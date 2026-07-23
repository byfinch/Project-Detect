import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "./config.js";
import { PROJECT_ROOT } from "./config.js";
import { AdsPowerClient, captchaProxyFromProfile, type CaptchaProxy, type ProfileSummary } from "./adspower/client.js";
import { BrowserSession } from "./browser/session.js";
import { markProfileInUse, releaseProfile } from "./browser/profileRegistry.js";
import {
  buildSerpUrl,
  gotoSerp,
  prepareGoogleConsent,
  recoverViaTrendClick,
  searchKeywordNatural,

  warmUp,
} from "./google/serp.js";
import { parseAds } from "./google/adParser.js";
import { resolveLanding } from "./resolve/redirectResolver.js";
import { Store } from "./store/db.js";
import { isInCooldown } from "./store/ipTrust.js";
import { exportScan } from "./store/report.js";
import { buildAdComplaintPack } from "./report/adComplaintPack.js";
import { exportTrustCookies, restoreTrustCookies } from "./captcha/recovery.js";
import { isBettingGuess } from "./analyze/betting.js";
import type { AdResult, Device } from "./types.js";
import { logger } from "./logger.js";
import { jitterDelay, sleep } from "./util/time.js";
import { browseSerpNaturally } from "./click/behavior.js";
import { personaFor } from "./util/persona.js";

/** How many different IPs to try for a keyword that hard-blocks (global default). */
const KEYWORD_IP_RETRIES = 3;

/**
 * Hard wall for any single scan step (trend recovery / keyword search).
 * A wedged renderer makes puppeteer protocol calls hang forever — without a
 * cap one stuck page froze an entire device leg (seen live). On expiry the
 * caller's normal error path runs: profile is closed, which rejects the hung
 * CDP promises, and the scan moves on. 6 minutes is generous — a healthy
 * keyword pass (nav + parse) fits in ~1.
 */
const SCAN_STEP_HARD_CAP_MS = 6 * 60_000;

export class ScanStepTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScanStepTimeoutError";
  }
}

function withScanStepCap<T>(p: Promise<T>, what: string, onTimeout?: () => void, ms = SCAN_STEP_HARD_CAP_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Let the caller mark its state before the rejection lands, so a
        // still-running zombie step can be detected and cleaned up.
        onTimeout?.();
        reject(new ScanStepTimeoutError(`${what} — hard timeout (${Math.round(ms / 60000)}m)`));
      }, ms);
    }),
  ]);
}

/** Close handshake must fail fast — a wedged renderer will never answer it. */
const PROFILE_CLOSE_CAP_MS = 60_000;

export interface BettingHit {
  device: string;
  keyword: string;
  displayDomain: string;
  finalDomain: string | null;
}

export interface ScanSummary {
  scanId: number;
  totalAds: number;
  bettingAds: number;
  byDevice: Record<string, number>;
  captchaKeywords: string[];
  bettingHits: BettingHit[];
  reportPaths: { json?: string; csv?: string };
}

interface ScanCtx {
  store: Store;
  scanId: number;
  config: AppConfig;
  shotDir: string;
  totalAds: number;
  bettingAds: number;
  byDevice: Record<string, number>;
  captchaKeywords: string[];
  bettingHits: BettingHit[];
  /** If set, only these AdsPower profile names may be used (safe clean pool). */
  onlyProfileNames: Set<string> | null;
  /** When true, captcha does not burn other clean IPs on the same keyword. */
  protectPool: boolean;
  /** user_id → display name for persona */
  profileNames: Map<string, string>;
  /** Protects shared counters across parallel device workers. */
  mutex: AsyncMutex;
}

export interface RunScanOpts {
  /** Restrict pool to these profile names (e.g. clean mobiles). */
  onlyProfileNames?: string[];
  /**
   * Protect restricted pool: on captcha, mark profile hot and skip keyword
   * without retrying on other clean profiles.
   */
  protectPool?: boolean;
  /** Abort signal to cancel the scan early. */
  signal?: AbortSignal;
}

class AsyncMutex {
  private promise: Promise<void> = Promise.resolve();
  async run<T>(fn: () => T): Promise<T> {
    const release = await this.acquire();
    try {
      return fn();
    } finally {
      release();
    }
  }
  private acquire(): Promise<() => void> {
    let resolve: () => void;
    const p = new Promise<void>((r) => {
      resolve = r;
    });
    const prev = this.promise;
    this.promise = prev.then(() => p);
    return prev.then(() => resolve!);
  }
}

function safeName(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "_").slice(0, 60) || "kw";
}

/**
 * Light interest warm-up before brand queries.
 * Keep SHORT — 5 heavy betting searches was burning IPs into /sorry/ storms.
 */
/** Soft only — brand-like warm-up ("bahis siteleri") burns IPs into /sorry. */
const WARM_UP_KEYWORDS = ["hava durumu"];

async function syncFingerprints(ads: AdsPowerClient, config: AppConfig): Promise<void> {
  if (!config.fingerprint?.syncBeforeScan) return;

  // NEVER call AdsPower newFingerprint() here.
  // Regenerating a random fingerprint every scan on a fixed private ISP IP is a
  // captcha death spiral: Google sees a new device on the same exit IP → /sorry
  // forever, even after a successful manual solve on the previous fingerprint.
  if (config.captcha.enabled) {
    logger.warn(
      "fingerprint.syncBeforeScan ignored while captcha.enabled — random fingerprint regen is banned in captcha mode"
    );
    return;
  }

  const profiles = await ads.listProfiles();
  for (const device of config.devices) {
    const prefix = device === "mobile" ? config.scan.mobileProfilePrefix : config.scan.profilePrefix;
    const cfg = config.fingerprint[device];
    if (!cfg || Object.keys(cfg).length === 0) {
      logger.warn({ device }, "no fingerprint config for device, skipping sync");
      continue;
    }
    const matched = profiles.filter((p) => (p.name ?? "").startsWith(prefix));
    logger.info({ device, count: matched.length }, "pinning UA/lang/tz only (no fingerprint regen)");

    const base = {
      automatic_timezone: cfg.automatic_timezone as string | undefined,
      language: cfg.language as string[] | undefined,
      ua: cfg.ua as string | undefined,
    };
    for (const p of matched) {
      try {
        const active = await ads.browserActive(p.user_id).catch(() => null);
        if (active?.status === "Active") {
          await ads.stopBrowser(p.user_id, true);
        }
        await ads.updateProfile(p.user_id, base);
        logger.debug({ device, profileId: p.user_id, name: p.name }, "fingerprint base pinned");
      } catch (err) {
        logger.warn({ device, profileId: p.user_id, err: String(err) }, "failed to pin fingerprint base");
      }
    }
  }
}

async function preWarmProfile(session: BrowserSession, config: AppConfig): Promise<void> {
  // Captcha-enabled private ISP: extra SERP hits are the death spiral.
  // Manual/auto solve → pre-warm "bahis siteleri" → new /sorry → user stuck solving forever.
  if (config.captcha.enabled) {
    logger.info("skipping pre-warm SERP keywords (captcha mode — do not burn IP)");
    return;
  }
  for (const keyword of WARM_UP_KEYWORDS) {
    try {
      const url = buildSerpUrl(config, keyword);
      await session.page.goto(url, { timeout: 25_000, waitUntil: "domcontentloaded" });
      if (session.page.url().includes("/sorry/")) {
        logger.warn({ keyword }, "captcha during pre-warm — skipping remaining warm-up keywords");
        break;
      }
      await sleep(1_200);
    } catch (err) {
      logger.debug({ keyword, err: String(err) }, "warm-up keyword failed (ignored)");
    }
  }
}

interface DevicePool {
  /** Shuffled profile ids for this device. */
  ids: string[];
  /** user_id → 2captcha proxy descriptor (from AdsPower user_proxy_config). */
  proxies: Map<string, CaptchaProxy>;
  /** user_id → AdsPower display name (for persona + logs). */
  nameById: Map<string, string>;
}

/** Load the set of profile names that passed the proxy health check. If the file is missing, allow all profiles. */
function loadCleanProfileNames(): Set<string> | null {
  try {
    const path = resolve(PROJECT_ROOT, "data", "proxy-status.json");
    const raw = readFileSync(path, "utf8");
    const list = JSON.parse(raw) as Array<{ name: string; status: string }>;
    return new Set(list.filter((r) => r.status === "ok").map((r) => r.name));
  } catch {
    return null;
  }
}

function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

/**
 * Drop profiles still in vault cooldown (solver-failed wait). Force list (--only) is never filtered.
 */
function filterVaultCooldown(
  profiles: ProfileSummary[],
  onlyProfileNames: Set<string> | null,
  store: Store | null
): ProfileSummary[] {
  if (!store || onlyProfileNames) return profiles;
  const now = new Date();
  const kept: ProfileSummary[] = [];
  let skipped = 0;
  for (const p of profiles) {
    const row = store.ipTrust.get(p.user_id) ?? store.ipTrust.list().find((r) => r.name === (p.name ?? ""));
    if (row && isInCooldown(row, now)) {
      skipped++;
      logger.debug(
        { name: p.name, status: row.status, nextRetryAt: row.nextRetryAt },
        "skip profile — vault cooldown active"
      );
      continue;
    }
    kept.push(p);
  }
  if (skipped) {
    logger.info({ from: profiles.length, kept: kept.length, skippedCooldown: skipped }, "filtered vault cooldown profiles");
  }
  return kept;
}

/**
 * Cap pool to maxProfilesPerDevice (default 5). Prefer vault "usable", then unknown;
 * skip in-cooldown captcha. Explicit --only-names is NOT capped.
 */
function applyActivePoolCap(
  profiles: ProfileSummary[],
  config: AppConfig,
  onlyProfileNames: Set<string> | null,
  store: Store | null
): ProfileSummary[] {
  const cooled = filterVaultCooldown(profiles, onlyProfileNames, store);
  const max = config.scan.maxProfilesPerDevice ?? 0;
  if (onlyProfileNames || max <= 0 || cooled.length <= max) return cooled;

  const rank = (p: ProfileSummary): number => {
    if (!store) return 1;
    const row = store.ipTrust.get(p.user_id) ?? store.ipTrust.list().find((r) => r.name === (p.name ?? ""));
    if (!row) return 1;
    if (row.status === "usable") return 0;
    if (row.status === "recovering") return 1;
    if (row.status === "captcha") return 2;
    return 3; // quarantined
  };

  const buckets: ProfileSummary[][] = [[], [], [], []];
  for (const p of cooled) {
    const r = rank(p);
    buckets[Math.min(r, 3)]!.push(p);
  }
  for (const b of buckets) shuffleInPlace(b);

  const picked: ProfileSummary[] = [];
  for (const b of buckets) {
    for (const p of b) {
      if (picked.length >= max) break;
      picked.push(p);
    }
    if (picked.length >= max) break;
  }
  logger.info(
    {
      from: profiles.length,
      cooled: cooled.length,
      to: picked.length,
      max,
      names: picked.map((p) => p.name),
    },
    "active scan pool capped (5+5 design — not all profiles)"
  );
  return picked;
}

/** Resolve the pool of AdsPower profiles (+ proxy creds) to rotate through for a device. */
async function resolvePool(
  ads: AdsPowerClient,
  device: Device,
  config: AppConfig,
  onlyProfileNames: Set<string> | null,
  store: Store | null = null
): Promise<DevicePool & { nameById: Map<string, string> }> {
  const empty = { ids: [] as string[], proxies: new Map<string, CaptchaProxy>(), nameById: new Map<string, string>() };
  const toPool = (profiles: ProfileSummary[]) => {
    const capped = applyActivePoolCap(profiles, config, onlyProfileNames, store);
    const ids = capped.map((p) => p.user_id);
    shuffleInPlace(ids);
    const proxies = new Map<string, CaptchaProxy>();
    const nameById = new Map<string, string>();
    for (const p of capped) {
      const cp = captchaProxyFromProfile(p);
      if (cp) proxies.set(p.user_id, cp);
      nameById.set(p.user_id, p.name ?? p.user_id);
    }
    return { ids, proxies, nameById };
  };

  if (!config.scan.rotateProfiles && !onlyProfileNames) {
    const id = config.profiles[device];
    if (!id) return empty;
    try {
      const all = await ads.listProfiles();
      const match = all.filter((p) => p.user_id === id);
      if (match.length) return toPool(match);
    } catch {
      /* fall through */
    }
    return { ids: [id], proxies: new Map(), nameById: new Map([[id, id]]) };
  }

  const prefix = device === "mobile" ? config.scan.mobileProfilePrefix : config.scan.profilePrefix;
  const cleanNames = onlyProfileNames ?? loadCleanProfileNames();
  try {
    const profiles = await ads.listProfiles();
    const matched = profiles.filter((p) => {
      const name = p.name ?? "";
      if (onlyProfileNames) return onlyProfileNames.has(name);
      return name.startsWith(prefix) && (cleanNames === null || cleanNames.has(name));
    });
    if (onlyProfileNames && matched.length === 0) {
      logger.warn({ device, wanted: [...onlyProfileNames] }, "no profiles matched --only-profiles list");
    }
    if (cleanNames && !onlyProfileNames && matched.length === 0) {
      logger.warn({ device, prefix }, "no clean profiles for device after proxy-status filter");
    }
    if (matched.length) {
      const pool = toPool(matched);
      logger.info(
        {
          device,
          poolSize: pool.ids.length,
          withProxy: pool.proxies.size,
          only: !!onlyProfileNames,
          maxPerDevice: config.scan.maxProfilesPerDevice,
          names: [...pool.nameById.values()],
        },
        "device pool ready (with AdsPower proxy map)"
      );
      return pool;
    }
    if (onlyProfileNames) return empty;
    logger.warn({ device, prefix }, "no profiles match prefix — falling back to configured single profile");
  } catch (err) {
    logger.warn({ device, err: String(err) }, "listProfiles failed — falling back to configured single profile");
  }
  if (onlyProfileNames) return empty;
  const id = config.profiles[device];
  return id ? { ids: [id], proxies: new Map(), nameById: new Map([[id, id]]) } : empty;
}

export interface ScannedAd {
  title: string;
  description: string;
  displayDomain: string;
  displayUrl: string;
  adHref: string | null;
  finalDomain: string | null;
  isBettingGuess: boolean;
}

/** Scan one keyword on the given session. Returns whether a CAPTCHA wall was hit / cleared. */
async function scanOneKeyword(
  ctx: ScanCtx,
  session: BrowserSession,
  device: Device,
  profileId: string,
  keyword: string,
  captchaProxy?: CaptchaProxy,
  onProgress?: (event: Record<string, unknown>) => void
): Promise<{ captcha: boolean; captchaSolved: boolean; ads: ScannedAd[]; adsFound: number }> {
  const { config, store, scanId } = ctx;
  const captchaOpts = {
    captchaProxy: captchaProxy
      ? { proxy: captchaProxy.proxy, proxytype: captchaProxy.proxytype }
      : undefined,
  };
  const profileName = ctx.profileNames.get(profileId) || profileId;
  onProgress?.({
    type: "scan-progress",
    device,
    keyword,
    profileId,
    profileName,
    message:
      device === "mobile"
        ? `Tek pass · marka ara: "${keyword}" · ${profileName}`
        : `Marka araması (tek pass): "${keyword}" · ${device} · ${profileName}`,
    phase: "brand-search",
  });

  // Single SERP pass after trend (no 0-ad re-search). Mobile = natural type; desktop = /search URL.
  let nav =
    device === "mobile"
      ? await searchKeywordNatural(session, config, keyword, { ...captchaOpts, device: "mobile" })
      : await gotoSerp(session, buildSerpUrl(config, keyword), config, captchaOpts);
  if (nav.captcha) {
    const cool = ctx.store.ipTrust.markSolverFailed(profileId, `keyword=${keyword}`);
    logger.warn(
      {
        device,
        keyword,
        profileId,
        cooldownMinutes: cool.cooldownMinutes,
        fails: cool.consecutiveFails,
        status: cool.status,
        nextRetryAt: cool.nextRetryAt,
      },
      "solver failed on brand SERP — profile cooldown (not permanent ban)"
    );
    onProgress?.({
      type: "scan-progress",
      device,
      keyword,
      profileId,
      message: `Solver fail → cooldown ${cool.cooldownMinutes}dk · ${profileName} (${device})`,
      phase: "captcha-cooldown",
    });
    return { captcha: true, captchaSolved: false, ads: [], adsFound: 0 };
  }

  // Light browse once, then parse. No scroll thrash loops.
  await browseSerpNaturally(session.page, device, profileName).catch(() => {});

  const raw = await parseAds(session.page);
  let captchaSolved = nav.captchaSolved;
  const searchPass = 1;

  // Single-pass scan: no Görseller/Tümü retries. They burn IPs and the
  // pipeline relies on the next scheduled 2h scan to catch fresh impressions.
  if (raw.length === 0) {
    logger.info(
      { device, keyword, profileId, finalUrl: nav.finalUrl },
      "0 ads on first SERP — no re-search (single-pass mode)"
    );
  }

  // Durable vault: trust cookies survive process restart and profile clears.
  try {
    const cookies = await exportTrustCookies(session);
    if (captchaSolved) ctx.store.ipTrust.markSolved(profileId, cookies);
    else ctx.store.ipTrust.markClean(profileId, cookies);
  } catch {
    /* non-fatal */
  }

  if (raw.length === 0) {
    logger.warn({ device, keyword, profileId, finalUrl: nav.finalUrl }, "SERP still has 0 ads after retries");
  }

  let shot: string | null = null;
  if (config.scan.screenshots) {
    // Unique per profile so later profiles do not overwrite ad evidence
    const shortId = profileId.slice(-6);
    const p = resolve(ctx.shotDir, `${device}-${safeName(keyword)}-${shortId}.png`);
    const { screenshotWithoutScrollbar } = await import("./browser/screenshot.js");
    shot = await screenshotWithoutScrollbar(session.page, p, { fullPage: true });
  }
  logger.info({ device, keyword, profileId, adsFound: raw.length }, "SERP parsed");

  const scannedAds: ScannedAd[] = [];
  let position = 0;
  for (const r of raw) {
    position++;
    const ad: AdResult = {
      keyword,
      device,
      profileId,
      position,
      block: r.block,
      displayDomain: r.displayDomain,
      displayUrl: r.displayUrl,
      title: r.title,
      description: r.description,
      adHref: r.adHref,
      finalUrl: null,
      finalDomain: null,
      redirectHops: [],
      isBettingGuess: isBettingGuess(config.bettingKeywords, {
        title: r.title,
        description: r.description,
        displayDomain: r.displayDomain,
      }),
      screenshotPath: shot,
      capturedAt: new Date().toISOString(),
    };

    if (config.scan.resolveLandings && (r.adHref || r.displayDomain)) {
      const target = r.adHref || `https://${r.displayDomain}`;
      try {
        const outcome = await resolveLanding(session, target, {
          hopCap: config.scan.hopCap,
          timeoutMs: config.scan.resolveTimeoutMs,
          referer: `https://${config.google.domain}/`,
          bettingKeywords: config.bettingKeywords,
        });
        ad.finalUrl = outcome.finalUrl;
        ad.finalDomain = outcome.finalDomain;
        ad.redirectHops = outcome.hops;
        if (outcome.bettingSignal) ad.isBettingGuess = true;
        else if (outcome.finalDomain) {
          ad.isBettingGuess =
            ad.isBettingGuess || isBettingGuess(config.bettingKeywords, { displayDomain: outcome.finalDomain });
        }
      } catch (err) {
        logger.debug({ keyword, target, err: String(err) }, "landing resolve failed");
      }
    }

    store.insertResult(scanId, ad);
    await ctx.mutex.run(() => {
      ctx.totalAds++;
      ctx.byDevice[device] = (ctx.byDevice[device] ?? 0) + 1;
      if (ad.isBettingGuess) {
        ctx.bettingAds++;
        if (ctx.bettingHits.length < 500) {
          ctx.bettingHits.push({ device, keyword, displayDomain: ad.displayDomain, finalDomain: ad.finalDomain });
        }
      }
    });
    scannedAds.push({
      title: ad.title,
      description: ad.description,
      displayDomain: ad.displayDomain,
      displayUrl: ad.displayUrl,
      adHref: ad.adHref,
      finalDomain: ad.finalDomain,
      isBettingGuess: ad.isBettingGuess,
    });
    if (ad.isBettingGuess) {
      onProgress?.({
        type: "ad-found",
        device,
        keyword,
        displayDomain: ad.displayDomain,
        finalDomain: ad.finalDomain,
        profileId,
        profileName,
      });
    }
  }
  onProgress?.({
    type: "keyword-done",
    device,
    keyword,
    profileId,
    profileName,
    adsFound: raw.length,
    totalAds: ctx.totalAds,
    searchPass,
    // Explicit: this is ONE profile result, not end of whole scan.
    message:
      raw.length > 0
        ? `"${keyword}" · ${device} · ${profileName}: ${raw.length} reklam (SERP açık — tık denenecek)`
        : `"${keyword}" · ${device} · ${profileName}: 0 reklam (profil devam edebilir)`,
  });
  return { captcha: false, captchaSolved, ads: scannedAds, adsFound: scannedAds.length };
}

interface WorkerState {
  session: BrowserSession | null;
  profileId: string | null;
  queriesOnProfile: number;
  /** Set when a withScanStepCap timeout fired mid-openNext — the zombie must not claim state. */
  timedOut?: boolean;
}

interface SwarmTarget {
  keyword: string;
  ad: ScannedAd;
}

/** Run one device with up to `concurrency` parallel profiles. */
async function runDeviceScan(
  ctx: ScanCtx,
  ads: AdsPowerClient,
  device: Device,
  keywords: string[],
  concurrency: number,
  onProgress?: (event: Record<string, unknown>) => void,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) {
    logger.warn({ device }, "runDeviceScan aborted before start");
    return;
  }
  if (concurrency <= 0) {
    logger.info({ device, concurrency }, "runDeviceScan: zero concurrency for device — skipping");
    return;
  }
  const config = ctx.config;
  const pool = await resolvePool(ads, device, config, ctx.onlyProfileNames, ctx.store);
  if (pool.ids.length === 0) {
    logger.warn(
      { device },
      `no AdsPower profiles for ${device} (need name prefix "${device === "mobile" ? config.scan.mobileProfilePrefix : config.scan.profilePrefix}" or PROFILE_${device.toUpperCase()})`
    );
    return;
  }
  for (const [id, name] of pool.nameById) ctx.profileNames.set(id, name);
  ctx.byDevice[device] = 0;
  // Restricted clean pool: never burn N clean IPs retrying one keyword.
  const keywordIpRetries = ctx.protectPool || ctx.onlyProfileNames ? 1 : KEYWORD_IP_RETRIES;
  logger.info(
    {
      device,
      poolSize: pool.ids.length,
      withProxy: pool.proxies.size,
      queriesPerProfile: keywords.length,
      keywordIpRetries,
      protectPool: ctx.protectPool,
      concurrency,
    },
    "device pool ready"
  );

  const hotProfiles = new Set<string>();
  let poolIdx = 0;
  let swarmTarget: SwarmTarget | null = null;

  const pickCandidate = (): string | null => {
    if (pool.ids.length === 0) return null;
    for (let i = 0; i < pool.ids.length; i++) {
      const idx = (poolIdx + i) % pool.ids.length;
      const id = pool.ids[idx]!;
      if (!hotProfiles.has(id)) {
        poolIdx = (idx + 1) % pool.ids.length;
        return id;
      }
    }
    const id = pool.ids[poolIdx % pool.ids.length]!;
    poolIdx = (poolIdx + 1) % pool.ids.length;
    return id;
  };

  const throwIfAborted = (where: string) => {
    if (signal?.aborted) {
      throw signal.reason || new Error(`scan aborted during ${where}`);
    }
  };

  const openNext = async (state: WorkerState, localSignal?: AbortSignal): Promise<boolean> => {
    throwIfAborted("openNext");
    // closeState carries the 60s hard cap + AdsPower API kill for wedged renderers.
    await closeState(state);

    for (let tried = 0; tried < pool.ids.length; tried++) {
      throwIfAborted("openNext");
      if (localSignal?.aborted) {
        logger.warn({ device }, "openNext local abort");
        return false;
      }
      const candidate = pickCandidate();
      if (!candidate) return false;
      let session: BrowserSession | null = null;
      try {
        throwIfAborted("openNext candidate open");
        const ws = await ads.ensureBrowser(candidate);
        throwIfAborted("openNext candidate attach");
        session = await BrowserSession.attach(ws);
        // Mark as soon as the browser exists — the reaper must not kill us
        // mid-warm-up (mark happens again at profile-ready; Set add is free).
        markProfileInUse(candidate);
        // Clear first, then re-seed consent — reverse order wiped CONSENT cookies.
        // When 2captcha recovery is on, NEVER wipe GOOGLE_ABUSE_EXEMPTION / NID:
        // those are what keep private ISP IPs usable day-to-day without manual solves.
        if (config.scan.clearProfileData) {
          // Always keep Google trust on private ISP (exemption/NID). Full wipe = /sorry forever.
          await session.clearProfileData({ preserveGoogleTrust: true });
          logger.info({ device, profileId: candidate, preserveGoogleTrust: true }, "profile data cleared (trust preserved)");
        }
        // Vault restore: durable trust across days (not only in-browser preserve).
        if (config.captcha.enabled) {
          const trust = ctx.store.ipTrust.get(candidate);
          if (trust?.trustCookies?.length) {
            await restoreTrustCookies(session, trust.trustCookies);
          }
          ctx.store.ipTrust.upsertMeta({
            profileId: candidate,
            name: pool.nameById.get(candidate) || candidate,
            device,
            proxyHost: pool.proxies.get(candidate)?.exitIp ?? "",
          });
        }
        await prepareGoogleConsent(session);
        if (device === "mobile") {
          const { applyMobileEmulation } = await import("./browser/mobileEmulation.js");
          await applyMobileEmulation(session.page);
        }
        const px = pool.proxies.get(candidate);
        const captchaOpts = px
          ? { captchaProxy: { proxy: px.proxy, proxytype: px.proxytype } }
          : {};
        // HARD RULE: never open brand SERP cold. Trend (or solve on trend) first,
        // then mark profile ready for keywords like herabet.
        throwIfAborted("openNext warm-up");
        const warm = await warmUp(session, config, { ...captchaOpts, trendWarmup: true });
        if (warm.captcha) {
          const cool = ctx.store.ipTrust.markSolverFailed(candidate, "trend warm-up blocked before brand");
          logger.warn(
            {
              device,
              profileId: candidate,
              trend: warm.trend,
              method: warm.method,
              cooldownMinutes: cool.cooldownMinutes,
              nextRetryAt: cool.nextRetryAt,
            },
            "trend warm-up solver failed — cooldown (skip brand this session)"
          );
          hotProfiles.add(candidate);
          releaseProfile(candidate);
          const { gracefulProfileShutdown } = await import("./browser/shutdown.js");
          await gracefulProfileShutdown(ads, session, candidate);
          continue;
        }
        try {
          const cookies = await exportTrustCookies(session);
          if (warm.captchaSolved) ctx.store.ipTrust.markSolved(candidate, cookies);
          else ctx.store.ipTrust.markClean(candidate, cookies);
        } catch {
          /* non-fatal */
        }
        throwIfAborted("openNext pre-warm");
        await preWarmProfile(session, config);
        state.session = session;
        state.profileId = candidate;
        state.queriesOnProfile = 0;
        logger.info(
          {
            device,
            profileId: candidate,
            hasProxy: !!px,
            proxytype: px?.proxytype,
            exitIp: px?.exitIp,
            hot: hotProfiles.has(candidate),
            trend: warm.trend,
            trustMethod: warm.method,
            captchaSolved: warm.captchaSolved,
          },
          "profile ready (session safe via trend)"
        );
        onProgress?.({
          type: "profile-ready",
          device,
          profileId: candidate,
          trend: warm.trend,
          trustMethod: warm.method,
        });
        markProfileInUse(candidate);
        // The step cap already fired while we were opening — do not claim the
        // worker state (a zombie assignment would orphan the browser).
        if (state.timedOut) {
          const { gracefulProfileShutdown } = await import("./browser/shutdown.js");
          await gracefulProfileShutdown(ads, session, candidate).catch(() => {});
          releaseProfile(candidate);
          return false;
        }
        return true;
      } catch (err) {
        logger.warn({ device, profileId: candidate, err: String(err) }, "profile start failed, trying next");
        releaseProfile(candidate);
        const { gracefulProfileShutdown } = await import("./browser/shutdown.js");
        await withScanStepCap(gracefulProfileShutdown(ads, session ?? null, candidate), `close failed profile ${candidate}`, undefined, PROFILE_CLOSE_CAP_MS).catch(
          async (closeErr) => {
            logger.error({ device, profileId: candidate, err: String(closeErr) }, "graceful close wedged — force-killing via AdsPower API");
            await ads.stopBrowser(candidate).catch(() => {});
          }
        );
        state.session = null;
      }
    }
    return false;
  };

  const closeState = async (state: WorkerState): Promise<void> => {
    const { gracefulProfileShutdown } = await import("./browser/shutdown.js");
    const pid = state.profileId;
    try {
      if (pid) {
        // Hard cap + API kill: a wedged renderer never answers the CDP close
        // handshake (seen live: mobile leg frozen 4h right at this line). After
        // 60s, kill the browser through the AdsPower HTTP API — that channel
        // does not depend on the stuck renderer.
        await withScanStepCap(gracefulProfileShutdown(ads, state.session, pid), `close profile ${pid}`, undefined, PROFILE_CLOSE_CAP_MS).catch(
          async (err) => {
            logger.error({ device, profileId: pid, err: String(err) }, "graceful close wedged — force-killing via AdsPower API");
            await ads.stopBrowser(pid).catch(() => {});
          }
        );
      } else if (state.session) {
        await state.session.detach().catch(() => {});
      }
    } finally {
      if (pid) releaseProfile(pid);
      state.session = null;
      state.profileId = null;
    }
  };

  // How many brand queries per open session after trend warm.
  // Default 1 from config; protect-pool mode uses full keyword list per profile below.
  const queriesPerProfile = Math.max(1, config.scan.queriesPerProfile ?? 1);

  /**
   * Safe / only-profiles mode. Full-variant scans (45 keywords × 5 profiles)
   * took 2.5h+ per device — far past the 2h cadence. Now keywords are SHARDED
   * across pool profiles (each keyword once per scan) whenever the list is
   * longer than the pool: same coverage, ~5x faster, profiles freed for clicks.
   * Short lists keep the old all-keywords-per-profile behavior.
   * Captcha on one profile stops that profile only — never reassigns keyword to burn another clean IP.
   */
  if (ctx.onlyProfileNames || ctx.protectPool) {
    const totalProfiles = pool.ids.length;
    const sharded = keywords.length > totalProfiles;
    logger.info(
      { device, profiles: totalProfiles, keywords: keywords.length, sharded },
      sharded
        ? "protected pool mode: keywords sharded across profiles"
        : "protected pool mode: each profile runs full keyword list"
    );
    for (let pi = 0; pi < pool.ids.length; pi++) {
      const profileId = pool.ids[pi]!;
      const profileKeywords = sharded ? keywords.filter((_, ki) => ki % totalProfiles === pi) : keywords;
      if (profileKeywords.length === 0) continue;
      if (hotProfiles.has(profileId)) continue;
      const pnameHint = pool.nameById.get(profileId) || profileId;
      const remainingAfter = totalProfiles - pi - 1;
      onProgress?.({
        type: "scan-progress",
        device,
        profileId,
        profileIndex: pi + 1,
        profileTotal: totalProfiles,
        message: `Profil ${pi + 1}/${totalProfiles} açılıyor + trend warm-up (${device}): ${pnameHint}`,
        phase: "profile-open",
      });
      const state: WorkerState = { session: null, profileId: null, queriesOnProfile: 0 };
      // Force this profile next (pickCandidate respects hot set).
      poolIdx = pool.ids.indexOf(profileId);
      const ok = await withScanStepCap(openNext(state, signal), `profile open (${pnameHint})`, () => {
        state.timedOut = true;
      }).catch(async (err) => {
        // Scan-level abort must propagate — swallowing it traps the scan here.
        if (signal?.aborted) throw err;
        logger.error({ device, profileId, err: String(err) }, "profile open wedged — closing and skipping");
        await closeState(state).catch(() => {});
        return false;
      });
      if (!ok || state.profileId !== profileId) {
        // openNext may pick another if open failed — if wrong profile, close and skip.
        if (state.profileId && state.profileId !== profileId) {
          hotProfiles.add(profileId);
          await closeState(state);
        }
        logger.warn({ device, profileId }, "could not open protected-pool profile — skipping");
        onProgress?.({
          type: "scan-progress",
          device,
          profileId,
          message: `Profil atlandı (${device}): ${pnameHint} · kalan ~${remainingAfter}`,
          phase: "profile-skip",
        });
        continue;
      }
      const pname = pool.nameById.get(profileId) || profileId;
      const persona = personaFor(pname);
      logger.info({ device, profile: pname, persona: persona.label, keywords: profileKeywords.length }, "protected profile scan start");
      onProgress?.({
        type: "scan-progress",
        device,
        profileId,
        profileName: pname,
        profileIndex: pi + 1,
        profileTotal: totalProfiles,
        message: `Profil tarama: ${pname} (${device}) · ${pi + 1}/${totalProfiles}`,
        phase: "profile-scan",
      });

      // Desktop: Safe–Keyword–Safe–Keyword…
      // openNext already did first live trend (Safe). Between brands: another live trend (not fixed soft words).
      // Cadence: with sharded variant lists, per-keyword trends dominated scan time
      // (~25s × 45) — now every 3rd keyword, the session is already warm.
      // Mobile: brands back-to-back (single-pass brand only).
      for (let ki = 0; ki < profileKeywords.length; ki++) {
        if (swarmTarget) {
          logger.info({ device, profile: pname, keyword: swarmTarget.keyword, domain: swarmTarget.ad.displayDomain }, "swarm: target locked, stopping scan worker");
          await closeState(state);
          return;
        }
        const keyword = profileKeywords[ki]!;
        const proxy = pool.proxies.get(profileId);

        if (device === "desktop" && ki > 0 && ki % 3 === 0) {
          onProgress?.({
            type: "scan-progress",
            device,
            profileName: pname,
            message: `Safe (canlı trend) · sonra marka "${keyword}" · ${pname}`,
            phase: "safe-trend",
          });
          try {
            const captchaOpts = proxy
              ? { captchaProxy: { proxy: proxy.proxy, proxytype: proxy.proxytype } }
              : {};
            const safeNav = await withScanStepCap(
              recoverViaTrendClick(state.session!, config, captchaOpts),
              `safe-trend ${pname}`
            );
            if (safeNav.captcha && !safeNav.captchaSolved) {
              hotProfiles.add(profileId);
              const cool = ctx.store.ipTrust.markSolverFailed(profileId, "safe-trend blocked");
              logger.warn(
                {
                  device,
                  profile: pname,
                  trend: safeNav.trend,
                  cooldownMinutes: cool.cooldownMinutes,
                  nextRetryAt: cool.nextRetryAt,
                },
                "desktop safe-trend solver failed — cooldown"
              );
              await ctx.mutex.run(() => ctx.captchaKeywords.push(`${device}:safe-trend:${pname}`));
              onProgress?.({
                type: "scan-progress",
                device,
                profileName: pname,
                message: `Safe trend solver fail → cooldown ${cool.cooldownMinutes}dk · ${pname}`,
                phase: "profile-captcha-stop",
              });
              break;
            }
            logger.info(
              { device, profile: pname, trend: safeNav.trend, nextBrand: keyword },
              "desktop Safe (live trend) OK — next brand keyword"
            );
            await jitterDelay(
              Math.floor(config.scan.minDelayMs * 0.5),
              Math.floor(config.scan.maxDelayMs * 0.7)
            );
          } catch (err) {
            logger.warn({ device, profile: pname, err: String(err) }, "safe-trend failed (continuing to brand)");
          }
        }

        try {
          const res = await withScanStepCap(
            scanOneKeyword(ctx, state.session!, device, profileId, keyword, proxy, onProgress),
            `keyword scan "${keyword}" (${pname})`
          );
          if (res.captcha) {
            // markSolverFailed already called in scanOneKeyword
            hotProfiles.add(profileId);
            const row = ctx.store.ipTrust.get(profileId);
            const mins = row?.consecutiveFails
              ? [10, 20, 45, 120, 360, 720, 1440][Math.min(row.consecutiveFails - 1, 6)]
              : 10;
            logger.warn(
              { device, keyword, profile: pname, cooldownMinutes: mins, nextRetryAt: row?.nextRetryAt },
              "protected profile cooldown — other clean IPs continue"
            );
            await ctx.mutex.run(() => ctx.captchaKeywords.push(`${device}:${keyword}:${pname}`));
            onProgress?.({
              type: "scan-progress",
              device,
              keyword,
              profileName: pname,
              message: `Cooldown ${mins}dk · ${pname} (${device}) — diğer profiller devam`,
              phase: "profile-captcha-stop",
            });
            break;
          }
          if (res.captchaSolved) {
            logger.info({ profile: pname, keyword }, "captcha solved mid-scan — continuing carefully");
          }

          // Swarm mode: first ad caught → all workers switch to this single target.
          if (res.adsFound > 0 && config.scan.firstAdSwarm && state.session && state.profileId) {
            const firstAd = res.ads.find((a) => a.adHref);
            if (firstAd && !swarmTarget) {
              swarmTarget = { keyword, ad: firstAd };
              logger.info(
                { device, profileId: state.profileId, keyword, domain: firstAd.displayDomain },
                "swarm: global target locked, all workers will attack this ad"
              );
              onProgress?.({
                type: "scan-progress",
                device,
                keyword,
                domain: firstAd.displayDomain,
                scanId: ctx.scanId,
                message: `Swarm hedefi kilitlendi · ${firstAd.displayDomain} · tüm profiller bu reklama odaklanacak`,
                phase: "swarm-locked",
                target: {
                  domain: firstAd.displayDomain,
                  titleHint: firstAd.title,
                  keywords: [keyword],
                  targetDevice: device,
                  impressions: [],
                },
              });
            }
          }

          // Ad visible NOW — click before close/reopen (impression often gone after restart).
          if (res.adsFound > 0 && config.scan.autoClickAfterScan && state.session) {
            const clickTargets = res.ads.filter((a) => a.adHref);
            if (clickTargets.length > 0) {
              onProgress?.({
                type: "scan-progress",
                device,
                keyword,
                profileName: pname,
                phase: "inline-click",
                message: `Reklam göründü · profil AÇIK tutuluyor · ${clickTargets.length} domain tıklanacak · ${pname}`,
              });
              const { clickAdsOnOpenSerpWithCap, InlineClickTimeoutError } = await import("./click/inlineClick.js");
              try {
                await clickAdsOnOpenSerpWithCap({
                  config,
                  session: state.session,
                  device,
                  profileId,
                  profileName: pname,
                  keyword,
                  ads: clickTargets,
                  outputDir: config.output.dir,
                  maxClicks: Math.min(5, clickTargets.length),
                  withReport: true,
                  operationId: `scan-${ctx.scanId}`,
                  captchaProxy: state.profileId ? pool.proxies.get(state.profileId) : undefined,
                  onProgress,
                });
              } catch (err) {
                if (err instanceof InlineClickTimeoutError) {
                  // Wedged renderer/CDP — this session is untrustworthy. Break the
                  // keyword loop; closeState below kills the browser and unsticks it.
                  logger.error({ device, profile: pname, err: String(err) }, "inline click WEDGED — closing profile, moving on");
                  onProgress?.({
                    type: "scan-progress",
                    device,
                    profileName: pname,
                    phase: "inline-click-timeout",
                    message: `Inline tık kilitlendi · profil kapatılıp sıradakine geçiliyor · ${pname}`,
                  });
                  break;
                }
                logger.warn({ device, profile: pname, err: String(err) }, "inline click after ad failed (scan continues)");
                onProgress?.({
                  type: "scan-progress",
                  device,
                  profileName: pname,
                  phase: "inline-click-error",
                  message: `Inline tık hata (tarama devam): ${String(err).slice(0, 120)}`,
                });
              }
            }
          }
        } catch (err) {
          hotProfiles.add(profileId);
          logger.error({ device, keyword, profile: pname, err: String(err) }, "keyword scan failed — stopping profile");
          await ctx.mutex.run(() => ctx.captchaKeywords.push(`${device}:${keyword}:${pname}:error`));
          onProgress?.({
            type: "scan-progress",
            device,
            keyword,
            profileName: pname,
            message: `Profil hata ile durdu: ${pname} (${device})`,
            phase: "profile-error",
          });
          break;
        }
        const gapScale = persona.interQueryScale;
        await jitterDelay(
          Math.floor(config.scan.minDelayMs * gapScale),
          Math.floor(config.scan.maxDelayMs * gapScale)
        );
      }
      // Close only after all keywords (+ inline clicks) on this profile
      await closeState(state);
      onProgress?.({
        type: "scan-progress",
        device,
        profileName: pname,
        profileIndex: pi + 1,
        profileTotal: totalProfiles,
        message:
          remainingAfter > 0
            ? `Profil kapandı: ${pname} (${device}) · sırada ~${remainingAfter} profil daha`
            : `Son profil kapandı: ${pname} (${device}) · cihaz havuzu bitti`,
        phase: "profile-closed",
      });
      // Cool-down between profiles in the safe pool.
      await jitterDelay(config.scan.minDelayMs, config.scan.maxDelayMs);
    }
    onProgress?.({
      type: "scan-progress",
      device,
      message: `${device} cihaz taraması tamamlandı (${totalProfiles} profil denendi) — diğer cihazlar sürebilir`,
      phase: "device-done",
    });
    return;
  }

  // SHARED queue — each keyword once (old code copied full list per worker = double brand hits).
  const sharedQueue = [...keywords];
  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) {
    const state: WorkerState = { session: null, profileId: null, queriesOnProfile: 0 };

    workers.push(
      (async () => {
        // Short stagger only — long 0–30s delay looked like "stuck Preparing…".
        await sleep(w * 1500 + Math.floor(Math.random() * 1500));
        while (true) {
          if (swarmTarget) {
            await closeState(state);
            return;
          }
          const keyword = sharedQueue.shift();
          if (!keyword) break;

          // New profile session → trend warm first (never cold brand).
          if (!state.session || state.queriesOnProfile >= queriesPerProfile) {
            onProgress?.({
              type: "scan-progress",
              device,
              message: `Profil açılıyor + trend warm-up (${device})…`,
            });
            let ok = false;
            const profileOpenController = new AbortController();
            const profileOpenTimeout = setTimeout(() => {
              profileOpenController.abort(new Error("profile open timeout"));
            }, 90_000);
            try {
              ok = await withScanStepCap(openNext(state, profileOpenController.signal), "profile open", () => {
                state.timedOut = true;
              });
            } catch (err) {
              logger.warn({ device, worker: w, profileId: state.profileId, err: String(err) }, "openNext failed or aborted");
              ok = false;
            } finally {
              clearTimeout(profileOpenTimeout);
            }
            if (!ok) {
              logger.error({ device, worker: w }, "no working profile in pool — worker stopping");
              await closeState(state);
              return;
            }
          }

          onProgress?.({
            type: "scan-progress",
            device,
            keyword,
            profileId: state.profileId,
            message: `Trend OK → marka araması: ${keyword}`,
            remaining: sharedQueue.length,
          });

          let keywordDone = false;
          for (let ipTry = 1; ipTry <= keywordIpRetries && !keywordDone; ipTry++) {
            try {
              const proxy = state.profileId ? pool.proxies.get(state.profileId) : undefined;
              const res = await withScanStepCap(
                scanOneKeyword(ctx, state.session!, device, state.profileId!, keyword, proxy, onProgress),
                `keyword scan "${keyword}" (worker ${w})`
              );
              state.queriesOnProfile++;

              if (res.captcha) {
                if (state.profileId) hotProfiles.add(state.profileId);
                state.queriesOnProfile = queriesPerProfile;
                logger.warn(
                  { device, keyword, profileId: state.profileId, ipTry, max: keywordIpRetries },
                  "hard-block — retrying keyword on another IP"
                );
                // No sharedQueue.unshift here — the ipTry loop itself retries
                // this keyword on the fresh IP; requeueing would double-scan it.
                const ok = await withScanStepCap(openNext(state, signal), "profile reopen", () => {
                  state.timedOut = true;
                }).catch(() => false);
                if (!ok) {
                  await closeState(state);
                  return;
                }
                continue;
              }

              keywordDone = true;
              if (res.captchaSolved) {
                logger.info({ profileId: state.profileId, keyword }, "captcha solved mid-scan — continuing carefully");
              }

              // Swarm mode: first ad caught → all workers switch to this single target.
              if (res.adsFound > 0 && config.scan.firstAdSwarm && state.session && state.profileId) {
                const firstAd = res.ads.find((a) => a.adHref);
                if (firstAd && !swarmTarget) {
                  swarmTarget = { keyword, ad: firstAd };
                  logger.info(
                    { device, profileId: state.profileId, keyword, domain: firstAd.displayDomain },
                    "swarm: global target locked, all workers will attack this ad"
                  );
                  onProgress?.({
                    type: "scan-progress",
                    device,
                    keyword,
                    domain: firstAd.displayDomain,
                    scanId: ctx.scanId,
                    message: `Swarm hedefi kilitlendi · ${firstAd.displayDomain} · tüm profiller bu reklama odaklanacak`,
                    phase: "swarm-locked",
                    target: {
                      domain: firstAd.displayDomain,
                      titleHint: firstAd.title,
                      keywords: [keyword],
                      targetDevice: device,
                      impressions: [],
                    },
                  });
                }
              }

              // Same as protectPool: click while SERP still open.
              if (res.adsFound > 0 && config.scan.autoClickAfterScan && state.session && state.profileId) {
                const clickTargets = res.ads.filter((a) => a.adHref);
                if (clickTargets.length > 0) {
                  const pname = ctx.profileNames.get(state.profileId) || state.profileId;
                  const { clickAdsOnOpenSerpWithCap, InlineClickTimeoutError } = await import("./click/inlineClick.js");
                  try {
                    await clickAdsOnOpenSerpWithCap({
                      config,
                      session: state.session,
                      device,
                      profileId: state.profileId,
                      profileName: pname,
                      keyword,
                      ads: clickTargets,
                      outputDir: config.output.dir,
                      maxClicks: Math.min(5, clickTargets.length),
                      withReport: true,
                      operationId: `scan-${ctx.scanId}`,
                      captchaProxy: pool.proxies.get(state.profileId),
                      onProgress,
                    });
                  } catch (err) {
                    if (err instanceof InlineClickTimeoutError) {
                      // Wedged renderer/CDP. The keyword was already scanned
                      // (ads found, results inserted) — rescanning would only
                      // duplicate rows. Burn the profile and let the
                      // queriesOnProfile check at the top of the while loop
                      // close/reopen it.
                      logger.error({ device, keyword, profileId: state.profileId, err: String(err) }, "inline click WEDGED — burning profile, keyword kept as done");
                      onProgress?.({
                        type: "scan-progress",
                        device,
                        keyword,
                        phase: "inline-click-timeout",
                        message: "Inline tık kilitlendi · profil yenileniyor (keyword tamamlandı sayıldı)",
                      });
                      if (state.profileId) hotProfiles.add(state.profileId);
                      state.queriesOnProfile = queriesPerProfile;
                      keywordDone = true;
                      break;
                    }
                    logger.warn({ device, err: String(err) }, "inline click failed (shared queue)");
                  }
                }
              }
            } catch (err) {
              logger.error({ device, keyword, profileId: state.profileId, err: String(err) }, "keyword scan failed");
              if (state.profileId) hotProfiles.add(state.profileId);
              state.queriesOnProfile = queriesPerProfile;
              // No sharedQueue.unshift here — the ipTry loop handles retries;
              // requeueing caused duplicate rows and captcha ping-pong.
              const ok = await withScanStepCap(openNext(state, signal), "profile reopen", () => {
                state.timedOut = true;
              }).catch(() => false);
              if (!ok) {
                await closeState(state);
                return;
              }
            }
          }

          if (!keywordDone) {
            await ctx.mutex.run(() => ctx.captchaKeywords.push(`${device}:${keyword}`));
            logger.warn({ device, keyword }, "CAPTCHA wall — keyword skipped after IP retries");
          }

          const pname = state.profileId ? ctx.profileNames.get(state.profileId) || state.profileId : "gap";
          const gapScale = personaFor(pname).interQueryScale;
          await jitterDelay(
            Math.floor(config.scan.minDelayMs * gapScale),
            Math.floor(config.scan.maxDelayMs * gapScale)
          );
        }

        await closeState(state);
      })()
    );
  }

  await Promise.all(workers);
}

export async function runScan(
  config: AppConfig,
  keywords: string[],
  onProgress?: (event: Record<string, unknown>) => void,
  opts: RunScanOpts = {}
): Promise<ScanSummary> {
  const ads = new AdsPowerClient(config.adspower.baseUrl, config.adspower.apiKey, config.adspower.requestIntervalMs);
  if (!(await ads.isUp())) {
    throw new Error(`AdsPower Local API not reachable at ${config.adspower.baseUrl}. Is AdsPower running with the Local API enabled?`);
  }

  await syncFingerprints(ads, config);

  const store = new Store(config.output.dir);
  const orphanCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const closed = store.closeOrphanedScans(orphanCutoff);
  if (closed > 0) {
    logger.warn({ closed }, "closed orphaned scans");
  }

  const onlyProfileNames =
    opts.onlyProfileNames && opts.onlyProfileNames.length
      ? new Set(opts.onlyProfileNames.map((s) => s.trim()).filter(Boolean))
      : null;
  const protectPool = opts.protectPool ?? !!onlyProfileNames;

  const startedAt = new Date().toISOString();
  const scanId = store.createScan({
    startedAt,
    keywords,
    devices: config.devices,
    location: [config.location.city, config.location.country].filter(Boolean).join(", "),
    totalAds: 0,
  });
  logger.info(
    {
      scanId,
      keywords: keywords.length,
      devices: config.devices,
      rotate: config.scan.rotateProfiles,
      concurrency: config.scan.concurrency,
      onlyProfiles: onlyProfileNames ? onlyProfileNames.size : 0,
      protectPool,
    },
    "scan started"
  );

  const shotDir = resolve(config.output.dir, "screenshots", `scan-${scanId}`);
  if (config.scan.screenshots) mkdirSync(shotDir, { recursive: true });

  const ctx: ScanCtx = {
    store,
    scanId,
    config,
    shotDir,
    totalAds: 0,
    bettingAds: 0,
    byDevice: {},
    captchaKeywords: [],
    bettingHits: [],
    onlyProfileNames,
    protectPool,
    profileNames: new Map(),
    mutex: new AsyncMutex(),
  };

  // Split total concurrency across devices. Use remainder distribution so the
  // sum matches config.scan.concurrency and some devices may receive zero
  // workers if the user configured very low concurrency.
  const base = Math.floor(config.scan.concurrency / config.devices.length);
  let rem = config.scan.concurrency % config.devices.length;
  const deviceConcurrencies = config.devices.map(() => Math.max(0, base + (rem-- > 0 ? 1 : 0)));
  logger.info(
    {
      scanConcurrency: config.scan.concurrency,
      devices: config.devices,
      deviceConcurrencies,
      keywordCount: keywords.length,
    },
    "scan concurrency split across devices"
  );

  if (opts.signal?.aborted) {
    throw opts.signal.reason || new Error("scan aborted before start");
  }

  const scanTasks = config.devices.map((device, idx) =>
    runDeviceScan(ctx, ads, device, keywords, deviceConcurrencies[idx]!, onProgress, opts.signal)
  );

  // finishScan + store.close must happen even when the abort fires mid-scan.
  let reportPaths: { json?: string; csv?: string } = {};
  try {
    await Promise.all(scanTasks);
  } finally {
    try {
      const finishedAt = new Date().toISOString();
      store.finishScan(scanId, finishedAt, ctx.totalAds);
      reportPaths = exportScan(store, scanId, config.output.dir, { json: config.output.json, csv: config.output.csv });
    } catch (finErr) {
      logger.warn({ err: String(finErr) }, "finishScan after abort/failure failed");
    }
    store.close();
  }

  // Auto complaint pack: betting-flagged rows with screenshots for manual Google reporting.
  try {
    const pack = buildAdComplaintPack({ outputDir: config.output.dir, scanId, bettingOnly: true });
    if (pack.count > 0) {
      logger.info(
        { scanId, dir: pack.dir, count: pack.count },
        "Ad complaint pack generated after scan"
      );
      onProgress?.({
        type: "scan-progress",
        phase: "complaint-pack",
        scanId,
        count: pack.count,
        dir: pack.dir,
        message: `Şikâyet paketi hazır · ${pack.count} reklam · ${pack.dir}`,
      });
    } else {
      logger.info({ scanId }, "No betting ads — complaint pack skipped");
    }
  } catch (err) {
    logger.warn({ scanId, err: String(err) }, "Ad complaint pack after scan failed");
  }

  logger.info({ scanId, totalAds: ctx.totalAds, bettingAds: ctx.bettingAds }, "scan complete");
  return {
    scanId,
    totalAds: ctx.totalAds,
    bettingAds: ctx.bettingAds,
    byDevice: ctx.byDevice,
    captchaKeywords: ctx.captchaKeywords,
    bettingHits: ctx.bettingHits,
    reportPaths,
  };
}
