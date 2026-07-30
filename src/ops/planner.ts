import type { AppConfig } from "../config.js";
import { getActiveDomains } from "./richness.js";
import { logger } from "../logger.js";

/**
 * Domain planner (ops Package 1).
 *
 * Walks the brand priority list and keeps AT MOST `ops.maxActiveDomains`
 * (hard cap 2) rich domains active. When a higher-priority brand goes poor
 * the next rich one takes over; when it recovers it reclaims its slot.
 *
 * Anti-flap hysteresis: an assignment younger than
 * `ops.domainHysteresisMinutes` is LOCKED — it cannot be displaced by a
 * priority change as long as its domain still exists in the snapshot
 * (score > 0). Once the lock expires, pure priority order decides.
 */

export interface PlannedDomain {
  domain: string;
  device: string;
  keywords: string[];
  /** Index into ops.brandPriority (lower = higher priority). */
  priority: number;
}

export interface PlannedAssignment extends PlannedDomain {
  /** When this assignment became active (hysteresis clock). */
  since: string;
  score: number;
  /** True while the min-residence lock prevents displacement. */
  hysteresisLocked: boolean;
}

let maxActiveDomains = 2;
let hysteresisMinutes = 10;
let brandPriority: string[] = [];
const assignments = new Map<string, PlannedAssignment>();

/** Bind planner knobs from config. Called by the panel on boot/toggle. */
export function initPlanner(ops: AppConfig["ops"]): void {
  // The 2-active-domain ceiling is a hard product rule, not just a default.
  maxActiveDomains = Math.min(2, Math.max(1, ops.maxActiveDomains));
  hysteresisMinutes = ops.domainHysteresisMinutes;
  brandPriority = ops.brandPriority.map((b) => b.toLocaleLowerCase("tr"));
}

function isLocked(a: PlannedAssignment, now: number): boolean {
  return now - new Date(a.since).getTime() < hysteresisMinutes * 60_000;
}

/**
 * Compute the current active set (0, 1 or 2 entries). Reads the richness
 * snapshot fresh on every call; hysteresis state lives in this module.
 */
export function planActiveDomains(): PlannedDomain[] {
  return getPlanState().active.map(({ domain, device, keywords, priority }) => ({
    domain,
    device,
    keywords,
    priority,
  }));
}

/** Plan + hysteresis internals for the panel API. */
export function getPlanState(): {
  active: PlannedAssignment[];
  maxActiveDomains: number;
  hysteresisMinutes: number;
  updatedAt: string;
} {
  const now = Date.now();
  const rich = getActiveDomains(brandPriority);

  // Desired set: best rich domain per brand, in priority order, capped.
  const bestByBrand = new Map<string, (typeof rich)[number]>();
  for (const d of rich) {
    if (!bestByBrand.has(d.brand)) bestByBrand.set(d.brand, d);
  }
  const desired = brandPriority
    .map((b, i) => {
      const d = bestByBrand.get(b);
      return d ? { ...d, priority: i } : null;
    })
    .filter((d): d is NonNullable<typeof d> => d !== null)
    .slice(0, maxActiveDomains);
  const desiredKeys = new Set(desired.map((d) => d.key));
  const richKeys = new Set(rich.map((d) => d.key));

  // Drop assignments whose domain vanished entirely (score 0 = dead window);
  // hysteresis never protects a domain that is gone.
  for (const [key, a] of assignments) {
    if (!richKeys.has(key)) {
      assignments.delete(key);
      logger.info({ domain: key }, "ops planner: domain vanished from snapshot — slot released");
    } else {
      a.hysteresisLocked = isLocked(a, now);
    }
  }

  // Locked assignments keep their slot even when priority says otherwise.
  const kept = [...assignments.values()].filter((a) => a.hysteresisLocked && !desiredKeys.has(a.domain));

  // Fill remaining slots by pure priority order.
  const final: PlannedAssignment[] = [];
  for (const d of desired) {
    const existing = assignments.get(d.key);
    if (existing) {
      existing.device = d.device;
      existing.keywords = d.keywords;
      existing.score = d.score;
      final.push(existing);
    } else {
      const created: PlannedAssignment = {
        domain: d.key,
        device: d.device,
        keywords: d.keywords,
        priority: d.priority,
        score: d.score,
        since: new Date(now).toISOString(),
        hysteresisLocked: hysteresisMinutes > 0,
      };
      assignments.set(d.key, created);
      final.push(created);
      logger.info({ domain: d.key, priority: d.priority, score: d.score }, "ops planner: domain activated");
    }
  }
  for (const a of kept) {
    if (final.length >= maxActiveDomains) break;
    final.push(a);
  }

  // Release everything that did not make the final set.
  const finalKeys = new Set(final.map((a) => a.domain));
  for (const key of [...assignments.keys()]) {
    if (!finalKeys.has(key)) {
      assignments.delete(key);
      logger.info({ domain: key }, "ops planner: domain deactivated (priority takeover)");
    }
  }

  final.sort((a, b) => a.priority - b.priority);
  return {
    active: final,
    maxActiveDomains,
    hysteresisMinutes,
    updatedAt: new Date(now).toISOString(),
  };
}
