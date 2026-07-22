/**
 * Gentle status check: all TR-MOBILE profiles via trend path only.
 * No brand keywords. Graceful close. Concurrency 3.
 *
 * node scripts/status-all-mobile.mjs
 */
import { writeFileSync } from "node:fs";
import { loadConfig } from "../dist/config.js";
import { AdsPowerClient, captchaProxyFromProfile } from "../dist/adspower/client.js";
import { BrowserSession } from "../dist/browser/session.js";
import { applyMobileEmulation } from "../dist/browser/mobileEmulation.js";
import { prepareGoogleConsent, recoverViaTrendClick } from "../dist/google/serp.js";
import { exportTrustCookies, restoreTrustCookies } from "../dist/captcha/recovery.js";
import { gracefulProfileShutdown } from "../dist/browser/shutdown.js";
import { Store } from "../dist/store/db.js";
import { sleep } from "../dist/util/time.js";

const CONCURRENCY = 3;

const config = loadConfig();
const ads = new AdsPowerClient(
  config.adspower.baseUrl,
  config.adspower.apiKey,
  config.adspower.requestIntervalMs
);
const store = new Store(config.output.dir);

if (!(await ads.isUp())) {
  console.error("AdsPower down");
  process.exit(2);
}

const all = await ads.listProfiles();
const mobiles = all
  .filter((p) => /^TR-MOBILE-/.test(p.name || ""))
  .sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { numeric: true }));

console.log(`mobile status check n=${mobiles.length} concurrency=${CONCURRENCY} (trend only, no brands)`);

const results = [];
let idx = 0;

async function one(p) {
  const name = p.name || p.user_id;
  const row = {
    name,
    profileId: p.user_id,
    status: "error",
    trend: "",
    finalUrl: "",
    ms: 0,
    error: "",
  };
  const t0 = Date.now();
  let session = null;
  try {
    await ads.stopBrowser(p.user_id).catch(() => {});
    await sleep(500);
    const ws = await ads.ensureBrowser(p.user_id);
    session = await BrowserSession.attach(ws);

    const trust = store.ipTrust.get(p.user_id);
    if (trust?.trustCookies?.length) await restoreTrustCookies(session, trust.trustCookies);

    await prepareGoogleConsent(session);
    await applyMobileEmulation(session.page);

    const px = captchaProxyFromProfile(p);
    const captchaOpts = px ? { captchaProxy: { proxy: px.proxy, proxytype: px.proxytype } } : {};

    const nav = await recoverViaTrendClick(session, config, captchaOpts);
    row.trend = nav.trend || "";
    row.finalUrl = (nav.finalUrl || "").slice(0, 200);
    const finalSorry = /\/sorry\//i.test(nav.finalUrl || "");

    const cookies = await exportTrustCookies(session);
    if (nav.captchaSolved && !finalSorry) {
      row.status = "captcha_solved";
      store.ipTrust.markSolved(p.user_id, cookies);
    } else if (!nav.captcha && !finalSorry) {
      row.status = "clean";
      store.ipTrust.markClean(p.user_id, cookies);
    } else {
      row.status = "captcha";
      store.ipTrust.markHardCaptcha(p.user_id, "status check: still wall after trend");
    }
  } catch (err) {
    row.status = "error";
    row.error = String(err).slice(0, 220);
    try {
      store.ipTrust.markHardCaptcha(p.user_id, row.error);
    } catch {
      /* */
    }
  } finally {
    row.ms = Date.now() - t0;
    await gracefulProfileShutdown(ads, session, p.user_id);
  }
  return row;
}

async function worker() {
  while (true) {
    const i = idx++;
    if (i >= mobiles.length) break;
    const p = mobiles[i];
    const row = await one(p);
    results.push(row);
    console.log(
      `[${results.length}/${mobiles.length}] ${row.name} → ${row.status} (${row.ms}ms)` +
        (row.trend ? ` trend="${row.trend}"` : "") +
        (row.error ? ` err=${row.error.slice(0, 70)}` : "")
    );
    await sleep(800);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
results.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

const clean = results.filter((r) => r.status === "clean");
const solved = results.filter((r) => r.status === "captcha_solved");
const captcha = results.filter((r) => r.status === "captcha");
const errors = results.filter((r) => r.status === "error");
const usable = [...clean, ...solved];

const summary = {
  at: new Date().toISOString(),
  total: results.length,
  clean: clean.length,
  captcha_solved: solved.length,
  captcha: captcha.length,
  error: errors.length,
  usable: usable.length,
  usableNames: usable.map((r) => r.name),
  captchaNames: captcha.map((r) => r.name),
  errorNames: errors.map((r) => ({ name: r.name, error: r.error })),
  vault: store.ipTrust.summary(),
  results,
};

writeFileSync("data/mobile-status-50.json", JSON.stringify(summary, null, 2));
writeFileSync(
  "data/mobile-status-50.csv",
  ["name,status,ms,trend,error"]
    .concat(
      results.map((r) =>
        [r.name, r.status, r.ms, JSON.stringify(r.trend || ""), JSON.stringify(r.error || "")].join(",")
      )
    )
    .join("\n")
);
writeFileSync("data/mobile-usable-now.txt", usable.map((r) => r.name).join("\n") + "\n");

console.log("\n========== 50 MOBILE STATUS ==========");
console.log(`total          : ${summary.total}`);
console.log(`clean          : ${summary.clean}`);
console.log(`captcha_solved : ${summary.captcha_solved}`);
console.log(`usable (ok)    : ${summary.usable}`);
console.log(`captcha (wall) : ${summary.captcha}`);
console.log(`error          : ${summary.error}`);
if (captcha.length) console.log("WALL:", captcha.map((r) => r.name).join(", "));
if (errors.length) console.log("ERROR:", errors.map((r) => r.name).join(", "));
console.log("vault:", summary.vault);
console.log("JSON: data/mobile-status-50.json");
console.log("usable list: data/mobile-usable-now.txt");

store.close();
process.exit(0);
