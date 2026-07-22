import type { Page } from "playwright-core";
import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";
import { sleep } from "../util/time.js";

export interface CloudflarePassOpts {
  /** Optional proxy for CapSolver: user:pass@host:port */
  proxy?: string;
  proxytype?: "HTTP" | "HTTPS" | "SOCKS4" | "SOCKS5";
  timeoutMs?: number;
  /** Where detect.sqlite lives (solver cost logging). */
  outputDir?: string;
}

/**
 * Detect Cloudflare interstitial / Turnstile checkbox pages.
 * "Bir dakika lütfen..." / "Just a moment..." / doğrulama kutusu.
 */
export async function pageLooksLikeCloudflare(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    if (/challenges\.cloudflare\.com|cdn-cgi\/challenge|cf-browser-verification/i.test(url)) return true;
    return await page.evaluate(() => {
      const title = document.title || "";
      const t = `${title} ${(document.body?.innerText || "").slice(0, 2500)}`;
      if (/just a moment|checking your browser|verify you are human|bir dakika lütfen|güvenlik kontrolü|cloudflare/i.test(t)) {
        return true;
      }
      if (document.querySelector("#challenge-form, #cf-challenge-running, .cf-turnstile, [name='cf-turnstile-response']")) {
        return true;
      }
      if (document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]')) {
        return true;
      }
      return false;
    });
  } catch {
    return false;
  }
}

/** CapSolver proxy string. Prefer socks5:ip:port:user:pass for AdsPower SOCKS5 ISP. */
function formatCapSolverProxy(opts: CloudflarePassOpts): string | null {
  if (!opts.proxy) return null;
  const raw = opts.proxy.trim();
  const ptype = (opts.proxytype || "SOCKS5").toLowerCase();
  // already typed
  if (/^(socks5|socks4|http|https):/i.test(raw)) return raw;
  // host:port:user:pass
  if (/^[^:@]+:\d+:[^:]+:.+$/.test(raw) && !raw.includes("@")) {
    return `${ptype}:${raw}`;
  }
  // user:pass@host:port
  const m = raw.match(/^(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$/);
  if (!m) return raw;
  const [, user, pass, host, port] = m;
  if (user != null && user !== "") return `${ptype}:${host}:${port}:${user}:${pass ?? ""}`;
  return `${ptype}:${host}:${port}`;
}

/** Turnstile keys look like 0x4AAAAA... — reject garbage from HTML noise. */
function isValidTurnstileSitekey(k: string | null | undefined): k is string {
  if (!k || k.length < 20 || k.length > 80) return false;
  return /^0x[0-9A-Za-z_-]{10,}$/.test(k);
}

async function extractTurnstileSitekey(page: Page): Promise<string | null> {
  try {
    const raw = await page.evaluate(() => {
      const el =
        document.querySelector(".cf-turnstile[data-sitekey]") ||
        document.querySelector("[data-sitekey]") ||
        document.querySelector("div[data-sitekey]");
      const k = el?.getAttribute("data-sitekey");
      if (k) return k;
      const html = document.documentElement?.innerHTML || "";
      const m1 = html.match(/data-sitekey=["'](0x[0-9A-Za-z_-]{10,})["']/i);
      if (m1?.[1]) return m1[1];
      const m2 = html.match(/sitekey["']?\s*[:=]\s*["'](0x[0-9A-Za-z_-]{10,})["']/i);
      if (m2?.[1]) return m2[1];
      for (const iframe of document.querySelectorAll("iframe[src]")) {
        const src = (iframe as HTMLIFrameElement).src || "";
        const m = src.match(/[?&](?:sitekey|k)=(0x[0-9A-Za-z_-]+)/i);
        if (m?.[1]) return decodeURIComponent(m[1]);
      }
      return null;
    });
    return isValidTurnstileSitekey(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** CapSolver AntiCloudflare only accepts Windows Chrome UA. */
const CAPSOLVER_CF_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function forceWindowsChromeUa(page: Page): Promise<void> {
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setUserAgentOverride", {
      userAgent: CAPSOLVER_CF_UA,
      platform: "Win32",
      acceptLanguage: "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
    });
    await cdp.send("Network.setUserAgentOverride", {
      userAgent: CAPSOLVER_CF_UA,
      acceptLanguage: "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
      platform: "Win32",
    });
    await cdp.detach().catch(() => {});
  } catch (err) {
    logger.warn({ err: String(err) }, "could not override UA to Windows Chrome for CF");
  }
}

/** Race helper: CDP mouse occasionally stalls on emulated sessions — never hang. */
async function withRace<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, sleep(ms).then(() => fallback)]);
}

/**
 * Human-feeling mouse click: approach along a stepped path from a plausible
 * previous position, pause, press with a human hold time. Plain CDP
 * locator.click() teleports the cursor — Turnstile flags exactly that.
 */
async function humanMouseClick(page: Page, x: number, y: number): Promise<void> {
  const startX = Math.max(8, x - 100 - Math.random() * 220);
  const startY = Math.max(8, y - 60 - Math.random() * 160);
  await page.mouse.move(startX, startY, { steps: 5 }).catch(() => {});
  await page.mouse.move(x, y, { steps: 16 + Math.floor(Math.random() * 12) }).catch(() => {});
  await sleep(140 + Math.random() * 260);
  await page.mouse.down().catch(() => {});
  await sleep(55 + Math.random() * 95);
  await page.mouse.up().catch(() => {});
}

/** Real browser: click the Turnstile checkbox if present (not main-frame body). */
async function tryClickTurnstileCheckbox(page: Page): Promise<boolean> {
  // Main-frame explicit widgets only
  for (const sel of [".cf-turnstile", ".ctp-checkbox-label", "label.cb-lb", "#challenge-stage input", 'input[type="checkbox"]']) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 700 }).catch(() => false)) {
        const bb = await loc.boundingBox().catch(() => null);
        if (bb) {
          await humanMouseClick(
            page,
            bb.x + bb.width * (0.3 + Math.random() * 0.4),
            bb.y + bb.height * (0.3 + Math.random() * 0.4)
          );
        } else {
          await loc.click({ timeout: 3000 }).catch(() => {});
        }
        await sleep(1500);
        return true;
      }
    } catch {
      /* next */
    }
  }

  // Only CF/Turnstile iframes — never click main page body
  for (const frame of page.frames()) {
    const fu = frame.url();
    if (!/challenges\.cloudflare\.com|turnstile|cdn-cgi\/challenge/i.test(fu)) continue;
    // Humanized mouse click at the checkbox inside the iframe.
    let humanClicked = false;
    for (const sel of ['input[type="checkbox"]', ".ctp-checkbox-label", "label.cb-lb", ".mark", "#challenge-stage"]) {
      try {
        const el = frame.locator(sel).first();
        if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
          const bb = await el.boundingBox().catch(() => null);
          if (bb) {
            await withRace(
              humanMouseClick(
                page,
                bb.x + bb.width * (0.3 + Math.random() * 0.4),
                bb.y + bb.height * (0.3 + Math.random() * 0.4)
              ),
              9000,
              undefined
            );
            logger.info({ frame: fu.slice(0, 90), sel }, "human-clicked CF/Turnstile checkbox");
            humanClicked = true;
            await sleep(2500);
            break;
          }
        }
      } catch {
        /* next */
      }
    }
    if (humanClicked) return true;
    // DOM click fallback — CDP mouse can stall on some emulated sessions.
    try {
      const domClicked = await frame.evaluate(() => {
        const el =
          document.querySelector('input[type="checkbox"]') ||
          document.querySelector(".ctp-checkbox-label") ||
          document.querySelector("label.cb-lb") ||
          document.querySelector(".mark");
        if (!el) return false;
        (el as HTMLElement).click();
        return true;
      });
      if (domClicked) {
        logger.info({ frame: fu.slice(0, 90) }, "DOM-clicked CF/Turnstile checkbox");
        await sleep(2500);
        return true;
      }
    } catch {
      /* fall through to locator clicks */
    }
    for (const sel of ['input[type="checkbox"]', ".ctp-checkbox-label", "label.cb-lb", "#challenge-stage", ".mark"]) {
      try {
        const el = frame.locator(sel).first();
        if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
          await el.click({ timeout: 4000 }).catch(() => {});
          logger.info({ frame: fu.slice(0, 90), sel }, "clicked Cloudflare/Turnstile checkbox in iframe");
          await sleep(2500);
          return true;
        }
      } catch {
        /* next */
      }
    }
    // center click on challenge iframe content
    try {
      const box = frame.locator("body");
      const bb = await box.boundingBox().catch(() => null);
      if (bb) {
        await page.mouse.click(bb.x + bb.width / 2, bb.y + Math.min(bb.height / 2, 80));
        logger.info({ frame: fu.slice(0, 90) }, "center-clicked CF challenge iframe");
        await sleep(2500);
        return true;
      }
    } catch {
      /* */
    }
  }

  try {
    const fl = page.frameLocator(
      'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], iframe[title*="Widget"]'
    );
    await fl.locator('input[type="checkbox"], .ctp-checkbox-label, body').first().click({ timeout: 5000 });
    logger.info("clicked CF via frameLocator");
    await sleep(2500);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilNotChallenge(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await pageLooksLikeCloudflare(page))) return true;
    await sleep(600);
  }
  return !(await pageLooksLikeCloudflare(page));
}

async function solveTurnstileCapSolver(
  apiKey: string,
  websiteURL: string,
  websiteKey: string
): Promise<string | null> {
  const task = {
    type: "AntiTurnstileTaskProxyLess",
    websiteURL,
    websiteKey,
  };
  const createRes = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: apiKey, task }),
    signal: AbortSignal.timeout(30_000),
  });
  const created = (await createRes.json()) as { errorId?: number; errorDescription?: string; taskId?: string };
  if (created.errorId || !created.taskId) {
    logger.warn({ err: created.errorDescription || created }, "CapSolver Turnstile createTask rejected");
    return null;
  }
  logger.info({ jobId: created.taskId }, "CapSolver Turnstile job accepted");

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await sleep(2500);
    const res = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId: created.taskId }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json()) as {
      status?: string;
      errorId?: number;
      errorDescription?: string;
      solution?: { token?: string };
    };
    if (json.errorId) {
      logger.warn({ err: json.errorDescription }, "CapSolver Turnstile error");
      return null;
    }
    if (json.status === "ready" && json.solution?.token) {
      logger.info({ tokenLen: json.solution.token.length }, "CapSolver Turnstile token ready");
      return json.solution.token;
    }
  }
  return null;
}

/**
 * CapSolver AntiCloudflareTask for "Just a moment..." / "Bir dakika lütfen..."
 * Returns cf_clearance cookie value. Proxy required.
 */
async function solveChallengeCapSolver(
  apiKey: string,
  websiteURL: string,
  html: string,
  userAgent: string,
  opts: CloudflarePassOpts
): Promise<{ cf_clearance: string; userAgent: string } | null> {
  const proxy = formatCapSolverProxy(opts);
  if (!proxy) {
    logger.warn("AntiCloudflareTask needs proxy — none provided");
    return null;
  }
  const task: Record<string, unknown> = {
    type: "AntiCloudflareTask",
    websiteURL,
    proxy,
    userAgent,
  };
  if (html && html.length > 100) task.html = html.slice(0, 500_000);

  const createRes = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: apiKey, task }),
    signal: AbortSignal.timeout(30_000),
  });
  const created = (await createRes.json()) as { errorId?: number; errorDescription?: string; taskId?: string };
  if (created.errorId || !created.taskId) {
    logger.warn({ err: created.errorDescription || created }, "CapSolver AntiCloudflare createTask rejected");
    return null;
  }
  logger.info({ jobId: created.taskId }, "CapSolver AntiCloudflare job accepted");

  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const res = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId: created.taskId }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json()) as {
      status?: string;
      errorId?: number;
      errorDescription?: string;
      solution?: {
        cookies?: { cf_clearance?: string };
        token?: string;
        userAgent?: string;
      };
    };
    if (json.errorId) {
      logger.warn({ err: json.errorDescription }, "CapSolver AntiCloudflare error");
      return null;
    }
    if (json.status === "ready") {
      const cf =
        json.solution?.cookies?.cf_clearance ||
        json.solution?.token ||
        "";
      if (cf) {
        logger.info({ cfLen: cf.length }, "CapSolver cf_clearance ready");
        return { cf_clearance: cf, userAgent: json.solution?.userAgent || userAgent };
      }
      return null;
    }
  }
  logger.warn("CapSolver AntiCloudflare timed out");
  return null;
}

async function injectTurnstileToken(page: Page, token: string): Promise<void> {
  await page
    .evaluate((tok) => {
      const setVal = (el: Element | null) => {
        if (!el) return;
        (el as HTMLInputElement).value = tok;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      setVal(document.querySelector('input[name="cf-turnstile-response"]'));
      setVal(document.querySelector('textarea[name="cf-turnstile-response"]'));
      setVal(document.querySelector("[name='cf-turnstile-response']"));
      try {
        const w = window as unknown as { turnstileCallback?: (t: string) => void };
        if (typeof w.turnstileCallback === "function") w.turnstileCallback(tok);
      } catch {
        /* */
      }
      const form = document.querySelector("#challenge-form, form") as HTMLFormElement | null;
      form?.submit?.();
    }, token)
    .catch(() => {});
}

async function applyCfClearance(page: Page, cfClearance: string, websiteURL: string): Promise<void> {
  let domain = "m.rovbets.icu";
  try {
    domain = new URL(websiteURL).hostname;
  } catch {
    /* */
  }
  // Set for host and parent domain
  const domains = [domain, domain.replace(/^www\./, ""), domain.replace(/^m\./, "")];
  const unique = [...new Set(domains.filter(Boolean))];
  for (const d of unique) {
    await page
      .context()
      .addCookies([
        {
          name: "cf_clearance",
          value: cfClearance,
          domain: d.startsWith(".") ? d : `.${d}`,
          path: "/",
          secure: true,
          httpOnly: true,
        },
      ])
      .catch(() => {});
    await page
      .context()
      .addCookies([
        {
          name: "cf_clearance",
          value: cfClearance,
          domain: d,
          path: "/",
          secure: true,
        },
      ])
      .catch(() => {});
  }
  await page.goto(websiteURL, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
  await sleep(2500);
}

/**
 * 2captcha TurnstileTask (WITH our proxy — verified working with proxy-seller).
 * For managed challenge pages, action/cData/pagedata improve acceptance;
 * they are captured by intercepting turnstile.render (see grabTurnstileParams).
 * Returns token + the userAgent the solve is bound to.
 */
async function solveTurnstile2Captcha(
  apiKey: string,
  websiteURL: string,
  websiteKey: string,
  proxy: { proxy: string; proxytype?: "HTTP" | "HTTPS" | "SOCKS4" | "SOCKS5" },
  extra?: { action?: string; data?: string; pagedata?: string },
  outputDir?: string
): Promise<{ token: string; userAgent: string } | null> {
  const m = proxy.proxy.match(/^(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$/);
  if (!m) return null;
  const [, user, pass, host, port] = m;
  const task: Record<string, unknown> = {
    type: "TurnstileTask",
    websiteURL,
    websiteKey,
    proxyType: (proxy.proxytype ?? "SOCKS5").toLowerCase(),
    proxyAddress: host,
    proxyPort: Number(port),
    proxyLogin: user,
    proxyPassword: pass,
  };
  if (extra?.action) task.action = extra.action;
  if (extra?.data) task.data = extra.data;
  if (extra?.pagedata) task.pagedata = extra.pagedata;

  const createRes = await fetch("https://api.2captcha.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: apiKey, task }),
    signal: AbortSignal.timeout(30_000),
  });
  const created = (await createRes.json()) as { errorId?: number; errorDescription?: string; taskId?: number };
  if (created.errorId || !created.taskId) {
    logger.warn({ err: created.errorDescription || created }, "2captcha Turnstile createTask rejected");
    return null;
  }
  logger.info({ jobId: created.taskId }, "2captcha Turnstile job accepted");

  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    await sleep(4000);
    const res = await fetch("https://api.2captcha.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId: created.taskId }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json()) as {
      status?: string;
      errorId?: number;
      errorDescription?: string;
      solution?: { token?: string; userAgent?: string };
    };
    if (json.errorId) {
      logger.warn({ err: json.errorDescription }, "2captcha Turnstile error");
      return null;
    }
    if (json.status === "ready" && json.solution?.token) {
      logger.info({ tokenLen: json.solution.token.length }, "2captcha Turnstile token ready");
      if (outputDir) {
        const { logSolverCall } = await import("../report/solverCost.js");
        logSolverCall(outputDir, { provider: "2captcha", taskType: "turnstile-managed", status: "solved", cost: (json as { cost?: string }).cost ? Number((json as { cost?: string }).cost) : null });
      }
      return { token: json.solution.token, userAgent: json.solution.userAgent ?? "" };
    }
  }
  if (outputDir) {
    const { logSolverCall } = await import("../report/solverCost.js");
    logSolverCall(outputDir, { provider: "2captcha", taskType: "turnstile-managed", status: "failed" });
  }
  return null;
}

/**
 * Intercept turnstile.render to capture action/cData/chlPageData (required by
 * 2captcha for Cloudflare Challenge pages). Must be injected BEFORE the
 * challenge script runs — we reload right after installing it.
 */
async function grabTurnstileParams(
  page: Page
): Promise<{ action?: string; data?: string; pagedata?: string; sitekey?: string } | null> {
  try {
    // addInitScript: survives the reload — page.evaluate would be wiped by navigation.
    await page.addInitScript(() => {
      const w = window as unknown as { __tsParams?: unknown; __tsCallback?: unknown; turnstile?: { render?: unknown } };
      const iv = setInterval(() => {
        if (w.turnstile) {
          clearInterval(iv);
          w.turnstile.render = ((a: unknown, b: Record<string, unknown>) => {
            w.__tsParams = {
              sitekey: b.sitekey,
              action: b.action,
              data: b.cData,
              pagedata: b.chlPageData,
            };
            // Keep the REAL callback — the token must be delivered through it.
            w.__tsCallback = b.callback;
            return "foo";
          }) as unknown;
        }
      }, 25);
    });
    // Presence signals nudge the challenge JS to actually render the widget.
    await page.mouse.move(120, 300, { steps: 10 }).catch(() => {});
    await sleep(400);
    await page.mouse.move(200, 420, { steps: 12 }).catch(() => {});
    await sleep(600);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    // give the challenge script a moment to call render
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      const params = await page.evaluate(() => (window as unknown as { __tsParams?: unknown }).__tsParams ?? null);
      if (params) return params as { action?: string; data?: string; pagedata?: string; sitekey?: string };
    }
    logger.info("grabTurnstileParams: render call not intercepted in 25s");
    return null;
  } catch {
    return null;
  }
}

/** Force the browser UA to a specific string (solver-bound UA must match). */
async function forceUa(page: Page, ua: string): Promise<void> {
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setUserAgentOverride", { userAgent: ua, acceptLanguage: "tr-TR,tr;q=0.9" });
    await cdp.detach().catch(() => {});
  } catch {
    /* best effort */
  }
}

/** Inject a 2captcha Turnstile token: real callback first (per 2captcha docs),
 * hidden inputs as fallback. No form submit on managed challenges. */
async function injectTurnstileToken2Captcha(page: Page, token: string): Promise<void> {
  await page
    .evaluate((tok) => {
      const w = window as unknown as { __tsCallback?: (t: string) => void };
      try {
        if (typeof w.__tsCallback === "function") w.__tsCallback(tok);
      } catch {
        /* */
      }
      const setVal = (el: Element | null) => {
        if (!el) return;
        (el as HTMLInputElement).value = tok;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      for (const el of document.querySelectorAll('[name="cf-turnstile-response"], [id^="cf-chl-widget"]')) {
        setVal(el);
      }
    }, token)
    .catch(() => {});
}
export async function passCloudflareIfPresent(
  page: Page,
  config: AppConfig,
  opts: CloudflarePassOpts = {}
): Promise<{ passed: boolean; method: string }> {
  if (!(await pageLooksLikeCloudflare(page))) {
    return { passed: true, method: "none" };
  }

  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pageUrl = page.url();
  logger.info({ url: pageUrl.slice(0, 120) }, "Cloudflare challenge detected");

  if (await waitUntilNotChallenge(page, 18_000)) {
    logger.info("Cloudflare cleared without interaction");
    return { passed: true, method: "auto" };
  }

  // Checkbox click (user's case: "Gerçek kişi olduğunuzu doğrulayın").
  // Turnstile sometimes ignores the first synthetic click — retry a few times
  // before paying for a solver.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const clicked = await tryClickTurnstileCheckbox(page);
    if (clicked && (await waitUntilNotChallenge(page, attempt === 1 ? 20_000 : 12_000))) {
      logger.info({ attempt }, "Cloudflare passed after checkbox click");
      return { passed: true, method: attempt === 1 ? "checkbox-click" : `checkbox-click-x${attempt}` };
    }
    await sleep(2000);
  }

  const capKey = config.captcha.capSolverApiKey || config.captcha.twoCaptchaApiKey || config.captcha.apiKey || "";
  if (!capKey || !config.captcha.enabled) {
    logger.warn("Cloudflare still up and no solver key configured");
    return { passed: false, method: "failed" };
  }

  // Managed challenge ("Güvenlik doğrulaması yapılıyor" / "Just a moment" /
  // challenge-platform) — Turnstile TOKEN INJECTION DOES NOT WORK on these
  // (no form to inject into). Go straight to AntiCloudflare cf_clearance,
  // solved with the SAME proxy IP the browser uses.
  const htmlProbe = (await page.content().catch(() => "")) + " " + (await page.title().catch(() => "")) + " " + pageUrl;
  const looksManaged =
    /just a moment|bir dakika|cf-browser-verification|challenge-platform|cdn-cgi\/challenge|güvenlik doğrulaması|doğrulanıyor|bot olmadığınızı|checking your browser/i.test(
      htmlProbe
    );

  if (looksManaged) {
    // PRIMARY: 2captcha TurnstileTask with OUR proxy (verified working —
    // CapSolver's infra times out on proxy-seller, 2captcha connects fine).
    const twoKey = config.captcha.twoCaptchaApiKey || config.captcha.apiKey || "";
    if (twoKey && opts.proxy) {
      const params = await grabTurnstileParams(page);
      // Wait for the widget iframe too — sitekey lives in its src even when
      // the render interception misses.
      let siteKey2 = params?.sitekey ?? null;
      for (let i = 0; i < 15 && !siteKey2; i++) {
        await sleep(1000);
        siteKey2 = await extractTurnstileSitekey(page);
        if (siteKey2) break;
      }
      if (siteKey2) {
        logger.info({ siteKey: siteKey2.slice(0, 14), hasParams: !!params }, "2captcha Turnstile (managed, same-IP proxy)");
        const sol = await solveTurnstile2Captcha(twoKey, pageUrl, siteKey2, { proxy: opts.proxy, proxytype: opts.proxytype }, params ?? undefined, opts.outputDir);
        if (sol) {
          if (sol.userAgent) await forceUa(page, sol.userAgent);
          await injectTurnstileToken2Captcha(page, sol.token);
          if (await waitUntilNotChallenge(page, 25_000)) {
            return { passed: true, method: "2captcha-turnstile" };
          }
          // NO reload — the token is bound to the intercepted render call;
          // a reload would mint a new challenge instance and void it.
          await injectTurnstileToken2Captcha(page, sol.token);
          if (await waitUntilNotChallenge(page, 15_000)) {
            return { passed: true, method: "2captcha-turnstile-retry" };
          }
        }
      } else {
        logger.warn("2captcha path skipped — no sitekey (widget not rendered)");
      }
    }

    // FALLBACK: CapSolver AntiCloudflareTask (broken with proxy-seller, kept
    // for other providers) — same-IP cf_clearance.
    const capKey2 = config.captcha.capSolverApiKey || "";
    if (capKey2) {
      logger.info({ hasProxy: !!opts.proxy }, "CapSolver AntiCloudflareTask (fallback)");
      await forceWindowsChromeUa(page);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
      await sleep(2000);
      const html2 = await page.content().catch(() => htmlProbe);
      const sol = await solveChallengeCapSolver(capKey2, pageUrl, html2, CAPSOLVER_CF_UA, opts);
      if (sol?.cf_clearance) {
        await applyCfClearance(page, sol.cf_clearance, pageUrl);
        if (await waitUntilNotChallenge(page, 20_000)) {
          return { passed: true, method: "capsolver-cf-clearance" };
        }
        await page.goto(pageUrl.split("#")[0] || pageUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
        await sleep(3000);
        if (!(await pageLooksLikeCloudflare(page))) {
          return { passed: true, method: "capsolver-cf-clearance" };
        }
        logger.warn("cf_clearance set but page still shows Cloudflare (IP banned or sticky proxy mismatch)");
      }
    }
  }

  // Embedded Turnstile widget (not a managed interstitial) — token injection path.
  const siteKey = await extractTurnstileSitekey(page);
  if (siteKey && !looksManaged) {
    logger.info({ siteKey: siteKey.slice(0, 14) }, "CapSolver Turnstile");
    const token = await solveTurnstileCapSolver(capKey, pageUrl, siteKey);
    if (token) {
      await injectTurnstileToken(page, token);
      await sleep(2000);
      if (await waitUntilNotChallenge(page, 20_000)) {
        return { passed: true, method: "capsolver-turnstile" };
      }
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      await injectTurnstileToken(page, token);
      if (await waitUntilNotChallenge(page, 15_000)) {
        return { passed: true, method: "capsolver-turnstile-reload" };
      }
    }
  }

  await tryClickTurnstileCheckbox(page);
  if (await waitUntilNotChallenge(page, Math.min(15_000, timeoutMs))) {
    return { passed: true, method: "checkbox-retry" };
  }

  logger.warn({ url: page.url().slice(0, 120) }, "Cloudflare challenge not cleared");
  return { passed: false, method: "failed" };
}
