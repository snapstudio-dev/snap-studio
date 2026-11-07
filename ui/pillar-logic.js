"use strict";
/* One prime tower per material: pure rules (no DOM, no WebGL), tested by
   scripts/test-pillars.js. The plan: docs/plans/prime-tower-per-material.md.

   The engine prints one prime tower per plate; on a plate whose materials
   do not bond, that tower stacks them and comes off. Instead, Snap Studio
   can generate small pillars, printed as ordinary objects (walls only),
   one per group of materials that bond: a group printed by several heads
   gets one pillar of concentric rings, one ring per head. Always the
   user's choice, offered only when two of the plate's materials do not
   bond; the engine's single tower stays the default. */

const PM_NODE = typeof module !== "undefined" && typeof require === "function";
const PM_SP = PM_NODE ? require("./spoolcheck.js") : null;
const PM_PT = PM_NODE ? require("./tower-logic.js") : null;
const pmBonds = (a, b) => (PM_SP ? PM_SP.spBonds : spBonds)(a, b);
const pmFamily = (m) => (PM_SP ? PM_SP.spMaterialFamily : spMaterialFamily)(m);
const pmSpot = (...a) => (PM_PT ? PM_PT.ptSpot : ptSpot)(...a);

/* Sizes, from the feasibility test (walls only, 2 perimeters on each side
   of a tube): each ring 2 mm thick, the innermost one's hole 8 mm (rings
   of 12, 16, 20, 24 mm for one to four heads); a one-head tube 15 mm. A
   pillar is at least an eighth of its height wide, and gets a 3 mm brim. */
const PM = { ring: 2, core: 8, tube: 15, slender: 8, brim: 3, gap: 3 };

/* The plate's heads in groups of materials that bond. `heads`: [{ n,
   material }] (the profile's type, else its name). Two heads share a group
   when `spBonds` says true; a group is a clique (a head joins one only if
   it bonds with every head in it). A head whose material is unknown, or a
   pair whose bonding is unknown (null), gets its own pillar: a little more
   room, never a tower that may come off. Groups by their lowest head:
   [{ key, family, heads: [n] }], `key` the families ("PLA", "PETG+PCTG"),
   or "T3" for an unknown material. */
function pmGroups(heads) {
  const groups = [];
  const list = [...(heads || [])].filter((h) => Number.isInteger(h?.n)).sort((a, b) => a.n - b.n);
  const seen = new Set();
  for (const h of list) {
    if (seen.has(h.n)) continue;
    seen.add(h.n);
    const fam = pmFamily(h.material);
    const g = fam && groups.find((g) => g.members.every((m) => m.fam && pmBonds(m.material, h.material) === true));
    if (g) g.members.push({ ...h, fam });
    else groups.push({ members: [{ ...h, fam }] });
  }
  return groups.map((g) => {
    const fams = [...new Set(g.members.map((m) => m.fam).filter(Boolean))];
    return {
      key: fams.length ? fams.join("+") : `T${g.members[0].n}`,
      family: fams.length ? fams.join(" / ") : null,
      heads: g.members.map((m) => m.n),
    };
  });
}

/* The choice is offered: two of the plate's materials do not bond
   (`spBonds` false; unknown pairs do not count). */
function pmOffered(heads) {
  const known = (heads || []).filter((h) => pmFamily(h.material));
  for (let i = 0; i < known.length; i++)
    for (let j = i + 1; j < known.length; j++) if (pmBonds(known[i].material, known[j].material) === false) return true;
  return false;
}

/* The tower printed: null (none: off, one head, by object), "single" (the
   engine's) or "material" (the pillars). `state`: ptState's; `kind`: the
   user's choice, kept on the plate. The pillars only while the choice is
   offered: back to the single tower when the materials all bond again,
   the choice kept for when they do not. */
function pmKind({ state, offered, kind }) {
  if (!state?.show) return null;
  return offered && kind === "material" ? "material" : "single";
}

/* A height on the engine's layers, rounded up: `first` the first layer's
   height, `layer` the others'. */
function pmLayerUp(h, layer = 0.2, first = layer) {
  if (!(h > 0)) return 0;
  if (h <= first + 1e-6) return Math.round(first * 1000) / 1000;
  const n = Math.ceil((h - first) / layer - 1e-6);
  return Math.round((first + n * layer) * 1000) / 1000;
}

/* The rings of a pillar for `heads` [{ n, h }] (h: the head's last layer,
   on the layer grid): the tallest outside, each ring 2 mm thick, the
   pillar at least h / 8 wide (the hole grows). [{ head, d_out, d_in, h }],
   outer first. A single head: a 15 mm tube. */
function pmRings(heads) {
  const list = [...heads].sort((a, b) => b.h - a.h || a.n - b.n);
  const k = list.length;
  if (!k) return [];
  const tall = Math.max(...list.map((x) => x.h));
  const base = k === 1 ? PM.tube : PM.core + 2 * PM.ring * k;
  const outer = Math.max(base, tall / PM.slender);
  const r = (v) => Math.round(v * 100) / 100;
  return list.map((x, i) => {
    const d_out = outer - 2 * PM.ring * i;
    return { head: x.n, d_out: r(d_out), d_in: r(d_out - 2 * PM.ring), h: x.h };
  });
}

/* The pillars for the groups: `heights` { head: last layer }, `split`
   { groupKey: true } (one pillar per head, chosen or forced for room). A
   group's heads that print nothing are left out. [{ key, group, family,
   heads, rings, d, h, w }]: `w` the square it takes with its brim. A split
   group's pillars are keyed "<group>/T<n>". */
function pmPillars(groups, heights, split = {}) {
  const out = [];
  const make = (key, g, heads) => {
    const rings = pmRings(heads.map((n) => ({ n, h: heights[n] })));
    const d = rings[0].d_out, h = rings[0].h;
    out.push({ key, group: g.key, family: g.family, heads: rings.map((r) => r.head), rings, d, h, w: Math.round((d + 2 * PM.brim) * 100) / 100 });
  };
  for (const g of groups) {
    const heads = g.heads.filter((n) => heights[n] > 0);
    if (!heads.length) continue;
    if (split[g.key] && heads.length > 1) for (const n of heads) make(`${g.key}/T${n}`, g, [n]);
    else make(g.key, g, heads);
  }
  return out;
}

/* A pillar's square, around its center, as tower-logic.js boxes. */
const pmBox = (p) => ({ x0: -p.w / 2, y0: -p.w / 2, w: p.w, d: p.w, h: p.h });

/* Places pillars (`list`, from pmPillars) in a free spot: one row, `gap`
   mm apart, turned `rot` degrees, as #36's tower (ptSpot: the corners
   first, then the first free place); no room for the row, each pillar on
   its own; still none for a ring pillar, split into one pillar per head
   (`alt(p)`: its per-head pillars) — the caller then shows those; still
   none, the engine's default place, `free` false. `parts`: the footprints
   to keep clear of (convex polygons). { at: { key: { x, y } }, split:
   [group keys split for room], free, row: bool }. */
function pmLayout(list, bed, parts, { rot = 0, gap = PM.gap, alt = null } = {}) {
  const at = {};
  if (!list.length) return { at, split: [], free: true, row: true };
  const W = list.reduce((s, p) => s + p.w, 0) + gap * (list.length - 1);
  const D = Math.max(...list.map((p) => p.w));
  const spot = pmSpot({ x0: 0, y0: 0, w: W, d: D, h: 0 }, bed, parts, rot);
  if (spot.free || list.length === 1) {
    Object.assign(at, pmRowAt(list, spot, rot, gap));
    if (spot.free) return { at, split: [], free: true, row: true };
  }
  // Each on its own, the biggest first; the ones placed count as parts.
  const taken = [...parts];
  const split = [];
  let free = true;
  const place = (p) => {
    const s = pmSpot(pmBox(p), bed, taken, 0);
    if (!s.free) return null;
    taken.push(pmSquare(s, p));
    return s;
  };
  for (const p of [...list].sort((a, b) => b.w - a.w)) {
    let s = place(p);
    if (s) {
      at[p.key] = { x: s.x, y: s.y };
      continue;
    }
    const each = p.heads.length > 1 && alt ? alt(p) : null;
    if (each?.length) {
      const got = each.map((q) => [q, place(q)]);
      if (got.every(([, s]) => s)) {
        split.push(p.group);
        for (const [q, s] of got) at[q.key] = { x: s.x, y: s.y };
        continue;
      }
    }
    // No room: the engine's default corner, the overlap shown.
    free = false;
    at[p.key] = { x: Math.round((spot.x + p.w / 2) * 10) / 10, y: Math.round((spot.y + p.w / 2) * 10) / 10 };
  }
  return { at, split, free, row: false };
}

/* The centers of a row whose frame's corner is `t` ({ x, y }), turned
   `rot` degrees around it. */
function pmRowAt(list, t, rot = 0, gap = PM.gap) {
  const D = Math.max(...list.map((p) => p.w));
  const a = (rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const at = {};
  let off = 0;
  for (const p of list) {
    const lx = off + p.w / 2, ly = D / 2;
    at[p.key] = { x: Math.round((t.x + lx * c - ly * s) * 100) / 100, y: Math.round((t.y + lx * s + ly * c) * 100) / 100 };
    off += p.w + gap;
  }
  return at;
}

/* A pillar's square on the plate (convex polygon). */
const pmSquare = (c, p) => [[c.x - p.w / 2, c.y - p.w / 2], [c.x + p.w / 2, c.y - p.w / 2], [c.x + p.w / 2, c.y + p.w / 2], [c.x - p.w / 2, c.y + p.w / 2]];

/* Points turned by `deg` degrees around their middle: the row turned. */
function pmTurn(points, deg) {
  const keys = Object.keys(points);
  if (!keys.length) return {};
  const mx = keys.reduce((s, k) => s + points[k].x, 0) / keys.length;
  const my = keys.reduce((s, k) => s + points[k].y, 0) / keys.length;
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const out = {};
  for (const k of keys) {
    const x = points[k].x - mx, y = points[k].y - my;
    out[k] = { x: Math.round((mx + x * c - y * s) * 100) / 100, y: Math.round((my + x * s + y * c) * 100) / 100 };
  }
  return out;
}

/* The places kept for the pillars wanted now (`keys`): a known one keeps
   its place, a new one needs one (`fresh`), a gone one is forgotten. */
function pmReconcile(places, keys) {
  const kept = {};
  const fresh = [];
  for (const k of keys) {
    if (places?.[k] && Number.isFinite(places[k].x) && Number.isFinite(places[k].y)) kept[k] = { ...places[k] };
    else fresh.push(k);
  }
  return { kept, fresh };
}

/* What a slice sends with the pillars: no engine tower, objects printed in
   the list's order (the pillars are first: each head primes on its ring
   before the model), and no support layer of its own between two object
   layers (it would change heads where no pillar layer is). They win over
   the sheet's differences. */
const pmOverrides = () => ({ enable_prime_tower: "0", print_order: "as_obj_list", independent_support_layer_height: "0" });

/* "PLA (T0, T1) · PETG (T2)": the groups, `name(g)` their label. */
const pmList = (groups, name = (g) => g.family || g.key) => groups.map((g) => `${name(g)} (${g.heads.map((n) => "T" + n).join(", ")})`).join(" · ");

if (typeof module !== "undefined") {
  module.exports = { PM, pmGroups, pmOffered, pmKind, pmLayerUp, pmRings, pmPillars, pmBox, pmLayout, pmRowAt, pmSquare, pmTurn, pmReconcile, pmOverrides, pmList };
}
