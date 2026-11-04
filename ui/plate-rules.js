"use strict";
/* Build plate × material: does the pair go together?

   One data table, PLATE_RULES: per plate (its `curr_bed_type` value, as
   the engine and the slice sheet name it), per material family
   (`spMaterialFamily`: "PLA Matte" → "PLA"), a rule:
     - "warn" with a reason: the pair does not suit (the print may not
       stick, or the plate cannot take the bed temperature);
     - "glue" with a reason: it prints, with a thin layer of glue stick
       (to help it stick, or to keep it from bonding too hard and tearing
       the plate's surface when removed).
   A pair the table does not name is fine; an unknown plate or material
   says nothing: never guessed. Edited here without touching the logic;
   reviewed by the owner (PR #16). Pure, tested in scripts/test-plate.js.

   Reasons (`plate.why.*`):
     stick   it does not stick to this plate;
     heat    it needs a hotter bed than this plate takes;
     bond    it bonds too strongly and can damage the plate;
     grip    it needs help to stay down (warping). */

const PLATE_RULES = {
  // Textured PEI: grips most materials and lets them go once cooled.
  "Textured PEI Plate": {
    PA: ["glue", "grip"],
    PC: ["glue", "grip"],
    PP: ["warn", "stick"],
    PE: ["warn", "stick"],
  },
  // Smooth PEI ("High Temp Plate"): PETG and flexibles bond to it.
  "High Temp Plate": {
    PETG: ["glue", "bond"],
    PCTG: ["glue", "bond"],
    PET: ["glue", "bond"],
    TPU: ["glue", "bond"],
    TPE: ["glue", "bond"],
    PEBA: ["glue", "bond"],
    PA: ["glue", "grip"],
    PC: ["glue", "grip"],
    PP: ["warn", "stick"],
    PE: ["warn", "stick"],
  },
  // The U1's Graphic Effect plate: a printed surface, for PLA and PETG.
  "Graphic Effect Plate": {
    PETG: ["glue", "bond"],
    TPU: ["glue", "bond"],
    TPE: ["glue", "bond"],
    ABS: ["warn", "heat"],
    ASA: ["warn", "heat"],
    PC: ["warn", "heat"],
    PA: ["warn", "heat"],
    PP: ["warn", "stick"],
    PE: ["warn", "stick"],
  },
  // Smooth low-temperature plate.
  "Cool Plate": {
    PETG: ["glue", "bond"],
    PCTG: ["glue", "bond"],
    ABS: ["warn", "heat"],
    ASA: ["warn", "heat"],
    PC: ["warn", "heat"],
    PA: ["warn", "heat"],
    PP: ["warn", "stick"],
    PE: ["warn", "stick"],
  },
  "Textured Cool Plate": {
    ABS: ["warn", "heat"],
    ASA: ["warn", "heat"],
    PC: ["warn", "heat"],
    PA: ["warn", "heat"],
    PP: ["warn", "stick"],
    PE: ["warn", "stick"],
  },
  // Engineering plate: made to be used with glue.
  "Engineering Plate": {
    PLA: ["glue", "grip"],
    PETG: ["glue", "bond"],
    TPU: ["glue", "bond"],
    PA: ["glue", "grip"],
    PC: ["glue", "grip"],
    PP: ["warn", "stick"],
    PE: ["warn", "stick"],
  },
  // Supertack: holds without glue; flexibles and PETG bond too well.
  "Supertack Plate": {
    PETG: ["glue", "bond"],
    TPU: ["glue", "bond"],
    TPE: ["glue", "bond"],
    PP: ["warn", "stick"],
    PE: ["warn", "stick"],
  },
};

/* The rule for a material family on a plate: { level: "ok" | "warn" |
   "glue", reason }; "ok" (no reason) when the table says nothing. */
function plateRule(family, plate) {
  const r = PLATE_RULES[plate]?.[String(family || "").toUpperCase()];
  return r ? { level: r[0], reason: r[1] } : { level: "ok", reason: null };
}

/* The rules worth saying for a plate and the materials (families) that
   touch it: each family once, warnings first. [] for an unknown plate. */
function plateIssues(families, plate) {
  if (!plate || !PLATE_RULES[plate]) return [];
  const out = [];
  for (const f of new Set(families.filter(Boolean))) {
    const r = plateRule(f, plate);
    if (r.level !== "ok") out.push({ family: f, ...r });
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === "warn" ? -1 : 1));
}

/* "Don't show again", per kind of message: an incompatible pair, the glue
   tip, the glue reminder before a start, a plate other than the one the
   print was sliced for. Re-enabled in Settings › Prepare. */
const PLATE_HIDE_KEY = "snapstudio.plate.hide";
const PLATE_KINDS = ["pair", "glue", "reminder", "mismatch"];

function plateHidden(kind, store = typeof localStorage !== "undefined" ? localStorage : null) {
  try {
    return !!JSON.parse(store?.getItem(PLATE_HIDE_KEY) || "{}")[kind];
  } catch {
    return false;
  }
}
function plateSetHidden(kind, hidden, store = typeof localStorage !== "undefined" ? localStorage : null) {
  if (!store) return;
  let v = {};
  try {
    v = JSON.parse(store.getItem(PLATE_HIDE_KEY) || "{}") || {};
  } catch {}
  if (hidden) v[kind] = true;
  else delete v[kind];
  store.setItem(PLATE_HIDE_KEY, JSON.stringify(v));
}

/* What the start sheet adds for a print (pure): the plate it was sliced
   for (`sliced`) against the printer's (`printer`), the materials that
   will touch it. → { mismatch: { sliced, printer } | null, warn: [issues],
   glue: [issues] }, minus the kinds hidden. Unknown plates: nothing. */
function plateStartRows({ sliced = null, printer = null, families = [], hidden = () => false }) {
  const mismatch = sliced && printer && sliced !== printer && !hidden("mismatch") ? { sliced, printer } : null;
  const issues = plateIssues(families, printer);
  return {
    mismatch,
    warn: hidden("pair") ? [] : issues.filter((i) => i.level === "warn"),
    glue: hidden("reminder") ? [] : issues.filter((i) => i.level === "glue"),
  };
}

/* A spool on a head, as a key: a new key on a head is a new spool. */
const plateSpoolKey = (slot) =>
  slot?.present ? [slot.vendor, slot.kind, slot.sub_type, slot.color].map((x) => String(x || "").toLowerCase()).join("|") : "";

if (typeof module !== "undefined") {
  module.exports = { PLATE_RULES, PLATE_KINDS, PLATE_HIDE_KEY, plateRule, plateIssues, plateHidden, plateSetHidden, plateStartRows, plateSpoolKey };
}
