// Build plate × material rules (ui/plate-rules.js): every pair of the
// table, the start sheet's rows, "Don't show again", spool keys.
const assert = require("assert");
const R = require("../ui/plate-rules.js");
const S = require("../ui/spoolcheck.js");

const PLATES = ["Textured PEI Plate", "High Temp Plate", "Graphic Effect Plate", "Cool Plate", "Textured Cool Plate", "Engineering Plate", "Supertack Plate"];
const FAMILIES = ["PLA", "PETG", "PCTG", "PET", "ABS", "ASA", "TPU", "TPE", "PEBA", "PVA", "BVOH", "HIPS", "PA", "PC", "PP", "PE", "PPS", "PPSU", "PEEK", "PEI"];

// Every plate the slice sheet offers has its rules, and only those.
assert.deepStrictEqual(Object.keys(R.PLATE_RULES).sort(), [...PLATES].sort());
const LEVELS = new Set(["warn", "glue"]), REASONS = new Set(["stick", "heat", "bond", "grip"]);
for (const [plate, rules] of Object.entries(R.PLATE_RULES)) {
  for (const [fam, [level, reason]] of Object.entries(rules)) {
    assert.ok(FAMILIES.includes(fam), `${plate}: ${fam} is a material family`);
    assert.strictEqual(S.spMaterialFamily(fam), fam, `${fam}: what spMaterialFamily gives`);
    assert.ok(LEVELS.has(level) && REASONS.has(reason), `${plate} × ${fam}: ${level} ${reason}`);
  }
}
// Every pair: what the table says, "ok" otherwise.
for (const plate of PLATES) {
  for (const fam of FAMILIES) {
    const want = R.PLATE_RULES[plate][fam];
    assert.deepStrictEqual(R.plateRule(fam, plate), want ? { level: want[0], reason: want[1] } : { level: "ok", reason: null }, `${plate} × ${fam}`);
  }
}

// The cases the PR started from.
assert.deepStrictEqual(R.plateRule("PETG", "High Temp Plate"), { level: "glue", reason: "bond" }, "PETG on smooth PEI: glue as a release");
assert.deepStrictEqual(R.plateRule("TPU", "High Temp Plate"), { level: "glue", reason: "bond" });
assert.deepStrictEqual(R.plateRule("PLA", "Textured PEI Plate"), { level: "ok", reason: null });
assert.deepStrictEqual(R.plateRule("ABS", "Graphic Effect Plate"), { level: "warn", reason: "heat" });
// Through the family: "PETG HF", "pla matte".
assert.strictEqual(R.plateRule(S.spMaterialFamily("PETG HF"), "High Temp Plate").level, "glue");
assert.strictEqual(R.plateRule(S.spMaterialFamily("pla matte"), "High Temp Plate").level, "ok");
// Unknown plate or material: nothing, never guessed.
assert.strictEqual(R.plateRule("PETG", "Some Other Plate").level, "ok");
assert.strictEqual(R.plateRule("", "High Temp Plate").level, "ok");
assert.strictEqual(R.plateRule(undefined, undefined).level, "ok");
assert.deepStrictEqual(R.plateIssues(["PETG"], null), []);
assert.deepStrictEqual(R.plateIssues(["PETG"], "Unknown"), []);

// Issues: each family once, warnings first.
assert.deepStrictEqual(R.plateIssues(["PETG", "ABS", "PETG", "PLA", ""], "Graphic Effect Plate").map((i) => `${i.level} ${i.family}`), ["warn ABS", "glue PETG"]);

// "Don't show again", per kind, in a store.
{
  const m = new Map();
  const store = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
  assert.strictEqual(R.plateHidden("glue", store), false);
  R.plateSetHidden("glue", true, store);
  assert.strictEqual(R.plateHidden("glue", store), true);
  assert.strictEqual(R.plateHidden("pair", store), false, "per kind");
  R.plateSetHidden("glue", false, store);
  assert.strictEqual(R.plateHidden("glue", store), false, "re-enabled");
  m.set(R.PLATE_HIDE_KEY, "{oops");
  assert.strictEqual(R.plateHidden("glue", store), false, "a broken value hides nothing");
  assert.deepStrictEqual(R.PLATE_KINDS, ["pair", "glue", "reminder", "mismatch"]);
}

// The start sheet's rows.
{
  const none = () => false;
  const r = R.plateStartRows({ sliced: "Textured PEI Plate", printer: "High Temp Plate", families: ["PETG", "PLA"], hidden: none });
  assert.deepStrictEqual(r.mismatch, { sliced: "Textured PEI Plate", printer: "High Temp Plate" });
  assert.deepStrictEqual(r.warn, []);
  assert.deepStrictEqual(r.glue.map((i) => i.family), ["PETG"], "the glue reminder");
  // Unset printer plate: nothing compared, nothing said.
  assert.deepStrictEqual(R.plateStartRows({ sliced: "High Temp Plate", printer: null, families: ["PETG"], hidden: none }), { mismatch: null, warn: [], glue: [] });
  // Unknown sliced plate (an old G-code): the pair is still checked.
  assert.deepStrictEqual(R.plateStartRows({ sliced: null, printer: "Graphic Effect Plate", families: ["ASA"], hidden: none }).warn.map((i) => i.family), ["ASA"]);
  // Same plate: no mismatch.
  assert.strictEqual(R.plateStartRows({ sliced: "High Temp Plate", printer: "High Temp Plate", families: [], hidden: none }).mismatch, null);
  // Hidden kinds stay out.
  const hidden = (k) => k === "mismatch" || k === "reminder";
  const h = R.plateStartRows({ sliced: "Textured PEI Plate", printer: "Graphic Effect Plate", families: ["PETG", "ABS"], hidden });
  assert.deepStrictEqual([h.mismatch, h.warn.map((i) => i.family), h.glue], [null, ["ABS"], []]);
}

// A new spool on a head: a new key; an empty head: none.
assert.strictEqual(R.plateSpoolKey({ present: false, kind: "PLA" }), "");
assert.strictEqual(R.plateSpoolKey(null), "");
assert.strictEqual(R.plateSpoolKey({ present: true, vendor: "Generic", kind: "PETG", sub_type: "HF", color: "#FF0000" }), "generic|petg|hf|#ff0000");
assert.notStrictEqual(
  R.plateSpoolKey({ present: true, kind: "PLA", color: "#ffffff" }),
  R.plateSpoolKey({ present: true, kind: "PLA", color: "#000000" }),
  "another color: another spool"
);

console.log("plate: ok");
