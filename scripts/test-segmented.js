// node scripts/test-segmented.js — segmented controls and language flags.
const assert = require("assert");
const S = require("../ui/segmented-logic.js");

// Segments from options: the chosen one on, the first when none matches.
const opts = [{ value: "zoom", text: " Zoom " }, { value: "pan", text: "Pan the view" }, { value: "orbit", text: "Orbit", disabled: true }];
assert.deepStrictEqual(S.segItems(opts, "pan").map((x) => x.on), [false, true, false]);
assert.deepStrictEqual(S.segItems(opts, "pan").map((x) => x.label), ["Zoom", "Pan the view", "Orbit"], "trimmed text");
assert.deepStrictEqual(S.segItems(opts, "nope").map((x) => x.on), [true, false, false], "as a select: its first option");
assert.deepStrictEqual(S.segItems(opts, null).map((x) => x.on), [true, false, false]);
assert.strictEqual(S.segItems(opts, "orbit")[2].disabled, true);
assert.deepStrictEqual(S.segItems([], "x"), []);
// Numbers as a select gives them: strings.
assert.deepStrictEqual(S.segItems([{ value: 0.5, text: "0.5×" }, { value: 1, text: "1×" }], 1).map((x) => [x.value, x.on]), [["0.5", false], ["1", true]]);
assert.strictEqual(S.segItems([{ value: "a", label: "A", text: "ignored" }], "a")[0].label, "A", "label wins over text");

// The slice sheet's level (adv-logic.js SL_LEVELS): two segments, the
// saved one on.
const A = require("../ui/adv-logic.js");
const levels = A.SL_LEVELS.map((v) => ({ value: v, text: v === "basic" ? "Basic" : "Advanced" }));
assert.deepStrictEqual(S.segItems(levels, "basic").map((x) => [x.value, x.on]), [["basic", true], ["advanced", false]]);
assert.deepStrictEqual(S.segItems(levels, "advanced").map((x) => x.on), [false, true]);

// Flags: inline SVG for the app's languages, the code otherwise.
for (const c of ["fr", "en", "FR"]) assert.ok(/^<svg[^>]*aria-hidden="true"/.test(S.segFlag(c)), c);
assert.ok(!/id=/.test(S.SEG_FLAGS.en + S.SEG_FLAGS.fr), "no ids: the flags appear several times");
assert.ok(/>NL</.test(S.segFlag("nl")), "no flag: its code");
for (const c of ["de", "es", "pt-BR", "it", "ja", "zh-Hans", "ko"]) assert.ok(/^<svg/.test(S.segFlag(c)), `${c} has its flag`);
assert.ok(!/id=/.test(Object.values(S.SEG_FLAGS).join("")), "no ids in any flag");
assert.ok(/>X</.test(S.segFlag("<x>")) && !/<x/.test(S.segFlag("<x>")), "only letters of the code");
assert.strictEqual(S.segFlagMode(2), "pills");
assert.strictEqual(S.segFlagMode(S.SEG_FLAG_MAX), "pills");
assert.strictEqual(S.segFlagMode(S.SEG_FLAG_MAX + 1), "popover");

// Filters narrowing a list.
assert.strictEqual(S.segActive({ kind: "all", state: "all", engine: "all" }), 0);
assert.strictEqual(S.segActive({ kind: "create", state: "all", engine: "local" }), 2);
assert.strictEqual(S.segActive({}), 0);
assert.strictEqual(S.segActive(null), 0);

// A value the list does not offer, kept as a chosen, disabled extra option
// (slice-adv.js): its segment is the one on, not the first.
assert.deepStrictEqual(S.segItems([{ value: "a", text: "A" }, { value: "b", text: "B" }, { value: "x", text: "Unknown value: x", disabled: true }], "x").map((x) => [x.on, x.disabled]), [[false, false], [false, false], [true, true]]);

console.log("segmented: ok");
