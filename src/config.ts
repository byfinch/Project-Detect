import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";
import type { Device } from "./types.js";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

const DeviceEnum = z.enum(["desktop", "mobile"]);

const ConfigSchema = z.object({
  adspower: z.object({
    baseUrl: z.string().url(),
    apiKey: z.string(),
    requestIntervalMs: z.number().int().positive(),
  }),
  captcha: z.object({
    enabled: z.boolean(),
    /** Preferred provider when both keys exist. "auto" = CapSolver first, then 2captcha. */
    provider: z.enum(["2captcha", "capsolver", "auto"]).default("auto"),
    /** 2captcha API key (legacy field name kept for callers). */
    apiKey: z.string(),
    twoCaptchaApiKey: z.string().default(""),
    capSolverApiKey: z.string().default(""),
    /**
     * Solver economics (see captcha/policy.ts). Paid solves are capped per
     * hour/day; providers with a collapsing wall-clear rate are paused; a
     * profile gets fewer attempts the more walls it has already burned today.
     */
    budget: z
      .object({
        maxSolvesPerHour: z.number().int().positive().default(40),
        maxSolvesPerDay: z.number().int().positive().default(250),
        /** Pause a provider when clear-rate over the window drops below this. */
        minClearRate: z.number().min(0).max(1).default(0.15),
        /** Samples needed before the clear-rate breaker may trip. */
        breakerMinSamples: z.number().int().positive().default(8),
        /** How long a tripped provider (or global) pause lasts, minutes. */
        breakerPauseMinutes: z.number().int().positive().default(30),
        /** Attempts allowed on a profile's 1st / 2nd wall of the day (3rd+: no solve). */
        attemptsFirstWall: z.number().int().positive().default(2),
        attemptsSecondWall: z.number().int().positive().default(1),
      })
      .default({}),
  }),
  google: z.object({
    domain: z.string(),
    hl: z.string(),
    gl: z.string(),
    num: z.number().int().positive(),
    uule: z.string().optional().default(""),
    extraParams: z.record(z.string()).default({}),
  }),
  location: z.object({
    country: z.string(),
    city: z.string().optional(),
  }),
  profiles: z.object({
    desktop: z.string().optional(),
    mobile: z.string().optional(),
  }),
  fingerprint: z
    .object({
      syncBeforeScan: z.boolean().default(false),
      desktop: z.record(z.unknown()).default({}),
      mobile: z.record(z.unknown()).default({}),
    })
    .default({}),
  devices: z.array(DeviceEnum).min(1),
  scan: z.object({
    hopCap: z.number().int().positive(),
    navTimeoutMs: z.number().int().positive(),
    resolveTimeoutMs: z.number().int().positive(),
    minDelayMs: z.number().int().nonnegative(),
    maxDelayMs: z.number().int().nonnegative(),
    screenshots: z.boolean(),
    resolveLandings: z.boolean(),
    concurrency: z.number().int().positive(),
    rotateProfiles: z.boolean(),
    queriesPerProfile: z.number().int().positive(),
    profilePrefix: z.string(),
    mobileProfilePrefix: z.string(),
    // Default false: wiping Google trust on every open re-opens /sorry forever on private ISP.
    clearProfileData: z.boolean().default(false),
    /**
     * Cap active profiles per device for a scan (e.g. 5 mobile + 5 desktop).
     * 0 = use entire matching pool. Explicit --only-names bypasses this cap.
     */
    maxProfilesPerDevice: z.number().int().nonnegative().default(5),
    /**
     * After a scheduled/web scan finishes with ads, start click engine automatically
     * (no manual panel approval).
     */
    autoClickAfterScan: z.boolean().default(false),
    /**
     * After a scan finishes, automatically start a 2h focus campaign on the SERP #1 ad.
     * This is the preferred ops mode: click the top competitor ad for 2h, then rescan.
     */
    autoFocusCampaignAfterScan: z.boolean().default(true),
    /**
     * Swarm mode: when a profile sees any ad, stop scanning other keywords with that
     * profile and repeatedly click + report the same ad until the per-profile target
     * is reached. Other profiles keep scanning and join the swarm when they see an ad.
     */
    firstAdSwarm: z.boolean().default(false),
    swarmClicksPerProfile: z.number().int().nonnegative().default(10),
    swarmReportsPerProfile: z.number().int().nonnegative().default(10),
    swarmMinDelayMs: z.number().int().nonnegative().default(30000),
    swarmMaxDelayMs: z.number().int().nonnegative().default(90000),
  }),
  click: z.object({
    mode: z.enum(["conservative", "adaptive", "aggressive"]),
    concurrency: z.number().int().positive(),
    durationMinutes: z.number().int().positive(),
    clicksPerProfile: z.number().int().positive(),
    staggerWindowSeconds: z.number().int().nonnegative(),
    minDelayMs: z.number().int().nonnegative(),
    maxDelayMs: z.number().int().nonnegative(),
    maxClicksPerProfilePerHour: z.number().int().positive(),
    sameAdCooldownMinutes: z.number().int().nonnegative(),
    /** Cap click pool per device (match scan 5+5). 0 = all matching profiles. */
    maxProfilesPerDevice: z.number().int().nonnegative().default(5),
    /**
     * Focus campaign: only SERP #1 ad; attack for this many minutes, then re-scan.
     * If same ad still present → another window. Default 120 (2 hours).
     */
    focusWindowMinutes: z.number().int().positive().default(120),
    behavior: z.object({
      minPreClickMs: z.number().int().nonnegative(),
      maxPreClickMs: z.number().int().nonnegative(),
      minStayMs: z.number().int().nonnegative(),
      maxStayMs: z.number().int().nonnegative(),
      scrollChance: z.number().min(0).max(1),
      mouseMoveChance: z.number().min(0).max(1),
      internalLinkChance: z.number().min(0).max(1),
      minInternalStayMs: z.number().int().nonnegative(),
      maxInternalStayMs: z.number().int().nonnegative(),
      mobileViewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
    }),
  }),
  output: z.object({
    dir: z.string(),
    sqlite: z.boolean(),
    json: z.boolean(),
    csv: z.boolean(),
  }),
  /**
   * Ops reporting + optional SendGrid delivery.
   * Secrets via env: SENDGRID_API_KEY (preferred).
   */
  report: z
    .object({
      emailEnabled: z.boolean().default(false),
      /** Write Google Ads report pack after each scan. */
      autoExportOnScan: z.boolean().default(true),
      /** Email Google Ads report after scan when SendGrid configured. */
      autoEmailOnScan: z.boolean().default(false),
      from: z.string().default(""),
      to: z.array(z.string()).default([]),
      /** Optional hardcoded key — prefer SENDGRID_API_KEY env. */
      sendgridApiKey: z.string().optional(),
      /** Auto SERP report-ad: default dry-run; set true to actually submit. */
      autoSerpSubmit: z.boolean().default(false),
      autoSerpMaxAds: z.number().int().nonnegative().default(20),
      autoSerpDelayMinMs: z.number().int().nonnegative().default(30000),
      autoSerpDelayMaxMs: z.number().int().nonnegative().default(90000),
      /** Email used in Google's required "E-posta" field when reporting an ad. */
      reportEmail: z.string().default(""),
      /**
       * Rotating email pool (mail.tm) for report forms. LRU rotation:
       * consecutive reports never share an address, old ones may be reused.
       * reportEmail above is the fallback when the pool is empty/disabled.
       */
      emailPool: z
        .object({
          enabled: z.boolean().default(true),
          /** Refill target: keep this many active addresses. */
          minSize: z.number().int().nonnegative().default(10),
        })
        .default({}),
    })
    .default({}),
  bettingKeywords: z.array(z.string()),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

interface RawFileConfig {
  [key: string]: unknown;
}

function loadDefaults(): RawFileConfig {
  const path = resolve(PROJECT_ROOT, "config", "default.json");
  return JSON.parse(readFileSync(path, "utf8")) as RawFileConfig;
}

/**
 * Merge config/default.json with environment variables. Env wins.
 * Secrets (API keys, profile ids) live only in the environment / .env.
 */
export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const file = loadDefaults() as any;

  const merged = {
    adspower: {
      baseUrl: process.env.ADSPOWER_BASE_URL ?? "http://local.adspower.net:50325",
      apiKey: process.env.ADSPOWER_API_KEY ?? "",
      requestIntervalMs: file.adspower?.requestIntervalMs ?? 1100,
    },
    captcha: {
      enabled: file.captcha?.enabled ?? false,
      provider: (file.captcha?.provider as "2captcha" | "capsolver" | "auto" | undefined) ?? "auto",
      apiKey: process.env.TWOCAPTCHA_API_KEY ?? "",
      twoCaptchaApiKey: process.env.TWOCAPTCHA_API_KEY ?? "",
      capSolverApiKey: process.env.CAPSOLVER_API_KEY ?? "",
      budget: {
        maxSolvesPerHour: file.captcha?.budget?.maxSolvesPerHour ?? 40,
        maxSolvesPerDay: file.captcha?.budget?.maxSolvesPerDay ?? 250,
        minClearRate: file.captcha?.budget?.minClearRate ?? 0.15,
        breakerMinSamples: file.captcha?.budget?.breakerMinSamples ?? 8,
        breakerPauseMinutes: file.captcha?.budget?.breakerPauseMinutes ?? 30,
        attemptsFirstWall: file.captcha?.budget?.attemptsFirstWall ?? 2,
        attemptsSecondWall: file.captcha?.budget?.attemptsSecondWall ?? 1,
      },
    },
    google: {
      domain: file.google?.domain ?? "www.google.com",
      hl: file.google?.hl ?? "tr",
      gl: file.google?.gl ?? "tr",
      num: file.google?.num ?? 10,
      uule: file.google?.uule ?? "",
      extraParams: file.google?.extraParams ?? {},
    },
    location: {
      country: file.location?.country ?? "TR",
      city: file.location?.city,
    },
    profiles: {
      desktop: process.env.PROFILE_DESKTOP || undefined,
      mobile: process.env.PROFILE_MOBILE || undefined,
    },
    fingerprint: {
      syncBeforeScan: file.fingerprint?.syncBeforeScan ?? false,
      desktop: file.fingerprint?.desktop ?? {},
      mobile: file.fingerprint?.mobile ?? {},
    },
    devices: (file.devices ?? ["desktop", "mobile"]) as Device[],
    scan: {
      hopCap: file.scan?.hopCap ?? 12,
      navTimeoutMs: file.scan?.navTimeoutMs ?? 45000,
      resolveTimeoutMs: file.scan?.resolveTimeoutMs ?? 30000,
      minDelayMs: file.scan?.minDelayMs ?? 4000,
      maxDelayMs: file.scan?.maxDelayMs ?? 11000,
      screenshots: file.scan?.screenshots ?? true,
      resolveLandings: file.scan?.resolveLandings ?? true,
      concurrency: file.scan?.concurrency ?? 1,
      rotateProfiles: file.scan?.rotateProfiles ?? true,
      queriesPerProfile: file.scan?.queriesPerProfile ?? 1,
      profilePrefix: file.scan?.profilePrefix ?? "TR-ISP-",
      mobileProfilePrefix: file.scan?.mobileProfilePrefix ?? "TR-MOBILE-",
      // NEVER default to true — wiping Google trust re-opens /sorry forever on private ISP.
      clearProfileData: file.scan?.clearProfileData ?? false,
      // Product design: scan with a small active pool (5 mobile + 5 desktop), not all 50+50.
      maxProfilesPerDevice: file.scan?.maxProfilesPerDevice ?? 5,
      autoClickAfterScan: file.scan?.autoClickAfterScan ?? false,
      autoFocusCampaignAfterScan: file.scan?.autoFocusCampaignAfterScan ?? true,
      firstAdSwarm: file.scan?.firstAdSwarm ?? false,
      swarmClicksPerProfile: file.scan?.swarmClicksPerProfile ?? 10,
      swarmReportsPerProfile: file.scan?.swarmReportsPerProfile ?? 10,
      swarmMinDelayMs: file.scan?.swarmMinDelayMs ?? 30000,
      swarmMaxDelayMs: file.scan?.swarmMaxDelayMs ?? 90000,
    },
    click: {
      mode: file.click?.mode ?? "adaptive",
      concurrency: file.click?.concurrency ?? 10,
      durationMinutes: file.click?.durationMinutes ?? 60,
      clicksPerProfile: file.click?.clicksPerProfile ?? 30,
      staggerWindowSeconds: file.click?.staggerWindowSeconds ?? 300,
      minDelayMs: file.click?.minDelayMs ?? 3000,
      maxDelayMs: file.click?.maxDelayMs ?? 10000,
      maxClicksPerProfilePerHour: file.click?.maxClicksPerProfilePerHour ?? 10,
      sameAdCooldownMinutes: file.click?.sameAdCooldownMinutes ?? 20,
      maxProfilesPerDevice: file.click?.maxProfilesPerDevice ?? 5,
      focusWindowMinutes: file.click?.focusWindowMinutes ?? 120,
      behavior: {
        minPreClickMs: file.click?.behavior?.minPreClickMs ?? 5000,
        maxPreClickMs: file.click?.behavior?.maxPreClickMs ?? 15000,
        minStayMs: file.click?.behavior?.minStayMs ?? 15000,
        maxStayMs: file.click?.behavior?.maxStayMs ?? 45000,
        scrollChance: file.click?.behavior?.scrollChance ?? 0.9,
        mouseMoveChance: file.click?.behavior?.mouseMoveChance ?? 0.7,
        internalLinkChance: file.click?.behavior?.internalLinkChance ?? 0.25,
        minInternalStayMs: file.click?.behavior?.minInternalStayMs ?? 8000,
        maxInternalStayMs: file.click?.behavior?.maxInternalStayMs ?? 20000,
        mobileViewport: {
          width: file.click?.behavior?.mobileViewport?.width ?? 393,
          height: file.click?.behavior?.mobileViewport?.height ?? 851,
        },
      },
    },
    output: {
      dir: process.env.OUTPUT_DIR || "./data",
      sqlite: file.output?.sqlite ?? true,
      json: file.output?.json ?? true,
      csv: file.output?.csv ?? true,
    },
    report: {
      emailEnabled: file.report?.emailEnabled ?? false,
      autoExportOnScan: file.report?.autoExportOnScan ?? true,
      autoEmailOnScan: file.report?.autoEmailOnScan ?? false,
      from: process.env.REPORT_FROM || file.report?.from || "",
      to: process.env.REPORT_TO
        ? process.env.REPORT_TO.split(",").map((s) => s.trim()).filter(Boolean)
        : Array.isArray(file.report?.to)
          ? (file.report.to as string[]).map(String)
          : [],
      sendgridApiKey: process.env.SENDGRID_API_KEY || file.report?.sendgridApiKey || "",
      autoSerpSubmit: file.report?.autoSerpSubmit ?? false,
      autoSerpMaxAds: file.report?.autoSerpMaxAds ?? 20,
      autoSerpDelayMinMs: file.report?.autoSerpDelayMinMs ?? 30000,
      autoSerpDelayMaxMs: file.report?.autoSerpDelayMaxMs ?? 90000,
      reportEmail: process.env.REPORT_EMAIL || file.report?.reportEmail || "",
      emailPool: {
        enabled: file.report?.emailPool?.enabled ?? true,
        minSize: file.report?.emailPool?.minSize ?? 10,
      },
    },
    bettingKeywords: file.bettingKeywords ?? [],
    ...overrides,
  };

  const parsed = ConfigSchema.parse(merged);
  // Resolve output dir to an absolute path against the project root.
  parsed.output.dir = resolve(PROJECT_ROOT, parsed.output.dir);
  return parsed;
}

export { PROJECT_ROOT };
