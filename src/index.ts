#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { expandBrandKeywords, loadKeywords } from "./util/keywords.js";
import { runScan } from "./scanner.js";
import { probeAllIps } from "./probeIps.js";
import { runRecoveryLoop, runRecoveryPass } from "./captcha/recovery.js";
import { AdsPowerClient } from "./adspower/client.js";
import { Store } from "./store/db.js";
import { IpTrustStore } from "./store/ipTrust.js";
import { exportScan } from "./store/report.js";
import { runClickEngine, buildEngineConfig } from "./click/engine.js";
import { ClickStore } from "./click/store.js";
import { exportClickRun } from "./click/report.js";
import { buildTargetsFromScan } from "./click/targets.js";
import { runFocusCampaign } from "./click/focusCampaign.js";
import { createWebServer } from "./web/server.js";
import type { Device } from "./types.js";
import type { ClickMode, ClickTarget, TargetDevice } from "./click/types.js";
import { logger } from "./logger.js";

// Fatal fingerprints: the service died once with exit 1 and ZERO output —
// unlogged unhandled rejections are invisible in the journal. Log first,
// then exit so systemd restarts us with evidence preserved.
process.on("unhandledRejection", (reason) => {
  try {
    logger.fatal({ err: String(reason), stack: reason instanceof Error ? reason.stack : undefined }, "FATAL: unhandledRejection — process exiting");
  } finally {
    process.exit(1);
  }
});
process.on("uncaughtException", (err) => {
  try {
    logger.fatal({ err: String(err), stack: err.stack }, "FATAL: uncaughtException — process exiting");
  } finally {
    process.exit(1);
  }
});

const program = new Command();
program.name("detect").description("Google SERP paid-ad scanner (Turkey, desktop + mobile) via AdsPower").version("0.1.0");

function resolveKeywordFile(explicit?: string): string {
  if (explicit) return resolve(process.cwd(), explicit);
  const candidates = ["keywords.txt", "keywords.example.txt"];
  for (const c of candidates) {
    const p = resolve(process.cwd(), c);
    if (existsSync(p)) return p;
  }
  throw new Error("No keyword file found. Pass --keywords <file> or create keywords.txt");
}

program
  .command("scan")
  .description("Scan keywords on Google Turkey and detect paid/sponsored ads")
  .option("-k, --keywords <file>", "keyword file (one query per line)")
  .option("-d, --devices <list>", "comma-separated devices: desktop,mobile")
  .option("--no-resolve", "do not follow ad redirect chains to the real landing site")
  .option("--no-screenshots", "do not capture SERP screenshots")
  .option("-l, --limit <n>", "only scan the first N keywords", (v) => parseInt(v, 10))
  .option("--expand-brands", "expand each brand keyword into variations (giriş, güncel giriş, ...)")
  .option("--concurrency <n>", "parallel profiles per device (default from config)", (v) => parseInt(v, 10))
  .option("--no-clear-profile", "do not clear cookies/cache/storage before each scan")
  .option(
    "--only-profiles <file>",
    "restrict to profile names listed in file (one per line) — use for safe clean-pool scans"
  )
  .option("--only-names <list>", "comma-separated profile names (same as --only-profiles)")
  .option("--protect-pool", "on captcha, do not retry keyword on other profiles in the pool (default when --only-*)")
  .action(
    async (opts: {
      keywords?: string;
      devices?: string;
      resolve: boolean;
      screenshots: boolean;
      limit?: number;
      expandBrands?: boolean;
      concurrency?: number;
      clearProfile?: boolean;
      onlyProfiles?: string;
      onlyNames?: string;
      protectPool?: boolean;
    }) => {
    const config = loadConfig();
    if (opts.devices) {
      config.devices = opts.devices
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s): s is Device => s === "desktop" || s === "mobile");
    }
    if (!opts.resolve) config.scan.resolveLandings = false;
    if (!opts.screenshots) config.scan.screenshots = false;
    if (opts.concurrency && opts.concurrency > 0) config.scan.concurrency = opts.concurrency;
    if (opts.clearProfile === false) config.scan.clearProfileData = false;

    let keywords = loadKeywords(resolveKeywordFile(opts.keywords));
    if (opts.expandBrands) {
      keywords = expandBrandKeywords(keywords);
    }
    if (opts.limit && opts.limit > 0) keywords = keywords.slice(0, opts.limit);
    if (keywords.length === 0) {
      console.error("No keywords to scan.");
      process.exitCode = 1;
      return;
    }

    const onlyProfileNames: string[] = [];
    if (opts.onlyNames) {
      onlyProfileNames.push(
        ...opts.onlyNames
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      );
    }
    if (opts.onlyProfiles) {
      const { readFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const raw = readFileSync(resolve(process.cwd(), opts.onlyProfiles), "utf8");
      onlyProfileNames.push(
        ...raw
          .split(/\r?\n/)
          .map((l) => l.replace(/#.*$/, "").trim())
          .filter(Boolean)
      );
    }

    if (!config.scan.rotateProfiles && onlyProfileNames.length === 0) {
      const missing = config.devices.filter((d) => !config.profiles[d]);
      if (missing.length === config.devices.length) {
        console.error(
          `No AdsPower profile configured for any requested device (${config.devices.join(", ")}).\n` +
            `Run "detect profiles" to list your profiles, then set PROFILE_DESKTOP / PROFILE_MOBILE in .env,\n` +
            `or enable scan.rotateProfiles in config/default.json to auto-rotate a pool by name prefix.`
        );
        process.exitCode = 1;
        return;
      }
    }

    if (onlyProfileNames.length) {
      console.log(`Safe pool: ${onlyProfileNames.length} profiles — ${onlyProfileNames.join(", ")}`);
    }

    const summary = await runScan(config, keywords, undefined, {
      onlyProfileNames: onlyProfileNames.length ? onlyProfileNames : undefined,
      protectPool: opts.protectPool || onlyProfileNames.length > 0,
    });

    console.log("\n" + "=".repeat(64));
    console.log(`Scan #${summary.scanId} complete`);
    console.log(`  keywords scanned : ${keywords.length} (${config.devices.join(", ")})`);
    console.log(`  ads detected     : ${summary.totalAds}`);
    console.log(`  betting (guess)  : ${summary.bettingAds}`);
    for (const [dev, n] of Object.entries(summary.byDevice)) console.log(`    ${dev.padEnd(8)}: ${n} ads`);
    if (summary.captchaKeywords.length) console.log(`  CAPTCHA-blocked  : ${summary.captchaKeywords.join(", ")}`);
    if (summary.reportPaths.csv) console.log(`  CSV report       : ${summary.reportPaths.csv}`);
    if (summary.reportPaths.json) console.log(`  JSON report      : ${summary.reportPaths.json}`);

    if (summary.bettingHits.length) {
      console.log("\nSuspected betting ads (display domain -> resolved destination):");
      for (const h of summary.bettingHits.slice(0, 40)) {
        console.log(`  [${h.device}] "${h.keyword}"  ${h.displayDomain}  ->  ${h.finalDomain ?? "(unresolved)"}`);
      }
    }

    if (summary.bettingHits.length && config.output.sqlite) {
      const store = new Store(config.output.dir);
      const targets = buildTargetsFromScan(store, summary.scanId);
      store.close();
      if (targets.length) {
        console.log("\nAuto-detected click targets:");
        for (const t of targets) {
          console.log(`  [${t.targetDevice}] ${t.domain}  keywords=[${t.keywords.join(", ")}]`);
        }
        console.log(`\nRun click with: detect click --from-scan ${summary.scanId}`);
      }
    }

    // CLI: auto focus campaign on SERP #1 ad (2h windows + rescan).
    if (config.scan.autoFocusCampaignAfterScan && summary.bettingAds > 0) {
      console.log("\n[auto-focus] Starting 2h focus campaign on top SERP ad…");
      try {
        const finalState = await runFocusCampaign({
          config,
          scanId: summary.scanId,
          windowMinutes: config.click.focusWindowMinutes,
          mode: config.click.mode,
          hooks: {
            onState: (s) => {
              if (s.status === "running") {
                console.log(`[focus] #${s.windowIndex} ${s.focusDomain} · ok=${s.completedClicks} · ${s.message}`);
              }
            },
          },
        });
        console.log(`[auto-focus] finished · status=${finalState.status} · ok=${finalState.completedClicks}`);
      } catch (err) {
        console.error("[auto-focus] failed:", String(err));
      }
    }

    console.log("=".repeat(64) + "\n");
  });

program
  .command("profiles")
  .description("List AdsPower profiles and groups (to find profile IDs for .env)")
  .option("-g, --group <id>", "filter by group id")
  .action(async (opts: { group?: string }) => {
    const config = loadConfig();
    const client = new AdsPowerClient(config.adspower.baseUrl, config.adspower.apiKey, config.adspower.requestIntervalMs);
    if (!(await client.isUp())) {
      console.error(`AdsPower Local API not reachable at ${config.adspower.baseUrl}.`);
      process.exitCode = 1;
      return;
    }

    try {
      const groups = await client.listGroups();
      console.log("\nGroups:");
      for (const g of groups) console.log(`  ${g.group_id.padEnd(10)} ${g.group_name}`);

      const profiles = await client.listProfiles(opts.group);
      console.log(`\nProfiles (${profiles.length}):`);
      console.log(`  ${"user_id".padEnd(12)} ${"name".padEnd(24)} ${"group".padEnd(16)} country`);
      for (const p of profiles) {
        console.log(`  ${String(p.user_id).padEnd(12)} ${(p.name || "").slice(0, 23).padEnd(24)} ${(p.group_name || "").slice(0, 15).padEnd(16)} ${p.ip_country ?? ""}`);
      }
      console.log('\nSet the desired IDs in .env:  PROFILE_DESKTOP=<user_id>   PROFILE_MOBILE=<user_id>\n');
    } catch (err) {
      console.error(`Failed to list profiles: ${String(err)}`);
      if (/require api-key|api key mismatch/i.test(String(err))) {
        console.error("Set ADSPOWER_API_KEY in .env (AdsPower -> Settings -> API).");
      }
      process.exitCode = 1;
    }
  });

program
  .command("report")
  .description("Re-export a scan's results to JSON + CSV")
  .option("-s, --scan <id>", "scan id (defaults to the latest scan)", (v) => parseInt(v, 10))
  .action(async (opts: { scan?: number }) => {
    const config = loadConfig();
    const store = new Store(config.output.dir);
    const scanId = opts.scan ?? store.latestScanId();
    if (!scanId) {
      console.error("No scans found in the database yet. Run a scan first.");
      store.close();
      process.exitCode = 1;
      return;
    }
    const paths = exportScan(store, scanId, config.output.dir, { json: true, csv: true });
    store.close();
    console.log(`Exported scan #${scanId}:`);
    if (paths.json) console.log(`  ${paths.json}`);
    if (paths.csv) console.log(`  ${paths.csv}`);
  });

program
  .command("report-google-ads")
  .description("Google Ads SERP competitive report (advertisers + inventory). Optional SendGrid.")
  .option("-s, --scan <id>", "limit to one scan id", (v) => parseInt(v, 10))
  .option("--from <iso>", "period start ISO")
  .option("--to <iso>", "period end ISO")
  .option("--email", "send via SendGrid (SENDGRID_API_KEY + REPORT_FROM + REPORT_TO)")
  .action(async (opts: { scan?: number; from?: string; to?: string; email?: boolean }) => {
    const config = loadConfig();
    const { publishGoogleAdsReport } = await import("./report/publishGoogleAds.js");
    try {
      const { report, files, emailed } = await publishGoogleAdsReport({
        config,
        scanId: opts.scan,
        from: opts.from,
        to: opts.to,
        email: !!opts.email,
      });
      console.log(report.summaryText);
      console.log("\nGoogle Ads report files:");
      console.log(`  ${files.dir}`);
      console.log(`  advertisers: ${report.advertisers.length}`);
      console.log(`  inventory  : ${report.inventory.length} ad impressions`);
      if (opts.email) console.log(emailed ? "  email: sent" : "  email: failed");
    } catch (err) {
      console.error(String(err));
      process.exitCode = 1;
    }
  });

program
  .command("report-complaints")
  .description("Google Ads şikâyet paketi: her reklam için SIKAYET.txt + screenshot (form için)")
  .option("-s, --scan <id>", "sadece bu scan", (v) => parseInt(v, 10))
  .option("--betting-only", "sadece is_betting=1 satırlar")
  .action(async (opts: { scan?: number; bettingOnly?: boolean }) => {
    const config = loadConfig();
    const { buildAdComplaintPack } = await import("./report/adComplaintPack.js");
    const pack = buildAdComplaintPack({
      outputDir: config.output.dir,
      scanId: opts.scan,
      bettingOnly: !!opts.bettingOnly,
    });
    console.log(`Şikâyet paketi: ${pack.count} reklam`);
    console.log(`  ${pack.dir}`);
    console.log(`  ${pack.indexCsv}`);
    console.log(`  ${pack.howToMd}`);
    console.log("\nGoogle'a otomatik gönderim yok — her klasördeki SIKAYET.txt + screenshot ile Report ad.");
    if (!pack.count) {
      console.error("Reklam yok. Önce tarama çalıştırın.");
      process.exitCode = 1;
    }
  });

program
  .command("recover-ips")
  .description(
    "Long-running private-ISP captcha recovery: vault + 2captcha + backoff (no manual step). Use --loop unattended."
  )
  .option("-l, --limit <n>", "max profiles per pass", (v) => parseInt(v, 10))
  .option("--soft-keyword <kw>", "neutral recovery keyword", "hava durumu")
  .option("--seed", "register all TR-ISP/TR-MOBILE profiles into the trust vault first")
  .option("--loop", "repeat forever with backoff between passes (production recovery daemon)")
  .option("--interval-min <n>", "minutes between loop passes (default 15)", (v) => parseInt(v, 10))
  .option("--max-passes <n>", "with --loop, stop after N passes (0=forever)", (v) => parseInt(v, 10))
  .option("--only <names>", "comma-separated profile names to force-recover")
  .option("--status", "print vault summary and exit")
  .action(
    async (opts: {
      limit?: number;
      softKeyword?: string;
      seed?: boolean;
      loop?: boolean;
      intervalMin?: number;
      maxPasses?: number;
      only?: string;
      status?: boolean;
    }) => {
      const config = loadConfig();
      if (opts.status) {
        const store = new Store(config.output.dir);
        const vault = new IpTrustStore(store.db);
        const sum = vault.summary();
        console.log("IP trust vault:", sum);
        for (const row of vault.list()) {
          console.log(
            `  ${row.name || row.profileId}  ${row.status}  fails=${row.consecutiveFails}  solves=${row.totalSolves}  next=${row.nextRetryAt ?? "-"}  cookies=${row.trustCookies.length}`
          );
        }
        store.close();
        return;
      }
      if (!config.captcha.capSolverApiKey && !config.captcha.twoCaptchaApiKey && !config.captcha.apiKey) {
        console.error("CAPSOLVER_API_KEY or TWOCAPTCHA_API_KEY missing — recover-ips needs a solver");
        process.exitCode = 1;
        return;
      }
      config.captcha.enabled = true;
      const onlyNames = opts.only
        ? opts.only
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      const passOpts = {
        limit: opts.limit,
        softKeyword: opts.softKeyword,
        seedFromAdsPower: !!opts.seed,
        onlyNames,
      };
      if (opts.loop) {
        await runRecoveryLoop(config, {
          ...passOpts,
          intervalMs: (opts.intervalMin && opts.intervalMin > 0 ? opts.intervalMin : 15) * 60_000,
          maxPasses: opts.maxPasses ?? 0,
        });
      } else {
        const report = await runRecoveryPass(config, passOpts);
        console.log("\n" + "=".repeat(64));
        console.log("IP recovery pass complete");
        console.log(`  attempted : ${report.attempted}`);
        console.log(`  clean     : ${report.clean}`);
        console.log(`  solved    : ${report.captcha_solved}`);
        console.log(`  hard      : ${report.captcha}`);
        console.log(`  error     : ${report.error}`);
        console.log(`  vault     : ${JSON.stringify(report.vault)}`);
      }
    }
  );

program
  .command("probe-ips")
  .description("Test TR-ISP/TR-MOBILE profiles with a real Google keyword (clean vs captcha; optional 2captcha solve)")
  .option("-k, --keywords <file>", "keyword file (cycled across profiles)", "keywords.txt")
  .option("-l, --limit <n>", "only probe first N profiles (debug)", (v) => parseInt(v, 10))
  .option("--solve", "enable 2captcha (proxy+cookies+data-s) to try clearing Google /sorry walls")
  .option("--from-probe <file>", "re-test only profiles that were captcha in a prior probe JSON")
  .option("--out-stem <name>", "output filename stem under data/ (default ip-captcha-bypass / ip-keyword-probe)")
  .option("--resume-from <file>", "skip profiles already present in this partial JSON")
  .option(
    "--soft-keyword <kw>",
    "when --solve, search this neutral keyword instead of brand names (easier captcha recovery)"
  )
  .action(
    async (opts: {
      keywords?: string;
      limit?: number;
      solve?: boolean;
      fromProbe?: string;
      outStem?: string;
      resumeFrom?: string;
      softKeyword?: string;
    }) => {
    const config = loadConfig();
    if (
      opts.solve &&
      !config.captcha.capSolverApiKey &&
      !config.captcha.twoCaptchaApiKey &&
      !config.captcha.apiKey
    ) {
      console.error("CAPSOLVER_API_KEY or TWOCAPTCHA_API_KEY missing in .env — cannot --solve");
      process.exitCode = 1;
      return;
    }
    const report = await probeAllIps(config, {
      keywordsFile: opts.keywords,
      limit: opts.limit,
      solve: !!opts.solve,
      fromProbeJson: opts.fromProbe,
      outStem: opts.outStem,
      resumeFrom: opts.resumeFrom,
      softKeyword: opts.softKeyword,
    });
    const pct = (n: number) => (report.total ? Math.round((100 * n) / report.total) : 0);
    console.log("\n" + "=".repeat(64));
    console.log(`IP keyword probe complete  (solve=${report.solveEnabled ? "ON" : "OFF"})`);
    console.log(`  total profiles : ${report.total}`);
    console.log(`  CLEAN (direct) : ${report.clean}  (${pct(report.clean)}%)`);
    console.log(`  CAPTCHA solved : ${report.captcha_solved}  (${pct(report.captcha_solved)}%)`);
    console.log(`  CAPTCHA hard   : ${report.captcha}  (${pct(report.captcha)}%)`);
    console.log(`  ERROR          : ${report.error}`);
    console.log(`  USABLE total   : ${report.usable}  (${pct(report.usable)}%)  = clean + solved`);
    for (const [dev, s] of Object.entries(report.byDevice)) {
      console.log(
        `  ${dev.padEnd(8)}: clean=${s.clean} solved=${s.captcha_solved} hard=${s.captcha} error=${s.error} (of ${s.total})`
      );
    }
    if (report.captcha_solved) {
      console.log("\nCleared via 2captcha:");
      for (const r of report.results.filter((x) => x.status === "captcha_solved")) {
        console.log(`  [${r.device}] ${r.name}  kw="${r.keyword}"  host=${r.proxyHost}`);
      }
    }
    if (report.captcha) {
      console.log("\nStill hard-blocked after probe:");
      for (const r of report.results.filter((x) => x.status === "captcha")) {
        console.log(`  [${r.device}] ${r.name}  kw="${r.keyword}"  host=${r.proxyHost}`);
      }
    }
    if (report.error) {
      console.log("\nProfiles with errors:");
      for (const r of report.results.filter((x) => x.status === "error")) {
        console.log(`  [${r.device}] ${r.name}  ${r.error.slice(0, 120)}`);
      }
    }
    console.log("=".repeat(64) + "\n");
  });

program
  .command("click")
  .description("Click targeted ads with AdsPower profiles (drain mode)")
  .option("--target-domain <domain>", "display domain of the ad to click (e.g. magicpixelvale.click)")
  .option("--from-scan <id>", "use click targets auto-detected from a previous scan", (v) => parseInt(v, 10))
  .option("--keywords <list>", "comma-separated keywords to search before clicking (manual mode)", "bahis")
  .option("--title-hint <text>", "optional title fragment to match the ad")
  .option("--device <device>", "force device pool: desktop, mobile, or both (manual mode)")
  .option("--mode <mode>", "conservative | adaptive | aggressive", "adaptive")
  .option("--duration <n>", "duration in minutes", (v) => parseInt(v, 10))
  .option("--clicks-per-profile <n>", "clicks per profile", (v) => parseInt(v, 10))
  .option("--concurrency <n>", "max parallel active profiles", (v) => parseInt(v, 10))
  .option("-l, --limit <n>", "only schedule N total clicks (for testing)", (v) => parseInt(v, 10))
  .option("--fallback-first-ad", "if target domain is not found, click the first sponsored ad")
  .option("--click-first-result", "if no ad matches, click the first organic SERP result")
  .action(
    async (opts: {
      targetDomain?: string;
      fromScan?: number;
      keywords: string;
      titleHint?: string;
      device?: string;
      mode: string;
      duration?: number;
      clicksPerProfile?: number;
      concurrency?: number;
      limit?: number;
      fallbackFirstAd?: boolean;
      clickFirstResult?: boolean;
    }) => {
      const config = loadConfig();
      const mode = (opts.mode as ClickMode) ?? config.click.mode;
      const engineConfig = buildEngineConfig(config, mode);
      if (opts.duration && opts.duration > 0) engineConfig.durationMinutes = opts.duration;
      if (opts.clicksPerProfile && opts.clicksPerProfile > 0) engineConfig.clicksPerProfile = opts.clicksPerProfile;
      if (opts.concurrency && opts.concurrency > 0) engineConfig.concurrency = opts.concurrency;

      let targets: ClickTarget[] = [];

      if (opts.fromScan) {
        const scanStore = new Store(config.output.dir);
        targets = buildTargetsFromScan(scanStore, opts.fromScan);
        scanStore.close();
        if (targets.length === 0) {
          console.error(`No betting ads found in scan #${opts.fromScan} to build click targets.`);
          process.exitCode = 1;
          return;
        }
        console.log(`Loaded ${targets.length} click target(s) from scan #${opts.fromScan}:`);
        for (const t of targets) {
          console.log(`  [${t.targetDevice}] ${t.domain}  keywords=[${t.keywords.join(", ")}]`);
        }
      } else if (opts.targetDomain) {
        let targetDevice: TargetDevice = "both";
        if (opts.device === "desktop") targetDevice = "desktop";
        if (opts.device === "mobile") targetDevice = "mobile";
        if (opts.device === "both") targetDevice = "both";

        targets = [
          {
            domain: opts.targetDomain,
            titleHint: opts.titleHint,
            keywords: opts.keywords.split(",").map((s) => s.trim()),
            targetDevice,
            clickFirstResult: opts.clickFirstResult,
          },
        ];
      } else {
        console.error("Either --target-domain <domain> or --from-scan <id> is required.");
        process.exitCode = 1;
        return;
      }

      console.log(`\nStarting multi-target click run for ${targets.length} target(s)`);
      console.log(`  mode: ${engineConfig.mode}`);
      console.log(`  concurrency: ${engineConfig.concurrency}`);
      console.log(`  clicks/profile: ${engineConfig.clicksPerProfile}`);
      console.log(`  duration: ${engineConfig.durationMinutes} min`);

      const summary = await runClickEngine({
        config,
        targets,
        engineConfig,
        outputDir: config.output.dir,
        limit: opts.limit,
        fallbackFirstAd: opts.fallbackFirstAd,
        clickFirstResult: opts.clickFirstResult,
      });

      const store = new ClickStore(config.output.dir);
      const reportPaths = exportClickRun(store, summary.runId, config.output.dir);
      store.close();

      console.log("\n" + "=".repeat(64));
      console.log(`Click run #${summary.runId} complete`);
      console.log(`  targets          : ${summary.targets.map((t) => `${t.domain} (${t.device})`).join(", ")}`);
      console.log(`  total jobs       : ${summary.totalJobs}`);
      console.log(`  successful       : ${summary.completedJobs}`);
      console.log(`  failed           : ${summary.failedJobs}`);
      console.log(`  captcha blocked  : ${summary.captchaJobs}`);
      console.log(`  skipped          : ${summary.skippedJobs}`);
      console.log(`  avg stay         : ${summary.avgStayMs} ms`);
      console.log(`  clicks/hour      : ${summary.clicksPerHour}`);
      for (const [dev, n] of Object.entries(summary.byDevice)) console.log(`    ${dev.padEnd(8)}: ${n} clicks`);
      if (reportPaths.json) console.log(`  JSON report      : ${reportPaths.json}`);
      if (reportPaths.csv) console.log(`  CSV report       : ${reportPaths.csv}`);
      console.log("=".repeat(64) + "\n");
    }
  );

program
  .command("click-report")
  .description("Re-export a click run to JSON + CSV")
  .option("-r, --run <id>", "click run id (defaults to latest)", (v) => parseInt(v, 10))
  .action(async (opts: { run?: number }) => {
    const config = loadConfig();
    const store = new ClickStore(config.output.dir);
    const runId = opts.run ?? store.latestRunId();
    if (!runId) {
      console.error("No click runs found. Run 'detect click' first.");
      store.close();
      process.exitCode = 1;
      return;
    }
    const paths = exportClickRun(store, runId, config.output.dir);
    store.close();
    console.log(`Exported click run #${runId}:`);
    if (paths.json) console.log(`  ${paths.json}`);
    if (paths.csv) console.log(`  ${paths.csv}`);
  });

program
  .command("web")
  .description("Launch the web management panel")
  .option("-p, --port <n>", "port to run the web panel on", (v) => parseInt(v, 10), 3000)
  .action(async (opts: { port: number }) => {
    loadConfig();
    createWebServer(opts.port);
  });

program
  .command("doctor")
  .description("Check AdsPower connectivity and configuration")
  .action(async () => {
    const config = loadConfig();
    const client = new AdsPowerClient(config.adspower.baseUrl, config.adspower.apiKey, config.adspower.requestIntervalMs);
    const up = await client.isUp();
    console.log(`AdsPower API (${config.adspower.baseUrl}): ${up ? "OK" : "UNREACHABLE"}`);
    console.log(`ADSPOWER_API_KEY set: ${config.adspower.apiKey ? "yes" : "no"}`);
    console.log(`PROFILE_DESKTOP: ${config.profiles.desktop ?? "(unset)"}`);
    console.log(`PROFILE_MOBILE : ${config.profiles.mobile ?? "(unset)"}`);
    console.log(
      `captcha solvers: enabled=${config.captcha.enabled} provider=${config.captcha.provider} capsolver=${config.captcha.capSolverApiKey ? "yes" : "no"} 2captcha=${config.captcha.twoCaptchaApiKey || config.captcha.apiKey ? "yes" : "no"}`
    );
    console.log(`Location: ${[config.location.city, config.location.country].filter(Boolean).join(", ")}  (hl=${config.google.hl}, gl=${config.google.gl})`);
    console.log(`Output dir: ${config.output.dir}`);
    if (up && config.adspower.apiKey) {
      try {
        const profiles = await client.listProfiles();
        console.log(`Profiles visible: ${profiles.length}`);
      } catch (err) {
        console.log(`Profile list failed: ${String(err)}`);
      }
    }
  });

program.parseAsync(process.argv).catch((err) => {
  logger.error({ err: String(err) }, "fatal");
  console.error(String(err));
  process.exit(1);
}).finally(async () => {
  const { closeEmailPools } = await import("./report/emailPool.js");
  closeEmailPools();
});
