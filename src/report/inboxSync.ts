/**
 * Inbox poller (wave 3): periodically reads the mail.tm inboxes of ACTIVE
 * pool addresses, stores new messages in the `inbox_messages` table,
 * classifies them (google-confirmation / google-outcome / other) and links
 * each message back to the complaint row (clicks.id) that used the address.
 *
 * Rate-limit discipline: every address costs ~2 mail.tm calls (token + list),
 * counted against an hourly budget (report.inboxSyncPerHour, default 200).
 * A 429/5xx from mail.tm pauses the poller for 30 minutes — the same rule
 * the pool refill already follows.
 */
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { logger } from "../logger.js";
import { sleep } from "../util/time.js";
import { getEmailPool, isRateLimitOrServerError } from "./emailPool.js";

export type MailClass = "google-confirmation" | "google-outcome" | "other";

/** Pause all polling for this long after a 429/5xx from mail.tm. */
const RATE_LIMIT_BACKOFF_MS = 30 * 60_000;
/** Messages older than this are ignored (Google answers within days). */
const DEFAULT_LOOKBACK_DAYS = 7;
/** Clock-skew tolerance when matching a message to the click that sent it. */
const LINK_FUTURE_TOLERANCE_MS = 5 * 60_000;
/** Never link a message to a complaint older than this. */
const LINK_MAX_AGE_MS = 60 * 24 * 60 * 60_000;

const GOOGLE_FROM_RE = /(@|\.)(google|googlemail)\.com\s*$/i;
/** Confirmation pattern — same family emailPool.latestGoogleNotificationFull uses. */
const CONFIRM_RE = /gönderdiğiniz bildirim|your report|report you submitted|bildiriminiz/i;
/** Review-outcome keywords (TR + EN) seen in Google's decision mails. */
const OUTCOME_RE =
  /inceledik|inceleme|kaldırdık|kaldırıldı|askıya|askı|action taken|violation|ihlal|removed|removal|suspended|suspend|policy|politika|devre dışı/i;

/** Pure classifier — exported for tests. */
export function classifyMail(fromAddr: string, subject: string, snippet: string): MailClass {
  if (!GOOGLE_FROM_RE.test(fromAddr)) return "other";
  // Outcome keywords in the SUBJECT are decisive ("Action taken on your
  // report…" also contains the confirmation phrase, but it is a decision).
  if (OUTCOME_RE.test(subject)) return "google-outcome";
  if (CONFIRM_RE.test(subject)) return "google-confirmation";
  if (OUTCOME_RE.test(snippet)) return "google-outcome";
  return "other";
}

export interface InboxMessage {
  id: string;
  emailAddr: string;
  fromAddr: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  classified: MailClass;
  linkedClickId: number | null;
}

export interface MailListQuery {
  page: number;
  limit: number;
  keyword?: string;
  domain?: string;
  classified?: string;
  dateFromIso?: string;
  dateToIso?: string;
}

/** SQLite access for inbox_messages (+ lazy body cache). */
export class InboxStore {
  readonly db: DatabaseSync;

  constructor(outputDir: string) {
    const dbPath = resolve(outputDir, "detect.sqlite");
    this.db = new DatabaseSync(dbPath);
    // Multiple stores share detect.sqlite (ClickStore, Store, pool) — wait for locks.
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inbox_messages (
        id              TEXT PRIMARY KEY,
        email_addr      TEXT NOT NULL,
        from_addr       TEXT,
        subject         TEXT,
        snippet         TEXT,
        body_text       TEXT,
        received_at     TEXT,
        classified      TEXT NOT NULL DEFAULT 'other',
        linked_click_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_inbox_received ON inbox_messages(received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_inbox_classified ON inbox_messages(classified);
      CREATE INDEX IF NOT EXISTS idx_inbox_click ON inbox_messages(linked_click_id);
      CREATE INDEX IF NOT EXISTS idx_inbox_addr ON inbox_messages(email_addr);
    `);
    // Migration for DBs created before body caching existed.
    try {
      this.db.exec(`ALTER TABLE inbox_messages ADD COLUMN body_text TEXT;`);
    } catch {
      /* already exists */
    }
  }

  /** Insert when new; returns true when the row was actually added. */
  insertMessage(m: InboxMessage): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO inbox_messages
           (id, email_addr, from_addr, subject, snippet, received_at, classified, linked_click_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(m.id, m.emailAddr, m.fromAddr, m.subject, m.snippet, m.receivedAt, m.classified, m.linkedClickId);
    return Number(info.changes) > 0;
  }

  /**
   * Link a message to the complaint that used its address: the newest click
   * whose report email matches and that happened BEFORE the message arrived
   * (pool addresses rotate, so "latest before received_at" is the right one).
   */
  linkClick(emailAddr: string, receivedAt: string): number | null {
    const recvMs = Date.parse(receivedAt);
    if (!Number.isFinite(recvMs)) return null;
    const maxCaptured = new Date(recvMs + LINK_FUTURE_TOLERANCE_MS).toISOString();
    const minCaptured = new Date(recvMs - LINK_MAX_AGE_MS).toISOString();
    const row = this.db
      .prepare(
        `SELECT c.id FROM clicks c
         WHERE c.report_message LIKE '%' || ? || '%'
           AND c.report_status IN ('submitted','filled','submit-failed')
           AND c.captured_at <= ?
           AND c.captured_at >= ?
         ORDER BY c.captured_at DESC LIMIT 1`
      )
      .get(emailAddr, maxCaptured, minCaptured) as { id: number } | undefined;
    return row ? Number(row.id) : null;
  }

  list(q: MailListQuery): { total: number; results: Array<InboxMessage & { keyword: string | null; domain: string | null }> } {
    const parts: string[] = ["1=1"];
    const params: unknown[] = [];
    if (q.keyword) {
      parts.push(`LOWER(c.keyword) LIKE ?`);
      params.push(`%${q.keyword.toLowerCase()}%`);
    }
    if (q.domain) {
      parts.push(`LOWER(c.target_domain) LIKE ?`);
      params.push(`%${q.domain.toLowerCase()}%`);
    }
    if (q.classified && ["google-confirmation", "google-outcome", "other"].includes(q.classified)) {
      parts.push(`m.classified = ?`);
      params.push(q.classified);
    }
    if (q.dateFromIso) {
      parts.push(`m.received_at >= ?`);
      params.push(q.dateFromIso);
    }
    if (q.dateToIso) {
      parts.push(`m.received_at <= ?`);
      params.push(q.dateToIso);
    }
    const where = parts.join(" AND ");
    const join = `FROM inbox_messages m LEFT JOIN clicks c ON m.linked_click_id = c.id`;
    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) AS c ${join} WHERE ${where}`).get(...(params as string[])) as { c: number }).c
    ) || 0;
    const rows = this.db
      .prepare(
        `SELECT m.*, c.keyword AS kw, c.target_domain AS dom
         ${join} WHERE ${where}
         ORDER BY m.received_at DESC, m.id DESC LIMIT ? OFFSET ?`
      )
      .all(...(params as string[]), q.limit, (q.page - 1) * q.limit) as Array<Record<string, unknown>>;
    return {
      total,
      results: rows.map((r) => ({
        ...this.mapRow(r),
        keyword: r.kw ? String(r.kw) : null,
        domain: r.dom ? String(r.dom) : null,
      })),
    };
  }

  stats(): {
    total: number;
    confirmations: number;
    outcomes: number;
    other: number;
    linked: number;
    trend: Array<{ day: string; count: number }>;
  } {
    const byClass = new Map(
      (
        this.db.prepare(`SELECT classified, COUNT(*) AS c FROM inbox_messages GROUP BY classified`).all() as Array<{
          classified: string;
          c: number;
        }>
      ).map((r) => [r.classified, Number(r.c) || 0])
    );
    const total = [...byClass.values()].reduce((a, b) => a + b, 0);
    const linked = Number(
      (this.db.prepare(`SELECT COUNT(*) AS c FROM inbox_messages WHERE linked_click_id IS NOT NULL`).get() as { c: number }).c
    ) || 0;
    const since = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
    const trendRows = this.db
      .prepare(
        `SELECT substr(received_at, 1, 10) AS day, COUNT(*) AS c
         FROM inbox_messages WHERE received_at >= ? GROUP BY day`
      )
      .all(since) as Array<{ day: string; c: number }>;
    const byDay = new Map(trendRows.map((r) => [r.day, Number(r.c) || 0]));
    const trend: Array<{ day: string; count: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      trend.push({ day, count: byDay.get(day) ?? 0 });
    }
    return {
      total,
      confirmations: byClass.get("google-confirmation") ?? 0,
      outcomes: byClass.get("google-outcome") ?? 0,
      other: byClass.get("other") ?? 0,
      linked,
      trend,
    };
  }

  get(id: string): (InboxMessage & { bodyText: string | null }) | null {
    const row = this.db.prepare(`SELECT * FROM inbox_messages WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return { ...this.mapRow(row), bodyText: row.body_text ? String(row.body_text) : null };
  }

  /** Cache the fetched plain-text body so the detail view costs mail.tm once. */
  saveBody(id: string, text: string): void {
    this.db.prepare(`UPDATE inbox_messages SET body_text = ? WHERE id = ?`).run(text, id);
  }

  /** Mails linked to any of the given click ids (public proof page). */
  forClicks(clickIds: number[]): Array<InboxMessage> {
    if (!clickIds.length) return [];
    const marks = clickIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM inbox_messages WHERE linked_click_id IN (${marks}) ORDER BY received_at ASC`)
      .all(...clickIds) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  private mapRow(r: Record<string, unknown>): InboxMessage {
    return {
      id: String(r.id),
      emailAddr: String(r.email_addr ?? ""),
      fromAddr: String(r.from_addr ?? ""),
      subject: String(r.subject ?? ""),
      snippet: String(r.snippet ?? ""),
      receivedAt: String(r.received_at ?? ""),
      classified: String(r.classified ?? "other") as MailClass,
      linkedClickId: r.linked_click_id != null ? Number(r.linked_click_id) : null,
    };
  }
}

export interface InboxSyncStatus {
  lastRunAt: string | null;
  lastInserted: number;
  lastScannedAddresses: number;
  backoffUntil: string | null;
  callsUsedThisHour: number;
  perHour: number;
}

const syncStatus: InboxSyncStatus = {
  lastRunAt: null,
  lastInserted: 0,
  lastScannedAddresses: 0,
  backoffUntil: null,
  callsUsedThisHour: 0,
  perHour: 0,
};

/** Panel/status introspection for the poller. */
export function inboxSyncStatus(): InboxSyncStatus {
  return { ...syncStatus };
}

export interface InboxSyncOptions {
  outputDir: string;
  /** Tick interval — config report.inboxSyncMinutes (default 15). */
  intervalMinutes: number;
  /** Hourly mail.tm call budget — config report.inboxSyncPerHour (default 200). */
  perHour: number;
  lookbackDays?: number;
}

/**
 * Start the periodic poller. Active addresses are walked with a rotating
 * cursor so every tick covers a different slice; with the default budget
 * (200 calls/h ≈ 100 addresses/h) a 500-address pool is swept every ~5h.
 * Inserts are idempotent (mail.tm message id is the PK), so overlap between
 * ticks is harmless.
 */
export function startInboxSync(opts: InboxSyncOptions): { stop: () => void } {
  const intervalMs = Math.max(1, opts.intervalMinutes) * 60_000;
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  let cursor = 0;
  let windowStart = Date.now();
  let usedThisHour = 0;
  let backoffUntil = 0;
  let inFlight = false;
  let stopped = false;

  syncStatus.perHour = opts.perHour;

  const tick = async (): Promise<void> => {
    if (inFlight || stopped) return;
    if (Date.now() < backoffUntil) return;
    inFlight = true;
    const store = new InboxStore(opts.outputDir);
    try {
      if (Date.now() - windowStart >= 60 * 60_000) {
        windowStart = Date.now();
        usedThisHour = 0;
      }
      const pool = getEmailPool(opts.outputDir);
      const addresses = pool.activeAddresses();
      if (!addresses.length) return;
      // Each address costs ~2 calls (token + list) — stop early so a tick
      // never blows the hourly budget mid-sweep.
      const budgetLeft = Math.max(0, opts.perHour - usedThisHour);
      const maxAddresses = Math.floor(budgetLeft / 2);
      if (maxAddresses <= 0) return;
      const sinceMs = Date.now() - lookbackDays * 86_400_000;
      let scanned = 0;
      let inserted = 0;
      for (let i = 0; i < Math.min(maxAddresses, addresses.length); i++) {
        if (stopped) break;
        const address = addresses[(cursor + i) % addresses.length]!;
        let msgs: Awaited<ReturnType<typeof pool.inboxList>>;
        try {
          msgs = await pool.inboxList(address);
          usedThisHour += 2;
        } catch (err) {
          if (isRateLimitOrServerError(err)) {
            backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
            logger.warn(
              { until: new Date(backoffUntil).toISOString() },
              "inbox sync: mail.tm rate limited — pausing for 30 min"
            );
            break;
          }
          logger.debug({ err: String(err), address }, "inbox sync: address fetch failed — skipping");
          continue;
        }
        scanned++;
        for (const m of msgs) {
          const recvMs = Date.parse(m.createdAt);
          if (!Number.isFinite(recvMs) || recvMs < sinceMs) continue;
          const linkedClickId = store.linkClick(address, m.createdAt);
          const added = store.insertMessage({
            id: m.id,
            emailAddr: address,
            fromAddr: m.from,
            subject: m.subject,
            snippet: m.intro,
            receivedAt: m.createdAt,
            classified: classifyMail(m.from, m.subject, m.intro),
            linkedClickId,
          });
          if (added) inserted++;
        }
        // Polite pacing under mail.tm's 8 QPS cap (token + list per address).
        await sleep(400);
      }
      cursor = (cursor + scanned) % Math.max(1, addresses.length);
      syncStatus.lastRunAt = new Date().toISOString();
      syncStatus.lastInserted = inserted;
      syncStatus.lastScannedAddresses = scanned;
      syncStatus.backoffUntil = Date.now() < backoffUntil ? new Date(backoffUntil).toISOString() : null;
      syncStatus.callsUsedThisHour = usedThisHour;
      if (inserted > 0) {
        logger.info({ inserted, scanned, usedThisHour, perHour: opts.perHour }, "inbox sync tick done");
      }
    } catch (err) {
      logger.debug({ err: String(err) }, "inbox sync tick failed");
    } finally {
      store.close();
      inFlight = false;
    }
  };

  // First sweep shortly after boot, then on the configured interval.
  const bootTimer = setTimeout(() => void tick(), 60_000);
  const timer = setInterval(() => void tick(), intervalMs);
  return {
    stop() {
      stopped = true;
      clearTimeout(bootTimer);
      clearInterval(timer);
    },
  };
}
