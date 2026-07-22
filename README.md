# Project-Detect

Detect **paid / sponsored ads** on Google Search results for a list of keywords,
in the **Turkey** locale, on **desktop and mobile** — driven through your
**AdsPower** anti-detect profiles. Built for spotting betting/gambling ads
(`Ücretli sponsorlu reklam`) and unmasking the real site behind cloaked ad
domains like `magicpixelvale.click`.

This is **Step 1**: a standalone scanner engine + CLI. It is built so a panel,
scheduler and email alerts can wrap it later.

## What it does

For every keyword × device it:

1. Launches the configured AdsPower profile and attaches Playwright over CDP.
2. Opens Google Turkey with a pinned TR location (`hl=tr`, `gl=tr`, `uule` for Istanbul).
3. Detects the sponsored ad blocks using a **class-name-independent** strategy
   (localised label text `Sponsorlu` / `Ücretli sponsorlu reklam` + the durable
   `[data-text-ad]` anchor), and extracts: display domain, display URL, title,
   description, ad position, and top/bottom block.
4. Unwraps the Google click URL (`/aclk?…&adurl=`) and **follows the redirect
   chain** (HTTP 3xx + meta refresh + JS `location`) through the same TR proxy to
   the real landing site.
5. Flags likely betting ads and stores everything in SQLite + JSON + CSV, with a
   full-page screenshot of each SERP.

## Prerequisites

- **AdsPower** running, on a **paid plan**, with the **Local API enabled**
  (Settings → API). Note the port (default `50325`).
- An **AdsPower API key** (Settings → API → each member has one).
- Two AdsPower profiles, each bound to a **Turkey proxy** (your Proxy Seller TR
  residential/mobile IPs):
  - a **desktop** profile (Windows UA), and
  - a **mobile** profile (Android/iOS UA + mobile screen resolution).
  > Mobile emulation cannot be injected over CDP without contradicting the
  > profile fingerprint, so device = profile. Keep them separate.
- **Node.js ≥ 20** (uses the built-in `node:sqlite`, so no native build).

## Install

```bash
npm install
npm run build
```

## Configure

```bash
cp .env.example .env
```

Fill in `.env`:

```
ADSPOWER_BASE_URL=http://local.adspower.net:50325
ADSPOWER_API_KEY=<your AdsPower API key>
PROFILE_DESKTOP=<desktop profile user_id>
PROFILE_MOBILE=<mobile profile user_id>
TWOCAPTCHA_API_KEY=<optional, only for CAPTCHA fallback>
OUTPUT_DIR=./data
```

Non-secret defaults (locale, delays, hop cap, betting keyword list) live in
[`config/default.json`](config/default.json).

Find your profile IDs:

```bash
npm run doctor      # verify AdsPower connectivity + config
npm run profiles    # list groups + profiles (user_id, name, country)
```

## Run a scan

Put your queries in `keywords.txt` (one per line; see `keywords.example.txt`):

```bash
# Quick first run: 3 keywords, no redirect-following (fast)
node dist/index.js scan --keywords keywords.txt --limit 3 --no-resolve

# Full run: all keywords, desktop + mobile, follow ad redirects
npm run scan -- --keywords keywords.txt

# Desktop only
npm run scan -- --devices desktop
```

`scan` options: `--keywords <file>`, `--devices desktop,mobile`, `--limit <n>`,
`--no-resolve` (skip redirect-following), `--no-screenshots`.

### Profile rotation (avoids CAPTCHA)

A single IP gets Google's `/sorry/` CAPTCHA after ~5 searches. With `scan.rotateProfiles`
(on by default) the scanner spreads queries across a **pool** of AdsPower profiles — all
profiles whose name starts with `scan.profilePrefix` (`TR-ISP-`) for desktop and
`scan.mobileProfilePrefix` (`TR-MOBILE-`) for mobile — using `scan.queriesPerProfile`
searches per profile before rotating to a fresh IP, with a warm-up on each. In testing this
took CAPTCHA walls to zero. No `PROFILE_*` env needed when rotation is on.

### Catching intermittent betting ads

Illegal betting ads on Google TR are **volatile**: Google purges them and affiliates relaunch
in bursts, so any single scan may find zero. The tool is built to be **run repeatedly** — put
it on a schedule (e.g. every 15-30 min) and it will catch the betting ads whenever they surface,
storing each sighting in `detect.sqlite`. Legitimate ads (e.g. "uçak bileti") appear reliably
and confirm the pipeline is working between betting bursts.

## Output

Everything lands in `OUTPUT_DIR` (`./data`):

- `detect.sqlite` — `scans`, `results`, `hops` tables (query across runs).
- `scan-<id>.json` / `scan-<id>.csv` — flat export per scan.
- `screenshots/scan-<id>/<device>-<keyword>.png` — full-page SERP captures.

Re-export any scan later: `npm run report -- --scan <id>` (omit `--scan` for the latest).

## How ad detection stays robust

Google obfuscates and rotates CSS class names, so the parser never relies on
them alone. It anchors on the **legally-required label text** (`Sponsorlu`,
`Ücretli sponsorlu reklam`, `Reklam`, and the English/EU equivalents), unions
that with every `[data-text-ad]` unit, expands grouped `Sponsorlu sonuçlar`
blocks into individual cards, and reads fields by DOM structure. See
[`src/google/adParser.ts`](src/google/adParser.ts).

If Google changes layout, tune the token list / anchors there — the strategy
itself does not depend on class names.

## Project layout

```
src/
  index.ts              CLI (scan / profiles / report / doctor)
  scanner.ts            orchestrator: keyword × device → detect → resolve → store
  config.ts             config + .env loader (zod-validated)
  adspower/client.ts    AdsPower Local API (Bearer auth, 1 req/s, ws.puppeteer)
  browser/session.ts    Playwright attach over CDP to the profile's context
  google/serp.ts        TR SERP URL, consent + CAPTCHA handling
  google/uule.ts        Google location (uule) encoder for Turkey
  google/adParser.ts    resilient sponsored-ad detection/extraction
  resolve/redirectResolver.ts  follow cloaked ad redirect chain to real site
  captcha/solver.ts     2captcha reCAPTCHA fallback (optional)
  analyze/betting.ts    betting/gambling heuristic
  store/db.ts           node:sqlite store
  store/report.ts       JSON/CSV export
```

## Notes & limits

- **Legality/ToS:** scraping Google SERPs violates Google's ToS and Google
  actively fights it. Use real Turkish residential/mobile proxies, low volume and
  human-like pacing (the built-in randomized delays). This is your risk to manage.
- **CAPTCHA:** with genuine TR residential IPs you rarely hit the `sorry` wall.
  If you do, enable `captcha` in `config/default.json` + set `TWOCAPTCHA_API_KEY`.
- **Consent page:** Turkey is not EEA, so a real TR IP skips it; the scanner also
  pre-seeds a consent cookie and clicks "Tümünü kabul et" as a fallback.
- The first live run is also how you validate/tune the parser against the current
  Google TR DOM — start with `--limit 3`.
