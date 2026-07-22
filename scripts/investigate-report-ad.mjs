/**
 * Investigate Google SERP "Report ad" UI without submitting.
 * Opens a clean profile, searches a keyword, clicks report menu on first ad,
 * dumps the dialog DOM and screenshots.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";
import { AdsPowerClient } from "../dist/adspower/client.js";
import { BrowserSession } from "../dist/browser/session.js";
import { buildSerpUrl, gotoSerp, prepareGoogleConsent, settleSerpForAds } from "../dist/google/serp.js";
import { parseAds } from "../dist/google/adParser.js";
import { sleep } from "../dist/util/time.js";

const PROFILE_NAME = process.argv[2] || "TR-MOBILE-099";
const KEYWORD = process.argv[3] || "herabet";
const outDir = join("data", "investigate-report-ad");
mkdirSync(outDir, { recursive: true });

const config = loadConfig();
config.captcha.enabled = true;
const ads = new AdsPowerClient(config.adspower.baseUrl, config.adspower.apiKey, config.adspower.requestIntervalMs);

const isMobile = /^TR-MOBILE-/.test(PROFILE_NAME);
console.log(`Investigating ${PROFILE_NAME} (${isMobile ? "mobile" : "desktop"}) · keyword=${KEYWORD}`);

const all = await ads.listProfiles();
const profile = all.find((p) => p.name === PROFILE_NAME);
if (!profile) {
  console.log("Profile not found:", PROFILE_NAME);
  process.exit(2);
}

let session;
try {
  await ads.stopBrowser(profile.user_id).catch(() => {});
  await sleep(500);
  const ws = await ads.ensureBrowser(profile.user_id);
  session = await BrowserSession.attach(ws);
  await prepareGoogleConsent(session);
  if (isMobile) {
    const { applyMobileEmulation } = await import("../dist/browser/mobileEmulation.js");
    await applyMobileEmulation(session.page);
  } else {
    await session.page.setViewportSize({ width: 1366, height: 900 }).catch(() => {});
  }

  const url = buildSerpUrl(config, KEYWORD);
  const nav = await gotoSerp(session, url, config, {});
  console.log("Navigation result:", JSON.stringify(nav, null, 2));
  await settleSerpForAds(session.page);

  // Consent leftover dismissal
  await session.page.locator("button", { hasText: /kabul|accept|tamam|agree/i }).first().click({ timeout: 2000 }).catch(() => {});
  await sleep(800);

  const pageUrl = session.page.url();
  writeFileSync(join(outDir, "page-url.txt"), pageUrl, "utf8");
  console.log("Page URL:", pageUrl);

  const fullHtml = await session.page.content();
  writeFileSync(join(outDir, "serp.html"), fullHtml, "utf8");

  const shotFull = join(outDir, "serp-full.png");
  await session.page.screenshot({ path: shotFull, fullPage: true });
  console.log("Full SERP screenshot:", shotFull);

  const adsList = await parseAds(session.page);
  console.log("Ads found:", adsList.length);
  writeFileSync(join(outDir, "ads.json"), JSON.stringify(adsList, null, 2), "utf8");

  if (adsList.length === 0) {
    console.log("No ads found. Check serp.html and serp-full.png");
    process.exit(0);
  }

  const target = adsList[0];
  console.log("Target ad:", JSON.stringify(target, null, 2));

  // Find the ad container for the target display domain or title.
  const targetInfo = await session.page.evaluate((domain, title) => {
    const containers = Array.from(document.querySelectorAll('div[data-text-ad], [data-text-ad], #tads > div, #tadsb > div'));
    for (const c of containers) {
      const text = c.textContent || "";
      if (text.includes(domain) || text.includes(title.slice(0, 30))) {
        // find the report/more button inside this container
        const btn = c.querySelector('button[aria-label*="More"], button[aria-label*="more"], button[aria-label*="Diğer"], div[role="button"][aria-label*="More"], div[role="button"][aria-label*="Diğer"]');
        return { foundContainer: true, containerText: text.slice(0, 300), hasButton: !!btn };
      }
    }
    return { foundContainer: false };
  }, target.displayDomain, target.title);
  console.log("Target container info:", targetInfo);

  // Try to find report menu button.
  const possibleSelectors = [
    'div[data-text-ad] button[aria-label*="More"], div[data-text-ad] button[aria-label*="more"], div[data-text-ad] button[aria-label*="Diğer"], div[data-text-ad] button[aria-label*="diğer"]',
    'div[data-text-ad] div[role="button"][aria-label*="More"], div[data-text-ad] div[role="button"][aria-label*="Diğer"]',
    '#tads button[aria-label*="More"], #tads div[role="button"][aria-label*="More"]',
    '#tadsb button[aria-label*="More"], #tadsb div[role="button"][aria-label*="More"]',
    'button[aria-label*="More"], button[aria-label*="more"], button[aria-label*="Diğer"], div[role="button"][aria-label*="More"]',
  ];

  let reportBtn = null;
  let usedSelector = "";
  for (const sel of possibleSelectors) {
    const el = await session.page.$(sel).catch(() => null);
    if (el) {
      reportBtn = el;
      usedSelector = sel;
      console.log("Found report menu button via:", sel);
      break;
    }
  }

  if (!reportBtn) {
    console.log("No report button found with selectors. Dumping all buttons...");
    const buttons = await session.page.evaluate(() => {
      return Array.from(document.querySelectorAll('button, div[role="button"]')).map((b) => ({
        text: (b.textContent || "").slice(0, 60),
        ariaLabel: b.getAttribute("aria-label") || "",
        className: b.className,
      }));
    });
    writeFileSync(join(outDir, "buttons.json"), JSON.stringify(buttons, null, 2), "utf8");
    process.exit(0);
  }

  await reportBtn.click().catch((e) => console.log("click error", e.message));
  await sleep(2000);

  const shotMenu = join(outDir, "menu-open.png");
  await session.page.screenshot({ path: shotMenu, fullPage: false });
  console.log("Menu screenshot:", shotMenu);

  // Try to click "Report ad" / "Bu reklamı bildir"
  const reportLabelRegex = /report ad|şikayet|bildir|report/i;
  const clicked = await session.page.evaluate((rxSource) => {
    const rx = new RegExp(rxSource, "i");
    const all = Array.from(document.querySelectorAll('span, div, a, button, [role="menuitem"], [role="option"]'));
    for (const el of all) {
      if (rx.test(el.textContent || "")) {
        el.scrollIntoView({ block: "center" });
        el.click();
        return el.textContent?.trim();
      }
    }
    return null;
  }, reportLabelRegex.source);
  console.log("Clicked report menu item:", clicked);

  await sleep(3000);
  const shotDialog = join(outDir, "dialog.png");
  await session.page.screenshot({ path: shotDialog, fullPage: false });
  console.log("Dialog screenshot:", shotDialog);

  const dialogHtml = await session.page.evaluate(() => {
    const candidates = document.querySelectorAll(
      '[role="dialog"], [jsname], .g3L2C, .EfDFA, .xPBD1, iframe[name*="report"], iframe[src*="report"]'
    );
    const out = [];
    for (const c of candidates) {
      out.push(`TAG:${c.tagName}\nCLASS:${c.className}\nTEXT:${(c.textContent || "").slice(0, 600)}\nHTML:${c.outerHTML.slice(0, 2500)}`);
    }
    return out.join("\n\n---\n\n");
  });
  writeFileSync(join(outDir, "dialog.txt"), dialogHtml, "utf8");
  console.log("Dialog DOM dumped to dialog.txt");

  const fullHtml2 = await session.page.content();
  writeFileSync(join(outDir, "page-with-dialog.html"), fullHtml2, "utf8");

  console.log("\nInvestigation complete. Did NOT submit any report.");
} catch (err) {
  console.error("Investigation error:", err);
} finally {
  if (session) await session.detach().catch(() => {});
  await ads.stopBrowser(profile.user_id).catch(() => {});
}
