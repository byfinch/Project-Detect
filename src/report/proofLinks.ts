/**
 * Customer proof links (wave 3): short random tokens that open a PUBLIC,
 * login-free page (/proof/:token) listing the filtered complaints plus the
 * Google reply mails linked to them. Tokens expire (default 30 days).
 *
 * The public page must NEVER leak pool credentials — only masked addresses
 * (pd***@domain) leave the server.
 */
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ProofFilters {
  domain?: string;
  keyword?: string;
}

export interface ProofLink {
  token: string;
  filters: ProofFilters;
  createdAt: string;
  expiresAt: string;
}

const DEFAULT_TTL_DAYS = 30;
const MAX_TTL_DAYS = 365;

export class ProofLinkStore {
  private db: DatabaseSync;

  constructor(outputDir: string) {
    const dbPath = resolve(outputDir, "detect.sqlite");
    this.db = new DatabaseSync(dbPath);
    // Multiple stores share detect.sqlite — wait for locks.
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proof_links (
        token      TEXT PRIMARY KEY,
        filters    TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
  }

  create(filters: ProofFilters, days?: number): ProofLink {
    const ttl = Math.min(MAX_TTL_DAYS, Math.max(1, Number(days) || DEFAULT_TTL_DAYS));
    const token = randomBytes(12).toString("hex"); // 24 hex chars, unguessable
    const now = new Date();
    const link: ProofLink = {
      token,
      filters: {
        ...(filters.domain ? { domain: filters.domain } : {}),
        ...(filters.keyword ? { keyword: filters.keyword } : {}),
      },
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl * 86_400_000).toISOString(),
    };
    this.db
      .prepare(`INSERT INTO proof_links (token, filters, created_at, expires_at) VALUES (?, ?, ?, ?)`)
      .run(link.token, JSON.stringify(link.filters), link.createdAt, link.expiresAt);
    return link;
  }

  /** Null when unknown or expired — the public page treats both as gone. */
  get(token: string): ProofLink | null {
    if (!/^[a-f0-9]{16,64}$/.test(token)) return null;
    const row = this.db
      .prepare(`SELECT token, filters, created_at, expires_at FROM proof_links WHERE token = ?`)
      .get(token) as Record<string, unknown> | undefined;
    if (!row) return null;
    const expiresAt = String(row.expires_at);
    if (Date.parse(expiresAt) < Date.now()) return null;
    let filters: ProofFilters = {};
    try {
      const parsed = JSON.parse(String(row.filters || "{}")) as Record<string, unknown>;
      if (typeof parsed.domain === "string" && parsed.domain) filters.domain = parsed.domain;
      if (typeof parsed.keyword === "string" && parsed.keyword) filters.keyword = parsed.keyword;
    } catch {
      /* malformed filters → unfiltered */
    }
    return {
      token: String(row.token),
      filters,
      createdAt: String(row.created_at),
      expiresAt,
    };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

/** pd1a2b3c4d@web-library.net → pd***@web-library.net (public page masking). */
export function maskPoolAddress(addr: string): string {
  const at = addr.indexOf("@");
  if (at <= 0) return "***";
  const local = addr.slice(0, at);
  return `${local.slice(0, 2)}***${addr.slice(at)}`;
}
