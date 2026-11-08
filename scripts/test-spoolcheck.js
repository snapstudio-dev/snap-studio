// node scripts/test-spoolcheck.js — spool check before sending.
const assert = require("assert");
const S = require("../ui/spoolcheck.js");

// Material families: case, suffixes, aliases.
for (const m of ["PLA", "pla", "PLA+", "PLA Matte", "PLA Silk", "PLA-CF", " pla basic "]) assert.equal(S.spMaterialFamily(m), "PLA", m);
assert.equal(S.spMaterialFamily("PETG"), "PETG");
assert.equal(S.spMaterialFamily("PETG-CF"), "PETG");
assert.equal(S.spMaterialFamily("PET"), "PET");
assert.equal(S.spMaterialFamily("PCTG"), "PCTG");
assert.equal(S.spMaterialFamily("PC"), "PC");
assert.equal(S.spMaterialFamily("Nylon"), "PA");
assert.equal(S.spMaterialFamily("PA12-CF"), "PA");
assert.equal(S.spMaterialFamily("TPU 95A"), "TPU");
assert.equal(S.spMaterialFamily(""), "");
assert.equal(S.spMaterialFamily("?"), "");
assert.equal(S.spMaterialFromName("Snapmaker PLA SnapSpeed @U1"), "PLA");
assert.equal(S.spMaterialFromName("Generic PETG @Snapmaker U1"), "PETG");
assert.equal(S.spMaterialFromName("Mon profil"), "");

// Colors: small differences tolerated, clear ones not.
assert.ok(S.spColorDelta("#ff0000", "#f01010") < S.SP_COLOR_TOL);
assert.ok(S.spColorDelta("#FFFFFF", "#f4f4f0FF") < S.SP_COLOR_TOL, "white / off-white, RGBA accepted");
assert.ok(S.spColorDelta("#ff0000", "#000000") > S.SP_COLOR_TOL);
assert.ok(S.spColorDelta("#0047ab", "#00a651") > S.SP_COLOR_TOL, "blue / green");
assert.ok(S.spColorDelta("#e01010", "#c81e1e") < S.SP_COLOR_TOL, "two reds of different brands");
assert.ok(S.spColorDelta("#1a1a1a", "#000000") < S.SP_COLOR_TOL, "two blacks");
assert.ok(S.spColorDelta("#7a3fd0", "#1144dd") > S.SP_COLOR_TOL, "violet / blue (CIE76 put them at 19)");
assert.ok(S.spColorDelta("#ffffff", "#c0c0c0") > S.SP_COLOR_TOL, "white / silver");
assert.equal(S.spColorDelta("", "#000000"), Infinity);

const slots = [
  { index: 0, present: true, kind: "PLA", sub_type: "Matte", color: "#ffffff", vendor: "Snapmaker" },
  { index: 1, present: true, kind: "PLA", sub_type: "", color: "#e01010" },
  { index: 2, present: true, kind: "PETG", sub_type: "", color: "#000000" },
  { index: 3, present: false, kind: "", color: null },
];

// Expected: slice-time spool colors and profile types win, G-code fills gaps.
const exp = S.spExpected({
  tools: [0, 2, 2],
  profile: { filaments: ["Snapmaker PLA @U1", "x", "Generic PLA @U1"], colors: ["#FFFFFF", null, "#ff0000"] },
  stats: { filament_types: ["PLA", "PLA", ""], filament_colors: ["#000000", "", "#00ff00"] },
});
assert.deepEqual(exp, [{ tool: 0, material: "PLA", color: "#ffffff" }, { tool: 2, material: "PLA", color: "#ff0000" }]);
assert.deepEqual(S.spExpected({ tools: [], stats: { filament_types: ["PETG"], filament_colors: ["#123456"] } }), [{ tool: 0, material: "PETG", color: "#123456" }]);
assert.equal(S.spExpected({ tools: [1], profile: { filaments: ["", "Mine"] }, ftypeOf: (n) => (n === "Mine" ? "TPU" : "") })[0].material, "TPU");
// Sliced without a printer: no spool color, and the presets' default
// colors in the G-code are not a choice.
assert.equal(S.spExpected({ tools: [0], profile: { filaments: ["Generic PLA"], colors: [null] }, stats: { filament_colors: ["#c0c0c0"] } })[0].color, "");

// T2: red PLA expected, black PETG loaded → material and color. T0 fits. T1, T3 unused: ignored.
let mm = S.spMismatches(exp, slots);
assert.equal(mm.length, 1);
assert.equal(mm[0].tool, 2);
assert.deepEqual(mm[0].reasons, ["material", "color"]);
// Same material, near color: no warning.
assert.equal(S.spMismatches([{ tool: 1, material: "PLA", color: "#ff0000" }], slots).length, 0);
// Only the color differs.
assert.deepEqual(S.spMismatches([{ tool: 0, material: "PLA", color: "#ff0000" }], slots)[0].reasons, ["color"]);
// Unknown expectations: nothing to compare.
assert.equal(S.spMismatches([{ tool: 2, material: "", color: "" }], slots).length, 0);
// Empty heads are warnings; a head the printer does not report is unknown.
assert.deepEqual(S.spMismatches([{ tool: 3, material: "PLA", color: "" }], slots)[0].reasons, ["empty"]);
assert.deepEqual(S.spMismatches([{ tool: 3, material: "PLA", color: "" }], [])[0].reasons, ["unknown"]);
// A loaded spool whose material is unknown: only its color is compared.
assert.equal(S.spMismatches([{ tool: 0, material: "PLA", color: "#ffffff" }], [{ index: 0, present: true, kind: "", color: "#fcfcfc" }]).length, 0);
assert.deepEqual(S.spMismatches([{ tool: 0, material: "PLA", color: "#ffffff" }], [{ index: 0, present: true, kind: "", color: "#000000" }])[0].reasons, ["color"]);

// Substitution: T2 → head 1 (red PLA) clears the warning.
assert.equal(S.spSuggest(exp[1], slots, new Set([0])), 1);
assert.equal(S.spSuggest(exp[1], slots, new Set([0, 1])), null, "head 1 taken");
const map = S.spRemap([0, 2], { 2: 1 });
assert.deepEqual(map, [[2, 1]]);
assert.equal(S.spMismatches(exp, slots, map).length, 0);
assert.equal(S.spHeadOf(2, map), 1);
assert.equal(S.spHeadOf(0, map), 0);
// Keeping its own head is no change.
assert.deepEqual(S.spRemap([0, 2], { 2: 2 }), []);
assert.deepEqual(S.spRemap([0, 2], {}), []);
// Swap is fine; two tools on one head, or a head that does not exist, are not.
assert.deepEqual(S.spRemap([0, 1], { 0: 1, 1: 0 }), [[0, 1], [1, 0]]);
assert.throws(() => S.spRemap([0, 2], { 2: 0 }), /two tools/);
assert.throws(() => S.spRemap([0], { 0: 4 }), /no head/);
// Picks of tools the print does not use are ignored.
assert.deepEqual(S.spRemap([0], { 3: 1 }), []);

// ---------------------------------------------------------------- default choices
const slots4 = [...slots.slice(0, 3), { index: 3, present: true, kind: "PLA", color: "#1144dd" }];
const white = { tool: 0, material: "PLA", color: "#ffffff" };
// A blue expected on T1 (red loaded): the blue PLA on head 3, unused by the print, takes it.
assert.deepEqual(S.spDefaults([white, { tool: 1, material: "PLA", color: "#1040e0" }], slots4), { 0: 0, 1: 3 });
// Violet expected, no violet loaded: T1 keeps its own spool (the user may change it).
assert.deepEqual(S.spDefaults([white, { tool: 1, material: "PLA", color: "#b0309a" }], slots4), { 0: 0, 1: 1 });
// A head of the print is never taken as a substitute by default: T0 stays white.
assert.deepEqual(S.spDefaults([white, { tool: 1, material: "PLA", color: "#ffffff" }], slots4), { 0: 0, 1: 1 });
// Own head empty, nothing fits: no choice, the user picks one.
assert.deepEqual(S.spDefaults([{ tool: 3, material: "PLA", color: "#b0309a" }], slots), { 3: null });
// Own head empty, a fitting spool elsewhere: taken.
assert.deepEqual(S.spDefaults([{ tool: 3, material: "PETG", color: "#000000" }], slots), { 3: 2 });

// Bonding between materials (the prime tower, #35; the plate, #16).
assert.equal(S.spBonds("PLA", "PLA"), true, "same family");
assert.equal(S.spBonds("PLA Matte", "PLA+ Silk"), true, "variants of a family");
assert.equal(S.spBonds("PLA", "PETG"), false);
assert.equal(S.spBonds("PETG", "PLA"), false, "either way round");
assert.equal(S.spBonds("PLA", "TPU 95A"), false);
assert.equal(S.spBonds("PETG HF", "flex"), false, "an alias (FLEX → TPU)");
assert.equal(S.spBonds("ABS", "ASA"), true, "close families bond");
assert.equal(S.spBonds("PA", "PC"), null, "not known: never warned about");
assert.equal(S.spBonds("", "PLA"), null);
assert.equal(S.spBonds("?", "PLA"), null);

// The prime tower's advice.
const h = (n, material) => ({ n, material });
assert.equal(S.spTowerAdvice({ tower: false, heads: [h(0, "PLA"), h(1, "PETG")] }), null, "no tower, nothing to say");
assert.equal(S.spTowerAdvice({ tower: true, heads: [h(0, "PLA")] }), null, "one head");
assert.equal(S.spTowerAdvice({ tower: true, heads: [h(0, "PLA"), h(1, "PLA Matte")] }), null, "they bond");
assert.equal(S.spTowerAdvice({ tower: true, heads: [h(0, "PLA"), h(1, "")] }), null, "a material not known");
assert.equal(S.spTowerAdvice({ tower: true, heads: [h(0, "PA"), h(1, "PC")] }), null, "a pair not known");
let a = S.spTowerAdvice({ tower: true, heads: [h(0, "PLA"), h(2, "PETG"), h(3, "PLA Silk")] });
assert.equal(a.state, "conflict");
assert.deepEqual(a.pairs, [[0, 2], [2, 3]]);
assert.deepEqual(a.families, [{ family: "PLA", heads: [0, 3] }, { family: "PETG", heads: [2] }], "in the plate's order");
a = S.spTowerAdvice({ tower: true, wall: 0, heads: [h(0, "PLA"), h(2, "PETG")] });
assert.equal(a.state, "walled", "the outer wall in one material: said, not urged");
assert.equal(S.spTowerAdvice({ tower: true, wall: 1, heads: [h(0, "PLA"), h(2, "PETG")] }).state, "conflict", "a wall head the plate does not use");

console.log("spoolcheck.js OK");
