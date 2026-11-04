"use strict";
/* Care & Tuning › Control: the printer's basic actions (#17), in three
   layers so the quick panels of the 3D printer view (#34) reuse them
   rather than copy them:

   1. One command service per app (CTL): each printer's state and
      configuration (control.rs), its reads, its actions — one at a time —
      and who to tell when something changes (ctlSubscribe).
   2. One filament source: ctlSpool(pid, n), from the spools heads.js
      reads (colour, material, name).
   3. Components with a full and a compact mode, one per function: head
      (nozzle), spool, bed, light, emergency stop. Each is HTML
      (ctl…Html) plus a paint (ctl…Paint) that updates it in place; any
      element with data-ctl-pid gets their events from ctlBind.

   The tab composes the full components as the validated mockup; a quick
   panel (#34) will compose the compact ones inside a Prepare-style
   floating panel. The interface never sends G-code: control.rs turns an
   Action into the U1's commands or refuses it, and control-logic.js
   holds the same rules to grey out and explain. Opening with a context:
   ctlOpen(pid, { head }) — the printer page's shortcut and #34's "All
   controls" link. */

/* ================================================================ service */

const CTL = {
  data: new Map(), // pid → { st, cfg, err, reading, slotsAt }
  busy: new Map(), // pid → the action under way (label)
  subs: new Set(),
};

function ctlData(pid) {
  if (!CTL.data.has(pid)) CTL.data.set(pid, { st: null, cfg: null, err: null, reading: false, slotsAt: 0 });
  return CTL.data.get(pid);
}
/* The state to act on: none while the printer does not answer (the last
   one read is not the printer's now). */
const ctlState = (pid) => {
  const d = ctlData(pid);
  return d.err ? null : d.st;
};
const ctlBusy = (pid) => CTL.busy.get(pid) || null;

/* Told of every change of a printer's state, spools or action under way. */
function ctlSubscribe(fn) {
  CTL.subs.add(fn);
  return () => CTL.subs.delete(fn);
}
const ctlEmit = (pid) => CTL.subs.forEach((fn) => fn(pid));

/* Reads a printer (one read at a time); `config` once per opening. */
async function ctlRead(pid, config = false) {
  const d = ctlData(pid);
  if (!pid || d.reading) return;
  d.reading = true;
  try {
    const r = await invoke("control_read", { printerId: pid, config: config || !d.cfg });
    d.st = r.state;
    if (r.config) d.cfg = r.config;
    d.err = null;
  } catch (e) {
    // The raw error (with the address tried) stays in the console; the
    // tab only says the printer does not answer.
    if (!d.err) console.warn("control_read", pid, String(e));
    d.err = String(e);
  } finally {
    d.reading = false;
  }
  ctlEmit(pid);
}

/* The heads' spools, read from the printer (the printer page reads them
   too; opened straight on Control they are not known yet). */
async function ctlSpools(pid) {
  if (!pid || typeof headsRefreshSlots !== "function") return;
  ctlData(pid).slotsAt = Date.now();
  await headsRefreshSlots(pid);
  ctlEmit(pid);
}

/* The filament source: what is in head `n` (ctlSpoolInfo). */
function ctlSpool(pid, n) {
  const slots = typeof headsSlots === "function" ? headsSlots(pid) : [];
  return ctlSpoolInfo(slots.find((s) => s.index === n), typeof colorName === "function" ? colorName : null);
}
window.addEventListener("headschange", (e) => e.detail?.pid && ctlEmit(e.detail.pid));

const CTL_CONFIRM = {
  emergency_stop: ["ctl.confirm.estop_t", "ctl.confirm.estop", "ctl.estop_ok"],
  motors_off: ["ctl.confirm.motors_t", "ctl.confirm.motors", "ctl.motors_off"],
  firmware_restart: ["ctl.confirm.restart_t", "ctl.confirm.restart", "ctl.restart"],
};

/* Runs an action on a printer; while it runs, the rest waits (the
   emergency stop never does). */
async function ctlRun(pid, action, label) {
  const stop = action.kind === "emergency_stop";
  if (!pid || (ctlBusy(pid) && !stop)) return false;
  const c = CTL_CONFIRM[action.kind];
  if (c && !(await confirmDelete(tr(c[0]), tr(c[1]), tr(c[2])))) return false;
  if (!stop) CTL.busy.set(pid, label || tr("ctl.doing.any"));
  ctlEmit(pid);
  let ok = true;
  try {
    await invoke("control_run", { printerId: pid, action });
  } catch (e) {
    ok = false;
    console.warn("control_run", action.kind, String(e));
    toast(errNoUrl(e) || tr("ctl.offline"), true);
  } finally {
    if (!stop) CTL.busy.delete(pid);
    await ctlRead(pid);
    // A spool went in or out, or was declared.
    if (["load", "unload", "filament"].includes(action.kind)) ctlSpools(pid);
  }
  return ok;
}

/* Opens Care & Tuning › Control on a printer, with a context: `head`
   brings that head's card into view. The printer page's shortcut and the
   quick panels' "All controls" go through here. */
function ctlOpen(pid, ctx = {}) {
  if (pid) maintShow(pid, "control", ctx);
}

/* ============================================================= components */

const CTL_ICONS = {
  up: '<path d="M12 6l6 7H6z"/>',
  down: '<path d="M12 18l6-7H6z"/>',
  left: '<path d="M6 12l7-6v12z"/>',
  right: '<path d="M18 12l-7-6v12z"/>',
  home: '<path d="M12 4l8 7h-2.5v8h-4v-5h-3v5h-4v-8H4z"/>',
  power: '<path d="M11 3h2v9h-2zM6.3 6.3l1.4 1.4A6 6 0 1 0 16.3 7.7l1.4-1.4A8 8 0 1 1 6.3 6.3z"/>',
  edit: '<path d="M4 17.2V20h2.8l8.3-8.3-2.8-2.8zm14.7-7.6a.8.8 0 0 0 0-1.1l-1.2-1.2a.8.8 0 0 0-1.1 0l-1.4 1.4 2.3 2.3z"/>',
};
const ctlIcon = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${CTL_ICONS[k]}</svg>`;
const ctlDeg = (v) => (v == null ? "—" : `${fmtNum(Math.round(v))}°`);
const ctlBtn = (kind, n, label, extra = "") =>
  `<button class="btn small" data-act="${kind}"${n == null ? "" : ` data-n="${n}"`}${extra}>${esc(label)}</button>`;

/* Spool: its colour and name, the head it feeds; compact: with Load and
   Unload (the quick panel of a spool). */
function ctlSpoolHtml(n, { compact = false } = {}) {
  const chip = `<span class="ctl-spool" data-ctl="spool" data-n="${n}"><i class="ct-spool" aria-hidden="true"></i><span class="ct-mat" data-v="mat"></span></span>`;
  if (!compact) return chip;
  return `<div class="ctl-c ctl-c-spool" data-ctl="spool-c" data-n="${n}">
      <div class="ctl-c-row"><b>T${n}</b>${chip}</div>
      <div class="ctl-c-acts">${ctlBtn("load", n, tr("ctl.load"))}${ctlBtn("unload", n, tr("ctl.unload"))}</div>
      <button class="btn small ctl-c-fil" data-act="filament" data-n="${n}" data-tip="${esc(tr("ctl.filament_sub"))}">${ctlIcon("edit")}<span>${esc(tr("ctl.filament"))}</span></button>
    </div>`;
}
function ctlSpoolPaint(el, pid, n) {
  const s = ctlSpool(pid, n);
  // The chip carries the colour (alone, or inside a compact spool panel).
  const chip = el.matches(".ctl-spool") ? el : el.querySelector(".ctl-spool");
  for (const x of new Set([el, chip])) x?.style.setProperty("--spool", s.color || "var(--separator)");
  el.classList.toggle("no-spool", !s.present);
  el.querySelector('[data-v="mat"]').textContent = s.present ? s.name || tr("ctl.loaded") : tr("ctl.no_spool");
}

/* Head (nozzle): full — the tab's card (spool, gauge, target, activate,
   load, unload, extrude, retract); compact — temperature and its target. */
function ctlHeadHtml(h, { compact = false } = {}) {
  const n = h.index;
  const slider = `<label class="ct-slider"><span>${esc(tr("ctl.nozzle"))}</span>
      <input type="range" min="0" max="${Math.round(h.max_temp)}" step="5" data-temp="${n}" aria-label="${esc(tr("ctl.nozzle_n", { n }))}" />
      <b data-v="set">0°</b></label>`;
  if (compact) {
    return `<div class="ctl-c ctl-c-head" data-ctl="head" data-n="${n}">
        <div class="ctl-c-row"><b>T${n}</b>${ctlSpoolHtml(n)}<span class="ctl-c-temp"><b data-v="temp">—</b><small data-v="target"></small></span></div>
        ${slider}
      </div>`;
  }
  return `<div class="ct-head" data-ctl="head" data-n="${n}" data-head="${n}">
      <div class="ct-head-top"><b>T${n}</b>${ctlSpoolHtml(n)}<button class="ct-edit" data-act="filament" data-n="${n}" title="${esc(tr("ctl.filament"))}" aria-label="${esc(tr("ctl.filament"))}" data-tip="${esc(tr("ctl.filament"))}">${ctlIcon("edit")}</button><span class="ct-badge" data-v="badge"></span></div>
      <div class="ct-head-mid">
        <div class="ct-gauge" data-v="gauge"><span><b data-v="temp">—</b><small data-v="target"></small></span></div>
        <div class="ct-head-set">${slider}<button class="btn small ct-activate" data-act="tool" data-n="${n}">${esc(tr("ctl.activate"))}</button></div>
      </div>
      <div class="ct-head-acts">
        ${ctlBtn("load", n, tr("ctl.load"))}${ctlBtn("unload", n, tr("ctl.unload"))}
        ${ctlBtn("extrude", n, `↓ ${tr("ctl.extrude")}`, ` title="${esc(tr("ctl.extrude_sub"))}" data-tip="${esc(tr("ctl.extrude_sub"))}"`)}${ctlBtn("retract", n, `↑ ${tr("ctl.retract")}`)}
      </div>
    </div>`;
}
function ctlHeadPaint(el, pid, h) {
  const st = ctlState(pid);
  const hs = st?.heads.find((x) => x.index === h.index);
  const active = st?.active === h.index;
  const s = ctlSpool(pid, h.index);
  el.style.setProperty("--spool", s.color || "var(--separator)");
  el.classList.toggle("no-spool", !s.present);
  el.classList.toggle("active", active);
  const spool = el.querySelector('[data-ctl="spool"]');
  if (spool) ctlSpoolPaint(spool, pid, h.index);
  const badge = el.querySelector('[data-v="badge"]');
  if (badge) badge.textContent = active ? tr("ctl.is_active") : "";
  el.querySelector('[data-v="temp"]').textContent = ctlDeg(hs?.temp);
  el.querySelector('[data-v="target"]').textContent = hs?.target > 0 ? `→ ${ctlDeg(hs.target)}` : tr("ctl.off");
  const g = el.querySelector('[data-v="gauge"]');
  if (g) ctlGauge(g, hs?.temp, hs?.target, h.max_temp);
  ctlSyncRange(el.querySelector(`[data-temp="${h.index}"]`), Math.round(hs?.target || 0), el.querySelector('[data-v="set"]'), ctlDeg);
}

/* Bed: full — gauge, target and maximum; compact — temperature and target. */
function ctlBedHtml(cfg, { compact = false } = {}) {
  const max = Math.round(cfg?.bed_max || 100);
  const slider = `<label class="ct-slider"><span>${esc(tr("ctl.target"))}</span><input type="range" min="0" max="${max}" step="5" data-bed aria-label="${esc(tr("ctl.bed"))}" /><b data-v="set">0°</b></label>`;
  if (compact) {
    return `<div class="ctl-c ctl-c-bed" data-ctl="bed">
        <div class="ctl-c-row"><b>${esc(tr("ctl.bed"))}</b><span class="ctl-c-temp"><b data-v="temp">—</b><small data-v="target"></small></span></div>
        ${slider}
      </div>`;
  }
  return `<div class="ct-head-mid" data-ctl="bed">
      <div class="ct-gauge" data-v="gauge"><span><b data-v="temp">—</b><small data-v="target"></small></span></div>
      <div class="ct-head-set">${slider}<small class="ct-note">${esc(tr("ctl.max", { t: fmtNum(max) }))}</small></div>
    </div>`;
}
function ctlBedPaint(el, pid) {
  const bed = ctlState(pid)?.bed;
  el.querySelector('[data-v="temp"]').textContent = ctlDeg(bed?.temp);
  el.querySelector('[data-v="target"]').textContent = bed?.target > 0 ? `→ ${ctlDeg(bed.target)}` : tr("ctl.off");
  const g = el.querySelector('[data-v="gauge"]');
  if (g) ctlGauge(g, bed?.temp, bed?.target, ctlData(pid).cfg?.bed_max || 100);
  ctlSyncRange(el.querySelector("[data-bed]"), Math.round(bed?.target || 0), el.querySelector('[data-v="set"]'), ctlDeg);
}

/* Chamber light: a switch, in a row (full) or a compact row. */
function ctlLightHtml({ compact = false } = {}) {
  return `<label class="ct-switch${compact ? " ctl-c ctl-c-light" : ""}" data-ctl="light"><span>${esc(tr("ctl.light"))}</span><input type="checkbox" class="sw${compact ? " small" : ""}" role="switch" data-light /></label>`;
}
function ctlLightPaint(el, pid) {
  const sw = el.querySelector("[data-light]");
  const cfg = ctlData(pid).cfg;
  el.classList.toggle("hidden", !!cfg && !cfg.light);
  if (document.activeElement !== sw) sw.checked = !!ctlState(pid)?.light;
  sw.disabled = !!ctlWhy("light", ctlState(pid), cfg);
}

/* Emergency stop: always in reach; compact for a quick panel's corner. */
function ctlEstopHtml({ compact = false } = {}) {
  return `<button class="ct-estop${compact ? " compact" : ""}" data-act="emergency_stop" title="${esc(tr("ctl.estop"))}" aria-label="${esc(tr("ctl.estop"))}">${ctlIcon("power")}${compact ? "" : `<span>${esc(tr("ctl.estop"))}</span>`}</button>`;
}

/* A round gauge: the temperature's share of the heater's maximum, the
   target as a tick, its colour from heating to ready. */
function ctlGauge(el, temp, target, max) {
  el.style.setProperty("--p", String(ctlPct(temp, max)));
  el.style.setProperty("--t", String(ctlPct(target, max)));
  el.dataset.heat = ctlHeat(temp || 0, target || 0);
}
/* A slider follows the printer, unless it is being moved. */
function ctlSyncRange(r, v, label, fmt) {
  if (!r || document.activeElement === r || r.dataset.drag) return;
  r.value = String(v);
  if (label) label.textContent = fmt(v);
}

/* Paints every component under `root` for printer `pid`, and what can run
   now: its actions, sliders and switches (the same rules as control.rs). */
function ctlPaint(root, pid) {
  const d = ctlData(pid), st = ctlState(pid), cfg = d.cfg, busy = ctlBusy(pid);
  root.querySelectorAll('[data-ctl="head"]').forEach((el) => {
    const h = cfg?.heads.find((x) => x.index === +el.dataset.n);
    if (h) ctlHeadPaint(el, pid, h);
  });
  root.querySelectorAll('[data-ctl="spool-c"]').forEach((el) => ctlSpoolPaint(el, pid, +el.dataset.n));
  root.querySelectorAll('[data-ctl="bed"]').forEach((el) => ctlBedPaint(el, pid));
  root.querySelectorAll('[data-ctl="light"]').forEach((el) => ctlLightPaint(el, pid));
  const step = +root.dataset.step || 0;
  root.querySelectorAll("[data-act]").forEach((b) => {
    const kind = b.dataset.act;
    const opts = { n: b.dataset.n == null ? null : +b.dataset.n, axis: b.dataset.axis, dist: b.dataset.sign ? +b.dataset.sign * step : 0, axes: b.dataset.axes || "" };
    const why = kind === "emergency_stop" ? (st || cfg ? "" : "ctl.why.offline") : busy ? "ctl.why.busy" : ctlWhy(kind, st, cfg, opts);
    b.disabled = !!why;
    if (why) b.title = tr(why, { t: fmtNum(Math.round(cfg?.heads.find((h) => h.index === opts.n)?.min_extrude_temp || 170)) });
    else if (b.dataset.tip) b.title = b.dataset.tip;
    else if (!b.classList.contains("ct-jog") && kind !== "emergency_stop") b.removeAttribute("title");
  });
  root.querySelectorAll("[data-temp]").forEach((r) => (r.disabled = !!busy || !!ctlWhy("nozzle_temp", st, cfg, { n: +r.dataset.temp })));
  root.querySelectorAll("[data-bed]").forEach((r) => (r.disabled = !!busy || !!ctlWhy("bed_temp", st, cfg)));
}

const CTL_DOING = { home: "ctl.doing.home", jog: "ctl.doing.jog", tool: "ctl.doing.tool", load: "ctl.doing.load", unload: "ctl.doing.unload", extrude: "ctl.doing.extrude", retract: "ctl.doing.retract", clean: "ctl.doing.clean", purge_position: "ctl.doing.purge", heaters_off: "ctl.doing.off", motors_off: "ctl.doing.motors", firmware_restart: "ctl.doing.restart" };

/* The components' events, delegated on `root` (the tab, a quick panel):
   the printer is the closest data-ctl-pid. Actions, sliders (sent on
   release), switches. */
function ctlBind(root) {
  const pidOf = (el) => el.closest("[data-ctl-pid]")?.dataset.ctlPid;
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || b.disabled || !root.contains(b)) return;
    const pid = pidOf(b), kind = b.dataset.act;
    const n = b.dataset.n == null ? undefined : +b.dataset.n;
    if (kind === "jog") {
      const step = +b.closest("[data-step]")?.dataset.step || 1;
      const dist = +b.dataset.sign * step;
      return ctlRun(pid, { kind, axis: b.dataset.axis, dist }, tr(CTL_DOING.jog, { axis: b.dataset.axis.toUpperCase(), d: fmtDec(dist, step < 1 ? 1 : 0) }));
    }
    if (kind === "home") return ctlRun(pid, { kind, axes: b.dataset.axes }, tr(CTL_DOING.home, { axes: b.dataset.axes.toUpperCase() }));
    // A head's material and colour; loading a spool without an RFID tag
    // asks them first (as the printer's screen).
    if (kind === "filament") return ctlFilament(pid, n);
    if (kind === "load" && ctlLoadAsks(ctlState(pid)?.heads.find((h) => h.index === n), ctlData(pid).cfg)) return ctlFilament(pid, n, { load: true });
    const action = { kind };
    if (n !== undefined) action.n = n;
    ctlRun(pid, action, CTL_DOING[kind] ? tr(CTL_DOING[kind], { n }) : tr("ctl.doing.any"));
  });
  root.addEventListener("input", (e) => {
    const r = e.target;
    if (r.type !== "range" || !(r.dataset.temp != null || r.dataset.bed != null)) return;
    r.dataset.drag = "1";
    const label = r.parentElement.querySelector('[data-v="set"]');
    if (label) label.textContent = ctlDeg(+r.value);
  });
  root.addEventListener("change", (e) => {
    const r = e.target, pid = pidOf(r);
    if (r.dataset.temp != null) {
      delete r.dataset.drag;
      return ctlRun(pid, { kind: "nozzle_temp", n: +r.dataset.temp, temp: +r.value }, tr("ctl.doing.temp", { n: r.dataset.temp, t: fmtNum(+r.value) }));
    }
    if (r.dataset.bed != null) {
      delete r.dataset.drag;
      return ctlRun(pid, { kind: "bed_temp", temp: +r.value }, tr("ctl.doing.bed", { t: fmtNum(+r.value) }));
    }
    if (r.dataset.light != null) return ctlRun(pid, { kind: "light", on: r.checked }, tr("ctl.doing.light"));
  });
}

/* =================================================================== tab */

const CT = {
  pid: null,
  head: null, // the head the opening asked for (ctlOpen)
  homedSeen: false, // homed earlier in this visit: a loss is Klipper's standby
  step: +localStorage.getItem("snapstudio.ctl.step") || 10,
  timer: 0,
  built: null, // the pid and head count the skeleton was built for
};

const ctOn = () => window.currentView === "maint" && MT.tab === "control";
const ctMm = (v) => fmtDec(v, 1);

/* Opens the tab on a printer; `ctx.head` brings that head into view. */
async function ctShow(pid, ctx = {}) {
  if (CT.pid !== pid) Object.assign(CT, { pid, built: null, homedSeen: false });
  CT.head = ctx.head ?? null;
  ctBuild();
  ctUpdate();
  ctlSpools(pid);
  await ctlRead(pid, true);
  ctFocusHead();
  ctPoll();
}

function ctLeave() {
  clearTimeout(CT.timer);
  CT.timer = 0;
  camLeave();
}

/* Every 1.5 s while shown; the spools every 30 s. */
function ctPoll() {
  clearTimeout(CT.timer);
  if (!ctOn()) return;
  CT.timer = setTimeout(async () => {
    const pid = CT.pid;
    await ctlRead(pid);
    if (Date.now() - ctlData(pid).slotsAt > 30000) ctlSpools(pid);
    ctPoll();
  }, 1500);
}

/* The head the opening asked for: scrolled into view, briefly marked. */
function ctFocusHead() {
  if (CT.head == null) return;
  const card = $("ct-body").querySelector(`.ct-head[data-n="${CT.head}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.add("focus");
  setTimeout(() => card.classList.remove("focus"), 1800);
  CT.head = null;
}

ctlSubscribe((pid) => {
  if (pid !== CT.pid || !ctOn()) return;
  const cfg = ctlData(pid).cfg;
  if (CT.built !== `${pid}:${cfg ? cfg.heads.length : 0}`) ctBuild();
  ctUpdate();
});

function ctBuild() {
  const pid = CT.pid, cfg = ctlData(pid).cfg;
  CT.built = `${pid}:${cfg ? cfg.heads.length : 0}`;
  const heads = cfg ? cfg.heads : [];
  const jog = (axis, dist, icon, label) =>
    `<button class="ct-jog" data-act="jog" data-axis="${axis}" data-sign="${dist}" aria-label="${esc(label)}" title="${esc(label)}">${ctlIcon(icon)}<small>${esc(label)}</small></button>`;
  $("ct-body").innerHTML = `<div class="ct" data-ctl-pid="${esc(pid)}" data-step="${CT.step}">
    <div class="ct-status">
      <span class="ct-state" id="ct-state"><i></i><b id="ct-state-t"></b></span>
      <span class="ct-chip" id="ct-homed"></span>
      <span class="ct-chip" id="ct-active"></span>
      <span class="ct-busy hidden" id="ct-busy" role="status"><span class="spinner small"></span><span id="ct-busy-t"></span></span>
      ${ctlEstopHtml()}
    </div>
    <div class="mt-stale hidden" id="ct-conn" role="status"></div>
    <div class="ct-lock hidden" id="ct-lock" role="status"></div>
    <div class="ct-top">
      <section class="ct-card ct-move">
        <div class="ct-card-head">${esc(tr("ctl.move"))}<span class="ct-pos" id="ct-pos"></span></div>
        <div class="ct-move-body">
          <div class="ct-padwrap">
            <div class="ct-pad" role="group" aria-label="${esc(tr("ctl.move_xy"))}">
              <span></span>${jog("y", 1, "up", "Y+")}<span></span>
              ${jog("x", -1, "left", "X−")}<button class="ct-jog ct-home" data-act="home" data-axes="xy" title="${esc(tr("ctl.home_xy"))}" aria-label="${esc(tr("ctl.home_xy"))}">${ctlIcon("home")}<small>XY</small></button>${jog("x", 1, "right", "X+")}
              <span></span>${jog("y", -1, "down", "Y−")}<span></span>
            </div>
            <span class="ct-padcap">X · Y</span>
          </div>
          <div class="ct-padwrap">
            <div class="ct-zpad" role="group" aria-label="${esc(tr("ctl.move_z"))}">
              ${jog("z", 1, "up", "Z+")}
              <button class="ct-jog ct-home" data-act="home" data-axes="z" title="${esc(tr("ctl.home_z"))}" aria-label="${esc(tr("ctl.home_z"))}">${ctlIcon("home")}<small>Z</small></button>
              ${jog("z", -1, "down", "Z−")}
            </div>
            <span class="ct-padcap">Z</span>
          </div>
        </div>
        <div class="ct-settings">
          <div class="ct-row"><span class="ct-k">${esc(tr("ctl.step"))}</span>
            <div class="seg ct-steps" id="ct-steps" role="radiogroup" aria-label="${esc(tr("ctl.step"))}">${CTL_STEPS.map((s) => `<button class="seg-btn" role="radio" data-step-pick="${s}">${esc(fmtDec(s, s < 1 ? 1 : 0))} <small>mm</small></button>`).join("")}</div>
          </div>
          <div class="ct-row ct-homes"><span class="ct-k">${esc(tr("ctl.home"))}</span>
            <div class="ct-homegrp">
              <button class="btn small primary" data-act="home" data-axes="xyz">${ctlIcon("home")} XYZ</button>
              ${cfg?.u1
                // A U1 homes X and Y together (its G28 override).
                ? `<button class="btn small" data-act="home" data-axes="xy">XY</button><button class="btn small" data-act="home" data-axes="z">Z</button>`
                : `<button class="btn small" data-act="home" data-axes="x">X</button><button class="btn small" data-act="home" data-axes="y">Y</button><button class="btn small" data-act="home" data-axes="z">Z</button>`}
            </div>
          </div>
        </div>
        <div class="ct-warn hidden" id="ct-nohome"><span></span><button class="btn small primary" data-act="home" data-axes="xyz">${esc(tr("ctl.home_now"))}</button></div>
        <div class="ct-row ct-tools">${ctlBtn("clean", null, tr("ctl.clean"))}${ctlBtn("purge_position", null, tr("ctl.purge"))}</div>
      </section>
      <section class="ct-card ct-heads">
        <div class="ct-card-head"><button class="ct-help" data-ct-help title="${esc(tr("ctl.help.title"))}" aria-label="${esc(tr("ctl.help.title"))}">?</button>${esc(tr("ctl.heads"))}</div>
        <div class="ct-head-grid">${heads.length ? heads.map((h) => ctlHeadHtml(h)).join("") : `<p class="ct-empty"></p>`}</div>
      </section>
    </div>
    <div class="ct-bottom">
      <section class="ct-card ct-bed">
        <div class="ct-card-head">${esc(tr("ctl.bed"))}</div>
        ${ctlBedHtml(cfg)}
      </section>
      <section class="ct-card ct-air">
        <div class="ct-card-head">${esc(tr("ctl.air"))}</div>
        <label class="ct-slider wide"><span>${esc(tr("ctl.part_fan"))}</span><input type="range" min="0" max="100" step="5" id="ct-fan" aria-label="${esc(tr("ctl.part_fan"))}" /><b id="ct-fan-v">0 %</b></label>
        <label class="ct-slider wide${cfg?.chamber_fan ? "" : " hidden"}"><span>${esc(tr("ctl.chamber_fan"))}</span><input type="range" min="0" max="100" step="5" id="ct-cfan" aria-label="${esc(tr("ctl.chamber_fan"))}" /><b id="ct-cfan-v">0 %</b></label>
        <label class="ct-switch${cfg?.purifier ? "" : " hidden"}"><span>${esc(tr("ctl.purifier"))}</span><input type="checkbox" class="sw" role="switch" id="ct-purifier" /></label>
        ${ctlLightHtml()}
      </section>
      <section class="ct-card ct-cam">
        <div class="ct-card-head">${esc(tr("printers.camera"))}<input type="checkbox" class="sw small" role="switch" id="ct-cam-sw" aria-label="${esc(tr("printers.camera"))}" /></div>
        <div class="ct-cam-box" id="ct-cam-box"><span class="ct-cam-note">${esc(tr("ctl.cam_off"))}</span></div>
      </section>
    </div>
    <div class="ct-foot">
      ${ctlBtn("heaters_off", null, tr("ctl.heaters_off")).replace('btn small', 'btn')}
      <span class="ct-note" id="ct-idle-note">${esc(tr("ctl.idle_note"))}</span>
      <details class="ct-adv"><summary>${esc(tr("ctl.advanced"))}</summary>
        <div class="ct-adv-body">${ctlBtn("motors_off", null, tr("ctl.motors_off"))}${ctlBtn("firmware_restart", null, tr("ctl.restart"))}</div>
      </details>
    </div>
  </div>`;
  // The card is new: the camera's box goes back into it.
  ctCamHome();
}

/* The tab's own parts (status, movement, fans, notices), then the shared
   components (ctlPaint). */
function ctUpdate() {
  const root = $("ct-body").firstElementChild;
  if (!root) return;
  const pid = CT.pid, d = ctlData(pid), cfg = d.cfg, st = ctlState(pid), busy = ctlBusy(pid);
  const state = d.err ? "offline" : !st ? "reading" : ctlStateOf(st);
  const stateText = state === "printing" ? tr("ctl.st.printing", { p: fmtNum(Math.round((st.progress || 0) * 100)) })
    : state === "busy" ? tr("ctl.st.busy", { state: st.main_state }) : tr(`ctl.st.${state}`);
  $("ct-state").className = `ct-state ${state}`;
  $("ct-state-t").textContent = stateText;
  const homed = ctlHomed(st), xy = ctlHomed(st, "xy");
  // X and Y only (a U1's "G28 X Y", its feeder or a head change): said.
  $("ct-homed").textContent = st ? tr(homed ? "ctl.homed" : xy ? "ctl.homed_xy" : "ctl.not_homed_short") : "";
  $("ct-homed").className = `ct-chip${st && !homed ? " warn" : ""}`;
  $("ct-active").textContent = st?.active != null ? tr("ctl.active_head", { n: st.active }) : "";
  $("ct-busy").classList.toggle("hidden", !busy);
  $("ct-busy-t").textContent = busy || "";
  // Reading the printer, or it does not answer: said in a line, with a
  // retry, as Maintenance says it (the raw error, with the address it
  // tried, stays in the console).
  const conn = $("ct-conn");
  conn.classList.toggle("hidden", state !== "reading" && state !== "offline");
  if (state === "reading") conn.innerHTML = `<span class="spinner"></span><span>${esc(tr("ctl.reading"))}</span>`;
  else if (state === "offline") {
    // No answer, or an answer that is an error (Klipper shut down, HTTP
    // 503): the error is said then, without its address, as it calls for
    // something else than checking the network.
    const name = printerName(pid);
    const said = d.err && !errUnreachable(d.err) ? tr("ctl.read_err", { err: errNoUrl(d.err) }) : name ? tr("printers.no_answer", { name }) : tr("ctl.offline");
    conn.innerHTML = offlineLine(said, "data-ct-retry", true);
  }
  root.querySelector(".ct-empty")?.replaceChildren(tr(state === "offline" ? "ctl.offline" : "ctl.reading"));
  // Printing or a U1 procedure: what stays possible is said.
  const lock = state === "printing" || state === "paused" ? "ctl.lock.printing" : state === "busy" ? "ctl.lock.busy" : "";
  $("ct-lock").classList.toggle("hidden", !lock);
  if (lock) $("ct-lock").textContent = tr(lock);
  // Homed a moment ago, not any more, nothing moved: Klipper's standby
  // (5 min without a command) turned the motors off. Said as such.
  if (homed) CT.homedSeen = true;
  $("ct-nohome").classList.toggle("hidden", !st || homed || xy || !!lock);
  $("ct-nohome").querySelector("span").textContent = tr(CT.homedSeen && !homed && st?.idle === "Idle" ? "ctl.not_homed_idle" : "ctl.not_homed");
  $("ct-pos").textContent = st && xy ? `X ${ctMm(st.position[0])}  Y ${ctMm(st.position[1])}${homed ? `  Z ${ctMm(st.position[2])}` : ""}` : "";
  root.dataset.step = String(CT.step);
  document.querySelectorAll("#ct-steps [data-step-pick]").forEach((b) => {
    const on = +b.dataset.stepPick === CT.step;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  });
  // Fans and purifier: the tab's own.
  ctlSyncRange($("ct-fan"), Math.round((st?.part_fan || 0) * 100), $("ct-fan-v"), (v) => `${fmtNum(v)} %`);
  ctlSyncRange($("ct-cfan"), Math.round((st?.chamber_fan || 0) * 100), $("ct-cfan-v"), (v) => `${fmtNum(v)} %`);
  if (document.activeElement !== $("ct-purifier")) $("ct-purifier").checked = !!st?.purifier;
  $("ct-fan").disabled = !!busy || !!ctlWhy("part_fan", st, cfg);
  $("ct-cfan").disabled = !!busy || !!ctlWhy("chamber_fan", st, cfg);
  $("ct-purifier").disabled = !!busy || !!ctlWhy("purifier", st, cfg);
  // The shared components and every action's state.
  ctlPaint(root, pid);
}

ctlBind($("ct-body"));
$("ct-body").addEventListener("click", (e) => {
  if (e.target.closest("[data-ct-help]")) return ctHelp();
  if (e.target.closest("[data-ct-retry]")) {
    ctlData(CT.pid).err = null;
    ctUpdate();
    return ctlRead(CT.pid, true);
  }
  const step = e.target.closest("[data-step-pick]");
  if (step) {
    CT.step = +step.dataset.stepPick;
    localStorage.setItem("snapstudio.ctl.step", String(CT.step));
    ctUpdate();
  }
});
/* The tab's own sliders and switches (fans, purifier, camera). */
$("ct-body").addEventListener("input", (e) => {
  const r = e.target;
  if (r.id === "ct-fan" || r.id === "ct-cfan") {
    r.dataset.drag = "1";
    $(`${r.id}-v`).textContent = `${fmtNum(+r.value)} %`;
  }
});
$("ct-body").addEventListener("change", (e) => {
  const r = e.target;
  if (r.id === "ct-fan" || r.id === "ct-cfan") {
    delete r.dataset.drag;
    return ctlRun(CT.pid, { kind: r.id === "ct-fan" ? "part_fan" : "chamber_fan", pct: +r.value }, tr("ctl.doing.fan"));
  }
  if (r.id === "ct-purifier") return ctlRun(CT.pid, { kind: "purifier", on: r.checked }, tr("ctl.doing.purifier"));
  if (r.id === "ct-cam-sw") return r.checked ? camStart(CT.pid) : camStop();
});

/* ------------------------------------------------- material and colour */

/* The colours offered at once (any other through the colour field). */
const CTL_COLORS = ["#ffffff", "#000000", "#8e9089", "#c9cbcd", "#c12e1f", "#ff6a13", "#f4d10b", "#00ae42", "#164b35", "#0086d6", "#0a2989", "#5e43b7", "#f55a74", "#9d432c", "#e8dbb7", "#b8cde9"];

const CF = { pid: null, n: null, load: false, pick: null };

/* Declares head `n`'s material and colour, from the printer's own list
   (Material › Brand › Type, as on its screen); `load`: then loads it. */
function ctlFilament(pid, n, { load = false } = {}) {
  const cfg = ctlData(pid).cfg;
  if (!pid || !cfg?.materials?.length) return;
  const slot = (typeof headsSlots === "function" ? headsSlots(pid) : []).find((s) => s.index === n);
  Object.assign(CF, { pid, n, load, pick: ctlFilamentPick(cfg.materials, slot) });
  $("ctlfil-title").textContent = tr(load ? "ctl.fil.title_load" : "ctl.fil.title", { n });
  $("ctlfil-ok").textContent = tr(load ? "ctl.fil.ok_load" : "common.save");
  ctlFilFill();
  openSheet($("ctlfil"));
}

function ctlFilFill() {
  const mats = ctlData(CF.pid).cfg?.materials || [], p = CF.pick;
  const m = mats.find((x) => x.kind === p.material) || mats[0];
  const v = m.vendors.find((x) => x.name === p.vendor) || m.vendors[0];
  const opt = (val, label, on) => `<option value="${esc(val)}"${on ? " selected" : ""}>${esc(label)}</option>`;
  $("ctlfil-material").innerHTML = mats.map((x) => opt(x.kind, x.kind, x === m)).join("");
  // A few materials: pills over the select, which stays the source of truth.
  const pills = mats.length <= CTL_MAT_PILLS;
  $("ctlfil-mats").classList.toggle("hidden", !pills);
  $("ctlfil-material-l").classList.toggle("hidden", pills);
  $("ctlfil-mats-seg").innerHTML = pills
    ? mats.map((x) => `<button type="button" class="seg-btn${x === m ? " on" : ""}" role="radio" aria-checked="${x === m}" data-mat="${esc(x.kind)}" tabindex="${x === m ? 0 : -1}">${esc(x.kind)}</button>`).join("")
    : "";
  $("ctlfil-vendor").innerHTML = m.vendors.map((x) => opt(x.name, x.name, x === v)).join("");
  $("ctlfil-sub").innerHTML = v.subs.map((s) => opt(s, s || tr("ctl.fil.generic"), s === p.sub_type)).join("");
  $("ctlfil-vendor").disabled = m.vendors.length < 2;
  $("ctlfil-sub").disabled = v.subs.length < 2;
  const name = typeof colorName === "function" ? colorName : () => "";
  $("ctlfil-colors").innerHTML = CTL_COLORS.map((c) => `<button class="ctl-fil-sw${c === p.color ? " on" : ""}" data-color="${c}" style="--c:${c}" title="${esc(name(c))}" aria-label="${esc(name(c) || c)}" role="radio" aria-checked="${c === p.color}"></button>`).join("");
  $("ctlfil-color").value = p.color;
  $("ctlfil-color-t").textContent = `${name(p.color)} ${p.color.toUpperCase()}`.trim();
  $("ctlfil-preview").style.setProperty("--c", p.color);
  $("ctlfil-preview-t").textContent = [p.vendor, p.material, p.sub_type].filter(Boolean).join(" ");
}

/* Up to this many materials show as pills. */
const CTL_MAT_PILLS = 8;
$("ctlfil-mats-seg").addEventListener("click", (e) => {
  const b = e.target.closest("[data-mat]");
  if (!b) return;
  setSelect($("ctlfil-material"), b.dataset.mat);
  $("ctlfil-mats-seg").querySelector(`[data-mat="${CSS.escape(b.dataset.mat)}"]`)?.focus();
});
// Arrows move and choose, as in a native radio group.
$("ctlfil-mats-seg").addEventListener("keydown", (e) => {
  const row = [...$("ctlfil-mats-seg").querySelectorAll("[data-mat]")];
  const j = swMove(row, row.indexOf(document.activeElement), e.key);
  if (j < 0) return;
  e.preventDefault();
  row[j].click();
});
$("ctlfil-material").addEventListener("change", (e) => {
  const m = ctlData(CF.pid).cfg.materials.find((x) => x.kind === e.target.value);
  Object.assign(CF.pick, { material: m.kind, vendor: m.vendors[0].name, sub_type: m.vendors[0].subs[0] });
  ctlFilFill();
});
$("ctlfil-vendor").addEventListener("change", (e) => {
  const v = ctlData(CF.pid).cfg.materials.find((x) => x.kind === CF.pick.material).vendors.find((x) => x.name === e.target.value);
  Object.assign(CF.pick, { vendor: v.name, sub_type: v.subs[0] });
  ctlFilFill();
});
$("ctlfil-sub").addEventListener("change", (e) => {
  CF.pick.sub_type = e.target.value;
  ctlFilFill();
});
$("ctlfil-colors").addEventListener("click", (e) => {
  const b = e.target.closest("[data-color]");
  if (!b) return;
  CF.pick.color = b.dataset.color;
  ctlFilFill();
});
$("ctlfil-color").addEventListener("input", (e) => {
  CF.pick.color = e.target.value.toLowerCase();
  ctlFilFill();
});
$("ctlfil-cancel").addEventListener("click", () => closeSheet($("ctlfil")));
$("ctlfil-ok").addEventListener("click", async () => {
  const { pid, n, load, pick } = CF;
  closeSheet($("ctlfil"));
  const ok = await ctlRun(pid, { kind: "filament", n, vendor: pick.vendor, material: pick.material, sub_type: pick.sub_type, color: pick.color }, tr("ctl.doing.filament", { n }));
  if (ok && load) ctlRun(pid, { kind: "load", n }, tr("ctl.doing.load", { n }));
});

/* ------------------------------------------------------------ help */

/* The heads' buttons explained: what each does, when it is greyed out;
   then what holds for all of them. */
function ctHelp() {
  const rows = ["temp", "tool", "load", "unload", "filament", "extrude", "retract"].map((k) => `<div class="ct-help-row">
      <b>${esc(tr(`ctl.help.${k}_t`))}</b>
      <span>${esc(tr(`ctl.help.${k}`))}</span>
      <small>${esc(tr(`ctl.help.${k}_when`))}</small>
    </div>`).join("");
  const notes = ["greyed", "one", "idle", "commands"].map((k) => `<li>${esc(tr(`ctl.help.note_${k}`))}</li>`).join("");
  $("cthelp-body").innerHTML = `<div class="ct-help-list">${rows}</div><ul class="ct-help-notes">${notes}</ul>`;
  openSheet($("cthelp"));
}
$("cthelp-close").addEventListener("click", () => closeSheet($("cthelp")));

/* ------------------------------------------------------------ camera */

/* The printer's camera (camera.js), small, in its card: the same stream
   as the printer page, moved here. */
function ctCamHome() {
  const box = $("ct-cam-box");
  if (ctOn() && box && CT.pid) camHome(box, CT.pid);
}
document.addEventListener("cam-change", () => {
  const sw = $("ct-cam-sw");
  if (sw) sw.checked = CAM.on && CAM.id === CT.pid;
});

window.addEventListener("langchange", () => {
  if (!ctOn()) return;
  CT.built = null;
  ctBuild();
  ctUpdate();
});
