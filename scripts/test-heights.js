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

// The colours the sheet maps: the object's, then the changes'.
assert.deepStrictEqual(H.hcColours([1], hc), [1, 2, 3]);
assert.deepStrictEqual(H.hcColours([], hc), [1, 2, 3], "an uncoloured object is extruder 1");
assert.deepStrictEqual(H.hcColours([2], hc), [2, 3]);
assert.deepStrictEqual(H.hcColours([1, 2], undefined), [1, 2], "no change: unchanged");

// No change: nothing sent, whatever the plate.
assert.deepStrictEqual(H.hcRequest([{ base: [1, 2], hc: [], map: [0, 1] }], { pillars: true }), { changes: [] });

// One object on T0, T1 from 1.2 mm, a pause for the spool on T2 at 2.4 mm.
const one = { base: [1], hc, map: [0, 1, 2] };
assert.deepStrictEqual(H.hcRequest([one]), {
  changes: [{ z: 1.2, head: 1, kind: "auto" }, { z: 2.4, head: 2, kind: "pause" }],
});
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

console.log("test-heights: ok");
