import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../dist/config.js";
import { runScan } from "../dist/scanner.js";

const cfg = loadConfig();
cfg.devices = ["desktop"];
cfg.scan.maxProfilesPerDevice = 0; // no 5-cap — all TR-ISP-
cfg.scan.concurrency = 1;
cfg.scan.clearProfileData = false;
cfg.scan.queriesPerProfile = 1;

const keywords = readFileSync(resolve("data/_kw-5brands.txt"), "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean);

console.log("DESKTOP-50 START", new Date().toISOString());
console.log("keywords", keywords.join(", "));
console.log("maxProfilesPerDevice", cfg.scan.maxProfilesPerDevice, "(0=unlimited)");
console.log("method: Safe(live trend)->Brand->Safe(trend)->Brand single-pass");

const t0 = Date.now();
const summary = await runScan(cfg, keywords, (ev) => {
  if (ev.type === "scan-progress" || ev.type === "profile-ready" || ev.type === "keyword-done") {
    const msg = ev.message || ev.type;
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
  }
}, { protectPool: true });

const sec = Math.round((Date.now() - t0) / 1000);
console.log("\n========== DESKTOP-50 DONE ==========");
console.log("scanId", summary.scanId);
console.log("totalAds", summary.totalAds, "betting", summary.bettingAds);
console.log("byDevice", summary.byDevice);
console.log("captchaKeywords", summary.captchaKeywords?.length || 0, summary.captchaKeywords?.slice?.(0, 20));
console.log("ELAPSED_SEC", sec, "ELAPSED_MIN", (sec / 60).toFixed(1));
console.log("END", new Date().toISOString());
