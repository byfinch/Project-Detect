/**
 * Live "Report ad" flow test on a single AdsPower profile (mobile or desktop).
 *
 * Usage:
 *   node scripts/test-report-live.mjs <PROFILE_NAME> [keyword] [--submit]
 *
 * Default is DRY-RUN (form filled, NOT submitted). Pass --submit for real.
 * Follows SYSTEM-RULES: trend warm-up first, no direct cold brand SERP.
 * Evidence screenshots land in data/test-report-live/<profile>-<ts>/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";
import { AdsPowerClient } from "../dist/adspower/client.js";
import { BrowserSession } from "../dist/browser/session.js";
import {
  buildSerpUrl,
  gotoSerp,
  prepareGoogleConsent,
  settleSerpForAds,
  warmUp,
} from "../dist/google/serp.js";
import { parseAds } from "../dist/google/adParser.js";
import { openReportUi, fillReportForm } from "../dist/report/autoSerpReport.js";
import { getEmailPool, acquireReportEmail, markReportEmailUsed } from "../dist/report/emailPool.js";
import { sleep } from "../dist/util/time.js";

const PROFILE_NAME = process.argv[2];
const KEYWORD = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : "herabet";
const SUBMIT = process.argv.includes("--submit");
/** --attach: do NOT restart the browser or navigate — report the ad on the CURRENT live SERP tab. */
const ATTACH = process.argv.includes("--attach");

if (!PROFILE_NAME) {
  console.error("Usage: node scripts/test-report-live.mjs <PROFILE_NAME> [keyword] [--submit]");
  process.exit(2);
}

const isMobile = /^TR-MOBILE-/i.test(PROFILE_NAME);
const device = isMobile ? "mobile" : "desktop";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join("data", "test-report-live", `${PROFILE_NAME}-${stamp}`);
mkdirSync(outDir, { recursive: true });

console.log(`Profile: ${PROFILE_NAME} (${device}) · keyword=${KEYWORD} · submit=${SUBMIT}`);
console.log(`Evidence: ${outDir}`);

const config = loadConfig();
config.captcha.enabled = true;
const ads = new AdsPowerClient(config.adspower.baseUrl, config.adspower.apiKey, config.adspower.requestIntervalMs);

const all = await ads.listProfiles();
const profile = all.find((p) => p.name === PROFILE_NAME);
if (!profile) {
  console.error("Profile not found:", PROFILE_NAME);
  process.exit(2);
}

const shot = async (page, name) => {
  const p = join(outDir, `${name}.png`);
  await page.screenshot({ path: p, fullPage: false, timeout: 10000 }).catch(() => {});
  console.log(`  [shot] ${name}.png`);
};

let session;
const summary = { profile: PROFILE_NAME, device, keyword: KEYWORD, submit: SUBMIT, attach: ATTACH, steps: {} };
let page;
try {
  if (!ATTACH) {
    await ads.stopBrowser(profile.user_id).catch(() => {});
    await sleep(800);
  }
  const ws = await ads.ensureBrowser(profile.user_id);
  session = await BrowserSession.attach(ws);
  if (ATTACH) {
    // Live mode: find the tab already showing a Google SERP — never navigate.
    const pages = session.context.pages();
    const serpTab = pages.find((p) => /google\..*\/search/.test(p.url())) || pages.find((p) => /google\./.test(p.url()));
    if (!serpTab) {
      console.error("ABORT: no live Google tab found in the running browser.");
      summary.result = "no-live-serp";
      throw new Error("no-live-serp");
    }
    page = serpTab;
    const q = new URL(page.url()).searchParams.get("q") || KEYWORD;
    summary.steps.liveUrl = page.url();
    summary.steps.liveKeyword = q;
    console.log(`1) attached to live tab: ${page.url().slice(0, 120)}`);
  } else {
    page = session.page;
    await prepareGoogleConsent(session);
    if (isMobile) {
      const { applyMobileEmulation } = await import("../dist/browser/mobileEmulation.js");
      await applyMobileEmulation(page);
    } else {
      await page.setViewportSize({ width: 1366, height: 900 }).catch(() => {});
    }

    // 1) SYSTEM-RULES warm-up: trend path first, never cold brand SERP.
    console.log("1) warm-up (trend path)...");
    const warm = await warmUp(session, config, {});
    summary.steps.warmup = { captcha: warm.captcha, solved: warm.captchaSolved, finalUrl: warm.finalUrl };
    console.log("   warm-up:", JSON.stringify(summary.steps.warmup));
    if (warm.captcha) {
      console.error("ABORT: captcha wall survived warm-up — not touching this profile further.");
      summary.result = "aborted-captcha";
      throw new Error("captcha-after-warmup");
    }

    // 2) Brand SERP.
    console.log("2) brand SERP...");
    const url = buildSerpUrl(config, KEYWORD);
    const nav = await gotoSerp(session, url, config, {});
    summary.steps.serp = nav;
    console.log("   nav:", JSON.stringify(nav));
    if (nav.captcha || String(nav.finalUrl || "").includes("/sorry")) {
      console.error("ABORT: /sorry on brand SERP.");
      summary.result = "aborted-sorry";
      throw new Error("sorry-wall");
    }
  }
  await settleSerpForAds(page, { light: ATTACH });
  await shot(page, "01-serp");

  // 3) Find a target ad (0 ads → soft reload, mirrors scanner's re-settle rule).
  //    In --attach mode NO reload: the live impression is the whole point.
  let adsList = await parseAds(page);
  for (let retry = 1; !ATTACH && retry <= 2 && adsList.length === 0; retry++) {
    console.log(`   0 ads — soft reload ${retry}/2`);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await sleep(2500);
    await settleSerpForAds(page, { light: true });
    adsList = await parseAds(page);
  }
  console.log(`   ads found: ${adsList.length}`);
  writeFileSync(join(outDir, "ads.json"), JSON.stringify(adsList, null, 2), "utf8");
  const target = adsList.find((a) => a.displayDomain) || adsList[0];
  if (!target) {
    console.error("ABORT: no ad on SERP (auction empty).");
    summary.result = "no-ad";
    throw new Error("no-ad");
  }
  summary.steps.target = { domain: target.displayDomain, title: target.title };
  console.log("   target:", JSON.stringify(summary.steps.target));

  // 4) Acquire pool email.
  const acc = acquireReportEmail(config.output.dir, {
    enabled: config.report.emailPool.enabled,
    fallback: config.report.reportEmail,
  });
  summary.steps.email = acc;
  console.log(`4) email: ${acc.email} (fromPool=${acc.fromPool})`);

  // 5) Open report UI.
  console.log("5) openReportUi...");
  const opened = await openReportUi(page, target.displayDomain, target.title, device, outDir);
  summary.steps.opened = opened;
  await shot(page, "02-report-ui");
  if (!opened) {
    console.error("FAIL: report UI did not open.");
    summary.result = "no-form";
    throw new Error("no-form");
  }

  // 6) Fill (+ optionally submit).
  console.log(`6) fillReportForm (submit=${SUBMIT})...`);
  const reportKeyword = summary.steps.liveKeyword || KEYWORD;
  const res = await fillReportForm(
    page,
    {
      keyword: reportKeyword,
      device,
      displayDomain: target.displayDomain,
      title: target.title,
      description: target.description,
      finalDomain: target.finalDomain ?? undefined,
      adHref: target.adHref ?? undefined,
      displayUrl: target.displayUrl ?? undefined,
      seed: PROFILE_NAME,
    },
    SUBMIT,
    outDir,
    acc.email || undefined
  );
  summary.steps.form = res;
  console.log("   form result:", JSON.stringify(res));
  if (res.status === "submitted" || res.status === "filled") {
    markReportEmailUsed(config.output.dir, acc.email, acc.fromPool);
  }
  summary.result = res.status;
  const pool = getEmailPool(config.output.dir);
  console.log("   pool stats:", JSON.stringify(pool.stats()));
} catch (err) {
  if (!summary.result) {
    summary.result = "error";
    summary.error = String(err);
    console.error("ERROR:", err);
  }
} finally {
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log("RESULT:", summary.result);
  if (session) await session.detach().catch(() => {});
  // --attach: leave the user's browser RUNNING — we only borrowed the tab.
  if (!ATTACH) await ads.stopBrowser(profile.user_id).catch(() => {});
}
