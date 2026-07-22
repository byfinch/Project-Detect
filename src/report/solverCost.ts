/**
 * Solver cost tracking — every paid captcha-solver call is logged with its
 * real cost when the provider returns one (2captcha reports `cost` per task).
 * Panel shows daily/weekly spend so the meter never runs silently.
 */
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { logger } from "../logger.js";

function open(outputDir: string): DatabaseSync {
  const db = new DatabaseSync(resolve(outputDir, "detect.sqlite"));
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
  return db;
}

export function logSolverCall(
  outputDir: string,
  entry: { provider: "2captcha" | "capsolver"; taskType: string; status: "solved" | "failed"; cost?: number | null }
): void {
  try {
    const db = open(outputDir);
    try {
      db.prepare(
        `INSERT INTO solver_calls (provider, task_type, status, cost, created_at) VALUES (?, ?, ?, ?, ?)`
      ).run(entry.provider, entry.taskType, entry.status, entry.cost ?? null, new Date().toISOString());
    } finally {
      db.close();
    }
  } catch (err) {
    logger.debug({ err: String(err) }, "solver cost log failed (ignored)");
  }
}

export function solverCostSummary(outputDir: string): { today: number; last7d: number; todayCalls: number; weekCalls: number } {
  try {
    const db = open(outputDir);
    try {
      const todayIso = new Date().toISOString().slice(0, 10);
      const weekIso = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const t = db
        .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(cost), 0) AS s FROM solver_calls WHERE created_at >= ?`)
        .get(todayIso) as { n: number; s: number };
      const w = db
        .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(cost), 0) AS s FROM solver_calls WHERE created_at >= ?`)
        .get(weekIso) as { n: number; s: number };
      return {
        today: Math.round(t.s * 10000) / 10000,
        last7d: Math.round(w.s * 10000) / 10000,
        todayCalls: t.n,
        weekCalls: w.n,
      };
    } finally {
      db.close();
    }
  } catch {
    return { today: 0, last7d: 0, todayCalls: 0, weekCalls: 0 };
  }
}
