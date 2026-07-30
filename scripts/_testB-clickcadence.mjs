/* TEST B+C: güvenli tempoda tık+şikayet kadansı — başarı, kalıcılık, duvar sinyali */
import { chromium } from "playwright-core";
import fs from "node:fs";

const PROFILES = ["k1ei6vy8", "k1ei6w8e"];
const KEYWORD = "rovbet";
const CYCLE_MS = 150_000; // IP başına ~24 sorgu/saat
const DURATION_MIN = 40;
const API = "http://localhost:50325";
const KEY = process.env.ADSPOWER_API_KEY || "";
const LOG = "/tmp/testB-results.jsonl";
fs.writeFileSync(LOG, "");
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const serp = `https://www.google.com/search?q=${KEYWORD}&hl=tr&gl=tr&nfpr=1&filter=0&ie=UTF-8&oe=UTF-8&pws=0&num=10`;

function rec(o) { fs.appendFileSync(LOG, JSON.stringify(o) + "\n"); }

async function runProfile(profile) {
  const r = await fetch(`${API}/api/v1/browser/start?user_id=${profile}&launch_args=${encodeURIComponent(JSON.stringify(["--blink-settings=imagesEnabled=false"]))}`, { headers: { Authorization: `Bearer ${KEY}` } }).then((x) => x.json());
  if (r.code !== 0) { console.log("[B] open fail", profile); return; }
  const browser = await chromium.connectOverCDP(r.data.ws.puppeteer, { timeout: 25000 });
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }).catch(() => {});
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 393, height: 851, deviceScaleFactor: 2.75, mobile: true }).catch(() => {});
  await cdp.send("Emulation.setUserAgentOverride", { userAgent: UA, platform: "Linux armv81" }).catch(() => {});
  await page.setViewportSize({ width: 393, height: 851 }).catch(() => {});

  const proofs = [];
  ctx.on("request", (req) => { const u = req.url(); if (/\/aclk|googleadservices\.com\/pagead\/aclk|intent:\/\/play\.google\.com/.test(u)) proofs.push(u.slice(0, 60)); });

  const t0 = Date.now();
  let cycle = 0;
  await page.goto(serp, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
  while (Date.now() - t0 < DURATION_MIN * 60_000) {
    cycle++;
    if (cycle > 1) await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const state = await Promise.race([
      page.evaluate(() => {
        const out = { cards: [], sorry: location.href.includes("/sorry") };
        for (const c of document.querySelectorAll("[data-text-ad]")) {
          const a = c.querySelector('a[href*="aclk"]');
          const h = (c.querySelector('[role="heading"], h3')?.textContent || "").trim().slice(0, 40);
          if (a) { a.scrollIntoView({ block: "center" }); const r = a.getBoundingClientRect(); out.cards.push({ title: h, x: r.x + r.width / 2, y: r.y + r.height / 2 }); }
        }
        return out;
      }),
      new Promise((res) => setTimeout(() => res(null), 12000)),
    ]);
    if (!state) { rec({ p: profile, cycle, frozen: true }); continue; }
    if (state.sorry) { rec({ p: profile, cycle, sorry: true }); console.log("[B] SORRY:", profile); break; }
    const appCards = state.cards.filter((c) => /yükle|install|indir/i.test(c.title));
    proofs.length = 0;
    let clicked = false;
    if (appCards.length > 0) {
      const c = appCards[0];
      try {
        // tık (üretim yolu: _blank + mouse)
        await page.evaluate(({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          const a = el?.closest("a"); if (a) a.setAttribute("target", "_blank");
        }, { x: c.x, y: c.y });
        await page.mouse.move(c.x, c.y, { steps: 5 });
        await page.mouse.down(); await page.waitForTimeout(80); await page.mouse.up();
        clicked = true;
      } catch (e) { rec({ p: profile, cycle, clickError: String(e).slice(0, 60) }); }
      await page.waitForTimeout(5000);
    }
    // yeni sekmeleri kapat
    const pages = ctx.pages();
    for (let i = 1; i < pages.length; i++) await pages[i].close().catch(() => {});
    const alive = await Promise.race([page.evaluate(() => 1).then(() => true, () => false), new Promise((res) => setTimeout(() => res(false), 5000))]);
    rec({
      p: profile, cycle,
      ads: state.cards.length, appCards: appCards.length,
      clicked, proof: proofs.length > 0, rendererAlive: alive,
      titles: appCards.map((c) => c.title.slice(0, 25)),
    });
    console.log(`[B] ${profile} tur ${cycle}: ads=${state.cards.length} app=${appCards.length} tık=${clicked} kanıt=${proofs.length > 0}`);
    // sonraki tura kadar bekle
    const wait = CYCLE_MS - (Date.now() - t0 - (cycle - 1) * CYCLE_MS);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  await fetch(`${API}/api/v1/browser/stop?user_id=${profile}`, { headers: { Authorization: `Bearer ${KEY}` } }).catch(() => {});
  console.log("[B] done:", profile);
}

await Promise.all(PROFILES.map(runProfile));
console.log("[B] ALL DONE →", LOG);
process.exit(0);
