/* Gözcü + Test B: reklam zenginliği eşiği geçince tık kadansını ölç */
import { chromium } from "playwright-core";
import fs from "node:fs";

process.on("unhandledRejection", (e) => console.log("[guard] unhandledRejection:", String(e).slice(0, 120)));
process.on("uncaughtException", (e) => console.log("[guard] uncaughtException:", String(e).slice(0, 120)));

const WATCH_PROFILE = "k1ei6w2w";
const B_PROFILES = ["k1ei6w2w", "k1ei6wbu"];
const KEYWORD = "rovbet";
const PROBE_EVERY_MS = 15 * 60_000;
const RICH_THRESHOLD = 2; // app-reklam kartı sayısı
const MAX_WAIT_H = 12;
const B_DURATION_MIN = 40;
const B_CYCLE_MS = 150_000;
const API = "http://localhost:50325";
const KEY = process.env.ADSPOWER_API_KEY || "";
const LOG = "/tmp/testB-results.jsonl";
const WLOG = "/tmp/testB-watch.jsonl";
fs.writeFileSync(LOG, ""); fs.writeFileSync(WLOG, "");
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const serp = `https://www.google.com/search?q=${KEYWORD}&hl=tr&gl=tr&nfpr=1&filter=0&ie=UTF-8&oe=UTF-8&pws=0&num=10`;

function rec(f, o) { fs.appendFileSync(f, JSON.stringify(o) + "\n"); }

async function openMobile(profile) {
  const r = await fetch(`${API}/api/v1/browser/start?user_id=${profile}&launch_args=${encodeURIComponent(JSON.stringify(["--blink-settings=imagesEnabled=false"]))}`, { headers: { Authorization: `Bearer ${KEY}` } }).then((x) => x.json());
  if (r.code !== 0) throw new Error("open fail " + profile);
  const browser = await chromium.connectOverCDP(r.data.ws.puppeteer, { timeout: 25000 });
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }).catch(() => {});
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 393, height: 851, deviceScaleFactor: 2.75, mobile: true }).catch(() => {});
  await cdp.send("Emulation.setUserAgentOverride", { userAgent: UA, platform: "Linux armv81" }).catch(() => {});
  await page.setViewportSize({ width: 393, height: 851 }).catch(() => {});
  return { browser, ctx, page };
}
async function closeMobile(profile) { await fetch(`${API}/api/v1/browser/stop?user_id=${profile}`, { headers: { Authorization: `Bearer ${KEY}` } }).catch(() => {}); }

async function countAppCards(page) {
  const st = await Promise.race([
    page.evaluate(() => {
      let app = 0, ads = 0;
      for (const c of document.querySelectorAll("[data-text-ad]")) {
        ads++;
        const h = (c.querySelector('[role="heading"], h3')?.textContent || "");
        if (/yükle|install|indir/i.test(h)) app++;
      }
      return { ads, app, sorry: location.href.includes("/sorry") };
    }),
    new Promise((res) => setTimeout(() => res(null), 12000)),
  ]);
  return st;
}

// 1) GÖZCÜ: zengin pencereyi yakala
const t0 = Date.now();
let rich = false;
while (Date.now() - t0 < MAX_WAIT_H * 3_600_000 && !rich) {
  try {
    const { page } = await openMobile(WATCH_PROFILE);
    await page.goto(serp, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const st = await countAppCards(page);
    await closeMobile(WATCH_PROFILE);
    rec(WLOG, { t: Date.now(), ads: st?.ads, app: st?.app, sorry: st?.sorry });
    console.log(`[watch] app=${st?.app} ads=${st?.ads} sorry=${st?.sorry}`);
    if (st && st.app >= RICH_THRESHOLD) rich = true;
    else await new Promise((r) => setTimeout(r, PROBE_EVERY_MS));
  } catch (e) {
    console.log("[watch] err", String(e).slice(0, 60));
    await closeMobile(WATCH_PROFILE);
    await new Promise((r) => setTimeout(r, PROBE_EVERY_MS));
  }
}
if (!rich) { console.log("[watch] zengin pencere bulunamadı, çıkılıyor"); process.exit(0); }
console.log("[watch] ZENGİN PENCERE — Test B başlıyor");

// 2) TEST B: tık kadansı
async function runB(profile) {
  const { ctx, page } = await openMobile(profile);
  const proofs = [];
  ctx.on("request", (req) => { const u = req.url(); if (/\/aclk|googleadservices\.com\/pagead\/aclk|intent:\/\/play\.google\.com/.test(u)) proofs.push(u.slice(0, 60)); });
  const t0 = Date.now();
  let cycle = 0;
  await page.goto(serp, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
  while (Date.now() - t0 < B_DURATION_MIN * 60_000) {
    cycle++;
    if (cycle > 1) await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const state = await Promise.race([
      page.evaluate(() => {
        const out = { cards: [], sorry: location.href.includes("/sorry") };
        for (const c of document.querySelectorAll("[data-text-ad]")) {
          const a = c.querySelector('a[href*="aclk"]');
          const h = (c.querySelector('[role="heading"], h3')?.textContent || "").trim().slice(0, 40);
          if (a && /yükle|install|indir/i.test(h)) { a.scrollIntoView({ block: "center" }); const r = a.getBoundingClientRect(); out.cards.push({ title: h, x: r.x + r.width / 2, y: r.y + r.height / 2 }); }
        }
        return out;
      }),
      new Promise((res) => setTimeout(() => res(null), 12000)),
    ]);
    if (!state) { rec(LOG, { p: profile, cycle, frozen: true }); continue; }
    if (state.sorry) { rec(LOG, { p: profile, cycle, sorry: true }); console.log("[B] SORRY:", profile); break; }
    proofs.length = 0;
    let clicked = false, proof = false;
    if (state.cards.length > 0) {
      const c = state.cards[0];
      try {
        await page.evaluate(({ x, y }) => { const el = document.elementFromPoint(x, y); const a = el?.closest("a"); if (a) a.setAttribute("target", "_blank"); }, { x: c.x, y: c.y });
        await page.mouse.move(c.x, c.y, { steps: 5 });
        await page.mouse.down(); await page.waitForTimeout(80); await page.mouse.up();
        clicked = true;
      } catch (e) { rec(LOG, { p: profile, cycle, clickError: String(e).slice(0, 60) }); }
      await page.waitForTimeout(5000);
      proof = proofs.length > 0;
      const pages = ctx.pages();
      for (let i = 1; i < pages.length; i++) await pages[i].close().catch(() => {});
    }
    rec(LOG, { p: profile, cycle, appCards: state.cards.length, clicked, proof, titles: state.cards.map((c) => c.title.slice(0, 25)) });
    console.log(`[B] ${profile} tur ${cycle}: app=${state.cards.length} tık=${clicked} kanıt=${proof}`);
    const wait = B_CYCLE_MS - (Date.now() - t0 - (cycle - 1) * B_CYCLE_MS);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  await closeMobile(profile);
  console.log("[B] done:", profile);
}
await Promise.all(B_PROFILES.map((p) => runB(p).catch((e) => console.log("[B] profile crash", p, String(e).slice(0, 100)))));
console.log("[B] ALL DONE →", LOG);
process.exit(0);
