import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { AdResult, ScanMeta } from "../types.js";
import { IpTrustStore } from "./ipTrust.js";

/**
 * SQLite store backed by Node's built-in `node:sqlite` (no native build needed).
 */
export class Store {
  readonly db: DatabaseSync;
  readonly ipTrust: IpTrustStore;

  constructor(outputDir: string) {
    mkdirSync(outputDir, { recursive: true });
    const dbPath = resolve(outputDir, "detect.sqlite");
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
    this.ipTrust = new IpTrustStore(this.db);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scans (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at   TEXT NOT NULL,
        finished_at  TEXT,
        keywords     TEXT NOT NULL,
        devices      TEXT NOT NULL,
        location     TEXT NOT NULL,
        total_ads    INTEGER NOT NULL DEFAULT 0,
        notes        TEXT
      );

      CREATE TABLE IF NOT EXISTS results (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_id        INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
        keyword        TEXT NOT NULL,
        device         TEXT NOT NULL,
        profile_id     TEXT NOT NULL,
        position       INTEGER NOT NULL,
        block          TEXT NOT NULL,
        display_domain TEXT NOT NULL,
        display_url    TEXT NOT NULL,
        title          TEXT NOT NULL,
        description    TEXT NOT NULL,
        ad_href        TEXT,
        final_url      TEXT,
        final_domain   TEXT,
        is_betting     INTEGER NOT NULL DEFAULT 0,
        screenshot_path TEXT,
        captured_at    TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hops (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        result_id  INTEGER NOT NULL REFERENCES results(id) ON DELETE CASCADE,
        seq        INTEGER NOT NULL,
        url        TEXT NOT NULL,
        type       TEXT NOT NULL,
        status     INTEGER,
        method     TEXT,
        location   TEXT,
        at_ms      INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_results_scan   ON results(scan_id);
      CREATE INDEX IF NOT EXISTS idx_results_domain ON results(display_domain);
      CREATE INDEX IF NOT EXISTS idx_results_final  ON results(final_domain);
      CREATE INDEX IF NOT EXISTS idx_hops_result    ON hops(result_id);
    `);
  }

  createScan(meta: ScanMeta): number {
    const info = this.db
      .prepare(
        `INSERT INTO scans (started_at, keywords, devices, location, total_ads, notes)
         VALUES (?, ?, ?, ?, 0, ?)`
      )
      .run(meta.startedAt, JSON.stringify(meta.keywords), JSON.stringify(meta.devices), meta.location, meta.notes ?? null);
    return Number(info.lastInsertRowid);
  }

  finishScan(scanId: number, finishedAt: string, totalAds: number): void {
    this.db.prepare(`UPDATE scans SET finished_at = ?, total_ads = ? WHERE id = ?`).run(finishedAt, totalAds, scanId);
  }

  /** Close scans that were started before the cutoff but never finished (orphaned runs). */
  closeOrphanedScans(beforeIso: string): number {
    const info = this.db
      .prepare(`UPDATE scans SET finished_at = ?, notes = ? WHERE started_at < ? AND finished_at IS NULL`)
      .run(new Date().toISOString(), "auto-closed: orphaned scan", beforeIso);
    return Number(info.changes);
  }

  insertResult(scanId: number, ad: AdResult): number {
    // results row + hops in ONE transaction — a hops failure must not leave an
    // orphaned results row behind.
    this.db.exec("BEGIN");
    try {
      const info = this.db
        .prepare(
          `INSERT INTO results
            (scan_id, keyword, device, profile_id, position, block, display_domain, display_url,
             title, description, ad_href, final_url, final_domain, is_betting, screenshot_path, captured_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          scanId,
          ad.keyword,
          ad.device,
          ad.profileId,
          ad.position,
          ad.block,
          ad.displayDomain,
          ad.displayUrl,
          ad.title,
          ad.description,
          ad.adHref,
          ad.finalUrl,
          ad.finalDomain,
          ad.isBettingGuess ? 1 : 0,
          ad.screenshotPath,
          ad.capturedAt
        );
      const resultId = Number(info.lastInsertRowid);

      if (ad.redirectHops.length) {
        const hopStmt = this.db.prepare(
          `INSERT INTO hops (result_id, seq, url, type, status, method, location, at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const h of ad.redirectHops) {
          hopStmt.run(resultId, h.seq, h.url, h.type, h.status ?? null, h.method ?? null, h.location ?? null, h.atMs ?? null);
        }
      }
      this.db.exec("COMMIT");
      return resultId;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  resultsForScan(scanId: number): Record<string, unknown>[] {
    return this.db
      .prepare(`SELECT * FROM results WHERE scan_id = ? ORDER BY keyword, device, position`)
      .all(scanId) as Record<string, unknown>[];
  }

  latestScanId(): number | null {
    const row = this.db.prepare(`SELECT id FROM scans ORDER BY id DESC LIMIT 1`).get() as { id: number } | undefined;
    return row?.id ?? null;
  }

  close(): void {
    this.db.close();
  }
}
