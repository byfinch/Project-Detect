/**
 * Direct CF-path test: open profile, go to a known-challenging domain, run passCloudflareIfPresent.
 * Usage: node scripts/test-cf-direct.mjs <PROFILE_NAME> [url]
 */
import { loadConfig } from "../dist/config.js";
import { AdsPowerClient, captchaProxyFromProfile } from "../dist/adspower/client.js";
import { BrowserSession } from "../dist/browser/session.js";
import { passCloudflareIfPresent } from "../dist/captcha/cloudflare.js";
import { sleep } from "../dist/util/time.js";

const PROFILE_NAME = process.argv[2] || "TR-MOBILE-079";
const URL_ = process.argv[3] || "https://k56thc2itt.com/";
const config = loadConfig();
const ads = new AdsPowerClient(config.adspower.baseUrl, config.adspower.apiKey, config.adspower.requestIntervalMs);
const all = await ads.listProfiles();
const profile = all.find((p) => p.name === PROFILE_NAME);
if (!profile) { console.error("not found"); process.exit(2); }

const T = () => new Date().toISOString().slice(17, 23);
const step = (m) => console.log(`[${T()}] ${m}`);

let session;
try {
  await ads.stopBrowser(profile.user_id).catch(() => {});
  await sleep(800);
  const ws = await ads.ensureBrowser(profile.user_id);
  session = await BrowserSession.attach(ws);
  const page = session.page;
  if (/^TR-MOBILE-/i.test(PROFILE_NAME)) {
    const { applyMobileEmulation } = await import("../dist/browser/mobileEmulation.js");
    await applyMobileEmulation(page);
  }
  await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await sleep(3000);
  step("landed: " + page.url().slice(0, 80));
  const px = captchaProxyFromProfile(profile);
  const cf = await passCloudflareIfPresent(page, config, {
    proxy: px?.proxy,
    proxytype: px?.proxytype,
    timeoutMs: 150_000,
  });
  step(`CF result: passed=${cf.passed} method=${cf.method}`);
  await page.screenshot({ path: "data/cf-direct-after.png", timeout: 10000 }).catch(() => {});
  step("final: " + page.url().slice(0, 80));
} catch (err) {
  step("ERROR: " + String(err));
} finally {
  if (session) await session.detach().catch(() => {});
  await ads.stopBrowser(profile.user_id).catch(() => {});
}
