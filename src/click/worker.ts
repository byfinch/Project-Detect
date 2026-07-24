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
  };
}

function normalizeDomain(s: string): string {
  return s.toLowerCase().replace(/^(www\.|m\.)/, "").trim();
}

interface ClickableTarget {
  title: string;
  adHref: string | null;
  displayUrl: string;
  displayDomain: string;
  description: string;
  block: "top" | "bottom" | "unknown";
  isOrganic: boolean;
}

function matchAd(
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

async function openProfile(ctx: WorkerContext, profileId: string, device: Device): Promise<BrowserSession | null> {
  let session: BrowserSession | null = null;
  try {
    // AdsPower transient open failures (zombie browser, CDP refused, stale lock)
    // are common — one stop+retry recovers most of them instead of burning the
    // job as profile_error (26 of 766 attempts in a live op).
    let ws: string | null = null;
    for (let openAttempt = 1; openAttempt <= 2; openAttempt++) {
      try {
        ws = await ctx.adsClient.ensureBrowser(profileId);
        break;
      } catch (err) {
        if (openAttempt === 2) throw err;
        logger.warn({ profileId, err: String(err) }, "click worker: profile open failed — stop + single retry");
        await ctx.adsClient.stopBrowser(profileId).catch(() => {});
        await sleep(2_000);
      }
    }
    if (!ws) throw new Error("ensureBrowser returned no ws endpoint");
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
      const ws2 = await ctx.adsClient.ensureBrowser(profileId);
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
      let cool: { cooldownMinutes: number; nextRetryAt: string } | null = null;
      try {
        const { Store } = await import("../store/db.js");
        const vault = new Store(ctx.config.output.dir);
        cool = vault.ipTrust.markSolverFailed(profileId, "click: trend warm-up solver failed");
        vault.close();
      } catch {
        /* vault optional */
      }
      logger.warn(
        {
          profileId,
          trend: warm.trend,
          method: warm.method,
          cooldownMinutes: cool?.cooldownMinutes,
          nextRetryAt: cool?.nextRetryAt,
        },
        "click worker: trend warm-up solver failed — cooldown (try another profile)"
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

async function closeProfile(ctx: WorkerContext, session: BrowserSession | null, profileId: string): Promise<void> {
  try {
    const { gracefulProfileShutdown } = await import("../browser/shutdown.js");
    await gracefulProfileShutdown(ctx.adsClient, session, profileId);
  } finally {
    releaseProfile(profileId);
  }
}

async function maybeReportAdBeforeClick(
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
    const nav = await gotoSerp(session, serpUrl, ctx.config, {
      captchaProxy: captchaProxy
        ? { proxy: captchaProxy.proxy, proxytype: captchaProxy.proxytype }
        : undefined,
      profileId: job.profileId,
    });

    if (nav.captcha) {
      status = "captcha";
      error = "CAPTCHA wall blocked SERP";
      evidence.serpUrl = nav.finalUrl;
      await closeProfile(ctx, session, job.profileId);
      return { job, status, evidence, error, capturedAt, report: reportResult };
    }

    evidence.serpUrl = nav.finalUrl;

    // 3. Browse SERP naturally (per-profile persona).
    const meta = ctx.profileMeta.get(job.profileId);
    const profileKey = meta?.name || job.profileId;
    const personaBehavior = behaviorForProfile(ctx.behavior, profileKey);
    logger.debug({ profile: profileKey, persona: personaFor(profileKey).label }, "click persona");
    evidence.preClickMs = await preClickBrowse(page, job.device, personaBehavior);

    // 4. Parse ads and find target.
    const ads = await parseAds(page);
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
    const toClickable = (a: (typeof ads)[number]): ClickableTarget => ({
      title: a.title,
      adHref: a.adHref,
      displayUrl: a.displayUrl,
      displayDomain: a.displayDomain,
      description: a.description,
      block: (a as { block?: "top" | "bottom" | "unknown" }).block ?? "unknown",
      isOrganic: false,
    });

    /**
     * Click + CF + landing behaviour + resolve + report for ONE ad on the
     * current SERP. Used for the main target AND for the harvest pass
     * (other ads on the same SERP — including when the target is missing).
     */
    async function clickAndReportAd(
      currentAd: ClickableTarget,
      jobForRecord: ClickJob
    ): Promise<{ status: ClickStatus; error: string | null; evidence: ClickEvidence; reportResult: ClickReportResult }> {
      const ev: ClickEvidence = {
        serpUrl: evidence.serpUrl,
        adTitle: currentAd.title,
        adDescription: currentAd.description,
        displayUrl: currentAd.displayUrl,
        clickUrl: currentAd.adHref,
        landingUrl: null,
        finalUrl: null,
        finalDomain: null,
        redirectHops: [],
        screenshotSerp: evidence.screenshotSerp,
        screenshotLanding: null,
        screenshotFinal: null,
        preClickMs: evidence.preClickMs,
        stayMs: 0,
        internalClicks: 0,
      };
      let st: ClickStatus = "running";
      let err: string | null = null;
      let rep: ClickReportResult = { status: "skipped", message: "not attempted" };
      const evPaths = buildEvidencePaths(evidenceDir, jobForRecord.id, job.device, job.keyword);

      if (!currentAd.adHref) {
        return { status: "skipped", error: "ad has no href", evidence: ev, reportResult: rep };
      }

      // 1) Evidence-first resolve (NO ad click): the report goes out on THIS
      //    exact impression — impressions rotate, so report before the landing
      //    journey, with the resolved betting domain already as evidence.
      const preEvidence: { finalUrl?: string | null; finalDomain?: string | null } = {};
      try {
        const outcome = await resolveLanding(sess, currentAd.adHref, {
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

      // 2) Report on the SAME fresh impression — with the resolved evidence.
      rep = await maybeReportAdBeforeClick(ctx, page, jobForRecord, currentAd, preEvidence);

      // Dismiss the "Reklam Merkezim" overlay the report flow leaves open —
      // the click phase needs a clean SERP DOM (no reload: same-impression rule).
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

      // Renderer liveness probe (5s): the report flow (or an intent:// redirect
      // from a previous ad) can leave the renderer frozen — every later call
      // then burns its own cap and the job dies as "failed" after minutes
      // (seen live on the app:casibom mobile leg). Report is already out;
      // skip the click cheaply instead of wedging the slot.
      const rendererAlive = await Promise.race([
        page.evaluate(() => 1).then(() => true, () => false),
        sleep(5_000).then(() => false),
      ]);
      if (!rendererAlive) {
        logger.warn({ jobId: jobForRecord.id, domain: currentAd.displayDomain }, "click worker: renderer frozen before click phase — skipping click (report already out)");
        return { status: "skipped", error: "renderer frozen before click (intent redirect?)", evidence: ev, reportResult: rep };
      }

      // aclkFired: Google registers the click the moment the aclk is followed —
      // a landing error afterwards does NOT un-click it (and must still count).
      let aclkFired = false;
      try {
        // Locate the anchor — card-scoped first (same matching as the report
        // opener): find the target ad card, click its primary link. The old
        // title-text / aclk-href heuristics miss desktop cards entirely
        // ("could not locate anchor element" → report without click).
        const cardAnchor = await page.evaluate(
          ({ target, titleHint }) => {
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
              const isTarget =
                (dd && norm(dd) === target) ||
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
          { target: currentAd.displayDomain.toLowerCase().replace(/^(www\.|m\.)/, ""), titleHint: currentAd.title?.slice(0, 60) ?? "" }
        ).catch(() => null);

        let landingPage: Page = page;
        if (cardAnchor) {
          const pagesBefore = page.context().pages().length;
          await page.mouse.move(cardAnchor.x, cardAnchor.y, { steps: 8 }).catch(() => {});
          await page.mouse.down().catch(() => {});
          await sleep(60 + Math.random() * 80);
          await page.mouse.up().catch(() => {});
          aclkFired = true;
          await sleep(1800);
          const pages = page.context().pages();
          if (pages.length > pagesBefore) landingPage = pages[pages.length - 1]!;
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
            // URL; DOM anchor is only the pretty way to trigger it.
            if (currentAd.adHref) {
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
                if (currentAd.adHref) {
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

        // Play app ads: the aclk/intent chain ends at intent://play.google.com —
        // a browser cannot open the intent protocol (and mobile emulation freezes
        // on the "open in app" flow). The CLICK is already registered by Google
        // (aclk fired); for landing evidence + stay, take the HTTPS Play page
        // (what an app-less user sees) via the package id.
        if (
          ev.landingUrl.startsWith("intent:") ||
          (currentAd.adHref?.startsWith("intent://") && ev.landingUrl.includes("google."))
        ) {
          const pkg =
            appAdPackage(currentAd.adHref) ?? appAdPackage(ev.landingUrl);
          if (pkg) {
            const playUrl = `https://play.google.com/store/apps/details?id=${pkg}&hl=tr&gl=tr`;
            logger.info({ jobId: jobForRecord.id, pkg }, "app ad: intent landing — navigating to HTTPS Play page for evidence");
            await landingPage.goto(playUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
            ev.landingUrl = landingPage.url();
          }
        }

        // Cloudflare doğrulama kutusu (Turnstile checkbox) — tıkla / 2captcha.
        let cfPassed = true;
        try {
          const { passCloudflareIfPresent } = await import("../captcha/cloudflare.js");
          const proxy = ctx.profileMeta.get(job.profileId);
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
        }

        if (!cfPassed) {
          // Challenge wall still up — no behaviour/resolve here (wanders to
          // cloudflare.com, seen live). Mark the profile cooling so the engine
          // stops burning it on CF-heavy landings for a while.
          try {
            const { Store } = await import("../store/db.js");
            const vault = new Store(ctx.config.output.dir);
            const cool = vault.ipTrust.markSolverFailed(job.profileId, "cf: landing challenge failed");
            vault.close();
            logger.warn({ jobId: jobForRecord.id, landing: landingPage.url().slice(0, 80), cooldownMinutes: cool.cooldownMinutes }, "CF not passed — profile cooling + skipping landing behaviour");
          } catch {
            logger.warn({ jobId: jobForRecord.id }, "CF not passed — skipping landing behaviour & resolve");
          }
          ev.finalUrl = null;
          ev.finalDomain = null;
          throw new Error("cloudflare challenge not passed");
        }

        // Post-click behaviour on landing.
        const behaviour = await behaveOnLanding(landingPage, job.device, personaBehavior, profileKey);
        ev.stayMs = behaviour.stayMs;
        ev.internalClicks = behaviour.internalClicks;
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
            ev.finalUrl = landingPage.url();
            try {
              ev.finalDomain = new URL(landingPage.url()).hostname;
            } catch {
              ev.finalDomain = null;
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

        // Back to the SERP (landing tab no longer needed).
        if (landingPage !== page) {
          await landingPage.close().catch(() => {});
        }
        if (!page.url().includes("google.")) {
          await page.goto(serpUrl, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
          await sleep(1500);
        }
      } catch (clickErr) {
        if (aclkFired) {
          // Google saw the click — landing error is best-effort, not a failed click.
          st = "success";
          err = `landing failed after aclk: ${String(clickErr).slice(0, 120)}`;
          logger.warn({ jobId: jobForRecord.id, err }, "click fired but landing failed — counting as click");
        } else {
          st = "failed";
          err = String(clickErr);
          logger.warn({ jobId: jobForRecord.id, err }, "click step failed (no aclk) — report was already sent on the impression");
        }
        await page.goto(serpUrl, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
        await sleep(1500);
      }

      // 1:1 guarantee — the report failed on this impression (no-form /
      // submit-failed / wedged opener) but the click landed. ONE bounded
      // retry on a FRESH impression: re-search the keyword, re-locate the ad,
      // report only. Google rotates cards, so the fresh card usually has the
      // menu again. Naturalness preserved: single retry, same profile, new SERP.
      if (
        st === "success" &&
        ctx.config.report.autoSerpSubmit &&
        (rep.status === "no-form" || rep.status === "submit-failed" || rep.status === "error" || rep.status === "skipped")
      ) {
        try {
          logger.info({ jobId: jobForRecord.id, domain: currentAd.displayDomain, prev: rep.status }, "report retry on fresh impression");
          await page.goto(serpUrl, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
          await sleep(1200);
          const retryAds = await parseAds(page);
          // App ads share play.google.com — match the fresh SERP by app identity.
          const retryKey =
            appAdKey(currentAd.title, currentAd.adHref) ?? currentAd.displayDomain;
          const retryAd = matchAd(retryAds, retryKey, currentAd.title, false);
          if (retryAd?.adHref) {
            const retryTarget = toClickable(retryAd);
            const retryRep = await maybeReportAdBeforeClick(ctx, page, jobForRecord, retryTarget, {
              finalUrl: ev.finalUrl,
              finalDomain: ev.finalDomain,
            });
            if (retryRep.status === "submitted" || retryRep.status === "filled" || rep.status === "skipped") {
              rep = retryRep;
            }
          } else {
            logger.info({ jobId: jobForRecord.id, domain: currentAd.displayDomain }, "report retry: ad not on fresh SERP (rotated)");
          }
        } catch (retryErr) {
          logger.warn({ jobId: jobForRecord.id, err: String(retryErr) }, "report retry failed (keeping original result)");
        }
      }

      return { status: st, error: err, evidence: ev, reportResult: rep };
    }

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
        const extra = toClickable(harvestable[i]!);
        const extraJob: ClickJob = { ...job, id: `${job.id}-h${i}`, targetDomain: identityOf(harvestable[i]!) || extra.displayDomain, targetTitle: extra.title };
        const r = await clickAndReportAd(extra, extraJob);
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
    const main = await clickAndReportAd(targetAd, job);
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
      const extra = toClickable(extras[i]!);
      const extraJob: ClickJob = { ...job, id: `${job.id}-h${i}`, targetDomain: identityOf(extras[i]!) || extra.displayDomain, targetTitle: extra.title };
      const r = await clickAndReportAd(extra, extraJob);
      ctx.store.insertClick(ctx.runId, { job: extraJob, status: r.status, evidence: r.evidence, error: r.error, capturedAt: new Date().toISOString(), report: r.reportResult });
      logger.info({ jobId: job.id, extra: extra.displayDomain, status: r.status, report: r.reportResult.status }, "harvest: extra ad click+report done");
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
