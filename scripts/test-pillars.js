// node scripts/test-pillars.js — one prime tower per material: groups,
// when it is offered, heights, sizes, placement, what the engine gets.
const assert = require("assert");
const P = require("../ui/pillar-logic.js");
const T = require("../ui/tower-logic.js");

const h = (n, material) => ({ n, material });
const keys = (gs) => gs.map((g) => `${g.key}:${g.heads.join(",")}`);

// ------------------------------------------------------------ groups

assert.deepStrictEqual(keys(P.pmGroups([h(0, "PLA"), h(1, "PLA"), h(2, "PETG")])), ["PLA:0,1", "PETG:2"]);
assert.deepStrictEqual(keys(P.pmGroups([h(2, "PETG"), h(0, "PLA"), h(1, "PLA")])), ["PLA:0,1", "PETG:2"], "by their lowest head");
assert.deepStrictEqual(keys(P.pmGroups([h(0, "ABS"), h(1, "ASA")])), ["ABS+ASA:0,1"], "ABS bonds with ASA");
assert.deepStrictEqual(keys(P.pmGroups([h(0, "PETG"), h(1, "PCTG"), h(2, "PET")])), ["PETG+PCTG+PET:0,1,2"]);
assert.deepStrictEqual(keys(P.pmGroups([h(0, "PLA"), h(1, "PLA-CF"), h(3, "PLA Silk")])), ["PLA:0,1,3"], "one family");
// A pair whose bonding is not known: separate pillars.
assert.strictEqual(require("../ui/spoolcheck.js").spBonds("PLA", "PC"), null);
assert.deepStrictEqual(keys(P.pmGroups([h(0, "PLA"), h(1, "PC")])), ["PLA:0", "PC:1"]);
// Cliques: PLA bonds with PVA, PETG does not with PLA; PVA joins PLA.
assert.deepStrictEqual(keys(P.pmGroups([h(0, "PLA"), h(1, "PETG"), h(2, "PVA")])), ["PLA+PVA:0,2", "PETG:1"]);
// A head with no known material: alone, keyed by its head.
assert.deepStrictEqual(keys(P.pmGroups([h(0, "PLA"), h(1, ""), h(2, "?")])), ["PLA:0", "T1:1", "T2:2"]);
assert.strictEqual(P.pmGroups([h(1, "")])[0].family, null);
// Duplicates and junk are ignored.
assert.deepStrictEqual(keys(P.pmGroups([h(0, "PLA"), h(0, "PLA"), { n: null }, null])), ["PLA:0"]);
assert.deepStrictEqual(P.pmGroups([]), []);
assert.strictEqual(P.pmList(P.pmGroups([h(0, "PLA"), h(1, "PLA"), h(2, "PETG")])), "PLA (T0, T1) · PETG (T2)");

// ------------------------------------------------------------ when it is offered

assert.strictEqual(P.pmOffered([h(0, "PLA"), h(1, "PETG")]), true);
assert.strictEqual(P.pmOffered([h(0, "PLA"), h(1, "PLA")]), false, "materials that bond");
assert.strictEqual(P.pmOffered([h(0, "PLA"), h(1, "PC")]), false, "unknown pairs: not offered");
assert.strictEqual(P.pmOffered([h(0, "PLA"), h(1, "")]), false);
assert.strictEqual(P.pmOffered([h(0, "PLA")]), false);
const on = T.ptState({ heads: 2, on: true });
// Single by default, also when the materials do not bond.
assert.strictEqual(P.pmKind({ state: on, offered: true, kind: undefined }), "single");
assert.strictEqual(P.pmKind({ state: on, offered: true, kind: "single" }), "single");
assert.strictEqual(P.pmKind({ state: on, offered: true, kind: "material" }), "material");
// The choice kept, the single tower while the materials all bond.
assert.strictEqual(P.pmKind({ state: on, offered: false, kind: "material" }), "single");
// No tower at all: off, one head, by object.
assert.strictEqual(P.pmKind({ state: T.ptState({ heads: 2, on: false }), offered: true, kind: "material" }), null);
assert.strictEqual(P.pmKind({ state: T.ptState({ heads: 1, on: true }), offered: true, kind: "material" }), null);
assert.strictEqual(P.pmKind({ state: T.ptState({ heads: 3, on: true, sequence: "by object" }), offered: true, kind: "material" }), null);

// ------------------------------------------------------------ heights

// Rounded up to the engine's layers (U1: 0.25 mm first, then 0.2 mm).
assert.strictEqual(P.pmLayerUp(30, 0.2, 0.25), 30.05, "as the test's 30 mm cube: 30.05");
assert.strictEqual(P.pmLayerUp(20, 0.2, 0.25), 20.05);
assert.strictEqual(P.pmLayerUp(30.05, 0.2, 0.25), 30.05, "already on a layer");
assert.strictEqual(P.pmLayerUp(30.06, 0.2, 0.25), 30.25);
assert.strictEqual(P.pmLayerUp(0.1, 0.2, 0.25), 0.25, "the first layer");
assert.strictEqual(P.pmLayerUp(10, 0.12), 10.08);
assert.strictEqual(P.pmLayerUp(0), 0);

// ------------------------------------------------------------ sizes

// One head: a 15 mm tube, 2 mm thick.
assert.deepStrictEqual(P.pmRings([{ n: 2, h: 20 }]), [{ head: 2, d_out: 15, d_in: 11, h: 20 }]);
// Two heads: 16 mm, the tallest outside, the rings touching.
let r = P.pmRings([{ n: 0, h: 10 }, { n: 1, h: 30 }]);
assert.deepStrictEqual(r, [{ head: 1, d_out: 16, d_in: 12, h: 30 }, { head: 0, d_out: 12, d_in: 8, h: 10 }]);
// Four heads: 24 mm; equal heights by head.
r = P.pmRings([3, 1, 2, 0].map((n) => ({ n, h: 20 })));
assert.deepStrictEqual(r.map((x) => [x.head, x.d_out, x.d_in]), [[0, 24, 20], [1, 20, 16], [2, 16, 12], [3, 12, 8]]);
for (let i = 1; i < r.length; i++) assert.strictEqual(r[i].d_out, r[i - 1].d_in, "no gap: they bond");
// Tall: at least h / 8 wide, the hole grows.
r = P.pmRings([{ n: 0, h: 160 }, { n: 1, h: 160 }]);
assert.strictEqual(r[0].d_out, 20);
assert.strictEqual(r[1].d_in, 12);
assert.strictEqual(P.pmRings([{ n: 0, h: 200 }])[0].d_out, 25);

const heights = { 0: 30.05, 1: 30.05, 2: 20.05 };
const groups = P.pmGroups([h(0, "PLA"), h(1, "PLA"), h(2, "PETG")]);
let ps = P.pmPillars(groups, heights);
assert.deepStrictEqual(ps.map((p) => [p.key, p.heads, p.d, p.h, p.w]), [["PLA", [0, 1], 16, 30.05, 22], ["PETG", [2], 15, 20.05, 21]]);
assert.deepStrictEqual(P.pmBox(ps[0]), { x0: -11, y0: -11, w: 22, d: 22, h: 30.05 });
// Split: one pillar per head, keyed by group and head.
ps = P.pmPillars(groups, heights, { PLA: true });
assert.deepStrictEqual(ps.map((p) => [p.key, p.group, p.heads, p.d]), [["PLA/T0", "PLA", [0], 15], ["PLA/T1", "PLA", [1], 15], ["PETG", "PETG", [2], 15]]);
// A head that prints nothing has no ring.
ps = P.pmPillars(groups, { 0: 10, 2: 5 });
assert.deepStrictEqual(ps.map((p) => [p.key, p.heads]), [["PLA", [0]], ["PETG", [2]]]);

// ------------------------------------------------------------ placement

const bed = { w: 270, d: 270 };
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
ps = P.pmPillars(groups, heights);
// An empty corner: the row at the back-left, side by side, 3 mm apart.
let l = P.pmLayout(ps, bed, []);
assert.ok(l.free && l.row);
assert.deepStrictEqual(l.at, { PLA: { x: 13, y: 257 }, PETG: { x: 37.5, y: 257 } });
assert.strictEqual(l.at.PETG.x - l.at.PLA.x, 11 + 3 + 10.5, "touching squares plus the gap");
// Turned 90°: the row goes along the left edge.
l = P.pmLayout(ps, bed, [], { rot: 90 });
assert.ok(l.free);
assert.strictEqual(l.at.PLA.x, l.at.PETG.x, "one column");
// The back-left corner taken: the next corner.
l = P.pmLayout(ps, bed, [sq(0, 200, 80, 270)]);
assert.ok(l.free && l.at.PLA.x > 200, JSON.stringify(l.at));
// No room for the row (a plate full but for two small gaps): each on its own.
const full = (holes) => {
  const parts = [];
  for (let y = 0; y < 270; y += 30) for (let x = 0; x < 270; x += 30) if (!holes.some(([hx, hy]) => hx === x && hy === y)) parts.push(sq(x + 1, y + 1, x + 29, y + 29));
  return parts;
};
let parts = full([[0, 240], [120, 120]]);
l = P.pmLayout(ps, bed, parts.map((p) => p.map(([x, y]) => [x, y])), {});
assert.ok(l.free && !l.row, JSON.stringify(l));
for (const p of ps) assert.ok(!parts.some((q) => T.ptConvexOverlap(P.pmSquare(l.at[p.key], p), q, 0)), p.key + " clear of the parts");
// No room for the ring pillar either: split into one pillar per head. The
// plate full but for three 27 mm holes: a 30 mm ring pillar fits none, its
// two 21 mm tubes and the PETG one fit one each.
const alt = (p) => P.pmPillars(groups.filter((g) => g.key === p.group), heights, { [p.group]: true });
const narrow = { w: 270, d: 270 };
parts = [];
for (let y = 0; y < 270; y += 27) for (let x = 0; x < 270; x += 27) if (!([[0, 243], [54, 243], [108, 243]].some(([hx, hy]) => hx === x && hy === y))) parts.push(sq(x, y, x + 27, y + 27));
const tight = P.pmPillars(groups, heights).map((p) => ({ ...p, w: p.key === "PLA" ? 30 : p.w }));
const altTight = (p) => alt(p).map((q) => ({ ...q, w: 21 }));
l = P.pmLayout(tight, narrow, parts, { alt: altTight, gap: 3 });
assert.deepStrictEqual(l.split, ["PLA"], JSON.stringify(l));
assert.ok(l.at["PLA/T0"] && l.at["PLA/T1"] && l.at.PETG && !l.at.PLA);
// No spot at all: the engine's default place, not free.
l = P.pmLayout(ps, bed, [sq(0, 0, 270, 270)]);
assert.strictEqual(l.free, false);
assert.ok(l.at.PLA && l.at.PETG);
assert.deepStrictEqual(P.pmLayout([], bed, []), { at: {}, split: [], free: true, row: true });

// The row turned around its middle.
const t = P.pmTurn({ a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }, 90);
assert.deepStrictEqual(t, { a: { x: 5, y: -5 }, b: { x: 5, y: 5 } });
assert.deepStrictEqual(P.pmTurn({}, 90), {});

// Group keys appearing and disappearing keep the others' places.
const rc = P.pmReconcile({ PLA: { x: 10, y: 20, moved: true }, ABS: { x: 1, y: 2 } }, ["PLA", "PETG"]);
assert.deepStrictEqual(rc, { kept: { PLA: { x: 10, y: 20, moved: true } }, fresh: ["PETG"] });
assert.deepStrictEqual(P.pmReconcile(null, ["PLA"]).fresh, ["PLA"]);
assert.deepStrictEqual(P.pmReconcile({ PLA: { x: null, y: 3 } }, ["PLA"]).fresh, ["PLA"], "a place not known");

// ------------------------------------------------------------ overrides

const o = P.pmOverrides();
assert.deepStrictEqual(o, { enable_prime_tower: "0", print_order: "as_obj_list", independent_support_layer_height: "0" });
assert.ok(!("wipe_tower_x" in o));

console.log("pillars: ok");
