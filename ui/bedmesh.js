"use strict";
/* Bed leveling tab of Care & Tuning: Klipper's bed_mesh read through
   Moonraker (bedmesh.rs), its history stored by the app, a 3D surface and
   a heat map, comparing two measurements, measuring now. The arithmetic
   is in bedmesh-logic.js. */

const BM = {
  pid: null,
  hist: new Map(), // pid → stored meshes, oldest first
  live: new Map(), // pid → what the printer said last
  err: new Map(), // pid → the last read's error
  readAt: new Map(),
  loading: false,
  shown: null, // a stored mesh's `at`, "live", or null: the newest
  mode: localStorage.getItem("snapstudio.bm.mode") === "map" ? "map" : "3d",
  relief: +localStorage.getItem("snapstudio.bm.relief") || 100,
  cam: { yaw: -0.55, pitch: 0.9, zoom: 1 },
  run: null, // measurement in progress: { pid, temp, start, timer, done }
  wiz: null, // the measuring assistant: { pid, step, resume, fix, result }
  zone: null, // { at, n }: the finding shown on the map
  moreOpen: localStorage.getItem("snapstudio.bm.more") === "1",
  cmp: { a: null, b: null, view: "d", mode: "map" },
  viewer: null,
  cmpViewer: null,
};

/* ------------------------------------------------------------ settings */

const bmSetKey = (pid) => `snapstudio.bedmesh.${pid}`;
function bmSettingsOf(pid) {
  try {
    return bmlSettings(JSON.parse(localStorage.getItem(bmSetKey(pid)) || "null"));
  } catch {
    return bmlSettings(null);
  }
}
const bmSaveSettings = (pid, s) => localStorage.setItem(bmSetKey(pid), JSON.stringify(bmlSettings(s)));

/* The newest stored mesh out of tolerance (alert on): { dev, at } or null. */
const bmAlertOf = (pid) => (pid ? bmlAlert(BM.hist.get(pid) || [], bmSettingsOf(pid)) : null);

/* ------------------------------------------------------------ reminders */

/* The printer's job count (Care reads it), or null. */
function bmJobsNow(pid) {
  const c = typeof mtCached === "function" ? mtCached(pid)?.usage?.jobs : null;
  if (c != null) return c;
  return MT.pid === pid && MT.usage ? MT.usage.jobs : null;
}
/* The job count when the newest measurement was stored: prints since. */
const bmJobsKey = (pid) => `snapstudio.bm.jobs.${pid}`;
function bmJobsMark(pid) {
  try {
    return JSON.parse(localStorage.getItem(bmJobsKey(pid)) || "null");
  } catch {
    return null;
  }
}
function bmMarkJobs(pid) {
  const hist = BM.hist.get(pid) || [];
  const newest = hist[hist.length - 1], jobs = bmJobsNow(pid);
  if (!newest || jobs == null || bmJobsMark(pid)?.at === newest.at) return;
  localStorage.setItem(bmJobsKey(pid), JSON.stringify({ at: newest.at, jobs }));
}

/* The page's state (bmlState): its card, its action, what Care asks. */
function bmStateOf(pid) {
  const hist = BM.hist.get(pid) || [];
  const newest = hist[hist.length - 1], mark = bmJobsMark(pid);
  return bmlState(hist, bmSettingsOf(pid), { now: Date.now() / 1000, jobsNow: bmJobsNow(pid), jobsAtLast: newest && mark?.at === newest.at ? mark.jobs : null });
}

/* What Care asks about the bed: out of tolerance (alert on), or a
   measurement due; null otherwise. */
function bmDueOf(pid) {
  if (!pid) return null;
  const s = bmStateOf(pid);
  if (s.kind === "out" && bmSettingsOf(pid).alert) return s;
  return s.kind === "stale" ? s : null;
}

/* ------------------------------------------------------------ loading */

/* History, then the printer's mesh; a new full-bed mesh is stored. During
   a measurement from the app, it is stored when the measurement ends. */
async function bmLoad(pid) {
  const hist = await invoke("bed_mesh_history", { printerId: pid }).catch(() => null);
  if (hist) BM.hist.set(pid, hist);
  bmMarkJobs(pid);
  let live = null;
  try {
    live = await invoke("bed_mesh_read", { printerId: pid });
    BM.live.set(pid, live);
    BM.err.delete(pid);
    BM.readAt.set(pid, Date.now());
  } catch (e) {
    BM.err.set(pid, String(e));
  }
  if (live?.mesh && !live.mesh.partial && BM.run?.pid !== pid) await bmRecord(pid, live.mesh, false);
  return live;
}

async function bmRecord(pid, mesh, byApp) {
  const h = await invoke("bed_mesh_record", { printerId: pid, mesh, keep: bmSettingsOf(pid).keep, byApp }).catch(() => null);
  if (h) BM.hist.set(pid, h);
  bmMarkJobs(pid);
  return h;
}

/* The stored entry of the printer's mesh, if it is one. */
const bmStoredOf = (pid, mesh) => mesh && (BM.hist.get(pid) || []).find((m) => bmSame(m, mesh));
function bmSame(a, b) {
  if (!a || !b || a.points.length !== b.points.length) return false;
  const near = (x, y, e) => Math.abs(x - y) < e;
  return [0, 1].every((k) => near(a.min[k], b.min[k], 0.01) && near(a.max[k], b.max[k], 0.01)) &&
    a.points.every((r, j) => r.length === b.points[j].length && r.every((v, i) => near(v, b.points[j][i], 1e-6)));
}

/* Opens the tab (Care & Tuning calls it); reads again when old. */
function bmShow(pid) {
  if (BM.pid !== pid) BM.shown = null;
  BM.pid = pid;
  bmRender();
  const age = Date.now() - (BM.readAt.get(pid) || 0);
  if (!MT.loading && age > 60000) {
    BM.loading = true;
    bmLoad(pid).finally(() => {
      BM.loading = false;
      if (BM.pid === pid) bmAfterChange();
    });
  }
}

function bmAfterChange() {
  mtSideDots();
  if (window.currentView === "maint" && MT.pid === BM.pid) {
    if (MT.tab === "level") bmRender();
    else mtRender();
  }
}

/* ------------------------------------------------------------ formats */

const bmMm = (v, n = 2) => fmtDec(v, n);
const bmSigned = (v, n = 3) => {
  const r = Math.round(v * 10 ** n) / 10 ** n;
  return (r > 0 ? "+" : r < 0 ? "−" : "") + fmtDec(Math.abs(r), n);
};
/* "21 Oct, 14:02"; another year: "21 Oct 2025, 14:02". */
function bmWhen(at) {
  const d = new Date(at * 1000);
  const year = d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {};
  return d.toLocaleString(locale(), { day: "numeric", month: "short", ...year, hour: "2-digit", minute: "2-digit" });
}
/* "15 Oct"; another year: "15 Oct 2025". */
function bmDay(at) {
  const d = new Date(at * 1000);
  const year = d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {};
  return d.toLocaleDateString(locale(), { day: "numeric", month: "short", ...year });
}
const bmPrinter = (pid) => P.list.find((x) => x.id === pid);
const bmPrinting = (pid) => ["printing", "paused"].includes(P.status.get(pid)?.state) || ["printing", "paused"].includes(BM.live.get(pid)?.state);

/* The mesh shown: the one picked, otherwise the newest stored, otherwise
   the printer's (adaptive) one. */
function bmShownMesh(pid) {
  const hist = BM.hist.get(pid) || [];
  const live = BM.live.get(pid)?.mesh;
  if (BM.shown === "live" && live) return { mesh: live, live: true };
  const picked = BM.shown != null && hist.find((m) => m.at === BM.shown);
  if (picked) return { mesh: picked };
  const newest = hist[hist.length - 1];
  if (newest) return { mesh: newest, newest: true };
  if (live) return { mesh: live, live: true };
  return null;
}

/* ------------------------------------------------------------ render */

function bmRender() {
  const pid = BM.pid;
  const p = bmPrinter(pid);
  if (!p || MT.tab !== "level") return;
  const box = $("bm-body");
  const st = bmSettingsOf(pid);
  const live = BM.live.get(pid);
  const err = BM.err.get(pid);
  const hist = BM.hist.get(pid) || [];
  bmToolbar();
  const shown = bmShownMesh(pid);
  const notices = [];
  if (BM.loading && !live) notices.push(`<div class="mt-stale"><span class="spinner"></span>${esc(tr("bm.reading"))}</div>`);
  else if (err) {
    const name = printerName(pid);
    notices.push(offlineLine(hist.length ? tr("bm.offline_hist", { name }) : tr("printers.no_answer", { name }), "data-bm-retry"));
  }
  if (live && !live.supported) notices.push(`<div class="bm-notice">${esc(tr("bm.unsupported"))}</div>`);
  if (live?.mesh?.partial && !shown?.live) {
    const m = live.mesh;
    notices.push(`<div class="bm-notice"><span>${esc(tr("bm.adaptive", { x: `${fmtNum(Math.round(m.min[0]))}–${fmtNum(Math.round(m.max[0]))}`, y: `${fmtNum(Math.round(m.min[1]))}–${fmtNum(Math.round(m.max[1]))}` }))}</span><button class="btn small" data-bm-show="live">${esc(tr("bm.show"))}</button></div>`);
  }
  if (!shown) {
    const can = live?.supported;
    box.innerHTML = `${notices.join("")}${BM.loading ? "" : bmHero({ kind: "none" }, st, can)}`;
    bmViewerDetach();
    return;
  }
  const m = shown.mesh;
  const s = bmlStats(m);
  const status = bmlStatus(s.dev, st);
  const stored = shown.live ? bmStoredOf(pid, m) : m;
  const isNewest = !shown.live && (shown.newest || stored === hist[hist.length - 1]);
  // The newest measurement: a card that says what to do. Another one
  // (picked in the history, the printer's adaptive mesh): what it is.
  let head;
  if (isNewest) head = bmHero(bmStateOf(pid), st, live?.supported);
  else {
    const when = stored ? tr(stored.by_app ? "bm.when_app" : "bm.when_seen", { d: bmWhen(stored.at) }) : tr("bm.when_live");
    const area = m.partial ? tr("bm.area_partial") : tr("bm.area_full");
    head = `<div class="bm-head">
      <div class="bm-dev ${status}"><b>${esc(bmMm(s.dev))}</b><span>mm</span><small>${esc(tr("bm.dev"))}</small></div>
      <div class="bm-head-text">
        <span class="bm-status ${status}"><i></i>${esc(tr(`bm.st.${status}`))}</span>
        <div class="bm-when">${esc(when)}</div>
        <div class="bm-sub">${esc(tr("bm.grid", { x: s.nx, y: s.ny }))} · ${esc(area)}</div>
      </div>
      <button class="btn small" data-bm-show="">${esc(tr("bm.newest"))}</button>
    </div>`;
  }
  // What the shape says, when the bed asks for attention.
  const findings = status === "good" || m.partial ? [] : bmlShape(m);
  const zoneKey = shown.live ? "live" : m.at;
  if (BM.zone?.at !== zoneKey) BM.zone = { at: zoneKey, n: findings.length && status === "out" ? 0 : null };
  const diag = status === "good" || m.partial ? "" : bmDiagHtml(m, findings, status, isNewest);
  const stats = [
    [bmSigned(s.min), tr("bm.min")],
    [bmSigned(s.max), tr("bm.max")],
    [bmSigned(s.mean), tr("bm.mean")],
    [`${s.nx} × ${s.ny}`, tr("bm.size")],
  ].map(([v, k]) => `<span><b>${esc(v)}</b>${esc(k)}</span>`).join("");
  const view = `<div class="bm-card">
      <div class="bm-viewbar">
        <div id="bm-modes" class="seg" role="group" aria-label="${esc(tr("bm.view"))}">
          <button class="seg-btn labeled${BM.mode === "3d" ? " on" : ""}" data-bmode="3d" aria-pressed="${BM.mode === "3d"}">3D</button>
          <button class="seg-btn labeled${BM.mode === "map" ? " on" : ""}" data-bmode="map" aria-pressed="${BM.mode === "map"}">${esc(tr("bm.view.map"))}</button>
        </div>
        <label class="bm-relief${BM.mode === "3d" ? "" : " hidden"}"><span>${esc(tr("bm.relief"))}</span><input id="bm-relief" type="range" min="20" max="800" step="10" value="${BM.relief}" /><b id="bm-relief-v">${fmtNum(BM.relief)}</b></label>
        <span class="bm-hint">${esc(BM.mode === "3d" ? tr("bm.hint3d") : tr("bm.hintmap"))}</span>
      </div>
      <div class="bm-stage${BM.mode === "map" ? " map" : ""}"><canvas id="bm-canvas" aria-label="${esc(tr("bm.canvas", { dev: bmMm(s.dev) }))}" role="img"></canvas><div class="bm-hover hidden" id="bm-hover"></div></div>
      <div class="bm-legend" id="bm-legend"></div>
      <div class="mt-strip bm-stats">${stats}</div>
    </div>`;
  box.innerHTML = `${notices.join("")}${head}${diag}${view}${bmHistoryHtml(pid, m)}`;
  bmViewerAttach(m, st, findings[BM.zone.n]?.zone);
  bmDrawTrend(pid);
}

/* The card on top: the bed's state in a sentence, and the one thing to do. */
function bmHero(state, st, canMeasure) {
  const btn = (label, attr, primary) => `<button class="btn${primary ? " primary" : ""}" ${attr}>${esc(label)}</button>`;
  const measure = (label, primary = true) => (canMeasure ? btn(label, "data-bm-measure", primary) : "");
  const level = tr(`bm.level.${bmlLevelOf(st)}`);
  const limits = tr("bm.limits_level", { level, good: bmMm(st.good), limit: bmMm(st.limit) });
  if (state.kind === "none") {
    return `<div class="bm-hero none">
      <span class="bm-hero-ic"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17l4-3h10l4 3v3H3zM6 12l3-6h6l3 6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></span>
      <div class="bm-hero-text"><b>${esc(tr("bm.hero.none"))}</b><small>${esc(tr(canMeasure ? "bm.hero.none_sub" : "bm.empty_hint"))}</small></div>
      <div class="bm-hero-acts">${measure(tr("bm.measure.sheet"))}</div>
    </div>`;
  }
  const dev = bmMm(state.dev);
  const when = tr("bm.hero.when", { d: bmWhen(state.at) });
  const ch = state.change;
  const vs = !ch ? "" : ch.delta < 0 ? tr("bm.hero.better", { d: bmDay(ch.at), v: bmMm(-ch.delta) }) : ch.delta > 0 ? tr("bm.hero.worse", { d: bmDay(ch.at), v: bmMm(ch.delta) }) : tr("bm.hero.same", { d: bmDay(ch.at) });
  let cls = state.status, title, sub, acts;
  if (state.kind === "out") {
    title = tr("bm.hero.out", { dev });
    sub = tr("bm.hero.out_sub", { limit: bmMm(st.limit) });
    acts = btn(tr("bm.hero.cause"), "data-bm-cause", true) + measure(tr("bm.hero.again"), false);
  } else if (state.kind === "stale") {
    cls = "stale";
    title = state.remind.reason === "prints" ? tr("bm.hero.stale_prints", { n: state.remind.prints }) : tr("bm.hero.stale_days", { n: state.remind.days });
    sub = tr("bm.hero.stale_sub", { st: tr(`bm.st.${state.status}`).toLowerCase(), dev });
    acts = measure(tr("bm.hero.again"));
  } else if (state.kind === "watch") {
    title = tr("bm.hero.watch", { dev });
    sub = [tr("bm.hero.watch_sub", { limit: bmMm(st.limit) }), vs].filter(Boolean).join(" · ");
    acts = measure(tr("bm.hero.check"));
  } else {
    title = tr("bm.hero.good", { dev });
    sub = [tr("bm.hero.comp"), when, vs].filter(Boolean).join(" · ");
    acts = measure(tr("bm.hero.again"), false);
  }
  const icon = cls === "good" ? '<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'
    : cls === "stale" ? '<path d="M12 6v6l4 2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/>'
    : '<path d="M12 7v6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="17" r="1.4" fill="currentColor"/>';
  return `<div class="bm-hero ${cls}">
      <span class="bm-hero-ic"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></span>
      <div class="bm-hero-text"><b>${esc(title)}</b><small>${esc(sub)}</small><small class="bm-hero-lim">${esc(state.kind === "good" || state.kind === "stale" ? limits : when + " · " + limits)}</small></div>
      <div class="bm-hero-acts">${acts}</div>
    </div>`;
}

/* A finding in words: what it is and what to do. */
function bmFindingText(f, mesh) {
  const v = bmMm(f.amount);
  // A U1 has a knob under each corner, and its screen guides their setting.
  const knobs = !!BM.live.get(BM.pid)?.config?.auto_macro;
  if (f.kind === "tilt") return { title: tr("bm.f.tilt", { side: tr(`bm.side.${f.side}`), v }), tip: tr(knobs ? "bm.f.tilt_tip_knobs" : "bm.f.tilt_tip") };
  if (f.kind === "corner") return { title: tr(f.high ? "bm.f.corner_up" : "bm.f.corner_down", { corner: tr(`bm.side.${f.corner}`), v }), tip: knobs ? tr("bm.f.corner_tip_knobs", { corner: tr(`bm.side.${f.corner}`) }) : tr(f.high ? "bm.f.corner_up_tip" : "bm.f.corner_down_tip") };
  if (f.kind === "bowl" || f.kind === "dome") return { title: tr(`bm.f.${f.kind}`, { v }), tip: tr("bm.f.curve_tip") };
  const [x, y] = bmlXY(mesh, f.at[0], f.at[1]);
  return { title: tr(f.high ? "bm.f.bump_up" : "bm.f.bump_down", { v, x: fmtNum(Math.round(x)), y: fmtNum(Math.round(y)) }), tip: tr("bm.f.bump_tip") };
}

/* "What the measurement shows": each shape found, where it is (shown on
   the map on request), what to do; then measure again to check. */
function bmDiagHtml(mesh, findings, status, isNewest) {
  const rows = findings.length
    ? findings.map((f, n) => {
        const t = bmFindingText(f, mesh), on = BM.zone?.n === n;
        return `<div class="bm-find${on ? " on" : ""}">
          <span class="bm-find-n">${n + 1}</span>
          <div class="bm-find-text"><b>${esc(t.title)}</b><small>${esc(t.tip)}</small></div>
          <button class="btn small${on ? " on" : ""}" data-bm-zone="${n}" aria-pressed="${on}">${esc(tr(on ? "bm.diag.hide" : "bm.diag.show"))}</button>
        </div>`;
      }).join("")
    : `<div class="bm-find"><div class="bm-find-text"><b>${esc(tr("bm.f.none"))}</b><small>${esc(tr("bm.f.none_tip"))}</small></div></div>`;
  const again = isNewest && BM.live.get(BM.pid)?.supported ? `<div class="bm-diag-foot"><span>${esc(tr("bm.diag.after"))}</span><button class="btn primary" data-bm-fixed>${esc(tr("bm.diag.fixed"))}</button></div>` : "";
  return `<div class="bm-card bm-diag ${status}" id="bm-diag">
      <div class="bm-diag-head">${esc(tr("bm.diag.title"))}</div>
      ${rows}${again}
    </div>`;
}

/* The toolbar's Measure button: its state follows the printer. */
function bmToolbar() {
  const pid = BM.pid;
  const btn = $("bm-measure-btn");
  const live = BM.live.get(pid);
  const run = BM.run?.pid === pid;
  const printing = bmPrinting(pid);
  // One measurement at a time: another printer's is under way.
  const other = BM.run && BM.run.pid !== pid ? bmPrinter(BM.run.pid) : null;
  btn.disabled = !run && (!!other || printing || !live?.supported || bmlBusy(live));
  btn.title = run ? tr("bm.measure.show") : other ? tr("bm.measure.other", { name: other.name || other.host }) : printing ? tr("bm.measure.printing") : !live?.supported ? tr("bm.measure.unavailable") : tr("bm.measure.title");
  btn.classList.toggle("on", run);
  $("bm-measure-lbl").textContent = run ? bmRunLabel() : tr("bm.measure");
}
const bmlBusy = (live) => ["preheating", "prescanning", "probing", "aborting"].includes(live?.progress?.state);

function bmHistoryHtml(pid, shownMesh) {
  const st = bmSettingsOf(pid);
  const hist = [...(BM.hist.get(pid) || [])].reverse();
  if (!hist.length) return "";
  const rows = hist.map((m) => {
    const dev = bmlStats(m)?.dev ?? 0;
    const status = bmlStatus(dev, st);
    const on = bmSame(m, shownMesh);
    return `<div class="bm-hrow${on ? " on" : ""}" data-bm-show="${m.at}" tabindex="0" role="button" aria-pressed="${on}">
      <span class="mt-dot-st ${status === "good" ? "ok" : status === "watch" ? "soon" : "due"}"></span>
      <span class="bm-hname"><b>${esc(bmWhen(m.at))}</b><small>${esc(tr("bm.dev_mm", { v: bmMm(dev) }))} · ${esc(tr(`bm.st.${status}`))}${m.by_app ? ` · ${esc(tr("bm.by_app"))}` : ""}</small></span>
      ${hist.length > 1 ? `<button class="btn small" data-bm-cmp="${m.at}">${esc(tr("bm.compare"))}</button>` : ""}
      <button class="tb-btn danger" data-bm-del="${m.at}" title="${esc(tr("bm.delete"))}" aria-label="${esc(tr("bm.delete"))}"><svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7z"/></svg></button>
    </div>`;
  }).join("");
  // Folded by default: the card on top says what matters.
  return `<details class="bm-more" id="bm-more"${BM.moreOpen ? " open" : ""}>
      <summary>${esc(tr("bm.more"))} <small class="bm-count">${esc(tr("bm.history_n", { n: hist.length, keep: st.keep }))}</small></summary>
      <div class="bm-card bm-trend-card"><svg id="bm-trend" class="bm-trend" role="img" aria-label="${esc(tr("bm.trend"))}"></svg></div>
      <div class="group bm-hist">${rows}</div>
    </details>`;
}

/* Deviation over time, with the alert threshold. */
function bmDrawTrend(pid) {
  const svg = $("bm-trend");
  if (!svg) return;
  const st = bmSettingsOf(pid);
  const pts = bmlTrend(BM.hist.get(pid));
  const w = Math.max(240, svg.clientWidth || 600), h = 130, pad = { l: 44, r: 12, t: 12, b: 22 };
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  if (pts.length < 2) {
    svg.innerHTML = `<text class="bm-t-note" x="${w / 2}" y="${h / 2}" text-anchor="middle">${esc(tr("bm.trend_one"))}</text>`;
    return;
  }
  const ymax = Math.max(st.limit, ...pts.map((p) => p.dev)) * 1.2;
  const t0 = pts[0].at, t1 = pts[pts.length - 1].at;
  const X = (at) => pad.l + ((w - pad.l - pad.r) * (at - t0)) / Math.max(1, t1 - t0);
  const Y = (v) => h - pad.b - ((h - pad.t - pad.b) * v) / ymax;
  const line = pts.map((p, i) => `${i ? "L" : "M"}${X(p.at).toFixed(1)},${Y(p.dev).toFixed(1)}`).join(" ");
  const ticks = [0, ymax / 2, ymax].map((v) => `<text class="bm-t-axis" x="${pad.l - 6}" y="${Y(v) + 3}" text-anchor="end">${esc(fmtDec(v, 2))}</text><line class="bm-t-grid" x1="${pad.l}" x2="${w - pad.r}" y1="${Y(v)}" y2="${Y(v)}"/>`).join("");
  const dots = pts.map((p) => `<circle class="bm-t-dot ${bmlStatus(p.dev, st)}" cx="${X(p.at).toFixed(1)}" cy="${Y(p.dev).toFixed(1)}" r="3.5"><title>${esc(`${bmWhen(p.at)} · ${tr("bm.dev_mm", { v: bmMm(p.dev) })}`)}</title></circle>`).join("");
  const dates = [pts[0], pts[pts.length - 1]].map((p, i) => `<text class="bm-t-axis" x="${X(p.at)}" y="${h - 6}" text-anchor="${i ? "end" : "start"}">${esc(mtDate(p.at))}</text>`).join("");
  svg.innerHTML = `${ticks}<line class="bm-t-limit" x1="${pad.l}" x2="${w - pad.r}" y1="${Y(st.limit)}" y2="${Y(st.limit)}"/>
    <text class="bm-t-limit-l" x="${w - pad.r}" y="${Y(st.limit) - 4}" text-anchor="end">${esc(tr("bm.threshold", { v: bmMm(st.limit) }))}</text>
    <path class="bm-t-path" d="${line}"/>${dots}${dates}`;
}

/* ------------------------------------------------------------ the view */

/* Colour stops from the theme (--mesh-low, --mesh-mid, --mesh-high). */
function bmStops() {
  const cs = getComputedStyle(document.documentElement);
  const ctx = document.createElement("canvas").getContext("2d");
  return ["--mesh-low", "--mesh-mid", "--mesh-high"].map((v) => {
    ctx.fillStyle = "#888";
    ctx.fillStyle = cs.getPropertyValue(v).trim() || "#888";
    const c = ctx.fillStyle;
    if (c.startsWith("#")) return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    return (c.match(/[\d.]+/g) || [136, 136, 136]).slice(0, 3).map(Number);
  });
}
const bmCss = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

/* A mesh drawn on a canvas, as a 3D surface (drag to turn, wheel to zoom,
   double-click to reset) or a heat map; the hovered point's value. */
function bmMakeViewer(canvas, hover) {
  const V = { mesh: null, fine: null, stats: null, scale: null, mode: "3d", relief: 100, k: 1, diff: false, quads: [], cells: [], mark: null, zone: null, stops: null, ro: null };
  const accent = () => (typeof cssColor === "function" && cssColor("var(--accent)")) || "#007aff";
  const ctx = canvas.getContext("2d");
  const dpr = () => window.devicePixelRatio || 1;

  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width * dpr()));
    canvas.height = Math.max(1, Math.round(r.height * dpr()));
    draw();
  }

  /* World: the mesh area in [-1, 1] (longest side), heights × relief. */
  function project(x, y, v, W, H) {
    const m = V.mesh, c = BM.cam;
    const cx = (m.min[0] + m.max[0]) / 2, cy = (m.min[1] + m.max[1]) / 2;
    const half = Math.max(m.max[0] - m.min[0], m.max[1] - m.min[1]) / 2 || 1;
    const X = (x - cx) / half, Y = (y - cy) / half, Z = ((v - V.scale.center) * V.relief) / half;
    const x1 = X * Math.cos(c.yaw) - Y * Math.sin(c.yaw);
    const y1 = X * Math.sin(c.yaw) + Y * Math.cos(c.yaw);
    const up = y1 * Math.sin(c.pitch) + Z * Math.cos(c.pitch);
    const depth = y1 * Math.cos(c.pitch) - Z * Math.sin(c.pitch);
    const f = 4.2 / (4.2 + depth);
    const k = V.k * c.zoom;
    return [W / 2 + x1 * f * k, H * 0.5 - up * f * k, depth];
  }

  /* Scale that fits the bed whatever the turn: its circle, the relief,
     the nearest point's perspective. */
  function fit(W, H) {
    const m = V.mesh, p = BM.cam.pitch;
    const half = Math.max(m.max[0] - m.min[0], m.max[1] - m.min[1]) / 2 || 1;
    const R = Math.hypot((m.max[0] - m.min[0]) / 2, (m.max[1] - m.min[1]) / 2) / half;
    const zr = (V.scale.span * 1.2 * V.relief) / half;
    const fn = 4.2 / Math.max(1, 4.2 - R * Math.cos(p) - zr * Math.sin(p));
    const vert = (R * Math.sin(p) + zr * Math.cos(p)) * fn + 0.12;
    V.k = Math.min((W * 0.47) / (R * fn), (H * 0.58) / vert);
  }

  function colorOf(v) {
    return bmlColor(bmlT(v, V.scale), V.stops);
  }

  function draw3d(W, H) {
    fit(W, H);
    const f = V.fine, p = f.points, ny = p.length, nx = p[0].length;
    const P = p.map((r, j) => r.map((v, i) => (v == null ? null : project(...bmlXY(f, i, j), v, W, H))));
    const quads = [];
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const c = [P[j][i], P[j][i + 1], P[j + 1][i + 1], P[j + 1][i]];
        if (c.some((q) => !q)) continue;
        const vs = [p[j][i], p[j][i + 1], p[j + 1][i + 1], p[j + 1][i]];
        // Light from the top left: the slope darkens or lightens a little.
        const sx = (vs[1] + vs[2] - vs[0] - vs[3]) / 2, sy = (vs[2] + vs[3] - vs[0] - vs[1]) / 2;
        const shade = 1 + Math.max(-0.12, Math.min(0.12, (-sx + sy) * 40 * (V.relief / 200)));
        quads.push({ c, i, j, d: (c[0][2] + c[1][2] + c[2][2] + c[3][2]) / 4, v: (vs[0] + vs[1] + vs[2] + vs[3]) / 4, shade });
      }
    quads.sort((a, b) => b.d - a.d);
    // The bed's outline under the surface, and its front edge named.
    const m = V.mesh, base = V.scale.center - V.scale.span * 1.15;
    const corners = [[m.min[0], m.min[1]], [m.max[0], m.min[1]], [m.max[0], m.max[1]], [m.min[0], m.max[1]]].map(([x, y]) => project(x, y, base, W, H));
    ctx.strokeStyle = bmCss("--separator") || "#888";
    ctx.lineWidth = 1 * dpr();
    ctx.beginPath();
    corners.forEach((q, n) => (n ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
    ctx.closePath();
    ctx.stroke();
    for (const q of quads) {
      const rgb = colorOf(q.v).map((x) => Math.min(255, Math.round(x * q.shade)));
      ctx.fillStyle = ctx.strokeStyle = `rgb(${rgb.join(",")})`;
      ctx.lineWidth = 0.6 * dpr();
      ctx.beginPath();
      q.c.forEach((pt, n) => (n ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1])));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    V.quads = quads;
    const front = project((m.min[0] + m.max[0]) / 2, m.min[1], base, W, H);
    ctx.fillStyle = bmCss("--text-secondary") || "#888";
    ctx.font = `${11 * dpr()}px ${bmCss("--font-ui") || "system-ui"}`;
    ctx.textAlign = "center";
    ctx.fillText(tr("bm.front"), front[0], front[1] + 16 * dpr());
    // A finding's points: rings in the accent.
    if (V.zone) {
      ctx.strokeStyle = accent();
      ctx.lineWidth = 2.5 * dpr();
      for (const [i, j] of V.zone) {
        const v = V.mesh.points[j]?.[i];
        if (v == null) continue;
        const pt = project(...bmlXY(V.mesh, i, j), v, W, H);
        ctx.beginPath();
        ctx.arc(pt[0], pt[1], 7 * dpr(), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (V.mark) {
      const [i, j] = V.mark;
      const pt = project(...bmlXY(V.mesh, i, j), V.mesh.points[j][i], W, H);
      ctx.beginPath();
      ctx.arc(pt[0], pt[1], 4.5 * dpr(), 0, Math.PI * 2);
      ctx.fillStyle = bmCss("--content-bg") || "#fff";
      ctx.fill();
      ctx.lineWidth = 2 * dpr();
      ctx.strokeStyle = bmCss("--text") || "#000";
      ctx.stroke();
    }
  }

  function drawMap(W, H) {
    const m = V.mesh, p = m.points, ny = p.length, nx = p[0].length;
    const padB = 22 * dpr(), padT = 6 * dpr(), padL = 6 * dpr();
    const aspect = (m.max[0] - m.min[0]) / Math.max(1e-6, m.max[1] - m.min[1]) || 1;
    let gw = W - padL * 2, gh = gw / aspect;
    if (gh > H - padB - padT) (gh = H - padB - padT), (gw = gh * aspect);
    const x0 = (W - gw) / 2, y0 = padT + (H - padB - padT - gh) / 2;
    const cw = gw / nx, ch = gh / ny;
    const decimals = cw >= 52 * dpr() ? 3 : 2;
    ctx.font = `${Math.max(8.5, Math.min(13, (cw / dpr()) * 0.24)) * dpr()}px ${bmCss("--font-mono") || "monospace"}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const cells = [];
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const v = p[j][i];
        // Row 0 is the front (min y): at the bottom.
        const x = x0 + i * cw, y = y0 + (ny - 1 - j) * ch;
        cells.push({ i, j, x, y, w: cw, h: ch });
        if (v == null) continue;
        const rgb = colorOf(v);
        ctx.fillStyle = `rgb(${rgb.join(",")})`;
        ctx.fillRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
        if (cw >= 26 * dpr() && ch >= 14 * dpr()) {
          ctx.fillStyle = bmlInk(rgb);
          ctx.fillText(bmSigned(v, decimals), x + cw / 2, y + ch / 2);
        }
      }
    const mk = (at, color) => {
      if (!at) return;
      const c = cells.find((q) => q.i === at[0] && q.j === at[1]);
      ctx.lineWidth = 2 * dpr();
      ctx.strokeStyle = color;
      ctx.strokeRect(c.x + 1.5, c.y + 1.5, c.w - 3, c.h - 3);
    };
    if (V.zone) {
      // A finding's cells: outlined in the accent, the rest a little faded.
      const inZone = new Set(V.zone.map(([i, j]) => `${i},${j}`));
      ctx.fillStyle = "rgba(128, 128, 128, 0.35)";
      for (const c of cells) if (!inZone.has(`${c.i},${c.j}`)) ctx.fillRect(c.x + 0.5, c.y + 0.5, c.w - 1, c.h - 1);
      for (const at of V.zone) mk(at, accent());
    }
    if (V.mark) mk(V.mark, bmCss("--text") || "#000");
    V.cells = cells;
    ctx.fillStyle = bmCss("--text-secondary") || "#888";
    ctx.font = `${11 * dpr()}px ${bmCss("--font-ui") || "system-ui"}`;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillText(`X ${fmtNum(Math.round(m.min[0]))}`, x0, y0 + gh + 15 * dpr());
    ctx.textAlign = "right";
    ctx.fillText(`${fmtNum(Math.round(m.max[0]))} mm`, x0 + gw, y0 + gh + 15 * dpr());
    ctx.textAlign = "center";
    ctx.fillText(tr("bm.front"), x0 + gw / 2, y0 + gh + 15 * dpr());
  }

  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!V.mesh) return;
    V.stops = V.stops || bmStops();
    if (V.mode === "3d") draw3d(W, H);
    else drawMap(W, H);
  }

  /* The probed point under the pointer: [i, j] of the mesh, or null. */
  function pick(ev) {
    const r = canvas.getBoundingClientRect();
    const x = (ev.clientX - r.left) * dpr(), y = (ev.clientY - r.top) * dpr();
    if (V.mode === "map") {
      const c = V.cells.find((q) => x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h);
      return c ? [c.i, c.j] : null;
    }
    const inside = (pt, poly) => {
      let s = false;
      for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
        const [xa, ya] = poly[a], [xb, yb] = poly[b];
        if (ya > pt[1] !== yb > pt[1] && pt[0] < ((xb - xa) * (pt[1] - ya)) / (yb - ya) + xa) s = !s;
      }
      return s;
    };
    for (let n = V.quads.length - 1; n >= 0; n--) {
      const q = V.quads[n];
      if (!inside([x, y], q.c)) continue;
      // Nearest probed point to the hovered cell's centre.
      const f = V.fine, m = V.mesh;
      const [fx, fy] = bmlXY(f, q.i + 0.5, q.j + 0.5);
      const nx = m.points[0].length, ny = m.points.length;
      const i = Math.round(((fx - m.min[0]) / (m.max[0] - m.min[0])) * (nx - 1));
      const j = Math.round(((fy - m.min[1]) / (m.max[1] - m.min[1])) * (ny - 1));
      return [Math.max(0, Math.min(nx - 1, i)), Math.max(0, Math.min(ny - 1, j))];
    }
    return null;
  }

  function showHover(at, ev) {
    V.mark = at;
    draw();
    if (!at) return hover.classList.add("hidden");
    const [x, y] = bmlXY(V.mesh, at[0], at[1]);
    const v = V.mesh.points[at[1]][at[0]];
    hover.textContent = `X ${fmtNum(Math.round(x))} · Y ${fmtNum(Math.round(y))} mm  ${v == null ? "—" : `${bmSigned(v, 3)} mm`}`;
    hover.classList.remove("hidden");
    const r = canvas.getBoundingClientRect();
    hover.style.left = `${Math.min(r.width - 10, Math.max(10, ev.clientX - r.left))}px`;
    hover.style.top = `${Math.max(0, ev.clientY - r.top - 34)}px`;
  }

  let drag = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (V.mode !== "3d") return;
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("dragging");
  });
  canvas.addEventListener("pointermove", (e) => {
    if (drag) {
      BM.cam.yaw -= (e.clientX - drag.x) * 0.008;
      BM.cam.pitch = Math.max(0.15, Math.min(1.45, BM.cam.pitch + (e.clientY - drag.y) * 0.008));
      drag = { x: e.clientX, y: e.clientY };
      hover.classList.add("hidden");
      V.mark = null;
      draw();
      return;
    }
    showHover(pick(e), e);
  });
  const stop = () => {
    drag = null;
    canvas.classList.remove("dragging");
  };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);
  canvas.addEventListener("pointerleave", () => !drag && showHover(null));
  canvas.addEventListener("wheel", (e) => {
    if (V.mode !== "3d") return;
    e.preventDefault();
    BM.cam.zoom = Math.max(0.5, Math.min(3, BM.cam.zoom * Math.exp(-e.deltaY * 0.0015)));
    draw();
  }, { passive: false });
  canvas.addEventListener("dblclick", () => {
    BM.cam = { yaw: -0.55, pitch: 0.9, zoom: 1 };
    draw();
  });

  V.ro = new ResizeObserver(resize);
  V.ro.observe(canvas.parentElement);

  return {
    set(mesh, opts) {
      V.mesh = mesh;
      V.diff = !!opts.diff;
      V.stats = bmlStats(mesh);
      V.scale = bmlScale(V.stats, opts.settings, V.diff);
      V.mode = opts.mode;
      V.relief = opts.relief;
      const n = Math.max(mesh.points.length, mesh.points[0].length);
      V.fine = bmlUpsample(mesh, Math.max(1, Math.min(6, Math.round(36 / Math.max(1, n - 1)))));
      V.stops = null;
      V.mark = null;
      // A new relief keeps the finding shown.
      if (opts.zone !== undefined) V.zone = opts.zone || null;
      resize();
      return V;
    },
    zone(z) {
      V.zone = z || null;
      draw();
    },
    draw,
    restyle() {
      V.stops = null;
      draw();
    },
    detach() {
      V.ro.disconnect();
    },
  };
}

/* The legend: the colour bar and the heights at its ends and middle. */
function bmLegend(el, stats, settings, diff) {
  const sc = bmlScale(stats, settings, diff);
  const lo = sc.center - sc.span, hi = sc.center + sc.span;
  el.innerHTML = `<span>${esc(bmSigned(lo, 2))}</span><i></i><span>${esc(bmSigned(hi, 2))} mm</span>
    <small>${esc(diff ? tr("bm.legend_diff") : tr("bm.legend", { mean: bmSigned(stats.mean, 3) }))}</small>`;
}

function bmViewerDetach() {
  BM.viewer?.detach();
  BM.viewer = null;
}
function bmViewerAttach(mesh, st, zone) {
  bmViewerDetach();
  BM.viewer = bmMakeViewer($("bm-canvas"), $("bm-hover"));
  BM.viewer.set(mesh, { mode: BM.mode, relief: BM.relief, settings: st, zone });
  bmLegend($("bm-legend"), bmlStats(mesh), st, false);
}

/* ------------------------------------------------------------ compare */

function bmOpenCompare(at) {
  const hist = BM.hist.get(BM.pid) || [];
  if (hist.length < 2) return;
  const newest = hist[hist.length - 1];
  BM.cmp.a = at === newest.at ? hist[hist.length - 2].at : at;
  BM.cmp.b = newest.at;
  BM.cmp.view = "d";
  BM.cmp.mode = BM.mode;
  openSheet($("bmcompare"));
  requestAnimationFrame(bmRenderCompare);
}

function bmRenderCompare() {
  const pid = BM.pid, st = bmSettingsOf(pid);
  const hist = BM.hist.get(pid) || [];
  const a = hist.find((m) => m.at === BM.cmp.a), b = hist.find((m) => m.at === BM.cmp.b);
  // The measurements as chips, newest first: date, deviation, status.
  const chips = (pick) => [...hist].reverse().map((m) => {
    const dev = bmlStats(m).dev, on = m.at === pick;
    return `<button type="button" class="bm-chip${on ? " on" : ""}" role="radio" aria-checked="${on}" data-at="${m.at}"><i class="${bmlStatus(dev, st)}"></i><b>${esc(bmWhen(m.at))}</b><small>${esc(bmMm(dev))} mm</small></button>`;
  }).join("");
  $("bmc-a").innerHTML = chips(BM.cmp.a);
  $("bmc-b").innerHTML = chips(BM.cmp.b);
  for (const id of ["bmc-a", "bmc-b"]) $(id).querySelector(".on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  document.querySelectorAll("#bmc-views [data-cv]").forEach((x) => x.classList.toggle("on", x.dataset.cv === BM.cmp.view));
  document.querySelectorAll("#bmc-modes [data-bmode]").forEach((x) => x.classList.toggle("on", x.dataset.bmode === BM.cmp.mode));
  if (!a || !b) return;
  const da = bmlStats(a).dev, db = bmlStats(b).dev, delta = bmlDelta(da, db);
  const diff = bmlDiff(a, b);
  const better = delta < 0 ? "good" : delta > 0 ? "out" : "watch";
  $("bmc-sum").innerHTML = `<span class="bm-status ${bmlStatus(da, st)}"><i></i>${esc(bmMm(da))} mm</span><span class="bm-cmp-arrow">→</span>
    <span class="bm-status ${bmlStatus(db, st)}"><i></i>${esc(bmMm(db))} mm</span>
    <b class="bm-delta ${better}">${esc(bmSigned(delta, 2))} mm</b><small>${esc(tr(better === "good" ? "bm.compare.better" : better === "out" ? "bm.compare.worse" : "bm.compare.same"))}</small>`;
  const mesh = BM.cmp.view === "a" ? a : BM.cmp.view === "b" ? b : diff;
  $("bmc-views").querySelector('[data-cv="d"]').disabled = !diff;
  if (!mesh) {
    BM.cmp.view = "b";
    return bmRenderCompare();
  }
  if (!BM.cmpViewer) BM.cmpViewer = bmMakeViewer($("bmc-canvas"), $("bmc-hover"));
  BM.cmpViewer.set(mesh, { mode: BM.cmp.mode, relief: BM.relief, settings: st, diff: mesh === diff });
  bmLegend($("bmc-legend"), bmlStats(mesh), st, mesh === diff);
}

for (const [id, side] of [["bmc-a", "a"], ["bmc-b", "b"]]) {
  $(id).addEventListener("click", (e) => {
    const c = e.target.closest("[data-at]");
    if (c) (BM.cmp[side] = +c.dataset.at), bmRenderCompare();
  });
}
$("bmc-views").addEventListener("click", (e) => {
  const b = e.target.closest("[data-cv]");
  if (b && !b.disabled) (BM.cmp.view = b.dataset.cv), bmRenderCompare();
});
$("bmc-modes").addEventListener("click", (e) => {
  const b = e.target.closest("[data-bmode]");
  if (b) (BM.cmp.mode = b.dataset.bmode), bmRenderCompare();
});
$("bmc-close").addEventListener("click", () => closeSheet($("bmcompare")));

/* ------------------------------------------------------------ settings sheet */

function bmOpenSettings() {
  const pid = BM.pid;
  const p = bmPrinter(pid);
  $("bms-printer").textContent = tr("bm.set.for", { name: p?.name || p?.host || "" });
  // Choices as segments: the values offered, nothing to type.
  const seg = (id, key, values, label) => ($(id).innerHTML = segHtml(values.map((v) => ({ value: v, label: label(v) })), { key, cls: "labeled" }));
  seg("bms-level", "level", Object.keys(BML_LEVELS), (k) => tr(`bm.level.${k}`));
  seg("bms-days", "days", BML_REMIND_DAYS, (n) => tr("bm.set.days_n", { n }));
  seg("bms-prints", "prints", BML_REMIND_PRINTS, (n) => (n ? fmtNum(n) : tr("bm.set.prints_off")));
  seg("bms-keep", "keep", BML_KEEPS, (n) => fmtNum(n));
  bmFillSettings(bmSettingsOf(pid));
  openSheet($("bmsettings"));
}
function bmFillSettings(s) {
  const level = bmlLevelOf(s);
  const on = (id, key, v) => document.querySelectorAll(`#${id} [data-${key}]`).forEach((b) => {
    const yes = b.dataset[key] === String(v);
    b.classList.toggle("on", yes);
    b.setAttribute("aria-checked", String(yes));
  });
  on("bms-level", "level", level);
  on("bms-days", "days", s.remindDays);
  on("bms-prints", "prints", s.remindPrints);
  on("bms-keep", "keep", s.keep);
  $("bms-level-sub").textContent = tr(level === "custom" ? "bm.set.level_custom" : `bm.set.level_${level}`, { good: bmMm(s.good), limit: bmMm(s.limit) });
  $("bms-good").value = s.good;
  $("bms-limit").value = s.limit;
  $("bms-good-v").textContent = `${bmMm(s.good)} mm`;
  $("bms-limit-v").textContent = `${bmMm(s.limit)} mm`;
  $("bms-alert").checked = s.alert;
  $("bms-remind").checked = s.remind;
  ["bms-days-row", "bms-prints-row"].forEach((id) => $(id).classList.toggle("off", !s.remind));
}
/* Saves a change; `patch` from a segment, or the sliders and switches. */
async function bmSettingsChanged(which, patch = {}) {
  const pid = BM.pid, old = bmSettingsOf(pid);
  let good = +$("bms-good").value, limit = +$("bms-limit").value;
  // The two limits push each other: good never above the threshold.
  if (which === "good" && good > limit) limit = good;
  if (which === "limit" && limit < good) good = limit;
  const s = bmlSettings({ ...old, good, limit, alert: $("bms-alert").checked, remind: $("bms-remind").checked, ...patch });
  bmSaveSettings(pid, s);
  bmFillSettings(s);
  if (s.keep < old.keep) {
    const h = await invoke("bed_mesh_keep", { printerId: pid, keep: s.keep }).catch((e) => (toast(String(e), true), null));
    if (h) BM.hist.set(pid, h);
  }
  bmAfterChange();
}
$("bms-good").addEventListener("input", () => bmSettingsChanged("good"));
$("bms-limit").addEventListener("input", () => bmSettingsChanged("limit"));
$("bms-alert").addEventListener("change", () => bmSettingsChanged("alert"));
$("bms-remind").addEventListener("change", () => bmSettingsChanged("remind"));
$("bmsettings").addEventListener("click", (e) => {
  const b = e.target.closest("[data-level], [data-days], [data-prints], [data-keep]");
  if (!b) return;
  const d = b.dataset;
  if (d.level) return bmSettingsChanged("level", BML_LEVELS[d.level]);
  if (d.days) return bmSettingsChanged("days", { remindDays: +d.days });
  if (d.prints) return bmSettingsChanged("prints", { remindPrints: +d.prints });
  if (d.keep) return bmSettingsChanged("keep", { keep: +d.keep });
});
// Arrows move between a row's segments and choose, as in a radio group.
for (const id of ["bms-level", "bms-days", "bms-prints", "bms-keep"]) segKeys($(id), (b) => b.click());
$("bms-reset").addEventListener("click", () => bmSettingsChanged("reset", { ...BML_DEFAULTS, keep: bmSettingsOf(BM.pid).keep }));
$("bms-done").addEventListener("click", () => closeSheet($("bmsettings")));
$("bm-settings-btn").addEventListener("click", bmOpenSettings);

/* ------------------------------------------------------------ measuring */

/* The assistant: ① prepare (a checklist the app fills in where it can, the
   bed confirmed empty, a temperature proposed), ② measure (each phase,
   an emergency stop), ③ the result (in words, against the previous
   measurement, what to do next). Its state: BM.wiz. */

const bmTempKey = (pid) => `snapstudio.bm.temp.${pid}`;
const bmPaceKey = (pid) => `snapstudio.bm.pace.${pid}`;

function bmEstimateFor(pid, temp) {
  const live = BM.live.get(pid), c = live?.config;
  return bmlEstimate({
    points: c ? c.count[0] * c.count[1] : 169,
    samples: c?.samples ?? 3,
    preheat: c?.preheat ?? 60,
    temp,
    bed: live?.bed?.current ?? 25,
    autoMacro: c ? c.auto_macro : true,
    homed: live?.homed || "",
    perPoint: +localStorage.getItem(bmPaceKey(pid)) || null,
  });
}

function bmRunLabel() {
  const r = BM.run;
  const ph = bmlPhase(BM.live.get(r.pid), r.temp);
  return ph.phase === "probing" ? tr("bm.run.point_short", { n: ph.current, total: ph.total }) : tr("bm.run.short");
}

/* Opens the assistant on the printer shown. `resume`: the view to go back
   to and the send sheet to reopen afterwards; `fix`: measuring again after
   a correction (the result says whether it worked). */
async function bmOpenMeasure(opts = {}) {
  const pid = BM.pid;
  const p = bmPrinter(pid);
  $("bmm-printer").textContent = p?.name || p?.host || "";
  const running = BM.run?.pid === pid;
  if (!running || !BM.wiz || BM.wiz.pid !== pid) BM.wiz = { pid, step: running ? "run" : "prep", resume: opts.resume || null, fix: !!opts.fix, result: null, tempSet: false };
  else if (opts.resume) BM.wiz.resume = opts.resume;
  if (BM.wiz.step === "prep") {
    $("bmm-empty").checked = false;
    $("bmm-clean").checked = false;
  }
  bmWizRender();
  openSheet($("bmmeasure"));
  // The printer's state, settings and last print, fresh.
  if (BM.wiz.step === "prep") {
    await bmLoad(pid).catch(() => null);
    if (BM.wiz?.pid === pid && BM.wiz.step === "prep") bmWizRender();
  }
}

function bmWizRender() {
  const w = BM.wiz;
  if (!w) return;
  const order = ["prep", "run", "done"];
  document.querySelectorAll("#bmm-steps [data-step]").forEach((li) => {
    const k = order.indexOf(li.dataset.step), cur = order.indexOf(w.step);
    li.classList.toggle("on", k === cur);
    li.classList.toggle("done", k < cur);
  });
  $("bmm-form").classList.toggle("hidden", w.step !== "prep");
  $("bmm-run").classList.toggle("hidden", w.step !== "run");
  $("bmm-done").classList.toggle("hidden", w.step !== "done");
  $("bmm-stop").classList.toggle("hidden", w.step !== "run");
  if (w.step !== "run") $("bmm-abort").classList.add("hidden");
  $("bmm-alt").classList.add("hidden");
  $("bmm-cancel").classList.remove("hidden");
  $("bmm-msg").textContent = "";
  if (w.step === "prep") bmPrepRender();
  else if (w.step === "run") {
    $("bmm-go").classList.add("hidden");
    $("bmm-cancel").textContent = tr("bm.run.hide");
    bmRunRender();
  } else bmDoneRender();
}

/* ① The checklist. */
function bmPrepRender() {
  const w = BM.wiz, pid = w.pid, live = BM.live.get(pid), c = live?.config;
  const printing = bmPrinting(pid);
  const other = BM.run && BM.run.pid !== pid ? bmPrinter(BM.run.pid) : null;
  const why = other ? tr("bm.measure.other", { name: other.name || other.host }) : !live ? tr("bm.offline") : !live.supported ? tr("bm.measure.unavailable") : printing ? tr("bm.measure.printing") : bmlBusy(live) ? tr("bm.measure.busy") : "";
  const ready = !why;
  $("bmm-ready-ic").className = `bm-check ${live ? (ready ? "ok" : "ko") : "wait"}`;
  $("bmm-ready-sub").textContent = !live && BM.loading ? tr("bm.reading") : why || tr(/x/.test(live.homed) && /y/.test(live.homed) && /z/.test(live.homed) ? "bm.prep.ready" : "bm.prep.ready_home");
  // A print just ended: its part may be on the bed.
  const recent = bmlRecentPrint(live?.last_job);
  const warn = $("bmm-recent");
  warn.classList.toggle("hidden", recent == null && live?.state !== "complete");
  if (recent != null) warn.textContent = tr("bm.prep.recent", { t: fmtDuration(Math.max(1, recent) * 60), file: live.last_job.filename || "" });
  else if (live?.state === "complete") warn.textContent = tr("bm.prep.recent_any");
  // The temperature: proposed once, then the user's.
  // Never above the bed's max_temp (100 °C on the U1).
  const max = live?.config?.bed_max || 100;
  $("bmm-temp").max = String(max);
  const sug = bmlSuggestTemp(live?.last_job, localStorage.getItem(bmTempKey(pid)), max);
  if (!w.tempSet) $("bmm-temp").value = String(sug.temp);
  const temp = Math.max(0, Math.min(max, +$("bmm-temp").value || 0));
  $("bmm-temp-v").textContent = temp > 0 ? `${fmtNum(temp)} °C` : tr("bm.prep.no_heat");
  $("bmm-temp-sub").textContent = sug.from === "last" ? tr("bm.prep.temp_last", { file: sug.file }) : sug.from === "stored" ? tr("bm.prep.temp_stored") : tr("bm.prep.temp_default");
  $("bmm-eta").textContent = tr("bm.prep.eta", { t: fmtDuration(bmEstimateFor(pid, temp)), n: c ? fmtNum(c.count[0] * c.count[1]) : "—" });
  const empty = $("bmm-empty").checked;
  const go = $("bmm-go");
  go.classList.remove("hidden");
  go.textContent = tr("bm.measure.go");
  go.disabled = !ready || !empty;
  $("bmm-cancel").textContent = tr("common.cancel");
  $("bmm-msg").textContent = ready && !empty ? tr("bm.prep.confirm_empty") : "";
}
$("bmm-temp").addEventListener("input", () => {
  if (BM.wiz) BM.wiz.tempSet = true;
  bmPrepRender();
});
$("bmm-empty").addEventListener("change", bmPrepRender);

async function bmStartMeasure() {
  const pid = BM.pid;
  if (BM.run || bmPrinting(pid) || !$("bmm-empty").checked) return;
  const live = BM.live.get(pid);
  const temp = Math.max(0, Math.min(live?.config?.bed_max || 100, Math.round(+$("bmm-temp").value || 0)));
  localStorage.setItem(bmTempKey(pid), String(temp));
  const hist = BM.hist.get(pid) || [];
  const run = {
    pid, temp, start: Date.now(), probeStart: null, timer: 0, failed: null, stopped: false,
    before: live?.mesh || null,
    prev: hist[hist.length - 1] || null, // the measurement this one is compared with
    homedAtStart: /x/.test(live?.homed || "") && /y/.test(live?.homed || "") && /z/.test(live?.homed || ""),
    // The U1's macro: a 2 min soak, the bed's preheat, its corner check.
    u1: !!live?.config?.auto_macro,
    preheat: live?.config?.preheat ?? 60,
    soakStart: null, // when the bed reached its temperature (ms)
    seen: false, // the printer's own leveling began (preheat, corners, probing)
    aborted: false,
  };
  BM.run = run;
  BM.wiz.step = "run";
  bmWizRender();
  bmToolbar();
  run.timer = setInterval(() => bmPoll(run), 2000);
  try {
    await invoke("bed_mesh_measure", { printerId: pid, temp });
  } catch (e) {
    run.failed = String(e);
    // The request may have ended before the printer (45 min, a network
    // drop): what the printer does decides.
    await bmFollow(run);
  }
  await bmFinish(run);
}

/* Follows a measurement whose request ended early, until the printer is
   done with it; unreachable for 10 min: given up. */
async function bmFollow(run) {
  if (run.stopped) return;
  run.following = true;
  let lastOk = Date.now();
  while (BM.run === run && !run.stopped) {
    const live = await invoke("bed_mesh_read", { printerId: run.pid, light: true }).catch(() => null);
    if (live) {
      lastOk = Date.now();
      if (!bmlStillMeasuring(live, run.temp)) break;
      // Still at it: the error was the connection's, not the printer's.
      run.failed = null;
    } else if (Date.now() - lastOk > 10 * 60 * 1000) break;
    if (BM.wiz?.step === "run") bmRunRender();
    await new Promise((r) => setTimeout(r, 3000));
  }
  run.following = false;
}

/* Following it: a light read (no printer configuration) every 2 s. */
async function bmPoll(run) {
  // One read at a time: on a slow network, a tick waits for the last one.
  if (BM.run !== run || run.polling) return;
  run.polling = true;
  const live = await invoke("bed_mesh_read", { printerId: run.pid, light: true }).catch(() => null);
  run.polling = false;
  if (BM.run !== run || !live) return;
  const prev = BM.live.get(run.pid);
  BM.live.set(run.pid, { ...live, config: live.config || prev?.config || null, last_job: prev?.last_job || null });
  if (live.progress?.state === "probing" && !run.probeStart) run.probeStart = { t: Date.now(), n: live.progress.current };
  if (["preheating", "prescanning", "probing"].includes(live.progress?.state)) run.seen = true;
  if (BM.wiz?.step === "run") bmRunRender();
  bmToolbar();
}

async function bmFinish(run) {
  clearInterval(run.timer);
  const live = await invoke("bed_mesh_read", { printerId: run.pid }).catch(() => null);
  if (live) BM.live.set(run.pid, live);
  BM.run = null;
  const mesh = live?.mesh;
  const fresh = mesh && !mesh.partial && !(run.before && bmSame(mesh, run.before));
  const sheetOpen = !$("bmmeasure").classList.contains("hidden");
  let note;
  // A new full mesh is the proof: a connection lost on the way does not
  // make it a failure.
  if (fresh && !run.stopped && !run.aborted) {
    // Its pace, for the next estimate.
    if (run.probeStart && live.progress?.total) {
      const pace = (Date.now() - run.probeStart.t) / 1000 / Math.max(1, live.progress.total - run.probeStart.n);
      if (pace > 0.2 && pace < 20) localStorage.setItem(bmPaceKey(run.pid), pace.toFixed(2));
    }
    await bmRecord(run.pid, mesh, true);
    if (BM.pid === run.pid) BM.shown = null;
    const st = bmSettingsOf(run.pid);
    const dev = bmlStats(mesh).dev;
    const status = bmlStatus(dev, st);
    const result = { ok: true, mesh, dev, status, prev: run.prev, findings: status === "good" ? [] : bmlShape(mesh) };
    if (BM.wiz?.pid === run.pid) Object.assign(BM.wiz, { step: "done", result });
    note = tr("bm.run.done", { dev: bmMm(dev), st: tr(`bm.st.${status}`) });
  } else {
    const msg = run.stopped ? tr("bm.run.stopped") : run.aborted ? tr("bm.run.aborted_app") : run.failed || (live?.progress?.state === "aborted" ? tr("bm.run.aborted") : tr("bm.run.nomesh"));
    if (BM.wiz?.pid === run.pid) Object.assign(BM.wiz, { step: "done", result: { ok: false, msg } });
    note = msg;
  }
  if (BM.wiz?.pid === run.pid) bmWizRender();
  // Elsewhere in the app, or in another app: said there.
  if (!sheetOpen) toast(note, !BM.wiz?.result?.ok);
  if (!document.hasFocus()) invoke("app_notify", { title: tr("bm.notify_title", { name: bmPrinter(run.pid)?.name || "" }), body: note }).catch(() => {});
  bmToolbar();
  bmAfterChange();
}

/* ② Each step (the U1's: soak, preheat, corners), the one under way, its
   countdown or progress; the stops that can act now. */
function bmRunRender() {
  const run = BM.run;
  if (!run) return;
  const live = BM.live.get(run.pid);
  const ph = bmlRunPhase(live, run);
  if (ph.soakStart && !run.soakStart) run.soakStart = ph.soakStart;
  const steps = bmlRunSteps(run);
  const ci = steps.indexOf(ph.cur);
  $("bmm-phases").innerHTML = steps.map((k, n) => `<li class="${ci < 0 ? "" : n < ci ? "done" : n === ci ? "on" : ""}"><i></i>${esc(tr(`bm.phase.${k}`))}</li>`).join("");
  const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
  const text = ph.cur === "probe" ? (ph.total ? tr("bm.run.point", { n: ph.n, total: ph.total }) : tr("bm.run.start"))
    : ph.cur === "home" ? tr("bm.run.home")
    : ph.cur === "heat" ? tr("bm.run.heating", { t: ph.t == null ? "—" : fmtDec(ph.t, 0), target: ph.target })
    : ph.cur === "soak" ? tr("bm.run.soak_left", { t: clock(Math.ceil(ph.left)) })
    : ph.cur === "preheat" ? tr("bm.run.preheat", { s: Math.round(ph.left) })
    : ph.cur === "prescan" ? tr("bm.run.prescan")
    : tr("bm.run.aborted");
  $("bmm-phase").textContent = text;
  $("bmm-phase-why").textContent = ph.cur === "soak" ? tr("bm.run.soak_why") : ph.cur === "preheat" ? tr("bm.run.preheat_why") : ph.cur === "prescan" ? tr("bm.run.prescan_why") : "";
  const bar = $("bmm-progress");
  bar.classList.toggle("indeterminate", ph.pct == null);
  bar.querySelector("i").style.width = ph.pct == null ? "" : `${(Math.min(1, ph.pct) * 100).toFixed(1)}%`;
  const eta = bmEstimateFor(run.pid, run.temp);
  const left = Math.max(60, eta - (Date.now() - run.start) / 1000);
  $("bmm-left").textContent = run.following ? tr("bm.run.following") : tr("bm.run.left", { t: fmtDuration(left), elapsed: fmtDuration((Date.now() - run.start) / 1000) });
  // Snapmaker's clean stop acts once its leveling began; before, only the
  // emergency stop can interrupt the heating and the soak.
  const clean = run.u1 && ["preheat", "prescan", "probe"].includes(ph.cur) && !run.aborted && !run.stopped;
  $("bmm-abort").classList.toggle("hidden", !clean);
  $("bmm-stop").disabled = run.stopped;
  $("bmm-stop-note").textContent = tr(clean ? "bm.run.stop_note_clean" : run.u1 ? "bm.run.stop_note_wait" : "bm.run.stop_note");
}

/* Stops the probing cleanly (the U1): the script then turns the bed off. */
async function bmAbort() {
  const run = BM.run;
  if (!run || run.aborted || run.stopped) return;
  const ok = await confirmDelete(tr("bm.abort.title"), tr("bm.abort.msg"), tr("bm.abort.ok"));
  if (!ok || BM.run !== run) return;
  run.aborted = true;
  bmRunRender();
  await invoke("bed_mesh_abort", { printerId: run.pid }).catch((e) => {
    run.aborted = false;
    toast(String(e), true);
    bmRunRender();
  });
}

/* Emergency stop: everything off at once, Klipper restarts. */
async function bmStop() {
  const run = BM.run;
  if (!run || run.stopped) return;
  const ok = await confirmDelete(tr("bm.stop.title"), tr("bm.stop.msg"), tr("bm.stop.ok"));
  if (!ok || BM.run !== run) return;
  run.stopped = true;
  bmRunRender();
  await invoke("bed_mesh_stop", { printerId: run.pid }).catch((e) => toast(String(e), true));
}

/* ③ The result in words, against the measurement before. */
function bmDoneRender() {
  const w = BM.wiz, r = w.result, go = $("bmm-go"), alt = $("bmm-alt"), cancel = $("bmm-cancel");
  go.classList.remove("hidden");
  go.disabled = false;
  if (!r.ok) {
    $("bmm-done").innerHTML = `<div class="bm-verdict fail"><b>${esc(tr("bm.done.fail"))}</b><small>${esc(r.msg)}</small></div>`;
    go.textContent = tr("bm.done.retry");
    cancel.textContent = tr("common.close");
  } else {
    const prev = r.prev && bmlStats(r.prev);
    let vs = "";
    if (prev) {
      const delta = bmlDelta(prev.dev, r.dev);
      const k = w.fix && r.status === "good" && delta < 0 ? "fixed" : delta < 0 ? "better" : delta > 0 ? "worse" : "same";
      vs = tr(`bm.done.${k}`, { d: bmDay(r.prev.at), from: bmMm(prev.dev), to: bmMm(r.dev) });
    }
    const what = r.status === "good" ? tr("bm.done.good_sub") : r.findings.length ? tr("bm.done.found", { n: r.findings.length }) : tr("bm.done.look");
    const list = r.findings.slice(0, 3).map((f) => `<li>${esc(bmFindingText(f, r.mesh).title)}</li>`).join("");
    $("bmm-done").innerHTML = `<div class="bm-verdict ${r.status}">
        <div class="bm-dev ${r.status}"><b>${esc(bmMm(r.dev))}</b><span>mm</span></div>
        <div class="bm-verdict-text"><span class="bm-status ${r.status}"><i></i>${esc(tr(`bm.st.${r.status}`))}</span>${vs ? `<small>${esc(vs)}</small>` : ""}</div>
      </div>
      <p class="bm-note">${esc(what)}</p>${list ? `<ul class="bm-vlist">${list}</ul>` : ""}`;
    if (r.status === "good") {
      go.textContent = tr("bm.done.ok");
      cancel.classList.add("hidden");
    } else {
      go.textContent = tr("bm.done.cause");
      cancel.textContent = tr("common.close");
    }
  }
  if (w.resume) {
    alt.classList.remove("hidden");
    alt.textContent = tr("bm.done.resume");
  }
}

$("bmm-go").addEventListener("click", () => {
  const w = BM.wiz;
  if (!w) return;
  if (w.step === "prep") return bmStartMeasure();
  if (w.step !== "done") return;
  if (!w.result.ok) {
    w.step = "prep";
    $("bmm-empty").checked = false;
    return bmWizRender();
  }
  closeSheet($("bmmeasure"));
  if (w.result.status !== "good") bmShowCause();
});
$("bmm-alt").addEventListener("click", () => {
  const back = BM.wiz?.resume;
  closeSheet($("bmmeasure"));
  if (!back) return;
  // Back where the print was being sent, its sheet as it was.
  if (back.view && back.view !== window.currentView) switchView(back.view);
  openSheet($("sendmodal"));
  if (typeof checkSendPrinter === "function") checkSendPrinter();
});
$("bmm-stop").addEventListener("click", bmStop);
$("bmm-abort").addEventListener("click", bmAbort);
$("bmm-cancel").addEventListener("click", () => closeSheet($("bmmeasure")));
$("bm-measure-btn").addEventListener("click", () => bmOpenMeasure());

/* The diagnosis in view, its first finding shown on the map. */
function bmShowCause() {
  if (MT.tab !== "level") mtSetTab("level");
  BM.shown = null;
  BM.zone = null;
  bmRender();
  requestAnimationFrame(() => $("bm-diag")?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

/* ------------------------------------------------------------ events */

$("bm-body").addEventListener("click", async (e) => {
  if (e.target.closest("[data-bm-retry]")) return maintShow(BM.pid);
  if (e.target.closest("[data-bm-measure]")) return bmOpenMeasure();
  if (e.target.closest("[data-bm-fixed]")) return bmOpenMeasure({ fix: true });
  if (e.target.closest("[data-bm-cause]")) return $("bm-diag")?.scrollIntoView({ behavior: "smooth", block: "start" });
  const zone = e.target.closest("[data-bm-zone]");
  if (zone) {
    // One finding at a time on the map; again: none.
    const n = +zone.dataset.bmZone;
    BM.zone = { ...BM.zone, n: BM.zone?.n === n ? null : n };
    return bmRender();
  }
  const cmp = e.target.closest("[data-bm-cmp]");
  if (cmp) return bmOpenCompare(+cmp.dataset.bmCmp);
  const del = e.target.closest("[data-bm-del]");
  if (del) {
    const at = +del.dataset.bmDel;
    const ok = await confirmDelete(tr("bm.delete_title"), tr("bm.delete_msg", { d: bmWhen(at) }));
    if (!ok) return;
    const h = await invoke("bed_mesh_remove", { printerId: BM.pid, at }).catch((err) => (toast(String(err), true), null));
    if (h) BM.hist.set(BM.pid, h);
    if (BM.shown === at) BM.shown = null;
    return bmAfterChange();
  }
  const mode = e.target.closest("[data-bmode]");
  if (mode && mode.dataset.bmode !== BM.mode) {
    BM.mode = mode.dataset.bmode;
    localStorage.setItem("snapstudio.bm.mode", BM.mode);
    return bmRender();
  }
  const show = e.target.closest("[data-bm-show]");
  if (show) {
    const v = show.dataset.bmShow;
    BM.shown = v === "" ? null : v === "live" ? "live" : +v;
    bmRender();
  }
});
$("bm-body").addEventListener("toggle", (e) => {
  if (e.target.id !== "bm-more") return;
  BM.moreOpen = e.target.open;
  localStorage.setItem("snapstudio.bm.more", BM.moreOpen ? "1" : "0");
  if (BM.moreOpen) bmDrawTrend(BM.pid);
}, true);
$("bm-body").addEventListener("keydown", (e) => {
  const row = e.target.closest(".bm-hrow");
  if (row && (e.key === "Enter" || e.key === " ") && e.target === row) {
    e.preventDefault();
    row.click();
  }
});
$("bm-body").addEventListener("input", (e) => {
  if (e.target.id !== "bm-relief") return;
  BM.relief = +e.target.value;
  $("bm-relief-v").textContent = fmtNum(BM.relief);
  localStorage.setItem("snapstudio.bm.relief", String(BM.relief));
  if (BM.viewer) {
    const s = bmShownMesh(BM.pid);
    if (s) BM.viewer.set(s.mesh, { mode: BM.mode, relief: BM.relief, settings: bmSettingsOf(BM.pid) });
  }
});
window.addEventListener("themechange", () => {
  BM.viewer?.restyle();
  BM.cmpViewer?.restyle();
});
window.addEventListener("resize", () => window.currentView === "maint" && MT.tab === "level" && bmDrawTrend(BM.pid));

/* ------------------------------------------------------------ print launch */

/* The send sheet's banner: the printer chosen is out of tolerance. */
async function bmSendBanner(pid) {
  const el = $("snd-bed");
  if (!pid) return el.classList.add("hidden");
  if (!BM.hist.has(pid)) {
    const h = await invoke("bed_mesh_history", { printerId: pid }).catch(() => null);
    if (h) BM.hist.set(pid, h);
  }
  if (typeof sendPrinter === "function" && sendPrinter()?.id !== pid) return;
  const a = bmAlertOf(pid);
  el.classList.toggle("hidden", !a);
  el.dataset.pid = pid;
  if (a) $("snd-bed-text").textContent = tr("bm.send_banner", { dev: bmMm(a.dev) });
}
/* "Measure first": the assistant, then back to the send sheet as it was. */
$("snd-bed-go").addEventListener("click", () => {
  const pid = $("snd-bed").dataset.pid;
  if (!pid) return;
  const view = window.currentView;
  closeSheet($("sendmodal"));
  // The tab opens at once; the printer's answer follows.
  maintShow(pid, "level");
  bmOpenMeasure({ resume: { view } });
});
