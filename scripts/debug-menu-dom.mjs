/**
 * Dump the "Reklam Merkezim" menu DOM after clicking the ad opener,
 * using a DOM .click() (bypasses the stalling CDP mouse pipeline).
 */
import { writeFileSync } from "node:fs";
import { loadConfig } from "../dist/config.js";
import { AdsPowerClient } from "../dist/adspower/client.js";
import { BrowserSession } from "../dist/browser/session.js";
import { buildSerpUrl, gotoSerp, prepareGoogleConsent, settleSerpForAds, warmUp } from "../dist/google/serp.js";
import { parseAds } from "../dist/google/adParser.js";
import { sleep } from "../dist/util/time.js";

const PROFILE_NAME = process.argv[2] || "TR-MOBILE-085";
const KEYWORD = process.argv[3] || "rovbet";
const config = loadConfig();
const ads = new AdsPowerClient(config.adspower.baseUrl, config.adspower.apiKey, config.adspower.requestIntervalMs);
const all = await ads.listProfiles();
const profile = all.find((p) => p.name === PROFILE_NAME);
if (!profile) { console.error("not found"); process.exit(2); }

const T = () => new Date().toISOString().slice(17, 23);
const step = (msg) => console.log(`[${T()}] ${msg}`);

let session;
try {
  await ads.stopBrowser(profile.user_id).catch(() => {});
  await sleep(800);
  const ws = await ads.ensureBrowser(profile.user_id);
  session = await BrowserSession.attach(ws);
  const page = session.page;
  await prepareGoogleConsent(session);
  const { applyMobileEmulation } = await import("../dist/browser/mobileEmulation.js");
  await applyMobileEmulation(page);

  const warm = await warmUp(session, config, {});
  if (warm.captcha) { step("warmup captcha"); process.exit(1); }
  let adsList = [];
  let usedKw = KEYWORD;
  const candidates = KEYWORD === "auto" ? ["rovbet", "vegasslot", "primebahis", "napolibet", "herabet"] : [KEYWORD];
  for (const kw of candidates) {
    await gotoSerp(session, buildSerpUrl(config, kw), config, {});
    await settleSerpForAds(page, { light: true });
    adsList = await parseAds(page);
    for (let r = 1; r <= 2 && !adsList.length; r++) {
      step(`${kw}: 0 ads — reload ${r}/2`);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      await sleep(2500);
      await settleSerpForAds(page, { light: true });
      adsList = await parseAds(page);
    }
    step(`${kw}: ads=${adsList.length}`);
    if (adsList.length) { usedKw = kw; break; }
  }
  const target = adsList.find((a) => a.displayDomain) || adsList[0];
  if (!target) { step("no ad on any keyword"); process.exit(0); }
  step(`target: ${target.displayDomain} · ${target.title} (kw=${usedKw})`);

  // DOM-click the opener inside the target card.
  const clicked = await page.evaluate((dom) => {
    const cards = Array.from(document.querySelectorAll("[data-text-ad], #tads [data-hveid], #tadsb [data-hveid], #tvcap [data-hveid], [data-pcu]"));
    for (const c of cards) {
      const text = (c.textContent || "").toLowerCase();
      if (!text.includes(dom)) continue;
      const btns = Array.from(c.querySelectorAll('button, [role="button"]'));
      for (const b of btns) {
        const aria = (b.getAttribute("aria-label") || "").toLowerCase();
        if (aria.includes("neden") || aria.includes("why") || aria.includes("more") || aria.includes("diğer")) {
          b.scrollIntoView({ block: "center" });
          b.click();
          return { aria: b.getAttribute("aria-label"), tag: b.tagName };
        }
      }
    }
    return null;
  }, target.displayDomain.replace(/^www\./, ""));
  step("clicked opener: " + JSON.stringify(clicked));
  await sleep(2500);
  await page.screenshot({ path: "data/debug-menu-1.png", timeout: 8000 }).catch(() => {});

  // Dump every visible dialog/menu container fully.
  const dump = await page.evaluate(() => {
    const vis = (el) => el.getBoundingClientRect().width > 0;
    const sels = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-vhid], .VfPpkd-xl07Ob, [jsname="r4nke"]';
    const out = [];
    for (const d of Array.from(document.querySelectorAll(sels))) {
      if (!vis(d)) continue;
      out.push({ sel: d.getAttribute("role") || d.className?.toString().slice(0, 40), html: d.outerHTML.slice(0, 4000) });
    }
    // Everything mentioning bildir / şikayet / report
    const hits = [];
    for (const el of Array.from(document.querySelectorAll("*"))) {
      const own = el.childNodes.length === 1 && el.firstChild?.nodeType === 3 ? (el.textContent || "").trim() : "";
      const aria = el.getAttribute("aria-label") || "";
      if ((/bildir|şikayet|sikayet|report/i.test(own) || /bildir|şikayet|sikayet|report/i.test(aria)) && vis(el)) {
        hits.push({ tag: el.tagName, role: el.getAttribute("role"), aria, text: own.slice(0, 60) });
      }
    }
    return { dialogs: out.length, dump: out, reportHits: hits.slice(0, 20) };
  });
  writeFileSync("data/debug-menu-dom.json", JSON.stringify(dump, null, 2), "utf8");
  step(`visible dialogs: ${dump.dialogs} · report-related elements: ${dump.reportHits.length}`);
  for (const h of dump.reportHits) step("  hit: " + JSON.stringify(h));
  step("dump → data/debug-menu-dom.json");
} catch (err) {
  step("ERROR: " + String(err));
} finally {
  if (session) await session.detach().catch(() => {});
  await ads.stopBrowser(profile.user_id).catch(() => {});
  step("done");
}
