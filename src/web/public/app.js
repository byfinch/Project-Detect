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
    const [ops, complaintRes, opResultsRes, scansRes, proofRes, healthRes] = await Promise.all([
      API.get("/api/ops"),
      API.get("/api/reports/complaints/packs").catch(() => ({ packs: [] })),
      API.get(`/api/ops/summary?page=${opResultsPage}&limit=${OP_RESULTS_LIMIT}`).catch(() => ({ results: [], total: 0, page: 1, limit: OP_RESULTS_LIMIT })),
      API.get(`/api/scans/paged?page=${scansPage}&limit=${SCANS_PER_PAGE}`).catch(() => ({ scans: [], total: 0, page: 1, limit: SCANS_PER_PAGE })),
      API.get(`/api/reports/submitted?page=${proofPage}&limit=${PROOF_LIMIT}${proofQs}`).catch(() => ({ results: [], total: 0, page: 1, limit: PROOF_LIMIT })),
      API.get("/api/profiles/health").catch(() => ({ profiles: [] })),
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
    isScanRunningFromOps = isScanRunning(ops.jobs);
    updateOps(ops);
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
      if (d.message) log(eventLevel(d.type), d.message);
      if (["scan-completed", "scan-started", "click-completed", "click-done", "campaign-rescan-done"].includes(d.type)) {
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
    const chips = [
      ["Başlangıç", fmtDT(s.startedAt)],
      ["Son aktivite", fmtDT(s.lastAt)],
      ["Süre", dur],
      ["Cihaz", s.devices || "—"],
      ["Domain", s.domainCount],
      ["Deneme", s.attempts],
      ["Tıklama", s.clicks],
      ["Şikayet", s.reports],
      ["Başarı", "%" + pct],
    ].map(([k, v]) => `<div class="op-chip"><div class="op-chip-k">${k}</div><div class="op-chip-v">${v}</div></div>`).join("");

    const statusTxt = (d.byStatus || []).map((x) => `${x.status}: ${x.n}`).join(" · ");
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
      <div class="muted" style="margin:6px 0 14px">Durum dağılımı: ${esc(statusTxt || "—")}</div>
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

function init() {
  renderLogs();
  void loadServerLogs();
  document.querySelectorAll(".nav-item").forEach((btn) =>
    btn.addEventListener("click", () => switchView(btn.dataset.view))
  );
  const savedView = localStorage.getItem(VIEW_KEY);
  if (savedView && document.getElementById("view-" + savedView)) switchView(savedView);
  document.getElementById("scan-form").addEventListener("submit", onScanSubmit);
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
  const logoutBtn = document.getElementById("btn-logout");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      await API.post("/api/logout").catch(() => {});
      window.location.href = "/login";
    });
  }
  setupSSE();
  refresh(true);
  setInterval(refresh, 10000);
}

init();
