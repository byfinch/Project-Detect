/**
 * Build a Google `uule` value that pins the search's physical location.
 *
 * Format (verified): "w+" + base64( [0x08,0x02,0x10,0x20,0x22, <byteLen>] + <canonicalNameBytes> )
 * Using the BYTE length (not char count) makes Turkish diacritics work.
 *
 * Known-good outputs:
 *   uuleForCanonicalName("Turkey")          === "w+CAIQICIGVHVya2V5"
 *   uuleForCanonicalName("Istanbul,Turkey") === "w+CAIQICIPSXN0YW5idWwsVHVya2V5"
 */
export function uuleForCanonicalName(canonicalName: string): string {
  const nameBytes = Buffer.from(canonicalName, "utf8");
  const header = Buffer.from([0x08, 0x02, 0x10, 0x20, 0x22, nameBytes.length]);
  const payload = Buffer.concat([header, nameBytes]);
  // Strip '=' padding to match Google's canonical form; URLSearchParams handles +,/ encoding.
  return "w+" + payload.toString("base64").replace(/=+$/, "");
}

const COUNTRY_NAMES: Record<string, string> = {
  TR: "Turkey",
};

/** Canonical "City,Country" (or just "Country") for a config location. */
export function canonicalLocationName(country: string, city?: string): string {
  const countryName = COUNTRY_NAMES[country.toUpperCase()] ?? country;
  return city ? `${city},${countryName}` : countryName;
}

export function uuleForLocation(country: string, city?: string): string {
  return uuleForCanonicalName(canonicalLocationName(country, city));
}
