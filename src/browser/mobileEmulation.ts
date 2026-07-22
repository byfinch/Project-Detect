import type { CDPSession, Page } from "playwright-core";
import { logger } from "../logger.js";

/**
 * Real Android Chrome Mobile UA — not desktop Chrome with a narrow viewport.
 * Desktop UA + phone width still makes Google serve desktop HTML (AI Mode bar, etc.).
 */
export const ANDROID_MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

export const MOBILE_VIEWPORT = { width: 393, height: 851 } as const;

const UA_METADATA = {
  brands: [
    { brand: "Google Chrome", version: "131" },
    { brand: "Chromium", version: "131" },
    { brand: "Not_A Brand", version: "24" },
  ],
  fullVersionList: [
    { brand: "Google Chrome", version: "131.0.6778.135" },
    { brand: "Chromium", version: "131.0.6778.135" },
    { brand: "Not_A Brand", version: "10.0.2.3" },
  ],
  platform: "Android",
  platformVersion: "13.0.0",
  architecture: "",
  model: "Pixel 7",
  mobile: true,
  bitness: "",
  wow64: false,
};

/**
 * Force phone-like browsing for TR-MOBILE profiles:
 * viewport + touch + Mobile UA + Client Hints (mobile:true).
 * Call after BrowserSession.attach, before any Google navigation.
 */
export async function applyMobileEmulation(page: Page): Promise<void> {
  await page.setViewportSize(MOBILE_VIEWPORT).catch(() => {});

  let cdp: CDPSession | null = null;
  try {
    cdp = await page.context().newCDPSession(page);

    await cdp.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    });

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: MOBILE_VIEWPORT.width,
      height: MOBILE_VIEWPORT.height,
      deviceScaleFactor: 2.75,
      mobile: true,
      screenWidth: MOBILE_VIEWPORT.width,
      screenHeight: MOBILE_VIEWPORT.height,
    });

    // Critical: without Mobile UA Google serves desktop SERP/home even at 393px.
    await cdp.send("Emulation.setUserAgentOverride", {
      userAgent: ANDROID_MOBILE_UA,
      platform: "Linux armv81",
      acceptLanguage: "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
      userAgentMetadata: UA_METADATA,
    });

    await cdp.send("Network.setUserAgentOverride", {
      userAgent: ANDROID_MOBILE_UA,
      acceptLanguage: "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
      platform: "Linux armv81",
      userAgentMetadata: UA_METADATA,
    });
  } catch (err) {
    logger.warn({ err: String(err) }, "mobile CDP emulation partial failure");
  } finally {
    // detach must happen even when a send() throws — CDP sessions leak otherwise.
    if (cdp) await cdp.detach().catch(() => {});
  }

  // Sanity log once per attach so we catch desktop UA regressions fast.
  try {
    const info = await page.evaluate(() => ({
      ua: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
      w: window.innerWidth,
      h: window.innerHeight,
    }));
    const isMobileUa = /Mobile|Android/i.test(info.ua);
    logger.info(
      { ...info, isMobileUa },
      isMobileUa ? "mobile emulation OK" : "mobile emulation FAIL — still desktop UA"
    );
  } catch {
    /* page may not be ready */
  }
}
