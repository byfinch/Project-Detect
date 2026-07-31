/**
 * Ops engine (ops Package 2) — unified production pool.
 *
 * Persistent browsers (ops.browsers, one AdsPower profile each) x tabs
 * (ops.tabsPerBrowser) = ~20 points. Every point is its own page inside the
 * SAME profile context (tabs share the profile/IP). Each point works the
 * planner's active domains (Package 1): refresh the SERP on a jittered
 * interval → if the target ad is present, click + report via the PROVEN
 * core (worker.ts module-level clickAndReportAd + aclkWatch + restoreSerp +
 * tapMobile, incl. click-first / new-tab isolation / proof-by-crash), then
 * harvest the other betting ads on the same SERP (1 query = 2-4 products).
 *
 * Hard rules:
 *  - Query budget: per PROFILE (not per tab) rolling-hour cap =
 *    SAFE_QUERIES_PER_HOUR minus the watcher share — the watcher can never
 *    starve and the engine can never wall an IP through query volume.
 *  - Tab sharing: a per-browser mutex serialises SERP actions so two tabs
 *    of one profile never drive CDP against each other.
 *  - Valve/busy: isCalm() parks points (no new queries, browsers stay open);
 *    isBusy() (classic scan/click/storm) makes the engine yield all
 *    browsers gracefully (storm shouldYield pattern).
 *  - Infra ≠ solver-fail: renderer/page crashes never touch the cooldown
 *    ladder; 3 consecutive infra crashes deprioritise the profile for 30m.
 *    Sorry walls go through the existing solve-through; 3 solver fiascos
 *    rest the profile for 10m (vault markSolverFailed, never a long park).
 *
 * Lifecycle: started/stopped by the panel's ops runtime (ops.enabled).
 */
import type { Page } from "playwright-core";
import { AdsPowerClient, captchaProxyFromProfile, type ProfileSummary } from "../adspower/client.js";
import type { AppConfig } from "../config.js";
import type { BrowserSession } from "../browser/session.js";
import { buildSerpUrl, gotoSerp, warmUp, type SerpNavOptions } from "../google/serp.js";
import { parseAds, type RawAd } from "../google/adParser.js";
import { logger } from "../logger.js";
import { sleep } from "../util/time.js";
import type { Device } from "../types.js";
import type { ClickJob, ClickResult } from "../click/types.js";
import { ClickStore } from "../click/store.js";
import {
  clickAndReportAd,
  closeProfile,
  isTargetDeathError,
  matchAd,
  normalizeDomain,
  openProfile,
  toClickableAd,
  type AdFlowContext,
  type WorkerContext,
} from "../click/worker.js";
import { getInUseProfiles, releaseProfile } from "../browser/profileRegistry.js";
import { governedConcurrency } from "../util/resources.js";
import { behaviorForProfile } from "../util/persona.js";
import { ensureEvidenceDir } from "../click/evidence.js";
import { appAdKey, isAppInstallAd } from "../util/appAds.js";
import { planActiveDomains, type PlannedDomain } from "./planner.js";
import { SAFE_QUERIES_PER_HOUR, watchBudgetPerHour } from "./richness.js";

/** ±40% everywhere — no metronome intervals. */
function jitterSec(baseSec: number): number {
  return Math.max(3, Math.round(baseSec * (0.6 + Math.random() * 0.8)));
}

export interface OpsEngineDeps {
  config: AppConfig;
  /** Classic scan/click/campaign/storm running → engine yields all browsers. */
  isBusy: () => boolean;
  /** Health valve calm → points park (no new queries, browsers stay open). */
  isCalm: () => boolean;
  /** SSE/event sink (panel emitEvent shape). */
  emit: (event: Record<string, unknown>) => void;
}

type PointStateName = "starting" | "active" | "miss" | "parked" | "idle";

interface PointState {
  id: string;
  profileId: string;
  tabIndex: number;
  page: Page;
  domain: string | null;
  keyword: string;
  state: PointStateName;
  refreshes: number;
  misses: number;
  clicks: number;
  reports: number;
  fails: number;
  /** Last time this point produced a click or report (miss-reset window). */
  lastProductionAt: number;
  lastAction: string | null;
  serpUrl: string | null;
  serpFinalUrl: string | null;
  nextRefreshAt: number;
  stopRequested: boolean;
  done: Promise<void>;
}

interface BrowserSlot {
  profileId: string;
  device: Device;
  session: BrowserSession;
  openedAt: number;
  /** Rolling 1h SERP-query timestamps across BOTH tabs (profile budget). */
  queries: number[];
  solverFails: number;
  stopRequested: boolean;
  lock: SlotLock;
  points: PointState[];
}

/** Tiny promise-chain mutex — serialises SERP actions inside one browser. */
class SlotLock {
  private chain: Promise<void> = Promise.resolve();
  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.chain;
    this.chain = prev.then(() => next);
    await prev;
    return release;
  }
}

export interface OpsEngineStatus {
  running: boolean;
  startedAt: string | null;
  runId: number;
  browsers: number;
  activePoints: number;
  totals: { clicks: number; reports: number; failed: number; skipped: number; queriesLastHour: number };
  perDomain: Array<{ domain: string; clicks: number; reports: number; clicksPerHour: number }>;
  points: Array<{
    id: string;
    profileId: string;
    tabIndex: number;
    device: Device;
    domain: string | null;
    keyword: string;
    state: PointStateName;
    lastAction: string | null;
    clicks: number;
    reports: number;
    fails: number;
    misses: number;
  }>;
}

class OpsEngine {
  private readonly deps: OpsEngineDeps;
  private readonly config: AppConfig;
  private readonly adsClient: AdsPowerClient;
  private readonly store: ClickStore;
  private workerCtx!: WorkerContext;
  private runId = 0;
  private evidenceDir = "";
  private readonly slots = new Map<string, BrowserSlot>();
  private poolByDevice: Record<Device, string[]> = { desktop: [], mobile: [] };
  private readonly retryAfter = new Map<string, number>();
  private readonly infraStreak = new Map<string, number>();
  private plan: PlannedDomain[] = [];
  private planFetchedAt = 0;
  private stopped = false;
  private startedAt: string | null = null;
  private readonly totals = { clicks: 0, reports: 0, failed: 0, skipped: 0 };
  private readonly perDomain = new Map<string, { clicks: number; reports: number }>();
  private supervisor: Promise<void> | null = null;
  private clickSeq = 0;
  private lastStatsSig = "";
  private lastStatsAt = 0;

  constructor(deps: OpsEngineDeps) {
    this.deps = deps;
    this.config = deps.config;
    this.adsClient = new AdsPowerClient(
      this.config.adspower.baseUrl,
      this.config.adspower.apiKey,
      this.config.adspower.requestIntervalMs
    );
    this.store = new ClickStore(this.config.output.dir);
  }

  async start(): Promise<void> {
    if (this.supervisor) throw new Error("ops engine already running");
    if (!(await this.adsClient.isUp())) {
      throw new Error(`AdsPower Local API not reachable at ${this.config.adspower.baseUrl}`);
    }
    const allProfiles = await this.adsClient.listProfiles();
    const profileMeta = new Map<string, ProfileSummary>(allProfiles.map((p) => [p.user_id, p]));
    this.poolByDevice = {
      desktop: allProfiles
        .filter((p) => (p.name || p.user_id).startsWith(this.config.scan.profilePrefix))
        .map((p) => p.user_id),
      mobile: allProfiles
        .filter((p) => (p.name || p.user_id).startsWith(this.config.scan.mobileProfilePrefix))
        .map((p) => p.user_id),
    };
    this.startedAt = new Date().toISOString();
    this.runId = this.store.createRun({
      startedAt: this.startedAt,
      targetDomain: "ops-engine",
      targetDevice: "both",
      totalJobs: 0, // open-ended pool — counters reconcile on finish
      notes: `ops engine · browsers<=${this.config.ops.browsers} · tabs=${this.config.ops.tabsPerBrowser}`,
      operationId: "ops-engine",
    });
    this.evidenceDir = ensureEvidenceDir(this.config.output.dir, this.runId);
    this.workerCtx = {
      runId: this.runId,
      config: this.config,
      adsClient: this.adsClient,
      behavior: this.config.click.behavior,
      outputDir: this.config.output.dir,
      profileMeta,
      store: this.store,
    };
    this.stopped = false;
    this.supervisor = this.supervise();
    logger.info(
      { runId: this.runId, browsers: this.config.ops.browsers, tabs: this.config.ops.tabsPerBrowser },
      "ops engine started"
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const slot of this.slots.values()) slot.stopRequested = true;
    await this.supervisor?.catch(() => {});
  }

  status(): OpsEngineStatus {
    const hourAgo = Date.now() - 3_600_000;
    let queriesLastHour = 0;
    for (const slot of this.slots.values()) {
      queriesLastHour += slot.queries.filter((t) => t > hourAgo).length;
    }
    const elapsedH = this.startedAt
      ? Math.max(60_000, Date.now() - new Date(this.startedAt).getTime()) / 3_600_000
      : 1;
    const points = [...this.slots.values()].flatMap((slot) =>
      slot.points.map((p) => ({
        id: p.id,
        profileId: p.profileId,
        tabIndex: p.tabIndex,
        device: slot.device,
        domain: p.domain,
        keyword: p.keyword,
        state: p.state,
        lastAction: p.lastAction,
        clicks: p.clicks,
        reports: p.reports,
        fails: p.fails,
        misses: p.misses,
      }))
    );
    return {
      running: !this.stopped,
      startedAt: this.startedAt,
      runId: this.runId,
      browsers: this.slots.size,
      activePoints: points.filter((p) => p.state === "active" || p.state === "miss").length,
      totals: { ...this.totals, queriesLastHour },
      perDomain: [...this.perDomain.entries()].map(([domain, d]) => ({
        domain,
        clicks: d.clicks,
        reports: d.reports,
        clicksPerHour: Math.round(d.clicks / elapsedH),
      })),
      points,
    };
  }

  // ── supervisor ────────────────────────────────────────────────────

  private effectiveBrowsers(): number {
    const max = Math.max(1, this.config.ops.browsers);
    const gov = governedConcurrency({ base: max, floor: 2, ceiling: 16 });
    const external = Math.max(0, getInUseProfiles().size - this.slots.size);
    return Math.max(0, Math.min(max, gov.concurrency, 16 - external));
  }

  private refreshPlanIfDue(force: boolean): void {
    if (!force && Date.now() - this.planFetchedAt < 60_000) return;
    this.planFetchedAt = Date.now();
    try {
      this.plan = planActiveDomains();
    } catch (err) {
      logger.debug({ err: String(err) }, "ops engine: planner read failed (keeping last plan)");
    }
  }

  private async supervise(): Promise<void> {
    try {
      let ticks = 0;
      let wasDormant = true; // pool starts dormant until the planner has work
      while (!this.stopped) {
        this.refreshPlanIfDue(false);
        const busy = this.deps.isBusy();
        // No active domains → no browsers. Slots only exist while the
        // planner has work; an emptied plan drains the pool gracefully
        // (points finish their current cycle via the stopRequested checks).
        const dormant = busy || this.plan.length === 0;
        if (dormant !== wasDormant) {
          wasDormant = dormant;
          logger.info(
            {
              reason: busy ? "classic-op busy" : this.plan.length === 0 ? "plan empty" : "plan active",
              planDomains: this.plan.length,
            },
            dormant
              ? "ops engine: pool dormant — browser slots stay closed"
              : "ops engine: plan active — opening browser slots"
          );
        }
        // Classic campaign/scan/storm owns the browser ceiling — yield ALL.
        if (busy) {
          for (const slot of this.slots.values()) slot.stopRequested = true;
        }
        const desired = dormant ? 0 : this.effectiveBrowsers();
        if (this.slots.size > desired) {
          let toShed = this.slots.size - desired;
          for (const slot of this.slots.values()) {
            if (toShed <= 0) break;
            if (!slot.stopRequested) {
              slot.stopRequested = true;
              toShed--;
            }
          }
        }
        while (!this.stopped && !dormant && this.slots.size < desired) {
          const opened = await this.openSlot();
          if (!opened) break;
          // Stagger browser opens — the AdsPower API hates herds.
          await sleep(1_500 + Math.random() * 1_500);
        }
        if (++ticks % 10 === 0) this.emitStats();
        await sleep(3_000);
      }
      // Stop: graceful drain (points exit their loops), 10s grace, then force.
      for (const slot of this.slots.values()) slot.stopRequested = true;
      const deadline = Date.now() + 10_000;
      while (this.slots.size > 0 && Date.now() < deadline) {
        await sleep(250);
      }
      for (const slot of [...this.slots.values()]) {
        await this.adsClient.stopBrowser(slot.profileId).catch(() => {});
        releaseProfile(slot.profileId);
      }
    } finally {
      try {
        this.store.finishRun(
          this.runId,
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

  // ── slot (browser) lifecycle ───────────────────────────────────────

  private noteInfraCrash(profileId: string): void {
    const streak = (this.infraStreak.get(profileId) ?? 0) + 1;
    this.infraStreak.set(profileId, streak);
    const backoffMs = streak >= 3 ? 30 * 60_000 : jitterSec(120) * 1000;
    this.retryAfter.set(profileId, Date.now() + backoffMs);
    logger.warn(
      { profileId, streak, backoffMinutes: Math.round(backoffMs / 60_000) },
      "ops engine: infra crash — profile deprioritised (no cooldown)"
    );
  }

  private slotsOfDevice(device: Device): number {
    let n = 0;
    for (const slot of this.slots.values()) if (slot.device === device) n++;
    return n;
  }

  private async pickProfile(): Promise<{ profileId: string; device: Device } | null> {
    // Device preference follows the plan; the device with fewer open slots first.
    const devices: Device[] = [];
    for (const d of this.plan) {
      const dev: Device = d.device === "mobile" ? "mobile" : "desktop";
      if (!devices.includes(dev)) devices.push(dev);
    }
    if (devices.length === 0) devices.push("mobile", "desktop");
    devices.sort((a, b) => this.slotsOfDevice(a) - this.slotsOfDevice(b));

    const inUse = getInUseProfiles();
    const nowMs = Date.now();
    const nowIso = new Date().toISOString();
    // Vault-cooled profiles rest until nextRetryAt (solver/CF failures).
    const cooling = new Set<string>();
    try {
      const { Store } = await import("../store/db.js");
      const vault = new Store(this.config.output.dir);
      try {
        for (const pool of Object.values(this.poolByDevice)) {
          for (const id of pool) {
            const row = vault.ipTrust.get(id) as { nextRetryAt?: string | null } | undefined;
            if (row?.nextRetryAt && row.nextRetryAt > nowIso) cooling.add(id);
          }
        }
      } finally {
        vault.close();
      }
    } catch {
      /* vault optional */
    }

    for (const device of devices) {
      const candidates = this.poolByDevice[device].filter(
        (id) =>
          !this.slots.has(id) &&
          !inUse.has(id) &&
          !cooling.has(id) &&
          (this.retryAfter.get(id) ?? 0) <= nowMs
      );
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
      }
      if (candidates.length > 0) return { profileId: candidates[0]!, device };
    }
    return null;
  }

  private async openSlot(): Promise<boolean> {
    const pick = await this.pickProfile();
    if (!pick) return false;
    const session = await openProfile(this.workerCtx, pick.profileId, pick.device);
    if (!session) {
      this.noteInfraCrash(pick.profileId);
      return false;
    }
    const slot: BrowserSlot = {
      profileId: pick.profileId,
      device: pick.device,
      session,
      openedAt: Date.now(),
      queries: [],
      solverFails: 0,
      stopRequested: false,
      lock: new SlotLock(),
      points: [],
    };
    this.slots.set(pick.profileId, slot);
    const tabs = Math.max(1, this.config.ops.tabsPerBrowser);
    const pages: Page[] = [session.page];
    for (let i = 1; i < tabs; i++) {
      try {
        pages.push(await session.newPage());
      } catch (err) {
        logger.warn({ profileId: pick.profileId, err: String(err) }, "ops engine: extra tab open failed — running with fewer tabs");
        break;
      }
    }
    pages.forEach((page, i) => {
      const point = this.makePoint(slot, page, i);
      slot.points.push(point);
      point.done = this.pointLoop(slot, point).catch((err) => {
        logger.debug({ pointId: point.id, err: String(err) }, "ops engine: point loop died");
      });
    });
    // Close the browser once every point loop has exited.
    void (async () => {
      await Promise.allSettled(slot.points.map((p) => p.done));
      await this.closeSlot(slot);
    })();
    logger.info({ profileId: pick.profileId, device: pick.device, tabs: pages.length }, "ops engine: browser slot opened");
    this.emitStats(); // pool size changed — report immediately (gated)
    return true;
  }

  private makePoint(slot: BrowserSlot, page: Page, tabIndex: number): PointState {
    return {
      id: `ops-${slot.profileId.slice(-6)}-t${tabIndex}`,
      profileId: slot.profileId,
      tabIndex,
      page,
      domain: null,
      keyword: "",
      state: "starting",
      refreshes: 0,
      misses: 0,
      clicks: 0,
      reports: 0,
      fails: 0,
      lastProductionAt: 0,
      lastAction: null,
      serpUrl: null,
      serpFinalUrl: null,
      nextRefreshAt: 0,
      stopRequested: false,
      done: Promise.resolve(),
    };
  }

  private async closeSlot(slot: BrowserSlot): Promise<void> {
    if (!this.slots.has(slot.profileId)) return;
    this.slots.delete(slot.profileId);
    for (const p of slot.points) {
      await p.page.close().catch(() => {});
    }
    await closeProfile(this.workerCtx, slot.session, slot.profileId);
    logger.info({ profileId: slot.profileId }, "ops engine: browser slot closed");
    this.emitStats(); // pool size changed — report immediately (gated)
  }

  // ── point (tab) loop ───────────────────────────────────────────────

  private async waitInterruptible(ms: number, slot: BrowserSlot, point: PointState): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.stopped || slot.stopRequested || point.stopRequested) return false;
      await sleep(Math.min(500, deadline - Date.now()));
    }
    return true;
  }

  private assignDomain(slot: BrowserSlot, point: PointState): PlannedDomain | null {
    const matching = this.plan.filter((d) => d.device === slot.device);
    if (matching.length === 0) return null;
    return matching[point.tabIndex % matching.length] ?? matching[0]!;
  }

  private async pointLoop(slot: BrowserSlot, point: PointState): Promise<void> {
    while (!this.stopped && !slot.stopRequested && !point.stopRequested) {
      try {
        // Valve / busy parking — no new queries while calm or yielding.
        if (this.deps.isCalm() || this.deps.isBusy()) {
          if (point.state !== "parked") {
            point.state = "parked";
            this.emitPoint(slot, point, "park (valf/meşgul)");
          }
          await this.waitInterruptible(10_000 + Math.random() * 10_000, slot, point);
          continue;
        }
        const target = this.assignDomain(slot, point);
        if (!target) {
          if (point.state !== "idle") {
            point.state = "idle";
            point.domain = null;
          }
          await this.waitInterruptible(20_000 + Math.random() * 20_000, slot, point);
          continue;
        }
        if (point.domain !== target.domain) {
          // Plan change (hysteresis respected upstream): switch gracefully.
          // Plan keywords are recency-ordered (the keyword the ad was seen on
          // first) — tab 0 searches the proven auction, siblings take the
          // next variants; rotation cycles the rest.
          point.domain = target.domain;
          point.keyword =
            target.keywords[point.tabIndex % Math.max(1, target.keywords.length)] ??
            target.keywords[0] ??
            target.domain;
          point.serpUrl = null;
          point.misses = 0;
          this.emitPoint(slot, point, `yeni domain · ${target.domain} · ${point.keyword}`);
        }
        const waitMs = await this.workCycle(slot, point, target);
        await this.waitInterruptible(waitMs, slot, point);
      } catch (err) {
        // Infra (page/CDP/context death) — never a cooldown, streak backoff only.
        point.state = "idle";
        point.lastAction = `infra: ${String(err).slice(0, 80)}`;
        if (isTargetDeathError(err)) this.noteInfraCrash(slot.profileId);
        await this.waitInterruptible(15_000, slot, point);
      }
    }
    point.state = "idle";
  }

  // ── one production cycle (mutex-protected inside the browser) ─────

  private engineBudgetPerHour(): number {
    // The watcher owns its share (ops.watchBudgetPct); the engine uses the rest.
    return Math.max(1, SAFE_QUERIES_PER_HOUR - watchBudgetPerHour(this.config.ops.watchBudgetPct));
  }

  private budgetOk(slot: BrowserSlot): boolean {
    const hourAgo = Date.now() - 3_600_000;
    slot.queries = slot.queries.filter((t) => t > hourAgo);
    return slot.queries.length < this.engineBudgetPerHour();
  }

  private countQuery(slot: BrowserSlot, n = 1): void {
    for (let i = 0; i < n; i++) slot.queries.push(Date.now());
  }

  /** Per-profile per-domain click cooling — same ClickStore counters as the worker. */
  private isCooling(profileId: string, domain: string): boolean {
    const d = normalizeDomain(domain);
    const hourAgoIso = new Date(Date.now() - 3_600_000).toISOString();
    const cap = Math.max(1, this.config.click.maxClicksPerProfilePerHour);
    const cooldownMs = Math.max(0, this.config.click.sameAdCooldownMinutes) * 60_000;
    try {
      if (this.store.countRecentSuccesses(profileId, d, hourAgoIso) >= cap) return true;
      const last = this.store.lastSuccessAt(profileId, d);
      return !!(last && Date.now() - new Date(last).getTime() < cooldownMs);
    } catch {
      return false;
    }
  }

  private async navigatePointSerp(
    slot: BrowserSlot,
    point: PointState
  ): Promise<{ serpUrl: string; finalUrl: string } | null> {
    const cfg = this.config;
    const serpUrl = buildSerpUrl(cfg, point.keyword);
    const meta = this.workerCtx.profileMeta.get(slot.profileId);
    const captchaProxy = meta ? captchaProxyFromProfile(meta) : undefined;
    const navOpts: SerpNavOptions = {
      captchaProxy: captchaProxy
        ? { proxy: captchaProxy.proxy, proxytype: captchaProxy.proxytype }
        : undefined,
      profileId: slot.profileId,
    };
    // gotoSerp/warmUp only read session.page — rebind to this point's tab.
    const rebound = { ...slot.session, page: point.page } as unknown as BrowserSession;
    let nav = await gotoSerp(rebound, serpUrl, cfg, navOpts);
    if (nav.captcha) {
      // Same recovery as the click worker: ONE trend search, retry once.
      const warm = await warmUp(rebound, cfg, { ...navOpts, trendWarmup: true });
      if (!warm.captcha) {
        nav = await gotoSerp(rebound, serpUrl, cfg, { ...navOpts, skipSolve: true });
      }
      if (nav.captcha) {
        slot.solverFails++;
        if (!warm.infraError) {
          try {
            const { Store } = await import("../store/db.js");
            const vault = new Store(cfg.output.dir);
            try {
              vault.ipTrust.markSolverFailed(slot.profileId, "ops: SERP wall after trend refresh", {
                maxCooldownMinutes: 10,
              });
            } finally {
              vault.close();
            }
          } catch {
            /* vault optional */
          }
        }
        if (slot.solverFails >= 3) {
          // 3 solver fiascos → the profile rests 10m (vault nextRetryAt);
          // close the browser so the pool picks another profile.
          slot.stopRequested = true;
          logger.warn({ profileId: slot.profileId }, "ops engine: 3 solver fiascos — profile rests 10m, browser closed");
        }
        return null;
      }
    }
    slot.solverFails = 0;
    return { serpUrl, finalUrl: nav.finalUrl };
  }

  /** Returns the wait (ms) before the point's next cycle. */
  private async workCycle(slot: BrowserSlot, point: PointState, target: PlannedDomain): Promise<number> {
    const ops = this.config.ops;
    const release = await slot.lock.acquire();
    try {
      if (!this.budgetOk(slot)) {
        point.state = "parked";
        point.lastAction = "sorgu bütçesi dolu — pencere bekleniyor";
        return 90_000 + Math.random() * 60_000;
      }
      // Keyword rotation within the domain's set.
      point.refreshes++;
      if (point.refreshes % ops.keywordRotateEvery === 0 && target.keywords.length > 1) {
        const others = target.keywords.filter((k) => k !== point.keyword);
        point.keyword = others[Math.floor(Math.random() * others.length)] ?? point.keyword;
      }

      const nav = await this.navigatePointSerp(slot, point);
      this.countQuery(slot, 1);
      if (!nav) {
        point.state = "miss";
        point.lastAction = "SERP duvarı (solve-through başarısız)";
        return jitterSec(ops.missRetrySec) * 1000;
      }
      point.serpUrl = nav.serpUrl;
      point.serpFinalUrl = nav.finalUrl;
      point.state = "active";

      const ads = await Promise.race([
        parseAds(point.page),
        sleep(20_000).then(() => [] as RawAd[]),
      ]);
      let targetAd = matchAd(ads, target.domain, undefined);
      if (!targetAd && target.domain.startsWith("app:")) {
        // Richness app keys are app:<finalDomain>, while matchAd keys on
        // app:<brandslug|pkg> — fall back to the first app-install card on
        // the SERP so app targets still produce.
        const appCard = ads.find((a) => a.adHref && isAppInstallAd(a.displayDomain, a.adHref));
        targetAd = appCard ? toClickableAd(appCard) : null;
      }

      if (!targetAd) {
        // (a) Production beats misses: a point that produced a click/report
        // within missResetOnProductionMinutes is in a live auction — its
        // miss counter resets instead of declaring blindness.
        const prodWindowMs = this.config.ops.missResetOnProductionMinutes * 60_000;
        const producedRecently = Date.now() - point.lastProductionAt < prodWindowMs;
        point.misses = producedRecently ? 0 : point.misses + 1;
        point.state = "miss";
        if (point.misses >= ops.maxMisses) {
          // (c) Genuine drought: this IP looks ad-blind for the auction —
          // close the browser; the supervisor spawns a FRESH profile and
          // planner hysteresis keeps the domain alive across the swap.
          this.refreshPlanIfDue(true);
          this.emitPoint(slot, point, `${ops.maxMisses} ıska — profil değişiyor (plan korunuyor)`);
          slot.stopRequested = true;
          return jitterSec(ops.missRetrySec) * 1000;
        }
        point.lastAction = `reklam yok (${point.misses}/${ops.maxMisses})`;
        return jitterSec(ops.missRetrySec) * 1000;
      }

      point.misses = 0;

      // Advertiser identity (app ads share play.google.com — identity by app).
      const identityOf = (a: RawAd): string =>
        isAppInstallAd(a.displayDomain, a.adHref)
          ? (appAdKey(a.title, a.adHref) ?? (a.displayDomain || ""))
          : (a.displayDomain || "");
      const uniqueAds = (list: RawAd[]): RawAd[] => {
        const seen = new Set<string>();
        return list.filter((a) => {
          const d = identityOf(a).toLowerCase().replace(/^www\./, "");
          if (!d || seen.has(d)) return false;
          seen.add(d);
          return true;
        });
      };

      // Main target click (+ report via the proven core).
      if (!this.isCooling(slot.profileId, identityOf(targetAd) || target.domain)) {
        const crashed = await this.clickOne(slot, point, targetAd, identityOf(targetAd) || target.domain);
        if (crashed) return jitterSec(ops.refreshSec) * 1000; // tab replaced; SERP reloads next cycle
      } else {
        point.lastAction = "hedef cooling (saatlik cap / same-ad)";
      }

      // Harvest: other unique ads on the same SERP (1 query = 2-4 products).
      const extras = uniqueAds(ads)
        .filter((a) => a.adHref)
        .filter(
          (a) =>
            identityOf(a).toLowerCase().replace(/^www\./, "") !==
            identityOf(targetAd).toLowerCase().replace(/^www\./, "")
        )
        .filter((a) => !this.isCooling(slot.profileId, identityOf(a)))
        .slice(0, 3);
      for (const extra of extras) {
        if (this.stopped || slot.stopRequested || point.stopRequested) break;
        const crashed = await this.clickOne(slot, point, extra, identityOf(extra) || extra.displayDomain);
        if (crashed) break;
      }

      point.nextRefreshAt = Date.now() + jitterSec(ops.refreshSec) * 1000;
      return Math.max(0, point.nextRefreshAt - Date.now());
    } finally {
      release();
    }
  }

  /**
   * One click+report via the proven core. Returns true when the click was
   * counted by proof-by-crash and the tab had to be replaced (the caller
   * stops the harvest pass — the new tab loads a fresh SERP next cycle).
   */
  private async clickOne(
    slot: BrowserSlot,
    point: PointState,
    ad: RawAd,
    domainKey: string
  ): Promise<boolean> {
    const clickable = toClickableAd(ad);
    const meta = this.workerCtx.profileMeta.get(slot.profileId);
    const profileKey = meta?.name || slot.profileId;
    const job: ClickJob = {
      id: `ops-${slot.profileId.slice(-6)}-t${point.tabIndex}-${++this.clickSeq}-${Date.now().toString(36)}`,
      profileId: slot.profileId,
      device: slot.device,
      keyword: point.keyword,
      targetDomain: normalizeDomain(domainKey),
      targetTitle: clickable.title,
      fallbackFirstAd: false,
      clickFirstResult: false,
      scheduledAt: Date.now(),
      attempt: 0,
      maxAttempts: 1,
    };
    const flow: AdFlowContext = {
      ctx: this.workerCtx,
      session: slot.session,
      page: point.page,
      serpUrl: point.serpUrl!,
      serpFinalUrl: point.serpFinalUrl,
      screenshotSerp: null,
      preClickMs: 0,
      evidenceDir: this.evidenceDir,
      device: slot.device,
      keyword: point.keyword,
      personaBehavior: behaviorForProfile(this.config.click.behavior, profileKey),
      profileKey,
      reportEnabled: true,
    };
    const result = await clickAndReportAd(flow, clickable, job);
    this.countQuery(slot, 1); // internal fresh-impression re-queries included
    this.recordResult(slot, point, job, result);
    if (/renderer died on intent chain/.test(result.error ?? "")) {
      // Proof-by-crash: the click COUNTED, the tab died — replace the tab and
      // continue on a fresh SERP next cycle (context death closes the slot).
      const recovered = await this.recoverPointTab(slot, point);
      if (!recovered) return true;
      return true;
    }
    return false;
  }

  private async recoverPointTab(slot: BrowserSlot, point: PointState): Promise<boolean> {
    try {
      await point.page.close().catch(() => {}); // dead tab — best effort
      point.page = await slot.session.newPage(); // throws when the context is dead
      point.serpUrl = null;
      point.serpFinalUrl = null;
      point.lastAction = "sekme yenilendi (intent-chain tab death)";
      this.emitPoint(slot, point, "tık kanıtı: renderer öldü · yeni sekme");
      return true;
    } catch (err) {
      logger.warn({ profileId: slot.profileId, err: String(err) }, "ops engine: tab recovery failed — closing browser (infra)");
      this.noteInfraCrash(slot.profileId);
      slot.stopRequested = true;
      return false;
    }
  }

  // ── recording + events ─────────────────────────────────────────────

  private recordResult(
    slot: BrowserSlot,
    point: PointState,
    job: ClickJob,
    result: { status: ClickResult["status"]; error: string | null; evidence: ClickResult["evidence"]; reportResult: ClickResult["report"] }
  ): void {
    try {
      this.store.insertClick(this.runId, {
        job,
        status: result.status,
        evidence: result.evidence,
        error: result.error,
        capturedAt: new Date().toISOString(),
        report: result.reportResult,
      });
    } catch (err) {
      logger.debug({ err: String(err) }, "ops engine: insertClick failed (ignored)");
    }
    const domainKey = normalizeDomain(job.targetDomain);
    if (result.status === "success") {
      point.clicks++;
      this.totals.clicks++;
      point.lastProductionAt = Date.now();
      this.infraStreak.delete(slot.profileId);
      const d = this.perDomain.get(domainKey) ?? { clicks: 0, reports: 0 };
      d.clicks++;
      this.perDomain.set(domainKey, d);
    } else if (result.status === "skipped") {
      this.totals.skipped++;
    } else {
      point.fails++;
      this.totals.failed++;
    }
    const repOk =
      result.reportResult &&
      (result.reportResult.status === "submitted" || result.reportResult.status === "filled");
    if (repOk) {
      point.reports++;
      this.totals.reports++;
      point.lastProductionAt = Date.now();
      const d = this.perDomain.get(domainKey) ?? { clicks: 0, reports: 0 };
      d.reports++;
      this.perDomain.set(domainKey, d);
    }
    point.lastAction = `tık ${result.status} · ${domainKey}`;
    try {
      this.store.updateRunProgress(this.runId, {
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
    this.deps.emit({
      type: "ops-click",
      runId: this.runId,
      jobId: job.id,
      pointId: point.id,
      profileId: slot.profileId,
      domain: domainKey,
      device: slot.device,
      keyword: job.keyword,
      status: result.status,
      reportStatus: result.reportResult?.status ?? null,
      message: `ops · ${domainKey} · profil …${slot.profileId.slice(-6)}/t${point.tabIndex} · tık ${result.status}${repPart}`,
    });
  }

  private emitPoint(slot: BrowserSlot, point: PointState, note: string): void {
    this.deps.emit({
      type: "ops-point",
      pointId: point.id,
      profileId: slot.profileId,
      device: slot.device,
      domain: point.domain,
      keyword: point.keyword,
      state: point.state,
      message: `ops · nokta ${point.id} · ${note}`,
    });
  }

  private emitStats(): void {
    const s = this.status();
    const now = Date.now();
    // Anti-spam: emit on meaningful change, on a 30s cadence while
    // producing, and at most a 10-minute "waiting" heartbeat when fully idle.
    const sig = [
      s.browsers,
      s.activePoints,
      s.totals.clicks,
      s.totals.reports,
      s.totals.failed,
      s.totals.skipped,
      s.totals.queriesLastHour,
      this.plan.map((d) => d.domain).join(","),
    ].join("|");
    const idle = s.browsers === 0 && s.activePoints === 0;
    const changed = sig !== this.lastStatsSig;
    const dueActive = !idle && now - this.lastStatsAt >= 30_000;
    const dueIdle = idle && now - this.lastStatsAt >= 10 * 60_000;
    if (!changed && !dueActive && !dueIdle) return;
    this.lastStatsSig = sig;
    this.lastStatsAt = now;
    const message =
      idle && this.plan.length === 0
        ? `ops · beklemede · aktif domain yok · toplam ${s.totals.clicks} tık · ${s.totals.reports} rapor`
        : `ops · ${s.browsers} tarayıcı · ${s.activePoints} nokta · ${s.totals.clicks} tık · ${s.totals.reports} rapor · ${s.totals.queriesLastHour} sorgu/saat`;
    this.deps.emit({
      type: "ops-stats",
      runId: this.runId,
      browsers: s.browsers,
      activePoints: s.activePoints,
      totals: s.totals,
      perDomain: s.perDomain,
      message,
    });
  }
}

// ── module singleton (panel ops runtime drives this) ────────────────

let engine: OpsEngine | null = null;

export async function startOpsEngine(deps: OpsEngineDeps): Promise<void> {
  if (engine) return;
  const e = new OpsEngine(deps);
  try {
    await e.start();
  } catch (err) {
    logger.warn({ err: String(err) }, "ops engine start failed");
    return;
  }
  engine = e;
}

export async function stopOpsEngine(): Promise<void> {
  const e = engine;
  engine = null;
  if (e) await e.stop().catch((err) => logger.debug({ err: String(err) }, "ops engine stop error"));
}

export function getOpsEngineStatus(): OpsEngineStatus | { running: false } {
  return engine ? engine.status() : { running: false };
}
