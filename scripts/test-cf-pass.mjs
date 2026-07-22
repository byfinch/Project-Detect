/**
 * Live Cloudflare-pass test: SERP → click first ad → passCloudflareIfPresent.
 * Usage: node scripts/test-cf-pass.mjs <PROFILE_NAME> [keyword]
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";
import { AdsPowerClient, captchaProxyFromProfile } from "../dist/adspower/client.js";
import { BrowserSession } from "../dist/browser/session.js";
import { buildSerpUrl, gotoSerp, prepareGoogleConsent, settleSerpForAds, warmUp } from "../dist/google/serp.js";
import { parseAds } from "../dist/google/adParser.js";
import { passCloudflareIfPresent } from "../dist/captcha/cloudflare.js";
import { sleep } from "../dist/util/time.js";

const PROFILE_NAME = process.argv[2];
const KEYWORD = process.argv[3] || "rovbet";
if (!PROFILE_NAME) { console.error("profile gerekli"); process.exit(2); }

const isMobile = /^TR-MOBILE-/i.test(PROFILE_NAME);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join("data", "cf-test", `${PROFILE_NAME}-${stamp}`);
mkdirSync(outDir, { recursive: true });

const config = loadConfig();
const ads = new AdsPowerClient(config.adspower.baseUrl, config.adspower.apiKey, config.adspower.requestIntervalMs);
const all = await ads.listProfiles();
const profile = all.find((p) => p.name === PROFILE_NAME);
if (!profile) { console.error("not found"); process.exit(2); }

const T = () => new Date().toISOString().slice(17, 23);
const step = (m) => console.log(`[${T()}] ${m}`);
const shot = async (page, name) => {
  await page.screenshot({ path: join(outDir, name + ".png"), fullPage: false, timeout: 10000 }).catch(() => {});
  step(`[shot] ${name}`);
};

let session;
try {
  await ads.stopBrowser(profile.user_id).catch(() => {});
  await sleep(800);
  const ws = await ads.ensureBrowser(profile.user_id);
  session = await BrowserSession.attach(ws);
  const page = session.page;
  await prepareGoogleConsent(session);
  if (isMobile) {
    const { applyMobileEmulation } = await import("../dist/browser/mobileEmulation.js");
    await applyMobileEmulation(page);
  } else {
    await page.setViewportSize({ width: 1366, height: 900 }).catch(() => {});
  }

  const warm = await warmUp(session, config, {});
  step(`warmup: captcha=${warm.captcha}`);
  if (warm.captcha) throw new Error("warmup captcha");

  await gotoSerp(session, buildSerpUrl(config, KEYWORD), config, {});
  await settleSerpForAds(page, { light: true });
  let adsList = await parseAds(page);
  for (let r = 1; r <= 2 && !adsList.length; r++) {
    step(`0 ads — reload ${r}/2`);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await sleep(2500);
    await settleSerpForAds(page, { light: true });
    adsList = await parseAds(page);
  }
  const target = adsList.find((a) => a.adHref) || adsList[0];
  if (!target) { step("no ad"); process.exit(0); }
  step(`target: ${target.displayDomain} · ${target.title}`);

  let anchor = null;
  if (target.title) {
    const safe = target.title.replace(/"/g, '\\"').slice(0, 80);
    anchor = await page.$(`a:has-text("${safe}")`).catch(() => null);
  }
  if (!anchor && target.adHref) anchor = await page.$(`a[href="${target.adHref}"]`).catch(() => null);
  if (!anchor) anchor = await page.$(`a[href*="aclk"]`).catch(() => null);
  if (!anchor && !target.adHref) { step("no anchor/href"); process.exit(1); }
  const [newPage] = await Promise.all([
    page.context().waitForEvent("page", { timeout: 18000 }).catch(() => null),
    anchor
      ? anchor.click().catch(() => null)
      : page.goto(target.adHref, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null),
  ]);
  const landing = newPage ?? page;
  await landing.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
  step(`landing: ${landing.url().slice(0, 90)}`);
  await sleep(2500);
  await shot(landing, "cf-01-before");

  const px = captchaProxyFromProfile(profile);
  const cf = await passCloudflareIfPresent(landing, config, {
    proxy: px?.proxy,
    proxytype: px?.proxytype,
    timeoutMs: 120_000,
  });
  step(`CF result: passed=${cf.passed} method=${cf.method}`);
  await shot(landing, "cf-02-after");
  step(`final: ${landing.url().slice(0, 90)}`);
} catch (err) {
  step("ERROR: " + String(err));
} finally {
  if (session) await session.detach().catch(() => {});
  await ads.stopBrowser(profile.user_id).catch(() => {});
  step("done");
}
