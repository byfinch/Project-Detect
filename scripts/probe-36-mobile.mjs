/**
 * Gentle health probe for the 36 proxy-replaced mobile profiles.
 * System's own flow per profile: open → consent → trend warm-up → soft SERP.
 * Sequential, protect-friendly. Writes data/mobile-36-probe.json
 */
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { loadConfig } from "../dist/config.js";
import { AdsPowerClient } from "../dist/adspower/client.js";
import { BrowserSession } from "../dist/browser/session.js";
import { buildSerpUrl, gotoSerp, prepareGoogleConsent, warmUp } from "../dist/google/serp.js";
import { sleep } from "../dist/util/time.js";

const csv = readFileSync("C:/Users/efsun/Downloads/orders.csv", "utf8")
  .split(/\r?\n/).slice(1).map((l) => l.split(",")[0].trim()).filter(Boolean);
const inList = new Set(csv);

const config = loadConfig();
config.captcha.enabled = true;
const ads = new AdsPowerClient(config.adspower.baseUrl, config.adspower.apiKey, config.adspower.requestIntervalMs);
const all = await ads.listProfiles();
const targets = all.filter(
  (p) => p.name.startsWith("TR-MOBILE-") && inList.has(p.user_proxy_config?.proxy_host || "") &&
    !["TR-MOBILE-064","TR-MOBILE-074","TR-MOBILE-075","TR-MOBILE-090","TR-MOBILE-091","TR-MOBILE-094","TR-MOBILE-097","TR-MOBILE-098","TR-MOBILE-099"].includes(p.name)
).sort((a, b) => a.name.localeCompare(b.name));

console.log(`probe: ${targets.length} profil`);
const results = [];
const t0 = Date.now();

for (let i = 0; i < targets.length; i++) {
  const p = targets[i];
  const row = { name: p.name, ip: p.user_proxy_config?.proxy_host, status: "error", note: "" };
  let session;
  try {
    await ads.stopBrowser(p.user_id).catch(() => {});
    await sleep(600);
    const ws = await ads.ensureBrowser(p.user_id);
    session = await BrowserSession.attach(ws);
    await prepareGoogleConsent(session);
    const { applyMobileEmulation } = await import("../dist/browser/mobileEmulation.js");
    await applyMobileEmulation(session.page);
    const warm = await warmUp(session, config, {});
    if (warm.captcha) {
      row.status = "captcha";
      row.note = "warm-up captcha";
    } else {
      const nav = await gotoSerp(session, buildSerpUrl(config, "hava durumu"), config, {});
      if (nav.captcha || String(nav.finalUrl || "").includes("/sorry")) {
        row.status = "captcha";
        row.note = "serp /sorry";
      } else {
        row.status = "clean";
        row.note = warm.captchaSolved ? "warm-up solved" : "clean";
      }
    }
  } catch (err) {
    row.status = "error";
    row.note = String(err).slice(0, 120);
  } finally {
    if (session) await session.detach().catch(() => {});
    await ads.stopBrowser(p.user_id).catch(() => {});
  }
  results.push(row);
  console.log(`[${i + 1}/${targets.length}] ${row.name} (${row.ip}) → ${row.status}${row.note !== row.status ? " · " + row.note : ""}`);
  await sleep(1500);
}

const summary = {
  testedAt: new Date().toISOString(),
  durationMin: Math.round((Date.now() - t0) / 60000),
  total: results.length,
  clean: results.filter((r) => r.status === "clean").length,
  captcha: results.filter((r) => r.status === "captcha").length,
  error: results.filter((r) => r.status === "error").length,
  results,
};
writeFileSync("data/mobile-36-probe.json", JSON.stringify(summary, null, 2), "utf8");
console.log(`\nSONUÇ: ${summary.clean} clean · ${summary.captcha} captcha · ${summary.error} error (${summary.durationMin}dk)`);
