/**
 * All TR-MOBILE profiles × keyword "rovbet" — parallel, trend-safe, count ads.
 * Usage: node scripts/scan-rovbet-all-mobile.mjs
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { loadConfig } from "../dist/config.js";
import { AdsPowerClient, captchaProxyFromProfile } from "../dist/adspower/client.js";
import { BrowserSession } from "../dist/browser/session.js";
import { applyMobileEmulation } from "../dist/browser/mobileEmulation.js";
import {
  prepareGoogleConsent,
  warmUp,
  buildSerpUrl,
  gotoSerp,
  settleSerpForAds,
  reSearchKeyword,
} from "../dist/google/serp.js";
import { parseAds } from "../dist/google/adParser.js";
import { exportTrustCookies, restoreTrustCookies } from "../dist/captcha/recovery.js";
import { gracefulProfileShutdown } from "../dist/browser/shutdown.js";
import { Store } from "../dist/store/db.js";
import { sleep } from "../dist/util/time.js";

const CONCURRENCY = 4;
const KEYWORD = "rovbet";
/** Total keyword navigations if ads stay 0 (1st + re-searches). */
const MAX_KEYWORD_SEARCHES = 3;

const config = loadConfig();
config.scan.screenshots = false;
config.scan.resolveLandings = false;

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

console.log(`rovbet mobile scan: n=${mobiles.length} concurrency=${CONCURRENCY}`);

const results = [];
let idx = 0;

async function one(p) {
  const name = p.name || p.user_id;
  const row = {
    name,
    profileId: p.user_id,
    status: "error",
    ads: 0,
    pass1Ads: 0,
    pass2Ads: 0,
    pass3Ads: 0,
    searchPasses: 1,
    retried: false,
    titles: [],
    domains: [],
    finalUrl: "",
    trend: "",
    ms: 0,
    error: "",
  };
  const t0 = Date.now();
  let session = null;
  try {
    await ads.stopBrowser(p.user_id).catch(() => {});
    await sleep(400);
    const ws = await ads.ensureBrowser(p.user_id);
    session = await BrowserSession.attach(ws);
    const trust = store.ipTrust.get(p.user_id);
    if (trust?.trustCookies?.length) await restoreTrustCookies(session, trust.trustCookies);
    await prepareGoogleConsent(session);
    await applyMobileEmulation(session.page);
    const px = captchaProxyFromProfile(p);
    const captchaOpts = px ? { captchaProxy: { proxy: px.proxy, proxytype: px.proxytype } } : {};

    const warm = await warmUp(session, config, { ...captchaOpts, trendWarmup: true });
    row.trend = warm.trend || "";
    if (warm.captcha) {
      row.status = "captcha_warmup";
      store.ipTrust.markHardCaptcha(p.user_id, "rovbet scan: trend warm blocked");
      return row;
    }

    const url = buildSerpUrl(config, KEYWORD);
    let nav = await gotoSerp(session, url, config, captchaOpts);
    row.finalUrl = nav.finalUrl;
    if (nav.captcha) {
      row.status = "captcha_serp";
      store.ipTrust.markHardCaptcha(p.user_id, "rovbet scan: serp captcha");
      return row;
    }

    // Pass 1: settle + parse. If 0 ads → home→keyword up to MAX_KEYWORD_SEARCHES total.
    await settleSerpForAds(session.page).catch(() => {});
    let raw = await parseAds(session.page);
    row.pass1Ads = raw.length;
    let searchPass = 1;

    while (raw.length === 0 && searchPass < MAX_KEYWORD_SEARCHES) {
      searchPass++;
      row.retried = true;
      row.searchPasses = searchPass;
      console.log(`  ${name}: 0 ads → home then ${searchPass}/${MAX_KEYWORD_SEARCHES} rovbet search…`);
      nav = await reSearchKeyword(session, config, KEYWORD, captchaOpts);
      row.finalUrl = nav.finalUrl;
      if (nav.captcha) {
        row.status = "captcha_serp";
        store.ipTrust.markHardCaptcha(p.user_id, "rovbet scan: serp captcha on retry");
        return row;
      }
      raw = await parseAds(session.page);
      if (searchPass === 2) row.pass2Ads = raw.length;
      if (searchPass === 3) row.pass3Ads = raw.length;
      console.log(
        raw.length > 0
          ? `  ${name}: pass ${searchPass} → ${raw.length} ads`
          : `  ${name}: pass ${searchPass} → still 0 ads`
      );
    }
    if (!row.retried) {
      row.pass2Ads = raw.length;
      row.pass3Ads = raw.length;
      row.searchPasses = 1;
    }

    row.ads = raw.length;
    row.titles = raw.map((a) => (a.title || "").slice(0, 80));
    row.domains = raw.map((a) => a.displayUrl || a.finalDomain || "").filter(Boolean);
    row.status = raw.length > 0 ? "ads" : "no_ads";

    const cookies = await exportTrustCookies(session);
    if (nav.captchaSolved || warm.captchaSolved) store.ipTrust.markSolved(p.user_id, cookies);
    else store.ipTrust.markClean(p.user_id, cookies);
  } catch (err) {
    row.status = "error";
    row.error = String(err).slice(0, 200);
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
      `[${results.length}/${mobiles.length}] ${row.name} → ${row.status} ads=${row.ads} (${row.ms}ms)` +
        (row.titles.length ? ` | ${row.titles.join(" || ")}` : "") +
        (row.error ? ` err=${row.error.slice(0, 60)}` : "")
    );
  }
}

const workers = Array.from({ length: CONCURRENCY }, () => worker());
await Promise.all(workers);

results.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

const withAds = results.filter((r) => r.ads > 0);
const noAds = results.filter((r) => r.status === "no_ads");
const captcha = results.filter((r) => r.status.startsWith("captcha"));
const errors = results.filter((r) => r.status === "error");
const recoveredOnRetry = results.filter((r) => r.retried && r.ads > 0);

// domain frequency
const domainHit = new Map();
for (const r of withAds) {
  for (const d of r.domains.length ? r.domains : ["(unknown)"]) {
    domainHit.set(d, (domainHit.get(d) || 0) + 1);
  }
}

const summary = {
  at: new Date().toISOString(),
  keyword: KEYWORD,
  device: "mobile",
  total: results.length,
  profilesWithAds: withAds.length,
  profilesNoAds: noAds.length,
  captcha: captcha.length,
  errors: errors.length,
  recoveredOnRetry: recoveredOnRetry.length,
  recoveredOnRetryNames: recoveredOnRetry.map((r) => r.name),
  withAdsNames: withAds.map((r) => ({
    name: r.name,
    ads: r.ads,
    pass1Ads: r.pass1Ads,
    pass2Ads: r.pass2Ads,
    pass3Ads: r.pass3Ads,
    searchPasses: r.searchPasses,
    retried: r.retried,
    titles: r.titles,
    domains: r.domains,
  })),
  domainHit: Object.fromEntries([...domainHit.entries()].sort((a, b) => b[1] - a[1])),
  results,
};

writeFileSync("data/rovbet-all-mobile.json", JSON.stringify(summary, null, 2));
writeFileSync(
  "data/rovbet-all-mobile.csv",
  ["name,status,ads,ms,titles,domains,error"]
    .concat(
      results.map((r) =>
        [
          r.name,
          r.status,
          r.ads,
          r.ms,
          JSON.stringify(r.titles.join(" | ")),
          JSON.stringify(r.domains.join(" | ")),
          JSON.stringify(r.error),
        ].join(",")
      )
    )
    .join("\n")
);

console.log("\n========== ROVBET MOBILE SUMMARY ==========");
console.log(`profiles total     : ${summary.total}`);
console.log(`WITH ads           : ${summary.profilesWithAds}`);
console.log(`  of which on 2nd search only: ${summary.recoveredOnRetry}`);
console.log(`NO ads             : ${summary.profilesNoAds}`);
console.log(`captcha blocked    : ${summary.captcha}`);
console.log(`errors             : ${summary.errors}`);
console.log("with ads:", withAds.map((r) => `${r.name}(${r.ads}${r.retried ? "+retry" : ""})`).join(", ") || "(none)");
console.log("retry recovered:", summary.recoveredOnRetryNames.join(", ") || "(none)");
console.log("domain hits:", summary.domainHit);
console.log("JSON: data/rovbet-all-mobile.json");

store.close();
process.exit(0);
