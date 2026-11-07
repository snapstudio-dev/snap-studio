"use strict";
/* A printer's files (sidebar: Printer › Files): the print files Snap Studio
   or another slicer sent to it, and the timelapse videos its camera made.
   Everything is read from Moonraker by printer_files.rs; pictures and videos
   come through the prn: protocol (lib.rs), video by pieces. Pure logic:
   pfiles-logic.js. */

const PFL = {
  pid: null,
  data: null,
  err: null,
  loading: false,
  seq: 0,
  tab: "files",
  view: "list",
  sort: "date",
  desc: true,
  q: "",
  sel: null,
  detail: false,
  selMode: false,
  picked: new Set(),
  // Shift-click's start, outside Select mode.
  anchor: null,
  player: null,
  busy: false,
  // What the context menu acts on: one file, or every picked one.
  menuKeys: [],
  durations: new Map(),
  counts: new Map(),
  countAt: new Map(),
};

const PFL_PREFS = "snapstudio.pfiles";
try {
  const p = JSON.parse(localStorage.getItem(PFL_PREFS) || "{}");
  if (["files", "videos"].includes(p.tab)) PFL.tab = p.tab;
  if (["list", "grid"].includes(p.view)) PFL.view = p.view;
  if (PFL_SORTS.includes(p.sort)) PFL.sort = p.sort;
  if (typeof p.desc === "boolean") PFL.desc = p.desc;
} catch {}
const pflSave = () => localStorage.setItem(PFL_PREFS, JSON.stringify({ tab: PFL.tab, view: PFL.view, sort: PFL.sort, desc: PFL.desc }));

const PFL_SORT_LABELS = { date: "pfiles.sort.date", name: "pfiles.sort.name", duration: "pfiles.sort.duration", size: "pfiles.sort.size" };
const PFL_LAST = {
  completed: ["pfiles.last.completed", "ok"],
  cancelled: ["pfiles.last.cancelled", ""],
  error: ["pfiles.last.error", "err"],
  klippy_shutdown: ["pfiles.last.error", "err"],
  interrupted: ["pfiles.last.interrupted", "err"],
  in_progress: ["pfiles.last.in_progress", "busy"],
};
/* Placeholders when a file has no picture (or it does not load). */
const PFL_ICON_FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"><path d="M6 2.75h8.25L19 7.5v12.25a1.5 1.5 0 0 1-1.5 1.5h-11.5a1.5 1.5 0 0 1-1.5-1.5V4.25A1.5 1.5 0 0 1 6 2.75z"/><path d="M14 2.75V7.5h5"/><path d="M12 10.5l-3.75 2.1v4.2L12 18.9l3.75-2.1v-4.2zM8.25 12.6 12 14.7l3.75-2.1M12 14.7v4.2"/></svg>';
const PFL_ICON_FILM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"><rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7 4.5v15M17 4.5v15M3 8.5h4M3 12h4M3 15.5h4M17 8.5h4M17 12h4M17 15.5h4"/><path d="M10.5 9.75v4.5l3.75-2.25z" fill="currentColor"/></svg>';
const PFL_PH = { file: PFL_ICON_FILE, film: PFL_ICON_FILM };
/* An error said on this page: without the URLs it carries (errNoUrl,
   control-logic.js); the raw one goes to the console. */
function pflErr(e, what) {
  const raw = String(e?.message || e || "");
  console.warn("printer files", what, raw);
  return errNoUrl(raw);
}
const PFL_ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const PFL_ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>';

const pflPrinter = () => (typeof P !== "undefined" ? P.list.find((p) => p.id === PFL.pid) : null) || null;
const pflUrl = (root, path) => schemeUrl("prn", pflPrnQuery(PFL.pid, root, path));
const pflList = () => (PFL.data ? (PFL.tab === "files" ? PFL.data.files : PFL.data.videos) : []);
const pflFind = (key) => (PFL.data ? [...PFL.data.files, ...PFL.data.videos].find((f) => pflKey(f) === key) : null) || null;
const pflShown = () => pflSort(pflList().filter((f) => pflMatches(f, PFL.q)), PFL.sort, PFL.desc, PFL.durations);
const pflThumb = (f) => {
  const t = f.meta ? f.meta.thumb : f.thumb;
  return t ? pflUrl(f.root, t) : null;
};
const pflWhy = (reason) => (reason === "printing" ? tr("pfiles.why.printing") : "");
const pflOpen = () => !$("view-pfiles").classList.contains("hidden");

/* ------------------------------------------------------------ entry */

function pflShow(pid) {
  if (PFL.pid !== pid) {
    pflClosePlayer();
    Object.assign(PFL, { pid, data: null, err: null, sel: null, detail: false, selMode: false, picked: new Set(), anchor: null, q: "" });
    $("pfl-q").value = "";
  }
  switchView("pfiles");
  pflLoad();
}

async function pflLoad() {
  const pid = PFL.pid, seq = ++PFL.seq;
  if (!pid) return;
  PFL.loading = true;
  pflRender();
  try {
    const data = await invoke("pf_overview", { printerId: pid });
    if (seq !== PFL.seq) return;
    PFL.data = data;
    PFL.err = null;
    PFL.counts.set(pid, data.files.length);
    PFL.countAt.set(pid, Date.now());
    // What is no longer there is no longer selected.
    const keys = new Set([...data.files, ...data.videos].map(pflKey));
    if (PFL.sel && !keys.has(PFL.sel)) Object.assign(PFL, { sel: null, detail: false });
    PFL.picked = new Set([...PFL.picked].filter((k) => keys.has(k)));
    // Outside Select mode, print files picked are two or more: one left is
    // the selected file.
    if (!PFL.selMode && PFL.tab === "files" && PFL.picked.size === 1) {
      PFL.sel = [...PFL.picked][0];
      PFL.picked = new Set();
    }
    if (PFL.player && !keys.has(PFL.player)) pflClosePlayer();
  } catch (e) {
    if (seq !== PFL.seq) return;
    // No answer, or an answer that is an error: said apart (pflRender).
    PFL.err = String(e?.message || e || "error");
    console.warn("printer files", "pf_overview", PFL.err);
  } finally {
    if (seq === PFL.seq) PFL.loading = false;
  }
  pflRender();
  pflSideCounts();
  pflDurations(seq);
}

/* Stops the video when the view is left. */
function pflLeave() {
  pflClosePlayer();
}

/* ------------------------------------------------------------ sidebar */

/* The count of print files under each printer. Asked again at most every
   minute, and only of printers that answer. */
function pflSideCounts() {
  document.querySelectorAll("#side-printers [data-pfiles]").forEach((b) => {
    const id = b.dataset.pfiles;
    const n = PFL.counts.get(id);
    b.querySelector(".count").textContent = n ? String(n) : "";
    const st = typeof P !== "undefined" ? P.status.get(id) : null;
    if (st?.online && Date.now() - (PFL.countAt.get(id) || 0) > 60000) {
      PFL.countAt.set(id, Date.now());
      invoke("pf_count", { printerId: id })
        .then((c) => {
          PFL.counts.set(id, c);
          pflSideCounts();
        })
        .catch(() => {});
    }
  });
}

/* ------------------------------------------------------------ rendering */

function pflHeader() {
  const list = pflList();
  let sub = "";
  if (PFL.data) {
    const s = pflSummary(list, PFL.data.disk);
    sub = tr(PFL.tab === "files" ? "pfiles.summary.files" : "pfiles.summary.videos", { n: s.count, size: fmtSize(s.bytes) });
    if (s.free != null) sub += " · " + tr("pfiles.summary.free", { size: fmtSize(s.free) });
  }
  tbSet("pfiles", `${printerName(PFL.pid)} › ${tr("pfiles.title")}`, sub);
  document.querySelectorAll("#pfl-tabs .seg-btn").forEach((b) => {
    b.classList.toggle("on", b.dataset.tab === PFL.tab);
    b.setAttribute("aria-pressed", String(b.dataset.tab === PFL.tab));
  });
  document.querySelectorAll("#pfl-layout .seg-btn").forEach((b) => {
    b.classList.toggle("on", b.dataset.layout === PFL.view);
    b.setAttribute("aria-pressed", String(b.dataset.layout === PFL.view));
  });
  $("pfl-layout").classList.toggle("hidden", PFL.tab !== "files");
  $("pfl-select").classList.toggle("hidden", !pflList().length);
  $("pfl-select").classList.toggle("on", PFL.selMode);
  $("pfl-select").setAttribute("aria-pressed", String(PFL.selMode));
}

function pflState(icon, title, text, action, detail) {
  return `<div class="empty"><div class="empty-art">${icon}</div><h1>${esc(title)}</h1>${text ? `<p>${esc(text)}</p>` : ""}${detail ? `<p class="det-sub">${esc(detail)}</p>` : ""}${
    action ? `<div class="empty-actions"><button class="btn" data-act="${action.id}">${esc(action.label)}</button></div>` : ""
  }</div>`;
}

function pflRender() {
  if (!PFL.pid) return;
  pflHeader();
  const main = $("pfl-main");
  if (!PFL.data) {
    // The printer does not answer, or answered with an error (said without
    // its address): one line, as on the printer's other screens.
    main.innerHTML = PFL.err
      ? offlineLine(errUnreachable(PFL.err) ? tr("printers.no_answer", { name: printerName(PFL.pid) }) : tr("pfiles.load_err", { err: errNoUrl(PFL.err) }), 'data-act="retry"')
      : `<div class="loading"><div class="spinner"></div>${esc(tr("pfiles.loading"))}</div>`;
    pflRenderDetail();
    pflRenderSelbar();
    return;
  }
  const all = pflList();
  const shown = pflShown();
  let html = "";
  // A refresh that failed: the list shown is the last one read.
  if (PFL.err) {
    const note = errUnreachable(PFL.err) ? tr("pfiles.stale", { name: printerName(PFL.pid) }) : tr("pfiles.stale_err", { err: errNoUrl(PFL.err) });
    html += offlineLine(note, 'data-act="retry"');
  }
  if (!all.length) {
    html += PFL.tab === "files"
      ? pflState(PFL_ICON_FILE, tr("pfiles.empty.files"), tr("pfiles.empty.files_hint"))
      : pflState(PFL_ICON_FILM, tr("pfiles.empty.videos"), tr("pfiles.empty.videos_hint", { option: tr("send.timelapse") }));
  } else if (!shown.length) {
    html += pflState(PFL_ICON_FILE, tr("pfiles.no_match"), tr("pfiles.no_match_hint", { q: PFL.q.trim() }));
  } else if (PFL.tab === "files") {
    html += PFL.view === "grid" ? pflFilesGrid(shown) : pflFilesList(shown);
  } else {
    html += pflVideosGrid(shown);
  }
  main.innerHTML = html;
  main.classList.toggle("busy", PFL.loading);
  pflRenderDetail();
  pflRenderSelbar();
}

function pflDots(meta) {
  return pflFilaments(meta)
    .map((f) => `<span class="swatch" style="background:${esc(f.color || "#8E8E93")}" title="${esc(`T${f.tool}${f.type ? " · " + f.type : ""}`)}"></span>`)
    .join("");
}
const pflGrams = (meta) => fmtWeight(meta?.filament_weight_total ?? null) || "";
/* The picture, or the placeholder; a picture that fails to load is
   replaced by it too (listener below: no inline handler under the CSP). */
const pflPh = (kind) => `<span class="pfl-ph" data-ph="${kind}">${PFL_PH[kind]}</span>`;
const pflImg = (f, kind, lazy = true) => {
  const src = pflThumb(f);
  return src ? `<img src="${esc(src)}" alt="" ${lazy ? 'loading="lazy" ' : ""}draggable="false" data-ph="${kind}" />` : pflPh(kind);
};
const pflCheck = (k) =>
  PFL.selMode ? `<input type="checkbox" class="pfl-check" tabindex="-1" aria-label="${esc(tr("pfiles.pick"))}"${PFL.picked.has(k) ? " checked" : ""} />` : "";
/* Picks outside Select mode (Ctrl/Cmd or Shift-click) show as a selection. */
const pflItemSel = (k) => (PFL.selMode || PFL.picked.size ? PFL.picked.has(k) : PFL.sel === k);
const pflItemCls = (k) => (pflItemSel(k) ? (PFL.selMode ? " picked" : " on") : "");
const pflPrintingTag = (f) => (PFL.data.printing && pflCanChange(f, PFL.data.printing).reason === "printing" ? `<span class="pfl-tag busy">${esc(tr("pfiles.printing"))}</span>` : "");

function pflFilesList(list) {
  const head = (k, label) => `<span class="sortable${PFL.sort === k ? " on" : ""}" data-sort="${k}">${esc(label)}${PFL.sort === k ? (PFL.desc ? " ↓" : " ↑") : ""}</span>`;
  return `<div class="pfl-list${PFL.selMode ? " picking" : ""}" role="listbox" aria-multiselectable="${PFL.selMode}" aria-label="${esc(tr("pfiles.tab.files"))}">
    <div class="pfl-lhead"><span></span>${head("name", tr("pfiles.col.name"))}${head("date", tr("pfiles.col.sent"))}${head("duration", tr("pfiles.col.duration"))}<span>${esc(tr("pfiles.col.filament"))}</span>${head("size", tr("pfiles.col.size"))}</div>
    ${list
      .map((f) => {
        const k = pflKey(f);
        return `<div class="pfl-row${pflItemCls(k)}" data-k="${esc(k)}" role="option" aria-selected="${pflItemSel(k)}" tabindex="-1">
          <span class="pfl-th">${pflImg(f, "file")}${pflCheck(k)}</span>
          <span class="pfl-name"><b title="${esc(f.path)}">${esc(pflName(f.path))}</b>${pflPrintingTag(f)}</span>
          <span class="pfl-c">${esc(fmtDate(f.modified))}</span>
          <span class="pfl-c">${esc(fmtDuration(f.meta?.estimated_time ?? null) || "—")}</span>
          <span class="pfl-fil">${pflDots(f.meta)}<span>${esc(pflGrams(f.meta))}</span></span>
          <span class="pfl-c">${esc(fmtSize(f.size))}</span>
        </div>`;
      })
      .join("")}
  </div>`;
}

function pflFilesGrid(list) {
  return `<div class="pfl-grid${PFL.selMode ? " picking" : ""}" role="listbox" aria-multiselectable="${PFL.selMode}" aria-label="${esc(tr("pfiles.tab.files"))}">${list
    .map((f) => {
      const k = pflKey(f);
      const line = [fmtDuration(f.meta?.estimated_time ?? null), pflGrams(f.meta)].filter(Boolean).join(" · ");
      return `<div class="pfl-card${pflItemCls(k)}" data-k="${esc(k)}" role="option" aria-selected="${pflItemSel(k)}" tabindex="-1">
        <div class="pfl-cth">${pflImg(f, "file")}${pflPrintingTag(f)}${pflCheck(k)}</div>
        <div class="pfl-cname" title="${esc(f.path)}">${esc(pflName(f.path))}</div>
        <div class="pfl-csub"><span class="pfl-fil">${pflDots(f.meta)}</span><span>${esc(line || fmtSize(f.size))}</span></div>
      </div>`;
    })
    .join("")}</div>`;
}

function pflVideosGrid(list) {
  return `<div class="pfl-grid videos${PFL.selMode ? " picking" : ""}" role="listbox" aria-multiselectable="${PFL.selMode}" aria-label="${esc(tr("pfiles.tab.videos"))}">${list
    .map((v) => {
      const k = pflKey(v);
      const d = PFL.durations.get(k);
      const picked = PFL.picked.has(k);
      return `<div class="pfl-card video${picked ? " picked" : ""}" data-k="${esc(k)}" role="option" aria-selected="${picked}" tabindex="-1">
        <div class="pfl-cth">${pflImg(v, "film")}<span class="pfl-dur${d ? "" : " hidden"}">${d ? pflClock(d) : ""}</span>${
          PFL.selMode ? pflCheck(k) : `<span class="pfl-playmark">${PFL_ICON_PLAY}</span>`
        }</div>
        <div class="pfl-cname" title="${esc(v.path)}">${esc(pflVideoTitle(v))}</div>
        <div class="pfl-csub"><span>${esc(fmtDate(pflVideoDate(v)))}</span><span>${esc(fmtSize(v.size))}</span></div>
      </div>`;
    })
    .join("")}</div>`;
}

/* ------------------------------------------------------------ detail */

function pflRenderDetail() {
  const aside = $("pfl-detail");
  const f = PFL.detail && PFL.tab === "files" ? pflFind(PFL.sel) : null;
  aside.classList.toggle("hidden", !f);
  $("view-pfiles").classList.toggle("with-detail", !!f);
  if (!f) return;
  const m = f.meta || {};
  const can = pflCanChange(f, PFL.data.printing);
  const row = (k, v) => (v == null || v === "" ? "" : `<dt>${esc(tr(k))}</dt><dd>${esc(v)}</dd>`);
  const fils = pflFilaments(f.meta)
    .map((x) => `<div class="fil"><span class="swatch" style="background:${esc(x.color || "#8E8E93")}"></span><span>T${x.tool}${x.type ? " · " + esc(x.type) : ""}</span><span class="g">${esc(fmtWeight(x.grams) || "")}</span></div>`)
    .join("");
  let last = `<p class="det-sub">${esc(tr("pfiles.last.never"))}</p>`;
  if (f.last) {
    const [key, cls] = PFL_LAST[f.last.status] || ["pfiles.last.unknown", ""];
    last = `<dl class="info"><dt>${esc(tr("pfiles.last.result"))}</dt><dd><span class="pfl-tag ${cls}">${esc(tr(key))}</span></dd>${row("pfiles.last.date", f.last.end_time ? fmtDate(f.last.end_time) : null)}${row("pfiles.last.took", f.last.duration ? fmtDuration(f.last.duration) : null)}</dl>`;
  }
  const thumb = pflThumb(f);
  aside.innerHTML = `
    <div class="pfl-dhead"><button class="tb-btn" data-act="close-detail" title="${esc(tr("common.close"))}" aria-label="${esc(tr("common.close"))}"><svg viewBox="0 0 24 24"><path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4z"/></svg></button></div>
    <div class="det-preview">${thumb ? `<img src="${esc(thumb)}" alt="" draggable="false" data-ph="file" />` : pflPh("file")}</div>
    <h2>${esc(pflName(f.path))}</h2>
    <div class="det-sub" title="${esc(f.path)}">${esc(f.path)}</div>
    <div class="det-actions">
      <button class="btn primary" data-act="print">${esc(tr("pfiles.print"))}</button>
      <button class="btn" data-act="download"${PFL.busy ? " disabled" : ""}>${esc(tr("common.download"))}</button>
      <button class="btn" data-act="share">${esc(tr("share.button"))}</button>
      <button class="btn danger" data-act="delete"${can.ok && !PFL.busy ? "" : " disabled"} title="${esc(can.ok ? tr("common.delete") : pflWhy(can.reason))}">${esc(tr("common.delete"))}</button>
    </div>
    ${can.ok ? "" : `<p class="pfl-why">${esc(pflWhy(can.reason))}</p>`}
    <dl class="info">${row("pfiles.col.sent", fmtDate(f.modified))}${row("pfiles.col.size", fmtSize(f.size))}${row("pfiles.meta.time", m.estimated_time ? fmtDuration(m.estimated_time) : null)}${row(
      "pfiles.meta.filament",
      pflGrams(f.meta)
    )}${row("pfiles.meta.layer", m.layer_height ? `${fmtDec(m.layer_height, 2)} mm` : null)}${row("pfiles.meta.layers", m.layer_count ? fmtNum(m.layer_count) : null)}${row(
      "pfiles.meta.height",
      m.object_height ? `${fmtDec(m.object_height, 1)} mm` : null
    )}${row("pfiles.meta.nozzle", m.nozzle_diameter ? `${fmtDec(m.nozzle_diameter, 1)} mm` : null)}${row("pfiles.meta.slicer", [m.slicer, m.slicer_version].filter(Boolean).join(" ") || null)}</dl>
    ${fils ? `<div class="set-section">${esc(tr("pfiles.meta.tools"))}</div><div class="filaments">${fils}</div>` : ""}
    <div class="set-section">${esc(tr("pfiles.last.title"))}</div>
    ${last}`;
}

/* ------------------------------------------------------------ selection bar */

function pflRenderSelbar() {
  const bar = $("pfl-selbar");
  // One print file selected (not in Select mode, its panel closed): the
  // same bar, with that file's actions.
  const one = !PFL.selMode && !PFL.picked.size && PFL.tab === "files" && !PFL.detail && !PFL.player && PFL.data ? pflFind(PFL.sel) : null;
  // Files picked by Ctrl/Cmd or Shift-click: the Select mode bar,
  // without Select all and Done (Esc or a plain click ends it).
  const loose = !PFL.selMode && PFL.picked.size > 0;
  const on = ((PFL.selMode || loose) && !!PFL.data && !PFL.player) || !!one;
  bar.classList.toggle("hidden", !on);
  bar.classList.toggle("single", !!one);
  // One file: its actions only, the selected row already says which.
  $("pfl-selcount").classList.toggle("hidden", !!one);
  for (const id of ["pfl-selall", "pfl-seldone"]) $(id).classList.toggle("hidden", !!one || loose);
  for (const id of ["pfl-selprint", "pfl-selshare", "pfl-selren"]) $(id).classList.toggle("hidden", !one);
  if (!on) return;
  if (one) {
    const can = pflCanChange(one, PFL.data.printing);
    $("pfl-seldl").disabled = PFL.busy;
    $("pfl-selren").disabled = !can.ok;
    $("pfl-seldel").disabled = !can.ok || PFL.busy;
    $("pfl-seldel").title = $("pfl-selren").title = can.ok ? "" : pflWhy(can.reason);
    return;
  }
  $("pfl-selren").disabled = false;
  const picked = pflPicked();
  $("pfl-selcount").textContent = tr("pfiles.picked", { n: picked.length });
  $("pfl-seldl").disabled = !picked.length || PFL.busy;
  // Only the file being printed is kept; read-only videos are tried anyway
  // (the printer's camera service can delete them, printer_files.rs).
  const busy = picked.find((f) => !pflCanChange(f, PFL.data.printing).ok);
  $("pfl-seldel").disabled = !picked.length || !!busy || PFL.busy;
  $("pfl-seldel").title = busy ? pflWhy("printing") : "";
}
const pflPicked = () => pflList().filter((f) => PFL.picked.has(pflKey(f)));

/* Picks changed outside Select mode: the items marked in place (a full
   render would reload every thumbnail), then the panel and the bar. */
function pflRenderPicks() {
  document.querySelectorAll("#pfl-main [data-k]").forEach((el) => {
    const on = pflItemSel(el.dataset.k);
    el.classList.toggle(el.classList.contains("video") ? "picked" : "on", on);
    el.setAttribute("aria-selected", String(on));
  });
  pflRenderDetail();
  pflRenderSelbar();
}

function pflSetSelMode(on) {
  PFL.selMode = on;
  if (!on) PFL.picked = new Set();
  // Picking several replaces the single selection and its panel.
  if (on) PFL.detail = false;
  pflRender();
}

/* ------------------------------------------------------------ durations */

/* Video lengths, read from each file's header (a few small pieces). */
async function pflDurations(seq) {
  if (!PFL.data) return;
  const todo = PFL.data.videos.filter((v) => !PFL.durations.has(pflKey(v)));
  const worker = async () => {
    while (todo.length && seq === PFL.seq) {
      const v = todo.shift();
      const k = pflKey(v);
      const d = await invoke("pf_video_duration", { printerId: PFL.pid, root: v.root, path: v.path, modified: v.modified }).catch(() => null);
      if (d == null) continue;
      PFL.durations.set(k, d);
      const badge = document.querySelector(`#pfl-main [data-k="${CSS.escape(k)}"] .pfl-dur`);
      if (badge) {
        badge.textContent = pflClock(d);
        badge.classList.remove("hidden");
      }
      if (PFL.player === k) $("pfl-dur").textContent = pflClock($("pfl-video").duration || d);
    }
  };
  await Promise.all([worker(), worker()]);
  if (seq === PFL.seq && PFL.tab === "videos" && PFL.sort === "duration") pflRender();
}

/* ------------------------------------------------------------ actions */

function pflSelect(key, open = false) {
  PFL.sel = key;
  if (open) PFL.detail = true;
  document.querySelectorAll("#pfl-main [data-k]").forEach((el) => {
    const on = el.dataset.k === key;
    el.classList.toggle("on", on);
    el.setAttribute("aria-selected", String(on));
  });
  pflRenderDetail();
  pflRenderSelbar();
}

function pflPrint(f) {
  const p = pflPrinter();
  if (!p || !f) return;
  openSendRemote(p, f, pflThumb(f));
}

async function pflDownload(files) {
  if (!files.length || PFL.busy) return;
  const root = files[0].root;
  // Print files join the Files folder (the local library), videos the
  // Downloads folder.
  let dir = null;
  if (root === "gcodes") {
    dir = state.dir || (await invoke("pick_folder").catch(() => null));
    if (!dir) return;
  }
  PFL.busy = true;
  pflRenderDetail();
  pflRenderSelbar();
  toast(tr("pfiles.downloading", { n: files.length }));
  try {
    // One call per root: the videos tab can mix `timelapse` and `camera`.
    const saved = [];
    for (const r of new Set(files.map((f) => f.root))) {
      const paths = files.filter((f) => f.root === r).map((f) => f.path);
      saved.push(...(await invoke("pf_download", { printerId: PFL.pid, root: r, paths, dir })));
    }
    const where = dir || saved[0]?.replace(/[\\/][^\\/]*$/, "") || "";
    toast(tr("pfiles.saved", { n: saved.length, folder: baseName(where) }), false, saved[0] ? { label: tr("pfiles.reveal"), run: () => invoke("reveal", { path: saved[0] }).catch((e) => toast(pflErr(e, "reveal"), true)) } : null);
    if (dir && dir === state.dir) refresh();
  } catch (e) {
    toast(pflErr(e, "files"), true);
  } finally {
    PFL.busy = false;
    pflRenderDetail();
    pflRenderSelbar();
  }
}

async function pflDelete(files) {
  if (!files.length || PFL.busy) return;
  const blocked = files.map((f) => pflCanChange(f, PFL.data.printing)).find((c) => !c.ok);
  if (blocked) {
    toast(pflWhy(blocked.reason), true);
    return;
  }
  const one = files.length === 1;
  const name = one ? (files[0].meta || files[0].root === "gcodes" ? pflName(files[0].path) : pflVideoTitle(files[0])) : "";
  const many = files[0].root === "gcodes" ? "pfiles.del.title_files" : "pfiles.del.title_videos";
  const title = one ? tr("pfiles.del.title_one", { name }) : tr(many, { n: files.length });
  if (!(await confirmDelete(title, tr("pfiles.del.text")))) return;
  // Several timelapses take a while (the camera service, one by one): the
  // delete buttons wait, so the same files are not asked twice.
  PFL.busy = true;
  pflRenderBusy();
  toast(tr("pfiles.deleting", { n: files.length }));
  const failed = [];
  try {
    // One call per root: a path is only deleted, and checked, under its own.
    for (const { root, paths } of pflDeleteBatches(files)) {
      const errs = await invoke("pf_delete", { printerId: PFL.pid, root, paths });
      // The files' own errors; a picture's is never shown (its video's stands).
      for (const f of files) {
        const err = f.root === root ? errs[paths.indexOf(f.path)] : null;
        if (err) failed.push(err);
      }
    }
    // Every failure to the console; the first one said.
    const first = failed.map((e) => pflErr(e, "pf_delete"))[0] || "";
    if (failed.length === 1) toast(first, true);
    else if (failed.length) toast(tr("pfiles.del.failed", { n: failed.length, err: first }), true);
  } catch (e) {
    toast(pflErr(e, "files"), true);
  } finally {
    PFL.busy = false;
  }
  if (PFL.player && files.some((f) => pflKey(f) === PFL.player)) pflClosePlayer();
  // The files sent leave the picks; the others stay picked (a failed delete
  // is still listed, pflLoad keeps what is there).
  for (const f of files) PFL.picked.delete(pflKey(f));
  await pflLoad();
  pflRenderBusy();
}

/* The buttons that wait while a download or a delete runs. */
function pflRenderBusy() {
  pflRenderDetail();
  pflRenderSelbar();
  $("pfl-pdl").disabled = $("pfl-pdel").disabled = PFL.busy;
}

function pflRenameOpen(f) {
  const can = pflCanChange(f, PFL.data.printing);
  if (!can.ok) {
    toast(pflWhy(can.reason), true);
    return;
  }
  PFL.renaming = f;
  $("pflren-name").value = pflBase(f.path).replace(/\.[^.]+$/, "");
  $("pflren-msg").textContent = "";
  $("pflren-go").disabled = false;
  openSheet($("pflrename"));
  setTimeout(() => $("pflren-name").select(), 50);
}

async function pflRenameGo() {
  const f = PFL.renaming;
  const name = $("pflren-name").value.trim();
  if (!f || !name) return;
  $("pflren-go").disabled = true;
  try {
    const dest = await invoke("pf_rename", { printerId: PFL.pid, path: f.path, name });
    closeSheet($("pflrename"));
    PFL.sel = "gcodes/" + dest;
    await pflLoad();
  } catch (e) {
    $("pflren-msg").textContent = pflErr(e, "pf_rename");
    $("pflren-msg").className = "pf-test err";
    $("pflren-go").disabled = false;
  }
}

/* ------------------------------------------------------------ player */

function pflPlay(key) {
  const shown = pflShown();
  const v = shown.find((x) => pflKey(x) === key);
  if (!v) return;
  PFL.player = key;
  const video = $("pfl-video");
  const rate = +$("pfl-speed").value || 1;
  $("pfl-player").classList.remove("hidden");
  $("view-pfiles").classList.add("playing");
  $("pfl-ptitle").textContent = pflVideoTitle(v);
  $("pfl-pdate").textContent = [fmtDate(pflVideoDate(v)), fmtSize(v.size)].join(" · ");
  const i = shown.indexOf(v);
  $("pfl-pcount").textContent = tr("pfiles.player.pos", { i: i + 1, n: shown.length });
  $("pfl-pprev").disabled = pflNeighbor(i, shown.length, -1) < 0;
  $("pfl-pnext").disabled = pflNeighbor(i, shown.length, 1) < 0;
  $("pfl-pdel").title = tr("common.delete");
  $("pfl-perr").classList.add("hidden");
  $("pfl-seek").value = 0;
  $("pfl-cur").textContent = pflClock(0);
  const d = PFL.durations.get(key);
  $("pfl-dur").textContent = d ? pflClock(d) : "–:––";
  video.poster = pflThumb(v) || "";
  video.src = pflUrl(v.root, v.path);
  video.playbackRate = rate;
  video.play().catch(() => {});
  pflRenderSelbar();
  $("pfl-play").focus();
}

function pflClosePlayer() {
  const video = $("pfl-video");
  if (!video) return;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $("pfl-player").classList.remove("max");
  video.pause();
  video.removeAttribute("src");
  video.load();
  const was = PFL.player;
  PFL.player = null;
  $("pfl-player").classList.add("hidden");
  $("view-pfiles").classList.remove("playing");
  pflRenderSelbar();
  if (was) document.querySelector(`#pfl-main [data-k="${CSS.escape(was)}"]`)?.focus();
}

function pflStep(delta) {
  const shown = pflShown();
  const i = shown.findIndex((x) => pflKey(x) === PFL.player);
  const j = pflNeighbor(i, shown.length, delta);
  if (j >= 0) pflPlay(pflKey(shown[j]));
}

function pflPlayPause() {
  const v = $("pfl-video");
  if (v.paused || v.ended) v.play().catch(() => {});
  else v.pause();
}

/* Full screen: the element's own when the web view allows it, otherwise
   the whole window's content. */
function pflFullscreen() {
  const el = $("pfl-player");
  if (document.fullscreenElement) return document.exitFullscreen().catch(() => {});
  if (el.classList.contains("max")) return el.classList.remove("max");
  if (document.fullscreenEnabled && el.requestFullscreen) el.requestFullscreen().catch(() => el.classList.add("max"));
  else el.classList.add("max");
}

/* ------------------------------------------------------------ events */

$("pfl-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (!b || b.dataset.tab === PFL.tab) return;
  pflClosePlayer();
  PFL.tab = b.dataset.tab;
  PFL.selMode = false;
  PFL.picked = new Set();
  PFL.anchor = null;
  pflSave();
  pflRender();
});
$("pfl-layout").addEventListener("click", (e) => {
  const b = e.target.closest("[data-layout]");
  if (!b) return;
  PFL.view = b.dataset.layout;
  pflSave();
  pflRender();
});
$("pfl-sort").addEventListener("click", (e) =>
  menuUnder(e.currentTarget, [
    ...PFL_SORTS.map((k) => ({ id: "pflsort:" + k, label: tr(PFL_SORT_LABELS[k]), checked: PFL.sort === k })),
    {},
    { id: "pflorder:asc", label: tr("files.sort.asc"), checked: !PFL.desc },
    { id: "pflorder:desc", label: tr("files.sort.desc"), checked: PFL.desc },
  ])
);
onMenu("pflsort", (k) => {
  PFL.sort = k;
  // Names read best A→Z, the rest newest / biggest / longest first.
  PFL.desc = k !== "name";
  pflSave();
  pflRender();
});
onMenu("pflorder", (o) => {
  PFL.desc = o === "desc";
  pflSave();
  pflRender();
});
$("pfl-refresh").addEventListener("click", () => pflLoad());
$("pfl-select").addEventListener("click", () => pflSetSelMode(!PFL.selMode));
$("pfl-q").addEventListener("input", (e) => {
  PFL.q = e.target.value;
  pflRender();
});

$("pfl-main").addEventListener("click", (e) => {
  if (e.target.closest("[data-act=retry]")) return pflLoad();
  const s = e.target.closest("[data-sort]");
  if (s) {
    if (PFL.sort === s.dataset.sort) PFL.desc = !PFL.desc;
    else {
      PFL.sort = s.dataset.sort;
      PFL.desc = s.dataset.sort !== "name";
    }
    pflSave();
    return pflRender();
  }
  const item = e.target.closest("[data-k]");
  if (!item) return;
  const k = item.dataset.k;
  if (PFL.selMode) {
    PFL.picked = pflToggle(PFL.picked, k);
    item.classList.toggle("picked", PFL.picked.has(k));
    item.setAttribute("aria-selected", String(PFL.picked.has(k)));
    const box = item.querySelector(".pfl-check");
    if (box) box.checked = PFL.picked.has(k);
    pflRenderSelbar();
    return;
  }
  // Ctrl/Cmd or Shift-click: several files, as in the Files view.
  const toggle = e.metaKey || e.ctrlKey, range = e.shiftKey;
  if (toggle || range) {
    const order = pflShown().map(pflKey);
    const sel = PFL.tab === "files" ? PFL.sel : null;
    const next = pflPickClick({ picked: PFL.picked, sel, anchor: PFL.anchor }, k, order, { toggle, range });
    // Videos have no single selection (a click plays): one video stays picked.
    PFL.picked = PFL.tab === "files" || !next.sel ? next.picked : new Set([next.sel]);
    PFL.anchor = next.anchor;
    if (PFL.tab === "files") {
      PFL.sel = next.sel;
      if (next.picked.size) PFL.detail = false;
    }
    return pflRenderPicks();
  }
  PFL.anchor = k;
  if (PFL.picked.size) {
    PFL.picked = new Set();
    pflRenderPicks();
  }
  if (PFL.tab === "videos") pflPlay(k);
  else pflSelect(k);
});
$("pfl-main").addEventListener("dblclick", (e) => {
  const item = e.target.closest("[data-k]");
  // Not over picks: the panel would show one file and the bar the others.
  if (e.metaKey || e.ctrlKey || e.shiftKey || PFL.picked.size) return;
  if (item && PFL.tab === "files" && !PFL.selMode) pflSelect(item.dataset.k, true);
});
$("pfl-main").addEventListener("contextmenu", (e) => {
  const item = e.target.closest("[data-k]");
  if (!item) return;
  e.preventDefault();
  const k = item.dataset.k;
  const f = pflFind(k);
  if (!f) return;
  // On a picked file, every picked one; otherwise the file clicked alone
  // (the picks stay).
  const picking = PFL.selMode || PFL.picked.size > 0;
  PFL.menuKeys = pflMenuTargets(picking, PFL.picked, k, pflShown().map(pflKey));
  const files = PFL.menuKeys.map(pflFind).filter(Boolean);
  if (files.length > 1) {
    const can = files.every((x) => pflCanChange(x, PFL.data.printing).ok);
    nativeMenu([
      { id: "pfl:download", label: tr("common.download") },
      ...(can ? [{}, { id: "pfl:delete", label: tr("pfiles.delete_many", { n: files.length }) }] : []),
    ], e.clientX, e.clientY);
    return;
  }
  const can = pflCanChange(f, PFL.data.printing);
  if (PFL.tab === "files") {
    if (!picking) pflSelect(k);
    nativeMenu([
      { id: "pfl:print", label: tr("pfiles.print") },
      { id: "pfl:download", label: tr("common.download") },
      { id: "pfl:share", label: tr("share.button") },
      ...(can.ok ? [{ id: "pfl:rename", label: tr("pfiles.rename") }, {}, { id: "pfl:delete", label: tr("common.delete") }] : []),
    ], e.clientX, e.clientY);
  } else {
    nativeMenu([
      { id: "pfl:play", label: tr("pfiles.play") },
      { id: "pfl:download", label: tr("common.download") },
      { id: "pfl:share", label: tr("share.button") },
      ...(can.ok ? [{}, { id: "pfl:delete", label: tr("common.delete") }] : []),
    ], e.clientX, e.clientY);
  }
});
onMenu("pfl", (verb) => {
  const files = PFL.menuKeys.map(pflFind).filter(Boolean);
  const f = files[0];
  if (!f) return;
  if (verb === "download") pflDownload(files);
  else if (verb === "delete") pflDelete(files);
  else if (verb === "print") pflPrint(f);
  else if (verb === "share") pfsOpen(f);
  else if (verb === "rename") pflRenameOpen(f);
  else if (verb === "play") pflPlay(pflKey(f));
});

$("pfl-detail").addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  const f = pflFind(PFL.sel);
  if (!b || !f) return;
  const act = b.dataset.act;
  if (act === "close-detail") {
    PFL.detail = false;
    pflRenderDetail();
    pflRenderSelbar();
  } else if (act === "print") pflPrint(f);
  else if (act === "download") pflDownload([f]);
  else if (act === "share") pfsOpen(f);
  else if (act === "delete") pflDelete([f]);
});

$("pfl-selall").addEventListener("click", () => {
  const shown = pflShown();
  const all = shown.every((v) => PFL.picked.has(pflKey(v)));
  PFL.picked = all ? new Set() : new Set(shown.map(pflKey));
  pflRender();
});
/* The bar acts on the files picked, or on the one file selected. */
const pflBarFiles = () => (PFL.selMode || PFL.picked.size ? pflPicked() : [pflFind(PFL.sel)].filter(Boolean));
$("pfl-selprint").addEventListener("click", () => pflPrint(pflFind(PFL.sel)));
$("pfl-selshare").addEventListener("click", () => pfsOpen(pflFind(PFL.sel)));
$("pfl-selren").addEventListener("click", () => {
  const f = pflFind(PFL.sel);
  if (f) pflRenameOpen(f);
});
$("pfl-seldl").addEventListener("click", () => pflDownload(pflBarFiles()));
$("pfl-seldel").addEventListener("click", () => pflDelete(pflBarFiles()));
$("pfl-seldone").addEventListener("click", () => pflSetSelMode(false));

$("pflren-go").addEventListener("click", pflRenameGo);
$("pflren-cancel").addEventListener("click", () => closeSheet($("pflrename")));
$("pflren-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") pflRenameGo();
  if (e.key === "Escape") closeSheet($("pflrename"));
});

/* Player controls. */
const pflVideo = $("pfl-video");
$("pfl-back").addEventListener("click", pflClosePlayer);
$("pfl-pprev").addEventListener("click", () => pflStep(-1));
$("pfl-pnext").addEventListener("click", () => pflStep(1));
$("pfl-pdl").addEventListener("click", () => {
  const v = pflFind(PFL.player);
  if (v) pflDownload([v]);
});
$("pfl-pshare").addEventListener("click", () => pfsOpen(pflFind(PFL.player)));
$("pfl-pdel").addEventListener("click", () => {
  const v = pflFind(PFL.player);
  if (v) pflDelete([v]);
});
$("pfl-play").addEventListener("click", pflPlayPause);
pflVideo.addEventListener("click", pflPlayPause);
$("pfl-fs").addEventListener("click", pflFullscreen);
pflVideo.addEventListener("dblclick", pflFullscreen);
$("pfl-speed").addEventListener("change", (e) => (pflVideo.playbackRate = +e.target.value || 1));
segmented("pfl-speed", { cls: "compact" });
$("pfl-seek").addEventListener("input", (e) => {
  if (isFinite(pflVideo.duration)) pflVideo.currentTime = (e.target.value / 1000) * pflVideo.duration;
});
const pflPlayIcon = () => {
  const paused = pflVideo.paused || pflVideo.ended;
  $("pfl-play").innerHTML = paused ? PFL_ICON_PLAY : PFL_ICON_PAUSE;
  const label = tr(paused ? "pfiles.player.play" : "pfiles.player.pause");
  $("pfl-play").title = label;
  $("pfl-play").setAttribute("aria-label", label);
};
["play", "pause", "ended", "emptied"].forEach((ev) => pflVideo.addEventListener(ev, pflPlayIcon));
pflVideo.addEventListener("loadedmetadata", () => {
  if (isFinite(pflVideo.duration)) $("pfl-dur").textContent = pflClock(pflVideo.duration);
});
pflVideo.addEventListener("timeupdate", () => {
  $("pfl-cur").textContent = pflClock(pflVideo.currentTime);
  if (isFinite(pflVideo.duration) && pflVideo.duration > 0) $("pfl-seek").value = Math.round((pflVideo.currentTime / pflVideo.duration) * 1000);
});
pflVideo.addEventListener("error", () => {
  if (!PFL.player) return;
  $("pfl-perr").textContent = tr("pfiles.player.error");
  $("pfl-perr").classList.remove("hidden");
});
document.addEventListener("fullscreenchange", () => $("pfl-fs").classList.toggle("on", !!document.fullscreenElement));

/* Keys: in the player ←/→ previous/next video, Space pause, Esc back; in the
   lists Enter opens, Esc closes the panel or leaves selection. */
document.addEventListener("keydown", (e) => {
  if (window.currentView !== "pfiles" || document.querySelector(".modal:not(.hidden)")) return;
  const typing = e.target.closest?.("input[type=search], input[type=text], textarea, select");
  if (PFL.player) {
    if (e.key === "Escape") {
      e.preventDefault();
      if ($("pfl-player").classList.contains("max")) $("pfl-player").classList.remove("max");
      else pflClosePlayer();
      return;
    }
    if (typing) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      pflStep(e.key === "ArrowLeft" ? -1 : 1);
    } else if (e.key === " ") {
      e.preventDefault();
      // A focused button would also click on release.
      if (document.activeElement?.tagName === "BUTTON") document.activeElement.blur();
      pflPlayPause();
    }
    return;
  }
  if (typing) return;
  if (e.key === "Escape") {
    if (PFL.selMode) pflSetSelMode(false);
    else if (PFL.picked.size) {
      PFL.picked = new Set();
      pflRenderPicks();
    }
    else if (PFL.detail) {
      PFL.detail = false;
      pflRenderDetail();
      pflRenderSelbar();
    } else if (PFL.sel) pflSelect(null); // then the selection, and its bar
  } else if (e.key === "Enter" && PFL.sel && PFL.tab === "files") pflSelect(PFL.sel, true);
});

window.addEventListener("langchange", () => {
  if (PFL.pid) pflRender();
  pflPlayIcon();
});
/* A print sent from Snap Studio adds a file: the count is asked again. */
listen("print-send", (e) => {
  if (e.payload?.phase !== "done") return;
  PFL.countAt.clear();
  pflSideCounts();
  if (pflOpen()) pflLoad();
});
pflPlayIcon();

/* A picture that does not load: its placeholder instead ("error" does not
   bubble, hence the capture). */
$("view-pfiles").addEventListener(
  "error",
  (e) => {
    const img = e.target;
    if (img?.tagName !== "IMG" || !img.dataset.ph) return;
    img.outerHTML = pflPh(img.dataset.ph);
  },
  true
);
