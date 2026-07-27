/* Debug 2: reklam DOM'unu ham dök */
import { chromium } from "playwright-core";

const PROFILE = process.argv[2] || "k1ei6vyg";
const KEYWORD = process.argv[3] || "rovbet";
const API = "http://localhost:50325";
const KEY = process.env.ADSPOWER_API_KEY || "";

const start = await fetch(`${API}/api/v1/browser/start?user_id=${PROFILE}`, {
  headers: { Authorization: `Bearer ${KEY}` },
}).then((r) => r.json());
const browser = await chromium.connectOverCDP(start.data.ws.puppeteer, { timeout: 20000 });
const ctx = browser.contexts()[0];
const page = ctx.pages()[0] || (await ctx.newPage());

await page.goto(`https://www.google.com/search?q=${encodeURIComponent(KEYWORD)}&hl=tr&gl=tr&nfpr=1&filter=0&ie=UTF-8&oe=UTF-8&pws=0&num=10`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
await page.waitForTimeout(3000);

const dump = await page.evaluate(() => {
  const out = { playAnchors: [], sponsoredText: [], containers: [] };
  for (const a of document.querySelectorAll('a[href*="play.google.com"], a[href^="intent://"], a[href*="aclk"]')) {
    const r = a.getBoundingClientRect();
    out.playAnchors.push({
      text: (a.textContent || "").trim().slice(0, 50),
      href: (a.href || "").slice(0, 100),
      visible: r.width > 0,
      parents: (() => { const p = []; let el = a; for (let i = 0; i < 6 && el; i++) { el = el.parentElement; if (el) p.push(el.tagName + "." + (typeof el.className === "string" ? el.className.slice(0, 30) : "") + (el.getAttribute("data-text-ad") !== null ? "[data-text-ad]" : "") + (el.getAttribute("data-hveid") ? "[hveid]" : "")); } return p; })(),
    });
  }
  for (const el of document.querySelectorAll("span, div")) {
    const t = (el.textContent || "").trim();
    if ((t === "Reklam" || t === "Sponsorlu" || t === "Ücretli sponsorlu reklam") && el.children.length === 0) {
      out.sponsoredText.push(t);
    }
  }
  return out;
});
console.log(JSON.stringify(dump, null, 1).slice(0, 4000));

await fetch(`${API}/api/v1/browser/stop?user_id=${PROFILE}`, { headers: { Authorization: `Bearer ${KEY}` } }).catch(() => {});
process.exit(0);
