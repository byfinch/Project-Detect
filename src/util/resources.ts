/**
 * Host resource probe for the adaptive concurrency governor.
 * Linux-only in practice (VPS); on any other OS it returns null and the
 * governor falls back to the configured static concurrency.
 */
import { readFileSync } from "node:fs";

/** MemAvailable in MB, or null when not a Linux /proc host. */
export function memAvailableMb(): number | null {
  try {
    const raw = readFileSync("/proc/meminfo", "utf8");
    const m = raw.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (!m) return null;
    return Math.round(Number(m[1]) / 1024);
  } catch {
    return null;
  }
}

export interface GovernorDecision {
  concurrency: number;
  availMb: number | null;
  reason: string;
}

/**
 * RAM-governed parallelism for browser fleets.
 *
 * One AdsPower browser ≈ 350-450 MB under load. The governor keeps a safety
 * floor for the OS + Node + AdsPower app and spends the rest on browsers:
 *
 *   avail > 3.0 GB  → base + floor((avail-3.0GB)/1.2GB)  (up to `ceiling`)
 *   avail 1.5-3 GB  → base
 *   avail < 1.5 GB  → base - 2 (never below `floor`) — shed before OOM/swap thrash
 *
 * The same code scales any box: upgrade RAM and the ceiling is the only limit.
 */
export function governedConcurrency(opts: {
  base: number;
  floor?: number;
  ceiling?: number;
}): GovernorDecision {
  const floor = opts.floor ?? 6;
  const ceiling = opts.ceiling ?? 16;
  const avail = memAvailableMb();
  if (avail === null) {
    return { concurrency: opts.base, availMb: null, reason: "no /proc — static base" };
  }
  let c = opts.base;
  let reason = "base";
  if (avail < 1536) {
    c = Math.max(floor, opts.base - 2);
    reason = `RAM pressure (${avail}MB) — shedding`;
  } else if (avail > 3072) {
    c = Math.min(ceiling, opts.base + Math.floor((avail - 3072) / 1229));
    reason = `headroom (${avail}MB) — scaling up`;
  }
  c = Math.max(floor, Math.min(ceiling, c));
  return { concurrency: c, availMb: avail, reason };
}
