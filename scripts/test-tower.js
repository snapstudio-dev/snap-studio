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

// Estimate, against real Snapmaker Orca 2.4.0 slices (0.4 nozzle, 10 mm
// parts): a plain wall without brim is exactly the tower.
assert.strictEqual(T.ptEstimate({ heads: 1 }), null, "one head, no tower");
const rect = (heads, layer, width, volume) => T.ptEstimate({ heads, layer, width, volume, brim: 0, height: 10 });
for (const [heads, layer, width, volume, real] of [
  [2, 0.2, 40, 45, 9.5], [3, 0.2, 40, 45, 18.5], [4, 0.2, 40, 45, 27.5],
  [2, 0.2, 60, 45, 6.5], [4, 0.2, 60, 45, 18.5], [2, 0.2, 40, 90, 17.3], [4, 0.2, 40, 90, 50.9],
  [2, 0.12, 40, 45, 14.3], [4, 0.12, 40, 45, 41.9], [4, 0.12, 40, 90, 79.7],
]) {
  const e = rect(heads, layer, width, volume);
  assert.strictEqual(e.w, width, "plain wall: the width asked for");
  near(e.d, real, (heads - 1) * 0.65, `depth, ${heads} heads, ${layer} mm, ${width} mm wide, ${volume} mm³`);
  assert.deepStrictEqual([e.x0, e.y0, e.h], [0, 0, 10]);
}
// More heads, more volume, thinner layers, a narrower tower: deeper.
assert.ok(rect(3, 0.2, 40, 45).d > rect(2, 0.2, 40, 45).d);
assert.ok(rect(2, 0.2, 40, 90).d > rect(2, 0.2, 40, 45).d);
assert.ok(rect(2, 0.12, 40, 45).d > rect(2, 0.2, 40, 45).d);
assert.ok(rect(2, 0.2, 40, 45).d > rect(2, 0.2, 60, 45).d);
// Brim margin: all around, from the corner.
const brim = T.ptEstimate({ heads: 2, width: 40, brim: 5, height: 10 });
assert.deepStrictEqual([brim.x0, brim.y0, brim.w], [-5, -5, 50]);
near(brim.d, rect(2, 0.2, 40, 45).d + 10, 0.01, "brim on both sides");
// The U1's rib tower: square, ribs and brim beyond the corner; never
// smaller than the real one (38.3 × 38.4 from −9.7, two heads; 52.3 × 52.2
// with four), within 3 mm.
const u1 = (heads) => T.ptEstimate({ heads, width: 35, volume: 45, brim: 5, wall: "rib", height: 10 });
for (const [heads, w, d, x0] of [[2, 38.3, 38.4, -9.7], [3, 46.8, 45.0, -9.7], [4, 52.3, 52.2, -9.7]]) {
  const e = u1(heads);
  assert.ok(e.w >= w - 0.5 && e.w <= w + 3, `rib width, ${heads} heads: ${e.w} vs ${w}`);
  assert.ok(e.d >= d - 0.5 && e.d <= d + 3, `rib depth, ${heads} heads: ${e.d} vs ${d}`);
  assert.ok(e.x0 <= x0 + 0.5 && e.x0 >= x0 - 2, `rib margin: ${e.x0} vs ${x0}`);
}
// Less purge (Prepare's prime volume slider, down to 15 mm³): a smaller
// tower, the estimate still never smaller than the real one.
for (const [heads, volume, w, d, real] of [
  [2, 15, 30.6, 28.0, 4.1], [2, 20, 32.3, 31.4, 4.7], [2, 30, 35.7, 34.7, 6.5],
  [4, 15, 40.8, 37.8, 11.3], [4, 20, 43.3, 41.4, 13.1], [4, 30, 47.3, 45.0, 18.5],
]) {
  const rib = T.ptEstimate({ heads, volume, width: 35, brim: 5, wall: "rib", ribExtra: 8, ribWidth: 8, spacing: 1.2 });
  assert.ok(rib.w >= w - 0.5 && rib.w <= w + 3 && rib.d >= d - 0.5 && rib.d <= d + 3, `rib, ${heads} heads, ${volume} mm³: ${rib.w} × ${rib.d} vs ${w} × ${d}`);
  const plain = T.ptEstimate({ heads, volume, width: 40, brim: 0, spacing: 1.2 });
  assert.ok(plain.d >= real - 0.2 && plain.d <= real + 1.5, `plain, ${heads} heads, ${volume} mm³: ${plain.d} vs ${real}`);
}
assert.ok(u1(2).w > T.ptEstimate({ heads: 2, width: 35, volume: 15, brim: 5, wall: "rib", ribExtra: 8, ribWidth: 8, spacing: 1.2 }).w, "less purge, smaller");
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
