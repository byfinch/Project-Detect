/**
 * Email pool for Google "Report ad" forms.
 *
 * Source: mail.tm — free, no API key (8 QPS per IP). Accounts are created on
 * demand and persisted in the detect.sqlite `email_pool` table so the pool
 * survives restarts. Rotation is LRU: the least-recently-used active address
 * is handed out, so consecutive reports never share an address but older
 * addresses may be reused later (per ops decision).
 *
 * Inbox reading is intentionally out of scope for now — Google's report form
 * only asks for the address, no verification loop. Passwords are kept so a
 * future `GET /messages` integration can be added without recreating accounts.
 */
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { logger } from "../logger.js";
import { sleep } from "../util/time.js";

const MAILTM_BASE = "https://api.mail.tm";
/** mail.tm allows 8 QPS; account creation is 2 requests, stay well below. */
const CREATE_GAP_MS = 800;

export interface PoolEmail {
  address: string;
  password: string;
  provider: string;
  mailtmId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  useCount: number;
  status: "active" | "disabled" | "error";
}

export interface PoolStats {
  total: number;
  active: number;
  disabled: number;
  error: number;
  avgUse: number;
}

interface MailTmDomain {
  id: string;
  domain: string;
  isActive: boolean;
}

function randToken(len: number): string {
  return randomBytes(len).toString("hex").slice(0, len);
}

class MailTmClient {
  private cachedDomains: string[] | null = null;

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch(`${MAILTM_BASE}${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429 && attempt < 3) {
        await sleep(1500 * attempt);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`mail.tm ${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
      }
      return (await res.json()) as T;
    }
    throw new Error("mail.tm: unreachable");
  }

  async getDomains(): Promise<string[]> {
    if (this.cachedDomains?.length) return this.cachedDomains;
    const data = await this.req<{ "hydra:member": MailTmDomain[] }>("GET", "/domains?page=1");
    const active = (data["hydra:member"] || []).filter((d) => d.isActive).map((d) => d.domain);
    if (!active.length) throw new Error("mail.tm: no active domain");
    this.cachedDomains = active;
    return active;
  }

  /** Creates an account on a RANDOM active domain (domain diversity for the pool). */
  async createAccount(): Promise<{ address: string; password: string; id: string }> {
    const domains = await this.getDomains();
    const domain = domains[Math.floor(Math.random() * domains.length)]!;
    const address = `pd${randToken(10)}@${domain}`;
    const password = `Pd!${randToken(16)}`;
    const acc = await this.req<{ id: string }>("POST", "/accounts", { address, password });
    // Token call validates the account is really usable; token itself is not stored.
    await this.req<{ token: string }>("POST", "/token", { address, password });
    return { address, password, id: acc.id };
  }

  async token(address: string, password: string): Promise<string> {
    const res = await this.req<{ token: string }>("POST", "/token", { address, password });
    return res.token;
  }

  async messagesWithAuth(token: string) {
    const res = await fetch(`${MAILTM_BASE}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { "hydra:member"?: Array<{ id: string; from?: { address?: string }; subject?: string; createdAt?: string }> };
    return data["hydra:member"] ?? [];
  }
}

export class EmailPool {
  private db: DatabaseSync;
  private client = new MailTmClient();
  private refilling = false;

  constructor(outputDir: string) {
    const dbPath = resolve(outputDir, "detect.sqlite");
    this.db = new DatabaseSync(dbPath);
    // Multiple stores share detect.sqlite (ClickStore, Store, pool) — wait for locks.
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS email_pool (
        address      TEXT PRIMARY KEY,
        password     TEXT NOT NULL,
        provider     TEXT NOT NULL DEFAULT 'mailtm',
        mailtm_id    TEXT,
        created_at   TEXT NOT NULL,
        last_used_at TEXT,
        use_count    INTEGER NOT NULL DEFAULT 0,
        status       TEXT NOT NULL DEFAULT 'active'
      );
    `);
  }

  /**
   * Health scan: verify active addresses still authenticate (temp-mail accounts
   * can expire). Dead ones are marked disabled so LRU never hands them out.
   * Bounded per call to respect the 8 QPS rate limit.
   */
  async healthCheck(limit = 50): Promise<{ checked: number; alive: number; dead: number }> {
    const rows = this.db
      .prepare(`SELECT address, password FROM email_pool WHERE status = 'active' ORDER BY last_used_at ASC NULLS FIRST LIMIT ?`)
      .all(limit) as Array<{ address: string; password: string }>;
    let alive = 0;
    let dead = 0;
    for (const r of rows) {
      try {
        await this.client.token(r.address, r.password);
        alive++;
      } catch (err) {
        if (/429/.test(String(err))) {
          logger.warn("healthCheck: rate limited — continuing later");
          break;
        }
        dead++;
        this.db.prepare(`UPDATE email_pool SET status = 'disabled' WHERE address = ?`).run(r.address);
        logger.warn({ address: r.address }, "email pool: dead account disabled");
      }
      await sleep(350);
    }
    return { checked: alive + dead, alive, dead };
  }

  /** Latest Google ads-support notification in this address's inbox (proof of submission). */
  async latestGoogleNotification(address: string): Promise<{ subject: string; date: string } | null> {
    const full = await this.latestGoogleNotificationFull(address);
    return full ? { subject: full.subject, date: full.date } : null;
  }

  /** Same notification WITH the full HTML body — for the customer-facing proof view. */
  async latestGoogleNotificationFull(
    address: string,
    sinceIso?: string
  ): Promise<{ subject: string; date: string; html: string; notifId: string | null; outcomeSubject: string | null } | null> {
    const row = this.db.prepare(`SELECT password FROM email_pool WHERE address = ?`).get(address) as
      | { password: string }
      | undefined;
    if (!row) return null;
    try {
      const token = await this.client.token(address, row.password);
      const msgs = await this.client.messagesWithAuth(token);
      const googleMsgs = msgs.filter((m) => /ads-support-noreply@google\.com/i.test(m.from?.address ?? ""));
      if (!googleMsgs.length) return null;

      // Confirmation pattern: "Google'a gönderdiğiniz bildirim NNN" — an OUTCOME
      // mail is any Google mail that does NOT follow this pattern.
      const isConfirmation = (s: string) => /gönderdiğiniz bildirim|your report|report you submitted/i.test(s);
      const outcome = googleMsgs.find((m) => m.subject && !isConfirmation(m.subject));

      // Pool addresses rotate: pick the confirmation closest to (and after) the
      // report's timestamp, not just the newest — otherwise rows show a
      // notification id belonging to a DIFFERENT report.
      const confirmations = googleMsgs.filter((m) => m.subject && isConfirmation(m.subject));
      let picked = confirmations[0];
      if (sinceIso && confirmations.length > 1) {
        const since = new Date(sinceIso).getTime();
        const after = confirmations.filter((m) => new Date(m.createdAt ?? 0).getTime() >= since - 60_000);
        if (after.length) picked = after[after.length - 1]; // earliest after the report
      }
      if (!picked?.subject) return null;

      let html = "";
      try {
        const res = await fetch(`${MAILTM_BASE}/messages/${picked.id}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          const full = (await res.json()) as { html?: string[]; text?: string };
          html = (full.html ?? []).join("\n") || `<pre>${full.text ?? ""}</pre>`;
        }
      } catch {
        /* body optional */
      }
      const notifId = /\b(\d{10,})\b/.exec(picked.subject)?.[1] ?? null;
      return {
        subject: picked.subject,
        date: picked.createdAt ?? "",
        html,
        notifId,
        outcomeSubject: outcome?.subject ?? null,
      };
    } catch {
      return null;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  /** LRU acquire: least-recently-used active address (never-used first). */
  acquire(): PoolEmail | null {
    const row = this.db
      .prepare(
        `SELECT * FROM email_pool WHERE status = 'active'
         ORDER BY last_used_at IS NULL DESC, last_used_at ASC, use_count ASC
         LIMIT 1`
      )
      .get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapRow(row);
  }

  /** Active count below target → top up in the background (fire-and-forget). */
  ensureSize(targetSize: number): void {
    if (this.activeCount() >= targetSize) return;
    void this.refill(targetSize).catch((err) => {
      logger.warn({ err: String(err) }, "email pool auto-refill failed");
    });
  }

  markUsed(address: string): void {
    this.db
      .prepare(`UPDATE email_pool SET use_count = use_count + 1, last_used_at = ? WHERE address = ?`)
      .run(new Date().toISOString(), address);
  }

  disable(address: string): void {
    this.db.prepare(`UPDATE email_pool SET status = 'disabled' WHERE address = ?`).run(address);
  }

  private activeCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM email_pool WHERE status = 'active'`)
      .get() as { c: number };
    return Number(row.c) || 0;
  }

  /** Create accounts until the active pool reaches targetSize. Serialized. */
  async refill(targetSize: number): Promise<{ created: number; failed: number; active: number }> {
    if (this.refilling) return { created: 0, failed: 0, active: this.activeCount() };
    this.refilling = true;
    let created = 0;
    let failed = 0;
    try {
      let need = Math.max(0, targetSize - this.activeCount());
      while (need > 0) {
        try {
          const acc = await this.client.createAccount();
          this.db
            .prepare(
              `INSERT OR IGNORE INTO email_pool (address, password, provider, mailtm_id, created_at)
               VALUES (?, ?, 'mailtm', ?, ?)`
            )
            .run(acc.address, acc.password, acc.id, new Date().toISOString());
          created++;
          need--;
          logger.info({ address: acc.address, poolActive: this.activeCount() }, "email pool: account created");
        } catch (err) {
          failed++;
          logger.warn({ err: String(err) }, "email pool: account creation failed");
          if (failed >= 3) {
            logger.warn("email pool: 3 consecutive create failures — stopping refill");
            break;
          }
        }
        if (need > 0) await sleep(CREATE_GAP_MS);
      }
    } finally {
      this.refilling = false;
    }
    return { created, failed, active: this.activeCount() };
  }

  stats(): PoolStats {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS c FROM email_pool GROUP BY status`)
      .all() as Array<{ status: string; c: number }>;
    const use = this.db
      .prepare(`SELECT AVG(use_count) AS a FROM email_pool WHERE status = 'active'`)
      .get() as { a: number | null };
    const byStatus = new Map(rows.map((r) => [r.status, Number(r.c) || 0]));
    return {
      total: rows.reduce((s, r) => s + (Number(r.c) || 0), 0),
      active: byStatus.get("active") ?? 0,
      disabled: byStatus.get("disabled") ?? 0,
      error: byStatus.get("error") ?? 0,
      avgUse: Math.round((Number(use.a) || 0) * 10) / 10,
    };
  }

  /** Panel/API listing — password never leaves the store. */
  list(): Array<Omit<PoolEmail, "password">> {
    const rows = this.db
      .prepare(`SELECT * FROM email_pool ORDER BY created_at DESC LIMIT 200`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const { password: _pw, ...rest } = this.mapRow(r);
      return rest;
    });
  }

  private mapRow(r: Record<string, unknown>): PoolEmail {
    return {
      address: String(r.address),
      password: String(r.password),
      provider: String(r.provider),
      mailtmId: r.mailtm_id ? String(r.mailtm_id) : null,
      createdAt: String(r.created_at),
      lastUsedAt: r.last_used_at ? String(r.last_used_at) : null,
      useCount: Number(r.use_count) || 0,
      status: String(r.status) as PoolEmail["status"],
    };
  }
}

// ── process-wide singleton (worker + inlineClick share the same LRU view) ──
const pools = new Map<string, EmailPool>();

export function getEmailPool(outputDir: string): EmailPool {
  const key = resolve(outputDir);
  let pool = pools.get(key);
  if (!pool) {
    pool = new EmailPool(key);
    pools.set(key, pool);
  }
  return pool;
}

/** Close all pooled connections (short-lived CLI runs should call this). */
export function closeEmailPools(): void {
  for (const pool of pools.values()) pool.close();
  pools.clear();
}

/**
 * Pick the email for one report: pool LRU address when enabled and available,
 * otherwise the static fallback (config.report.reportEmail).
 * Also kicks an async top-up when the pool drops below minSize, so a long
 * report series never starts reusing addresses.
 */
export function acquireReportEmail(
  outputDir: string,
  opts: { enabled: boolean; minSize?: number; fallback: string }
): { email: string; fromPool: boolean } {
  if (opts.enabled) {
    try {
      const pool = getEmailPool(outputDir);
      pool.ensureSize(opts.minSize ?? 10);
      const acc = pool.acquire();
      if (acc) return { email: acc.address, fromPool: true };
      logger.warn("email pool empty — falling back to static reportEmail");
    } catch (err) {
      logger.warn({ err: String(err) }, "email pool acquire failed — falling back to static reportEmail");
    }
  }
  return { email: opts.fallback, fromPool: false };
}

/** Mark a pool address as consumed — only call when the form actually used it. */
export function markReportEmailUsed(outputDir: string, email: string, fromPool: boolean): void {
  if (!fromPool) return;
  try {
    getEmailPool(outputDir).markUsed(email);
  } catch (err) {
    logger.warn({ err: String(err) }, "email pool markUsed failed");
  }
}
