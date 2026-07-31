import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "../config.js";
import { PROJECT_ROOT } from "../config.js";
import { AdsPowerClient, captchaProxyFromProfile, type ProfileSummary } from "../adspower/client.js";
import { BrowserSession } from "../browser/session.js";
import { buildSerpUrl, gotoSerp, prepareGoogleConsent, recoverViaTrendClick } from "../google/serp.js";
import { Store } from "../store/db.js";
import { IpTrustStore, type TrustCookie } from "../store/ipTrust.js";
import { logger } from "../logger.js";
import { jitterDelay, sleep } from "../util/time.js";

const SOFT_KEYWORD = "hava durumu";

/** Never thrash / recover these — proven clean pool (data/PROTECT-PROFILES.txt). */
export function loadProtectedProfileNames(): Set<string> {
  const paths = [
    resolve(PROJECT_ROOT, "data", "PROTECT-PROFILES.txt"),
    resolve(process.cwd(), "data", "PROTECT-PROFILES.txt"),
  ];
  const out = new Set<string>();
  for (const p of paths) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      out.add(t);
    }
    break;
  }
  return out;
}

const TRUST_NAME_RE =
  /^(GOOGLE_ABUSE_EXEMPTION|NID|__Secure-ENID|AEC|SID|HSID|SSID|APISID|SAPISID|__Secure-1PSID|__Secure-3PSID|__Secure-1PAPISID|__Secure-3PAPISID|CONSENT|SOCS)$/i;

export async function exportTrustCookies(session: BrowserSession): Promise<TrustCookie[]> {
  const all = await session.exportGoogleCookies();
  return all
    .filter((c) => TRUST_NAME_RE.test(c.name))
    .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || "/" }));
}

export async function restoreTrustCookies(session: BrowserSession, cookies: TrustCookie[]): Promise<void> {
  if (!cookies.length) return;
  await session.importGoogleCookies(cookies);
  logger.info({ n: cookies.length }, "restored trust cookies from vault");
}

export interface RecoveryPassOpts {
  /** Max profiles to attempt this pass. */
  limit?: number;
  /** Soft keyword used for recovery SERP (default: hava durumu). */
  softKeyword?: string;
  /** Only these profile names (optional). */
  onlyNames?: string[];
  /** If set, also register all TR-ISP/TR-MOBILE profiles into the vault first. */
  seedFromAdsPower?: boolean;
}

export interface RecoveryAttemptResult {
  profileId: string;
  name: string;
  status: "clean" | "captcha_solved" | "captcha" | "error";
  finalUrl: string;
  ms: number;
  error: string;
}

export interface RecoveryPassReport {
  checkedAt: string;
  attempted: number;
  clean: number;
  captcha_solved: number;
  captcha: number;
  error: number;
  vault: Record<string, number>;
  results: RecoveryAttemptResult[];
}

/**
 * One automated recovery pass over private ISP profiles that hit /sorry.
 *
 * This is the long-lived loop body: no human steps. Failed IPs get backoff and
 * are retried on later passes until usable again.
 */
export async function runRecoveryPass(config: AppConfig, opts: RecoveryPassOpts = {}): Promise<RecoveryPassReport> {
  if (
    !config.captcha.enabled ||
    !(config.captcha.capSolverApiKey || config.captcha.twoCaptchaApiKey || config.captcha.apiKey)
  ) {
    throw new Error("Captcha recovery requires captcha.enabled + CAPSOLVER_API_KEY or TWOCAPTCHA_API_KEY");
  }

  const store = new Store(config.output.dir);
  const vault = new IpTrustStore(store.db);
  const ads = new AdsPowerClient(config.adspower.baseUrl, config.adspower.apiKey, config.adspower.requestIntervalMs);
  if (!(await ads.isUp())) {
    store.close();
    throw new Error(`AdsPower Local API not reachable at ${config.adspower.baseUrl}`);
  }

  const allProfiles = await (async () => {
    try {
      return await ads.listProfiles();
    } catch (err) {
      store.close();
      throw err;
    }
  })();
  const byId = new Map(allProfiles.map((p) => [p.user_id, p]));
  const byName = new Map(allProfiles.map((p) => [p.name ?? p.user_id, p]));

  try {
  if (opts.seedFromAdsPower) {
    for (const p of allProfiles) {
      if (!/^(TR-ISP-|TR-MOBILE-)/.test(p.name ?? "")) continue;
      const device = (p.name ?? "").startsWith("TR-MOBILE") ? "mobile" : "desktop";
      vault.upsertMeta({
        profileId: p.user_id,
        name: p.name ?? p.user_id,
        device,
        proxyHost: p.user_proxy_config?.proxy_host ?? "",
      });
    }
  }

  // Build work list: due vault rows, or onlyNames force list.
  let work: ProfileSummary[] = [];
  if (opts.onlyNames?.length) {
    for (const n of opts.onlyNames) {
      const p = byName.get(n);
      if (p) work.push(p);
    }
  } else {
    const due = vault.listDueForRecovery();
    for (const row of due) {
      const p = byId.get(row.profileId) ?? byName.get(row.name);
      if (p) work.push(p);
    }
  }

  // Dedupe
  const seen = new Set<string>();
  work = work.filter((p) => {
    if (seen.has(p.user_id)) return false;
    seen.add(p.user_id);
    return true;
  });

  // HARD RULE: never thrash protected clean pool in bulk recovery.
  // Explicit --only names may include protect for a one-shot trend check (user-requested).
  const protectedNames = loadProtectedProfileNames();
  if (protectedNames.size && !opts.onlyNames?.length) {
    const before = work.length;
    work = work.filter((p) => !protectedNames.has(p.name ?? "") && !protectedNames.has(p.user_id));
    const skipped = before - work.length;
    if (skipped > 0) {
      logger.info({ skipped, protected: protectedNames.size }, "recovery skipped PROTECT-PROFILES (do not burn clean pool)");
    }
  } else if (protectedNames.size && opts.onlyNames?.length) {
    const protectInWork = work.filter((p) => protectedNames.has(p.name ?? "") || protectedNames.has(p.user_id));
    if (protectInWork.length) {
      logger.info(
        { n: protectInWork.length, names: protectInWork.map((p) => p.name) },
        "recovery: explicit --only includes PROTECT profiles (gentle trend check only)"
      );
    }
  }

  if (opts.limit && opts.limit > 0) work = work.slice(0, opts.limit);

  const soft = opts.softKeyword?.trim() || SOFT_KEYWORD;
  const recoverConfig: AppConfig = {
    ...config,
    captcha: { ...config.captcha, enabled: true },
    google: { ...config.google, domain: "www.google.com" },
    scan: { ...config.scan, screenshots: false, resolveLandings: false },
  };

  logger.info({ n: work.length, soft }, "IP recovery pass started");

  const results: RecoveryAttemptResult[] = [];

  for (let i = 0; i < work.length; i++) {
    const p = work[i]!;
    const name = p.name ?? p.user_id;
    const device = name.startsWith("TR-MOBILE") ? "mobile" : "desktop";
    const px = captchaProxyFromProfile(p);
    vault.upsertMeta({
      profileId: p.user_id,
      name,
      device,
      proxyHost: p.user_proxy_config?.proxy_host ?? "",
    });
    vault.markRecovering(p.user_id);

    const row: RecoveryAttemptResult = {
      profileId: p.user_id,
      name,
      status: "error",
      finalUrl: "",
      ms: 0,
      error: "",
    };
    const t0 = Date.now();
    let session: BrowserSession | null = null;

    try {
      await ads.stopBrowser(p.user_id).catch(() => {});
      await sleep(600);
      const ws = await ads.ensureBrowser(p.user_id);
      session = await BrowserSession.attach(ws);

      // Vault first — durable across days, not "hope AdsPower still has it".
      const trust = vault.get(p.user_id);
      if (trust?.trustCookies?.length) {
        await restoreTrustCookies(session, trust.trustCookies);
      }

      await prepareGoogleConsent(session);
      if (device === "mobile") {
        // Full phone stack: viewport + touch + Mobile UA (viewport alone = desktop Google).
        const { applyMobileEmulation } = await import("../browser/mobileEmulation.js");
        await applyMobileEmulation(session.page);
      }

      const captchaOpts = {
        captchaProxy: px ? { proxy: px.proxy, proxytype: px.proxytype } : undefined,
      };

      // HUMAN PATH (proven): Google home → click "Trend olan aramalar" item → solve /sorry if shown.
      // Do NOT goto /search?q=hava+durumu — that bot path loops / fails more often.
      const nav = await recoverViaTrendClick(session, recoverConfig, captchaOpts);
      row.finalUrl = nav.finalUrl;
      row.ms = Date.now() - t0;

      const cookies = await exportTrustCookies(session);
      const finalSorry = /\/sorry\//i.test(nav.finalUrl);

      if (nav.captchaSolved && !finalSorry) {
        row.status = "captcha_solved";
        vault.markSolved(p.user_id, cookies);
        logger.info({ i: i + 1, n: work.length, name, ms: row.ms, trend: nav.trend }, "RECOVERY solved via trend-click → usable");
      } else if (!nav.captcha && !finalSorry) {
        row.status = "clean";
        vault.markClean(p.user_id, cookies);
        logger.info({ i: i + 1, n: work.length, name, ms: row.ms, trend: nav.trend }, "RECOVERY clean via trend-click → usable");
      } else {
        row.status = "captcha";
        vault.markHardCaptcha(p.user_id, "still /sorry after trend-click solve");
        logger.warn(
          { i: i + 1, n: work.length, name, ms: row.ms, trend: nav.trend },
          "RECOVERY hard captcha after trend-click — backoff"
        );
      }
    } catch (err) {
      row.ms = Date.now() - t0;
      row.status = "error";
      row.error = String(err).slice(0, 300);
      vault.markHardCaptcha(p.user_id, row.error);
      logger.warn({ i: i + 1, n: work.length, name, err: row.error }, "RECOVERY error");
    } finally {
      const { gracefulProfileShutdown } = await import("../browser/shutdown.js");
      await gracefulProfileShutdown(ads, session, p.user_id);
      session = null;
    }

    results.push(row);
    console.log(
      `[${results.length}/${work.length}] ${name} → ${row.status} (${row.ms}ms)` +
        (row.error ? ` err=${row.error.slice(0, 80)}` : "")
    );
    await sleep(2000);
  }

  const report: RecoveryPassReport = {
    checkedAt: new Date().toISOString(),
    attempted: results.length,
    clean: results.filter((r) => r.status === "clean").length,
    captcha_solved: results.filter((r) => r.status === "captcha_solved").length,
    captcha: results.filter((r) => r.status === "captcha").length,
    error: results.filter((r) => r.status === "error").length,
    vault: vault.summary(),
    results,
  };

  logger.info({ ...report, results: undefined }, "IP recovery pass complete");
  return report;
  } finally {
    store.close();
  }
}

/**
 * Continuous recovery daemon: run passes until no due work, sleep, repeat.
 * Designed to run unattended (hours/days), not a 2-hour band-aid.
 */
export async function runRecoveryLoop(
  config: AppConfig,
  opts: RecoveryPassOpts & { intervalMs?: number; maxPasses?: number } = {}
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 15 * 60_000;
  const maxPasses = opts.maxPasses ?? 0; // 0 = forever
  let pass = 0;
  while (maxPasses === 0 || pass < maxPasses) {
    pass += 1;
    logger.info({ pass, intervalMs }, "recovery loop pass");
    const report = await runRecoveryPass(config, { ...opts, seedFromAdsPower: pass === 1 || opts.seedFromAdsPower });
    console.log(
      `\nPass #${pass}: attempted=${report.attempted} clean=${report.clean} solved=${report.captcha_solved} hard=${report.captcha} err=${report.error}`
    );
    console.log(`Vault: ${JSON.stringify(report.vault)}`);
    if (report.attempted === 0) {
      console.log(`No profiles due — sleeping ${Math.round(intervalMs / 60000)}m until next check…`);
    } else {
      console.log(`Sleeping ${Math.round(intervalMs / 60000)}m before next recovery pass…`);
    }
    await sleep(intervalMs);
  }
}

/* --------------------------------------------------------------------------
 * Interest pilot: light betting-neighbour browsing for a few pilot profiles,
 * a couple of times a week. Goal: Google's ad personalisation keeps serving
 * betting ads to these profiles, so scans see them more consistently.
 * HARD limits: <= 2 searches per profile per run, interestPilotMaxQueriesPerDay
 * daily ceiling, never runs the captcha solver (skipSolve) — the wall just
 * ends that profile's turn.
 * ------------------------------------------------------------------------ */

const INTEREST_PILOT_STATE_FILE = "interest-pilot.json";
const FALLBACK_INTEREST_KEYWORDS = ["spor bahisleri", "canlı skor", "maç sonuçları"];

export interface InterestPilotProfileResult {
  name: string;
  profileId: string;
  queries: string[];
  organicVisits: number;
  status: "ok" | "captcha" | "error" | "skipped";
  error?: string;
}

export interface InterestPilotReport {
  startedAt: string;
  finishedAt: string;
  profiles: InterestPilotProfileResult[];
}

export interface InterestPilotState {
  lastRun: InterestPilotReport | null;
  /** day (YYYY-MM-DD) → profile name → Google queries used. */
  daily: Record<string, Record<string, number>>;
}

function interestPilotStatePath(outputDir: string): string {
  return resolve(outputDir, INTEREST_PILOT_STATE_FILE);
}

export function readInterestPilotState(outputDir: string): InterestPilotState {
  try {
    const raw = JSON.parse(readFileSync(interestPilotStatePath(outputDir), "utf8")) as Partial<InterestPilotState>;
    return { lastRun: raw.lastRun ?? null, daily: raw.daily ?? {} };
  } catch {
    return { lastRun: null, daily: {} };
  }
}

/**
 * One light interest-feeding round over the configured pilot profiles
 * (config.interestPilotProfiles — empty list = feature off). Sequential and
 * gentle: open profile → 1-2 betting-neighbour searches → 1-2 organic result
 * visits → close. State (last run + daily counters) persists to
 * data/interest-pilot.json and backs GET /api/interest/status.
 */
export async function runInterestPilotPass(config: AppConfig): Promise<InterestPilotReport> {
  const report: InterestPilotReport = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    profiles: [],
  };
  const pilotNames = config.interestPilotProfiles ?? [];
  if (pilotNames.length === 0) {
    report.finishedAt = new Date().toISOString();
    return report;
  }

  const ads = new AdsPowerClient(config.adspower.baseUrl, config.adspower.apiKey, config.adspower.requestIntervalMs);
  if (!(await ads.isUp())) {
    throw new Error(`AdsPower Local API not reachable at ${config.adspower.baseUrl}`);
  }

  const store = new Store(config.output.dir);
  const vault = new IpTrustStore(store.db);
  try {
    const state = readInterestPilotState(config.output.dir);
    const today = new Date().toISOString().slice(0, 10);
    const dailyToday = (state.daily[today] ??= {});
    const dailyCap = Math.max(1, config.interestPilotMaxQueriesPerDay ?? 5);
    const keywordPool =
      config.interestPilotKeywords?.length > 0 ? config.interestPilotKeywords : FALLBACK_INTEREST_KEYWORDS;

    const allProfiles = await ads.listProfiles();
    const byName = new Map(allProfiles.map((p) => [p.name ?? p.user_id, p]));

    logger.info({ pilots: pilotNames.length, dailyCap }, "interest pilot pass started");

    for (const name of pilotNames) {
      const p = byName.get(name);
      const result: InterestPilotProfileResult = {
        name,
        profileId: p?.user_id ?? "",
        queries: [],
        organicVisits: 0,
        status: "skipped",
      };
      report.profiles.push(result);

      if (!p) {
        result.error = "profile not found in AdsPower";
        logger.warn({ name }, "interest pilot: profile not found — skipped");
        continue;
      }
      result.profileId = p.user_id;

      const usedToday = dailyToday[name] ?? 0;
      if (usedToday >= dailyCap) {
        result.error = `daily query cap reached (${usedToday}/${dailyCap})`;
        continue;
      }

      // 1-2 searches this run, never past the daily ceiling.
      const searchesThisRun = Math.min(1 + Math.floor(Math.random() * 2), dailyCap - usedToday);
      const picked = [...keywordPool].sort(() => Math.random() - 0.5).slice(0, searchesThisRun);
      const device = name.startsWith(config.scan.mobileProfilePrefix) ? "mobile" : "desktop";

      let session: BrowserSession | null = null;
      try {
        await ads.stopBrowser(p.user_id).catch(() => {});
        await sleep(600);
        const ws = await ads.ensureBrowser(p.user_id);
        session = await BrowserSession.attach(ws);

        const trust = vault.get(p.user_id);
        if (trust?.trustCookies?.length) {
          await restoreTrustCookies(session, trust.trustCookies);
        }
        await prepareGoogleConsent(session);
        if (device === "mobile") {
          const { applyMobileEmulation } = await import("../browser/mobileEmulation.js");
          await applyMobileEmulation(session.page);
        }

        for (const kw of picked) {
          // skipSolve: a wall ends this profile's turn — the pilot must never
          // burn the solver budget on vanity queries.
          const nav = await gotoSerp(session, buildSerpUrl(config, kw), config, {
            profileId: p.user_id,
            skipSolve: true,
          });
          result.queries.push(kw);
          dailyToday[name] = (dailyToday[name] ?? 0) + 1;
          if (nav.captcha) {
            result.status = "captcha";
            logger.warn({ name, keyword: kw }, "interest pilot: captcha wall — profile turn ends (no solve)");
            break;
          }

          // 1-2 organic result visits (never ad links) — light browsing signal.
          const links = await session.page
            .evaluate(() => {
              const out: string[] = [];
              for (const h of Array.from(document.querySelectorAll("#search h3"))) {
                const a = h.closest("a");
                const href = a?.href ?? "";
                if (href && /^https?:/.test(href) && !/google\.[a-z.]+/i.test(href)) out.push(href);
                if (out.length >= 5) break;
              }
              return out;
            })
            .catch(() => [] as string[]);
          const visits = Math.min(links.length, 1 + Math.floor(Math.random() * 2));
          for (let v = 0; v < visits; v++) {
            try {
              await session.page.goto(links[v]!, { timeout: 20_000, waitUntil: "domcontentloaded" });
              result.organicVisits++;
              await sleep(5_000 + Math.random() * 5_000);
            } catch {
              /* organic visit failed — ignore */
            }
          }
          await jitterDelay(4_000, 9_000);
        }

        if (result.status !== "captcha") result.status = "ok";
        try {
          const cookies = await exportTrustCookies(session);
          vault.markClean(p.user_id, cookies);
        } catch {
          /* non-fatal */
        }
        logger.info(
          { name, queries: result.queries, organicVisits: result.organicVisits, status: result.status },
          "interest pilot: profile round done"
        );
      } catch (err) {
        result.status = "error";
        result.error = String(err).slice(0, 300);
        logger.warn({ name, err: result.error }, "interest pilot: profile round failed");
      } finally {
        const { gracefulProfileShutdown } = await import("../browser/shutdown.js");
        await gracefulProfileShutdown(ads, session, p.user_id).catch(() => {});
        session = null;
      }
      await sleep(3_000 + Math.random() * 4_000);
    }

    report.finishedAt = new Date().toISOString();
    state.lastRun = report;
    // Prune daily counters older than 7 days.
    const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    for (const day of Object.keys(state.daily)) {
      if (day < cutoff) delete state.daily[day];
    }
    writeFileSync(interestPilotStatePath(config.output.dir), JSON.stringify(state, null, 2));
    logger.info(
      { profiles: report.profiles.length, ok: report.profiles.filter((r) => r.status === "ok").length },
      "interest pilot pass complete"
    );
    return report;
  } finally {
    store.close();
  }
}
