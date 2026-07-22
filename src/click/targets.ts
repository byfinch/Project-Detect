import type { Store } from "../store/db.js";
import type { Device } from "../types.js";
import type { ClickTarget } from "./types.js";
import { analyzeScanClones } from "../analyze/cloneReport.js";

/**
 * Build ClickTargets from a scan's clone/betting ads.
 *
 * One target per domain. targetDevice = where it was seen (mobile/desktop/both).
 * recommendedClicks = budget from clone analysis.
 * impressions = seer shortlist (profiles that already saw the ad) — engine gives each 1 click first,
 * then fills remaining budget with other pool profiles (never spam one profile).
 */
export function domainPlanTotal(t: {
  recommendedClicks?: { mobile?: number; desktop?: number };
}): number {
  return (t.recommendedClicks?.mobile ?? 0) + (t.recommendedClicks?.desktop ?? 0);
}

/** Prefer domains with more scan hits first (focus fire). */
export function sortTargetsByPriority(targets: ClickTarget[]): ClickTarget[] {
  return [...targets].sort((a, b) => {
    const ha = a.impressions?.length ?? 0;
    const hb = b.impressions?.length ?? 0;
    if (hb !== ha) return hb - ha;
    return domainPlanTotal(b) - domainPlanTotal(a);
  });
}

export function buildTargetsFromScan(
  store: Store,
  scanId: number,
  opts: { mode?: "conservative" | "adaptive" | "aggressive" } = {}
): ClickTarget[] {
  const analysis = analyzeScanClones(store, scanId, { mode: opts.mode ?? "adaptive" });

  // Play Store app ads surface as display_domain google.com / play.google.com —
  // Google itself is never a focus target (the betting entity is the app).
  const isGoogleDomain = (d: string) => /(^|\.)google\.[a-z.]+$/i.test(d.trim());

  const list = analysis.clones
    .filter((c) => !isGoogleDomain(c.domain))
    .map((c) => {
    const impressions = c.hits.map((h) => ({
      profileId: h.profileId,
      device: h.device as Device,
      keyword: h.keyword,
      displayDomain: h.displayDomain,
      finalDomain: h.finalDomain,
      title: h.title,
    }));

    const seerMobile = new Set(c.mobileProfiles).size;
    const seerDesktop = new Set(c.desktopProfiles).size;
    const planM = c.clickPlan.mobileClicks;
    const planD = c.clickPlan.desktopClicks;

    return {
      domain: c.domain,
      keywords: c.keywords,
      targetDevice: c.presence,
      titleHint: c.titles[0],
      impressions,
      recommendedClicks: {
        mobile: planM,
        desktop: planD,
      },
      planReason: `${c.clickPlan.reason} · seer-first (M${seerMobile}/D${seerDesktop} gördü → 1’er tık, kalan diğer profiller)`,
    };
  });

  // One domain at a time in click ops — order by how often it was seen.
  return sortTargetsByPriority(list);
}
