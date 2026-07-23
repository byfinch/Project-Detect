/**
 * Captcha solver economics — the policy gate in front of every paid solve.
 *
 * Why this exists: a Google distrust wave can wall dozens of profiles at once.
 * Solving every wall with up to 6 paid attempts each burns the solver budget
 * for near-zero yield (a persisted wall almost never clears on the 3rd+ token).
 *
 * Three independent gates, all persisted in SQLite so they survive restarts
 * (the service runs 24/7):
 *
 *  1) Budget: at most `maxSolvesPerHour` / `maxSolvesPerDay` paid solves.
 *     Exceeded → no solve, profile goes straight to vault cooldown.
 *  2) Provider circuit breaker: rolling wall-clear rate per provider over the
 *     last `breakerMinSamples`+ outcomes. Below `minClearRate` → provider
 *     paused for `breakerPauseMinutes`. Both paused → global solve pause
 *     (distrust wave: walls are unbeatable right now, don't even try).
 *  3) Per-profile wall attempts: 1st wall of the day → `attemptsFirstWall`
 *     paid attempts, 2nd → `attemptsSecondWall`, 3rd+ → no solve at all.
 *
 * Cooldown after a failed wall is owned by the IpTrust vault
 * (progressive 10m→24h); this module only decides whether/how much to spend.
 */
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";

export type SolverProvider = "2captcha" | "capsolver";
export type SolveOutcome = "cleared" | "persisted" | "no_token";

type Budget = AppConfig["captcha"]["budget"];

export interface SolveGate {
  ok: boolean;
  reason?: string;
  /** Paid attempts allowed on THIS wall (0 when ok=false). */
  maxAttempts: number;
}

export interface PolicyStats {
  todaySolves: number;
  hourSolves: number;
  todayWalls: number;
  todayCleared: number;
  clearRateToday: number;
  hourBudget: number;
  dayBudget: number;
  pausedProviders: string[];
  globalPausedUntil: string | null;
}

function openDb(outputDir: string): DatabaseSync {
  const db = new DatabaseSync(resolve(outputDir, "detect.sqlite"));
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS solver_calls (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      provider   TEXT NOT NULL,
      task_type  TEXT NOT NULL,
      status     TEXT NOT NULL,
      cost       REAL,
      created_at TEXT NOT NULL
    );
  `);
  // Older DBs lack these columns — add idempotently.
  for (const ddl of [
    "ALTER TABLE solver_calls ADD COLUMN outcome TEXT",
    "ALTER TABLE solver_calls ADD COLUMN profile_id TEXT",
  ]) {
    try {
      db.exec(ddl);
    } catch {
      /* column exists */
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS captcha_walls (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT NOT NULL,
      cleared    INTEGER NOT NULL,
      attempts   INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS captcha_policy_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

export class CaptchaPolicy {
  private readonly db: DatabaseSync;

  constructor(
    outputDir: string,
    private readonly budget: Budget
  ) {
    this.db = openDb(outputDir);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  private getState(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM captcha_policy_state WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private setState(key: string, value: string | null): void {
    if (value === null) this.db.prepare("DELETE FROM captcha_policy_state WHERE key = ?").run(key);
    else
      this.db
        .prepare("INSERT INTO captcha_policy_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(key, value);
  }

  private pausedUntil(key: string): string | null {
    const v = this.getState(`paused:${key}`);
    if (!v) return null;
    if (v > new Date().toISOString()) return v;
    this.setState(`paused:${key}`, null); // expired
    return null;
  }

  private countSolvesSince(iso: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM solver_calls WHERE created_at >= ?")
      .get(iso) as { n: number };
    return row.n;
  }

  private wallsToday(profileId: string): number {
    const dayIso = new Date().toISOString().slice(0, 10);
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM captcha_walls WHERE profile_id = ? AND created_at >= ?")
      .get(profileId, dayIso) as { n: number };
    return row.n;
  }

  /**
   * Gate 3 (per-profile attempts) + gate 1 (budget) + gate 2 (global pause).
   * Call once when a profile hits a wall, BEFORE any paid attempt.
   */
  shouldSolve(profileId: string | undefined): SolveGate {
    const global = this.pausedUntil("global");
    if (global) {
      return { ok: false, reason: `global solver pause (distrust wave) until ${global}`, maxAttempts: 0 };
    }
    const hourIso = new Date(Date.now() - 3_600_000).toISOString();
    const dayIso = new Date().toISOString().slice(0, 10);
    if (this.countSolvesSince(hourIso) >= this.budget.maxSolvesPerHour) {
      return { ok: false, reason: `hourly solver budget exhausted (${this.budget.maxSolvesPerHour}/h)`, maxAttempts: 0 };
    }
    if (this.countSolvesSince(dayIso) >= this.budget.maxSolvesPerDay) {
      return { ok: false, reason: `daily solver budget exhausted (${this.budget.maxSolvesPerDay}/d)`, maxAttempts: 0 };
    }
    if (!profileId) {
      // Unknown profile (recovery paths): allow the conservative minimum.
      return { ok: true, maxAttempts: this.budget.attemptsSecondWall };
    }
    const walls = this.wallsToday(profileId);
    if (walls === 0) return { ok: true, maxAttempts: this.budget.attemptsFirstWall };
    if (walls === 1) return { ok: true, maxAttempts: this.budget.attemptsSecondWall };
    return { ok: false, reason: `profile already burned ${walls} walls today — no more solves`, maxAttempts: 0 };
  }

  /**
   * Gate 2 per provider: is this provider currently allowed to take a paid job?
   * "auto" order must skip paused providers.
   */
  providerAllowed(provider: SolverProvider): boolean {
    if (this.pausedUntil("global")) return false;
    return !this.pausedUntil(provider);
  }

  /**
   * Record the outcome of ONE paid solve attempt (token consumed).
   * Also feeds the provider circuit breaker; may trip a pause.
   */
  recordSolve(profileId: string | undefined, provider: SolverProvider, outcome: SolveOutcome, solverCallId?: number | null): void {
    try {
      if (solverCallId != null) {
        this.db
          .prepare("UPDATE solver_calls SET outcome = ?, profile_id = ? WHERE id = ?")
          .run(outcome, profileId ?? null, solverCallId);
      } else {
        this.db
          .prepare("UPDATE solver_calls SET outcome = ?, profile_id = ? WHERE id = (SELECT MAX(id) FROM solver_calls WHERE provider = ?)")
          .run(outcome, profileId ?? null, provider);
      }
    } catch (err) {
      logger.debug({ err: String(err) }, "policy: outcome update failed (ignored)");
    }

    // Circuit breaker over the last N outcomes of this provider.
    const rows = this.db
      .prepare(
        "SELECT outcome FROM solver_calls WHERE provider = ? AND outcome IS NOT NULL ORDER BY id DESC LIMIT ?"
      )
      .all(provider, this.budget.breakerMinSamples) as Array<{ outcome: string }>;
    if (rows.length >= this.budget.breakerMinSamples) {
      const cleared = rows.filter((r) => r.outcome === "cleared").length;
      const rate = cleared / rows.length;
      if (rate < this.budget.minClearRate && !this.pausedUntil(provider)) {
        const until = new Date(Date.now() + this.budget.breakerPauseMinutes * 60_000).toISOString();
        this.setState(`paused:${provider}`, until);
        logger.warn(
          { provider, cleared, samples: rows.length, rate, until },
          "solver circuit breaker TRIPPED — provider paused (wall-clear rate collapsed)"
        );
        // Both providers tripped → global pause: this is a Google distrust wave.
        const other: SolverProvider = provider === "capsolver" ? "2captcha" : "capsolver";
        if (this.pausedUntil(other)) {
          this.setState("paused:global", until);
          logger.warn({ until }, "both solver providers paused — GLOBAL solve pause (distrust wave)");
        }
      }
    }
  }

  /** Record a finished wall (after all attempts) — drives per-profile attempt caps. */
  recordWallClosed(profileId: string | undefined, cleared: boolean, attempts: number): void {
    if (!profileId) return;
    try {
      this.db
        .prepare("INSERT INTO captcha_walls (profile_id, cleared, attempts, created_at) VALUES (?, ?, ?, ?)")
        .run(profileId, cleared ? 1 : 0, attempts, new Date().toISOString());
    } catch (err) {
      logger.debug({ err: String(err) }, "policy: wall record failed (ignored)");
    }
  }

  stats(): PolicyStats {
    const dayIso = new Date().toISOString().slice(0, 10);
    const hourIso = new Date(Date.now() - 3_600_000).toISOString();
    const walls = this.db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(cleared), 0) AS c FROM captcha_walls WHERE created_at >= ?")
      .get(dayIso) as { n: number; c: number };
    const paused: string[] = [];
    for (const p of ["capsolver", "2captcha"] as const) {
      const u = this.pausedUntil(p);
      if (u) paused.push(`${p} (${u.slice(11, 16)}Z)`);
    }
    return {
      todaySolves: this.countSolvesSince(dayIso),
      hourSolves: this.countSolvesSince(hourIso),
      todayWalls: walls.n,
      todayCleared: walls.c,
      clearRateToday: walls.n > 0 ? Math.round((walls.c / walls.n) * 100) / 100 : 0,
      hourBudget: this.budget.maxSolvesPerHour,
      dayBudget: this.budget.maxSolvesPerDay,
      pausedProviders: paused,
      globalPausedUntil: this.pausedUntil("global"),
    };
  }
}

/** Shared per-process instance (scanner, click worker, recovery all share gates). */
let shared: CaptchaPolicy | null = null;

export function getCaptchaPolicy(config: AppConfig): CaptchaPolicy {
  if (!shared) shared = new CaptchaPolicy(config.output.dir, config.captcha.budget);
  return shared;
}
