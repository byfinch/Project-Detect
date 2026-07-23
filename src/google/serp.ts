import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "playwright-core";
import type { AppConfig } from "../config.js";
import type { BrowserSession } from "../browser/session.js";
import { uuleForLocation } from "./uule.js";
import { solveRecaptchaMulti, solveImageCaptcha, reportIncorrect } from "../captcha/solver.js";
import { logger } from "../logger.js";
import { sleep } from "../util/time.js";

const CONSENT_ACCEPT_LABELS = ["Tümünü kabul et", "Tümünü Kabul Et", "Kabul et", "Accept all", "Alle akzeptieren", "Kabul Et"];

/**
 * Private ISP recovery: if a human can clear /sorry, the solver path must keep trying.
 * Each reCAPTCHA try needs a FRESH data-s (never reuse challenge after fail).
 * Previous fail-fast (2 tries) marked profiles "captcha" while manual still worked — wrong.
 */
const RECAPTCHA_MAX_ATTEMPTS = 6;
/** Prefer reCAPTCHA; OCR is backup. */
const IMAGE_MAX_ATTEMPTS = 2;
/** 2captcha guide: wait after token submit for Google to process. */
const POST_TOKEN_SETTLE_MS = 10_000;
/** While waiting on solver, nudge so AdsPower/CDP does not idle-close. */
const KEEPALIVE_INTERVAL_MS = 10_000;
/** CapSolver is usually faster; allow headroom for 2captcha + SOCKS. */
const RECAPTCHA_SOLVE_TIMEOUT_MS = 150_000;
/**
 * Google data-s ages hard. Submitting a 100s+ token almost always leaves /sorry.
 * Discard and re-challenge instead of reportbad (worker may have been correct, token was stale).
 */
const DATA_S_MAX_WAIT_MS = 90_000;

export interface SerpNavResult {
  captcha: boolean;
  captchaSolved: boolean;
  finalUrl: string;
}

/** Optional browser proxy so 2captcha workers solve from the same IP as the profile. */
export interface SerpNavOptions {
  captchaProxy?: {
    proxy: string;
    proxytype: "HTTP" | "HTTPS" | "SOCKS4" | "SOCKS5";
  };
  /** AdsPower profile id — feeds the captcha policy gates (budget/attempts). */
  profileId?: string;
}

export function buildSerpUrl(config: AppConfig, keyword: string, start = 0): string {
  const u = new URL(`https://${config.google.domain}/search`);
  u.searchParams.set("q", keyword);
  u.searchParams.set("hl", config.google.hl);
  u.searchParams.set("gl", config.google.gl);
  u.searchParams.set("nfpr", "1");
  u.searchParams.set("filter", "0");
  u.searchParams.set("ie", "UTF-8");
  u.searchParams.set("oe", "UTF-8");
  // Personalisation off + consistent ad auction inputs across profiles.
  if (!("pws" in config.google.extraParams)) u.searchParams.set("pws", "0");
  for (const [k, v] of Object.entries(config.google.extraParams)) u.searchParams.set(k, v);

  // num is largely deprecated by Google (~Sept 2025) but still honoured in some cases and
  // configured in default.json — apply it so the config value is not silently ignored.
  if (config.google.num > 0) u.searchParams.set("num", String(config.google.num));

  const uule = config.google.uule || uuleForLocation(config.location.country, config.location.city);
  if (uule) u.searchParams.set("uule", uule);
  if (start > 0) u.searchParams.set("start", String(start));
  return u.toString();
}

/** Pre-seed a consent cookie so google.com doesn't bounce us to consent.google.com. */
export async function prepareGoogleConsent(session: BrowserSession): Promise<void> {
  const domains = [".google.com", ".google.com.tr"];
  const cookies = domains.flatMap((domain) => [
    { name: "CONSENT", value: "YES+cb", domain, path: "/" },
    { name: "SOCS", value: "CAESHAgBEhIaAB", domain, path: "/" },
  ]);
  try {
    await session.context.addCookies(cookies);
  } catch (err) {
    logger.debug({ err: String(err) }, "could not pre-seed consent cookies (continuing)");
  }
}

async function pageLooksLikeCaptcha(page: Page): Promise<boolean> {
  // /sorry/ URL is definitive — still blocked.
  if (page.url().includes("/sorry/")) return true;
  // VISIBLE text + real DOM only (not raw HTML — SERP scripts contain "recaptcha"/"sorry").
  try {
    return await page.evaluate(() => {
      const text = (document.body?.innerText || "").toLowerCase();
      if (/unusual traffic|olağan dışı trafik|olagan disi trafik|robot değilim|i'?m not a robot/.test(text)) return true;
      if (document.querySelector('form[action*="sorry"]')) return true;
      if (document.querySelector('input[name="captcha"]')) return true;
      if (document.querySelector('.g-recaptcha, iframe[src*="recaptcha/api2"], iframe[src*="/recaptcha/"]')) return true;
      return false;
    });
  } catch {
    // During navigation evaluate can throw — treat as still blocked (never false-success).
    return true;
  }
}

/**
 * Strict success: we must be off /sorry/ AND not still show a captcha wall.
 * 2captcha tokens that don't land on SERP are not "solved".
 */
async function isRealSerp(page: Page): Promise<boolean> {
  const url = page.url();
  if (url.includes("/sorry/")) return false;
  if (!/google\.[^/]+\/search/i.test(url) && !url.includes("/search?")) {
    // After solve Google sometimes lands on /webhp or home then redirects — allow non-sorry google.
    if (!/google\./i.test(url)) return false;
  }
  return !(await pageLooksLikeCaptcha(page));
}

async function tryDismissConsent(page: Page): Promise<boolean> {
  if (!page.url().includes("consent.google.")) {
    // Some consent walls are inlined; check for the accept button anyway but don't force it.
    const bodyText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    if (!/devam etmeden önce|before you continue/i.test(bodyText)) return false;
  }
  for (const label of CONSENT_ACCEPT_LABELS) {
    try {
      const btn = page.getByRole("button", { name: label, exact: false }).first();
      if (await btn.count()) {
        await btn.click({ timeout: 5000 });
        await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
        logger.info({ label }, "dismissed Google consent interstitial");
        return true;
      }
    } catch {
      /* try next label */
    }
  }
  return false;
}

/**
 * Solve /sorry on the *current* page (no forced keyword URL).
 * Used after natural entry: homepage → click "Trend olan aramalar".
 */
export async function attemptCaptchaSolve(
  page: Page,
  config: AppConfig,
  captchaProxy?: SerpNavOptions["captchaProxy"],
  profileId?: string
): Promise<boolean> {
  const hasSolverKey = !!(config.captcha.capSolverApiKey || config.captcha.twoCaptchaApiKey || config.captcha.apiKey);
  if (!config.captcha.enabled || !hasSolverKey) {
    logger.warn(
      {
        enabled: config.captcha.enabled,
        hasCapSolver: !!config.captcha.capSolverApiKey,
        has2captcha: !!(config.captcha.twoCaptchaApiKey || config.captcha.apiKey),
      },
      "captcha wall hit but solver disabled or CAPSOLVER/TWOCAPTCHA API key missing"
    );
    return false;
  }

  // Economics gate: budget / distrust-wave pause / per-profile daily wall cap.
  const { getCaptchaPolicy } = await import("../captcha/policy.js");
  const policy = getCaptchaPolicy(config);
  const gate = policy.shouldSolve(profileId);
  if (!gate.ok) {
    logger.warn({ profileId, reason: gate.reason }, "captcha policy: wall will NOT be solved — straight to cooldown");
    policy.recordWallClosed(profileId, false, 0);
    return false;
  }
  const attemptCap = Math.min(RECAPTCHA_MAX_ATTEMPTS, gate.maxAttempts);
  let paidAttempts = 0;
  let wallCleared = false;

  try {
    // Private dedicated ISP IPs: recover fully. Prefer reCAPTCHA (2captcha Google docs).
    // Image is secondary; after image try, reload for a chance at reCAPTCHA again.
    let imageTries = 0;
    let recaptchaTries = 0;
    const maxLoops = attemptCap + IMAGE_MAX_ATTEMPTS + 2;
    for (let attempt = 1; attempt <= maxLoops; attempt++) {
      await waitForCaptchaMarkup(page);
      if (await isRealSerp(page)) {
        await logAbuseExemption(page, "pre-check");
        wallCleared = true;
        return true;
      }
      if (!(await pageLooksLikeCaptcha(page))) {
        if (await isRealSerp(page)) {
          wallCleared = true;
          return true;
        }
      }

      const hasRecaptcha = await page.$(".g-recaptcha[data-sitekey], iframe[src*='recaptcha']").then((h) => !!h);
      if (hasRecaptcha) {
        if (recaptchaTries >= attemptCap) {
          logger.warn({ attempt, recaptchaTries, attemptCap }, "reCAPTCHA attempts exhausted (policy cap)");
          return false;
        }
        recaptchaTries += 1;
        paidAttempts += 1;
        const ok = await solveRecaptchaOnce(page, config, attempt, captchaProxy, profileId);
        if (ok) {
          wallCleared = true;
          return true;
        }
        // 2captcha: never reuse data-s — always fresh challenge.
        await reloadCaptchaPage(page);
        continue;
      }

      const hasImage = await page.$('input[name="captcha"]').then((h) => !!h);
      if (hasImage) {
        // Prefer reCAPTCHA: first hit on pure-image, reload once to try mint reCAPTCHA.
        if (imageTries === 0 && recaptchaTries < attemptCap) {
          logger.info({ attempt }, "image wall — reloading once to prefer reCAPTCHA challenge");
          await reloadCaptchaPage(page);
          const upgraded = await page.$(".g-recaptcha[data-sitekey], iframe[src*='recaptcha']").then((h) => !!h);
          if (upgraded) continue;
        }
        if (imageTries >= IMAGE_MAX_ATTEMPTS) {
          logger.warn({ attempt, imageTries }, "image captcha exhausted after recovery loops");
          return false;
        }
        imageTries += 1;
        const ok = await solveImageOnce(page, config, attempt);
        if (ok) {
          wallCleared = true;
          return true;
        }
        logger.warn({ attempt, imageTries }, "image OCR failed — reloading for next challenge type");
        await reloadCaptchaPage(page);
        continue;
      }

      logger.warn({ attempt }, "captcha wall present but neither reCAPTCHA nor image variant matched");
      await reloadCaptchaPage(page);
    }
    return false;
  } catch (err) {
    logger.warn({ err: String(err) }, "captcha solve attempt failed");
    return false;
  } finally {
    policy.recordWallClosed(profileId, wallCleared, paidAttempts);
  }
}

async function logAbuseExemption(page: Page, phase: string): Promise<void> {
  try {
    const cookies = await page.context().cookies();
    const abuse = cookies.find((c) => /GOOGLE_ABUSE_EXEMPTION/i.test(c.name));
    const nid = cookies.find((c) => c.name === "NID");
    logger.info(
      {
        phase,
        hasAbuseExemption: !!abuse,
        abuseExpires: abuse?.expires,
        hasNid: !!nid,
        cookieCount: cookies.filter((c) => /google/i.test(c.domain)).length,
      },
      "google session trust cookies"
    );
  } catch {
    /* ignore */
  }
}

async function waitForCaptchaMarkup(page: Page): Promise<void> {
  await page
    .waitForSelector(
      '.g-recaptcha[data-sitekey], iframe[src*="recaptcha"], #captcha-form input[name="captcha"], input[name="captcha"]',
      { timeout: 15_000 }
    )
    .catch(() => {});
}

/** Collect google.* cookies in 2captcha's `NAME:VALUE;NAME2:VALUE2` format. */
async function googleCookiesFor2Captcha(page: Page): Promise<string> {
  try {
    const cookies = await page.context().cookies();
    const relevant = cookies.filter(
      (c) => /google\./i.test(c.domain) || /recaptcha/i.test(c.domain) || /gstatic\./i.test(c.domain)
    );
    // 2captcha classic API: colon between name and value, semicolon between pairs.
    return relevant.map((c) => `${c.name}:${c.value}`).join(";");
  } catch {
    return "";
  }
}

interface RecaptchaPageParams {
  key: string | null;
  dataS: string | null;
  enterprise: boolean;
  /** Why we set enterprise (for logs). */
  enterpriseSignals: string[];
  q: string | null;
  continueUrl: string | null;
  callback: string | null;
  origin: string;
  iframeSrcSnippet: string | null;
  /** All captcha-form fields (name→value) for complete GET submit. */
  formFields: Record<string, string>;
  formAction: string | null;
}

/** Pull sitekey, data-s (element + iframe), and form fields from the sorry page. */
async function extractRecaptchaParams(page: Page): Promise<RecaptchaPageParams> {
  return page.evaluate(() => {
    const el = document.querySelector(".g-recaptcha") as HTMLElement | null;
    const iframe = document.querySelector('iframe[src*="recaptcha"]') as HTMLIFrameElement | null;
    let key = el?.getAttribute("data-sitekey") ?? null;
    if (!key && iframe) {
      const m = iframe.src.match(/[?&]k=([^&]+)/);
      if (m) key = decodeURIComponent(m[1]!);
    }
    // data-s is one-shot and required for Google Search. Prefer the element attribute;
    // fall back to the iframe `s=` query param (some renders only put it there).
    let dataS = el?.getAttribute("data-s") ?? null;
    if (!dataS && iframe) {
      const m = iframe.src.match(/[?&]s=([^&]+)/);
      if (m) dataS = decodeURIComponent(m[1]!);
    }

    // Enterprise only when the widget is clearly loaded via enterprise API.
    const signals: string[] = [];
    const iframeSrc = iframe?.src ?? "";
    if (/recaptcha\/enterprise/i.test(iframeSrc)) signals.push("iframe:/recaptcha/enterprise");
    if (/[?&]enterprise=/i.test(iframeSrc)) signals.push("iframe:enterprise=");
    const scripts = Array.from(document.querySelectorAll("script[src]"))
      .map((s) => (s as HTMLScriptElement).src)
      .filter(Boolean);
    if (scripts.some((src) => /recaptcha\/enterprise\.js/i.test(src))) {
      signals.push("script:recaptcha/enterprise.js");
    }
    if (scripts.some((src) => /recaptcha\/enterprise/i.test(src))) {
      signals.push("script:recaptcha/enterprise");
    }
    try {
      const g = (window as unknown as { grecaptcha?: { enterprise?: unknown } }).grecaptcha;
      if (g && g.enterprise) signals.push("window.grecaptcha.enterprise");
    } catch {
      /* ignore */
    }
    // Google Search sorry sitekeys are enterprise even when signals lag.
    if (!signals.length && /google\.(com|com\.tr)/i.test(location.hostname) && /\/sorry\//i.test(location.pathname)) {
      signals.push("heuristic:google-sorry");
    }
    const enterprise = signals.length > 0;

    const form = (document.getElementById("captcha-form") ||
      document.querySelector('form[action*="index"], form[action*="sorry"], form')) as HTMLFormElement | null;
    const formFields: Record<string, string> = {};
    if (form) {
      const inputs = form.querySelectorAll("input, textarea, select");
      for (let i = 0; i < inputs.length; i++) {
        const inp = inputs[i] as HTMLInputElement;
        const name = inp.name || inp.id;
        if (!name) continue;
        if (inp.type === "submit" || inp.type === "button" || inp.type === "image") continue;
        formFields[name] = inp.value ?? "";
      }
    }
    // URL query also carries q/continue on many renders.
    const sp = new URLSearchParams(location.search);
    for (const k of ["q", "continue", "hl", "id", "sa", "sei"]) {
      const v = sp.get(k);
      if (v && !formFields[k]) formFields[k] = v;
    }

    const q = formFields["q"] || sp.get("q");
    const continueUrl = formFields["continue"] || sp.get("continue");
    const callback = el?.getAttribute("data-callback") ?? null;
    let formAction: string | null = null;
    if (form?.action) {
      try {
        formAction = new URL(form.action, location.href).toString();
      } catch {
        formAction = form.action;
      }
    }

    return {
      key,
      dataS,
      enterprise,
      enterpriseSignals: signals,
      q,
      continueUrl,
      callback,
      origin: location.origin,
      iframeSrcSnippet: iframeSrc ? iframeSrc.slice(0, 180) : null,
      formFields,
      formAction,
    };
  });
}

/**
 * Build the pageurl 2captcha expects for Google /sorry.
 * Full current URL is preferred; if oversized, keep origin+path+q+continue+hl.
 */
function pageUrlFor2Captcha(fullUrl: string, rc: RecaptchaPageParams): string {
  try {
    const u = new URL(fullUrl);
    if (fullUrl.length <= 1800) return fullUrl;
    const slim = new URL(`${u.origin}${u.pathname}`);
    if (rc.q) slim.searchParams.set("q", rc.q);
    if (rc.continueUrl) slim.searchParams.set("continue", rc.continueUrl);
    const hl = u.searchParams.get("hl") || rc.formFields?.hl;
    if (hl) slim.searchParams.set("hl", hl);
    return slim.toString();
  } catch {
    return fullUrl;
  }
}

/**
 * One reCAPTCHA solve attempt (caller owns the retry/reload loop).
 *
 * Strategy rotates by attempt number (fresh data-s each time after reload):
 *  1) Enterprise + proxy + browser cookies  (ip-100 production path)
 *  2) Classic V2 + recaptchaDataSValue + proxy + cookies
 *  3) Enterprise + proxy, no cookies
 *  4) Enterprise + proxy + cookies + apply worker solution cookies before submit
 *
 * Private ISP proxies are NOT abandoned — we only rotate solve shape.
 */
async function solveRecaptchaOnce(
  page: Page,
  config: AppConfig,
  attempt: number,
  captchaProxy?: SerpNavOptions["captchaProxy"],
  profileId?: string
): Promise<boolean> {
  const rc = await extractRecaptchaParams(page);
  if (!rc.key) {
    logger.warn({ attempt }, "captcha wall present but no reCAPTCHA sitekey found");
    return false;
  }
  if (!rc.dataS) {
    logger.warn({ attempt }, "sorry-page reCAPTCHA missing data-s — solve will almost certainly fail");
  }

  const cookies = await googleCookiesFor2Captcha(page);
  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => undefined);
  const fullUrl = page.url();
  const pageUrl = pageUrlFor2Captcha(fullUrl, rc);
  const hasProxy = !!captchaProxy?.proxy;
  const ua = userAgent || undefined;
  const siteKey = rc.key;

  // Rotate task shape — same data-s never reused after a failed job (caller reloads).
  type Variant = {
    label: string;
    enterprise: boolean;
    sendCookies: boolean;
    applyWorkerCookies: boolean;
  };
  const variants: Variant[] = [
    { label: "ent+proxy+cookies", enterprise: true, sendCookies: true, applyWorkerCookies: false },
    { label: "v2+proxy+cookies", enterprise: false, sendCookies: true, applyWorkerCookies: false },
    { label: "ent+proxy", enterprise: true, sendCookies: false, applyWorkerCookies: false },
    { label: "ent+proxy+cookies+workerCk", enterprise: true, sendCookies: true, applyWorkerCookies: true },
  ];
  const variant = variants[(attempt - 1) % variants.length]!;

  logger.info(
    {
      attempt,
      variant: variant.label,
      detectedEnterprise: rc.enterprise,
      enterpriseSignals: rc.enterpriseSignals,
      iframeSrcSnippet: rc.iframeSrcSnippet,
      hasDataS: !!rc.dataS,
      dataSLen: rc.dataS?.length ?? 0,
      cookiePairs: cookies ? cookies.split(";").filter(Boolean).length : 0,
      hasUa: !!userAgent,
      hasProxy,
      proxytype: captchaProxy?.proxytype,
      pageUrlLen: pageUrl.length,
      siteKeyPrefix: siteKey.slice(0, 12),
    },
    "attempting 2captcha solve for Google sorry-page reCAPTCHA"
  );

  // Prefer CapSolver first (faster = fresher data-s). Fall back to 2captcha on later attempts.
  const preferCap = !!(config.captcha.capSolverApiKey);
  const has2c = !!(config.captcha.twoCaptchaApiKey || config.captcha.apiKey);
  const providerForAttempt: "capsolver" | "2captcha" | "auto" =
    config.captcha.provider === "2captcha"
      ? "2captcha"
      : config.captcha.provider === "capsolver"
        ? "capsolver"
        : preferCap
          ? attempt <= 3 || !has2c
            ? "capsolver"
            : "2captcha"
          : "2captcha";

  const solved = await withBrowserKeepAlive(page, () =>
    solveRecaptchaMulti(siteKey, pageUrl, {
      enterprise: variant.enterprise || rc.enterprise,
      dataS: rc.dataS ?? undefined,
      userAgent: ua,
      proxy: hasProxy ? captchaProxy!.proxy : undefined,
      proxytype: captchaProxy?.proxytype,
      cookies: variant.sendCookies && cookies ? cookies : undefined,
      allowCookiesWithProxy: !!(hasProxy && variant.sendCookies),
      timeoutMs: RECAPTCHA_SOLVE_TIMEOUT_MS,
      pollMs: 1_500,
      provider: providerForAttempt,
      capSolverApiKey: config.captcha.capSolverApiKey,
      twoCaptchaApiKey: config.captcha.twoCaptchaApiKey || config.captcha.apiKey,
    })
  );

  if (!solved) {
    logger.warn({ attempt, variant: variant.label, provider: providerForAttempt }, "solver returned no token");
    return false;
  }

  // Stale data-s: do NOT submit, do NOT reportbad — worker may have been right.
  if (solved.waitMs != null && solved.waitMs > DATA_S_MAX_WAIT_MS) {
    logger.warn(
      { attempt, waitMs: solved.waitMs, variant: variant.label, provider: solved.provider },
      "token wait exceeded data-s budget — discard without submit, retry fresh challenge"
    );
    return false;
  }

  // If the page rotated data-s while we waited, this token is dead — do not reportbad.
  if (rc.dataS) {
    const still = await extractRecaptchaParams(page);
    if (still.dataS && still.dataS !== rc.dataS) {
      logger.warn(
        { attempt, had: rc.dataS.slice(0, 24), now: still.dataS.slice(0, 24) },
        "data-s rotated while waiting for solver — discarding token"
      );
      return false;
    }
    if (still.q) rc.q = still.q;
    if (still.continueUrl) rc.continueUrl = still.continueUrl;
    if (still.formFields) rc.formFields = still.formFields;
    if (still.formAction) rc.formAction = still.formAction;
    if (still.callback) rc.callback = still.callback;
  }

  if (solved.cookies && (variant.applyWorkerCookies || !hasProxy)) {
    await apply2CaptchaCookies(page, solved.cookies);
  }

  const cleared = await submitRecaptchaToken(page, solved.token, rc);
  // Policy outcome: one paid token consumed — cleared or persisted (breaker input).
  const recordOutcome = async (outcome: "cleared" | "persisted") => {
    try {
      const { getCaptchaPolicy } = await import("../captcha/policy.js");
      const provider = solved.provider ?? (solved.via === "capsolver" ? "capsolver" : "2captcha");
      getCaptchaPolicy(config).recordSolve(profileId, provider, outcome, solved.solverCallId);
    } catch {
      /* policy optional */
    }
  };
  if (cleared) {
    await recordOutcome("cleared");
    logger.info(
      {
        attempt,
        variant: variant.label,
        enterprise: variant.enterprise || rc.enterprise,
        via: solved.via,
        provider: solved.provider,
        waitMs: solved.waitMs,
      },
      "captcha wall cleared via solver"
    );
    return true;
  }

  // One more chance: harvest abuse + continue (manual path often lands here)
  await harvestGoogleAbuseFromUrl(page);
  if (rc.continueUrl) {
    const late = await tryFollowContinueUrl(page, rc.continueUrl, "reCAPTCHA/late-continue");
    if (late) {
      await recordOutcome("cleared");
      logger.info({ attempt, variant: variant.label }, "captcha cleared on late continue after token");
      return true;
    }
  }

  await recordOutcome("persisted");

  logger.warn(
    {
      attempt,
      variant: variant.label,
      enterprise: variant.enterprise || rc.enterprise,
      via: solved.via,
      provider: solved.provider,
      waitMs: solved.waitMs,
    },
    "token submitted but wall still present — reporting bad (fresh challenge next)"
  );
  if (solved.provider === "2captcha" || solved.via === "api_v2" || solved.via === "in_php") {
    await reportIncorrect(config.captcha.twoCaptchaApiKey || config.captcha.apiKey, solved.jobId);
  }
  return false;
}

/**
 * Light activity while 2captcha workers solve so AdsPower does not close the browser
 * and the /sorry page (with its data-s) stays loaded.
 */
async function withBrowserKeepAlive<T>(page: Page, work: () => Promise<T>): Promise<T> {
  let stop = false;
  const tick = async () => {
    while (!stop) {
      await sleep(KEEPALIVE_INTERVAL_MS);
      if (stop) break;
      try {
        if (page.isClosed()) break;
        await page.evaluate(() => {
          window.scrollBy(0, 1);
          window.scrollBy(0, -1);
        });
      } catch {
        break;
      }
    }
  };
  const keepalive = tick();
  try {
    return await work();
  } finally {
    stop = true;
    await keepalive.catch(() => {});
  }
}

/** Apply cookies returned by 2captcha workers onto google.com / google.com.tr. */
async function apply2CaptchaCookies(page: Page, cookieStr: string): Promise<void> {
  const pairs = cookieStr
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!pairs.length) return;

  const domains = [".google.com", ".google.com.tr", "www.google.com", "www.google.com.tr"];
  const cookies: Array<{ name: string; value: string; domain: string; path: string }> = [];
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    const colon = pair.indexOf(":");
    let name: string;
    let value: string;
    if (eq > 0) {
      name = pair.slice(0, eq).trim();
      value = pair.slice(eq + 1).trim();
    } else if (colon > 0) {
      name = pair.slice(0, colon).trim();
      value = pair.slice(colon + 1).trim();
    } else {
      continue;
    }
    if (!name) continue;
    for (const domain of domains) {
      cookies.push({ name, value, domain, path: "/" });
    }
  }
  try {
    await page.context().addCookies(cookies);
    logger.info({ pairs: pairs.length, cookieObjs: cookies.length }, "applied 2captcha worker cookies");
  } catch (err) {
    logger.warn({ err: String(err) }, "failed to apply 2captcha cookies");
  }
}

/**
 * Apply a solved token. Order matters for Google /sorry:
 *
 * Proven production path (ip-100, 19 solves): inject + data-callback / form submit
 * WHILE STILL ON THE SAME CHALLENGE PAGE → SERP with google_abuse=.
 *
 * Full GET first navigates away, often burns a valid token against a rotated q.
 * So: 1) callback/form  2) GET fallback  3) continue URL
 */
async function submitRecaptchaToken(page: Page, token: string, rc: RecaptchaPageParams): Promise<boolean> {
  // Strategy 1 (proven on ip-100): stay on challenge page → inject token → callback / form.
  if (page.url().includes("/sorry/")) {
    const submitted = await page
      .evaluate(
        ({ t, cbName }: { t: string; cbName: string | null }) => {
          const form = (document.getElementById("captcha-form") ||
            document.querySelector('form[action*="index"], form[action*="sorry"], form')) as HTMLFormElement | null;

          const setTokenOn = (ta: HTMLTextAreaElement | HTMLInputElement) => {
            ta.value = t;
            if ("innerHTML" in ta) (ta as HTMLTextAreaElement).innerHTML = t;
            ta.setAttribute("value", t);
            ta.dispatchEvent(new Event("input", { bubbles: true }));
            ta.dispatchEvent(new Event("change", { bubbles: true }));
          };

          // Every known response field (including multiples Google sometimes injects).
          const nodes = document.querySelectorAll(
            'textarea[name="g-recaptcha-response"], #g-recaptcha-response, textarea[id*="g-recaptcha-response"], input[name="g-recaptcha-response"]'
          );
          if (nodes.length) {
            nodes.forEach((n) => setTokenOn(n as HTMLTextAreaElement));
          } else if (form) {
            const ta = document.createElement("textarea");
            ta.name = "g-recaptcha-response";
            ta.id = "g-recaptcha-response";
            ta.style.display = "none";
            form.appendChild(ta);
            setTokenOn(ta);
          }

          try {
            (window as unknown as Record<string, unknown>)["g-recaptcha-response"] = t;
          } catch {
            /* ignore */
          }

          // Walk ___grecaptcha_cfg and fire any nested callback with the token.
          try {
            const cfg = (window as unknown as { ___grecaptcha_cfg?: { clients?: Record<string, unknown> } })
              .___grecaptcha_cfg;
            const clients = cfg?.clients;
            if (clients) {
              const walk = (obj: unknown, depth: number) => {
                if (!obj || typeof obj !== "object" || depth > 8) return;
                const rec = obj as Record<string, unknown>;
                for (const k of Object.keys(rec)) {
                  const v = rec[k];
                  if ((k === "callback" || k === "promise-callback") && typeof v === "function") {
                    try {
                      (v as (tok: string) => void)(t);
                    } catch {
                      /* next */
                    }
                  } else if (v && typeof v === "object") {
                    walk(v, depth + 1);
                  }
                }
              };
              for (const id of Object.keys(clients)) walk(clients[id], 0);
            }
          } catch {
            /* ignore */
          }

          // Named data-callback on the widget.
          if (cbName) {
            const fn = (window as unknown as Record<string, unknown>)[cbName];
            if (typeof fn === "function") {
              try {
                (fn as (tok: string) => void)(t);
                return "callback";
              } catch {
                /* fall through */
              }
            }
          }

          for (const name of ["submitCallback", "captchaSubmit", "onSubmit"]) {
            const fn = (window as unknown as Record<string, unknown>)[name];
            if (typeof fn === "function") {
              try {
                (fn as (tok: string) => void)(t);
                return `callback:${name}`;
              } catch {
                /* next */
              }
            }
          }

          // Google /sorry form is usually method=GET — form.submit() is the documented path.
          const btn = document.querySelector(
            '#captcha-form input[type="submit"], input[name="btn"], input[name="btn-submit"], #captcha-form button[type="submit"], #recaptcha-submit, button.rc-button'
          ) as HTMLElement | null;
          if (btn) {
            btn.click();
            return "click";
          }
          if (form) {
            // Ensure token field is inside the form before submit.
            let ta = form.querySelector(
              'textarea[name="g-recaptcha-response"], input[name="g-recaptcha-response"]'
            ) as HTMLTextAreaElement | null;
            if (!ta) {
              ta = document.createElement("textarea");
              ta.name = "g-recaptcha-response";
              ta.style.display = "none";
              form.appendChild(ta);
            }
            setTokenOn(ta);
            form.submit();
            return "submit";
          }
          return false;
        },
        { t: token, cbName: rc.callback }
      )
      .catch(() => false as const);

    if (submitted) {
      logger.info({ via: submitted }, "submitted captcha token via in-page callback/form");
      await harvestGoogleAbuseFromUrl(page);
      const ok = await confirmSolveCleared(page, `reCAPTCHA/${submitted}`, rc.continueUrl);
      if (ok) return true;
    }
  }

  // Strategy 2: full GET /sorry/index?...&g-recaptcha-response=TOKEN (2captcha blog alt path).
  // Only if still on /sorry and form fields still match the original challenge.
  if (page.url().includes("/sorry/")) {
    try {
      const base =
        rc.formAction ||
        new URL("/sorry/index", rc.origin || "https://www.google.com").toString();
      const u = new URL(base);
      for (const [k, v] of Object.entries(rc.formFields || {})) {
        if (k === "g-recaptcha-response") continue;
        if (v != null && v !== "") u.searchParams.set(k, v);
      }
      if (rc.q && !u.searchParams.get("q")) u.searchParams.set("q", rc.q);
      if (rc.continueUrl && !u.searchParams.get("continue")) u.searchParams.set("continue", rc.continueUrl);
      u.searchParams.set("g-recaptcha-response", token);
      logger.info(
        { origin: rc.origin, fieldCount: Object.keys(rc.formFields || {}).length, hasQ: !!u.searchParams.get("q") },
        "submitting captcha token via full /sorry GET (fallback)"
      );
      await page.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      await harvestGoogleAbuseFromUrl(page);
      const ok = await confirmSolveCleared(page, "reCAPTCHA/full-get", rc.continueUrl);
      if (ok) return true;
    } catch (err) {
      logger.warn({ err: String(err) }, "full /sorry GET submit failed");
    }
  }

  // Strategy 3: continue URL (exemption cookie path).
  await harvestGoogleAbuseFromUrl(page);
  if (rc.continueUrl) {
    const ok = await tryFollowContinueUrl(page, rc.continueUrl, "reCAPTCHA/continue-fallback");
    if (ok) return true;
  }

  return false;
}

/**
 * If Google put google_abuse= on the current URL, materialize it as a cookie so
 * the next continue/SERP navigation carries GOOGLE_ABUSE_EXEMPTION.
 */
async function harvestGoogleAbuseFromUrl(page: Page): Promise<void> {
  try {
    const url = page.url();
    if (!url.includes("google_abuse=")) return;
    const u = new URL(url);
    const raw = u.searchParams.get("google_abuse");
    if (!raw) return;
    // Value looks like: GOOGLE_ABUSE_EXEMPTION=ID=...:TM=...; path=/; domain=google.com; expires=...
    const nameMatch = raw.match(/^([^=\s]+)=/);
    const name = nameMatch?.[1] || "GOOGLE_ABUSE_EXEMPTION";
    let value = raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : raw;
    // Strip cookie attributes if embedded in the value string.
    value = value.split(";")[0]?.trim() || value;
    if (!value) return;
    await page.context().addCookies([
      { name, value, domain: ".google.com", path: "/" },
      { name, value, domain: ".google.com.tr", path: "/" },
    ]);
    logger.info({ name, valueLen: value.length }, "harvested google_abuse into session cookie");
  } catch (err) {
    logger.debug({ err: String(err) }, "harvestGoogleAbuseFromUrl failed");
  }
}

/**
 * After a token submit, Google sometimes sets trust cookies but does not auto-redirect.
 * Following the original SERP `continue` URL recovers those sessions.
 */
async function tryFollowContinueUrl(page: Page, continueUrl: string, kind: string): Promise<boolean> {
  try {
    let hasAbuse = false;
    try {
      const cookies = await page.context().cookies();
      hasAbuse = cookies.some((c) => /GOOGLE_ABUSE_EXEMPTION/i.test(c.name));
    } catch {
      /* ignore */
    }
    logger.info({ kind, hasAbuse, host: (() => { try { return new URL(continueUrl).host; } catch { return "?"; } })() }, "following continue URL after captcha token");
    await page.goto(continueUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    await sleep(3_500);
    if (await isRealSerp(page)) {
      await logAbuseExemption(page, kind);
      logger.info({ kind, url: page.url() }, "captcha wall cleared via continue URL");
      return true;
    }
  } catch (err) {
    logger.warn({ err: String(err), kind }, "continue URL follow failed");
  }
  return false;
}

/**
 * Reload / re-hit the search so Google mints a fresh challenge.
 * Prefer the form's `continue` URL (the original SERP) — a bare reload of /sorry/ sometimes
 * lands on an empty page with no image and no reCAPTCHA widget.
 */
async function reloadCaptchaPage(page: Page): Promise<void> {
  try {
    const continueUrl = await page
      .evaluate(() => {
        const input = document.querySelector('input[name="continue"]') as HTMLInputElement | null;
        return input?.value || new URLSearchParams(location.search).get("continue");
      })
      .catch(() => null);
    if (continueUrl) {
      await page.goto(continueUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    } else {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    }
  } catch {
    /* ignore — caller will re-check markup */
  }
  await sleep(1500);
  await waitForCaptchaMarkup(page);
}

/** True if base64 looks like a real PNG/JPEG/GIF (not an HTML error body or 1x1 pixel). */
function looksLikeImageBase64(b64: string): boolean {
  if (!b64 || b64.length < 500) return false;
  try {
    const head = Buffer.from(b64.slice(0, 32), "base64");
    // PNG ‰PNG / JPEG ÿØÿ / GIF GIF8
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return true;
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true;
    if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Grab the sorry-page image as base64.
 * 1) Wait for a real painted <img> (naturalWidth)
 * 2) Fetch /sorry/image with cookies and validate magic bytes
 * 3) Fall back to element screenshot
 */
async function captureSorryImageBase64(page: Page): Promise<string | null> {
  // Give the image a moment to paint over slow proxies.
  await page
    .waitForFunction(
      () => {
        const img = document.querySelector(
          '#captcha-form img, img[src*="/sorry/image"], form img'
        ) as HTMLImageElement | null;
        return !!img && (img.naturalWidth > 40 || img.complete);
      },
      { timeout: 12_000 }
    )
    .catch(() => {});

  const fromFetch = await page
    .evaluate(async () => {
      const img = document.querySelector(
        '#captcha-form img, img[src*="/sorry/image"], form img'
      ) as HTMLImageElement | null;
      if (!img) return null;
      const src = img.currentSrc || img.getAttribute("src") || img.src;
      if (!src) return null;
      try {
        const abs = new URL(src, location.href).toString();
        const res = await fetch(abs, { credentials: "include", cache: "no-store" });
        if (!res.ok) return null;
        const ct = res.headers.get("content-type") || "";
        if (ct && !/image\//i.test(ct) && !/octet-stream/i.test(ct)) return null;
        const buf = await res.arrayBuffer();
        if (buf.byteLength < 400) return null;
        const bytes = new Uint8Array(buf);
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        return {
          b64: btoa(binary),
          bytes: buf.byteLength,
          w: img.naturalWidth,
          h: img.naturalHeight,
        };
      } catch {
        return null;
      }
    })
    .catch(() => null);

  if (fromFetch?.b64 && looksLikeImageBase64(fromFetch.b64)) {
    logger.info(
      { bytes: fromFetch.bytes, w: fromFetch.w, h: fromFetch.h, via: "fetch" },
      "captured sorry-page captcha image"
    );
    return fromFetch.b64;
  }

  try {
    const imgLoc = page.locator('#captcha-form img, img[src*="/sorry/image"], form img').first();
    await imgLoc.waitFor({ state: "visible", timeout: 10_000 });
    const buf = await imgLoc.screenshot({ timeout: 10_000, type: "png" });
    const b64 = buf.toString("base64");
    if (!looksLikeImageBase64(b64)) {
      logger.warn({ bytes: buf.length }, "screenshot did not look like a real image");
      return null;
    }
    logger.info({ bytes: buf.length, via: "screenshot" }, "captured sorry-page captcha image");
    return b64;
  } catch (err) {
    logger.warn({ err: String(err) }, "could not capture sorry-page captcha image");
    return null;
  }
}

/** Persist captcha image + OCR text under data/debug-captcha/ for manual verification. */
function dumpCaptchaDebug(base64: string, meta: { attempt: number; answer?: string; jobId?: string }): void {
  try {
    const dir = resolve(process.cwd(), "data", "debug-captcha");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const imgPath = resolve(dir, `${stamp}-a${meta.attempt}.png`);
    const raw = base64.replace(/^data:image\/\w+;base64,/, "");
    writeFileSync(imgPath, Buffer.from(raw, "base64"));
    if (meta.answer != null) {
      writeFileSync(
        resolve(dir, `${stamp}-a${meta.attempt}.txt`),
        `answer=${meta.answer}\njobId=${meta.jobId ?? ""}\nattempt=${meta.attempt}\nimage=${imgPath}\n`,
        "utf8"
      );
    }
    logger.info({ imgPath, answer: meta.answer, jobId: meta.jobId }, "captcha debug dump written");
  } catch (err) {
    logger.debug({ err: String(err) }, "captcha debug dump failed");
  }
}

/** One image-captcha solve attempt (caller owns the retry/reload loop). */
async function solveImageOnce(page: Page, config: AppConfig, attempt: number): Promise<boolean> {
  const base64 = await captureSorryImageBase64(page);
  if (!base64) return false;

  dumpCaptchaDebug(base64, { attempt });

  logger.info({ attempt, bytes: base64.length }, "attempting 2captcha ImageToTextTask for Google sorry-page");
  // Loose constraints: wrong min/max/case forced bad worker guesses.
  // Do not rewrite the answer (no space-stripping) — type exactly what workers return.
  const imgKey = config.captcha.twoCaptchaApiKey || config.captcha.apiKey;
  if (!imgKey) {
    logger.warn("image captcha needs TWOCAPTCHA_API_KEY (CapSolver image path not wired)");
    return false;
  }
  const solved = await solveImageCaptcha(imgKey, base64, {
    caseSensitive: false,
    comment: "Type the distorted characters from the image exactly as shown",
  });
  if (!solved?.text) {
    logger.warn({ attempt }, "2captcha returned no image answer");
    return false;
  }
  // Only trim ends — never remove internal spaces or change case.
  const answer = solved.text.trim();
  dumpCaptchaDebug(base64, { attempt, answer, jobId: solved.jobId });
  logger.info(
    { attempt, answer, answerLen: answer.length, via: solved.via, jobId: solved.jobId },
    "2captcha image answer received"
  );

  // DOM fill + explicit submit is more reliable than Playwright click on Google's
  // mobile-emulated profiles (click often hangs even when the input is "visible").
  const submitted = await page
    .evaluate((ans) => {
      const form = (document.getElementById("captcha-form") ||
        document.querySelector("form")) as HTMLFormElement | null;
      const input = (document.querySelector('input[name="captcha"]') ||
        document.querySelector("#captcha")) as HTMLInputElement | null;
      if (!input) return "no-input";
      input.focus();
      input.value = ans;
      input.setAttribute("value", ans);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));

      const btn = (form || document).querySelector(
        'input[type="submit"], input[name="btn"], input[name="btn-submit"], input[name="submit"], button[type="submit"]'
      ) as HTMLElement | null;
      if (btn) {
        btn.click();
        return "click";
      }
      if (form) {
        form.submit();
        return "submit";
      }
      return "no-form";
    }, answer)
    .catch(() => "error");

  if (submitted === "no-input" || submitted === "no-form" || submitted === "error") {
    logger.warn({ attempt, submitted, answer }, "could not submit image captcha form");
    return false;
  }

  const continueUrl = await page
    .evaluate(() => {
      const input = document.querySelector('input[name="continue"]') as HTMLInputElement | null;
      return input?.value || new URLSearchParams(location.search).get("continue");
    })
    .catch(() => null);
  const cleared = await confirmSolveCleared(page, `image/${submitted}`, continueUrl);
  if (cleared) {
    logger.info({ attempt, kind: "image", via: solved.via, answer }, "captcha wall cleared via 2captcha");
    return true;
  }
  // Refund / retrain workers when Google rejects the OCR text.
  await reportIncorrect(imgKey, solved.jobId).catch(() => {});
  logger.warn({ attempt, answer, answerLen: answer.length, jobId: solved.jobId }, "image captcha answer rejected");
  return false;
}

/**
 * After submitting a solve, wait for Google to process (2captcha: 5–10s) and
 * only declare success if we are on a real SERP (strict).
 * Optionally follow `continueUrl` when still on /sorry after token (cookie path).
 */
async function confirmSolveCleared(page: Page, kind: string, continueUrl?: string | null): Promise<boolean> {
  await Promise.race([
    page.waitForURL((u) => !u.toString().includes("/sorry/"), { timeout: 35_000 }).catch(() => null),
    page.waitForLoadState("domcontentloaded", { timeout: 35_000 }).catch(() => null),
    sleep(POST_TOKEN_SETTLE_MS),
  ]);
  // Extra settle — tokens that "flash" /search then bounce back to /sorry must fail.
  await sleep(4_000);
  await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
  await harvestGoogleAbuseFromUrl(page);

  if (await isRealSerp(page)) {
    await logAbuseExemption(page, kind);
    logger.info({ kind, url: page.url() }, "captcha wall cleared — real SERP confirmed");
    return true;
  }

  // Manual path often: token → google_abuse cookie → navigate continue SERP.
  const continueTargets: string[] = [];
  if (continueUrl) continueTargets.push(continueUrl);
  const discovered = await page
    .evaluate(() => {
      const input = document.querySelector('input[name="continue"]') as HTMLInputElement | null;
      return input?.value || new URLSearchParams(location.search).get("continue");
    })
    .catch(() => null);
  if (discovered && !continueTargets.includes(discovered)) continueTargets.push(discovered);

  for (const target of continueTargets) {
    const viaContinue = await tryFollowContinueUrl(page, target, `${kind}+continue`);
    if (viaContinue) return true;
    // Second settle + retry (Google sometimes needs exemption cookie to stick)
    await sleep(2_500);
    await harvestGoogleAbuseFromUrl(page);
    if (await isRealSerp(page)) {
      await logAbuseExemption(page, `${kind}+post-continue`);
      return true;
    }
    const via2 = await tryFollowContinueUrl(page, target, `${kind}+continue-retry`);
    if (via2) return true;
  }

  const url = page.url();
  logger.warn({ kind, url, stillSorry: url.includes("/sorry/") }, "captcha submit did not reach real SERP");
  return false;
}

/**
 * Warm up a fresh profile session BEFORE any brand keyword.
 *
 * Critical product rule (mobile private ISP):
 *   NEVER go straight to "herabet" / brand SERP.
 *   1) Google home → live "Trend olan aramalar" (human path)
 *   2) Solve /sorry on that path if needed
 *   3) Only then allow brand keyword search
 *
 * Direct /search?q=hava+durumu is bot-like and is NOT used when captcha mode is on.
 */
export interface WarmUpOptions extends SerpNavOptions {
  /**
   * When false, only open Google home (no trend / soft SERP).
   * Use false when the caller already runs recoverViaTrendClick / soft keyword itself
   * (recovery pass, probe with its own soft keyword) so we do not double-hit Google.
   */
  softSearch?: boolean;
  /**
   * Prefer live homepage trend over any fixed soft keyword (default true).
   * Only relevant when softSearch is not false and captcha recovery is enabled.
   */
  trendWarmup?: boolean;
}

export type WarmUpResult = SerpNavResult & { trend?: string; method: "trend" | "home-only" | "skipped" };

export async function warmUp(
  session: BrowserSession,
  config: AppConfig,
  opts: WarmUpOptions = {}
): Promise<WarmUpResult> {
  const hasSolverKey = !!(
    config.captcha.capSolverApiKey ||
    config.captcha.twoCaptchaApiKey ||
    config.captcha.apiKey
  );
  // Default: trend trust path whenever captcha recovery is on (scan / click).
  // softSearch:false = caller owns the path (recover-ips, probe soft-keyword).
  const doTrustWarm =
    opts.softSearch !== false && !!config.captcha.enabled && hasSolverKey;
  const useTrend = opts.trendWarmup !== false;

  if (!doTrustWarm) {
    try {
      await session.page.goto(`https://${config.google.domain}/`, {
        waitUntil: "domcontentloaded",
        timeout: config.scan.navTimeoutMs,
      });
      await tryDismissConsent(session.page);
      await sleep(1500);
    } catch (err) {
      logger.debug({ err: String(err) }, "warm-up home navigation failed (continuing)");
    }
    return { captcha: false, captchaSolved: false, finalUrl: session.page.url(), method: "home-only" };
  }

  if (useTrend) {
    try {
      logger.info("session trust warm-up via live homepage trend (before any brand keyword)");
      const nav = await recoverViaTrendClick(session, config, opts);
      if (nav.captchaSolved) {
        logger.info(
          { trend: nav.trend, finalUrl: nav.finalUrl },
          "trend warm-up cleared captcha — session safe for brand keyword"
        );
      } else if (nav.captcha) {
        logger.warn(
          { trend: nav.trend },
          "trend warm-up still blocked — refusing brand keyword on this profile"
        );
      } else {
        await logAbuseExemption(session.page, "trend-warmup-clean");
        logger.info(
          { trend: nav.trend, finalUrl: nav.finalUrl },
          "trend warm-up clean — session safe for brand keyword"
        );
      }
      await sleep(1200);
      return { ...nav, method: "trend" };
    } catch (err) {
      logger.warn({ err: String(err) }, "trend warm-up failed");
      return {
        captcha: true,
        captchaSolved: false,
        finalUrl: session.page.url(),
        trend: "",
        method: "trend",
      };
    }
  }

  // Explicit opt-out of trend only (rare): fixed soft keyword path.
  try {
    await session.page.goto(`https://${config.google.domain}/`, {
      waitUntil: "domcontentloaded",
      timeout: config.scan.navTimeoutMs,
    });
    await tryDismissConsent(session.page);
    await sleep(1500);
    const soft = "hava durumu";
    const softUrl = buildSerpUrl(config, soft);
    logger.info({ soft }, "soft warm-up search (trendWarmup=false)");
    const nav = await gotoSerp(session, softUrl, config, opts);
    await sleep(1200);
    return { ...nav, method: "home-only", trend: soft };
  } catch (err) {
    logger.debug({ err: String(err) }, "soft warm-up failed");
    return { captcha: true, captchaSolved: false, finalUrl: session.page.url(), method: "home-only" };
  }
}

/** After landing on a Google page (SERP or /sorry), settle + optional captcha solve. */
async function finishSerpNav(
  page: Page,
  config: AppConfig,
  opts: SerpNavOptions,
  logCtx: Record<string, unknown>
): Promise<SerpNavResult> {
  await tryDismissConsent(page);
  await settleSerp(page);

  let captcha = await pageLooksLikeCaptcha(page);
  let captchaSolved = false;
  if (captcha) {
    logger.warn({ ...logCtx, url: page.url().slice(0, 160), hasProxy: !!opts.captchaProxy }, "Google CAPTCHA / sorry wall detected");
    captchaSolved = await attemptCaptchaSolve(page, config, opts.captchaProxy, opts.profileId);
    if (captchaSolved) {
      await settleSerp(page);
      if (!(await isRealSerp(page))) {
        logger.warn({ finalUrl: page.url() }, "solve claimed success but final URL is not a real SERP — marking blocked");
        captchaSolved = false;
      } else {
        await logAbuseExemption(page, "gotoSerp-final");
      }
    }
    captcha = !captchaSolved;
  }

  return { captcha, captchaSolved, finalUrl: page.url() };
}

/** Navigate to a SERP URL, clearing consent and handling a CAPTCHA wall if it appears. */
export async function gotoSerp(
  session: BrowserSession,
  url: string,
  config: AppConfig,
  opts: SerpNavOptions = {}
): Promise<SerpNavResult> {
  const page = session.page;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.scan.navTimeoutMs }).catch((err) => {
    logger.debug({ err: String(err) }, "SERP goto did not fully settle");
  });
  return finishSerpNav(page, config, opts, { mode: "direct-url", dest: url.slice(0, 120) });
}

export interface NaturalSearchOptions extends SerpNavOptions {
  /** mobile = type on homepage (normal mweb Google). desktop = still prefers box, falls back to /search. */
  device?: "mobile" | "desktop";
}

/**
 * Normal Google search the way a human does on phone:
 *   open google.com home → type into the search box → Enter
 * (NOT bot-style /search?q=...&nfpr=1&pws=0&uule=... which trips /sorry more on mobile.)
 *
 * Fallback only if the box is missing: simple /search?q=...&source=hp (minimal params).
 */
export async function searchKeywordNatural(
  session: BrowserSession,
  config: AppConfig,
  keyword: string,
  opts: NaturalSearchOptions = {}
): Promise<SerpNavResult> {
  const page = session.page;
  const device = opts.device ?? "mobile";
  const home = `https://${config.google.domain}/?hl=${config.google.hl}&gl=${config.google.gl}`;

  logger.info(
    { keyword, device, home },
    "natural Google search (mobile-style): home → type query → Enter"
  );

  await page
    .goto(home, { waitUntil: "domcontentloaded", timeout: config.scan.navTimeoutMs })
    .catch((err) => {
      logger.debug({ err: String(err) }, "google home goto did not fully settle");
    });
  await tryDismissConsent(page);
  await sleep(device === "mobile" ? 2000 : 1200);

  // Mobile homepage sometimes needs a light scroll before the search field paints.
  if (device === "mobile") {
    await page.evaluate(() => window.scrollBy(0, 40)).catch(() => {});
    await sleep(400);
  }

  let typedOk = false;
  try {
    const box = page
      .locator(
        'textarea[name="q"], input[name="q"], textarea.gLFyf, input.gLFyf, form[role="search"] textarea, form[role="search"] input[type="search"], form[role="search"] input[type="text"]'
      )
      .first();
    const n = await box.count();
    if (n > 0) {
      await box.click({ timeout: 5000 }).catch(() => {});
      await sleep(350);
      // Clear any prefilled / suggestion state
      await box.fill("").catch(() => {});
      await sleep(200);
      // Human-ish typing (mobile keyboard pace)
      await box.pressSequentially(keyword, { delay: device === "mobile" ? 55 : 40 }).catch(async () => {
        // Older Playwright fallback
        await box.type(keyword, { delay: device === "mobile" ? 55 : 40 });
      });
      await sleep(600);
      await page.keyboard.press("Enter");
      await page.waitForLoadState("domcontentloaded", { timeout: 25_000 }).catch(() => {});
      await sleep(1500);
      if (isSearchNavigation(page.url()) || (await pageLooksLikeCaptcha(page))) {
        typedOk = true;
        logger.info(
          { keyword, device, url: page.url().slice(0, 160) },
          "natural search via homepage box (normal mobile Google)"
        );
      }
    } else {
      logger.warn({ keyword, device, url: page.url().slice(0, 120) }, "search box not found on Google home");
    }
  } catch (err) {
    logger.warn({ err: String(err), keyword }, "natural type-search failed");
  }

  if (!typedOk) {
    // Minimal human-like SERP URL — no nfpr/pws/uule bot signature
    const dest = new URL(`https://${config.google.domain}/search`);
    dest.searchParams.set("q", keyword);
    dest.searchParams.set("hl", config.google.hl);
    dest.searchParams.set("gl", config.google.gl);
    dest.searchParams.set("source", "hp");
    logger.info(
      { keyword, device, dest: dest.toString().slice(0, 140) },
      "natural search fallback: simple /search?q=...&source=hp"
    );
    await page
      .goto(dest.toString(), { waitUntil: "domcontentloaded", timeout: config.scan.navTimeoutMs })
      .catch((err) => {
        logger.debug({ err: String(err) }, "simple SERP goto failed");
      });
  }

  return finishSerpNav(page, config, opts, {
    mode: typedOk ? "home-type" : "simple-search",
    keyword,
    device,
  });
}

/**
 * Let the SERP settle and force top + bottom ads to paint.
 * Mobile Google often lazy-loads ad slots; a single fast scroll is not enough.
 * @param light — short settle only (no full-page thrash). Use for re-search pass.
 */
async function settleSerp(page: Page, opts: { light?: boolean } = {}): Promise<void> {
  await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
  // Organic results first — if #search never appears we still continue.
  await page
    .waitForSelector("#search, #rso, #main, [data-async-context], #center_col", { timeout: 12_000 })
    .catch(() => {});
  // Brief pause at top so top-of-page text ads can attach before we scroll away.
  await sleep(opts.light ? 900 : 1_500);
  await waitForAdMarkers(page, opts.light ? 3_000 : 4_000);

  if (opts.light) {
    // One gentle mid-page peek for bottom/lazy ads — not full bottom→top thrash.
    await page.evaluate(() => window.scrollBy(0, Math.min(900, Math.floor(window.innerHeight * 1.2)))).catch(() => {});
    await sleep(700);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await sleep(600);
    await waitForAdMarkers(page, 2_500);
    return;
  }

  await autoScroll(page);
  // After bottom paint, return top and wait again — top ads are the primary betting slot.
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await sleep(1_200);
  await waitForAdMarkers(page, 5_000);
  await sleep(800);
}

/** Wait until Google has injected at least one ad marker (or timeout). */
async function waitForAdMarkers(page: Page, timeoutMs: number): Promise<boolean> {
  try {
    await page.waitForFunction(
      () => {
        if (document.querySelector("[data-text-ad]")) return true;
        if (document.querySelector('a[href*="/aclk?"], a[href*="googleadservices.com"]')) return true;
        if (document.querySelector("#tads, #tvcap, #taw, #bottomads, #tadsb")) return true;
        // Localised badges (TR mobile often uses "Sponsorlu" without data-text-ad immediately).
        const nodes = document.querySelectorAll("span, div");
        for (let i = 0; i < Math.min(nodes.length, 400); i++) {
          const t = (nodes[i]?.textContent || "").trim();
          if (t === "Sponsorlu" || t === "Sponsored" || t === "Reklam" || t === "Ücretli sponsorlu reklam") {
            return true;
          }
        }
        return false;
      },
      { timeout: timeoutMs }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Extra settle + re-parse prep after a zero-ad result.
 * Does not navigate away — only scrolls and waits for late ad injection.
 */
export type HomepageTrend = { text: string; id: string; href: string };

/**
 * Live "Trend olan aramalar" items. Prefers real <a href="/search?q=..."> nodes.
 * Mobile home usually exposes a trend list; desktop often only shows trends after
 * the search box is focused (suggestion / "trending" panel) — caller should call
 * revealHomepageTrends first when the list is empty.
 */
export async function listHomepageTrends(page: Page): Promise<HomepageTrend[]> {
  return page.evaluate(() => {
    const out: Array<{ text: string; id: string; href: string }> = [];
    const seen = new Set<string>();

    function cleanText(raw: string): string {
      return (raw || "")
        .replace(/\s+/g, " ")
        .trim()
        .split("\n")[0]!
        .replace(/^\d+\s*/, "") // strip leading rank numbers on desktop
        .trim();
    }

    function add(el: Element, text: string, href: string) {
      const t = cleanText(text);
      if (!t || t.length < 2 || t.length > 120) return;
      if (
        /trend olan|trending searches|trends for you|türkiye'?de|koyu tema|ayarlar|gizlilik|şartlar|reklam|işletme|hakkında|google|oturum|giriş yap|images|haritalar|haberler|videolar|daha fazla|all|maps|news|shopping|finance|gmail|search labs/i.test(
          t
        )
      ) {
        return;
      }
      // Desktop chrome / long multi-line blobs
      if (t.split(" ").length > 14) return;
      const key = t.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const id = `trend-pick-${out.length}`;
      el.setAttribute("data-trend-pick", id);
      let h = href || "";
      if (!h && el instanceof HTMLAnchorElement) h = el.href || el.getAttribute("href") || "";
      if (!h) {
        const a = el.closest("a") || el.querySelector("a");
        if (a) h = (a as HTMLAnchorElement).href || a.getAttribute("href") || "";
      }
      out.push({ text: t, id, href: h });
    }

    // A) Links that look like trend / suggestion search URLs
    for (const a of document.querySelectorAll<HTMLAnchorElement>("a[href*='/search']")) {
      const href = a.href || a.getAttribute("href") || "";
      if (!/[?&]q=/.test(href) && !href.includes("/search?q=")) continue;
      // Desktop header nav can hold /search links — keep body / main / listbox only when sparse
      if (a.closest("footer")) continue;
      const t = cleanText(a.innerText || a.textContent || a.getAttribute("aria-label") || "");
      if (t.length >= 3) add(a, t, a.href || href);
    }

    // B) Desktop autocomplete / trending dropdown (role=option | listbox | presentation)
    for (const el of document.querySelectorAll<HTMLElement>(
      "[role='option'], [role='listbox'] li, ul[role='listbox'] > li, div[role='presentation'] li, .G43f7e li, .aajZCb li, .erkvQe li"
    )) {
      const t = cleanText(el.innerText || el.textContent || el.getAttribute("aria-label") || "");
      if (t.length < 3) continue;
      const a = el.closest("a") || el.querySelector("a");
      const href = a ? (a as HTMLAnchorElement).href || "" : "";
      add(a || el, t, href);
    }

    // C) Section under "Trend olan aramalar" / "Trending searches" heading (mobile + desktop)
    if (out.length < 3) {
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let heading: Element | null = null;
      while (walk.nextNode()) {
        const el = walk.currentNode as Element;
        const tx = (el.textContent || "").trim();
        if (
          el.childElementCount < 8 &&
          tx.length < 64 &&
          /trend olan aramalar|trending searches|trends for you|türkiye'?de trend/i.test(tx)
        ) {
          heading = el;
          break;
        }
      }
      if (heading) {
        let root: Element | null = heading.parentElement;
        for (let d = 0; d < 8 && root; d++) {
          const candidates = root.querySelectorAll(
            "a, div[role='link'], li, [jsname], [role='option'], [data-entityname]"
          );
          let n = 0;
          for (const c of candidates) {
            const t = cleanText((c as HTMLElement).innerText || c.textContent || "");
            if (t.length < 3 || t.length > 100) continue;
            if (/trend olan|trending/i.test(t)) continue;
            const a = c.tagName === "A" ? c : c.querySelector("a") || c.closest("a");
            const href = a ? (a as HTMLAnchorElement).href || "" : "";
            add(a || c, t, href);
            n++;
          }
          if (n >= 3) break;
          root = root.parentElement;
        }
      }
    }

    return out.slice(0, 12);
  });
}

/**
 * Desktop Google often hides trends until the search box is focused.
 * Mobile may still benefit from a light focus+scroll. Non-fatal if box missing.
 */
async function revealHomepageTrends(page: Page): Promise<void> {
  try {
    const focused = await page.evaluate(() => {
      const box =
        (document.querySelector('textarea[name="q"]') as HTMLElement | null) ||
        (document.querySelector('input[name="q"]') as HTMLElement | null) ||
        (document.querySelector('textarea[aria-label*="Ara"], textarea[aria-label*="Search"], input[aria-label*="Ara"], input[aria-label*="Search"]') as HTMLElement | null) ||
        (document.querySelector("textarea.gLFyf, input.gLFyf") as HTMLElement | null);
      if (!box) return false;
      box.scrollIntoView({ block: "center", inline: "nearest" });
      box.click();
      box.focus();
      // Fire events so Google paints the suggestion / trending panel
      box.dispatchEvent(new Event("focus", { bubbles: true }));
      box.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      box.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return true;
    });
    if (focused) {
      await sleep(1200);
      // Nudge: empty query sometimes needs a tiny input event for desktop panel
      await page.keyboard.press("ArrowDown").catch(() => {});
      await sleep(600);
    }
    await page.evaluate(() => window.scrollBy(0, 180)).catch(() => {});
    await sleep(500);
  } catch {
    /* ignore */
  }
}

/**
 * When live trends are missing (common on desktop homepage), open a soft
 * non-brand query so the session still gets a real SERP trust path.
 * Prefer typing into the homepage search box (human-like); fall back to assign.
 */
async function softWarmupKeywordSearch(
  page: Page,
  config: AppConfig,
  soft = "hava durumu"
): Promise<{ ok: boolean; trend: string }> {
  rememberTrend(soft);
  logger.info({ soft }, "desktop/soft warm-up: no live trends — opening soft SERP");

  // 1) Type into homepage search box when still on home
  try {
    const onHome = !isSearchNavigation(page.url());
    if (onHome) {
      const box =
        page.locator('textarea[name="q"], input[name="q"], textarea.gLFyf, input.gLFyf').first();
      if ((await box.count()) > 0) {
        await box.click({ timeout: 4000 }).catch(() => {});
        await sleep(400);
        await box.fill("");
        await box.type(soft, { delay: 45 });
        await sleep(500);
        await page.keyboard.press("Enter");
        await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
        await sleep(1500);
        if (isSearchNavigation(page.url())) {
          logger.info({ soft, url: page.url().slice(0, 140) }, "soft warm-up via search box");
          return { ok: true, trend: soft };
        }
      }
    }
  } catch (err) {
    logger.debug({ err: String(err) }, "soft warm-up type path failed");
  }

  // 2) Direct assign (same as trend path — not a silent home reload)
  const dest = trendSearchUrl(config, soft);
  try {
    await Promise.race([
      page.evaluate((url) => {
        window.location.assign(url);
      }, dest),
      sleep(3000),
    ]);
    await sleep(1500);
  } catch {
    /* goto below */
  }
  if (!isSearchNavigation(page.url())) {
    await page.goto(dest, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((err) => {
      logger.warn({ err: String(err) }, "soft warm-up page.goto failed");
    });
    await sleep(1500);
  }
  const ok = isSearchNavigation(page.url());
  logger.info(
    { soft, ok, url: page.url().slice(0, 140) },
    ok ? "soft warm-up search open" : "soft warm-up search FAILED"
  );
  return { ok, trend: soft };
}

function isSearchNavigation(url: string): boolean {
  return /\/search|\/sorry|[?&]q=/.test(url);
}

/** Process-local: avoid hammering the same trend query across many IPs in one recovery pass. */
const recentTrendQueries: string[] = [];
const RECENT_TREND_CAP = 12;

function normTrend(s: string): string {
  return s
    .toLowerCase()
    .split(" — ")[0]!
    .replace(/\s+/g, " ")
    .trim();
}

function takeRecentTrends(): Set<string> {
  return new Set(recentTrendQueries.map(normTrend));
}

function rememberTrend(text: string): void {
  const k = normTrend(text);
  if (!k) return;
  recentTrendQueries.push(k);
  while (recentTrendQueries.length > RECENT_TREND_CAP) recentTrendQueries.shift();
}

/** Build the same URL Google would open for a homepage trend string. */
function trendSearchUrl(config: AppConfig, trendText: string, hrefHint?: string): string {
  if (hrefHint && /[?&]q=/.test(hrefHint)) {
    try {
      const u = new URL(hrefHint, `https://${config.google.domain}`);
      u.searchParams.set("hl", config.google.hl);
      u.searchParams.set("gl", config.google.gl);
      return u.toString();
    } catch {
      /* fall through */
    }
  }
  const u = new URL(`https://${config.google.domain}/search`);
  u.searchParams.set("q", trendText);
  u.searchParams.set("hl", config.google.hl);
  u.searchParams.set("gl", config.google.gl);
  u.searchParams.set("source", "hp");
  return u.toString();
}

/**
 * Open a LIVE homepage trend as a real Google search.
 *
 * AdsPower/CDP synthetic clicks often only show a ripple and never navigate.
 * Reliable path: read trend text/href from the homepage list, then page.goto
 * that query (same q the trend represents — NOT a fixed "hava durumu").
 */
export async function clickHomepageTrend(
  page: Page,
  pick: HomepageTrend,
  config?: AppConfig
): Promise<boolean> {
  const cfg =
    config ??
    ({
      google: { domain: "www.google.com", hl: "tr", gl: "tr" },
    } as AppConfig);

  // Prefer live anchor href from the marked node (no long waits / no mouse hang)
  let liveHref = pick.href || "";
  try {
    const h = await Promise.race([
      page.evaluate((id) => {
        const el = document.querySelector(`[data-trend-pick="${id}"]`);
        if (!el) return "";
        const a =
          el.closest("a") ||
          (el.tagName === "A" ? el : null) ||
          el.querySelector("a");
        return a ? (a as HTMLAnchorElement).href || "" : "";
      }, pick.id),
      sleep(2000).then(() => ""),
    ]);
    if (h) liveHref = h;
  } catch {
    /* keep pick.href */
  }

  const qText = (pick.text.split(" — ")[0] || pick.text).trim();
  const dest = trendSearchUrl(cfg, qText, liveHref);

  logger.info(
    { trend: qText, dest: dest.slice(0, 180), hasHref: !!liveHref },
    "trend → direct search navigation (no synthetic click)"
  );

  // In-page assign first (keeps same browsing context / referrer-ish behavior)
  try {
    await Promise.race([
      page.evaluate((url) => {
        window.location.assign(url);
      }, dest),
      sleep(3000),
    ]);
    await sleep(1500);
  } catch {
    /* goto below */
  }

  if (isSearchNavigation(page.url())) {
    logger.info({ trend: qText, url: page.url().slice(0, 140) }, "trend navigated via location.assign");
    return true;
  }

  // Hard navigation — always leaves the blank homepage stare
  await page.goto(dest, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((err) => {
    logger.warn({ err: String(err), dest: dest.slice(0, 100) }, "trend page.goto failed");
  });
  await sleep(1500);

  const ok = isSearchNavigation(page.url());
  logger.info(
    { trend: qText, ok, url: page.url().slice(0, 140) },
    ok ? "trend search open" : "trend search FAILED"
  );
  return ok;
}

/**
 * Human-like recovery entry: Google home → live trend (or soft SERP fallback) → solve /sorry if shown.
 *
 * Desktop TR homepage often has NO visible "Trend olan aramalar" list until the search box
 * is focused — without that we used to only reload home and mark captcha=true (skip profile).
 * Now: reveal trends → list → navigate; if still empty and not captcha, soft keyword SERP.
 */
export async function recoverViaTrendClick(
  session: BrowserSession,
  config: AppConfig,
  opts: SerpNavOptions = {}
): Promise<SerpNavResult & { trend?: string }> {
  const page = session.page;
  await page
    .goto(`https://${config.google.domain}/?hl=${config.google.hl}&gl=${config.google.gl}`, {
      waitUntil: "domcontentloaded",
      timeout: config.scan.navTimeoutMs,
    })
    .catch(() => {});
  await tryDismissConsent(page);
  await sleep(2500);

  // Mobile: light scroll. Desktop: focus search box so trending/suggestions paint.
  await page.evaluate(() => window.scrollBy(0, 120)).catch(() => {});
  await sleep(600);
  await revealHomepageTrends(page);

  let trends = await listHomepageTrends(page);
  if (trends.length < 2) {
    // webhp + focus again (desktop sometimes paints trends only here)
    await page
      .goto(`https://${config.google.domain}/webhp?hl=${config.google.hl}&gl=${config.google.gl}`, {
        waitUntil: "domcontentloaded",
        timeout: config.scan.navTimeoutMs,
      })
      .catch(() => {});
    await tryDismissConsent(page);
    await sleep(2200);
    await revealHomepageTrends(page);
    trends = await listHomepageTrends(page);
  }

  let pickText = "";

  if (!trends.length) {
    // Diagnostic: was it captcha, or just desktop UI without trend module?
    const wall = await pageLooksLikeCaptcha(page);
    const diag = await page
      .evaluate(() => ({
        url: location.href.slice(0, 120),
        title: document.title,
        w: window.innerWidth,
        h: window.innerHeight,
        hasQ:
          !!document.querySelector('textarea[name="q"], input[name="q"], textarea.gLFyf, input.gLFyf'),
        bodySample: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 160),
      }))
      .catch(() => null);
    logger.warn(
      { wall, diag },
      "no homepage trends found — will soft-search if not captcha wall"
    );

    if (wall) {
      // Real wall on home: try solve on current page (rare on pure home)
      const captchaSolved = await attemptCaptchaSolve(page, config, opts.captchaProxy, opts.profileId);
      if (!captchaSolved) {
        return { captcha: true, captchaSolved: false, finalUrl: page.url(), trend: "" };
      }
      // After solve land, try soft path for SERP trust
    }

    const soft = await softWarmupKeywordSearch(page, config, "hava durumu");
    if (!soft.ok) {
      // Soft path also failed to leave homepage — do not burn brand keyword.
      return {
        captcha: true,
        captchaSolved: false,
        finalUrl: page.url(),
        trend: soft.trend,
      };
    }
    pickText = soft.trend;
  } else {
    // NEVER always the same trend — shuffle among non-recent
    const recent = takeRecentTrends();
    const fresh = trends.filter((t) => !recent.has(normTrend(t.text)));
    const pool = fresh.length ? fresh : trends;
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    let pick = shuffled[0]!;
    rememberTrend(pick.text);
    logger.info(
      {
        trend: pick.text,
        n: trends.length,
        pool: pool.length,
        avoidedRecent: recent.size,
        hasHref: !!pick.href,
        order: shuffled.map((t) => t.text),
      },
      "recovery: activating live trend search (randomized, de-duplicated)"
    );

    let clicked = await clickHomepageTrend(page, pick, config);
    if (!clicked) {
      for (const alt of shuffled.slice(1, 4)) {
        logger.info({ trend: alt.text }, "retry with different randomized trend");
        if (!isSearchNavigation(page.url())) {
          const again = await listHomepageTrends(page);
          const match =
            again.find((t) => t.text === alt.text) ||
            again.find((t) => t.text.includes(alt.text.slice(0, 12)));
          if (match) {
            clicked = await clickHomepageTrend(page, match, config);
            if (clicked) {
              pick = match;
              break;
            }
          } else {
            clicked = await clickHomepageTrend(page, alt, config);
            if (clicked) {
              pick = alt;
              break;
            }
          }
        }
      }
    }

    if (!clicked) {
      // Desktop often "finds" pseudo-trends without navigable href — fall soft, don't spin home.
      logger.warn(
        { trend: pick.text },
        "trend activation failed (no navigation) — soft warm-up fallback"
      );
      const soft = await softWarmupKeywordSearch(page, config, "hava durumu");
      if (!soft.ok) {
        return { captcha: true, captchaSolved: false, finalUrl: page.url(), trend: pick.text };
      }
      pickText = soft.trend;
    } else {
      pickText = pick.text;
    }
  }

  await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
  await sleep(2000);
  await settleSerp(page);

  let captcha = await pageLooksLikeCaptcha(page);
  let captchaSolved = false;
  if (captcha) {
    logger.warn(
      { trend: pickText, hasProxy: !!opts.captchaProxy },
      "captcha after trend/soft warm-up — solving (natural entry path)"
    );
    captchaSolved = await attemptCaptchaSolve(page, config, opts.captchaProxy, opts.profileId);
    if (captchaSolved) {
      await settleSerp(page);
      if (!(await isRealSerp(page))) {
        captchaSolved = false;
      } else {
        await logAbuseExemption(page, "trend-click-solved");
      }
    }
    captcha = !captchaSolved;
  }

  return {
    captcha,
    captchaSolved,
    finalUrl: page.url(),
    trend: pickText,
  };
}

export async function settleSerpForAds(page: Page, opts: { light?: boolean } = {}): Promise<void> {
  await settleSerp(page, opts);
}

/** Type into the visible Google search box (home or SERP). */
async function typeIntoGoogleSearchBox(
  page: Page,
  keyword: string,
  opts: { device?: "mobile" | "desktop"; clearFirst?: boolean } = {}
): Promise<boolean> {
  const device = opts.device ?? "mobile";
  const clearFirst = opts.clearFirst !== false;
  const box = page
    .locator(
      'textarea[name="q"], input[name="q"], textarea.gLFyf, input.gLFyf, form[role="search"] textarea, form[role="search"] input[type="search"], form[role="search"] input[type="text"]'
    )
    .first();
  if ((await box.count()) === 0) return false;
  await box.click({ timeout: 5000 }).catch(() => {});
  await sleep(300);
  if (clearFirst) {
    // Select-all + delete feels more human than fill("") on mobile SERP
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
    await sleep(120);
    await page.keyboard.press("Backspace").catch(() => {});
    await box.fill("").catch(() => {});
    await sleep(200);
  }
  await box.pressSequentially(keyword, { delay: device === "mobile" ? 55 : 40 }).catch(async () => {
    await box.type(keyword, { delay: device === "mobile" ? 55 : 40 });
  });
  await sleep(500);
  await page.keyboard.press("Enter");
  await page.waitForLoadState("domcontentloaded", { timeout: 25_000 }).catch(() => {});
  await sleep(1400);
  return isSearchNavigation(page.url()) || (await pageLooksLikeCaptcha(page));
}

/**
 * Click Google "Görseller" / Images tab (mobile + desktop header chips).
 */
async function clickImagesTab(page: Page): Promise<boolean> {
  // Prefer role/name (TR + EN)
  for (const name of [/görseller/i, /^images$/i, /images/i]) {
    try {
      const link = page.getByRole("link", { name }).first();
      if (await link.count()) {
        await link.click({ timeout: 5000 });
        await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
        await sleep(1200);
        logger.info({ url: page.url().slice(0, 140) }, "clicked Görseller / Images tab");
        return true;
      }
    } catch {
      /* try next */
    }
  }
  // href fallback
  try {
    const a = page.locator('a[href*="tbm=isch"]').first();
    if (await a.count()) {
      await a.click({ timeout: 5000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
      await sleep(1200);
      logger.info({ url: page.url().slice(0, 140) }, "clicked Images via tbm=isch href");
      return true;
    }
  } catch {
    /* fall through */
  }
  logger.warn({ url: page.url().slice(0, 120) }, "Görseller / Images tab not found");
  return false;
}

/** True when current page is (or looks like) Google Images results. */
function looksLikeImagesResults(url: string): boolean {
  return /tbm=isch|udm=2|\/imghp|images\.google|imgres|visual_search/i.test(url);
}

/**
 * After Görseller re-query we STAY on Images by default — must explicitly open Tümü.
 * Always try the chip/tab click; URL heuristics alone miss mobile `udm=2` Images.
 */
async function clickAllResultsTab(page: Page, opts: { force?: boolean } = {}): Promise<boolean> {
  const force = opts.force !== false; // default force after images path
  const before = page.url();

  if (!force && !looksLikeImagesResults(before)) {
    return true;
  }

  logger.info({ url: before.slice(0, 140), force }, "switching to Tümü / All (leave Görseller)");

  // 1) Role / accessible name (TR + EN), including tab role on some UIs
  const namePatterns = [/^tümü$/i, /^all$/i, /^tumu$/i, /tümü/i, /^all results$/i, /^web$/i];
  for (const role of ["link", "tab", "button"] as const) {
    for (const name of namePatterns) {
      try {
        const el = page.getByRole(role, { name }).first();
        if (await el.count()) {
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await el.click({ timeout: 5000 });
          await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
          await sleep(1200);
          const after = page.url();
          if (!looksLikeImagesResults(after) || after !== before) {
            logger.info({ url: after.slice(0, 140), role }, "clicked Tümü / All tab");
            return true;
          }
        }
      } catch {
        /* try next */
      }
    }
  }

  // 2) Chip strip: text content match (mobile often not proper role)
  try {
    const clicked = await page.evaluate(() => {
      const labels = ["tümü", "tumu", "all", "all results", "web"];
      const nodes = Array.from(
        document.querySelectorAll("a, button, div[role='tab'], span[role='link'], g-tabs a, [data-hveid] a")
      );
      for (const el of nodes) {
        const t = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (!t || t.length > 24) continue;
        if (!labels.some((l) => t === l || t.startsWith(l))) continue;
        // Prefer chips near top (not footer)
        const r = (el as HTMLElement).getBoundingClientRect?.();
        if (r && r.top > 220) continue;
        (el as HTMLElement).click();
        return t;
      }
      return "";
    });
    if (clicked) {
      await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
      await sleep(1200);
      logger.info({ clicked, url: page.url().slice(0, 140) }, "clicked Tümü via text chip");
      if (!looksLikeImagesResults(page.url())) return true;
    }
  } catch {
    /* fall through */
  }

  // 3) Prefer href without tbm=isch / udm=2 that keeps same q
  try {
    const href = await page.evaluate(() => {
      const q = new URL(location.href).searchParams.get("q") || "";
      const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href*='/search']"));
      for (const a of anchors) {
        const h = a.href || "";
        if (!h.includes("/search")) continue;
        if (/tbm=isch|udm=2/i.test(h)) continue;
        if (q && !h.includes(encodeURIComponent(q)) && !h.includes(q.replace(/ /g, "+"))) continue;
        const t = (a.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (/tümü|tumu|^all$|web/.test(t) || a.getAttribute("aria-selected") === "false") {
          return h;
        }
      }
      // Any top chip link to plain /search?q=
      for (const a of anchors) {
        const h = a.href || "";
        if (/\/search\?/.test(h) && !/tbm=isch|udm=2/i.test(h) && /[?&]q=/.test(h)) {
          const r = a.getBoundingClientRect();
          if (r.top >= 0 && r.top < 200) return h;
        }
      }
      return "";
    });
    if (href) {
      await page.goto(href, { waitUntil: "domcontentloaded", timeout: 25_000 }).catch(() => {});
      await sleep(1200);
      logger.info({ url: page.url().slice(0, 140) }, "navigated to Tümü via chip href");
      if (!looksLikeImagesResults(page.url())) return true;
    }
  } catch {
    /* fall through */
  }

  // 4) Hard URL rebuild: same q, web SERP (no images params)
  try {
    const u = new URL(page.url());
    const q = u.searchParams.get("q") || "";
    if (!q) return false;
    const dest = new URL(`https://${u.hostname}/search`);
    dest.searchParams.set("q", q);
    dest.searchParams.set("hl", u.searchParams.get("hl") || "tr");
    dest.searchParams.set("gl", u.searchParams.get("gl") || "tr");
    // deliberately no tbm / udm
    await page.goto(dest.toString(), { waitUntil: "domcontentloaded", timeout: 25_000 }).catch(() => {});
    await sleep(1200);
    const ok = !looksLikeImagesResults(page.url());
    logger.info({ ok, url: page.url().slice(0, 140) }, "Tümü via rebuilt /search?q= (no images params)");
    return ok;
  } catch {
    return false;
  }
}

/**
 * Human re-search path (especially mobile), as practiced manually:
 *   on brand SERP → click Görseller → clear search box → type brand → Enter
 *   then MUST click Tümü (stays on Images otherwise) so text ads can be parsed.
 * Pass 2 and pass 3 both use this same step.
 */
export async function reSearchViaImagesRetype(
  session: BrowserSession,
  config: AppConfig,
  keyword: string,
  opts: NaturalSearchOptions = {}
): Promise<SerpNavResult> {
  const page = session.page;
  const device = opts.device ?? "mobile";
  logger.info(
    { keyword, device, url: page.url().slice(0, 120) },
    "re-search: Görseller → clear box → type brand → Enter → Tümü"
  );

  // Need to be on a Google results page; if not, open brand once first
  if (!/google\./i.test(page.url()) || page.url().includes("/sorry/")) {
    if (page.url().includes("/sorry/")) {
      return finishSerpNav(page, config, opts, { mode: "images-retype-blocked", keyword, device });
    }
    await searchKeywordNatural(session, config, keyword, { ...opts, device });
    if (await pageLooksLikeCaptcha(page)) {
      return finishSerpNav(page, config, opts, { mode: "images-retype-pre", keyword, device });
    }
  }

  const imagesOk = await clickImagesTab(page);
  if (!imagesOk) {
    // Fallback: still retype on current SERP box
    logger.info({ keyword }, "Images tab miss — retype brand on current SERP box");
  }
  await sleep(800);

  const typed = await typeIntoGoogleSearchBox(page, keyword, { device, clearFirst: true });
  if (!typed) {
    logger.warn({ keyword }, "retype in search box failed — soft natural search fallback");
    return searchKeywordNatural(session, config, keyword, { ...opts, device });
  }

  // CRITICAL: after Görseller retype we remain on Images — always open Tümü next
  await sleep(600);
  const allOk = await clickAllResultsTab(page, { force: true });
  if (!allOk) {
    logger.warn(
      { keyword, url: page.url().slice(0, 140) },
      "Tümü click failed — still on Görseller; ad parse may miss"
    );
  } else {
    logger.info({ keyword, url: page.url().slice(0, 140) }, "Tümü OK — web SERP ready for ads");
  }

  await settleSerp(page, { light: true });
  return finishSerpNav(page, config, opts, {
    mode: imagesOk ? (allOk ? "images-retype-all" : "images-retype-stuck") : "serp-retype",
    keyword,
    device,
  });
}

/**
 * Visible second/third search when first SERP had 0 ads.
 * Mobile (user path): Görseller → sil → markayı yaz → ara (pass 2 ve 3 aynı).
 * Desktop: home → type (or simple /search).
 */
export async function reSearchKeyword(
  session: BrowserSession,
  config: AppConfig,
  keyword: string,
  opts: NaturalSearchOptions = {}
): Promise<SerpNavResult> {
  const device = opts.device ?? "mobile";
  if (device === "mobile") {
    logger.info(
      { keyword, device },
      "0 ads — mobile re-search: Görseller → clear → brand → Enter → Tümü"
    );
    return reSearchViaImagesRetype(session, config, keyword, { ...opts, device: "mobile" });
  }
  logger.info(
    { keyword, device },
    "0 ads — desktop re-search: home → type → Enter"
  );
  const nav = await searchKeywordNatural(session, config, keyword, { ...opts, device });
  await settleSerp(session.page, { light: true });
  return nav;
}

/** Scroll to the bottom so bottom-of-page ads and lazy content render. */
async function autoScroll(page: Page): Promise<void> {
  try {
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        let total = 0;
        const step = 280;
        const timer = setInterval(() => {
          window.scrollBy(0, step);
          total += step;
          const max = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
          if (total >= max - window.innerHeight || total > 12_000) {
            clearInterval(timer);
            resolve();
          }
        }, 180);
      });
    });
    // Pause at bottom so IntersectionObserver ads can fire.
    await sleep(900);
  } catch {
    /* ignore */
  }
}
