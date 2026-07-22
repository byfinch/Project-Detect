import type { Page } from "playwright-core";
import type { BrowserSession } from "../browser/session.js";
import type { RedirectHop, HopType } from "../types.js";
import { hostnameOf } from "../util/url.js";
import { logger } from "../logger.js";
import { sleep } from "../util/time.js";

export interface ResolveOptions {
  hopCap: number;
  timeoutMs: number;
  referer?: string;
  settleMs?: number;
  bettingKeywords: string[];
}

export interface ResolveOutcome {
  finalUrl: string;
  finalDomain: string | null;
  hops: RedirectHop[];
  /** Reached a genuine destination (betting keywords OR a login/register UI). Used for dead-end detection. */
  reachedRealSite: boolean;
  /** Stronger signal: betting/gambling vocabulary was present on the final page. */
  bettingSignal: boolean;
  deadEnd: boolean;
}

function normalizeForCycle(url: string): string {
  try {
    const u = new URL(url);
    // Ignore volatile query/hash so token-varying loops are still caught.
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * Navigate to `startUrl` inside a fresh tab of the profile's context and follow the
 * full redirect chain (HTTP 3xx + meta refresh + JS location) to the real destination.
 *
 * Runs through the SAME AdsPower profile/proxy as the SERP scan, so TR-geofenced
 * cloakers serve the real chain instead of a decoy.
 */
export async function resolveLanding(session: BrowserSession, startUrl: string, opts: ResolveOptions): Promise<ResolveOutcome> {
  const settleMs = opts.settleMs ?? 6000;
  const page: Page = await session.newPage();

  // Ordered backbone: every main-frame document response (3xx redirects AND committed docs).
  const docHops: Array<{ url: string; status: number; atMs: number }> = [];
  // JS-initiated navigation targets reported by the init-script instrumentation.
  const jsTargets = new Set<string>();
  const t0 = Date.now();

  page.on("response", (resp) => {
    try {
      const req = resp.request();
      if (req.frame() !== page.mainFrame()) return;
      if (req.resourceType() !== "document") return;
      docHops.push({ url: resp.url(), status: resp.status(), atMs: Date.now() - t0 });
    } catch {
      /* ignore */
    }
  });

  // Instrument client-side redirects so we can classify (and see gesture-gated targets
  // even when a later geo/headless check blocks the actual navigation).
  try {
    await page.exposeFunction("__detectHop", (target: string) => {
      try {
        jsTargets.add(new URL(target, page.url()).href);
      } catch {
        jsTargets.add(target);
      }
    });
    await page.addInitScript(() => {
      const report = (u: unknown) => {
        try {
          if (typeof u === "string" && u) (window as any).__detectHop?.(u);
        } catch {
          /* ignore */
        }
      };
      try {
        const origAssign = window.location.assign.bind(window.location);
        const origReplace = window.location.replace.bind(window.location);
        (window.location as any).assign = (u: string) => {
          report(u);
          return origAssign(u);
        };
        (window.location as any).replace = (u: string) => {
          report(u);
          return origReplace(u);
        };
        const origOpen = window.open;
        (window as any).open = (u?: string, ...rest: any[]) => {
          report(u);
          return origOpen ? (origOpen as any)(u, ...rest) : null;
        };
      } catch {
        /* ignore */
      }
    });
  } catch (err) {
    logger.debug({ err: String(err) }, "resolver instrumentation setup failed (continuing)");
  }

  let deadEnd = false;
  try {
    await page.goto(startUrl, {
      referer: opts.referer,
      waitUntil: "domcontentloaded",
      timeout: opts.timeoutMs,
    });
  } catch (err) {
    logger.debug({ startUrl, err: String(err) }, "initial goto did not fully settle");
  }

  // Cloudflare "doğrulama kutusu" (Turnstile checkbox) — click / CapSolver if needed.
  try {
    const { passCloudflareIfPresent } = await import("../captcha/cloudflare.js");
    // Config optional on ResolveOptions — loaded lazily via global config not available here.
    // Callers that need solver must use click path; here we at least click the box.
    const { loadConfig } = await import("../config.js");
    const cfg = loadConfig();
    const cf = await passCloudflareIfPresent(page, cfg, { timeoutMs: 60_000 });
    if (!cf.passed && cf.method !== "none") {
      logger.warn({ method: cf.method, url: page.url().slice(0, 100) }, "Cloudflare still blocking landing");
    }
  } catch (err) {
    logger.debug({ err: String(err) }, "Cloudflare pass attempt failed (continuing)");
  }

  // Active settle: wait until the URL is stable for `settleMs`, bounded by its OWN deadline
  // (measured from after navigation, so a slow goto doesn't consume the whole settle budget),
  // plus hop cap / cycle detection.
  const seen = new Set<string>();
  let lastUrl = "";
  let stableSince = Date.now();
  const settleDeadline = Date.now() + opts.timeoutMs;
  while (Date.now() < settleDeadline) {
    const current = page.url();
    if (current !== lastUrl) {
      lastUrl = current;
      stableSince = Date.now();
      const norm = normalizeForCycle(current);
      if (seen.has(norm)) {
        logger.debug({ current }, "redirect cycle detected — stopping");
        break;
      }
      seen.add(norm);
      if (seen.size > opts.hopCap) {
        logger.debug({ hops: seen.size }, "hop cap reached — stopping");
        break;
      }
    } else if (Date.now() - stableSince >= settleMs) {
      break;
    }
    await sleep(400);
  }

  // Probe the final page. `bettingSignal` (betting vocabulary) is stronger than
  // `reachedRealSite` (which also counts a generic login/register UI).
  let reachedRealSite = false;
  let bettingSignal = false;
  let finalTitle = "";
  try {
    const info = await page.evaluate(() => {
      const text = (document.body?.innerText ?? "").slice(0, 6000);
      const hasPassword = !!document.querySelector('input[type="password"]');
      return { title: document.title ?? "", text, hasPassword };
    });
    finalTitle = info.title;
    const hay = `${info.title}\n${info.text}`.toLocaleLowerCase("tr");
    const kwHit = opts.bettingKeywords.some((k) => hay.includes(k.toLocaleLowerCase("tr")));
    const uiHit = info.hasPassword || /(giriş yap|kayıt ol|üye ol|giris yap|kayit ol|uye ol|para yatır|canlı bahis|spor bahisleri)/i.test(info.text);
    bettingSignal = kwHit || /(canlı bahis|spor bahisleri|para yatır)/i.test(info.text);
    reachedRealSite = kwHit || uiHit;
  } catch (err) {
    logger.debug({ err: String(err) }, "final page probe failed");
  }

  const finalUrl = page.url();
  const finalDomain = hostnameOf(finalUrl);

  // A stopped chain with no betting/operator signal and a tiny throwaway page = decoy/dead-end.
  if (!reachedRealSite && (finalTitle.trim() === "" || /redirect|bekleyin|loading|please wait/i.test(finalTitle))) {
    deadEnd = true;
  }

  await page.close().catch(() => {});

  const hops = buildHops(startUrl, docHops, jsTargets, finalUrl);
  return { finalUrl, finalDomain, hops, reachedRealSite, bettingSignal, deadEnd };
}

function classify(status: number, isLast: boolean, url: string, finalUrl: string, jsTargets: Set<string>): HopType {
  if (url === finalUrl) return "final";
  if (status >= 300 && status < 400) return "http";
  if (isLast) return "final";
  if (jsTargets.has(url)) return "js";
  return "meta";
}

function buildHops(
  startUrl: string,
  docHops: Array<{ url: string; status: number; atMs: number }>,
  jsTargets: Set<string>,
  finalUrl: string
): RedirectHop[] {
  const hops: RedirectHop[] = [{ seq: 0, url: startUrl, type: "initial", atMs: 0 }];
  docHops.forEach((h, i) => {
    const isLast = i === docHops.length - 1;
    // Skip a duplicate leading entry that just repeats the start URL with 2xx.
    if (i === 0 && h.url === startUrl && h.status < 300) {
      hops[0] = { seq: 0, url: startUrl, type: isLast ? "final" : "initial", status: h.status, atMs: h.atMs };
      return;
    }
    hops.push({
      seq: hops.length,
      url: h.url,
      type: classify(h.status, isLast, h.url, finalUrl, jsTargets),
      status: h.status,
      atMs: h.atMs,
    });
  });

  // Surface JS-intended targets that never produced a committed navigation (blocked /
  // gesture-gated / geo-decoyed). They are evidence of the intended destination.
  const visited = new Set(hops.map((h) => h.url));
  for (const target of jsTargets) {
    if (!visited.has(target)) {
      hops.push({ seq: hops.length, url: target, type: "js" });
      visited.add(target);
    }
  }
  return hops;
}
