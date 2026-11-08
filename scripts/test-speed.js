// node scripts/test-speed.js — Speed adjustment of the slice sheet.
const assert = require("assert");
const S = require("../ui/speed.js");

// Values of "0.20mm Standard @Snapmaker U1 (0.4 nozzle)", flattened, and of
// its machine: lists per nozzle flow type, keys left to the engine.
const U1 = {
  outer_wall_speed: ["200", "500"], inner_wall_speed: ["300", "600"],
  sparse_infill_speed: ["270", "600"], internal_solid_infill_speed: ["250", "600"], gap_infill_speed: "250",
  top_surface_speed: "200", support_speed: "150", support_interface_speed: "80", bridge_speed: "50",
  default_acceleration: "10000", outer_wall_acceleration: "5000", top_surface_acceleration: "2000",
  initial_layer_speed: "50", initial_layer_infill_speed: "105", travel_speed: "500",
};
const MACHINE = {
  machine_max_speed_x: ["500", "200"], machine_max_speed_y: ["500", "200"],
  machine_max_acceleration_x: ["20000", "20000"], machine_max_acceleration_y: ["20000", "20000"],
  machine_max_acceleration_extruding: ["20000", "20000"],
};
const caps = S.spdCaps(MACHINE);
assert.deepEqual(caps, { speed: 500, accel: 20000 }, "normal-mode limits, the smallest axis");
assert.deepEqual(S.spdCaps({}), { speed: 0, accel: 0 }, "unknown: no cap");

const at = (pct, extra = {}) => S.spdCompute({ ...S.spdState(), pct, ...extra }, U1, caps);
const row = (c, id) => c.rows.find((r) => r.id === id);

// 100 % with nothing edited: nothing is sent, the G-code is the profile's.
assert.deepEqual(at(100).overrides, {});
assert.deepEqual(S.spdCompute(S.spdState(), U1, caps).overrides, {});
assert.deepEqual(S.spdCompute(undefined, {}, {}).overrides, {}, "no state, no profile");
assert.deepEqual(at(100, { first: true, travel: true }).overrides, {}, "switches alone change nothing at 100 %");
assert.equal(S.spdCount(S.spdState(), U1, caps), 0);
assert.ok(!S.spdActive(S.spdState()));

// Speeds × f, rounded down to 1 mm/s, every flow type.
const c75 = at(75);
assert.deepEqual(c75.overrides.outer_wall_speed, ["150", "375"]);
assert.deepEqual(c75.overrides.inner_wall_speed, ["225", "450"]);
assert.deepEqual(c75.overrides.sparse_infill_speed, ["202", "450"], "202.5 → 202");
assert.deepEqual(c75.overrides.internal_solid_infill_speed, ["187", "450"]);
assert.equal(c75.overrides.gap_infill_speed, "187");
assert.equal(c75.overrides.top_surface_speed, "150");
assert.equal(c75.overrides.support_speed, "112", "112.5 → 112");
assert.equal(c75.overrides.support_interface_speed, "60");
assert.equal(c75.overrides.bridge_speed, "37", "bridges slow down");
// Accelerations × f²: 0.5625, rounded down to 10 mm/s².
assert.equal(c75.overrides.default_acceleration, "5620");
assert.equal(c75.overrides.outer_wall_acceleration, "2810");
assert.equal(c75.overrides.top_surface_acceleration, "1120");
assert.equal(c75.overrides.inner_wall_acceleration, "5620", "engine default 10000 when the profile has none");
assert.ok(!("sparse_infill_acceleration" in c75.overrides), "100% of default_acceleration: follows it");
// First layer and travel untouched by default.
for (const k of ["initial_layer_speed", "initial_layer_infill_speed", "travel_speed"]) assert.ok(!(k in c75.overrides), k);
assert.ok(!row(c75, "first") && !row(c75, "travel"), "their rows only with the switch on");
// Shown: profile → computed, the first key of the row.
assert.deepEqual(
  { p: row(c75, "outer").profile, v: row(c75, "outer").value, l: row(c75, "outer").linked },
  { p: 200, v: 150, l: true }
);
assert.deepEqual({ p: row(c75, "accel").profile, v: row(c75, "accel").value }, { p: 10000, v: 5620 });
assert.equal(S.spdCount({ pct: 75 }, U1, caps), Object.keys(c75.overrides).length);
assert.ok(S.spdActive({ pct: 75 }));

// Floating point: 270 × 0.7 = 188.99999…, still 189.
assert.deepEqual(at(70).overrides.sparse_infill_speed, ["189", "420"]);
assert.equal(S.spdRound(188.99999999999997, false), 189);
assert.equal(S.spdRound(5625, true), 5620);
// A low profile keeps its proportion: 500 mm/s² at 75 % gives 280, not 200.
assert.equal(S.spdScale("500", 0.5625, true, 0), "280");
assert.equal(S.spdRound(0.3, false), 1, "never below 1 mm/s");
assert.equal(S.spdRound(40, true), 100, "never below 100 mm/s²");
// 50 %: f² = 0.25.
const c50 = at(50);
assert.equal(c50.overrides.default_acceleration, "2500");
assert.deepEqual(c50.overrides.outer_wall_speed, ["100", "250"]);

// Switches: they only slow down.
const sw = at(80, { first: true, travel: true });
assert.equal(sw.overrides.initial_layer_speed, "40");
assert.equal(sw.overrides.initial_layer_infill_speed, "84");
assert.equal(sw.overrides.travel_speed, "400");
const swFast = at(120, { first: true, travel: true });
for (const k of ["initial_layer_speed", "initial_layer_infill_speed", "travel_speed"]) assert.ok(!(k in swFast.overrides), k + " not faster");

// Above 100 %: within the machine's limits; bridges stay.
const c120 = at(120);
assert.deepEqual(c120.overrides.outer_wall_speed, ["240", "500"], "500 × 1.2 capped to 500 (profile value: unchanged)");
assert.deepEqual(c120.overrides.inner_wall_speed, ["360", "600"], "a profile already above the limit keeps its value");
assert.ok(!("bridge_speed" in c120.overrides), "bridges never faster");
assert.equal(c120.overrides.default_acceleration, "14400", "× 1.44");
assert.equal(c120.overrides.top_surface_acceleration, "2880");
assert.equal(S.spdScale("450", 1.2, false, 500), "500");
assert.equal(S.spdScale("18000", 1.44, true, 20000), "20000");
assert.equal(S.spdScale("450", 1.2, false, 0), "540", "no known limit");
assert.equal(S.spdScale("112.5", 1.001, false, 112.6), "112.5", "capped at the profile: unchanged");
assert.equal(S.spdScale("100%", 0.5, true, 0), "100%");
assert.equal(S.spdScale("0", 0.5, true, 0), "0", "0 follows the default acceleration");
assert.deepEqual(S.spdScale(["200", "50%"], 0.5, false, 0), ["100", "50%"]);
assert.equal(S.spdScale("112.5", 1, false, 0), "112.5", "factor 1: untouched");

// Unlinking: a value typed by hand detaches its row, the global slider no
// longer moves it, and the other keys of the row follow in proportion.
let st = S.spdEdit({ pct: 75 }, "outer", "130", U1, caps);
assert.deepEqual(st.edits, { outer: 130 });
const e75 = S.spdCompute(st, U1, caps);
assert.equal(row(e75, "outer").linked, false);
assert.equal(row(e75, "outer").value, 130);
assert.deepEqual(e75.overrides.outer_wall_speed, ["130", "325"]);
st.pct = 50;
const e50 = S.spdCompute(st, U1, caps);
assert.deepEqual(e50.overrides.outer_wall_speed, ["130", "325"], "not overwritten by the slider");
assert.deepEqual(e50.overrides.inner_wall_speed, ["150", "300"], "the linked rows follow");
// Several keys in a row: they keep the ratio of the one typed.
const sup = S.spdCompute(S.spdEdit({ pct: 100 }, "support", "75", U1, caps), U1, caps);
assert.equal(sup.overrides.support_speed, "75");
assert.equal(sup.overrides.support_interface_speed, "40");
// Accelerations typed: rounded down to 10, the others in proportion.
const acc = S.spdEdit({ pct: 100 }, "accel", "5055", U1, caps);
assert.deepEqual(acc.edits, { accel: 5050 });
const accC = S.spdCompute(acc, U1, caps);
assert.equal(accC.overrides.default_acceleration, "5050");
assert.equal(accC.overrides.outer_wall_acceleration, "2520", "5000 × 0.505 = 2525, rounded down");
// Typed above the machine's limit: capped.
assert.deepEqual(S.spdCompute(S.spdEdit({}, "outer", "900", U1, caps), U1, caps).overrides.outer_wall_speed, ["500", "500"]);
// At 100 %, one row edited: only that row is sent.
assert.deepEqual(Object.keys(S.spdCompute(S.spdEdit({}, "top", "150", U1, caps), U1, caps).overrides), ["top_surface_speed"]);
assert.ok(S.spdActive(S.spdEdit({}, "top", "150", U1, caps)), "an edited row keeps it active at 100 %");
// The value the row would have anyway, or nothing, links it again.
assert.deepEqual(S.spdEdit({ pct: 75 }, "outer", "150", U1, caps).edits, {});
assert.deepEqual(S.spdEdit(st, "outer", "", U1, caps).edits, {});
assert.deepEqual(S.spdEdit(st, "nope", "10", U1, caps).edits, { outer: 130 }, "unknown row ignored");
// Link and reset.
assert.deepEqual(S.spdLink(st, "outer").edits, {});
assert.deepEqual(S.spdLink(st, "outer").pct, 50, "linking keeps the percentage");
assert.deepEqual(S.spdReset(), { pct: 100, edits: {}, first: false, travel: false });
assert.deepEqual(S.spdCompute(S.spdReset(), U1, caps).overrides, {});

// Remembered state, made safe.
assert.deepEqual(S.spdNormalize({ pct: 200, edits: { outer: "120", bad: 3, inner: -1 }, first: 1 }), {
  pct: 120, edits: { outer: 120 }, first: true, travel: false,
});
assert.equal(S.spdNormalize({ pct: 10 }).pct, 50);
assert.equal(S.spdNormalize({ pct: 77 }).pct, 75, "on a 5 % step");
assert.equal(S.spdNormalize({ pct: "abc" }).pct, 100);
assert.equal(S.spdNormalize(null).pct, 100);
// The state given is never changed.
const keep = { pct: 75, edits: { outer: 130 } };
S.spdEdit(keep, "outer", "", U1, caps);
S.spdLink(keep, "outer");
assert.deepEqual(keep, { pct: 75, edits: { outer: 130 } });

// Tone and factors.
assert.equal(S.spdTone(75), "slow");
assert.equal(S.spdTone(100), "");
assert.equal(S.spdTone(110), "fast");
assert.equal(S.spdFactor({ accel: true }, 80), 0.6400000000000001);
assert.equal(S.spdFactor({ slow: true }, 120), 1);
assert.equal(S.spdFactor({}, 120), 1.2);
assert.deepEqual(S.SPD_MARKS.map((m) => m.v), [50, 75, 100, 120]);
assert.ok(S.SPD_MARKS.every((m) => (m.v - S.SPD_MIN) % S.SPD_STEP === 0));
// Every key driven is a real Orca key with an engine default.
for (const k of S.SPD_KEYS) assert.ok(k in S.SPD_ENGINE_DEFAULTS, k);

console.log("speed: ok");
