/**
 * Ad-inventory probe: why do mobile click jobs report "target ad not found"?
 * Opens a few mobile + desktop profiles the same way the system does
 * (consent → trend warm-up → brand SERP), then prints how many ads each
 * SERP actually served and which domains appeared.
 *
 * Usage: node scripts/probe-ad-inventory.mjs [keyword] [perDevice]
 * Defaults: keyword=herabet, perDevice=2. Sequential, closes each browser.
 */
import { loadConfig } from "../dist/config.js";
import { AdsPowerClient } from "../dist/adspower/client.js";
import { BrowserSession } from "../dist/browser/session.js";
import { buildSerpUrl, gotoSerp, prepareGoogleConsent, warmUp } from "../dist/google/serp.js";
import { parseAds } from "../dist/google/adParser.js";
import { sleep } from "../dist/util/time.js";

const keyword = process.argv[2] || "herabet";
const perDevice = Math.max(1, parseInt(process.argv[3] || "2", 10) || 2);

const config = loadConfig();
config.captcha.enabled = true;
const ads = new AdsPowerClient(config.adspower.baseUrl, config.adspower.apiKey, config.adspower.requestIntervalMs);

const all = await ads.listProfiles();
const pick = (prefix) =>
  all.filter((p) => (p.name || "").startsWith(prefix)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, perDevice);
const targets = [
  ...pick(config.scan.mobileProfilePrefix || "TR-MOBILE-").map((p) => ({ p, device: "mobile" })),
  ...pick(config.scan.profilePrefix || "TR-ISP-").map((p) => ({ p, device: "desktop" })),
];

console.log(`probe: keyword="${keyword}" · ${targets.length} profil (${perDevice}/cihaz)`);

for (const { p, device } of targets) {
  const name = p.name || p.user_id;
  let session;
  try {
    await ads.stopBrowser(p.user_id).catch(() => {});
    await sleep(600);
    const ws = await ads.ensureBrowser(p.user_id);
    session = await BrowserSession.attach(ws);
    await prepareGoogleConsent(session);
    if (device === "mobile") {
      const { applyMobileEmulation } = await import("../dist/browser/mobileEmulation.js");
      await applyMobileEmulation(session.page);
    }
    const warm = await warmUp(session, config, { trendWarmup: true });
    if (warm.captcha) {
      console.log(`${device.padEnd(7)} ${name}: CAPTCHA (warm-up) — SERP atlandı`);
      continue;
    }
    const nav = await gotoSerp(session, buildSerpUrl(config, keyword), config, {});
    if (nav.captcha || String(nav.finalUrl || "").includes("/sorry")) {
      console.log(`${device.padEnd(7)} ${name}: CAPTCHA (/sorry)`);
      continue;
    }
    const found = await parseAds(session.page);
    const domains = found.map((a) => a.displayDomain);
    console.log(
      `${device.padEnd(7)} ${name}: adsFound=${found.length}` +
        (domains.length ? ` · ${domains.join(", ")}` : " · (reklam yok)")
    );
  } catch (err) {
    console.log(`${device.padEnd(7)} ${name}: ERROR ${String(err).slice(0, 120)}`);
  } finally {
    try {
      if (session) await session.detach().catch(() => {});
      await ads.stopBrowser(p.user_id).catch(() => {});
    } catch {
      /* best effort */
    }
  }
}
console.log("probe bitti");
