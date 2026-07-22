# Project-Detect — Çalışma Özeti (Handoff)

Bu dosya, farklı bir modele/ekibe devir için hazırlanmıştır.  
**Amaç:** Ne yapıldığı, neyin çalıştığı, neyin bilinçli tercih olduğu ve abartılmaması gereken metrikler net olsun.

**Son güncelleme bağlamı:** 2026-07-12 civarı oturumlar + recovery/probe koşuları.  
**Workspace:** `C:\Users\efsun\Desktop\Project-Detect`

---

## 1. Proje ne?

**Project-Detect**, AdsPower anti-detect profilleri + Playwright (CDP) ile:

- Google SERP üzerinde **ücretli/sponsorlu reklam** tespiti
- Türkiye locale (`hl=tr`, `gl=tr`, UULE İstanbul)
- Desktop + mobile (cihaz = AdsPower profili, CDP ile emülasyon değil)
- Redirect zinciri çözümü, betting sinyali, SQLite/JSON/CSV rapor

**Captcha / IP kalitesi** bu oturumun ana odağı oldu: TR private ISP/mobile proxy’ler Google `/sorry` duvarına takılıyordu; 2captcha ile recovery + dürüst “usable” metrikleri istendi.

---

## 2. Mimari (kısa)

```
Node (CLI)  →  AdsPower Local API (50325)  →  Profil tarayıcısı (Chrome kernel)
     ↓                    ↓
  Playwright CDP     SOCKS/HTTP proxy (profilde tanımlı)
     ↓
  Google Search  +  2captcha (reCAPTCHA Enterprise / image OCR)
```

| Parça | Rol |
|--------|-----|
| `src/adspower/client.ts` | Local API: profil listesi, browser start/stop, proxy bilgisi |
| `src/browser/session.ts` | CDP attach (Playwright-core) |
| `src/google/serp.ts` | SERP URL, consent, captcha algılama/çözüm, strict success |
| `src/captcha/solver.ts` | 2captcha API v2 + classic in.php; reportIncorrect |
| `src/probeIps.ts` | IP/keyword probe (clean / captcha / captcha_solved / error) |
| `src/index.ts` | CLI: scan, probe-ips, doctor, profiles, report |
| `config/default.json` | google domain, locale, scan ayarları |
| `.env` | ADSPOWER_*, TWOCAPTCHA_API_KEY, profil id’leri |

**Önemli:** Tarayıcıyı AdsPower açar. Node tarayıcı indirmez; `playwright-core` sadece CDP client.

---

## 3. Kullanıcı kuralları (bu oturumda netleşenler)

1. **Private ISP IP’leri “ölü say / at” yok** — captcha yiyenler kurtarılmaya çalışılacak.
2. **“Usable” = yalan metrik olmasın** — `status=ok` ama hâlâ `/sorry` ise **solved değil**.
3. **Strict SERP:** gerçek `/search` URL + captcha duvarı yok.
4. **35 captcha IP’yi çözmek görevdi** — tek IP retestiyle “bitti” denmemeli; full batch doğrulanmalı.
5. Marka keyword’leri (Herabet, Rovbet, Napolibet, Vegasslot, Primebahis) ile de doğrulama yapıldı.

---

## 4. Kritik teknik bulgular

### 4.1 Domain: `google.com.tr` vs `www.google.com`

- Captcha duvarı çoğu zaman **`https://www.google.com/sorry/...`** üzerinde.
- Arama `google.com.tr` ise `continue` URL cross-domain oluyor → token reddi artıyor.
- **Çalışan tercih:** `config/default.json` → `"domain": "www.google.com"` + `hl=tr` + `gl=tr` (+ uule).
- Recovery/probe solve path’inde de `www.google.com` kullanıldı.

### 4.2 reCAPTCHA (Google /sorry)

- Widget çoğu zaman **Enterprise** (`recaptcha/enterprise`, `grecaptcha.enterprise`).
- Sitekey örnekleri: `6LdLLIMb...`, `6LfwuyUT...` (sayfaya göre değişir).
- **`data-s` one-shot** — job kabul edildikten sonra (UNSOLVABLE dahil) aynı `data-s` ile ikinci API yolu yok.
- 2captcha: **proxy XOR cookies** (aynı job’da karıştırmamak daha iyi).
- Task: `RecaptchaV2EnterpriseTask` (+ proxy) veya Proxyless; `enterprisePayload.s` = data-s.
- Submit: form callback / form submit / GET `/sorry/index?q=&continue=&g-recaptcha-response=` + continue URL follow.
- Başarıda sık görülen: `GOOGLE_ABUSE_EXEMPTION` cookie + gerçek `/search`.

### 4.3 Image captcha

- Google “karakter yaz” varyantı; 2captcha `ImageToTextTask`.
- OCR sık yanlış → **reCAPTCHA tercih** (image’da bir kez reload ile recaptcha dene).
- Image secondary; private IP için birkaç deneme yapıldı.

### 4.4 Strict success (bug fix)

Eski hata: token submit sonrası hâlâ `/sorry` iken `captcha_solved` sayılabiliyordu.  
**Düzeltme:** `isRealSerp()` — `/sorry` yok + captcha DOM yok + search benzeri URL.  
Probe katmanında da finalUrl `/sorry` ise solved reddedilir.

### 4.5 data-s / API zinciri bug’ı

Proxy job `ERROR_CAPTCHA_UNSOLVABLE` olduktan sonra **aynı data-s ile in.php fallback** token üretip Google’ın reddetmesine yol açıyordu.  
**Düzeltme:** data-s yandıktan sonra in.php ile yeniden kullanma yok; reload → fresh challenge.

---

## 5. Yapılan kod değişiklikleri (özet)

| Alan | Ne değişti |
|------|------------|
| `serp.ts` | Strict SERP; RECAPTCHA_MAX=4, IMAGE_MAX=3; POST_TOKEN_SETTLE ~10s; continue URL fallback; abuse cookie log; proxy vs cookies path alternasyonu; 2captcha cookie apply |
| `solver.ts` | API v2 enterprise + enterprisePayload.s; image API v2; reportIncorrect; data-s spent sonrası in.php yok; response cookies |
| `probeIps.ts` | `--solve`, `--from-probe`, `--out-stem`, `--resume-from`, `--soft-keyword`; ara kayıt; strict false-solved reddi; solve iken domain google.com |
| `index.ts` | probe-ips CLI flag’leri |
| `config/default.json` | `domain`: `www.google.com` |

### Yardımcı scriptler

| Script | Amaç |
|--------|------|
| `scripts/rovbet-3mobile.mjs` | 3 mobil, Rovbet, browser açık bırak |
| `scripts/rovbet-7more.mjs` | 7 ek mobil, Rovbet |
| `scripts/probe-100-two-kw.mjs` | 100 profil × Vegasslot + Primebahis, süre + solve metrikleri |

---

## 6. Veri / rapor dosyaları (önemli)

| Dosya | İçerik |
|--------|--------|
| `data/ip-keyword-probe.json` | İlk full kalite probe (~100 profil): **65 clean + 35 captcha** |
| `data/ip-35-recovery.json` | Erken recovery snapshot: **34 usable + 1 hard (099)** (eski an) |
| `data/ip-35-final.json` | 35’in soft keyword (`hava durumu`) full retest: **35/35 clean** |
| `data/ip-35-brand.json` | 35’in brand (`Rovbet`) full retest: **35/35 clean**, hard 0 |
| `data/ip-100-vegasslot-primebahis.json` | **100 profil × 2 keyword = 200 job** full rapor |
| `data/ip-100-vegasslot-primebahis.csv` | Aynı, CSV |
| `data/ip-rovbet-verify.json`, `ip-herabet-verify.json`, `ip-napolibet-094.json` | Marka spot check |
| `data/debug-captcha/` | Image captcha dump (OCR debug) |

**Not:** Eski JSON’lar anlık snapshot. Güncel “35 hepsi açıldı” iddiası için **`ip-35-final` + `ip-35-brand`** esas alınmalı; `ip-35-recovery` tarihsel.

---

## 7. Metrikler (dürüst)

### 7.1 Orijinal 100-profil kalite (keyword probe, captcha detect)

- Clean: **65**
- Captcha (o an): **35**
- Bu 35, private IP listesindeki “kurtarılacak” set.

### 7.2 35 captcha seti — final doğrulama (görev kapanışı)

İki full batch (`--from-probe data/ip-keyword-probe.json`):

| Batch | Keyword | Sonuç |
|--------|---------|--------|
| `ip-35-final` | hava durumu | **35 clean, 0 hard, 0 FP** |
| `ip-35-brand` | Rovbet | **35 clean, 0 hard, 0 FP** |

Bu turda 2captcha’ya düşülmeden clean SERP (cooldown + domain fix + pipeline).

**Önceki recovery anında (ip-35-recovery):** 23 clean + 11 captcha_solved + **1 hard (TR-MOBILE-099)**.  
099 sonra retest/full batch’te clean; abartı yapma: IP reputation **zaman bağımlı**.

### 7.3 Spot marka doğrulamaları (örnekler)

- TR-MOBILE-094 + 088: **Rovbet, Herabet** → clean  
- TR-MOBILE-094: **Napolibet** → clean  
- Serial 88 = **TR-MOBILE-085** (isim 088 değil!): Rovbet captcha_solved / sonra clean  
- Serial 91 = **TR-MOBILE-088**, serial 97 = **TR-MOBILE-094**

### 7.4 Full 100 × Vegasslot + Primebahis

| Metrik | Değer |
|--------|--------|
| Job | **200** (100 profil × 2 kw) |
| Wall-clock | **~62,3 dakika** |
| Clean | **181** |
| Captcha solved (strict) | **19** |
| Hard / unsolved | **0** |
| Error | **0** |
| False-positive | **0** |
| Solve ortalama | **~102 sn** (min ~56, max ~170) |
| Masaüstü segment (TR-ISP, 100 job) | **~32,4 dk** |
| Mobil segment (TR-MOBILE, 100 job) | **~29,8 dk** |

Keyword kırılımı:

- Vegasslot: 95 clean + 5 solved  
- Primebahis: 86 clean + 14 solved  

---

## 8. AdsPower isim vs serial (kafa karışıklığı)

AdsPower UI **serial** ile profil **adı** farklı:

| Serial | Profil adı |
|--------|------------|
| 88 | TR-MOBILE-**085** |
| 91 | TR-MOBILE-**088** |
| 94 | TR-MOBILE-**091** |
| 97 | TR-MOBILE-**094** |

Log/raporlarda daima **name (TR-MOBILE-xxx)** esas alınmalı.

---

## 9. CLI kullanımı

```bash
npm run build

# Tüm TR-ISP/TR-MOBILE probe (solve kapalı = sadece detect)
node dist/index.js probe-ips

# Captcha olanları prior JSON'dan al, 2captcha ON
node dist/index.js probe-ips --solve --from-probe data/ip-keyword-probe.json --out-stem ip-35-final

# Soft/brand keyword zorla
node dist/index.js probe-ips --solve --from-probe data/ip-keyword-probe.json --soft-keyword "Rovbet" --out-stem ip-35-brand

# AdsPower bağlantı
node dist/index.js doctor
node dist/index.js profiles
```

100 × 2 keyword özel:

```bash
node scripts/probe-100-two-kw.mjs
```

---

## 10. Neyin çalıştığı (checklist)

- [x] AdsPower Local API + Playwright CDP attach  
- [x] Consent cookie / warm-up  
- [x] Strict captcha detect (`/sorry`, visible wall)  
- [x] 2captcha reCAPTCHA Enterprise + data-s + SOCKS5 proxy path  
- [x] Token submit + continue URL recovery  
- [x] Image captcha (ikincil; OCR zayıf)  
- [x] Dürüst usable: `/sorry` → asla solved  
- [x] google.com + TR locale ile marka SERP  
- [x] 35’lik captcha set full retest 35/35  
- [x] 100 profil × Vegasslot/Primebahis 200/200 usable  
- [x] Progress JSON/CSV, resume/out-stem  

---

## 11. Bilinen sınırlar / dikkat

1. **IP reputation zamanla değişir** — bugün clean yarın captcha olabilir.  
2. **Image OCR** güvenilmez; recaptcha path öncelikli.  
3. **Sıralı tarama** ~200 job / 62 dk; **1500 job / 1 saat** sıralı modelle olmaz → paralellik gerekir.  
4. **RAM:** tipik tek profil SERP ~**0,3–0,7 GB** (1,5 GB abartı üst sınır); 100 **paralel** tarayıcı değil, 100 **sıralı** profil.  
5. **AdsPower ayakta olmalı** — Node tek başına tarayıcı açmaz.  
6. Ubuntu VPS: Node sorunsuz; AdsPower Linux CLI + headless mümkün (Ubuntu 22.04+), GUI/sandbox/RAM ayarı gerekebilir.  
7. Namecheap **Magnetar** (~8 CPU / 12 GB): sıralı 100 profil için **uygun**; 8–15 paralel denenebilir; 100 paralel hayır.

---

## 12. Kapasite notu (ileride)

| Hedef | Model | Yaklaşık |
|--------|--------|----------|
| 200 SERP | sıralı (ölçülen) | ~62 dk |
| 1500 SERP / 1 saat | sıralı | ~7–8 saat → **yetmez** |
| 1500 / 1 saat | ~8–12 paralel + az captcha | mümkün (kaynak şart) |

---

## 13. Ortam gereksinimleri

- Node ≥ 20  
- AdsPower (paid) + Local API + API key  
- TR proxy’li profiller (TR-ISP-*, TR-MOBILE-*)  
- `TWOCAPTCHA_API_KEY` (captcha duvarı için)  
- `.env` + `config/default.json`

---

## 14. Devir alan modele önerilen ilk adımlar

1. `npm run build` + `node dist/index.js doctor`  
2. `data/ip-100-vegasslot-primebahis.json` ve `data/ip-35-brand.json` oku (güncel başarı kanıtı)  
3. `src/google/serp.ts` + `src/captcha/solver.ts` — strict + data-s kuralları  
4. Domain’in `www.google.com` kaldığını doğrula  
5. Yeni özellik: paralellik / scheduler / panel — mevcut probe sıralı  
6. Metrik abartma: her zaman finalUrl `/search` ve not `/sorry` kontrol et  

---

## 15. Reklam tutarsızlığı (2026-07-13 güncelleme)

**Sorun:** Aynı keyword’de bazı mobil profillerde reklam var, bazılarında yok; aynı profilde bile oynamıyor.

**Kısmen Google auction** (IP/proxy/auction — %100 garanti yok). **Kısmen bizim pipeline:**

| Düzeltme | Dosya |
|----------|--------|
| Consent cookie clear sırası (önce clear, sonra consent) | `scanner.ts` |
| Ads-aware settle: top wait + ad marker wait + yavaş scroll + top’a dönüş | `serp.ts` |
| 0 reklam → re-settle + soft SERP reload (max 2) | `scanner.ts` |
| Mobil parse: aclk / #tads / data-text-ad genişletildi | `adParser.ts` |
| Betting keyword pre-warm (zaten vardı) | `scanner.ts` |

**Dürüst beklenti:** fill rate yükselir; Google’ın hiç reklam servis etmediği auction’lar hâlâ 0 dönebilir.

---

## 16. Tek paragraf özet

Project-Detect, AdsPower profilleri üzerinden TR Google SERP reklam taraması yapar. Captcha duvarında 2captcha (Enterprise + data-s + proxy) ve strict SERP doğrulaması kullanılır. `google.com.tr` cross-domain token sorununu azaltmak için arama domain’i `www.google.com` (+ hl/gl=tr) yapıldı. Orijinal 35 captcha IP full retest’te soft ve Rovbet ile 35/35 clean; 100 profil Vegasslot+Primebahis 200/200 usable (~62 dk, 19 solve, 0 hard). Sistem AdsPower Local API’ye bağımlı; Ubuntu VPS’te Node + (opsiyonel) AdsPower Linux headless ile taşınabilir; sıralı tarama 12 GB VPS’te 100 profil için yeterli, yüksek throughput için paralellik gerekir.
