/**
 * Google Ads competitive report.
 *
 * Purpose: SERP paid-ad inventory for monitored brands (TR), who advertises,
 * on which device, at what position, and what click pressure we applied.
 * Scaled for ~100 AdsPower profiles (inventory can be large → CSV first).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../store/db.js";
import { ClickStore } from "../click/store.js";
export interface AdImpressionRow {
  scanId: number;
  capturedAt: string;
  keyword: string;
  device: string;
  profileId: string;
  position: number;
  block: string;
  displayDomain: string;
  finalDomain: string;
  displayUrl: string;
  title: string;
  description: string;
  isBetting: number;
  adHref: string;
}

export interface AdvertiserRow {
  /** Primary SERP display domain */
  displayDomain: string;
  finalDomains: string;
  bestPosition: number;
  impressions: number;
  mobileImpressions: number;
  desktopImpressions: number;
  presence: string;
  keywords: string;
  titles: string;
  profilesSeen: number;
  clickSuccess: number;
  clickSkipped: number;
  clickFailed: number;
  clickCaptcha: number;
  clickTotal: number;
  clickSuccessRate: number;
  /** Rank among advertisers by best position then impressions */
  rank: number;
}

export interface GoogleAdsReport {
  reportType: "google-ads-competitive";
  title: string;
  generatedAt: string;
  market: {
    locale: string;
    googleDomain: string;
    country: string;
  };
  period: { from: string | null; to: string | null; label: string };
  brands: string[];
  scans: {
    count: number;
    scanIds: number[];
    totalAdImpressions: number;
    uniqueAdvertisers: number;
  };
  /** Every paid ad row from scans in period (can be hundreds with 100 profiles). */
  inventory: AdImpressionRow[];
  /** One row per advertiser domain — main Google Ads board. */
  advertisers: AdvertiserRow[];
  /** Focus / #1 advertiser recommendation from latest scan */
  topAdvertiser: AdvertiserRow | null;
  clicks: {
    total: number;
    success: number;
    skipped: number;
    failed: number;
    captcha: number;
    successRate: number;
  };
  summaryText: string;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

export function rowsToCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]!);
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((h) => csvCell(row[h])).join(","));
  return lines.join("\n");
}

function normDomain(d: string): string {
  return d.toLowerCase().replace(/^www\./, "").replace(/^m\./, "").trim();
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface BuildGoogleAdsReportOpts {
  outputDir: string;
  /** Limit to one scan; omit for period aggregate. */
  scanId?: number;
  from?: string;
  to?: string;
  googleDomain?: string;
  country?: string;
}

export function buildGoogleAdsReport(opts: BuildGoogleAdsReportOpts): GoogleAdsReport {
  const store = new Store(opts.outputDir);
  const clickStore = new ClickStore(opts.outputDir);
  const now = new Date().toISOString();
  const to = opts.to ?? now;
  const from = opts.from ?? null;

  try {
    // ── scans in scope ───────────────────────────────────
    let scanIds: number[] = [];
    if (opts.scanId) {
      scanIds = [opts.scanId];
    } else {
      const params: string[] = [];
      let where = "1=1";
      if (from) {
        where += " AND started_at >= ?";
        params.push(from);
      }
      where += " AND started_at <= ?";
      params.push(to);
      scanIds = (
        store.db.prepare(`SELECT id FROM scans WHERE ${where} ORDER BY id DESC`).all(...params) as Array<{
          id: number;
        }>
      ).map((r) => r.id);
    }

    const brandSet = new Set<string>();
    for (const id of scanIds) {
      const row = store.db.prepare(`SELECT keywords FROM scans WHERE id = ?`).get(id) as
        | { keywords?: string }
        | undefined;
      if (!row?.keywords) continue;
      try {
        for (const k of JSON.parse(row.keywords) as string[]) brandSet.add(String(k).toLowerCase());
      } catch {
        /* */
      }
    }

    // ── ad inventory (results) ───────────────────────────
    const inventory: AdImpressionRow[] = [];
    if (scanIds.length) {
      const placeholders = scanIds.map(() => "?").join(",");
      const rows = store.db
        .prepare(
          `SELECT scan_id, captured_at, keyword, device, profile_id, position, block,
                  display_domain, final_domain, display_url, title, description,
                  is_betting, ad_href
           FROM results
           WHERE scan_id IN (${placeholders})
           ORDER BY scan_id DESC, keyword, device, position`
        )
        .all(...scanIds) as Array<Record<string, unknown>>;

      for (const r of rows) {
        inventory.push({
          scanId: Number(r.scan_id),
          capturedAt: String(r.captured_at ?? ""),
          keyword: String(r.keyword ?? ""),
          device: String(r.device ?? ""),
          profileId: String(r.profile_id ?? ""),
          position: Number(r.position ?? 0),
          block: String(r.block ?? ""),
          displayDomain: String(r.display_domain ?? ""),
          finalDomain: String(r.final_domain ?? r.display_domain ?? ""),
          displayUrl: String(r.display_url ?? ""),
          title: String(r.title ?? ""),
          description: String(r.description ?? "").slice(0, 500),
          isBetting: Number(r.is_betting ?? 0),
          adHref: String(r.ad_href ?? ""),
        });
      }
    }

    // ── clicks against domains ───────────────────────────
    const clickParams: string[] = [];
    let clickWhere = "1=1";
    if (from) {
      clickWhere += " AND captured_at >= ?";
      clickParams.push(from);
    }
    clickWhere += " AND captured_at <= ?";
    clickParams.push(to);

    const clickAgg = clickStore.db
      .prepare(
        `SELECT target_domain, device, status, COUNT(*) AS c
         FROM clicks WHERE ${clickWhere}
         GROUP BY target_domain, device, status`
      )
      .all(...clickParams) as Array<{
      target_domain: string;
      device: string;
      status: string;
      c: number;
    }>;

    const clickByDomain = new Map<
      string,
      { success: number; skipped: number; failed: number; captcha: number; total: number }
    >();
    let cSuccess = 0,
      cSkip = 0,
      cFail = 0,
      cCap = 0,
      cTotal = 0;
    for (const r of clickAgg) {
      const n = Number(r.c) || 0;
      cTotal += n;
      const key = normDomain(r.target_domain);
      const b = clickByDomain.get(key) ?? {
        success: 0,
        skipped: 0,
        failed: 0,
        captcha: 0,
        total: 0,
      };
      b.total += n;
      if (r.status === "success") {
        b.success += n;
        cSuccess += n;
      } else if (r.status === "skipped") {
        b.skipped += n;
        cSkip += n;
      } else if (r.status === "captcha") {
        b.captcha += n;
        cCap += n;
      } else {
        b.failed += n;
        cFail += n;
      }
      clickByDomain.set(key, b);
    }

    // ── advertisers board ────────────────────────────────
    type Acc = {
      displayDomain: string;
      finals: Set<string>;
      bestPosition: number;
      impressions: number;
      mobile: number;
      desktop: number;
      keywords: Set<string>;
      titles: Set<string>;
      profiles: Set<string>;
    };
    const byAdv = new Map<string, Acc>();

    for (const ad of inventory) {
      const key = normDomain(ad.displayDomain || ad.finalDomain);
      if (!key || key === "unknown") continue;
      let a = byAdv.get(key);
      if (!a) {
        a = {
          displayDomain: ad.displayDomain || key,
          finals: new Set(),
          bestPosition: ad.position || 99,
          impressions: 0,
          mobile: 0,
          desktop: 0,
          keywords: new Set(),
          titles: new Set(),
          profiles: new Set(),
        };
        byAdv.set(key, a);
      }
      a.impressions += 1;
      if (ad.device === "mobile") a.mobile += 1;
      else if (ad.device === "desktop") a.desktop += 1;
      if (ad.position > 0 && ad.position < a.bestPosition) a.bestPosition = ad.position;
      if (ad.finalDomain) a.finals.add(normDomain(ad.finalDomain));
      if (ad.keyword) a.keywords.add(ad.keyword);
      if (ad.title) a.titles.add(ad.title.slice(0, 80));
      if (ad.profileId) a.profiles.add(ad.profileId);
    }

    // Also include click-only domains (clicked but not in period inventory)
    for (const [dom, c] of clickByDomain) {
      if (byAdv.has(dom)) continue;
      byAdv.set(dom, {
        displayDomain: dom,
        finals: new Set(),
        bestPosition: 99,
        impressions: 0,
        mobile: 0,
        desktop: 0,
        keywords: new Set(),
        titles: new Set(),
        profiles: new Set(),
      });
    }

    let advertisers: AdvertiserRow[] = [...byAdv.entries()].map(([key, a]) => {
      const c = clickByDomain.get(key) ?? {
        success: 0,
        skipped: 0,
        failed: 0,
        captcha: 0,
        total: 0,
      };
      const presence =
        a.mobile && a.desktop ? "both" : a.mobile ? "mobile" : a.desktop ? "desktop" : "unknown";
      return {
        displayDomain: a.displayDomain,
        finalDomains: [...a.finals].join("|"),
        bestPosition: a.bestPosition,
        impressions: a.impressions,
        mobileImpressions: a.mobile,
        desktopImpressions: a.desktop,
        presence,
        keywords: [...a.keywords].join("|"),
        titles: [...a.titles].slice(0, 3).join(" || "),
        profilesSeen: a.profiles.size,
        clickSuccess: c.success,
        clickSkipped: c.skipped,
        clickFailed: c.failed,
        clickCaptcha: c.captcha,
        clickTotal: c.total,
        clickSuccessRate: c.total ? Math.round((1000 * c.success) / c.total) / 10 : 0,
        rank: 0,
      };
    });

    // Rank = best SERP position first (true Google Ads board order), then impressions.
    advertisers.sort((a, b) => {
      if (a.bestPosition !== b.bestPosition) return a.bestPosition - b.bestPosition;
      return b.impressions - a.impressions;
    });
    advertisers = advertisers.map((row, i) => ({ ...row, rank: i + 1 }));

    const topAdvertiser = advertisers[0] ?? null;
    const successRate = cTotal ? Math.round((1000 * cSuccess) / cTotal) / 10 : 0;

    const brands = [...brandSet];
    const summaryText = [
      `Google Ads rekabet raporu · ${now}`,
      `Pazar: TR · google.com.tr · markalar: ${brands.join(", ") || "—"}`,
      `Taramalar: ${scanIds.length} · reklam gösterimi: ${inventory.length} · reklamveren: ${advertisers.length}`,
      topAdvertiser
        ? `#1 reklamveren: ${topAdvertiser.displayDomain} · sıra ${topAdvertiser.bestPosition} · ${topAdvertiser.impressions} gösterim · ${topAdvertiser.presence} · tık ${topAdvertiser.clickSuccess}/${topAdvertiser.clickTotal}`
        : `#1 reklamveren: —`,
      `Tık özeti: ${cSuccess} ok / ${cTotal} deneme (${successRate}%) · skip ${cSkip} · fail ${cFail}`,
      advertisers
        .slice(0, 8)
        .map(
          (a) =>
            `  #${a.rank} ${a.displayDomain} · pos ${a.bestPosition} · imp ${a.impressions} · ${a.presence} · click ${a.clickSuccess}/${a.clickTotal}`
        )
        .join("\n"),
    ].join("\n");

    return {
      reportType: "google-ads-competitive",
      title: "Google Ads Rekabet Raporu (SERP)",
      generatedAt: now,
      market: {
        locale: "tr-TR",
        googleDomain: opts.googleDomain ?? "www.google.com.tr",
        country: opts.country ?? "TR",
      },
      period: {
        from,
        to,
        label: opts.scanId
          ? `scan #${opts.scanId}`
          : from
            ? `${from.slice(0, 10)} → ${to.slice(0, 10)}`
            : `tüm kayıt → ${to.slice(0, 10)}`,
      },
      brands,
      scans: {
        count: scanIds.length,
        scanIds,
        totalAdImpressions: inventory.length,
        uniqueAdvertisers: advertisers.length,
      },
      inventory,
      advertisers,
      topAdvertiser,
      clicks: {
        total: cTotal,
        success: cSuccess,
        skipped: cSkip,
        failed: cFail,
        captcha: cCap,
        successRate,
      },
      summaryText,
    };
  } finally {
    store.close();
    clickStore.close();
  }
}

export interface GoogleAdsReportFiles {
  dir: string;
  summaryJson: string;
  advertisersCsv: string;
  inventoryCsv: string;
  summaryTxt: string;
}

export function writeGoogleAdsReportFiles(
  report: GoogleAdsReport,
  outputDir: string
): GoogleAdsReportFiles {
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const dir = resolve(outputDir, "reports", "google-ads", stamp);
  mkdirSync(dir, { recursive: true });

  const summaryJson = resolve(dir, "google-ads-report.json");
  const advertisersCsv = resolve(dir, "advertisers.csv");
  const inventoryCsv = resolve(dir, "ads-inventory.csv");
  const summaryTxt = resolve(dir, "summary.txt");

  // JSON without full inventory duplicate if huge — still include for completeness
  writeFileSync(summaryJson, JSON.stringify(report, null, 2), "utf8");
  writeFileSync(
    advertisersCsv,
    rowsToCsv(report.advertisers as unknown as Record<string, unknown>[]),
    "utf8"
  );
  writeFileSync(
    inventoryCsv,
    rowsToCsv(report.inventory as unknown as Record<string, unknown>[]),
    "utf8"
  );
  writeFileSync(summaryTxt, report.summaryText, "utf8");

  return { dir, summaryJson, advertisersCsv, inventoryCsv, summaryTxt };
}

/** Stakeholder HTML — Google Ads board, not vault ops. */
export function googleAdsReportToHtml(report: GoogleAdsReport): string {
  const top = report.topAdvertiser;
  const rows = report.advertisers
    .slice(0, 25)
    .map(
      (a) => `<tr>
      <td><b>#${a.rank}</b></td>
      <td>${esc(a.displayDomain)}</td>
      <td>${a.bestPosition}</td>
      <td>${a.impressions}</td>
      <td>${a.mobileImpressions}M / ${a.desktopImpressions}D</td>
      <td>${esc(a.presence)}</td>
      <td>${a.clickSuccess}/${a.clickTotal} <span style="color:#666">(${a.clickSuccessRate}%)</span></td>
      <td style="font-size:11px;color:#555">${esc(a.titles.slice(0, 60))}</td>
    </tr>`
    )
    .join("");

  return `<!DOCTYPE html><html><body style="font-family:Segoe UI,Roboto,Helvetica,sans-serif;color:#202124;max-width:800px;margin:0 auto;padding:16px">
  <div style="border-bottom:3px solid #1a73e8;padding-bottom:12px;margin-bottom:16px">
    <div style="color:#1a73e8;font-size:12px;font-weight:600;letter-spacing:.04em">GOOGLE ADS · SERP REKABET</div>
    <h1 style="margin:6px 0 4px;font-size:22px">${esc(report.title)}</h1>
    <div style="color:#5f6368;font-size:13px">${esc(report.period.label)} · ${esc(report.market.googleDomain)} · ${esc(report.generatedAt)}</div>
  </div>

  <p style="margin:0 0 14px"><b>Markalar:</b> ${esc(report.brands.join(", ") || "—")}</p>

  <table width="100%" cellpadding="10" style="border-collapse:collapse;margin-bottom:18px">
    <tr>
      <td style="background:#e8f0fe;border-radius:8px">
        <div style="font-size:11px;color:#1967d2">REKLAM GÖSTERİMİ</div>
        <div style="font-size:22px;font-weight:700">${report.scans.totalAdImpressions}</div>
      </td>
      <td style="width:8px"></td>
      <td style="background:#e6f4ea;border-radius:8px">
        <div style="font-size:11px;color:#137333">REKLAMVEREN</div>
        <div style="font-size:22px;font-weight:700">${report.scans.uniqueAdvertisers}</div>
      </td>
      <td style="width:8px"></td>
      <td style="background:#fef7e0;border-radius:8px">
        <div style="font-size:11px;color:#b06000">TIK OK</div>
        <div style="font-size:22px;font-weight:700">${report.clicks.success}<span style="font-size:13px;font-weight:500;color:#5f6368"> / ${report.clicks.total}</span></div>
      </td>
    </tr>
  </table>

  ${
    top
      ? `<div style="background:#f8f9fa;border-left:4px solid #1a73e8;padding:12px 14px;margin-bottom:18px">
    <div style="font-size:11px;color:#5f6368;font-weight:600">#1 HEDEF REKLAMVEREN (SERP)</div>
    <div style="font-size:18px;font-weight:700;margin:4px 0">${esc(top.displayDomain)}</div>
    <div style="font-size:13px;color:#5f6368">Sıra ${top.bestPosition} · ${top.impressions} gösterim · ${esc(top.presence)} · tık ${top.clickSuccess}/${top.clickTotal}</div>
  </div>`
      : ""
  }

  <h2 style="font-size:15px;margin:0 0 8px">Reklamveren tablosu</h2>
  <table width="100%" border="0" cellpadding="8" style="border-collapse:collapse;font-size:12px">
    <tr style="background:#f1f3f4;text-align:left">
      <th>#</th><th>Domain</th><th>Pos</th><th>Gösterim</th><th>Cihaz</th><th>Presence</th><th>Tık</th><th>Başlık</th>
    </tr>
    ${rows || "<tr><td colspan=8>Reklam yok</td></tr>"}
  </table>

  <p style="margin-top:20px;font-size:11px;color:#80868b">
    Ekler: <b>advertisers.csv</b> (özet), <b>ads-inventory.csv</b> (ham SERP reklam satırları — profil × keyword × cihaz), <b>google-ads-report.json</b>.
    ${report.inventory.length} envanter satırı · ${report.advertisers.length} reklamveren.
  </p>
</body></html>`;
}
