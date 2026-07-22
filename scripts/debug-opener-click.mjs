/**
 * Micro-step debug for the report opener click hang.
 * Logs a timestamp between every single CDP call to find the stalling step.
 */
import { loadConfig } from "../dist/config.js";
import { AdsPowerClient } from "../dist/adspower/client.js";
import { BrowserSession } from "../dist/browser/session.js";
import { buildSerpUrl, gotoSerp, prepareGoogleConsent, settleSerpForAds, warmUp } from "../dist/google/serp.js";
import { parseAds } from "../dist/google/adParser.js";
import { sleep } from "../dist/util/time.js";

const PROFILE_NAME = process.argv[2] || "TR-MOBILE-085";
const KEYWORD = process.argv[3] || "rovbet";
const config = loadConfig();
const ads = new AdsPowerClient(config.adspower.baseUrl, config.adspower.apiKey, config.adspower.requestIntervalMs);
const all = await ads.listProfiles();
const profile = all.find((p) => p.name === PROFILE_NAME);
if (!profile) { console.error("not found"); process.exit(2); }

const T = () => new Date().toISOString().slice(17, 23);
const step = (msg) => console.log(`[${T()}] ${msg}`);
const race = (p, ms, label) =>
  Promise.race([p, sleep(ms).then(() => { step(`TIMEOUT(${ms}) @ ${label}`); return "TIMEOUT"; })]);

let session;
try {
  await ads.stopBrowser(profile.user_id).catch(() => {});
  await sleep(800);
  step("ensureBrowser");
  const ws = await ads.ensureBrowser(profile.user_id);
  session = await BrowserSession.attach(ws);
  const page = session.page;
  await prepareGoogleConsent(session);
  const { applyMobileEmulation } = await import("../dist/browser/mobileEmulation.js");
  await applyMobileEmulation(page);

  step("warmUp");
  const warm = await race(warmUp(session, config, {}), 60000, "warmUp");
  if (warm === "TIMEOUT" || warm.captcha) { step("warmup blocked"); process.exit(1); }

  step("gotoSerp");
  await gotoSerp(session, buildSerpUrl(config, KEYWORD), config, {});
  await settleSerpForAds(page, { light: true });
  const adsList = await parseAds(page);
  step(`ads: ${adsList.length}`);
  const target = adsList.find((a) => a.displayDomain) || adsList[0];
  if (!target) { step("no ad"); process.exit(0); }
  step(`target: ${target.displayDomain}`);

  // Find opener coords (same logic as findCardOpenerBox, inline).
  step("find opener");
  const box = await race(page.evaluate((dom) => {
    const norm = (s) => s.toLowerCase().replace(/^(www\.|m\.)/, "").trim();
    const cards = Array.from(document.querySelectorAll("[data-text-ad], #tads [data-hveid], #tadsb [data-hveid], #tvcap [data-hveid], [data-pcu]"));
    for (const c of cards) {
      const text = c.textContent || "";
      if (!text.toLowerCase().includes(dom)) continue;
      const btns = Array.from(c.querySelectorAll('button, [role="button"]'));
      step: for (const b of btns) {
        const r = b.getBoundingClientRect();
        if (r.width > 0 && r.width <= 60) {
          b.scrollIntoView({ block: "center" });
          const r2 = b.getBoundingClientRect();
          return { x: r2.x + r2.width / 2, y: r2.y + r2.height / 2, aria: b.getAttribute("aria-label"), tag: b.tagName, text: (b.textContent || "").slice(0, 20) };
        }
      }
    }
    return null;
  }, target.displayDomain.replace(/^www\./, "")), 10000, "find-opener");
  step(`opener: ${JSON.stringify(box)}`);
  if (!box || box === "TIMEOUT") process.exit(1);

  step("mouse.move");
  await race(page.mouse.move(box.x, box.y), 8000, "mouse.move");
  step("mouse.down");
  await race(page.mouse.down(), 8000, "mouse.down");
  step("mouse.up");
  await race(page.mouse.up(), 8000, "mouse.up");
  step("clicked; wait 1500");
  await sleep(1500);

  step("url now: " + page.url());
  step("frames: " + page.frames().length);

  step("screenshot");
  const r = await race(page.screenshot({ path: "data/debug-opener-click.png", timeout: 6000 }), 8000, "screenshot");
  step("screenshot done: " + (r === "TIMEOUT" ? "TIMEOUT" : "ok"));

  step("evaluate popup state");
  const st = await race(page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'))
      .filter((d) => d.getBoundingClientRect().width > 0)
      .map((d) => (d.textContent || "").slice(0, 120));
    const bildir = Array.from(document.querySelectorAll('[aria-label="Bildir"]')).length;
    return { dialogs, bildirCount: bildir, bodyTextStart: (document.body?.textContent || "").slice(0, 100) };
  }), 8000, "evaluate-state");
  step("state: " + JSON.stringify(st));
} catch (err) {
  step("ERROR: " + String(err));
} finally {
  if (session) await session.detach().catch(() => {});
  await ads.stopBrowser(profile.user_id).catch(() => {});
  step("done");
}
