"use strict";
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);

/* On macOS the menu bar carries the ⌘ shortcuts and the window is vibrant,
   with an overlaid title bar; elsewhere, a classic window. */
const IS_MAC = /Macintosh|Mac OS X/.test(navigator.userAgent);
document.documentElement.classList.toggle("mac", IS_MAC);

/* Settings carried over from the former "3MF Studio" (trimf.* keys). The
   WebKit storage itself was copied by Rust at startup. */
for (const [o, n] of [["trimf", "snapstudio"], ["trimf.slice", "snapstudio.slice"], ["trimf.libtabs", "snapstudio.libtabs"]]) {
  if (localStorage.getItem(n) === null && localStorage.getItem(o) !== null) {
    localStorage.setItem(n, localStorage.getItem(o));
    localStorage.removeItem(o);
  }
}

/* ------------------------------------------------------------------ state */

const DEFAULTS = {
  view: "grid",
  sort: "name",
  asc: true,
  tile: 220,
  pref: 0,
  recursive: false,
  detailsWidth: 340,
  invertWheel: false,
  wheelAction: "zoom",
  wheelSpeed: 1,
  dir: null,
  recents: [],
  /* How the AI is used: "container" (the Sandbox side), "local", "both",
     "off"; null until asked. */
  aiModes: null,
  /* Which sandbox the Sandbox side uses: "builtin" (Claude Code's own) or
     "yolobox"; null until decided once (ai-logic.js aiSandboxDefault). */
  aiSandbox: null,
  /* The slice sheet's level, "basic" or "advanced"; null until first set
     (slice-adv.js, sliceLevelDefault). */
  sliceLevel: null,
};

/* A stored value, or {} when there is none or it is unreadable: a corrupt
   entry must not stop the script, and the whole app with it. */
function storedObject(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const state = {
  ...DEFAULTS,
  ...storedObject("snapstudio"),
  files: [],
  meta: new Map(),
  analysis: new Map(),
  view_files: [],
  sel: new Set(),
  anchor: -1,
  rendered: 0,
  nodes: new Map(),
  scanning: false,
};

function save() {
  const { view, sort, asc, tile, pref, recursive, detailsWidth, invertWheel, wheelAction, wheelSpeed, dir, recents, aiModes, aiSandbox, sliceLevel } = state;
  localStorage.setItem(
    "snapstudio",
    JSON.stringify({ view, sort, asc, tile, pref, recursive, detailsWidth, invertWheel, wheelAction, wheelSpeed, dir, recents, aiModes, aiSandbox, sliceLevel })
  );
}

/* ------------------------------------------------------------ formatting */

/* Sizes in 1024 steps, units from the catalog ("B KB MB…" / "o Ko Mo…"). */
const fmtSize = (b) => {
  const u = tr("units.size").split(" ");
  if (b < 1024) return `${b} ${u[0]}`;
  let v = b / 1024, i = 1;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v < 10 ? fmtDec(v, 1) : fmtNum(Math.round(v))) + " " + u[i];
};

const fmtDuration = (s) => {
  if (s == null) return null;
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h > 0
    ? tr("units.hm", { h, m: String(m).padStart(2, "0") })
    : tr("units.min", { m: Math.max(m, 1) });
};

const fmtWeight = (g) => (g == null ? null : `${g < 10 ? fmtDec(g, 1) : fmtNum(Math.round(g))} g`);

/* Time of day; the date is added when it is not today. */
function fmtClock(ms) {
  const d = new Date(ms);
  const hm = d.toLocaleTimeString(locale(), { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${d.toLocaleDateString(locale(), { weekday: "short", day: "numeric" })} ${hm}`;
}
const fmtDate = (secs) =>
  new Date(secs * 1000).toLocaleString(locale(), { dateStyle: "short", timeStyle: "short" });

/* ------------------------------------------------------------ thumbnails */

const SIZES = [192, 256, 320, 448, 640, 896];
const bucket = (n) => SIZES.find((s) => s >= n) ?? SIZES[SIZES.length - 1];

function thumbUrl(f, px) {
  const s = bucket(Math.round(px * Math.min(window.devicePixelRatio || 1, 2)));
  return thumbSrc(f.path, s, state.pref, f.modified);
}

/* ------------------------------------------------------------------ theme */

/* Light or dark, theme and accent: themes.js (loaded in <head>) resolves
   them, exposes isDark() and fires "themechange"; surfaces drawn outside
   CSS (WebGL, terminal) listen to it and read the tokens. */

/* ------------------------------------------------------- native menus */

/* Menus are built by Rust; each entry carries a "verb:argument" id that
   comes back through the "menu" event. An entry without an id is a
   separator; "checked" makes it a checkable entry. */
const MENU = {};
const onMenu = (verb, fn) => (MENU[verb] = fn);
listen("menu", (e) => {
  const id = String(e.payload);
  const i = id.indexOf(":");
  const fn = MENU[i < 0 ? id : id.slice(0, i)];
  if (fn) fn(i < 0 ? "" : id.slice(i + 1));
});
function nativeMenu(items, x, y) {
  return invoke("popup_menu", { items, x, y }).catch((e) => toast(String(e), true));
}
/* Every deletion is confirmed by a native alert (NSAlert). */
function confirmDelete(title, message, okLabel = tr("common.delete")) {
  return window.__TAURI__.dialog.ask(message, {
    title,
    kind: "warning",
    okLabel,
    cancelLabel: tr("common.cancel"),
  });
}

/* A print the printer started without some of its options: said in a
   dialog to acknowledge, not in a passing toast. */
function startWarning(message) {
  return window.__TAURI__.dialog.message(message, { title: tr("send.options_unapplied.title"), kind: "error" }).catch(() => toast(message, true));
}

/* No browser context menu, except in text fields. */
document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest("input, textarea, [contenteditable]")) e.preventDefault();
});

/* Menu opened under a toolbar button. */
function menuUnder(el, items) {
  const r = el.getBoundingClientRect();
  return nativeMenu(items, r.left, r.bottom + 4);
}

/* ------------------------------------------------------- shared toolbar */

/* Each view declares its title and subtitle; only the visible view shows
   them. Its controls live in a .tb-actions[data-for] slot. */
const TB = {};
/* Simulated printers, in a development build running them: the badge's
   label comes with the list (window.SIM, set by that build), none in here. */
const simOf = (id) => !!window.SIM?.on && !!window.SIM.printers?.includes(id);
const simBadge = (id) => (simOf(id) ? `<span class="sim-badge">${esc(window.SIM.label)}</span>` : "");

function tbSet(view, title, sub = "") {
  TB[view] = { title, sub };
  if ((window.currentView || "files") === view) tbRender();
}
function tbRender() {
  const v = window.currentView || "files";
  const t = TB[v] || { title: "", sub: "" };
  $("tb-title").textContent = t.title;
  $("tb-sub").textContent = t.sub;
  // `data-for` may name several views ("library snapmaker": the same tabs).
  document.querySelectorAll(".tb-actions").forEach((el) => el.classList.toggle("on", el.dataset.for.split(" ").includes(v)));
}

/* ------------------------------------------------------------- sidebar */

const SIDE_FOLDER = '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const baseName = (p) => p.split("/").filter(Boolean).pop() || p;

function sideCount(view, n) {
  const el = $("count-" + view);
  if (el) el.textContent = n ? String(n) : "";
}

function renderRecents() {
  const box = $("side-recents");
  box.innerHTML = "";
  for (const d of state.recents) {
    const b = document.createElement("button");
    b.className = "side-item";
    b.dataset.dir = d;
    b.title = d;
    b.innerHTML = `<span class="glyph" style="color: #32ADE6">${SIDE_FOLDER}</span><span class="lbl">${esc(baseName(d))}</span><span class="count"></span>`;
    b.onclick = () => {
      switchView("files");
      if (d !== state.dir) openDir(d);
    };
    b.oncontextmenu = (e) =>
      nativeMenu([
        { id: "recent:reveal:" + d, label: tr("menu.file.reveal") },
        {},
        { id: "recent:forget:" + d, label: tr("files.forget_recent") },
      ], e.clientX, e.clientY);
    box.appendChild(b);
  }
  sideSync();
}

onMenu("recent", (arg) => {
  const i = arg.indexOf(":");
  const what = arg.slice(0, i), dir = arg.slice(i + 1);
  if (what === "reveal") invoke("reveal", { path: dir }).catch((e) => toast(String(e), true));
  if (what === "forget") {
    state.recents = state.recents.filter((d) => d !== dir);
    save();
    renderRecents();
  }
});

/* A single selection in the sidebar, as in the Finder: the open folder, the
   printer shown, otherwise the view's entry. */
function sideSync() {
  const v = window.currentView || "files";
  let target = null;
  if (v === "files" && state.dir) target = document.querySelector(`#side-recents [data-dir="${CSS.escape(state.dir)}"]`);
  if (v === "printers" && typeof P !== "undefined" && P.sel) target = document.querySelector(`#side-printers [data-id="${CSS.escape(P.sel)}"]`);
  if (v === "heads" && typeof HV !== "undefined" && HV.pid) target = document.querySelector(`#side-printers [data-heads="${CSS.escape(HV.pid)}"]`);
  if (v === "pfiles" && typeof PFL !== "undefined" && PFL.pid) target = document.querySelector(`#side-printers [data-pfiles="${CSS.escape(PFL.pid)}"]`);
  if (v === "maint" && typeof MT !== "undefined" && MT.pid) target = document.querySelector(`#side-printers [data-maint="${CSS.escape(MT.pid)}"]`);
  if (v === "ia" && typeof IA !== "undefined" && IA.open) target = document.querySelector(`#side-ia [data-conv="${CSS.escape(IA.open)}"]`);
  if (v === "prints" && typeof PJ !== "undefined" && PJ.sel) {
    target = document.querySelector(`#side-prints [data-pj="${CSS.escape(PJ.sel)}"]`);
    // A running print started by Snap Studio: its "live" entry.
    if (!target && PJ.sel.startsWith("job:")) {
      const j = PJ.jobs.find((x) => "job:" + x.id === PJ.sel);
      if (j?.state === "printing") target = document.querySelector(`#side-prints [data-pj="live:${CSS.escape(j.printer_id)}"]`);
    }
  }
  if (v === "library" && typeof LIB !== "undefined") {
    if (LIB.active === "favs") target = $("side-favs");
    // A site's tab lights its pinned entry (Snapmaker Space is always there).
    const t = LIB.tabs.find((x) => x.id === LIB.active);
    if (t) target = document.querySelector(`.sidebar .side-item[data-site="${CSS.escape(t.site)}"]`);
  }
  if (!target) target = document.querySelector(`.sidebar .side-item[data-view="${v}"]`);
  document.querySelectorAll(".sidebar .side-item").forEach((el) => el.classList.toggle("on", el === target));
  // The open folder's count shows on its entry.
  document.querySelectorAll("#side-recents .count").forEach((c) => (c.textContent = ""));
  if (v === "files" && target && target.dataset.dir) {
    target.querySelector(".count").textContent = state.dir ? String(state.files.length || "") : "";
  }
}

/* The selection turns grey when the window loses focus. We listen to the
   native window: the document also loses focus when clicking into a Library
   page, which lives in another view of the same window. */
const setInactive = (off) => $("sidebar").classList.toggle("inactive", off);
const tauriWin = window.__TAURI__.window?.getCurrentWindow?.();
if (tauriWin) tauriWin.onFocusChanged(({ payload }) => setInactive(!payload));
else {
  window.addEventListener("blur", () => setInactive(true));
  window.addEventListener("focus", () => setInactive(false));
}

/* ------------------------------------------------------------------ sheets */

/* AppKit-style modal sheets: they slide down from the title bar. Clicking
   the backdrop = Cancel; the first field takes focus. */
function openSheet(el) {
  el.classList.remove("closing", "hidden");
  requestAnimationFrame(() => {
    const f = el.querySelector("input:not([type=range]):not([type=checkbox]), textarea, select");
    if (f) f.focus();
  });
}
function closeSheet(el) {
  if (el.classList.contains("hidden") || el.classList.contains("closing")) return;
  el.classList.add("closing");
  setTimeout(() => {
    if (!el.classList.contains("closing")) return;
    el.classList.remove("closing");
    el.classList.add("hidden");
  }, 150);
}
document.querySelectorAll(".modal").forEach((m) =>
  m.addEventListener("mousedown", (e) => {
    if (e.target !== m) return;
    const cancel = m.querySelector("[data-cancel]");
    if (cancel && !cancel.classList.contains("hidden")) cancel.click();
  })
);

/* ------------------------------------------------------------------ toasts */

const TOAST_OK = '<svg class="ok" viewBox="0 0 24 24"><path d="M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7z"/></svg>';
const TOAST_KO = '<svg class="ko" viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m1 15h-2v-2h2zm0-4h-2V7h2z"/></svg>';

/* Capsule at the bottom of the window, never a button; 2.6 s, 5 s for an error. */
/* `action`: { label, run } — a button in the toast (Undo…), which then
   stays longer. */
function toast(msg, err = false, action = null) {
  const el = document.createElement("div");
  el.className = "toast" + (err ? " err" : "");
  el.innerHTML = err ? TOAST_KO : TOAST_OK;
  const span = document.createElement("span");
  span.textContent = msg;
  el.appendChild(span);
  const close = () => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 180);
  };
  if (action) {
    const b = document.createElement("button");
    b.className = "toast-act";
    b.textContent = action.label;
    b.onclick = () => {
      close();
      action.run();
    };
    el.appendChild(b);
  }
  $("toasts").appendChild(el);
  setTimeout(close, err || action ? 5000 : 2600);
}

/* ----------------------------------------------------------------- folder */

async function pickFolder() {
  const dir = await invoke("pick_folder");
  if (dir) openDir(dir);
}

async function openDir(dir) {
  state.dir = dir;
  // A folder already listed keeps its place in the sidebar; only a newcomer
  // goes to the top (the oldest drops out when the list is full).
  if (!state.recents.includes(dir)) state.recents = [dir, ...state.recents].slice(0, 8);
  save();
  renderRecents();
  updateStatus();
  await refresh();
}

async function refresh() {
  if (!state.dir) return;
  state.scanning = true;
  setSel([]);
  state.meta.clear();
  state.analysis.clear();
  $("empty").classList.add("hidden");
  $("loading").classList.remove("hidden");
  $("items").innerHTML = "";
  try {
    state.files = await invoke("scan_folder", { dir: state.dir, recursive: state.recursive });
  } catch (e) {
    state.files = [];
    toast(String(e), true);
  }
  state.scanning = false;
  $("loading").classList.add("hidden");
  applyView();
  updateDetails();
  loadMetas();
}

/* Metadata arrives in batches so as not to block rendering. */
async function loadMetas() {
  const token = (loadMetas.token = Symbol());
  const paths = state.files.map((f) => f.path);
  for (let i = 0; i < paths.length; i += 60) {
    const chunk = paths.slice(i, i + 60);
    let metas;
    try {
      metas = await invoke("read_metas", { paths: chunk });
    } catch {
      return;
    }
    if (token !== loadMetas.token) return;
    for (const m of metas) state.meta.set(m.path, m);
    for (const p of chunk) patchNode(p);
    if (state.sort === "time" || state.sort === "weight") applyView();
    if (state.sel.size === 1 && chunk.includes([...state.sel][0])) updateDetails();
    updateStatus();
  }
}

/* ---------------------------------------------------- sorting, filtering */

function subtitle(f) {
  const m = state.meta.get(f.path);
  const bits = [];
  const d = fmtDuration(m?.print_time_s);
  if (d) bits.push(d);
  const w = fmtWeight(m?.weight_g);
  if (w) bits.push(w);
  if (!bits.length) bits.push(fmtSize(f.size));
  return bits;
}

function applyView() {
  const q = $("search").value.trim().toLowerCase();
  let list = state.files;
  if (q) {
    const terms = q.split(/\s+/);
    list = list.filter((f) => {
      const m = state.meta.get(f.path);
      const hay = (
        f.name + " " + f.rel + " " + (m?.title || "") + " " + (m?.designer || "") +
        " " + (m?.objects || []).join(" ")
      ).toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }

  const dir = state.asc ? 1 : -1;
  const byName = (a, b) => collate(a.name, b.name);
  const num = (v) => (v == null ? null : v);
  const cmpNullable = (av, bv, a, b) => {
    if (av == null && bv == null) return byName(a, b);
    if (av == null) return 1;   // no value: always last
    if (bv == null) return -1;
    return (av - bv) * dir || byName(a, b);
  };

  list = [...list].sort((a, b) => {
    switch (state.sort) {
      case "date": return (a.modified - b.modified) * dir || byName(a, b);
      case "size": return (a.size - b.size) * dir || byName(a, b);
      case "time": return cmpNullable(num(state.meta.get(a.path)?.print_time_s), num(state.meta.get(b.path)?.print_time_s), a, b);
      case "weight": return cmpNullable(num(state.meta.get(a.path)?.weight_g), num(state.meta.get(b.path)?.weight_g), a, b);
      case "folder": return collate(a.rel, b.rel) * dir || byName(a, b);
      default: return byName(a, b) * dir;
    }
  });

  state.view_files = list;
  renderReset();
  updateStatus();
}

/* ---------------------------------------------------------------- render */

const BATCH = 100;

function renderReset() {
  const items = $("items");
  items.innerHTML = "";
  state.nodes.clear();
  state.rendered = 0;
  items.className = state.view === "grid" ? "grid" : "items-list";
  $("listhead").classList.toggle("hidden", state.view !== "list" || !state.view_files.length);
  const nothing = !state.view_files.length && !state.scanning && state.dir;
  $("noresult").classList.toggle("hidden", !nothing);
  if (nothing) {
    $("noresult").querySelector("p").textContent = state.files.length
      ? tr("files.no_match")
      : tr("files.no_file") + (state.recursive ? "" : " " + tr("files.no_file.recursive"));
  }
  $("empty").classList.toggle("hidden", !!state.dir);
  document.documentElement.style.setProperty("--tile", state.tile + "px");
  renderMore();
}

function renderMore() {
  const items = $("items");
  const frag = document.createDocumentFragment();
  const end = Math.min(state.rendered + BATCH, state.view_files.length);
  for (let i = state.rendered; i < end; i++) {
    const f = state.view_files[i];
    const node = state.view === "grid" ? makeCard(f) : makeRow(f);
    node.dataset.path = f.path;
    node.dataset.index = i;
    if (state.sel.has(f.path)) node.classList.add("sel");
    state.nodes.set(f.path, node);
    frag.appendChild(node);
  }
  items.appendChild(frag);
  state.rendered = end;
}

function thumbImg(f, px, cls) {
  const img = document.createElement("img");
  img.loading = "lazy";
  img.decoding = "async";
  img.draggable = false;
  img.alt = "";
  img.src = thumbUrl(f, px);
  img.addEventListener("load", () => img.classList.add("ok"));
  img.addEventListener("error", () => {
    const box = img.parentElement;
    img.remove();
    const d = document.createElement("div");
    d.className = "fail";
    d.textContent = cls === "row" ? "?" : tr("files.no_preview");
    box.appendChild(d);
  });
  return img;
}

function pickBox() {
  const p = document.createElement("div");
  p.className = "pick";
  p.title = tr("files.add_to_selection");
  p.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9.5 17.2 4.8 12.5l1.4-1.4 3.3 3.3 8-8 1.4 1.4z"/></svg>';
  return p;
}

function makeCard(f) {
  const card = document.createElement("div");
  card.className = "card";
  const thumb = document.createElement("div");
  thumb.className = "thumb";
  thumb.appendChild(thumbImg(f, state.tile));
  thumb.appendChild(pickBox());
  card.appendChild(thumb);

  const meta = document.createElement("div");
  meta.className = "meta";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = f.name.replace(/\.(3mf|stl)$/i, "");
  name.title = f.name;
  const sub = document.createElement("div");
  sub.className = "sub";
  meta.append(name, sub);
  card.appendChild(meta);
  fillSub(sub, f);
  addBadges(card, f);
  return card;
}

function makeRow(f) {
  const row = document.createElement("div");
  row.className = "row-item";
  const th = document.createElement("div");
  th.className = "rthumb";
  th.appendChild(thumbImg(f, 46, "row"));

  const nameWrap = document.createElement("div");
  const n = document.createElement("div");
  n.className = "rname";
  n.textContent = f.name.replace(/\.(3mf|stl)$/i, "");
  const s = document.createElement("div");
  s.className = "rsub";
  nameWrap.append(n, s);

  const cells = ["time", "weight", "size", "date"].map((k) => {
    const c = document.createElement("div");
    c.className = "cell " + k;
    return c;
  });
  row.append(pickBox(), th, nameWrap, ...cells);
  fillRow(row, f);
  return row;
}

function fillSub(sub, f) {
  sub.innerHTML = "";
  const bits = subtitle(f);
  bits.forEach((b, i) => {
    if (i) {
      const d = document.createElement("span");
      d.className = "dot";
      sub.appendChild(d);
    }
    const sp = document.createElement("span");
    sp.textContent = b;
    sub.appendChild(sp);
  });
}

function fillRow(row, f) {
  const m = state.meta.get(f.path);
  const sub = row.querySelector(".rsub");
  const parts = [];
  if (f.rel) parts.push(f.rel);
  if (m?.title && m.title !== f.name) parts.push(m.title);
  if (m?.designer) parts.push(m.designer);
  if (m?.objects?.length > 1) parts.push(tr("files.parts", { n: m.objects.length }));
  sub.textContent = parts.join(" · ");
  const [t, w, sz, dt] = row.querySelectorAll(".cell");
  t.textContent = fmtDuration(m?.print_time_s) || "—";
  w.textContent = fmtWeight(m?.weight_g) || "—";
  sz.textContent = fmtSize(f.size);
  dt.textContent = fmtDate(f.modified);
}

function addBadges(card, f) {
  const m = state.meta.get(f.path);
  card.querySelectorAll(".badge").forEach((b) => b.remove());
  if (f.kind === "gcode") {
    const b = document.createElement("div");
    b.className = "badge gcode";
    b.textContent = "G-code";
    b.title = tr("files.gcode_badge");
    card.querySelector(".thumb").appendChild(b);
    return;
  }
  if (f.kind === "stl") {
    // A mesh only: tells it from a 3MF of the same name.
    const b = document.createElement("div");
    b.className = "badge stl";
    b.textContent = "STL";
    b.title = tr("files.stl_badge");
    card.querySelector(".thumb").appendChild(b);
    // Always a render, never several plates: the other badges say nothing.
    return;
  }
  if (!m) return;
  if (state.pref === 3 || (state.pref !== 2 && !m.has_embedded_thumb)) {
    const b = document.createElement("div");
    b.className = "badge";
    b.textContent = tr("files.render_badge");
    b.title = tr("files.render_badge.title");
    card.querySelector(".thumb").appendChild(b);
  }
  if (m.plates > 1) {
    const b = document.createElement("div");
    b.className = "badge plates";
    b.textContent = tr("files.plates", { n: m.plates });
    card.querySelector(".thumb").appendChild(b);
  }
}

function patchNode(path) {
  const node = state.nodes.get(path);
  if (!node) return;
  const f = state.files.find((x) => x.path === path);
  if (!f) return;
  if (state.view === "grid") {
    fillSub(node.querySelector(".sub"), f);
    addBadges(node, f);
  } else {
    fillRow(node, f);
  }
}

/* -------------------------------------------------------------- selection */

function setSel(paths, { scroll = false } = {}) {
  state.sel = new Set(paths);
  document.body.classList.toggle("has-sel", state.sel.size > 0);
  for (const [p, n] of state.nodes) n.classList.toggle("sel", state.sel.has(p));
  if (scroll && paths.length) {
    const n = state.nodes.get(paths[paths.length - 1]);
    if (n) n.scrollIntoView({ block: "nearest" });
  }
  updateDetails();
  updateStatus();
  updateSelBar();
}

function updateSelBar() {
  const n = state.sel.size;
  const bar = $("selbar");
  bar.classList.toggle("hidden", n < 2);
  if (n >= 2) {
    const size = state.files.filter((f) => state.sel.has(f.path)).reduce((s, f) => s + f.size, 0);
    $("selbar-txt").textContent = `${tr("files.selected", { n })} · ${fmtSize(size)}`;
  }
}

function selectAll() {
  while (state.rendered < state.view_files.length) renderMore();
  setSel(state.view_files.map((f) => f.path));
}

function indexOfPath(p) {
  return state.view_files.findIndex((f) => f.path === p);
}

function toggleOne(path) {
  const s = new Set(state.sel);
  s.has(path) ? s.delete(path) : s.add(path);
  state.anchor = indexOfPath(path);
  setSel([...s]);
}

function clickItem(ev, path) {
  const idx = indexOfPath(path);
  if (ev.shiftKey && state.anchor >= 0) {
    const [a, b] = [state.anchor, idx].sort((x, y) => x - y);
    setSel(state.view_files.slice(a, b + 1).map((f) => f.path));
  } else if (ev.metaKey || ev.ctrlKey) {
    const s = new Set(state.sel);
    s.has(path) ? s.delete(path) : s.add(path);
    state.anchor = idx;
    setSel([...s]);
  } else {
    state.anchor = idx;
    setSel([path]);
  }
}

function moveSel(delta) {
  if (!state.view_files.length) return;
  const cur = state.sel.size ? indexOfPath([...state.sel][state.sel.size - 1]) : -1;
  let next = Math.min(Math.max(cur + delta, 0), state.view_files.length - 1);
  while (next >= state.rendered) renderMore();
  state.anchor = next;
  setSel([state.view_files[next].path], { scroll: true });
}

function columns() {
  if (state.view === "list") return 1;
  const cs = getComputedStyle($("items")).gridTemplateColumns;
  return Math.max(1, cs.split(" ").filter(Boolean).length);
}

/* ---------------------------------------------------------------- details */

async function updateDetails() {
  const n = state.sel.size;
  $("det-empty").classList.toggle("hidden", n !== 0);
  $("det-body").classList.toggle("hidden", n !== 1);
  $("det-multi").classList.toggle("hidden", n < 2);

  if (n > 1) {
    const files = state.files.filter((f) => state.sel.has(f.path));
    $("multi-title").textContent = tr("files.selected", { n });
    $("multi-size").textContent = tr("files.total", { size: fmtSize(files.reduce((s, f) => s + f.size, 0)) });
    $("multi-prepare").classList.toggle("hidden", files.every((f) => f.kind === "gcode"));
    $("multi-delete").textContent = tr("files.trash_many", { n });
    return;
  }
  if (n !== 1) return;

  const path = [...state.sel][0];
  const f = state.files.find((x) => x.path === path);
  if (!f) return;
  const dimg = $("det-img");
  dimg.style.visibility = "hidden";
  dimg.onload = () => (dimg.style.visibility = "visible");
  dimg.onerror = () => (dimg.style.visibility = "hidden");
  dimg.src = thumbUrl(f, 640);
  $("det-name").textContent = f.name;
  $("det-name").title = f.path;

  if (!state.meta.has(path)) {
    try {
      const [m] = await invoke("read_metas", { paths: [path] });
      if (m) state.meta.set(path, m);
      patchNode(path);
    } catch {}
    if (![...state.sel][0] || [...state.sel][0] !== path) return;
  }
  const m = state.meta.get(path) || {};
  // An STL has no unit: a size far from millimeters is worth a word.
  const oddUnit = f.kind === "stl" && m.size_mm && attachOddScale(m.size_mm);
  $("det-sub").textContent = oddUnit
    ? tr("files.unit_hint", { size: chatModelDims(m) })
    : [m.title, m.designer && tr("files.by", { name: m.designer })].filter(Boolean).join(" — ");
  $("det-sub").classList.toggle("warn", !!oddUnit);
  // An STL never has an embedded image: its preview is always a render.
  const rendered = f.kind === "stl" || state.pref === 3 || (state.pref !== 2 && !m.has_embedded_thumb);
  $("det-badge").textContent = rendered ? tr("files.render_badge") : "";
  $("det-badge").style.display = rendered ? "" : "none";

  const rows = [];
  const add = (k, v) => v && rows.push([k, v]);
  if (f.kind === "stl") add(tr("files.info.format"), tr("files.info.format.stl"));
  add(tr("files.col.size"), fmtSize(f.size));
  add(tr("files.col.date"), fmtDate(f.modified));
  if (f.rel) add(tr("files.info.subfolder"), f.rel);
  add(tr("files.col.time"), fmtDuration(m.print_time_s));
  add(tr("files.col.weight"), fmtWeight(m.weight_g));
  if (m.plates > 1) add(tr("files.info.plates"), m.plates);
  if (m.objects?.length) add(tr("files.info.parts"), m.objects.length > 3 ? `${m.objects.length}` : m.objects.join(", "));
  add(tr("slice.printer"), m.printer);
  add(tr("files.info.software"), m.application);
  add(tr("files.info.created"), m.creation_date);
  add(tr("files.info.license"), m.license);
  const a = state.analysis.get(path);
  if (a) {
    add(tr("files.info.bbox"), a.size_mm.map((v) => fmtDec(v, 1)).join(" × ") + " mm");
    add(tr("files.info.triangles"), fmtNum(a.triangles) + (a.approximated ? " " + tr("files.info.sampled") : ""));
  }
  $("det-info").innerHTML = rows
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(String(v))}</dd>`)
    .join("");

  $("det-filaments").innerHTML = (m.filaments || [])
    .map(
      (fl) => `<div class="fil"><span class="swatch" style="background:${esc(fl.color || "#888")}"></span>
      <span>${esc(fl.kind || "?")}</span>
      <span class="g">${fl.used_g != null ? esc(fmtWeight(fl.used_g)) : ""}${
        fl.used_m != null ? " · " + fmtDec(fl.used_m, 1) + " m" : ""
      }</span></div>`
    )
    .join("");

  // Geometry analysis only applies to meshes.
  const isGcode = f.kind === "gcode";
  $("act-analyze").classList.toggle("hidden", !!a || isGcode);
  // A G-code is already sliced: its own action is the toolpath view.
  $("det-model").classList.toggle("hidden", isGcode);
  $("det-3d").querySelector("[data-i18n]").textContent = tr(isGcode ? "viewer.color.paths" : "files.view3d");
  $("det-desc").textContent = m.description || "";
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function analyzeSelected() {
  const path = [...state.sel][0];
  if (!path) return;
  const btn = $("act-analyze");
  btn.disabled = true;
  btn.textContent = tr("files.analyzing");
  try {
    const a = await invoke("analyze", { path });
    state.analysis.set(path, a);
    updateDetails();
  } catch (e) {
    toast(tr("files.analyze_failed", { err: e }), true);
  }
  btn.disabled = false;
  btn.textContent = tr("files.analyze");
}

/* --------------------------------------------------------------- deletion */

async function askDelete() {
  if (!state.sel.size) return;
  const files = state.files.filter((f) => state.sel.has(f.path));
  const ok = await confirmDelete(
    files.length === 1 ? tr("files.trash.one", { name: files[0].name }) : tr("files.trash.many", { n: files.length }),
    files.length === 1
      ? tr("files.trash.one.text")
      : tr("files.trash.many.text", { size: fmtSize(files.reduce((s, f) => s + f.size, 0)) }),
    tr("files.trash.ok")
  );
  if (ok) doDelete();
}

async function doDelete() {
  const paths = [...state.sel];
  try {
    await invoke("trash_files", { paths });
  } catch (e) {
    toast(tr("files.trash_failed", { err: e }), true);
    return;
  }
  const gone = new Set(paths);
  const idx = indexOfPath(paths[0]);
  state.files = state.files.filter((f) => !gone.has(f.path));
  state.sel.clear();
  applyView();
  const next = state.view_files[Math.min(idx, state.view_files.length - 1)];
  setSel(next ? [next.path] : []);
  toast(tr("files.trashed", { n: paths.length }));
}

/* ------------------------------------------------------------ menus, misc */

/* Native context menu of a file; it acts on the current selection, to which
   the right-click already added the target. Its entries carry the target
   path ("ctxfile:action:path"), distinct from the menu bar's ("file:action"). */
function openMenu(x, y, path) {
  const many = state.sel.size > 1;
  const f0 = state.files.find((f) => f.path === path);
  const id = (what) => `ctxfile:${what}:${path}`;
  nativeMenu([
    ...(f0?.kind !== "gcode" ? [{ id: id("prepare"), label: tr("nav.prepare") }] : []),
    ...(many ? [] : [
      {},
      { id: id("view3d"), label: f0?.kind === "gcode" ? tr("files.view_paths") : tr("files.view3d") },
      { id: id("reveal"), label: tr("menu.file.reveal") },
      { id: id("copy"), label: tr("files.copy_path") },
    ]),
    {},
    { id: id("delete"), label: many ? tr("files.trash_many", { n: state.sel.size }) : tr("menu.file.trash") },
  ], x, y);
}

function fileAction(what, path) {
  if (what === "prepare") prepareFiles([...state.sel]);
  if (what === "view3d") open3d(path);
  if (what === "reveal") invoke("reveal", { path }).catch((e) => toast(String(e), true));
  if (what === "copy") copy(path);
  if (what === "delete") askDelete();
}
onMenu("ctxfile", (arg) => {
  const i = arg.indexOf(":");
  const path = arg.slice(i + 1);
  if (state.sel.has(path)) fileAction(arg.slice(0, i), path);
});
/* From the menu bar: Files view only, with no sheet open and no typing. */
onMenu("file", (what) => {
  const path = [...state.sel][0];
  if (!path || window.currentView !== "files") return;
  if (document.querySelector(".modal:not(.hidden)")) return;
  const el = document.activeElement;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
  fileAction(what, path);
});

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(tr("files.path_copied"));
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast(tr("files.path_copied"));
  }
}

function updateStatus() {
  const total = state.view_files.reduce((s, f) => s + f.size, 0);
  const filtered = state.view_files.length !== state.files.length;
  const sub = state.dir
    ? (filtered
        ? tr("files.count_of", { n: state.view_files.length, total: state.files.length })
        : tr("files.count", { n: state.view_files.length })) + ` · ${fmtSize(total)}`
    : "";
  tbSet("files", state.dir ? baseName(state.dir) : tr("nav.files"), sub);
  sideSync();
}

/* ----------------------------------------------------------------- events */

$("items").addEventListener("mousedown", (e) => {
  const node = e.target.closest("[data-path]");
  if (!node) return;
  if (e.target.closest(".pick")) {
    e.preventDefault();
    e.stopPropagation();
    toggleOne(node.dataset.path);
    return;
  }
  if (e.button === 2) {
    if (!state.sel.has(node.dataset.path)) clickItem(e, node.dataset.path);
    return;
  }
  clickItem(e, node.dataset.path);
});

$("items").addEventListener("dblclick", (e) => {
  const node = e.target.closest("[data-path]");
  if (node) openFile(node.dataset.path);
});

$("items").addEventListener("contextmenu", (e) => {
  const node = e.target.closest("[data-path]");
  if (!node) return;
  e.preventDefault();
  openMenu(e.clientX, e.clientY, node.dataset.path);
});

document.addEventListener("mousedown", (e) => {
  if ((e.target === $("stage") || e.target === $("items")) && !e.metaKey && !e.ctrlKey && !e.shiftKey)
    setSel([]);
});

document.addEventListener("keydown", (e) => {
  // The Files view's shortcuts only apply to it.
  if (window.currentView && window.currentView !== "files") return;
  if (!$("viewer").classList.contains("hidden")) return;
  // An open sheet keeps the keyboard to itself.
  if (document.querySelector(".modal:not(.hidden)")) return;
  const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName);
  const mod = e.metaKey || e.ctrlKey;
  // ⌘A selects the files; elsewhere, the Edit menu's native selection.
  if (mod && e.key.toLowerCase() === "a" && !typing) { e.preventDefault(); selectAll(); return; }
  // On macOS the other combinations are menu bar accelerators.
  if (mod && IS_MAC) return;
  if (mod && e.key.toLowerCase() === "o") { e.preventDefault(); pickFolder(); return; }
  if (mod && e.key.toLowerCase() === "r") { e.preventDefault(); refresh(); return; }
  if (mod && e.key === "1") { setView("grid"); return; }
  if (mod && e.key === "2") { setView("list"); return; }
  if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); $("search").focus(); $("search").select(); return; }
  if (e.key === "Escape") {
    if (typing) { $("search").blur(); return; }
    setSel([]);
    return;
  }
  if (typing) return;
  if (e.key.toLowerCase() === "v") {
    const p = [...state.sel][0];
    if (p) open3d(p);
    return;
  }
  if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); askDelete(); return; }
  if (e.key === "Enter" && !mod) {
    const p = [...state.sel][0];
    if (p) openFile(p);
    return;
  }
  const cols = columns();
  if (e.key === "ArrowRight") { e.preventDefault(); moveSel(1); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); moveSel(-1); }
  else if (e.key === "ArrowDown") { e.preventDefault(); moveSel(cols); }
  else if (e.key === "ArrowUp") { e.preventDefault(); moveSel(-cols); }
});

$("stage").addEventListener("scroll", () => {
  const s = $("stage");
  if (s.scrollTop + s.clientHeight > s.scrollHeight - 600 && state.rendered < state.view_files.length)
    renderMore();
});

$("search").addEventListener("input", () => applyView());
const SORTS = ["name", "date", "size", "time", "weight", "folder"];
$("btn-sort").addEventListener("click", (e) =>
  menuUnder(e.currentTarget, [
    ...SORTS.map((k) => ({ id: "sort:" + k, label: tr("files.sort." + k), checked: state.sort === k })),
    {},
    { id: "order:asc", label: tr("files.sort.asc"), checked: state.asc },
    { id: "order:desc", label: tr("files.sort.desc"), checked: !state.asc },
  ])
);
onMenu("sort", (k) => { state.sort = k; save(); applyView(); syncHead(); });
onMenu("order", (o) => { state.asc = o === "asc"; save(); applyView(); syncHead(); });
$("btn-add").addEventListener("click", pickFolder);
onMenu("nav", (v) => switchView(v));
onMenu("view", (v) => { switchView("files"); setView(v); });
/* The Edit menu's undo / redo (macOS): typing in a field undoes itself,
   as the system's entry did; elsewhere Prepare's plate takes it. A
   Library site holding the keyboard gets it from Rust (menu.rs forward). */
function editHistory(what) {
  if (!document.hasFocus()) return;
  // A list has no typing to undo: the plate's, as a slider.
  const el = document.activeElement;
  const typing = plTyping(el) && el.tagName !== "SELECT";
  if (!typing && typeof prMenuHistory === "function" && prMenuHistory(what === "redo")) return;
  document.execCommand(what);
}
onMenu("edit", (what) => {
  if (what === "undo" || what === "redo") return editHistory(what);
  if (what === "find" && window.currentView === "files") { $("search").focus(); $("search").select(); }
  // On macOS ⌘F is the menu's: the AI list has its own search.
  if (what === "find" && window.currentView === "ia" && !IA.open && IA.list.length) { $("ia-q").focus(); $("ia-q").select(); }
  if (what === "find" && window.currentView === "prints") { $("pj-q").focus(); $("pj-q").select(); }
});
onMenu("files", (what) => {
  if (what === "open") { switchView("files"); pickFolder(); }
  // ⌘R reloads the page in the Library, the folder elsewhere.
  if (what === "refresh") window.currentView === "library" ? libCmd("reload") : refresh();
  if (what === "reveal" && state.dir) invoke("reveal", { path: state.dir }).catch((e) => toast(String(e), true));
});
$("tile").addEventListener("input", () => {
  state.tile = +$("tile").value;
  document.documentElement.style.setProperty("--tile", state.tile + "px");
  save();
});
$("tile").addEventListener("change", () => applyView());
$("btn-open2").addEventListener("click", pickFolder);
$("btn-refresh").addEventListener("click", refresh);
$("view-grid").addEventListener("click", () => setView("grid"));
$("view-list").addEventListener("click", () => setView("list"));
/* Double-click and ⏎: a model goes to the plate (with the rest of the
   selection), a G-code shows its toolpaths. */
function openFile(path) {
  const f = state.files.find((x) => x.path === path);
  if (!f) return;
  if (f.kind === "gcode") open3d(path);
  else prepareFiles([...state.sel]);
}

$("act-reveal").addEventListener("click", () => {
  const p = [...state.sel][0];
  if (p) invoke("reveal", { path: p }).catch((e) => toast(String(e), true));
});
$("act-delete").addEventListener("click", askDelete);
$("det-3d").addEventListener("click", () => {
  const p = [...state.sel][0];
  if (p) open3d(p);
});
$("det-img").addEventListener("click", () => {
  const p = [...state.sel][0];
  if (p) open3d(p);
});

/* The viewer is defined in viewer.js, loaded after this file. */
function open3d(path) {
  const f = state.files.find((x) => x.path === path);
  if (f) openViewer(f.path, f.name, f.kind);
}
$("multi-delete").addEventListener("click", askDelete);
$("multi-prepare").addEventListener("click", () => prepareFiles([...state.sel]));
$("act-analyze").addEventListener("click", analyzeSelected);
$("selbar-all").addEventListener("click", selectAll);
$("selbar-none").addEventListener("click", () => setSel([]));
$("selbar-del").addEventListener("click", askDelete);

$("listhead").addEventListener("click", (e) => {
  const c = e.target.closest(".sortable");
  if (!c) return;
  const k = c.dataset.sort;
  if (state.sort === k) state.asc = !state.asc;
  else { state.sort = k; state.asc = true; }
  save();
  applyView();
  syncHead();
});

function syncHead() {
  $("listhead").querySelectorAll(".sortable").forEach((c) =>
    c.classList.toggle("on", c.dataset.sort === state.sort)
  );
}

function setView(v) {
  state.view = v;
  save();
  $("view-grid").classList.toggle("on", v === "grid");
  $("view-list").classList.toggle("on", v === "list");
  $("tile").style.display = v === "grid" ? "" : "none";
  renderReset();
}

/* settings */
$("set-invert-wheel").addEventListener("change", () => {
  state.invertWheel = $("set-invert-wheel").checked;
  save();
});
$("set-wheel-action").addEventListener("change", () => {
  state.wheelAction = $("set-wheel-action").value;
  save();
});
$("set-wheel-speed").addEventListener("input", () => {
  state.wheelSpeed = +$("set-wheel-speed").value;
  $("set-wheel-speed-val").textContent = fmtDec(state.wheelSpeed, 1) + "×";
  save();
});
$("opt-recursive").addEventListener("change", () => {
  state.recursive = $("opt-recursive").checked;
  save();
  refresh();
});
$("opt-pref").addEventListener("change", () => {
  state.pref = +$("opt-pref").value;
  save();
  renderReset();
  updateDetails();
});
$("opt-clear").addEventListener("click", async () => {
  const n = await invoke("clear_cache");
  refreshCacheSize();
  toast(tr("settings.cache.cleared", { n }));
  renderReset();
});

function refreshCacheSize() {
  invoke("cache_info").then((c) => ($("cache-size").textContent = fmtSize(c.bytes)));
}


/* drag and drop. Tauri takes every file dropped on the window (the page's
   own drop never gets them): files go to the AI's creation sheet when it
   is open, or to the conversation the AI view shows (attach-logic.js,
   ia.js iaDropPaths); anywhere else, a folder opens in Files. */
function dropTarget() {
  return attachTarget({
    sheetOpen: !$("iamodal").classList.contains("hidden"),
    iaVisible: !$("view-ia").classList.contains("hidden"),
    convOpen: !!CHAT.id,
  });
}
listen("tauri://drag-enter", () => {
  const target = dropTarget();
  document.body.classList.toggle("dragover", !target);
  iaDropHint(target);
});
listen("tauri://drag-leave", () => {
  document.body.classList.remove("dragover");
  iaDropHint(null);
});
listen("tauri://drag-drop", (e) => {
  document.body.classList.remove("dragover");
  iaDropHint(null);
  const paths = e.payload?.paths || [];
  const target = dropTarget();
  if (target) {
    iaDropPaths(target, paths);
    return;
  }
  const p = paths[0];
  // An image has nothing to open outside the AI view.
  if (!p || /\.(png|jpe?g|gif|webp)$/i.test(p)) return;
  // A file dropped opens its folder (a file path pushed to the recents
  // would stay there as a dead entry); a folder opens itself.
  openDir(p.replace(/[\\/][^\\/]+\.(3mf|stl|gcode|gco|g|obj|step|stp)$/i, ""));
});

/* rubber-band selection in the empty area */
(() => {
  const stage = $("stage");
  const items = $("items");
  let box = null, sx = 0, sy = 0, base = null, active = false, rects = null;

  stage.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || (e.target !== stage && e.target !== items)) return;
    sx = e.clientX;
    sy = e.clientY;
    base = e.metaKey || e.ctrlKey || e.shiftKey ? new Set(state.sel) : new Set();
    active = true;
    rects = null;
  });

  addEventListener("mousemove", (e) => {
    if (!active) return;
    if (!box && Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) < 5) return;
    if (!box) {
      box = document.createElement("div");
      box.className = "rubber";
      document.body.appendChild(box);
      // Positions are frozen at the start of the gesture: a single layout pass.
      rects = [...state.nodes].map(([p, n]) => [p, n.getBoundingClientRect()]);
    }
    const x = Math.min(sx, e.clientX), y = Math.min(sy, e.clientY);
    const w = Math.abs(e.clientX - sx), h = Math.abs(e.clientY - sy);
    Object.assign(box.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
    const sel = new Set(base);
    for (const [p, r] of rects) {
      if (r.left < x + w && r.right > x && r.top < y + h && r.bottom > y) sel.add(p);
    }
    if (sel.size !== state.sel.size || [...sel].some((p) => !state.sel.has(p))) setSel([...sel]);
  });

  addEventListener("mouseup", () => {
    active = false;
    if (box) {
      box.remove();
      box = null;
    }
  });
})();

/* width of the details panel */
(() => {
  const sp = $("splitter");
  let startX = 0, startW = 0, dragging = false;
  sp.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startW = $("details").offsetWidth;
    sp.classList.add("drag");
    e.preventDefault();
  });
  addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const w = Math.min(Math.max(startW - (e.clientX - startX), 260), 560);
    $("details").style.width = w + "px";
    state.detailsWidth = w;
  });
  addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    sp.classList.remove("drag");
    save();
  });
})();

/* ---------------------------------------------------------------- startup */

/* Usual folders (Downloads, Documents…), named by Rust in the current language. */
async function fillPlaces() {
  const places = await invoke("quick_places").catch(() => []);
  $("places").innerHTML = "";
  for (const p of places) {
    const b = document.createElement("button");
    b.className = "place";
    b.textContent = p.label;
    b.title = p.path;
    b.onclick = () => openDir(p.path);
    $("places").appendChild(b);
  }
}

async function boot() {
  $("stage").dataset.drop = tr("files.drop");
  $("opt-recursive").checked = state.recursive;
  $("set-invert-wheel").checked = state.invertWheel;
  $("set-wheel-action").value = state.wheelAction;
  $("set-wheel-speed").value = state.wheelSpeed;
  $("set-wheel-speed-val").textContent = fmtDec(state.wheelSpeed, 1) + "×";
  $("opt-pref").value = String(state.pref);
  $("tile").value = state.tile;
  $("details").style.width = state.detailsWidth + "px";
  setView(state.view);
  syncHead();

  await fillPlaces();

  const arg = await invoke("initial_dir");
  if (arg) state.dir = arg;

  renderRecents();
  updateStatus();
  if (state.dir) await refresh();
}

/* Switches (input.sw, role="switch"): Enter toggles them too, as Space
   does, and is kept from submitting or closing anything around them. */
document.addEventListener("keydown", (e) => {
  const t = e.target;
  if (e.key !== "Enter" || !(t instanceof HTMLInputElement) || !t.classList.contains("sw") || t.disabled) return;
  e.preventDefault();
  e.stopPropagation();
  t.click();
}, true);

/* A new language: everything Files builds in code is rebuilt. */
window.addEventListener("langchange", () => {
  renderRecents();
  renderReset();
  updateDetails();
  updateSelBar();
  updateStatus();
  fillPlaces();
  refreshCacheSize();
  $("set-wheel-speed-val").textContent = fmtDec(state.wheelSpeed, 1) + "×";
  if (!$("act-analyze").disabled) $("act-analyze").textContent = tr("files.analyze");
  $("stage").dataset.drop = tr("files.drop");
});

boot();
