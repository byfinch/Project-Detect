import express, { type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { Store } from "../store/db.js";
import { ClickStore } from "../click/store.js";
import { runScan } from "../scanner.js";
import { runFocusCampaign, pickTopAdFromScan, waveBudget, type FocusCampaignState } from "../click/focusCampaign.js";
import { analyzeScanClones } from "../analyze/cloneReport.js";
import { expandBrandKeywords } from "../util/keywords.js";
import { buildAdComplaintPack } from "../report/adComplaintPack.js";
import { getEmailPool } from "../report/emailPool.js";
import { solverCostSummary } from "../report/solverCost.js";

import { logger } from "../logger.js";
import type { Device } from "../types.js";
import type { ClickMode, ClickTarget } from "../click/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = existsSync(resolve(__dirname, "public"))
  ? resolve(__dirname, "public")
  : resolve(__dirname, "..", "..", "src", "web", "public");

interface JobState {
  id: string;
  type: "scan" | "click";
  status: "running" | "completed" | "failed" | "cancelled";
  progress: number;
  message: string;
  details: Record<string, unknown>;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  updatedAt: string;
}

const jobs = new Map<string, JobState>();
/** Cooperative cancel flags for long-running click engines / campaigns. */
const cancelFlags = new Map<string, boolean>();
/** AbortControllers for running scan jobs — panel cancel must actually stop the scan. */
const scanAbortControllers = new Map<string, AbortController>();
/** Active focus campaign (top-ad · 2h windows). */
let activeCampaign: FocusCampaignState | null = null;
const events = new EventEmitter();
events.setMaxListeners(100);

/** Server-side shared log ring — every panel user sees the SAME history. */
const LOG_BUFFER_MAX = 500;
const logBuffer: Array<{ t: string; type: string; message: string }> = [];

function emitEvent(event: Record<string, unknown>): void {
  const msg = typeof event.message === "string" ? event.message : null;
  if (msg) {
    logBuffer.push({ t: new Date().toISOString(), type: String(event.type ?? ""), message: msg });
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX);
  }
  events.emit("broadcast", { time: new Date().toISOString(), ...event });
}

function createJobId(type: string): string {
  return `${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

const SCHEDULED_BRANDS = ["herabet", "rovbet", "napolibet", "primebahis", "vegasslot"];
/** Slim variant set for scheduled scans: base + 3 suffixes = 4 keywords/brand. */
const SCHEDULED_SLIM_SUFFIXES = ["giriş", "güncel adres", "bonus"];
const SCHEDULED_INTERVAL_HOURS = 2;
const SCHEDULED_FIRST_HOUR = 6;

interface ScheduledScanState {
  enabled: boolean;
  nextAt: string | null;
  lastQueuedAt: string | null;
  lastJobId: string | null;
}

const scheduledScan: ScheduledScanState = {
  enabled: true,
  nextAt: null,
  lastQueuedAt: null,
  lastJobId: null,
};

function isScanRunning(jobList: JobState[] = Array.from(jobs.values())): boolean {
  return jobList.some((j) => j.type === "scan" && j.status === "running");
}

async function isScanRunningInDb(outputDir: string): Promise<boolean> {
  try {
    const store = new Store(outputDir);
    try {
      const row = store.db.prepare("SELECT id FROM scans WHERE finished_at IS NULL LIMIT 1").get() as
        | { id: number }
        | undefined;
      return !!row;
    } finally {
      store.close();
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "isScanRunningInDb failed");
    return false;
  }
}

function trDateParts(d: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value])) as Record<string, string>;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function trDateFromParts(p: { year: number; month: number; day: number; hour: number; minute: number }): Date {
  // Construct a UTC timestamp that corresponds to the requested TR local wall-clock time.
  const iso = `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:00+03:00`;
  return new Date(iso);
}

/** HH:MM in Europe/Istanbul — server TZ is UTC on the VPS, so toLocale* needs an explicit zone. */
function trTimeHHMM(d: Date): string {
  return d.toLocaleTimeString("tr-TR", { timeZone: "Europe/Istanbul", hour: "2-digit", minute: "2-digit" });
}

function getNextScheduledSlot(from = new Date()): Date {
  const tr = trDateParts(from);
  const dayStart = trDateFromParts({ year: tr.year, month: tr.month, day: tr.day, hour: 0, minute: 0 });
  // Slots every 2h anchored at 06:00 TR → covers overnight too: 06,08,...,22,00,02,04.
  // Walk the CONTINUOUS grid (dayStart + n·2h) instead of today's wall-clock
  // hours — the old code compared only today's slots, so after 22:xx TR the
  // 00/02/04 next-day slots were skipped straight to 06:00 next day.
  const gridStep = SCHEDULED_INTERVAL_HOURS * 60 * 60 * 1000;
  const firstSlot = dayStart.getTime() + SCHEDULED_FIRST_HOUR * 60 * 60 * 1000;
  const elapsed = from.getTime() - firstSlot;
  const stepsAhead = Math.max(1, Math.ceil(elapsed / gridStep));
  return new Date(firstSlot + stepsAhead * gridStep);
}

function jobsStatePath(outputDir: string): string {
  return resolve(outputDir, "panel-jobs.json");
}

function persistJobs(outputDir: string): void {
  try {
    mkdirSync(outputDir, { recursive: true });
    const list = Array.from(jobs.values())
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
      .slice(0, 40);
    writeFileSync(jobsStatePath(outputDir), JSON.stringify(list, null, 2), "utf8");
  } catch (err) {
    logger.debug({ err: String(err) }, "persistJobs failed");
  }
}

function loadPersistedJobs(outputDir: string): void {
  try {
    const p = jobsStatePath(outputDir);
    if (!existsSync(p)) return;
    const list = JSON.parse(readFileSync(p, "utf8")) as JobState[];
    if (!Array.isArray(list)) return;
    for (const j of list) {
      // Running jobs cannot survive process death — mark failed so panel is honest.
      if (j.status === "running") {
        j.status = "failed";
        j.message = "Sunucu yeniden başladı — iş yarıda kesildi";
        j.error = "server-restart";
        j.finishedAt = new Date().toISOString();
        j.updatedAt = j.finishedAt;
      }
      jobs.set(j.id, j);
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "loadPersistedJobs failed");
  }
}

function setJobState(jobId: string, update: Partial<JobState>): void {
  const state = jobs.get(jobId);
  if (!state) return;
  Object.assign(state, update, { updatedAt: new Date().toISOString() });
  emitEvent({ type: "job-update", job: { ...state } });
  try {
    const cfg = loadConfig();
    persistJobs(cfg.output.dir);
  } catch {
    /* */
  }
}

/** Wire any click engine event into live job progress (panel must never sit at 0% silently). */
function applyClickProgress(jobId: string, event: Record<string, unknown>): void {
  const state = jobs.get(jobId);
  if (!state || state.status !== "running") return;

  /** Total is locked once: planTotal / first totalJobs — never oscillates. */
  const lockedTotal = (): number => {
    const fromState = Number(state.details?.total ?? state.details?.planTotal ?? 0);
    const fromEvent = Number(event.total ?? event.totalJobs ?? 0);
    if (fromState > 0) return fromState;
    if (fromEvent > 0) return fromEvent;
    return 0;
  };

  if (event.type === "click-run-created" || event.type === "click-domain-start") {
    // Focus campaigns write cumulative counters via onState — resetting them
    // here (and re-locking total to the wave size) would fight that writer.
    if (state.details?.focus === true) return;
    // Per-domain phase: force new locked total (e.g. 10), do not keep previous 30.
    const total = Number(event.totalJobs ?? event.total ?? 0);
    const domain = String(event.domain ?? state.details?.currentDomain ?? "");
    setJobState(jobId, {
      progress: Math.max(state.progress || 0, 3),
      message: String(
        event.message ||
          (domain ? `domain ${domain} · total=${total}` : `run #${event.runId} · total=${total}`)
      ),
      details: {
        ...state.details,
        runId: event.runId ?? state.details?.runId,
        total,
        planTotal: total,
        currentDomain: domain || state.details?.currentDomain,
        domainIndex: event.domainIndex ?? state.details?.domainIndex,
        domainCount: event.domainCount ?? state.details?.domainCount,
        // Domain-local counters reset for display of X/total for this ad.
        completed: 0,
        failed: 0,
        captcha: 0,
        skipped: 0,
      },
    });
    return;
  }

  const completed = Number(event.completed ?? state.details?.completed ?? 0);
  const failed = Number(event.failed ?? state.details?.failed ?? 0);
  const captcha = Number(event.captcha ?? state.details?.captcha ?? 0);
  const skipped = Number(event.skipped ?? state.details?.skipped ?? 0);
  const running = Number(event.running ?? state.details?.running ?? 0);
  const pending = Number(event.pending ?? state.details?.pending ?? 0);
  const total = lockedTotal();
  const done = completed + failed + captcha + skipped;
  // Show activity even before first finish: opening browsers still counts as progress.
  let pct = 0;
  if (total > 0) {
    pct = Math.min(99, Math.round(((done + running * 0.35) / total) * 100));
  } else if (event.type === "click-progress" || event.type === "click-queue-ready") {
    pct = Math.max(state.progress || 0, 5);
  } else {
    pct = Math.min(99, (state.progress || 0) + 1);
  }

  setJobState(jobId, {
    progress: Math.max(state.progress || 0, pct),
    message: String(
      event.message ||
        `tık ${event.status || "…"} · ${event.domain || event.device || ""} · ${done}/${total || "?"}`
    ),
    details: {
      ...state.details,
      runId: event.runId ?? state.details?.runId,
      completed,
      failed,
      captcha,
      skipped,
      running,
      pending,
      total, // locked — do not recompute from done+remaining
      lastDomain: event.domain ?? state.details?.lastDomain,
      lastStatus: event.status ?? state.details?.lastStatus,
      lastEvent: event.type,
    },
  });
}

function wireClickEvents(jobId: string, event: Record<string, unknown>): void {
  emitEvent({ ...event, jobId });
  if (
    event.type === "click-done" ||
    event.type === "click-progress" ||
    event.type === "click-queue-ready" ||
    event.type === "click-run-created" ||
    event.type === "click-domain-start"
  ) {
    applyClickProgress(jobId, event);
  }
}

/**
 * Focus campaign from a finished scan: SERP #1 ad only, 2h windows, then rescan.
 * Panel "Tıkla" and auto-click both use this — not multi-domain 30-click batch.
 */
function startFocusCampaignJob(opts: {
  scanId: number;
  cfg: ReturnType<typeof loadConfig>;
  auto?: boolean;
  targetOverride?: ClickTarget;
}): { jobId: string; domain: string; presence: string; windowMinutes: number; planTotal: number } {
  if (activeCampaign?.status === "running") {
    throw new Error(`Zaten aktif kampanya var: ${activeCampaign.focusDomain} (${activeCampaign.id})`);
  }

  let picked;
  if (opts.targetOverride) {
    picked = {
      target: opts.targetOverride,
      bestPosition: 1,
      reason: `Swarm hedefi · ${opts.targetOverride.domain} · ${opts.targetOverride.targetDevice}`,
    };
  } else {
    const store = new Store(opts.cfg.output.dir);
    try {
      picked = pickTopAdFromScan(store, opts.scanId, "adaptive");
    } finally {
      store.close();
    }
  }
  if (!picked) {
    throw new Error("Bu taramada odaklanacak reklam yok");
  }

  const windowMinutes = opts.cfg.click.focusWindowMinutes ?? 120;
  const imp = picked.target.impressions ?? [];
  const budget = waveBudget(picked.target.targetDevice, {
    mobileHits: imp.filter((i) => i.device === "mobile").length,
    desktopHits: imp.filter((i) => i.device === "desktop").length,
  });
  const planTotal = budget.mobile + budget.desktop;
  const jobId = createJobId("click");
  const nowIso = new Date().toISOString();
  const ends = new Date(Date.now() + windowMinutes * 60_000).toISOString();

  jobs.set(jobId, {
    id: jobId,
    type: "click",
    status: "running",
    progress: 2,
    message: `FOCUS · #1 ${picked.target.domain} · ${windowMinutes}dk pencere · diğer reklamlar yok`,
    details: {
      scanId: opts.scanId,
      auto: !!opts.auto,
      focus: true,
      currentDomain: picked.target.domain,
      presence: picked.target.targetDevice,
      bestPosition: picked.bestPosition,
      windowMinutes,
      windowEndsAt: ends,
      total: planTotal,
      planTotal,
      planReason: picked.reason,
    },
    startedAt: nowIso,
    updatedAt: nowIso,
  });
  persistJobs(opts.cfg.output.dir);
  cancelFlags.set(jobId, false);

  emitEvent({
    type: "click-started",
    jobId,
    focus: true,
    domain: picked.target.domain,
    windowMinutes,
    planTotal,
    message: `Focus kampanya: sadece ${picked.target.domain} (${windowMinutes}dk, sonra yeniden tarama)`,
  });

  void (async () => {
    try {
      const finalState = await runFocusCampaign({
        config: opts.cfg,
        scanId: opts.scanId,
        campaignId: jobId,
        windowMinutes,
        mode: "adaptive",
        targetOverride: opts.targetOverride,
        hooks: {
          isCancelled: () => cancelFlags.get(jobId) === true,
          onState: (s) => {
            activeCampaign = s;
            const winTotal = planTotal;
            const endsAt = s.windowEndsAt;
            let progress = 5;
            if (s.windowStartedAt && s.windowEndsAt) {
              const start = new Date(s.windowStartedAt).getTime();
              const end = new Date(s.windowEndsAt).getTime();
              const now = Date.now();
              if (end > start) {
                progress = Math.min(95, Math.round(((now - start) / (end - start)) * 100));
              }
            }
            setJobState(jobId, {
              progress: s.status === "running" ? Math.max(3, progress) : 100,
              message: s.message,
              details: {
                ...(jobs.get(jobId)?.details ?? {}),
                focus: true,
                currentDomain: s.focusDomain,
                presence: s.presence,
                windowIndex: s.windowIndex,
                windowMinutes: s.windowMinutes,
                windowEndsAt: endsAt,
                wave: s.wave,
                completed: s.completedClicks,
                failed: s.failedClicks,
                skipped: s.skippedClicks,
                total: winTotal,
                planTotal: winTotal,
                lastScanId: s.lastScanId,
                campaignStatus: s.status,
              },
            });
          },
          onEvent: (event) => {
            emitEvent({ ...event, jobId });
            if (
              event.type === "click-done" ||
              event.type === "click-progress" ||
              event.type === "click-run-created"
            ) {
              applyClickProgress(jobId, event);
            }
          },
        },
      });

      activeCampaign = finalState;
      const st =
        finalState.status === "stopped"
          ? "cancelled"
          : finalState.status === "failed"
            ? "failed"
            : "completed";
      setJobState(jobId, {
        // A panel cancel must survive the engine's natural completion.
        status: jobs.get(jobId)?.status === "cancelled" ? "cancelled" : st,
        progress: 100,
        message: finalState.message,
        error: finalState.error,
        finishedAt: finalState.finishedAt ?? new Date().toISOString(),
        details: {
          ...(jobs.get(jobId)?.details ?? {}),
          focus: true,
          currentDomain: finalState.focusDomain,
          completed: finalState.completedClicks,
          failed: finalState.failedClicks,
          skipped: finalState.skippedClicks,
          windowIndex: finalState.windowIndex,
          campaignStatus: finalState.status,
        },
      });
      emitEvent({
        type: st === "completed" ? "click-completed" : "click-failed",
        jobId,
        focus: true,
        completed: finalState.completedClicks,
        failed: finalState.failedClicks,
        error: finalState.error,
      });
    } catch (err) {
      const msg = String(err);
      activeCampaign = null;
      setJobState(jobId, {
        status: "failed",
        message: msg,
        error: msg,
        finishedAt: new Date().toISOString(),
      });
      emitEvent({ type: "click-failed", jobId, error: msg });
    } finally {
      cancelFlags.delete(jobId);
    }
  })();

  return {
    jobId,
    domain: picked.target.domain,
    presence: picked.target.targetDevice,
    windowMinutes,
    planTotal,
  };
}

export function createWebServer(port: number): void {
  const app = express();
  app.use(express.json());

  // ── Panel auth (session cookie) ─────────────────────────────
  // Credentials: PANEL_USER / PANEL_PASSWORD env (defaults are local-dev only).
  const PANEL_USER = process.env.PANEL_USER || "admin";
  const PANEL_PASSWORD = process.env.PANEL_PASSWORD || "detect";
  const sessions = new Map<string, number>(); // token → expiresAt
  const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  const hasSession = (req: Request): boolean => {
    const m = /(?:^|;\s*)detect_session=([a-f0-9]{32,})/.exec(req.headers.cookie || "");
    if (!m) return false;
    const exp = sessions.get(m[1]!);
    if (!exp) return false;
    if (exp < Date.now()) {
      sessions.delete(m[1]!);
      return false;
    }
    return true;
  };

  app.post("/api/login", (req: Request, res: Response) => {
    const { user, password } = req.body ?? {};
    if (user === PANEL_USER && password === PANEL_PASSWORD) {
      const token = randomBytes(24).toString("hex");
      // Sweep expired tokens so the map cannot grow unbounded.
      for (const [t, exp] of sessions) if (exp < Date.now()) sessions.delete(t);
      sessions.set(token, Date.now() + SESSION_TTL_MS);
      res.setHeader(
        "Set-Cookie",
        `detect_session=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax`
      );
      res.json({ ok: true });
      return;
    }
    res.status(401).json({ error: "Kullanıcı adı veya şifre hatalı" });
  });

  app.post("/api/logout", (req: Request, res: Response) => {
    const m = /(?:^|;\s*)detect_session=([a-f0-9]{32,})/.exec(req.headers.cookie || "");
    if (m) sessions.delete(m[1]!);
    res.setHeader("Set-Cookie", "detect_session=; HttpOnly; Path=/; Max-Age=0");
    res.json({ ok: true });
  });

  // Page guard: unauthenticated visitors get the login screen, never the panel.
  app.use((req: Request, res: Response, next) => {
    if ((req.path === "/" || req.path === "/index.html") && !hasSession(req)) {
      res.sendFile(resolve(PUBLIC_DIR, "login.html"));
      return;
    }
    next();
  });

  app.use(express.static(PUBLIC_DIR));

  // API guard: everything under /api except login/logout requires a session.
  app.use("/api", (req: Request, res: Response, next) => {
    if (req.path === "/login" || req.path === "/logout") {
      next();
      return;
    }
    if (!hasSession(req)) {
      res.status(401).json({ error: "auth required" });
      return;
    }
    next();
  });

  const config = loadConfig();
  loadPersistedJobs(config.output.dir);

  // Clean up scans / click runs that were left open by crashed processes.
  try {
    const store = new Store(config.output.dir);
    const clickStore = new ClickStore(config.output.dir);
    // Reconcile any unfinished runs immediately (panel must not show fake running).
    const closedScans = store.closeOrphanedScans(new Date().toISOString());
    const closedClicks = clickStore.closeOrphanedRuns(new Date().toISOString());
    if (closedScans > 0 || closedClicks > 0) {
      logger.warn({ closedScans, closedClicks }, "closed orphaned runs on startup");
    }
    store.close();
    clickStore.close();
    persistJobs(config.output.dir);
  } catch (err) {
    logger.warn({ err: String(err) }, "failed to close orphaned runs on startup");
  }

  // SSE endpoint for real-time updates.
  app.get("/api/events", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const listener = (data: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    events.on("broadcast", listener);

    req.on("close", () => {
      events.off("broadcast", listener);
    });
  });

  /** Close scans stuck without finished_at (panel must never show fake "Devam ediyor"). */
  function closeStaleScans(store: Store, maxAgeMs = 3 * 60 * 60 * 1000): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const r = store.db
      .prepare(
        `UPDATE scans
         SET finished_at = ?,
             total_ads = (SELECT COUNT(*) FROM results WHERE results.scan_id = scans.id),
             notes = COALESCE(notes, '') || ' | auto-closed stale'
         WHERE finished_at IS NULL AND started_at < ?`
      )
      .run(new Date().toISOString(), cutoff);
    return Number(r.changes ?? 0);
  }

  function closeStaleClicks(cs: ClickStore, maxAgeMs = 45 * 60 * 1000): number {
    // Use reconcile path so counters are correct.
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    return cs.closeOrphanedRuns(cutoff);
  }

  /**
   * Status only "running" when a live in-memory job exists for this row.
   * Orphan unfinished rows → "stale" (never fake "Devam ediyor" in UI).
   */
  function scanRowStatus(row: { finished_at?: string | null; started_at?: string; id?: number }): string {
    if (row.finished_at) return "done";
    const byId = Array.from(jobs.values()).find(
      (j) => j.type === "scan" && j.status === "running" && Number(j.details?.scanId) === Number(row.id)
    );
    if (byId) return "running";
    // Any running scan job without scanId yet — only attach to newest open row < 4h
    const anyScan = Array.from(jobs.values()).find((j) => j.type === "scan" && j.status === "running");
    if (anyScan && row.started_at) {
      const age = Date.now() - new Date(row.started_at).getTime();
      if (age < 4 * 60 * 60 * 1000) return "running";
    }
    return "stale";
  }

  function clickRowStatus(row: { finished_at?: string | null; started_at?: string; id?: number }): string {
    if (row.finished_at) return "done";
    // Strict: only mark running when job explicitly references this runId.
    const byId = Array.from(jobs.values()).find(
      (j) => j.type === "click" && j.status === "running" && Number(j.details?.runId) === Number(row.id)
    );
    if (byId) return "running";
    // Job started but runId not assigned yet: only the newest open click row.
    const anyClick = Array.from(jobs.values()).find((j) => j.type === "click" && j.status === "running");
    if (anyClick && !anyClick.details?.runId && row.started_at) {
      const age = Date.now() - new Date(row.started_at).getTime();
      if (age < 15 * 60 * 1000) return "running";
    }
    return "stale";
  }

  /** Close DB runs that have no live job (panel refresh after crash must not stay running). */
  function reconcileLiveClickRuns(cs: ClickStore): void {
    const open = cs.db
      .prepare(`SELECT id, started_at FROM click_runs WHERE finished_at IS NULL`)
      .all() as Array<{ id: number; started_at: string }>;
    for (const row of open) {
      const live = Array.from(jobs.values()).some(
        (j) => j.type === "click" && j.status === "running" && Number(j.details?.runId) === Number(row.id)
      );
      if (live) continue;
      const liveNoId = Array.from(jobs.values()).some(
        (j) => j.type === "click" && j.status === "running" && !j.details?.runId
      );
      const age = Date.now() - new Date(row.started_at).getTime();
      // Allow brief window before runId is assigned.
      if (liveNoId && age < 8 * 60 * 1000) continue;
      cs.closeRunReconciled(row.id, "no live panel job");
    }
  }

  app.get("/api/status", async (req: Request, res: Response) => {
    let adsUp = false;
    try {
      const { AdsPowerClient } = await import("../adspower/client.js");
      const ads = new AdsPowerClient(config.adspower.baseUrl, config.adspower.apiKey, config.adspower.requestIntervalMs);
      adsUp = await ads.isUp();
    } catch {
      adsUp = false;
    }

    let vault = {
      total: 0,
      usable: 0,
      ready: 0,
      cooling: 0,
      recovering: 0,
      captcha: 0,
      quarantined: 0,
      effective: 0,
    };
    let lastScan: Record<string, unknown> | null = null;
    let lastClick: Record<string, unknown> | null = null;
    try {
      const store = new Store(config.output.dir);
      try {
        closeStaleScans(store);
        vault = store.ipTrust.summary();
        const scans = store.db
          .prepare(
            "SELECT id, started_at, finished_at, total_ads, keywords, devices, notes FROM scans ORDER BY id DESC LIMIT 1"
          )
          .all() as Array<Record<string, unknown>>;
        if (scans[0]) {
          lastScan = {
            ...scans[0],
            status: scanRowStatus(scans[0] as { finished_at?: string | null; started_at?: string; id?: number }),
          };
          try {
            const a = analyzeScanClones(store, Number(scans[0].id), { mode: "adaptive", brandKeywords: config.bettingKeywords });
            lastScan.cloneCount = a.cloneCount;
            lastScan.planTotal = a.totalClicks;
            lastScan.planMobile = a.totalMobileClicks;
            lastScan.planDesktop = a.totalDesktopClicks;
          } catch {
            /* */
          }
        }
      } finally {
        store.close();
      }
    } catch {
      /* */
    }

    try {
      const cs = new ClickStore(config.output.dir);
      try {
        closeStaleClicks(cs);
        const rows = cs.db
          .prepare(
            "SELECT id, started_at, finished_at, target_domain, target_device, total_jobs, completed_jobs, failed_jobs FROM click_runs ORDER BY id DESC LIMIT 1"
          )
          .all() as Array<Record<string, unknown>>;
        if (rows[0]) {
          lastClick = {
            ...rows[0],
            status: clickRowStatus(rows[0] as { finished_at?: string | null; started_at?: string; id?: number }),
          };
        }
      } finally {
        cs.close();
      }
    } catch {
      /* */
    }

    const activeJobs = Array.from(jobs.values())
      .filter((j) => j.status === "running")
      .map((j) => ({
        id: j.id,
        type: j.type,
        status: j.status,
        progress: j.progress,
        message: j.message,
        startedAt: j.startedAt,
        details: j.details,
      }));

    res.json({
      adsPower: { up: adsUp, url: config.adspower.baseUrl },
      vault,
      lastScan,
      lastClick,
      activeJobs,
      activeJobCount: activeJobs.length,
      config: {
        scanConcurrency: config.scan.concurrency,
        clickConcurrency: config.click.concurrency,
        scanMaxProfilesPerDevice: config.scan.maxProfilesPerDevice,
        clickMaxProfilesPerDevice: config.click.maxProfilesPerDevice,
        autoFocusCampaignAfterScan: config.scan.autoFocusCampaignAfterScan,
        focusWindowMinutes: config.click.focusWindowMinutes ?? 120,
      },
    });
  });

  /** Single ops snapshot for the lean panel. */
  app.get("/api/ops", async (req: Request, res: Response) => {
    const statusRes = await new Promise<Record<string, unknown>>((resolvePromise) => {
      // reuse status logic via internal call pattern — call handlers duplicated light
      void (async () => {
        // Build via fetch-free duplicate: just re-read
        let adsUp = false;
        try {
          const { AdsPowerClient } = await import("../adspower/client.js");
          const ads = new AdsPowerClient(
            config.adspower.baseUrl,
            config.adspower.apiKey,
            config.adspower.requestIntervalMs
          );
          adsUp = await ads.isUp();
        } catch {
          adsUp = false;
        }
        let vault: Record<string, unknown> = { total: 0, usable: 0, cooling: 0, recovering: 0, captcha: 0, quarantined: 0, effective: 0 };
        let scans: Record<string, unknown>[] = [];
        try {
          const store = new Store(config.output.dir);
          try {
            closeStaleScans(store);
            vault = store.ipTrust.summary();
            scans = (
              store.db
                .prepare(
                  "SELECT id, started_at, finished_at, total_ads, keywords, devices, notes FROM scans ORDER BY id DESC LIMIT 15"
                )
                .all() as Array<Record<string, unknown>>
            ).map((s) => ({
              ...s,
              status: scanRowStatus(s as { finished_at?: string | null; started_at?: string; id?: number }),
            }));
          } finally {
            store.close();
          }
        } catch {
          /* */
        }

        let clicks: Record<string, unknown>[] = [];
        try {
          const cs = new ClickStore(config.output.dir);
          try {
            closeStaleClicks(cs);
            reconcileLiveClickRuns(cs);
            // Live ok/fail/skip from clicks table; total_jobs stays as locked plan size.
            clicks = (
              cs.db
                .prepare(
                  "SELECT id, started_at, finished_at, target_domain, target_device, total_jobs, completed_jobs, failed_jobs, captcha_jobs, skipped_jobs FROM click_runs ORDER BY id DESC LIMIT 15"
                )
                .all() as Array<Record<string, unknown>>
            ).map((c) => {
              const id = Number(c.id);
              if (!c.finished_at) {
                const live = cs.statsForRun(id);
                if (live.total > 0) {
                  c.completed_jobs = live.completed;
                  c.failed_jobs = live.failed;
                  c.captcha_jobs = live.captcha;
                  c.skipped_jobs = live.skipped;
                  // Do NOT inflate total_jobs from live click count — total is the locked plan.
                }
              }
              return {
                ...c,
                status: clickRowStatus(c as { finished_at?: string | null; started_at?: string; id?: number }),
              };
            });
          } finally {
            cs.close();
          }
        } catch {
          /* */
        }

        const jobList = Array.from(jobs.values())
          .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
          .slice(0, 20)
          .map((j) => ({
            id: j.id,
            type: j.type,
            status: j.status,
            progress: j.progress,
            message: j.message,
            startedAt: j.startedAt,
            finishedAt: j.finishedAt,
            updatedAt: j.updatedAt,
            details: j.details,
            error: j.error,
          }));

        resolvePromise({
          adsPower: { up: adsUp },
          vault,
          jobs: jobList,
          scans,
          clicks,
          campaign: activeCampaign,
          scheduledScan: { ...scheduledScan, scanRunning: isScanRunning() },
          solverCost: solverCostSummary(config.output.dir),
          config: {
            scanConcurrency: config.scan.concurrency,
            clickConcurrency: config.click.concurrency,
            scanMaxProfilesPerDevice: config.scan.maxProfilesPerDevice,
            clickMaxProfilesPerDevice: config.click.maxProfilesPerDevice,
            autoFocusCampaignAfterScan: config.scan.autoFocusCampaignAfterScan,
            focusWindowMinutes: config.click.focusWindowMinutes ?? 120,
          },
        });
      })();
    });
    res.json(statusRes);
  });

  app.get("/api/ops/results", (req: Request, res: Response) => {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit || "10"), 10) || 10));
    const store = new ClickStore(config.output.dir);
    try {
      const { total, results } = store.operationResults(page, limit);
      res.json({ total, page, limit, results });
    } finally {
      store.close();
    }
  });

  /**
   * Customer-facing proof panel: every submitted ad report as a distinguishable
   * row — timestamp, keyword, target domain, device, the pool email used, the
   * outcome, and Google's notification id read from that email's inbox.
   * Filters: ?keyword= &domain= &operation= (operation_id of the click run).
   */
  const googleMailCache = new Map<string, { subject: string; date: string; notifId?: string | null; outcomeSubject?: string | null; fetchedAt: number }>();

  function submittedFilter(req: Request): { where: string; params: string[] } {
    const parts: string[] = [`c.report_status IN ('submitted','filled','submit-failed')`];
    const params: string[] = [];
    const keyword = String(req.query.keyword || "").trim().toLowerCase();
    const domain = String(req.query.domain || "").trim().toLowerCase();
    const operation = String(req.query.operation || "").trim();
    if (keyword) {
      parts.push(`LOWER(c.keyword) LIKE ?`);
      params.push(`%${keyword}%`);
    }
    if (domain) {
      parts.push(`LOWER(c.target_domain) LIKE ?`);
      params.push(`%${domain}%`);
    }
    const device = String(req.query.device || "").trim();
    if (device === "mobile" || device === "desktop") {
      parts.push(`c.device = ?`);
      params.push(device);
    }
    if (operation) {
      parts.push(`r.operation_id = ?`);
      params.push(operation);
    }
    return { where: parts.join(" AND "), params };
  }

  /** Profile health grid: ip_trust status per profile (usable / captcha / cooling). */
  app.get("/api/profiles/health", (req: Request, res: Response) => {
    const store = new Store(config.output.dir);
    try {
      const rows = store.db
        .prepare(
          `SELECT profile_id, name, device, status, consecutive_fails, total_solves, next_retry_at, last_clean_at, last_error, updated_at
           FROM ip_trust ORDER BY status, device, profile_id`
        )
        .all() as Array<Record<string, unknown>>;
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      // A one-off failure from days ago is NOT a health problem — profiles
      // recover (Google forgives, trend warm-ups succeed). "captcha" only
      // counts CURRENT issues: in cooldown or failed within the last 48h.
      const RECENT_FAIL_MS = 48 * 60 * 60 * 1000;
      res.json({
        profiles: rows.map((r) => {
          const rawStatus = String(r.status ?? "usable");
          const cooling = !!(r.next_retry_at && String(r.next_retry_at) > nowIso);
          const lastChangeMs = r.updated_at ? Date.parse(String(r.updated_at)) : 0;
          const recentFail = lastChangeMs > 0 && nowMs - lastChangeMs < RECENT_FAIL_MS;
          let displayStatus = rawStatus;
          // Stale one-off failure (no active cooldown, nothing in 48h) = usable.
          if ((rawStatus === "captcha" || rawStatus === "quarantined") && !cooling && !recentFail) {
            displayStatus = "usable";
          }
          return {
            id: String(r.profile_id),
            name: String(r.name || r.profile_id),
            device: String(r.device ?? ""),
            status: displayStatus,
            consecutiveFails: Number(r.consecutive_fails ?? 0),
            totalSolves: Number(r.total_solves ?? 0),
            cooling,
            nextRetryAt: r.next_retry_at ? String(r.next_retry_at) : null,
            lastError: r.last_error ? String(r.last_error).slice(0, 120) : null,
          };
        }),
      });
    } finally {
      store.close();
    }
  });
  /** KPI: SERP presence heatmap — per domain, per day, was the ad served? */
  app.get("/api/kpi/presence", (req: Request, res: Response) => {
    const days = Math.max(3, Math.min(30, parseInt(String(req.query.days || "14"), 10) || 14));
    const store = new Store(config.output.dir);
    try {
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const rows = store.db
        .prepare(
          `SELECT substr(captured_at, 1, 10) AS day, display_domain, COUNT(*) AS hits
           FROM results
           WHERE captured_at >= ? AND display_domain != '' AND display_domain NOT LIKE '%google%'
           GROUP BY day, display_domain`
        )
        .all(since) as Array<{ day: string; display_domain: string; hits: number }>;
      const byDomain = new Map<string, Map<string, number>>();
      for (const r of rows) {
        let m = byDomain.get(r.display_domain);
        if (!m) byDomain.set(r.display_domain, (m = new Map()));
        m.set(r.day, (m.get(r.day) ?? 0) + Number(r.hits));
      }
      const dayList: string[] = [];
      for (let i = days - 1; i >= 0; i--) dayList.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
      const domains = [...byDomain.entries()]
        .map(([domain, m]) => ({
          domain,
          total: [...m.values()].reduce((a, b) => a + b, 0),
          days: dayList.map((d) => m.get(d) ?? 0),
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 12);
      res.json({ days: dayList, domains });
    } finally {
      store.close();
    }
  });

  app.get("/api/reports/submitted", async (req: Request, res: Response) => {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.max(1, Math.min(50, parseInt(String(req.query.limit || "5"), 10) || 5));
    const store = new ClickStore(config.output.dir);
    try {
      const { where, params } = submittedFilter(req);
      const countRow = store.db
        .prepare(`SELECT COUNT(*) AS c FROM clicks c LEFT JOIN click_runs r ON c.run_id = r.id WHERE ${where}`)
        .get(...params) as { c: number };
      const rows = store.db
        .prepare(
          `SELECT c.id, c.run_id, c.job_id, c.keyword, c.target_domain, c.device, c.profile_id, c.status, c.report_status, c.report_message, c.captured_at
           FROM clicks c LEFT JOIN click_runs r ON c.run_id = r.id
           WHERE ${where}
           ORDER BY c.captured_at DESC, c.id DESC LIMIT ? OFFSET ?`
        )
        .all(...params, limit, (page - 1) * limit) as Array<Record<string, unknown>>;

      const pool = getEmailPool(config.output.dir);
      const results = [];
      for (const r of rows) {
        const msg = String(r.report_message || "");
        const mailMatch = /mail (?:pool|static):(\S+)/.exec(msg);
        const email = mailMatch?.[1] ?? null;
        let google: { subject: string; date: string; notifId?: string | null; outcomeSubject?: string | null } | null = null;
        if (email) {
          // Cache per email+report-hour — the same pool address serves many
          // reports, and the correct confirmation differs by report time.
          const cacheKey = `${email}|${String(r.captured_at ?? "").slice(0, 13)}`;
          const cached = googleMailCache.get(cacheKey);
          if (cached && Date.now() - cached.fetchedAt < 10 * 60_000) {
            google = cached;
          } else {
            const full = await pool.latestGoogleNotificationFull(email, String(r.captured_at ?? "")).catch(() => null);
            if (full) {
              google = full;
              googleMailCache.set(cacheKey, { ...full, fetchedAt: Date.now() });
            }
          }
        }
        const notifId = google?.notifId ?? (google ? (/\b(\d{10,})\b/.exec(google.subject)?.[1] ?? null) : null);
        results.push({
          id: Number(r.id),
          capturedAt: String(r.captured_at ?? ""),
          keyword: String(r.keyword ?? ""),
          domain: String(r.target_domain ?? ""),
          device: String(r.device ?? ""),
          profileId: String(r.profile_id ?? ""),
          clickStatus: String(r.status ?? ""),
          reportStatus: String(r.report_status ?? ""),
          email,
          googleNotifId: notifId,
          googleOutcome: google?.outcomeSubject ?? null,
          evidenceUrl: `/api/reports/evidence-img?run=${Number(r.run_id)}&job=${encodeURIComponent(String(r.job_id ?? ""))}&name=04-report-submitted.jpg`,
        });
      }
      res.json({ total: Number(countRow.c) || 0, page, limit, results });
    } finally {
      store.close();
    }
  });

  /** Export ALL matching reports as a styled Excel workbook (default) or CSV
   *  (?format=csv). Same filters, no pagination. Google notif ids come from
   *  the cache only — export never hammers mail.tm. */
  app.get("/api/reports/submitted/export", async (req: Request, res: Response) => {
    const store = new ClickStore(config.output.dir);
    try {
      const { where, params } = submittedFilter(req);
      const rows = store.db
        .prepare(
          `SELECT c.captured_at, c.keyword, c.target_domain, c.device, c.status, c.report_status, c.report_message, r.operation_id
           FROM clicks c LEFT JOIN click_runs r ON c.run_id = r.id
           WHERE ${where}
           ORDER BY c.captured_at DESC, c.id DESC LIMIT 5000`
        )
        .all(...params) as Array<Record<string, unknown>>;

      const extractMail = (m: unknown) => /mail (?:pool|static):(\S+)/.exec(String(m || ""))?.[1] ?? "";
      const kw = String(req.query.keyword || "").trim();
      const dom = String(req.query.domain || "").trim();
      const op = String(req.query.operation || "").trim();

      if (String(req.query.format || "") === "csv") {
        const esc = (v: unknown) => {
          const s = String(v ?? "");
          return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
        };
        const lines = ["date,keyword,domain,device,click_status,report_status,email,operation"];
        for (const r of rows) {
          lines.push(
            [esc(r.captured_at), esc(r.keyword), esc(r.target_domain), esc(r.device), esc(r.status), esc(r.report_status), esc(extractMail(r.report_message)), esc(r.operation_id ?? "")].join(",")
          );
        }
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="sikayetler.csv"`);
        res.send(lines.join("\n"));
        return;
      }

      // ── Styled .xlsx ──
      const { default: ExcelJS } = await import("exceljs");
      const wb = new ExcelJS.Workbook();
      wb.creator = "Detect Ops Center";
      const ws = wb.addWorksheet("Şikayet Kanıtları", { views: [{ state: "frozen", ySplit: 4 }] });

      // Title + filter meta
      ws.mergeCells("A1:H1");
      ws.getCell("A1").value = "GOOGLE ADS ŞİKAYET KANITLARI";
      ws.getCell("A1").font = { bold: true, size: 14, color: { argb: "FF06281C" } };
      ws.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF34D399" } };
      ws.getCell("A1").alignment = { horizontal: "center", vertical: "middle" };
      ws.getRow(1).height = 26;

      ws.mergeCells("A2:H2");
      const filters = [kw && `keyword: ${kw}`, dom && `domain: ${dom}`, op && `operasyon: ${op}`].filter(Boolean).join(" · ") || "tümü";
      ws.getCell("A2").value = `Detect Ops Center · üretim: ${new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })} · filtre: ${filters} · kayıt: ${rows.length}`;
      ws.getCell("A2").font = { size: 10, color: { argb: "FF636E7D" } };
      ws.getRow(2).height = 16;
      ws.getRow(3).height = 6;

      const header = ["Tarih", "Keyword", "Domain", "Cihaz", "Tık", "Şikayet", "Mail", "Operasyon"];
      const headerRow = ws.getRow(4);
      headerRow.values = header;
      headerRow.font = { bold: true, size: 11, color: { argb: "FFFFFFFF" } };
      headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B3D2E" } };
      headerRow.alignment = { horizontal: "center", vertical: "middle" };
      headerRow.height = 20;

      ws.columns = [
        { width: 20 }, { width: 14 }, { width: 26 }, { width: 10 },
        { width: 10 }, { width: 14 }, { width: 34 }, { width: 24 },
      ];

      const statusFill: Record<string, string> = {
        submitted: "FFD1FAE5",
        filled: "FFDBEAFE",
        "submit-failed": "FFFEE2E2",
      };
      const statusText: Record<string, string> = {
        submitted: "GÖNDERİLDİ",
        filled: "DOLDURULDU",
        "submit-failed": "BAŞARISIZ",
      };

      rows.forEach((r, i) => {
        const row = ws.getRow(5 + i);
        const dt = String(r.captured_at ?? "").replace("T", " ").slice(0, 19);
        row.values = [
          dt,
          String(r.keyword ?? ""),
          String(r.target_domain ?? ""),
          String(r.device ?? "") === "mobile" ? "Mobil" : "Masaüstü",
          String(r.status ?? ""),
          statusText[String(r.report_status ?? "")] ?? String(r.report_status ?? ""),
          extractMail(r.report_message),
          String(r.operation_id ?? ""),
        ];
        row.font = { size: 10 };
        row.alignment = { vertical: "middle" };
        if (i % 2 === 1) row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };
        const statusCell = row.getCell(6);
        const fill = statusFill[String(r.report_status ?? "")];
        if (fill) statusCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
        statusCell.font = { size: 10, bold: true };
        row.eachCell((cell) => {
          cell.border = { bottom: { style: "thin", color: { argb: "FFE5E7EB" } } };
        });
      });

      ws.autoFilter = { from: "A4", to: "H4" };

      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="sikayet-kanitlari-${stamp}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } finally {
      store.close();
    }
  });

  /** The Google notification email itself, rendered as a proof page (scripts stripped). */
  app.get("/api/reports/email-html", async (req: Request, res: Response) => {
    try {
      const address = String(req.query.address || "");
      if (!/^[^@\s]+@[^@\s]+$/.test(address)) {
        res.status(400).json({ error: "bad address" });
        return;
      }
      const pool = getEmailPool(config.output.dir);
      const mail = await pool.latestGoogleNotificationFull(address).catch(() => null);
      if (!mail) {
        res.status(404).send("<h3 style='font-family:sans-serif'>Bu adreste Google bildirimi bulunamadı (henüz gelmemiş olabilir).</h3>");
        return;
      }
      const safeBody = mail.html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/ on\w+="[^"]*"/gi, "");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Google Bildirimi</title>
        <style>body{font-family:Arial,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#202124}
        .head{border-bottom:3px solid #1a73e8;padding-bottom:12px;margin-bottom:16px}
        .subject{font-size:18px;font-weight:700}.meta{color:#5f6368;font-size:13px;margin-top:4px}
        .proof{background:#e6f4ea;border:1px solid #13733333;border-radius:8px;padding:10px 14px;font-size:13px;margin-bottom:16px}</style></head>
        <body><div class="head"><div class="subject">${mail.subject.replace(/</g, "&lt;")}</div>
        <div class="meta">Kimden: ads-support-noreply@google.com · Kime: ${address} · Tarih: ${mail.date}</div></div>
        <div class="proof">Detect Ops Center — bu e-posta, yukarıdaki adrese yapılan reklam şikayetine Google'ın verdiği resmi onaydır.</div>
        ${safeBody}</body></html>`);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /** Evidence screenshots for submitted reports — path-guarded to the reports dir. */
  app.get("/api/reports/evidence-img", (req: Request, res: Response) => {
    try {
      const run = String(req.query.run || "").replace(/[^0-9]/g, "");
      const job = String(req.query.job || "").replace(/[^a-zA-Z0-9._-]/g, "");
      const name = String(req.query.name || "").replace(/[^a-zA-Z0-9.-]/g, "");
      // Accept .jpg (new) and .png (legacy files from before the format switch).
      if (!run || !job || !/\.(jpe?g|png)$/.test(name)) {
        res.status(404).end();
        return;
      }
      const base = resolve(config.output.dir, "screenshots", "reports", `run-${run}`, job);
      const file = resolve(base, name);
      if (!file.startsWith(base) || !existsSync(file)) {
        res.status(404).end();
        return;
      }
      // Evidence files are immutable once written — cache hard in the browser.
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.sendFile(file);
    } catch {
      res.status(404).end();
    }
  });

  /** Server-side paginated scans — panel pager must cover ALL scans, not a 15-row window. */
  /** Enable/disable the scheduled scan cron (keeps the same 2h slots when re-enabled). */
  app.post("/api/scheduled-scan/enabled", (req: Request, res: Response) => {
    scheduledScan.enabled = req.body?.enabled !== false;
    if (scheduledScan.enabled) {
      // Re-arm on the regular slot grid (06:00, 08:00, …) — no custom drift.
      scheduledScan.nextAt = getNextScheduledSlot().toISOString();
    }
    emitEvent({
      type: "scheduled-scan-toggled",
      enabled: scheduledScan.enabled,
      nextAt: scheduledScan.nextAt,
      message: scheduledScan.enabled
        ? `Otomatik tarama açıldı · sıradaki slot: ${trTimeHHMM(new Date(scheduledScan.nextAt ?? Date.now()))}`
        : "Otomatik tarama kapatıldı",
    });
    res.json({ ok: true, enabled: scheduledScan.enabled, nextAt: scheduledScan.nextAt });
  });

  app.get("/api/scans/paged", (req: Request, res: Response) => {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.max(1, Math.min(50, parseInt(String(req.query.limit || "5"), 10) || 5));
    const store = new Store(config.output.dir);
    try {
      closeStaleScans(store);
      const total = Number((store.db.prepare("SELECT COUNT(*) AS c FROM scans").get() as { c: number }).c) || 0;
      const scans = (
        store.db
          .prepare(
            `SELECT s.id, s.started_at, s.finished_at, s.keywords, s.devices, s.notes,
                    MAX(s.total_ads, (SELECT COUNT(*) FROM results r WHERE r.scan_id = s.id)) AS total_ads
             FROM scans s ORDER BY s.id DESC LIMIT ? OFFSET ?`
          )
          .all(limit, (page - 1) * limit) as Array<Record<string, unknown>>
      ).map((s) => ({
        ...s,
        status: scanRowStatus(s as { finished_at?: string | null; started_at?: string; id?: number }),
      }));
      res.json({ total, page, limit, scans });
    } finally {
      store.close();
    }
  });

  app.get("/api/scans", (req: Request, res: Response) => {
    const store = new Store(config.output.dir);
    try {
      closeStaleScans(store);
      const rows = (
        store.db
          .prepare(
            `SELECT s.id, s.started_at, s.finished_at, s.keywords, s.devices, s.notes,
                    MAX(s.total_ads, (SELECT COUNT(*) FROM results r WHERE r.scan_id = s.id)) AS total_ads
             FROM scans s ORDER BY s.id DESC LIMIT 50`
          )
          .all() as Array<Record<string, unknown>>
      ).map((s) => ({
        ...s,
        status: scanRowStatus(s as { finished_at?: string | null; started_at?: string; id?: number }),
      }));
      res.json(rows);
    } finally {
      store.close();
    }
  });

  app.get("/api/scans/:id", (req: Request, res: Response) => {
    const store = new Store(config.output.dir);
    try {
      const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const scanId = parseInt(idParam || "0", 10);
      const run = store.db.prepare("SELECT * FROM scans WHERE id = ?").get(scanId) as Record<string, unknown> | undefined;
      const clicks = store.resultsForScan(scanId);
      const mode = (req.query.mode as ClickMode) || "adaptive";
      const cloneAnalysis = analyzeScanClones(store, scanId, { mode, brandKeywords: config.bettingKeywords });
      res.json({ run, clicks, cloneAnalysis });
    } finally {
      store.close();
    }
  });

  /** Clone detection + device presence + recommended click plan for a finished scan. */
  app.get("/api/scans/:id/clones", (req: Request, res: Response) => {
    const store = new Store(config.output.dir);
    try {
      const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const scanId = parseInt(idParam || "0", 10);
      const mode = (req.query.mode as ClickMode) || "adaptive";
      const analysis = analyzeScanClones(store, scanId, { mode, brandKeywords: config.bettingKeywords });
      res.json(analysis);
    } finally {
      store.close();
    }
  });

  app.post("/api/scans/start", async (req: Request, res: Response) => {
    const { brands, devices, concurrency, expandBrands, clearProfile } = req.body;
    if (!Array.isArray(brands) || brands.length === 0) {
      res.status(400).json({ error: "brands array required" });
      return;
    }
    if (isScanRunning()) {
      res.status(409).json({ error: "Zaten çalışan bir tarama var" });
      return;
    }
    const cleanBrands = brands
      .map((b: string) => b.trim().toLocaleLowerCase("tr"))
      .filter(Boolean);
    try {
      const jobId = startScanJob({ brands: cleanBrands, devices, concurrency, expandBrands, clearProfile });
      res.json({ jobId, status: "started" });
    } catch (err) {
      res.status(409).json({ error: String(err) });
    }
  });

  function startScanJob(opts: {
    brands: string[];
    devices?: string;
    concurrency?: number;
    expandBrands?: boolean;
    clearProfile?: boolean;
    auto?: boolean;
    scheduled?: boolean;
  }): string {
    // Load guard: a scan during an active click campaign would double the
    // browser load and muddle presence data (the campaign already re-scans
    // inside its own 2h windows via runScan, unaffected by this guard).
    if (
      activeCampaign?.status === "running" ||
      Array.from(jobs.values()).some((j) => j.type === "click" && j.status === "running")
    ) {
      throw new Error("Tıklama operasyonu sürüyor — bitince tarama başlatabilirsin");
    }
    // DB-level guard: two Node processes or a race inside the same process
    // must not start parallel scans against the same SQLite DB.
    try {
      const guardStore = new Store(config.output.dir);
      try {
        const running = guardStore.db.prepare("SELECT id FROM scans WHERE finished_at IS NULL LIMIT 1").get() as
          | { id: number }
          | undefined;
        if (running) {
          throw new Error(`Başka bir tarama zaten çalışıyor (scan #${running.id})`);
        }
      } finally {
        guardStore.close();
      }
    } catch (err) {
      if (String(err).includes("Başka bir tarama")) throw err;
      logger.warn({ err: String(err) }, "scan start DB guard failed");
    }

    const jobId = createJobId("scan");
    const scanStart = new Date().toISOString();
    jobs.set(jobId, {
      id: jobId,
      type: "scan",
      status: "running",
      progress: 0,
      message: "Preparing scan...",
      details: { brands: opts.brands, devices: opts.devices, concurrency: opts.concurrency, expandBrands: opts.expandBrands, auto: opts.auto, scheduled: opts.scheduled },
      startedAt: scanStart,
      updatedAt: scanStart,
    });
    persistJobs(config.output.dir);

    void (async () => {
      try {
        const cfg = loadConfig();
        if (opts.devices) {
          if (opts.devices === "both") cfg.devices = ["desktop", "mobile"];
          else if (opts.devices === "mobile") cfg.devices = ["mobile"];
          else if (opts.devices === "desktop") cfg.devices = ["desktop"];
          else if (Array.isArray(opts.devices)) cfg.devices = opts.devices as Device[];
        }
        if (opts.concurrency && opts.concurrency > 0) cfg.scan.concurrency = opts.concurrency;
        cfg.scan.clearProfileData = opts.clearProfile === true;
        cfg.scan.queriesPerProfile = 1;

        // Scheduled scans use a slim variant set (4 keywords/brand) to protect
        // the 2h cadence and IP budget; manual "Varyant ekle" keeps the full 9.
        let keywords =
          opts.expandBrands === true
            ? expandBrandKeywords(opts.brands, opts.scheduled ? SCHEDULED_SLIM_SUFFIXES : undefined)
            : opts.brands;
        const totalKeywords = keywords.length;

        emitEvent({
          type: "scan-started",
          jobId,
          brands: opts.brands,
          totalKeywords,
          devices: cfg.devices,
          message: `Trend-safe tarama · ${totalKeywords} sorgu · ${cfg.devices.join("+")}`,
        });
        setJobState(jobId, {
          progress: 5,
          message: `Başladı: önce trend warm-up, sonra marka (${keywords.join(", ")})`,
        });

        const approxUnits = Math.max(1, (cfg.devices?.length || 2) * 5 * Math.max(1, totalKeywords));
        let unitsDone = 0;

        emitEvent({
          type: "scan-progress",
          jobId,
          message: `Tarama sürüyor · ${totalKeywords} sorgu · ${cfg.devices.join("+")} · profil havuzu açılıyor…`,
          phase: "starting",
        });

        const abortController = new AbortController();
        scanAbortControllers.set(jobId, abortController);
        let summary;
        try {
          summary = await runScan(
            cfg,
            keywords,
            (event) => {
            emitEvent({ ...event, jobId });
            if (event.type === "scan-progress" && (event as { phase?: string }).phase === "swarm-locked") {
              const target = (event as { target?: ClickTarget }).target;
              const scanId = Number((event as { scanId?: number }).scanId ?? 0);
              if (target && scanId && !(activeCampaign?.status === "running")) {
                try {
                  const started = startFocusCampaignJob({ scanId, cfg, auto: true, targetOverride: target });
                  logger.info({ jobId, scanId, domain: started.domain }, "swarm-locked: focus campaign started from scan event");
                  // Mark scan job as done so panel no longer shows it as running.
                  setJobState(jobId, {
                    status: "completed",
                    progress: 100,
                    message: `Reklam bulundu · ${started.domain} · tık-şikayet operasyonu başladı`,
                    finishedAt: new Date().toISOString(),
                  });
                } catch (err) {
                  logger.warn({ jobId, scanId, err: String(err) }, "swarm-locked: focus campaign could not start");
                }
              }
            }
            if (
              event.type === "scan-progress" ||
              event.type === "profile-ready" ||
              event.type === "keyword-done" ||
              event.type === "ad-found" ||
              event.type === "click-done" ||
              event.type === "click-started" ||
              event.type === "click-completed"
            ) {
              if (event.type === "keyword-done" || event.type === "profile-ready") unitsDone += 1;
              else if (event.type === "scan-progress" && (event as { phase?: string }).phase === "profile-closed") {
                unitsDone += 0.25;
              } else if (event.type === "click-done") {
                unitsDone += 0.15;
              }
              const pct = Math.min(92, 8 + Math.round((unitsDone / approxUnits) * 84));
              const msg = String(
                (event as { message?: string }).message ||
                  (event.type === "keyword-done"
                    ? `keyword-done · ${(event as { device?: string }).device || ""} · ${(event as { keyword?: string }).keyword || ""}`
                    : event.type === "click-done"
                      ? `inline tık · ${(event as { domain?: string }).domain || ""} · ${(event as { status?: string }).status || ""}`
                      : event.type)
              );
              setJobState(jobId, {
                status: jobs.get(jobId)?.status === "running" ? "running" : jobs.get(jobId)?.status,
                progress: Math.max(jobs.get(jobId)?.progress ?? 5, pct),
                message: msg,
                details: {
                  ...jobs.get(jobId)?.details,
                  lastEvent: event.type,
                  lastPhase: (event as { phase?: string }).phase || null,
                  inlineClicks: event.type === "click-done" ? (Number(jobs.get(jobId)?.details?.inlineClicks ?? 0) + 1) : jobs.get(jobId)?.details?.inlineClicks,
                },
              });
            }
          },
            { protectPool: true, signal: abortController.signal }
          );
        } finally {
          scanAbortControllers.delete(jobId);
        }

        // Bail out if the job was cancelled mid-scan — never resurrect it and
        // never let a cancelled scan auto-start a focus campaign.
        if (jobs.get(jobId)?.status !== "running") return;

        const hasAds = summary.totalAds > 0;
        const postScanMessage = hasAds
          ? `SERP bitti · ${summary.totalAds} reklam bulundu · tık/şikayet planı hazırlanıyor (scan #${summary.scanId})…`
          : `SERP bitti · reklam bulunamadı, tık/şikayet planı yapılmayacak`;
        setJobState(jobId, {
          status: "running",
          progress: 94,
          message: postScanMessage,
          details: {
            ...jobs.get(jobId)?.details,
            scanId: summary.scanId,
            totalAds: summary.totalAds,
            bettingAds: summary.bettingAds,
          },
        });
        emitEvent({
          type: "scan-progress",
          jobId,
          scanId: summary.scanId,
          message: postScanMessage,
          phase: hasAds ? "click-plan" : "no-ads",
        });

        const store = new Store(cfg.output.dir);
        let cloneAnalysis;
        try {
          cloneAnalysis = analyzeScanClones(store, summary.scanId, { mode: "adaptive", brandKeywords: cfg.bettingKeywords });
        } finally {
          store.close();
        }

        setJobState(jobId, {
          status: "completed",
          progress: 100,
          message: `Tarama bitti: ${cloneAnalysis.cloneCount} domain, plan ${cloneAnalysis.totalClicks} tık (${cloneAnalysis.totalMobileClicks}M+${cloneAnalysis.totalDesktopClicks}D)`,
          details: {
            scanId: summary.scanId,
            totalAds: summary.totalAds,
            bettingAds: summary.bettingAds,
            cloneCount: cloneAnalysis.cloneCount,
            clickPlan: {
              mobile: cloneAnalysis.totalMobileClicks,
              desktop: cloneAnalysis.totalDesktopClicks,
              total: cloneAnalysis.totalClicks,
            },
          },
          finishedAt: new Date().toISOString(),
        });

        emitEvent({
          type: "scan-completed",
          jobId,
          scanId: summary.scanId,
          totalAds: summary.totalAds,
          bettingAds: summary.bettingAds,
          bettingHits: summary.bettingHits,
          cloneAnalysis,
        });

        // Ad reporting is now performed inside each focus click profile before the click.
        if (cfg.scan.autoFocusCampaignAfterScan && cloneAnalysis.totalClicks > 0 && cloneAnalysis.cloneCount > 0) {
          try {
            if (!(activeCampaign?.status === "running")) {
              startFocusCampaignJob({ scanId: summary.scanId, cfg, auto: true });
            }
          } catch (err) {
            logger.warn({ err: String(err) }, "auto focus campaign start failed");
            // Must carry a message — otherwise the terminal shows the scan
            // stuck at "plan hazırlanıyor" with no explanation (seen live).
            emitEvent({
              type: "click-failed",
              error: String(err),
              auto: true,
              message: `Kampanya başlatılamadı: ${String(err).slice(0, 120)}`,
            });
          }
        }
      } catch (err) {
        const msg = String(err);
        // Do not overwrite a user-initiated cancel with "failed".
        const cur = jobs.get(jobId)?.status;
        setJobState(jobId, { status: cur === "cancelled" ? "cancelled" : "failed", message: msg, error: msg, finishedAt: new Date().toISOString() });
        emitEvent({ type: "scan-failed", jobId, error: msg });
      }
    })();

    return jobId;
  }

  function startScheduledScanCron(): void {
    scheduledScan.nextAt = getNextScheduledSlot().toISOString();
    logger.info({ nextAt: scheduledScan.nextAt }, "scheduled scan cron started");

    setInterval(async () => {
      if (!scheduledScan.enabled) return;
      const tickNow = new Date();
      if (isScanRunning() || (await isScanRunningInDb(config.output.dir))) {
        // A scan is already running — skip any slot that fell inside it instead
        // of firing a redundant catch-up scan the moment it ends.
        if (scheduledScan.nextAt && tickNow >= new Date(scheduledScan.nextAt)) {
          scheduledScan.nextAt = getNextScheduledSlot(tickNow).toISOString();
          logger.info({ nextAt: scheduledScan.nextAt }, "scheduled scan slot skipped — scan already running");
        }
        return;
      }
      const now = new Date();
      if (!scheduledScan.nextAt || now >= new Date(scheduledScan.nextAt)) {
        const slot = new Date(scheduledScan.nextAt || now);
        // Load guard: never stack a scheduled scan on top of a running click
        // operation — defer this slot entirely (06:00 → 08:00), don't squeeze
        // the scan into the campaign.
        const clickOpRunning =
          (activeCampaign?.status === "running") ||
          Array.from(jobs.values()).some((j) => j.type === "click" && j.status === "running");
        if (clickOpRunning) {
          scheduledScan.nextAt = getNextScheduledSlot(new Date(slot.getTime() + 60_000)).toISOString();
          const nextHH = trTimeHHMM(new Date(scheduledScan.nextAt));
          logger.info({ deferredFrom: slot, nextAt: scheduledScan.nextAt }, "scheduled scan deferred — click operation running");
          emitEvent({
            type: "scheduled-scan-deferred",
            nextAt: scheduledScan.nextAt,
            message: `Zamanlanmış tarama ertelendi · tıklama operasyonu sürüyor · yeni slot: ${nextHH}`,
          });
          return;
        }
        // Preemptively advance the slot before starting the job so a second
        // tick/process cannot queue the same slot again.
        scheduledScan.nextAt = getNextScheduledSlot(new Date(slot.getTime() + 60_000)).toISOString();
        try {
          const jobId = startScanJob({
            brands: SCHEDULED_BRANDS,
            devices: "both",
            expandBrands: true, // slim variants (4 kw/brand) — more ad auctions per scan
            auto: true,
            scheduled: true,
          });
          scheduledScan.lastQueuedAt = now.toISOString();
          scheduledScan.lastJobId = jobId;
          emitEvent({
            type: "scheduled-scan-queued",
            jobId,
            nextAt: scheduledScan.nextAt,
            message: `Zamanlanmış tarama kuyruğa alındı · sonraki: ${trTimeHHMM(new Date(scheduledScan.nextAt))}`,
          });
          logger.info({ jobId, nextAt: scheduledScan.nextAt }, "scheduled scan queued");
        } catch (err) {
          logger.error({ err: String(err), slot }, "scheduled scan failed to start");
        }
      }
    }, 60_000);
  }

  startScheduledScanCron();

  /**
   * Idle profile reaper: scan/click jobs sometimes leave AdsPower browsers
   * open (scan phase leftovers). Every 10 min, when NO job is running,
   * stop any pool browser that is still open — idle browsers are pure load.
   */
  function startIdleProfileReaper(): void {
    const INTERVAL_MS = 5 * 60 * 1000;
    const SHOT_TTL_MS = 5 * 24 * 60 * 60 * 1000; // screenshots older than 5 days are deleted

    /** Recursively delete screenshot files older than TTL (+ now-empty dirs). */
    function sweepScreenshots(): number {
      const base = resolve(config.output.dir, "screenshots");
      if (!existsSync(base)) return 0;
      let deleted = 0;
      const cutoff = Date.now() - SHOT_TTL_MS;
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = resolve(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
            try {
              if (readdirSync(full).length === 0) rmdirSync(full);
            } catch {
              /* not empty */
            }
          } else if (/\.(png|jpe?g)$/i.test(entry.name)) {
            try {
              if (statSync(full).mtimeMs < cutoff) {
                rmSync(full, { force: true });
                deleted++;
              }
            } catch {
              /* busy file */
            }
          }
        }
      };
      walk(base);
      return deleted;
    }

    setInterval(async () => {
      try {
        const swept = sweepScreenshots();
        if (swept > 0) logger.info({ swept }, "idle reaper: old screenshots deleted");
        const { AdsPowerClient } = await import("../adspower/client.js");
        const ads = new AdsPowerClient(config.adspower.baseUrl, config.adspower.apiKey, 250);
        if (!(await ads.isUp().catch(() => false))) return;
        const profiles = await ads.listProfiles();
        const pool = profiles.filter((p) => /^(TR-ISP-|TR-MOBILE-)/.test(p.name || ""));
        // Sweep even while jobs run: only browsers NOT owned by a live worker
        // are orphans. Previously the reaper skipped entirely during jobs, so
        // orphaned windows from wedged jobs lingered for hours.
        const { getInUseProfiles } = await import("../browser/profileRegistry.js");
        const inUse = getInUseProfiles();
        const stopped: string[] = [];
        for (const p of pool) {
          if (inUse.has(p.user_id)) continue; // legitimately working right now
          const a = await ads.browserActive(p.user_id).catch(() => null);
          if (a?.status === "Active") {
            await ads.stopBrowser(p.user_id).catch(() => {});
            stopped.push(p.name || p.user_id);
          }
        }
        if (stopped.length) {
          logger.warn({ stopped }, "idle reaper: closed leftover AdsPower browsers");
          emitEvent({
            type: "idle-reaper",
            count: stopped.length,
            message: `Boşta kalan ${stopped.length} profil tarayıcısı kapatıldı · ${stopped.slice(0, 4).join(", ")}${stopped.length > 4 ? "…" : ""}`,
          });
        }
      } catch (err) {
        logger.warn({ err: String(err) }, "idle reaper tick failed");
      }
    }, INTERVAL_MS);
  }

  startIdleProfileReaper();

  app.post("/api/scans/:id/click", async (req: Request, res: Response) => {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const scanId = parseInt(idParam || "0", 10);

    try {
      const cfg = loadConfig();
      const started = startFocusCampaignJob({ scanId, cfg, auto: false });
      const store = new Store(cfg.output.dir);
      let cloneAnalysis;
      try {
        cloneAnalysis = analyzeScanClones(store, scanId, { mode: "adaptive", brandKeywords: cfg.bettingKeywords });
      } finally {
        store.close();
      }
      res.json({
        jobId: started.jobId,
        status: "started",
        focus: true,
        domain: started.domain,
        presence: started.presence,
        windowMinutes: started.windowMinutes,
        planTotal: started.planTotal,
        message: `Sadece #1 ${started.domain} · ${started.windowMinutes}dk pencere · sonra rescan`,
        cloneAnalysis,
      });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.get("/api/campaign", (_req: Request, res: Response) => {
    res.json({ campaign: activeCampaign });
  });

  app.post("/api/campaign/stop", (_req: Request, res: Response) => {
    if (!activeCampaign || activeCampaign.status !== "running") {
      res.json({ ok: true, message: "aktif kampanya yok" });
      return;
    }
    const id = activeCampaign.id;
    cancelFlags.set(id, true);
    for (const [jid, j] of jobs) {
      if (j.status === "running" && j.details?.focus) cancelFlags.set(jid, true);
    }
    res.json({ ok: true, campaignId: id, message: "durdurma istendi" });
  });

  /** Cancel a running panel job (marks cancelled; engine finishes current browsers then exits naturally). */
  app.post("/api/jobs/:id/cancel", (req: Request, res: Response) => {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const jobId = idParam || "";
    const state = jobs.get(jobId);
    if (!state) {
      res.status(404).json({ error: "job not found" });
      return;
    }
    if (state.status !== "running") {
      res.json({ ok: true, status: state.status, message: "already finished" });
      return;
    }
    cancelFlags.set(jobId, true);
    // Scans stop via AbortController, not the flag — otherwise cancel is a no-op.
    scanAbortControllers.get(jobId)?.abort(new Error("cancelled from panel"));
    scanAbortControllers.delete(jobId);
    setJobState(jobId, {
      status: "cancelled",
      message: "İptal istendi — aktif tarayıcılar kapanınca durur",
      finishedAt: new Date().toISOString(),
      progress: state.progress,
    });
    // Close associated click run if we know runId
    const runId = Number(state.details?.runId || 0);
    if (runId) {
      try {
        const cs = new ClickStore(config.output.dir);
        try {
          cs.closeRunReconciled(runId, "cancelled from panel");
        } finally {
          cs.close();
        }
      } catch {
        /* */
      }
    }
    emitEvent({ type: "job-update", job: jobs.get(jobId) });
    res.json({ ok: true, jobId, status: "cancelled" });
  });

  /** Google Ads şikâyet paketi — SIKAYET.txt + screenshot; otomatik form yok. */
  app.post("/api/reports/complaints", (req: Request, res: Response) => {
    try {
      const scanId = req.body?.scanId ? Number(req.body.scanId) : undefined;
      const pack = buildAdComplaintPack({
        outputDir: config.output.dir,
        scanId: Number.isFinite(scanId as number) ? scanId : undefined,
        bettingOnly: req.body?.bettingOnly === true,
      });
      res.json({
        ok: true,
        count: pack.count,
        dir: pack.dir,
        indexCsv: pack.indexCsv,
        howTo: pack.howToMd,
        ads: pack.ads.map((a) => ({
          folder: a.folder,
          domain: a.displayDomain,
          title: a.title,
          keyword: a.keyword,
          isBetting: a.isBetting,
          hasScreenshot: !!a.screenshotInPack,
        })),
        message:
          pack.count > 0
            ? `${pack.count} reklam şikâyet klasörü hazır. Google formu elle doldurulur.`
            : "Reklam yok — önce tarama yapın.",
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /** Shared log history — identical for every panel user. */
  app.get("/api/logs", (req: Request, res: Response) => {
    const limit = Math.max(1, Math.min(500, parseInt(String(req.query.limit || "200"), 10) || 200));
    res.json({ logs: logBuffer.slice(-limit) });
  });

  /** List generated complaint packs. */
  app.get("/api/reports/complaints/packs", (req: Request, res: Response) => {
    try {
      const dir = resolve(config.output.dir, "reports", "ad-complaints");
      if (!existsSync(dir)) {
        res.json({ packs: [] });
        return;
      }
      const packs = readdirSync(dir)
        .map((name) => {
          const full = resolve(dir, name);
          const st = statSync(full);
          const indexPath = resolve(full, "INDEX.csv");
          let adCount = 0;
          try {
            adCount = readdirSync(full).filter((n) => statSync(resolve(full, n)).isDirectory()).length;
          } catch {
            /* */
          }
          return {
            name,
            dir: full,
            createdAt: st.birthtime.toISOString(),
            hasIndex: existsSync(indexPath),
            adCount,
          };
        })
        .filter((p) => p.hasIndex)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 20);
      res.json({ packs });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /** Email pool (mail.tm) — stats + listing for the report-ad forms. */
  app.get("/api/emails/pool", (req: Request, res: Response) => {
    try {
      const pool = getEmailPool(config.output.dir);
      res.json({ enabled: config.report.emailPool.enabled, stats: pool.stats(), emails: pool.list() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /** Refill the pool up to a target size (default: configured minSize). */
  app.post("/api/emails/pool/refill", async (req: Request, res: Response) => {
    try {
      const size = Number(req.body?.size) > 0 ? Number(req.body.size) : config.report.emailPool.minSize;
      const pool = getEmailPool(config.output.dir);
      const result = await pool.refill(size);
      res.json({ ok: true, ...result, stats: pool.stats() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /** Preview which address LRU would hand out next (does NOT consume it). */
  app.post("/api/emails/pool/next", (req: Request, res: Response) => {
    try {
      const pool = getEmailPool(config.output.dir);
      const acc = pool.acquire();
      res.json({ ok: true, email: acc?.address ?? null, useCount: acc?.useCount ?? 0 });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /** Health-scan pool addresses (dead accounts get disabled). */
  app.post("/api/emails/pool/health", async (req: Request, res: Response) => {
    try {
      const pool = getEmailPool(config.output.dir);
      const result = await pool.healthCheck(Number(req.body?.limit) > 0 ? Number(req.body.limit) : 50);
      res.json({ ok: true, ...result, stats: pool.stats() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /** Remove an address from rotation. */
  app.delete("/api/emails/pool/:address", (req: Request, res: Response) => {
    try {
      const pool = getEmailPool(config.output.dir);
      pool.disable(String(req.params.address));
      res.json({ ok: true, stats: pool.stats() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/clicks", (req: Request, res: Response) => {
    const store = new ClickStore(config.output.dir);
    try {
      closeStaleClicks(store);
      const rows = (
        store.db
          .prepare(
            "SELECT id, started_at, finished_at, target_domain, target_device, total_jobs, completed_jobs, failed_jobs FROM click_runs ORDER BY id DESC LIMIT 50"
          )
          .all() as Array<Record<string, unknown>>
      ).map((c) => ({
        ...c,
        status: clickRowStatus(c as { finished_at?: string | null; started_at?: string; id?: number }),
      }));
      res.json(rows);
    } finally {
      store.close();
    }
  });

  app.get("/api/clicks/:id", (req: Request, res: Response) => {
    const store = new ClickStore(config.output.dir);
    try {
      const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const runId = parseInt(idParam || "0", 10);
      const run = store.getRun(runId);
      const clicks = store.clicksForRun(runId);
      res.json({ run, clicks });
    } finally {
      store.close();
    }
  });

  app.get("/api/jobs", (req: Request, res: Response) => {
    res.json(Array.from(jobs.values()).reverse());
  });

  app.use((req: Request, res: Response) => {
    if (!hasSession(req)) {
      res.sendFile(resolve(PUBLIC_DIR, "login.html"));
      return;
    }
    res.sendFile(resolve(PUBLIC_DIR, "index.html"));
  });

  mkdirSync(PUBLIC_DIR, { recursive: true });
  app.listen(port, () => {
    logger.info({ port }, "Detect web panel running");
    console.log(`Detect web panel running at http://localhost:${port}`);
  });
}
