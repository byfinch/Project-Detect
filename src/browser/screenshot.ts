import type { Page } from "playwright-core";
import { logger } from "../logger.js";

const HIDE_SCROLLBAR_CSS = `
html, body, * {
  scrollbar-width: none !important; /* Firefox */
  -ms-overflow-style: none !important; /* legacy Edge */
}
html::-webkit-scrollbar,
body::-webkit-scrollbar,
*::-webkit-scrollbar {
  width: 0 !important;
  height: 0 !important;
  display: none !important;
  background: transparent !important;
}
`;

/**
 * Capture a page screenshot without desktop-style scrollbars (report-clean mobile look).
 * Injects temporary CSS, shoots, then removes the style tag.
 */
export async function screenshotWithoutScrollbar(
  page: Page,
  path: string,
  opts: { fullPage?: boolean } = {}
): Promise<string | null> {
  const fullPage = opts.fullPage !== false;
  const jpeg = path.toLowerCase().endsWith(".jpg") || path.toLowerCase().endsWith(".jpeg");
  let styleHandle: Awaited<ReturnType<Page["addStyleTag"]>> | null = null;
  try {
    styleHandle = await page.addStyleTag({ content: HIDE_SCROLLBAR_CSS }).catch(() => null);
    // One frame so styles apply before capture
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r()))).catch(() => {});
    await page.screenshot(jpeg ? { path, fullPage, type: "jpeg", quality: 72 } : { path, fullPage });
    return path;
  } catch (err) {
    logger.debug({ path, err: String(err) }, "screenshotWithoutScrollbar failed");
    return null;
  } finally {
    if (styleHandle) {
      await styleHandle.evaluate((el) => (el as HTMLElement).remove()).catch(() => {});
    }
  }
}
