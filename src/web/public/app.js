const API = {
  async get(path) {
    const r = await fetch(path);
    if (r.status === 401) {
      window.location.href = "/login";
      throw new Error("auth required");
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  },
  async post(path, body = {}) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.status === 401) {
      window.location.href = "/login";
      throw new Error("auth required");
    }
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || `HTTP ${r.status}`);
    }
    return r.json();
  },
};

const LOG_MAX = 200;
const LOG_KEY = "detect-ops-logs";
const SCAN_LOCK_KEY = "detect-ops-scan-lock";
const VIEW_KEY = "detect-ops-view";
let logs = loadLogs();
let scanStartLockUntil = Number(localStorage.getItem(SCAN_LOCK_KEY) || "0");
const SCAN_START_LOCK_MS = 20000;
let scansPage = 1;
const SCANS_PER_PAGE = 5;

function switchView(name) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("hidden", v.id !== "view-" + name));
  try { localStorage.setItem(VIEW_KEY, name); } catch {}
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function loadLogs() {
  return [];
}

/** Initial fill from the shared server-side log — same for every user. */
async function loadServerLogs() {
  try {
    const data = await API.get("/api/logs?limit=200");
    const items = (data.logs || []).map((l) => ({
      t: new Date(l.t).toLocaleTimeString("tr-TR"),
      level: eventLevel(l.type),
      msg: l.message,
    }));
    // Server buffer is chronological (oldest → newest); the live log() path
    // unshifts newest-first. Reverse here or the initial history renders
    // upside-down under the live entries.
    logs = items.slice(-LOG_MAX).reverse();
    renderLogs();
  } catch {
    /* SSE will fill in */
  }
}

function saveLogs() {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(logs.slice(0, LOG_MAX)));
  } catch {}
}

function log(level, msg) {
  const t = new Date().toLocaleTimeString("tr-TR");
  logs.unshift({ t, level, msg });
  if (logs.length > LOG_MAX) logs.length = LOG_MAX;
  saveLogs();
  renderLogs();
}

function renderLogs() {
  const el = document.getElementById("log");
  if (!el) return;
  el.innerHTML = logs.map((l) => `<div class="line ${l.level}"><span class="t">${esc(l.t)}</span>${esc(l.msg)}</div>`).join("");
}

function badge(st) {
  const s = String(st || "—").toLowerCase();
  let cls = "badge";
  let label = s;
  if (s === "running") { cls += " run"; label = "running"; }
  else if (s === "done" || s === "completed") { cls += " ok"; label = "done"; }
  else if (s === "failed" || s === "error") { cls += " err"; label = "failed"; }
  else if (s === "stale") { cls += " stale"; label = "stale"; }
  return `<span class="${cls}">${esc(label)}</span>`;
}

function renderScans(data) {
  const tb = document.querySelector("#tbl-scans tbody");
  const pager = document.getElementById("scans-pager");
  if (!tb) return;
  // Server-paged: { total, page, limit, scans } — pager covers ALL scans in DB.
  const scans = data?.scans || (Array.isArray(data) ? data : []);
  const total = Number(data?.total ?? scans.length) || 0;
  const limit = Number(data?.limit ?? SCANS_PER_PAGE) || SCANS_PER_PAGE;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  scansPage = Math.min(scansPage, totalPages);
  if (!scans.length) {
    tb.innerHTML = `<tr><td colspan="6" class="empty">Henüz tarama yok</td></tr>`;
    if (pager) pager.innerHTML = "";
    return;
  }

  tb.innerHTML = scans.map((s) => {
    let brands = "";
    try {
      const kws = JSON.parse(s.keywords || "[]");
      brands = kws.slice(0, 3).join(", ") + (kws.length > 3 ? ` +${kws.length - 3}` : "");
    } catch {}
    let devs = "";
    try { devs = JSON.parse(s.devices || "[]").join("+"); } catch {}
    return `<tr>
      <td class="mono">#${s.id}</td>
      <td>${badge(s.status)}</td>
      <td title="${esc(brands)}">${esc(brands || "—")}</td>
      <td class="muted">${esc(devs || "—")}</td>
      <td class="mono">${s.total_ads ?? 0}</td>
      <td class="muted">${esc(fmtTime(s.started_at))}</td>
    </tr>`;
  }).join("");

  if (pager) {
    pager.innerHTML = `
      <button class="pager-btn" ${scansPage <= 1 ? "disabled" : ""} onclick="changeScansPage(-1)">← Önceki</button>
      <span class="pager-info">Sayfa ${scansPage} / ${totalPages} (${total})</span>
      <button class="pager-btn" ${scansPage >= totalPages ? "disabled" : ""} onclick="changeScansPage(1)">Sonraki →</button>
    `;
  }
}

window.changeScansPage = (delta) => {
  scansPage += delta;
  refresh(true);
};

function renderJobs(jobs) {
  const el = document.getElementById("jobs-list");
  if (!el) return;
  const recent = (jobs || []).slice(0, 5);
  if (!recent.length) {
    el.innerHTML = `<div class="empty">Aktif iş yok</div>`;
    return;
  }
  el.innerHTML = recent.map((j) => {
    const pct = Math.min(100, Math.max(0, j.progress || 0));
    const isRunning = j.status === "running";
    const stateCls = isRunning ? "running" : j.status === "completed" ? "done" : j.status === "failed" ? "failed" : "";
    const ringColor = isRunning ? "var(--accent)" : j.status === "failed" ? "var(--danger)" : "var(--text-muted)";
    const radius = 18;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (pct / 100) * circumference;
    return `<div class="job-row ${isRunning ? "pulse" : ""}">
      <div class="job-progress-ring" data-status="${stateCls}">
        <svg width="44" height="44" viewBox="0 0 44 44">
          <circle class="ring-bg" cx="22" cy="22" r="${radius}" />
          <circle class="ring-bar" cx="22" cy="22" r="${radius}" stroke="${ringColor}" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" transform="rotate(-90 22 22)" />
        </svg>
        <span>${pct}%</span>
      </div>
      <div class="job-info">
        <h4>${esc(j.type.toUpperCase())} · ${esc(j.message || "…")}</h4>
        <p>${esc(j.id)} · ${esc(fmtTime(j.startedAt))}${j.finishedAt ? " → " + esc(fmtTime(j.finishedAt)) : ""}</p>
      </div>
      <div class="job-state ${stateCls}">${esc(j.status)}</div>
    </div>`;
  }).join("");
}

function isScanRunning(jobs) {
  return (jobs || []).some((j) => j.type === "scan" && j.status === "running");
}

function setScanButtonLocked(locked, reason = "") {
  const btn = document.getElementById("btn-start-scan");
  if (!btn) return;
  btn.disabled = locked;
  if (locked) {
    btn.dataset.locked = "1";
    btn.innerHTML = `<span class="btn-icon">◐</span> ${reason || "Taranıyor…"}`;
  } else {
    delete btn.dataset.locked;
    btn.innerHTML = `<span class="btn-icon">▶</span> Taramayı Başlat`;
  }
}

let isScanRunningFromOps = false;

function updateScheduledInfo(ss) {
  const el = document.getElementById("scheduled-info");
  const toggle = document.getElementById("scheduled-enabled");
  if (toggle && document.activeElement !== toggle) toggle.checked = ss?.enabled !== false;
  if (!el || !ss) return;
  if (ss.enabled === false) {
    el.className = "scheduled-info";
    el.textContent = "Otomatik tarama kapalı — açınca aynı saatlerden (06:00, 08:00…) devam eder";
    return;
  }
  if (ss.scanRunning || isScanRunningFromOps) {
    el.className = "scheduled-info run";
    el.textContent = "Zamanlanmış tarama devam ediyor — manuel başlatma kapalı";
    return;
  }
  el.className = "scheduled-info";
  const next = ss.nextAt ? fmtTime(ss.nextAt) : "—";
  el.textContent = `Sıradaki zamanlanmış tarama: ${next} · markalar: herabet, rovbet, napolibet, primebahis, vegasslot`;
}

function updateOps(ops) {
  const focusBadge = document.getElementById("focus-status-badge");
  const focusMeta = document.getElementById("focus-status");
  const stopFocus = document.getElementById("btn-stop-focus");

  if (ops.campaign?.status === "running") {
    focusBadge.textContent = "AKTİF";
    focusBadge.className = "op-status run";
    focusMeta.textContent = `${ops.campaign.focusDomain || "—"} · pencere #${ops.campaign.windowIndex || 1} · ${ops.campaign.windowMinutes || 120}dk`;
    stopFocus.disabled = focusStopping;
    if (!focusStopping) stopFocus.innerHTML = `<span class="btn-icon">■</span> Durdur`;
  } else {
    focusBadge.textContent = "PASİF";
    focusBadge.className = "op-status";
    focusMeta.textContent = "Beklemede";
    stopFocus.disabled = true;
    if (focusStopping) {
      focusStopping = false;
      stopFocus.innerHTML = `<span class="btn-icon">■</span> Durdur`;
    }
  }
}

let refreshInFlight = false;
let lastRefreshAt = 0;

let stormStopping = false;

function updateStorm(storm) {
  const badge = document.getElementById("storm-status-badge");
  const meta = document.getElementById("storm-status");
  const startBtn = document.getElementById("btn-start-storm");
  const stopBtn = document.getElementById("btn-stop-storm");
  const form = document.getElementById("storm-form");
  if (!badge || !meta) return;
  if (storm?.running) {
    const t = storm.totals || { clicks: 0, reports: 0 };
    badge.textContent = "AKTİF";
    badge.className = "op-status run";
    meta.textContent = `${storm.targetDomain || "—"} · ${storm.activeSessions ?? 0} oturum · ${t.clicks} tık · ${t.reports} rapor · saatlik ${storm.clicksPerHour ?? 0}`;
    if (startBtn) startBtn.disabled = true;
    if (stopBtn) {
      stopBtn.disabled = stormStopping;
      if (!stormStopping) stopBtn.innerHTML = `<span class="btn-icon">■</span> Durdur`;
    }
    if (form) form.classList.add("disabled");
  } else {
    badge.textContent = "PASİF";
    badge.className = "op-status";
    meta.textContent = storm?.totals && (storm.totals.clicks || storm.totals.reports)
      ? `Son: ${storm.targetDomain} · ${storm.totals.clicks} tık · ${storm.totals.reports} rapor`
      : "Beklemede";
    if (startBtn) startBtn.disabled = false;
    if (stopBtn) {
      stopBtn.disabled = true;
      if (stormStopping) {
        stormStopping = false;
        stopBtn.innerHTML = `<span class="btn-icon">■</span> Durdur`;
      }
    }
    if (form) form.classList.remove("disabled");
  }
}

async function startStorm() {
  const msg = document.getElementById("storm-form-msg");
  const keywords = document.getElementById("storm-keywords").value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  const targetDomain = document.getElementById("storm-domain").value.trim();
  const device = document.getElementById("storm-device").value;
  if (!keywords.length || !targetDomain) {
    if (msg) msg.textContent = "keyword seti + hedef domain gerekli";
    return;
  }
  if (msg) msg.textContent = "Başlatılıyor…";
  try {
    const res = await API.post("/api/storm/start", { keywords, targetDomain, device });
    if (msg) msg.textContent = `Başladı · run #${res.runId}`;
    log("info", `storm başladı · ${targetDomain} · ${device} · ${keywords.length} keyword`);
    await refresh(true);
  } catch (err) {
    if (msg) msg.textContent = err.message;
    log("err", `storm başlatma: ${err.message}`);
  }
}

async function stopStorm() {
  if (stormStopping) return; // no spam — one stop request at a time
  stormStopping = true;
  const btn = document.getElementById("btn-stop-storm");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `Durduruluyor`;
  }
  try {
    await API.post("/api/storm/stop", {});
    log("warn", "storm durduruldu");
    await refresh(true);
  } catch (err) {
    log("err", `storm durdurma: ${err.message}`);
    stormStopping = false;
    if (btn) btn.innerHTML = `<span class="btn-icon">■</span> Durdur`;
  }
}

async function refresh(force = false) {
  if (refreshInFlight) return; // pager double-click guard — no parallel fetches
  // Throttle event-driven refreshes (SSE click-done storms); explicit UI
  // actions (init, pager, submit) pass force=true to bypass.
  const now = Date.now();
  if (!force && now - lastRefreshAt < 3000) return;
  lastRefreshAt = now;
  refreshInFlight = true;
  document.querySelectorAll(".pager-btn").forEach((b) => b.classList.add("loading"));
  try {
    const proofQs = proofFilterQs();
    const [ops, complaintRes, opResultsRes, scansRes, proofRes, healthRes, stormRes] = await Promise.all([
      API.get("/api/ops"),
      API.get("/api/reports/complaints/packs").catch(() => ({ packs: [] })),
      API.get(`/api/ops/summary?page=${opResultsPage}&limit=${OP_RESULTS_LIMIT}`).catch(() => ({ results: [], total: 0, page: 1, limit: OP_RESULTS_LIMIT })),
      API.get(`/api/scans/paged?page=${scansPage}&limit=${SCANS_PER_PAGE}`).catch(() => ({ scans: [], total: 0, page: 1, limit: SCANS_PER_PAGE })),
      API.get(`/api/reports/submitted?page=${proofPage}&limit=${PROOF_LIMIT}${proofQs}`).catch(() => ({ results: [], total: 0, page: 1, limit: PROOF_LIMIT })),
      API.get("/api/profiles/health").catch(() => ({ profiles: [] })),
      API.get("/api/storm/status").catch(() => ({ storm: { running: false } })),
    ]);
    const adsPill = document.getElementById("pill-ads");
    if (adsPill) {
      adsPill.innerHTML = `<span class="dot"></span>${ops.adsPower?.up ? "AdsPower ON" : "AdsPower OFF"}`;
      adsPill.classList.toggle("off", !ops.adsPower?.up);
    }
    const running = (ops.jobs || []).filter((j) => j.status === "running").length;
    const jp = document.getElementById("pill-jobs");
    if (jp) jp.textContent = `${running} iş`;
    const sp = document.getElementById("pill-solver");
    if (sp && ops.solverCost) {
      const pol = ops.solverPolicy;
      const budgetTxt = pol ? ` · bütçe ${pol.hourSolves}/${pol.hourBudget} saat` : "";
      const pausedTxt = pol && (pol.pausedProviders.length || pol.globalPausedUntil) ? " · ⏸" : "";
      sp.textContent = `$${ops.solverCost.today} bugün · $${ops.solverCost.last7d} 7g${budgetTxt}${pausedTxt}`;
      const lines = [`Solver maliyeti · bugün ${ops.solverCost.todayCalls} çağrı · 7 günde ${ops.solverCost.weekCalls} çağrı`];
      if (pol) {
        lines.push(`Duvar: ${pol.todayWalls} · aşılan: ${pol.todayCleared} · başarı %${Math.round(pol.clearRateToday * 100)}`);
        lines.push(`Bütçe: ${pol.hourSolves}/${pol.hourBudget} saatlik · ${pol.todaySolves}/${pol.dayBudget} günlük`);
        if (pol.globalPausedUntil) lines.push(`GLOBAL PAUSE: ${pol.globalPausedUntil}`);
        if (pol.pausedProviders.length) lines.push(`Duraklatılan: ${pol.pausedProviders.join(", ")}`);
      }
      sp.title = lines.join("\n");
    }
    const mp = document.getElementById("pill-mail");
    if (mp) {
      const ep = ops.emailPool;
      if (ep) {
        mp.textContent = `mail ${ep.active}/${ep.minSize}`;
        const low = ep.active < ep.minSize || ep.fresh < Math.ceil(ep.minSize * 0.3) || !!ep.refillBackoffUntil;
        mp.classList.toggle("off", low);
        const lines = [
          `Mail havuzu · aktif ${ep.active} / hedef ${ep.minSize} (toplam ${ep.total})`,
          `Taze: ${ep.fresh} · son 24s kullanım: ${ep.usedLast24h}`,
          `Üretim: son 1 saatte ${ep.createdLastHour} / limit ${ep.refillPerHour}`,
        ];
        if (ep.refillBackoffUntil) lines.push(`RATE-LIMIT: ${ep.refillBackoffUntil} — üretim duraklatıldı`);
        mp.title = lines.join("\n");
      } else {
        mp.textContent = "mail kapalı";
        mp.classList.add("off");
      }
    }
    isScanRunningFromOps = isScanRunning(ops.jobs);
    updateOps(ops);
    updateStorm(stormRes?.storm);
    updateScheduledInfo(ops.scheduledScan);
    renderJobs(ops.jobs);
    renderScans(scansRes);
    renderOpResults(opResultsRes);
    renderProof(proofRes);
    renderHealth(healthRes);

    const clickOpRunning = (ops.jobs || []).some((j) => j.type === "click" && j.status === "running");
    const locked = isScanRunningFromOps || clickOpRunning || Date.now() < scanStartLockUntil;
    const reason = clickOpRunning
      ? "Tıklama operasyonu sürüyor"
      : ops.scheduledScan?.scanRunning
        ? "Zamanlanmış tarama devam ediyor"
        : isScanRunningFromOps
          ? "Taranıyor…"
          : "";
    setScanButtonLocked(locked, reason);
  } catch (err) {
    log("err", `refresh: ${err.message}`);
  } finally {
    refreshInFlight = false;
    document.querySelectorAll(".pager-btn").forEach((b) => b.classList.remove("loading"));
  }
}

async function onScanSubmit(e) {
  e.preventDefault();
  if (isScanRunningFromOps) {
    document.getElementById("scan-form-msg").textContent = "Zaten çalışan bir tarama var";
    return;
  }
  const brands = document.getElementById("scan-brands").value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!brands.length) {
    document.getElementById("scan-form-msg").textContent = "Marka girin";
    return;
  }
  // Keep the user's custom list for next time (defaults switch off).
  if (!document.getElementById("scan-default-brands").checked) {
    localStorage.setItem("detect-custom-brands", brands.join("\n"));
  }
  const devices = document.getElementById("scan-devices").value;
  const expand = document.getElementById("scan-expand").checked;
  scanStartLockUntil = Date.now() + SCAN_START_LOCK_MS;
  localStorage.setItem(SCAN_LOCK_KEY, String(scanStartLockUntil));
  setScanButtonLocked(true);
  document.getElementById("scan-form-msg").textContent = "Gönderiliyor…";
  try {
    const res = await API.post("/api/scans/start", { brands, devices, expandBrands: expand, clearProfile: false });
    document.getElementById("scan-form-msg").textContent = `Kuyruğa alındı · ${res.jobId}`;
    log("info", `scan kuyruğa alındı · ${brands.join(", ")} · ${res.jobId}`);
    await refresh(true);
  } catch (err) {
    document.getElementById("scan-form-msg").textContent = err.message;
    log("err", `scan hata: ${err.message}`);
    scanStartLockUntil = 0;
    localStorage.removeItem(SCAN_LOCK_KEY);
    setScanButtonLocked(false);
  }
}

let focusStopping = false;

async function stopFocus() {
  if (focusStopping) return; // no spam — one stop request at a time
  focusStopping = true;
  const btn = document.getElementById("btn-stop-focus");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `Durduruluyor`;
  }
  try {
    await API.post("/api/campaign/stop", {});
    log("warn", "focus durduruluyor");
    await refresh(true);
  } catch (err) {
    log("err", `focus durdurma: ${err.message}`);
    focusStopping = false;
    if (btn) btn.innerHTML = `<span class="btn-icon">■</span> Durdur`;
  }
}

function setupSSE() {
  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      // ops-stats her tıkta akar — terminali boğmasın, sadece canlı sayaçları beslesin
      if (d.type === "ops-stats") {
        updateOpsFromStats(d);
      } else if (d.message) {
        const level = d.type === "ops-valve" ? (d.calm ? "warn" : "ok") : eventLevel(d.type);
        log(level, d.message);
      }
      if (["ops-point", "ops-click", "ops-valve", "ops-enabled"].includes(d.type)) {
        refreshOpsMode();
      }
      if (["scan-completed", "scan-started", "click-completed", "click-done", "campaign-rescan-done", "storm-started", "storm-completed", "storm-click", "storm-progress"].includes(d.type)) {
        refresh();
      }
    } catch {}
  };
}

function eventLevel(t) {
  if (!t) return "";
  if (t.includes("failed") || t === "error") return "err";
  if (t === "scan-completed" || t === "click-completed" || t === "campaign-rescan-done" || t.includes("ok")) return "ok";
  if (t.includes("started") || t === "scan-progress") return "info";
  if (t.includes("captcha") || t.includes("warn")) return "warn";
  if (t.startsWith("ops-")) return "info";
  return "";
}

let opResultsPage = 1;
const OP_RESULTS_LIMIT = 5;
let proofPage = 1;
const PROOF_LIMIT = 5;

/** Compact date-time for tight table cells/chips: "24.07 04:52". */
function fmtDT(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const dd = d.toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit" });
  const tt = d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
  return `${dd} ${tt}`;
}

function proofFilterQs() {
  const kw = document.getElementById("proof-filter-keyword")?.value.trim();
  const dom = document.getElementById("proof-filter-domain")?.value.trim();
  const op = document.getElementById("proof-filter-operation")?.value.trim();
  const dev = document.getElementById("proof-filter-device")?.value;
  let qs = "";
  if (kw) qs += `&keyword=${encodeURIComponent(kw)}`;
  if (dom) qs += `&domain=${encodeURIComponent(dom)}`;
  if (op) qs += `&operation=${encodeURIComponent(op)}`;
  if (dev) qs += `&device=${encodeURIComponent(dev)}`;
  return qs;
}

function renderOpResultsPager(total, page, limit) {
  const pager = document.getElementById("op-results-pager");
  if (!pager) return;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  if (totalPages <= 1) {
    pager.innerHTML = "";
    return;
  }
  let html = `<button class="pager-btn" ${page <= 1 ? "disabled" : ""} data-page="${page - 1}">Önceki</button>`;
  html += `<span class="pager-info">Sayfa ${page} / ${totalPages}</span>`;
  html += `<button class="pager-btn" ${page >= totalPages ? "disabled" : ""} data-page="${page + 1}">Sonraki</button>`;
  pager.innerHTML = html;
  pager.querySelectorAll(".pager-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const next = Number((e.currentTarget).dataset.page);
      if (next >= 1 && next <= totalPages) {
        opResultsPage = next;
        refresh(true);
      }
    });
  });
}

function renderOpResults(data) {
  const tbody = document.querySelector("#tbl-op-results tbody");
  const empty = document.getElementById("op-results-empty");
  if (!tbody || !empty) return;
  const results = data.results || data;
  if (!results.length) {
    tbody.innerHTML = "";
    empty.style.display = "block";
    document.getElementById("op-results-pager").innerHTML = "";
    return;
  }
  empty.style.display = "none";
  // Each row = ONE operation (all its waves/domains aggregated). Click → detail modal.
  const opLabel = (id) => {
    const s = String(id || "");
    if (s.startsWith("run-")) return "#" + s.slice(4);
    return s.length > 18 ? s.slice(0, 8) + "…" + s.slice(-5) : s;
  };
  const pct = (r) => (r.attempts > 0 ? Math.round((r.clicks / r.attempts) * 100) : 0);
  tbody.innerHTML = results
    .map(
      (r) => `<tr class="op-row" data-op="${esc(r.operationId)}" title="Detay için tıkla">
        <td class="mono">${esc(opLabel(r.operationId))}</td>
        <td title="${esc(r.keywords || "")}">${esc((r.keywords || "—").length > 32 ? (r.keywords || "").slice(0, 32) + "…" : r.keywords || "—")}</td>
        <td>${esc(r.devices || "—")}</td>
        <td>${r.domainCount}</td>
        <td>${r.attempts}</td>
        <td>${r.clicks}</td>
        <td>${r.reports}</td>
        <td class="muted">%${pct(r)}</td>
        <td class="muted" title="${r.startedAt ? new Date(r.startedAt).toLocaleString("tr-TR") : ""}">${fmtDT(r.startedAt)}</td>
      </tr>`
    )
    .join("");
  tbody.querySelectorAll(".op-row").forEach((row) => {
    row.addEventListener("click", () => openOpDetail(row.dataset.op));
  });
  renderOpResultsPager(data.total || results.length, data.page || 1, data.limit || OP_RESULTS_LIMIT);
}

/* ── Operation detail modal ── */
let opDetailLoading = false;
async function openOpDetail(operationId) {
  if (opDetailLoading) return;
  opDetailLoading = true;
  const modal = document.getElementById("op-detail-modal");
  const body = document.getElementById("op-detail-body");
  const title = document.getElementById("op-detail-title");
  if (!modal || !body || !title) { opDetailLoading = false; return; }
  title.textContent = `Operasyon: ${operationId}`;
  body.innerHTML = `<div class="empty">Yükleniyor…</div>`;
  modal.classList.remove("hidden");
  document.documentElement.classList.add("modal-open");
  document.body.classList.add("modal-open");
  try {
    const d = await API.get(`/api/ops/detail?operationId=${encodeURIComponent(operationId)}`);
    const s = d.summary;
    if (!s) {
      body.innerHTML = `<div class="empty">Operasyon bulunamadı</div>`;
      return;
    }
    const pct = s.attempts > 0 ? Math.round((s.clicks / s.attempts) * 100) : 0;
    const dur = s.startedAt && s.lastAt
      ? Math.max(1, Math.round((new Date(s.lastAt) - new Date(s.startedAt)) / 60000)) + " dk"
      : "—";
    const chipHtml = (k, v, hero = false) =>
      `<div class="op-chip${hero ? " hero" : ""}"><div class="op-chip-k">${k}</div><div class="op-chip-v">${v}</div></div>`;
    const chips = [
      chipHtml("Tıklama", s.clicks, true),
      chipHtml("Şikayet", s.reports, true),
      chipHtml("Başarı", "%" + pct, true),
      chipHtml("Deneme", s.attempts),
      chipHtml("Domain", s.domainCount),
    ].join("");

    // Meta line under the title — device/duration/dates have no room inside
    // chips and always ellipsized; here they get the full modal width.
    const metaEl = document.getElementById("op-detail-meta");
    if (metaEl) {
      const arrow = `${fmtDT(s.startedAt)} → ${fmtDT(s.lastAt)}`;
      metaEl.textContent = `${s.devices || "—"} · süre ${dur} · ${arrow}`;
    }

    const STATUS_STYLE = {
      success: "st-ok",
      failed: "st-err",
      profile_error: "st-err",
      captcha: "st-warn",
      skipped: "st-dim",
      running: "st-info",
    };
    const statusPills = (d.byStatus || [])
      .map((x) => `<span class="st-pill ${STATUS_STYLE[x.status] || "st-dim"}">${esc(x.status)} <b>${x.n}</b></span>`)
      .join("");
    const domainRows = (d.byDomain || []).map((x) => {
      const p = x.attempts > 0 ? Math.round((x.clicks / x.attempts) * 100) : 0;
      return `<tr>
        <td class="mono">${esc(x.domain)}</td>
        <td title="${esc(x.keywords || "")}">${esc((x.keywords || "—").length > 24 ? (x.keywords || "").slice(0, 24) + "…" : x.keywords || "—")}</td>
        <td>${esc(x.devices || "—")}</td>
        <td>${x.profiles}</td>
        <td>${x.attempts}</td><td>${x.clicks}</td><td>${x.reports}</td>
        <td class="muted">%${p}</td>
      </tr>`;
    }).join("");
    const profileRows = (d.byProfile || []).map((x) =>
      `<tr><td class="mono" title="${esc(x.profileId)}">${esc(x.profileId.length > 12 ? "…" + x.profileId.slice(-8) : x.profileId)}</td><td>${x.attempts}</td><td>${x.clicks}</td><td>${x.reports}</td></tr>`
    ).join("");
    const timelineRows = (d.timeline || []).slice(0, 50).map((x) => {
      const cls = x.status === "success" ? "ok" : x.status === "failed" || x.status === "profile_error" ? "err" : x.status === "captcha" ? "warn" : "";
      return `<tr>
        <td class="muted">${x.capturedAt ? new Date(x.capturedAt).toLocaleTimeString("tr-TR") : "—"}</td>
        <td class="mono" title="${esc(x.profileId)}">${esc(x.profileId.length > 10 ? "…" + x.profileId.slice(-6) : x.profileId)}</td>
        <td>${esc(x.device)}</td>
        <td title="${esc(x.keyword)}">${esc(x.keyword.length > 18 ? x.keyword.slice(0, 18) + "…" : x.keyword)}</td>
        <td class="mono" title="${esc(x.domain)}">${esc(x.domain.length > 26 ? x.domain.slice(0, 26) + "…" : x.domain)}</td>
        <td class="${cls}">${esc(x.status)}</td>
        <td>${esc(x.reportStatus || "—")}</td>
      </tr>`;
    }).join("");

    body.innerHTML = `
      <div class="op-chips">${chips}</div>
      <div class="op-status-row">${statusPills || `<span class="st-pill st-dim">veri yok</span>`}</div>
      <h3 class="op-sec">Site Bazında</h3>
      <div class="table-wrap"><table class="op-detail-table"><thead><tr>
        <th>Domain</th><th>Keyword</th><th>Cihaz</th><th>Profil</th><th>Deneme</th><th>Tık</th><th>Rapor</th><th>Başarı</th>
      </tr></thead><tbody>${domainRows || `<tr><td colspan="8" class="empty">Veri yok</td></tr>`}</tbody></table></div>
      <h3 class="op-sec">Profil Bazında (ilk 15)</h3>
      <div class="table-wrap"><table class="op-detail-table"><thead><tr>
        <th>Profil</th><th>Deneme</th><th>Tık</th><th>Rapor</th>
      </tr></thead><tbody>${profileRows || `<tr><td colspan="4" class="empty">Veri yok</td></tr>`}</tbody></table></div>
      <h3 class="op-sec">İş Akışı (son 50)</h3>
      <div class="table-wrap"><table class="op-detail-table"><thead><tr>
        <th>Saat</th><th>Profil</th><th>Cihaz</th><th>Keyword</th><th>Domain</th><th>Tık</th><th>Rapor</th>
      </tr></thead><tbody>${timelineRows || `<tr><td colspan="7" class="empty">Veri yok</td></tr>`}</tbody></table></div>`;
  } catch (err) {
    body.innerHTML = `<div class="empty">Detay yüklenemedi: ${esc(String(err))}</div>`;
  } finally {
    opDetailLoading = false;
  }
}

function closeOpDetail() {
  document.getElementById("op-detail-modal")?.classList.add("hidden");
  document.documentElement.classList.remove("modal-open");
  document.body.classList.remove("modal-open");
}
document.getElementById("op-detail-close")?.addEventListener("click", closeOpDetail);
document.getElementById("op-detail-modal")?.addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeOpDetail();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeOpDetail();
});

/* ── Profile health grid ── */
function renderHealth(data) {
  const el = document.getElementById("health-grid");
  if (!el) return;
  const profiles = data?.profiles || [];
  if (!profiles.length) {
    el.innerHTML = `<div class="empty">Profil verisi yok</div>`;
    return;
  }
  const counts = { usable: 0, captcha: 0, cooling: 0 };
  const chips = profiles
    .map((p) => {
      const cls = p.cooling ? "cooling" : p.status === "usable" ? "usable" : "captcha";
      counts[cls]++;
      const title = `${p.name} · ${p.device} · ${p.status}${p.cooling ? " · cooldown → " + (p.nextRetryAt || "") : ""}${p.lastError ? " · " + p.lastError : ""}`;
      return `<span class="health-chip ${cls}" title="${esc(title)}">${esc(p.name.replace(/^(TR-ISP-|TR-MOBILE-)/, ""))}</span>`;
    })
    .join("");
  el.innerHTML =
    chips +
    `<div class="health-legend"><span>● usable: ${counts.usable}</span><span>● captcha: ${counts.captcha}</span><span>● cooling: ${counts.cooling}</span></div>`;
}
/* ── KPI presence heatmap ── */
/* ── Proof (submitted ad reports) ── */
function renderProofPager(total, page, limit) {
  const pager = document.getElementById("proof-pager");
  if (!pager) return;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  if (totalPages <= 1) {
    pager.innerHTML = "";
    return;
  }
  let html = `<button class="pager-btn" ${page <= 1 ? "disabled" : ""} data-page="${page - 1}">Önceki</button>`;
  html += `<span class="pager-info">Sayfa ${page} / ${totalPages} (${total})</span>`;
  html += `<button class="pager-btn" ${page >= totalPages ? "disabled" : ""} data-page="${page + 1}">Sonraki</button>`;
  pager.innerHTML = html;
  pager.querySelectorAll(".pager-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const next = Number(e.currentTarget.dataset.page);
      if (next >= 1 && next <= totalPages) {
        proofPage = next;
        refresh(true);
      }
    });
  });
}

function proofBadge(status) {
  if (status === "submitted") return `<span class="badge run">GÖNDERİLDİ</span>`;
  if (status === "filled") return `<span class="badge ok">DOLDURULDU</span>`;
  if (status === "submit-failed") return `<span class="badge err">BAŞARISIZ</span>`;
  return `<span class="badge stale">${esc(status)}</span>`;
}

function renderProof(data) {
  const tbody = document.querySelector("#tbl-proof tbody");
  const empty = document.getElementById("proof-empty");
  if (!tbody || !empty) return;
  const results = data.results || [];
  if (!results.length) {
    tbody.innerHTML = "";
    empty.style.display = "block";
    document.getElementById("proof-pager").innerHTML = "";
    return;
  }
  empty.style.display = "none";
  tbody.innerHTML = results
    .map(
      (r) => `<tr>
        <td class="muted">${r.capturedAt ? new Date(r.capturedAt).toLocaleString("tr-TR") : "—"}</td>
        <td>${esc(r.keyword)}</td>
        <td>${esc(r.domain)}</td>
        <td>${esc(r.device)}</td>
        <td class="mono" style="font-size:11px">${esc(r.email || "—")}</td>
        <td>${proofBadge(r.reportStatus)}</td>
        <td class="mono">${r.googleNotifId ? `<a href="/api/reports/email-html?address=${encodeURIComponent(r.email || "")}" target="_blank" style="color:inherit;text-decoration:none" title="Google onay mailini gör">#${esc(r.googleNotifId)} ↗</a>` : '<span class="muted">bekleniyor</span>'}</td>
        <td>${r.googleOutcome ? `<span class="badge ok" title="${esc(r.googleOutcome)}">${esc(r.googleOutcome.slice(0, 40))}</span>` : '<span class="muted">inceleniyor</span>'}</td>
        <td>${r.reportStatus === "submitted" ? `<a href="${esc(r.evidenceUrl)}" target="_blank" class="pager-btn" style="text-decoration:none;padding:4px 9px;font-size:11px">Gör</a>` : ""}</td>
      </tr>`
    )
    .join("");
  renderProofPager(data.total || results.length, data.page || 1, data.limit || PROOF_LIMIT);
}

/* ── Ops mode (yeni birleşik sistem: gözcü + planlayıcı + valf + motor) ── */
const RICH_THRESHOLD = 2; // config.ops.richThreshold default — sadece vurgulama için
let opsCache = { plan: null, valve: null, richness: null, engine: null };
let opsPollInFlight = false;
let lastOpsRefreshAt = 0;

function fmtAgo(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 15_000) return "az önce";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} dk`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} sa`;
  return `${Math.floor(h / 24)} g`;
}

function opsViewVisible() {
  return !document.getElementById("view-opsmode")?.classList.contains("hidden");
}

function renderOpsControl(enabled) {
  const toggle = document.getElementById("ops-enabled-toggle");
  const status = document.getElementById("ops-mode-status");
  if (toggle && document.activeElement !== toggle) toggle.checked = !!enabled;
  if (status) {
    status.textContent = enabled ? "AKTİF" : "KAPALI";
    status.className = enabled ? "op-status run ops-on" : "op-status";
  }
}

function renderOpsRates(engineRes) {
  const el = document.getElementById("ops-rates");
  const totalsEl = document.getElementById("ops-totals");
  const metaEl = document.getElementById("ops-engine-meta");
  if (!el || !totalsEl || !metaEl) return;
  const eng = engineRes?.engine;
  if (!eng || !eng.running) {
    metaEl.textContent = engineRes?.enabled
      ? "Motor durdu — plan veya valf bekleniyor"
      : "Ops modu kapalı — yukarıdaki anahtarla başlat";
    el.innerHTML = `<div class="empty">Motor çalışmıyor</div>`;
    totalsEl.innerHTML = "";
    return;
  }
  const t = eng.totals || { clicks: 0, reports: 0, failed: 0, skipped: 0, queriesLastHour: 0 };
  metaEl.textContent = `run #${eng.runId} · ${eng.browsers} tarayıcı · ${eng.activePoints} aktif nokta · ${t.queriesLastHour} sorgu/saat`;
  const per = eng.perDomain || [];
  el.innerHTML = per.length
    ? per
        .map(
          (d) => `<div class="ops-rate-card">
        <div class="ops-rate-domain" title="${esc(d.domain)}">${esc(d.domain)}</div>
        <div class="ops-rate-nums">
          <div class="ops-rate-num">${d.clicksPerHour}<span>tık/sa</span></div>
          <div class="ops-rate-num rep">${d.reports}<span>şikayet</span></div>
        </div>
        <div class="ops-rate-sub">${d.clicks} toplam tık</div>
      </div>`
        )
        .join("")
    : `<div class="empty">Henüz domain bazlı tık yok</div>`;
  totalsEl.textContent = `toplam ${t.clicks} tık · ${t.reports} rapor · ${t.failed} fail · ${t.skipped} skip`;
}

function renderOpsValve(v) {
  const status = document.getElementById("ops-valve-status");
  const band = document.getElementById("ops-calm-band");
  const meta = document.getElementById("ops-valve-meta");
  if (!status || !band || !meta) return;
  if (!v) {
    status.textContent = "—";
    status.className = "op-status";
    meta.textContent = "Valf verisi yok";
    return;
  }
  if (v.calm) {
    status.textContent = "SAKINLEŞME";
    status.className = "op-status calm";
    band.classList.remove("hidden");
  } else {
    status.textContent = "AKIŞ AÇIK";
    status.className = "op-status run";
    band.classList.add("hidden");
  }
  meta.textContent = `captcha ${v.captchaCount ?? 0} · usable ${v.usableCount ?? 0} · sakinleşme eşiği ${v.calmThreshold} · toparlanma eşiği ${v.resumeThreshold}`;
}

function renderOpsPlan(p) {
  const el = document.getElementById("ops-plan-cards");
  const desc = document.getElementById("ops-plan-desc");
  if (!el) return;
  if (desc && p) {
    desc.textContent = `en fazla ${p.maxActiveDomains} domain · histerezis ${p.hysteresisMinutes} dk · güncelleme ${fmtTime(p.updatedAt)}`;
  }
  const active = p?.active || [];
  if (!active.length) {
    el.innerHTML = `<div class="empty">Aktif hedef yok — zengin domain bekleniyor</div>`;
    return;
  }
  el.innerHTML = active
    .map(
      (a) => `<div class="op-card">
      <div class="op-header">
        <div class="op-icon">◎</div>
        <span class="op-status run">ÖNCELİK #${(a.priority ?? 0) + 1}</span>
      </div>
      <h3>${esc(a.domain)}</h3>
      <p class="op-desc">${esc((a.keywords || []).join(" · ") || "—")}</p>
      <div class="op-meta">${esc(a.device)} · skor ${Number(a.score || 0).toFixed(1)} · ${fmtAgo(a.since)} aktif</div>
      ${a.hysteresisLocked ? `<span class="badge stale">histerezis kilidi</span>` : ""}
    </div>`
    )
    .join("");
}

function renderOpsRichness(r) {
  const grid = document.getElementById("ops-richness-grid");
  const meta = document.getElementById("ops-richness-meta");
  if (!grid) return;
  const w = r?.watcher;
  if (meta) {
    meta.textContent = w
      ? `gözcü ${w.running ? "çalışıyor" : "durdu"} · son tur ${fmtTime(w.lastTickAt)} · ${w.queriesLastHour}/${w.budgetPerHour} sorgu/saat`
      : "Gözcü verisi yok";
  }
  const domains = r?.domains || [];
  if (!domains.length) {
    grid.innerHTML = `<div class="empty">Henüz zenginlik verisi yok</div>`;
    return;
  }
  const maxScore = Math.max(...domains.map((d) => d.score || 0), 1);
  const planned = new Set((opsCache.plan?.active || []).map((a) => a.domain));
  grid.innerHTML = domains
    .slice(0, 24)
    .map((d) => {
      const rich = (d.score || 0) >= RICH_THRESHOLD;
      const pct = Math.max(6, Math.min(100, Math.round(((d.score || 0) / maxScore) * 100)));
      const devBadges = Object.entries(d.devices || {})
        .map(([dev, n]) => `<span class="health-chip usable">${esc(dev)} ${n}</span>`)
        .join("");
      const tag = planned.has(d.key)
        ? `<span class="badge run">PLANDA</span>`
        : rich
          ? `<span class="badge ok">ZENGİN</span>`
          : "";
      return `<div class="rich-card ${rich ? "rich" : ""}">
      <div class="rich-head">
        <span class="rich-brand">${esc(d.brand || "—")}</span>
        ${tag}
      </div>
      <div class="rich-domain" title="${esc(d.key)}">${esc(d.key)}</div>
      <div class="score-bar"><span style="width:${pct}%"></span></div>
      <div class="rich-meta">${d.adCount} reklam · skor ${Number(d.score || 0).toFixed(1)} · son ${fmtAgo(d.lastSeenAt)}</div>
      <div class="rich-devs">${devBadges}</div>
    </div>`;
    })
    .join("");
}

function pointStateBadge(state) {
  const map = { active: "run", miss: "ok", starting: "stale", parked: "stale", idle: "stale" };
  return `<span class="badge ${map[state] || "stale"}">${esc(state || "—")}</span>`;
}

function renderOpsPoints(engineRes) {
  const tbody = document.querySelector("#tbl-ops-points tbody");
  const empty = document.getElementById("ops-points-empty");
  if (!tbody || !empty) return;
  const points = engineRes?.engine?.points || [];
  if (!points.length) {
    tbody.innerHTML = "";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";
  tbody.innerHTML = points
    .map((p) => {
      const kw = p.keyword || "—";
      const act = p.lastAction || "—";
      return `<tr>
      <td class="mono" title="${esc(p.profileId)}">…${esc(String(p.profileId || "").slice(-6))}</td>
      <td class="mono">t${p.tabIndex}</td>
      <td>${esc(p.device)}</td>
      <td class="mono">${esc(p.domain || "—")}</td>
      <td title="${esc(kw)}">${esc(kw.length > 18 ? kw.slice(0, 18) + "…" : kw)}</td>
      <td>${pointStateBadge(p.state)}</td>
      <td class="muted" title="${esc(act)}">${esc(act.length > 26 ? act.slice(0, 26) + "…" : act)}</td>
      <td class="mono">${p.clicks}</td>
      <td class="mono">${p.reports}</td>
      <td class="mono">${p.fails}</td>
      <td class="mono">${p.misses}</td>
    </tr>`;
    })
    .join("");
}

async function refreshOpsMode(force = false) {
  if (opsPollInFlight) return;
  if (!force && !opsViewVisible()) return; // görünmeyen görünümü poll etme
  if (!force && Date.now() - lastOpsRefreshAt < 3000) return; // SSE fırtınasına karşı
  lastOpsRefreshAt = Date.now();
  opsPollInFlight = true;
  try {
    const [plan, valve, richness, engine] = await Promise.all([
      API.get("/api/ops/plan").catch(() => null),
      API.get("/api/ops/valve").catch(() => null),
      API.get("/api/ops/richness").catch(() => null),
      API.get("/api/ops/engine").catch(() => null),
    ]);
    opsCache = { plan, valve, richness, engine };
    renderOpsControl(plan?.enabled ?? engine?.enabled ?? false);
    renderOpsRates(engine);
    renderOpsValve(valve);
    renderOpsPlan(plan);
    renderOpsRichness(richness);
    renderOpsPoints(engine);
  } finally {
    opsPollInFlight = false;
  }
}

/** ops-stats SSE: sayaçları ve hızları tam poll olmadan canlı güncelle. */
function updateOpsFromStats(d) {
  if (!opsViewVisible()) return;
  const eng = opsCache.engine?.engine;
  if (!eng || !eng.running) return;
  if (d.totals) eng.totals = d.totals;
  if (d.perDomain) eng.perDomain = d.perDomain;
  if (d.browsers != null) eng.browsers = d.browsers;
  if (d.activePoints != null) eng.activePoints = d.activePoints;
  if (d.runId != null) eng.runId = d.runId;
  renderOpsRates(opsCache.engine);
}

function init() {
  renderLogs();
  void loadServerLogs();
  document.querySelectorAll(".nav-item").forEach((btn) =>
    btn.addEventListener("click", () => {
      switchView(btn.dataset.view);
      if (btn.dataset.view === "opsmode") refreshOpsMode(true);
    })
  );
  const savedView = localStorage.getItem(VIEW_KEY);
  if (savedView && document.getElementById("view-" + savedView)) {
    switchView(savedView);
    if (savedView === "opsmode") refreshOpsMode(true);
  }
  document.getElementById("scan-form").addEventListener("submit", onScanSubmit);

  // Default brands switch: ON → box pre-filled + locked; OFF → custom list
  // (restores the user's last custom list if any).
  const DEFAULT_SCAN_BRANDS = ["herabet", "primebahis", "napolibet", "rovbet", "vegasslot"];
  const brandsBox = document.getElementById("scan-brands");
  const defaultSwitch = document.getElementById("scan-default-brands");
  function applyBrandMode() {
    if (defaultSwitch.checked) {
      brandsBox.value = DEFAULT_SCAN_BRANDS.join("\n");
      brandsBox.disabled = true;
    } else {
      brandsBox.disabled = false;
      const custom = localStorage.getItem("detect-custom-brands");
      brandsBox.value = custom || "";
      brandsBox.focus();
    }
  }
  defaultSwitch.addEventListener("change", applyBrandMode);
  applyBrandMode();
  document.getElementById("btn-clear-log")?.addEventListener("click", () => {
    logs = [];
    saveLogs();
    renderLogs();
  });
  document.getElementById("scheduled-enabled")?.addEventListener("change", async (e) => {
    try {
      await API.post("/api/scheduled-scan/enabled", { enabled: e.target.checked });
      refresh(true);
    } catch (err) {
      log("err", `otomatik tarama: ${err.message}`);
    }
  });
  document.getElementById("proof-filter-apply")?.addEventListener("click", () => {
    proofPage = 1;
    const exportBtn = document.getElementById("proof-export");
    if (exportBtn) exportBtn.href = `/api/reports/submitted/export?${proofFilterQs().replace(/^&/, "")}`;
    refresh(true);
  });
  document.getElementById("btn-stop-focus").addEventListener("click", stopFocus);
  document.getElementById("btn-start-storm")?.addEventListener("click", startStorm);
  document.getElementById("btn-stop-storm")?.addEventListener("click", stopStorm);
  const logoutBtn = document.getElementById("btn-logout");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      await API.post("/api/logout").catch(() => {});
      window.location.href = "/login";
    });
  }
  document.getElementById("ops-enabled-toggle")?.addEventListener("change", async (e) => {
    const enabled = e.target.checked;
    try {
      await API.post("/api/ops/enabled", { enabled });
      log("info", enabled ? "ops modu açıldı" : "ops modu kapatıldı");
      await refreshOpsMode(true);
    } catch (err) {
      e.target.checked = !enabled;
      log("err", `ops modu: ${err.message}`);
    }
  });
  setupSSE();
  refresh(true);
  setInterval(refresh, 10000);
  setInterval(refreshOpsMode, 15000);
}

init();
