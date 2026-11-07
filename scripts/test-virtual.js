// node scripts/test-virtual.js — virtual heads: values, cadences, orphans,
// unloading, what the engine gets.
const assert = require("assert");
const V = require("../ui/virtual-logic.js");

// Values: 100 + uid, never a physical head.
assert.strictEqual(V.vhValue(3), 103);
assert.strictEqual(V.vhUid(103), 3);
for (const h of [0, 3, 15, "2", null, undefined, "", 99.5]) assert.strictEqual(V.vhIs(h), false, String(h));
for (const h of [100, 103, "105"]) assert.strictEqual(V.vhIs(h), true, String(h));

const list = [{ uid: 3, a: 0, b: 2, pct: 33 }, { uid: 5, a: 3, b: 1, pct: 50 }];
assert.deepStrictEqual(V.vhFind(list, 103), list[0]);
assert.strictEqual(V.vhFind(list, 104), null);
assert.strictEqual(V.vhFind(list, 2), null, "a physical head is not a virtual one");
// Orphans: a virtual value whose head is gone.
assert.strictEqual(V.vhOrphan(list, 104), true);
assert.strictEqual(V.vhOrphan(list, 103), false);
assert.strictEqual(V.vhOrphan(list, 2), false);
assert.strictEqual(V.vhOrphan([], 103), true);
// Names by order among the current ones.
assert.strictEqual(V.vhName(list, 103), "V1");
assert.strictEqual(V.vhName(list, 105), "V2");
assert.strictEqual(V.vhName(list.slice(1), 105), "V1", "renamed when V1 goes");
assert.strictEqual(V.vhName(list, 104), "");

// Notches ↔ shares ↔ Orca's cadences (compute_gradient_ratios).
assert.deepStrictEqual(V.VH_PCTS, [20, 25, 33, 50, 67, 75, 80]);
const cad = [[4, 1], [3, 1], [2, 1], [1, 1], [1, 2], [1, 3], [1, 4]];
V.VH_PCTS.forEach((p, i) => {
  assert.strictEqual(V.vhPct(i + 1), p);
  assert.strictEqual(V.vhNotch(p), i + 1);
  assert.deepStrictEqual(V.vhCadence(p), cad[i], `${p} %`);
});
assert.strictEqual(V.vhPct(0), 20, "bounded");
assert.strictEqual(V.vhPct(9), 80);
// In between, as Orca rounds major / minor: 60 % and 67 % both give 1:2,
// 40 % (1.5) gives 2:1.
assert.deepStrictEqual(V.vhCadence(60), [1, 2]);
assert.deepStrictEqual(V.vhCadence(40), [2, 1]);
assert.deepStrictEqual(V.vhCadence(10), [9, 1]);
assert.deepStrictEqual(V.vhCadence(0), [1, 0]);
assert.deepStrictEqual(V.vhCadence(100), [0, 1]);
assert.strictEqual(V.vhNotch(60), 5, "the nearest notch");
assert.strictEqual(V.vhRatio(33), "2:1");
assert.strictEqual(V.vhShare(33), 1 / 3, "a third of the layers are B's");
assert.strictEqual(V.vhShare(50), 0.5);

// The plate's physical heads: a virtual one gives its two, an orphan none.
assert.deepStrictEqual([...V.vhPhysical(new Set([103]), list)].sort(), [0, 2]);
assert.deepStrictEqual([...V.vhPhysical(new Set([1, 103, 105]), list)].sort(), [0, 1, 2, 3]);
assert.deepStrictEqual([...V.vhPhysical(new Set([104, 1]), list)], [1], "an orphan prints nothing");

// Duplicates: the same pair at the same cadence, either way round.
assert.strictEqual(V.vhDuplicate(list, { a: 0, b: 2, pct: 33 }), list[0]);
assert.strictEqual(V.vhDuplicate(list, { a: 2, b: 0, pct: 67 }), list[0], "swapped sides, same mix");
assert.strictEqual(V.vhDuplicate(list, { a: 0, b: 2, pct: 50 }), null, "another cadence");
assert.strictEqual(V.vhDuplicate(list, { a: 0, b: 2, pct: 33 }, 3), null, "itself, when editing");
assert.strictEqual(V.vhDuplicate(list, { a: 1, b: 3, pct: 50 }), list[1]);

// The limit.
assert.strictEqual(V.VH_MAX, 8);
assert.strictEqual(V.vhCanAdd(Array.from({ length: 7 }, (_, i) => ({ uid: i }))), true);
assert.strictEqual(V.vhCanAdd(Array.from({ length: 8 }, (_, i) => ({ uid: i }))), false);

// What can be mixed: heads holding a spool whose color is read.
assert.deepStrictEqual(V.vhLoaded([{ index: 0, present: true, color: "#00ffff" }, { index: 1, present: true }, { index: 2, present: false }, { index: 3, present: true, color: "#ffff00" }]), [0, 3]);

// Unloading: only a read saying a spool is out deletes.
const full = [0, 1, 2, 3].map((i) => ({ index: i, present: true, color: "#123456" }));
const out2 = full.map((s) => (s.index === 2 ? { ...s, present: false } : s));
let gone = V.vhUnloaded(list, out2);
assert.deepStrictEqual(gone.map((g) => g.v.uid), [3], "T2 out: V1 (T0 + T2) goes");
assert.deepStrictEqual(gone[0].out, [2]);
assert.deepStrictEqual(V.vhUnloaded(list, []), [], "offline: nothing read, nothing deleted");
assert.deepStrictEqual(V.vhUnloaded(list, null), []);
assert.deepStrictEqual(V.vhUnloaded(list, full), [], "everything loaded");
const both = full.map((s) => ({ ...s, present: s.index === 1 }));
assert.deepStrictEqual(V.vhUnloaded(list, both).map((g) => g.v.uid), [3, 5], "several at once");
assert.deepStrictEqual(V.vhUnloaded(list, both)[0].out, [0, 2], "both components out");
assert.deepStrictEqual(V.vhUnloaded(list, full.slice(0, 3)).map((g) => g.v.uid), [5], "a printer with fewer heads");
// A spool swapped for another (still present) keeps it.
assert.deepStrictEqual(V.vhUnloaded(list, full.map((s) => ({ ...s, color: "#ff0000" }))), []);

// The engine: the used virtual heads in uid order, after the physical ones.
const e = V.vhEngine(new Set([105, 1, 103, 104]), list, 4);
assert.deepStrictEqual(e.heads.map((v) => v.uid), [3, 5], "stable order, orphans left out");
assert.strictEqual(e.index(103), 4, "the first: head 4, the engine's filament 5");
assert.strictEqual(e.index(105), 5);
assert.strictEqual(e.index(1), 1, "a physical head as it is");
assert.strictEqual(e.index(104), null, "an orphan: none");
assert.deepStrictEqual(V.vhEngine(new Set([0, 2]), list, 4).heads, [], "no virtual head used");

// The stand-in mix: the ends are the colors, blue + yellow is not grey.
assert.strictEqual(V.vhMixLinear("#0000ff", "#ffff00", 0), "#0000ff");
assert.strictEqual(V.vhMixLinear("#0000ff", "#ffff00", 1), "#ffff00");
assert.match(V.vhMixLinear("#002185", "#fcd300", 0.5), /^#[0-9a-f]{6}$/);

// Contrast: relative luminance apart (WCAG), from 0.5 on a warning.
assert.strictEqual(V.VH_CONTRAST_WARN, 0.5);
assert.strictEqual(V.vhContrast("#000000", "#ffffff"), 1, "black and white: the most");
assert.strictEqual(V.vhContrastWarn("#ffffff", "#000000"), true);
assert.strictEqual(V.vhContrastWarn("#FFFFFF", "#d3d3d3"), false, "white and light gray mix well");
assert.strictEqual(V.vhContrast("#3a6ea5", "#3a6ea5"), 0, "the same color");
assert.strictEqual(V.vhContrastWarn("#3a6ea5", "#3a6ea5"), false);
assert.ok(V.vhContrast("#ff0000", "#ffff00") > 0.5 && V.vhContrastWarn("#ff0000", "#ffff00"), "red and yellow: far apart in light");
assert.ok(!V.vhContrastWarn("#00aeef", "#e4007c"), "cyan and magenta: close enough");
for (const bad of ["", null, undefined, "#fff", "#12345g", "rgb(0,0,0)"]) {
  assert.strictEqual(V.vhContrast(bad, "#000000"), null, String(bad));
  assert.strictEqual(V.vhContrastWarn("#ffffff", bad), false, "a color not read never warns: " + bad);
}

// Smooth mix: the plate's switch, on unless it says otherwise; it matters
// only with a virtual head on the plate.
assert.strictEqual(V.vhSmoothOn(null), true, "a new plate");
assert.strictEqual(V.vhSmoothOn({}), true, "an older plate, saved before");
assert.strictEqual(V.vhSmoothOn({ smoothMix: true }), true);
assert.strictEqual(V.vhSmoothOn({ smoothMix: false }), false);
assert.strictEqual(V.vhSmoothOn(JSON.parse(JSON.stringify({ smoothMix: V.vhSmoothOn({ smoothMix: false }) }))), false, "saved and read back");
assert.strictEqual(V.vhUsesVirtual(new Set([0, 2]), list), false, "physical heads only");
assert.strictEqual(V.vhUsesVirtual(new Set([0, 103]), list), true);
assert.strictEqual(V.vhUsesVirtual(new Set([104]), list), false, "an orphan is no virtual head");
assert.strictEqual(V.vhUsesVirtual(null, list), false);

console.log("virtual: ok");
