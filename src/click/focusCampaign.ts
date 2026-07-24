/**
 * Focus campaign: only the #1 ranked ad (SERP position).
 *
 * - 2 hour windows on that single domain (device = where it was seen).
 * - Ignore other ads during the window.
 * - After each window: re-scan brands → if same ad still present, another 2h;
 *   else switch to the new #1 and continue.
 */
import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";
import { Store } from "../store/db.js";
import { runScan } from "../scanner.js";
import type { Device } from "../types.js";
import { runClickEngine, buildEngineConfig } from "./engine.js";
import { buildTargetsFromScan } from "./targets.js";
import type { ClickTarget, TargetDevice } from "./types.js";
import { sleep } from "../util/time.js";
import { buildAdComplaintPack } from "../report/adComplaintPack.js";

export interface FocusCampaignState {
  id: string;
  status: "running" | "stopped" | "failed" | "completed";
  focusDomain: string | null;
  presence: TargetDevice | null;
  brands: string[];
  devices: Device[];
  windowMinutes: number;
  windowIndex: number;
  windowStartedAt: string | null;
  windowEndsAt: string | null;
  lastScanId: number | null;
  wave: number;
  completedClicks: number;
  failedClicks: number;
  skippedClicks: number;
  message: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface FocusCampaignHooks {
  onState?: (s: FocusCampaignState) => void;
  onEvent?: (e: Record<string, unknown>) => void;
  isCancelled?: () => boolean;
}

function normDomain(d: string): string {
  return d.toLowerCase().replace(/^www\./, "").replace(/^m\./, "").trim();
}

/**
 * #1 ad = best (lowest) SERP position across the scan; ties → more hits.
 * Only that domain becomes the focus target.
 */
export function pickTopAdFromScan(
  store: Store,
  scanId: number,
  mode: "conservative" | "adaptive" | "aggressive" = "adaptive"
): { target: ClickTarget; bestPosition: number; reason: string } | null {
  const all = buildTargetsFromScan(store, scanId, { mode });
  if (!all.length) return null;

  const rows = store.resultsForScan(scanId) as Array<{
    display_domain?: string;
    final_domain?: string | null;
    position?: number;
  }>;

  const bestPos = new Map<string, number>();
  const hits = new Map<string, number>();
  for (const r of rows) {
    // Key rule must match cloneReport grouping: display_domain takes priority,
    // otherwise redirect-chain ads never match their rank and a random target wins.
    const key = normDomain(String(r.display_domain || r.final_domain || ""));
    if (!key || key === "unknown") continue;
    const pos = Number(r.position ?? 99);
    const prev = bestPos.get(key);
    if (prev == null || pos < prev) bestPos.set(key, pos);
    hits.set(key, (hits.get(key) ?? 0) + 1);
  }

  const ranked = [...all].sort((a, b) => {
    const ka = normDomain(a.domain);
    const kb = normDomain(b.domain);
    const pa = bestPos.get(ka) ?? 99;
    const pb = bestPos.get(kb) ?? 99;
    if (pa !== pb) return pa - pb;
    return (hits.get(kb) ?? 0) - (hits.get(ka) ?? 0);
  });

  const top = ranked[0]!;
  const pos = bestPos.get(normDomain(top.domain)) ?? 99;
  return {
    target: top,
    bestPosition: pos,
    reason: `SERP sıra #${pos} · ${top.domain} · ${top.targetDevice} (diğer reklamlar yok sayılır)`,
  };
}

export function waveBudget(
  presence: TargetDevice,
  opts?: { mobileHits?: number; desktopHits?: number }
): { mobile: number; desktop: number } {
  // One wave ≈ concurrent pool capacity (10 single-device or split).
  if (presence === "mobile") return { mobile: 10, desktop: 0 };
  if (presence === "desktop") return { mobile: 0, desktop: 10 };
  // "both": split by measured fill rate instead of fixed 5+5.
  const m = opts?.mobileHits ?? 0;
  const d = opts?.desktopHits ?? 0;
  if (m + d > 0) {
    const mobile = Math.max(1, Math.min(9, Math.round((m / (m + d)) * 10)));
    return { mobile, desktop: 10 - mobile };
  }
  return { mobile: 5, desktop: 5 };
}

/**
 * Waves are sized as a multiple of the base pool-capacity budget. 10-job
 * waves idled every slot at each wave tail (~3min cycle); 5x covers ~15min
 * of continuous work, so slots stay fed from the engine's own queue.
 */
export const WAVE_SIZE_FACTOR = 5;

function brandsFromScan(store: Store, scanId: number): string[] {
  const row = store.db.prepare(`SELECT keywords FROM scans WHERE id = ?`).get(scanId) as
    | { keywords?: string }
    | undefined;
  if (!row?.keywords) return [];
  try {
    const parsed = JSON.parse(row.keywords) as string[];
    return Array.isArray(parsed) ? parsed.map((s) => String(s).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function devicesFromScan(store: Store, scanId: number): Device[] {
  const row = store.db.prepare(`SELECT devices FROM scans WHERE id = ?`).get(scanId) as
    | { devices?: string }
    | undefined;
  if (!row?.devices) return ["mobile", "desktop"];
  try {
    const parsed = JSON.parse(row.devices) as string[];
    const out = parsed.filter((d): d is Device => d === "mobile" || d === "desktop");
    return out.length ? out : ["mobile", "desktop"];
  } catch {
    return ["mobile", "desktop"];
  }
}

export function createFocusCampaignId(): string {
  return `focus-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Run focus campaign until cancelled or no ads left after a rescan.
 */
export async function runFocusCampaign(opts: {
  config: AppConfig;
  scanId: number;
  campaignId?: string;
  /** Default 120 minutes. */
  windowMinutes?: number;
  mode?: "conservative" | "adaptive" | "aggressive";
  /** When set, skip pickTopAdFromScan and use this exact target. */
  targetOverride?: ClickTarget;
  hooks?: FocusCampaignHooks;
}): Promise<FocusCampaignState> {
  const windowMinutes = Math.max(5, opts.windowMinutes ?? opts.config.click.focusWindowMinutes ?? 120);
  const mode = opts.mode ?? "adaptive";
  const hooks = opts.hooks ?? {};

  const state: FocusCampaignState = {
    id: opts.campaignId ?? createFocusCampaignId(),
    status: "running",
    focusDomain: null,
    presence: null,
    brands: [],
    devices: ["mobile", "desktop"],
    windowMinutes,
    windowIndex: 0,
    windowStartedAt: null,
    windowEndsAt: null,
    lastScanId: opts.scanId,
    wave: 0,
    completedClicks: 0,
    failedClicks: 0,
    skippedClicks: 0,
    message: "Focus kampanya başlıyor…",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const publish = (msg?: string) => {
    if (msg) state.message = msg;
    state.updatedAt = new Date().toISOString();
    hooks.onState?.({ ...state });
    hooks.onEvent?.({ type: "campaign-update", campaign: { ...state } });
  };

  const cancelled = () => hooks.isCancelled?.() === true;

  // Plain sleep() can't be interrupted — panel stop would wait minutes.
  const sleepCancellable = async (ms: number) => {
    const step = 1000;
    for (let t = 0; t < ms && !cancelled(); t += step) await sleep(Math.min(step, ms - t));
  };

  try {
    let scanId = opts.scanId;
    {
      const store = new Store(opts.config.output.dir);
      try {
        state.brands = brandsFromScan(store, scanId);
        state.devices = devicesFromScan(store, scanId);
      } finally {
        // SQLite handle must close even on throw, otherwise it leaks.
        store.close();
      }
    }

    if (!state.brands.length) {
      throw new Error("Scan marka listesi boş — focus kampanya başlatılamaz");
    }

    // Outer loop: 2h windows until cancel or no ads.
    while (!cancelled()) {
      let top: ReturnType<typeof pickTopAdFromScan>;
      let allTargets: ClickTarget[];
      {
        const store = new Store(opts.config.output.dir);
        try {
          top = opts.targetOverride
            ? { target: opts.targetOverride, bestPosition: 1, reason: `Swarm hedefi · ${opts.targetOverride.domain} · ${opts.targetOverride.targetDevice}` }
            : pickTopAdFromScan(store, scanId, mode);
          allTargets = opts.targetOverride ? [opts.targetOverride] : buildTargetsFromScan(store, scanId, { mode });
        } finally {
          // SQLite handle must close even on throw, otherwise it leaks.
          store.close();
        }
      }

      if (!top && !allTargets.length) {
        state.message = "Tarama sonucu reklam yok — kampanya durdu";
        state.status = "completed";
        publish();
        break;
      }

      // Prefer previous focus domain if it STILL appears (any rank); else take new SERP #1.
      let picked = top;
      let continued = false;
      if (state.focusDomain) {
        const stillThere = allTargets.find(
          (t) => normDomain(t.domain) === normDomain(state.focusDomain!)
        );
        if (stillThere) {
          picked = {
            target: stillThere,
            bestPosition: top?.bestPosition ?? 1,
            reason: `Önceki hedef HÂLÂ SERP'te · ${stillThere.domain} · ${stillThere.targetDevice} → +${windowMinutes}dk aynı reklam`,
          };
          continued = true;
        }
      }
      if (!picked) {
        state.message = "Odaklanacak reklam kalmadı — kampanya durdu";
        state.status = "completed";
        publish();
        break;
      }

      state.focusDomain = picked.target.domain;
      state.presence = picked.target.targetDevice;
      state.lastScanId = scanId;
      state.windowIndex += 1;
      state.windowStartedAt = new Date().toISOString();
      const windowEndMs = Date.now() + windowMinutes * 60_000;
      state.windowEndsAt = new Date(windowEndMs).toISOString();

      publish(
        continued
          ? `Pencere #${state.windowIndex}: ${picked.target.domain} duruyor → +${windowMinutes}dk devam`
          : `Pencere #${state.windowIndex}: HEDEF #1 = ${picked.target.domain} · ${windowMinutes}dk · ${picked.reason}`
      );

      hooks.onEvent?.({
        type: "campaign-window-start",
        campaignId: state.id,
        domain: picked.target.domain,
        presence: picked.target.targetDevice,
        windowIndex: state.windowIndex,
        windowEndsAt: state.windowEndsAt,
        continued: !!continued,
        message: state.message,
      });

      // Inner loop: click waves on THIS domain only until window ends.
      let consecutiveWaveErrors = 0;
      let emptyWaveStreak = 0;
      const imp = picked.target.impressions ?? [];
      const budget = waveBudget(picked.target.targetDevice, {
        mobileHits: imp.filter((i) => i.device === "mobile").length,
        desktopHits: imp.filter((i) => i.device === "desktop").length,
      });
      while (Date.now() < windowEndMs && !cancelled()) {
        state.wave += 1;
        const remainingMs = windowEndMs - Date.now();
        const remainingMin = Math.max(1, Math.ceil(remainingMs / 60_000));
        publish(
          `Vuruyor · ${picked.target.domain} · dalga ${state.wave} · pencere bitişine ~${remainingMin}dk · ok=${state.completedClicks}`
        );

        const waveTarget: ClickTarget = {
          ...picked.target,
          // Big waves, not 10-job packets: the engine feeds freed slots from
          // its own queue continuously, so a ~15min wave keeps all slots busy.
          // Small waves idled every slot at each wave tail for no benefit.
          recommendedClicks: {
            mobile: budget.mobile * WAVE_SIZE_FACTOR,
            desktop: budget.desktop * WAVE_SIZE_FACTOR,
          },
          planReason: `focus-window #${state.windowIndex} wave ${state.wave} · only ${picked.target.domain}`,
        };

        const engineConfig = buildEngineConfig(opts.config, mode);
        // Pack waves tightly; full 2h is outer loop, not single schedule spread.
        engineConfig.burst = true;
        engineConfig.durationMinutes = Math.min(15, Math.max(5, remainingMin));

        try {
          const summary = await runClickEngine(
            {
              config: opts.config,
              targets: [waveTarget],
              engineConfig,
              outputDir: opts.config.output.dir,
              operationId: state.id,
              isCancelled: cancelled,
            },
            (event) => {
              hooks.onEvent?.({ ...event, campaignId: state.id, focusDomain: picked.target.domain });
            }
          );
          state.completedClicks += summary.completedJobs;
          state.failedClicks += summary.failedJobs;
          state.skippedClicks += summary.skippedJobs;
          consecutiveWaveErrors = 0;
          // Empty-wave damping: a wave with ZERO clicks means the auction is
          // dead right now (night supply). Full-speed waves then burn profiles
          // AND feed Google's distrust (649 empty hits in one live window).
          // Back the cadence off x2 (60s→2m→4m→8m cap); first click resets.
          if (summary.completedJobs > 0) {
            emptyWaveStreak = 0;
          } else {
            emptyWaveStreak += 1;
          }
          publish(
            `Dalga ${state.wave} bitti · ${picked.target.domain} · +${summary.completedJobs} ok · toplam ok=${state.completedClicks}` +
              (emptyWaveStreak > 0 ? ` · boş seri=${emptyWaveStreak} → tempo yavaşladı` : "")
          );
        } catch (err) {
          const msg = String(err);
          logger.warn({ err: msg, domain: picked.target.domain }, "focus wave failed");
          // All profiles cooling → long wait, no point hammering failed waves.
          // Other errors (e.g. AdsPower down) → exponential backoff, otherwise a
          // 5s+8s loop hammers the API until the window ends.
          const isCooling = /cooling/i.test(msg);
          const coolWait = isCooling
            ? 300_000
            : Math.min(300_000, 5_000 * 2 ** ++consecutiveWaveErrors);
          publish(
            isCooling
              ? `Profiller dinleniyor (frekans limiti) · 5dk sonra yeni dalga · ${picked.target.domain}`
              : `Dalga hata: ${msg.slice(0, 120)}`
          );
          await sleepCancellable(coolWait);
        }

        // Gap between waves: base 8s, damped exponentially while waves come
        // back empty (60s → 2m → 4m → 8m cap). Any click resets the streak.
        if (Date.now() < windowEndMs && !cancelled()) {
          const gapMs =
            emptyWaveStreak === 0
              ? 8_000
              : Math.min(480_000, 60_000 * 2 ** (emptyWaveStreak - 1));
          await sleepCancellable(gapMs);
        }
      }

      if (cancelled()) break;

      // Window done → re-scan to see if ad still ranks / other ads appeared.
      publish(
        `Pencere #${state.windowIndex} bitti · yeniden tarama (markalar: ${state.brands.join(", ")})…`
      );
      hooks.onEvent?.({
        type: "campaign-rescan-start",
        campaignId: state.id,
        afterDomain: picked.target.domain,
        brands: state.brands,
        message: state.message,
      });

      const cfg = { ...opts.config, devices: state.devices };
      // Critical: rescan must NOT trigger any downstream auto-action.
      cfg.scan = { ...cfg.scan, autoClickAfterScan: false, autoFocusCampaignAfterScan: false };

      try {
        const RESCAN_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes max
        const abortController = new AbortController();
        const timeoutId = setTimeout(() => abortController.abort(new Error("rescan timeout (30m)")), RESCAN_TIMEOUT_MS);
        // Panel cancel must also abort a running rescan — otherwise "stop" waits up to 30m.
        const cancelWatcher = setInterval(() => {
          if (cancelled()) abortController.abort(new Error("campaign cancelled from panel"));
        }, 2000);

        let summary;
        try {
          summary = await runScan(
            cfg,
            state.brands,
            (event) => hooks.onEvent?.({ ...event, campaignId: state.id, phase: "rescan" }),
            { protectPool: true, signal: abortController.signal }
          );
        } finally {
          // Timers must die on BOTH success and throw — a leaked interval keeps
          // the event loop alive forever.
          clearTimeout(timeoutId);
          clearInterval(cancelWatcher);
        }
        scanId = summary.scanId;
        state.lastScanId = scanId;

        // Generate complaint pack for the fresh rescan as well.
        try {
          const pack = buildAdComplaintPack({ outputDir: opts.config.output.dir, scanId, bettingOnly: true });
          if (pack.count > 0) {
            logger.info({ scanId, dir: pack.dir, count: pack.count }, "focus campaign: complaint pack after rescan");
            hooks.onEvent?.({
              type: "campaign-rescan-done",
              campaignId: state.id,
              scanId,
              phase: "complaint-pack",
              count: pack.count,
              dir: pack.dir,
              message: `Focus rescan şikayet paketi hazır · ${pack.count} reklam · ${pack.dir}`,
            });
          }
        } catch (err) {
          logger.warn({ scanId, err: String(err) }, "focus campaign: complaint pack after rescan failed");
        }

        publish(
          `Yeniden tarama #${scanId} bitti · ads=${summary.totalAds} · hedef kontrol ediliyor…`
        );
        hooks.onEvent?.({
          type: "campaign-rescan-done",
          campaignId: state.id,
          scanId,
          totalAds: summary.totalAds,
        });
      } catch (err) {
        // Panel cancel aborts the rescan — that's not a failure; the outer
        // loop will mark the campaign 'stopped' anyway.
        if (cancelled()) { state.error = undefined; break; }
        logger.error({ err: String(err) }, "focus rescan failed");
        state.status = "failed";
        state.error = String(err);
        state.message = `Yeniden tarama başarısız: ${String(err).slice(0, 160)}`;
        publish();
        break;
      }
      // Loop continues → pick top again (same or new #1).
    }

    if (cancelled()) {
      state.status = "stopped";
      state.message = `Durduruldu · son hedef ${state.focusDomain ?? "—"} · ok=${state.completedClicks}`;
    } else if (state.status === "running") {
      state.status = "completed";
      state.message = `Kampanya bitti · ok=${state.completedClicks}`;
    }
  } catch (err) {
    state.status = "failed";
    state.error = String(err);
    state.message = String(err);
    logger.error({ err: String(err) }, "focus campaign failed");
  }

  state.finishedAt = new Date().toISOString();
  state.updatedAt = state.finishedAt;
  hooks.onState?.({ ...state });
  hooks.onEvent?.({ type: "campaign-finished", campaign: { ...state } });
  return state;
}
