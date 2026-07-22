import type { DatabaseSync } from "node:sqlite";

/**
 * Long-lived per-profile Google trust state for private ISP recovery.
 *
 * Model (solver-failed ≠ IP dead forever):
 *  - usable: SERP works (clean or recently solved)
 *  - captcha: solver failed this session → short/medium cooldown (next_retry_at)
 *  - recovering: in-flight recovery attempts
 *  - quarantined: many consecutive fails → long cooldown (still auto-retried later)
 *
 * Manual solve still works on many "captcha" IPs — status means "wait then retry",
 * not "never open this profile again".
 *
 * Trust cookies (GOOGLE_ABUSE_EXEMPTION, NID, …) survive restarts / clearProfile.
 */

export type IpTrustStatus = "usable" | "captcha" | "recovering" | "quarantined";

export interface TrustCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
}

export interface IpTrustRow {
  profileId: string;
  name: string;
  device: string;
  proxyHost: string;
  status: IpTrustStatus;
  consecutiveFails: number;
  totalSolves: number;
  totalHardFails: number;
  lastCleanAt: string | null;
  lastCaptchaAt: string | null;
  lastSolvedAt: string | null;
  nextRetryAt: string | null;
  trustCookies: TrustCookie[];
  lastError: string;
  updatedAt: string;
}

export interface SolverFailResult {
  status: IpTrustStatus;
  consecutiveFails: number;
  /** Minutes until next_retry_at from now */
  cooldownMinutes: number;
  nextRetryAt: string;
}

/**
 * Progressive cooldown after solver fails (not permanent ban).
 * 1st: 10m · 2nd: 20m · 3rd: 45m · 4th: 2h · 5th: 6h · 6th+: 12h (cap 24h)
 */
export function computeNextRetryAt(consecutiveFails: number, from = new Date()): Date {
  const minutes = [10, 20, 45, 120, 360, 720, 1440][Math.min(Math.max(consecutiveFails, 1) - 1, 6)] ?? 1440;
  return new Date(from.getTime() + minutes * 60_000);
}

export function cooldownMinutesForFails(consecutiveFails: number): number {
  return [10, 20, 45, 120, 360, 720, 1440][Math.min(Math.max(consecutiveFails, 1) - 1, 6)] ?? 1440;
}

/** True if vault says wait until next_retry_at. */
export function isInCooldown(row: IpTrustRow, now = new Date()): boolean {
  if (row.status === "usable") return false;
  if (!row.nextRetryAt) return row.status === "captcha" || row.status === "quarantined";
  return new Date(row.nextRetryAt).getTime() > now.getTime();
}

export class IpTrustStore {
  constructor(private readonly db: DatabaseSync) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ip_trust (
        profile_id         TEXT PRIMARY KEY,
        name               TEXT NOT NULL DEFAULT '',
        device             TEXT NOT NULL DEFAULT 'desktop',
        proxy_host         TEXT NOT NULL DEFAULT '',
        status             TEXT NOT NULL DEFAULT 'usable',
        consecutive_fails  INTEGER NOT NULL DEFAULT 0,
        total_solves       INTEGER NOT NULL DEFAULT 0,
        total_hard_fails   INTEGER NOT NULL DEFAULT 0,
        last_clean_at      TEXT,
        last_captcha_at    TEXT,
        last_solved_at     TEXT,
        next_retry_at      TEXT,
        trust_cookies_json TEXT,
        last_error         TEXT NOT NULL DEFAULT '',
        updated_at         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ip_trust_status ON ip_trust(status);
      CREATE INDEX IF NOT EXISTS idx_ip_trust_retry  ON ip_trust(next_retry_at);
    `);
  }

  private rowFromDb(r: Record<string, unknown>): IpTrustRow {
    let trustCookies: TrustCookie[] = [];
    if (typeof r.trust_cookies_json === "string" && r.trust_cookies_json) {
      try {
        trustCookies = JSON.parse(r.trust_cookies_json) as TrustCookie[];
      } catch {
        trustCookies = [];
      }
    }
    return {
      profileId: String(r.profile_id),
      name: String(r.name ?? ""),
      device: String(r.device ?? "desktop"),
      proxyHost: String(r.proxy_host ?? ""),
      status: (r.status as IpTrustStatus) || "usable",
      consecutiveFails: Number(r.consecutive_fails ?? 0),
      totalSolves: Number(r.total_solves ?? 0),
      totalHardFails: Number(r.total_hard_fails ?? 0),
      lastCleanAt: (r.last_clean_at as string) ?? null,
      lastCaptchaAt: (r.last_captcha_at as string) ?? null,
      lastSolvedAt: (r.last_solved_at as string) ?? null,
      nextRetryAt: (r.next_retry_at as string) ?? null,
      trustCookies,
      lastError: String(r.last_error ?? ""),
      updatedAt: String(r.updated_at ?? ""),
    };
  }

  get(profileId: string): IpTrustRow | null {
    const r = this.db.prepare(`SELECT * FROM ip_trust WHERE profile_id = ?`).get(profileId) as
      | Record<string, unknown>
      | undefined;
    return r ? this.rowFromDb(r) : null;
  }

  list(status?: IpTrustStatus): IpTrustRow[] {
    if (status) {
      return (
        this.db.prepare(`SELECT * FROM ip_trust WHERE status = ? ORDER BY name`).all(status) as Record<
          string,
          unknown
        >[]
      ).map((r) => this.rowFromDb(r));
    }
    return (this.db.prepare(`SELECT * FROM ip_trust ORDER BY name`).all() as Record<string, unknown>[]).map((r) =>
      this.rowFromDb(r)
    );
  }

  /** Profiles due for automated recovery (captcha/quarantined and next_retry_at passed). */
  listDueForRecovery(now = new Date()): IpTrustRow[] {
    const iso = now.toISOString();
    return (
      this.db
        .prepare(
          `SELECT * FROM ip_trust
           WHERE status IN ('captcha', 'quarantined', 'recovering')
             AND (next_retry_at IS NULL OR next_retry_at <= ?)
           ORDER BY consecutive_fails ASC, name`
        )
        .all(iso) as Record<string, unknown>[]
    ).map((r) => this.rowFromDb(r));
  }

  upsertMeta(input: {
    profileId: string;
    name: string;
    device: string;
    proxyHost?: string;
  }): void {
    const now = new Date().toISOString();
    const existing = this.get(input.profileId);
    if (existing) {
      this.db
        .prepare(
          `UPDATE ip_trust SET name = ?, device = ?, proxy_host = COALESCE(NULLIF(?, ''), proxy_host), updated_at = ?
           WHERE profile_id = ?`
        )
        .run(input.name, input.device, input.proxyHost ?? "", now, input.profileId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO ip_trust (profile_id, name, device, proxy_host, status, updated_at)
         VALUES (?, ?, ?, ?, 'usable', ?)`
      )
      .run(input.profileId, input.name, input.device, input.proxyHost ?? "", now);
  }

  saveTrustCookies(profileId: string, cookies: TrustCookie[]): void {
    const now = new Date().toISOString();
    this.upsertMeta({ profileId, name: profileId, device: "desktop" });
    this.db
      .prepare(`UPDATE ip_trust SET trust_cookies_json = ?, updated_at = ? WHERE profile_id = ?`)
      .run(JSON.stringify(cookies), now, profileId);
  }

  /** SERP OK without needing a solve this session. */
  markClean(profileId: string, cookies?: TrustCookie[]): void {
    const now = new Date().toISOString();
    this.upsertMeta({ profileId, name: profileId, device: "desktop" });
    if (cookies?.length) {
      this.db
        .prepare(
          `UPDATE ip_trust SET
             status = 'usable', consecutive_fails = 0, last_clean_at = ?, next_retry_at = NULL,
             last_error = '', trust_cookies_json = ?, updated_at = ?
           WHERE profile_id = ?`
        )
        .run(now, JSON.stringify(cookies), now, profileId);
    } else {
      this.db
        .prepare(
          `UPDATE ip_trust SET
             status = 'usable', consecutive_fails = 0, last_clean_at = ?, next_retry_at = NULL,
             last_error = '', updated_at = ?
           WHERE profile_id = ?`
        )
        .run(now, now, profileId);
    }
  }

  /** 2captcha / CapSolver / manual cleared /sorry → real SERP. */
  markSolved(profileId: string, cookies?: TrustCookie[]): void {
    const now = new Date().toISOString();
    const row = this.get(profileId);
    const solves = (row?.totalSolves ?? 0) + 1;
    this.upsertMeta({ profileId, name: row?.name ?? profileId, device: row?.device ?? "desktop" });
    this.db
      .prepare(
        `UPDATE ip_trust SET
           status = 'usable', consecutive_fails = 0, total_solves = ?,
           last_solved_at = ?, last_clean_at = ?, next_retry_at = NULL,
           last_error = '', trust_cookies_json = COALESCE(?, trust_cookies_json), updated_at = ?
         WHERE profile_id = ?`
      )
      .run(solves, now, now, cookies?.length ? JSON.stringify(cookies) : null, now, profileId);
  }

  /**
   * Solver exhausted on /sorry this session → short progressive cooldown (not permanent ban).
   * Prefer this over calling markHardCaptcha with "hard-block" wording.
   */
  markSolverFailed(profileId: string, err = ""): SolverFailResult {
    const now = new Date();
    const row = this.get(profileId);
    const fails = (row?.consecutiveFails ?? 0) + 1;
    const hard = (row?.totalHardFails ?? 0) + 1;
    const cooldownMinutes = cooldownMinutesForFails(fails);
    const next = computeNextRetryAt(fails, now);
    // Soft for first fails; only long quarantine after repeated consecutive fails.
    const status: IpTrustStatus = fails >= 5 ? "quarantined" : "captcha";
    const msg = `solver-failed → cooldown ${cooldownMinutes}m | ${err}`.slice(0, 500);

    this.upsertMeta({ profileId, name: row?.name ?? profileId, device: row?.device ?? "desktop" });
    this.db
      .prepare(
        `UPDATE ip_trust SET
           status = ?, consecutive_fails = ?, total_hard_fails = ?,
           last_captcha_at = ?, next_retry_at = ?, last_error = ?, updated_at = ?
         WHERE profile_id = ?`
      )
      .run(status, fails, hard, now.toISOString(), next.toISOString(), msg, now.toISOString(), profileId);

    return {
      status,
      consecutiveFails: fails,
      cooldownMinutes,
      nextRetryAt: next.toISOString(),
    };
  }

  /**
   * @deprecated Prefer markSolverFailed — same cooldown model, clearer semantics.
   * Kept for probe/recovery call sites.
   */
  markHardCaptcha(profileId: string, err = ""): SolverFailResult {
    return this.markSolverFailed(profileId, err || "hard captcha");
  }

  markRecovering(profileId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE ip_trust SET status = 'recovering', updated_at = ? WHERE profile_id = ?`)
      .run(now, profileId);
  }

  /**
   * Vault snapshot for panel / CLI.
   *
   * Cooldown does NOT auto-flip DB status to "usable" — that only happens after a
   * successful SERP (markClean/markSolved). When next_retry_at passes the profile
   * becomes selectable again (isInCooldown=false) even if status is still captcha.
   *
   *  - usable: proven clean (status=usable)
   *  - ready: cooldown ended — can open again (status captcha/quarantined/recovering but not cooling)
   *  - cooling: next_retry_at still in the future — skip for scan/click
   *  - captcha / quarantined / recovering: raw DB status counts (legacy)
   *  - effective: usable + ready (what the pool can actually pick)
   */
  summary(now = new Date()): {
    total: number;
    usable: number;
    ready: number;
    cooling: number;
    recovering: number;
    captcha: number;
    quarantined: number;
    effective: number;
  } {
    const rows = this.list();
    const out = {
      total: rows.length,
      usable: 0,
      ready: 0,
      cooling: 0,
      recovering: 0,
      captcha: 0,
      quarantined: 0,
      effective: 0,
    };
    for (const r of rows) {
      if (r.status === "usable") {
        out.usable += 1;
        continue;
      }
      if (r.status === "captcha") out.captcha += 1;
      else if (r.status === "quarantined") out.quarantined += 1;
      else if (r.status === "recovering") out.recovering += 1;

      if (isInCooldown(r, now)) out.cooling += 1;
      else out.ready += 1;
    }
    out.effective = out.usable + out.ready;
    return out;
  }
}
