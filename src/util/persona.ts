import type { ClickBehaviorConfig } from "../click/types.js";

/**
 * Stable per-profile "personality" derived from profile name/id.
 * Same profile always gets the same base traits (scroll style, pace, mouse-iness).
 * Per-action randomness still applies inside those ranges so sessions don't look robotic.
 */

export type ScrollStyle = "calm" | "normal" | "active";

export interface ProfilePersona {
  key: string;
  /** 0..1 — higher = more scrolling */
  scrollChance: number;
  /** 0..1 — desktop mouse wander */
  mouseMoveChance: number;
  /** 0..1 — chance to open an internal link after click */
  internalLinkChance: number;
  /** Multiplier on pre-click wait ranges */
  preClickScale: number;
  /** Multiplier on landing stay ranges */
  stayScale: number;
  scrollStyle: ScrollStyle;
  /** Extra inter-keyword delay multiplier (scan safety) */
  interQueryScale: number;
  /** Label for logs */
  label: string;
}

/** FNV-1a 32-bit hash → stable seed in [0,1). */
function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0xffffffff;
}

function pickStyle(t: number): ScrollStyle {
  if (t < 0.33) return "calm";
  if (t < 0.66) return "normal";
  return "active";
}

/**
 * Build a deterministic persona for an AdsPower profile (prefer human name: TR-MOBILE-094).
 */
export function personaFor(profileKey: string): ProfilePersona {
  const key = profileKey.trim() || "unknown";
  const a = hash01(key);
  const b = hash01(key + ":b");
  const c = hash01(key + ":c");
  const d = hash01(key + ":d");
  const e = hash01(key + ":e");

  const scrollStyle = pickStyle(a);
  const scrollChance =
    scrollStyle === "calm" ? 0.45 + b * 0.25 : scrollStyle === "normal" ? 0.7 + b * 0.2 : 0.85 + b * 0.15;
  const mouseMoveChance = 0.35 + c * 0.55;
  const internalLinkChance = 0.08 + d * 0.28;
  const preClickScale = 0.75 + e * 0.7; // 0.75–1.45
  const stayScale = 0.8 + hash01(key + ":stay") * 0.6; // 0.8–1.4
  const interQueryScale = 0.9 + hash01(key + ":gap") * 0.5; // 0.9–1.4

  const label =
    scrollStyle === "calm" ? "sakin" : scrollStyle === "normal" ? "normal" : "aktif";

  return {
    key,
    scrollChance: Math.min(0.98, scrollChance),
    mouseMoveChance: Math.min(0.95, mouseMoveChance),
    internalLinkChance: Math.min(0.45, internalLinkChance),
    preClickScale,
    stayScale,
    scrollStyle,
    interQueryScale,
    label,
  };
}

/** Scale a [min,max] range by factor, keep integers. */
function scaleRange(min: number, max: number, scale: number): { min: number; max: number } {
  const mid = (min + max) / 2;
  const half = ((max - min) / 2) * scale;
  const nmin = Math.max(200, Math.floor(mid - half));
  const nmax = Math.max(nmin + 100, Math.floor(mid + half));
  return { min: nmin, max: nmax };
}

/** Merge global click.behavior with this profile's persona. */
export function behaviorForProfile(base: ClickBehaviorConfig, profileKey: string): ClickBehaviorConfig {
  const p = personaFor(profileKey);
  const pre = scaleRange(base.minPreClickMs, base.maxPreClickMs, p.preClickScale);
  const stay = scaleRange(base.minStayMs, base.maxStayMs, p.stayScale);
  const internal = scaleRange(base.minInternalStayMs, base.maxInternalStayMs, p.stayScale);

  return {
    ...base,
    minPreClickMs: pre.min,
    maxPreClickMs: pre.max,
    minStayMs: stay.min,
    maxStayMs: stay.max,
    minInternalStayMs: internal.min,
    maxInternalStayMs: internal.max,
    scrollChance: p.scrollChance,
    mouseMoveChance: p.mouseMoveChance,
    internalLinkChance: p.internalLinkChance,
  };
}
