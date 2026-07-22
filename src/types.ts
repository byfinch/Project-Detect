export type Device = "desktop" | "mobile";

export type AdBlock = "top" | "bottom" | "unknown";

export type HopType = "initial" | "http" | "meta" | "js" | "final";

export interface RedirectHop {
  seq: number;
  url: string;
  type: HopType;
  status?: number;
  method?: string;
  location?: string;
  atMs?: number;
}

/** One detected paid/sponsored ad on a SERP. */
export interface AdResult {
  keyword: string;
  device: Device;
  profileId: string;
  /** 1-based rank among the ads found in the same block. */
  position: number;
  block: AdBlock;
  /** Domain shown in the ad, e.g. "magicpixelvale.click". */
  displayDomain: string;
  /** Full display URL line under the domain, e.g. "https://www.magicpixelvale.click". */
  displayUrl: string;
  title: string;
  description: string;
  /** Raw anchor href of the ad title (often a googleadservices/aclk tracking URL). */
  adHref: string | null;
  /** Real destination after following the redirect chain (null if not resolved). */
  finalUrl: string | null;
  finalDomain: string | null;
  redirectHops: RedirectHop[];
  /** Heuristic: does this ad look like gambling/betting? */
  isBettingGuess: boolean;
  screenshotPath: string | null;
  capturedAt: string;
}

/** Result of parsing a single SERP page. */
export interface SerpParseResult {
  ads: Array<Omit<AdResult, "device" | "profileId" | "finalUrl" | "finalDomain" | "redirectHops" | "screenshotPath" | "capturedAt">>;
  totalResultsText: string | null;
  captcha: boolean;
}

export interface ScanMeta {
  id?: number;
  startedAt: string;
  finishedAt?: string;
  keywords: string[];
  devices: Device[];
  location: string;
  totalAds: number;
  notes?: string;
}
