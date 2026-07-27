/* Debug: app-install adına tık neden kanıt üretmiyor? */
import { chromium } from "playwright-core";

const PROFILE = process.argv[2] || "k1ei6vyg";
const KEYWORD = process.argv[3] || "rovbet";
const API = "http://localhost:50325";
const KEY = process.env.ADSPOWER_API_KEY || "";

async function main() {
  const start = await fetch(`${API}/api/v1/browser/start?user_id=${PROFILE}`, {
    headers: { Authorization: `Bearer ${KEY}` },
  }).then((r) => r.json());
  if (start.code !== 0) throw new Error("open failed: " + JSON.stringify(start));
  const ws = start.data.ws.puppeteer;
  console.log("[dbg] browser started", ws);

  const browser = await chromium.connectOverCDP(ws, { timeout: 20000 });
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || (await ctx.newPage());

  // tüm istekleri yakala
  const seen = [];
  ctx.on("request", (req) => {
    const u = req.url();
    if (/aclk|googleadservices|intent:|play\.google|doubleclick/.test(u)) seen.push(u.slice(0, 140));
  });

  // mobil emülasyon (basit)
  await page.emulateMedia({ colorScheme: "light" }).catch(() => {});
  const url = `https://www.google.com/search?q=${encodeURIComponent(KEYWORD)}&hl=tr&gl=tr&nfpr=1&filter=0&ie=UTF-8&oe=UTF-8&pws=0&num=10`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => console.log("[dbg] goto err", String(e).slice(0, 100)));
  await page.waitForTimeout(3000);
  console.log("[dbg] landed:", page.url().slice(0, 80));

  // kartları incele
  const cards = await page.evaluate(() => {
    const out = [];
    const els = document.querySelectorAll("[data-text-ad], #tads [data-hveid], #tadsb [data-hveid], #tvcap [data-hveid], [data-pcu]");
    for (const c of els) {
      const heading = c.querySelector('[role="heading"], h3');
      const anchors = Array.from(c.querySelectorAll("a[href]")).map((a) => ({
        text: (a.textContent || "").trim().slice(0, 40),
        href: (a.href || "").slice(0, 110),
        cls: (a.className || "").toString().slice(0, 40),
      }));
      const buttons = Array.from(c.querySelectorAll('[role="button"], button')).map((b) => ({
        text: (b.textContent || "").trim().slice(0, 40),
        tag: b.tagName,
      }));
      out.push({
        title: (heading?.textContent || "").trim().slice(0, 60),
        html: c.outerHTML.slice(0, 400),
        anchors,
        buttons,
      });
    }
    return out;
  });
  console.log("[dbg] cards:", cards.length);
  for (const c of cards) {
    console.log("=== CARD:", c.title);
    console.log("  anchors:", JSON.stringify(c.anchors, null, 1));
    console.log("  buttons:", JSON.stringify(c.buttons, null, 1));
    console.log("  html:", c.html.replace(/\s+/g, " ").slice(0, 350));
  }

  // play içeren kartı bul ve TIKLA — koordinatla
  const target = await page.evaluate(() => {
    const els = document.querySelectorAll("[data-text-ad], #tads [data-hveid], #tadsb [data-hveid], #tvcap [data-hveid], [data-pcu]");
    for (const c of els) {
      const play = c.querySelector('a[href*="play.google.com"], a[href^="intent://"]');
      if (!play) continue;
      play.scrollIntoView({ block: "center" });
      const r = play.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, href: (play.href || "").slice(0, 110), w: r.width, h: r.height };
    }
    return null;
  });
  console.log("[dbg] play anchor:", JSON.stringify(target));
  if (target && target.w > 0) {
    const pagesBefore = ctx.pages().length;
    await page.mouse.move(target.x, target.y, { steps: 5 });
    await page.mouse.down(); await page.waitForTimeout(80); await page.mouse.up();
    console.log("[dbg] clicked at", target.x, target.y);
    await page.waitForTimeout(6000);
    console.log("[dbg] after click url:", page.url().slice(0, 110));
    console.log("[dbg] pages:", ctx.pages().length, "(before:", pagesBefore, ")");
  }
  console.log("[dbg] seen requests:", JSON.stringify(seen, null, 1));

  await fetch(`${API}/api/v1/browser/stop?user_id=${PROFILE}`, { headers: { Authorization: `Bearer ${KEY}` } }).catch(() => {});
  process.exit(0);
}
main().catch((e) => { console.error("[dbg] FATAL", e); process.exit(1); });
