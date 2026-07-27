/**
 * Proof-of-click request watcher for Play app-install ads.
 *
 * App ads end their aclk chain at intent://play.google.com — no desktop
 * browser can open the intent protocol, so the page stays on the SERP even
 * though the aclk request DID reach Google (96 false "no navigation" fails
 * in one live run). Watching context requests lets us count those clicks
 * honestly and harvest the Play package id from the actual redirect.
 */
import type { Page, Request } from "playwright-core";
import { appAdPackage } from "../util/appAds.js";

export interface AclkWatch {
  /** True once a google /aclk (or googleadservices pagead/aclk) request fired. */
  sawAclk: () => boolean;
  /** Play package id captured from an intent:// or play.google.com request. */
  packageId: () => string | null;
  /** Remove the listener — always call when the click phase is done. */
  detach: () => void;
}

const ACLK_RE = /google\.[a-z.]+\/aclk[?/]|googleadservices\.com\/pagead\/aclk/i;

export function watchAclkRequests(page: Page): AclkWatch {
  const context = page.context();
  let aclk = false;
  let pkg: string | null = null;
  const onRequest = (req: Request) => {
    const u = req.url();
    if (ACLK_RE.test(u)) aclk = true;
    if (!pkg && (u.startsWith("intent://") || u.includes("play.google.com"))) {
      pkg = appAdPackage(u);
    }
  };
  context.on("request", onRequest);
  return {
    sawAclk: () => aclk,
    packageId: () => pkg,
    detach: () => context.off("request", onRequest),
  };
}
