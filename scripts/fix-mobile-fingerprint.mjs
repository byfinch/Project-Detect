/**
 * Force TR-MOBILE-* AdsPower profiles to real mobile fingerprint
 * (explicit Android Mobile Chrome UA + 393x851). Skips PROTECT-PROFILES by default.
 *
 * Usage:
 *   node scripts/fix-mobile-fingerprint.mjs
 *   node scripts/fix-mobile-fingerprint.mjs --all
 *   node scripts/fix-mobile-fingerprint.mjs TR-MOBILE-058
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { loadConfig } from "../dist/config.js";
import { AdsPowerClient } from "../dist/adspower/client.js";
import { sleep } from "../dist/util/time.js";

const forceAll = process.argv.includes("--all");
const only = process.argv.find((a) => /^TR-MOBILE-/.test(a));

/** Must include "Mobile" — Google keys off UA, not just screen width. */
const ANDROID_MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

function loadProtect() {
  const p = "data/PROTECT-PROFILES.txt";
  if (!existsSync(p)) return new Set();
  return new Set(
    readFileSync(p, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
  );
}

/** AdsPower fingerprint_config for mobile Chrome (not desktop). */
function mobileFingerprint() {
  return {
    automatic_timezone: "1",
    language_switch: "0",
    language: ["tr-TR", "tr", "en-US"],
    page_language_switch: "1",
    // Critical: phone screen, not host desktop
    screen_resolution: "393_851",
    webrtc: "proxy",
    canvas: "1",
    webgl_image: "1",
    webgl: "3",
    audio: "1",
    client_rects: "1",
    hardware_concurrency: "8",
    device_memory: "4",
    // Explicit Mobile UA wins over random_ua (AdsPower docs)
    ua: ANDROID_MOBILE_UA,
    random_ua: {
      ua_system_version: ["Android 13", "Android 14", "Android 12"],
    },
    media_devices: "1",
    speech_switch: "1",
    device_name_switch: "2",
    device_name: "Pixel 7",
  };
}

const config = loadConfig();
const ads = new AdsPowerClient(
  config.adspower.baseUrl,
  config.adspower.apiKey,
  config.adspower.requestIntervalMs
);
if (!(await ads.isUp())) {
  console.error("AdsPower down");
  process.exit(2);
}

const protect = loadProtect();
const all = await ads.listProfiles();
let mobiles = all
  .filter((p) => /^TR-MOBILE-/.test(p.name || ""))
  .sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { numeric: true }));

if (only) {
  mobiles = mobiles.filter((p) => p.name === only);
} else if (!forceAll) {
  mobiles = mobiles.filter((p) => !protect.has(p.name || ""));
}

console.log(
  `Updating ${mobiles.length} mobile profiles (protect skipped=${!forceAll && !only ? protect.size : 0})`
);
console.log("UA:", ANDROID_MOBILE_UA.slice(0, 80) + "…");

const fp = mobileFingerprint();
const results = [];

for (const p of mobiles) {
  const name = p.name || p.user_id;
  try {
    await ads.stopBrowser(p.user_id).catch(() => {});
    await sleep(350);
    const body = {
      user_id: p.user_id,
      fingerprint_config: fp,
      // Clean home on next open — not the last brand/trend SERP
      tabs: ["https://www.google.com/?hl=tr&gl=tr"],
    };
    const base = config.adspower.baseUrl.replace(/\/$/, "");
    const res = await fetch(`${base}/api/v1/user/update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.adspower.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const json = await res.json();
    if (json.code !== 0) throw new Error(json.msg || JSON.stringify(json));
    console.log("OK", name, "→ Android Mobile UA + 393x851");
    results.push({ name, ok: true });
  } catch (err) {
    console.log("FAIL", name, String(err).slice(0, 120));
    results.push({ name, ok: false, error: String(err).slice(0, 200) });
  }
  await sleep(900);
}

writeFileSync(
  "data/fix-mobile-fp-results.json",
  JSON.stringify(
    { at: new Date().toISOString(), forceAll, only: only || null, ua: ANDROID_MOBILE_UA, results },
    null,
    2
  )
);
console.log("done", results.filter((r) => r.ok).length, "/", results.length);
console.log("PROTECT left untouched unless --all:", [...protect].join(", "));
process.exit(results.some((r) => !r.ok) ? 1 : 0);
