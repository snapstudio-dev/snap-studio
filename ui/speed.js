"use strict";
/* Speed adjustment of the slice sheet: one percentage of the profile.

   With f = percentage / 100, the print speeds are multiplied by f and the
   accelerations by f², so a move keeps its shape, only slower. Bridges
   only slow down (never faster than the profile), and the first layer and
   travel moves stay as they are unless their switch is on (then they only
   slow down, too). Above 100 %, nothing goes past the machine's limits.
   Speeds are rounded down to 1 mm/s, accelerations to 10 mm/s².

   Each row of the ⚙ panel follows the global percentage until a value is
   typed by hand: the row is then detached and keeps that value (its other
   keys follow in proportion) until it is linked again or reset.

   Only values that differ from the profile are sent: at 100 % with nothing
   edited, nothing is sent and the G-code is the profile's.

   Pure functions, tested by scripts/test-speed.js. */

const SPD_MIN = 50, SPD_MAX = 120, SPD_STEP = 5, SPD_DEFAULT = 100;
const SPD_MARKS = [
  { v: 50, t: "slice.speed.mark.very_safe" },
  { v: 75, t: "slice.speed.mark.safe" },
  { v: 100, t: "slice.speed.mark.profile" },
  { v: 120, t: "slice.speed.mark.fast" },
];

/* Rows of the panel: the first key is the one shown, the others follow it.
   `slow`: only below 100 %. `opt`: only when that switch is on. */
const SPD_ROWS = [
  { id: "outer", t: "slice.speed.row.outer", keys: ["outer_wall_speed"] },
  { id: "inner", t: "slice.speed.row.inner", keys: ["inner_wall_speed"] },
  { id: "infill", t: "slice.speed.row.infill", keys: ["sparse_infill_speed", "internal_solid_infill_speed", "gap_infill_speed"] },
  { id: "top", t: "slice.speed.row.top", keys: ["top_surface_speed"] },
  { id: "support", t: "slice.speed.row.support", keys: ["support_speed", "support_interface_speed"] },
  { id: "bridge", t: "slice.speed.row.bridge", keys: ["bridge_speed"], slow: true },
  {
    id: "accel", t: "slice.speed.row.accel", accel: true,
    keys: ["default_acceleration", "outer_wall_acceleration", "inner_wall_acceleration", "top_surface_acceleration", "sparse_infill_acceleration"],
  },
  { id: "first", t: "slice.speed.row.first", keys: ["initial_layer_speed", "initial_layer_infill_speed"], slow: true, opt: "first" },
  { id: "travel", t: "slice.speed.row.travel", keys: ["travel_speed"], slow: true, opt: "travel" },
];
const SPD_KEYS = SPD_ROWS.flatMap((r) => r.keys);

/* Engine defaults (Snapmaker Orca 2.4.0, PrintConfig.cpp) for the keys a
   profile may leave out; the U1 profiles leave out inner_wall_acceleration
   and sparse_infill_acceleration. A percentage follows another key
   (sparse_infill_acceleration: of default_acceleration) and is left as is. */
const SPD_ENGINE_DEFAULTS = {
  outer_wall_speed: "60", inner_wall_speed: "60", sparse_infill_speed: "100", internal_solid_infill_speed: "100",
  gap_infill_speed: "30", top_surface_speed: "100", support_speed: "80", support_interface_speed: "80", bridge_speed: "25",
  default_acceleration: "500", outer_wall_acceleration: "500", inner_wall_acceleration: "10000",
  top_surface_acceleration: "500", sparse_infill_acceleration: "100%",
  initial_layer_speed: "30", initial_layer_infill_speed: "60", travel_speed: "120",
};

const spdState = () => ({ pct: SPD_DEFAULT, edits: {}, first: false, travel: false });

/* A remembered state, made safe: percentage within range and on a step,
   edits only for known rows and positive numbers. */
function spdNormalize(s) {
  const out = spdState();
  if (!s || typeof s !== "object") return out;
  const p = Math.round(+s.pct / SPD_STEP) * SPD_STEP;
  if (Number.isFinite(p)) out.pct = Math.max(SPD_MIN, Math.min(SPD_MAX, p));
  for (const r of SPD_ROWS) {
    const v = +s.edits?.[r.id];
    if (s.edits && r.id in s.edits && Number.isFinite(v) && v > 0) out.edits[r.id] = v;
  }
  out.first = !!s.first;
  out.travel = !!s.travel;
  return out;
}

/* First number of a value ("200", ["200", "500"], 200); null for a
   percentage or anything else. */
function spdNum(v) {
  const x = Array.isArray(v) ? v[0] : v;
  if (x == null || /%\s*$/.test(String(x))) return null;
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : null;
}

/* Machine limits, from the machine profile's values: the normal mode's
   (first) values. 0: unknown, no cap. */
function spdCaps(machine) {
  const min = (...ks) => {
    const xs = ks.map((k) => spdNum(machine?.[k])).filter((x) => x > 0);
    return xs.length ? Math.min(...xs) : 0;
  };
  return {
    speed: min("machine_max_speed_x", "machine_max_speed_y"),
    accel: min("machine_max_acceleration_x", "machine_max_acceleration_y", "machine_max_acceleration_extruding"),
  };
}

/* Factor a row applies with the global percentage alone. */
function spdFactor(row, pct) {
  const f = pct / 100;
  if (row.accel) return f * f;
  return row.slow ? Math.min(f, 1) : f;
}

/* Rounded down: 1 mm/s, 10 mm/s² — finer than 100, which took a low
   profile's 500 mm/s² at 75 % to 200 instead of 281 (the epsilon absorbs
   270 × 0.7 = 188.99999…). Never below 1 mm/s or 100 mm/s². */
function spdRound(x, accel) {
  const unit = accel ? 10 : 1;
  const min = accel ? 100 : 1;
  return Math.max(min, Math.floor(x / unit + 1e-9) * unit);
}

/* One profile value times `r`, the same shape back (a list stays a list: the
   U1 profiles give one value per nozzle flow type). Percentages and zeros
   (which follow another key) are left as they are, and so is a value the
   factor does not change. Going up, it stops at the machine's limit, or at
   the profile's value if the profile is already above it. */
function spdScale(v, r, accel, cap) {
  if (Array.isArray(v)) return v.map((x) => spdScale(x, r, accel, cap));
  if (v == null || r === 1) return v;
  const s = String(v);
  if (/%\s*$/.test(s)) return v;
  const p = parseFloat(s);
  if (!Number.isFinite(p) || p <= 0) return v;
  let x = p * r;
  if (x > p && cap > 0) x = Math.max(p, Math.min(x, cap));
  const out = spdRound(x, accel);
  if (x >= p && out < p) return v; // capped back to the profile's value
  return out === p ? v : String(out);
}

const spdSame = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* Everything the panel shows and the engine gets:
   rows: [{ id, t, accel, linked, profile, value, keys }] for the rows that
   apply, overrides: { key: value } that differ from the profile. `profile`
   holds the process values (engine defaults filled in by the caller or
   here). */
function spdCompute(state, profile, caps = {}) {
  const st = spdNormalize(state);
  const prof = { ...SPD_ENGINE_DEFAULTS, ...(profile || {}) };
  const rows = [];
  const overrides = {};
  for (const row of SPD_ROWS) {
    if (row.opt && !st[row.opt]) continue;
    const cap = row.accel ? caps.accel || 0 : caps.speed || 0;
    const main = spdNum(prof[row.keys[0]]);
    const edit = st.edits[row.id];
    const linked = !(edit > 0 && main > 0);
    const r = linked ? spdFactor(row, st.pct) : edit / main;
    for (const k of row.keys) {
      const v = spdScale(prof[k], r, !!row.accel, cap);
      if (!spdSame(v, prof[k])) overrides[k] = v;
    }
    const shown = spdNum(spdScale(prof[row.keys[0]], r, !!row.accel, cap));
    rows.push({ id: row.id, t: row.t, accel: !!row.accel, linked, profile: main, value: shown, keys: row.keys });
  }
  return { rows, overrides };
}

/* A value typed in a row: kept, the row detached. The value the row would
   have anyway, or none, links it again. */
function spdEdit(state, id, value, profile, caps) {
  const st = spdNormalize(state);
  delete st.edits[id];
  const row = SPD_ROWS.find((r) => r.id === id);
  if (!row || value == null || value === "" || !(+value > 0)) return st;
  const v = spdRound(+value, !!row.accel);
  const linked = spdCompute(st, profile, caps).rows.find((r) => r.id === id);
  if (linked && linked.value === v) return st;
  st.edits[id] = v;
  return st;
}

const spdLink = (state, id) => {
  const st = spdNormalize(state);
  delete st.edits[id];
  return st;
};
const spdReset = () => spdState();

/* Number of profile values changed (the ⚙ badge). */
const spdCount = (state, profile, caps) => Object.keys(spdCompute(state, profile, caps).overrides).length;

/* Colour of the percentage: below 100 % "slow" (warning), above "fast" (accent). */
const spdTone = (pct) => (pct < 100 ? "slow" : pct > 100 ? "fast" : "");

/* Is the adjustment doing anything? */
const spdActive = (state) => {
  const st = spdNormalize(state);
  return st.pct !== SPD_DEFAULT || Object.keys(st.edits).length > 0;
};

if (typeof module !== "undefined") {
  module.exports = {
    SPD_MIN, SPD_MAX, SPD_STEP, SPD_DEFAULT, SPD_MARKS, SPD_ROWS, SPD_KEYS, SPD_ENGINE_DEFAULTS,
    spdState, spdNormalize, spdNum, spdCaps, spdFactor, spdRound, spdScale, spdCompute, spdEdit, spdLink, spdReset,
    spdCount, spdTone, spdActive,
  };
}
