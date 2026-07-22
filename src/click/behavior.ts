import type { Page } from "playwright-core";
import { jitterDelay, randInt } from "../util/time.js";
import type { ClickBehaviorConfig } from "./types.js";
import { personaFor, type ScrollStyle } from "../util/persona.js";
import { logger } from "../logger.js";

function randomBetween(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function scrollParams(style: ScrollStyle): { distMin: number; distMax: number; stepsMin: number; stepsMax: number } {
  if (style === "calm") return { distMin: 120, distMax: 400, stepsMin: 2, stepsMax: 5 };
  if (style === "active") return { distMin: 350, distMax: 1100, stepsMin: 5, stepsMax: 12 };
  return { distMin: 200, distMax: 800, stepsMin: 3, stepsMax: 8 };
}

/** Wait a random duration inside the configured range. */
export async function naturalWait(minMs: number, maxMs: number): Promise<number> {
  const ms = Math.floor(randomBetween(minMs, maxMs));
  await jitterDelay(ms, ms);
  return ms;
}

/** Slow, human-like scroll; style can be persona-driven. */
export async function naturalScroll(
  page: Page,
  device: "desktop" | "mobile",
  style: ScrollStyle = "normal"
): Promise<void> {
  const p = scrollParams(style);
  const direction = Math.random() > 0.5 ? 1 : -1;
  const distance = randInt(p.distMin, p.distMax) * direction;
  const steps = randInt(p.stepsMin, p.stepsMax);
  const stepPause = style === "calm" ? [200, 550] : style === "active" ? [80, 280] : [150, 400];

  try {
    for (let i = 0; i < steps; i++) {
      const step = Math.floor(distance / steps);
      await page.mouse.wheel(0, step);
      await jitterDelay(stepPause[0]!, stepPause[1]!);
    }
    await jitterDelay(300, 900);
  } catch (err) {
    logger.debug({ err: String(err) }, "naturalScroll failed (ignored)");
  }
}

/** Random mouse movements on desktop. */
export async function randomMouseMoves(page: Page): Promise<void> {
  try {
    const viewport = page.viewportSize();
    if (!viewport) return;
    const moves = randInt(2, 5);
    for (let i = 0; i < moves; i++) {
      const x = randInt(50, Math.max(51, viewport.width - 50));
      const y = randInt(50, Math.max(51, viewport.height - 50));
      await page.mouse.move(x, y);
      await jitterDelay(100, 300);
    }
  } catch (err) {
    logger.debug({ err: String(err) }, "randomMouseMoves failed (ignored)");
  }
}

/** Click a random internal link on the landing page, with some probability. */
const NEVER_CLICK_HOSTS = /(^|\.)cloudflare\.com$|challenges\.cloudflare\.com/i;

export async function maybeClickInternalLink(
  page: Page,
  config: ClickBehaviorConfig,
  device: "desktop" | "mobile"
): Promise<number> {
  if (Math.random() > config.internalLinkChance) return 0;

  try {
    const links = await page.$$eval(
      'a[href]:not([href^="#"]):not([href^="javascript:"]):not([href^="mailto:"])',
      (els) =>
        els
          .map((el) => ({
            href: el.getAttribute("href") || "",
            text: (el.textContent || "").trim().slice(0, 80),
            rect: el.getBoundingClientRect(),
          }))
          .filter((l) => l.rect.width > 0 && l.rect.height > 0 && l.href.startsWith("http"))
    );

    // On a challenge page the only links are Cloudflare's own footer links —
    // clicking them lands on cloudflare.com corporate site (seen live).
    const safeLinks = links.filter((l) => {
      try {
        return !NEVER_CLICK_HOSTS.test(new URL(l.href).hostname);
      } catch {
        return false;
      }
    });
    if (safeLinks.length === 0) return 0;

    const target = safeLinks[randInt(0, safeLinks.length - 1)];
    if (!target) return 0;

    const el = await page.$(`a[href="${target.href}"]`);
    if (!el) return 0;

    await el.scrollIntoViewIfNeeded();
    await jitterDelay(300, 800);
    await el.click();
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    const stay = await naturalWait(config.minInternalStayMs, config.maxInternalStayMs);
    if (Math.random() < config.scrollChance) {
      await naturalScroll(page, device, "normal");
    }
    return stay;
  } catch (err) {
    logger.debug({ err: String(err) }, "internal link click failed (ignored)");
    return 0;
  }
}

/** Full landing behaviour: wait, scroll, maybe move mouse, maybe click internal link. */
export async function behaveOnLanding(
  page: Page,
  device: "desktop" | "mobile",
  config: ClickBehaviorConfig,
  profileKey?: string
): Promise<{ stayMs: number; internalClicks: number }> {
  const persona = profileKey ? personaFor(profileKey) : null;
  const stayMs = await naturalWait(config.minStayMs, config.maxStayMs);

  if (device === "desktop" && Math.random() < config.mouseMoveChance) {
    await randomMouseMoves(page);
  }

  if (Math.random() < config.scrollChance) {
    await naturalScroll(page, device, persona?.scrollStyle ?? "normal");
  }

  const internalStay = await maybeClickInternalLink(page, config, device);

  return { stayMs: stayMs + internalStay, internalClicks: internalStay > 0 ? 1 : 0 };
}

/** Light SERP browse before parsing ads (scan path) — persona-aware. */
export async function browseSerpNaturally(
  page: Page,
  device: "desktop" | "mobile",
  profileKey: string
): Promise<void> {
  const p = personaFor(profileKey);
  await naturalWait(Math.floor(800 * p.preClickScale), Math.floor(2200 * p.preClickScale));
  if (Math.random() < p.scrollChance) {
    await naturalScroll(page, device, p.scrollStyle);
  }
  if (device === "desktop" && Math.random() < p.mouseMoveChance) {
    await randomMouseMoves(page);
  }
  await naturalWait(400, 1200);
}
