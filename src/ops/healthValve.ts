import { Store } from "../store/db.js";
import { logger } from "../logger.js";

/**
 * Health valve / auto-calm (ops Package 1).
 *
 * Watches the vault (ip_trust): when too many profiles sit in captcha state
 * the whole operation pauses so IPs can recover; when the count drops the
 * operation resumes. This module only produces the SIGNAL — the recovery
 * supervisor itself is untouched.
 *
 * Hysteresis band: calm when captcha > calmThreshold, resume when
 * captcha < resumeThreshold; between the two the previous state sticks.
 */

export interface ValveState {
  calm: boolean;
  /** Vault rows with status 'captcha'. */
  captchaCount: number;
  /** Vault rows with status 'usable'. */
  usableCount: number;
  evaluatedAt: string;
}

interface ValveConfig {
  outputDir: string;
  calmThreshold: number;
  resumeThreshold: number;
  /** Fired (e.g. SSE "ops-valve") whenever the calm flag flips. */
  onChange?: (state: ValveState) => void;
}

let cfg: ValveConfig | null = null;
let calm = false;

/** Bind the valve to the vault. Cheap; safe to call on every boot. */
export function initHealthValve(c: ValveConfig): void {
  cfg = c;
  calm = false;
  evaluateValve();
}

/** Re-read the vault and update the calm flag (fires onChange on flips). */
export function evaluateValve(): ValveState {
  if (!cfg) throw new Error("ops health valve not initialized — call initHealthValve() first");
  const store = new Store(cfg.outputDir);
  let captchaCount = 0;
  let usableCount = 0;
  try {
    const row = store.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'captcha' THEN 1 ELSE 0 END) AS captcha,
           SUM(CASE WHEN status = 'usable' THEN 1 ELSE 0 END) AS usable
         FROM ip_trust`
      )
      .get() as { captcha: number | null; usable: number | null } | undefined;
    captchaCount = Number(row?.captcha ?? 0);
    usableCount = Number(row?.usable ?? 0);
  } finally {
    store.close();
  }

  const wasCalm = calm;
  if (!calm && captchaCount > cfg.calmThreshold) calm = true;
  else if (calm && captchaCount < cfg.resumeThreshold) calm = false;

  const state: ValveState = { calm, captchaCount, usableCount, evaluatedAt: new Date().toISOString() };
  if (calm !== wasCalm) {
    logger.warn({ calm, captchaCount, usableCount }, "ops health valve: calm state flipped");
    try {
      cfg.onChange?.(state);
    } catch (err) {
      logger.warn({ err: String(err) }, "ops health valve: onChange handler failed");
    }
  }
  return state;
}

/** Last evaluated calm flag (no DB hit — use evaluateValve() for fresh data). */
export function isCalm(): boolean {
  return calm;
}

/** Fresh valve state for the panel API. */
export function getValveState(): ValveState {
  return evaluateValve();
}
