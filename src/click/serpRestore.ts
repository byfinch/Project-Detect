/**
 * Restore the SERP after a click/report detour.
 *
 * history.back() returns the SAME impression from bfcache — a fresh goto
 * re-runs the auction and rotates ad cards, which is exactly how harvest
 * reports lose the card they just saw ("no-form" waves). Fall back to goto
 * only when back() does not land on a Google search page.
 */
import type { Page } from "playwright-core";
import { sleep } from "../util/time.js";

export async function restoreSerp(page: Page, serpUrl: string, gotoTimeoutMs = 25_000): Promise<void> {
  try {
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 6_000 });
    await sleep(1200);
    const u = page.url();
    if (u === serpUrl || /\/search[?#]/.test(u)) return;
  } catch {
    /* no history / busy renderer — goto fallback below */
  }
  await page.goto(serpUrl, { waitUntil: "domcontentloaded", timeout: gotoTimeoutMs }).catch(() => {});
  await sleep(1200);
}
