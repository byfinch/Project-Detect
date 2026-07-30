/* TEST A2: güvenli tempo (IP başına 40 sorgu/saat) serve-rate ölçümü, tık yok */
import { chromium } from "playwright-core";
import fs from "node:fs";
import { execSync } from "node:child_process";

const SETUP = [
  { profile: "k1ei6w2w", kws: ["rovbet", "herabet"] },
  { profile: "k1ei6wgi", kws: ["rovbet", "vegasslot"] },
  { profile: "k1ei6wbu", kws: ["herabet", "primebahis"] },
  { profile: "k1ei6w21", kws: ["rovbet", "napolibet"] },
];
const REFRESH_MS = 180_000; // sekme başına 20/saat → IP başına 40/saat
const DURATION_MIN = 60;
const API = "http://localhost:50325";
const KEY = process.env.ADSPOWER_API_KEY || "";
const LOG = "/tmp/testA2-results.jsonl";
fs.writeFileSync(LOG, "");

const serp = (kw) => `https://www.google.com/search?q=${encodeURIComponent(kw)}&hl=tr&gl=tr&nfpr=1&filter=0&ie=UTF-8&oe=UTF-8&pws=0&num=10`;
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

async function mobileEmu(ctx, page) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }).catch(() => {});
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 393, height: 851, deviceScaleFactor: 2.75, mobile: true, screenWidth: 393, screenHeight: 851 }).catch(() => {});
  await cdp.send("Emulation.setUserAgentOverride", { userAgent: UA, platform: "Linux armv81", acceptLanguage: "tr-TR,tr;q=0.9" }).catch(() => {});
  await cdp.detach().catch(() => {});
  await page.setViewportSize({ width: 393, height: 851 }).catch(() => {});
}

function rec(o) { fs.appendFileSync(LOG, JSON.stringify(o) + "\n"); }

const tabs = [];
for (const s of SETUP) {
  try {
    const r = await fetch(`${API}/api/v1/browser/start?user_id=${s.profile}&launch_args=${encodeURIComponent(JSON.stringify(["--blink-settings=imagesEnabled=false"]))}`, { headers: { Authorization: `Bearer ${KEY}` } }).then((x) => x.json());
    if (r.code !== 0) { console.log("[A2] open fail", s.profile, r.msg); continue; }
    const browser = await chromium.connectOverCDP(r.data.ws.puppeteer, { timeout: 25000 });
    const ctx = browser.contexts()[0];
    for (let i = 0; i < s.kws.length; i++) {
      const page = i === 0 ? ctx.pages()[0] : await ctx.newPage();
      await mobileEmu(ctx, page);
      await page.goto(serp(s.kws[i]), { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
      tabs.push({ profile: s.profile, kw: s.kws[i], page, refreshNo: 0, alive: true, lastRefresh: 0 });
    }
    console.log("[A2] up:", s.profile);
  } catch (e) { console.log("[A2] FAIL", s.profile, String(e).slice(0, 80)); }
}
console.log("[A2] tabs:", tabs.length);

async function measure(t) {
  t.refreshNo++;
  try {
    if (t.refreshNo > 1) await t.page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
    await t.page.waitForTimeout(2500);
    const r = await Promise.race([
      t.page.evaluate(() => {
        const ads = [];
        for (const c of document.querySelectorAll("[data-text-ad]")) {
          const h = (c.querySelector('[role="heading"], h3')?.textContent || "").trim().slice(0, 50);
          ads.push(h);
        }
        return { ads: ads.length, titles: ads.slice(0, 5), sorry: location.href.includes("/sorry") };
      }),
      new Promise((res) => setTimeout(() => res(null), 12000)),
    ]);
    if (r === null) { rec({ t: Date.now(), p: t.profile, kw: t.kw, n: t.refreshNo, frozen: true }); return; }
    rec({ t: Date.now(), p: t.profile, kw: t.kw, n: t.refreshNo, ads: r.ads, titles: r.titles, sorry: r.sorry });
    if (r.sorry) console.log("[A2] SORRY WALL:", t.profile, t.kw);
  } catch (e) {
    t.alive = false;
    rec({ t: Date.now(), p: t.profile, kw: t.kw, n: t.refreshNo, dead: String(e).slice(0, 60) });
  }
}

const t0 = Date.now();
let lastStat = 0;
while (Date.now() - t0 < DURATION_MIN * 60_000) {
  const now = Date.now();
  for (const t of tabs) {
    if (t.alive && now - t.lastRefresh >= REFRESH_MS) {
      t.lastRefresh = now;
      await measure(t);
      await new Promise((r) => setTimeout(r, 3000 + Math.random() * 4000)); // jitter
    }
  }
  if (now - lastStat > 300_000) {
    lastStat = now;
    try {
      const free = execSync("free -m | awk 'NR==2{print $3\"/\"$2}'").toString().trim();
      const load = execSync("uptime | awk -F'average:' '{print $2}'").toString().trim();
      console.log(`[A2] ${Math.round((now - t0) / 60000)}dk · RAM ${free}MB · load${load} · alive ${tabs.filter((x) => x.alive).length}/${tabs.length}`);
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 5000));
}

for (const s of SETUP) await fetch(`${API}/api/v1/browser/stop?user_id=${s.profile}`, { headers: { Authorization: `Bearer ${KEY}` } }).catch(() => {});
console.log("[A2] DONE →", LOG);
process.exit(0);
