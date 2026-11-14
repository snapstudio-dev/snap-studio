// Prepare view rules: on / off the plate, slicing filter, slider steps.
const assert = require("assert");
const L = require("../ui/prepare-logic.js");

const bed = { w: 270, d: 270 };
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

// Bed state from a footprint.
assert.strictEqual(L.plBedState(sq(10, 10, 50, 50), bed), "in");
assert.strictEqual(L.plBedState(sq(0, 0, 270, 270), bed), "in");
assert.strictEqual(L.plBedState(sq(-0.05, 0, 270.05, 270), bed), "in", "0.1 mm tolerance");
assert.strictEqual(L.plBedState(sq(250, 10, 290, 50), bed), "partial");
assert.strictEqual(L.plBedState(sq(-5, 10, 20, 50), bed), "partial");
assert.strictEqual(L.plBedState(sq(290, 10, 330, 50), bed), "out");
assert.strictEqual(L.plBedState(sq(10, -60, 50, -20), bed), "out");

// Groups and the slicing filter: only "in" objects are sliced.
const objs = [
  { id: 1, st: "in" },
  { id: 2, st: "out" },
  { id: 3, st: "partial" },
  { id: 4, st: "in" },
  { id: 5, st: "out" },
];
const stateOf = (o) => o.st;
const g = L.plGroups(objs, stateOf);
assert.deepStrictEqual(g.on.map((o) => o.id), [1, 3, 4], "sticking out stays with the plate");
assert.deepStrictEqual(g.off.map((o) => o.id), [2, 5]);
assert.strictEqual(g.partial, 1);
assert.strictEqual(g.sliced, 2);
assert.deepStrictEqual(L.plSliced(objs, stateOf).map((o) => o.id), [1, 4], "never an off-plate object");
assert.deepStrictEqual(L.plSliced([{ st: "out" }], stateOf), []);
const empty = L.plGroups([], stateOf);
assert.deepStrictEqual([empty.on.length, empty.off.length, empty.sliced], [0, 0, 0]);

// Slider bounds.
assert.deepStrictEqual([L.plRange("pos", bed, 0).min, L.plRange("pos", { w: 300, d: 200 }, 1).max], [0, 200]);
assert.deepStrictEqual([L.plRange("rot").min, L.plRange("rot").max], [-180, 180]);
assert.deepStrictEqual([L.plRange("scale").min, L.plRange("scale").max], [10, 400]);

// Magnetic 15 degree notches, off with Shift.
assert.strictEqual(L.plSnapAngle(43, false), 45);
assert.strictEqual(L.plSnapAngle(-88, false), -90);
assert.strictEqual(L.plSnapAngle(40, false), 40);
assert.strictEqual(L.plSnapAngle(43, true), 43);
assert.strictEqual(L.plSnapAngle(179, false), 180);

// Wheel / arrow steps.
assert.strictEqual(L.plNudge("pos", 100, 1, false, bed), 101);
assert.strictEqual(L.plNudge("pos", 100, -1, true, bed), 90);
assert.strictEqual(L.plNudge("pos", 103.5, 1, true, bed), 110, "coarse steps land on round values");
assert.strictEqual(L.plNudge("pos", 269.5, 1, false, bed), 270, "kept within the bed");
assert.strictEqual(L.plNudge("rot", 10, 1, true, bed), 15);
assert.strictEqual(L.plNudge("rot", 15, 1, true, bed), 30);
assert.strictEqual(L.plNudge("rot", 15, -1, true, bed), 0);
assert.strictEqual(L.plNudge("rot", 180, 1, false, bed), -179, "rotation wraps");
assert.strictEqual(L.plNudge("rot", -180, -1, true, bed), 165);
assert.strictEqual(L.plNudge("scale", 400, 1, false, bed), 400);
// A value beyond the bounds takes the step, not the bound.
assert.strictEqual(L.plNudge("scale", 500, -1, false, bed), 499, "typed above 400 %");
assert.strictEqual(L.plNudge("scale", 2540, 1, false, bed), 2541, "inch model converted to mm");
assert.strictEqual(L.plNudge("scale", 5, -1, false, bed), 4, "below 10 %");
assert.strictEqual(L.plNudge("scale", 1, -1, false, bed), 1, "never below 1 %");
assert.strictEqual(L.plNudge("pos", 320, 1, false, bed, 0), 321, "parked beside the bed: not thrown back");
assert.strictEqual(L.plNudge("scale", 10, -1, true, bed), 10);
assert.strictEqual(L.plNudge("scale", 100, 1, true, bed), 110);
assert.strictEqual(L.plWrapDeg(270), -90);

// The prime tower's volume: its own bounds, whole steps, 5 with ⇧.
assert.deepStrictEqual([L.plRange("purge", bed, 0, { min: 15, max: 90 }).min, L.plRange("purge", bed, 0, { min: 15, max: 90 }).max], [15, 90]);
assert.deepStrictEqual([L.plRange("purge").min, L.plRange("purge").max], [15, 90], "defaults without bounds");
assert.strictEqual(L.plNudge("purge", 45, -1, false, bed, 0, { min: 15, max: 90 }), 44);
assert.strictEqual(L.plNudge("purge", 45, 1, true, bed, 0, { min: 15, max: 90 }), 50);
assert.strictEqual(L.plNudge("purge", 15, -1, false, bed, 0, { min: 15, max: 90 }), 15, "never below the minimum purge");
assert.strictEqual(L.plNudge("purge", 88, 1, true, bed, 0, { min: 15, max: 90 }), 90);

// Bringing a box back on the plate by the smallest move.
assert.deepStrictEqual(L.plInside({ x0: 250, y0: 10, x1: 290, y1: 50 }, bed), [-20, 0]);
assert.deepStrictEqual(L.plInside({ x0: -5, y0: -8, x1: 20, y1: 30 }, bed), [5, 8]);
assert.deepStrictEqual(L.plInside({ x0: 10, y0: 10, x1: 20, y1: 20 }, bed), [0, 0]);
assert.strictEqual(L.plInside({ x0: -10, y0: 0, x1: 300, y1: 20 }, bed), null, "larger than the bed");

// Parking beside the plate: on its right, below what is already there.
assert.deepStrictEqual(L.plParkSpot([], bed, 40, 30), [290, 0]);
assert.deepStrictEqual(L.plParkSpot([{ x0: 290, y0: 0, x1: 330, y1: 30 }], bed, 40, 30), [340, 0], "next in the row");
assert.deepStrictEqual(L.plParkSpot([{ x0: 290, y0: 60, x1: 330, y1: 90 }], bed, 40, 30), [290, 0], "a gap above is used");
assert.deepStrictEqual(L.plParkSpot([{ x0: 10, y0: 0, x1: 50, y1: 30 }], bed, 40, 30), [290, 0], "boxes on the plate do not count");
// Many objects: rows no wider than the bed (290 → 560), several of them.
{
  const parked = [];
  for (let i = 0; i < 20; i++) {
    const [x, y] = L.plParkSpot(parked, bed, 70, 70);
    parked.push({ x0: x, y0: y, x1: x + 70, y1: y + 70 });
  }
  assert.ok(parked.every((b) => b.x0 >= 290 && b.x1 <= 290 + 270), "within the bed's width");
  assert.deepStrictEqual([...new Set(parked.map((b) => b.y0))], [0, 80, 160, 240, 320, 400, 480], "rows of three, one after the other");
  assert.deepStrictEqual(parked.slice(0, 4).map((b) => [b.x0, b.y0]), [[290, 0], [370, 0], [450, 0], [290, 80]]);
  // A gap left in a row is used again.
  parked.splice(1, 1);
  assert.deepStrictEqual(L.plParkSpot(parked, bed, 70, 70), [370, 0]);
  // Wider than the area: alone at the start of a new row.
  assert.deepStrictEqual(L.plParkSpot([], bed, 400, 50), [290, 0]);
}

// Shift-click: from the anchor to the clicked row, in the displayed order.
const order = [4, 1, 7, 3, 9];
assert.deepStrictEqual(L.plRangeIds(order, 1, 3), [1, 7, 3]);
assert.deepStrictEqual(L.plRangeIds(order, 9, 1), [1, 7, 3, 9], "upwards too");
assert.deepStrictEqual(L.plRangeIds(order, 7, 7), [7]);
assert.deepStrictEqual(L.plRangeIds(order, 42, 3), [3], "anchor gone: the row alone");
assert.deepStrictEqual(L.plRangeIds(order, 1, 42), []);

// Projection: identity keeps NDC; a point behind the eye is dropped.
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
assert.deepStrictEqual(L.plProject(I, [0.5, -0.5, 0]), [0.5, -0.5]);
const behind = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0]; // w = -z
assert.strictEqual(L.plProject(behind, [0, 0, 1]), null);
assert.deepStrictEqual(L.plProject(behind, [1, 1, -2]), [0.5, 0.5]);
assert.deepStrictEqual(L.plScreenBox(I, [[-1, 1, 0], [0, 0, 0]], 200, 100), { x0: 0, y0: 0, x1: 100, y1: 50 }, "y down");
assert.strictEqual(L.plScreenBox(behind, [[0, 0, 1]], 200, 100), null);

// Rubber band: boxes it touches, corners in any order.
const boxes = [
  { id: 1, x0: 10, y0: 10, x1: 30, y1: 30 },
  { id: 2, x0: 50, y0: 10, x1: 70, y1: 30 },
  { id: 3, x0: 10, y0: 60, x1: 30, y1: 80 },
  null,
];
assert.deepStrictEqual(L.plMarquee([0, 0], [40, 40], boxes), [1]);
assert.deepStrictEqual(L.plMarquee([60, 35], [25, 5], boxes), [1, 2], "partly touched counts");
assert.deepStrictEqual(L.plMarquee([31, 31], [49, 59], boxes), []);
assert.deepStrictEqual(L.plMarquee([0, 0], [100, 100], boxes), [1, 2, 3]);

// Scale split: asked for, or forced by a non-uniform scale.
assert.strictEqual(L.plScaleSplit([1, 1, 1], false), false);
assert.strictEqual(L.plScaleSplit([1, 1, 1], true), true);
assert.strictEqual(L.plScaleSplit([1, 2, 1], false), true);
assert.strictEqual(L.plUniform([0.5, 0.5, 0.5]), true);

// Toolbar: only the useful buttons; the last three always.
const vis = (st) => Object.entries(L.plTools(st)).filter(([, v]) => v.show).map(([k]) => k);
assert.deepStrictEqual(vis({}), ["p-save", "p-clear", "p-slice"], "empty plate");
assert.deepStrictEqual(vis({ n: 2, onBed: 2, sliceable: true }), ["p-face", "p-orient", "p-arrange", "p-overhangs", "p-save", "p-clear", "p-slice"], "nothing selected");
assert.deepStrictEqual(vis({ n: 2, onBed: 0 }), ["p-face", "p-overhangs", "p-save", "p-clear", "p-slice"], "all beside the plate");
assert.strictEqual(vis({ n: 2, sel: 1, onBed: 2 }).length, 11, "a selection: all");
assert.ok(vis({ overhangs: true }).includes("p-overhangs"), "the overhang view on stays in view");
assert.ok(vis({ n: 1, tool: "rotate" }).includes("p-rotate"), "a tool on stays in view");
const busy = L.plTools({ n: 1, sel: 1, onBed: 1, orienting: true, splitting: true });
assert.deepStrictEqual([busy["p-orient"], busy["p-split"]], [{ show: true, on: false }, { show: true, on: false }]);
assert.strictEqual(L.plTools({ n: 1 })["p-slice"].on, false);
assert.strictEqual(L.plTools({ n: 1 })["p-save"].on, true);


// Supports badge: "likely" objects only, nothing with supports on; each
// reason once. The hint's key ignores the position on the bed.
{
  const objs = [
    { id: 1, name: "T.stl" },
    { id: 2, name: "Cube" },
    { id: 3, name: "Pendant" },
    { id: 4, name: "Bridge" },
    { id: 5, name: "Shelf" },
  ];
  const hints = { 1: { verdict: "likely", reason: "cantilever" }, 2: { verdict: "none" }, 3: { verdict: "likely", reason: "floating" }, 4: { verdict: "maybe" }, 5: { verdict: "likely", reason: "cantilever" } };
  const hintOf = (o) => hints[o.id];
  assert.deepStrictEqual(L.plSupportBadge(objs, hintOf, false), { ids: [1, 3, 5], names: ["T.stl", "Pendant", "Shelf"], reasons: ["cantilever", "floating"] });
  assert.strictEqual(L.plSupportBadge(objs, hintOf, true), null, "supports on: no badge");
  assert.strictEqual(L.plSupportBadge(objs.slice(1, 2), hintOf, false), null, "nothing likely");
  assert.strictEqual(L.plSupportBadge([{ id: 9 }], () => undefined, false), null, "hint not known yet");
  const o = { path: "/a.stl", item: 0, piece: null, pos: [10, 20], rot: [90, 0, 0], scale: [1, 1, 1] };
  assert.strictEqual(L.plHintKey(o, 30), L.plHintKey({ ...o, pos: [100, 5] }, 30), "moved: same hint");
  assert.notStrictEqual(L.plHintKey(o, 30), L.plHintKey({ ...o, rot: [0, 0, 0] }, 30), "tilted: new hint");
  assert.strictEqual(L.plHintKey(o, 30), L.plHintKey({ ...o, rot: [90, 0, 45] }, 30), "turned on the bed: same hint");
  assert.notStrictEqual(L.plHintKey(o, 30), L.plHintKey({ ...o, scale: [2, 2, 2] }, 30), "scaled: new hint");
  assert.notStrictEqual(L.plHintKey(o, 30), L.plHintKey(o, 45), "another angle: new hint");
}

// Bulk buttons of the object list: "all" without a relevant selection or
// with the whole side selected, "some" with a count otherwise; a mixed
// selection counts each side alone.
{
  const on = [{ id: 1 }, { id: 2 }], off = [{ id: 3 }, { id: 4 }, { id: 5 }];
  assert.deepEqual(L.plBulk(new Set(), on), { mode: "all", n: 2 });
  assert.deepEqual(L.plBulk(new Set([1]), on), { mode: "some", n: 1 });
  assert.deepEqual(L.plBulk(new Set([1, 2]), on), { mode: "all", n: 2 });
  assert.deepEqual(L.plBulk(new Set([1, 3, 4]), off), { mode: "some", n: 2 });
  assert.deepEqual(L.plBulk(new Set([1, 3, 4]), on), { mode: "some", n: 1 });
  assert.deepEqual(L.plBulk(new Set([9]), off), { mode: "all", n: 3 });
}

// Colour modes: the plate's colours, the hand-off between the two modes,
// and what blocks the slice.
{
  const objs = [
    { id: 1, extruders: [1, 2], heads: { 1: 0, 2: 1 }, st: "in" },
    { id: 2, extruders: [2, 3], heads: { 2: 1 }, st: "in" },
    { id: 3, extruders: [3], heads: { 3: 3 }, st: "in" },
    { id: 4, extruders: [4], heads: { 4: 2 }, st: "out" },
  ];
  const stateOf = (o) => o.st, coloursOf = (o) => o.extruders;
  const headsOf = (o) => Object.fromEntries(o.extruders.map((c) => [c, o.heads[c] ?? c - 1]));
  // Off-plate colours are not the plate's.
  assert.deepEqual(L.plPlateColours(objs, stateOf, coloursOf), [1, 2, 3]);
  // Colour 2: both objects agree on T1. Colour 3: object 2 defaults to T2, object 3 chose T3 → conflict.
  assert.deepEqual(L.plMigrateToColour(objs, stateOf, headsOf, [1, 2, 3]), { 1: 0, 2: 1, 3: null });
  assert.deepEqual(L.plUnmapped([1, 2, 3], { 1: 0, 2: 1, 3: null }), [3]);
  // Colour → object: the global heads become each object's own; unmapped colours keep the object's choice.
  const back = L.plMigrateToObject(objs, stateOf, coloursOf, { 1: 2, 2: null, 3: 0 });
  assert.deepEqual(back, { 1: { 1: 2, 2: 1 }, 2: { 2: 1, 3: 0 }, 3: { 3: 0 } });
  assert.equal(back[4], undefined, "off-plate objects are left alone");
  // Nothing on the plate: nothing to map, nothing blocks.
  assert.deepEqual(L.plMigrateToColour([], stateOf, headsOf, []), {});
  // Virtual heads and orphans (a virtual head deleted since) go across as
  // they are: never turned into a physical head.
  const vobjs = [{ id: 1, st: "in", heads: { 1: 101, 2: 105 } }, { id: 2, st: "in", heads: { 1: 101 } }];
  assert.deepEqual(L.plMigrateToColour(vobjs, stateOf, (o) => o.heads, [1, 2]), { 1: 101, 2: 105 });
  assert.deepEqual(L.plMigrateToObject(vobjs, stateOf, () => [1, 2], { 1: 101, 2: 105 }), { 1: { 1: 101, 2: 105 }, 2: { 1: 101, 2: 105 } });
  assert.deepEqual(L.plUnmapped([], {}), []);
}

// "By colour" mode: an on-plate object without a colour from its file,
// and without a head picked by hand, blocks the slice.
{
  const objs = [
    { id: 1, extruders: [1], st: "in" },
    { id: 2, extruders: [], st: "in" },
    { id: 3, extruders: [], st: "in", pick: 2 },
    { id: 4, extruders: [], st: "out" },
  ];
  assert.deepEqual(L.plUncoloured(objs, (o) => o.st, (o) => o.extruders || []), [2]);
}

// "By colour" palette: every head, the picked one on; "the plate's colours"
// only once a head is picked; a single head is no choice.
{
  const none = L.plPalette(null, 4);
  assert.deepStrictEqual(none.heads.map((x) => x.h), [0, 1, 2, 3]);
  assert.ok(none.heads.every((x) => !x.on));
  assert.strictEqual(none.plate, false, "no plate row before a pick");
  assert.strictEqual(none.single, false);
  const two = L.plPalette(2, 4);
  assert.deepStrictEqual(two.heads.filter((x) => x.on).map((x) => x.h), [2]);
  assert.strictEqual(two.plate, true, "plate row once picked");
  assert.strictEqual(L.plPalette(0, 4).plate, true, "head 0 is a pick");
  assert.strictEqual(L.plPalette(null, 1).single, true);
  assert.strictEqual(L.plPalette(null, 0).heads.length, 1, "at least one head");
}


// Undo shortcut: a slider or a switch keeps the keyboard, ⌘Z still undoes.
assert.strictEqual(L.plTyping({ tagName: "INPUT", type: "range" }), false, "slider");
assert.strictEqual(L.plTyping({ tagName: "INPUT", type: "checkbox" }), false, "switch");
assert.strictEqual(L.plTyping({ tagName: "BUTTON" }), false);
assert.strictEqual(L.plTyping({ tagName: "CANVAS" }), false);
assert.strictEqual(L.plTyping(null), false);
assert.strictEqual(L.plTyping({ tagName: "INPUT", type: "number" }), true, "typed value");
assert.strictEqual(L.plTyping({ tagName: "INPUT", type: "text" }), true);
assert.strictEqual(L.plTyping({ tagName: "INPUT" }), true, "no type is text");
assert.strictEqual(L.plTyping({ tagName: "TEXTAREA" }), true);
assert.strictEqual(L.plTyping({ tagName: "SELECT" }), true);
assert.strictEqual(L.plTyping({ tagName: "DIV", isContentEditable: true }), true);

console.log("prepare: ok");
