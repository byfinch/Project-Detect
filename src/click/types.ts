import type { Device, RedirectHop } from "../types.js";

export type ClickStatus =
  | "scheduled"
  | "running"
  | "success"
  | "failed"
  | "skipped"
  | "captcha"
  | "profile_error";

export type ClickMode = "conservative" | "adaptive" | "aggressive";

export type TargetDevice = Device | "both";

/** A single click scheduled for a specific profile. */
export interface ClickJob {
  id: string;
  profileId: string;
  device: Device;
  keyword: string;
  targetDomain: string;
  targetTitle?: string;
  fallbackFirstAd: boolean;
  clickFirstResult: boolean;
  scheduledAt: number;
  attempt: number;
  maxAttempts: number;
}

/** Evidence that an ad was seen by a specific profile for a specific keyword. */
export interface ImpressionEvidence {
  profileId: string;
  device: Device;
  keyword: string;
  displayDomain: string;
  finalDomain: string | null;
  title: string;
}

/** Recommended click budget from clone analysis (per device type). */
export interface RecommendedClicks {
  mobile: number;
  desktop: number;
}

/** What we want to drain / remove. */
export interface ClickTarget {
  domain: string;
  titleHint?: string;
  keywords: string[];
  /** If known from a detect run. */
  targetDevice: TargetDevice;
  /** Profiles that already saw this ad during a scan. */
  impressions?: ImpressionEvidence[];
  /** If true, click the first organic result when no ad is found. */
  clickFirstResult?: boolean;
  /**
   * Cap total clicks per device for this target (from clone analysis).
   * When set, overrides clicksPerProfile × profileCount for job building.
   */
  recommendedClicks?: RecommendedClicks;
  /** Why this plan (for UI/logs). */
  planReason?: string;
}

/** Natural behaviour parameters for one click. */
export interface ClickBehaviorConfig {
  minPreClickMs: number;
  maxPreClickMs: number;
  minStayMs: number;
  maxStayMs: number;
  scrollChance: number;
  mouseMoveChance: number;
  internalLinkChance: number;
  minInternalStayMs: number;
  maxInternalStayMs: number;
  mobileViewport: { width: number; height: number };
}

/** Runtime click engine settings. */
export interface ClickEngineConfig {
  mode: ClickMode;
  concurrency: number;
  durationMinutes: number;
  clicksPerProfile: number;
  staggerWindowSeconds: number;
  minDelayMs: number;
  maxDelayMs: number;
  maxClicksPerProfilePerHour: number;
  sameAdCooldownMinutes: number;
  behavior: ClickBehaviorConfig;
  /**
   * Web/ops: schedule jobs ASAP (short window) instead of spreading over durationMinutes.
   * Prevents "running 0%" for many minutes while jobs wait on the schedule.
   */
  burst?: boolean;
}

/** Evidence collected for one click. */
export interface ClickEvidence {
  serpUrl: string | null;
  adTitle: string | null;
  adDescription: string | null;
  displayUrl: string | null;
  clickUrl: string | null;
  landingUrl: string | null;
  finalUrl: string | null;
  finalDomain: string | null;
  redirectHops: RedirectHop[];
  screenshotSerp: string | null;
  screenshotLanding: string | null;
  screenshotFinal: string | null;
  preClickMs: number;
  stayMs: number;
  internalClicks: number;
}

export interface ClickReportResult {
  status: "submitted" | "filled" | "submit-failed" | "no-form" | "skipped" | "error";
  message?: string;
}

/** Result stored for one executed click. */
export interface ClickResult {
  job: ClickJob;
  status: ClickStatus;
  evidence: ClickEvidence;
  error: string | null;
  capturedAt: string;
  report?: ClickReportResult;
}

/** Summary of a click run. */
export interface ClickRunSummary {
  runId: number;
  targetDomain: string;
  targetDevice: TargetDevice;
  targets: Array<{ domain: string; device: TargetDevice }>;
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  captchaJobs: number;
  skippedJobs: number;
  avgStayMs: number;
  clicksPerHour: number;
  byDevice: Record<string, number>;
  reportPaths: { json?: string; csv?: string };
}

/** Options used to build jobs from a target. */
export interface ClickRunOptions {
  target: ClickTarget;
  profileIds: string[];
  deviceOfProfile: Map<string, Device>;
  engineConfig: ClickEngineConfig;
  baseTime?: number;
  fallbackFirstAd?: boolean;
  clickFirstResult?: boolean;
}
