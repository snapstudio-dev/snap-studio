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
  { layer: 1, kind: "head", tool: 0, start: true },
  { layer: 3, kind: "head", tool: 1 },
  { layer: 5, kind: "pause" },
]);
assert.deepStrictEqual(H.hcMarks([0, undefined, 0], []), [], "a layer without extrusion changes nothing");
assert.deepStrictEqual(H.hcMarks([0, 0, 0], [2]), [{ layer: 0, kind: "head", tool: 0, start: true }, { layer: 2, kind: "pause" }], "pauses only: the head it starts on too");
assert.deepStrictEqual(H.hcMarks([0, 0, 0], []), [], "one head, nothing to mark: no start mark either");
// A virtual head alternating at every layer: no head marks, pauses kept.
const alt = Array.from({ length: 100 }, (_, l) => (l % 3 === 2 ? 2 : 0));
assert.deepStrictEqual(H.hcMarks(alt, [40]), [{ layer: 40, kind: "pause" }]);
// At the limit: `max` changes still marked, with the start mark.
const two = (n) => Array.from({ length: n + 1 }, (_, l) => l % 2);
assert.strictEqual(H.hcMarks(two(32), []).length, 33, "32 changes: 32 marks and the start");
assert.deepStrictEqual(H.hcMarks(two(33), []), [], "33 changes: none");

// ---- "By height" mode (step 2).

// Layer tops: first layer, then even layers (HueForge's layer #11 at 0.96).
assert.strictEqual(H.hzLayerTop(11, 0.08, 0.16), 0.96);
assert.strictEqual(H.hzLayerTop(1, 0.08, 0.16), 0.16);
// Snap to the nearest layer top: 0.50 → layer 5 at 0.48.
assert.deepStrictEqual(H.hzSnap(0.5, 0.08, 0.16), { layer: 5, z: 0.48, gap: -0.02 });
assert.deepStrictEqual(H.hzSnap(0.96, 0.08, 0.16), { layer: 11, z: 0.96, gap: 0 });
assert.deepStrictEqual(H.hzSnap(0.01, 0.2, 0.2), { layer: 2, z: 0.4, gap: 0.39 }, "never the first layer (as Rust)");
assert.strictEqual(H.hzSnap(0.53, 0.08, 0.16).z, 0.56);
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
assert.deepStrictEqual(H.hzRequest(plan, [{ base: [1, 2] }]), { error: "multicolour" }, "a painted object");
assert.deepStrictEqual(H.hzPlanHeads(plan), [plan.base, ...plan.changes.filter((c) => c.kind !== "pause").map((c) => c.head)], "the heads a plan prints with");
assert.deepStrictEqual(H.hzPlanHeads({ base: 2, changes: [{ z: 1, head: 0, kind: "auto" }, { z: 2, head: 0, kind: "pause" }, { z: 3, head: 101, kind: "auto" }] }), [2, 0, 101], "a pause keeps its head");
assert.deepStrictEqual(H.hzPlanHeads(null), [], "no plan");
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
assert.deepStrictEqual(
  H.hzParseDescribe("layer height of 0.08mm\n#000000 Black PLA - Transmission Distance: 0.6\nAt layer #5 (0.4mm) swap to Black").colours,
  [{ hex: "#000000", name: "Black PLA" }],
  "a name keeps no separator before its transmission distance",
);

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
  baseHex: "#000000",
  changes: [
    { z: 0.96, head: 1, kind: "auto", hex: "#8c6239" },
    { z: 1.68, head: 2, kind: "auto", hex: "#ffffff" },
    { z: 2.56, head: 2, kind: "auto", hex: "#f5e663" },
  ],
  layers: { layer_height: 0.08, first_layer: 0.16 },
  src: "describe",
  names: { "#000000": "PLA Bambu Lab Basic Black", "#8c6239": "PLA Polymaker Bronze", "#f5e663": "PLA Elegoo Yellow", "#ffffff": "PLA Generic White" },
});
// Four colours, three loaded heads: yellow shares white's head, said.
assert.deepStrictEqual(
  fromD.warnings,
  [
    { kind: "unloaded", name: "PLA Elegoo Yellow", hex: "#f5e663" },
    { kind: "same", hex: "#ffffff", name: "PLA Generic White", with: "#f5e663", withName: "PLA Elegoo Yellow" },
  ],
  "1.69 → 1.68 is within 0.01",
);
// Each colour on its own head while there are enough: two greys never on
// black's and white's heads while red and blue are free.
const four = [{ head: 0, color: "#000000" }, { head: 1, color: "#ffffff" }, { head: 2, color: "#ff0000" }, { head: 3, color: "#0000ff" }];
const greys = H.hzAssign(["#000000", "#404040", "#c0c0c0", "#ffffff"], four);
assert.deepStrictEqual([...greys.values()].map((x) => x.head).sort(), [0, 1, 2, 3], "four colours, four heads");
assert.strictEqual(greys.get("#000000").head, 0);
assert.strictEqual(greys.get("#ffffff").head, 1);
assert.strictEqual(H.hzAssign(["#000000"], [{ head: 0, color: null }]), null, "no spool known");
// A 3MF object on its own extruder starts with it.
const own = H.hzFromFile([{ z: 0.5, ext: 1, kind: "auto" }], { 1: "#000000", 2: "#ffffff" }, hcl, four, 2);
assert.strictEqual(own.plan.base, 1, "the object's extruder 2, white");
assert.strictEqual(own.plan.baseHex, "#ffffff");
assert.strictEqual(own.plan.changes[0].head, 0);

// Saved with the plate: the list for Orca (a pause on the head in force),
// the plan read back while the file's list is still the one saved.
const saving = { base: 1, changes: [{ z: 0.48, head: 2, kind: "auto" }, { z: 0.8, head: 2, kind: "pause" }, { z: 1.2, head: 0, kind: "auto" }], layers: null, src: null };
const toFile = H.hzToFile(saving, (h) => h + 1);
assert.deepStrictEqual(toFile, [{ z: 0.48, extruder: 3, kind: "auto" }, { z: 0.8, extruder: 3, kind: "pause" }, { z: 1.2, extruder: 1, kind: "auto" }]);
const fileHc = H.hcFromFile(toFile.map((c) => ({ ...c, z: Math.fround(c.z) })));
const check = H.hcKey(toFile.map((c) => ({ z: c.z, ext: c.extruder, kind: c.kind })));
assert.deepStrictEqual(H.hzFromSaved({ ...saving, check }, fileHc), { ...saving, warnings: [] }, "read back as saved");
assert.strictEqual(H.hzFromSaved({ ...saving, check }, fileHc.slice(1)), null, "edited elsewhere since: the file's list");
assert.strictEqual(H.hzFromSaved(null, fileHc), null);

// The head in force: a pause keeps the one before it (a change added after
// a pause goes on from there, not from the start).
assert.strictEqual(H.hzHeadAt(saving, Infinity), 0);
assert.strictEqual(H.hzHeadAt(saving, 0.8), 2, "at the pause");
assert.strictEqual(H.hzHeadAt(saving, 0.1), 1, "below the first change");
assert.strictEqual(H.hzHeadAt({ base: 1, changes: [{ z: 0.5, head: 3, kind: "auto" }, { z: 0.9, head: 3, kind: "pause" }] }, Infinity), 3);
// A head chosen by hand forgets what the import said of that colour only.
const said = [{ kind: "unloaded", hex: "#ff0000" }, { kind: "same", hex: "#00ff00", with: "#ff0000" }, { kind: "unloaded", hex: "#0000ff" }, { kind: "offline" }, { kind: "gap", z: 1, to: 1.04 }];
assert.deepStrictEqual(H.hzForget(said, "#ff0000"), [{ kind: "unloaded", hex: "#0000ff" }, { kind: "offline" }, { kind: "gap", z: 1, to: 1.04 }]);
// ...and keeps it at the rematch, the other colours going to their heads.
const byHand = { base: 0, baseHex: "#000000", changes: [{ z: 0.5, head: 3, hex: "#ffffff", kind: "auto", hand: true }, { z: 1, head: 0, hex: "#ff0000", kind: "auto" }], warnings: [{ kind: "offline" }] };
const rh = H.hzRematch(byHand, four);
assert.strictEqual(rh.changes[0].head, 3, "chosen by hand: kept");
assert.strictEqual(rh.changes[1].head, 2, "red to the red spool");
assert.strictEqual(rh.base, 0);
// A colour change (M600): to the head holding that colour, else a pause.
assert.deepStrictEqual(H.hcFromFile([{ z: 0.8, extruder: 1, kind: "pause", color: "#ff0000" }, { z: 1, extruder: 1, kind: "pause" }]), [
  { z: 0.8, ext: 1, kind: "pause", swap: "#ff0000" },
  { z: 1, ext: 1, kind: "pause" },
]);
const m600 = H.hzFromFile([{ z: 0.8, ext: 1, kind: "pause", swap: "#fe0101" }, { z: 1.2, ext: 1, kind: "pause", swap: "#123456" }], { 1: "#000000" }, null, four);
assert.deepStrictEqual(m600.plan.changes.map((c) => [c.kind, c.head]), [["auto", 2], ["pause", 2]], "red loaded on head 2; #123456 nowhere: swapped by hand");
const m600off = H.hzFromFile([{ z: 0.8, ext: 1, kind: "pause", swap: "#ff0000" }], { 1: "#000000" }, null, [{ head: 0, color: null }]);
assert.strictEqual(m600off.plan.changes[0].kind, "pause", "spools unknown: a pause for now");
const m600re = H.hzRematch({ ...m600off.plan, warnings: m600off.warnings }, four);
assert.deepStrictEqual([m600re.changes[0].kind, m600re.changes[0].head], ["auto", 2], "...a head change once they are");
assert.strictEqual(H.hzSwap({ z: 1, head: 0, kind: "pause", swap: "#ff0000", hand: true }, four).kind, "pause", "a pause put by hand stays");

// Changes the objects never reach: left out of the slice.
assert.deepStrictEqual(H.hzRequest(saving, [{ base: [1] }], { top: 1.0 }).changes.map((c) => c.z), [0.48, 0.8], "1.2 above a 1 mm object");
assert.strictEqual(H.hzRequest(saving, [{ base: [1] }], { top: 0 }).changes.length, 3, "top unknown: all kept");
assert.ok(H.hzAbove(1.0, 1.0) && !H.hzAbove(0.96, 1.0));
// ...and their heads are not the slice's (sheet, empty-head check, tower).
const high = { base: 0, changes: [{ z: 0.48, head: 1, kind: "auto" }, { z: 30, head: 2, kind: "auto" }] };
assert.deepStrictEqual(H.hzPlanHeads(high, 10), [0, 1], "T2 at 30 mm on a 10 mm object: never used");
assert.deepStrictEqual(H.hzPlanHeads(high), [0, 1, 2], "top unknown: all");
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
  baseHex: "#000000",
  changes: [{ z: 0.48, head: 2, kind: "auto", hex: "#ffffff" }, { z: 1.04, head: 2, kind: "pause" }],
  layers: hcl,
  src: "3mf",
});
assert.deepStrictEqual(fromF.warnings, [{ kind: "gap", z: 0.5, to: 0.48 }]);

// The printer never answered: no spool known, the heads follow the
// file's order and one warning says so, not one per colour.
const offline = [{ head: 0, color: null }, { head: 1, color: null }];
const offF = H.hzFromFile(
  [{ z: 0.48, ext: 2, kind: "auto" }, { z: 0.96, ext: 3, kind: "auto" }, { z: 1.2, ext: 5, kind: "auto" }],
  { 1: "#000000", 2: "#ffffff", 3: "#f5e663", 5: "#8c6239" },
  hcl,
  [],
);
assert.deepStrictEqual(offF.plan.base, 0);
assert.deepStrictEqual(offF.plan.changes.map((c) => c.head), [1, 2, 0], "in the file's order, on the four heads");
assert.deepStrictEqual(offF.warnings, [{ kind: "offline" }]);
const offD = H.hzFromDescribe(d, offline);
assert.deepStrictEqual([offD.plan.base, ...offD.plan.changes.map((c) => c.head)], [0, 1, 3, 2], "a describe's colours in its list's order");
assert.deepStrictEqual(offD.warnings, [{ kind: "offline" }]);

// Then the printer answers: each colour to its head, the colours no
// head holds said instead (with the describe's names), a pause keeps
// the head in force, the other warnings kept.
assert.strictEqual(H.hzRematch({ ...offD.plan, warnings: offD.warnings }, offline), null, "still none known");
const reD = H.hzRematch({ ...offD.plan, warnings: [...offD.warnings, { kind: "gap", z: 1.69, to: 1.68 }] }, heads);
assert.deepStrictEqual([reD.base, ...reD.changes.map((c) => c.head)], [fromD.plan.base, ...fromD.plan.changes.map((c) => c.head)], "as if imported online");
assert.deepStrictEqual(reD.warnings, [
  { kind: "gap", z: 1.69, to: 1.68 },
  { kind: "unloaded", name: "PLA Elegoo Yellow", hex: "#f5e663" },
  { kind: "same", hex: "#ffffff", name: "PLA Generic White", with: "#f5e663", withName: "PLA Elegoo Yellow" },
]);
const offP = H.hzFromFile([{ z: 0.48, ext: 3, kind: "auto" }, { z: 0.96, ext: 1, kind: "pause" }], { 1: "#ffffff", 3: "#8c6239" }, hcl, []).plan;
const reP = H.hzRematch(offP, heads);
assert.deepStrictEqual([reP.base, ...reP.changes.map((c) => c.head)], [2, 1, 1]);
assert.deepStrictEqual(reP.warnings, []);

// A layer typed: the top of that layer; the first is the start.
assert.strictEqual(H.hzLayerZ(5, 0.08, 0.16), 0.48);
assert.strictEqual(H.hzSnap(H.hzLayerZ(11, 0.08, 0.16), 0.08, 0.16).layer, 11, "back to the same layer");
assert.strictEqual(H.hzLayerZ(1, 0.08, 0.16), null);
assert.strictEqual(H.hzLayerZ(5, 0, 0.16), null);

// The slice settings a plan brings: a 3MF's own, among the sheet's keys.
assert.deepStrictEqual(H.hzPick({ layer_height: "0.08", wall_loops: "3", filament_colour: "#fff", x: "" }, ["layer_height", "wall_loops", "x", "y"]), { layer_height: "0.08", wall_loops: "3" });
assert.deepStrictEqual(H.hzPick(null, ["a"]), {});
// A describe's layers and full infill; a 3MF's settings win over its layers.
assert.deepStrictEqual(H.hzPlanSettings({ layers: { layer_height: 0.08, first_layer: 0.16 }, infill100: true }), {
  layer_height: "0.08", initial_layer_print_height: "0.16", sparse_infill_density: "100%",
});
assert.deepStrictEqual(H.hzPlanSettings({ layers: { layer_height: 0.08, first_layer: 0.16 }, settings: { layer_height: "0.08", initial_layer_print_height: "0.2", wall_loops: "3" } }), {
  layer_height: "0.08", initial_layer_print_height: "0.2", wall_loops: "3",
});
assert.deepStrictEqual(H.hzPlanSettings({ layers: null }), {});
assert.deepStrictEqual(H.hzPlanSettings(null), {});
// The quick settings among them.
assert.deepStrictEqual(H.hzQuick({ layer_height: "0.075", sparse_infill_density: "100%", wall_loops: "3", enable_support: "0", brim_type: "no_brim" }), {
  layer: 0.08, exact: false, infill: 100, walls: 3, supports: false, brim: false,
});
assert.strictEqual(H.hzQuick({ layer_height: "0.08" }).exact, true);
assert.deepStrictEqual(H.hzQuick({ enable_support: "1", brim_type: "outer_only" }), { supports: true, brim: true });
assert.deepStrictEqual(H.hzQuick({ brim_type: "auto_brim" }), {}, "Orca's default is not a choice");
// A file for the U1 keeps every setting; another printer's, not its machine's.
assert.strictEqual(H.hzForU1({ printer_model: "Snapmaker U1" }), true);
assert.strictEqual(H.hzForU1({ printer_model: "Bambu Lab P1S" }), false);
assert.strictEqual(H.hzForU1(null), false);
assert.ok(H.HZ_MACHINE_KEYS.has("line_width") && !H.HZ_MACHINE_KEYS.has("top_shell_layers"));
assert.deepStrictEqual(H.hzQuick({}), {});

// What the sheet remembers once the file's settings were applied: the
// person's from before, unless they changed one since.
const memo = {
  before: { process: "0.20mm Standard @U1", simple: { infill: 15, walls: 2, supports: true, brim: false }, adv: { seam_position: "back", ironing_type: "top" } },
  file: { process: "0.08mm Standard @U1", simple: { infill: 100, walls: 3 }, adv: { seam_position: "aligned", initial_layer_print_height: "0.16", top_shell_layers: "6" } },
};
assert.deepStrictEqual(
  H.hzMemo({ process: "0.08mm Standard @U1", simple: { infill: 100, walls: 4, supports: true, brim: false }, adv: { initial_layer_print_height: "0.16", top_shell_layers: "8", ironing_type: "top" } }, memo),
  { process: "0.20mm Standard @U1", simple: { infill: 15, walls: 4, supports: true, brim: false }, adv: { seam_position: "back", top_shell_layers: "8", ironing_type: "top" } },
);
assert.deepStrictEqual(H.hzMemo({ process: "0.12mm Standard @U1" }, memo), { process: "0.12mm Standard @U1" }, "a profile chosen since");
assert.deepStrictEqual(H.hzMemo({ adv: { a: "1" } }, null), { adv: { a: "1" } });

// The file's colour of each row: the start's, a change's, a pause's swap;
// none for a row made by hand. A spool far from it is marked.
{
  const plan = { base: 0, baseHex: "#000000", changes: [{ z: 1, head: 1, kind: "auto", hex: "#ffffff" }, { z: 2, head: 1, kind: "pause", swap: "#ff0000" }, { z: 3, head: 2, kind: "auto" }] };
  assert.strictEqual(H.hzWant(plan, -1), "#000000");
  assert.strictEqual(H.hzWant(plan, 0), "#ffffff");
  assert.strictEqual(H.hzWant(plan, 1), "#ff0000", "a pause names the colour to load");
  assert.strictEqual(H.hzWant(plan, 2), null, "added by hand");
  assert.strictEqual(H.hzWant({ base: 0, changes: [] }, -1), null, "a plan typed on an STL");
  assert.ok(H.hzFar("#ffffff", "#000000") && !H.hzFar("#ffffff", "#f4f4f4"));
  assert.ok(!H.hzFar("#ffffff", null) && !H.hzFar(null, "#000000"), "unknown: no mark");
}

console.log("test-heights: ok");
