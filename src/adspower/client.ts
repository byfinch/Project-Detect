import { RateLimiter } from "../util/time.js";
import { logger } from "../logger.js";

export interface AdsPowerWs {
  puppeteer: string;
  selenium: string;
}

export interface StartResult {
  ws: AdsPowerWs;
  debug_port?: string;
  webdriver?: string;
}

export interface ActiveResult {
  status: "Active" | "Inactive";
  ws?: AdsPowerWs;
  debug_port?: string;
}

export interface UserProxyConfig {
  proxy_soft?: string;
  proxy_type?: string;
  proxy_host?: string;
  proxy_port?: string | number;
  proxy_user?: string;
  proxy_password?: string;
  proxy_url?: string;
}

/** AdsPower fingerprint_config payload accepted by /api/v1/user/update. */
export interface FingerprintConfig {
  automatic_timezone?: string;
  language?: string[];
  ua?: string;
  webrtc?: string;
  flash?: string;
  canvas?: string;
  webgl_image?: string;
  [key: string]: unknown;
}

export interface ProfileSummary {
  user_id: string;
  serial_number: string;
  name: string;
  group_id: string;
  group_name: string;
  domain_name?: string;
  ip?: string;
  ip_country?: string;
  remark?: string;
  last_open_time?: string;
  user_proxy_config?: UserProxyConfig;
}

/** 2captcha-ready proxy credentials extracted from an AdsPower profile. */
export interface CaptchaProxy {
  /** `user:pass@host:port` or `host:port` */
  proxy: string;
  proxytype: "HTTP" | "HTTPS" | "SOCKS4" | "SOCKS5";
  /** Exit IP if AdsPower last-checked it (for logs only). */
  exitIp?: string;
}

/** Build a 2captcha proxy descriptor from AdsPower's user_proxy_config (never log the password). */
export function captchaProxyFromProfile(p: ProfileSummary): CaptchaProxy | null {
  const c = p.user_proxy_config;
  if (!c?.proxy_host || c.proxy_port === undefined || c.proxy_port === "") return null;
  const raw = (c.proxy_type || "http").toLowerCase();
  let proxytype: CaptchaProxy["proxytype"] = "HTTP";
  if (raw.includes("socks5")) proxytype = "SOCKS5";
  else if (raw.includes("socks4")) proxytype = "SOCKS4";
  else if (raw === "https") proxytype = "HTTPS";
  else proxytype = "HTTP";

  const host = c.proxy_host;
  const port = String(c.proxy_port);
  const proxy =
    c.proxy_user != null && c.proxy_user !== ""
      ? `${c.proxy_user}:${c.proxy_password ?? ""}@${host}:${port}`
      : `${host}:${port}`;
  return { proxy, proxytype, exitIp: p.ip };
}

export interface GroupSummary {
  group_id: string;
  group_name: string;
  remark?: string;
}

export class AdsPowerError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly path: string
  ) {
    super(`AdsPower ${path}: ${message} (code ${code})`);
    this.name = "AdsPowerError";
  }
}

interface ApiEnvelope<T> {
  code: number;
  msg: string;
  data: T;
}

interface StartOptions {
  headless?: boolean;
  /** open_tabs=1 suppresses AdsPower platform/history tabs. */
  suppressPlatformTabs?: boolean;
  /** ip_tab=0 avoids polluting the first tab with the IP-check page. */
  openIpTab?: boolean;
  /**
   * Restore last session tabs (default false).
   * MUST stay false — otherwise reopening reloads the last brand/trend SERP.
   */
  restoreLastTabs?: boolean;
}

/**
 * Client for the AdsPower Local API.
 *
 * Contract (verified against a live install):
 *  - Auth is an `Authorization: Bearer <key>` header on every call. `/status` is exempt.
 *  - Errors return HTTP 200 with { code: -1, msg }, so we branch on the body's `code`.
 *  - Everything is serialised through a 1 req/s limiter; a "Too many request" body is retried.
 */
export class AdsPowerClient {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    requestIntervalMs: number
  ) {
    this.limiter = new RateLimiter(requestIntervalMs);
  }

  private headers(hasBody = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    if (hasBody) h["Content-Type"] = "application/json";
    return h;
  }

  private buildUrl(path: string, params?: Record<string, string | number | undefined>): string {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  /** One HTTP attempt, with a hard timeout so a wedged Local API can't stall for minutes. */
  private async fetchOnce<T>(
    path: string,
    opts: { params?: Record<string, string | number | undefined>; method: "GET" | "POST"; body?: unknown }
  ): Promise<ApiEnvelope<T>> {
    const url = this.buildUrl(path, opts.params);
    const res = await fetch(url, {
      method: opts.method,
      headers: this.headers(opts.body !== undefined),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
    }
    return (await res.json()) as ApiEnvelope<T>;
  }

  private async request<T>(
    path: string,
    opts: { params?: Record<string, string | number | undefined>; method?: "GET" | "POST"; body?: unknown } = {}
  ): Promise<T> {
    const method = opts.method ?? "GET";
    // Hard total deadline: the rate-limiter queue (or repeated retries) must not
    // let a request hang forever while the Local API is wedged.
    const deadline = Date.now() + 60_000;
    let lastMsg = "unknown error";
    for (let attempt = 1; attempt <= 4; attempt++) {
      if (Date.now() > deadline) throw new AdsPowerError("request deadline exceeded (60s)", -1, path);
      // Each attempt (incl. retries) goes through the limiter, so retries are spaced >= 1/s too.
      let json: ApiEnvelope<T>;
      try {
        json = await this.limiter.schedule(() => this.fetchOnce<T>(path, { params: opts.params, method, body: opts.body }));
        if (Date.now() > deadline) throw new Error("AdsPower request deadline exceeded (60s)");
      } catch (err) {
        const msg = String(err);
        // Past the total deadline (mostly time lost in the limiter queue) — stop.
        if (msg.includes("deadline exceeded")) throw new AdsPowerError("request deadline exceeded (60s)", -1, path);
        // 4xx (except 429) is a client error — retrying cannot help.
        if (/HTTP 4(?!29)\d/.test(msg)) throw new AdsPowerError(msg, -1, path);
        lastMsg = `network error: ${msg}`;
        logger.warn({ path, attempt, err: msg }, "AdsPower request failed at transport");
        continue;
      }
      if (json.code === 0) return json.data;
      lastMsg = json.msg;
      if (/too many request/i.test(json.msg ?? "")) continue;
      throw new AdsPowerError(json.msg, json.code, path);
    }
    throw new AdsPowerError(`retries exhausted: ${lastMsg}`, -1, path);
  }

  /** Liveness probe. Returns true if the Local API answers. */
  async isUp(): Promise<boolean> {
    try {
      const res = await fetch(this.buildUrl("/status"), { signal: AbortSignal.timeout(5000) });
      const json = (await res.json()) as ApiEnvelope<unknown>;
      return json.code === 0;
    } catch {
      return false;
    }
  }

  async listGroups(): Promise<GroupSummary[]> {
    const data = await this.request<{ list: GroupSummary[] }>("/api/v1/group/list", {
      params: { page: 1, page_size: 2000 },
    });
    return data.list ?? [];
  }

  async listProfiles(groupId?: string): Promise<ProfileSummary[]> {
    const out: ProfileSummary[] = [];
    for (let page = 1; page <= 50; page++) {
      const data = await this.request<{ list: ProfileSummary[]; page: number; page_size: number }>("/api/v1/user/list", {
        params: { group_id: groupId, page, page_size: 100 },
      });
      const list = data.list ?? [];
      out.push(...list);
      if (list.length < 100) break;
    }
    return out;
  }

  async browserActive(userId: string): Promise<ActiveResult> {
    return this.request<ActiveResult>("/api/v1/browser/active", { params: { user_id: userId } });
  }

  async startBrowser(userId: string, opts: StartOptions = {}): Promise<StartResult> {
    // last_opened_tabs=0: do not reopen previous SERP/trend when profile starts.
    // open_tabs=1: skip AdsPower junk tabs. ip_tab=0: no proxy-check first tab.
    return this.request<StartResult>("/api/v1/browser/start", {
      params: {
        user_id: userId,
        headless: opts.headless ? 1 : 0,
        open_tabs: opts.suppressPlatformTabs === false ? 0 : 1,
        ip_tab: opts.openIpTab ? 1 : 0,
        last_opened_tabs: opts.restoreLastTabs ? 1 : 0,
      },
    });
  }

  async stopBrowser(userId: string, clean = true): Promise<void> {
    // Default clean=true so AdsPower does not keep a dirty session snapshot.
    await this.request<unknown>("/api/v1/browser/stop", {
      params: { user_id: userId, clean: clean ? 1 : 0 },
    });
  }

  /**
   * Set startup tabs to a clean Google home (no leftover brand search URL).
   * Does not touch fingerprint or proxy.
   */
  async setStartupTabs(userId: string, tabs: string[]): Promise<void> {
    await this.request<unknown>("/api/v1/user/update", {
      method: "POST",
      body: { user_id: userId, tabs },
    });
  }

  async updateProfile(userId: string, fingerprintConfig: FingerprintConfig): Promise<void> {
    await this.request<unknown>("/api/v1/user/update", {
      method: "POST",
      body: { user_id: userId, fingerprint_config: fingerprintConfig },
    });
  }


  /**
   * Return a live CDP websocket endpoint for the profile, re-using the running
   * browser if it is already Active, otherwise launching it.
   */
  async ensureBrowser(userId: string, opts: StartOptions = {}): Promise<string> {
    const active = await this.browserActive(userId).catch((err) => {
      logger.warn({ err: String(err) }, "browserActive check failed");
      return null;
    });
    if (active?.status === "Active" && active.ws?.puppeteer) {
      logger.info({ userId }, "AdsPower profile already active — re-attaching");
      return active.ws.puppeteer;
    }
    const started = await this.startBrowser(userId, opts);
    if (!started.ws?.puppeteer) {
      throw new AdsPowerError("browser/start returned no ws.puppeteer endpoint", -1, "/api/v1/browser/start");
    }
    return started.ws.puppeteer;
  }
}
