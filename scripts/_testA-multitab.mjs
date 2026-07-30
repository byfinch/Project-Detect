/* TEST A: çok-sekme serve-rate + kaynak ölçümü (tık yok) */
import { chromium } from "playwright-core";
import fs from "node:fs";
import { execSync } from "node:child_process";

const PROFILES = ["k1ei6w0g", "k1ei6vxi", "k1ei6w9m"];
const KEYWORDS = ["rovbet", "herabet", "vegasslot", "primebahis"];
const REFRESH_MS = 45_000;
const DURATION_MIN = 35;
const API = "http://localhost:50325";
const KEY = process.env.ADSPOWER_API_KEY || "";
const LOG = "/tmp/testA-results.jsonl";
fs.writeFileSync(LOG, "");

const serp = (kw) => `https://www.google.com/search?q=${encodeURIComponent(kw)}&hl=tr&gl=tr&nfpr=1&filter=0&ie=UTF-8&oe=UTF-8&pws=0&num=10`;

async function openProfile(id) {
  const r = await fetch(`${API}/api/v1/browser/start?user_id=${id}&launch_args=${encodeURIComponent(JSON.stringify(["--blink-settings=imagesEnabled=false"]))}`, { headers: { Authorization: `Bearer ${KEY}` } }).then((x) => x.json());
  if (r.code !== 0) throw new Error(id + " open fail " + r.msg);
  const browser = await chromium.connectOverCDP(r.data.ws.puppeteer, { timeout: 25000 });
  return browser;
}

function rec(o) { fs.appendFileSync(LOG, JSON.stringify(o) + "\n"); }

const tabs = []; // {profile, kw, page, refreshNo, alive}
for (const p of PROFILES) {
  try {
    const browser = await openProfile(p);
    const ctx = browser.contexts()[0];
    for (let i = 0; i < KEYWORDS.length; i++) {
      const page = i === 0 ? ctx.pages()[0] : await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      // üretimle birebir mobil emülasyon (applyMobileEmulation)
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }).catch(() => {});
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 393, height: 851, deviceScaleFactor: 2.75, mobile: true, screenWidth: 393, screenHeight: 851 }).catch(() => {});
      const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
      const META = { brands: [{ brand: "Google Chrome", version: "131" }, { brand: "Chromium", version: "131" }, { brand: "Not_A Brand", version: "24" }], platform: "Android", platformVersion: "13.0.0", architecture: "", model: "Pixel 7", mobile: true, bitness: "", wow64: false };
      await cdp.send("Emulation.setUserAgentOverride", { userAgent: UA, platform: "Linux armv81", acceptLanguage: "tr-TR,tr;q=0.9", userAgentMetadata: META }).catch(() => {});
      await cdp.detach().catch(() => {});
      await page.setViewportSize({ width: 393, height: 851 }).catch(() => {});
      await page.goto(serp(KEYWORDS[i]), { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
      tabs.push({ profile: p, kw: KEYWORDS[i], page, refreshNo: 0, alive: true });
    }
    console.log("[A] profile up:", p);
  } catch (e) { console.log("[A] profile FAIL", p, String(e).slice(0, 80)); }
}
console.log("[A] total tabs:", tabs.length);

async function measure(t) {
  t.refreshNo++;
  try {
    if (t.refreshNo > 1) await t.page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
    await t.page.waitForTimeout(2500);
    const r = await Promise.race([
      t.page.evaluate(() => {
        const ads = [];
        for (const c of document.querySelectorAll("[data-text-ad]")) {
          const a = c.querySelector('a[href*="aclk"], a[href*="play.google.com"], a[href^="intent://"]');
          const h = (c.querySelector('[role="heading"], h3')?.textContent || "").trim().slice(0, 50);
          ads.push({ title: h, hasLink: !!a });
        }
        return { ads: ads.length, appAds: ads.filter((a) => /yükle|install|indir/i.test(a.title)).map((a) => a.title.slice(0, 30)), sorry: location.href.includes("/sorry") };
      }),
      new Promise((res) => setTimeout(() => res(null), 12000)),
    ]);
    if (r === null) { rec({ t: Date.now(), p: t.profile, kw: t.kw, n: t.refreshNo, frozen: true }); return; }
    rec({ t: Date.now(), p: t.profile, kw: t.kw, n: t.refreshNo, ads: r.ads, appAds: r.appAds, sorry: r.sorry });
  } catch (e) {
    t.alive = false;
    rec({ t: Date.now(), p: t.profile, kw: t.kw, n: t.refreshNo, dead: String(e).slice(0, 60) });
  }
}

const t0 = Date.now();
let round = 0;
while (Date.now() - t0 < DURATION_MIN * 60_000) {
  round++;
  for (const t of tabs) { if (t.alive) await measure(t); }
  if (round % 4 === 1) {
    try {
      const free = execSync("free -m | awk 'NR==2{print $3\"/\"$2}'").toString().trim();
      const load = execSync("uptime | awk -F'average:' '{print $2}'").toString().trim();
      console.log(`[A] round ${round} · RAM used ${free} MB · load${load} · tabs alive ${tabs.filter((x) => x.alive).length}/${tabs.length}`);
    } catch {}
  }
  const elapsed = Date.now() - t0;
  const wait = Math.max(2000, REFRESH_MS * round - elapsed);
  await new Promise((r) => setTimeout(r, Math.min(wait, REFRESH_MS)));
}

for (const p of PROFILES) await fetch(`${API}/api/v1/browser/stop?user_id=${p}`, { headers: { Authorization: `Bearer ${KEY}` } }).catch(() => {});
console.log("[A] DONE →", LOG);
process.exit(0);
