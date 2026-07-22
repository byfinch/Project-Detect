/** Best-effort hostname extraction (no external PSL dependency). */
export function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // Might be a bare "example.click" display string.
    const m = url.match(/^([a-z0-9-]+\.)+[a-z]{2,}/i);
    return m ? m[0].replace(/^www\./, "") : null;
  }
}

/** Normalise a display domain string shown in an ad ("https://www.foo.click/" -> "foo.click"). */
export function normalizeDisplayDomain(raw: string): string {
  const trimmed = raw.trim().replace(/\s+›.*$/, ""); // strip breadcrumb tail "foo.click › path"
  const host = hostnameOf(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
  return host ?? trimmed.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0]!;
}
