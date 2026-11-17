// node scripts/test-sequence.js — printing by object in Prepare: the room
// the head needs between objects, the heights it can pass over, the print
// order, and the plates that cannot print by object. The figures are
// Snapmaker Orca 2.4.0's (Print.cpp, sequential_print_clearance_valid) with
// the U1's profile.
const assert = require("assert");
const S = require("../ui/sequence-logic.js");

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const obj = (id, x0, y0, x1, y1, height) => ({ id, foot: sq(x0, y0, x1, y1), height });

// Clearances: the profile's, the U1's when it gives none or nonsense.
assert.deepStrictEqual(S.sqClearance(), { radius: 72.5, rod: 27.5, lid: 140, nozzle: 2.5, height: 270.05 });
const prof = { extruder_clearance_radius: "60", extruder_clearance_height_to_rod: ["20"], nozzle_height: "x", printable_height: -1 };
const c = S.sqClearance((k) => prof[k]);
assert.strictEqual(c.radius, 60, "a string from the profile");
assert.strictEqual(c.rod, 20, "a per-extruder list: the first");
assert.strictEqual(c.nozzle, 2.5, "not a number: the U1's");
assert.strictEqual(c.height, 270.05, "negative: the U1's");
assert.strictEqual(c.lid, 140, "missing: the U1's");

// The gap: the radius less 0.2 mm (each side grown by r/2 - 0.1), or
// 3.8 mm when every object is lower than the nozzle.
near(S.sqGap([{ height: 10 }], S.SQ_U1), 72.3, 1e-9, "the U1's gap");
near(S.sqGap([{ height: 1 }, { height: 2 }], S.SQ_U1), 3.8, 1e-9, "flat objects");
near(S.sqGap([{ height: 1 }, { height: 3 }], S.SQ_U1), 72.3, 1e-9, "one taller than the nozzle");

// Distances between footprints.
assert.strictEqual(S.sqDist(sq(0, 0, 10, 10), sq(5, 5, 15, 15)), 0, "overlapping");
assert.strictEqual(S.sqDist(sq(0, 0, 10, 10), sq(2, 2, 4, 4)), 0, "one inside the other");
near(S.sqDist(sq(0, 0, 10, 10), sq(20, 0, 30, 10)), 10, 1e-9, "side by side");
near(S.sqDist(sq(0, 0, 10, 10), sq(13, 14, 20, 20)), 5, 1e-9, "corner to corner");
near(S.sqDist([[0, 0]], sq(3, -1, 5, 1)), 3, 1e-9, "a point");
assert.strictEqual(S.sqDist([], sq(0, 0, 1, 1)), Infinity, "nothing");

// Side by side: closer than the gap is a conflict, the gap is not.
let r = S.sqCheck([obj("a", 0, 0, 20, 20, 10), obj("b", 92, 0, 112, 20, 10)]);
assert.deepStrictEqual(r.close, [["a", "b"]], "72 mm apart is too close");
r = S.sqCheck([obj("a", 0, 0, 20, 20, 10), obj("b", 92.5, 0, 112.5, 20, 10)]);
assert.deepStrictEqual(r.close, [], "72.5 mm apart is enough");
r = S.sqCheck([obj("a", 0, 0, 20, 20, 2), obj("b", 24, 0, 44, 20, 2)]);
assert.deepStrictEqual(r.close, [], "flat objects only need a few millimetres");
r = S.sqCheck([obj("a", 0, 0, 20, 20, 2), obj("b", 23, 0, 43, 20, 2)]);
assert.deepStrictEqual(r.close, [["a", "b"]], "but not less");
r = S.sqCheck([obj("a", 0, 0, 20, 20, 10), obj("b", 30, 0, 40, 20, 10), obj("c", 200, 200, 220, 220, 10)]);
assert.deepStrictEqual(r.close, [["a", "b"]], "only the pair that is too close");
assert.deepStrictEqual(r.order, { a: 1, b: 2, c: 3 }, "numbered in print order");

// In height: the last one may be as tall as the printer.
r = S.sqCheck([obj("a", 0, 0, 20, 20, 200)]);
assert.deepStrictEqual(r.tall, [], "alone: the whole height");
r = S.sqCheck([obj("a", 0, 0, 20, 20, 280)]);
assert.deepStrictEqual(r.tall, [{ id: "a", limit: 270.05, why: "height" }], "taller than the printer");
// A later object in its row: the rod.
r = S.sqCheck([obj("a", 0, 0, 20, 20, 30), obj("b", 150, 0, 170, 20, 30)]);
assert.deepStrictEqual(r.tall, [{ id: "a", limit: 27.5, why: "rod" }], "first one under the rod");
r = S.sqCheck([obj("a", 0, 0, 20, 20, 27), obj("b", 150, 0, 170, 20, 100)]);
assert.deepStrictEqual(r.tall, [], "the tall one last");
// Not in its row (the later one's footprint, grown by 36.15 mm, misses
// it in Y): the lid.
r = S.sqCheck([obj("a", 0, 0, 20, 20, 100), obj("b", 150, 57, 170, 77, 30)]);
assert.deepStrictEqual(r.tall, [], "another row: up to the lid");
r = S.sqCheck([obj("a", 0, 0, 20, 20, 100), obj("b", 150, 56, 170, 76, 30)]);
assert.deepStrictEqual(r.tall, [{ id: "a", limit: 27.5, why: "rod" }], "the grown footprint reaches its row");
r = S.sqCheck([obj("a", 0, 0, 20, 20, 150), obj("b", 150, 100, 170, 120, 30)]);
assert.deepStrictEqual(r.tall, [{ id: "a", limit: 140, why: "lid" }], "taller than the lid");
// Only later objects count.
r = S.sqCheck([obj("b", 150, 100, 170, 120, 30), obj("a", 0, 100, 20, 120, 100)]);
assert.deepStrictEqual(r.tall, [{ id: "b", limit: 27.5, why: "rod" }]);
r = S.sqCheck([obj("b", 150, 100, 170, 120, 20), obj("a", 0, 100, 20, 120, 100)]);
assert.deepStrictEqual(r.tall, [], "the order fixes it");

// The zone drawn around a footprint: every point at the distance asked.
const zone = S.sqGrow(sq(0, 0, 20, 20), 36);
assert.ok(zone.length >= 8);
for (const p of zone) near(S.sqDist([p], sq(0, 0, 20, 20)), 36, 0.01, "on the zone");
const cw = S.sqGrow(sq(0, 0, 20, 20).reverse(), 36);
for (const p of cw) near(S.sqDist([p], sq(0, 0, 20, 20)), 36, 0.01, "clockwise too");
for (const p of S.sqGrow([[5, 5]], 10)) near(Math.hypot(p[0] - 5, p[1] - 5), 10, 1e-9, "a point: a circle");
assert.deepStrictEqual(S.sqGrow(sq(0, 0, 1, 1), 0), sq(0, 0, 1, 1), "nothing to grow");

// When it cannot print by object.
assert.strictEqual(S.sqBlocked({}), null);
assert.strictEqual(S.sqBlocked({ assoc: "colour" }), null);
assert.strictEqual(S.sqBlocked({ assoc: "height" }), "height");
assert.strictEqual(S.sqBlocked({ virtual: true }), "virtual");
assert.strictEqual(S.sqBlocked({ assoc: "height", virtual: true }), "height", "the first reason");

// Reordering the list.
const ids = ["a", "b", "c", "d"];
assert.deepStrictEqual(S.sqMove(ids, ["d"], "a"), ["d", "a", "b", "c"], "to the top");
assert.deepStrictEqual(S.sqMove(ids, ["a"], null), ["b", "c", "d", "a"], "to the end");
assert.deepStrictEqual(S.sqMove(ids, ["a"], "c"), ["b", "a", "c", "d"], "before another");
assert.deepStrictEqual(S.sqMove(ids, ["d", "b"], "a"), ["b", "d", "a", "c"], "several, in their order");
assert.deepStrictEqual(S.sqMove(ids, ["b"], "b"), ids, "onto itself: no change");
assert.deepStrictEqual(S.sqMove(ids, ["z"], "a"), ids, "unknown: no change");



// Per-object skirts: mirror object_skirt_offset and Flow's line spacing.
const skirtProfile = { skirt_type: 'perobject', skirt_loops: '2', skirt_distance: '4', initial_layer_line_width: '125%', initial_layer_print_height: '.2', nozzle_diameter: '.4' };
const skirtClearance = S.sqClearance(k => skirtProfile[k]);
const width = .5, spacing = width - .2 * (1 - Math.PI / 4);
near(S.sqGap([{height:1}], skirtClearance), 2 * (4 + width + spacing - .1), 1e-9, 'short objects include the whole skirt');
near(S.sqGap([{height:10}], skirtClearance), 72.3, 1e-9, 'a low narrow skirt fits under the head');
skirtProfile.draft_shield = 'enabled';
near(S.sqGap([{height:10}], S.sqClearance(k => skirtProfile[k])), 72.3 + 2 * (4 + width), 1e-9, 'a tall skirt adds clearance on each side');
skirtProfile.draft_shield = 'disabled'; skirtProfile.skirt_distance = '40';
near(S.sqGap([{height:10}], S.sqClearance(k => skirtProfile[k])), 2 * (40 + width + spacing - .1), 1e-9, 'a wide skirt extends past the head radius');
skirtProfile.skirt_type = 'combined';
near(S.sqGap([{height:1}], S.sqClearance(k => skirtProfile[k])), 3.8, 1e-9, 'combined skirts do not inflate individual objects');

assert.strictEqual(S.sqDist([[2,2],[8,8]], sq(0,0,10,10)), 0, 'segment inside a polygon');
assert.strictEqual(S.sqDist([[-5,5],[15,5]], sq(0,0,10,10)), 0, 'segment crossing a polygon');
assert.strictEqual(S.sqDist([[-5,0],[5,0]], [[0,-5],[0,5]]), 0, 'crossing segments');
for (const p of S.sqGrow([[0,0],[100,0]],10)) near(S.sqDist([p],[[0,0],[100,0]]),10,1e-9,'a segment grows into a full-length capsule');

const mixed = { skirt_type:'perobject', skirt_loops:1, skirt_distance:4, initial_layer_line_width:.5, max_layer_height:[.2,.3], skirt_height:9 };
near(S.sqGap([{height:10}], S.sqClearance(k => mixed[k])),81.3,1e-9,'the maximum head layer height triggers the tall skirt');
mixed.nozzle_diameter = [.4,.6]; mixed.initial_layer_line_width = '125%'; mixed.support_filament = 1;
let mixedClearance = S.sqClearance(k => mixed[k]);
near(mixedClearance.skirt.initial,.75,1e-9,'clearance initial width uses the largest nozzle');
near(mixedClearance.skirt.width,.5,1e-9,'skirt flow width uses the support nozzle');
near(S.sqGap([{height:10}],mixedClearance),81.8,1e-9,'tall skirt clearance uses the maximum nozzle width');
near(S.sqGap([{height:1}],mixedClearance),8.8,1e-9,'short skirt extent uses the support nozzle width');
mixed.support_filament = 2;
mixedClearance = S.sqClearance(k => mixed[k]);
near(mixedClearance.skirt.width,.75,1e-9,'support head selection changes skirt flow');
near(S.sqGap([{height:1}],mixedClearance),9.3,1e-9,'larger support nozzle enlarges the short skirt');
console.log("sequence: ok");
