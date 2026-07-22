import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "./config.js";
import { AdsPowerClient, captchaProxyFromProfile } from "./adspower/client.js";
import { BrowserSession } from "./browser/session.js";
import { buildSerpUrl, gotoSerp, prepareGoogleConsent, warmUp } from "./google/serp.js";
import { exportTrustCookies } from "./captcha/recovery.js";
import { Store } from "./store/db.js";
import { loadKeywords } from "./util/keywords.js";
import { logger } from "./logger.js";
import { sleep } from "./util/time.js";

export type ProbeStatus = "clean" | "captcha" | "captcha_solved" | "error";

export interface ProbeRow {
  name: string;
  user_id: string;
  device: "desktop" | "mobile";
  proxyHost: string;
  exitIp: string;
  keyword: string;
  status: ProbeStatus;
  finalUrl: string;
  error: string;
  ms: number;
}

export interface ProbeReport {
  checkedAt: string;
  total: number;
  clean: number;
  captcha: number;
  captcha_solved: number;
  error: number;
  /** clean + captcha_solved — usable for SERP after this probe */
  usable: number;
  byDevice: Record<string, { total: number; clean: number; captcha: number; captcha_solved: number; error: number }>;
  results: ProbeRow[];
  solveEnabled: boolean;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export interface ProbeOpts {
  keywordsFile?: string;
  outDir?: string;
  limit?: number;
  /** Enable 2captcha solve (default false = detect-only). */
  solve?: boolean;
  /**
   * Only probe these profile names (e.g. the 35 that previously hit captcha).
   * If set, only matching TR-ISP/TR-MOBILE profiles are tested.
   */
  onlyNames?: string[];
  /**
   * Load captcha-status profiles from a previous probe JSON and re-test only those.
   * Implies focusing on hard IPs; use with solve:true to try bypass.
   */
  fromProbeJson?: string;
  /** Output filename stem (default ip-keyword-probe or ip-captcha-bypass). */
  outStem?: string;
  /** Resume: skip profiles already present in this partial JSON (by name). */
  resumeFrom?: string;
  /**
   * When solving captcha walls, use this keyword instead of the betting brand.
   * Soft queries reduce re-challenge rate; IPs become usable once exemption is set.
   */
  softKeyword?: string;
}

/**
 * Open TR-ISP / TR-MOBILE profiles, run ONE real Google keyword search each.
 *
 * - solve:false → detect captcha wall only (raw IP quality)
 * - solve:true  → 2captcha ON + AdsPower SOCKS5 proxy forwarded to 2captcha
 */
export async function probeAllIps(config: AppConfig, opts: ProbeOpts = {}): Promise<ProbeReport> {
  const ads = new AdsPowerClient(config.adspower.baseUrl, config.adspower.apiKey, config.adspower.requestIntervalMs);
  if (!(await ads.isUp())) {
    throw new Error(`AdsPower Local API not reachable at ${config.adspower.baseUrl}`);
  }

  const solve = !!opts.solve;
  const trustDb = solve ? new Store(config.output.dir) : null;
  try {
  const vault = trustDb?.ipTrust ?? null;
  // Recovery: captcha wall always lands on google.com/sorry (co=google.com). Searching
  // google.com.tr first forces a cross-domain continue URL that often rejects valid tokens.
  // Use google.com for solve runs; hl/gl still force TR SERP locale.
  const probeConfig: AppConfig = {
    ...config,
    captcha: { ...config.captcha, enabled: solve },
    scan: { ...config.scan, screenshots: false, resolveLandings: false },
    google: {
      ...config.google,
      domain: solve ? "www.google.com" : config.google.domain,
    },
  };

  let keywords: string[];
  try {
    keywords = loadKeywords(opts.keywordsFile ?? resolve(process.cwd(), "keywords.txt"));
  } catch {
    keywords = ["hava durumu", "dolar kuru", "ucak bileti"];
  }
  if (!keywords.length) keywords = ["hava durumu"];

  // Preferred keyword per profile name (from prior probe), if any.
  const preferredKw = new Map<string, string>();
  let onlyNames = opts.onlyNames ? new Set(opts.onlyNames) : null;
  if (opts.fromProbeJson) {
    const prev = JSON.parse(readFileSync(resolve(opts.fromProbeJson), "utf8")) as ProbeReport;
    const captchaOnes = prev.results.filter((r) => r.status === "captcha");
    onlyNames = new Set(captchaOnes.map((r) => r.name));
    for (const r of captchaOnes) preferredKw.set(r.name, r.keyword);
    logger.info({ from: opts.fromProbeJson, n: onlyNames.size }, "loaded captcha profiles from prior probe");
  }

  const outDir = opts.outDir ?? config.output.dir;
  mkdirSync(outDir, { recursive: true });
  const stem = opts.outStem ?? (solve && onlyNames ? "ip-captcha-bypass" : "ip-keyword-probe");
  const jsonPath = resolve(outDir, `${stem}.json`);
  const csvPath = resolve(outDir, `${stem}.csv`);

  // Resume: keep already-done rows and skip those names.
  const results: ProbeRow[] = [];
  const doneNames = new Set<string>();
  if (opts.resumeFrom) {
    try {
      const partial = JSON.parse(readFileSync(resolve(opts.resumeFrom), "utf8")) as ProbeReport;
      for (const r of partial.results ?? []) {
        results.push(r);
        doneNames.add(r.name);
      }
      logger.info({ from: opts.resumeFrom, kept: doneNames.size }, "resumed prior probe rows");
    } catch (err) {
      logger.warn({ err: String(err) }, "resumeFrom unreadable — starting fresh");
    }
  }

  const all = await ads.listProfiles();
  let targets = all.filter((p) => /^(TR-ISP-|TR-MOBILE-)/.test(p.name ?? ""));
  if (onlyNames) {
    targets = targets.filter((p) => onlyNames!.has(p.name ?? ""));
  } else {
    const desktop = shuffle(targets.filter((p) => (p.name ?? "").startsWith("TR-ISP-")));
    const mobile = shuffle(targets.filter((p) => (p.name ?? "").startsWith("TR-MOBILE-")));
    targets = [...desktop, ...mobile];
  }
  if (doneNames.size) {
    targets = targets.filter((p) => !doneNames.has(p.name ?? p.user_id));
  }
  if (opts.limit && opts.limit > 0) targets = targets.slice(0, opts.limit);

  logger.info(
    { total: targets.length, alreadyDone: doneNames.size, keywords: keywords.length, solve, only: !!onlyNames },
    `IP keyword probe started (captcha solve ${solve ? "ON" : "OFF"})`
  );

  let kwIdx = 0;

  const writeProgress = () => {
    const byDevice: ProbeReport["byDevice"] = {
      desktop: { total: 0, clean: 0, captcha: 0, captcha_solved: 0, error: 0 },
      mobile: { total: 0, clean: 0, captcha: 0, captcha_solved: 0, error: 0 },
    };
    for (const r of results) {
      const b = byDevice[r.device]!;
      b.total++;
      b[r.status]++;
    }
    const clean = results.filter((r) => r.status === "clean").length;
    const captcha = results.filter((r) => r.status === "captcha").length;
    const captcha_solved = results.filter((r) => r.status === "captcha_solved").length;
    const error = results.filter((r) => r.status === "error").length;
    const report: ProbeReport = {
      checkedAt: new Date().toISOString(),
      total: results.length,
      clean,
      captcha,
      captcha_solved,
      error,
      usable: clean + captcha_solved,
      byDevice,
      results,
      solveEnabled: solve,
    };
    writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    const csv = [
      "name,device,status,keyword,proxyHost,exitIp,ms,finalUrl,error",
      ...results.map((r) =>
        [
          r.name,
          r.device,
          r.status,
          JSON.stringify(r.keyword),
          r.proxyHost,
          r.exitIp,
          r.ms,
          JSON.stringify(r.finalUrl),
          JSON.stringify(r.error),
        ].join(",")
      ),
    ].join("\n");
    writeFileSync(csvPath, csv);
    return report;
  };

  for (let i = 0; i < targets.length; i++) {
    const p = targets[i]!;
    const device: "desktop" | "mobile" = (p.name ?? "").startsWith("TR-MOBILE") ? "mobile" : "desktop";
    const px = captchaProxyFromProfile(p);
    const name = p.name ?? p.user_id;
    // Soft keyword while solving: establish GOOGLE_ABUSE_EXEMPTION without brand heat.
    const brandKw = preferredKw.get(name) ?? keywords[kwIdx % keywords.length]!;
    const keyword = solve && opts.softKeyword ? opts.softKeyword : brandKw;
    kwIdx++;
    const row: ProbeRow = {
      name,
      user_id: p.user_id,
      device,
      proxyHost: p.user_proxy_config?.proxy_host ?? "",
      exitIp: p.ip ?? px?.exitIp ?? "",
      keyword,
      status: "error",
      finalUrl: "",
      error: "",
      ms: 0,
    };

    const t0 = Date.now();
    let session: BrowserSession | null = null;
    try {
      // Fresh browser process, but KEEP profile cookies on disk.
      // clearProfileData here would wipe GOOGLE_ABUSE_EXEMPTION and force a new /sorry
      // every recovery run — private ISP IPs would never "stay saved".
      if (solve) {
        await ads.stopBrowser(p.user_id).catch(() => {});
        await sleep(800);
      }
      const ws = await ads.ensureBrowser(p.user_id);
      session = await BrowserSession.attach(ws);
      await prepareGoogleConsent(session);
      if (device === "mobile") {
        const { applyMobileEmulation } = await import("./browser/mobileEmulation.js");
        await applyMobileEmulation(session.page);
      }
      const captchaOpts = {
        captchaProxy: px ? { proxy: px.proxy, proxytype: px.proxytype } : undefined,
      };
      // Home only. softSearch:false — if --soft-keyword is already the main query we must
      // not burn a second challenge in warmUp (that doubled fails on hard IPs).
      await warmUp(session, probeConfig, { ...captchaOpts, softSearch: false });

      const url = buildSerpUrl(probeConfig, keyword);
      const nav = await gotoSerp(session, url, probeConfig, captchaOpts);
      row.finalUrl = nav.finalUrl;
      row.ms = Date.now() - t0;

      // Strict: captcha_solved only if final URL is real SERP (not /sorry).
      const finalIsSorry = /\/sorry\//i.test(nav.finalUrl);
      if (nav.captcha || (nav.captchaSolved && finalIsSorry)) {
        row.status = "captcha";
        if (nav.captchaSolved && finalIsSorry) {
          logger.warn(
            { i: i + 1, n: targets.length, profile: row.name },
            "REJECTED false captcha_solved (finalUrl still /sorry)"
          );
        } else {
          logger.warn({ i: i + 1, n: targets.length, profile: row.name, device, keyword, solve }, "CAPTCHA wall (unsolved)");
        }
        if (vault) {
          vault.upsertMeta({ profileId: p.user_id, name, device, proxyHost: row.proxyHost });
          vault.markHardCaptcha(p.user_id, "probe hard captcha");
        }
      } else if (nav.captchaSolved) {
        row.status = "captcha_solved";
        logger.info(
          { i: i + 1, n: targets.length, profile: row.name, device, keyword, ms: row.ms },
          "CAPTCHA solved → SERP"
        );
        if (vault) {
          vault.upsertMeta({ profileId: p.user_id, name, device, proxyHost: row.proxyHost });
          const cookies = await exportTrustCookies(session);
          vault.markSolved(p.user_id, cookies);
        }
      } else {
        row.status = "clean";
        logger.info({ i: i + 1, n: targets.length, profile: row.name, device, keyword, ms: row.ms }, "CLEAN serp");
        if (vault) {
          vault.upsertMeta({ profileId: p.user_id, name, device, proxyHost: row.proxyHost });
          const cookies = await exportTrustCookies(session);
          vault.markClean(p.user_id, cookies);
        }
      }
    } catch (err) {
      row.ms = Date.now() - t0;
      row.status = "error";
      row.error = String(err).slice(0, 300);
      logger.warn({ i: i + 1, n: targets.length, profile: row.name, err: row.error }, "probe error");
    } finally {
      const { gracefulProfileShutdown } = await import("./browser/shutdown.js");
      await gracefulProfileShutdown(ads, session, p.user_id);
      session = null;
    }

    results.push(row);
    const progress = writeProgress();
    console.log(
      `[${results.length}] ${row.name} → ${row.status} | usable=${progress.usable} hard=${progress.captcha} err=${progress.error} (${row.ms}ms)`
    );
    // Slightly longer gap between private IPs during solve recovery.
    await sleep(solve ? 2000 : 800);
  }

  const report = writeProgress();
  logger.info({ jsonPath, csvPath, ...report, results: undefined }, "IP keyword probe complete");
  console.log(`\nProbe report: ${jsonPath}`);
  console.log(`CSV:          ${csvPath}`);
  return report;
  } finally {
    trustDb?.close();
  }
}
