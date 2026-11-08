"use strict";
/* Prepare: the prime tower on the plate (rules in tower-logic.js).

   The "Prime tower" switch under the object list and the slice sheet's
   (#s-tower-sw) are one setting, `enable_prime_tower`, kept with the plate
   (`PR.tower.on`) — never the profile's: a new plate starts without one.
   When the engine will print a tower (advTowerOn: the option on, two heads
   used or more, layer by layer), a grey translucent box stands where it
   will be printed: placed in a free corner, moved and turned like a part,
   sent with the plate as `wipe_tower_x` / `wipe_tower_y` /
   `wipe_tower_rotation_angle`. Its size is estimated until a slice tells
   the real one. On a plate whose materials do not bond, the user may
   choose one tower per material instead (prepare-pillars.js): the same
   switch, the same boxes, checks and menu, for each pillar. */

/* What is selected of the towers: false, true (the engine's tower) or a
   pillar's key. */
PR.towerSel = false;

/* The plate's tower as stored, in the plate and its undo steps: the
   engine's tower, and the pillars (the kind chosen, the row's turn, each
   group split or not, each pillar's place). */
const prTowerStored = (t = PR.tower) => ({
  on: !!t.on, x: t.x, y: t.y, rot: t.rot || 0, real: t.real || null,
  kind: t.kind === "material" ? "material" : "single", row: { rot: t.row?.rot || 0 }, groups: t.groups || {}, pillars: t.pillars || {},
});

/* A stored tower back (plate, undo step, older plate without one: off, a
   single tower, no pillars). */
function prTowerRestore(t) {
  PR.tower = { on: false, x: null, y: null, rot: 0, real: null, kind: "single", row: { rot: 0 }, groups: {}, pillars: {}, ...(t && typeof t === "object" ? t : {}) };
  PR.tower.on = ptOn({ tower: PR.tower });
  if (PR.tower.kind !== "material") PR.tower.kind = "single";
  for (const k of ["groups", "pillars"]) if (!PR.tower[k] || typeof PR.tower[k] !== "object") PR.tower[k] = {};
  if (!PR.tower.row || typeof PR.tower.row !== "object") PR.tower.row = { rot: 0 };
}

// The plate read at start (prLoadState) holds its tower, or none.
prTowerRestore(PR.tower);

/* A 3MF's tower (plate_tower), for a file opened on an empty plate as it
   was laid out: its place, and its switch when Snap Studio saved it — an
   Orca project's is its profile's, and a new project starts without. */
async function prTowerFromFile(path) {
  const t = await invoke("plate_tower", { path }).catch(() => null);
  if (!t) return;
  if (t.x != null && t.y != null) {
    PR.tower.x = t.x;
    PR.tower.y = t.y;
    PR.tower.rot = normDeg(t.rot || 0);
    PR.tower.real = null;
    if (t.ours) PR.tower.on = !!t.on;
  }
  // Smooth mix as saved (Snap Studio's files only).
  if (t.smooth_mix != null) PR.smoothMix = !!t.smooth_mix;
  // Snap Studio's own data: one tower per material, its pillars' places.
  const d = t.ours ? t.snap : null;
  if (d && typeof d === "object") {
    const { on, x, y, rot, real } = PR.tower;
    prTowerRestore({ on, x, y, rot, real, kind: d.kind, row: d.row, groups: d.groups, pillars: d.pillars });
  }
}

/* ------------------------------------------------------------ settings */

/* The sheet's advanced differences for the remembered machine: its own
   once it has loaded them, otherwise the ones remembered for it. */
function prTowerAdv() {
  if (typeof SL === "undefined") return {};
  if ($("s-machine")?.value) return SL.adv || {};
  const machine = SL.memory?.last;
  return (machine && SL.memory[machine]?.adv) || {};
}

/* A profile's value: the sheet's, or the one read here, or the engine's. */
function prTowerProfileValue(k) {
  if (typeof ADV !== "undefined" && ADV.defaults?.[k] != null) return ADV.defaults[k];
  if (PR.towerProfile?.values?.[k] != null) return PR.towerProfile.values[k];
  return typeof ADV_ENGINE_DEFAULTS !== "undefined" ? ADV_ENGINE_DEFAULTS[k] : undefined;
}

/* The tower's settings, as the slice will send them: the sheet's
   differences, then the profile's values (loaded by the sheet, or here for
   the remembered profile), then the engine's defaults. */
function prTowerSetting(k) {
  const adv = prTowerAdv();
  return k in adv ? adv[k] : prTowerProfileValue(k);
}
const prTowerNum = (k, dflt) => {
  const v = parseFloat(String(prTowerSetting(k) ?? "").replace("%", ""));
  return isFinite(v) ? v : dflt;
};

/* The remembered machine and profile: the sheet's last choice. */
function prTowerProfileName() {
  if (typeof SL === "undefined") return null;
  const machine = SL.memory?.last;
  const m = machine ? SL.memory[machine] || {} : {};
  return machine && m.process ? { machine, process: m.process, simple: m.simple || null } : null;
}

/* The profile's tower values, read once per profile when the sheet has
   not loaded them (Prepare before the first slice). */
async function prTowerLoadProfile() {
  const p = prTowerProfileName();
  if (!p || (typeof ADV !== "undefined" && ADV.defaults?.prime_tower_width != null)) return;
  const key = `${p.machine}\n${p.process}`;
  if (PR.towerProfile?.key === key) return;
  PR.towerProfile = { key, values: null };
  const d = await invoke("slice_details", { name: p.process, machine: p.machine, simple: p.simple, overrides: {}, color: null }).catch(() => null);
  if (PR.towerProfile?.key !== key) return;
  PR.towerProfile.values = Object.fromEntries(Object.entries(d?.values || {}).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  prTowerChanged();
}

/* The head of each colour of an object, as the slice will send it. */
function prTowerObjectHeads(o) {
  const live = typeof headsActive === "function";
  const pid = live ? headsActive() : "";
  if (PR.assoc === "colour") return prSliceHeads(o);
  if (!live) return o.heads || {};
  return Object.fromEntries(Object.entries(prHeads(o, pid, headsSlots(pid), headsCount(pid))).map(([e, v]) => [e, v.h]));
}

/* Heads the plate prints with: its sliced objects' colours, and the heads
   the advanced settings send supports, walls or infill to. */
function prTowerHeads() {
  const live = typeof headsActive === "function";
  const pid = live ? headsActive() : "";
  const used = new Set();
  for (const o of plSliced(PR.objects, bedState)) {
    const heads = prTowerObjectHeads(o);
    for (const ext of prColors(o)) used.add(heads[ext] ?? 0);
  }
  if (typeof advHeads === "function") for (const h of Object.values(advHeads({ tower: false }))) used.add(h);
  // A virtual head prints with its two heads; an orphan with none.
  return vhPhysical(used, headsVirtual(pid));
}

/* The plate uses a virtual head: it changes heads at every layer. */
function prTowerVirtualUsed() {
  const list = headsVirtual(headsActive());
  // A virtual head is always a choice: in the heads the slice gets.
  return list.length > 0 && plSliced(PR.objects, bedState).some((o) => Object.values(prSliceHeads(o)).some((h) => vhFind(list, h)));
}

/* Whether a tower is printed now (either kind), and why not. */
const prTowerState = (heads = prTowerHeads().size) =>
  ptState({ heads, on: PR.tower.on, sequence: String(prTowerSetting("print_sequence") || "by layer") });
/* The engine's own tower is printed (not the pillars). */
const prTowerShown = () => !!PR.tower.on && prTowerKindNow() === "single";

/* What the size depends on (tower-logic.js ptSizeKey). */
function prTowerKey(heads = prTowerHeads().size) {
  const parts = plSliced(PR.objects, bedState).map((o) => [meshKey(o), o.rot, o.scale]);
  const p = prTowerProfileName();
  const settings = ["prime_tower_width", "prime_volume", "prime_tower_brim_width", "wipe_tower_wall_type", "wipe_tower_rib_width", "wipe_tower_extra_rib_length", "wipe_tower_extra_spacing", "layer_height"].map(prTowerSetting);
  return ptSizeKey(parts, [heads, p?.machine, p?.process, settings]);
}

/* The tower's box: the slice's while nothing it depends on changed,
   otherwise estimated. null without a tower. */
function prTowerBox() {
  // Off: nothing to work out (this runs on every frame and pointer move).
  if (!PR.tower.on) return null;
  const set = prTowerHeads(), heads = set.size;
  if (prTowerKindNow(set) !== "single") return null;
  const real = PR.tower.real;
  if (real?.box && real.key === prTowerKey(heads)) return { ...real.box, est: false };
  const height = Math.max(0, ...plSliced(PR.objects, bedState).map((o) => shape(o).zmax - shape(o).zmin));
  const name = prTowerProfileName()?.machine || "";
  const nozzle = prTowerNum("nozzle_diameter", +(/([\d.]+) nozzle/.exec(name)?.[1] || 0.4));
  const e = ptEstimate({
    heads,
    height,
    layer: prTowerNum("layer_height", 0.2),
    width: prTowerNum("prime_tower_width", 60),
    volume: prTowerNum("prime_volume", 45),
    brim: prTowerNum("prime_tower_brim_width", 3),
    nozzle,
    wall: String(prTowerSetting("wipe_tower_wall_type") || "rectangle"),
    ribWidth: prTowerNum("wipe_tower_rib_width", 8),
    ribExtra: prTowerNum("wipe_tower_extra_rib_length", 0),
    spacing: prTowerNum("wipe_tower_extra_spacing", 100) / 100,
  });
  return e && { ...e, est: true };
}

/* ------------------------------------------------------------ placement */

/* Part footprints the tower must keep clear of: the objects on the plate. */
const prTowerParts = () => PR.objects.filter((o) => bedState(o) !== "out").map(footprintPoly);

/* A free spot for the tower, its rotation kept. */
function prTowerSpot(box = prTowerBox()) {
  return box ? ptSpot(box, PR.bed, prTowerParts(), PR.tower.rot || 0) : null;
}

/* A tower shown for the first time takes a free corner; pillars, a free
   place each. */
function prTowerEnsurePlaced() {
  prPillarsEnsurePlaced();
  if (PR.tower.x != null || !prTowerShown()) return;
  const s = prTowerSpot();
  if (!s) return;
  PR.tower.x = s.x;
  PR.tower.y = s.y;
  prSave();
}

/* "Move it to a free spot": the automatic placement again, one undo step;
   the pillars' whole row. */
function prTowerToSpot() {
  if (prPillarsShown()) {
    prRemember();
    if (!prPillarsPlaceAll()) toast(tr("prepare.tower.no_spot"), true);
    return prTowerChanged(true);
  }
  const s = prTowerSpot();
  if (!s) return;
  prRemember();
  PR.tower.x = s.x;
  PR.tower.y = s.y;
  if (!s.free) toast(tr("prepare.tower.no_spot"), true);
  prTowerChanged(true);
}

/* Its corners on the plate, and its state there: "in", "partial" or
   "out", overlapping a part or not. */
function prTowerCheck(box = prTowerBox()) {
  if (!box || PR.tower.x == null) return null;
  const poly = ptCorners(PR.tower, box);
  const parts = PR.objects.filter((o) => bedState(o) !== "out");
  const hits = parts.filter((o) => ptConvexOverlap(poly, footprintPoly(o)));
  return { poly, state: ptBedState(PR.tower, box, PR.bed), hits: hits.map((o) => o.id) };
}

/* Every tower's check on the plate: the engine's, each pillar's.
   [{ key, check, pillar }] — `key` true or the pillar's key. */
function prTowerChecks() {
  if (prPillarsShown()) return prPillars().list.map((p) => ({ key: p.key, pillar: p, check: prPillarCheck(p) })).filter((c) => c.check);
  const check = prTowerShown() ? prTowerCheck() : null;
  return check ? [{ key: true, check }] : [];
}

/* The plate, a part or a setting changed: the tower follows (shown or
   not, placed, redrawn), and the slice sheet's switch with it. `save`:
   its own change, kept with the plate. */
function prTowerChanged(save = false) {
  prTowerEnsurePlaced();
  if (save) prSave();
  prRenderInspector();
  prSchedule();
  if (typeof advRenderRows === "function" && !$("smodal").classList.contains("hidden")) {
    advRenderRows();
    if (ADV.cat === "mm") advRenderPanel();
  }
}

/* The option, from either switch. */
function prTowerSetOn(on) {
  if (PR.tower.on === !!on) return;
  PR.tower.on = !!on;
  if (on) prTowerLoadProfile();
  if (!prTowerSelValid()) PR.towerSel = false;
  prTowerChanged(true);
}

/* The overrides a slice sends: the tower's place, with it only; with the
   pillars, the engine's tower off and the objects in the list's order. */
function prTowerOverrides() {
  if (prPillarsShown()) return pmOverrides();
  if (!prTowerShown() || PR.tower.x == null) return {};
  const n = (v) => String(Math.round(v * 1000) / 1000);
  return { wipe_tower_x: [n(PR.tower.x)], wipe_tower_y: [n(PR.tower.y)], wipe_tower_rotation_angle: n(PR.tower.rot || 0) };
}

/* A slice is done: the tower it printed (gcode.rs TowerBox) gives the real
   size, for the plate as it was sliced (`key`). */
function prTowerSliced(t, key) {
  const box = ptFromGcode(t);
  PR.tower.real = box && key ? { box, key } : null;
  prSave();
  prSchedule();
}

/* The prime volume from Prepare's slider: the slice sheet's setting, a
   difference from the profile shown there (Multi-material panel). Before
   the sheet has loaded this machine's settings, it goes to the ones
   remembered for it, which the sheet loads. */
function prTowerSetVolume(v) {
  const k = "prime_volume", value = String(Math.round(v));
  if ($("s-machine")?.value && ADV.defaults?.[k] != null) return advSet(k, value);
  const machine = prTowerProfileName()?.machine;
  if (!machine) return;
  const adv = { ...(rememberFor(machine).adv || {}) };
  if (value === String(prTowerProfileValue(k))) delete adv[k];
  else adv[k] = value;
  SL.memory[machine] = { ...rememberFor(machine), adv };
  localStorage.setItem("snapstudio.slice", JSON.stringify(SL.memory));
}

/* Its bounds: the least the engine purges on the tower
   (filament_minimal_purge_on_wipe_tower, 15 on the U1), up to twice the
   profile's. */
function prTowerVolumeRange() {
  const min = Math.max(1, Math.round(prTowerNum("filament_minimal_purge_on_wipe_tower", 15)));
  const profile = parseFloat(prTowerProfileValue("prime_volume")) || 45;
  return { min, max: Math.max(90, Math.round(profile * 2)), profile };
}

/* Moves (the selected pillar, or the tower) and turns, the turn around
   the box's middle. */
function prTowerMove(dx, dy, key = PR.towerSel) {
  if (typeof key === "string") return prPillarMove(key, dx, dy);
  PR.tower.x = Math.round((PR.tower.x + dx) * 100) / 100;
  PR.tower.y = Math.round((PR.tower.y + dy) * 100) / 100;
}

/* What the inspector's position fields act on: the tower, or the selected
   pillar's place; null when nothing shown is selected. */
function prTowerTarget() {
  if (PR.towerSel === true) return prTowerShown() && PR.tower.x != null ? PR.tower : null;
  if (typeof PR.towerSel === "string") return prPillarsShown() ? PR.tower.pillars?.[PR.towerSel] || null : null;
  return null;
}

/* The selection still stands for something shown. */
const prTowerSelValid = () => !PR.towerSel || !!prTowerTarget();
function prTowerTurn(rot, box = prTowerBox()) {
  if (!box) return;
  const t = ptTurn(PR.tower, box, normDeg(rot));
  Object.assign(PR.tower, { x: Math.round(t.x * 100) / 100, y: Math.round(t.y * 100) / 100, rot: t.rot });
}

/* ------------------------------------------------------------ picking */

/* Distance along the pointer's ray to the nearest tower's box (the
   engine's tower, or a pillar), or null. */
const prTowerHit = (e, ray = prRay(e)) => prTowerPick(e, ray)?.dist ?? null;

/* The nearest tower under the pointer: { dist, key } (key true for the
   engine's tower, else the pillar's), or null. */
function prTowerPick(e, ray = prRay(e)) {
  let best = null;
  const near = (dist, key) => dist != null && (!best || dist < best.dist) && (best = { dist, key });
  if (prPillarsShown()) {
    for (const p of prPillars().list) if (Number.isFinite(p.x)) near(prBoxHit(ray, { x: p.x, y: p.y, rot: 0 }, pmBox(p)), p.key);
  } else {
    const box = prTowerBox();
    if (box && PR.tower.x != null) near(prBoxHit(ray, PR.tower, box), true);
  }
  return best;
}

/* Distance along a ray to a box placed at `t` ({ x, y, rot }), or null. */
function prBoxHit(ray, t, box) {
  const a = (-(t.rot || 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const local = (v, point) => {
    const x = point ? v[0] - t.x : v[0], y = point ? v[1] - t.y : v[1];
    return [x * c - y * s, x * s + y * c, v[2]];
  };
  const o = local(ray.o, true), d = local(ray.d, false);
  const lo = [box.x0, box.y0, 0], hi = [box.x0 + box.w, box.y0 + box.d, Math.max(box.h, 1)];
  let t0 = 0, t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-12) {
      if (o[k] < lo[k] || o[k] > hi[k]) return null;
      continue;
    }
    const p = (lo[k] - o[k]) / d[k], q = (hi[k] - o[k]) / d[k];
    t0 = Math.max(t0, Math.min(p, q));
    t1 = Math.min(t1, Math.max(p, q));
  }
  return t0 <= t1 ? t0 : null;
}

/* A tower selected (alone: `key` true for the engine's, else a pillar's),
   or none. */
function prTowerSelect(on, key = true) {
  PR.towerSel = on ? key : false;
  if (!prTowerSelValid()) PR.towerSel = false;
  if (PR.towerSel) PR.sel.clear();
  prRenderInspector();
  prSchedule();
}

/* ------------------------------------------------------------ drawing */

const TOWER_GREY = [0.55, 0.56, 0.58];

/* The boxes, translucent, with darker edges; selected, overlapping or off
   the plate, they take the parts' tints. */
function prTowerDraw(gl, vp, accent) {
  if (prPillarsShown()) {
    for (const p of prPillars().list) {
      const chk = prPillarCheck(p);
      if (chk) prTowerDrawBox(gl, vp, accent, chk, p.h, PR.towerSel === p.key);
    }
    return;
  }
  const box = prTowerBox();
  const chk = prTowerCheck(box);
  if (chk) prTowerDrawBox(gl, vp, accent, chk, box.h, PR.towerSel === true);
}

function prTowerDrawBox(gl, vp, accent, chk, height, selected) {
  const h = Math.max(height, 1);
  const lo = chk.poly.map(([x, y]) => [x, y, 0.05]), hi = chk.poly.map(([x, y]) => [x, y, h]);
  const tint =
    chk.state !== "in" ? [prTok("--danger", [1, 0.23, 0.19]), 0.5]
    : selected ? [accent, 0.4]
    : chk.hits.length ? [prTok("--warning", [1, 0.58, 0]), 0.45]
    : null;
  const base = tint ? TOWER_GREY.map((v, i) => v + (tint[0][i] - v) * tint[1]) : TOWER_GREY;
  const shade = (k) => [...base.map((v) => v * k), 0.35];
  const quad = (a, b, c, d) => [...a, ...b, ...c, ...a, ...c, ...d];
  // Translucent faces: what is behind shows; the depth buffer is left as
  // the parts made it. The canvas itself stays opaque (its alpha kept at
  // 1): otherwise the page behind it would show through the faces.
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
  gl.depthMask(false);
  drawSolid(gl, vp, quad(hi[0], hi[1], hi[2], hi[3]), shade(1), gl.TRIANGLES);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    drawSolid(gl, vp, quad(lo[i], lo[j], hi[j], hi[i]), shade(i % 2 ? 0.78 : 0.88), gl.TRIANGLES);
  }
  gl.depthMask(true);
  const edges = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    edges.push(...lo[i], ...lo[j], ...hi[i], ...hi[j], ...lo[i], ...hi[i]);
  }
  const edge = selected ? accent : base.map((v) => v * 0.55);
  drawSolid(gl, vp, edges, [...edge, selected ? 1 : 0.9], gl.LINES);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
}

/* "Prime tower 60 × 34 × 42 mm", "estimated" before slicing; `short`:
   the size alone, beside the tower's name. */
function prTowerLabel(box = prTowerBox(), short = false) {
  if (!box) return "";
  const size = [box.w, box.d, box.h].map((v) => fmtDec(v, 0)).join(" × ");
  const key = short ? (box.est ? "prepare.tower.dims_est" : "prepare.tower.dims") : box.est ? "prepare.tower.size_est" : "prepare.tower.size";
  return tr(key, { size });
}

/* The hover label, under the pointer. */
function prTowerHover(e) {
  const tip = $("p-tower-tip");
  const pick = !PR.drag && e ? prTowerPick(e) : null;
  const over = !!pick && !(prPickDist(e)?.dist < pick.dist);
  tip.classList.toggle("hidden", !over);
  if (!over) return;
  const rect = $("p-canvas").getBoundingClientRect();
  const p = typeof pick.key === "string" ? prPillar(pick.key) : null;
  tip.textContent = p ? prPillarLabel(p) : prTowerLabel();
  tip.style.left = e.clientX - rect.left + "px";
  tip.style.top = e.clientY - rect.top + "px";
}

/* ------------------------------------------------------------ panels */

/* The switch under the list: on or off, disabled with its reason when no
   tower can be printed (the choice kept for when one can). Not shown at
   all while the plate prints with one head: there is nothing to choose. */
function prTowerRenderSwitch() {
  const sw = $("p-tower-sw");
  if (!sw) return;
  const st = prTowerState();
  $("p-plateopts").classList.toggle("hidden", st.reason === "single");
  sw.checked = PR.tower.on;
  sw.disabled = !!st.reason;
  const why = $("p-tower-why");
  const pillars = prPillarsShown();
  // Off with a virtual head: advised, never turned on for the user.
  why.textContent = st.reason ? tr(`prepare.tower.why.${st.reason}`) : st.show && !pillars ? prTowerLabel(undefined, true) : !PR.tower.on && prTowerVirtualUsed() ? tr("prepare.tower.virtual_hint") : "";
  why.classList.toggle("hidden", !why.textContent);
  sw.title = st.reason ? why.textContent : "";
  $("p-tower-row").classList.toggle("off", !!st.reason);
  // One tower or one per material: only when the materials do not bond.
  const offered = prPillarOffered();
  $("p-tower-kind-row").classList.toggle("hidden", !offered);
  if (!offered) return;
  document.querySelectorAll("#p-tower-kind [data-kind]").forEach((b) => {
    const on = b.dataset.kind === (pillars ? "material" : "single");
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  });
  $("p-tower-kind-why").textContent = pillars ? tr("prepare.tower.per_material", { list: prPillarList() }) : tr("prepare.tower.per_material_why");
}

/* The inspector for the tower: its corner, its turn, its prime volume
   (prepare.js PF, sliders or typed as the objects'), its size and what is
   wrong with its place. */
function prTowerRenderProps() {
  const t = prTowerTarget();
  $("p-tower-props").classList.toggle("hidden", !t);
  if (!t) return false;
  $("p-insp").classList.remove("hidden");
  $("p-props").classList.add("hidden");
  const pillar = typeof PR.towerSel === "string" ? prPillar(PR.towerSel) : null;
  $("p-tower-props").classList.toggle("pillar", !!pillar);
  if (pillar) return prPillarRenderProps(pillar);
  $("p-insp-name").textContent = $("p-insp-name").title = tr("prepare.tower");
  $("p-tower-corner").textContent = tr("prepare.tower.corner");
  $("p-trot-sec").classList.remove("hidden");
  for (const [id, f] of Object.entries(PF)) if (f.tower) prRenderField(id, f, f.get(t));
  // Less than the profile purges: colours may mix at head changes.
  const vol = PF["p-tvol"].get(), lim = prTowerVolumeRange();
  $("p-tvol-note").classList.toggle("hidden", !(vol < lim.profile));
  const box = prTowerBox(), chk = prTowerCheck(box);
  $("p-tower-dims").textContent = prTowerLabel(box, true);
  const warn = !chk ? "" : chk.state !== "in" ? tr("prepare.tower.off_plate") : chk.hits.length ? tr("prepare.tower.overlap") : "";
  $("p-tower-warn").textContent = warn;
  $("p-tower-warn").classList.toggle("hidden", !warn);
  return true;
}

/* A pillar's inspector: its name, its heads (outer ring first), its exact
   size (Snap Studio makes it), its place, the row's turn while it is in
   the row, one pillar per head for its group, what is wrong with its
   place. No prime volume: with the engine's tower off it does nothing. */
function prPillarRenderProps(p) {
  $("p-insp-name").textContent = $("p-insp-name").title = prPillarName(p);
  $("p-tower-corner").textContent = tr("prepare.tower.center");
  const target = prTowerTarget();
  for (const [id, f] of Object.entries(PF)) if (f.tower && !f.setting && id !== "p-trot") prRenderField(id, f, f.get(target));
  // The row turns while its pillars are together; one moved out of it has
  // only a position.
  const inRow = !target.moved && Object.values(PR.tower.pillars).filter((c) => !c.moved).length > 1;
  $("p-trot-sec").classList.toggle("hidden", !inRow);
  if (inRow) prRenderField("p-trot", PF["p-trot"], PF["p-trot"].get(target));
  // Its heads as tokens, the outer ring first.
  const slots = typeof headsActive === "function" ? headsSlots(headsActive()) : [];
  $("p-pillar-heads").innerHTML = p.heads.map((n) => headToken({ h: n, slot: slots.find((x) => x.index === n), tag: "span" })).join("");
  const group = PR.tower.groups?.[p.group] || {};
  const several = (pmGroups(prPillarHeads()).find((g) => g.key === p.group)?.heads.length || 1) > 1;
  $("p-pillar-split-row").classList.toggle("hidden", !several);
  $("p-pillar-split").checked = !!group.split;
  $("p-pillar-split-sub").textContent = tr(group.split === "auto" ? "prepare.tower.split_auto" : "prepare.tower.split_sub");
  $("p-tower-dims").textContent = tr("prepare.tower.dims", { size: [p.d, p.d, p.h].map((v) => fmtDec(v, 0)).join(" × ") });
  const chk = prPillarCheck(p);
  const warn = !chk ? "" : chk.state !== "in" ? tr("prepare.tower.off_plate") : chk.hits.length ? tr("prepare.tower.overlap") : "";
  $("p-tower-warn").textContent = warn;
  $("p-tower-warn").classList.toggle("hidden", !warn);
  return true;
}

/* The slice sheet's warning: a tower on a part (the engine refuses such a
   plate) or off the plate (slicing waits for it), with the way out. */
function prTowerSheetWarning() {
  const box = $("s-tower-place");
  if (!box) return;
  const checks = prTowerChecks().map((c) => c.check);
  const kind = checks.some((c) => c.state !== "in") ? "off_plate" : checks.some((c) => c.hits.length) ? "overlap" : "";
  const html = kind
    ? `<span class="sl-tower-t">${esc(tr(`slice.tower.place.${kind}`))}</span><span class="sl-tower-acts"><button class="btn small" data-tower-spot>${esc(tr("prepare.tower.spot"))}</button></span>`
    : "";
  box.classList.toggle("bad", kind === "off_plate");
  if (box.innerHTML !== html) box.innerHTML = html;
  box.classList.toggle("hidden", !html);
  box.querySelectorAll("button").forEach((b) => (b.disabled = !!SL.job));
}

/* Off the plate, the engine would print it there: slicing waits, as for
   a part sticking out. */
const prTowerBlocks = () => prTowerChecks().some((c) => c.check.state !== "in");

/* ------------------------------------------------------------ events */

$("p-tower-sw").addEventListener("change", (e) => prTowerSetOn(e.target.checked));
$("p-tower-kind").addEventListener("click", (e) => {
  const b = e.target.closest("[data-kind]");
  if (b) prTowerSetKind(b.dataset.kind);
});
$("p-pillar-split").addEventListener("change", (e) => {
  const p = typeof PR.towerSel === "string" ? prPillar(PR.towerSel) : null;
  if (p) prPillarSetSplit(p.group, e.target.checked);
});
$("s-tower-place").addEventListener("click", (e) => {
  if (!e.target.closest("[data-tower-spot]")) return;
  prTowerToSpot();
  prTowerSheetWarning();
});
onMenu("tower", (what) => {
  if (what === "spot") prTowerToSpot();
  if (what === "off") prTowerSetOn(false);
});

/* The tower's menu, from the plate (`key`: the tower or pillar clicked). */
function prTowerMenu(x, y, key = true) {
  prTowerSelect(true, key);
  nativeMenu([
    { id: "tower:spot", label: tr("prepare.tower.spot") },
    {},
    { id: "tower:off", label: tr("prepare.tower.turn_off") },
  ], x, y);
}
