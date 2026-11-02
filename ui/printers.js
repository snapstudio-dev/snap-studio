"use strict";
/* "Printers" view.
   Status is read through the printer's Moonraker HTTP API (Klipper): the
   Snapmaker U1 exposes it on port 7125, and on port 80 behind its nginx.
   The network search (mDNS) only runs while the "On the network" list is
   shown; otherwise only the saved addresses are queried. */

const P = {
  list: [],
  sel: null,
  status: new Map(),   // id -> last known status
  seen: new Map(),     // id -> time of the last data received
  live: new Map(),     // id -> live feed established
  timer: null,
  editing: null,
  busy: false,
  offErr: "",          // last offline error logged (once per change)
};

window.currentView = "files";

/* ------------------------------------------------------------ navigation */

function switchView(v) {
  window.currentView = v;
  // A popover belongs to the screen it was opened on.
  if (typeof closePicker === "function") closePicker();
  document.querySelectorAll(".views > .view").forEach((s) => {
    s.classList.toggle("hidden", s.id !== "view-" + v);
  });
  // Explore's tab strip stands in for the toolbar.
  document.body.classList.toggle("no-toolbar", v === "library");
  if (typeof p3dVisible === "function") p3dVisible(v === "printers");
  // The screens left first, the one entered after: the camera leaves with
  // a screen (a pinned one goes on, in its window; full size belongs to
  // the screen it was asked on) and the next one, drawn right away, keeps
  // a stream of the same printer.
  if (v !== "printers") {
    stopLive();
    camLeave();
  }
  // Leaving Care & Tuning stops Control's reads and its camera.
  if (v !== "maint" && typeof ctLeave === "function") ctLeave();
  // Leaving a printer's files stops its video.
  if (v !== "pfiles" && typeof pflLeave === "function") pflLeave();
  // Leaving Prints stops its camera and its timelapse.
  if (v !== "prints" && typeof pjLeave === "function") pjLeave();
  if (v === "printers") {
    startLive();
    prnCamHome();
  }
  if (v === "prints") pjRender();
  // Explore's native views must only live in its tab.
  libSetVisible(v === "library");
  if (v === "settings") {
    refreshCacheSize();
    settingsShown();
  }
  if (v === "prepare") prepareShow();
  if (v === "ia") iaRefresh();
  // The docked viewer follows the tab instead of staying trapped in it.
  iaSetVisible(v === "ia");
  tbRender();
  sideSync();
}

document.querySelectorAll(".sidebar .side-item[data-view]").forEach((b) =>
  b.addEventListener("click", () => {
    // AI in the sidebar leads to the list of conversations, even from one
    // that is open; its conversations below it open them.
    if (b.dataset.view === "ia" && typeof IA !== "undefined" && IA.open) iaBack();
    switchView(b.dataset.view);
  })
);
/* Titles of the views that have nothing more specific to show. */
function tbDefaults() {
  tbSet("prepare", tr("slice.plate"));
  tbSet("library", tr("nav.explore"));
  tbSet("printers", tr("nav.printers"));
  tbSet("settings", tr("nav.settings"));
}
tbDefaults();

/* ------------------------------------------------------------ list */

async function prnLoad(selectId) {
  P.list = await invoke("printers_list");
  if (selectId) P.sel = selectId;
  if (P.sel && !P.list.some((p) => p.id === P.sel)) P.sel = null;
  if (!P.sel && P.list.length) P.sel = P.list[0].id;
  prnRenderList();
  prnRenderDetail();
  if (window.currentView === "printers") startLive();
  // At launch, Prepare may show before the printers are known.
  if (window.currentView === "prepare" && typeof prRefreshSpools === "function") prRefreshSpools();
  // Maintenance due on each printer: the sidebar's dots.
  if (typeof mtCheckAll === "function") mtCheckAll();
  // Filament theme: its accent follows the active printer's T0 spool.
  displaySpoolSync(true);
}

function ledClass(st, id) {
  // Unreachable is not an error: neutral gray light (red only for real errors).
  if (id != null && P.live.get(id) === false) return "";
  if (!st || !st.online) return "";
  if (st.state === "printing") return "busy";
  if (st.state === "error") return "err";
  return "ok";
}

const SIDE_WRENCH = '<svg viewBox="0 0 24 24"><path d="M21.7 6.3a5.5 5.5 0 0 1-7.4 6.7L6.7 20.6a2 2 0 0 1-2.8-2.8L11.5 10.2a5.5 5.5 0 0 1 6.7-7.4l-3.4 3.4.7 2.8 2.8.7z"/></svg>';
const SIDE_SPOOL = '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m0 6a3 3 0 1 1 0 6 3 3 0 0 1 0-6m0-4a7 7 0 0 1 6.9 6h-3a4 4 0 0 0-7.8 0h-3A7 7 0 0 1 12 5"/></svg>';
const SIDE_PRINTER = '<svg viewBox="0 0 24 24"><path d="M7 3h10v4H7zm-2 6h14a2 2 0 0 1 2 2v5h-4v-3H7v3H3v-5a2 2 0 0 1 2-2m2 6h10v6H7z"/></svg>';

/* Printers show in the sidebar, status light on the right. Statuses arrive
   continuously: when the list has not changed, only the lights are touched,
   without replacing the entries (a click in progress would be lost). */
function prnRenderList() {
  const box = $("side-printers");
  const items = [...box.querySelectorAll(":scope > .side-item[data-id]")];
  if (items.length === P.list.length && items.every((el, i) => el.dataset.id === P.list[i].id)) {
    items.forEach((el, i) => {
      const p = P.list[i];
      el.querySelector(".led").className = "led " + ledClass(P.status.get(p.id), p.id);
      el.querySelector(".lbl").textContent = p.name || p.host;
    });
    box.querySelectorAll("[data-heads] .lbl").forEach((l) => (l.textContent = tr("heads.title")));
    box.querySelectorAll("[data-maint] .lbl").forEach((l) => (l.textContent = tr("maint.title")));
    box.querySelectorAll("[data-pfiles] .lbl").forEach((l) => (l.textContent = tr("pfiles.title")));
    if (typeof pflSideCounts === "function") pflSideCounts();
    sideSync();
    return;
  }
  box.innerHTML = "";
  for (const p of P.list) {
    const st = P.status.get(p.id);
    const el = document.createElement("button");
    el.className = "side-item";
    el.dataset.id = p.id;
    el.title = `${p.host}${p.port && p.port !== 80 ? ":" + p.port : ""}`;
    el.innerHTML = `<span class="glyph" style="color: #34C759">${SIDE_PRINTER}</span>
      <span class="lbl">${esc(p.name || p.host)}</span>${simBadge(p.id)}<span class="led ${ledClass(st, p.id)}"></span>`;
    el.onclick = () => {
      P.sel = p.id;
      prnRenderDetail();
      switchView("printers");
      refreshSelected();
    };
    el.oncontextmenu = (e) =>
      nativeMenu([
        { id: "prn:edit:" + p.id, label: tr("printers.edit_menu") },
        {},
        { id: "prn:remove:" + p.id, label: tr("common.delete") },
      ], e.clientX, e.clientY);
    box.appendChild(el);
    // "Heads and spools" sub-item, under each printer.
    const sub = document.createElement("div");
    sub.className = "side-group side-sub";
    sub.innerHTML = `<button class="side-item" data-heads="${esc(p.id)}"><span class="glyph" style="color: #34C759">${SIDE_SPOOL}</span><span class="lbl">${esc(tr("heads.title"))}</span></button>` +
      `<button class="side-item" data-maint="${esc(p.id)}"><span class="glyph" style="color: #8E8E93">${SIDE_WRENCH}</span><span class="lbl">${esc(tr("maint.title"))}</span><span class="mt-dot hidden"></span></button>` +
      `<button class="side-item" data-pfiles="${esc(p.id)}"><span class="glyph" style="color: #1E8CFF">${SIDE_FOLDER}</span><span class="lbl">${esc(tr("pfiles.title"))}</span><span class="count"></span></button>`;
    sub.children[0].onclick = () => headsShow(p.id);
    sub.children[1].onclick = () => maintShow(p.id);
    sub.children[2].onclick = () => pflShow(p.id);
    box.appendChild(sub);
  }
  if (typeof mtSideDots === "function") mtSideDots();
  if (typeof pflSideCounts === "function") pflSideCounts();
  sideSync();
}

/* ------------------------------------------------------------ detail */

/* Printer state → label key and light class. */
const STATES = {
  standby: ["printers.state.ready", "ok"],
  ready: ["printers.state.ready", "ok"],
  printing: ["printers.state.printing", "busy"],
  paused: ["printers.state.paused", "busy"],
  complete: ["printers.state.complete", "ok"],
  cancelled: ["printers.state.cancelled", ""],
  error: ["printers.state.error", "err"],
  offline: ["printers.state.offline", "err"],
};
const stateLabel = (s) => (STATES[s] ? tr(STATES[s][0]) : s);

const fmtHms = (s) => {
  if (s == null || !isFinite(s)) return null;
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? tr("units.hm", { h, m: String(m).padStart(2, "0") }) : tr("units.min", { m });
};

function current() {
  return P.list.find((p) => p.id === P.sel) || null;
}

/* A printer as the user named it (its address when it has no name); empty
   when unknown. */
function printerName(id) {
  const p = P.list.find((x) => x.id === id);
  return p ? p.name || p.host : "";
}

/* A printer that does not answer (or answers with an error), said the same
   on each of its screens: Control's status, its red dot and "Not
   connected", then why and a retry. `retry` is the button's attribute,
   which the screen listens to. `inner` gives the line alone, for Control,
   whose status card already shows the dot. */
function offlineLine(text, retry, inner = false) {
  const button = `<button class="btn small" ${retry}>${esc(tr("printers.offline.retry"))}</button>`;
  if (inner) return `<span class="mt-stale-dot"></span><span>${esc(text)}</span>${button}`;
  return `<div class="ct-status off-status" role="status"><span class="ct-state offline"><i></i><b>${esc(tr("ctl.st.offline"))}</b></span><span class="off-why">${esc(text)}</span>${button}</div>`;
}

/* The Camera section while the printer does not answer: hidden, unless a
   pinned stream of this printer shows there (it says the printer does not
   answer, camera.js). */
function prnCamSection() {
  const off = !$("prn-offline").classList.contains("hidden");
  $("prn-cam").classList.toggle("hidden", off && !(CAM.on && CAM.id === P.sel));
}

function prnRenderDetail() {
  const p = current();
  $("prn-empty").classList.toggle("hidden", !!p);
  $("prn-detail").classList.toggle("hidden", !p);
  $("prn-tools").classList.toggle("hidden", !p);
  if (!p) {
    tbSet("printers", tr("nav.printers"));
    prnCamHome();
    return;
  }
  tbSet("printers", p.name || p.host, `${p.host}:${p.port}${p.model ? " · " + p.model : ""}${simOf(p.id) ? " · " + window.SIM.label : ""}`);
  if (typeof p3dShow === "function") p3dShow(p);
  // The camera follows the printer shown (camera.js: switching printer
  // turns it off, unless pinned).
  prnCamHome();
  renderStatus(P.status.get(p.id));
}

/* Single "not connected" card, shown instead of ring/job/filaments/temps.
   mode: "connecting" (no status yet) | "offline". */
function setOffline(mode, st) {
  const card = $("prn-offline");
  const on = !!mode;
  card.classList.toggle("hidden", !on);
  card.classList.toggle("connecting", mode === "connecting");
  // Nor the model or the address (the address stays in the title bar), nor
  // the camera unless a pinned stream shows it: nothing to read or watch
  // until the printer answers.
  for (const id of ["prn-hero", "prn-filaments", "prn-temps", "prn-info"]) $(id).classList.toggle("hidden", on);
  prnCamSection();
  if (!on) {
    $("cam-toggle").disabled = false;
    return;
  }
  const connecting = mode === "connecting";
  $("prn-offline-title").textContent = tr(connecting ? "printers.offline.connecting" : "printers.offline.title");
  $("prn-offline-hint").classList.toggle("hidden", connecting);
  $("prn-offline-retry").classList.toggle("hidden", connecting);
  $("prn-offline-ico").classList.toggle("hidden", connecting);
  $("prn-offline-spin").classList.toggle("hidden", !connecting);
  setOfflineSeen(connecting ? null : P.seen.get(P.sel));
  // No camera without a connection: stop it and disable its switch (a
  // pinned one stays, saying the printer does not answer).
  if (CAM.on && CAM.id === P.sel) CAM.pinned ? camOffline(true) : camStop();
  $("cam-toggle").disabled = true;
  prnCamSection();
  // The raw error under Details, without the address it tried (errNoUrl,
  // control-logic.js); the whole of it goes to the console.
  const raw = (!connecting && st?.message) || "";
  if (raw && raw !== P.offErr) console.warn("printer offline", P.sel, raw);
  P.offErr = raw;
  const err = errNoUrl(raw);
  $("prn-offline-err").textContent = err;
  $("prn-offline-details").classList.toggle("hidden", !err);
}

function renderStatus(st) {
  const pill = $("prn-pill");
  const msg = $("prn-msg");
  if (!st) {
    pill.className = "pill";
    pill.textContent = tr("printers.querying");
    msg.classList.add("hidden");
    setOffline("connecting");
    $("prn-info").innerHTML = "";
    paintPrinter({ online: false, state: "offline", nozzles: [] });
    if (typeof p3dStatus === "function") p3dStatus(null);
    updateFreshness();
    return;
  }
  const s = st.online ? st.state : "offline";
  // Offline keeps a neutral gray badge; red stays for real errors.
  pill.className = "pill " + (s === "offline" ? "" : STATES[s]?.[1] ?? "");
  pill.textContent = stateLabel(s);

  // The raw error of an unreachable printer only lives in the card's Details.
  const text = st.online && st.state === "error" ? st.message || tr("printers.klipper_error") : "";
  msg.textContent = text;
  msg.classList.toggle("hidden", !text);
  setOffline(st.online ? null : "offline", st);

  // Progress ring
  const printing = st.job && st.progress != null;
  const pct = printing ? Math.round(st.progress * 100) : null;
  const C = 2 * Math.PI * 50;
  const ring = $("prn-ring");
  ring.style.strokeDashoffset = C * (1 - (printing ? st.progress : 0));
  ring.style.opacity = printing ? 1 : 0;
  $("prn-jobpct").textContent = pct != null ? pct + " %" : "—";
  $("prn-ringlbl").textContent = printing
    ? tr("printers.printed")
    : st.online
    ? (STATES[st.state] ? stateLabel(st.state) : tr("printers.idle")).toLowerCase()
    : tr("printers.state.offline").toLowerCase();
  $("prn-jobname").textContent = st.job || tr(st.online ? "printers.no_job" : "printers.no_data");

  const times = [];
  const el = fmtHms(st.elapsed_s);
  const re = fmtHms(st.remaining_s);
  if (el) times.push(tr("printers.elapsed", { t: el }));
  if (re) times.push(tr("printers.remaining", { t: re }));
  $("prn-times").textContent = times.join(" · ");

  // Context chips
  const chips = [];
  if (st.layer) chips.push(chip(tr("printers.layer"), `${st.layer[0]} / ${st.layer[1]}`));
  if (st.filament_mm) chips.push(chip(tr("files.col.weight"), fmtDec(st.filament_mm / 1000, 2) + " m"));
  const act = (st.nozzles || []).find((n) => n.active);
  if (act) {
    const t = fmtDec(act.current, 1);
    chips.push(chip(tr("printers.nozzle", { i: act.index }), act.target > 0 ? `${t} → ${Math.round(act.target)} °C` : `${t} °C`));
  }
  // A 100 % speed tells nothing: shown only when changed.
  if (st.speed_factor != null && Math.round(st.speed_factor * 100) !== 100)
    chips.push(chip(tr("printers.speed"), Math.round(st.speed_factor * 100) + " %"));
  if (st.fan != null) chips.push(chip(tr("printers.fan"), Math.round(st.fan * 100) + " %"));
  $("prn-chips").innerHTML = chips.join("");

  // Loaded filaments (U1) and temperatures. The live status is the spools'
  // freshest source: the heads' own copy (heads.js, Control, the 3D view)
  // follows it, or an unloaded spool would linger there.
  if (st.online && Array.isArray(st.filaments) && P.sel) headsSetSlots(P.sel, st.filaments);
  renderFilaments(st);
  const rows = [];
  if (!(st.filaments || []).length) {
    // Printer without declared slots: the nozzles stay listed here.
    for (const n of st.nozzles || []) {
      rows.push(tempRow(tr("printers.nozzle", { i: n.index }), n.active ? tr("printers.active_head") : "", n.current, n.target, n.active, ICON_NOZZLE));
    }
  }
  if (st.bed) rows.push(tempRow(tr("slice.plate"), "", st.bed.current, st.bed.target, false, ICON_BED));
  if (st.chamber) rows.push(tempRow(tr("printers.chamber"), "", st.chamber.current, st.chamber.target, false, ICON_BED));
  $("prn-temps").innerHTML = rows.join("");

  // Information
  const p = current();
  const info = [];
  const add = (k, v) => v != null && v !== "" && info.push(
    `<div class="grow-row"><span class="k">${esc(k)}</span><span class="val">${esc(String(v))}</span></div>`
  );
  add(tr("printers.form.model"), p?.model);
  add(tr("printers.address"), `${p?.host}:${p?.port}`);
  add(tr("printers.hostname"), st.hostname);
  add("Klipper", st.klipper);
  add(tr("printers.note"), p?.note);
  $("prn-info").innerHTML = info.join("");

  paintPrinter(st);
  // The 3D view, when it can, replaces the hero (printer3d.js).
  if (typeof p3dStatus === "function") p3dStatus(st);
  updateFreshness();
}

/* Approximate name of a color, to describe a spool. */
function colorName(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return "";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
  if (d < 0.08) return tr(l > 0.85 ? "color.white" : l < 0.12 ? "color.black" : "color.grey");
  let deg = mx === r ? 60 * (((g - b) / d) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  if (deg < 0) deg += 360;
  const table = [[15, "red"], [45, "orange"], [70, "yellow"], [160, "green"], [200, "cyan"],
                 [255, "blue"], [290, "violet"], [330, "pink"], [361, "red"]];
  const name = tr("color." + table.find(([lim]) => deg < lim)[1]);
  if (l < 0.22) return tr("color.dark", { c: name });
  if (l > 0.82) return tr("color.light", { c: name });
  return name;
}

/* Loaded spools, the active head first. */
function renderFilaments(st) {
  const box = $("prn-filaments");
  const fils = st.filaments || [];
  if (!fils.length) {
    box.innerHTML = "";
    return;
  }
  const act = (st.nozzles || []).find((n) => n.active);
  const ai = act ? act.index : -1;
  const printing = st.state === "printing";
  const sorted = [...fils].sort((a, b) => {
    if (a.index === ai) return -1;
    if (b.index === ai) return 1;
    return a.index - b.index;
  });

  // Filament profile of each head, as set in "Heads and spools".
  const prof = {};
  if (P.sel && !HD.listsNow[P.sel]) headsLists(P.sel).catch(() => {});
  if (P.sel) for (const f of fils) prof[f.index] = headsProfile(P.sel, f.index, HD.listsNow[P.sel] || null).name || "";
  const rows = sorted.map((f) => {
    const on = f.index === ai;
    const n = (st.nozzles || []).find((x) => x.index === f.index);
    const bits = [];
    if (f.present) {
      const kind = [f.kind, f.sub_type].filter(Boolean).join(" ");
      // The hex code is technical data: in ui-monospace.
      const col = f.color ? `${esc(colorName(f.color))} <code>${esc(f.color.toUpperCase())}</code>` : "";
      bits.push([esc(kind), col].filter(Boolean).join(" · "));
      if (f.vendor) bits.push(esc(f.vendor));
    } else {
      bits.push(esc(tr("printers.slot_empty")));
    }
    const tags = [];
    if (on) {
      tags.push(`<span class="ftag accent">${esc(tr(printing ? "printers.extruding" : "printers.active_head_tag"))}</span>`);
    } else if (f.used && st.job) {
      // `extruders_used` remembers the last job: with no print running, the
      // mention would no longer make sense.
      tags.push(`<span class="ftag">${esc(tr("printers.used_by_job"))}</span>`);
    }
    if (!f.present) tags.push(`<span class="ftag">${esc(tr("printers.empty_tag"))}</span>`);
    const temp = n ? `${fmtDec(n.current, 1)} °C` : "";
    const sw = f.present && f.color ? `background:${esc(f.color)}` : "";
    return `<div class="frow${on ? " on" : ""}">
      <span class="fbar"></span>
      <span class="fsw" style="${sw}"></span>
      <span class="k"><b>T${f.index}</b><span class="sub">${bits.join(" · ")}</span>${f.present && prof[f.index] ? `<span class="fprof">${esc(prof[f.index])}</span>` : ""}</span>
      <span class="ftags">${tags.join("")}<span class="ftemp">${esc(temp)}</span></span>
    </div>`;
  });

  box.innerHTML =
    `<div class="ghead">${esc(tr("printers.loaded"))}<span class="note">${esc(tr("printers.slots", { n: fils.length }))}</span><button class="btn small" data-heads-open>${esc(tr("heads.configure"))}</button></div>` +
    rows.join("");
}

const chip = (k, v) => `<span class="chip">${esc(k)} <b>${esc(v)}</b></span>`;

const ICON_NOZZLE =
  '<svg viewBox="0 0 24 24"><path d="M8 3h8v5l-2 3v4l-2 6-2-6v-4L8 8z"/></svg>';
const ICON_BED =
  '<svg viewBox="0 0 24 24"><path d="M3 13h18v3H3zm2 4h3v3H5zm11 0h3v3h-3z"/><path d="M7 4c0 2-2 2-2 4h2c0-2 2-2 2-4zm5 0c0 2-2 2-2 4h2c0-2 2-2 2-4zm5 0c0 2-2 2-2 4h2c0-2 2-2 2-4z"/></svg>';

function tempRow(label, sub, cur, target, active, icon) {
  const heat = target > 0 ? Math.max(0, Math.min(1, cur / target)) : 0;
  return `<div class="grow-row${active ? " active" : ""}">
    <span class="ic">${icon}</span>
    <span class="k">${esc(label)}${sub ? `<span class="sub">${esc(sub)}</span>` : ""}</span>
    <span class="heat"><i style="width:${(heat * 100).toFixed(0)}%"></i></span>
    <span class="v"><b>${fmtDec(cur, 1)} °C</b>
      <span>${target > 0 ? "→ " + Math.round(target) + " °C" : esc(tr("printers.not_heating"))}</span></span>
  </div>`;
}

/* Animates the illustration with live data: active head highlighted, spool
   and tube colors, heat, part growing. */
const HEADS = [[103, 71], [126, 63], [150, 54], [173, 46]];

function paintPrinter(st) {
  const pv = $("pv");
  if (!pv) return;
  const printing = st.online && st.state === "printing";
  pv.classList.toggle("printing", printing);
  pv.classList.toggle("off", !st.online);

  const fil = (i) => (st.filaments || []).find((f) => f.index === i);
  const colorOf = (i) => {
    const f = fil(i);
    return f && f.present && f.color ? f.color : null;
  };
  const noz = (i) => (st.nozzles || []).find((n) => n.index === i);
  const act = (st.nozzles || []).find((n) => n.active);
  const ai = st.online && act ? act.index : -1;

  $("pv-lamp").setAttribute("opacity", st.online ? (printing ? 0.16 : 0.07) : 0);

  pv.querySelectorAll(".pv-head").forEach((h) => {
    const i = +h.dataset.i;
    h.classList.toggle("on", i === ai);
    // Without information, show the U1's four heads.
    h.style.display = !st.nozzles?.length || noz(i) ? "" : "none";
  });
  pv.querySelectorAll(".pv-chip").forEach((c) => {
    c.style.fill = colorOf(+c.dataset.i) || "";
  });
  pv.querySelectorAll(".pv-spool").forEach((s) => {
    s.style.fill = colorOf(+s.dataset.i) || "";
  });
  pv.querySelectorAll(".pv-tube").forEach((t) => {
    t.style.stroke = colorOf(+t.dataset.i) || "";
  });

  // Active head: glow, label and leader line.
  const badge = $("pv-badge");
  if (ai >= 0) {
    const [x, y] = HEADS[ai];
    $("pv-glow").setAttribute("cx", x);
    $("pv-glow").setAttribute("cy", y + 8);
    $("pv-glow").setAttribute("opacity", 1);
    badge.setAttribute("opacity", 1);
    badge.querySelector("rect").setAttribute("x", x - 22);
    const t = badge.querySelector("text");
    t.setAttribute("x", x);
    t.textContent = "T" + ai;
    badge.querySelector(".pv-badge-line").setAttribute("d", `M${x} 33 L${x} ${y - 10}`);

    const n = noz(ai);
    const heat = n ? Math.max(0, Math.min(1, (n.current - 40) / 180)) : 0;
    $("pv-heat").setAttribute("cx", x);
    $("pv-heat").setAttribute("cy", y + 20);
    $("pv-heat").setAttribute("opacity", (heat * 0.95).toFixed(2));
  } else {
    $("pv-glow").setAttribute("opacity", 0);
    $("pv-heat").setAttribute("opacity", 0);
    badge.setAttribute("opacity", 0);
  }

  const bed = st.bed ? Math.max(0, Math.min(1, (st.bed.current - 30) / 60)) : 0;
  $("pv-bedglow").setAttribute("opacity", (bed * 0.8).toFixed(2));

  // The part grows on the bed, in the color of the filament in use.
  const h = st.job && st.progress != null ? 4 + st.progress * 40 : 0;
  const obj = $("pv-obj");
  obj.setAttribute("d", `M181 ${(172 - h).toFixed(1)} L206 ${(163 - h).toFixed(1)} L206 163 L181 172 Z`);
  obj.style.fill = (ai >= 0 && colorOf(ai)) || "";

  $("pv-screen").setAttribute(
    "class",
    st.online ? (printing ? "busy" : st.state === "error" ? "err" : "ok") : ""
  );
}

/* ------------------------------------------------------------ polling */

async function pollOne(p) {
  try {
    const st = await invoke("printer_status", { host: p.host, port: p.port });
    P.status.set(p.id, st);
    P.seen.set(p.id, Date.now());
  } catch {
    P.status.set(p.id, { online: false, state: "offline", message: tr("printers.internal_error") });
  }
}

async function refreshSelected() {
  const p = current();
  if (!p) return;
  await pollOne(p);
  if (current()?.id === p.id) {
    renderStatus(P.status.get(p.id));
    prnRenderList();
  }
}

/* Live feed: the printer pushes its changes over WebSocket (Moonraker
   JSON-RPC). Connections only live while this tab is shown. */
function startLive() {
  invoke("printers_watch_start").catch((e) => toast(String(e), true));
  // Refreshes the "… ago" timestamp without any network traffic.
  clearInterval(P.timer);
  P.timer = setInterval(() => {
    if (current()) updateFreshness();
  }, 1000);
}

function stopLive() {
  invoke("printers_watch_stop").catch(() => {});
  clearInterval(P.timer);
  P.timer = null;
  P.live.clear();
}

listen("printer-status", (e) => {
  const { id, live, status } = e.payload;
  P.status.set(id, status);
  P.live.set(id, live);
  if (live) P.seen.set(id, Date.now());
  prnRenderList();
  if (id === P.sel) renderStatus(status);
  // The camera's printer gone: said over the camera, wherever it shows.
  camPrinterStatus(id, status.online);
});

/* Time of the last data: time only today, date and time otherwise
   (an "at 21:36" after a night is ambiguous). */
function fmtSeen(seen) {
  const d = new Date(seen);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(locale())
    : d.toLocaleString(locale(), { dateStyle: "short", timeStyle: "medium" });
}

function setOfflineSeen(seen) {
  $("prn-offline-seen").textContent = seen ? tr("printers.offline.last_seen", { time: fmtSeen(seen) }) : "";
}

function updateFreshness() {
  const seen = P.seen.get(P.sel);
  const live = P.live.get(P.sel);
  const st = P.status.get(P.sel);
  // The footer, and its copy in the 3D view's details (printer3d.js).
  const say = (t) => {
    $("prn-updated").textContent = t;
    $("p3d-fresh").textContent = t;
  };
  // Offline: the card carries the last-connection time, no footer.
  if (st && !st.online) {
    say("");
    setOfflineSeen(seen);
    return;
  }
  if (!seen) {
    say(live ? tr("printers.live.connecting") : "");
    return;
  }
  const age = Math.round((Date.now() - seen) / 1000);
  // Printer answering HTTP but live feed down: the data may be stale.
  say(live ? tr("printers.live.age", { s: age }) : tr("printers.live.offline", { time: fmtSeen(seen) }));
}

/* ------------------------------------------------------------ form */

/* ------------------------------------------------- network search */

/* "On the network" list, shared by the add sheet and the welcome assistant:
   one search at a time, shown in the last list opened. Printers arrive as
   they answer, one per address. */
/* `search` numbers each search: a stopped one may still report a printer
   or its end while the next runs, and those are ignored. */
const DISC = { items: new Map(), running: false, error: null, picked: null, view: null, search: 0 };

function discoveryList(box, onPick) {
  DISC.view = { box, onPick };
  box.classList.add("disc");
  box.innerHTML = `<div class="disc-head">
      <span class="disc-title">${esc(tr("disc.title"))}</span>
      <span class="disc-state"></span>
      <button class="btn small disc-again hidden">${esc(tr("disc.again"))}</button>
    </div>
    <div class="disc-list"></div>`;
  box.querySelector(".disc-again").onclick = discoverStart;
  discoverStart();
}

async function discoverStart() {
  DISC.items.clear();
  DISC.picked = null;
  DISC.error = null;
  DISC.running = true;
  const search = ++DISC.search;
  discRender();
  try {
    await invoke("printer_discover_start", { search });
  } catch (e) {
    if (search !== DISC.search) return; // another search has started since
    DISC.running = false;
    DISC.error = String(e);
    discRender();
  }
}

function discoverStop() {
  if (DISC.running) invoke("printer_discover_stop").catch(() => {});
  DISC.running = false;
  DISC.view = null;
}

/* Model suggested for a printer found. */
const discModel = (f) => f.model || (f.service === "snapmaker" ? "Snapmaker U1" : "Klipper / Moonraker");

/* A found printer's address: its host, and its port when the address
   carries one ("host:port", printers sharing an address); Moonraker's
   usual port otherwise. */
function discAddr(f) {
  const m = /^([^:]+):(\d+)$/.exec(f.ip);
  return m ? { host: m[1], port: +m[2] } : { host: f.ip, port: 7125 };
}

/* Already saved: same address. */
const discKnown = (f) => {
  const a = discAddr(f);
  return P.list.some((p) => p.host === f.ip || (p.host === a.host && p.port === a.port));
};

listen("printer-found", (e) => {
  const { search, printer: f } = e.payload;
  if (search !== DISC.search) return; // a stopped search, still winding down
  const prev = DISC.items.get(f.ip);
  // A U1 sometimes announces itself twice (Snapmaker and Moonraker): the
  // richer Snapmaker record wins.
  if (prev?.service === "snapmaker" && f.service !== "snapmaker") return;
  DISC.items.set(f.ip, f);
  discRender();
});
listen("printer-discover-done", (e) => {
  if (e.payload?.search !== DISC.search) return;
  DISC.running = false;
  discRender();
});

function discRender() {
  const v = DISC.view;
  if (!v) return;
  v.box.querySelector(".disc-title").textContent = tr("disc.title");
  v.box.querySelector(".disc-again").textContent = tr("disc.again");
  const items = [...DISC.items.values()].sort((a, b) => collate(a.name, b.name));
  const st = v.box.querySelector(".disc-state");
  st.innerHTML = DISC.running
    ? `<span class="spinner small"></span>${esc(tr("disc.searching"))}`
    : items.length
      ? esc(tr("disc.found", { n: items.length }))
      : "";
  v.box.querySelector(".disc-again").classList.toggle("hidden", DISC.running);
  const list = v.box.querySelector(".disc-list");
  if (!items.length) {
    list.innerHTML = DISC.running
      ? ""
      : `<div class="disc-empty">${esc(DISC.error || tr("disc.none"))}</div>`;
    return;
  }
  list.innerHTML = "";
  for (const f of items) {
    const known = discKnown(f);
    const el = document.createElement("button");
    el.className = "disc-item" + (DISC.picked === f.ip ? " on" : "");
    el.disabled = known;
    const sub = [f.ip, discModel(f), f.firmware && tr("disc.firmware", { v: f.firmware })].filter(Boolean).join(" · ");
    el.innerHTML = `<span class="glyph">${SIDE_PRINTER}</span>
      <span class="disc-text"><b>${esc(f.name)}</b><small>${esc(sub)}</small></span>
      ${known ? `<span class="disc-tag">${esc(tr("disc.known"))}</span>` : ""}`;
    el.onclick = () => {
      DISC.picked = f.ip;
      discRender();
      v.onPick(f);
    };
    list.appendChild(el);
  }
}

function openForm(printer) {
  P.editing = printer || null;
  $("pmodal-title").textContent = tr(printer ? "printers.edit_title" : "printers.add");
  $("pf-name").value = printer?.name || "";
  $("pf-host").value = printer?.host || "";
  $("pf-port").value = printer?.port || 7125;
  $("pf-model").value = printer?.model || "Snapmaker U1";
  $("pf-test").textContent = "";
  $("pf-test").className = "pf-test";
  // The search is only for adding.
  $("pf-disc").classList.toggle("hidden", !!printer);
  if (!printer) {
    discoveryList($("pf-disc"), (f) => {
      const a = discAddr(f);
      $("pf-name").value = f.name;
      $("pf-host").value = a.host;
      $("pf-port").value = a.port;
      $("pf-model").value = discModel(f);
      probeForm();
    });
  }
  openSheet($("pmodal"));
  setTimeout(() => $("pf-host").focus(), 30);
}

function closeForm() {
  discoverStop();
  closeSheet($("pmodal"));
  P.editing = null;
}

/* The port typed, 1 to 65535 (the field's `max` is not enforced while
   typing, and Rust refuses anything else), or null. */
function portOf(input) {
  const n = Math.round(+input.value || 7125);
  return n >= 1 && n <= 65535 ? n : null;
}

async function probeForm() {
  const host = $("pf-host").value.trim();
  if (!host) return;
  const box = $("pf-test");
  const port = portOf($("pf-port"));
  if (!port) {
    box.className = "pf-test err";
    box.textContent = tr("printers.form.port_invalid");
    return;
  }
  box.className = "pf-test";
  box.textContent = tr("printers.form.testing");
  // A slow answer for a host typed before must not fill in the fields now.
  const seq = (P.probeSeq = (P.probeSeq || 0) + 1);
  let r;
  try {
    r = await invoke("printer_probe", { host, port });
  } catch (e) {
    r = { ok: false, detail: String(e) };
  }
  if (seq !== P.probeSeq) return;
  box.className = "pf-test " + (r.ok ? "ok" : "err");
  box.textContent = r.detail;
  if (r.ok) {
    $("pf-port").value = r.port;
    if (!$("pf-name").value.trim() && r.hostname) $("pf-name").value = r.hostname;
  }
}

async function saveForm() {
  const host = $("pf-host").value.trim();
  if (!host) {
    $("pf-test").className = "pf-test err";
    $("pf-test").textContent = tr("printers.form.host_missing");
    return;
  }
  const printer = {
    id: P.editing?.id || "",
    name: $("pf-name").value.trim() || host,
    host,
    port: +$("pf-port").value || 7125,
    model: $("pf-model").value.trim(),
    note: P.editing?.note || "",
  };
  try {
    P.list = await invoke("printer_save", { printer });
    const saved = P.list.find((x) => x.host === printer.host && x.port === printer.port);
    const edited = !!P.editing; // closeForm forgets it
    closeForm();
    await prnLoad(printer.id || saved?.id);
    switchView("printers");
    toast(tr(edited ? "printers.updated" : "printers.added"));
  } catch (e) {
    toast(tr("printers.form.save_failed", { err: e }), true);
  }
}

/* context menu of a printer in the sidebar */
onMenu("prn", (arg) => {
  const i = arg.indexOf(":");
  const what = arg.slice(0, i), id = arg.slice(i + 1);
  const p = P.list.find((x) => x.id === id);
  if (!p) return;
  if (what === "edit") openForm(p);
  if (what === "remove") askRemove(p);
});

/* Removal: confirmed by a native alert. */
async function askRemove(target) {
  const p = target && target.id ? target : current();
  if (!p) return;
  const ok = await confirmDelete(
    tr("printers.remove.title", { name: p.name || p.host }),
    tr("printers.remove.text")
  );
  if (!ok) return;
  invoke("printer_remove", { id: p.id })
    .then(() => {
      P.status.delete(p.id);
      if (P.sel === p.id) P.sel = null;
      return prnLoad();
    })
    .then(() => toast(tr("printers.removed")))
    .catch((e) => toast(String(e), true));
}

/* ------------------------------------------------------------ camera */

/* The camera (camera.js) on this page: the 3D view's corner, else the
   Camera section, for the printer shown. */
function prnCamHome() {
  if (window.currentView !== "printers") return;
  const p = current();
  if (!p) return camHome(null);
  const home = $("prn-detail").classList.contains("p3d-on") ? $("p3d") : document.querySelector("#prn-detail .group.cam");
  camHome(home, p.id, { enlarge: true });
}
// The Camera section's switch, and the 3D view's button, say its state.
document.addEventListener("cam-change", () => {
  $("cam-toggle").checked = CAM.on && CAM.id === P.sel;
  prnCamSection();
  if (window.currentView === "printers" && typeof p3dQuick === "function" && typeof P3 !== "undefined" && P3.pid) p3dQuick();
});
$("cam-toggle").addEventListener("change", () => ($("cam-toggle").checked ? camStart(P.sel) : camStop()));
// The pinned window's image leads back to its printer's page.
function camOpenPrinter() {
  if (!CAM.id) return;
  P.sel = CAM.id;
  prnRenderDetail();
  switchView("printers");
  prnRenderList();
  refreshSelected();
}

/* ------------------------------------------------------------ events */

$("prn-add").addEventListener("click", () => openForm(null));
$("prn-add2").addEventListener("click", () => openForm(null));
$("prn-add3").addEventListener("click", () => openForm(null));
$("prn-edit").addEventListener("click", () => openForm(current()));
// The printer card's shortcut to Care & Tuning › Control, through its
// opening (ctlOpen, as the quick panels' "All controls" will).
$("prn-control").addEventListener("click", () => current() && ctlOpen(current().id));
$("prn-del").addEventListener("click", () => askRemove());
$("prn-refresh").addEventListener("click", () => { refreshSelected(); startLive(); });
$("prn-offline-retry").addEventListener("click", () => { refreshSelected(); startLive(); });
$("pf-cancel").addEventListener("click", closeForm);
$("pf-probe").addEventListener("click", probeForm);
$("pf-save").addEventListener("click", saveForm);
$("pmodal").addEventListener("keydown", (e) => {
  // Enter in a field saves; on a button (Cancel, Test, a found printer)
  // it is that button's click, not a save.
  if (e.key === "Enter" && !e.target.closest("button")) saveForm();
  if (e.key === "Escape") closeForm();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("pmodal").classList.contains("hidden")) closeForm();
});

window.addEventListener("langchange", () => {
  tbDefaults();
  prnRenderList();
  prnRenderDetail();
  discRender();
  if (!$("pmodal").classList.contains("hidden")) $("pmodal-title").textContent = tr(P.editing ? "printers.edit_title" : "printers.add");
});

prnLoad();

$("prn-filaments").addEventListener("click", (e) => {
  if (e.target.closest("[data-heads-open]") && P.sel) headsShow(P.sel);
});
window.addEventListener("headschange", (e) => {
  if (window.currentView === "printers" && P.sel && (!e.detail?.pid || e.detail.pid === P.sel) && P.status.get(P.sel)) renderStatus(P.status.get(P.sel));
});
