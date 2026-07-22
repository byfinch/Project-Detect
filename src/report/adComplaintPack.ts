/**
 * Google Ads şikâyet paketi.
 *
 * Amaç: Tespit edilen reklamları Google'a şikâyet ederken kopyala-yapıştır
 * kanıt dosyası üretmek. Otomatik Google form gönderimi YOK (hesap/ToS);
 * paket insan tarafından Report ad / Policy formuna işlenir.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { Store } from "../store/db.js";
import { logger } from "../logger.js";

export interface ComplaintAdRow {
  resultId: number;
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
  adHref: string;
  finalUrl: string;
  isBetting: boolean;
  screenshotPath: string | null;
  screenshotInPack: string | null;
  folder: string;
}

export interface ComplaintPackResult {
  dir: string;
  indexCsv: string;
  howToMd: string;
  ads: ComplaintAdRow[];
  count: number;
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 48) || "ad";
}

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]!);
  return [headers.join(","), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(","))].join(
    "\n"
  );
}

/** Google'ın formlarına yapıştırılacak metin (TR). */
function buildComplaintText(ad: ComplaintAdRow): string {
  const reason = ad.isBetting
    ? "Yanıltıcı / yasa dışı kumar-bahis reklamı (TR arama, marka anahtar kelimesi). Politika ihlali şüphesi."
    : "Yanıltıcı veya marka taklidi / spam reklam şüphesi. Kullanıcıyı aldatıcı SERP reklamı.";

  return `GOOGLE ADS ŞİKÂYET FORMU — KOPYALA / YAPIŞTIR
========================================

[Nereye şikâyet?]
1) Reklamı Google'da görünce ⋮ / "Şikayet et" / "Report ad"
2) https://support.google.com/google-ads/answer/176207
3) https://support.google.com/legal (yasal içerik)
4) https://reportcontent.google.com (uygunsuz içerik)

[Şikâyet türü önerisi]
${reason}

[Tarih / saat (UTC)]
${ad.capturedAt}

[Arama kelimesi / marka]
${ad.keyword}

[Cihaz]
${ad.device}

[SERP sırası / blok]
position=${ad.position} · block=${ad.block}

[Reklam başlığı]
${ad.title}

[Reklam açıklaması]
${ad.description}

[Görünen domain]
${ad.displayDomain}

[Display URL]
${ad.displayUrl || "—"}

[Tıklama URL (aclk)]
${ad.adHref || "—"}

[Final URL / landing]
${ad.finalUrl || "—"}

[Final domain]
${ad.finalDomain || "—"}

[Kanıt]
- Ekran görüntüsü: ${ad.screenshotInPack || ad.screenshotPath || "yok"}
- Detect result_id: ${ad.resultId}
- Scan id: ${ad.scanId}
- Profil: ${ad.profileId}

[Kısa açıklama (form metni)]
"${ad.keyword}" aramasında Google TR sonuçlarında ücretli reklam olarak
"${ad.title}" başlıklı, ${ad.displayDomain} domainli reklam görüldü.
${ad.isBetting ? "Bahis/kumar içeriği ile ilişkili görünüyor; " : ""}
Yanıltıcı veya politika ihlali olabileceğini düşünüyorum. Ekte tarih,
anahtar kelime, URL ve ekran görüntüsü mevcuttur. Lütfen inceleyin.

[Not]
Bu dosya Detect tarama sisteminden üretilmiştir. Google formu
otomatik doldurulmaz; bilgileri form alanlarına elle yapıştırın.
`;
}

export function buildAdComplaintPack(opts: {
  outputDir: string;
  scanId?: number;
  /** Only betting-flagged rows when true */
  bettingOnly?: boolean;
}): ComplaintPackResult {
  const store = new Store(opts.outputDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = resolve(opts.outputDir, "reports", "ad-complaints", stamp);
  mkdirSync(dir, { recursive: true });

  try {
    let sql = `SELECT id, scan_id, captured_at, keyword, device, profile_id, position, block,
                      display_domain, final_domain, display_url, title, description,
                      ad_href, final_url, is_betting, screenshot_path
               FROM results`;
    const params: number[] = [];
    if (opts.scanId) {
      sql += ` WHERE scan_id = ?`;
      params.push(opts.scanId);
      if (opts.bettingOnly) sql += ` AND is_betting = 1`;
    } else if (opts.bettingOnly) {
      sql += ` WHERE is_betting = 1`;
    }
    sql += ` ORDER BY scan_id DESC, keyword, position`;

    const rows = store.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    // Dedupe: the same ad seen by N profiles is ONE complaint — keep the newest row.
    const seen = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      const key = `${String(r.keyword)}|${String(r.display_domain)}|${String(r.device)}`;
      const prev = seen.get(key);
      if (!prev || String(r.captured_at ?? "") > String(prev.captured_at ?? "")) seen.set(key, r);
    }
    const dedupedRows = [...seen.values()];
    const ads: ComplaintAdRow[] = [];

    for (let i = 0; i < dedupedRows.length; i++) {
      const r = dedupedRows[i]!;
      const resultId = Number(r.id);
      const domain = String(r.display_domain || r.final_domain || "unknown");
      const folderName = `${String(i + 1).padStart(3, "0")}_${safeName(domain)}_${resultId}`;
      const folder = resolve(dir, folderName);
      mkdirSync(folder, { recursive: true });

      let screenshotInPack: string | null = null;
      const shot = r.screenshot_path ? String(r.screenshot_path) : "";
      if (shot && existsSync(shot)) {
        const destName = `screenshot${shot.toLowerCase().endsWith(".png") ? ".png" : ""}`;
        const dest = resolve(folder, destName || "screenshot.png");
        try {
          copyFileSync(shot, dest);
          screenshotInPack = destName || basename(dest);
        } catch {
          screenshotInPack = null;
        }
      }

      const ad: ComplaintAdRow = {
        resultId,
        scanId: Number(r.scan_id),
        capturedAt: String(r.captured_at ?? ""),
        keyword: String(r.keyword ?? ""),
        device: String(r.device ?? ""),
        profileId: String(r.profile_id ?? ""),
        position: Number(r.position ?? 0),
        block: String(r.block ?? ""),
        displayDomain: domain,
        finalDomain: String(r.final_domain ?? ""),
        displayUrl: String(r.display_url ?? ""),
        title: String(r.title ?? ""),
        description: String(r.description ?? ""),
        adHref: String(r.ad_href ?? ""),
        finalUrl: String(r.final_url ?? ""),
        isBetting: Number(r.is_betting) === 1,
        screenshotPath: shot || null,
        screenshotInPack,
        folder: folderName,
      };

      writeFileSync(resolve(folder, "SIKAYET.txt"), buildComplaintText(ad), "utf8");
      writeFileSync(resolve(folder, "ad.json"), JSON.stringify(ad, null, 2), "utf8");
      ads.push(ad);
    }

    const indexRows = ads.map((a) => ({
      folder: a.folder,
      resultId: a.resultId,
      scanId: a.scanId,
      keyword: a.keyword,
      device: a.device,
      position: a.position,
      displayDomain: a.displayDomain,
      finalDomain: a.finalDomain,
      title: a.title,
      isBetting: a.isBetting ? 1 : 0,
      hasScreenshot: a.screenshotInPack ? 1 : 0,
      adHref: a.adHref,
      finalUrl: a.finalUrl,
      capturedAt: a.capturedAt,
    }));

    const indexCsv = resolve(dir, "INDEX.csv");
    writeFileSync(indexCsv, toCsv(indexRows as unknown as Record<string, unknown>[]), "utf8");

    const howToMd = resolve(dir, "NASIL_SIKAYET_EDILIR.md");
    writeFileSync(
      howToMd,
      `# Google Ads şikâyet paketi

Bu klasör Detect taramasından üretilen **kanıt dosyalarıdır**.
Sistem Google'a otomatik şikâyet **göndermez** — siz formları doldurursunuz.

## Nereye şikâyet?

1. **Reklam üzerinden (en hızlı)**  
   Google sonuçlarında reklamın yanındaki menü → **Şikayet et / Report ad**

2. **Google Ads yardım / politika**  
   https://support.google.com/google-ads/answer/176207

3. **Yasal içerik**  
   https://support.google.com/legal  
   https://reportcontent.google.com

## Nasıl kullanılır?

1. \`INDEX.csv\` ile tüm reklamları listele.
2. Her alt klasörde:
   - \`SIKAYET.txt\` → form alanlarına kopyala-yapıştır
   - \`screenshot.png\` → forma ekle / yükle
   - \`ad.json\` → teknik kayıt
3. Özellikle \`isBetting=1\` satırları öncelikli.

## Bu pakette

- Reklam adedi: **${ads.length}**
- Klasör: \`${dir}\`

Üretilme: ${new Date().toISOString()}
`,
      "utf8"
    );

    logger.info(
      {
        dir,
        count: ads.length,
        domains: [...new Set(ads.map((a) => a.displayDomain).filter(Boolean))].slice(0, 20),
      },
      `Şikayet paketi hazır: ${ads.length} reklam · ${dir}`
    );
    return { dir, indexCsv, howToMd, ads, count: ads.length };
  } finally {
    store.close();
  }
}
