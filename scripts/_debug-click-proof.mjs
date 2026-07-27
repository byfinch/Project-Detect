/* Debug 3: locateCardAnchor + tık + kanıt penceresi — fail anında DOM dökümü */
import { chromium } from "playwright-core";
import fs from "node:fs";

const PROFILE = process.argv[2];
const KEYWORD = process.argv[3] || "rovbet";
const TITLEHINT = (process.argv[4] || "Grandpashabet").slice(0, 25);
const API = "http://localhost:50325";
const KEY = process.env.ADSPOWER_API_KEY || "";

const start = await fetch(`${API}/api/v1/browser/start?user_id=${PROFILE}`, {
  headers: { Authorization: `Bearer ${KEY}` },
}).then((r) => r.json());
if (start.code !== 0) { console.log("open fail", start); process.exit(1); }
const browser = await chromium.connectOverCDP(start.data.ws.puppeteer, { timeout: 20000 });
const ctx = browser.contexts()[0];
const page = ctx.pages()[0] || (await ctx.newPage());

const proof = [];
ctx.on("request", (req) => {
  const u = req.url();
  if (/\/aclk|googleadservices\.com\/pagead\/aclk|intent:\/\/play\.google\.com/.test(u)) proof.push(u.slice(0, 120));
});

await page.goto(`https://www.google.com/search?q=${encodeURIComponent(KEYWORD)}&hl=tr&gl=tr&nfpr=1&filter=0&ie=UTF-8&oe=UTF-8&pws=0&num=10`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
await page.waitForTimeout(3500);

// locateCardAnchor'un birebir kopyası (isApp=true)
const anchor = await page.evaluate(({ titleHint }) => {
  const cards = Array.from(document.querySelectorAll("[data-text-ad], #tads [data-hveid], #tadsb [data-hveid], #tvcap [data-hveid], [data-pcu]"));
  for (const c of cards) {
    const heading = c.querySelector('[role="heading"], h3');
    const title = (heading?.textContent || "").trim();
    const isTarget = !!(titleHint && title.toLowerCase().includes(titleHint.toLowerCase()));
    if (!isTarget) continue;
    const headingLink = heading?.closest("a");
    const playLink = c.querySelector('a[href*="play.google.com"], a[href^="intent://"]');
    const CTA_RE = /yükle|hemen|install|indir|get/i;
    const CONTROL_RE = /menu|more|close|kapat|diğer|daha fazla|options|ayar/i;
    let cta = null;
    for (const el of Array.from(c.querySelectorAll('[role="button"], button, a[href]'))) {
      const label = `${el.getAttribute("aria-label") || ""} ${String(el.className || "")}`;
      if (CONTROL_RE.test(label)) continue;
      const text = (el.textContent || "").trim();
      if (!text || text.length > 30 || !CTA_RE.test(text)) continue;
      const rr = el.getBoundingClientRect();
      if (rr.width > 0) { cta = el; break; }
    }
    const link = playLink || cta || headingLink || c.querySelector("a[href]");
    if (!link) return { err: "no link" };
    link.scrollIntoView({ block: "center" });
    const r = link.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, picked: link === playLink ? "playLink" : link === cta ? "cta" : "heading", text: (link.textContent || "").trim().slice(0, 40), cardCount: cards.length };
  }
  return { err: "no target card", cardCount: cards.length, titles: cards.map((c) => (c.querySelector('[role="heading"], h3')?.textContent || "").trim().slice(0, 50)) };
}, { titleHint: TITLEHINT });

console.log("[dbg] locate:", JSON.stringify(anchor));

if (anchor && anchor.x) {
  await page.mouse.move(anchor.x, anchor.y, { steps: 5 });
  await page.mouse.down(); await page.waitForTimeout(80); await page.mouse.up();
  await page.waitForTimeout(5000);
  console.log("[dbg] proof requests:", JSON.stringify(proof, null, 1));
  if (proof.length === 0) {
    // FAIL — DOM dök
    const dom = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll("[data-text-ad], [data-hveid], [data-pcu]"));
      return {
        url: location.href.slice(0, 100),
        cardLike: cards.length,
        sample: cards.slice(0, 4).map((c) => ({
          cls: String(c.className).slice(0, 60),
          dataTextAd: c.getAttribute("data-text-ad"),
          heading: (c.querySelector('[role="heading"], h3')?.textContent || "").trim().slice(0, 60),
          anchors: Array.from(c.querySelectorAll("a[href]")).slice(0, 4).map((a) => ({ t: (a.textContent || "").trim().slice(0, 30), h: (a.href || "").slice(0, 60) })),
        })),
      };
    });
    fs.writeFileSync(`/tmp/fail-dom-${PROFILE}.json`, JSON.stringify(dom, null, 1));
    console.log("[dbg] FAIL-DOM:", JSON.stringify(dom, null, 1).slice(0, 3000));
  } else {
    console.log("[dbg] SUCCESS — proof observed");
  }
}

await fetch(`${API}/api/v1/browser/stop?user_id=${PROFILE}`, { headers: { Authorization: `Bearer ${KEY}` } }).catch(() => {});
process.exit(0);
