import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { logger } from "../logger.js";
import { sleep } from "../util/time.js";

/**
 * A Playwright client attached (over CDP) to a browser launched by AdsPower.
 *
 * Important invariants (see research notes):
 *  - We attach to the profile's EXISTING default context. Never browser.newContext():
 *    a fresh context drops the profile's proxy / fingerprint / cookies.
 *  - browser.close() here only DETACHES the Playwright client; the AdsPower process
 *    keeps running and must be stopped via the AdsPower API (handled by the caller).
 *  - Device (desktop vs mobile) is baked into the AdsPower profile, not set here.
 */
export class BrowserSession {
  private constructor(
    readonly browser: Browser,
    readonly context: BrowserContext,
    readonly page: Page
  ) {}

  static async attach(wsEndpoint: string, opts: { connectRetries?: number; connectBackoffMs?: number } = {}): Promise<BrowserSession> {
    const retries = opts.connectRetries ?? 5;
    const backoff = opts.connectBackoffMs ?? 1000;

    let browser: Browser | null = null;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        browser = await chromium.connectOverCDP(wsEndpoint, { timeout: 20_000 });
        break;
      } catch (err) {
        lastErr = err;
        logger.warn({ attempt, err: String(err) }, "connectOverCDP failed, retrying");
        if (attempt < retries) await sleep(backoff * attempt);
      }
    }
    if (!browser) {
      throw new Error(`Could not attach to AdsPower browser over CDP after ${retries} tries: ${String(lastErr)}`);
    }

    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => {});
      throw new Error("AdsPower browser has no default context — is the profile fully started?");
    }
    // Pick a real content tab. Mobile-simulation profiles open a devtools:// inspector tab
    // first; navigating that tab tears down the whole browser, so it must be skipped.
    const isContentPage = (u: string) =>
      !u.startsWith("devtools://") && !u.startsWith("chrome://") && !u.startsWith("chrome-extension://") && !u.startsWith("edge://");
    const usable = context.pages().find((p) => isContentPage(p.url()));
    const page = usable ?? (await context.newPage());
    return new BrowserSession(browser, context, page);
  }

  /** Open a fresh tab inside the SAME (profile) context — keeps proxy/fingerprint. */
  async newPage(): Promise<Page> {
    return this.context.newPage();
  }

  /**
   * Cookie names that prove "this IP already passed Google's sorry wall".
   * Wiping them forces a fresh /sorry on every scan — private ISP recovery fails.
   */
  private static readonly GOOGLE_TRUST_COOKIE_RE =
    /^(GOOGLE_ABUSE_EXEMPTION|NID|__Secure-ENID|AEC|SID|HSID|SSID|APISID|SAPISID|__Secure-1PSID|__Secure-3PSID|__Secure-1PAPISID|__Secure-3PAPISID|CONSENT|SOCS)$/i;

  /**
   * Clear cookies, storage, and cache while keeping the profile's proxy and
   * fingerprint. Used before a scan so results are not personalised by prior
   * browsing in the same profile.
   *
   * @param opts.preserveGoogleTrust When true (default for captcha-enabled runs),
   *   keep Google abuse-exemption / session cookies so yesterday's solve still
   *   protects the private ISP IP. Non-Google cookies and cache are still cleared.
   */
  async clearProfileData(opts: { preserveGoogleTrust?: boolean } = {}): Promise<void> {
    const preserve = !!opts.preserveGoogleTrust;
    let trustCookies: Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
      expires?: number;
      httpOnly?: boolean;
      secure?: boolean;
      sameSite?: "Strict" | "Lax" | "None";
    }> = [];

    if (preserve) {
      try {
        const all = await this.context.cookies();
        trustCookies = all
          .filter(
            (c) =>
              /google\./i.test(c.domain) && BrowserSession.GOOGLE_TRUST_COOKIE_RE.test(c.name)
          )
          .map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || "/",
            expires: c.expires > 0 ? c.expires : undefined,
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: c.sameSite as "Strict" | "Lax" | "None" | undefined,
          }));
        if (trustCookies.length) {
          logger.info(
            { kept: trustCookies.length, names: [...new Set(trustCookies.map((c) => c.name))] },
            "preserving Google trust cookies across profile clear"
          );
        }
      } catch (err) {
        logger.debug({ err: String(err) }, "could not snapshot trust cookies");
      }
    }

    try {
      await this.context.clearCookies();
    } catch (err) {
      logger.debug({ err: String(err) }, "clear cookies failed (ignored)");
    }

    try {
      await this.page.evaluate(() => {
        try {
          localStorage.clear();
        } catch {}
        try {
          sessionStorage.clear();
        } catch {}
        try {
          window.indexedDB.databases().then((dbs) => {
            dbs.forEach((db) => {
              if (db.name) window.indexedDB.deleteDatabase(db.name);
            });
          });
        } catch {}
      });
    } catch (err) {
      logger.debug({ err: String(err) }, "clear storage failed (ignored)");
    }

    try {
      const cdp = await this.context.newCDPSession(this.page);
      await cdp.send("Network.clearBrowserCache");
      // Only nuke all cookies via CDP when we are NOT preserving trust — otherwise
      // Network.clearBrowserCookies would drop what we are about to re-apply, and
      // Storage.clearDataForOrigin on google.com would kill GOOGLE_ABUSE_EXEMPTION.
      if (!preserve) {
        await cdp.send("Network.clearBrowserCookies");
        for (const origin of [
          "https://www.google.com",
          "https://google.com",
          "https://www.google.com.tr",
          "https://accounts.google.com",
        ]) {
          try {
            await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
          } catch {}
        }
      }
      await cdp.detach();
    } catch (err) {
      logger.debug({ err: String(err) }, "CDP clear cache/cookies failed (ignored)");
    }

    if (preserve && trustCookies.length) {
      try {
        await this.context.addCookies(
          trustCookies.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            expires: c.expires,
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: c.sameSite,
          }))
        );
        logger.info({ restored: trustCookies.length }, "restored Google trust cookies after clear");
      } catch (err) {
        logger.warn({ err: String(err) }, "failed to restore Google trust cookies");
      }
    }
  }

  /**
   * Export Google-domain cookies from this profile. Used to copy ad-targeting
   * signals from a profile that saw an ad to profiles that did not.
   */
  async exportGoogleCookies(): Promise<Array<{ name: string; value: string; domain: string; path: string }>> {
    try {
      const cdp = await this.context.newCDPSession(this.page);
      const res = (await cdp.send("Network.getAllCookies")) as {
        cookies: Array<{ name: string; value: string; domain: string; path: string }>;
      };
      await cdp.detach();
      return res.cookies.filter((c) => c.domain.includes("google"));
    } catch (err) {
      logger.debug({ err: String(err) }, "export google cookies failed");
      return [];
    }
  }

  /**
   * Import Google-domain cookies into this profile. Should be called right
   * after clearing profile data and before any navigation.
   */
  async importGoogleCookies(
    cookies: Array<{ name: string; value: string; domain: string; path: string }>
  ): Promise<void> {
    if (cookies.length === 0) return;
    try {
      const cdp = await this.context.newCDPSession(this.page);
      for (const c of cookies) {
        try {
          await cdp.send("Network.setCookie", {
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
          });
        } catch {
          // Ignore individual cookie failures.
        }
      }
      await cdp.detach();
      logger.debug({ count: cookies.length }, "imported google cookies into profile");
    } catch (err) {
      logger.debug({ err: String(err) }, "import google cookies failed");
    }
  }

  /** Detach the Playwright client. Does NOT terminate the AdsPower session. */
  async detach(): Promise<void> {
    try {
      await this.browser.close();
    } catch (err) {
      logger.debug({ err: String(err) }, "browser detach threw (ignored)");
    }
  }
}
