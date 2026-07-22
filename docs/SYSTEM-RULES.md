# System rules — captcha wall & pool protection

## Working pool (DO NOT TOUCH)

File: `data/PROTECT-PROFILES.txt`

- Soft smoke clean mobiles (2026-07-14): 064, 074, 075, 090, 091, 094, 097, 098, 099
- Recovery **always skips** these
- Production scan: `--only-profiles data/PROTECT-PROFILES.txt --protect-pool`
- Never: proxy reassign, clear cookies, fingerprint regen, thrash CapSolver

Desktop: historical clean TR-ISP — scan with protect-pool; do not thrash.

## Banned (death spiral)

| Setting | Status |
|---------|--------|
| `fingerprint.syncBeforeScan` | **false** |
| `newFingerprint` each scan | **banned** when captcha on |
| `clearProfileData` default | **false** |
| Web UI clearProfile | **false** |
| Warm-up `bahis siteleri` | **removed** |
| Direct brand SERP cold (no trend first) | **banned** when captcha mode on |
| Recovery on protect list (bulk) | **blocked** (explicit `--only` may gentle-check) |

## Session trust path (MANDATORY for brand scan / click)

When captcha mode is on, every profile open must:

1. Google home → live **Trend olan aramalar** (randomized, de-duplicated)
2. If `/sorry` → CapSolver/2captcha on that natural path
3. Only when clean/solved → brand keyword (`herabet`, etc.)

Never: open profile → direct `/search?q=herabet`.

Implemented in `warmUp()` → `recoverViaTrendClick()` (scanner + click worker).

## Hard / captcha profiles

1. Trend path first (not fixed soft keyword)
2. CapSolver → 2captcha, max **2** recaptcha attempts
3. Fail → skip profile / no brand keyword
4. Success → vault + brand search allowed
5. Never mix protect pool into hard recovery batches

## Clone detection & click plan (web panel)

After each scan the panel runs **clone analysis**:

1. Group betting/clone ads by domain  
2. Presence: **mobile only** | **desktop only** | **both**  
3. Click plan (adaptive default):
   - mobile only → **5 mobil** tık  
   - desktop only → **5 masaüstü** tık  
   - both → **5 mobil + 5 masaüstü**  
   - conservative: 3 / aggressive: 8 per device type  

API: `GET /api/scans/:id/clones` · click uses this plan automatically.

## Active scan pool (5 + 5)

- Default `scan.maxProfilesPerDevice: 5`
- Web panel / normal scan: **5 mobile + 5 desktop** (usable vault preferred), **not** all 50+50
- `concurrency` = parallel workers (default 2), not pool size
- Explicit `--only-names` / `--only-profiles` bypasses the cap

## Production scan

```bash
npm run build
node dist/index.js scan --only-profiles data/PROTECT-PROFILES.txt --protect-pool --no-clear-profile
```

(Adjust CLI flags to match `src/index.ts`.)
