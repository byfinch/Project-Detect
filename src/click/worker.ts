import type { Page } from "playwright-core";
import type { AppConfig } from "../config.js";
import { BrowserSession } from "../browser/session.js";
import { markProfileInUse, releaseProfile } from "../browser/profileRegistry.js";
import { AdsPowerClient, captchaProxyFromProfile, type ProfileSummary } from "../adspower/client.js";
import { buildSerpUrl, gotoSerp, prepareGoogleConsent, warmUp } from "../google/serp.js";
import { parseAds } from "../google/adParser.js";
import { resolveLanding } from "../resolve/redirectResolver.js";
import { logger } from "../logger.js";
import { sleep } from "../util/time.js";
import type { Device } from "../types.js";
import type { ClickBehaviorConfig, ClickEvidence, ClickJob, ClickReportResult, ClickResult, ClickStatus } from "./types.js";
import { behaveOnLanding, naturalWait } from "./behavior.js";
import { behaviorForProfile, personaFor } from "../util/persona.js";
import { appAdKey, appAdPackage, isAppInstallAd } from "../util/appAds.js";
import { openReportUi, fillReportForm, type ReportTask } from "../report/autoSerpReport.js";
import { buildEvidencePaths, ensureEvidenceDir, screenshotPage } from "./evidence.js";
import { watchAclkRequests } from "./aclkWatch.js";
import { restoreSerp } from "./serpRestore.js";
import type { ClickStore } from "./store.js";

export interface WorkerContext {
  runId: number;
  config: AppConfig;
  adsClient: AdsPowerClient;
  behavior: ClickBehaviorConfig;
  outputDir: string;
  profileMeta: Map<string, ProfileSummary>;
  store: ClickStore;
  /** Optional panel event sink — harvest clicks use it (they bypass executeJob). */
  onProgress?: (event: Record<string, unknown>) => void;
  /**
   * Locked at run start (plan size). Never changes when retries requeue —
   * panel total must stay stable.
   */
  fixedTotalJobs?: number;
  /** Shared across device engines for honest global counters. */
  sharedStats?: {
    completed: number;
    failed: number;
    captcha: number;
    skipped: number;
    /** Live jobs across BOTH legs — the governor's global ceiling needs it. */
    running: number;
  };
}

export function normalizeDomain(s: string): string {
  return s.toLowerCase().replace(/^(www\.|m\.)/, "").trim();
}

export interface ClickableTarget {
  title: string;
  adHref: string | null;
  displayUrl: string;
  displayDomain: string;
  description: string;
  block: "top" | "bottom" | "unknown";
  isOrganic: boolean;
}

export function matchAd(
  ads: Awaited<ReturnType<typeof parseAds>>,
  targetDomain: string,
  titleHint?: string,
  fallbackFirstAd = false
): ClickableTarget | null {
  const target = normalizeDomain(targetDomain);

  // App-install target (app:brand): match Play ads by synthetic app identity.
  if (target.startsWith("app:")) {
    for (const ad of ads) {
      if (isAppInstallAd(ad.displayDomain, ad.adHref) && appAdKey(ad.title, ad.adHref) === target) {
        return { ...ad, isOrganic: false };
      }
    }
    if (!fallbackFirstAd) return null;
  }

  // Exact display domain match.
  for (const ad of ads) {
    if (normalizeDomain(ad.displayDomain) === target) return { ...ad, isOrganic: false };
  }

  // adHref hostname match.
  for (const ad of ads) {
    if (ad.adHref) {
      try {
        const host = new URL(ad.adHref).hostname.toLowerCase().replace(/^(www\.|m\.)/, "");
        if (host === target) return { ...ad, isOrganic: false };
      } catch {
        /* ignore */
      }
    }
  }

  // Title hint match.
  if (titleHint) {
    const hint = titleHint.toLowerCase();
    for (const ad of ads) {
      if (ad.title.toLowerCase().includes(hint)) return { ...ad, isOrganic: false };
    }
  }

  // Fallback: first ad if allowed and nothing matches.
  if (fallbackFirstAd) {
    const first = ads[0];
    if (first) return { ...first, isOrganic: false };
  }
  return null;
}

async function firstOrganicResult(page: Page): Promise<ClickableTarget | null> {
  try {
    const candidates = await page.$$eval('#rso a[href^="http"]', (anchors: HTMLAnchorElement[]) => {
      return anchors
        .map((a) => {
          const href = a.href;
          if (!href || href.includes("google.com/search") || href.includes("/url?") || href.startsWith("https://www.google.com")) return null;
          // Skip if it looks like an ad label chip or navigation.
          const text = (a.textContent || "").trim();
          if (text.length < 3) return null;
          const titleEl = a.querySelector("h3, div[role='heading']") || a;
          const title = (titleEl.textContent || text).trim().slice(0, 120);
          const container = a.closest("div, li, [data-sokoban-feature]") as HTMLElement | null;
          const cite = container?.querySelector("cite");
          const displayUrl = (cite?.textContent || "").trim();
          const snippet = container?.querySelector('div[data-sncf], div[style*="-webkit-line-clamp"], .VwiC3b, .s3v94d');
          const description = (snippet?.textContent || "").trim().slice(0, 200);
          return { title, href, displayUrl, description };
        })
        .filter(Boolean);
    });

    const first = candidates[0];
    if (!first) return null;
    return {
      title: first.title,
      adHref: first.href,
      displayUrl: first.displayUrl || first.href,
      displayDomain: new URL(first.href).hostname.replace(/^www\./, ""),
      description: first.description,
      block: "unknown",
      isOrganic: true,
    };
  } catch (err) {
    logger.debug({ err: String(err) }, "firstOrganicResult failed");
    return null;
  }
}

/**
 * Process-wide browser-start gate. A wave start fires ~10 AdsPower open
 * requests at the same instant and the Local API buckles into transient
 * failures (46 profile_error in 775 live attempts — the same profiles open
 * fine manually). Max 2 concurrent starts + jitter between starts keeps the
 * API healthy.
 */
const OPEN_MAX_PARALLEL = 2;
let openInFlight = 0;
const openWaiters: Array<() => void> = [];

async function acquireOpenSlot(): Promise<void> {
  if (openInFlight < OPEN_MAX_PARALLEL) {
    openInFlight++;
    return;
  }
  await new Promise<void>((res) => openWaiters.push(res));
  openInFlight++;
}

function releaseOpenSlot(): void {
  openInFlight--;
  openWaiters.shift()?.();
}

/** ensureBrowser through the start gate: jitter + 3 attempts (3s / 8s backoff). */
async function openBrowserWithRetry(ctx: WorkerContext, profileId: string): Promise<string> {
  await acquireOpenSlot();
  try {
    // Stagger: even with a free slot, never fire two starts back-to-back.
    await sleep(1_500 + Math.random() * 1_500);
    let ws: string | null = null;
    for (let openAttempt = 1; openAttempt <= 3; openAttempt++) {
      try {
        ws = await ctx.adsClient.ensureBrowser(profileId);
        break;
      } catch (err) {
        if (openAttempt === 3) throw err;
        const backoffMs = openAttempt === 1 ? 3_000 : 8_000;
        logger.warn({ profileId, openAttempt, backoffMs, err: String(err) }, "click worker: profile open failed — stop + backoff retry");
        await ctx.adsClient.stopBrowser(profileId).catch(() => {});
        await sleep(backoffMs);
      }
    }
    if (!ws) throw new Error("ensureBrowser returned no ws endpoint");
    return ws;
  } finally {
    releaseOpenSlot();
  }
}

export async function openProfile(ctx: WorkerContext, profileId: string, device: Device): Promise<BrowserSession | null> {
  let session: BrowserSession | null = null;
  try {
    // AdsPower transient open failures (zombie browser, CDP refused, stale
    // lock, API herd crush) are common — gated starts + backoff retries
    // recover most of them instead of burning the job as profile_error.
    const ws = await openBrowserWithRetry(ctx, profileId);
    // Mark immediately after ensureBrowser, BEFORE the CDP attach — otherwise
    // the reaper can kill this browser in the window between the two calls.
    markProfileInUse(profileId);
    try {
      session = await BrowserSession.attach(ws);
    } catch (attachErr) {
      // CDP attach refused = zombie — kill and retry attach once on a fresh boot.
      logger.warn({ profileId, err: String(attachErr) }, "click worker: CDP attach failed — reboot browser + retry once");
      await ctx.adsClient.stopBrowser(profileId).catch(() => {});
      await sleep(2_000);
      const ws2 = await openBrowserWithRetry(ctx, profileId);
      session = await BrowserSession.attach(ws2);
    }
    await prepareGoogleConsent(session);
    if (device === "mobile") {
      const { applyMobileEmulation } = await import("../browser/mobileEmulation.js");
      await applyMobileEmulation(session.page);
    }
    // Trusted fast-path: vault says this profile was clean/solved <2h ago —
    // skip the ~25-30s trend warm-up and go straight to the SERP. A wall, if
    // one appears anyway, is handled by the normal captcha flow downstream.
    let trustedRecently = false;
    try {
      const { Store } = await import("../store/db.js");
      const vault = new Store(ctx.config.output.dir);
      try {
        const row = vault.ipTrust.get(profileId) as
          | { status?: string; lastCleanAt?: string | null; lastSolvedAt?: string | null }
          | undefined;
        const fresh = (iso?: string | null) => !!iso && Date.now() - new Date(iso).getTime() < 2 * 3_600_000;
        trustedRecently = row?.status === "usable" && (fresh(row?.lastCleanAt) || fresh(row?.lastSolvedAt));
      } finally {
        vault.close();
      }
    } catch {
      /* vault optional */
    }

    // Same rule as brand scan: trend (or solve) first — never cold brand SERP.
    const proxy = ctx.profileMeta.get(profileId);
    const captchaProxy = proxy ? captchaProxyFromProfile(proxy) : undefined;
    if (trustedRecently) {
      logger.info({ profileId }, "click worker: vault-trusted profile — trend warm-up skipped (fast path)");
      markProfileInUse(profileId);
      return session;
    }
    const warm = await warmUp(session, ctx.config, {
      captchaProxy: captchaProxy
        ? { proxy: captchaProxy.proxy, proxytype: captchaProxy.proxytype }
        : undefined,
      profileId,
      trendWarmup: true,
    });
    if (warm.captcha) {
      // Infrastructure errors (page crash, navigation/network timeout, CDP)
      // are NOT the profile's/IP's fault — no cooldown ladder for those.
      // Only a genuine solver defeat earns a cooldown.
      let cool: { cooldownMinutes: number; nextRetryAt: string } | null = null;
      if (!warm.infraError) {
        try {
          const { Store } = await import("../store/db.js");
          const vault = new Store(ctx.config.output.dir);
          // Solve-and-move-on: 3 chained solver fiascos earn a SHORT 10m break —
          // never a long park; the next clean check makes the profile usable.
          cool = vault.ipTrust.markSolverFailed(profileId, "click: trend warm-up solver failed", { maxCooldownMinutes: 10 });
          vault.close();
        } catch {
          /* vault optional */
        }
      }
      logger.warn(
        {
          profileId,
          trend: warm.trend,
          method: warm.method,
          infraError: warm.infraError ?? false,
          cooldownMinutes: cool?.cooldownMinutes,
          nextRetryAt: cool?.nextRetryAt,
        },
        warm.infraError
          ? "click worker: trend warm-up died on infra error — NO cooldown (try another profile)"
          : "click worker: trend warm-up solver failed — cooldown (try another profile)"
      );
      const { gracefulProfileShutdown } = await import("../browser/shutdown.js");
      await gracefulProfileShutdown(ctx.adsClient, session, profileId);
      releaseProfile(profileId);
      return null;
    }
    logger.info(
      { profileId, trend: warm.trend, method: warm.method, captchaSolved: warm.captchaSolved },
      "click worker session safe via trend"
    );
    markProfileInUse(profileId);
    return session;
  } catch (err) {
    logger.warn({ profileId, err: String(err) }, "click worker failed to open profile");
    // Never leave an orphaned AdsPower browser behind on open failure — and
    // kill the zombie NOW (CDP attach refused = crashed/zombie browser), don't
    // wait for the reaper's next tick.
    try {
      await ctx.adsClient.stopBrowser(profileId).catch(() => {});
      const { gracefulProfileShutdown } = await import("../browser/shutdown.js");
      await gracefulProfileShutdown(ctx.adsClient, session, profileId);
    } catch {
      /* best effort */
    }
    releaseProfile(profileId);
    return null;
  }
}

export async function closeProfile(ctx: WorkerContext, session: BrowserSession | null, profileId: string): Promise<void> {
  try {
    const { gracefulProfileShutdown } = await import("../browser/shutdown.js");
    await gracefulProfileShutdown(ctx.adsClient, session, profileId);
  } finally {
    releaseProfile(profileId);
  }
}

export async function maybeReportAdBeforeClick(
  ctx: WorkerContext,
  page: Page,
  job: ClickJob,
  target: ClickableTarget,
  landing?: { finalUrl?: string | null; finalDomain?: string | null }
): Promise<ClickReportResult> {
  if (!ctx.config.report.autoSerpSubmit) {
    return { status: "skipped", message: "autoSerpSubmit disabled" };
  }
  try {
    const opened = await openReportUi(page, target.displayDomain, target.title, job.device);
    if (!opened) {
      const msg = "report UI not opened";
      logger.debug({ jobId: job.id, domain: target.displayDomain }, msg);
      return { status: "no-form", message: msg };
    }
    const task: ReportTask = {
      keyword: job.keyword,
      device: job.device,
      displayDomain: target.displayDomain,
      title: target.title,
      description: target.description,
      adHref: target.adHref,
      displayUrl: target.displayUrl,
      finalUrl: landing?.finalUrl ?? undefined,
      finalDomain: landing?.finalDomain ?? undefined,
      seed: job.profileId,
    };
    const { resolve } = await import("node:path");
    const evidenceDir = resolve(ctx.outputDir, "screenshots", "reports", `run-${ctx.runId}`, job.id);
    const { acquireReportEmail, markReportEmailUsed } = await import("../report/emailPool.js");
    const acc = acquireReportEmail(ctx.outputDir, {
      enabled: ctx.config.report.emailPool.enabled,
      minSize: ctx.config.report.emailPool.minSize,
      refillPerHour: ctx.config.report.emailPool.refillPerHour,
      fallback: ctx.config.report.reportEmail,
    });
    const res = await fillReportForm(page, task, true, evidenceDir, acc.email || undefined);
    // submit-failed also counts: the email may have reached Google before the error.
    if (res.status === "submitted" || res.status === "filled" || res.status === "submit-failed") {
      markReportEmailUsed(ctx.outputDir, acc.email, acc.fromPool);
    }
    const shotsNote = res.shots?.length ? ` · kanıt ${res.shots.length} görsel` : "";
    const message = `${job.profileId} · ${job.keyword} · ${target.displayDomain} · mail ${acc.fromPool ? "pool" : "static"}:${acc.email}${shotsNote}`;
    logger.info({ jobId: job.id, profileId: job.profileId, keyword: job.keyword, domain: target.displayDomain, status: res.status, email: acc.email, fromPool: acc.fromPool, landing: landing?.finalDomain, shots: res.shots }, "ad reported after click (landing evidence attached)");
    return { status: res.status, message };
  } catch (err) {
    const msg = String(err);
    logger.warn({ jobId: job.id, err: msg }, "post-click report failed");
    return { status: "error", message: msg };
  }
}

async function preClickBrowse(page: Page, device: Device, behavior: ClickBehaviorConfig): Promise<number> {
  const preMs = await naturalWait(behavior.minPreClickMs, behavior.maxPreClickMs);
  if (Math.random() < behavior.scrollChance) {
    await page.evaluate(async () => {
      const step = 300;
      const total = Math.min(document.body.scrollHeight - window.innerHeight, 1200);
      for (let i = 0; i < total; i += step) {
        window.scrollBy(0, step);
        await new Promise((r) => setTimeout(r, 150));
      }
      window.scrollTo(0, 0);
    }).catch(() => {});
  }
  if (device === "desktop" && Math.random() < behavior.mouseMoveChance) {
    const viewport = page.viewportSize();
    if (viewport) {
      for (let i = 0; i < 3; i++) {
        const x = Math.floor(Math.random() * viewport.width);
        const y = Math.floor(Math.random() * viewport.height);
        await page.mouse.move(x, y).catch(() => {});
        await sleep(150);
      }
    }
  }
  return preMs;
}

type ParsedAd = Awaited<ReturnType<typeof parseAds>>[number];

/** Convert a parsed SERP ad into the clickable target shape. */
export function toClickableAd(a: ParsedAd): ClickableTarget {
  return {
    title: a.title,
    adHref: a.adHref,
    displayUrl: a.displayUrl,
    displayDomain: a.displayDomain,
    description: a.description,
    block: (a as { block?: "top" | "bottom" | "unknown" }).block ?? "unknown",
    isOrganic: false,
  };
}

/**
 * Shared per-SERP session state that clickAndReportAd operates on. runClickJob
 * builds one per job; storm mode builds one per impression (same session reused).
 */
export interface AdFlowContext {
  ctx: WorkerContext;
  session: BrowserSession;
  page: Page;
  /** Canonical SERP URL — goBack restore target / fresh-impression reload source. */
  serpUrl: string;
  /** finalUrl after SERP navigation (evidence.serpUrl of the enclosing job). */
  serpFinalUrl: string | null;
  screenshotSerp: string | null;
  preClickMs: number;
  evidenceDir: string;
  device: Device;
  keyword: string;
  personaBehavior: ClickBehaviorConfig;
  profileKey: string;
  /**
   * true → pre-click resolve + report on every click with the absolute 1:1
   * gate (engine behaviour). false → skip the report phase entirely (storm
   * rate-limited clicks); the 1:1 gate and post-click salvage do not apply.
   */
  reportEnabled: boolean;
}

/**
 * 1:1 salvage: the report failed on this impression (no-form /
 * submit-failed / wedged opener). Up to TWO bounded retries on FRESH
 * impressions: re-search the keyword, re-locate the ad, report only.
 * Google rotates cards, so a fresh card usually has the menu again.
 * Naturalness preserved: same profile, new SERP per attempt.
 * NOTE: the fresh-impression reload is intentional here (new auction) —
 * do NOT route this through restoreSerp/goBack.
 */
async function retryReportOnFreshImpressions(
  flow: AdFlowContext,
  currentAd: ClickableTarget,
  jobForRecord: ClickJob,
  rep: ClickReportResult,
  ev: ClickEvidence
): Promise<ClickReportResult> {
  const { ctx, page, serpUrl } = flow;
  for (
    let retryNo = 1;
    retryNo <= 2 &&
    ctx.config.report.autoSerpSubmit &&
    (rep.status === "no-form" || rep.status === "submit-failed" || rep.status === "error" || rep.status === "skipped");
    retryNo++
  ) {
    try {
      logger.info({ jobId: jobForRecord.id, domain: currentAd.displayDomain, prev: rep.status, retryNo }, "report retry on fresh impression");
      await page.goto(serpUrl, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
      await sleep(1200);
      const retryAds = await Promise.race([
        parseAds(page),
        sleep(15_000).then(() => [] as Awaited<ReturnType<typeof parseAds>>),
      ]);
      // App ads share play.google.com — match the fresh SERP by app identity.
      const retryKey =
        appAdKey(currentAd.title, currentAd.adHref) ?? currentAd.displayDomain;
      const retryAd = matchAd(retryAds, retryKey, currentAd.title, false);
      if (retryAd?.adHref) {
        const retryTarget = toClickableAd(retryAd);
        const retryRep = await maybeReportAdBeforeClick(ctx, page, jobForRecord, retryTarget, {
          finalUrl: ev.finalUrl,
          finalDomain: ev.finalDomain,
        });
        if (retryRep.status === "submitted" || retryRep.status === "filled") {
          rep = retryRep;
          ctx.store.upsertReportOutcome(ctx.runId, jobForRecord, rep);
        } else if (retryNo === 2) {
          // Second form also failed — record honestly why the pair broke.
          rep = { status: retryRep.status, message: `2 retry da başarısız: ${retryRep.message ?? retryRep.status}` };
          ctx.store.upsertReportOutcome(ctx.runId, jobForRecord, rep);
        }
      } else {
        logger.info({ jobId: jobForRecord.id, domain: currentAd.displayDomain }, "report retry: ad not on fresh SERP (rotated)");
      }
    } catch (retryErr) {
      logger.warn({ jobId: jobForRecord.id, err: String(retryErr) }, "report retry failed (keeping original result)");
    }
  }
  return rep;
}

/**
 * Click + CF + landing behaviour + resolve + report for ONE ad on the
 * current SERP. Used by runClickJob for the main target AND the harvest
 * pass, and by storm mode for repeated clicks on a persistent session.
 */
export async function clickAndReportAd(
  flow: AdFlowContext,
  currentAd: ClickableTarget,
  jobForRecord: ClickJob
): Promise<{ status: ClickStatus; error: string | null; evidence: ClickEvidence; reportResult: ClickReportResult }> {
  const { ctx, page, session: sess, serpUrl, evidenceDir, device, keyword, personaBehavior, profileKey } = flow;
  const ev: ClickEvidence = {
    serpUrl: flow.serpFinalUrl,
    adTitle: currentAd.title,
    adDescription: currentAd.description,
    displayUrl: currentAd.displayUrl,
    clickUrl: currentAd.adHref,
    landingUrl: null,
    finalUrl: null,
    finalDomain: null,
    redirectHops: [],
    screenshotSerp: flow.screenshotSerp,
    screenshotLanding: null,
    screenshotFinal: null,
    preClickMs: flow.preClickMs,
    stayMs: 0,
    internalClicks: 0,
  };
  let st: ClickStatus = "running";
  let err: string | null = null;
  let rep: ClickReportResult = { status: "skipped", message: "not attempted" };
  const evPaths = buildEvidencePaths(evidenceDir, jobForRecord.id, device, keyword);

  if (!currentAd.adHref) {
    return { status: "skipped", error: "ad has no href", evidence: ev, reportResult: rep };
  }

  const isAppAdTarget = isAppInstallAd(currentAd.displayDomain, currentAd.adHref);
  // Click-first experiment (app targets only, config.click.appClickFirst):
  // live storm data shows the report-first order sabotages app-ad clicks —
  // Google marks the card "Bu reklam bildirildi" and kills its aclk chain on
  // that impression. So app ads click FIRST (proof + Play evidence), restore
  // the SERP, then report. Web targets keep the proven report-first order;
  // the 1:1 gate only applies there (click-first failures are recorded
  // honestly as "after click-first" — the single allowed exception).
  const clickFirst = flow.reportEnabled && isAppAdTarget && !currentAd.isOrganic && !!ctx.config.click.appClickFirst;
  const preEvidence: { finalUrl?: string | null; finalDomain?: string | null } = {};

  if (flow.reportEnabled) {
    // 1) Evidence-first resolve (NO ad click): the report carries the
    //    resolved betting/Play domain as evidence either way.
    try {
      // intent:// hrefs can't be resolved/navigated — resolve the HTTPS Play
      // page instead so the report carries real landing evidence.
      let resolveHref = currentAd.adHref;
      if (resolveHref.startsWith("intent://")) {
        const pkg = appAdPackage(resolveHref);
        if (pkg) resolveHref = `https://play.google.com/store/apps/details?id=${pkg}&hl=tr&gl=tr`;
      }
      const outcome = await resolveLanding(sess, resolveHref, {
        hopCap: ctx.config.scan.hopCap,
        timeoutMs: Math.min(20_000, ctx.config.scan.resolveTimeoutMs),
        referer: `https://${ctx.config.google.domain}/`,
        bettingKeywords: ctx.config.bettingKeywords,
      });
      preEvidence.finalUrl = outcome.finalUrl;
      preEvidence.finalDomain = outcome.finalDomain;
      ev.finalUrl = outcome.finalUrl;
      ev.finalDomain = outcome.finalDomain;
      ev.redirectHops = outcome.hops;
    } catch (resolveErr) {
      logger.debug({ jobId: jobForRecord.id, err: String(resolveErr) }, "pre-click resolve failed (report continues without it)");
    }
  }

  if (flow.reportEnabled && !clickFirst) {
    // 2) Report on the SAME fresh impression — with the resolved evidence.
    rep = await maybeReportAdBeforeClick(ctx, page, jobForRecord, currentAd, preEvidence);
    // Write-through: persist the report outcome NOW — a later job death
    // (timeout/freeze) must not rewrite this as "error".
    ctx.store.upsertReportOutcome(ctx.runId, jobForRecord, rep);

    // 1:1 rule (absolute): never click an ad we could not report —
    // "raporlayamıyorsak tıklamayız". The report goes out BEFORE the click;
    // if the form was unavailable, retry on fresh impressions — still
    // failing → skip the click entirely (a click without a report breaks
    // the pair; live: 10 clicks / 0 reports on app:pinco). Organic results
    // are not reportable — exempt.
    if (
      !currentAd.isOrganic &&
      ctx.config.report.autoSerpSubmit &&
      rep.status !== "submitted" &&
      rep.status !== "filled"
    ) {
      rep = await retryReportOnFreshImpressions(flow, currentAd, jobForRecord, rep, ev);
      if (rep.status !== "submitted" && rep.status !== "filled") {
        logger.warn(
          { jobId: jobForRecord.id, domain: currentAd.displayDomain, reportStatus: rep.status },
          "report unavailable after retries — click skipped (1:1 rule)"
        );
        return { status: "skipped", error: "report unavailable — click skipped (1:1 rule)", evidence: ev, reportResult: rep };
      }
    }
  }

  // Renderer liveness probe (5s) BEFORE any other page call: the report
  // flow (or an intent:// redirect) can leave the renderer frozen — even
  // the Escape/dismiss below would then hang the slot until the 8m reaper
  // (11 jobs died exactly like this in one app-ad campaign). The report is
  // already persisted; skip the click cheaply instead of wedging.
  const rendererAlive = await Promise.race([
    page.evaluate(() => 1).then(() => true, () => false),
    sleep(5_000).then(() => false),
  ]);
  if (!rendererAlive) {
    logger.warn({ jobId: jobForRecord.id, domain: currentAd.displayDomain }, "click worker: renderer frozen before click phase — skipping click (report already out)");
    return { status: "skipped", error: "renderer frozen before click (intent redirect?)", evidence: ev, reportResult: rep };
  }

  // Dismiss the "Reklam Merkezim" overlay the report flow leaves open —
  // the click phase needs a clean SERP DOM (no reload: same-impression
  // rule). Bounded: keyboard/evaluate hang on a slow renderer.
  const dismissOverlayDialog = async (): Promise<void> => {
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
  };
  await dismissOverlayDialog();

  // aclkFired: the mouse event happened. clickLanded: the browser actually
  // LEFT the SERP — without it, "success" is fake (landing=SERP evidence).
  let aclkFired = false;
  let clickLanded = false;
  // App ads only: watch requests so an observed aclk proves the click
  // reached Google even when the intent:// chain never leaves the SERP.
  const aclkWatch = isAppAdTarget ? watchAclkRequests(page) : null;
  try {
    // Play app cards all share the play.google.com display domain — a
    // domain-only card match can click a DIFFERENT app's ad. Match app
    // targets by title, and extract the Play package href from the card.
    // Locate the anchor — card-scoped first (same matching as the report
    // opener): find the target ad card, click its primary link. The old
    // title-text / aclk-href heuristics miss desktop cards entirely
    // ("could not locate anchor element" → report without click).
    // 15s race: the renderer probe passes, THEN an intent redirect can
    // still freeze mid-flight — an unbounded evaluate hangs the slot.
    type CardAnchor = { x: number; y: number; playHref: string | null };
    const locateCardAnchor = (): Promise<CardAnchor | null> =>
      Promise.race([
      page.evaluate(
      ({ target, titleHint, isApp }) => {
        const norm = (s: string) => s.toLowerCase().replace(/^(www\.|m\.)/, "").trim();
        const cards = Array.from(
          document.querySelectorAll("[data-text-ad], #tads [data-hveid], #tadsb [data-hveid], #tvcap [data-hveid], [data-pcu]")
        );
        for (const c of cards) {
          const heading = c.querySelector('[role="heading"], h3');
          const title = (heading?.textContent || "").trim();
          let dd = "";
          for (const el of c.querySelectorAll("span, cite, div, a")) {
            const txt = (el.textContent || "").trim();
            if (/^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}/i.test(txt)) {
              dd = txt.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0]!;
              break;
            }
          }
          const cardText = (c.textContent || "").toLowerCase();
          const isTarget = isApp
            ? !!(titleHint && title.toLowerCase().includes(titleHint.toLowerCase()))
            : ((dd && norm(dd) === target) ||
               (titleHint && title.toLowerCase().includes(titleHint.toLowerCase())) ||
               cardText.includes(target));
          if (!isTarget) continue;
          const headingLink = heading?.closest("a") as HTMLAnchorElement | null;
          const playLink = c.querySelector('a[href*="play.google.com"], a[href^="intent://"]') as HTMLAnchorElement | null;
          const playHref = playLink?.href ?? null;
          let link: Element | null = null;
          if (isApp) {
            // App-install cards: the heading link often does NOT fire the
            // aclk/intent chain (live storm: same card fails 3/3 on one
            // profile, succeeds on another). The conversion path is the
            // Play/intent anchor or the CTA button — prefer those.
            // NOTE: aclk-wrapped Play hrefs still contain "play.google.com"
            // as a substring (adurl param), so playLink IS the wrapped
            // conversion anchor, not a raw store link.
            const CTA_RE = /yükle|hemen|install|indir|get/i;
            const CONTROL_RE = /menu|more|close|kapat|diğer|daha fazla|options|ayar/i;
            let cta: Element | null = null;
            for (const el of Array.from(c.querySelectorAll('[role="button"], button, a[href]'))) {
              const label = `${el.getAttribute("aria-label") || ""} ${String((el as HTMLElement).className || "")}`;
              if (CONTROL_RE.test(label)) continue; // 3-dot menu / close controls
              const text = (el.textContent || "").trim();
              if (!text || text.length > 30 || !CTA_RE.test(text)) continue;
              const rr = el.getBoundingClientRect();
              if (rr.width > 0) {
                cta = el;
                break;
              }
            }
            link = playLink || cta || headingLink || c.querySelector("a[href]");
          } else {
            link = headingLink || c.querySelector("a[href]");
          }
          if (!link) return null;
          link.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
          const r = link.getBoundingClientRect();
          if (r.width === 0) return null;
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, playHref };
        }
        return null;
      },
      { target: currentAd.displayDomain.toLowerCase().replace(/^(www\.|m\.)/, ""), titleHint: (currentAd.title ?? "").slice(0, isAppAdTarget ? 25 : 60), isApp: isAppAdTarget }
      ).catch(() => null),
      sleep(15_000).then(() => null),
    ]);

    /** Mouse-click a located card; returns the landing page (new tab or same). */
    const mouseClickCard = async (anchorPos: CardAnchor): Promise<Page> => {
      const pagesBefore = page.context().pages().length;
      // Bounded: mouse ops hang forever on a frozen renderer.
      await Promise.race([
        (async () => {
          await page.mouse.move(anchorPos.x, anchorPos.y, { steps: 8 }).catch(() => {});
          await page.mouse.down().catch(() => {});
          await sleep(60 + Math.random() * 80);
          await page.mouse.up().catch(() => {});
        })(),
        sleep(10_000),
      ]);
      aclkFired = true;
      await sleep(1800);
      const pages = page.context().pages();
      return pages.length > pagesBefore ? pages[pages.length - 1]! : page;
    };

    let cardAnchor = await locateCardAnchor();

    let landingPage: Page = page;
    if (cardAnchor) {
      landingPage = await mouseClickCard(cardAnchor);
    } else {
      let clickAnchor = null;
      if (currentAd.isOrganic) {
        clickAnchor = await page.$(`a[href="${currentAd.adHref}"]`).catch(() => null);
        if (!clickAnchor) {
          clickAnchor = await page.$('a[href^="http"] h3').catch(() => null);
        }
      } else {
        const headingSelector = currentAd.title
          ? `a:has-text("${currentAd.title.replace(/"/g, '\\"').slice(0, 80)}")`
          : 'a[href*="aclk"]';
        clickAnchor = await page.$(headingSelector).catch(() => null);
        if (!clickAnchor) {
          clickAnchor = await page.$('a[href*="aclk"]').catch(() => null);
        }
      }
      if (!clickAnchor) {
        // Last resort: fire the aclk directly — the parsed href IS the click
        // URL; DOM anchor is only the pretty way to trigger it. intent://
        // hrefs cannot be goto-fired (and a self-fired intent would fake the
        // listener's proof), so those fall through to the honest error.
        if (currentAd.adHref && !currentAd.adHref.startsWith("intent://")) {
          logger.warn({ jobId: jobForRecord.id, domain: currentAd.displayDomain }, "anchor missing — direct aclk goto fallback");
          await page.goto(currentAd.adHref, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
          aclkFired = true;
        } else {
          throw new Error("could not locate anchor element");
        }
      } else {
        const [newPage] = await Promise.all([
          page.context().waitForEvent("page", { timeout: 20000 }).catch(() => null),
          clickAnchor.click().then(() => { aclkFired = true; }).catch(async () => {
            if (currentAd.adHref && !currentAd.adHref.startsWith("intent://")) {
              await page.goto(currentAd.adHref, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
              aclkFired = true;
            }
            return null;
          }),
        ]);
        landingPage = newPage ?? page;
      }
    }
    await landingPage.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
    ev.landingUrl = landingPage.url();

    // Did the click actually navigate anywhere? aclkFired only means the
    // mouse event happened — a blocked navigation (JS card, intent://) can
    // leave the page sitting on the SERP, and counting that as success
    // produced fake clicks with landing=SERP (seen live on app:meritking).
    const onSerp = (u: string) =>
      u === flow.serpFinalUrl || /\/search[?#]/.test(u) || u.startsWith("intent:");
    let landed = !onSerp(ev.landingUrl);

    // Play app ads: the aclk chain ends at intent://play.google.com — a
    // desktop browser cannot open the intent protocol, so the page usually
    // stays on the SERP even though Google DID register the click. The
    // request listener is the source of truth here: an observed aclk
    // request means the click IS registered (no SERP exit required).
    if (isAppAdTarget && !landed && !aclkWatch?.sawClickProof() && currentAd.adHref && !currentAd.adHref.startsWith("intent://") && landingPage === page) {
      // No click proof observed from the mouse click — fire the parsed aclk
      // directly (that request IS the click); the listener catches it now.
      // intent:// hrefs are EXCLUDED here: goto cannot fire them, and a
      // self-fired intent request would fake the proof the listener verifies.
      logger.warn({ jobId: jobForRecord.id, domain: currentAd.displayDomain }, "app ad: no aclk observed — direct aclk goto fallback");
      await page.goto(currentAd.adHref, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      ev.landingUrl = page.url();
      landed = !onSerp(ev.landingUrl);
    } else if (isAppAdTarget && !landed && !aclkWatch?.sawClickProof() && landingPage === page) {
      // intent:// href (or none): cannot be fired by goto — but the mouse
      // click's chain (aclk → intent) may still be in flight, so give the
      // listener a bounded grace window before judging the click failed.
      for (let i = 0; i < 10 && !aclkWatch?.sawClickProof(); i++) {
        await sleep(500);
      }
    }
    // Same-impression retry (app ads only): the click attempt produced no
    // proof — the card rotated under the mouse, an overlay stole the click,
    // or the chain died silently. Live storm data: ~50% of these succeed on
    // the very next attempt against the SAME card, so ONE bounded retry:
    // dismiss overlays, re-locate the card, mouse-click again, re-wait the
    // proof window. This runs BEFORE any landing step; a second failure
    // takes the honest "no navigation" path below. The listener is
    // event-based, so the retry's clicks simply feed the same watch.
    if (isAppAdTarget && !landed && !aclkWatch?.sawClickProof() && landingPage === page && onSerp(page.url())) {
      logger.warn({ jobId: jobForRecord.id, domain: currentAd.displayDomain }, "app ad: no click proof — retrying click once on the same impression");
      await dismissOverlayDialog();
      const retryAnchor = await locateCardAnchor();
      if (retryAnchor) {
        landingPage = await mouseClickCard(retryAnchor);
        cardAnchor = retryAnchor; // pkg extraction below prefers the fresh card
        await landingPage.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
        ev.landingUrl = landingPage.url();
        landed = !onSerp(ev.landingUrl);
        if (!landed) {
          for (let i = 0; i < 10 && !aclkWatch?.sawClickProof(); i++) {
            await sleep(500);
          }
        }
      } else {
        logger.warn({ jobId: jobForRecord.id, domain: currentAd.displayDomain }, "app ad retry: card no longer on SERP (rotated)");
      }
    }
    const aclkSeen = aclkWatch?.sawClickProof() ?? false;
    // pkg from the ad href, the card DOM, the landing URL, or the observed
    // intent://play.google.com redirect.
    const pkg = isAppAdTarget
      ? appAdPackage(currentAd.adHref) ??
        appAdPackage(cardAnchor?.playHref ?? null) ??
        appAdPackage(ev.landingUrl) ??
        (aclkWatch?.packageId() ?? null)
      : null;
    if (isAppAdTarget && !landed && aclkSeen) {
      // aclk reached Google — count the click even though the intent
      // chain never left the SERP (expected app-ad behaviour). Open the
      // HTTPS Play page (what an app-less user sees) for evidence + stay.
      landed = true;
      if (pkg) {
        const playUrl = `https://play.google.com/store/apps/details?id=${pkg}&hl=tr&gl=tr`;
        logger.info({ jobId: jobForRecord.id, pkg }, "app ad: aclk observed on SERP — HTTPS Play page for evidence");
        await landingPage.goto(playUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
        ev.landingUrl = landingPage.url();
        if (!/play\.google\.com/.test(ev.landingUrl)) {
          logger.warn({ jobId: jobForRecord.id, url: ev.landingUrl.slice(0, 100) }, "app ad: Play page did not load — counting click without landing evidence");
        }
      }
    }
    if (!isAppAdTarget && !pkg && !landed && !currentAd.isOrganic && currentAd.adHref && landingPage === page) {
      // Web ad whose click never navigated (JS-blocked card): follow the
      // aclk directly — that request IS the click Google registers.
      logger.warn({ jobId: jobForRecord.id, domain: currentAd.displayDomain }, "click did not navigate — direct aclk goto fallback");
      await page.goto(currentAd.adHref, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      ev.landingUrl = page.url();
      landed = !onSerp(ev.landingUrl);
    }
    clickLanded = landed;
    if (!landed) {
      throw new Error("click did not leave the SERP (no navigation)");
    }

    // Cloudflare doğrulama kutusu (Turnstile checkbox) — tıkla / 2captcha.
    let cfPassed = true;
    // Thrown = infra error (page crash, CDP, network timeout) — NOT a
    // challenge defeat; must not feed the profile's cooldown ladder.
    let cfInfraError = false;
    try {
      const { passCloudflareIfPresent } = await import("../captcha/cloudflare.js");
      const proxy = ctx.profileMeta.get(jobForRecord.profileId);
      const { captchaProxyFromProfile } = await import("../adspower/client.js");
      const px = proxy ? captchaProxyFromProfile(proxy) : undefined;
      const cf = await passCloudflareIfPresent(landingPage, ctx.config, {
        proxy: px?.proxy,
        proxytype: px?.proxytype as "SOCKS5" | "HTTP" | "HTTPS" | "SOCKS4" | undefined,
        timeoutMs: 90_000,
        outputDir: ctx.config.output.dir,
      });
      if (cf.method !== "none") {
        logger.info({ jobId: jobForRecord.id, method: cf.method, passed: cf.passed }, "landing Cloudflare pass attempt");
      }
      cfPassed = cf.passed;
      ev.landingUrl = landingPage.url();
    } catch (cfErr) {
      logger.debug({ err: String(cfErr) }, "landing Cloudflare pass failed");
      cfPassed = false;
      cfInfraError = true;
    }

    if (!cfPassed) {
      // Challenge wall still up — no behaviour/resolve here (wanders to
      // cloudflare.com, seen live). Mark the profile cooling so the engine
      // stops burning it on CF-heavy landings for a while — but ONLY on a
      // genuine challenge defeat, never on an infra error.
      if (cfInfraError) {
        logger.warn({ jobId: jobForRecord.id }, "CF pass errored (infra — page/CDP/network) — NO cooldown, skipping landing behaviour");
      } else {
        try {
          const { Store } = await import("../store/db.js");
          const vault = new Store(ctx.config.output.dir);
          const cool = vault.ipTrust.markSolverFailed(jobForRecord.profileId, "cf: landing challenge failed");
          vault.close();
          logger.warn({ jobId: jobForRecord.id, landing: landingPage.url().slice(0, 80), cooldownMinutes: cool.cooldownMinutes }, "CF not passed — profile cooling + skipping landing behaviour");
        } catch {
          logger.warn({ jobId: jobForRecord.id }, "CF not passed — skipping landing behaviour & resolve");
        }
      }
      ev.finalUrl = null;
      ev.finalDomain = null;
      throw new Error("cloudflare challenge not passed");
    }

    // Post-click behaviour on landing. 90s race (same class as the inline
    // fix): evaluates hang forever on a frozen renderer — the slot dies
    // with the 8m cap instead of waiting forever.
    const behaviour = await Promise.race([
      behaveOnLanding(landingPage, device, personaBehavior, profileKey),
      sleep(90_000).then(() => null),
    ]);
    ev.stayMs = behaviour?.stayMs ?? 0;
    ev.internalClicks = behaviour?.internalClicks ?? 0;
    ev.screenshotLanding = await screenshotPage(landingPage, evPaths.paths.landing);

    // Resolve fallback: only if the pre-click resolve failed.
    if (!ev.finalDomain) {
      try {
        const outcome = await resolveLanding(sess, currentAd.adHref, {
          hopCap: ctx.config.scan.hopCap,
          timeoutMs: ctx.config.scan.resolveTimeoutMs,
          referer: `https://${ctx.config.google.domain}/`,
          bettingKeywords: ctx.config.bettingKeywords,
        });
        ev.finalUrl = outcome.finalUrl;
        ev.finalDomain = outcome.finalDomain;
        ev.redirectHops = outcome.hops;
      } catch (resolveErr) {
        logger.debug({ jobId: jobForRecord.id, err: String(resolveErr) }, "landing resolve failed");
        const u = landingPage.url();
        // Never record the SERP itself as "final landing" — that turned
        // no-navigation clicks into fake evidence (seen on app:meritking).
        if (!u.includes("/search?") && u !== flow.serpFinalUrl) {
          ev.finalUrl = u;
          try {
            ev.finalDomain = new URL(u).hostname;
          } catch {
            ev.finalDomain = null;
          }
        }
      }
    }

    // Final screenshot.
    if (ev.finalUrl && ev.finalUrl !== landingPage.url()) {
      try {
        await landingPage.goto(ev.finalUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await sleep(1000);
      } catch {
        /* ignore */
      }
    }
    ev.screenshotFinal = await screenshotPage(landingPage, evPaths.paths.final);

    st = "success";

    // Back to the SERP (landing tab no longer needed). Prefer goBack —
    // bfcache returns the SAME impression; a fresh goto re-runs the
    // auction and rotates the cards the harvest pass still needs.
    if (landingPage !== page) {
      await landingPage.close().catch(() => {});
    }
    // Restore whenever we are not back on a search page. The old
    // includes("google.") guard also matched play.google.com — after an
    // app-ad success the page stayed on the Play Store, which stranded
    // storm's back-loop (and the harvest pass) off the SERP.
    const afterClickUrl = page.url();
    if (afterClickUrl !== serpUrl && !/\/search[?#]/.test(afterClickUrl)) {
      await restoreSerp(page, serpUrl);
    }
  } catch (clickErr) {
    if (aclkFired && clickLanded) {
      // Google saw the click AND we left the SERP — a later landing error
      // (CF wall, resolve) is best-effort, not a failed click.
      st = "success";
      err = `landing failed after aclk: ${String(clickErr).slice(0, 120)}`;
      logger.warn({ jobId: jobForRecord.id, err }, "click fired but landing failed — counting as click");
    } else {
      st = "failed";
      err = String(clickErr);
      logger.warn({ jobId: jobForRecord.id, err }, "click step failed (no aclk) — report was already sent on the impression");
    }
    await restoreSerp(page, serpUrl);
  } finally {
    aclkWatch?.detach();
  }

  // 1:1 salvage (post-click): ads already passed the pre-click 1:1 gate,
  // so this only fires for report-exempt paths (organic results) whose
  // report failed on this impression. Same fresh-impression retry logic.
  if (flow.reportEnabled && st === "success") {
    if (clickFirst) {
      // Click-first: the click is registered and the SERP restored — report
      // NOW on the same impression, with the same fresh-impression retry
      // ladder as report-first. If the report still fails, the click STANDS
      // (single allowed 1:1 exception) and is recorded honestly.
      rep = await maybeReportAdBeforeClick(ctx, page, jobForRecord, currentAd, preEvidence);
      ctx.store.upsertReportOutcome(ctx.runId, jobForRecord, rep);
      if (rep.status !== "submitted" && rep.status !== "filled") {
        rep = await retryReportOnFreshImpressions(flow, currentAd, jobForRecord, rep, ev);
      }
      if (rep.status !== "submitted" && rep.status !== "filled") {
        rep = {
          status: rep.status,
          message: `${rep.status} after click-first (click kept)${rep.message ? ` · ${rep.message}` : ""}`,
        };
        ctx.store.upsertReportOutcome(ctx.runId, jobForRecord, rep);
        logger.warn(
          { jobId: jobForRecord.id, domain: currentAd.displayDomain, reportStatus: rep.status },
          "app click-first: report failed after retries — click kept (click-first exception)"
        );
      }
    } else {
      rep = await retryReportOnFreshImpressions(flow, currentAd, jobForRecord, rep, ev);
    }
  }

  return { status: st, error: err, evidence: ev, reportResult: rep };
}

export async function runClickJob(ctx: WorkerContext, job: ClickJob): Promise<ClickResult> {
  const evidence: ClickEvidence = {
    serpUrl: null,
    adTitle: null,
    adDescription: null,
    displayUrl: null,
    clickUrl: null,
    landingUrl: null,
    finalUrl: null,
    finalDomain: null,
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
  let reportResult: ClickReportResult = { status: "skipped", message: "target ad not reached" };

  const evidenceDir = ensureEvidenceDir(ctx.outputDir, ctx.runId);
  const { paths } = buildEvidencePaths(evidenceDir, job.id, job.device, job.keyword);

  let session: BrowserSession | null = null;

  try {
    // 1. Open profile.
    session = await openProfile(ctx, job.profileId, job.device);
    if (!session) {
      status = "profile_error";
      error = "could not open AdsPower profile";
      return { job, status, evidence, error, capturedAt, report: reportResult };
    }

    const page = session.page;

    // 2. Navigate to SERP.
    const serpUrl = buildSerpUrl(ctx.config, job.keyword);
    const proxy = ctx.profileMeta.get(job.profileId);
    const captchaProxy = proxy ? captchaProxyFromProfile(proxy) : undefined;
    const serpNavOpts = {
      captchaProxy: captchaProxy
        ? { proxy: captchaProxy.proxy, proxytype: captchaProxy.proxytype }
        : undefined,
      profileId: job.profileId,
    };
    let nav = await gotoSerp(session, serpUrl, ctx.config, serpNavOpts);

    if (nav.captcha) {
      // The solver chain inside gotoSerp already failed on this wall. A wall
      // this soon after warm-up (often right after a successful solve) means a
      // low trust score — refresh reputation with ONE clean trend search
      // instead of hammering the solver again (back-to-back solves against
      // Google are a bot pattern), then retry the SERP once. The profile stays
      // open in the SAME session as long as anything clears.
      logger.warn(
        { jobId: job.id, profileId: job.profileId, keyword: job.keyword },
        "SERP wall survived the solver chain — refreshing reputation via one clean trend search"
      );
      const warm = await warmUp(session, ctx.config, { ...serpNavOpts, trendWarmup: true });
      if (!warm.captcha) {
        // skipSolve: trust was just refreshed — do NOT re-enter the solver loop here.
        nav = await gotoSerp(session, serpUrl, ctx.config, { ...serpNavOpts, skipSolve: true });
      }
      if (nav.captcha) {
        // Genuine solver defeat — short 10m break, no long park: the vault's
        // next clean check makes the profile usable again. Infra errors
        // (crash/CDP/timeout) never feed the cooldown ladder.
        let cool: { cooldownMinutes: number; nextRetryAt: string } | null = null;
        if (!warm.infraError) {
          try {
            const { Store } = await import("../store/db.js");
            const vault = new Store(ctx.config.output.dir);
            cool = vault.ipTrust.markSolverFailed(job.profileId, "click: SERP wall after trend refresh", { maxCooldownMinutes: 10 });
            vault.close();
          } catch {
            /* vault optional */
          }
        }
        status = "captcha";
        error = "CAPTCHA wall blocked SERP";
        evidence.serpUrl = nav.finalUrl;
        logger.warn(
          {
            jobId: job.id,
            profileId: job.profileId,
            infraError: warm.infraError ?? false,
            cooldownMinutes: cool?.cooldownMinutes,
            nextRetryAt: cool?.nextRetryAt,
          },
          warm.infraError
            ? "SERP still walled after trend refresh (infra error — NO cooldown)"
            : "SERP still walled after trend refresh — short cooldown, profile released"
        );
        await closeProfile(ctx, session, job.profileId);
        return { job, status, evidence, error, capturedAt, report: reportResult };
      }
      logger.info(
        { jobId: job.id, profileId: job.profileId },
        "SERP wall cleared after trend reputation refresh — continuing in the same session"
      );
    }

    evidence.serpUrl = nav.finalUrl;

    // 3. Browse SERP naturally (per-profile persona).
    const meta = ctx.profileMeta.get(job.profileId);
    const profileKey = meta?.name || job.profileId;
    const personaBehavior = behaviorForProfile(ctx.behavior, profileKey);
    logger.debug({ profile: profileKey, persona: personaFor(profileKey).label }, "click persona");
    evidence.preClickMs = await preClickBrowse(page, job.device, personaBehavior);

    // 4. Parse ads and find target. Bounded — a wedged renderer here used to
    // hang the slot until the 8m reaper.
    const ads = await Promise.race([
      parseAds(page),
      sleep(20_000).then(() => [] as Awaited<ReturnType<typeof parseAds>>),
    ]);
    let targetAd = matchAd(ads, job.targetDomain, job.targetTitle, job.fallbackFirstAd);
    // Diagnose "target ad not found" waves: did the SERP have no ads at all
    // (ad simply not served to this IP/device) or did we fail to match it?
    if (!targetAd) {
      logger.info(
        {
          jobId: job.id,
          device: job.device,
          profileId: job.profileId,
          target: job.targetDomain,
          adsFound: ads.length,
          seenDomains: ads.map((a) => a.displayDomain).slice(0, 6),
          pageUrl: page.url().slice(0, 120),
        },
        "click: target ad not on SERP — parsed inventory"
      );
    }

    if (!targetAd && job.clickFirstResult) {
      targetAd = await firstOrganicResult(page);
    }

    evidence.screenshotSerp = await screenshotPage(page, paths.serp);

    const sess = session; // non-null from here on (checked above)
    // Shared flow state for the module-level clickAndReportAd (main target AND
    // the harvest pass). Storm mode builds the same shape per impression.
    const flow: AdFlowContext = {
      ctx,
      session: sess,
      page,
      serpUrl,
      serpFinalUrl: evidence.serpUrl,
      screenshotSerp: evidence.screenshotSerp,
      preClickMs: evidence.preClickMs,
      evidenceDir,
      device: job.device,
      keyword: job.keyword,
      personaBehavior,
      profileKey,
      reportEnabled: true,
    };

    // clickAndReportAd + retryReportOnFreshImpressions now live at module
    // level (shared with storm mode) — called below via `flow`.

    const hourAgoIso = new Date(Date.now() - 3_600_000).toISOString();
    const hourCap = Math.max(1, ctx.config.click.maxClicksPerProfilePerHour);
    const cooldownMs = Math.max(0, ctx.config.click.sameAdCooldownMinutes) * 60_000;
    /**
     * Advertiser identity for cooldown/dedupe: app-install ads all share the
     * play.google.com display domain — without this they would collapse into
     * ONE cooldown bucket and one dedupe entry. Web ads use their domain.
     */
    const identityOf = (a: (typeof ads)[number]): string =>
      isAppInstallAd(a.displayDomain, a.adHref)
        ? (appAdKey(a.title, a.adHref) ?? (a.displayDomain || ""))
        : (a.displayDomain || "");
    const isCooling = (domain: string): boolean => {
      const d = domain.toLowerCase().replace(/^www\./, "");
      if (ctx.store.countRecentSuccesses(job.profileId, d, hourAgoIso) >= hourCap) return true;
      const last = ctx.store.lastSuccessAt(job.profileId, d);
      return !!(last && Date.now() - new Date(last).getTime() < cooldownMs);
    };
    const uniqueAds = (list: typeof ads): typeof ads => {
      const seen = new Set<string>();
      return list.filter((a) => {
        const d = identityOf(a).toLowerCase().replace(/^www\./, "");
        if (!d || seen.has(d)) return false;
        seen.add(d);
        return true;
      });
    };

    if (!targetAd) {
      // Target not on this SERP — but other ads may exist. Harvest them instead
      // of walking away (they are betting ads for the same keyword).
      const harvestable = uniqueAds(ads).filter((a) => a.adHref && !isCooling(identityOf(a))).slice(0, 4);
      if (harvestable.length === 0) {
        status = "skipped";
        error = `target ad not found for domain ${job.targetDomain}`;
        await closeProfile(ctx, session, job.profileId);
        return { job, status, evidence, error, capturedAt, report: reportResult };
      }
      logger.info({ jobId: job.id, target: job.targetDomain, fallback: harvestable.map((a) => a.displayDomain) }, "target missing — harvesting other ads on SERP");
      let anySuccess = false;
      for (let i = 0; i < harvestable.length; i++) {
        const extra = toClickableAd(harvestable[i]!);
        const extraJob: ClickJob = { ...job, id: `${job.id}-h${i}`, targetDomain: identityOf(harvestable[i]!) || extra.displayDomain, targetTitle: extra.title };
        const r = await clickAndReportAd(flow, extra, extraJob);
        ctx.store.insertClick(ctx.runId, { job: extraJob, status: r.status, evidence: r.evidence, error: r.error, capturedAt: new Date().toISOString(), report: r.reportResult });
        if (r.status === "success") anySuccess = true;
        // Harvest clicks bypass executeJob — emit their own panel event or the
        // terminal never shows them (report stays visible only in Raporlama).
        ctx.onProgress?.({
          type: "click-done",
          jobId: extraJob.id,
          runId: ctx.runId,
          domain: extra.displayDomain,
          device: job.device,
          profileId: job.profileId,
          status: r.status,
          reportStatus: r.reportResult?.status ?? null,
          reportMessage: r.reportResult?.message ?? null,
          stayMs: r.evidence?.stayMs ?? 0,
          harvest: true,
          message: `hasat tık ${r.status} · rapor ${r.reportResult?.status ?? "-"} · ${extra.displayDomain} · ${job.device}`,
        });
      }
      status = anySuccess ? "success" : "skipped";
      error = anySuccess ? null : "target not found; harvest failed";
      await closeProfile(ctx, session, job.profileId);
      return { job, status, evidence, error, capturedAt, report: reportResult };
    }

    evidence.adTitle = targetAd.title;
    evidence.adDescription = targetAd.description;
    evidence.displayUrl = targetAd.displayUrl;
    evidence.clickUrl = targetAd.adHref;

    // 5. Main target: click → landing evidence → report.
    const main = await clickAndReportAd(flow, targetAd, job);
    status = main.status;
    error = main.error;
    Object.assign(evidence, {
      landingUrl: main.evidence.landingUrl,
      finalUrl: main.evidence.finalUrl,
      finalDomain: main.evidence.finalDomain,
      redirectHops: main.evidence.redirectHops,
      stayMs: main.evidence.stayMs,
      internalClicks: main.evidence.internalClicks,
      screenshotLanding: main.evidence.screenshotLanding,
      screenshotFinal: main.evidence.screenshotFinal,
    });
    reportResult = main.reportResult;

    // 6. Harvest pass: other ads on the same SERP (unique identities, not cooling).
    const extras = uniqueAds(ads)
      .filter((a) => a.adHref)
      .filter((a) => identityOf(a).toLowerCase().replace(/^www\./, "") !== identityOf(targetAd).toLowerCase().replace(/^www\./, ""))
      .filter((a) => !isCooling(identityOf(a)))
      .slice(0, 4);
    for (let i = 0; i < extras.length; i++) {
      const extra = toClickableAd(extras[i]!);
      const extraJob: ClickJob = { ...job, id: `${job.id}-h${i}`, targetDomain: identityOf(extras[i]!) || extra.displayDomain, targetTitle: extra.title };
      const r = await clickAndReportAd(flow, extra, extraJob);
      ctx.store.insertClick(ctx.runId, { job: extraJob, status: r.status, evidence: r.evidence, error: r.error, capturedAt: new Date().toISOString(), report: r.reportResult });
      logger.info({ jobId: job.id, extra: extra.displayDomain, status: r.status, report: r.reportResult.status }, "harvest: extra ad click+report done");
      // Same panel event as the target-missing harvest loop — these clicks
      // bypass executeJob, so without it the terminal never shows them.
      ctx.onProgress?.({
        type: "click-done",
        jobId: extraJob.id,
        runId: ctx.runId,
        domain: extra.displayDomain,
        device: job.device,
        profileId: job.profileId,
        status: r.status,
        reportStatus: r.reportResult?.status ?? null,
        reportMessage: r.reportResult?.message ?? null,
        stayMs: r.evidence?.stayMs ?? 0,
        harvest: true,
        message: `hasat tık ${r.status} · rapor ${r.reportResult?.status ?? "-"} · ${extra.displayDomain} · ${job.device}`,
      });
    }

  } catch (err) {
    logger.error({ jobId: job.id, profileId: job.profileId, err: String(err) }, "click worker failed");
    status = "failed";
    error = String(err);
  } finally {
    if (session) {
      await closeProfile(ctx, session, job.profileId);
    }
  }

  return { job, status, evidence, error, capturedAt, report: reportResult };
}
