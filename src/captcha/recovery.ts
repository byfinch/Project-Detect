import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "../config.js";
import { PROJECT_ROOT } from "../config.js";
import { AdsPowerClient, captchaProxyFromProfile, type ProfileSummary } from "../adspower/client.js";
import { BrowserSession } from "../browser/session.js";
import { prepareGoogleConsent, recoverViaTrendClick } from "../google/serp.js";
import { Store } from "../store/db.js";
import { IpTrustStore, type TrustCookie } from "../store/ipTrust.js";
import { logger } from "../logger.js";
import { sleep } from "../util/time.js";

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
