import type { Page } from "playwright-core";
import type { AdBlock } from "../types.js";

export interface RawAd {
  title: string;
  adHref: string | null;
  displayUrl: string;
  displayDomain: string;
  description: string;
  block: AdBlock;
}

/**
 * Localised labels Google uses to mark an individual paid result. Deliberately
 * excludes grouped-block headers ("Sponsorlu sonuçlar" / "Sponsored results")
 * so we anchor on per-ad labels and expand groups structurally instead.
 */
export const AD_LABEL_TOKENS = [
  "Sponsorlu",
  "Ücretli sponsorlu reklam",
  "Ucretli sponsorlu reklam",
  "Ücretli reklam",
  "Ucretli reklam",
  "Reklam",
  "Reklamlar",
  "Sponsored",
  "Ad",
  "Ads",
  "Anzeige",
  "Gesponsert",
  "Annonce",
  "Sponsorisé",
  "Anuncio",
  "Patrocinado",
  "Sponsorizzato",
  "Annuncio",
  "Advertentie",
  "Gesponsord",
  "Реклама",
];

/**
 * Detect and extract paid/sponsored ads on the current SERP.
 *
 * Strategy (class-name independent): union of every `[data-text-ad]` unit and the
 * containers reached by walking up from a localised ad-label text/aria node; grouped
 * blocks are expanded to their inner cards; fields are read by structure.
 */
export async function parseAds(page: Page, labelTokens: string[] = AD_LABEL_TOKENS): Promise<RawAd[]> {
  return page.evaluate((rawTokens: string[]): RawAd[] => {
    const fold = (s: string): string =>
      (s || "")
        .toLocaleLowerCase("tr")
        .replaceAll("ı", "i")
        .replaceAll("ş", "s")
        .replaceAll("ğ", "g")
        .replaceAll("ü", "u")
        .replaceAll("ö", "o")
        .replaceAll("ç", "c")
        .replace(/\s+/g, " ")
        .trim();

    const tokenSet = new Set(rawTokens.map(fold));
    const isLabelText = (t: string): boolean => {
      if (!t || t.length > 60) return false;
      const f = fold(t);
      if (tokenSet.has(f)) return true;
      // Mobile sometimes wraps badge with thin spaces / newlines
      const compact = f.replace(/\s+/g, " ");
      if (tokenSet.has(compact)) return true;
      // "ucretli sponsorlu reklam" as substring of short badge lines
      if (compact.length <= 40 && (compact.includes("sponsorlu") || compact === "reklam" || compact === "sponsored")) {
        return tokenSet.has(compact) || compact === "ucretli sponsorlu reklam" || compact === "ucretli reklam";
      }
      return false;
    };

    // 1) Label nodes: small NON-INTERACTIVE elements whose own text or aria-label IS a
    //    label token. Anchors are excluded — genuine ad badges are plain spans/divs, and
    //    skipping links avoids matching "Reklamlar"/related-search nav chips.
    const labelNodes: Element[] = [];
    for (const el of document.querySelectorAll("span, div, [aria-label]")) {
      if (el.closest("a")) continue;
      const txt = (el.textContent || "").trim();
      if (txt && isLabelText(txt)) {
        labelNodes.push(el);
        continue;
      }
      const aria = el.getAttribute("aria-label");
      if (aria && isLabelText(aria)) labelNodes.push(el);
    }

    // 2) Candidate containers: every [data-text-ad] unit + each label's ancestor card
    //    + aclk/googleadservices cards (mobile often omits data-text-ad on first paint).
    const containerOf = (label: Element): Element | null => {
      const byAttr =
        label.closest("[data-text-ad]") ||
        label.closest("#tads, #tvcap, #taw, #bottomads, #tadsb") ||
        label.closest("div.uEierd");
      if (byAttr && byAttr.querySelector("a[href]")) {
        // Prefer innermost card under the ads region when label sits on a group header.
        const inner = byAttr.querySelector("[data-text-ad]");
        if (inner && byAttr !== inner) return inner;
        return byAttr;
      }
      // Accept the nearest [data-hveid] only if it is card-shaped; Google stamps data-hveid
      // on almost every block, so an unvalidated match can grab a label sub-block.
      const hveid = label.closest("[data-hveid]");
      if (hveid && hveid.querySelector('[role="heading"], h3') && hveid.querySelector("a[href]")) return hveid;
      let n: Element | null = label;
      for (let i = 0; i < 10 && n; i++) {
        n = n.parentElement;
        if (!n) break;
        const hasLink = n.querySelector("a[href]");
        const hasHeading = n.querySelector('[role="heading"], h3');
        if (hasLink && hasHeading && n.querySelectorAll("a[href]").length <= 10) return n;
      }
      return null;
    };

    const cardFromAclk = (a: Element): Element | null => {
      let n: Element | null = a;
      for (let i = 0; i < 10 && n; i++) {
        if (n.hasAttribute("data-text-ad")) return n;
        const hasHeading = n.querySelector('[role="heading"], h3');
        if (hasHeading && n.querySelectorAll('a[href*="aclk"], a[href*="googleadservices"]').length >= 1) {
          // Avoid giant wrappers (whole SERP column).
          if (n.querySelectorAll("a[href]").length <= 12) return n;
        }
        n = n.parentElement;
      }
      return a.closest("[data-text-ad]") || a.parentElement;
    };

    const containers = new Set<Element>();
    for (const el of document.querySelectorAll("[data-text-ad]")) containers.add(el);
    for (const label of labelNodes) {
      const c = containerOf(label);
      if (c) containers.add(c);
    }
    // Mobile / continuous SERP: aclk links are definitive paid-click URLs.
    for (const a of document.querySelectorAll('a[href*="/aclk?"], a[href*="googleadservices.com/pagead"]')) {
      // Skip tiny nav chips without title.
      const card = cardFromAclk(a);
      if (card) containers.add(card);
    }
    // Explicit ad regions — harvest each direct child card-like block.
    for (const region of document.querySelectorAll("#tads, #tvcap, #taw, #bottomads, #tadsb")) {
      for (const child of region.querySelectorAll("[data-text-ad], [data-hveid]")) {
        if (child.querySelector('[role="heading"], h3') && child.querySelector("a[href]")) {
          containers.add(child);
        }
      }
    }

    // Expand grouped blocks holding multiple ad cards into the individual cards.
    const expanded: Element[] = [];
    for (const c of containers) {
      const inner = c.querySelectorAll("[data-text-ad]");
      if (inner.length > 1) for (const el of inner) expanded.push(el);
      else expanded.push(c);
    }
    // Keep only the innermost cards (drop ancestors of other cards).
    const cards = expanded.filter((c) => !expanded.some((o) => o !== c && c.contains(o)));

    const unwrap = (href: string | null): string | null => {
      if (!href) return null;
      try {
        const u = new URL(href, location.href);
        if (u.pathname.includes("aclk")) {
          const adurl = u.searchParams.get("adurl");
          if (adurl) return adurl;
        }
        if (u.pathname === "/url") {
          const q = u.searchParams.get("q");
          if (q) return q;
        }
        return u.href;
      } catch {
        return href;
      }
    };

    // A real ad badge is a non-interactive descendant whose OWN text is exactly a label
    // token. (Substring matching on the whole card text is useless — "ad" is in everything.)
    const hasBadge = (c: Element): boolean => {
      for (const el of [c, ...c.querySelectorAll("span, div")]) {
        if (el !== c && el.closest("a")) continue;
        const t = (el.textContent || "").trim();
        if (t && isLabelText(t)) return true;
        const aria = el.getAttribute("aria-label");
        if (aria && isLabelText(aria)) return true;
      }
      return false;
    };

    const isAdCard = (c: Element): boolean => {
      if (c.hasAttribute("data-text-ad")) return true;
      if (c.querySelector('a[href*="/aclk?"], a[href*="googleadservices.com"]')) return true;
      // Inside dedicated ad regions, heading+link is enough (mobile badges load late).
      if (c.closest("#tads, #tvcap, #taw, #bottomads, #tadsb")) {
        if (c.querySelector('[role="heading"], h3') && c.querySelector("a[href]")) return true;
      }
      return hasBadge(c);
    };

    const blockOf = (c: Element): AdBlock => {
      if (c.closest("#tads") || c.closest("#tvcap") || c.closest("#taw")) return "top";
      if (c.closest("#bottomads") || c.closest("#tadsb")) return "bottom";
      return "unknown";
    };

    // Requires a real alphabetic TLD so numeric tokens ("4.5", "1.2.3") are not mistaken
    // for a display domain. Allows an optional path.
    const domainLike = /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/[^\s]*)?$/i;

    const ads: RawAd[] = [];
    const seen = new Set<string>();
    for (const c of cards) {
      if (!isAdCard(c)) continue;

      const headingEl = c.querySelector('[role="heading"]') || c.querySelector("h3");
      const anchor =
        c.querySelector('a[href*="aclk"]') ||
        (headingEl ? headingEl.closest("a[href]") : null) ||
        c.querySelector("a[href]");

      const rawHref = anchor ? anchor.getAttribute("href") : null;
      const adHref = unwrap(rawHref);
      const title = ((headingEl || anchor)?.textContent || "").trim();

      // Display URL / domain: first spaceless, domain-shaped text token in the card.
      let displayUrl = "";
      let displayDomain = "";
      for (const el of c.querySelectorAll("span, cite, div")) {
        const t = (el.textContent || "").trim();
        if (!t || t.length > 90 || /\s/.test(t)) continue;
        if (domainLike.test(t)) {
          displayUrl = t;
          displayDomain = t
            .replace(/^https?:\/\//, "")
            .replace(/^www\./, "")
            .split(/[/?#]/)[0]!;
          break;
        }
      }
      // App-store ads (Play Store / App Store): the advertised entity is the
      // app — the store page is the meaningful domain, not google.com.
      if (!displayDomain) {
        const storeA = c.querySelector('a[href*="play.google.com/store"], a[href*="apps.apple.com"]');
        const storeHref = storeA ? storeA.getAttribute("href") || "" : "";
        const sm = storeHref.match(/https?:\/\/(play\.google\.com|apps\.apple\.com)\/[^\s&"']*/);
        if (sm) {
          displayUrl = sm[0];
          displayDomain = sm[1];
        }
      }
      if (!displayDomain && adHref) {
        try {
          const host = new URL(adHref, location.href).hostname.replace(/^www\./, "");
          // Google-owned redirect hosts (aclk etc.) are not the advertiser —
          // leave the domain empty instead of recording a bogus "google.com".
          if (!/(^|\.)google\.[a-z.]+$|googleadservices\.com$|doubleclick\.net$/i.test(host)) {
            displayDomain = host;
          }
        } catch {
          /* ignore */
        }
      }

      // Description: longest multi-word LEAF block that isn't the title/label/domain.
      // Skip wrappers that also contain the heading/link, or their concatenated text
      // (badge + url + title + snippet) would win over the real snippet element.
      let description = "";
      for (const el of c.querySelectorAll("div, span")) {
        if (el.querySelector('[role="heading"], h3, a[href]')) continue;
        const t = (el.textContent || "").trim();
        if (t.length <= description.length || t.length > 400) continue;
        if (t === title || !/\s/.test(t)) continue;
        if (tokenSet.has(fold(t))) continue;
        description = t;
      }

      const key = adHref || displayUrl || title;
      if (!key || seen.has(key)) continue;
      seen.add(key);

      ads.push({ title, adHref, displayUrl, displayDomain, description, block: blockOf(c) });
    }
    return ads;
  }, labelTokens);
}
