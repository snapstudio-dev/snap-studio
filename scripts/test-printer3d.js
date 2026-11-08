// node scripts/test-printer3d.js — the 3D printer view: zones, sides, heat, the status card.
const assert = require("assert");
const L = require("../ui/printer3d-logic.js");

// The parts picked, from the mesh up: spools, docks (heads), the carriage, bed, light.
assert.equal(L.p3dZoneOf(["spoolLeftTopFilament", "spoolLeftTop", "SnapmakerU1"]), "spool:0");
assert.equal(L.p3dZoneOf(["", "spoolRightBottom", "SnapmakerU1"]), "spool:3");
assert.equal(L.p3dZoneOf(["", "parked2", "dock2", "SnapmakerU1"]), "head:2");
assert.equal(L.p3dZoneOf(["nozzle", "toolhead", "SnapmakerU1"], 1), "head:1", "the carriage is the active head");
assert.equal(L.p3dZoneOf(["nozzle", "toolhead", "SnapmakerU1"], null), null, "no head on the carriage");
assert.equal(L.p3dZoneOf(["", "bed", "SnapmakerU1"]), "bed");
assert.equal(L.p3dZoneOf(["", "light", "SnapmakerU1"]), "light");
assert.equal(L.p3dZoneOf(["doorGlass", "door", "SnapmakerU1"]), null);
assert.equal(L.p3dZoneOf([]), null);

// Zones parsed; the side each sits on (T0 T1 left, T2 T3 right).
assert.deepEqual(L.p3dParse("spool:2"), { kind: "spool", n: 2 });
assert.deepEqual(L.p3dParse("head:0"), { kind: "head", n: 0 });
assert.deepEqual(L.p3dParse("bed"), { kind: "bed", n: null });
assert.equal(L.p3dParse("door"), null);
assert.equal(L.p3dParse(null), null);
assert.deepEqual([0, 1, 2, 3].map((n) => L.p3dSideOf(`spool:${n}`)), ["left", "left", "right", "right"]);
assert.deepEqual([0, 1, 2, 3].map((n) => L.p3dSideOf(`head:${n}`)), ["left", "left", "right", "right"], "a head: its spool's side");
assert.equal(L.p3dSideOf("bed"), "front");
assert.equal(L.p3dSideOf(null), "front");
assert.equal(L.p3dSideOf("light"), "front");
// Turning the short way round, whatever the turns already made.
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
near(L.p3dYawTo(0, "back"), Math.PI);
near(L.p3dYawTo(-0.95, "back"), -Math.PI, "from the right side, back is the other way");
near(L.p3dYawTo(2 * Math.PI + 0.1, "front"), 2 * Math.PI);
near(L.p3dYawTo(Math.PI, "left"), 0.95);
assert.equal(L.p3dSideAt(0.1), "front");
assert.equal(L.p3dSideAt(1.2), "left");
assert.equal(L.p3dSideAt(-1.1), "right");
assert.equal(L.p3dSideAt(3), "back");
assert.equal(L.p3dSideAt(-3), "back");
assert.equal(L.p3dSideAt(4 * Math.PI + 0.9), "left");
assert.ok(L.P3D_YAW.left > 0 && L.P3D_YAW.right < 0 && L.P3D_YAW.front === 0, "a positive turn shows the left side");

// A nozzle's glow: cold, on its way, at its target, cooling without one.
assert.equal(L.p3dHeat(24, 0), 0);
assert.equal(L.p3dHeat(220, 220), 1);
assert.equal(L.p3dHeat(130, 220), 0.5);
assert.equal(L.p3dHeat(300, 220), 1, "never above 1");
assert.equal(L.p3dHeat(120, 0), 0.5, "cooling: towards 200 °C");
assert.equal(L.p3dHeat(null, 0), 0);

// The status card.
assert.equal(L.p3dSummary(null).state, "offline");
assert.equal(L.p3dSummary({ online: false, state: "printing" }).state, "offline");
const idleSum = L.p3dSummary({ online: true, state: "standby", job: "old.gcode", progress: 1, fan: 0.5 });
assert.deepEqual([idleSum.job, idleSum.progress, idleSum.fan], ["", null, null], "a finished job is not shown as running");
assert.deepEqual(L.p3dSummary({ online: true, state: "printing", job: "cube.gcode", progress: 0.42, layer: [12, 80], elapsed_s: 1200, remaining_s: 3600, speed_factor: 1.1, fan: 0.5, filament_mm: 3200 }),
  { state: "printing", job: "cube.gcode", progress: 0.42, layer: [12, 80], elapsed: 1200, left: 3600, speed: 1.1, fan: 0.5, filament: 3.2 });
assert.equal(L.p3dSummary({ online: true, state: "printing", speed_factor: 1 }).speed, null, "100 % says nothing");
assert.equal(L.p3dSummary({ online: true, state: "paused", job: "a", progress: 0.1 }).progress, 0.1);
assert.equal(L.p3dSummary({ online: true }).state, "standby");

// The carriage: the bed's centre, its corners (Y+ at the back), unknown.
assert.deepEqual(L.p3dCarriage([135, 135, 10]), { x: 0, z: 0 });
assert.deepEqual(L.p3dCarriage([270, 0, 0]), { x: 0.135, z: 0.135 });
assert.deepEqual(L.p3dCarriage([0, 270, 0]), { x: -0.135, z: -0.135 });
assert.equal(L.p3dCarriage(null), null);
assert.equal(L.p3dCarriage([NaN, 0]), null);

// The turns' easing: from 0 to 1, symmetric.
assert.equal(L.p3dEase(0), 0);
assert.equal(L.p3dEase(1), 1);
assert.equal(L.p3dEase(0.5), 0.5);
assert.ok(L.p3dEase(0.25) < 0.25 && L.p3dEase(0.75) > 0.75);

// One panel per head, whichever of its parts is clicked.
assert.equal(L.p3dPanelZone("spool:2"), "head:2");
assert.equal(L.p3dPanelZone("head:2"), "head:2");
assert.equal(L.p3dPanelZone("bed"), "bed");
assert.equal(L.p3dPanelZone("light"), "light");
assert.equal(L.p3dPanelZone(null), null);

// The arrow keys turn side by side, all the way round.
assert.equal(L.p3dNextSide("front", 1), "left");
assert.equal(L.p3dNextSide("left", 1), "back");
assert.equal(L.p3dNextSide("right", 1), "front");
assert.equal(L.p3dNextSide("front", -1), "right");
assert.equal(L.p3dNextSide("back", -1), "left");
assert.equal(L.p3dNextSide("nowhere", 1), "left");

// The printer card's rows: Control's state first, else the page's status.
const sp = [{ present: true, color: "#6fd6dc", name: "Cyan PLA" }, { present: true, color: "#f4f4f4", name: "White PLA" }, { present: false, color: null, name: "" }, { present: true, color: "#1a1a1a", name: "Black PLA" }];
const stat = { online: true, nozzles: [{ index: 0, current: 24, target: 0, active: false }, { index: 1, current: 205, target: 210, active: true }], filaments: [{}, {}, {}, {}] };
let rows = L.p3dRows(stat, null, sp);
assert.equal(rows.length, 4);
assert.deepEqual(rows[1], { n: 1, temp: 205, target: 210, active: true, present: true, color: "#f4f4f4", name: "White PLA", inHead: null, detail: [], used: false });
const withFil = { ...stat, state: "printing", job: "a.gcode", filaments: [{ index: 0, kind: "PLA", sub_type: "Matte", color: "#6fd6dc", vendor: "Bambu", present: true, used: true }, { index: 2, kind: "PETG", present: false, used: true }] };
rows = L.p3dRows(withFil, null, sp);
assert.deepEqual([rows[0].detail, rows[0].used], [["PLA Matte", "#6FD6DC", "Bambu"], true]);
assert.deepEqual([rows[2].detail, rows[1].used], [[], false], "an empty slot has no details");
assert.equal(L.p3dRows({ ...withFil, state: "standby" }, null, sp)[0].used, false, "used by a past job: not shown");
assert.deepEqual([rows[2].present, rows[2].color, rows[2].temp], [false, null, null], "an empty slot, no nozzle reading");
const ctl = { active: 3, heads: [0, 1, 2, 3].map((index) => ({ index, temp: 20 + index, target: 0, filament: index !== 2 })) };
rows = L.p3dRows(stat, ctl, sp);
assert.deepEqual(rows.map((r) => r.active), [false, false, false, true], "Control's active head wins");
assert.deepEqual(rows.map((r) => r.temp), [20, 21, 22, 23]);
assert.deepEqual(rows.map((r) => r.inHead), [true, true, false, true]);
assert.equal(L.p3dRows(null, null, []).length, 0);

console.log("printer3d: ok");
