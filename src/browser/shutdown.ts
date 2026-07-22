import type { AdsPowerClient } from "../adspower/client.js";
import type { BrowserSession } from "./session.js";
import { logger } from "../logger.js";

/** Clean landing after any scan/captcha/proxy failure — never leave /sorry or brand SERP. */
export const SAFE_GOOGLE_HOME = "https://www.google.com/?hl=tr&gl=tr";

/**
 * Leave the profile on Google home so the next manual/AdsPower open is safe.
 * Closes extra tabs; does NOT wipe cookies/trust.
 */
export async function resetSessionTabsForClose(
  session: BrowserSession,
  homeUrl: string = SAFE_GOOGLE_HOME
): Promise<void> {
  try {
    const context = session.context;
    const pages = context.pages().filter((p) => {
      const u = p.url();
      return !u.startsWith("devtools://") && !u.startsWith("chrome-extension://");
    });
    const keep = pages[0] ?? (await context.newPage());
    for (const p of pages) {
      if (p !== keep) await p.close().catch(() => {});
    }
    // Google ana sayfa — about:blank veya /search?q=brand / /sorry bırakma
    await keep.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(async () => {
      await keep.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 8_000 }).catch(() => {});
    });
  } catch (err) {
    logger.debug({ err: String(err) }, "resetSessionTabsForClose failed (non-fatal)");
  }
}

/**
 * Clean profile shutdown: Google home → pin startup tab → detach → AdsPower stop.
 */
export async function gracefulProfileShutdown(
  ads: AdsPowerClient,
  session: BrowserSession | null,
  userId: string
): Promise<void> {
  if (session) {
    await resetSessionTabsForClose(session, SAFE_GOOGLE_HOME);
    await session.detach().catch(() => {});
  }
  // Next AdsPower open restores Google home, not last brand SERP
  await ads.setStartupTabs(userId, [SAFE_GOOGLE_HOME]).catch((err) => {
    logger.debug({ userId, err: String(err) }, "setStartupTabs Google home failed (non-fatal)");
  });
  await ads.stopBrowser(userId, true).catch((err) => {
    logger.debug({ userId, err: String(err) }, "stopBrowser after graceful shutdown failed");
  });
}
