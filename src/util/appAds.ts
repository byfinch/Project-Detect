/**
 * App-install ad identity (Google Play Store betting apps).
 *
 * Mobile betting SERPs increasingly carry app-install ads whose display domain
 * is always `play.google.com`. Grouping/matching by that domain is useless —
 * the real advertiser is the APP (Pusulabet, Casibom, …). This module derives
 * a stable synthetic identity:
 *
 *   key:   "app:pusulabet"   (grouping / cooldown / ClickTarget.domain)
 *   brand: "Pusulabet"       (human-facing, report text)
 *
 * Sources, in order of stability:
 *  1) Play package id in the href (`intent://play.google.com/d?id=com.x.y` or
 *     `…/store/apps/details?id=com.x.y`) — fallback when the title yields nothing.
 *  2) Title brand: Play ads render as "Hemen yükle | Pusulabet - Pusulabet Giriş"
 *     or "Jojo'bet' - Jojobet Indir" — brand = segment before the first " - ".
 */

const PLAY_DOMAIN_RE = /(^|\.)play\.google\.com$/i;
const PLAY_HREF_RE = /play\.google\.com\/(store\/apps|d\?)|^intent:\/\/play\.google\.com/i;

export function isAppInstallAd(displayDomain: string | null | undefined, href?: string | null): boolean {
  if (displayDomain && PLAY_DOMAIN_RE.test(displayDomain)) return true;
  if (href && PLAY_HREF_RE.test(href)) return true;
  return false;
}

function slugTr(s: string): string {
  return s
    .toLocaleLowerCase("tr")
    .replace(/['’`"]/g, "")
    .replace(/[^a-z0-9çğıöşü]+/gi, "")
    .slice(0, 40);
}

/** Brand name from the ad title, e.g. "Hemen yükle | Pusulabet - …" → "Pusulabet". */
export function appAdBrand(title: string | null | undefined): string | null {
  if (!title) return null;
  let t = title.trim();
  // Play CTA prefix: "Hemen yükle | X" / "Install | X" / "Yükle | X"
  const pipe = t.split("|");
  if (pipe.length > 1 && /hemen yükle|install|yükle|indir/i.test(pipe[0]!)) {
    t = pipe.slice(1).join("|").trim();
  }
  // Brand = segment before the first dash ("Pusulabet - Pusulabet Giriş").
  const dash = t.split(/\s[-–—]\s/);
  const brand = (dash[0] ?? "").trim();
  if (brand.length < 2 || brand.length > 40) return null;
  return brand;
}

/** Package id from a Play href (`id=com.x.y`), or null. */
export function appAdPackage(href: string | null | undefined): string | null {
  if (!href) return null;
  const m = href.match(/[?&/]id=([a-zA-Z][\w.]+)/);
  return m?.[1] ?? null;
}

/**
 * Stable synthetic identity for an app-install ad: "app:<brandslug>".
 * Falls back to the package id, then null (unidentifiable → skipped).
 */
export function appAdKey(title: string | null | undefined, href?: string | null): string | null {
  const brand = appAdBrand(title);
  if (brand) {
    const slug = slugTr(brand);
    if (slug) return `app:${slug}`;
  }
  const pkg = appAdPackage(href);
  return pkg ? `app:${pkg}` : null;
}
