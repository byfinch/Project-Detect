import { AdsPowerClient } from "../adspower/client.js";
import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";
import { sleep } from "../util/time.js";
import type { Device } from "../types.js";
import type {
  ClickEngineConfig,
  ClickJob,
  ClickResult,
  ClickRunOptions,
  ClickRunSummary,
  ClickTarget,
  TargetDevice,
} from "./types.js";
import { deviceOfProfile, selectPools } from "./pool.js";
import { runClickJob, type WorkerContext } from "./worker.js";
import { releaseProfile } from "../browser/profileRegistry.js";
import { ClickStore } from "./store.js";

function randomBetween(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function makeJobId(profileId: string, index: number): string {
  return `${profileId.slice(0, 24)}-${index}-${Date.now().toString(36)}`;
}

function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

/**
 * Build scheduled jobs for one target.
 *
 * Strategy (budget drain + valid-looking traffic):
 *  1) Shortlist profiles that SAW the ad in scan (impressions) → max 1 job each, first.
 *  2) Remaining budget → OTHER profiles in the pool, also max 1 per profile per round.
 *  3) Never stack 10 clicks on the same profile for one domain.
 *  4) If budget > unique profiles, second round only after full rotation (still 1/profile/round).
 */
export function buildJobs(opts: ClickRunOptions): ClickJob[] {
  const {
    target,
    profileIds,
    deviceOfProfile: deviceMap,
    engineConfig,
    baseTime = Date.now(),
    fallbackFirstAd = false,
    clickFirstResult = false,
  } = opts;
  // Burst (panel/ops): pack jobs into a short window so work starts immediately.
  const durationMs = engineConfig.burst
    ? Math.min(8 * 60_000, Math.max(60_000, (engineConfig.durationMinutes || 10) * 60_000))
    : engineConfig.durationMinutes * 60_000;
  const staggerMs = engineConfig.burst
    ? Math.min(20_000, Math.max(3_000, engineConfig.staggerWindowSeconds * 1000 || 8_000))
    : engineConfig.staggerWindowSeconds * 1000;

  const jobs: ClickJob[] = [];

  // Group pool by device.
  const byDevice = new Map<Device, string[]>();
  for (const id of profileIds) {
    const dev = deviceMap.get(id);
    if (!dev) continue;
    const list = byDevice.get(dev) ?? [];
    list.push(id);
    byDevice.set(dev, list);
  }

  // Impression shortlist: unique profiles that saw this domain, per device.
  const seersByDevice = new Map<Device, string[]>();
  for (const imp of target.impressions ?? []) {
    if (!profileIds.includes(imp.profileId)) continue;
    const list = seersByDevice.get(imp.device) ?? [];
    if (!list.includes(imp.profileId)) list.push(imp.profileId);
    seersByDevice.set(imp.device, list);
  }

  // Prefer keyword that profile actually saw when available.
  const keywordFor = (profileId: string, device: Device, fallbackIndex: number): string => {
    const hit = (target.impressions ?? []).find(
      (i) => i.profileId === profileId && i.device === device && i.keyword
    );
    if (hit?.keyword) return hit.keyword;
    return target.keywords[fallbackIndex % Math.max(1, target.keywords.length)] ?? target.keywords[0] ?? "search";
  };

  for (const [device, poolIds] of byDevice) {
    const recommended =
      device === "mobile" ? target.recommendedClicks?.mobile : target.recommendedClicks?.desktop;
    const totalClicks =
      recommended != null && recommended >= 0
        ? recommended
        : poolIds.length * engineConfig.clicksPerProfile;
    if (totalClicks <= 0 || poolIds.length === 0) continue;

    const seers = shuffleInPlace([...(seersByDevice.get(device) ?? [])].filter((id) => poolIds.includes(id)));
    const seerSet = new Set(seers);
    const others = shuffleInPlace(poolIds.filter((id) => !seerSet.has(id)));

    // Order: all seers first (1 each), then others, then rotate if budget remains.
    const rotation: string[] = [];
    for (const id of seers) rotation.push(id);
    for (const id of others) rotation.push(id);
    if (rotation.length === 0) continue;

    let made = 0;
    let round = 0;
    const maxRounds = Math.max(1, Math.ceil(totalClicks / rotation.length));
    while (made < totalClicks && round < maxRounds) {
      for (const profileId of rotation) {
        if (made >= totalClicks) break;
        // First round: seers get priority slots; already ordered.
        // Every round: at most 1 job per profile in that round (no same-profile spam).
        const baseOffset = (made / Math.max(1, totalClicks)) * durationMs;
        const staggerOffset = Math.random() * Math.min(staggerMs, durationMs / Math.max(1, totalClicks));
        jobs.push({
          id: makeJobId(profileId, jobs.length),
          profileId,
          device,
          keyword: keywordFor(profileId, device, made),
          targetDomain: target.domain,
          targetTitle: target.titleHint,
          fallbackFirstAd,
          clickFirstResult: target.clickFirstResult ?? false,
          scheduledAt: Math.floor(baseTime + baseOffset + staggerOffset),
          attempt: 0,
          maxAttempts: 2,
        });
        made++;
      }
      round++;
      // Next round: reshuffle non-seers only; seers already used once — put them at end if still needed.
      if (made < totalClicks) {
        shuffleInPlace(others);
        // Rebuild rotation for extra rounds: others first, then seers (avoid hammering seers first).
        rotation.length = 0;
        for (const id of others) rotation.push(id);
        for (const id of seers) rotation.push(id);
      }
    }

    logger.info(
      {
        domain: target.domain,
        device,
        totalClicks,
        seers: seers.length,
        others: others.length,
        jobs: made,
      },
      "click jobs built (seer shortlist + rotate others)"
    );
  }

  return jobs.sort((a, b) => a.scheduledAt - b.scheduledAt);
}

/** Create the engine config from AppConfig + optional overrides. */
export function buildEngineConfig(
  config: AppConfig,
  mode?: "conservative" | "adaptive" | "aggressive"
): ClickEngineConfig {
  const base = config.click;
  const selectedMode = mode ?? base.mode;

  const presets: Record<ClickEngineConfig["mode"], Partial<Omit<ClickEngineConfig, "mode" | "behavior">>> = {
    conservative: {
      concurrency: Math.min(5, base.concurrency),
      clicksPerProfile: Math.min(10, base.clicksPerProfile),
      durationMinutes: Math.max(60, base.durationMinutes),
      staggerWindowSeconds: Math.max(300, base.staggerWindowSeconds),
      minDelayMs: Math.max(3000, base.minDelayMs),
      maxDelayMs: Math.max(8000, base.maxDelayMs),
      maxClicksPerProfilePerHour: Math.min(5, base.maxClicksPerProfilePerHour),
      sameAdCooldownMinutes: Math.max(30, base.sameAdCooldownMinutes),
    },
    adaptive: {
      // Magnetar-class VPS (8C/12GB): default concurrency 10 is the sweet spot for desktop click fleets.
      concurrency: Math.min(10, Math.max(1, base.concurrency)),
      clicksPerProfile: base.clicksPerProfile,
      durationMinutes: base.durationMinutes,
      staggerWindowSeconds: base.staggerWindowSeconds,
      minDelayMs: base.minDelayMs,
      maxDelayMs: base.maxDelayMs,
      maxClicksPerProfilePerHour: base.maxClicksPerProfilePerHour,
      sameAdCooldownMinutes: base.sameAdCooldownMinutes,
    },
    aggressive: {
      // Cap aggressive so RAM does not thrash AdsPower (still ≥10 when base is 10).
      concurrency: Math.min(12, Math.max(10, base.concurrency)),
      clicksPerProfile: Math.min(60, Math.max(30, base.clicksPerProfile + 20)),
      durationMinutes: Math.max(30, Math.min(90, base.durationMinutes)),
      staggerWindowSeconds: Math.max(120, Math.min(300, base.staggerWindowSeconds)),
      minDelayMs: Math.max(1500, Math.min(3000, base.minDelayMs)),
      maxDelayMs: Math.max(4000, Math.min(8000, base.maxDelayMs)),
      maxClicksPerProfilePerHour: Math.min(20, Math.max(10, base.maxClicksPerProfilePerHour + 5)),
      sameAdCooldownMinutes: Math.max(10, Math.min(20, base.sameAdCooldownMinutes)),
    },
  };

  const preset = presets[selectedMode];

  return {
    mode: selectedMode,
    concurrency: preset.concurrency ?? base.concurrency,
    durationMinutes: preset.durationMinutes ?? base.durationMinutes,
    clicksPerProfile: preset.clicksPerProfile ?? base.clicksPerProfile,
    staggerWindowSeconds: preset.staggerWindowSeconds ?? base.staggerWindowSeconds,
    minDelayMs: preset.minDelayMs ?? base.minDelayMs,
    maxDelayMs: preset.maxDelayMs ?? base.maxDelayMs,
    maxClicksPerProfilePerHour: preset.maxClicksPerProfilePerHour ?? base.maxClicksPerProfilePerHour,
    sameAdCooldownMinutes: preset.sameAdCooldownMinutes ?? base.sameAdCooldownMinutes,
    behavior: base.behavior,
    burst: false,
  };
}

export interface RunClickEngineOptions {
  config: AppConfig;
  target?: ClickTarget;
  targets?: ClickTarget[];
  engineConfig: ClickEngineConfig;
  outputDir: string;
  limit?: number;
  fallbackFirstAd?: boolean;
  clickFirstResult?: boolean;
  /**
   * Groups these runs into one operation row in the panel (e.g. a focus
   * campaign = several wave runs). Omit → run stands alone.
   */
  operationId?: string;
  /**
   * Cooperative cancel: when this returns true the engine stops dequeuing new
   * jobs immediately, lets in-flight browsers finish their current job, then
   * returns. Panel "stop" is useless without this — a wave otherwise runs to
   * completion (up to 15 min) before anyone notices the flag.
   */
  isCancelled?: () => boolean;
}

interface DeviceEngineInput {
  device: Device;
  targets: ClickTarget[];
  profileIds: string[];
  concurrency: number;
}

/** Run click jobs for a single device pool with round-robin target rotation. */
async function runDeviceClickEngine(
  input: DeviceEngineInput,
  ctx: WorkerContext,
  engineConfig: ClickEngineConfig,
  limit?: number,
  onProgress?: (event: Record<string, unknown>) => void,
  isCancelled?: () => boolean,
  fallbackFirstAd?: boolean
): Promise<{ completed: number; failed: number; captchaBlocked: number; skipped: number; results: ClickResult[] }> {
  const { device, targets, profileIds, concurrency } = input;
  const cancelled = () => isCancelled?.() === true;

  // Build jobs for each target, then interleave them round-robin.
  const perTargetJobs: ClickJob[][] = [];
  for (const target of targets) {
    const deviceMap = new Map(profileIds.map((id) => [id, device]));
    const jobs = buildJobs({
      target: { ...target, targetDevice: device },
      profileIds,
      deviceOfProfile: deviceMap,
      engineConfig,
      fallbackFirstAd: fallbackFirstAd ?? false,
      clickFirstResult: target.clickFirstResult ?? false,
    });
    perTargetJobs.push(jobs);
  }

  // Round-robin interleave into a single pending queue.
  const pending: ClickJob[] = [];
  let idx = 0;
  let hasMore = true;
  while (hasMore) {
    hasMore = false;
    for (let t = 0; t < perTargetJobs.length; t++) {
      const job = perTargetJobs[t]![idx];
      if (job) {
        pending.push(job);
        hasMore = true;
      }
    }
    idx++;
  }

  if (limit && limit > 0 && limit < pending.length) {
    pending.length = limit;
  }

  const deviceQueued = pending.length;
  /** Locked total for this whole run — never grow with requeues / never shrink mid-run. */
  const lockedTotal = Math.max(1, ctx.fixedTotalJobs ?? deviceQueued);

  onProgress?.({
    type: "click-queue-ready",
    runId: ctx.runId,
    device,
    queued: deviceQueued,
    concurrency,
    profiles: profileIds.length,
    total: lockedTotal,
    message: `kuyruk hazır · ${device} · ${deviceQueued} iş (total kilit=${lockedTotal}) · conc=${concurrency}`,
  });

  const runningProfiles = new Set<string>();
  const results: ClickResult[] = [];
  let completed = 0;
  let failed = 0;
  let captchaBlocked = 0;
  let skipped = 0;
  let lastHeartbeat = 0;
  let lastHeartbeatKey = "";

  /**
   * Device circuit breaker: probe runs showed Google often serves ZERO ads to
   * mobile IPs at night (adsFound=0 while desktop gets the ad). Burning a full
   * profile open+warm-up per job on an ad-free device is pure waste — after 2
   * consecutive "target ad not found" skips, remaining jobs of this device leg
   * are fast-skipped without opening a browser. Fresh per run; the campaign's
   * next presence scan re-evaluates anyway.
   */
  let consecutiveNotFoundSkips = 0;
  let deviceBlind = false;
  /**
   * Blind-mode probing: instead of writing the device off for the whole wave,
   * every 5th job still runs for real (open + warm-up + SERP check). Ad serving
   * rotates — 2 empty results prove nothing — so probes let a recovering device
   * re-enter without burning more than ~20% of the queue on empty checks.
   */
  let blindSkips = 0;

  /**
   * Tail watchdog: when the queue is drained and only stragglers remain, the
   * freed slots have no work left — one wedged tail job holds the whole wave
   * (and the campaign's next wave) hostage. Healthy jobs run ~30-90s, so any
   * job older than 4m with an empty queue is force-closed. forceClosed guards
   * against double counting when the killed job's own promise rejects later.
   */
  const runningSince = new Map<string, number>();
  const forceClosed = new Set<string>();
  const TAIL_JOB_MAX_MS = 4 * 60 * 1000; // healthy jobs run ~30-90s; >4m with an empty queue = wedge

  function globalDone(): {
    completed: number;
    failed: number;
    captcha: number;
    skipped: number;
    done: number;
  } {
    const s = ctx.sharedStats;
    if (!s) {
      const done = completed + failed + captchaBlocked + skipped;
      return { completed, failed, captcha: captchaBlocked, skipped, done };
    }
    const done = s.completed + s.failed + s.captcha + s.skipped;
    return {
      completed: s.completed,
      failed: s.failed,
      captcha: s.captcha,
      skipped: s.skipped,
      done,
    };
  }

  function bumpShared(kind: "completed" | "failed" | "captcha" | "skipped"): void {
    if (!ctx.sharedStats) return;
    ctx.sharedStats[kind] += 1;
  }

  function emitHeartbeat(force = false): void {
    const now = Date.now();
    const g = globalDone();
    const key = `${g.done}/${runningProfiles.size}/${pending.length}`;
    // Spam guard: meaningful changes emit instantly (also when forced by job
    // start/finish); an unchanged state gets at most one keepalive per 30s
    // instead of flooding the terminal every 2.5s per device leg.
    if (!force && key === lastHeartbeatKey && now - lastHeartbeat < 30_000) return;
    lastHeartbeat = now;
    lastHeartbeatKey = key;
    const remaining = Math.max(0, lockedTotal - g.done);
    const queueLeft = pending.length + runningProfiles.size; // kalan iş: kuyruk + aktif
    onProgress?.({
      type: "click-progress",
      runId: ctx.runId,
      device,
      completed: g.completed,
      failed: g.failed,
      captcha: g.captcha,
      skipped: g.skipped,
      running: runningProfiles.size,
      pending: pending.length,
      total: lockedTotal,
      remaining,
      message: `${device} · aktif ${runningProfiles.size} · bitti ${Math.min(g.done, lockedTotal)}/${lockedTotal} · kalan ${queueLeft}`,
    });
  }

  async function executeJob(job: ClickJob): Promise<void> {
    runningProfiles.add(job.profileId);
    // Reset stale force-close flag: the same profile may run a later job after
    // a tail watchdog kill — without this its result would be silently dropped.
    forceClosed.delete(job.profileId);
    runningSince.set(job.profileId, Date.now());
    {
      const g = globalDone();
      onProgress?.({
        type: "click-progress",
        runId: ctx.runId,
        device,
        phase: "job-start",
        profileId: job.profileId,
        domain: job.targetDomain,
        completed: g.completed,
        failed: g.failed,
        captcha: g.captcha,
        skipped: g.skipped,
        running: runningProfiles.size,
        pending: pending.length,
        total: lockedTotal,
        message: `başlıyor · ${job.targetDomain} · ${device} · profil …${job.profileId.slice(-6)}`,
      });
    }
    try {
      // Hard watchdog: a job stuck pre-browser (CDP attach / API hang) would
      // otherwise block the scheduler AND the cancel drain forever (seen live:
      // 4 jobs frozen 30+ min with no browser open). 8 minutes is generous —
      // warm-up + report + click + CF solve normally fit in ~4-5.
      const JOB_HARD_TIMEOUT_MS = 8 * 60 * 1000;
      const jobPromise = runClickJob(ctx, job);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutP = new Promise<ClickResult>((res) => {
        timer = setTimeout(async () => {
          logger.error({ jobId: job.id, profileId: job.profileId, domain: job.targetDomain }, "click job hard timeout (8m) — force-closing stuck browser");
          // Kill the wedged browser via the AdsPower HTTP API (same escape hatch
          // as the cancel-drain path below). This rejects the hung CDP promises
          // inside runClickJob, so the job dies instead of leaking an open,
          // idle browser window forever.
          await ctx.adsClient.stopBrowser(job.profileId).catch(() => {});
          releaseProfile(job.profileId);
          res({
            job,
            status: "failed",
            error: "hard timeout 8m — job reaped (stuck pre/post browser)",
            capturedAt: new Date().toISOString(),
            evidence: {
              serpUrl: null, adTitle: null, adDescription: null, displayUrl: null,
              clickUrl: null, landingUrl: null, finalUrl: null, finalDomain: null,
              redirectHops: [], screenshotSerp: null, screenshotLanding: null,
              screenshotFinal: null, preClickMs: 0, stayMs: 0, internalClicks: 0,
            },
            report: { status: "error", message: "hard timeout" },
          });
        }, JOB_HARD_TIMEOUT_MS);
      });
      let result: ClickResult;
      try {
        result = await Promise.race([jobPromise, timeoutP]);
      } finally {
        // Cancel the watchdog whichever side won — otherwise a cleared timer
        // fires 8m later and kills a healthy new job's browser on this profile.
        clearTimeout(timer);
        // If the timeout won, the job's own promise may reject later (browser
        // killed under it) — swallow that zombie rejection instead of crashing.
        jobPromise.catch(() => {});
      }
      if (forceClosed.has(job.profileId)) return; // tail watchdog already counted this job
      results.push(result);
      ctx.store.insertClick(ctx.runId, result);

      if (result.status === "success") {
        completed++;
        bumpShared("completed");
      } else if (result.status === "captcha") {
        captchaBlocked++;
        bumpShared("captcha");
      } else if (result.status === "skipped") {
        skipped++;
        bumpShared("skipped");
      } else {
        failed++;
        bumpShared("failed");
      }

      // Circuit breaker tally (see declaration above).
      if (result.status === "skipped" && /not found|no href/i.test(result.error || "")) {
        consecutiveNotFoundSkips++;
        if (!deviceBlind && consecutiveNotFoundSkips >= 2) {
          deviceBlind = true;
          logger.warn({ device, pending: pending.length }, "device blind: SERP ad-free — probing every 5th job");
          onProgress?.({
            type: "click-progress",
            runId: ctx.runId,
            device,
            phase: "device-blind",
            message: `${device} · SERP reklamsız görünüyor · her 5. iş gerçek kontrol, kalanı hızlı geçiliyor`,
          });
        }
      } else {
        consecutiveNotFoundSkips = 0;
        // Any non-"not found" outcome from a blind-mode probe means ads are
        // being served again (success, or ads present but harvest failed) —
        // leave blind mode and resume normal processing.
        if (deviceBlind) {
          deviceBlind = false;
          logger.info({ device, status: result.status }, "device recovered — leaving blind mode");
          onProgress?.({
            type: "click-progress",
            runId: ctx.runId,
            device,
            phase: "device-recovered",
            message: `${device} · reklam tekrar görünüyor · normal moda dönüldü`,
          });
        }
      }

      // Retry on OTHER profile only — does NOT increase locked total (swap remaining work).
      const retriable =
        (result.status === "skipped" && /not found/i.test(result.error || "")) ||
        result.status === "captcha" ||
        result.status === "profile_error";
      if (retriable && job.attempt + 1 < (job.maxAttempts || 2)) {
        const g = globalDone();
        // Budget check: pending + in-flight (minus THIS job, still counted in both)
        const inFlight = pending.length + runningProfiles.size - 1;
        if (g.done + inFlight < lockedTotal) {
          const alt = profileIds.find((id) => id !== job.profileId && !runningProfiles.has(id));
          if (alt) {
            const retry: ClickJob = {
              ...job,
              id: makeJobId(alt, pending.length + results.length),
              profileId: alt,
              attempt: job.attempt + 1,
              scheduledAt: Date.now() + Math.floor(randomBetween(2_000, 10_000)),
            };
            pending.push(retry);
            logger.info(
              {
                from: job.profileId,
                to: alt,
                domain: job.targetDomain,
                attempt: retry.attempt,
                reason: result.status,
              },
              "click job requeued on alternate profile (total unchanged)"
            );
          }
        }
      }

      const g = globalDone();
      const remaining = Math.max(0, lockedTotal - g.done);
      try {
        ctx.store.updateRunProgress(ctx.runId, {
          completed: g.completed,
          failed: g.failed,
          captcha: g.captcha,
          skipped: g.skipped,
          totalJobs: lockedTotal,
        });
      } catch {
        /* non-fatal */
      }

      logger.info(
        {
          jobId: job.id,
          profileId: job.profileId,
          device: job.device,
          target: job.targetDomain,
          status: result.status,
          completed: g.completed,
          failed: g.failed,
          remaining,
          total: lockedTotal,
        },
        "click job finished"
      );
      const reportPart = result.report ? ` · rapor ${result.report.status}` : "";
      onProgress?.({
        type: "click-done",
        jobId: job.id,
        runId: ctx.runId,
        domain: job.targetDomain,
        device: job.device,
        profileId: job.profileId,
        status: result.status,
        reportStatus: result.report?.status ?? null,
        reportMessage: result.report?.message ?? null,
        stayMs: result.evidence.stayMs,
        completed: g.completed,
        failed: g.failed,
        captcha: g.captcha,
        skipped: g.skipped,
        total: lockedTotal,
        remaining,
        message: `tık ${result.status}${reportPart} · ${job.targetDomain} · ${job.device} (${Math.min(g.done, lockedTotal)}/${lockedTotal})`,
      });
      emitHeartbeat(true);
    } catch (err) {
      if (forceClosed.has(job.profileId)) return; // tail watchdog already counted this job
      logger.error({ jobId: job.id, err: String(err) }, "unexpected click job error");
      failed++;
      bumpShared("failed");
      // Record the failure in the store too — otherwise counters and the
      // clicks table disagree (job counted as failed but never persisted).
      const errResult: ClickResult = {
        job,
        status: "failed",
        error: String(err),
        capturedAt: new Date().toISOString(),
        evidence: {
          serpUrl: null, adTitle: null, adDescription: null, displayUrl: null,
          clickUrl: null, landingUrl: null, finalUrl: null, finalDomain: null,
          redirectHops: [], screenshotSerp: null, screenshotLanding: null,
          screenshotFinal: null, preClickMs: 0, stayMs: 0, internalClicks: 0,
        },
        report: { status: "error", message: "unexpected error" },
      };
      results.push(errResult);
      try {
        ctx.store.insertClick(ctx.runId, errResult);
      } catch {
        /* non-fatal */
      }
      const g = globalDone();
      onProgress?.({
        type: "click-done",
        jobId: job.id,
        runId: ctx.runId,
        domain: job.targetDomain,
        device: job.device,
        status: "failed",
        reportStatus: null,
        reportMessage: null,
        error: String(err),
        completed: g.completed,
        failed: g.failed,
        captcha: g.captcha,
        skipped: g.skipped,
        total: lockedTotal,
        message: `tık failed · ${job.targetDomain} · ${job.device} (${g.done}/${lockedTotal})`,
      });
    } finally {
      runningProfiles.delete(job.profileId);
      runningSince.delete(job.profileId);
      emitHeartbeat();
    }
  }

  function pickNextJob(): ClickJob | null {
    const now = Date.now();
    // Burst: ignore far future schedule — only light stagger (max 25s wait).
    const maxWait = engineConfig.burst ? 25_000 : Number.POSITIVE_INFINITY;
    for (let i = 0; i < pending.length; i++) {
      const job = pending[i]!;
      if (runningProfiles.has(job.profileId)) continue;
      if (job.scheduledAt > now + 500) {
        if (job.scheduledAt - now > maxWait) {
          // Pull forward so panel work does not sit idle for an hour.
          job.scheduledAt = now + Math.floor(Math.random() * 3000);
        } else {
          continue;
        }
      }
      if (job.scheduledAt > now + 500) continue;
      pending.splice(i, 1);
      return job;
    }
    return null;
  }

  emitHeartbeat(true);
  let cancelNotified = false;
  let drainStartedAt = 0;
  const DRAIN_MAX_MS = 90_000; // cancel must feel responsive — force-close after 90s
  while (pending.length > 0 || runningProfiles.size > 0) {
    if (cancelled()) {
      if (!cancelNotified) {
        cancelNotified = true;
        drainStartedAt = Date.now();
        const dropped = pending.length;
        pending.length = 0; // no new jobs — in-flight browsers finish their current job
        logger.warn({ device, dropped, running: runningProfiles.size }, "click engine cancelled — draining in-flight jobs");
        onProgress?.({
          type: "click-progress",
          runId: ctx.runId,
          device,
          phase: "cancelled",
          running: runningProfiles.size,
          pending: 0,
          total: lockedTotal,
          message: `${device} · İPTAL · ${dropped} bekleyen iş düştü · ${runningProfiles.size} aktif tarayıcı bitince duruyor`,
        });
      }
      if (runningProfiles.size === 0) break;
      // Force-close slow drains — a CF solve or hung job can hold the wave for
      // many minutes; the user asked to stop NOW.
      if (Date.now() - drainStartedAt > DRAIN_MAX_MS) {
        const stuck = [...runningProfiles];
        logger.warn({ device, stuck }, "drain timeout — force-closing in-flight browsers");
        for (const pid of stuck) {
          // Mark force-closed so the job's own late rejection is not double-counted.
          forceClosed.add(pid);
          await ctx.adsClient.stopBrowser(pid).catch(() => {});
          releaseProfile(pid);
          runningProfiles.delete(pid);
          failed++;
          bumpShared("failed");
        }
        onProgress?.({
          type: "click-progress",
          runId: ctx.runId,
          device,
          phase: "cancelled",
          running: 0,
          pending: 0,
          total: lockedTotal,
          message: `${device} · İPTAL · ${stuck.length} tarayıcı zorla kapatıldı`,
        });
        break;
      }
      await sleep(500);
      continue;
    }
    while (runningProfiles.size < concurrency) {
      const job = pickNextJob();
      if (!job) break;
      if (deviceBlind) {
        blindSkips++;
        // Every 5th job runs for real as a probe (open + warm-up + SERP check).
        // The rest fast-skip. Probes are how a recovering device re-enters.
        if (blindSkips % 5 !== 0) {
        // Fast-skip: Google isn't serving ads to this device right now —
        // record the skip without burning a profile open+warm-up cycle.
        skipped++;
        bumpShared("skipped");
        const blindResult: ClickResult = {
          job,
          status: "skipped",
          error: "device blind — SERP reklamsız (hızlı geçiş)",
          capturedAt: new Date().toISOString(),
          evidence: {
            serpUrl: null, adTitle: null, adDescription: null, displayUrl: null,
            clickUrl: null, landingUrl: null, finalUrl: null, finalDomain: null,
            redirectHops: [], screenshotSerp: null, screenshotLanding: null,
            screenshotFinal: null, preClickMs: 0, stayMs: 0, internalClicks: 0,
          },
          report: { status: "skipped", message: "device blind" },
        };
        results.push(blindResult);
        try {
          ctx.store.insertClick(ctx.runId, blindResult);
        } catch {
          /* store hiccup must not take down the whole device leg */
        }
        const g = globalDone();
        onProgress?.({
          type: "click-done",
          jobId: job.id,
          runId: ctx.runId,
          domain: job.targetDomain,
          device: job.device,
          profileId: job.profileId,
          status: "skipped",
          reportStatus: "skipped",
          reportMessage: "device blind",
          stayMs: 0,
          completed: g.completed,
          failed: g.failed,
          captcha: g.captcha,
          skipped: g.skipped,
          total: lockedTotal,
          remaining: Math.max(0, lockedTotal - g.done),
          message: `tık skipped · reklamsız cihaz (hızlı) · ${job.targetDomain} · ${job.device} (${Math.min(g.done, lockedTotal)}/${lockedTotal})`,
        });
        continue;
        }
        // probe job: fall through to executeJob below
        logger.info({ device, jobId: job.id, blindSkips }, "blind-mode probe — real SERP check");
      }
      void executeJob(job);
    }
    // Tail watchdog: queue drained, only stragglers left — healthy jobs run
    // ~30-90s, so anything older than 4m with an empty queue is a wedge
    // holding the next wave hostage. Force-close it and let the run finish.
    if (pending.length === 0) {
      for (const pid of [...runningProfiles]) {
        if (forceClosed.has(pid)) continue;
        const since = runningSince.get(pid) ?? Date.now();
        if (Date.now() - since > TAIL_JOB_MAX_MS) {
          forceClosed.add(pid);
          logger.warn({ device, profileId: pid, ageMs: Date.now() - since }, "tail straggler force-closed (queue empty, job > 4m)");
          await ctx.adsClient.stopBrowser(pid).catch(() => {});
          releaseProfile(pid);
          runningProfiles.delete(pid);
          runningSince.delete(pid);
          failed++;
          bumpShared("failed");
          onProgress?.({
            type: "click-progress",
            runId: ctx.runId,
            device,
            phase: "tail-kill",
            message: `${device} · kuyruk boş · 4 dk'yı aşan son iş kapatıldı · dalga tamamlanıyor`,
          });
        }
      }
    }
    emitHeartbeat();
    if (pending.length > 0 || runningProfiles.size > 0) {
      await sleep(500);
    }
  }

  return { completed, failed, captchaBlocked, skipped, results };
}

export async function runClickEngine(
  opts: RunClickEngineOptions,
  onProgress?: (event: Record<string, unknown>) => void
): Promise<ClickRunSummary> {
  const { config, engineConfig, outputDir, limit, fallbackFirstAd, clickFirstResult } = opts;
  const targets = opts.targets ?? (opts.target ? [opts.target] : []);
  if (targets.length === 0) {
    throw new Error("No click targets provided");
  }

  const adsClient = new AdsPowerClient(
    config.adspower.baseUrl,
    config.adspower.apiKey,
    config.adspower.requestIntervalMs
  );
  if (!(await adsClient.isUp())) {
    throw new Error(`AdsPower Local API not reachable at ${config.adspower.baseUrl}`);
  }

  const allProfiles = await adsClient.listProfiles();

  // Store early: needed for per-profile frequency/cooldown filtering below.
  const store = new ClickStore(outputDir);

  try {
  // Resolve pools and group selected profiles + targets by actual device.
  const deviceInputs = new Map<Device, DeviceEngineInput>();

  // Operational design: click with same 5+5 style pool as scan (not all 50).
  const clickCap = config.click.maxProfilesPerDevice ?? config.scan.maxProfilesPerDevice ?? 5;

  // Frequency guard: a profile may click the SAME domain at most
  // maxClicksPerProfilePerHour times per hour AND must wait sameAdCooldownMinutes
  // between hits — otherwise Google sees a bot pattern, not organic users.
  const hourAgoIso = new Date(Date.now() - 3_600_000).toISOString();
  const cooldownMs = Math.max(0, engineConfig.sameAdCooldownMinutes) * 60_000;
  const perProfileHourCap = Math.max(1, engineConfig.maxClicksPerProfilePerHour);

  // CF-fail cooldown: profiles marked cooling by the trust vault (cf: / solver
  // failures) are skipped until nextRetryAt.
  const coolingProfiles = new Set<string>();
  try {
    const { Store } = await import("../store/db.js");
    const trustStore = new Store(outputDir);
    try {
      const nowIso = new Date().toISOString();
      for (const p of allProfiles) {
        const row = trustStore.ipTrust.get(p.user_id) as { nextRetryAt?: string | null } | undefined;
        if (row?.nextRetryAt && row.nextRetryAt > nowIso) coolingProfiles.add(p.user_id);
      }
    } finally {
      trustStore.close();
    }
  } catch {
    /* vault optional */
  }

  for (const target of targets) {
    const allProfileIds = allProfiles.map((p) => p.name || p.user_id);
    const { pools } = selectPools(target, allProfileIds, config.scan.profilePrefix, config.scan.mobileProfilePrefix);

    for (const pool of pools) {
      let ids = allProfiles
        .filter((p) => pool.profileIds.includes(p.name || p.user_id))
        .map((p) => p.user_id);

      // Frequency/cooldown filter BEFORE shuffle+cap so cooled profiles don't eat pool slots.
      const beforeFilter = ids.length;
      ids = ids.filter((id) => {
        if (coolingProfiles.has(id)) return false;
        if (store.countRecentSuccesses(id, target.domain, hourAgoIso) >= perProfileHourCap) return false;
        const last = store.lastSuccessAt(id, target.domain);
        if (last && Date.now() - new Date(last).getTime() < cooldownMs) return false;
        return true;
      });
      const filtered = beforeFilter - ids.length;
      if (filtered > 0) {
        logger.info(
          { device: pool.device, domain: target.domain, filtered, remaining: ids.length, perProfileHourCap, cooldownMin: engineConfig.sameAdCooldownMinutes },
          "click pool: profiles cooling (frequency cap / same-ad cooldown)"
        );
      }

      // Shuffle then cap so we rotate which 5 of 50 are active.
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j]!, ids[i]!];
      }
      if (clickCap > 0 && ids.length > clickCap) {
        ids = ids.slice(0, clickCap);
      }

      const existing = deviceInputs.get(pool.device);
      if (existing) {
        // Merge profiles and targets, dedup profiles — keep first-capped set + new.
        const profileSet = new Set([...existing.profileIds, ...ids]);
        let merged = [...profileSet];
        for (let i = merged.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [merged[i], merged[j]] = [merged[j]!, merged[i]!];
        }
        if (clickCap > 0 && merged.length > clickCap) merged = merged.slice(0, clickCap);
        existing.profileIds = merged;
        existing.targets.push(target);
      } else {
        deviceInputs.set(pool.device, {
          device: pool.device,
          targets: [target],
          profileIds: ids,
          concurrency: 0, // assigned below
        });
      }
    }
  }

  const activeDevices = [...deviceInputs.keys()];
  if (activeDevices.length === 0) {
    throw new Error("No profiles matched any target device pool(s) — all cooling (frequency cap / same-ad cooldown)");
  }

  // GLOBAL concurrent browser cap comes from config. Split evenly across
  // active devices, but NEVER hand a device 0 slots — its engine loop would
  // spin forever with an undrainable pending queue.
  const globalCap = Math.max(1, engineConfig.concurrency);
  const baseConcurrency = Math.floor(globalCap / activeDevices.length);
  let remainder = globalCap % activeDevices.length;
  for (const device of activeDevices) {
    const input = deviceInputs.get(device)!;
    input.concurrency = Math.min(input.profileIds.length, baseConcurrency + (remainder > 0 ? 1 : 0));
    remainder = Math.max(0, remainder - 1);
  }
  for (const [device, input] of deviceInputs) {
    if (input.concurrency < 1 || input.profileIds.length === 0) {
      logger.warn({ device }, "device has no click slots — dropping from this run");
      deviceInputs.delete(device);
    }
  }
  const finalDevices = [...deviceInputs.keys()];
  if (finalDevices.length === 0) {
    throw new Error("No device has any click slot (concurrency too low or pools empty)");
  }

  const targetDomains = targets.map((t) => t.domain).join(",");
  const targetDevices: TargetDevice =
    finalDevices.length === 2 ? "both" : (finalDevices[0]! as TargetDevice);

  logger.info(
    {
      targets: targets.length,
      activeDevices,
      totalProfiles: [...deviceInputs.values()].reduce((sum, d) => sum + d.profileIds.length, 0),
      concurrency: engineConfig.concurrency,
      deviceConcurrency: Object.fromEntries([...deviceInputs.entries()].map(([d, i]) => [d, i.concurrency])),
    },
    "multi-target click engine starting"
  );

  // store was opened above (frequency filter) — reuse it here.
  const orphanCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const closed = store.closeOrphanedRuns(orphanCutoff);
  if (closed > 0) {
    logger.warn({ closed }, "closed orphaned click runs");
  }
  // Pre-count real jobs so panel never shows total=0 while work is running.
  let estimatedTotalJobs = 0;
  for (const input of deviceInputs.values()) {
    for (const target of input.targets) {
      const deviceMap = new Map(input.profileIds.map((id) => [id, input.device]));
      const preview = buildJobs({
        target: { ...target, targetDevice: input.device },
        profileIds: input.profileIds,
        deviceOfProfile: deviceMap,
        engineConfig,
        fallbackFirstAd: false,
        clickFirstResult: target.clickFirstResult ?? false,
      });
      estimatedTotalJobs += preview.length;
    }
  }
  if (limit && limit > 0 && limit < estimatedTotalJobs) estimatedTotalJobs = limit;

  // Locked total for the entire run — panel never changes this number.
  const fixedTotalJobs = Math.max(0, estimatedTotalJobs);

  const runId = store.createRun({
    startedAt: new Date().toISOString(),
    targetDomain: targetDomains,
    targetDevice: targetDevices,
    totalJobs: fixedTotalJobs,
    notes: `mode=${engineConfig.mode}, concurrency=${engineConfig.concurrency}, targets=${targets.length}, burst=${engineConfig.burst ? 1 : 0}, seer-first=1`,
    operationId: opts.operationId,
  });

  onProgress?.({
    type: "click-run-created",
    runId,
    totalJobs: fixedTotalJobs,
    devices: activeDevices,
    targets: targets.length,
    concurrency: engineConfig.concurrency,
    burst: !!engineConfig.burst,
    message: `click run #${runId} · total kilit=${fixedTotalJobs} · conc=${engineConfig.concurrency}`,
  });

  const profileMeta = new Map(allProfiles.map((p) => [p.user_id, p]));
  const sharedStats = { completed: 0, failed: 0, captcha: 0, skipped: 0 };
  const ctx: WorkerContext = {
    runId,
    config,
    adsClient,
    behavior: engineConfig.behavior,
    outputDir,
    profileMeta,
    store,
    fixedTotalJobs,
    sharedStats,
  };


  // Run each device engine in parallel.
  const deviceEngines = [...deviceInputs.values()];
  const perDeviceLimit = limit ? Math.ceil(limit / deviceEngines.length) : undefined;

  const deviceResults = await Promise.all(
    deviceEngines.map((input) =>
      runDeviceClickEngine(input, ctx, engineConfig, perDeviceLimit, onProgress, opts.isCancelled, fallbackFirstAd)
    )
  );

  let completed = 0;
  let failed = 0;
  let captchaBlocked = 0;
  let skipped = 0;
  const byDevice: Record<string, number> = {};
  const allResults: ClickResult[] = [];

  for (let i = 0; i < deviceEngines.length; i++) {
    const device = deviceEngines[i]!.device;
    const res = deviceResults[i]!;
    completed += res.completed;
    failed += res.failed;
    captchaBlocked += res.captchaBlocked;
    skipped += res.skipped;
    byDevice[device] = res.completed;
    allResults.push(...res.results);
  }

  const finishedAt = new Date().toISOString();
  const totalClicks = completed + failed + captchaBlocked + skipped;
  const durationHours = Math.max(1, engineConfig.durationMinutes) / 60;
  const avgStayMs = allResults.length
    ? Math.round(allResults.reduce((sum, r) => sum + r.evidence.stayMs, 0) / allResults.length)
    : 0;

  store.finishRun(runId, finishedAt, completed, failed, captchaBlocked, skipped);

  const summary: ClickRunSummary = {
    runId,
    targetDomain: targetDomains,
    targetDevice: targetDevices,
    targets: targets.map((t) => ({ domain: t.domain, device: t.targetDevice })),
    totalJobs: fixedTotalJobs,
    completedJobs: completed,
    failedJobs: failed,
    captchaJobs: captchaBlocked,
    skippedJobs: skipped,
    avgStayMs,
    clicksPerHour: Math.round(totalClicks / durationHours),
    byDevice,
    reportPaths: {},
  };

  return summary;
  } finally {
    store.close();
  }
}
