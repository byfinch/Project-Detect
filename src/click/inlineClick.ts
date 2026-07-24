/**
 * Click ads while the SERP is still open (same AdsPower session as scan).
 * Closing + reopening often loses the ad impression — so we click in-place.
 */
import type { Page } from "playwright-core";
import type { BrowserSession } from "../browser/session.js";
import type { AppConfig } from "../config.js";
import type { Device } from "../types.js";
import { logger } from "../logger.js";
import { sleep } from "../util/time.js";
import { behaveOnLanding, naturalWait } from "./behavior.js";
import { behaviorForProfile, personaFor } from "../util/persona.js";
import { ClickStore } from "./store.js";
import type { ClickEvidence, ClickJob, ClickReportResult, ClickResult, ClickStatus } from "./types.js";
import { openReportUi, fillReportForm } from "../report/autoSerpReport.js";

export interface InlineAdTarget {
  title: string;
  description: string;
  displayDomain: string;
  displayUrl: string;
  adHref: string | null;
  finalDomain?: string | null;
}

export interface InlineClickOpts {
  config: AppConfig;
  session: BrowserSession;
  device: Device;
  profileId: string;
  profileName?: string;
  keyword: string;
  ads: InlineAdTarget[];
  outputDir: string;
  /** Max ads to click this SERP (unique domain). Default 3. */
  maxClicks?: number;
  /** Open and fill Google's "Report ad" form before each click. */
  withReport?: boolean;
  /** Groups this run under one operation row in the panel (e.g. scan-N). */
  operationId?: string;
  /** Profile proxy for CapSolver AntiCloudflare (needs the SAME exit IP). */
  captchaProxy?: { proxy: string; proxytype: "HTTP" | "HTTPS" | "SOCKS4" | "SOCKS5" };
  onProgress?: (event: Record<string, unknown>) => void;
  /**
   * Internal: set by the WithCap wrapper when the HARD timeout fires.
   * The loop stops at the next ad boundary and skips recording — a reaped run
   * must not write phantom success rows after the caller already moved on.
   */
  abortSignal?: { aborted: boolean };
}

export interface InlineClickSummary {
  runId: number;
  attempted: number;
  completed: number;
  failed: number;
  skipped: number;
  reported: number;
  domains: string[];
}

function norm(d: string): string {
  return d.toLowerCase().replace(/^www\./, "").replace(/^m\./, "").trim();
}

function uniqueByDomain(ads: InlineAdTarget[]): InlineAdTarget[] {
  const seen = new Set<string>();
  const out: InlineAdTarget[] = [];
  for (const a of ads) {
    const key = norm(a.finalDomain || a.displayDomain || "");
    if (!key || seen.has(key)) continue;
    // google.* is only allowed for Play Store app-install betting ads
    // ("Hemen yükle | X Bet") — a real policy violation AND a paid click.
    if (/(^|\.)google\.[a-z.]+$/.test(key) && !/yükle|indir|download/i.test(a.title || "")) continue;
    if (!a.adHref) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

async function findAnchor(page: Page, ad: InlineAdTarget) {
  // Card-scoped first: find THIS ad's card and click its primary link —
  // title/aclk heuristics miss desktop cards ("anchor not found").
  const box = await page.evaluate(
    ({ target, titleHint }) => {
      const norm = (s: string) => s.toLowerCase().replace(/^(www\.|m\.)/, "").trim();
      const cards = Array.from(
        document.querySelectorAll("[data-text-ad], #tads [data-hveid], #tadsb [data-hveid], #tvcap [data-hveid], [data-pcu]")
      );
      for (const c of cards) {
        const heading = c.querySelector('[role="heading"], h3');
        const title = (heading?.textContent || "").trim();
        const cardText = (c.textContent || "").toLowerCase();
        const isTarget =
          (titleHint && title.toLowerCase().includes(titleHint.toLowerCase())) ||
          cardText.includes(target);
        if (!isTarget) continue;
        const headingLink = heading?.closest("a") as HTMLAnchorElement | null;
        const link = (headingLink || c.querySelector("a[href]")) as HTMLAnchorElement | null;
        if (!link) return null;
        link.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
        const r = link.getBoundingClientRect();
        if (r.width === 0) return null;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      return null;
    },
    {
      target: (ad.finalDomain || ad.displayDomain || "").toLowerCase().replace(/^(www\.|m\.)/, ""),
      titleHint: (ad.title || "").slice(0, 60),
    }
  ).catch(() => null);
  if (box) {
    return {
      click: async () => {
        await page.mouse.move(box.x, box.y, { steps: 8 });
        await page.mouse.down();
        await new Promise((r) => setTimeout(r, 80));
        await page.mouse.up();
      },
    };
  }
  if (ad.title) {
    const safe = ad.title.replace(/"/g, '\\"').slice(0, 80);
    const byTitle = await page.$(`a:has-text("${safe}")`).catch(() => null);
    if (byTitle) return byTitle;
  }
  if (ad.adHref) {
    const byHref = await page.$(`a[href="${ad.adHref}"]`).catch(() => null);
    if (byHref) return byHref;
  }
  return page.$('a[href*="aclk"]').catch(() => null);
}

/**
 * Click visible ads on the current SERP page, then return to SERP (close landing tabs).
 */
export class InlineClickTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InlineClickTimeoutError";
  }
}

/**
 * Hard cap around clickAdsOnOpenSerp. A stalled renderer/CDP call (seen live:
 * autoReport probing on a wedged page) would otherwise freeze the whole scan
 * leg forever — puppeteer protocol calls have no default timeout. On expiry
 * the caller MUST close the profile browser: that rejects the hung CDP
 * promises and lets the background invocation die.
 *
 * Two-stage guard (lesson from 3 live false-positives): a slow-but-healthy
 * mobile flow (report + resolve + CF + behave) can legitimately pass 4m/ad.
 * First stage only warns and starts a grace window; the reap (and profile
 * kill) happens solely if the flow is STILL running after grace — that is the
 * true wedge. An aborted run stops recording via opts.abortSignal, so no
 * phantom "success" rows appear after the caller has moved on.
 */
export async function clickAdsOnOpenSerpWithCap(opts: InlineClickOpts): Promise<InlineClickSummary> {
  const adCount = Math.min(opts.maxClicks ?? 3, opts.ads.length);
  const capMs = adCount * 300_000 + 120_000;
  const GRACE_MS = 180_000;
  const abortSignal = { aborted: false };
  let capTimer: NodeJS.Timeout | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<InlineClickSummary>((resolve, reject) => {
      clickAdsOnOpenSerp({ ...opts, abortSignal }).then(resolve, reject);
      capTimer = setTimeout(() => {
        logger.warn({ adCount, capMs }, "inline click over budget — grace window before reap (not a wedge yet)");
        opts.onProgress?.({
          type: "scan-progress",
          phase: "inline-click-late",
          message: "Inline tık süre bütçesini aştı · 3 dk ek süre tanındı (kilitlenme değilse tamamlanacak)",
        });
        graceTimer = setTimeout(() => {
          abortSignal.aborted = true;
          reject(new InlineClickTimeoutError(`inline click hard timeout (${Math.round((capMs + GRACE_MS) / 60000)}m)`));
        }, GRACE_MS);
      }, capMs);
    });
  } finally {
    if (capTimer) clearTimeout(capTimer);
    if (graceTimer) clearTimeout(graceTimer);
  }
}

export async function clickAdsOnOpenSerp(opts: InlineClickOpts): Promise<InlineClickSummary> {
  const {
    config,
    session,
    device,
    profileId,
    profileName,
    keyword,
    ads,
    outputDir,
    maxClicks = 3,
    withReport = false,
    onProgress,
  } = opts;

  const targets = uniqueByDomain(ads).slice(0, Math.max(1, maxClicks));
  const empty: InlineClickSummary = {
    runId: 0,
    attempted: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    reported: 0,
    domains: [],
  };
  if (targets.length === 0) return empty;

  const store = new ClickStore(outputDir);
  const domains = targets.map((t) => norm(t.finalDomain || t.displayDomain));
  const runId = store.createRun({
    startedAt: new Date().toISOString(),
    targetDomain: domains.join(","),
    targetDevice: device,
    totalJobs: targets.length,
    notes: `inline-scan profile=${profileName || profileId} kw=${keyword}`,
    operationId: opts.operationId,
  });

  let completed = 0;
  let failed = 0;
  let skipped = 0;
  let reported = 0;
  const profileKey = profileName || profileId;
  const personaBehavior = behaviorForProfile(config.click.behavior, profileKey);

  onProgress?.({
    type: "click-started",
    inline: true,
    runId,
    profileId,
    profileName: profileKey,
    device,
    keyword,
    targetCount: targets.length,
    planTotal: targets.length,
    message: `Açık SERP üzerinden tık · ${profileKey} · ${targets.length} domain`,
  });

  const page = session.page;
  const serpUrl = page.url();

  for (let i = 0; i < targets.length; i++) {
    // Reaped by the WithCap hard timeout — stop at the boundary, record nothing.
    if (opts.abortSignal?.aborted) {
      logger.warn({ profileId, done: i, total: targets.length }, "inline click aborted by hard timeout — skipping remaining ads");
      break;
    }
    const ad = targets[i]!;
    const domain = norm(ad.finalDomain || ad.displayDomain);
    const job: ClickJob = {
      id: `inline-${profileId.slice(-6)}-${i}-${Date.now().toString(36)}`,
      profileId,
      device,
      keyword,
      targetDomain: domain,
      targetTitle: ad.title,
      fallbackFirstAd: false,
      clickFirstResult: false,
      scheduledAt: Date.now(),
      attempt: 0,
      maxAttempts: 1,
    };

    const evidence: ClickEvidence = {
      serpUrl,
      adTitle: ad.title,
      adDescription: ad.description,
      displayUrl: ad.displayUrl,
      clickUrl: ad.adHref,
      landingUrl: null,
      finalUrl: null,
      finalDomain: ad.finalDomain ?? domain,
      redirectHops: [],
      screenshotSerp: null,
      screenshotLanding: null,
      screenshotFinal: null,
      preClickMs: 0,
      stayMs: 0,
      internalClicks: 0,
    };

    let status: ClickStatus = "running";
    let error: string | null = null;
    const capturedAt = new Date().toISOString();
    let reportResult: ClickReportResult = { status: "skipped", message: "report disabled for inline click" };

    try {
      // Ensure we're back on SERP (previous landing may have navigated main page)
      if (!page.url().includes("google.") || page.url().includes("/sorry")) {
        await page.goto(serpUrl, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
        await sleep(800);
      }

      evidence.preClickMs = await naturalWait(
        Math.min(personaBehavior.minPreClickMs, 1200),
        Math.min(personaBehavior.maxPreClickMs, 2800)
      );

      // Renderer liveness probe (5s): a renderer frozen by an intent:// redirect
      // (Play app ads) makes every later call burn its own cap — wedges summed
      // to 10m on a dead profile (seen live, same profile twice). Probe first:
      // dead renderer → report (if any) is already out, skip the click and bail
      // the whole profile — later ads hit the same frozen renderer.
      const rendererAlive = await Promise.race([
        page.evaluate(() => 1).then(() => true, () => false),
        sleep(5_000).then(() => false),
      ]);
      if (!rendererAlive) {
        status = "skipped";
        error = "renderer frozen before click phase (intent redirect?) — profile bailed early";
        skipped++;
        if (reportResult.status === "submitted" || reportResult.status === "filled") reported++;
        logger.warn({ domain, profileId }, "inline: renderer dead before click — bailing profile early");
        if (!opts.abortSignal?.aborted) {
          store.insertClick(runId, { job, status, evidence, error, capturedAt, report: reportResult });
          onProgress?.({
            type: "click-done",
            inline: true,
            runId,
            jobId: job.id,
            domain,
            device,
            profileId,
            profileName: profileKey,
            status,
            stayMs: 0,
            completed,
            failed,
            skipped,
            total: targets.length,
            message: `inline tık ${status} (renderer ölü) · ${domain} · ${profileKey}`,
          });
        }
        break;
      }

      // findAnchor runs page.evaluate with NO protocol timeout — on a renderer
      // frozen by an intent:// redirect (Play app ads on mobile) it hangs
      // forever (seen live: 3 wedges). Cap it; null falls to the aclk fallback.
      const anchor = await Promise.race([
        findAnchor(page, ad),
        sleep(15_000).then(() => null),
      ]);
      if (!anchor && !ad.adHref) {
        status = "skipped";
        error = "anchor not found on open SERP";
        skipped++;
      } else if (!anchor && ad.adHref) {
        // Report is already out; anchor gone after the report flow (SERP rotated
        // or report navigated the page) — fire the parsed aclk directly.
        logger.warn({ domain, profileId }, "inline: anchor gone after report — direct aclk goto fallback");
        status = "success";
        completed++;
        await page.goto(ad.adHref, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
        evidence.landingUrl = page.url();
        try {
          evidence.finalUrl = evidence.finalUrl || page.url();
          evidence.finalDomain = evidence.finalDomain || new URL(page.url()).hostname.replace(/^www\./, "");
        } catch {
          /* keep pre-resolve evidence */
        }
      } else {
        // 1) Evidence-first: resolve the aclk WITHOUT clicking, then report on
        //    THIS impression (impressions rotate — report-first wins).
        if (withReport && config.report.autoSerpSubmit && ad.adHref) {
          let preFinalUrl: string | null = null;
          let preFinalDomain: string | null = null;
          try {
            const { resolveLanding } = await import("../resolve/redirectResolver.js");
            const outcome = await resolveLanding(session, ad.adHref, {
              hopCap: config.scan.hopCap,
              timeoutMs: Math.min(20_000, config.scan.resolveTimeoutMs),
              referer: `https://${config.google.domain}/`,
              bettingKeywords: config.bettingKeywords,
            });
            preFinalUrl = outcome.finalUrl;
            preFinalDomain = outcome.finalDomain;
            evidence.finalUrl = outcome.finalUrl;
            evidence.finalDomain = outcome.finalDomain;
          } catch {
            /* report continues without resolve */
          }
          const opened = await openReportUi(page, ad.displayDomain, ad.title, device);
          if (opened) {
            const { resolve: pathResolve } = await import("node:path");
            const evidenceDir = pathResolve(outputDir, "screenshots", "reports", `run-${runId}`, job.id);
            const { acquireReportEmail, markReportEmailUsed } = await import("../report/emailPool.js");
            const acc = acquireReportEmail(outputDir, {
              enabled: config.report.emailPool.enabled,
              minSize: config.report.emailPool.minSize,
              fallback: config.report.reportEmail,
            });
            const res = await fillReportForm(page, {
              keyword,
              device,
              displayDomain: ad.displayDomain,
              title: ad.title,
              description: ad.description,
              finalUrl: preFinalUrl ?? undefined,
              finalDomain: preFinalDomain ?? ad.finalDomain ?? undefined,
              adHref: ad.adHref,
              displayUrl: ad.displayUrl,
              seed: profileKey,
            }, true, evidenceDir, acc.email || undefined);
            if (res.status === "submitted" || res.status === "filled" || res.status === "submit-failed") {
              markReportEmailUsed(outputDir, acc.email, acc.fromPool);
            }
            reportResult = {
              status: res.status,
              message: `inline report · ${domain} · ${res.status} · mail ${acc.fromPool ? "pool" : "static"}:${acc.email}`,
            };
          } else {
            reportResult = { status: "no-form", message: "report UI not opened" };
          }
          // The report flow leaves Google's "Reklam Merkezim" overlay OPEN when
          // the URL never left google.* (seen live: popup covering the SERP, the
          // click phase then crawls on a dirty DOM). Dismiss it — ESC first,
          // then any dialog close buttons; NO reload (a reload re-runs the
          // auction and can cost us the exact impression we just reported).
          await page.keyboard.press("Escape").catch(() => {});
          await sleep(400);
          await page.evaluate(() => {
            const btns = Array.from(
              document.querySelectorAll('[role="dialog"] [aria-label*="kapat" i], [role="dialog"] [aria-label*="close" i]')
            ) as HTMLElement[];
            for (const b of btns) {
              if (b.getBoundingClientRect().width > 0) b.click();
            }
          }).catch(() => {});
          // The report flow may have navigated — restore SERP before clicking.
          if (!page.url().includes("google.") || page.url().includes("/sorry")) {
            await page.goto(serpUrl, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
            await sleep(800);
          }
        }

        // 2) The click itself (report is already out).
        const pagesBefore = page.context().pages().length;
        const [newPage] = await Promise.all([
          page.context().waitForEvent("page", { timeout: 18000 }).catch(() => null),
          anchor!.click().catch(async () => {
            if (ad.adHref) {
              await page.goto(ad.adHref, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
            }
          }),
        ]);

        let landing: Page = newPage ?? page;
        // Prefer newest page if click opened a tab without waitForEvent catching it
        if (!newPage) {
          const pages = page.context().pages();
          if (pages.length > pagesBefore) {
            landing = pages[pages.length - 1]!;
          }
        }

        await landing.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
        evidence.landingUrl = landing.url();

        let cfPassed = true;
        try {
          const { passCloudflareIfPresent } = await import("../captcha/cloudflare.js");
          const cf = await passCloudflareIfPresent(landing, config, {
            timeoutMs: 60_000,
            proxy: opts.captchaProxy?.proxy,
            proxytype: opts.captchaProxy?.proxytype,
            outputDir: config.output.dir,
          });
          cfPassed = cf.passed;
          evidence.landingUrl = landing.url();
        } catch {
          cfPassed = false;
        }

        if (!cfPassed) {
          // Challenge wall still up — do NOT behave/click around here
          // (wanders to cloudflare.com, seen live).
          evidence.finalUrl = null;
          evidence.finalDomain = null;
        } else {
          // behaveOnLanding evaluates can hang on a frozen renderer (intent://
          // redirect) — bound the whole behaviour block, evidence stays partial.
          const behaviour = await Promise.race([
            behaveOnLanding(landing, device, personaBehavior, profileKey),
            sleep(90_000).then(() => null),
          ]);
          evidence.stayMs = behaviour?.stayMs ?? 0;
          evidence.internalClicks = behaviour?.internalClicks ?? 0;
          evidence.finalUrl = landing.url();
          try {
            evidence.finalDomain = new URL(landing.url()).hostname.replace(/^www\./, "");
          } catch {
            evidence.finalDomain = domain;
          }
        }

        // Close landing tab if separate; restore SERP on main page
        if (landing !== page) {
          await landing.close().catch(() => {});
        } else {
          await page.goto(serpUrl, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
          await sleep(600);
        }

        status = "success";
        completed++;
      }
    } catch (err) {
      status = "failed";
      error = String(err);
      failed++;
      logger.warn({ domain, profileId, err: error }, "inline SERP click failed");
    }

    if (reportResult.status === "submitted" || reportResult.status === "filled") {
      reported++;
    }
    // A reaped run (hard timeout) must not write phantom rows/events — the
    // caller already logged the wedge and moved on.
    if (opts.abortSignal?.aborted) break;
    const result: ClickResult = { job, status, evidence, error, capturedAt, report: reportResult };
    store.insertClick(runId, result);

    onProgress?.({
      type: "click-done",
      inline: true,
      runId,
      jobId: job.id,
      domain,
      device,
      profileId,
      profileName: profileKey,
      status,
      stayMs: evidence.stayMs,
      completed,
      failed,
      skipped,
      total: targets.length,
      message: `inline tık ${status} · ${domain} · ${profileKey} (${completed + failed + skipped}/${targets.length})`,
    });

    logger.info(
      {
        domain,
        status,
        profile: profileKey,
        device,
        stayMs: evidence.stayMs,
        runId,
      },
      "inline SERP click finished"
    );

    // Small gap between multi-ads on same SERP
    if (i < targets.length - 1) await sleep(800 + Math.floor(Math.random() * 1200));
  }

  store.finishRun(runId, new Date().toISOString(), completed, failed, 0, skipped);
  store.close();

  onProgress?.({
    type: "click-completed",
    inline: true,
    runId,
    completed,
    failed,
    skipped,
    profileName: profileKey,
    message: `inline tık bitti · ${completed} ok / ${targets.length} · ${profileKey}`,
  });

  return {
    runId,
    attempted: targets.length,
    completed,
    failed,
    skipped,
    reported,
    domains,
  };
}
