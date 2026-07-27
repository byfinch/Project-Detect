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
import { appAdPackage, isAppInstallAd } from "../util/appAds.js";
import { watchAclkRequests, type AclkWatch } from "./aclkWatch.js";
import { restoreSerp } from "./serpRestore.js";

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
  // Play app cards all share play.google.com — for app ads match by title
  // only, and carry the card's Play href out for package-id extraction.
  const isApp = isAppInstallAd(ad.displayDomain, ad.adHref);
  const box = await page.evaluate(
    ({ target, titleHint, isApp }) => {
      const norm = (s: string) => s.toLowerCase().replace(/^(www\.|m\.)/, "").trim();
      const cards = Array.from(
        document.querySelectorAll("[data-text-ad], #tads [data-hveid], #tadsb [data-hveid], #tvcap [data-hveid], [data-pcu]")
      );
      for (const c of cards) {
        const heading = c.querySelector('[role="heading"], h3');
        const title = (heading?.textContent || "").trim();
        const cardText = (c.textContent || "").toLowerCase();
        const isTarget = isApp
          ? !!(titleHint && title.toLowerCase().includes(titleHint.toLowerCase()))
          : ((titleHint && title.toLowerCase().includes(titleHint.toLowerCase())) ||
             cardText.includes(target));
        if (!isTarget) continue;
        const headingLink = heading?.closest("a") as HTMLAnchorElement | null;
        const link = (headingLink || c.querySelector("a[href]")) as HTMLAnchorElement | null;
        if (!link) return null;
        const playLink = c.querySelector('a[href*="play.google.com"], a[href^="intent://"]') as HTMLAnchorElement | null;
        const playHref = playLink?.href ?? null;
        link.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
        const r = link.getBoundingClientRect();
        if (r.width === 0) return null;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, playHref };
      }
      return null;
    },
    {
      target: (ad.finalDomain || ad.displayDomain || "").toLowerCase().replace(/^(www\.|m\.)/, ""),
      titleHint: (ad.title || "").slice(0, isApp ? 25 : 60),
      isApp,
    }
  ).catch(() => null);
  if (box) {
    return {
      playHref: box.playHref,
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

    // App ads only: an observed aclk request proves the click reached
    // Google even when the intent:// chain never leaves the SERP (the old
    // "no navigation" false-fails). Attached LAZILY at the click points —
    // the pre-click resolve also navigates the aclk URL in this context and
    // must NOT trip the watcher. Detached in the finally below.
    // (Holder object: a plain `let` mutated via closure gets dead-narrowed by TS.)
    const aclkWatchRef: { w: AclkWatch | null } = { w: null };
    const ensureAclkWatch = (): AclkWatch | null => {
      if (!aclkWatchRef.w && isAppInstallAd(ad.displayDomain, ad.adHref)) {
        aclkWatchRef.w = watchAclkRequests(page);
      }
      return aclkWatchRef.w;
    };

    try {
      // Ensure we're back on SERP (previous landing may have navigated main
      // page). goBack first: bfcache restores the same impression, a fresh
      // goto re-runs the auction and rotates the cards.
      if (!page.url().includes("google.") || page.url().includes("/sorry")) {
        await restoreSerp(page, serpUrl);
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
        // Renderer died BEFORE anything for this ad — no report, no click.
        // Record honestly (earlier ads in this loop already wrote their own rows).
        status = "skipped";
        error = "renderer frozen before report/click (intent redirect?) — nothing attempted for this ad";
        skipped++;
        logger.warn({ domain, profileId }, "inline: renderer dead before report/click — bailing profile early");
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
            message: `inline tık ${status} (renderer ölü) · rapor ${reportResult.status} · ${domain} · ${profileKey}`,
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
        const aclkWatch = ensureAclkWatch();
        await page.goto(ad.adHref, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
        evidence.landingUrl = page.url();
        const stuckOnSerp = page.url() === serpUrl || /\/search[?#]/.test(page.url());
        // App ads: the intent:// chain cannot navigate a desktop browser, but
        // an observed aclk request means Google DID register the click.
        const aclkSeen = aclkWatch?.sawAclk() ?? false;
        // Honest outcome: aclk goto that never leaves the SERP and never
        // fired an aclk request is NOT a click.
        if (stuckOnSerp && !aclkSeen) {
          status = "failed";
          error = "direct aclk goto did not navigate (anchor gone)";
          failed++;
        } else {
          status = "success";
          completed++;
          if (stuckOnSerp) {
            // aclk seen but page on SERP — take the HTTPS Play page for evidence.
            const pkg = appAdPackage(ad.adHref) ?? (aclkWatch?.packageId() ?? null);
            if (pkg) {
              const playUrl = `https://play.google.com/store/apps/details?id=${pkg}&hl=tr&gl=tr`;
              await page.goto(playUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
              evidence.landingUrl = page.url();
            }
          }
          try {
            evidence.finalUrl = evidence.finalUrl || page.url();
            evidence.finalDomain = evidence.finalDomain || new URL(page.url()).hostname.replace(/^www\./, "");
          } catch {
            /* keep pre-resolve evidence */
          }
        }
      } else {
        // 1) Evidence-first: resolve the aclk WITHOUT clicking, then report on
        //    THIS impression (impressions rotate — report-first wins).
        if (withReport && config.report.autoSerpSubmit && ad.adHref) {
          let preFinalUrl: string | null = null;
          let preFinalDomain: string | null = null;
          try {
            const { resolveLanding } = await import("../resolve/redirectResolver.js");
            // intent:// hrefs can't be resolved — use the HTTPS Play page.
            let resolveHref = ad.adHref!;
            if (resolveHref.startsWith("intent://")) {
              const { appAdPackage } = await import("../util/appAds.js");
              const pkg = appAdPackage(resolveHref);
              if (pkg) resolveHref = `https://play.google.com/store/apps/details?id=${pkg}&hl=tr&gl=tr`;
            }
            const outcome = await resolveLanding(session, resolveHref, {
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
              refillPerHour: config.report.emailPool.refillPerHour,
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
            // Write-through: inline flows die post-report too (8m cap, freeze).
            store.upsertReportOutcome(runId, job, reportResult);
          } else {
            reportResult = { status: "no-form", message: "report UI not opened" };
            store.upsertReportOutcome(runId, job, reportResult);
          }
          // Renderer probe BEFORE touching the page again — the report flow
          // (or an intent redirect) can freeze the renderer, and even the
          // Escape/dismiss below would then hang until the hard cap. Report is
          // already persisted (write-through); bail the profile honestly.
          const aliveAfterReport = await Promise.race([
            page.evaluate(() => 1).then(() => true, () => false),
            sleep(5_000).then(() => false),
          ]);
          if (!aliveAfterReport) {
            status = "skipped";
            error = "renderer frozen after report — click skipped (report already out)";
            skipped++;
            logger.warn({ domain, profileId }, "inline: renderer dead after report — bailing profile early");
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
                message: `inline tık ${status} (renderer ölü) · rapor ${reportResult.status} · ${domain} · ${profileKey}`,
              });
            }
            break;
          }
          // The report flow leaves Google's "Reklam Merkezim" overlay OPEN when
          // the URL never left google.* (seen live: popup covering the SERP, the
          // click phase then crawls on a dirty DOM). Dismiss it — ESC first,
          // then any dialog close buttons; NO reload (a reload re-runs the
          // auction and can cost us the exact impression we just reported).
          // Bounded: keyboard/evaluate hang on a slow renderer.
          await Promise.race([
            (async () => {
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
            })(),
            sleep(6_000),
          ]);
          // The report flow may have navigated — restore SERP before clicking
          // (goBack first: same impression from bfcache, no auction re-run).
          if (!page.url().includes("google.") || page.url().includes("/sorry")) {
            await restoreSerp(page, serpUrl);
            await sleep(800);
          }
        }

        // 2) The click itself (report is already out).
        const aclkWatch = ensureAclkWatch();
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

        // Did the click actually navigate? A blocked navigation (JS card,
        // intent://) leaves the page on the SERP — counting that as success
        // produced fake clicks with landing=SERP (seen on app:meritking).
        const onSerp = (u: string) =>
          u === serpUrl || /\/search[?#]/.test(u) || u.startsWith("intent:");
        let landed = !onSerp(evidence.landingUrl);

        // Play app ads: the aclk chain ends at intent://play.google.com — a
        // browser cannot open it, so the page usually stays on the SERP even
        // though Google DID register the click. The request listener is the
        // source of truth: an observed aclk request = click registered.
        const isAppAd = isAppInstallAd(ad.displayDomain, ad.adHref);
        if (isAppAd && !landed && !aclkWatch?.sawAclk() && ad.adHref && landing === page) {
          // No aclk observed from the click — fire the parsed aclk directly
          // (that request IS the click); the listener catches it now.
          logger.warn({ domain, profileId }, "inline app ad: no aclk observed — direct aclk goto fallback");
          await page.goto(ad.adHref, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
          evidence.landingUrl = page.url();
          landed = !onSerp(evidence.landingUrl);
        }
        const aclkSeen = aclkWatch?.sawAclk() ?? false;
        // pkg from ad href, the card DOM, the landing URL, or the observed
        // intent://play.google.com redirect.
        let pkg: string | null = null;
        if (isAppAd) {
          let cardPlayHref: string | null = null;
          if (anchor && "playHref" in anchor) {
            cardPlayHref = anchor.playHref ?? null;
          } else if (anchor && "evaluate" in anchor) {
            cardPlayHref = await anchor.evaluate((el: Element) => {
              const card = el.closest("[data-text-ad], [data-hveid], [data-pcu]");
              const pl = card?.querySelector('a[href*="play.google.com"], a[href^="intent://"]');
              return (pl as HTMLAnchorElement | null)?.href ?? null;
            }).catch(() => null);
          }
          pkg = appAdPackage(ad.adHref) ?? appAdPackage(cardPlayHref) ?? appAdPackage(evidence.landingUrl) ?? (aclkWatch?.packageId() ?? null);
        }
        if (isAppAd && !landed && aclkSeen) {
          // aclk reached Google — count the click even though the intent
          // chain never left the SERP. HTTPS Play page for evidence/stay.
          landed = true;
          if (pkg) {
            const playUrl = `https://play.google.com/store/apps/details?id=${pkg}&hl=tr&gl=tr`;
            logger.info({ domain, pkg }, "inline app ad: aclk observed on SERP — HTTPS Play page for evidence");
            await landing.goto(playUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
            evidence.landingUrl = landing.url();
          }
        }
        if (!landed) {
          status = "failed";
          error = "click did not leave the SERP (no navigation)";
          failed++;
          logger.warn({ domain, profileId }, "inline: click never navigated — not counting as click");
        } else {

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
          // Never record the SERP itself as "final landing" — fake evidence.
          if (!onSerp(landing.url())) {
            evidence.finalUrl = landing.url();
            try {
              evidence.finalDomain = new URL(landing.url()).hostname.replace(/^www\./, "");
            } catch {
              evidence.finalDomain = domain;
            }
          }
        }

        // Close landing tab if separate; restore SERP on main page (goBack
        // first — bfcache keeps the same impression, goto re-runs the auction).
        if (landing !== page) {
          await landing.close().catch(() => {});
        } else {
          await restoreSerp(page, serpUrl);
          await sleep(600);
        }

        status = "success";
        completed++;
        }
      }
    } catch (err) {
      status = "failed";
      error = String(err);
      failed++;
      logger.warn({ domain, profileId, err: error }, "inline SERP click failed");
    } finally {
      aclkWatchRef.w?.detach();
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
      reportStatus: reportResult.status,
      stayMs: evidence.stayMs,
      completed,
      failed,
      skipped,
      total: targets.length,
      message: `inline tık ${status} · rapor ${reportResult.status} · ${domain} · ${profileKey} (${completed + failed + skipped}/${targets.length})`,
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
    reported,
    profileName: profileKey,
    message: `inline tık bitti · ${completed} ok · ${reported} rapor · ${targets.length} hedef · ${profileKey}`,
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
