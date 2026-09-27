"use strict";

/* search-rotation Konsole — SPA mit Hash-Routing.
   Views: Übersicht (#/), Engines (#/engines), Verlauf (#/history), MCP Tools (#/tools) */

const $ = (s) => document.querySelector(s);

const state = {
  meta: null,
  config: null,
  status: [],
  history: [],
  route: "/",
  openEngines: new Set(), // aufgeklappte Engine-Drawer
  historyOpen: new Set(), // aufgeklappte Verlaufseinträge
  filters: { kind: "all", engine: "", q: "" },
  livePaused: false,
  dragFrom: null,
  unauthorized: false,
};

/* ---------- i18n ---------- */

const I18N = window.I18N;
let lang = localStorage.getItem("sr_lang") || "en";
if (!I18N[lang]) lang = "en";

function t(key, vars) {
  let s = (I18N[lang] && I18N[lang][key]) || I18N.de[key] || key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll("{" + k + "}", String(v));
  return s;
}

function applyI18n() {
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll("[data-i18n-title]").forEach((el) => (el.title = t(el.dataset.i18nTitle)));
  $("#lang-code").textContent = lang.toUpperCase();
  $("#theme-btn").title = t(document.documentElement.dataset.theme === "dark" ? "theme.toLight" : "theme.toDark");
  document.querySelectorAll("#lang-menu [data-lang]").forEach((b) => b.classList.toggle("active", b.dataset.lang === lang));
}

/* ---------- Theme ---------- */

function initTheme() {
  const saved = localStorage.getItem("sr_theme");
  const theme = saved || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  setTheme(theme, false);
}

function setTheme(theme, persist = true) {
  document.documentElement.dataset.theme = theme;
  $("#theme-icon").innerHTML = '<use href="#i-' + (theme === "dark" ? "sun" : "moon") + '"/>';
  $("#theme-btn").title = t(theme === "dark" ? "theme.toLight" : "theme.toDark");
  document.querySelector('meta[name="theme-color"]').setAttribute("content", theme === "dark" ? "#0a0c12" : "#f4f5fa");
  if (persist) localStorage.setItem("sr_theme", theme);
}

/* ---------- Helfer ---------- */

function esc(s) {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const rtf = { format: (value, unit) => new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(value, unit) };

function relTime(ts) {
  const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 45) return rtf.format(-s, "second");
  const m = Math.round(s / 60);
  if (m < 45) return rtf.format(-m, "minute");
  const h = Math.round(m / 60);
  if (h < 22) return rtf.format(-h, "hour");
  return rtf.format(-Math.round(h / 24), "day");
}

function fmtMs(ms) {
  return ms >= 1000 ? (ms / 1000).toLocaleString(lang, { maximumFractionDigits: 1 }) + " s" : Math.round(ms) + " ms";
}

const ENGINE_HUES = { tavily: 174, exa: 262, firecrawl: 24, "google-cse": 217, jina: 199, parallel: 145, duckduckgo: 14 };

function engineHue(id) {
  if (ENGINE_HUES[id] !== undefined) return ENGINE_HUES[id];
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function avatarStyle(id) {
  const h = engineHue(id);
  return "background:linear-gradient(135deg,hsl(" + h + " 62% 52%),hsl(" + ((h + 28) % 360) + " 68% 40%))";
}

/** Bundled provider favicon; the delegated error handler retains the letter fallback. */
function engineLogoHtml(e) {
  const letter = esc((e.label || e.id)[0]);
  if (!Object.hasOwn(ENGINE_HUES, e.id)) return '<span class="avatar" style="' + avatarStyle(e.id) + '\">' + letter + "</span>";
  return '<span class="logo-wrap"><img class="logo" src="/engine-logos/' + encodeURIComponent(e.id) +
    '.png" alt="" loading="lazy" data-fallback="' + letter + '" data-hue="' + engineHue(e.id) + '\"></span>';
}

function pctClass(pct) {
  return pct > 40 ? "ok" : pct > 10 ? "warn" : "crit";
}

function bar(pct) {
  return '<span class="bar" role="img" aria-label="' + esc(t("quota.free", { pct })) + '"><span class="fill ' + pctClass(pct) + '" style="width:' + Math.max(0, Math.min(100, pct)) + '%"></span></span>';
}

function usageSummary(st) {
  const search = st.used?.search || 0, fetch = st.used?.fetch || 0, errors = st.used?.errors || 0;
  return { total: search + fetch + errors, search, fetch, errors };
}

function usageHtml(st) {
  const counts = usageSummary(st);
  return '<span class="usage-summary" title="' + esc(t("usage.help")) + '"><strong>' +
    esc(t(counts.total === 1 ? "usage.totalOne" : "usage.total", { n: counts.total })) + '</strong><span class="usage-detail">' +
    esc(t("usage.detail", counts)) + '</span></span>';
}

function quotaDescription(st) {
  const q = st.quota;
  if (!q || !(q.limit > 0) || !Number.isFinite(q.used)) return t("quota.unknown");
  const format = n => n.toLocaleString(lang, { maximumFractionDigits: 2 });
  return t("quota.remaining", { remaining: format(Math.max(0, q.limit - q.used)), limit: format(q.limit), unit: t("quota.unit." + q.unit) }) +
    " · " + t(q.source === "remote" ? "quota.providerBalance" : "quota.period." + q.period) +
    (q.timeZone ? " · " + q.timeZone : "") + " · " + t("quota.source." + q.source) + (q.estimated ? " · " + t("quota.estimated") : "");
}

function budgetHtml(st) {
  const pct = remainingPctOf(st);
  const help = quotaDescription(st) + ". " + t(st.quota?.source === "remote" ? "quota.remoteHelp" : "quota.localHelp");
  return '<span class="budget-summary" title="' + esc(help) + '">' +
    (pct === null ? '' : bar(pct)) + '<span class="quota-label">' + esc(quotaDescription(st)) + '</span></span>' +
    (st.remoteError ? '<span class="quota-err" title="' + esc(st.remoteError) + '">' + esc(t("quota.fetchError")) + '</span>' : '');
}

function quotaHtml(st) {
  return st?.id ? usageHtml(st) + budgetHtml(st) : '';
}

function ringGauge(pct) {
  const r = 21, c = 2 * Math.PI * r;
  const label = pct === null ? t("quota.unknown") : t("quota.free", { pct });
  const off = c * (1 - (pct ?? 0) / 100);
  return '<span class="gauge" role="img" title="' + esc(label) + '" aria-label="' + esc(label) + '"><svg aria-hidden="true" width="52" height="52" viewBox="0 0 52 52">' +
    '<circle class="track" cx="26" cy="26" r="' + r + '" fill="none" stroke-width="5"/>' +
    (pct === null ? '' : '<circle class="val ' + pctClass(pct) + '" cx="26" cy="26" r="' + r + '" fill="none" stroke-width="5" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '"/>') +
    '</svg><span class="gauge-val' + (pct === null ? ' inf' : '') + '">' + (pct === null ? '?' : pct + '%') + '</span></span>';
}

/* ---------- Token & API ---------- */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    state.unauthorized = true;
    $("#view").innerHTML = '<div class="auth-error"><div><p style="font-size:34px;margin:0 0 10px">🔒</p>' + t("api.unauthorized") + '<p><a href="/login">Anmelden / Sign in</a></p></div></div>';
    throw new Error("unauthorized");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function refreshStatus() {
  const s = await api("/api/status");
  state.status = s.engines || [];
  if (state.meta) state.meta.month = s.month;
}

async function loadHistory() {
  const data = await api("/api/history?limit=200");
  state.history = data.entries || [];
}

async function load() {
  state.meta = await api("/api/meta");
  state.config = await api("/api/config");
  await refreshStatus();
  document.body.dataset.booted = "1";
  $("#version").textContent = "v" + state.meta.version;
  $("#configpath").textContent = state.meta.configPath;
  $("#configpath").title = state.meta.configPath;
  render();
  loadHistory().then(renderIfDataView).catch(() => {});
}

function renderIfDataView() {
  if (state.route === "/history" || state.route === "/") render();
}

/* ---------- Toasts ---------- */

function toast(kind, msg) {
  const wrap = $("#toasts");
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.innerHTML =
    '<svg width="16" height="16"><use href="#i-' +
    (kind === "ok" ? "check" : kind === "error" ? "x" : "zap") +
    '"/></svg><span>' + esc(msg) + "</span>";
  wrap.appendChild(el);
  setTimeout(() => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 260);
  }, 3200);
}

/* ---------- Status-Zugriff ---------- */

function statusOf(id) {
  return state.status.find((e) => e.id === id) || {};
}

function sortedEngines() {
  return [...state.status].sort((a, b) => a.searchPosition - b.searchPosition);
}

function anyKeySet() {
  return state.status.some((e) => e.hasKey);
}

/* ---------- Konfig-PUTs (serialisiert) ---------- */

let putChain = Promise.resolve();

function queuePut(bodyBuilder) {
  putChain = putChain
    .then(() => api("/api/config", { method: "PUT", body: bodyBuilder(state.config) }))
    .then(async (r) => {
      state.config = r.config;
      try {
        await refreshStatus();
      } catch {}
      render();
      toast("ok", t("toast.saved"));
    })
    .catch((err) => {
      if (err.message !== "unauthorized") toast("error", t("toast.error", { msg: err.message }));
    });
  return putChain;
}

/* ---------- Router ---------- */

function parseHash() {
  const h = location.hash.replace(/^#/, "");
  return ["/", "/engines", "/history", "/tools"].includes(h) ? h : "/";
}

function setRoute(route) {
  state.route = route;
  document.querySelectorAll(".nav-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.route === route));
  positionNavInd();
  render();
  window.scrollTo({ top: 0 });
}

function positionNavInd() {
  const active = $(".nav-tab.active");
  const ind = $("#nav-ind");
  if (!active || !ind) return;
  ind.style.width = active.offsetWidth + "px";
  ind.style.transform = "translateX(" + active.offsetLeft + "px)";
}

function render() {
  if (state.unauthorized) return;
  applyI18n();
  positionNavInd();
  if (!state.config) return renderSkeleton();
  if (state.route === "/engines") renderEngines();
  else if (state.route === "/history") renderHistory();
  else if (state.route === "/tools") renderTools();
  else renderOverview();
}

function renderSkeleton() {
  $("#view").innerHTML =
    '<div class="page">' +
    '<div class="skeleton" style="height:52px;margin-bottom:16px"></div>' +
    '<div class="overview-grid">' + '<div class="skeleton" style="height:110px"></div>'.repeat(4) + "</div>" +
    '<div class="skeleton" style="height:180px"></div>' +
    "</div>";
}

/* ---------- View: Übersicht ---------- */

function statValues() {
  const engines = state.status;
  const searches = engines.reduce((n, e) => n + (e.used?.search || 0), 0);
  const fetches = engines.reduce((n, e) => n + (e.used?.fetch || 0), 0);
  const h = state.history;
  const fails = h.filter((e) => !e.ok).length;
  const errRate = h.length ? Math.round((100 * fails) / h.length) : 0;
  const okDurs = h.filter((e) => e.ok).map((e) => e.ms);
  const avg = okDurs.length ? okDurs.reduce((a, b) => a + b, 0) / okDurs.length : 0;
  return { searches, fetches, errRate: h.length ? errRate + "%" : "–", avg: okDurs.length ? fmtMs(avg) : "–" };
}

function rotationHtml() {
  const enabled = sortedEngines().filter((e) => e.enabled && e.capabilities?.includes("search"));
  if (!enabled.length) return '<div class="empty" style="padding:22px"><span class="empty-title">' + esc(t("rotation.empty")) + '</span></div>';
  return enabled.map((e, i) => '<a class="rot-row" href="#/engines">' +
    '<span class="rot-pos">' + (i + 1) + '</span>' + engineLogoHtml(e) +
    '<span class="rot-content"><span class="rot-name">' + esc(e.label || e.id) + '</span>' + usageHtml(e) + budgetHtml(e) + '</span>' +
    '<svg class="rot-arrow" width="15" height="15"><use href="#i-arrow"/></svg></a>').join('');
}

function healthHtml() {
  return sortedEngines().map(e => '<a class="health-card' + (e.enabled ? '' : ' off') + '" href="#/engines">' +
    ringGauge(remainingPctOf(e)) + '<span class="health-meta"><span class="health-name">' + esc(e.label || e.id) +
    (!e.enabled ? ' <span class="badge">' + esc(t("health.off")) + '</span>' : '') + '</span>' +
    usageHtml(e) + '<span class="health-src" title="' + esc(t(e.quota?.source === 'remote' ? 'quota.remoteHelp' : 'quota.localHelp')) + '">' + esc(quotaDescription(e)) + '</span>' +
    (e.remoteError ? '<span class="quota-err" title="' + esc(e.remoteError) + '">' + esc(t("quota.fetchError")) + '</span>' : '') +
    '</span></a>').join('');
}

function recentHtml() {
  const h = state.history;
  if (!h.length) return '<div class="empty" style="padding:20px"><span class="muted">' + esc(t("recent.empty")) + "</span></div>";
  return h
    .slice(0, 6)
    .map(
      (e) =>
        '<a class="recent-row" href="#/history" title="' + esc(e.input + ' · ' + new Date(e.ts).toLocaleString(lang) + ' · ' + fmtMs(e.ms)) + '">' +
        '<span class="hkind-icon ' + esc(e.kind) + '" style="width:24px;height:24px"><svg width="13" height="13"><use href="#i-' + (e.kind === "search" ? "search" : "link") + '"/></svg></span>' +
        '<span class="ri">' + esc(e.input) + "</span>" +
        (e.ok ? "" : '<svg width="13" height="13" style="color:var(--crit)"><use href="#i-x"/></svg>') +
        '<span class="recent-engine">' + esc(e.engine ? statusOf(e.engine).label || e.engine : t('hist.failed')) + '</span>' +
        '<span class="rt">' + relTime(e.ts) + "</span></a>",
    )
    .join("");
}

function renderOverview() {
  const v = statValues();
  $("#view").innerHTML =
    '<div class="page">' +
    pageHead(t("overview.title"), t("overview.sub"), state.meta.month) +
    (anyKeySet() ? "" : '<div class="banner"><svg width="16" height="16"><use href="#i-alert"/></svg><span>' + esc(t("notice.nokeys")) + "</span></div>") +
    '<div class="overview-grid">' +
    statCard("searches", "search", t("stat.searches"), t("stat.searchesSub"), v.searches) +
    statCard("fetches", "link", t("stat.fetches"), t("stat.fetchesSub"), v.fetches) +
    statCard("errors", "alert", t("stat.errors"), t("stat.errorsSub"), v.errRate) +
    statCard("duration", "zap", t("stat.duration"), t("stat.durationSub"), v.avg) +
    "</div>" +
    '<div class="two-col">' +
    '<div class="panel"><div class="panel-head"><h2>' + esc(t("rotation.title")) + '</h2><span class="sub">' + esc(t("rotation.sub")) + '</span><span class="spacer"><a class="btn btn-ghost" href="#/engines">' + esc(t("rotation.manage")) + ' <svg width="13" height="13"><use href="#i-arrow"/></svg></a></span></div><div class="rot-list">' + rotationHtml() + "</div></div>" +
    '<div class="panel"><div class="panel-head"><h2>' + esc(t("health.title")) + '</h2><span class="sub">' + esc(t("health.sub")) + "</span></div>" + '<div class="health-grid">' + healthHtml() + "</div></div>" +
    "</div>" +
    '<div class="panel"><div class="panel-head"><h2>' + esc(t("recent.title")) + '</h2><span class="spacer"><a class="btn btn-ghost" href="#/history">' + esc(t("recent.all")) + ' <svg width="13" height="13"><use href="#i-arrow"/></svg></a></span></div>' +
    '<div class="sparkline">' + sparkline(state.history) + "</div>" +
    '<div class="recent-list">' + recentHtml() + "</div></div>" +
    '<details class="panel setup-panel" open><summary>' + esc(t("setup.summary")) + '<svg class="chev" width="16" height="16"><use href="#i-chevron"/></svg></summary>' +
    '<div class="snippets">' +
    '<div class="snippet"><h3>' + esc(t("snippet.codex")) + '</h3><pre id="snip-codex"></pre><button class="btn" data-copy="snip-codex">' + esc(t("btn.copy")) + "</button></div>" +
    '<div class="snippet"><h3>' + esc(t("snippet.claude")) + '</h3><pre id="snip-claude"></pre><button class="btn" data-copy="snip-claude">' + esc(t("btn.copy")) + "</button></div>" +
    '<div class="snippet"><h3>' + esc(t("snippet.remote")) + '</h3><pre id="snip-remote"></pre><button class="btn" data-copy="snip-remote">' + esc(t("btn.copy")) + "</button></div>" +
    "</div></details>" +
    "</div>";

  renderSnippets();
}

/** Patcht nur die dynamischen Bereiche der Übersicht — kein Voll-Render, kein Flackern. */
function updateOverview() {
  const root = $("#view");
  if (!root.querySelector(".rot-list")) return;
  const month = root.querySelector(".page-head .badge");
  if (month) month.textContent = state.meta.month;
  const v = statValues();
  const set = (id, val) => {
    const el = root.querySelector('[data-stat="' + id + '"]');
    if (el && el.textContent !== String(val)) el.textContent = String(val);
  };
  set("searches", v.searches);
  set("fetches", v.fetches);
  set("errors", v.errRate);
  set("duration", v.avg);
  const rot = root.querySelector(".rot-list");
  if (rot) rot.innerHTML = rotationHtml();
  const health = root.querySelector(".health-grid");
  if (health) health.innerHTML = healthHtml();
  const spark = root.querySelector(".sparkline");
  if (spark && !spark.contains(document.activeElement) && !spark.matches(":hover")) spark.innerHTML = sparkline(state.history);
  const recent = root.querySelector(".recent-list");
  if (recent) recent.innerHTML = recentHtml();
}

function pageHead(title, sub, month) {
  return (
    '<div class="page-head"><h1>' + esc(title) + (month ? ' <span class="badge">' + esc(month) + "</span>" : "") + "</h1>" +
    '<div class="sub">' + esc(sub) + "</div></div>"
  );
}

function statCard(stat, icon, label, sub, value) {
  return (
    '<div class="panel stat-card" tabindex="0" title="' + esc(t('stat.' + stat + 'Help')) + '"><span class="stat-icon"><svg width="16" height="16"><use href="#i-' + icon + '"/></svg></span>' +
    '<span class="stat-value" data-stat="' + stat + '">' + esc(value) + '</span><span class="stat-label">' + esc(label) + '</span><span class="stat-sub">' + esc(sub) + "</span></div>"
  );
}

function remainingPctOf(st) {
  const q = st.quota;
  return q?.limit > 0 && Number.isFinite(q.used)
    ? Math.max(0, Math.min(100, Math.round(100 * (q.limit - q.used) / q.limit))) : null;
}

/** Rolling 48-hour window, based on at most 200 retained tool calls. */
function activityBuckets(entries, now = Date.now()) {
  const bucketMs = 2 * 3600 * 1000;
  const buckets = Array.from({ length: 24 }, (_, i) => ({
    start: now - (24 - i) * bucketMs, end: now - (23 - i) * bucketMs,
    total: 0, search: 0, fetch: 0, errors: 0, attempts: 0, engines: {},
  }));
  for (const e of entries) {
    const age = now - new Date(e.ts).getTime();
    if (!Number.isFinite(age) || age < 0 || age >= 24 * bucketMs) continue;
    const bucket = buckets[23 - Math.floor(age / bucketMs)];
    bucket.total++;
    if (e.kind === 'search') bucket.search++;
    if (e.kind === 'fetch') bucket.fetch++;
    if (!e.ok) bucket.errors++;
    const attempts = e.attempts ?? (e.engine ? [{ engine: e.engine }] : []);
    for (const attempt of attempts) {
      bucket.attempts++;
      bucket.engines[attempt.engine] = (bucket.engines[attempt.engine] || 0) + 1;
    }
  }
  return buckets;
}

function sparkline(entries) {
  const buckets = activityBuckets(entries);
  const max = Math.max(...buckets.map(b => b.total), 1);
  const format = ts => new Date(ts).toLocaleString(lang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const bars = buckets.map(b => {
    const providers = Object.entries(b.engines).map(([id, n]) => (statusOf(id).label || id) + ': ' + n).join(' · ');
    const tip = format(b.start) + ' – ' + format(b.end) + '\n' + t('activity.bucket', b) +
      (providers ? '\n' + t('activity.providers', { n: b.attempts }) + ': ' + providers : '');
    return '<button type="button" class="activity-bucket" aria-label="' + esc(tip) + '">' +
      '<span class="activity-fill" style="height:' + (b.total ? Math.max(5, b.total / max * 100) : 0) + '%"></span>' +
      '<span class="activity-tooltip" aria-hidden="true">' + esc(tip) + '</span></button>';
  }).join('');
  return '<div class="activity-caption">' + esc(t('activity.caption')) + '</div>' +
    '<div class="activity-bars" role="group" aria-label="' + esc(t('activity.caption')) + '">' + bars + '</div>' +
    '<div class="activity-axis"><span>' + esc(t('activity.start')) + '</span><span>' + esc(t('activity.end')) + '</span></div>' +
    '<p class="activity-note">' + esc(t('activity.sample', { n: entries.length })) + '</p>';
}

function renderSnippets() {
  const remoteUrl = location.origin + "/mcp";
  const args = ["-y", "search-rotation"];
  const codex = $("#snip-codex");
  if (!codex) return;
  codex.textContent = '[mcp_servers.search-rotation]\ncommand = "npx"\nargs = ' + JSON.stringify(args);
  $("#snip-claude").textContent = JSON.stringify(
    { mcpServers: { "search-rotation": { command: "npx", args } } },
    null,
    2,
  );
  $("#snip-remote").textContent = "URL: " + remoteUrl + "\n" + "Authorization: Bearer <token>";
}

/* ---------- View: MCP tools ---------- */

function renderTools() {
  const tools = [
    { name: "search_web", icon: "search", params: [["query", "query"], ["numResults", "count"], ["engine", "engine"], ["timeRange", "timeRange"], ["startDate", "startDate"], ["endDate", "endDate"]], args: { query: "latest AI research", numResults: 5, timeRange: "week" } },
    { name: "fetch_url", icon: "link", params: [["url", "url"]], args: { url: "https://example.com" } },
    { name: "get_engine_status", icon: "gauge", params: [], args: {} },
    { name: "update_engine_config", icon: "grip", params: [["enabled", "enabled"], ["searchOrder", "searchOrder"], ["fetchOrder", "fetchOrder"], ["monthlyLimits", "monthlyLimits"], ["dailyLimits", "dailyLimits"]], args: { enabled: { duckduckgo: false }, searchOrder: ["tavily", "firecrawl", "parallel", "exa", "google-cse", "duckduckgo"] } },
    { name: "open_dashboard", icon: "stack", params: [], args: {} },
  ];
  $("#view").innerHTML = '<div class="page">' + pageHead(t("tools.title"), t("tools.sub")) +
    '<p class="tools-intro">' + esc(t("tools.intro")) + '</p><div class="tools-grid">' + tools.map(tool =>
      '<article class="panel tool-card"><div class="panel-head"><svg width="20" height="20" aria-hidden="true"><use href="#i-' + tool.icon + '"/></svg><h2><code>' + tool.name + '</code></h2></div>' +
      '<div class="tool-body"><p>' + esc(t("tools." + tool.name)) + '</p><h3>' + esc(t("tools.parameters")) + '</h3>' +
      (tool.params.length ? '<dl class="tool-params">' + tool.params.map(([name, key]) => '<dt><code>' + name + '</code></dt><dd>' + esc(t("tools.param." + key)) + '</dd>').join('') + '</dl>' : '<p class="muted">' + esc(t("tools.none")) + '</p>') +
      '<div class="tool-example"><h3>' + esc(t("tools.example")) + '</h3><pre id="tool-example-' + tool.name + '">' + esc(JSON.stringify({ name: tool.name, arguments: tool.args }, null, 2)) + '</pre>' +
      '<button class="btn" data-copy="tool-example-' + tool.name + '" aria-label="' + esc(t("tools.copy", { name: tool.name })) + '">' + esc(t("btn.copy")) + '</button></div></div></article>'
    ).join('') + '</div></div>';
}

/* ---------- View: Engines ---------- */

function settingsHtml() {
  const settings = state.config.settings;
  return '<div class="panel settings-panel"><h2>' + esc(t("settings.title")) + '</h2>' +
    '<label class="settings-check"><input id="strict-free" type="checkbox"' + (settings.strictFreeMode ? " checked" : "") + '> ' + esc(t("settings.strict")) + '</label>' +
    '<p class="muted">' + esc(t("settings.strictHelp")) + '</p>' +
    '<label for="request-timeout">' + esc(t("settings.timeout")) + '</label> ' +
    '<input id="request-timeout" type="number" min="1000" max="300000" step="1000" value="' + (settings.requestTimeoutMs ?? 60000) + '">' +
    '<div class="result-settings"><label for="result-count-mode">' + esc(t("settings.results")) + '</label> ' +
    '<select id="result-count-mode"><option value="custom"' + (settings.defaultNumResults !== null ? ' selected' : '') + '>' + esc(t("settings.resultsCustom")) + '</option><option value="provider"' + (settings.defaultNumResults === null ? ' selected' : '') + '>' + esc(t("settings.resultsProvider")) + '</option></select> ' +
    '<input id="result-count" aria-label="' + esc(t("settings.resultsCount")) + '" type="number" required min="1" max="20" step="1" value="' + (settings.defaultNumResults ?? 8) + '"' + (settings.defaultNumResults === null ? ' disabled hidden' : '') + '>' +
    '<p class="muted">' + esc(t("settings.resultsHelp")) + '</p></div>' +
    '<button class="btn" data-act="save-settings">' + esc(t("btn.save")) + '</button></div>';
}

function renderEngines() {
  const wrap = $("#view");
  // Ungespeicherte Eingaben über das Re-Render retten
  const saved = {};
  const strictDraft = wrap.querySelector("#strict-free")?.checked;
  const timeoutDraft = wrap.querySelector("#request-timeout")?.value;
  const resultsModeDraft = wrap.querySelector("#result-count-mode")?.value;
  const resultsCountDraft = wrap.querySelector("#result-count")?.value;
  wrap.querySelectorAll(".keyinput").forEach((el) => {
    if (el.value) saved["key:" + el.dataset.id] = el.value;
  });
  wrap.querySelectorAll(".extrainput").forEach((el) => {
    if (el.value) saved["extra:" + el.dataset.id + ":" + el.dataset.extra] = el.value;
  });

  const engines = sortedEngines();
  const inRotation = engines.filter((e) => e.enabled).length;
  const keys = engines.filter((e) => e.hasKey).length;

  const cards = engines
    .map((e) => {
      const open = state.openEngines.has(e.id);
      const caps = (e.capabilities || []).map((c) => '<span class="badge">' + esc(t("cap." + c)) + "</span>").join("");
      const extras = (e.extraFields || [])
        .map(
          (f) =>
            '<div class="drawer-row"><input type="text" class="extrainput" data-id="' + esc(e.id) + '" data-extra="' + esc(f.key) +
            '" placeholder="' + esc(f.label) + (e.extrasSet && e.extrasSet[f.key] ? " · " + esc(t("extra.set")) : "") + '">' +
            '<button class="btn" data-act="save-extra">' + esc(t("btn.save")) + "</button></div>",
        )
        .join("");
      return (
        '<div class="engine-card' + (e.enabled ? "" : " off") + (open ? " open" : "") + '" data-id="' + esc(e.id) + '">' +
        '<div class="engine-head">' +
        '<span class="handle" draggable="true" title="Drag & Drop"><svg width="16" height="16"><use href="#i-grip"/></svg></span>' +
        '<span class="pos-badge">' + (e.enabled ? e.searchPosition + 1 : "–") + "</span>" +
        engineLogoHtml(e) +
        '<span class="engine-title"><span class="engine-name">' + esc(e.label || e.id) + "</span>" +
        '<span class="engine-badges">' +
        (!e.hasKey && e.keyless === "ip" ? '<span class="badge ip">' + esc(t("badge.keyless")) + "</span>" : "") +
        (e.quotaEndpoint ? '<span class="badge quota">' + esc(t("badge.quota")) + "</span>" : "") +
        "</span></span>" +
        '<label class="switch"><input type="checkbox" aria-label="' + esc(e.label || e.id) + '" data-act="toggle"' + (e.enabled ? " checked" : "") + '><span class="track-el"></span></label>' +
        '<span class="engine-quota" data-quota="' + esc(e.id) + '">' + quotaHtml(e) + "</span>" +
        '<button class="drawer-toggle" data-act="drawer" aria-expanded="' + open + '" title="' + esc(open ? t("engines.collapse") : t("engines.config")) + '"><svg width="17" height="17"><use href="#i-chevron"/></svg></button>' +
        "</div>" +
        '<div class="drawer">' +
        '<div class="drawer-row">' +
        '<input type="password" class="keyinput" aria-label="' + esc((e.label || e.id) + ": " + t("key.set")) + '" data-id="' + esc(e.id) + '" placeholder="' +
        (e.hasKey ? esc(t("key.replace", { masked: e.keyMasked })) : esc(t("key.set"))) + '">' +
        '<button class="btn btn-primary" data-act="save-key">' + esc(t("btn.save")) + "</button>" +
        (e.hasKey ? '<button class="btn btn-danger" data-act="clear-key">' + esc(t("key.clear")) + "</button>" : "") +
        "</div>" +
        extras +
        '<div class="drawer-meta"><span class="caps-chips">' + caps + "</span>" +
        '<a class="signup" href="' + esc(e.signupUrl || e.homepage || "#") + '" target="_blank" rel="noreferrer">' + esc(t("signup")) + ' <svg width="12" height="12"><use href="#i-external"/></svg></a>' +
        (e.capabilities || []).map((kind) => '<button class="btn" data-act="test" data-kind="' + kind + '"><svg width="13" height="13"><use href="#i-zap"/></svg> Test: ' + esc(t("cap." + kind)) + "</button>").join("") + "</div>" +
        '<div class="testout" data-testout="' + esc(e.id) + '"></div>' +
        (e.notes ? '<div class="notes">' + esc(e.notes) + "</div>" : "") +
        "</div></div>"
      );
    })
    .join("");

  wrap.innerHTML =
    '<div class="page">' +
    pageHead(t("engines.title"), t("engines.sub")) +
    settingsHtml() +
    (anyKeySet() ? "" : '<div class="banner"><svg width="16" height="16"><use href="#i-alert"/></svg><span>' + esc(t("notice.nokeys")) + "</span></div>") +
    '<div style="margin-bottom:14px"><span class="engines-stat"><span class="dot"></span>' +
    esc(t("engines.stat", { in: inRotation, keys, total: engines.length })) +
    "</span></div>" +
    '<div class="engine-list">' + cards + "</div></div>";

  // Gesicherte Eingaben zurückschreiben
  if (strictDraft !== undefined) wrap.querySelector("#strict-free").checked = strictDraft;
  if (timeoutDraft !== undefined) wrap.querySelector("#request-timeout").value = timeoutDraft;
  if (resultsModeDraft !== undefined) {
    wrap.querySelector("#result-count-mode").value = resultsModeDraft;
    const field = wrap.querySelector("#result-count");
    field.value = resultsCountDraft;
    field.disabled = field.hidden = resultsModeDraft === "provider";
  }
  wrap.querySelectorAll(".keyinput").forEach((el) => {
    const v = saved["key:" + el.dataset.id];
    if (v) el.value = v;
  });
  wrap.querySelectorAll(".extrainput").forEach((el) => {
    const v = saved["extra:" + el.dataset.id + ":" + el.dataset.extra];
    if (v) el.value = v;
  });
}

/** Speichert eine Drag-Operation auf der zuletzt bestätigten Konfiguration. */
function queueReorder(from, to) {
  return queuePut((cfg) => {
    const engines = cfg.engines.map((e) => ({ id: e.id, enabled: e.enabled }));
    const i = engines.findIndex((e) => e.id === from);
    const j = engines.findIndex((e) => e.id === to);
    if (i >= 0 && j >= 0) engines.splice(j, 0, engines.splice(i, 1)[0]);
    return { engines, fetchOrder: cfg.fetchOrder };
  });
}

/* ---------- View: Verlauf ---------- */

function filteredHistory() {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  return state.history.filter((e) => {
    if (f.kind !== "all" && e.kind !== f.kind) return false;
    if (f.engine && e.engine !== f.engine && !(e.attempts || []).some(a => a.engine === f.engine)) return false;
    if (q) {
      const hay = (e.input + " " + (e.engine || "") + " " + (e.attempts || []).map((a) => a.engine).join(" ")).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function histListHtml(entries) {
  return entries
    .map((e) => {
      const key = e.ts;
      const failChips = (e.attempts || [])
        .filter((a) => !a.ok)
        .map((a) => '<span class="chip fail" title="' + esc(a.error || "") + '">' + esc(a.engine) + "</span>")
        .join("");
      const meta =
        e.ok && e.kind === "search" && e.result?.count !== undefined
          ? t("hist.results", { n: e.result.count })
          : e.ok && e.result?.chars !== undefined
            ? t("hist.chars", { n: e.result.chars })
            : "";

      let body = "";
      if (e.error) body += '<p class="error-text">' + esc(e.error) + "</p>";
      if ((e.attempts || []).length) {
        body +=
          "<p><strong>" + esc(t("hist.attempts")) + ":</strong></p><ul class='att'>" +
          e.attempts.map((a) => "<li>" + esc(a.engine) + " — " + (a.ok ? "✓" : "✗ " + esc(a.error || "")) + " (" + fmtMs(a.ms) + ")</li>").join("") +
          "</ul>";
      }
      if (e.result?.items?.length) {
        body +=
          "<p><strong>" + esc(t("hist.items")) + ":</strong></p><ul class='hitems'>" +
          e.result.items
            .map(
              (i) =>
                "<li><a href='" + esc(i.url) + "' target='_blank' rel='noreferrer'>" + esc(i.title || i.url) + "</a>" +
                (i.snippet ? "<div class='snip'>" + esc(i.snippet.slice(0, 200)) + "</div>" : "") + "</li>",
            )
            .join("") +
          "</ul>";
      }
      if (e.result?.markdown) {
        body += "<p><strong>" + esc(t("hist.markdown")) + ":</strong></p><pre>" + esc(e.result.markdown.slice(0, 2000)) + "</pre>";
      }

      return (
        '<details class="hist' + (e.ok ? "" : " fail") + '"' + (state.historyOpen.has(key) ? " open" : "") + ' data-key="' + esc(key) + '">' +
        "<summary>" +
        '<span class="hkind-icon ' + esc(e.kind) + '"><svg width="14" height="14"><use href="#i-' + (e.kind === "search" ? "search" : "link") + '"/></svg></span>' +
        '<time class="htime" datetime="' + esc(e.ts) + '" title="' + esc(new Date(e.ts).toLocaleString(lang)) + '">' + new Date(e.ts).toLocaleTimeString(lang, { hour12: false }) + '</time>' +
        '<span class="hinput" title="' + esc(e.input) + '">' + esc(e.input) + "</span>" +
        '<span class="chips">' + (e.engine ? '<span class="chip ok">' + esc(e.engine) + "</span>" : "") + failChips + "</span>" +
        '<span class="hmeta">' +
        (e.ok ? esc(meta) + " · " + fmtMs(e.ms) : '<span class="fail-mark">' + esc(t("hist.failed")) + "</span> · " + fmtMs(e.ms)) +
        "</span>" +
        '<svg class="chev" width="15" height="15"><use href="#i-chevron"/></svg>' +
        "</summary>" +
        (body ? '<div class="histbody">' + body + "</div>" : "") +
        "</details>"
      );
    })
    .join("");
}

function bindHistToggles() {
  document.querySelectorAll(".hist").forEach((det) => {
    det.addEventListener("toggle", () => {
      const k = det.dataset.key;
      if (det.open) state.historyOpen.add(k);
      else state.historyOpen.delete(k);
    });
  });
}

/** Engine-Filter als Custom-Dropdown — native <select>-Popups folgen nicht dem
 *  Seiten-Theme (helle System-Popups mit heller Schrift = unlesbar im Dark). */
function engineDropdownHtml(selected) {
  const engines = sortedEngines();
  const cur = engines.find((e) => e.id === selected);
  const label = selected && cur ? cur.label || cur.id : t("hist.filter.all");
  const items =
    '<button role="menuitem" data-engine="" class="' + (!selected ? "active" : "") + '">' + esc(t("hist.filter.all")) +
    '<svg class="mi-check" width="14" height="14"><use href="#i-check"/></svg></button>' +
    engines
      .map(
        (e) =>
          '<button role="menuitem" data-engine="' + esc(e.id) + '" class="' + (selected === e.id ? "active" : "") + '">' +
          esc(e.label || e.id) + '<svg class="mi-check" width="14" height="14"><use href="#i-check"/></svg></button>',
      )
      .join("");
  return (
    '<div class="dropdown" id="engine-dd">' +
    '<button class="btn" id="engine-dd-btn" aria-haspopup="menu" aria-expanded="false">' +
    '<svg width="13" height="13"><use href="#i-stack"/></svg><span id="engine-dd-label">' + esc(label) + "</span>" +
    '<svg class="chev" width="13" height="13"><use href="#i-chevron"/></svg></button>' +
    '<div class="menu menu-left" id="engine-dd-menu" role="menu" hidden>' + items + "</div></div>"
  );
}

function historyEmptyHtml() {
  return '<div class="empty"><span class="empty-title">' + esc(t(state.history.length ? "history.noMatches" : "history.empty")) + "</span></div>";
}

function renderHistory() {
  const f = state.filters;
  const entries = filteredHistory();
  const fails = entries.filter((e) => !e.ok).length;

  $("#view").innerHTML =
    '<div class="page">' +
    pageHead(t("history.title"), t("history.sub")) +
    '<div class="hist-toolbar">' +
    '<div class="seg" role="tablist">' +
    segBtn("all", t("hist.filter.all")) +
    segBtn("search", t("hist.filter.search")) +
    segBtn("fetch", t("hist.filter.fetch")) +
    "</div>" +
    engineDropdownHtml(f.engine) +
    '<input type="text" id="hist-q" placeholder="' + esc(t("hist.search.ph")) + '" value="' + esc(f.q) + '">' +
    '<span class="spacer"></span>' +
    '<span class="live-dot' + (state.livePaused ? " paused" : "") + '" id="live-dot"><span class="pulse"></span></span>' +
    '<button class="btn" data-act="live-toggle">' + esc(state.livePaused ? t("hist.resume") : t("hist.pause")) + "</button>" +
    '<button class="btn btn-danger" data-act="hist-clear"><svg width="13" height="13"><use href="#i-trash"/></svg> ' + esc(t("history.clear")) + "</button>" +
    "</div>" +
    '<p class="hist-summary">' + esc(t("hist.shown", { n: entries.length, f: fails })) + "</p>" +
    '<div class="hist-list">' + (entries.length ? histListHtml(entries) : historyEmptyHtml()) + "</div>" +
    "</div>";

  bindHistToggles();

  const qInput = $("#hist-q");
  qInput.addEventListener("input", () => {
    state.filters.q = qInput.value;
    clearTimeout(qInput.__t);
    qInput.__t = setTimeout(updateHistory, 220);
  });

  const ddBtn = $("#engine-dd-btn");
  const ddMenu = $("#engine-dd-menu");
  ddBtn.addEventListener("click", () => {
    const open = !ddMenu.hidden;
    ddMenu.hidden = open;
    ddBtn.setAttribute("aria-expanded", String(!open));
  });
  ddMenu.addEventListener("click", (ev) => {
    const item = ev.target.closest("[data-engine]");
    if (!item) return;
    state.filters.engine = item.dataset.engine;
    $("#engine-dd-label").textContent = item.textContent.trim();
    ddMenu.hidden = true;
    ddBtn.setAttribute("aria-expanded", "false");
    ddMenu.querySelectorAll("[data-engine]").forEach((b) => b.classList.toggle("active", b.dataset.engine === state.filters.engine));
    updateHistory();
  });
}

/** Patcht nur Liste + Zusammenfassung — Toolbar und Fokus im Filterfeld bleiben unangetastet. */
function updateHistory() {
  const root = $("#view");
  const list = root.querySelector(".hist-list");
  if (!list) {
    // Übergang vom Empty-State zu ersten Einträgen → einmal voll rendern
    if (filteredHistory().length && root.querySelector(".empty")) renderHistory();
    return;
  }
  const entries = filteredHistory();
  const fails = entries.filter((e) => !e.ok).length;
  const summary = root.querySelector(".hist-summary");
  if (summary) summary.textContent = t("hist.shown", { n: entries.length, f: fails });
  list.innerHTML = entries.length ? histListHtml(entries) : historyEmptyHtml();
  bindHistToggles();
}

function segBtn(kind, label) {
  return '<button data-kind="' + kind + '"' + (state.filters.kind === kind ? ' class="active"' : "") + ">" + esc(label) + "</button>";
}

/* ---------- Drag & Drop (delegiert, einmalig) ---------- */

document.addEventListener("dragstart", (ev) => {
  const card = ev.target.closest?.(".engine-card");
  if (!card) return;
  if (!ev.target.closest(".handle")) {
    // Drag nur am Griff starten — Inputs/Buttons bleiben normal nutzbar
    ev.preventDefault();
    return;
  }
  state.dragFrom = card.dataset.id;
  card.classList.add("dragging");
  ev.dataTransfer.effectAllowed = "move";
  try {
    ev.dataTransfer.setData("text/plain", card.dataset.id);
  } catch {}
});

document.addEventListener("dragend", (ev) => {
  const card = ev.target.closest?.(".engine-card");
  if (card) card.classList.remove("dragging");
  document.querySelectorAll(".drag-over").forEach((x) => x.classList.remove("drag-over"));
});

document.addEventListener("dragover", (ev) => {
  const card = ev.target.closest?.(".engine-card");
  if (!card || !state.dragFrom) return;
  ev.preventDefault();
  document.querySelectorAll(".drag-over").forEach((x) => x.classList.remove("drag-over"));
  card.classList.add("drag-over");
});

document.addEventListener("drop", (ev) => {
  const toEl = ev.target.closest?.(".engine-card");
  const from = state.dragFrom;
  state.dragFrom = null;
  document.querySelectorAll(".drag-over").forEach((x) => x.classList.remove("drag-over"));
  ev.preventDefault();
  if (!toEl || !from || from === toEl.dataset.id || state.route !== "/engines") return;
  const container = $(".engine-list");
  if (!container) return;
  queueReorder(from, toEl.dataset.id);
});

/* ---------- Events (delegiert) ---------- */

document.addEventListener("change", (ev) => {
  if (!ev.target.matches || !ev.target.matches('input[data-act="toggle"]')) return;
  const id = ev.target.closest("[data-id]").dataset.id;
  const enabled = ev.target.checked;
  queuePut((cfg) => ({
    engines: cfg.engines.map((e) => (e.id === id ? { id, enabled } : { id: e.id, enabled: e.enabled })),
    fetchOrder: cfg.fetchOrder,
    settings: { port: cfg.settings.port },
  }));
});

document.addEventListener("click", async (ev) => {
  if (ev.target.closest('[data-act="save-settings"]')) {
    const timeoutInput = $("#request-timeout");
    if (!timeoutInput.checkValidity()) { timeoutInput.reportValidity(); return; }
    const providerDefault = $("#result-count-mode").value === "provider";
    const countInput = $("#result-count");
    if (!providerDefault && !countInput.checkValidity()) { countInput.reportValidity(); return; }
    const defaultNumResults = providerDefault ? null : Number(countInput.value);
    const strictFreeMode = $("#strict-free").checked;
    const requestTimeoutMs = Number(timeoutInput.value);
    await queuePut((cfg) => ({
      engines: cfg.engines.map((e) => ({ id: e.id, enabled: e.enabled })),
      settings: { strictFreeMode, requestTimeoutMs, defaultNumResults },
    }));
    return;
  }

  // Kopieren-Buttons
  const copyBtn = ev.target.closest("button[data-copy]");
  if (copyBtn) {
    navigator.clipboard.writeText(document.getElementById(copyBtn.dataset.copy).textContent);
    copyBtn.textContent = t("btn.copied");
    toast("info", t("toast.copied"));
    setTimeout(() => (copyBtn.textContent = t("btn.copy")), 1500);
    return;
  }

  // Verlauf löschen
  const clearBtn = ev.target.closest('[data-act="hist-clear"]');
  if (clearBtn) {
    if (confirm(t("history.confirm"))) {
      try {
        await api("/api/history", { method: "DELETE" });
        state.historyOpen.clear();
        state.history = [];
        renderHistory();
        toast("ok", t("toast.saved"));
      } catch (err) {
        if (err.message !== "unauthorized") toast("error", t("toast.error", { msg: err.message }));
      }
    }
    return;
  }

  // Live pausieren/fortsetzen
  if (ev.target.closest('[data-act="live-toggle"]')) {
    state.livePaused = !state.livePaused;
    renderHistory();
    return;
  }

  // Segment-Filter
  const seg = ev.target.closest(".seg [data-kind]");
  if (seg) {
    state.filters.kind = seg.dataset.kind;
    renderHistory();
    return;
  }

  // Drawer auf/zu
  const drawerBtn = ev.target.closest('[data-act="drawer"]');
  if (drawerBtn) {
    const id = drawerBtn.closest("[data-id]").dataset.id;
    if (state.openEngines.has(id)) state.openEngines.delete(id);
    else state.openEngines.add(id);
    renderEngines();
    return;
  }

  // Engine-Aktionen
  const btn = ev.target.closest("button[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  if (!["save-key", "clear-key", "save-extra", "test"].includes(act)) return;
  const host = btn.closest("[data-id]");
  if (!host) return;
  const id = host.dataset.id;

  try {
    if (act === "save-key") {
      const value = host.querySelector(".keyinput").value;
      queuePut((cfg) => ({
        engines: cfg.engines.map((e) => (e.id === id ? { id, enabled: e.enabled, apiKey: value } : { id: e.id, enabled: e.enabled })),
        fetchOrder: cfg.fetchOrder,
        settings: { port: cfg.settings.port },
      }));
    } else if (act === "clear-key") {
      queuePut((cfg) => ({
        engines: cfg.engines.map((e) => (e.id === id ? { id, enabled: e.enabled, apiKey: null } : { id: e.id, enabled: e.enabled })),
        fetchOrder: cfg.fetchOrder,
        settings: { port: cfg.settings.port },
      }));
    } else if (act === "save-extra") {
      const input = host.querySelector('.extrainput[data-extra="' + CSS.escape(btn.closest(".drawer-row").querySelector(".extrainput").dataset.extra) + '"]');
      const key = input.dataset.extra;
      const value = input.value.trim();
      queuePut((cfg) => ({
        engines: cfg.engines.map((e) =>
          e.id === id ? { id, enabled: e.enabled, extra: { [key]: value || null } } : { id: e.id, enabled: e.enabled },
        ),
        fetchOrder: cfg.fetchOrder,
        settings: { port: cfg.settings.port },
      }));
    } else if (act === "test") {
      const out = document.querySelector('[data-testout="' + CSS.escape(id) + '"]');
      out.innerHTML = '<span class="muted">' + esc(t("test.running")) + "</span>";
      const capabilities = statusOf(id).capabilities || [];
      const kind = capabilities.includes(btn.dataset.kind) ? btn.dataset.kind : capabilities[0];
      if (!kind) throw new Error("Keine testbare Fähigkeit");
      const r = await api("/api/test", { method: "POST", body: { id, kind } });
      if (r.ok) {
        out.innerHTML =
          '<span class="ok">✓ ' + esc(kind === "fetch" ? t("test.fetchOk", { chars: r.chars, ms: fmtMs(r.ms) }) : t("test.ok", { count: r.count, ms: fmtMs(r.ms) })) + "</span>" +
          (r.preview ? "<pre>" + esc(r.preview) + "</pre>" : "");
      } else {
        out.innerHTML = '<span class="error">✗ ' + esc(r.error) + "</span>";
      }
    }
  } catch (err) {
    if (err.message !== "unauthorized") toast("error", t("toast.error", { msg: err.message }));
  }
});

/* ---------- Sprach-Dropdown & Theme-Button ---------- */

const langBtn = $("#lang-btn");
const langMenu = $("#lang-menu");

langBtn.addEventListener("click", (ev) => {
  ev.stopPropagation();
  const open = !langMenu.hidden;
  langMenu.hidden = open;
  langBtn.setAttribute("aria-expanded", String(!open));
});

langMenu.addEventListener("click", (ev) => {
  const item = ev.target.closest("[data-lang]");
  if (!item) return;
  lang = item.dataset.lang;
  localStorage.setItem("sr_lang", lang);
  langMenu.hidden = true;
  langBtn.setAttribute("aria-expanded", "false");
  applyI18n();
  setTheme(document.documentElement.dataset.theme, false);
  render();
  if (state.route === "/history" || state.route === "/") loadHistory().then(render).catch(() => {});
});

document.addEventListener("click", (ev) => {
  if (!langMenu.hidden && !ev.target.closest("#lang")) {
    langMenu.hidden = true;
    langBtn.setAttribute("aria-expanded", "false");
  }
  const engMenu = $("#engine-dd-menu");
  if (engMenu && !engMenu.hidden && !ev.target.closest("#engine-dd")) {
    engMenu.hidden = true;
    $("#engine-dd-btn")?.setAttribute("aria-expanded", "false");
  }
});

document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  if (!langMenu.hidden) {
    langMenu.hidden = true;
    langBtn.setAttribute("aria-expanded", "false");
  }
  const engMenu = $("#engine-dd-menu");
  if (engMenu && !engMenu.hidden) {
    engMenu.hidden = true;
    $("#engine-dd-btn")?.setAttribute("aria-expanded", "false");
  }
});

$("#theme-btn").addEventListener("click", () => {
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});

/* ---------- Polling ---------- */

/* ---------- Polling (gezielte Teil-Updates, kein Voll-Render) ---------- */

let lastHistorySig = "";
function historySig() {
  const h = state.history;
  // Minuten-Bucket: relative Zeiten ("vor 1 Stunde") bleiben ohne Flackern frisch
  return h.length + ":" + (h[0] ? h[0].ts : "") + ":" + Math.floor(Date.now() / 60000);
}

let lastStatusSig = "";
function statusSig() {
  return JSON.stringify([state.meta?.month, state.status.map(s => [s.id, s.enabled, s.searchPosition, s.capabilities, s.used, s.quota, s.remoteError])]);
}

setInterval(() => {
  if (document.hidden || state.unauthorized || state.livePaused) return;
  if (state.route !== "/history" && state.route !== "/") return;
  loadHistory()
    .then(() => {
      const sig = historySig();
      if (sig === lastHistorySig) return; // nichts Neues → kein DOM-Write, kein Flackern
      lastHistorySig = sig;
      if (state.route === "/history") updateHistory();
      else if (state.route === "/") updateOverview();
    })
    .catch(() => {});
}, 5000);

setInterval(async () => {
  if (document.hidden || state.unauthorized) return;
  try {
    await refreshStatus();
  } catch {
    return;
  }
  if (state.route === "/engines") {
    // Quota-Zeilen gezielt aktualisieren — keine Inputs/Drawer zerstören
    for (const st of state.status) {
      document.querySelectorAll('[data-quota="' + CSS.escape(st.id) + '"]').forEach((el) => {
        el.innerHTML = quotaHtml(st);
      });
    }
  } else if (state.route === "/") {
    const sig = statusSig();
    if (sig === lastStatusSig) return;
    lastStatusSig = sig;
    updateOverview();
  }
}, 30000);

window.addEventListener("resize", positionNavInd);
window.addEventListener("hashchange", () => setRoute(parseHash()));

/* Favicon-Load-Fehler → farbiger Buchstaben-Avatar (Capture-Phase: "error" bubblt nicht) */
document.addEventListener(
  "error",
  (ev) => {
    const img = ev.target;
    if (!img || !img.matches || !img.matches("img.logo")) return;
    const hue = Number(img.dataset.hue) || 210;
    const span = document.createElement("span");
    span.className = "avatar";
    span.style.cssText =
      "background:linear-gradient(135deg,hsl(" + hue + " 62% 52%),hsl(" + ((hue + 28) % 360) + " 68% 40%))";
    span.textContent = img.dataset.fallback || "?";
    const wrap = img.closest(".logo-wrap");
    if (wrap) wrap.replaceWith(span);
    else img.remove();
  },
  true,
);

/* ---------- Boot ---------- */

initTheme();
applyI18n();
setRoute(parseHash());
load().catch((e) => {
  if (e.message !== "unauthorized") toast("error", t("toast.error", { msg: e.message }));
});

// Keep the numeric input out of the provider-default mode.
document.addEventListener("change", ev => {
  if (ev.target.id !== "result-count-mode") return;
  const field = $("#result-count");
  field.disabled = field.hidden = ev.target.value === "provider";
});
