/**
 * Heuristic classifier: does an ad look like online betting / gambling?
 * Turkish betting ads lean on a recognisable vocabulary (bahis, casino, bonus,
 * deneme bonusu, giris, ...) plus telltale throwaway TLDs (.click, .link, .vip).
 * This is a guess to help triage, not a legal determination.
 */

const SUSPICIOUS_TLDS = new Set([
  "click",
  "link",
  "vip",
  "bet",
  "casino",
  "icu",
  "sbs",
  "top",
  "xyz",
  "live",
  "fun",
  "buzz",
  "shop",
  "online",
  "site",
]);

function foldTurkish(s: string): string {
  return s
    .toLocaleLowerCase("tr")
    .replaceAll("ı", "i")
    .replaceAll("ş", "s")
    .replaceAll("ğ", "g")
    .replaceAll("ü", "u")
    .replaceAll("ö", "o")
    .replaceAll("ç", "c");
}

export function tldOf(domain: string): string {
  const parts = domain.toLowerCase().split(".");
  return parts.length > 1 ? parts[parts.length - 1]! : "";
}

export function isBettingGuess(
  bettingKeywords: string[],
  parts: { title?: string; description?: string; displayDomain?: string }
): boolean {
  // Classify by the AD's OWN content only. The search keyword is deliberately NOT part of
  // the haystack: scanning a betting keyword must not auto-flag every ad on that SERP.
  const hay = foldTurkish([parts.title, parts.description, parts.displayDomain].filter(Boolean).join(" "));
  const needles = bettingKeywords.map(foldTurkish);

  for (const n of needles) {
    if (n && hay.includes(n)) return true;
  }

  if (parts.displayDomain) {
    const tld = tldOf(parts.displayDomain);
    // A suspicious TLD alone is weak; require it together with a gambling-ish token.
    if (SUSPICIOUS_TLDS.has(tld)) {
      const weakTokens = ["bet", "bahis", "casino", "slot", "win", "spin", "gate", "vale", "play", "gaming"];
      const domFolded = foldTurkish(parts.displayDomain);
      if (weakTokens.some((t) => domFolded.includes(t))) return true;
    }
  }

  return false;
}
