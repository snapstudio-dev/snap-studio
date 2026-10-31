// node scripts/test-tower.js — the prime tower in Prepare: when it shows,
// its estimated size, its placement.
const assert = require("assert");
const T = require("../ui/tower-logic.js");

const bed = { w: 270, d: 270 };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

// The option: off on a new plate, on only when the plate says so.
assert.strictEqual(T.ptOn(null), false, "a new project has no tower");
assert.strictEqual(T.ptOn({}), false);
assert.strictEqual(T.ptOn({ tower: { on: false } }), false);
assert.strictEqual(T.ptOn({ tower: { on: true } }), true);
assert.strictEqual(T.ptOn({ tower: { on: "1" } }), false, "only a real true");

// When it shows: on, two heads or more, layer by layer.
assert.deepStrictEqual(T.ptState({ heads: 2, on: true }), { show: true, reason: null });
assert.deepStrictEqual(T.ptState({ heads: 2, on: false }), { show: false, reason: null });
assert.deepStrictEqual(T.ptState({ heads: 1, on: true }), { show: false, reason: "single" });
assert.deepStrictEqual(T.ptState({ heads: 0, on: true }), { show: false, reason: "single" });
assert.deepStrictEqual(T.ptState({ heads: 3, on: true, sequence: "by object" }), { show: false, reason: "by_object" });
assert.deepStrictEqual(T.ptState({ heads: 1, on: false, sequence: "by object" }).reason, "single", "the first reason");

// Estimate, against real Snapmaker Orca 2.4.1 slices (slice.rs
// engine_tower_sizes: 0.4 nozzle, 0.20mm Standard, 10 mm cubes, one per
// head): never smaller than the real box, within about a line per tool
// change. A plain wall without brim is exactly the tower's width.
assert.strictEqual(T.ptEstimate({ heads: 1 }), null, "one head, no tower");
const fits = (e, real, changes, what) => {
  assert.ok(e >= real - 0.2, `${what}: ${e} smaller than the real ${real}`);
  assert.ok(e <= real + changes * 1.1 + 0.5, `${what}: ${e} too wide of the real ${real}`);
};
const rect = (heads, layer, width, volume, more = {}) => T.ptEstimate({ heads, layer, width, volume, brim: 0, height: 10, ...more });
// One category (two to four PLA heads, 15 mm³ least purge).
for (const [heads, layer, width, volume, real] of [
  [2, 0.2, 40, 45, 8.3], [3, 0.2, 40, 45, 16.1], [4, 0.2, 40, 45, 23.9], [2, 0.2, 60, 45, 5.9], [4, 0.2, 60, 45, 16.7],
  [2, 0.2, 40, 90, 16.1], [4, 0.2, 40, 90, 47.3], [2, 0.12, 40, 45, 13.1], [4, 0.12, 40, 45, 38.3], [4, 0.12, 40, 90, 76.1],
  [2, 0.2, 40, 15, 3.5], [4, 0.2, 40, 15, 9.5], [2, 0.2, 40, 30, 5.9], [4, 0.2, 40, 30, 16.7],
]) {
  const e = rect(heads, layer, width, volume, { purge: 15 });
  assert.strictEqual(e.w, width, "plain wall: the width asked for");
  fits(e.d, real, heads - 1, `depth, ${heads} heads, ${layer} mm, ${width} mm wide, ${volume} mm³`);
  assert.deepStrictEqual([e.x0, e.y0, e.h], [0, 0, 10]);
}
// Several categories (2.4.1's blocks): one more tool change's worth of
// depth, whatever their number; PETG's least purge (50 mm³) over 45.
for (const [mats, heads, categories, real] of [
  ["PLA+PETG", 2, 2, 17.3], ["PLA+PLA+PETG", 3, 2, 26.3], ["PLA+PETG+TPU", 3, 3, 27.5],
  ["PLA+PLA+PETG+PETG", 4, 2, 35.3], ["PLA+PETG+PETG+PETG", 4, 2, 37.7],
]) {
  fits(rect(heads, 0.2, 40, 45, { categories, purge: 50 }).d, real, heads, `depth, ${mats}`);
}
// More heads, more volume, thinner layers, a narrower tower, a second
// category, a larger least purge: deeper.
assert.ok(rect(3, 0.2, 40, 45).d > rect(2, 0.2, 40, 45).d);
assert.ok(rect(2, 0.2, 40, 90).d > rect(2, 0.2, 40, 45).d);
assert.ok(rect(2, 0.12, 40, 45).d > rect(2, 0.2, 40, 45).d);
assert.ok(rect(2, 0.2, 40, 45).d > rect(2, 0.2, 60, 45).d);
assert.ok(rect(2, 0.2, 40, 45, { categories: 2 }).d > rect(2, 0.2, 40, 45).d);
assert.strictEqual(rect(3, 0.2, 40, 45, { categories: 3 }).d, rect(3, 0.2, 40, 45, { categories: 2 }).d, "one more change, not one per category");
assert.ok(rect(2, 0.2, 40, 45, { purge: 50 }).d > rect(2, 0.2, 40, 45).d);
assert.strictEqual(rect(2, 0.2, 40, 45, { purge: 15 }).d, rect(2, 0.2, 40, 45).d, "a smaller least purge changes nothing");
// Brim margin: all around, from the corner.
const brim = T.ptEstimate({ heads: 2, width: 40, brim: 5, height: 10 });
assert.deepStrictEqual([brim.x0, brim.y0, brim.w], [-5, -5, 50]);
near(brim.d, rect(2, 0.2, 40, 45).d + 10, 0.01, "brim on both sides");
// The U1's rib tower: square; since 2.4.1 only the brim reaches out of the
// corner (2.4.0's box started 9.7 mm out); never smaller than the real
// one, within 5.5 mm.
const u1 = (heads, volume, more = {}) => T.ptEstimate({ heads, volume, width: 35, brim: 5, wall: "rib", ribExtra: 8, ribWidth: 8, spacing: 1.2, height: 10, ...more });
for (const [what, heads, volume, more, w, d] of [
  ["2 heads", 2, 45, {}, 37.84, 37.22], ["3 heads", 3, 45, {}, 45.34, 44.99], ["4 heads", 4, 45, {}, 50.8, 50.4],
  ["2 heads, 15 mm³", 2, 15, {}, 29.02, 28.05], ["4 heads, 15 mm³", 4, 15, {}, 37.8, 37.8], ["4 heads, 30 mm³", 4, 30, {}, 45.34, 44.99],
  ["PLA+PETG", 2, 45, { categories: 2, purge: 50 }, 45.84, 44.98], ["PLA+PETG+TPU", 3, 45, { categories: 3, purge: 50 }, 52.8, 52.2],
  ["PLA+PETG+PETG+PETG", 4, 45, { categories: 2, purge: 50 }, 58.34, 57.6],
]) {
  const e = u1(heads, volume, more);
  assert.ok(e.w >= w - 0.5 && e.w <= w + 5.5, `rib width, ${what}: ${e.w} vs ${w}`);
  assert.ok(e.d >= d - 0.5 && e.d <= d + 5.5, `rib depth, ${what}: ${e.d} vs ${d}`);
  assert.deepStrictEqual([e.x0, e.y0], [-5, -5], `rib box from the brim: ${what}`);
}
assert.ok(u1(2, 45).w > u1(2, 15).w, "less purge, smaller");
assert.strictEqual(T.ptEstimate({ heads: 2, height: 42.4 }).h, 42.4, "as tall as the tallest part");

// The sliced box replaces it as it is.
assert.deepStrictEqual(T.ptFromGcode({ x: 150, y: 200, x0: -9.67, y0: -9.67, w: 38.3, d: 38.4, h: 10.05 }), { x0: -9.67, y0: -9.67, w: 38.3, d: 38.4, h: 10.05 });
assert.strictEqual(T.ptFromGcode(null), null);
assert.strictEqual(T.ptFromGcode({ w: 0, d: 5 }), null);

// Corners: turned around the front-left corner, counter-clockwise.
const box = { x0: 0, y0: 0, w: 40, d: 10, h: 10 };
const round = (pts) => pts.map((p) => p.map((v) => Math.round(v * 1000) / 1000 + 0));
assert.deepStrictEqual(round(T.ptCorners({ x: 100, y: 50, rot: 0 }, box)), [[100, 50], [140, 50], [140, 60], [100, 60]]);
assert.deepStrictEqual(round(T.ptCorners({ x: 100, y: 50, rot: 90 }, box)), [[100, 50], [100, 90], [90, 90], [90, 50]], "90°: the width along +Y");
assert.deepStrictEqual(T.ptExtent({ x: 100, y: 50, rot: 90 }, box), { x0: 90, y0: 50, x1: 100, y1: 90 });

// Turning keeps the box's middle in place (the engine turns around the corner).
const mid = (t) => { const p = T.ptCorners(t, box); return [0, 1].map((k) => Math.round(((p[0][k] + p[2][k]) / 2) * 1000) / 1000 + 0); };
const turned = T.ptTurn({ x: 100, y: 50, rot: 0 }, box, 90);
assert.deepStrictEqual(mid(turned), mid({ x: 100, y: 50, rot: 0 }));
assert.strictEqual(turned.rot, 90);
assert.deepStrictEqual(mid(T.ptTurn(turned, box, -30)), [120, 55], "again from a turned one");
assert.deepStrictEqual(T.ptTurn({ x: 1, y: 2, rot: 45 }, box, 45), { x: 1, y: 2, rot: 45 }, "same angle, same place");

// On the plate, as an object.
assert.strictEqual(T.ptBedState({ x: 10, y: 10, rot: 0 }, box, bed), "in");
assert.strictEqual(T.ptBedState({ x: 240, y: 10, rot: 0 }, box, bed), "partial");
assert.strictEqual(T.ptBedState({ x: 300, y: 10, rot: 0 }, box, bed), "out");
assert.strictEqual(T.ptBedState({ x: 5, y: 10, rot: 90 }, box, bed), "partial", "turned past the left edge");

// Overlap with a part.
assert.ok(T.ptConvexOverlap(T.ptCorners({ x: 10, y: 10, rot: 0 }, box), sq(30, 5, 60, 30)));
assert.ok(!T.ptConvexOverlap(T.ptCorners({ x: 10, y: 10, rot: 0 }, box), sq(30, 21, 60, 40)));
assert.ok(!T.ptConvexOverlap(sq(0, 0, 10, 10), sq(10, 0, 20, 10)), "a clean contact does not count");

// Placement: an empty plate puts it back-left, 2 mm from the edges.
let s = T.ptSpot(box, bed, []);
assert.deepStrictEqual(s, { x: 2, y: 258, rot: 0, free: true });
// A free corner found: back-left taken, back-right next.
s = T.ptSpot(box, bed, [sq(0, 200, 100, 270)]);
assert.deepStrictEqual([s.x, s.y, s.free], [228, 258, true]);
// Back corners taken: front-left.
s = T.ptSpot(box, bed, [sq(0, 200, 270, 270)]);
assert.deepStrictEqual([s.x, s.y, s.free], [2, 2, true]);
// Every corner taken: the first free place, from the back-left, row by row.
const corners = [sq(0, 220, 60, 270), sq(210, 220, 270, 270), sq(0, 0, 60, 50), sq(210, 0, 270, 50)];
s = T.ptSpot(box, bed, corners);
assert.ok(s.free, "a spot between the corners");
assert.ok(!corners.some((p) => T.ptConvexOverlap(T.ptCorners(s, box), p, 0)), "clear of the parts");
assert.deepStrictEqual([s.x, s.y], [67, 258], "along the back first");
// Nowhere: the engine's default, said not free.
s = T.ptSpot(box, bed, [sq(0, 0, 270, 270)]);
assert.deepStrictEqual(s, { x: 15, y: 220, rot: 0, free: false });
// Rotation 90°: the corner moves so the turned box sits in the corner.
s = T.ptSpot(box, bed, [], 90);
assert.deepStrictEqual(s, { x: 12, y: 228, rot: 90, free: true });
const ext = T.ptExtent(s, box);
assert.deepStrictEqual(Object.values(ext).map((v) => Math.round(v * 1000) / 1000), [2, 228, 12, 268]);
// Brim margin: the box (brim included) stays on the plate, the tower's
// corner further in.
s = T.ptSpot(brim, bed, []);
assert.strictEqual(s.x, 7);
near(s.y, 268 - brim.d + 5, 0.05, "the corner 5 mm inside the box");
assert.strictEqual(T.ptBedState(s, brim, bed), "in");
// A gap around the parts: a part 1 mm beside the corner spot pushes it on.
s = T.ptSpot(box, bed, [sq(43, 250, 80, 270)]);
assert.notDeepStrictEqual([s.x, s.y], [2, 258], "too close to the part");
// A tower larger than the plate: nowhere.
assert.strictEqual(T.ptSpot({ x0: 0, y0: 0, w: 300, d: 10 }, bed, []).free, false);

// The real size's key: changes with the parts or the settings, not places.
const k = T.ptSizeKey([["a.3mf#0", [0, 0, 0], [1, 1, 1]]], { heads: 2, width: 35 });
assert.strictEqual(k, T.ptSizeKey([["a.3mf#0", [0, 0, 0], [1, 1, 1]]], { heads: 2, width: 35 }));
assert.notStrictEqual(k, T.ptSizeKey([["a.3mf#0", [0, 0, 0], [1, 1, 1]]], { heads: 3, width: 35 }));

// A plate printed with a virtual head alone (V1 = T0 + T2) uses two heads:
// the tower shows.
{
  const V = require("../ui/virtual-logic.js");
  const heads = V.vhPhysical(new Set([101]), [{ uid: 1, a: 0, b: 2, pct: 33 }]);
  assert.deepStrictEqual(T.ptState({ heads: heads.size, on: true }), { show: true, reason: null });
  assert.strictEqual(T.ptState({ heads: V.vhPhysical(new Set([103]), []).size, on: true }).reason, "single", "an orphan prints nothing");
}

// The plate's tower as stored (prepare-tower.js prTowerStored /
// prTowerRestore, run as written): an old plate comes back with a single
// tower and no pillars; one tower per material keeps its choice and places.
{
  const fs = require("fs"), vm = require("vm");
  const src = fs.readFileSync(require("path").join(__dirname, "../ui/prepare-tower.js"), "utf8");
  const body = src.slice(src.indexOf("const prTowerStored"), src.indexOf("// The plate read at start"));
  const ctx = { PR: {}, ptOn: T.ptOn };
  vm.runInNewContext(body + ";this.stored = prTowerStored; this.restore = prTowerRestore;", ctx);
  // Plain objects out of the context (its own prototypes).
  const plain = (v) => JSON.parse(JSON.stringify(v));
  ctx.restore({ on: true, x: 15, y: 220, rot: 90, real: null });
  assert.deepStrictEqual(plain(ctx.stored(ctx.PR.tower)), { on: true, x: 15, y: 220, rot: 90, real: null, kind: "single", row: { rot: 0 }, groups: {}, pillars: {} }, "an old plate");
  ctx.restore(null);
  assert.strictEqual(ctx.PR.tower.on, false);
  assert.strictEqual(ctx.PR.tower.kind, "single");
  const t = { on: true, x: null, y: null, rot: 0, real: null, kind: "material", row: { rot: 90 }, groups: { PLA: { split: true } }, pillars: { "PLA/T0": { x: 20, y: 30, moved: true } } };
  ctx.restore(JSON.parse(JSON.stringify(t)));
  assert.deepStrictEqual(plain(ctx.stored(ctx.PR.tower)), t, "kept as it was");
  ctx.restore({ on: true, kind: "rings", groups: "x", pillars: null, row: 3 });
  assert.deepStrictEqual(plain([ctx.PR.tower.kind, ctx.PR.tower.groups, ctx.PR.tower.pillars, ctx.PR.tower.row]), ["single", {}, {}, { rot: 0 }], "a corrupt one");
}

console.log("tower: ok");
