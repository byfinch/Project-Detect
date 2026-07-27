/**
 * Storm mode — persistent session pool.
 *
 * Instead of the open → warm-up → click → close cycle of the normal click
 * engine, a storm session KEEPS the profile open on a SERP where the target
 * ad was seen and produces repeated click + report cycles from it:
 *
 *   1. Back-loop: click the ad, short landing stay, restoreSerp(goBack) —
 *      the SAME impression (same gclid) survives; up to
 *      storm.clicksPerImpression cheap extra clicks per impression.
 *   2. Controlled refresh every storm.refreshIntervalSec (±40% jitter): a
 *      new auction = new gclid = full-value click. If the ad is gone, retry
 *      every storm.missRetrySec up to storm.maxMisses, then release the
 *      profile (session closes, profile may be re-picked later).
 *   3. Report cadence: 1 in storm.reportEveryNClicks clicks reports via the
 *      exact engine flow (maybeReportAdBeforeClick + email pool + evidence).
 *      The 1:1 rule applies only on report clicks: a failed report skips
 *      THAT click, never the whole session.
 *   4. Protection: per-profile hourly cap (shared ClickStore counter with
 *      the normal engine), keyword rotation within the set, solve-through
 *      captcha with a maxSolverFails budget (10m rest, no long park), infra
 *      errors close the session WITHOUT cooldown.
 *
 * Pool management: storm.maxSessions concurrent sessions, shrunk by the RAM
 * governor and by external browser usage; when a scan/click campaign runs
 * (shouldYield) storm gracefully sheds ALL sessions until it finishes.
 *
 * Startup source is the panel API for now; the module is intentionally
 * self-contained (StormStartOptions in, events out) so a future campaign
 * handoff can drive it without changes here.
 */
import { AdsPowerClient, captchaProxyFromProfile, type ProfileSummary } from "../adspower/client.js";
import type { AppConfig } from "../config.js";
import type { BrowserSession } from "../browser/session.js";
import { buildSerpUrl, gotoSerp, warmUp, type SerpNavOptions } from "../google/serp.js";
import { parseAds } from "../google/adParser.js";
import { logger } from "../logger.js";
import { sleep } from "../util/time.js";
import type { Device } from "../types.js";
import type { ClickBehaviorConfig, ClickJob, ClickResult } from "./types.js";
import { ClickStore } from "./store.js";
import {
  clickAndReportAd,
  closeProfile,
  matchAd,
  normalizeDomain,
  openProfile,
  type AdFlowContext,
  type WorkerContext,
} from "./worker.js";
import { getInUseProfiles, releaseProfile } from "../browser/profileRegistry.js";
import { governedConcurrency } from "../util/resources.js";
import { behaviorForProfile } from "../util/persona.js";
import { ensureEvidenceDir } from "./evidence.js";

/** ±40% everywhere — no metronome intervals in storm mode. */
function jitterSec(baseSec: number): number {
  return Math.max(3, Math.round(baseSec * (0.6 + Math.random() * 0.8)));
}

function jitterRangeMs(minMs: number, maxMs: number): number {
  return Math.floor(minMs + Math.random() * Math.max(0, maxMs - minMs));
}

export interface StormStartOptions {
  config: AppConfig;
  outputDir: string;
  /** Keyword set — a session rotates within it (same advertiser target). */
  keywords: string[];
  targetDomain: string;
  targetTitle?: string;
  device: Device;
  /** Overrides config.storm.maxSessions when > 0. */
  maxSessions?: number;
  /** Panel job id ("storm-…") — groups the storm click_runs row. */
  operationId: string;
  /** SSE/panel sink — storm-click / storm-session / storm-progress events. */
  onEvent?: (event: Record<string, unknown>) => void;
  /** Campaign priority: true → storm sheds all sessions until it clears. */
  shouldYield?: () => boolean;
}

interface SessionState {
  profileId: string;
  keyword: string;
  startedAt: string;
  impressions: number;
  clicks: number;
  reports: number;
  failed: number;
  skipped: number;
  misses: number;
  solverFails: number;
  stopRequested: boolean;
  exitReason: string | null;
}

export interface StormSessionStatus {
  profileId: string;
  keyword: string;
  startedAt: string;
  impressions: number;
  clicks: number;
  reports: number;
  failed: number;
  skipped: number;
  misses: number;
  solverFails: number;
  exitReason: string | null;
}

export interface StormStatus {
  running: boolean;
  startedAt: string | null;
  targetDomain: string;
  device: Device;
  keywords: string[];
  activeSessions: number;
  totals: { clicks: number; reports: number; failed: number; skipped: number };
  clicksPerHour: number;
  sessions: StormSessionStatus[];
}

export class StormManager {
  private readonly opts: StormStartOptions;
  private adsClient!: AdsPowerClient;
  private store!: ClickStore;
  private workerCtx!: WorkerContext;
  private stormBehavior!: ClickBehaviorConfig;
  private poolIds: string[] = [];
  private targetKey = "";
  private runIdNum = 0;
  private readonly sessions = new Map<string, SessionState>();
  /** Per-profile re-pick backoff after an infra/session failure (epoch ms). */
  private readonly retryAfter = new Map<string, number>();
  private stopped = false;
  private startedAt: string | null = null;
  private readonly totals = { clicks: 0, reports: 0, failed: 0, skipped: 0 };
  private supervisor: Promise<void> | null = null;

  constructor(opts: StormStartOptions) {
    this.opts = opts;
  }

  get runId(): number {
    return this.runIdNum;
  }

  async start(): Promise<{ runId: number }> {
    if (this.supervisor) throw new Error("storm already running");
    const { config } = this.opts;
    this.adsClient = new AdsPowerClient(
      config.adspower.baseUrl,
      config.adspower.apiKey,
      config.adspower.requestIntervalMs
    );
    if (!(await this.adsClient.isUp())) {
      throw new Error(`AdsPower Local API not reachable at ${config.adspower.baseUrl}`);
    }
    this.store = new ClickStore(this.opts.outputDir);
    const allProfiles = await this.adsClient.listProfiles();
    const profileMeta = new Map<string, ProfileSummary>(allProfiles.map((p) => [p.user_id, p]));
    const prefix = this.opts.device === "mobile" ? config.scan.mobileProfilePrefix : config.scan.profilePrefix;
    this.poolIds = allProfiles
      .filter((p) => (p.name || p.user_id).startsWith(prefix))
      .map((p) => p.user_id);
    if (this.poolIds.length === 0) {
      throw new Error(`no ${this.opts.device} profiles match prefix ${prefix}`);
    }
    this.targetKey = normalizeDomain(this.opts.targetDomain);
    this.startedAt = new Date().toISOString();
    // Light behaviour for storm clicks: short landing stay, rare internal
    // links — the value is the click itself, not long browsing.
    this.stormBehavior = {
      ...config.click.behavior,
      minPreClickMs: config.storm.preClickMinMs,
      maxPreClickMs: config.storm.preClickMaxMs,
      minStayMs: config.storm.stayMinMs,
      maxStayMs: config.storm.stayMaxMs,
      internalLinkChance: Math.min(0.1, config.click.behavior.internalLinkChance),
    };
    this.runIdNum = this.store.createRun({
      startedAt: this.startedAt,
      targetDomain: this.targetKey,
      targetDevice: this.opts.device,
      totalJobs: 0, // open-ended pool — counters reconcile on finish
      notes: `storm · sessions<=${this.opts.maxSessions ?? config.storm.maxSessions} · reportEvery=${config.storm.reportEveryNClicks} · keywords=${this.opts.keywords.length}`,
      operationId: this.opts.operationId,
    });
    this.workerCtx = {
      runId: this.runIdNum,
      config,
      adsClient: this.adsClient,
      behavior: this.stormBehavior,
      outputDir: this.opts.outputDir,
      profileMeta,
      store: this.store,
    };
    this.stopped = false;
    this.supervisor = this.supervise();
    logger.info(
      {
        runId: this.runIdNum,
        domain: this.targetKey,
        device: this.opts.device,
        keywords: this.opts.keywords,
        pool: this.poolIds.length,
        maxSessions: this.opts.maxSessions ?? config.storm.maxSessions,
      },
      "storm started"
    );
    return { runId: this.runIdNum };
  }

  /** Resolves when every session is closed and the run row is finished. */
  async whenDone(): Promise<void> {
    await this.supervisor?.catch(() => {});
  }

  /**
   * Graceful stop: sessions finish their current step, close their browsers
   * (AdsPower stopBrowser via closeProfile) within ~10s; stragglers are
   * force-killed so no orphan browser survives.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const st of this.sessions.values()) st.stopRequested = true;
    await this.whenDone();
  }

  status(): StormStatus {
    return {
      running: !this.stopped && this.supervisor !== null,
      startedAt: this.startedAt,
      targetDomain: this.targetKey || this.opts.targetDomain,
      device: this.opts.device,
      keywords: this.opts.keywords,
      activeSessions: this.sessions.size,
      totals: { ...this.totals },
      clicksPerHour: this.clicksPerHour(),
      sessions: [...this.sessions.values()].map((s) => ({
        profileId: s.profileId,
        keyword: s.keyword,
        startedAt: s.startedAt,
        impressions: s.impressions,
        clicks: s.clicks,
        reports: s.reports,
        failed: s.failed,
        skipped: s.skipped,
        misses: s.misses,
        solverFails: s.solverFails,
        exitReason: s.exitReason,
      })),
    };
  }

  // ── internals ──────────────────────────────────────────────────────

  private emit(event: Record<string, unknown>): void {
    try {
      this.opts.onEvent?.(event);
    } catch (err) {
      logger.debug({ err: String(err) }, "storm onEvent threw (ignored)");
    }
  }

  private emitSession(st: SessionState, note: string): void {
    this.emit({
      type: "storm-session",
      profileId: st.profileId,
      keyword: st.keyword,
      clicks: st.clicks,
      reports: st.reports,
      impressions: st.impressions,
      exitReason: st.exitReason,
      message: `storm · profil …${st.profileId.slice(-6)} · ${note}`,
    });
  }

  private clicksPerHour(): number {
    if (!this.startedAt) return 0;
    const elapsedMs = Math.max(60_000, Date.now() - new Date(this.startedAt).getTime());
    return Math.round(this.totals.clicks / (elapsedMs / 3_600_000));
  }

  /**
   * Session budget: config.storm.maxSessions, shrunk by the RAM governor and
   * by browsers other engines already hold (shared 16-browser ceiling). A
   * running campaign yields storm to zero.
   */
  private effectiveCapacity(): number {
    if (this.opts.shouldYield?.()) return 0;
    const max = Math.max(1, this.opts.maxSessions ?? this.opts.config.storm.maxSessions);
    const gov = governedConcurrency({ base: max, floor: 2, ceiling: 16 });
    const external = Math.max(0, getInUseProfiles().size - this.sessions.size);
    const byGlobal = Math.max(0, 16 - external);
    return Math.max(0, Math.min(max, gov.concurrency, byGlobal));
  }

  /** Abort-aware wait: returns false when the session/storm should stop. */
  private async waitInterruptible(ms: number, st: SessionState): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.stopped || st.stopRequested) return false;
      await sleep(Math.min(500, deadline - Date.now()));
    }
    return true;
  }

  private randomKeyword(exclude?: string): string {
    const kws = this.opts.keywords;
    if (kws.length === 0) return "search";
    if (kws.length === 1) return kws[0]!;
    for (let i = 0; i < 10; i++) {
      const pick = kws[Math.floor(Math.random() * kws.length)]!;
      if (pick !== exclude) return pick;
    }
    return kws[0]!;
  }

  /** Hourly click cap — the SAME ClickStore counter the normal engine uses. */
  private hourCapReached(profileId: string): boolean {
    try {
      const hourAgoIso = new Date(Date.now() - 3_600_000).toISOString();
      const cap = Math.max(1, this.opts.config.click.maxClicksPerProfilePerHour);
      return this.store.countRecentSuccesses(profileId, this.targetKey, hourAgoIso) >= cap;
    } catch {
      return false; // counter unavailable — never deadlock the pool on it
    }
  }

  /** Genuine solver defeat → SHORT 10m rest (never a long park). */
  private async markSolverFailed(profileId: string, reason: string): Promise<void> {
    try {
      const { Store } = await import("../store/db.js");
      const vault = new Store(this.opts.config.output.dir);
      try {
        vault.ipTrust.markSolverFailed(profileId, reason, { maxCooldownMinutes: 10 });
      } finally {
        vault.close();
      }
    } catch {
      /* vault optional */
    }
  }

  /**
   * Pick a free profile for a new session: not already storming, not in use
   * elsewhere, not vault-cooling, not in post-failure backoff, under the
   * hourly cap.
   */
  private async pickProfile(): Promise<string | null> {
    const cfg = this.opts.config;
    const cap = Math.max(1, cfg.click.maxClicksPerProfilePerHour);
    const hourAgoIso = new Date(Date.now() - 3_600_000).toISOString();
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const inUse = getInUseProfiles();
    const cooling = new Set<string>();
    try {
      const { Store } = await import("../store/db.js");
      const vault = new Store(cfg.output.dir);
      try {
        for (const id of this.poolIds) {
          const row = vault.ipTrust.get(id) as { nextRetryAt?: string | null } | undefined;
          if (row?.nextRetryAt && row.nextRetryAt > nowIso) cooling.add(id);
        }
      } finally {
        vault.close();
      }
    } catch {
      /* vault optional */
    }
    const candidates = this.poolIds.filter(
      (id) =>
        !this.sessions.has(id) &&
        !inUse.has(id) &&
        !cooling.has(id) &&
        (this.retryAfter.get(id) ?? 0) <= nowMs
    );
    // Shuffle so the same profile is not always picked first.
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
    }
    for (const id of candidates) {
      try {
        if (this.store.countRecentSuccesses(id, this.targetKey, hourAgoIso) >= cap) continue;
      } catch {
        /* counter unavailable — allow */
      }
      return id;
    }
    return null;
  }

  /**
   * Navigate the session to the keyword SERP. Returns null on a solver
   * fiasco (wall survived the solve-through chain AND the trend-refresh
   * retry — counted against storm.maxSolverFails; genuine defeats earn the
   * 10m rest, infra errors do not). Throws on infra errors (page/CDP).
   */
  private async navigateSerp(
    session: BrowserSession,
    st: SessionState,
    navOpts: SerpNavOptions
  ): Promise<{ serpUrl: string; finalUrl: string } | null> {
    const cfg = this.opts.config;
    const serpUrl = buildSerpUrl(cfg, st.keyword);
    let nav = await gotoSerp(session, serpUrl, cfg, navOpts);
    if (nav.captcha) {
      // Same recovery as the click worker: ONE clean trend search to refresh
      // reputation, then retry the SERP once without re-entering the solver.
      const warm = await warmUp(session, cfg, { ...navOpts, trendWarmup: true });
      if (!warm.captcha) {
        nav = await gotoSerp(session, serpUrl, cfg, { ...navOpts, skipSolve: true });
      }
      if (nav.captcha) {
        st.solverFails++;
        if (!warm.infraError) {
          await this.markSolverFailed(st.profileId, "storm: SERP wall after trend refresh");
        }
        logger.warn(
          { profileId: st.profileId, solverFails: st.solverFails, infraError: warm.infraError ?? false },
          "storm: SERP wall survived solver chain"
        );
        return null;
      }
    }
    return { serpUrl, finalUrl: nav.finalUrl };
  }

  private makeStormJob(st: SessionState, seq: number): ClickJob {
    return {
      // storm- prefix makes storm clicks distinguishable in the clicks table.
      id: `storm-${st.profileId.slice(-6)}-${seq}-${Date.now().toString(36)}`,
      profileId: st.profileId,
      device: this.opts.device,
      keyword: st.keyword,
      targetDomain: this.targetKey,
      targetTitle: this.opts.targetTitle,
      fallbackFirstAd: false,
      clickFirstResult: false,
      scheduledAt: Date.now(),
      attempt: 0,
      maxAttempts: 1,
    };
  }

  private recordResult(
    st: SessionState,
    job: ClickJob,
    result: { status: ClickResult["status"]; error: string | null; evidence: ClickResult["evidence"]; reportResult: ClickResult["report"] }
  ): void {
    try {
      this.store.insertClick(this.runIdNum, {
        job,
        status: result.status,
        evidence: result.evidence,
        error: result.error,
        capturedAt: new Date().toISOString(),
        report: result.reportResult,
      });
    } catch (err) {
      logger.debug({ err: String(err) }, "storm: insertClick failed (ignored)");
    }
    if (result.status === "success") {
      st.clicks++;
      this.totals.clicks++;
    } else if (result.status === "skipped") {
      st.skipped++;
      this.totals.skipped++;
    } else {
      st.failed++;
      this.totals.failed++;
    }
    const repOk =
      result.reportResult &&
      (result.reportResult.status === "submitted" || result.reportResult.status === "filled");
    if (repOk) {
      st.reports++;
      this.totals.reports++;
    }
    try {
      this.store.updateRunProgress(this.runIdNum, {
        completed: this.totals.clicks,
        failed: this.totals.failed,
        captcha: 0,
        skipped: this.totals.skipped,
      });
    } catch {
      /* non-fatal */
    }
    const repPart =
      result.reportResult && result.reportResult.status !== "skipped"
        ? ` · rapor ${result.reportResult.status}`
        : "";
    this.emit({
      type: "storm-click",
      runId: this.runIdNum,
      jobId: job.id,
      profileId: st.profileId,
      domain: job.targetDomain,
      device: job.device,
      keyword: job.keyword,
      status: result.status,
      reportStatus: result.reportResult?.status ?? null,
      impressions: st.impressions,
      sessionClicks: st.clicks,
      clicksPerHour: this.clicksPerHour(),
      message: `storm · profil …${st.profileId.slice(-6)} · tık ${result.status}${repPart} · ${st.impressions}. gösterim · saatlik ${this.clicksPerHour()}`,
    });
  }

  /** Supervisor: keep the pool at effective capacity until stopped. */
  private async supervise(): Promise<void> {
    try {
      let ticksSinceStatus = 0;
      while (!this.stopped) {
        const capacity = this.effectiveCapacity();
        // Campaign priority: shed excess sessions gracefully (oldest first).
        if (this.sessions.size > capacity) {
          let toShed = this.sessions.size - capacity;
          for (const st of this.sessions.values()) {
            if (toShed <= 0) break;
            if (!st.stopRequested) {
              st.stopRequested = true;
              st.exitReason = st.exitReason ?? "yield: campaign took priority";
              toShed--;
            }
          }
        }
        while (!this.stopped && this.sessions.size < this.effectiveCapacity()) {
          const pid = await this.pickProfile();
          if (!pid) break;
          const st: SessionState = {
            profileId: pid,
            keyword: this.randomKeyword(),
            startedAt: new Date().toISOString(),
            impressions: 0,
            clicks: 0,
            reports: 0,
            failed: 0,
            skipped: 0,
            misses: 0,
            solverFails: 0,
            stopRequested: false,
            exitReason: null,
          };
          this.sessions.set(pid, st);
          this.emitSession(st, `oturum açılıyor · ${st.keyword}`);
          void this.runSession(st);
          // Stagger session starts — never fire two AdsPower opens back-to-back.
          await sleep(1_000 + Math.random() * 2_000);
        }
        if (++ticksSinceStatus >= 15) {
          ticksSinceStatus = 0;
          this.emit({
            type: "storm-progress",
            runId: this.runIdNum,
            activeSessions: this.sessions.size,
            capacity,
            clicks: this.totals.clicks,
            reports: this.totals.reports,
            failed: this.totals.failed,
            skipped: this.totals.skipped,
            clicksPerHour: this.clicksPerHour(),
            message: `storm · ${this.sessions.size} oturum · ${this.totals.clicks} tık · ${this.totals.reports} rapor · saatlik ${this.clicksPerHour()}`,
          });
        }
        await sleep(2_000);
      }
      // Stop: ask every session to wind down, give them 10s to close cleanly.
      for (const st of this.sessions.values()) st.stopRequested = true;
      const deadline = Date.now() + 10_000;
      while (this.sessions.size > 0 && Date.now() < deadline) {
        await sleep(250);
      }
      // Force-kill stragglers — never leave an orphan AdsPower browser behind.
      const left = [...this.sessions.keys()];
      if (left.length > 0) {
        logger.warn({ left }, "storm stop: force-closing sessions after 10s grace");
        await Promise.all(left.map((pid) => this.adsClient.stopBrowser(pid).catch(() => {})));
        for (const pid of left) releaseProfile(pid);
      }
    } finally {
      try {
        this.store.finishRun(
          this.runIdNum,
          new Date().toISOString(),
          this.totals.clicks,
          this.totals.failed,
          0,
          this.totals.skipped
        );
      } catch {
        /* non-fatal */
      }
      try {
        this.store.close();
      } catch {
        /* non-fatal */
      }
    }
  }

  /**
   * One persistent session: open profile → SERP → [back-loop clicks →
   * controlled refresh] until a stop condition (abort, hourly cap, misses,
   * solver fiascos, infra error, campaign yield).
   */
  private async runSession(st: SessionState): Promise<void> {
    const cfg = this.opts.config;
    const storm = cfg.storm;
    let session: BrowserSession | null = null;
    try {
      session = await openProfile(this.workerCtx, st.profileId, this.opts.device);
      if (!session) {
        // Open/CDP infra failure — no cooldown; a short re-pick backoff only
        // so the supervisor does not spin on the same broken profile.
        st.exitReason = "profile open failed (infra — no cooldown)";
        this.retryAfter.set(st.profileId, Date.now() + jitterSec(120) * 1000);
        return;
      }
      const sess = session;
      const page = sess.page;
      const evidenceDir = ensureEvidenceDir(this.opts.outputDir, this.runIdNum);
      const meta = this.workerCtx.profileMeta.get(st.profileId);
      const profileKey = meta?.name || st.profileId;
      const personaBehavior = behaviorForProfile(this.stormBehavior, profileKey);
      const captchaProxy = meta ? captchaProxyFromProfile(meta) : undefined;
      const navOpts: SerpNavOptions = {
        captchaProxy: captchaProxy
          ? { proxy: captchaProxy.proxy, proxytype: captchaProxy.proxytype }
          : undefined,
        profileId: st.profileId,
      };

      let haveSerp = false;
      let serpUrl = "";
      let serpFinalUrl: string | null = null;
      let nextRefreshAt = 0;
      let refreshes = 0;
      let clickSeq = 0;

      while (!this.stopped && !st.stopRequested) {
        // 1. Ensure a live SERP (initial load / controlled refresh / miss retry).
        if (!haveSerp) {
          const nav = await this.navigateSerp(sess, st, navOpts);
          if (!nav) {
            if (st.solverFails >= storm.maxSolverFails) {
              st.exitReason = `${storm.maxSolverFails} solver fiascos — profile rests 10m`;
              break;
            }
            if (!(await this.waitInterruptible(jitterSec(storm.missRetrySec) * 1000, st))) break;
            continue;
          }
          serpUrl = nav.serpUrl;
          serpFinalUrl = nav.finalUrl;
          haveSerp = true;
          nextRefreshAt = Date.now() + jitterSec(storm.refreshIntervalSec) * 1000;
        }

        // 2. Hourly click cap (shared with the normal engine via ClickStore).
        if (this.hourCapReached(st.profileId)) {
          st.exitReason = "hourly click cap reached — profile rests";
          break;
        }

        // 3. Parse + locate the target ad (bounded — wedged renderer guard).
        const ads = await Promise.race([
          parseAds(page),
          sleep(20_000).then(() => [] as Awaited<ReturnType<typeof parseAds>>),
        ]);
        let target = matchAd(ads, this.opts.targetDomain, this.opts.targetTitle);

        if (!target) {
          st.misses++;
          if (st.misses >= storm.maxMisses) {
            st.exitReason = `ad missing ${st.misses}x in a row — profile released`;
            break;
          }
          this.emitSession(st, `reklam yok (${st.misses}/${storm.maxMisses}) · ${st.keyword}`);
          if (!(await this.waitInterruptible(jitterSec(storm.missRetrySec) * 1000, st))) break;
          haveSerp = false; // re-check on a fresh auction
          continue;
        }

        st.misses = 0;
        st.impressions++;

        // 4. Back-loop: up to clicksPerImpression clicks on THIS impression —
        //    clickAndReportAd restores the SERP via goBack (bfcache), so the
        //    same impression (same gclid) survives between iterations.
        let clicksOnImpression = 0;
        while (
          clicksOnImpression < storm.clicksPerImpression &&
          !this.stopped &&
          !st.stopRequested &&
          target?.adHref
        ) {
          if (this.hourCapReached(st.profileId)) break;
          clickSeq++;
          // Report cadence: 1 in N clicks reports (~33% at 3). The 1:1 gate
          // only applies on report clicks — a failed report skips THAT click.
          const reportDue =
            cfg.report.autoSerpSubmit &&
            storm.reportEveryNClicks > 0 &&
            (clickSeq - 1) % storm.reportEveryNClicks === 0;
          const job = this.makeStormJob(st, clickSeq);
          const flow: AdFlowContext = {
            ctx: this.workerCtx,
            session: sess,
            page,
            serpUrl,
            serpFinalUrl,
            screenshotSerp: null,
            preClickMs: 0,
            evidenceDir,
            device: this.opts.device,
            keyword: st.keyword,
            personaBehavior,
            profileKey,
            reportEnabled: reportDue,
          };
          if (!(await this.waitInterruptible(jitterRangeMs(storm.preClickMinMs, storm.preClickMaxMs), st))) break;
          const result = await clickAndReportAd(flow, target, job);
          this.recordResult(st, job, result);
          if (result.status !== "success") break; // failed / 1:1 skip → fresh auction, don't hammer
          clicksOnImpression++;
          if (clicksOnImpression < storm.clicksPerImpression && !this.stopped && !st.stopRequested) {
            if (!(await this.waitInterruptible(3_000 + Math.random() * 5_000, st))) break;
            // Cards may have re-rendered after goBack — re-locate before re-clicking.
            const ads2 = await Promise.race([
              parseAds(page),
              sleep(15_000).then(() => [] as Awaited<ReturnType<typeof parseAds>>),
            ]);
            target = matchAd(ads2, this.opts.targetDomain, this.opts.targetTitle);
          }
        }

        if (this.stopped || st.stopRequested) break;
        if (this.hourCapReached(st.profileId)) {
          st.exitReason = "hourly click cap reached — profile rests";
          break;
        }

        // 5. Controlled refresh: wait out the remainder of the interval
        //    (abort-aware), rotate the keyword when due, then re-auction.
        const waitMs = Math.max(0, nextRefreshAt - Date.now());
        if (!(await this.waitInterruptible(waitMs, st))) break;
        refreshes++;
        if (refreshes % storm.keywordRotateEvery === 0) {
          const next = this.randomKeyword(st.keyword);
          if (next !== st.keyword) {
            logger.info({ profileId: st.profileId, from: st.keyword, to: next }, "storm: keyword rotation");
            st.keyword = next;
          }
        }
        haveSerp = false;
      }
    } catch (err) {
      // Proxy/CDP/infra error — NO cooldown; the profile may retry next round.
      st.exitReason = `infra: ${String(err).slice(0, 120)}`;
      this.retryAfter.set(st.profileId, Date.now() + jitterSec(120) * 1000);
      logger.warn({ profileId: st.profileId, err: String(err) }, "storm session died on infra error — no cooldown");
    } finally {
      if (session) {
        await closeProfile(this.workerCtx, session, st.profileId);
      }
      this.sessions.delete(st.profileId);
      this.emitSession(st, `oturum kapandı · ${st.exitReason ?? "tamam"} · ${st.clicks} tık · ${st.reports} rapor`);
    }
  }
}
