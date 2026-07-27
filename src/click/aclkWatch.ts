/**
 * Proof-of-click request watcher for Play app-install ads.
 *
 * App ads end their aclk chain at intent://play.google.com — no desktop
 * browser can open the intent protocol, so the page stays on the SERP even
 * though the aclk request DID reach Google (96 false "no navigation" fails
 * in one live run). Watching context requests lets us count those clicks
 * honestly and harvest the Play package id from the actual redirect.
 * sawClickProof also credits an observed intent://play.google.com request —
 * some click chains only surface that hop (storm live run).
 */
import type { Page, Request } from "playwright-core";
import { appAdPackage } from "../util/appAds.js";

export interface AclkWatch {
  /** True once a google /aclk (or googleadservices pagead/aclk) request fired. */
  sawAclk: () => boolean;
  /**
   * True once the click chain produced ANY observable proof: an aclk request
   * OR the intent://play.google.com deep-link navigation it redirects to.
   * Some app-card clicks only surface the intent hop in the request stream
   * (the aclk hop itself never reaches Playwright), so aclk-only watching
   * mislabels those real clicks as "no navigation" — seen live in storm.
   */
  sawClickProof: () => boolean;
  /** Play package id captured from an intent:// or play.google.com request. */
  packageId: () => string | null;
  /** Remove the listener — always call when the click phase is done. */
  detach: () => void;
}

const ACLK_RE = /google\.[a-z.]+\/aclk[?/]|googleadservices\.com\/pagead\/aclk/i;
const INTENT_RE = /^intent:\/\/play\.google\.com/i;

export function watchAclkRequests(page: Page): AclkWatch {
  const context = page.context();
  let aclk = false;
  let intent = false;
  let pkg: string | null = null;
  const onRequest = (req: Request) => {
    const u = req.url();
    if (ACLK_RE.test(u)) aclk = true;
    if (INTENT_RE.test(u)) intent = true;
    if (!pkg && (u.startsWith("intent://") || u.includes("play.google.com"))) {
      pkg = appAdPackage(u);
    }
  };
  context.on("request", onRequest);
  return {
    sawAclk: () => aclk,
    sawClickProof: () => aclk || intent,
    packageId: () => pkg,
    detach: () => context.off("request", onRequest),
  };
}
