"use strict";
/* Prepare: one prime tower per material (rules in pillar-logic.js).

   Under the « Prime tower » switch, when two of the plate's materials do
   not bond, a choice: « One tower » (the engine's, the default) or « Per
   material » (`PR.tower.kind`, kept with the plate): small pillars, one per
   group of materials that bond, a ring per head. They stand where they will
   be printed, as the tower's grey boxes: placed side by side in a free
   spot, each moved on its own, the row turned while its pillars are still
   together. A slice sends them (`pillars`) with the engine's tower off;
   they are generated again at every slice, never saved in the project. */

/* The plate's heads with their filament's material: the profile's type,
   else its name (the slice sheet's rule, advTowerHeads). */
function prPillarHeads(set = prTowerHeads()) {
  const live = typeof headsActive === "function";
  const pid = live ? headsActive() : "";
  const list = typeof SL !== "undefined" ? SL.lists?.filaments || null : null;
  const ftype = typeof spFtypeOf === "function" ? spFtypeOf(pid) : () => null;
  return [...set].sort((a, b) => a - b).map((n) => {
    const name = live ? headsProfile(pid, n, list).name || "" : "";
    return { n, material: (name && ftype(name)) || spMaterialFromName(name) };
  });
}

/* The tower printed now: null, "single" or "material" (pillar-logic.js
   pmKind), and the heads it was worked out from. */
function prTowerKindNow(set = prTowerHeads()) {
  return pmKind({ state: prTowerState(set.size), offered: pmOffered(prPillarHeads(set)), kind: PR.tower.kind });
}
const prPillarsShown = () => !!PR.tower.on && prTowerKindNow() === "material";

/* The choice is offered: on, possible, materials that do not bond. */
function prPillarOffered(set = prTowerHeads()) {
  return !!PR.tower.on && prTowerState(set.size).show && pmOffered(prPillarHeads(set));
}

/* ------------------------------------------------------------ heights */

const PR_COLOR_TOPS = new Map();

/* The top of each colour of an object, placed (from its resting point):
   the highest triangle of that model extruder in the display mesh. A
   simplified mesh (dense files) or one without extruders gives the
   object's top for every colour: taller, never shorter. */
function prColorTops(o) {
  const m = PR.meshes.get(meshKey(o));
  const sh = shape(o);
  const top = sh.zmax - sh.zmin;
  if (!m?.pos || !m.ext || m.truncated) return { top, by: null };
  const key = `${meshKey(o)}|${o.rot}|${o.scale}`;
  let by = PR_COLOR_TOPS.get(key);
  if (!by) {
    by = {};
    const r = sh.r, s = o.scale;
    for (let i = 0, n = m.pos.length / 3; i < n; i++) {
      const z = r[2][0] * m.pos[i * 3] * s[0] + r[2][1] * m.pos[i * 3 + 1] * s[1] + r[2][2] * m.pos[i * 3 + 2] * s[2];
      const e = m.ext[i];
      if (!(e in by) || z > by[e]) by[e] = z;
    }
    for (const e of Object.keys(by)) by[e] = Math.min(top, by[e] - sh.zmin);
    if (PR_COLOR_TOPS.size > 200) PR_COLOR_TOPS.clear();
    PR_COLOR_TOPS.set(key, by);
  }
  return { top, by };
}

/* The last layer of each physical head, on the engine's layers: the top of
   every colour it prints (a virtual head's two heads both), and the
   tallest object for the heads printing supports, walls or infill. */
function prPillarHeights() {
  const pid = typeof headsActive === "function" ? headsActive() : "";
  const virt = typeof headsVirtual === "function" ? headsVirtual(pid) : [];
  const tall = {};
  const lift = (h, z) => {
    for (const p of vhPhysical(new Set([h]), virt)) tall[p] = Math.max(tall[p] || 0, z);
  };
  let tallest = 0;
  for (const o of plSliced(PR.objects, bedState)) {
    const heads = prTowerObjectHeads(o);
    const { top, by } = prColorTops(o);
    tallest = Math.max(tallest, top);
    for (const ext of prColors(o)) lift(heads[ext] ?? 0, by?.[ext] ?? top);
  }
  if (typeof advHeads === "function") for (const h of Object.values(advHeads({ tower: false }))) lift(h, tallest);
  const layer = prTowerNum("layer_height", 0.2), first = prTowerNum("initial_layer_print_height", layer);
  return Object.fromEntries(Object.entries(tall).map(([h, z]) => [h, pmLayerUp(z, layer, first)]));
}

/* ------------------------------------------------------------ pillars */

/* A group's name: its material(s), else its head. */
const prPillarFamily = (g) => g.family || g.key;

/* A pillar's name: « Prime tower · PLA », with its head when its group is
   split (« Prime tower · PLA (T1) »). */
const prPillarName = (p) => tr("prepare.tower.pillar", { m: p.key !== p.group ? `${prPillarFamily(p)} (T${p.heads[0]})` : prPillarFamily(p) });

/* The plate's pillars, with their places: [{ key, group, family, heads,
   rings, d, h, w, x, y, moved }], and the groups. Places as kept; a pillar
   not placed yet has none (prPillarsEnsurePlaced gives it one). */
function prPillars() {
  if (!prPillarsShown()) return { list: [], groups: [] };
  const set = prTowerHeads();
  const groups = pmGroups(prPillarHeads(set));
  const split = Object.fromEntries(Object.entries(PR.tower.groups || {}).map(([k, g]) => [k, !!g?.split]));
  const list = pmPillars(groups, prPillarHeights(), split).map((p) => ({ ...p, ...(PR.tower.pillars?.[p.key] || {}) }));
  return { list, groups };
}

/* One pillar by its key, with its place. */
const prPillar = (key) => prPillars().list.find((p) => p.key === key) || null;

/* Footprints the pillars keep clear of: the parts on the plate. */
const prPillarParts = () => PR.objects.filter((o) => bedState(o) !== "out").map(footprintPoly);

/* The groups' per-head pillars, for the layout's split fallback. */
function prPillarAlt(groups, heights) {
  return (p) => pmPillars(groups.filter((g) => g.key === p.group), heights, { [p.group]: true });
}

/* Places the whole row again (« Move to a free spot »), the groups split
   for room forgotten first; `save`: a change of its own. */
function prPillarsPlaceAll() {
  for (const g of Object.values(PR.tower.groups || {})) if (g.split === "auto") g.split = false;
  const set = prTowerHeads();
  const groups = pmGroups(prPillarHeads(set));
  const heights = prPillarHeights();
  const split = Object.fromEntries(Object.entries(PR.tower.groups || {}).map(([k, g]) => [k, !!g?.split]));
  const list = pmPillars(groups, heights, split);
  const l = pmLayout(list, PR.bed, prPillarParts(), { rot: PR.tower.row?.rot || 0, alt: prPillarAlt(groups, heights) });
  for (const k of l.split) PR.tower.groups[k] = { ...(PR.tower.groups[k] || {}), split: "auto" };
  PR.tower.pillars = Object.fromEntries(Object.entries(l.at).map(([k, c]) => [k, { x: c.x, y: c.y, moved: false }]));
  return l.free;
}

/* Pillars shown for the first time, or new ones (a new material, a group
   split): a free place, the others keeping theirs; gone ones forgotten. */
function prPillarsEnsurePlaced() {
  if (!prPillarsShown()) return;
  PR.tower.groups ||= {};
  PR.tower.pillars ||= {};
  const { list } = prPillars();
  const rc = pmReconcile(PR.tower.pillars, list.map((p) => p.key));
  const stale = Object.keys(PR.tower.pillars).some((k) => !(k in rc.kept));
  if (!rc.fresh.length && !stale) return;
  const kept = Object.values(rc.kept);
  // Nothing placed yet, or pillars replaced (a group split or joined) in a
  // row nobody moved: the row laid out again, side by side.
  if (!kept.length || (stale && rc.fresh.length && kept.every((c) => !c.moved))) {
    prPillarsPlaceAll();
  } else {
    // The newcomers together (a new material, a split group whose row was
    // moved), clear of the parts and of the pillars kept, which stay.
    const taken = prPillarParts();
    for (const p of list) if (rc.kept[p.key]) taken.push(pmSquare(rc.kept[p.key], p));
    const fresh = list.filter((q) => rc.fresh.includes(q.key));
    const l = pmLayout(fresh, PR.bed, taken, { rot: PR.tower.row?.rot || 0 });
    for (const p of fresh) rc.kept[p.key] = { ...l.at[p.key], moved: false };
    PR.tower.pillars = rc.kept;
  }
  prSave();
}

/* Its square on the plate, and its state there: "in", "partial" or
   "out", overlapping a part or not. */
function prPillarCheck(p) {
  if (!p || !Number.isFinite(p.x)) return null;
  const t = { x: p.x, y: p.y, rot: 0 }, box = pmBox(p);
  const poly = ptCorners(t, box);
  const hits = PR.objects.filter((o) => bedState(o) !== "out" && ptConvexOverlap(poly, footprintPoly(o)));
  return { poly, state: ptBedState(t, box, PR.bed), hits: hits.map((o) => o.id) };
}

/* Moves a pillar (it leaves the row: it is no longer turned with it). */
function prPillarMove(key, dx, dy) {
  const c = PR.tower.pillars?.[key];
  if (!c) return;
  c.x = Math.round((c.x + dx) * 100) / 100;
  c.y = Math.round((c.y + dy) * 100) / 100;
  c.moved = true;
}

/* The row's turn: the pillars still side by side turn around their
   middle; one moved out of the row has only a position. */
function prPillarRowTurn(rot) {
  rot = normDeg(rot);
  const delta = rot - (PR.tower.row?.rot || 0);
  PR.tower.row = { rot };
  const row = Object.fromEntries(Object.entries(PR.tower.pillars || {}).filter(([, c]) => !c.moved));
  for (const [k, c] of Object.entries(pmTurn(row, delta))) Object.assign(PR.tower.pillars[k], c);
}

/* The pillars a slice sends: centers and rings, outer first. */
function prPillarsRequest() {
  if (!prPillarsShown()) return [];
  return prPillars().list
    .filter((p) => Number.isFinite(p.x))
    .map((p) => ({ name: prPillarName(p), x: p.x, y: p.y, rings: p.rings, brim: PM.brim }));
}

/* Snap Studio's own tower data, saved beside the project's tower. */
const prPillarsFileData = () => ({ kind: PR.tower.kind || "single", row: PR.tower.row || { rot: 0 }, groups: PR.tower.groups || {}, pillars: PR.tower.pillars || {} });

/* "PLA (T0, T1) · PETG (T2)". */
function prPillarList(groups = pmGroups(prPillarHeads())) {
  return pmList(groups, prPillarFamily);
}

/* "Prime tower · PLA (T0, T1) 16 × 16 × 30 mm". */
function prPillarLabel(p) {
  const size = [p.d, p.d, p.h].map((v) => fmtDec(v, 0)).join(" × ");
  return tr("prepare.tower.pillar_size", { m: prPillarFamily(p), heads: p.heads.map((n) => "T" + n).join(", "), size });
}

/* The user's choice, from Prepare's control or the slice sheet's button. */
function prTowerSetKind(kind) {
  kind = kind === "material" ? "material" : "single";
  if (PR.tower.kind === kind) return;
  PR.tower.kind = kind;
  PR.towerSel = false;
  prTowerChanged(true);
}

/* A group's pillars split (one per head) or together, from the inspector. */
function prPillarSetSplit(group, on) {
  prRemember();
  PR.tower.groups ||= {};
  PR.tower.groups[group] = { ...(PR.tower.groups[group] || {}), split: !!on };
  // The new pillars take their places next to the others; the group's
  // first stays selected.
  prTowerEnsurePlaced();
  PR.towerSel = prPillars().list.find((p) => p.group === group)?.key || false;
  prTowerChanged(true);
}
