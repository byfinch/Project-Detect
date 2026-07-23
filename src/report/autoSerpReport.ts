/**
 * Auto SERP "Report ad" helpers.
 *
 * Used by the click worker to report an ad from the same live SERP impression
 * before clicking it. The standalone campaign operators were removed; reporting
 * is now always done inline with a click.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../logger.js";
import type { Device } from "../types.js";
import type { ElementHandle, Page } from "playwright-core";
import { sleep } from "../util/time.js";

export interface ReportTask {
  resultId?: number;
  keyword: string;
  device?: Device;
  displayDomain: string;
  title: string;
  description?: string;
  capturedAt?: string;
  /** Landing/bet site the ad leads to (strongest evidence for Google). */
  finalDomain?: string | null;
  finalUrl?: string | null;
  /** Google's aclk click URL — proves it is a paid ad, not organic. */
  adHref?: string | null;
  displayUrl?: string;
  /** Seed for per-profile template variation (profile name/id). */
  seed?: string;
}

function normalizeDomain(s: string): string {
  return s.toLowerCase().replace(/^(www\.|m\.)/, "").trim();
}

/**
 * Combinatorial complaint text generator. Thousands of reports must NOT share
 * sentence structures — Google's abuse analysis clusters identical templates.
 * Parts (opening × evidence layout × claim × closing × lexicon) are picked by
 * a seeded RNG, so each (profile, domain, day) yields a distinct but stable text.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(task: ReportTask): number {
  const s = `${task.seed}|${task.displayDomain}|${(task.capturedAt || "").slice(0, 10)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function buildReportText(task: ReportTask): string {
  const rnd = mulberry32(seedOf(task));
  const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]!;

  const dest = task.finalUrl || (task.finalDomain ? `https://${task.finalDomain}` : "");
  const isPlayStoreAd = /(^|\.)google\.[a-z.]+$/i.test(task.displayDomain || "");
  const when = task.capturedAt || new Date().toISOString();
  const whenTr = new Date(when).toLocaleString("tr-TR");
  const dev = task.device === "mobile"
    ? pick(["mobil cihazımdan", "telefonumdan", "mobil tarayıcıdan"])
    : pick(["masaüstü bilgisayarımdan", "bilgisayarımdan", "masaüstü tarayıcıdan"]);
  const adWord = pick(["reklam", "sponsorlu bağlantı", "ücretli ilan", "sponsorlu reklam"]);
  const betWord = pick(["bahis/kumar", "çevrimiçi kumar", "yasa dışı bahis", "online bahis"]);
  const aclkLine = task.adHref ? pick([
    `\nÜcretli reklam bağlantısı: ${task.adHref.slice(0, 280)}`,
    `\nReklamın tıklama linki (aclk): ${task.adHref.slice(0, 280)}`,
    `\nKanıt bağlantı: ${task.adHref.slice(0, 280)}`,
  ]) : "";
  const destSentence = isPlayStoreAd
    ? pick([
        `Reklam, kullanıcıyı Google Play Store'daki "${task.title}" adlı ${betWord} uygulamasına yönlendiriyor.`,
        `Bağlantı Play Store'da ${betWord} hizmeti veren bir uygulamanın ("${task.title}") sayfasına çıkıyor.`,
        `Tıklayan kullanıcı Play Store üzerinden "${task.title}" adlı ${betWord} uygulamasına götürülüyor.`,
      ])
    : dest
    ? pick([
        `Bağlantıya tıklayan kullanıcı "${dest}" adresindeki ${betWord} sitesine yönlendiriliyor.`,
        `Reklam, tıklandığında kullanıcıyı "${dest}" üzerindeki ${betWord} içerikli siteye götürüyor.`,
        `Tıkladığımda "${dest}" adresinde, ${betWord} hizmeti sunan bir siteye ulaştım.`,
        `Bağlantının yönlendirdiği yer: "${dest}" — ${betWord} içeriği barındırıyor.`,
      ])
    : pick([
        `Reklamın ${betWord} içeriğine yönlendirdiğinden şüpheleniyorum.`,
        `İçerik ${betWord} ile ilişkili görünüyor.`,
      ]);

  const opening = pick([
    `Google Türkiye arama sonuçlarında "${task.keyword}" sorgusunda "${task.title}" başlıklı, ${task.displayDomain} alan adlı bir ${adWord} gördüm.`,
    `"${task.keyword}" diye arama yaptığımda karşıma ${adWord} olarak "${task.title}" (${task.displayDomain}) çıktı.`,
    `${dev.charAt(0).toUpperCase() + dev.slice(1)} "${task.keyword}" aramasında ${task.displayDomain} kaynaklı bir ${adWord} dikkatimi çekti: "${task.title}".`,
    `"${task.keyword}" sorgusunun sponsorlu sonuçlarında "${task.title}" başlıklı, ${task.displayDomain} alan adlı bir ilan yer alıyor.`,
    `Bugün ${dev} Google'da "${task.keyword}" arattığımda ilk sıralarda "${task.title}" (${task.displayDomain}) adlı ${adWord} gösterildi.`,
    `"${task.keyword}" aramasında Google bana "${task.title}" başlıklı, ${task.displayDomain} domainli bir ${adWord} servis etti.`,
  ]);

  const claim = pick([
    `Türkiye'de lisanssız çevrimiçi kumar reklamı yasak olduğundan bunun politika ihlali olduğunu düşünüyorum.`,
    `Bu tür reklamlar Google'ın kumar politikasına ve Türkiye'deki yasalara aykırı; incelenmesini rica ediyorum.`,
    `Bilinen bir markanın adını kullanarak kullanıcıları yanıltıyor ve yasa dışı hizmete yönlendiriyor.`,
    `Reklam görünüşte başka bir sektördenmiş gibi yapıp aslında ${betWord} sitesine çıkıyor; bu gizleme (cloaking) şüphesi taşıyor.`,
    `Hem marka taklidi hem de yasa dışı kumar tanıtımı söz konusu; değerlendirilmesini talep ediyorum.`,
  ]);

  const evidence = pick([
    `Tarih: ${whenTr} (${dev}).${aclkLine}`,
    `Görülme zamanı: ${whenTr}, ${dev}.${aclkLine}`,
    `Kayıt: ${whenTr} · ${dev}.${aclkLine}`,
    `(${whenTr} · ${dev})${aclkLine}`,
    `Tarih: ${when.slice(0, 10)} · ${dev}.${aclkLine}`,
  ]);

  const closing = pick([
    `İncelemenizi rica ediyorum.`,
    `Gerekli incelemenin yapılmasını talep ediyorum.`,
    `Konunun değerlendirilmesini bekliyorum, teşekkürler.`,
    `Politika ekibinizin incelemesini rica ederim.`,
    `Bu reklamın kaldırılmasını ve reklamverenin incelenmesini istiyorum.`,
    `Raporumun dikkate alınmasını umuyorum.`,
  ]);

  // Order varies: some read claim-first, some evidence-first.
  if (rnd() < 0.5) {
    return `${opening} ${destSentence} ${claim}\n${evidence}\n${closing}`.slice(0, 1200);
  }
  return `${opening} ${claim} ${destSentence}\n${evidence}\n${closing}`.slice(0, 1200);
}

async function clickTextInPopup(page: Page, patterns: RegExp[]): Promise<boolean> {
  const clicked = await page.evaluate((patternStrings: string[]) => {
    const regexes = patternStrings.map((s) => new RegExp(s, "i"));
    const items = Array.from(document.querySelectorAll('button, [role="button"], a, span, div, li'));
    for (const item of items) {
      const t = (item.textContent || "").trim();
      if (!t) continue;
      for (const re of regexes) {
        if (re.test(t)) {
          // Click the nearest CLICKABLE ancestor, not the text node itself.
          const clickable = (item as HTMLElement).closest(
            'button, a, [role="button"], [role="menuitem"], [role="option"], li[role], [jsaction], [data-ved]'
          ) as HTMLElement | null;
          const target = clickable || (item as HTMLElement);
          target.click();
          return true;
        }
      }
    }
    return false;
  }, patterns.map((p) => p.source));
  if (clicked) return true;
  for (const f of page.frames()) {
    try {
      const ok = await f.evaluate((patternStrings: string[]) => {
        const regexes = patternStrings.map((s) => new RegExp(s, "i"));
        const items = Array.from(document.querySelectorAll('button, [role="button"], a, span, div, li'));
        for (const item of items) {
          const t = (item.textContent || "").trim();
          if (!t) continue;
          for (const re of regexes) {
            if (re.test(t)) {
              const clickable = (item as HTMLElement).closest(
                'button, a, [role="button"], [role="menuitem"], [role="option"], li[role], [jsaction], [data-ved]'
              ) as HTMLElement | null;
              const target = clickable || (item as HTMLElement);
              target.click();
              return true;
            }
          }
        }
        return false;
      }, patterns.map((p) => p.source));
      if (ok) return true;
    } catch {
      /* */
    }
  }
  return false;
}

async function dialogHas(page: Page, needle: RegExp): Promise<boolean> {
  return page.evaluate((src) => {
    const re = new RegExp(src, "i");
    const ds = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
    return ds.some((d) => d.getBoundingClientRect().width > 0 && re.test(d.textContent || ""));
  }, needle.source).catch(() => false);
}

async function clickDialogButton(page: Page, matcher: (b: { aria: string | null; text: string }) => boolean): Promise<boolean> {
  return page.evaluate((src) => {
    const fn = new Function("b", `return (${src})(b)`);
    const ds = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
    for (const d of ds) {
      if (d.getBoundingClientRect().width === 0) continue;
      const btns = Array.from(d.querySelectorAll('button, [role="button"], li[role="menuitem"], div[role="button"]'));
      for (const b of btns) {
        const aria = b.getAttribute("aria-label");
        const text = (b.textContent || "").trim();
        if (fn({ aria, text })) {
          (b as HTMLElement).scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
          (b as HTMLElement).click();
          return true;
        }
      }
    }
    return false;
  }, matcher.toString()).catch(() => false);
}

/** Opener aria-label stems — mobile "Reklam Merkezim" icons + desktop three-dot / about-this-ad. */
const OPENER_ARIA = [
  "more", "diğer", "daha", "info", "neden", "why",
  "hakkında", "about", "menü", "menu", "seçenek", "options",
];

/** After an opener click: "Bildir" → category → Yorumlar form. Shared by all opener paths. */
async function completeReportMenu(page: Page, debugDir?: string): Promise<boolean> {
  // Click the REAL button: div[role="button"][aria-label="Bildir"] inside the popup (DOM click).
  const bildirClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('div[role="button"][aria-label="Bildir"], [role="button"][aria-label="Bildir"]'));
    const b = btns.find((x) => (x as HTMLElement).getBoundingClientRect().width > 0) as HTMLElement | undefined;
    if (!b) return false;
    b.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
    b.click();
    return true;
  }).catch(() => false);
  if (!bildirClicked) {
    // Fallback: click any element whose exact text is "Bildir" (nearest clickable ancestor).
    const textClicked = await clickTextInPopup(page, [/^bildir$/i, /report ad/i, /bu reklamı bildir/i, /reklamı bildir/i]);
    if (!textClicked) {
      logger.info("autoReport: menu step — no 'Bildir' button after opener");
      return false;
    }
  }
  await sleep(1500);
  await debugShot(page, debugDir, "dbg-02-after-bildir");

  // Category screen "Reklamı bildir" → click a category LI.
  if (await dialogHas(page, /reklamı bildir|report ad|geri bildirim/i)) {
    const catClicked = await clickDialogButton(page, (b) =>
      /yanıltıcı|misleading|dolandırma|scam|kumar|gambling|yasa dışı|illegal|diğer|other/i.test(b.text)
    );
    if (catClicked) {
      await sleep(1800);
      await debugShot(page, debugDir, "dbg-03-after-category");
      const formReady = await page.evaluate(() => {
        const ds = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
        return ds.some((d) => d.getBoundingClientRect().width > 0 && d.querySelector("textarea"));
      }).catch(() => false);
      if (formReady) return true;
    }
    // Maybe the form opened directly without a category step.
    const directForm = await page.evaluate(() => {
      const ds = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
      return ds.some((d) => d.getBoundingClientRect().width > 0 && d.querySelector("textarea"));
    }).catch(() => false);
    if (directForm) return true;
  }
  return false;
}

/**
 * Find the opener (three-dot / "Neden bu reklam?") INSIDE the target ad card and
 * click it with a DOM .click() — CDP mouse input stalls for seconds on these
 * mobile-emulated sessions, while element.click() dispatches a native click that
 * Google's jsaction handlers accept (verified live on TR-MOBILE-085).
 * Returns the clicked button's aria-label, or null.
 */
async function clickCardOpener(
  page: Page,
  displayDomain: string,
  titleHint?: string
): Promise<string | null> {
  const target = normalizeDomain(displayDomain);
  return page.evaluate(
    ({ target: t, titleHint: h, ariaStems }) => {
      const norm = (s: string) => s.toLowerCase().replace(/^(www\.|m\.)/, "").trim();
      const cards = Array.from(
        document.querySelectorAll("[data-text-ad], #tads [data-hveid], #tadsb [data-hveid], #tvcap [data-hveid], [data-pcu]")
      );
      for (const c of cards) {
        const heading = c.querySelector('[role="heading"], h3');
        const title = (heading?.textContent || "").trim();
        let dd = "";
        for (const el of c.querySelectorAll("span, cite, div, a")) {
          const txt = (el.textContent || "").trim();
          if (/^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}/i.test(txt)) {
            dd = txt.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0]!;
            break;
          }
        }
        const cardText = (c.textContent || "").toLowerCase();
        const isTarget =
          (dd && norm(dd) === t) ||
          (h && title.toLowerCase().includes(h.toLowerCase())) ||
          (t && cardText.includes(t)); // fallback: domain string anywhere in the card
        if (!isTarget) continue;
        const btns = Array.from(c.querySelectorAll('button, [role="button"]')) as HTMLElement[];
        for (const b of btns) {
          const aria = (b.getAttribute("aria-label") || "").toLowerCase();
          if (aria && ariaStems.some((s) => aria.includes(s))) {
            if (b.getBoundingClientRect().width > 0) {
              b.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
              b.click();
              return b.getAttribute("aria-label") || "opener";
            }
          }
        }
        for (const b of btns) {
          const text = (b.textContent || "").trim();
          const r = b.getBoundingClientRect();
          if (r.width > 0 && r.width <= 48 && text.length <= 2) {
            b.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
            b.click();
            return b.getAttribute("aria-label") || "icon-opener";
          }
        }
        return null; // target card found but no opener inside — don't touch other cards
      }
      return null;
    },
    { target, titleHint, ariaStems: OPENER_ARIA }
  );
}

/**
 * Verified working flow (tested live on TR-MOBILE-099):
 *   ad info button → "Reklam Merkezim" → [aria-label=Bildir] → category LI → Yorumlar form.
 * Desktop uses the same menu after the card's three-dot / "about this ad" opener.
 *
 * Hard time budget: page-wide opener probing can burn minutes on a busy SERP,
 * so the whole function is capped — callers treat `false` as "skip report".
 */
const OPEN_REPORT_BUDGET_MS = 75_000;
const MENU_STEP_BUDGET_MS = 20_000;

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, sleep(ms).then(() => fallback)]);
}

async function debugShot(page: Page, dir: string | undefined, name: string): Promise<void> {
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: resolve(dir, `${name}.png`), fullPage: false, timeout: 8000 });
  } catch {
    /* debug only */
  }
}

export async function openReportUi(
  page: Page,
  displayDomain: string,
  titleHint?: string,
  device?: Device,
  debugDir?: string
): Promise<boolean> {
  let settled = false;
  const inner = openReportUiInner(page, displayDomain, titleHint, device, debugDir).then((ok) => {
    settled = true;
    return ok;
  });
  const timeout = sleep(OPEN_REPORT_BUDGET_MS).then(() => {
    if (settled) return false; // inner already won — no noise
    logger.warn({ displayDomain, device, budgetMs: OPEN_REPORT_BUDGET_MS }, "autoReport: open UI budget exhausted");
    return false;
  });
  return Promise.race([inner, timeout]);
}

async function openReportUiInner(
  page: Page,
  displayDomain: string,
  titleHint?: string,
  device?: Device,
  debugDir?: string
): Promise<boolean> {
  // 1) Direct feedback link (rare but most reliable).
  const directLink = await page.$('a[href*="adfeedback"], a[href*="adreview"], a[href*="survey=report"], a[href*="/ads/feedback/"]');
  if (directLink) {
    const href = await directLink.getAttribute("href").catch(() => null);
    if (href) {
      await page.goto(href, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
      await sleep(1500);
      return true;
    }
  }

  // 2) Card-scoped opener (preferred — never touches the wrong ad; DOM click).
  const openerLabel = await clickCardOpener(page, displayDomain, titleHint).catch(() => null);
  if (openerLabel) {
    logger.info({ displayDomain, device, opener: openerLabel }, "autoReport: card-scoped opener clicked");
    await sleep(1500);
    await debugShot(page, debugDir, "dbg-01-after-card-opener");
    if (await withTimeout(completeReportMenu(page, debugDir), MENU_STEP_BUDGET_MS, false)) return true;
    logger.info({ displayDomain, device }, "autoReport: card opener did not reach form — trying page-wide");
    // Menu may have stayed closed — fall through to page-wide openers.
  } else {
    logger.info({ displayDomain, device }, "autoReport: no card-scoped opener — page-wide probing");
  }

  // 3) Page-wide opener loop — STRICTLY ad-container openers only.
  //    Organic results' menus are none of our business: we report THE ad.
  const ariaSelector = OPENER_ARIA.flatMap((s) => {
    const cap = s.charAt(0).toUpperCase() + s.slice(1);
    return [
      `button[aria-label*="${s}"]`, `button[aria-label*="${cap}"]`,
      `[role="button"][aria-label*="${s}"]`, `[role="button"][aria-label*="${cap}"]`,
    ];
  }).join(", ");
  const MAX_PAGE_WIDE = 3;
  const adOpenerIdx = await page.evaluate((sel) => {
    const inAd = (el: Element) => !!el.closest("[data-text-ad], #tads, #tadsb, #tvcap, [data-pcu]");
    const all = Array.from(document.querySelectorAll(sel));
    const out: number[] = [];
    all.forEach((el, i) => { if (inAd(el)) out.push(i); });
    return out.slice(0, 10);
  }, ariaSelector).catch(() => [] as number[]);
  const openers = await page.$$(ariaSelector);
  logger.info({ displayDomain, device, adOpeners: adOpenerIdx.length }, "autoReport: page-wide probing limited to ad containers");
  for (const idx of adOpenerIdx.slice(0, MAX_PAGE_WIDE)) {
    const btn = openers[idx];
    if (!btn) continue;
    await btn.click().catch(() => {});
    await sleep(1200);
    if (await withTimeout(completeReportMenu(page, debugDir), MENU_STEP_BUDGET_MS, false)) return true;
  }

  // 4) Fallback: old UI — visible "Bildir" / "Report ad" elements (single pass, capped).
  const fallbackIdx = await page.evaluate(() => {
    const match = (t: string) => {
      const s = t.toLowerCase();
      return s.includes("report") || s.includes("bildir") || s.includes("şikayet") || s.includes("sikayet") || s.includes("spam") || s.includes("reklamı bildir");
    };
    const out: number[] = [];
    const all = Array.from(document.querySelectorAll('button, [role="button"], a'));
    all.forEach((el, i) => {
      const t = el.getAttribute("aria-label") || el.getAttribute("title") || (el.textContent || "");
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width > 0 && match(t)) out.push(i);
    });
    return out.slice(0, 5);
  }).catch(() => [] as number[]);
  const reportButtons = await page.$$('button, [role="button"], a');
  for (const idx of fallbackIdx) {
    const btn = reportButtons[idx];
    if (!btn) continue;
    await btn.click().catch(() => {});
    await sleep(800);
    const formReady = await page.evaluate(() => {
      const ds = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
      return ds.some((d) => d.getBoundingClientRect().width > 0 && d.querySelector("textarea"));
    }).catch(() => false);
    if (formReady) return true;
  }

  logger.info({ displayDomain, device }, "autoReport: no opener path reached the form");
  return false;
}

export async function fillReportForm(
  page: Page,
  task: ReportTask,
  submit: boolean,
  evidenceDir?: string,
  email?: string
): Promise<{ status: "filled" | "submitted" | "no-form" | "submit-failed"; shots?: string[] }> {
  const shots: string[] = [];
  const takeShot = async (name: string) => {
    if (!evidenceDir) return;
    try {
      mkdirSync(evidenceDir, { recursive: true });
      const p = resolve(evidenceDir, `${name}.png`);
      await page.screenshot({ path: p, fullPage: false, timeout: 10000 });
      shots.push(p);
    } catch (err) {
      logger.debug({ err: String(err) }, "report screenshot failed");
    }
  };

  await takeShot("01-report-opened");

  // HARD GATE: Yorumlar form must exist inside a visible dialog.
  const hasForm = await page.evaluate(() => {
    const ds = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
    return ds.some((d) => d.getBoundingClientRect().width > 0 && d.querySelector("textarea"));
  }).catch(() => false);
  if (!hasForm) {
    logger.warn("autoReport: feedback form not detected — aborting (no fallback)");
    await takeShot("02-no-dialog");
    return { status: "no-form", shots };
  }

  // 1) Fill Yorumlar textarea (value setter + events — verified working).
  const text = buildReportText(task);
  const filledText = await page.evaluate((t) => {
    const ds = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
    for (const d of ds) {
      if (d.getBoundingClientRect().width === 0) continue;
      const ta = d.querySelector("textarea") as HTMLTextAreaElement | null;
      if (!ta || ta.name === "q" || ta.id === "APjFqb") continue;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(ta, t);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  }, text.slice(0, 1200)).catch(() => false);
  logger.info({ filledText }, "autoReport: comment fill");

  // 2) Fill REQUIRED email field (input.fill clears properly — verified working).
  if (email) {
    const emailHandle = await page.evaluateHandle(() => {
      const ds = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
      for (const d of ds) {
        if (d.getBoundingClientRect().width === 0) continue;
        const input = d.querySelector('input[type="email"], input[autocomplete="email"]');
        if (input) return input;
      }
      return null;
    }).catch(() => null);
    const emailInput = emailHandle ? (emailHandle as unknown as ElementHandle).asElement() : null;
    if (emailInput) {
      await emailInput.fill("").catch(() => {});
      await emailInput.fill(email).catch(() => {});
      await page.keyboard.press("Tab").catch(() => {});
      await sleep(600);
      logger.info({ email }, "autoReport: email fill");
    } else {
      logger.warn("autoReport: email field not found in dialog");
    }
  } else {
    logger.warn("autoReport: no email configured — form may not submit");
  }
  await takeShot("03-report-filled");
  logger.info("autoReport: filled shot done — submitting");

  if (!submit) {
    return { status: "filled", shots };
  }

  // 3) Click "Gönder" — DOM click first (CDP mouse stalls on these sessions).
  const gonderResult = await page.evaluate(() => {
    const ds = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
    for (const d of ds) {
      if (d.getBoundingClientRect().width === 0) continue;
      const btn = Array.from(d.querySelectorAll('button, [role="button"]')).find(
        (b) => /^(gönder|gonder|send|submit)$/i.test((b.textContent || "").trim()) ||
               /^(gönder|gonder|send|submit)$/i.test(b.getAttribute("aria-label") || "")
      ) as HTMLElement | undefined;
      if (btn) {
        if ((btn as HTMLButtonElement).disabled) return { found: true, disabled: true };
        btn.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
        btn.click();
        return { found: true, disabled: false };
      }
    }
    return { found: false, disabled: false };
  }).catch(() => ({ found: false, disabled: false }));
  logger.info({ gonderResult }, "autoReport: submit click evaluated");

  if (!gonderResult.found) {
    logger.warn("autoReport: Gönder button not found");
    return { status: "filled", shots };
  }
  if (gonderResult.disabled) {
    logger.warn("autoReport: Gönder button disabled (form incomplete)");
    return { status: "filled", shots };
  }
  await sleep(4000);
  await takeShot("04-report-submitted");
  logger.info("autoReport: submitted shot done — verifying");

  // 4) Verify submission: dialog closes or confirmation text appears.
  const verify = await page.evaluate(() => {
    const ds = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
    const visible = ds.find((d) => d.getBoundingClientRect().width > 0);
    if (!visible) return { closed: true, text: "" };
    return { closed: false, text: (visible.textContent || "").toLowerCase() };
  }).catch(() => ({ closed: false, text: "" }));
  logger.info({ closed: verify.closed, textHead: verify.text.slice(0, 60) }, "autoReport: verify evaluated");

  if (verify.closed) return { status: "submitted", shots };
  const t = verify.text;
  if (t.includes("teşekkür") || t.includes("thank") || t.includes("gönderildi") || t.includes("alındı") || t.includes("received")) {
    return { status: "submitted", shots };
  }
  if (t.includes("hata") || t.includes("error") || t.includes("geçerli bir e-posta")) {
    return { status: "submit-failed", shots };
  }
  return { status: "submitted", shots };
}
