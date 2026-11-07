"use strict";
/* The printer page's 3D view (#34): the U1 seen from the front, its parts
   clickable (spools, heads, bed, light), filling the page. Over it, as
   Prepare's panels (.p-float): the print's status top centre, the heads
   card top left (one row per head, the bed), the quick panel of what is selected on the
   right, the printer's details bottom right, the sides and a quick bar
   (light, camera, help) along the bottom; the camera as a picture in the
   picture. The quick panels are made of Care & Tuning › Control's compact
   components (control.js) — one command service, one filament source, no
   copy; "All controls" opens that tab on the right head (ctlOpen). The
   emergency stop sits in the toolbar, beside Control. The scene
   (printer3d/view.js, three.js) loads on the first visit; without WebGL
   the page keeps its 2D picture and sections. The rules are in
   printer3d-logic.js. */

const P3 = {
  view: null,
  loading: null,
  failed: false,
  pid: null,
  zone: null, // the panel open: head:n, bed, light
  built: "", // what the panel was built for
  timer: 0,
  hint: localStorage.getItem("snapstudio.p3d.hint") !== "off",
};

const p3dOn = () => window.currentView === "printers" && !!P3.pid && !$("p3d").classList.contains("hidden");

/* The scene's code, fetched once (also ahead, when the app is idle: the
   first visit then shows the view at once). */
const p3dModule = () => (P3.module ||= import("./printer3d/view.js"));
setTimeout(() => (window.requestIdleCallback || setTimeout)(() => p3dModule().catch(() => {})), 2000);

/* WebGL here, as far as a test context tells: the page takes the view's
   layout before the scene is ready, without showing the old one first. */
function p3dWebGL() {
  if (P3.gl == null) {
    try {
      const c = document.createElement("canvas");
      P3.gl = !!(c.getContext("webgl2") || c.getContext("webgl"));
    } catch {
      P3.gl = false;
    }
  }
  return P3.gl;
}

/* Loads the scene once; null without WebGL. */
function p3dLoad() {
  if (P3.loading) return P3.loading;
  P3.loading = p3dModule()
    .then((m) => {
      const view = m.createView($("p3d-canvas"), { hover: p3dHover, pick: p3dPick, turn: p3dTurned });
      if (!view) throw new Error("WebGL");
      P3.view = view;
      p3dTheme();
      return view;
    })
    .catch((e) => {
      console.warn("3D view unavailable:", e);
      P3.failed = true;
      return null;
    });
  return P3.loading;
}
function p3dTheme() {
  P3.view?.setTheme(isDark(), getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
}

/* The printer page shows a printer (prnRenderDetail): the view follows it. */
function p3dShow(p) {
  const pid = p?.id || null;
  if (pid === P3.pid) return;
  P3.pid = pid;
  $("p3d").dataset.ctlPid = pid || "";
  $("prn-estop").dataset.ctlPid = pid || "";
  p3dClose();
  if (P3.view) {
    P3.view.turn("front", 0);
    p3dSegment("front");
  }
}

/* The page's status (renderStatus): the view takes the page while the
   printer answers; offline, the "not connected" card is alone. */
function p3dStatus(st) {
  const online = !!st?.online;
  // Control's state (temperatures, light, emergency stop) while it answers.
  if (online) p3dPoll();
  else p3dStop();
  p3dEstopPaint();
  if (!online || P3.failed || !p3dWebGL()) return p3dLayout(false);
  p3dLayout(true);
  p3dLoad().then((view) => {
    p3dLayout(!!view && !!P.status.get(P3.pid)?.online);
    if (!view) return;
    view.setShown(p3dOn());
    p3dPaint();
    // The loader goes once the scene is on screen.
    // (1.5 s at most, whatever happens).
    if ($("p3d").classList.contains("loading")) {
      const done = () => $("p3d").classList.remove("loading");
      view.ready().then(done);
      setTimeout(done, 1500);
    }
  });
  p3dCard(st);
  p3dInfo(st);
}

/* The page with the view (the sections it replaces hidden, the camera in
   its corner) or without. */
function p3dLayout(on) {
  $("p3d").classList.toggle("hidden", !on);
  $("prn-detail").classList.toggle("p3d-on", on);
  // The camera follows, into the corner or the Camera section.
  prnCamHome();
  if (!on) p3dTip(null);
}

/* Control's state every 3 s while the printer page shows a printer that
   answers (with or without the view: the emergency stop needs it). */
function p3dPoll() {
  if (P3.timer || window.currentView !== "printers" || !P3.pid) return;
  const pid = P3.pid;
  ctlRead(pid, !ctlData(pid).cfg);
  P3.timer = setTimeout(function next() {
    if (window.currentView !== "printers" || P3.pid !== pid || !P.status.get(pid)?.online) return p3dStop();
    ctlRead(pid);
    P3.timer = setTimeout(next, 3000);
  }, 3000);
}
function p3dStop() {
  clearTimeout(P3.timer);
  P3.timer = 0;
  P3.view?.setShown(false);
}
/* The printers view shown or left (switchView). */
function p3dVisible(on) {
  if (!on) {
    p3dStop();
    p3dTip(null);
    return;
  }
  // Back on the page: a loader over the view until the scene is drawn
  // again, rather than its panels and model popping in.
  $("p3d").classList.add("loading");
  if (P3.pid) p3dStatus(P.status.get(P3.pid));
}

ctlSubscribe((pid) => {
  if (pid !== P3.pid) return;
  p3dEstopPaint();
  if (P3.view) p3dPaint();
});
window.addEventListener("themechange", p3dTheme);

/* ------------------------------------------------------------ painting */

/* The model and the overlays from what is known: the page's status, and
   Control's state when read. */
function p3dPaint() {
  const pid = P3.pid, st = P.status.get(pid), cs = ctlState(pid);
  if (!pid || !P3.view) return;
  const spool = (n) => ctlSpool(pid, n);
  const active = cs ? cs.active ?? null : (st?.nozzles || []).find((n) => n.active)?.index ?? null;
  const noz = cs ? cs.heads.find((h) => h.index === active) : (st?.nozzles || []).find((n) => n.index === active);
  const sum = p3dSummary(st);
  P3.view.setState({
    spools: [0, 1, 2, 3].map((n) => (spool(n).present ? spool(n).color || "#9a9ca2" : null)),
    active,
    heat: noz ? p3dHeat(noz.temp ?? noz.current, noz.target) : 0,
    light: !!cs?.light,
    carriage: cs ? p3dCarriage(cs.position) : null,
    printing: sum.state === "printing",
    progress: sum.progress,
    partColor: active != null ? spool(active).color : null,
  });
  p3dCard(st);
  p3dPanelPaint();
  p3dQuick();
}

// Control's icon (the toolbar's Control button).
const P3D_CONTROL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l3 3.5h-2V9h-2V5.5H9zM12 22l-3-3.5h2V15h2v3.5h2zM2 12l3.5-3v2H9v2H5.5v2zM22 12l-3.5 3v-2H15v-2h3.5V9zM12 10.2a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6"/></svg>';
/* A text written only when it changes: a text replaced under a pressed
   mouse makes WebKit drop the click (the live status rewrites the rows
   several times a second). */
function p3dText(el, v) {
  if (el.textContent !== v) el.textContent = v;
}

const p3dTemp = (t, target) => (t == null ? "—" : `${ctlDeg(t)}${target > 0 ? ` → ${ctlDeg(target)}` : ""}`);

/* The print's status (top centre: state, job, chamber, progress) and the
   heads card (one row per head, the bed). */
function p3dCard(st) {
  const pid = P3.pid, sum = p3dSummary(st), cs = ctlState(pid);
  if (!pid) return;
  const s = STATES[sum.state] ? sum.state : "standby";
  // An action under way (an unload takes minutes) says so instead.
  const busy = ctlBusy(pid);
  $("p3d-state").className = "p3d-state " + (busy ? "busy" : STATES[s]?.[1] || "");
  p3dText($("p3d-state-t"), busy || stateLabel(sum.state));
  p3dText($("p3d-chamber"), st?.chamber ? tr("p3d.chamber", { t: fmtNum(Math.round(st.chamber.current)) }) : "");
  p3dText($("p3d-job"), sum.job || tr("p3d.no_job"));
  const printing = sum.progress != null;
  $("p3d-prog").classList.toggle("hidden", !printing);
  if (printing) {
    $("p3d-bar").style.width = `${Math.round(sum.progress * 100)}%`;
    const bits = [`${Math.round(sum.progress * 100)} %`];
    if (sum.layer) bits.push(tr("p3d.layer", { a: sum.layer[0], b: sum.layer[1] }));
    const el = fmtHms(sum.elapsed), left = fmtHms(sum.left);
    if (el) bits.push(tr("printers.elapsed", { t: el }));
    if (left) bits.push(tr("p3d.left", { t: left }));
    p3dText($("p3d-prog-t"), bits.join(" · "));
    const more = [];
    if (sum.speed != null) more.push(`${tr("printers.speed")} ${Math.round(sum.speed * 100)} %`);
    if (sum.fan != null) more.push(`${tr("printers.fan")} ${Math.round(sum.fan * 100)} %`);
    if (sum.filament != null) more.push(`${tr("files.col.weight")} ${fmtDec(sum.filament, 2)} m`);
    p3dText($("p3d-prog-more"), more.join(" · "));
  }
  const spools = [0, 1, 2, 3].map((n) => ctlSpool(pid, n));
  const rows = p3dRows(st, cs, spools);
  const box = $("p3d-heads");
  if (box.children.length !== rows.length) {
    box.innerHTML = rows
      .map((r) => `<div class="p3d-row p3d-head" role="listitem" data-zone="head:${r.n}" tabindex="0">
          <i class="p3d-sw"></i>
          <span class="p3d-main"><span class="p3d-l1"><b>T${r.n}</b><span class="p3d-name"></span><span class="p3d-tag"></span><span class="p3d-t"></span></span><small class="p3d-sub"></small></span>
          <button class="p3d-more" data-all="${r.n}" title="${esc(tr("p3d.all_head", { n: r.n }))}" aria-label="${esc(tr("p3d.all_head", { n: r.n }))}">⋯</button>
        </div>`)
      .join("");
  }
  // The filament profile of each head, as set in "Heads and spools".
  if (typeof HD !== "undefined" && !HD.listsNow[pid]) headsLists(pid).catch(() => {});
  const profile = (n) => (typeof headsProfile === "function" ? headsProfile(pid, n, HD.listsNow[pid] || null).name || "" : "");
  rows.forEach((r, i) => {
    const el = box.children[i];
    el.style.setProperty("--spool", r.present ? r.color || "var(--text-tertiary)" : "transparent");
    el.classList.toggle("no-spool", !r.present);
    el.classList.toggle("on", P3.zone === `head:${r.n}`);
    p3dText(el.querySelector(".p3d-name"), r.present ? r.name || tr("ctl.loaded") : tr("p3d.empty"));
    const tag = el.querySelector(".p3d-tag");
    p3dText(tag, r.active ? tr(sum.state === "printing" ? "printers.extruding" : "printers.active_head_tag") : r.present && r.inHead === false ? tr("p3d.unloaded") : r.used ? tr("printers.used_by_job") : "");
    // An empty head shows nothing of the spool it had, nor its profile.
    p3dText(el.querySelector(".p3d-sub"), r.present ? [...r.detail, profile(r.n)].filter(Boolean).join(" · ") : "");
    tag.className = "p3d-tag" + (r.active ? " accent" : "");
    p3dText(el.querySelector(".p3d-t"), p3dTemp(r.temp, r.target));
  });
  const bed = cs?.bed || (st?.bed && { temp: st.bed.current, target: st.bed.target });
  const b = $("p3d-bed");
  b.classList.toggle("hidden", !bed);
  b.classList.toggle("on", P3.zone === "bed");
  if (!b.firstElementChild) b.innerHTML = `<span class="p3d-name"></span><span class="p3d-t"></span>`;
  p3dText(b.firstElementChild, tr("ctl.bed"));
  p3dText(b.lastElementChild, bed ? p3dTemp(bed.temp, bed.target) : "");
}

/* The printer's details, bottom right, one per line; the data's age
   follows (updateFreshness writes #p3d-fresh). */
function p3dInfo(st) {
  const p = current();
  if (!p) return;
  const rows = [
    [tr("printers.form.model"), p.model],
    [tr("printers.address"), `${p.host}:${p.port}`],
    [tr("printers.hostname"), st?.hostname],
    ["Klipper", st?.klipper],
    [tr("printers.note"), p.note],
  ];
  $("p3d-info-rows").innerHTML = rows
    .filter((r) => r[1])
    .map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(String(v))}</b></div>`)
    .join("");
}

/* The quick bar: the light's state, the camera's. */
function p3dQuick() {
  const pid = P3.pid, cs = ctlState(pid), cfg = ctlData(pid).cfg;
  const light = $("p3d-light");
  light.classList.toggle("on", !!cs?.light);
  light.classList.toggle("hidden", !!cfg && !cfg.light);
  light.disabled = !!ctlBusy(pid) || !!ctlWhy("light", cs, cfg);
  $("p3d-camera").classList.toggle("on", CAM.on && CAM.id === P3.pid);
  $("p3d-help").classList.toggle("on", P3.hint);
  $("p3d-hint").classList.toggle("hidden", !P3.hint);
}

/* The emergency stop, in the toolbar beside Control. */
function p3dEstopPaint() {
  const box = $("prn-estop");
  if (!box.firstElementChild) box.innerHTML = ctlEstopHtml();
  if (P3.pid) ctlPaint(box, P3.pid);
}

/* ------------------------------------------------------------ hover, pick */

function p3dLabel(zone) {
  const z = p3dParse(zone), pid = P3.pid;
  if (!z) return null;
  const open = tr("p3d.click_open");
  if (z.kind === "spool") {
    const sp = ctlSpool(pid, z.n);
    return { title: `T${z.n} · ${sp.present ? sp.name || tr("ctl.loaded") : tr("ctl.no_spool")}`, sub: `${tr(`p3d.side.${P3D_SPOOLS[z.n].side}`)} · ${open}`, color: sp.present ? sp.color : null };
  }
  if (z.kind === "head") {
    const h = ctlState(pid)?.heads.find((x) => x.index === z.n);
    return { title: tr("p3d.head", { n: z.n }), sub: h ? p3dTemp(h.temp, h.target) : open, color: ctlSpool(pid, z.n).color };
  }
  if (z.kind === "bed") {
    const b = ctlState(pid)?.bed;
    return { title: tr("ctl.bed"), sub: b ? p3dTemp(b.temp, b.target) : open };
  }
  return { title: tr("ctl.light"), sub: ctlState(pid)?.light ? tr("p3d.on") : tr("p3d.off") };
}

function p3dTip(zone, x, y) {
  const tip = $("p3d-tip");
  const l = zone && p3dPanelZone(zone) !== P3.zone ? p3dLabel(zone) : null;
  tip.classList.toggle("hidden", !l);
  if (!l) return;
  tip.innerHTML = `<b>${l.color !== undefined ? `<i style="--spool:${esc(l.color || "transparent")}"></i>` : ""}${esc(l.title)}</b><small>${esc(l.sub)}</small>`;
  const r = $("p3d").getBoundingClientRect();
  tip.style.left = `${Math.min(x - r.left + 14, r.width - tip.offsetWidth - 8)}px`;
  tip.style.top = `${Math.max(8, y - r.top - tip.offsetHeight - 10)}px`;
}
const p3dHover = (zone, x, y) => p3dTip(zone, x, y);

/* A click (on the model, a row, a key) opens the panel of what was
   clicked and turns the view to it: a head to its spool's side, the bed
   and the light to the front. Clicking it again keeps it selected;
   nothing (the background, ✕, Esc) deselects and turns to the front. */
function p3dPick(zone) {
  p3dTip(null);
  p3dHintDone();
  const panel = p3dPanelZone(zone);
  if (!panel) return p3dDeselect();
  if (panel !== P3.zone) p3dOpen(panel);
  p3dTurn(p3dSideOf(panel));
}
function p3dDeselect() {
  p3dClose();
  p3dTurn("front");
}
function p3dTurned(side) {
  p3dSegment(side);
  p3dHintDone();
}
function p3dSegment(side) {
  $("p3d-views").querySelectorAll("[data-side]").forEach((b) => b.classList.toggle("on", b.dataset.side === side));
}
function p3dTurn(side) {
  if (!P3.view) return;
  p3dSegment(side);
  P3.view.turn(side);
  p3dHintDone();
}

/* The help line: until the first action, or asked for again (?). */
function p3dHintDone() {
  if (!P3.hint) return;
  P3.hint = false;
  localStorage.setItem("snapstudio.p3d.hint", "off");
  p3dQuick();
}

/* ------------------------------------------------------------ the panel */

function p3dOpen(zone) {
  P3.zone = zone;
  P3.built = "";
  $("p3d-panel").classList.remove("hidden");
  P3.view?.choose(zone);
  p3dPanelPaint();
  p3dCard(P.status.get(P3.pid));
}
function p3dClose() {
  P3.zone = null;
  $("p3d-panel").classList.add("hidden");
  P3.view?.choose(null);
  if (P3.pid) p3dCard(P.status.get(P3.pid));
}

/* Builds the panel for its zone (again once Control's configuration is
   known), then paints it with the components' paints. A head's panel: its
   nozzle (with its spool) then Load / Unload. */
function p3dPanelPaint() {
  const z = p3dParse(P3.zone), pid = P3.pid;
  if (!z || !pid) return;
  const cfg = ctlData(pid).cfg;
  const head = z.kind === "head" ? z.n : null;
  const sp = head != null ? ctlSpool(pid, head) : null;
  const key = `${pid}:${P3.zone}:${cfg ? 1 : 0}`;
  const body = $("p3d-panel-body");
  const title = $("p3d-panel-t");
  title.style.setProperty("--spool", sp?.present ? sp.color || "var(--text-tertiary)" : "transparent");
  title.textContent = head != null ? `${tr("p3d.head", { n: head })} · ${sp.present ? sp.name || tr("ctl.loaded") : tr("p3d.empty")}` : tr(z.kind === "bed" ? "ctl.bed" : "ctl.light");
  title.classList.toggle("p3d-swt", head != null);
  if (P3.built !== key) {
    P3.built = key;
    const wait = `<div class="ctl-c p3d-wait">${esc(tr("p3d.reading"))}</div>`;
    const h = head != null ? cfg?.heads.find((x) => x.index === head) : null;
    const parts = [];
    if (head != null) parts.push(h ? ctlHeadHtml(h, { compact: true }) : wait, ctlSpoolHtml(head, { compact: true }));
    if (z.kind === "bed") parts.push(cfg ? ctlBedHtml(cfg, { compact: true }) : wait);
    if (z.kind === "light") parts.push(ctlLightHtml({ compact: true }));
    const all = head != null ? tr("p3d.all_head", { n: head }) : tr("p3d.all");
    body.innerHTML = `${parts.join("")}
      <div class="p3d-busy hidden" role="status"><span class="spinner small"></span><span></span></div>
      <button class="btn p3d-all" data-all="${head ?? ""}">${P3D_CONTROL_ICON}<span>${esc(all)}</span></button>`;
  }
  ctlPaint(body, pid);
  const busy = ctlBusy(pid), b = body.querySelector(".p3d-busy");
  b.classList.toggle("hidden", !busy);
  b.lastElementChild.textContent = busy || "";
}

/* ------------------------------------------------------------ events */

ctlBind($("p3d"));
ctlBind($("prn-estop"));
$("p3d-close").addEventListener("click", p3dDeselect);
$("p3d").addEventListener("click", (e) => {
  const all = e.target.closest("[data-all]");
  if (all) return ctlOpen(P3.pid, all.dataset.all === "" ? {} : { head: +all.dataset.all });
  if (e.target.closest("[data-heads-open]") && P3.pid) return headsShow(P3.pid);
  const row = e.target.closest(".p3d-card [data-zone]");
  if (row) p3dPick(row.dataset.zone);
});
$("p3d-heads").addEventListener("keydown", (e) => {
  const row = e.target.closest("[data-zone]");
  if (row && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    p3dPick(row.dataset.zone);
  }
});
$("p3d-views").addEventListener("click", (e) => {
  const b = e.target.closest("[data-side]");
  if (b) p3dTurn(b.dataset.side);
});
$("p3d-light").addEventListener("click", () => {
  const pid = P3.pid;
  ctlRun(pid, { kind: "light", on: !ctlState(pid)?.light }, tr("ctl.doing.light"));
});
$("p3d-camera").addEventListener("click", async () => {
  await (CAM.on && CAM.id === P3.pid ? camStop() : camStart(P3.pid));
  p3dQuick();
});
$("p3d-help").addEventListener("click", () => {
  P3.hint = !P3.hint;
  localStorage.setItem("snapstudio.p3d.hint", P3.hint ? "on" : "off");
  p3dQuick();
});
/* The keyboard, on the printer page: ← → turn, 1–4 a head, Escape closes. */
document.addEventListener("keydown", (e) => {
  if (!p3dOn() || e.metaKey || e.ctrlKey || e.altKey || document.querySelector(".modal:not(.hidden)")) return;
  if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
  if (e.key === "Escape" && P3.zone) return p3dDeselect();
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    return p3dTurn(p3dNextSide(P3.view?.side || "front", e.key === "ArrowRight" ? 1 : -1));
  }
  const n = "1234".indexOf(e.key);
  if (n >= 0 && n < $("p3d-heads").children.length) p3dPick(`head:${n}`);
});
window.addEventListener("langchange", () => {
  P3.built = "";
  $("p3d-heads").innerHTML = "";
  $("prn-estop").innerHTML = "";
  if (P3.pid) p3dStatus(P.status.get(P3.pid));
});
