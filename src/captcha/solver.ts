import { logger } from "../logger.js";
import { sleep } from "../util/time.js";

export interface RecaptchaSolveOpts {
  pollMs?: number;
  timeoutMs?: number;
  enterprise?: boolean;
  /** Per-session data-s from Google's sorry-page .g-recaptcha (required for google.com). */
  dataS?: string;
  /**
   * Browser cookies for google.* domains.
   * Classic in.php format: `NAME:VALUE;NAME2:VALUE2`
   * (API v2 path converts to `NAME=VALUE; NAME2=VALUE2` automatically.)
   * With proxy: only sent when `allowCookiesWithProxy` is true (Google /sorry recovery).
   */
  cookies?: string;
  /** User-Agent of the browser that hit the captcha wall. */
  userAgent?: string;
  /**
   * Optional proxy the browser is using, so 2captcha workers solve from the same IP.
   * Format: `user:pass@host:port` (or `host:port`).
   */
  proxy?: string;
  /** Proxy protocol when `proxy` is set. */
  proxytype?: "HTTP" | "HTTPS" | "SOCKS4" | "SOCKS5";
  /**
   * Google Search /sorry: send cookies together with proxy (session + IP match).
   * Default false (generic 2captcha XOR). Private ISP recovery sets this true.
   */
  allowCookiesWithProxy?: boolean;
}

export interface RecaptchaSolveResult {
  token: string;
  /** Solver job/task id — used to report incorrect if Google rejects the token. */
  jobId: string;
  /** Which API path produced the token. */
  via?: "api_v2" | "in_php" | "capsolver";
  /**
   * Cookies returned by 2captcha when we sent cookies (classic API: after `|`).
   * Format often `NAME=VALUE; NAME2=VALUE2` — apply to the browser before form submit.
   * @see https://2captcha.com/blog/bypassing-recaptcha-v2-on-google-search
   */
  cookies?: string;
  /** How long we waited for the worker (ms). Google data-s ages hard after ~100s. */
  waitMs?: number;
  provider?: "2captcha" | "capsolver";
  /** solver_calls row id for this token — policy records the outcome against it. */
  solverCallId?: number | null;
}

export interface MultiProviderSolveOpts extends RecaptchaSolveOpts {
  /** CapSolver first when "auto" (faster for Google data-s). */
  provider?: "2captcha" | "capsolver" | "auto";
  twoCaptchaApiKey?: string;
  capSolverApiKey?: string;
}

/**
 * Parse `user:pass@host:port` or `host:port`.
 * Password may contain `:` — only split userinfo on the FIRST colon.
 * Host is the segment after the LAST `@` (passwords can contain `@` rarely; lastIndexOf is safer for user:pass@ip:port).
 */
function parseProxy(proxy: string): {
  address: string;
  port: number;
  login?: string;
  password?: string;
} | null {
  const raw = proxy.trim();
  if (!raw) return null;

  let userinfo: string | null = null;
  let hostport = raw;
  const at = raw.lastIndexOf("@");
  if (at > 0) {
    userinfo = raw.slice(0, at);
    hostport = raw.slice(at + 1);
  }

  const portSep = hostport.lastIndexOf(":");
  if (portSep <= 0) return null;
  const address = hostport.slice(0, portSep);
  const port = parseInt(hostport.slice(portSep + 1), 10);
  if (!address || !Number.isFinite(port) || port <= 0) return null;

  let login: string | undefined;
  let password: string | undefined;
  if (userinfo != null) {
    const colon = userinfo.indexOf(":");
    if (colon >= 0) {
      login = userinfo.slice(0, colon);
      password = userinfo.slice(colon + 1);
    } else {
      login = userinfo;
      password = "";
    }
  }
  return { address, port, login, password };
}

/** Convert classic `NAME:VALUE;…` cookies to API v2 `NAME=VALUE; …` (values may contain `=`). */
function cookiesToApiV2(classic: string): string {
  return classic
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf(":");
      if (i <= 0) return pair.includes("=") ? pair : "";
      return `${pair.slice(0, i)}=${pair.slice(i + 1)}`;
    })
    .filter(Boolean)
    .join("; ");
}

/**
 * 2captcha API v2 createTask — preferred when we have the browser's SOCKS/HTTP proxy.
 * Google Search: RecaptchaV2Task (or EnterpriseTask) with proxy — not Proxyless.
 *
 * Enterprise uses RecaptchaV2EnterpriseTask + enterprisePayload.s (data-s).
 * Classic uses RecaptchaV2Task + recaptchaDataSValue.
 * @see https://2captcha.com/api-docs/recaptcha-v2
 * @see https://2captcha.com/api-docs/recaptcha-v2-enterprise
 */
async function solveViaApiV2(
  apiKey: string,
  siteKey: string,
  pageUrl: string,
  opts: RecaptchaSolveOpts
): Promise<RecaptchaSolveResult | null> {
  const pollMs = opts.pollMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const parsed = opts.proxy ? parseProxy(opts.proxy) : null;
  if (opts.proxy && !parsed) {
    logger.warn(
      { proxyLen: opts.proxy.length, hasAt: opts.proxy.includes("@") },
      "2captcha proxy string failed to parse — job will be proxyless (IP mismatch risk)"
    );
  }
  const enterprise = !!opts.enterprise;

  // Task type must match the widget API Google loaded on the page.
  let type: string;
  if (enterprise) {
    type = parsed ? "RecaptchaV2EnterpriseTask" : "RecaptchaV2EnterpriseTaskProxyless";
  } else {
    type = parsed ? "RecaptchaV2Task" : "RecaptchaV2TaskProxyless";
  }

  const task: Record<string, unknown> = {
    type,
    websiteURL: pageUrl,
    websiteKey: siteKey,
  };

  // data-s is one-shot and required for google.com/sorry — field name differs by task family.
  if (opts.dataS) {
    if (enterprise) {
      task.enterprisePayload = { s: opts.dataS };
    } else {
      task.recaptchaDataSValue = opts.dataS;
    }
  }
  if (opts.userAgent) task.userAgent = opts.userAgent;
  // Default: proxy XOR cookies. Google /sorry recovery may set allowCookiesWithProxy.
  if (parsed) {
    task.proxyType = (opts.proxytype ?? "SOCKS5").toLowerCase();
    task.proxyAddress = parsed.address;
    task.proxyPort = parsed.port;
    if (parsed.login) task.proxyLogin = parsed.login;
    if (parsed.password !== undefined) task.proxyPassword = parsed.password;
    if (opts.cookies && opts.allowCookiesWithProxy) {
      task.cookies = cookiesToApiV2(opts.cookies);
    } else if (opts.cookies) {
      logger.warn("proxy set — dropping cookies (set allowCookiesWithProxy for Google /sorry)");
    }
  } else if (opts.cookies) {
    task.cookies = cookiesToApiV2(opts.cookies);
  }

  const createRes = await fetch("https://api.2captcha.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: apiKey, task }),
    signal: AbortSignal.timeout(30_000),
  });
  const created = (await createRes.json()) as {
    errorId: number;
    errorCode?: string;
    errorDescription?: string;
    taskId?: number | string;
  };
  const cookiesOnTask = typeof task.cookies === "string" && task.cookies.length > 0;
  if (created.errorId !== 0 || created.taskId == null) {
    logger.warn(
      {
        errorCode: created.errorCode,
        errorDescription: created.errorDescription,
        type,
        enterprise,
        hasDataS: !!opts.dataS,
        hasCookies: cookiesOnTask,
        hasProxy: !!parsed,
      },
      "2captcha createTask rejected"
    );
    return null;
  }
  const taskId = String(created.taskId);
  logger.info(
    {
      jobId: taskId,
      via: "api_v2",
      type,
      enterprise,
      hasDataS: !!opts.dataS,
      hasCookies: cookiesOnTask,
      hasProxy: !!parsed,
    },
    "2captcha job accepted"
  );

  const started = Date.now();
  // Google data-s ages hard — first poll at 5s, then every pollMs (caller often uses 2–3s).
  await sleep(5_000);
  while (Date.now() - started < timeoutMs) {
    const res = await fetch("https://api.2captcha.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json()) as {
      errorId: number;
      status?: string;
      errorCode?: string;
      errorDescription?: string;
      solution?: {
        gRecaptchaResponse?: string;
        token?: string;
        cookies?: string | Record<string, string>;
      };
    };
    if (json.errorId !== 0) {
      logger.warn(
        { jobId: taskId, errorCode: json.errorCode, errorDescription: json.errorDescription },
        "2captcha getTaskResult error"
      );
      return null;
    }
    if (json.status === "ready") {
      const token = json.solution?.gRecaptchaResponse || json.solution?.token;
      if (!token) {
        logger.warn({ jobId: taskId }, "2captcha ready but empty token");
        return null;
      }
      let cookies: string | undefined;
      const rawCookies = json.solution?.cookies;
      if (rawCookies) {
        if (typeof rawCookies === "string") cookies = rawCookies;
        else
          cookies = Object.entries(rawCookies)
            .map(([k, v]) => `${k}=${v}`)
            .join("; ");
      }
      const waitMs = Date.now() - started;
      logger.info({ jobId: taskId, waitMs, tokenLen: token.length }, "2captcha token ready");
      let solverCallId: number | null = null;
      try {
        const { loadConfig } = await import("../config.js");
        const { logSolverCall } = await import("../report/solverCost.js");
        solverCallId = logSolverCall(loadConfig().output.dir, {
          provider: "2captcha",
          taskType: opts.enterprise ? "recaptcha-enterprise" : "recaptcha",
          status: "solved",
          cost: (json as { cost?: string }).cost ? Number((json as { cost?: string }).cost) : null,
        });
      } catch {
        /* cost log optional */
      }
      return { token, jobId: taskId, via: "api_v2", cookies, waitMs, solverCallId };
    }
    await sleep(pollMs);
  }
  logger.warn({ jobId: taskId }, "2captcha api_v2 solve timed out");
  return null;
}

/** Classic in.php / res.php path (fallback). */
async function solveViaInPhp(
  apiKey: string,
  siteKey: string,
  pageUrl: string,
  opts: RecaptchaSolveOpts
): Promise<RecaptchaSolveResult | null> {
  const pollMs = opts.pollMs ?? 5000;
  const timeoutMs = opts.timeoutMs ?? 180_000;

  const body = new URLSearchParams();
  body.set("key", apiKey);
  body.set("method", "userrecaptcha");
  body.set("googlekey", siteKey);
  body.set("pageurl", pageUrl);
  body.set("json", "1");
  if (opts.enterprise) body.set("enterprise", "1");
  if (opts.dataS) body.set("data-s", opts.dataS);
  if (opts.userAgent) body.set("userAgent", opts.userAgent);
  // Default XOR; Google /sorry may allow both.
  if (opts.proxy) {
    body.set("proxy", opts.proxy);
    body.set("proxytype", opts.proxytype ?? "SOCKS5");
    if (opts.cookies && opts.allowCookiesWithProxy) {
      body.set("cookies", opts.cookies);
    } else if (opts.cookies) {
      logger.warn("proxy set — dropping cookies for in.php (set allowCookiesWithProxy for Google /sorry)");
    }
  } else if (opts.cookies) {
    body.set("cookies", opts.cookies);
  }

  const inRes = await fetch("https://2captcha.com/in.php", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const inJson = (await inRes.json()) as { status: number; request: string };
  if (inJson.status !== 1) {
    logger.warn(
      {
        resp: inJson.request,
        hasDataS: !!opts.dataS,
        hasCookies: !!opts.cookies,
        hasUa: !!opts.userAgent,
        hasProxy: !!opts.proxy,
      },
      "2captcha in.php rejected the job"
    );
    return null;
  }
  const id = inJson.request;
  logger.info({ jobId: id, via: "in_php", hasDataS: !!opts.dataS, hasCookies: !!opts.cookies }, "2captcha job accepted");

  const started = Date.now();
  await sleep(15_000);
  while (Date.now() - started < timeoutMs) {
    const resUrl = new URL("https://2captcha.com/res.php");
    resUrl.searchParams.set("key", apiKey);
    resUrl.searchParams.set("action", "get");
    resUrl.searchParams.set("id", id);
    resUrl.searchParams.set("json", "1");
    const res = await fetch(resUrl, { signal: AbortSignal.timeout(20_000) });
    const json = (await res.json()) as { status: number; request: string };
    if (json.status === 1) {
      const raw = json.request;
      // Classic Google path: TOKEN or TOKEN|cookie1=val;cookie2=val
      if (raw.includes("|")) {
        const pipe = raw.indexOf("|");
        const token = raw.slice(0, pipe);
        const cookies = raw.slice(pipe + 1).trim() || undefined;
        return { token, jobId: id, via: "in_php", cookies };
      }
      return { token: raw, jobId: id, via: "in_php" };
    }
    if (json.request !== "CAPCHA_NOT_READY") {
      logger.warn({ resp: json.request, jobId: id }, "2captcha res.php error");
      return null;
    }
    await sleep(pollMs);
  }
  logger.warn({ jobId: id }, "2captcha solve timed out");
  return null;
}

/**
 * CapSolver ReCaptchaV2 / Enterprise with proxy + enterprisePayload.s (data-s).
 * @see https://docs.capsolver.com/en/guide/captcha/ReCaptchaV2/
 */
async function solveViaCapSolver(
  apiKey: string,
  siteKey: string,
  pageUrl: string,
  opts: RecaptchaSolveOpts
): Promise<RecaptchaSolveResult | null> {
  const pollMs = opts.pollMs ?? 2_000;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const parsed = opts.proxy ? parseProxy(opts.proxy) : null;
  const enterprise = !!opts.enterprise;

  let type: string;
  if (enterprise) {
    type = parsed ? "ReCaptchaV2EnterpriseTask" : "ReCaptchaV2EnterpriseTaskProxyLess";
  } else {
    type = parsed ? "ReCaptchaV2Task" : "ReCaptchaV2TaskProxyLess";
  }

  const task: Record<string, unknown> = {
    type,
    websiteURL: pageUrl,
    websiteKey: siteKey,
  };
  if (opts.dataS) {
    if (enterprise) task.enterprisePayload = { s: opts.dataS };
    else task.recaptchaDataSValue = opts.dataS;
  }
  if (opts.userAgent) task.userAgent = opts.userAgent;

  // CapSolver proxy formats (docs): socks5:ip:port:user:pass  OR  socks5://user:pass@ip:port
  // Do NOT mix proxy string with separate proxyType/proxyAddress fields.
  if (parsed) {
    const scheme = (opts.proxytype ?? "SOCKS5").toLowerCase().replace("https", "http");
    if (parsed.login != null && parsed.login !== "") {
      task.proxy = `${scheme}:${parsed.address}:${parsed.port}:${parsed.login}:${parsed.password ?? ""}`;
    } else {
      task.proxy = `${scheme}:${parsed.address}:${parsed.port}`;
    }
  }

  // CapSolver + proxy: omit cookies (IP match is enough; cookie arrays often trigger INVALID_TASK_DATA).
  // Proxyless path may include cookies if needed later.

  const payload = { clientKey: apiKey, task };
  const createRes = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const created = (await createRes.json()) as {
    errorId: number;
    errorCode?: string;
    errorDescription?: string;
    taskId?: string;
  };
  if (created.errorId !== 0 || !created.taskId) {
    logger.warn(
      {
        errorCode: created.errorCode,
        errorDescription: created.errorDescription,
        type,
        enterprise,
        hasDataS: !!opts.dataS,
        hasProxy: !!parsed,
      },
      "CapSolver createTask rejected"
    );
    return null;
  }
  const taskId = String(created.taskId);
  logger.info(
    { jobId: taskId, via: "capsolver", type, enterprise, hasDataS: !!opts.dataS, hasProxy: !!parsed },
    "CapSolver job accepted"
  );

  const started = Date.now();
  await sleep(3_000);
  while (Date.now() - started < timeoutMs) {
    const res = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json()) as {
      errorId: number;
      status?: string;
      errorCode?: string;
      errorDescription?: string;
      solution?: { gRecaptchaResponse?: string; token?: string };
    };
    if (json.errorId !== 0) {
      logger.warn(
        { jobId: taskId, errorCode: json.errorCode, errorDescription: json.errorDescription },
        "CapSolver getTaskResult error"
      );
      return null;
    }
    if (json.status === "ready") {
      const token = json.solution?.gRecaptchaResponse || json.solution?.token;
      if (!token) {
        logger.warn({ jobId: taskId }, "CapSolver ready but empty token");
        return null;
      }
      const waitMs = Date.now() - started;
      logger.info({ jobId: taskId, waitMs, tokenLen: token.length }, "CapSolver token ready");
      let solverCallId: number | null = null;
      try {
        const { loadConfig } = await import("../config.js");
        const { logSolverCall } = await import("../report/solverCost.js");
        solverCallId = logSolverCall(loadConfig().output.dir, {
          provider: "capsolver",
          taskType: opts.enterprise ? "recaptcha-enterprise" : "recaptcha",
          status: "solved",
          cost: null, // CapSolver does not return per-task cost in getTaskResult
        });
      } catch {
        /* cost log optional */
      }
      return { token, jobId: taskId, via: "capsolver", waitMs, provider: "capsolver", solverCallId };
    }
    // status processing
    await sleep(pollMs);
  }
  logger.warn({ jobId: taskId }, "CapSolver solve timed out");
  return null;
}

/**
 * 2captcha reCAPTCHA v2 client tuned for Google's /sorry/ unusual-traffic wall.
 *
 * Prefer API v2. Fall back to classic in.php ONLY when createTask never started
 * (data-s still unused). Once a job is accepted, data-s is one-shot — never
 * re-submit the same data-s on another API path (2captcha Google Search guide).
 */
export async function solveRecaptchaV2(
  apiKey: string,
  siteKey: string,
  pageUrl: string,
  opts: RecaptchaSolveOpts = {}
): Promise<RecaptchaSolveResult | null> {
  if (!apiKey) return null;

  try {
    // Google Search: always try API v2 first when we have proxy OR data-s (structured fields).
    if (opts.proxy || opts.dataS) {
      const v2 = await solveViaApiV2(apiKey, siteKey, pageUrl, opts);
      if (v2) return { ...v2, provider: "2captcha" };
      // createTask rejected OR job ended unsolvable: data-s is spent if taskId existed.
      // Do NOT chain in.php with the same data-s — caller must reload for a fresh challenge.
      if (opts.dataS) {
        logger.warn("api_v2 failed after data-s job — not reusing data-s on in.php");
        return null;
      }
      logger.warn("api_v2 path failed — falling back to classic in.php");
    }
    const classic = await solveViaInPhp(apiKey, siteKey, pageUrl, opts);
    return classic ? { ...classic, provider: "2captcha" } : null;
  } catch (err) {
    logger.warn({ err: String(err) }, "2captcha request failed");
    return null;
  }
}

/**
 * Google /sorry solver: CapSolver first (when auto), then 2captcha.
 * IMPORTANT: do not send the same data-s to a second provider after a job was accepted —
 * CapSolver/2captcha both consume the challenge. On null, caller reloads for fresh data-s.
 */
export async function solveRecaptchaMulti(
  siteKey: string,
  pageUrl: string,
  opts: MultiProviderSolveOpts = {}
): Promise<RecaptchaSolveResult | null> {
  const provider = opts.provider ?? "auto";
  const capKey = opts.capSolverApiKey ?? "";
  const twoKey = opts.twoCaptchaApiKey ?? "";

  const order: Array<"capsolver" | "2captcha"> =
    provider === "capsolver"
      ? ["capsolver"]
      : provider === "2captcha"
        ? ["2captcha"]
        : capKey
          ? twoKey
            ? ["capsolver", "2captcha"]
            : ["capsolver"]
          : ["2captcha"];

  for (const p of order) {
    // Circuit breaker: paused providers are skipped (distrust-wave economics).
    try {
      const { loadConfig } = await import("../config.js");
      const { getCaptchaPolicy } = await import("./policy.js");
      if (!getCaptchaPolicy(loadConfig()).providerAllowed(p)) {
        logger.warn({ provider: p }, "solver provider paused by circuit breaker — skipping");
        continue;
      }
    } catch {
      /* policy optional */
    }
    if (p === "capsolver") {
      if (!capKey) continue;
      logger.info({ provider: "capsolver" }, "trying captcha provider");
      try {
        const r = await solveViaCapSolver(capKey, siteKey, pageUrl, opts);
        if (r) return r;
        // Job may have consumed data-s — do NOT fall through to 2captcha with same data-s.
        if (opts.dataS) {
          logger.warn("CapSolver failed after data-s job — not chaining 2captcha on same data-s");
          return null;
        }
      } catch (err) {
        logger.warn({ err: String(err) }, "CapSolver request failed");
        if (opts.dataS) return null;
      }
    } else {
      if (!twoKey) continue;
      logger.info({ provider: "2captcha" }, "trying captcha provider");
      const r = await solveRecaptchaV2(twoKey, siteKey, pageUrl, opts);
      if (r) return r;
      if (opts.dataS) return null;
    }
  }
  return null;
}

/** Tell 2captcha a token was rejected so they refund / retrain. */
export async function reportIncorrect(apiKey: string, jobId: string): Promise<void> {
  if (!apiKey || !jobId) return;
  try {
    // Works for both classic job ids and api_v2 task ids.
    const url = new URL("https://2captcha.com/res.php");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("action", "reportbad");
    url.searchParams.set("id", jobId);
    url.searchParams.set("json", "1");
    await fetch(url, { signal: AbortSignal.timeout(10_000) });
    await fetch("https://api.2captcha.com/reportIncorrect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId: jobId }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  } catch {
    /* non-fatal */
  }
}

export interface ImageCaptchaSolveOpts {
  pollMs?: number;
  timeoutMs?: number;
  /** Case-sensitive answer (Google sorry images often are). Default true. */
  caseSensitive?: boolean;
  /** 0=any, 1=digits only, 2=letters only, 3=digits OR letters, 4=both. Default 0. */
  numeric?: 0 | 1 | 2 | 3 | 4;
  minLength?: number;
  maxLength?: number;
  /** Shown to 2captcha workers — improves OCR accuracy. */
  comment?: string;
}

export interface ImageCaptchaSolveResult {
  text: string;
  jobId: string;
  via: "api_v2" | "in_php";
}

/**
 * Solve a normal image CAPTCHA (base64) via 2captcha ImageToTextTask (API v2).
 * Used for Google's legacy "type the characters" sorry-page variant.
 *
 * @see https://2captcha.com/api-docs/normal-captcha
 */
async function solveImageViaApiV2(
  apiKey: string,
  rawBase64: string,
  opts: ImageCaptchaSolveOpts
): Promise<ImageCaptchaSolveResult | null> {
  const pollMs = opts.pollMs ?? 4000;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  // Keep constraints optional — over-constraining (case/min/max) forces wrong guesses
  // from workers on Google's distorted glyphs.
  const task: Record<string, unknown> = {
    type: "ImageToTextTask",
    body: rawBase64,
    phrase: false,
    case: opts.caseSensitive ?? false,
    numeric: opts.numeric ?? 0,
    math: false,
    comment: opts.comment ?? "Type the characters you see on the image exactly",
  };
  if (opts.minLength != null && opts.minLength > 0) task.minLength = opts.minLength;
  if (opts.maxLength != null && opts.maxLength > 0) task.maxLength = opts.maxLength;

  const createRes = await fetch("https://api.2captcha.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: apiKey, task, languagePool: "en" }),
    signal: AbortSignal.timeout(30_000),
  });
  const created = (await createRes.json()) as {
    errorId: number;
    errorCode?: string;
    errorDescription?: string;
    taskId?: number | string;
  };
  if (created.errorId !== 0 || created.taskId == null) {
    logger.warn(
      { errorCode: created.errorCode, errorDescription: created.errorDescription },
      "2captcha ImageToTextTask createTask rejected"
    );
    return null;
  }
  const taskId = String(created.taskId);
  logger.info({ jobId: taskId, via: "api_v2" }, "2captcha image job accepted");

  const started = Date.now();
  await sleep(4000);
  while (Date.now() - started < timeoutMs) {
    const res = await fetch("https://api.2captcha.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json()) as {
      errorId: number;
      status?: string;
      errorCode?: string;
      errorDescription?: string;
      solution?: { text?: string };
    };
    if (json.errorId !== 0) {
      logger.warn(
        { jobId: taskId, errorCode: json.errorCode, errorDescription: json.errorDescription },
        "2captcha getTaskResult error (image)"
      );
      return null;
    }
    if (json.status === "ready") {
      const text = json.solution?.text?.trim();
      if (!text) {
        logger.warn({ jobId: taskId }, "2captcha image ready but empty text");
        return null;
      }
      return { text, jobId: taskId, via: "api_v2" };
    }
    await sleep(pollMs);
  }
  logger.warn({ jobId: taskId }, "2captcha image api_v2 solve timed out");
  return null;
}

/** Classic in.php base64 image path (fallback if API v2 rejects). */
async function solveImageViaInPhp(
  apiKey: string,
  rawBase64: string,
  opts: ImageCaptchaSolveOpts
): Promise<ImageCaptchaSolveResult | null> {
  const pollMs = opts.pollMs ?? 4000;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const body = new URLSearchParams({
    key: apiKey,
    method: "base64",
    body: rawBase64,
    json: "1",
    regsense: (opts.caseSensitive ?? false) ? "1" : "0",
    numeric: String(opts.numeric ?? 0),
    phrase: "0",
    min_len: String(opts.minLength ?? 0),
    max_len: String(opts.maxLength ?? 0),
    textinstructions: opts.comment ?? "Type the characters you see on the image exactly",
  });
  const inRes = await fetch("https://2captcha.com/in.php", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const inJson = (await inRes.json()) as { status: number; request: string };
  if (inJson.status !== 1) {
    logger.warn({ resp: inJson.request }, "2captcha in.php rejected the image job");
    return null;
  }
  const id = inJson.request;
  logger.info({ jobId: id, via: "in_php" }, "2captcha image job accepted");

  const started = Date.now();
  await sleep(5000);
  while (Date.now() - started < timeoutMs) {
    const resUrl = new URL("https://2captcha.com/res.php");
    resUrl.searchParams.set("key", apiKey);
    resUrl.searchParams.set("action", "get");
    resUrl.searchParams.set("id", id);
    resUrl.searchParams.set("json", "1");
    const res = await fetch(resUrl, { signal: AbortSignal.timeout(20_000) });
    const json = (await res.json()) as { status: number; request: string };
    if (json.status === 1) return { text: json.request, jobId: id, via: "in_php" };
    if (json.request !== "CAPCHA_NOT_READY") {
      logger.warn({ resp: json.request, jobId: id }, "2captcha res.php error (image)");
      return null;
    }
    await sleep(pollMs);
  }
  logger.warn({ jobId: id }, "2captcha image solve timed out");
  return null;
}

/**
 * Solve Google's sorry-page image CAPTCHA.
 * Prefers API v2 ImageToTextTask (comment / case / length hints for workers).
 * Falls back to classic in.php if createTask fails.
 */
export async function solveImageCaptcha(
  apiKey: string,
  base64Image: string,
  opts: ImageCaptchaSolveOpts = {}
): Promise<ImageCaptchaSolveResult | null> {
  if (!apiKey || !base64Image) return null;

  try {
    const raw = base64Image.replace(/^data:image\/\w+;base64,/, "");
    const v2 = await solveImageViaApiV2(apiKey, raw, opts);
    if (v2) return v2;
    logger.warn("ImageToTextTask api_v2 failed — falling back to classic in.php");
    return await solveImageViaInPhp(apiKey, raw, opts);
  } catch (err) {
    logger.warn({ err: String(err) }, "2captcha image request failed");
    return null;
  }
}
