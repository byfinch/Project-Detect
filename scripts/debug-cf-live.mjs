/**
 * Live CF debug on an ALREADY-OPEN profile (no restart, no navigation).
 * Dumps challenge internals, then tries a slow human-style click.
 * Usage: node scripts/debug-cf-live.mjs <PROFILE_NAME>
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";
import { AdsPowerClient } from "../dist/adspower/client.js";
import { BrowserSession } from "../dist/browser/session.js";
import { sleep } from "../dist/util/time.js";

const PROFILE_NAME = process.argv[2];
if (!PROFILE_NAME) { console.error("profile gerekli"); process.exit(2); }
const outDir = join("data", "cf-debug", `${PROFILE_NAME}-${Date.now().toString(36)}`);
mkdirSync(outDir, { recursive: true });

const config = loadConfig();
const ads = new AdsPowerClient(config.adspower.baseUrl, config.adspower.apiKey, config.adspower.requestIntervalMs);
const all = await ads.listProfiles();
const profile = all.find((p) => p.name === PROFILE_NAME);
if (!profile) { console.error("not found"); process.exit(2); }

const T = () => new Date().toISOString().slice(17, 23);
const step = (m) => console.log(`[${T()}] ${m}`);
const shot = async (page, name) => {
  await page.screenshot({ path: join(outDir, name + ".png"), timeout: 10000 }).catch(() => {});
  step(`[shot] ${name}`);
};

/** Slow eased path with jitter — mimics a hand moving to the checkbox. */
async function humanPathClick(page, tx, ty) {
  const sx = Math.max(10, tx - 150 - Math.random() * 250);
  const sy = Math.max(10, ty - 100 - Math.random() * 180);
  await page.mouse.move(sx, sy, { steps: 8 }).catch(() => {});
  await sleep(150 + Math.random() * 300);
  // wiggle — presence signal
  for (let i = 0; i < 2; i++) {
    await page.mouse.move(sx + (Math.random() * 30 - 15), sy + (Math.random() * 30 - 15), { steps: 4 }).catch(() => {});
    await sleep(80 + Math.random() * 150);
  }
  // eased approach: many steps, decelerating
  const steps = 30 + Math.floor(Math.random() * 15);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = 1 - Math.pow(1 - t, 3); // cubic ease-out
    const jx = (Math.random() - 0.5) * 3 * (1 - t);
    const jy = (Math.random() - 0.5) * 3 * (1 - t);
    await page.mouse.move(sx + (tx - sx) * ease + jx, sy + (ty - sy) * ease + jy).catch(() => {});
    await sleep(8 + Math.random() * 18);
  }
  await sleep(200 + Math.random() * 350);
  await page.mouse.down().catch(() => {});
  await sleep(70 + Math.random() * 90);
  await page.mouse.move(tx + 1, ty + 1).catch(() => {}); // slight drift during hold
  await page.mouse.up().catch(() => {});
}

let session;
try {
  const ws = await ads.ensureBrowser(profile.user_id);
  session = await BrowserSession.attach(ws);
  const pages = session.context.pages();
  step(`tabs: ${pages.length}`);
  let page = pages.find((p) => !/google\.|devtools|chrome:\/\//.test(p.url())) || pages[0];
  step(`using tab: ${page.url().slice(0, 100)}`);

  // Normalize view + wait for the Turnstile widget iframe to render.
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  // Presence signals first — stuck challenge JS often only proceeds after
  // real user activity; a reload forces the widget to re-render.
  await page.mouse.move(120, 300, { steps: 10 }).catch(() => {});
  await sleep(400);
  await page.mouse.move(200, 420, { steps: 12 }).catch(() => {});
  await sleep(600);
  const RELOAD_FIRST = process.argv.includes("--reload");
  if (RELOAD_FIRST) {
    step("reloading challenge page...");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await sleep(2000);
  }
  step("waiting for CF widget iframe (up to 35s)...");
  let widgetFrame = null;
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline && !widgetFrame) {
    widgetFrame = page.frames().find((f) => /challenges\.cloudflare\.com|turnstile/i.test(f.url()));
    if (!widgetFrame) await sleep(1000);
  }
  step(`widget frame: ${widgetFrame ? widgetFrame.url().slice(0, 100) : "NOT RENDERED"}`);

  // Dump challenge internals
  const info = await page.evaluate(() => {
    return {
      url: location.href,
      title: document.title,
      bodyStart: (document.body?.innerText || "").slice(0, 300),
      iframes: Array.from(document.querySelectorAll("iframe")).map((f) => f.src.slice(0, 120)),
      hasTurnstile: !!document.querySelector(".cf-turnstile, [name='cf-turnstile-response']"),
      challengeForm: !!document.querySelector("#challenge-form, #cf-challenge-running"),
      webdriver: navigator.webdriver,
      stageHtml: (document.querySelector("#challenge-stage, .main-content, #content")?.outerHTML || "").slice(0, 600),
    };
  }).catch((e) => ({ err: String(e) }));
  step("page info: " + JSON.stringify(info, null, 1));
  step("frames: " + page.frames().map((f) => f.url().slice(0, 80)).join(" | "));
  await shot(page, "cf-01-state");

  // Find checkbox box in CF iframe — the Turnstile checkbox sits at the
  // LEFT-CENTER of the widget; clicking the middle/right does nothing.
  let clicked = false;
  const framesToTry = widgetFrame ? [widgetFrame] : page.frames();
  for (const frame of framesToTry) {
    const fu = frame.url();
    if (!/challenges\.cloudflare\.com|turnstile|cdn-cgi/i.test(fu)) continue;
    let bb = null;
    for (const sel of ['input[type="checkbox"]', ".ctp-checkbox-label", "label.cb-lb", ".mark", "#challenge-stage", "body"]) {
      try {
        const el = frame.locator(sel).first();
        if (await el.isVisible({ timeout: 900 }).catch(() => false)) {
          bb = await el.boundingBox().catch(() => null);
          if (bb && bb.width > 5) break;
          bb = null;
        }
      } catch { /* next */ }
    }
    if (bb) {
      const tx = bb.x + Math.min(30, bb.width * 0.12) + Math.random() * 8;
      const ty = bb.y + bb.height / 2 + (Math.random() * 8 - 4);
      step(`checkbox target in frame at ${Math.round(tx)},${Math.round(ty)} (widget ${Math.round(bb.width)}x${Math.round(bb.height)})`);
      await humanPathClick(page, tx, ty);
      clicked = true;
      break;
    }
  }
  step(`human click done: ${clicked}`);
  // Poll up to 15s — managed challenge resolves asynchronously after the click.
  let after = null;
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    after = await page.evaluate(() => ({
      title: document.title,
      bodyStart: (document.body?.innerText || "").slice(0, 200),
      stillChallenge: /just a moment|güvenlik doğrulaması|doğrulanıyor|verify you are human|bir dakika/i.test(document.title + " " + (document.body?.innerText || "").slice(0, 2000)),
    })).catch(() => null);
    if (after && !after.stillChallenge) break;
  }
  await shot(page, "cf-02-after-click");

  step("after: " + JSON.stringify(after));
  step(`verdict: ${after && !after.stillChallenge ? "PASSED" : "STILL CHALLENGED"}`);
} catch (err) {
  step("ERROR: " + String(err));
} finally {
  if (session) await session.detach().catch(() => {});
  step("done (browser left open)");
}
