import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { ClickResult, ClickStatus, TargetDevice } from "./types.js";

export interface ClickRunMeta {
  startedAt: string;
  targetDomain: string;
  targetDevice: TargetDevice;
  totalJobs: number;
  notes?: string;
  /**
   * Groups runs into one operation (e.g. a focus campaign = several wave runs).
   * NULL → run stands alone (legacy behavior, one row per run in the panel).
   */
  operationId?: string;
}

export class ClickStore {
  readonly db: DatabaseSync;

  constructor(outputDir: string) {
    mkdirSync(outputDir, { recursive: true });
    const dbPath = resolve(outputDir, "detect.sqlite");
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS click_runs (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at     TEXT NOT NULL,
        finished_at    TEXT,
        target_domain  TEXT NOT NULL,
        target_device  TEXT NOT NULL,
        total_jobs     INTEGER NOT NULL DEFAULT 0,
        completed_jobs INTEGER NOT NULL DEFAULT 0,
        failed_jobs    INTEGER NOT NULL DEFAULT 0,
        captcha_jobs   INTEGER NOT NULL DEFAULT 0,
        skipped_jobs   INTEGER NOT NULL DEFAULT 0,
        notes          TEXT
      );

      CREATE TABLE IF NOT EXISTS clicks (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id             INTEGER NOT NULL REFERENCES click_runs(id) ON DELETE CASCADE,
        job_id             TEXT NOT NULL,
        profile_id         TEXT NOT NULL,
        device             TEXT NOT NULL,
        keyword            TEXT NOT NULL,
        target_domain      TEXT NOT NULL,
        status             TEXT NOT NULL,
        serp_url           TEXT,
        ad_title           TEXT,
        ad_description     TEXT,
        display_url        TEXT,
        click_url          TEXT,
        landing_url        TEXT,
        final_url          TEXT,
        final_domain       TEXT,
        pre_click_ms       INTEGER DEFAULT 0,
        stay_ms            INTEGER DEFAULT 0,
        internal_clicks    INTEGER DEFAULT 0,
        screenshot_serp    TEXT,
        screenshot_landing TEXT,
        screenshot_final   TEXT,
        error              TEXT,
        captured_at        TEXT NOT NULL,
        report_status      TEXT,
        report_message     TEXT
      );

      CREATE TABLE IF NOT EXISTS click_hops (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        click_id  INTEGER NOT NULL REFERENCES clicks(id) ON DELETE CASCADE,
        seq       INTEGER NOT NULL,
        url       TEXT NOT NULL,
        type      TEXT NOT NULL,
        status    INTEGER,
        method    TEXT,
        location  TEXT,
        at_ms     INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_clicks_run      ON clicks(run_id);
      CREATE INDEX IF NOT EXISTS idx_clicks_status   ON clicks(status);
      CREATE INDEX IF NOT EXISTS idx_clicks_profile  ON clicks(profile_id);
      CREATE INDEX IF NOT EXISTS idx_clicks_domain   ON clicks(target_domain);
      CREATE INDEX IF NOT EXISTS idx_click_hops_click ON click_hops(click_id);
    `);
    // Add report columns if missing (existing DB migration).
    try { this.db.exec(`ALTER TABLE clicks ADD COLUMN report_status TEXT;`); } catch { /* already exists */ }
    try { this.db.exec(`ALTER TABLE clicks ADD COLUMN report_message TEXT;`); } catch { /* already exists */ }
    try { this.db.exec(`ALTER TABLE click_runs ADD COLUMN operation_id TEXT;`); } catch { /* already exists */ }
  }

  createRun(meta: ClickRunMeta): number {
    const info = this.db
      .prepare(
        `INSERT INTO click_runs (started_at, target_domain, target_device, total_jobs, notes, operation_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(meta.startedAt, meta.targetDomain, meta.targetDevice, meta.totalJobs, meta.notes ?? null, meta.operationId ?? null);
    return Number(info.lastInsertRowid);
  }

  finishRun(
    runId: number,
    finishedAt: string,
    completed: number,
    failed: number,
    captcha: number,
    skipped: number
  ): void {
    // Keep locked total_jobs if already set; only fill if it was 0.
    const done = completed + failed + captcha + skipped;
    this.db
      .prepare(
        `UPDATE click_runs
         SET finished_at = ?, completed_jobs = ?, failed_jobs = ?, captcha_jobs = ?, skipped_jobs = ?,
             total_jobs = CASE WHEN total_jobs > 0 THEN total_jobs ELSE ? END
         WHERE id = ?`
      )
      .run(finishedAt, completed, failed, captcha, skipped, done, runId);
  }

  /** Live counters while a run is still open (panel progress). total_jobs stays locked once set. */
  updateRunProgress(
    runId: number,
    stats: { completed: number; failed: number; captcha: number; skipped: number; totalJobs?: number }
  ): void {
    // Prefer keeping existing total_jobs; only set if currently 0 and totalJobs provided.
    const row = this.db.prepare(`SELECT total_jobs FROM click_runs WHERE id = ?`).get(runId) as
      | { total_jobs: number }
      | undefined;
    const locked = Number(row?.total_jobs ?? 0);
    const nextTotal =
      locked > 0 ? locked : Math.max(0, Number(stats.totalJobs ?? 0));
    this.db
      .prepare(
        `UPDATE click_runs
         SET completed_jobs = ?, failed_jobs = ?, captcha_jobs = ?, skipped_jobs = ?,
             total_jobs = CASE WHEN total_jobs > 0 THEN total_jobs ELSE ? END
         WHERE id = ? AND finished_at IS NULL`
      )
      .run(stats.completed, stats.failed, stats.captcha, stats.skipped, nextTotal, runId);
  }

  setTotalJobs(runId: number, totalJobs: number): void {
    this.db.prepare(`UPDATE click_runs SET total_jobs = ? WHERE id = ?`).run(totalJobs, runId);
  }

  /** Aggregate live counters from clicks rows (source of truth after restarts). */
  statsForRun(runId: number): {
    total: number;
    completed: number;
    failed: number;
    captcha: number;
    skipped: number;
  } {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS c FROM clicks WHERE run_id = ? GROUP BY status`)
      .all(runId) as Array<{ status: string; c: number }>;
    const out = { total: 0, completed: 0, failed: 0, captcha: 0, skipped: 0 };
    for (const r of rows) {
      const n = Number(r.c) || 0;
      out.total += n;
      if (r.status === "success") out.completed += n;
      else if (r.status === "captcha") out.captcha += n;
      else if (r.status === "skipped") out.skipped += n;
      else out.failed += n;
    }
    return out;
  }

  /** Close one open run and fill counters from clicks rows. */
  closeRunReconciled(runId: number, note = "auto-closed orphan reconciled"): boolean {
    const row = this.db.prepare(`SELECT id FROM click_runs WHERE id = ? AND finished_at IS NULL`).get(runId) as
      | { id: number }
      | undefined;
    if (!row) return false;
    const stats = this.statsForRun(runId);
    const total = Math.max(stats.total, stats.completed + stats.failed + stats.captcha + stats.skipped);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE click_runs SET
           finished_at = ?,
           completed_jobs = ?,
           failed_jobs = ?,
           captcha_jobs = ?,
           skipped_jobs = ?,
           total_jobs = CASE WHEN total_jobs < ? THEN ? ELSE total_jobs END,
           notes = COALESCE(notes, '') || ?
         WHERE id = ? AND finished_at IS NULL`
      )
      .run(
        now,
        stats.completed,
        stats.failed,
        stats.captcha,
        stats.skipped,
        total,
        total,
        ` | ${note}`,
        runId
      );
    return true;
  }

  /**
   * Close unfinished runs older than cutoff and reconcile counters from clicks table
   * (prevents panel "running" with 0/0 after crash/restart).
   */
  closeOrphanedRuns(beforeIso: string): number {
    const open = this.db
      .prepare(`SELECT id FROM click_runs WHERE finished_at IS NULL AND started_at < ?`)
      .all(beforeIso) as Array<{ id: number }>;
    let n = 0;
    for (const row of open) {
      if (this.closeRunReconciled(row.id)) n += 1;
    }
    return n;
  }

  insertClick(runId: number, result: ClickResult): number {
    const ev = result.evidence;
    const info = this.db
      .prepare(
        `INSERT INTO clicks
          (run_id, job_id, profile_id, device, keyword, target_domain, status,
           serp_url, ad_title, ad_description, display_url, click_url, landing_url,
           final_url, final_domain, pre_click_ms, stay_ms, internal_clicks,
           screenshot_serp, screenshot_landing, screenshot_final, error, captured_at,
           report_status, report_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        runId,
        result.job.id,
        result.job.profileId,
        result.job.device,
        result.job.keyword,
        result.job.targetDomain,
        result.status,
        ev.serpUrl,
        ev.adTitle,
        ev.adDescription,
        ev.displayUrl,
        ev.clickUrl,
        ev.landingUrl,
        ev.finalUrl,
        ev.finalDomain,
        ev.preClickMs,
        ev.stayMs,
        ev.internalClicks,
        ev.screenshotSerp,
        ev.screenshotLanding,
        ev.screenshotFinal,
        result.error,
        result.capturedAt,
        result.report?.status ?? null,
        result.report?.message ?? null
      );
    const clickId = Number(info.lastInsertRowid);

    if (ev.redirectHops.length) {
      const hopStmt = this.db.prepare(
        `INSERT INTO click_hops (click_id, seq, url, type, status, method, location, at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      this.db.exec("BEGIN");
      try {
        for (const h of ev.redirectHops) {
          hopStmt.run(clickId, h.seq, h.url, h.type, h.status ?? null, h.method ?? null, h.location ?? null, h.atMs ?? null);
        }
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }

    return clickId;
  }

  getRun(runId: number): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM click_runs WHERE id = ?").get(runId) as Record<string, unknown> | undefined;
  }

  clicksForRun(runId: number): Record<string, unknown>[] {
    return this.db.prepare("SELECT * FROM clicks WHERE run_id = ? ORDER BY captured_at").all(runId) as Record<string, unknown>[];
  }

  latestRunId(): number | null {
    const row = this.db.prepare("SELECT id FROM click_runs ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
    return row?.id ?? null;
  }

  /** Successful clicks by one profile on one domain since a timestamp (frequency cap). */
  countRecentSuccesses(profileId: string, domain: string, sinceIso: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM clicks
         WHERE profile_id = ? AND target_domain = ? AND status = 'success' AND captured_at >= ?`
      )
      .get(profileId, domain, sinceIso) as { c: number };
    return Number(row.c) || 0;
  }

  /** Last successful click time by one profile on one domain (cooldown check). */
  lastSuccessAt(profileId: string, domain: string): string | null {
    const row = this.db
      .prepare(
        `SELECT MAX(captured_at) AS last FROM clicks
         WHERE profile_id = ? AND target_domain = ? AND status = 'success'`
      )
      .get(profileId, domain) as { last: string | null };
    return row.last ?? null;
  }

  /**
   * Operation results grouped PER OPERATION (campaign/job) × domain.
   * Waves/queues inside one operation accumulate into a single row — queue
   * boundaries don't split anything. A NEW operation on the same ad starts
   * its own row from zero; past operations keep their own history.
   * Legacy runs without operation_id stay one-row-per-run.
   */
  operationResults(page = 1, limit = 5): {
    total: number;
    results: Array<{
      operationId: string;
      domain: string;
      devices: string;
      keywords: string;
      startedAt: string | null;
      lastAt: string | null;
      attempts: number;
      clicks: number;
      reports: number;
    }>;
  } {
    const OP = `COALESCE(r.operation_id, 'run-' || r.id)`;
    const DOM = `COALESCE(c.target_domain, r.target_domain)`;
    const countRow = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM (
           SELECT 1 FROM click_runs r LEFT JOIN clicks c ON c.run_id = r.id
           GROUP BY ${OP}, ${DOM}
           HAVING COUNT(c.id) > 0
         )`
      )
      .get() as { c: number };
    const offset = Math.max(0, (page - 1) * limit);
    const results = this.db
      .prepare(
        `SELECT
           ${OP} AS operationId,
           ${DOM} AS domain,
           (SELECT GROUP_CONCAT(DISTINCT r2.target_device) FROM click_runs r2
             WHERE COALESCE(r2.operation_id, 'run-' || r2.id) = ${OP}) AS devices,
           (SELECT GROUP_CONCAT(kw) FROM (
              SELECT DISTINCT c2.keyword AS kw FROM clicks c2
              JOIN click_runs r2 ON c2.run_id = r2.id
              WHERE COALESCE(r2.operation_id, 'run-' || r2.id) = ${OP}
                AND c2.target_domain = ${DOM})) AS keywords,
           MIN(r.started_at) AS startedAt,
           MAX(c.captured_at) AS lastAt,
           COUNT(c.id) AS attempts,
           SUM(CASE WHEN c.status = 'success' THEN 1 ELSE 0 END) AS clicks,
           SUM(CASE WHEN c.report_status IN ('submitted', 'filled') THEN 1 ELSE 0 END) AS reports
         FROM click_runs r
         LEFT JOIN clicks c ON c.run_id = r.id
         GROUP BY operationId, domain
         HAVING COUNT(c.id) > 0
         ORDER BY MAX(r.id) DESC
         LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as Array<{
      operationId: string;
      domain: string;
      devices: string | null;
      keywords: string | null;
      startedAt: string | null;
      lastAt: string | null;
      attempts: number;
      clicks: number;
      reports: number;
    }>;
    return {
      total: Number(countRow.c),
      results: results.map((r) => ({
        ...r,
        devices: r.devices ?? "",
        keywords: r.keywords ?? "",
      })),
    };
  }

  close(): void {
    this.db.close();
  }
}
