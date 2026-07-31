import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "../config.js";
import { Store } from "../store/db.js";
import { runScan } from "../scanner.js";
import { logger } from "../logger.js";

/**
 * Richness watcher (ops Package 1).
 *
 * Measures ad serve-rate per brand x device with LIGHT probes (1 profile,
 * 1 keyword per probe) and produces a per-domain RichnessScore the planner
 * consumes. Probing is budget-capped to `ops.watchBudgetPct` of the measured
 * safe per-IP budget (40 queries/hour) so the watcher can never starve the
 * actual click operation.
 *
 * State persists in <outputDir>/ops-richness.json (survives restarts; scores
 * decay with age so stale richness cannot keep a domain "rich" forever).
 */

/** Measured safe query budget per IP per hour (wall-free evidence). */
export const SAFE_QUERIES_PER_HOUR = 40;

/** Score half-life: a domain seen N hours ago counts adCount * 0.5^(N/6). */
const SCORE_HALF_LIFE_HOURS = 6;

/** Max probes per watcher tick (round-robin covers the rest on later ticks). */
const MAX_PROBES_PER_TICK = 2;

export interface RichnessScore {
  /** Advertiser display domain, or "app:<finalDomain>" for app-install cards. */
  key: string;
  /** Brand (from ops.brandPriority) this domain was observed under, if any. */
  brand: string | null;
  adCount: number;
  /** device -> ads seen on that device. */
  devices: Record<string, number>;
  keywords: string[];
  lastSeenAt: string;
  /** Time-decayed score: adCount * 0.5^(ageHours/6). */
  score: number;
}

export interface RichnessSnapshot {
  generatedAt: string;
  watcher: {
    running: boolean;
    lastTickAt: string | null;
    lastProbeAt: string | null;
    /** Rolling 1h query usage vs the watcher budget. */
    queriesLastHour: number;
    budgetPerHour: number;
  };
  domains: RichnessScore[];
}

export interface ActiveDomain {
  key: string;
  brand: string;
  /** Device with the most observed ads for this domain. */
  device: string;
  keywords: string[];
  adCount: number;
  score: number;
  lastSeenAt: string;
}

interface DomainState {
  brand: string | null;
  adCount: number;
  devices: Record<string, number>;
  keywords: string[];
  lastSeenAt: string;
}

interface PersistedState {
  version: number;
  domains: Record<string, DomainState>;
  watch: {
    /** Rolling 1h window of executed watch queries (ISO timestamps). */
    queries: string[];
    /** Round-robin cursor into the brand x device probe matrix. */
    cursor: number;
    lastTickAt: string | null;
    lastProbeAt: string | null;
  };
}

export interface RichnessDeps {
  config: AppConfig;
  /** True while a classic scan/click/campaign/storm is running — watcher yields. */
  isBusy: () => boolean;
  /** True while the health valve is calm — watcher pauses too (budget protection). */
  isCalm: () => boolean;
  /** SSE/event sink (same shape as the panel's emitEvent). */
  emit: (event: Record<string, unknown>) => void;
}

interface ModuleState {
  outputDir: string;
  richThreshold: number;
  domains: Map<string, DomainState>;
  queries: number[];
  cursor: number;
  lastTickAt: string | null;
  lastProbeAt: string | null;
}

let state: ModuleState | null = null;
let deps: RichnessDeps | null = null;
let timer: NodeJS.Timeout | null = null;
let tickInFlight = false;

function storagePath(outputDir: string): string {
  return resolve(outputDir, "ops-richness.json");
}

function emptyState(outputDir: string, richThreshold: number): ModuleState {
  return {
    outputDir,
    richThreshold,
    domains: new Map(),
    queries: [],
    cursor: 0,
    lastTickAt: null,
    lastProbeAt: null,
  };
}

function persist(): void {
  if (!state) return;
  try {
    mkdirSync(state.outputDir, { recursive: true });
    const out: PersistedState = {
      version: 1,
      domains: Object.fromEntries(state.domains),
      watch: {
        queries: state.queries.map((t) => new Date(t).toISOString()),
        cursor: state.cursor,
        lastTickAt: state.lastTickAt,
        lastProbeAt: state.lastProbeAt,
      },
    };
    writeFileSync(storagePath(state.outputDir), JSON.stringify(out, null, 2), "utf8");
  } catch (err) {
    logger.warn({ err: String(err) }, "ops richness: persist failed");
  }
}

/**
 * Bind the module to an output dir and load persisted scores. Safe to call
 * on every boot regardless of ops.enabled — it only reads a JSON file.
 */
export function initRichness(outputDir: string, richThreshold = 2): void {
  state = emptyState(outputDir, richThreshold);
  try {
    const path = storagePath(outputDir);
    if (!existsSync(path)) return;
    const raw = JSON.parse(readFileSync(path, "utf8")) as PersistedState;
    for (const [key, d] of Object.entries(raw.domains ?? {})) {
      state.domains.set(key, {
        brand: d.brand ?? null,
        adCount: Number(d.adCount ?? 0),
        devices: d.devices ?? {},
        keywords: Array.isArray(d.keywords) ? d.keywords.slice(0, 20) : [],
        lastSeenAt: d.lastSeenAt ?? new Date(0).toISOString(),
      });
    }
    state.queries = (raw.watch?.queries ?? []).map((s) => new Date(s).getTime()).filter((t) => Number.isFinite(t));
    state.cursor = Number(raw.watch?.cursor ?? 0) || 0;
    state.lastTickAt = raw.watch?.lastTickAt ?? null;
    state.lastProbeAt = raw.watch?.lastProbeAt ?? null;
  } catch (err) {
    logger.warn({ err: String(err) }, "ops richness: load failed — starting empty");
  }
}

function requireState(): ModuleState {
  if (!state) throw new Error("ops richness not initialized — call initRichness() first");
  return state;
}

function decayedScore(domain: DomainState, now = Date.now()): number {
  const ageHours = Math.max(0, (now - new Date(domain.lastSeenAt).getTime()) / 3_600_000);
  return Math.round(domain.adCount * Math.pow(0.5, ageHours / SCORE_HALF_LIFE_HOURS) * 100) / 100;
}

function toScore(key: string, domain: DomainState): RichnessScore {
  return {
    key,
    brand: domain.brand,
    adCount: domain.adCount,
    devices: { ...domain.devices },
    keywords: [...domain.keywords],
    lastSeenAt: domain.lastSeenAt,
    score: decayedScore(domain),
  };
}

/** Match a scanned keyword back to its brand (base query or "<brand> <suffix>"). */
function brandOfKeyword(keyword: string, brandPriority: string[]): string | null {
  const kw = keyword.toLocaleLowerCase("tr");
  for (const b of brandPriority) {
    const brand = b.toLocaleLowerCase("tr");
    if (kw === brand || kw.startsWith(`${brand} `)) return brand;
  }
  return null;
}

/**
 * Fold the results of a finished scan into the richness table. Called after
 * watcher probes AND (by the panel) after classic scans — classic scan data
 * is free signal that saves watcher budget.
 */
export function ingestScanResults(scanId: number, brandPriority: string[]): number {
  const st = requireState();
  const store = new Store(st.outputDir);
  let rows: Array<Record<string, unknown>>;
  try {
    rows = store.db
      .prepare(`SELECT keyword, device, display_domain, final_domain FROM results WHERE scan_id = ?`)
      .all(scanId) as Array<Record<string, unknown>>;
  } finally {
    store.close();
  }

  const now = new Date().toISOString();
  const seen = new Map<string, { brand: string | null; device: string; keyword: string }>();
  for (const r of rows) {
    const display = String(r.display_domain ?? "").trim().toLowerCase();
    const final = String(r.final_domain ?? "").trim().toLowerCase();
    // App-install cards often have no usable display domain — keep them as
    // "app:<finalDomain>" so the planner can still target them.
    const key = display || (final ? `app:${final}` : "");
    if (!key) continue;
    const keyword = String(r.keyword ?? "");
    if (!seen.has(key)) {
      seen.set(key, { brand: brandOfKeyword(keyword, brandPriority), device: String(r.device ?? ""), keyword });
    }
  }

  for (const [key, hit] of seen) {
    const prev = st.domains.get(key);
    // Recency-first keyword order: the keyword the ad was just seen on leads,
    // the brand's other keywords stay behind it for rotation. The planner
    // carries this order into the plan and the engine searches it first.
    const rest = (prev?.keywords ?? []).filter((k) => k !== hit.keyword);
    const keywords = [hit.keyword, ...rest].slice(0, 20);
    st.domains.set(key, {
      brand: hit.brand ?? prev?.brand ?? null,
      // Count = ads observed in THIS observation (freshness beats accumulation —
      // a decaying pile of old ads would mask a window that just went poor).
      adCount: rows.filter((r) => {
        const d = String(r.display_domain ?? "").trim().toLowerCase();
        const f = String(r.final_domain ?? "").trim().toLowerCase();
        return (d || (f ? `app:${f}` : "")) === key;
      }).length,
      devices: (() => {
        const devices: Record<string, number> = { ...(prev?.devices ?? {}) };
        devices[hit.device] = (devices[hit.device] ?? 0) + 1;
        return devices;
      })(),
      keywords,
      lastSeenAt: now,
    });
  }
  persist();
  return seen.size;
}

/** Watcher budget: pct of the measured safe 40 q/h, at least 1 when enabled. */
export function watchBudgetPerHour(watchBudgetPct: number): number {
  return Math.max(1, Math.floor((SAFE_QUERIES_PER_HOUR * watchBudgetPct) / 100));
}

/** Full snapshot for the panel API / planner. */
export function getRichnessSnapshot(): RichnessSnapshot {
  const st = requireState();
  const hourAgo = Date.now() - 3_600_000;
  const queriesLastHour = st.queries.filter((t) => t > hourAgo).length;
  const domains = [...st.domains.entries()]
    .map(([key, d]) => toScore(key, d))
    .sort((a, b) => b.score - a.score);
  return {
    generatedAt: new Date().toISOString(),
    watcher: {
      running: timer !== null,
      lastTickAt: st.lastTickAt,
      lastProbeAt: st.lastProbeAt,
      queriesLastHour,
      budgetPerHour: deps ? watchBudgetPerHour(deps.config.ops.watchBudgetPct) : 0,
    },
    domains,
  };
}

/**
 * Rich domains (score >= ops.richThreshold) mapped onto the brand priority
 * list — the planner's raw material. Ordered by brand priority, then score.
 */
export function getActiveDomains(brandPriority: string[]): ActiveDomain[] {
  const st = requireState();
  const out: ActiveDomain[] = [];
  for (const brand of brandPriority) {
    const b = brand.toLocaleLowerCase("tr");
    const candidates = [...st.domains.entries()]
      .filter(([, d]) => d.brand === b)
      .map(([key, d]) => ({ key, d, score: decayedScore(d) }))
      .filter((c) => c.score >= st.richThreshold)
      .sort((x, y) => y.score - x.score);
    for (const c of candidates) {
      const deviceEntries = Object.entries(c.d.devices).sort((a, z) => z[1] - a[1]);
      out.push({
        key: c.key,
        brand: b,
        device: deviceEntries[0]?.[0] ?? "desktop",
        keywords: [...c.d.keywords],
        adCount: c.d.adCount,
        score: c.score,
        lastSeenAt: c.d.lastSeenAt,
      });
    }
  }
  return out;
}

/**
 * Probe matrix: every brand ROOT keyword x device FIRST, then every
 * "<brand> <variant>" x device (ops.watchVariants). Live case: the ad was
 * served on "herabet bonus" while the watcher only probed the root — the
 * variant set closes that blind spot. Budget rules are unchanged (max
 * probes/tick) — a longer matrix just means a longer round-robin cycle.
 */
function probeMatrix(config: AppConfig): Array<{ keyword: string; device: string }> {
  const roots: Array<{ keyword: string; device: string }> = [];
  const variants: Array<{ keyword: string; device: string }> = [];
  for (const brand of config.ops.brandPriority) {
    const b = brand.toLocaleLowerCase("tr");
    for (const device of config.devices) roots.push({ keyword: b, device });
    for (const v of config.ops.watchVariants) {
      const variant = v.trim();
      if (!variant) continue;
      for (const device of config.devices) variants.push({ keyword: `${b} ${variant}`, device });
    }
  }
  return [...roots, ...variants];
}

/**
 * One light probe: single profile, single keyword, single device.
 * Reuses the full scanner pipeline (trend warm-up, vault, captcha policy) so
 * probes behave exactly like classic scans, just tiny. Marked with the
 * "ops-watch" scan note so panel scan guards do not confuse it with a
 * classic scan.
 */
async function runProbe(config: AppConfig, keyword: string, device: string): Promise<number> {
  const probeConfig: AppConfig = {
    ...config,
    devices: [device as AppConfig["devices"][number]],
    // Probe scans are pure signal: no JSON/CSV report files per tick.
    output: { ...config.output, json: false, csv: false },
    scan: {
      ...config.scan,
      concurrency: 1,
      maxProfilesPerDevice: 1,
      queriesPerProfile: 1,
      // Probes are cheap signal collectors: no screenshots, no landing
      // resolve, never swarm/inline-click (that is the operation's job).
      screenshots: false,
      resolveLandings: false,
      firstAdSwarm: false,
      autoClickAfterScan: false,
      autoFocusCampaignAfterScan: false,
    },
  };
  const summary = await runScan(probeConfig, [keyword], undefined, {
    protectPool: true,
    scanNote: "ops-watch",
  });
  return summary.scanId;
}

async function watchTick(): Promise<void> {
  if (!state || !deps || tickInFlight) return;
  const st = state;
  const { config, isBusy, isCalm, emit } = deps;
  tickInFlight = true;
  st.lastTickAt = new Date().toISOString();
  try {
    if (isBusy()) {
      logger.debug("ops watcher: tick skipped — system busy");
      return;
    }
    if (isCalm()) {
      logger.info("ops watcher: tick skipped — health valve calm");
      return;
    }

    // Rolling 1h budget accounting.
    const hourAgo = Date.now() - 3_600_000;
    st.queries = st.queries.filter((t) => t > hourAgo);
    const budget = watchBudgetPerHour(config.ops.watchBudgetPct);
    const remaining = budget - st.queries.length;
    if (remaining <= 0) {
      logger.debug({ budget, used: st.queries.length }, "ops watcher: tick skipped — watch budget exhausted");
      return;
    }

    const matrix = probeMatrix(config);
    if (matrix.length === 0) return;
    const probeCount = Math.min(remaining, MAX_PROBES_PER_TICK);
    for (let i = 0; i < probeCount; i++) {
      if (isBusy() || isCalm()) break; // re-check between probes
      const pair = matrix[st.cursor % matrix.length]!;
      st.cursor = (st.cursor + 1) % matrix.length;
      try {
        emit({
          type: "ops-watch",
          keyword: pair.keyword,
          device: pair.device,
          message: `Gözcü probe: ${pair.keyword} · ${pair.device}`,
        });
        const scanId = await runProbe(config, pair.keyword, pair.device);
        st.queries.push(Date.now());
        st.lastProbeAt = new Date().toISOString();
        const found = ingestScanResults(scanId, config.ops.brandPriority);
        logger.info({ keyword: pair.keyword, device: pair.device, scanId, domains: found }, "ops watcher probe done");
      } catch (err) {
        logger.warn({ keyword: pair.keyword, device: pair.device, err: String(err) }, "ops watcher probe failed");
      }
    }
    persist();
    emit({ type: "ops-richness", snapshot: getRichnessSnapshot() });
  } finally {
    tickInFlight = false;
    persist();
  }
}

/** Start the periodic watcher. Idempotent; no-op when already running. */
export function startRichnessWatcher(d: RichnessDeps): void {
  initRichness(d.config.output.dir, d.config.ops.richThreshold);
  deps = d;
  if (timer) return;
  const intervalMs = d.config.ops.watchIntervalMinutes * 60_000;
  timer = setInterval(() => void watchTick(), intervalMs);
  // First tick shortly after boot so the panel has data quickly.
  setTimeout(() => void watchTick(), 15_000);
  logger.info(
    { intervalMinutes: d.config.ops.watchIntervalMinutes, budgetPerHour: watchBudgetPerHour(d.config.ops.watchBudgetPct) },
    "ops richness watcher started"
  );
}

export function stopRichnessWatcher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info("ops richness watcher stopped");
  }
  persist();
}
