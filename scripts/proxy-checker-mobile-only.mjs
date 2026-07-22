import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/config.js";
import { AdsPowerClient } from "../dist/adspower/client.js";
import { BrowserSession } from "../dist/browser/session.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, "..", "data");

const config = loadConfig();
const ads = new AdsPowerClient(
  config.adspower.baseUrl,
  config.adspower.apiKey,
  config.adspower.requestIntervalMs
);

const plan = JSON.parse(readFileSync(resolve(dataDir, "mobile-proxy-update-plan.json"), "utf8"));
const hardNames = new Set(plan.map((p) => p.name));

const profiles = (await ads.listProfiles()).filter(
  (p) => p.name && hardNames.has(p.name)
);

const toTest = profiles;
console.log(`Checking ${toTest.length} newly-proxied mobile profiles...`);

const results = [];
const concurrency = 3;

async function checkOne(p) {
  let status = "unknown";
  let detail = "";
  let session;
  try {
    const active = await ads.browserActive(p.user_id).catch(() => null);
    if (active?.status === "Active") {
      await ads.stopBrowser(p.user_id, true);
    }
    const startResult = await ads.startBrowser(p.user_id);
    session = await BrowserSession.attach(startResult.ws.puppeteer);
    await session.page.goto(
      "https://www.google.com/search?q=bahis+siteleri&hl=tr&gl=tr&pws=0",
      { timeout: 30000, waitUntil: "domcontentloaded" }
    );
    const html = await session.page.content();
    const url = session.page.url();
    if (
      html.includes("recaptcha") ||
      html.includes("g-recaptcha") ||
      url.includes("/sorry/") ||
      html.includes("Our systems have detected unusual traffic")
    ) {
      status = "captcha";
      detail = url;
    } else if (
      html.includes('id="search"') ||
      html.includes('id="rso"') ||
      html.includes("class=\"g\"")
    ) {
      status = "ok";
    } else {
      status = "unknown";
      detail = url.slice(0, 120);
    }
  } catch (err) {
    status = "error";
    detail = String(err).slice(0, 120);
  } finally {
    if (session) await session.detach().catch(() => {});
    await ads.stopBrowser(p.user_id, true).catch(() => {});
  }
  results.push({
    name: p.name,
    host: p.user_proxy_config?.proxy_host,
    status,
    detail,
  });
  console.log(`${(p.name || "").padEnd(18)} ${(p.user_proxy_config?.proxy_host || "").padEnd(18)} ${status}`);
}

const queue = [...toTest];
async function worker() {
  while (queue.length) {
    const p = queue.shift();
    if (!p) break;
    await checkOne(p);
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));

const byStatus = {};
for (const r of results) {
  byStatus[r.status] = (byStatus[r.status] || 0) + 1;
}

console.log("\n=== Summary ===");
console.log(byStatus);

mkdirSync(dataDir, { recursive: true });
const statusPath = resolve(dataDir, "proxy-status-mobile-only.json");
writeFileSync(statusPath, JSON.stringify(results, null, 2));
console.log(`\nSaved mobile-only status to ${statusPath}`);

const bad = results.filter((r) => r.status !== "ok");
if (bad.length) {
  console.log("\n=== Flagged / Problematic profiles ===");
  for (const r of bad) {
    console.log(`${r.name} ${r.host} ${r.status} ${r.detail}`);
  }
}
