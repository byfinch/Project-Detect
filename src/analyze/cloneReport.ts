import type { Store } from "../store/db.js";
import type { Device } from "../types.js";
import type { TargetDevice } from "../click/types.js";
import { isBettingGuess } from "./betting.js";
import { appAdKey, isAppInstallAd } from "../util/appAds.js";

export interface CloneAdHit {
  keyword: string;
  device: Device;
  profileId: string;
  title: string;
  displayDomain: string;
  finalDomain: string | null;
  block: string;
}

export interface ClickPlan {
  /** Profiles/devices to use for clicks on this clone. */
  presence: TargetDevice;
  mobileClicks: number;
  desktopClicks: number;
  totalClicks: number;
  /** Human-readable reason. */
  reason: string;
}

export interface CloneAdSummary {
  domain: string;
  finalDomains: string[];
  titles: string[];
  keywords: string[];
  /** How many scan rows (impressions) per device. */
  mobileHits: number;
  desktopHits: number;
  mobileProfiles: string[];
  desktopProfiles: string[];
  presence: TargetDevice;
  isClone: true;
  clickPlan: ClickPlan;
  hits: CloneAdHit[];
}

export interface ScanCloneAnalysis {
  scanId: number;
  totalAds: number;
  cloneCount: number;
  clones: CloneAdSummary[];
  /** Totals for the whole scan click plan. */
  totalMobileClicks: number;
  totalDesktopClicks: number;
  totalClicks: number;
}

interface ResultRow {
  keyword: string;
  device: string;
  profile_id: string;
  title: string;
  description: string;
  display_domain: string;
  display_url: string;
  ad_href: string | null;
  final_domain: string | null;
  is_betting: number;
  block: string;
}

function normDomain(d: string): string {
  return d.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
}

/**
 * Click budget by presence.
 *
 * VPS budget (Magnetar-class): max ~10 concurrent AdsPower browsers.
 * Plan must never assume 10M+10D (=20) concurrent work.
 *
 * - mobile only  → up to 10 mobile (full concurrent capacity on one side)
 * - desktop only → up to 10 desktop
 * - both         → 5 mobile + 5 desktop (share capacity; rules intact: only devices that saw the ad)
 *
 * If one side has no profiles later at click time, engine uses only the available side
 * (up to its plan or remaining capacity) — still never both-sides 10+10.
 */
export function recommendClickPlan(
  presence: TargetDevice,
  mode: "conservative" | "adaptive" | "aggressive" = "adaptive"
): ClickPlan {
  // Single-device budget (uses full concurrent pool of 10 when only one device is active).
  const single =
    mode === "conservative" ? 5 : mode === "aggressive" ? 10 : 10;
  // Both: always share 5+5 (total 10). Aggressive does NOT double to 10+10.
  const bothEach = mode === "conservative" ? 3 : 5;

  if (presence === "mobile") {
    return {
      presence,
      mobileClicks: single,
      desktopClicks: 0,
      totalClicks: single,
      reason: `Sadece mobilde görüldü → ${single} mobil tıklama (tek cihaz, full pool)`,
    };
  }
  if (presence === "desktop") {
    return {
      presence,
      mobileClicks: 0,
      desktopClicks: single,
      totalClicks: single,
      reason: `Sadece masaüstünde görüldü → ${single} masaüstü tıklama (tek cihaz, full pool)`,
    };
  }
  return {
    presence: "both",
    mobileClicks: bothEach,
    desktopClicks: bothEach,
    totalClicks: bothEach * 2,
    reason: `Mobil + masaüstünde görüldü → ${bothEach}M + ${bothEach}D (paylaşımlı, toplam ${bothEach * 2}; 10+10 yok)`,
  };
}

/**
 * Group scan ads by domain and derive device presence + click plan.
 * Default callers include all detected ads as click targets.
 */
export function analyzeScanClones(
  store: Store,
  scanId: number,
  opts: {
    mode?: "conservative" | "adaptive" | "aggressive";
    brandKeywords?: string[];
    /** When true, only is_betting / betting-guess rows (legacy). Default false = all ads. */
    bettingOnly?: boolean;
  } = {}
): ScanCloneAnalysis {
  const mode = opts.mode ?? "adaptive";
  const bettingOnly = opts.bettingOnly === true;
  const rows = store.resultsForScan(scanId) as unknown as ResultRow[];
  const totalAds = rows.length;

  const byDomain = new Map<string, ResultRow[]>();
  for (const row of rows) {
    if (bettingOnly) {
      const betting =
        row.is_betting === 1 ||
        isBettingGuess(opts.brandKeywords ?? [], {
          title: row.title,
          description: row.description,
          displayDomain: row.display_domain,
        });
      if (!betting) continue;
    }
    let key = normDomain(row.display_domain || row.final_domain || "");
    if (!key || key === "unknown") continue;
    // Google-owned shells are never a click target — EXCEPT app-install ads:
    // a play.google.com display domain hides the real advertiser (the betting
    // app). Group those by synthetic app identity so a Play-only night still
    // plans a campaign. Other google.* shells stay excluded.
    if (/(^|\.)google\.[a-z.]+$/i.test(key)) {
      const appKey = isAppInstallAd(row.display_domain, row.ad_href)
        ? appAdKey(row.title, row.ad_href)
        : null;
      if (!appKey) continue;
      key = appKey;
    }

    const list = byDomain.get(key) ?? [];
    list.push(row);
    byDomain.set(key, list);
  }

  const clones: CloneAdSummary[] = [];

  for (const [key, list] of byDomain) {
    const mobileRows = list.filter((r) => r.device === "mobile");
    const desktopRows = list.filter((r) => r.device === "desktop");
    const mobileSeen = mobileRows.length > 0;
    const desktopSeen = desktopRows.length > 0;
    const presence: TargetDevice =
      mobileSeen && desktopSeen ? "both" : mobileSeen ? "mobile" : "desktop";

    const clickPlan = recommendClickPlan(presence, mode);

    const titles = [...new Set(list.map((r) => r.title).filter(Boolean))];
    const keywords = [...new Set(list.map((r) => r.keyword))];
    const finalDomains = [
      ...new Set(list.map((r) => r.final_domain).filter((d): d is string => !!d)),
    ];

    clones.push({
      // App-install groups key on the synthetic identity (app:brand) — that is
      // the ClickTarget domain downstream; web groups keep the display domain.
      domain: key.startsWith("app:") ? key : list[0]!.display_domain,
      finalDomains,
      titles,
      keywords,
      mobileHits: mobileRows.length,
      desktopHits: desktopRows.length,
      mobileProfiles: [...new Set(mobileRows.map((r) => r.profile_id))],
      desktopProfiles: [...new Set(desktopRows.map((r) => r.profile_id))],
      presence,
      isClone: true,
      clickPlan,
      hits: list.map((r) => ({
        keyword: r.keyword,
        device: r.device as Device,
        profileId: r.profile_id,
        title: r.title,
        displayDomain: r.display_domain,
        finalDomain: r.final_domain,
        block: r.block,
      })),
    });
  }

  // Sort: both first, then more hits
  clones.sort((a, b) => {
    const rank = (p: TargetDevice) => (p === "both" ? 0 : p === "mobile" ? 1 : 2);
    const dr = rank(a.presence) - rank(b.presence);
    if (dr !== 0) return dr;
    return b.mobileHits + b.desktopHits - (a.mobileHits + a.desktopHits);
  });

  const totalMobileClicks = clones.reduce((s, c) => s + c.clickPlan.mobileClicks, 0);
  const totalDesktopClicks = clones.reduce((s, c) => s + c.clickPlan.desktopClicks, 0);

  return {
    scanId,
    totalAds,
    cloneCount: clones.length,
    clones,
    totalMobileClicks,
    totalDesktopClicks,
    totalClicks: totalMobileClicks + totalDesktopClicks,
  };
}
