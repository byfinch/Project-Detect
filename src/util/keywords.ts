import { readFileSync } from "node:fs";

const BRAND_SUFFIXES = [
  "giriş",
  "güncel adres",
  "yeni adres",
  "adres",
  "sitesi",
  "kayıt",
  "üyelik",
  "bonus",
];

/** Read a keyword file: one query per line, '#' comments and blank lines ignored. */
export function loadKeywords(path: string): string[] {
  const raw = readFileSync(path, "utf8");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const kw = line.trim();
    if (!kw || kw.startsWith("#")) continue;
    const key = kw.toLocaleLowerCase("tr");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** Expand a list of brand keywords into query variations.
 *
 * The original brand is always included. Turkish suffixes such as
 * "giriş", "güncel giriş", "yeni adres" etc. are appended to each brand.
 * A custom suffix list can slim the expansion (scheduled scans use fewer
 * variants to protect the 2h cadence and IP budget).
 */
export function expandBrandKeywords(brands: string[], suffixes: string[] = BRAND_SUFFIXES): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const brand of brands) {
    const base = brand.trim();
    if (!base) continue;

    const variations = [base, ...suffixes.map((s) => `${base} ${s}`)];
    for (const v of variations) {
      const key = v.toLocaleLowerCase("tr");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }

  return out;
}

