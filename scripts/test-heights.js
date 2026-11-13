// node scripts/test-heights.js — colour changes at a height (HueForge):
// the colours they bring, what the slice sends or why it cannot, the
// preview's marks.
const assert = require("assert");
const H = require("../ui/heights-logic.js");

// A file's list: extruders from 1, pauses kept, nonsense dropped.
const hc = H.hcFromFile([
  { z: 1.2, extruder: 2, kind: "auto" },
  { z: 2.4, extruder: 3, kind: "pause" },
  { z: 0, extruder: 1, kind: "auto" },
  { z: 3, extruder: 0 },
]);
assert.deepStrictEqual(hc, [{ z: 1.2, ext: 2, kind: "auto" }, { z: 2.4, ext: 3, kind: "pause" }]);
assert.deepStrictEqual(H.hcFromFile(null), []);

// The colours the sheet maps: the object's, then the head changes' (a
// pause keeps the head, so brings none).
assert.deepStrictEqual(H.hcColours([1], hc), [1, 2]);
assert.deepStrictEqual(H.hcColours([], hc), [1, 2], "an uncoloured object is extruder 1");
assert.deepStrictEqual(H.hcColours([3], hc), [3, 2]);
assert.deepStrictEqual(H.hcColours([1, 2], undefined), [1, 2], "no change: unchanged");

// No change: nothing sent, whatever the plate.
assert.deepStrictEqual(H.hcRequest([{ base: [1, 2], hc: [], map: [0, 1] }], { pillars: true }), { changes: [] });

// One object on T0, T1 from 1.2 mm, a pause for a spool swap at 2.4 mm:
// it keeps T1, the head in force; the file's layers go along.
const hcl = { layer_height: 0.08, first_layer: 0.16 };
const one = { base: [1], hc, hcl, map: [0, 1, 2], scale: [1, 1, 1] };
assert.deepStrictEqual(H.hcRequest([one]), {
  changes: [{ z: 1.2, head: 1, kind: "auto" }, { z: 2.4, head: 1, kind: "pause" }],
  layers: hcl,
});
// A pause below every head change: the base head; out of order, sorted.
assert.deepStrictEqual(
  H.hcRequest([{ ...one, hc: [{ z: 2, ext: 2, kind: "auto" }, { z: 1, ext: 3, kind: "pause" }], map: [3, 1, 2] }]).changes,
  [{ z: 1, head: 3, kind: "pause" }, { z: 2, head: 1, kind: "auto" }],
);
// A virtual head as target: its engine index as the map gives it.
assert.deepStrictEqual(H.hcRequest([{ ...one, map: [0, 4, 2] }]).changes[0], { z: 1.2, head: 4, kind: "auto" });
// Copies of the object, same list: fine.
assert.ok(H.hcRequest([one, { ...one }]).changes.length === 2);

// Blocks.
assert.deepStrictEqual(H.hcRequest([one, { base: [1], hc: [], map: [0] }]), { error: "mixed" }, "an object without the list");
assert.deepStrictEqual(H.hcRequest([one, { ...one, hc: [{ z: 1.4, ext: 2, kind: "auto" }] }]), { error: "mixed" });
assert.deepStrictEqual(H.hcRequest([one], { pillars: true }), { error: "pillars" });
assert.deepStrictEqual(H.hcRequest([one], { byObject: true }), { error: "by_object" });
assert.deepStrictEqual(H.hcRequest([{ ...one, base: [1, 2] }]), { error: "heads" }, "a painted or two-colour object");
assert.deepStrictEqual(H.hcRequest([one, { ...one, map: [3, 1, 2] }]), { error: "heads" }, "two objects on two heads");
assert.deepStrictEqual(H.hcRequest([one, { ...one, map: [0, 3, 2] }]), { error: "heads" }, "a change's colour on two heads");
// Only the head changes' colours count: a pause's says nothing.
assert.ok(H.hcRequest([one, { ...one, map: [0, 1, 3] }]).changes);
assert.deepStrictEqual(H.hcRequest([one, { ...one, hcl: { layer_height: 0.12, first_layer: 0.16 } }]), { error: "mixed" }, "other layers");
assert.deepStrictEqual(H.hcRequest([{ ...one, scale: [1, 1, 1.5] }]), { error: "scaled" });
assert.ok(H.hcRequest([{ ...one, scale: [2, 2, 1] }]).changes, "scaled across only: same heights");
assert.ok(H.hcRequest([one, { base: [1], hc: [], map: [0], scale: [1, 1, 2] }]).error !== "scaled", "an object without changes may be");
// Two colours on the same head: one head, fine.
assert.ok(H.hcRequest([{ ...one, base: [1, 2], map: [0, 0, 2] }]).changes);

// Marks: the pauses, then the main tool's changes.
assert.deepStrictEqual(H.hcMarks([undefined, 0, 0, 1, 1, 0], [5]), [
  { layer: 3, kind: "head", tool: 1 },
  { layer: 5, kind: "pause" },
]);
assert.deepStrictEqual(H.hcMarks([0, undefined, 0], []), [], "a layer without extrusion changes nothing");
// A virtual head alternating at every layer: no head marks, pauses kept.
const alt = Array.from({ length: 100 }, (_, l) => (l % 3 === 2 ? 2 : 0));
assert.deepStrictEqual(H.hcMarks(alt, [40]), [{ layer: 40, kind: "pause" }]);

// ---- "By height" mode (step 2).

// Layer tops: first layer, then even layers (HueForge's layer #11 at 0.96).
assert.strictEqual(H.hzLayerTop(11, 0.08, 0.16), 0.96);
assert.strictEqual(H.hzLayerTop(1, 0.08, 0.16), 0.16);
// Snap to the nearest layer top: 0.50 → layer 5 at 0.48.
assert.deepStrictEqual(H.hzSnap(0.5, 0.08, 0.16), { layer: 5, z: 0.48, gap: -0.02 });
assert.deepStrictEqual(H.hzSnap(0.96, 0.08, 0.16), { layer: 11, z: 0.96, gap: 0 });
assert.deepStrictEqual(H.hzSnap(0.01, 0.2, 0.2), { layer: 1, z: 0.2, gap: 0.19 }, "never below the first layer");
assert.strictEqual(H.hzSnap(0.5, 0, 0.2).layer, null, "no layers: as asked");

// Bands from the bed up; a pause keeps the head.
assert.deepStrictEqual(
  H.hzBands({ base: 0, changes: [{ z: 2, head: 3, kind: "pause" }, { z: 1, head: 1, kind: "auto" }] }),
  [
    { from: 0, to: 1, head: 0, pause: false },
    { from: 1, to: 2, head: 1, pause: false },
    { from: 2, to: null, head: 1, pause: true },
  ],
);
assert.deepStrictEqual(H.hzBands(null), [{ from: 0, to: null, head: 0, pause: false }]);

// What the slice sends: sorted, a pause carries the head in force.
const plan = { base: 2, changes: [{ z: 1.6, head: 0, kind: "pause" }, { z: 0.96, head: 1, kind: "auto" }], layers: hcl, src: "describe" };
assert.deepStrictEqual(H.hzRequest(plan, [{ base: [1], scale: [1, 1, 1] }, { base: [], scale: [2, 2, 1] }]), {
  changes: [{ z: 0.96, head: 1, kind: "auto" }, { z: 1.6, head: 1, kind: "pause" }],
  base: 2,
  layers: hcl,
});
assert.deepStrictEqual(H.hzRequest({ base: 1, changes: [] }, [{ base: [1] }], { pillars: true }), { changes: [], base: 1 });
assert.deepStrictEqual(H.hzRequest(plan, [{ base: [1, 2] }]), { error: "heads" }, "a painted object");
assert.deepStrictEqual(H.hzRequest(plan, [{ base: [1], scale: [1, 1, 2] }]), { error: "scaled" }, "an imported list on a stretched object");
assert.ok(H.hzRequest({ ...plan, src: null }, [{ base: [1], scale: [1, 1, 2] }]).changes, "heights set on the plate itself");
assert.deepStrictEqual(H.hzRequest(plan, [{ base: [1] }], { pillars: true }), { error: "pillars" });
assert.deepStrictEqual(H.hzRequest(plan, [{ base: [1] }], { byObject: true }), { error: "by_object" });

// Colours to heads: the same, else the nearest (flagged as not loaded).
const heads = [{ head: 0, color: "#000000" }, { head: 1, color: "#8a6038" }, { head: 2, color: "#ffffff" }, { head: 4, color: null }];
assert.deepStrictEqual(H.hzNearestHead("#8c6239", heads), { head: 1, exact: true });
assert.deepStrictEqual(H.hzNearestHead("#f5e663", heads), { head: 2, exact: false });
assert.strictEqual(H.hzNearestHead("#ffffff", []), null);
assert.strictEqual(H.hzColourGap("#000", "#000000"), Infinity);

// A describe, as a file or pasted on one line from a MakerWorld page.
const describe = `Print at 100% infill with a layer height of 0.08mm with a base layer of 0.16mm

#000000 PLA Bambu Lab Basic Black Transmission Distance: 0.6
#8C6239 PLA Polymaker Bronze Transmission Distance: 2.2
#f5e663 PLA Elegoo Yellow Transmission Distance: 4.5
#ffffff PLA Generic White TD: 6

Swap Instructions:
Start with Black
At layer #11 (0.96mm) swap to Bronze
At layer #20 (1.69mm) swap to White
At layer #31 (2.56mm) swap to Yellow for the rest.`;
const d = H.hzParseDescribe(describe);
assert.deepStrictEqual(d, {
  layer_height: 0.08,
  first_layer: 0.16,
  infill100: true,
  colours: [
    { hex: "#000000", name: "PLA Bambu Lab Basic Black" },
    { hex: "#8c6239", name: "PLA Polymaker Bronze" },
    { hex: "#f5e663", name: "PLA Elegoo Yellow" },
    { hex: "#ffffff", name: "PLA Generic White" },
  ],
  start: "Black",
  swaps: [
    { layer: 11, z: 0.96, name: "Bronze" },
    { layer: 20, z: 1.69, name: "White" },
    { layer: 31, z: 2.56, name: "Yellow" },
  ],
});
assert.deepStrictEqual(H.hzParseDescribe(describe.replace(/\n+/g, " ")).swaps, d.swaps, "pasted on one line");
assert.strictEqual(H.hzParseDescribe(describe.replace(/\n+/g, " ")).start, "Black");
assert.strictEqual(H.hzParseDescribe("hello"), null);

// Swap names to colour lines: whole words first, then the most shared.
assert.strictEqual(H.hzColourOf("bronze", d.colours).hex, "#8c6239");
assert.strictEqual(H.hzColourOf("Basic Black", d.colours).hex, "#000000");
assert.strictEqual(H.hzColourOf("Glow Yellow", d.colours).hex, "#f5e663");
assert.strictEqual(H.hzColourOf("Blue", d.colours), null);

// The plan: heights on real layers (1.69 → 1.68, beyond 0.01: said),
// heads by colour, a colour no head holds said.
const fromD = H.hzFromDescribe(d, heads);
assert.deepStrictEqual(fromD.plan, {
  base: 0,
  changes: [
    { z: 0.96, head: 1, kind: "auto" },
    { z: 1.68, head: 2, kind: "auto" },
    { z: 2.56, head: 2, kind: "auto" },
  ],
  layers: { layer_height: 0.08, first_layer: 0.16 },
  src: "describe",
});
assert.deepStrictEqual(fromD.warnings, [{ kind: "unloaded", name: "PLA Elegoo Yellow", hex: "#f5e663" }], "1.69 → 1.68 is within 0.01");
const far = H.hzFromDescribe({ ...d, swaps: [{ layer: 11, z: 0.99, name: "Pink" }] }, heads);
assert.deepStrictEqual(far.warnings, [{ kind: "gap", z: 0.99, to: 0.96 }, { kind: "unknown", name: "Pink" }]);

// From a 3MF's list: colours by extruder, a pause keeps the head.
const fromF = H.hzFromFile(
  [{ z: 0.5, ext: 2, kind: "auto" }, { z: 1.04, ext: 3, kind: "pause" }],
  { 1: "#000000", 2: "#ffffff", 3: "#ff00ff" },
  hcl,
  heads,
);
assert.deepStrictEqual(fromF.plan, {
  base: 0,
  changes: [{ z: 0.48, head: 2, kind: "auto" }, { z: 1.04, head: 2, kind: "pause" }],
  layers: hcl,
  src: "3mf",
});
assert.deepStrictEqual(fromF.warnings, [{ kind: "gap", z: 0.5, to: 0.48 }]);

console.log("test-heights: ok");
