// node scripts/test-control.js — Care & Tuning › Control: what the interface allows, and why not.
const assert = require("assert");
const C = require("../ui/control-logic.js");

// A U1 as control.rs reads it.
const cfg = {
  heads: [0, 1, 2, 3].map((index) => ({ index, max_temp: 300, min_extrude_temp: 170 })),
  bed_max: 100, min: [0, 0, -6], max: [271, 335, 275],
  chamber_fan: true, light: true, purifier: true, u1: true,
};
const idle = {
  state: "standby", main_state: "IDLE", progress: 0, homed: "xyz", position: [135, 135, 10], active: 1,
  heads: [{ index: 0, temp: 24, target: 0 }, { index: 1, temp: 210, target: 210 }, { index: 2, temp: 23, target: 0 }, { index: 3, temp: 23, target: 0 }],
  bed: { temp: 58, target: 60 }, part_fan: 0.5, chamber_fan: 0.2, light: true, purifier: false, idle: "Ready",
};
const why = (kind, st = idle, o = {}) => C.ctlWhy(kind, st, cfg, o);

// Idle and homed: everything can run.
for (const k of ["home", "heaters_off", "motors_off", "firmware_restart", "clean", "purge_position", "light", "purifier", "chamber_fan", "bed_temp", "part_fan"]) assert.equal(why(k), "", k);
assert.equal(why("jog", idle, { axis: "x", dist: 10 }), "");
assert.equal(why("tool", idle, { n: 2 }), "");
assert.equal(why("tool", idle, { n: 1 }), "ctl.why.active", "the active head");
assert.equal(why("extrude", idle, { n: 1 }), "");
assert.equal(why("extrude", idle, { n: 2 }), "ctl.why.cold", "a cold nozzle does not extrude");
assert.equal(why("load", idle, { n: 3 }), "");
assert.equal(why("tool", idle, { n: 7 }), "ctl.why.missing");

// Jogging: the steps offered, Z ≥ 0.5 mm and 10 mm at most, the travel, Y in front of a U1's docks.
assert.equal(why("jog", idle, { axis: "x", dist: 7 }), "ctl.why.limit");
assert.equal(why("jog", idle, { axis: "z", dist: -10 }), "ctl.why.limit", "10 - 10 = 0 < 0.5");
assert.equal(why("jog", { ...idle, position: [135, 135, 0.55] }, { axis: "z", dist: -0.1 }), "ctl.why.limit");
assert.equal(why("jog", idle, { axis: "z", dist: 50 }), "ctl.why.zstep");
assert.equal(why("jog", { ...idle, position: [135, 250, 10] }, { axis: "y", dist: 50 }), "ctl.why.limit");
assert.equal(why("jog", { ...idle, position: [135, 250, 10] }, { axis: "y", dist: 10 }), "");
assert.deepEqual(C.ctlRange(cfg, 1), [0, 270]);
assert.deepEqual(C.ctlRange({ ...cfg, u1: false }, 1), [0, 335]);
assert.deepEqual(C.ctlRange(cfg, 2), [0.5, 275]);

// Not homed: moves and cleaning wait; homing and heating do not, nor a
// head change, loading and unloading (a U1 homes X and Y itself).
const notHomed = { ...idle, homed: "" };
for (const [k, o] of [["jog", { axis: "x", dist: 1 }], ["clean", {}], ["purge_position", {}]]) assert.equal(why(k, notHomed, o), "ctl.why.home", k);
assert.equal(why("unload", notHomed, { n: 1 }), "");
assert.equal(why("tool", notHomed, { n: 2 }), "", "T<n> homes X and Y on a U1");
assert.equal(C.ctlWhy("tool", notHomed, { ...cfg, u1: false }, { n: 2 }), "ctl.why.home", "another printer: homed first");
// After the U1's "G28 X Y": X and Y jog, Z waits; Z homes once X and Y are.
const xyHomed = { ...idle, homed: "xy" };
assert.equal(why("jog", xyHomed, { axis: "x", dist: 1 }), "");
assert.equal(why("jog", xyHomed, { axis: "y", dist: -1 }), "");
assert.equal(why("jog", xyHomed, { axis: "z", dist: 1 }), "ctl.why.home");
assert.equal(why("clean", xyHomed), "");
assert.equal(why("home", notHomed, { axes: "z" }), "ctl.why.home_xy");
assert.equal(why("home", xyHomed, { axes: "z" }), "");
assert.equal(why("home", notHomed, { axes: "xyz" }), "");

// The spools, as a U1 reads them: T0 T1 loaded, T2 in the port, T3 empty.
const feed = (h, filament, feed_state, inserted, auto_feed = true) => ({ ...h, filament, feed_state, inserted, auto_feed });
const spools = { ...idle, heads: [feed(idle.heads[0], true, "load_finish", true), feed(idle.heads[1], true, "load_finish", true), feed(idle.heads[2], false, "preload_finish", true), feed(idle.heads[3], false, "wait_insert", false)] };
assert.equal(why("load", spools, { n: 0 }), "ctl.why.loaded", "a loaded head is not loaded again");
assert.equal(why("unload", spools, { n: 0 }), "");
assert.equal(why("load", spools, { n: 2 }), "");
assert.equal(why("unload", spools, { n: 2 }), "ctl.why.empty");
assert.equal(why("load", spools, { n: 3 }), "ctl.why.insert", "nothing in the feed port");
assert.equal(why("load", { ...spools, heads: spools.heads.map((h) => (h.index === 2 ? { ...h, auto_feed: false } : h)) }, { n: 2 }), "ctl.why.auto_off");
assert.equal(why("load", spools, { n: 2 }), why("load", { ...spools, homed: "" }, { n: 2 }), "loading does not wait for homing");
// Without a head sensor, the feed module's last load says; unknown: allowed.
assert.equal(C.ctlLoaded({ feed_state: "load_finish" }), true);
assert.equal(C.ctlLoaded({ feed_state: "wait_insert" }), false);
assert.equal(C.ctlLoaded({}), null);
assert.equal(why("load", spools, { n: 2 }), "");
assert.equal(C.ctlWhy("load", spools, { ...cfg, u1: false }, { n: 2 }), "ctl.why.missing", "no feed module elsewhere");
assert.equal(why("home", notHomed), "");
assert.equal(why("nozzle_temp", notHomed, { n: 0 }), "");
assert.equal(why("extrude", notHomed, { n: 1 }), "", "the active head extrudes without homing");
assert.equal(why("extrude", { ...notHomed, heads: idle.heads.map((h) => ({ ...h, temp: 220 })) }, { n: 2 }), "", "picking it homes X and Y on a U1");

// Printing: only the emergency stop and the light.
const printing = { ...idle, state: "printing", progress: 0.42 };
assert.equal(why("emergency_stop", printing), "");
assert.equal(why("light", printing), "");
for (const k of ["home", "heaters_off", "firmware_restart", "motors_off", "bed_temp"]) assert.equal(why(k, printing), "ctl.why.printing", k);
assert.equal(why("home", { ...idle, state: "paused" }), "ctl.why.printing");
// The U1 in one of its procedures: waits, the restart stays possible.
const leveling = { ...idle, main_state: "BED_LEVELING" };
assert.equal(why("home", leveling), "ctl.why.machine");
assert.equal(why("firmware_restart", leveling), "");
// What the printer lacks; no printer.
const bare = { ...cfg, light: false, chamber_fan: false, purifier: false };
assert.equal(C.ctlWhy("light", idle, bare), "ctl.why.missing");
assert.equal(C.ctlWhy("chamber_fan", idle, bare), "ctl.why.missing");
assert.equal(C.ctlWhy("purifier", idle, bare), "ctl.why.missing");
assert.equal(C.ctlWhy("home", null, cfg), "ctl.why.offline");

// The status bar's word.
assert.equal(C.ctlStateOf(idle), "idle");
assert.equal(C.ctlStateOf(printing), "printing");
assert.equal(C.ctlStateOf({ ...idle, state: "paused" }), "paused");
assert.equal(C.ctlStateOf(leveling), "busy");
assert.equal(C.ctlStateOf(null), "offline");
assert.equal(C.ctlStateOf({ ...idle, main_state: "" }), "idle", "another Klipper has no machine state");

// Gauges.
assert.equal(C.ctlPct(150, 300), 0.5);
assert.equal(C.ctlPct(400, 300), 1);
assert.equal(C.ctlHeat(120, 210), "heating");
assert.equal(C.ctlHeat(209, 210), "ready");
assert.equal(C.ctlHeat(150, 0), "cooling");
assert.equal(C.ctlHeat(24, 0), "off");

// The one filament description: colour named, material, capitalised; empty heads say so.
const nameOf = (hex) => ({ "#5ac8c8": "cyan", "#ffffff": "blanc" })[hex] || "";
assert.deepEqual(C.ctlSpoolInfo({ index: 0, present: true, color: "#5AC8C8", kind: "PLA" }, nameOf), { present: true, color: "#5ac8c8", kind: "PLA", name: "Cyan PLA" });
assert.deepEqual(C.ctlSpoolInfo({ index: 1, present: true, color: null, kind: "PETG" }, nameOf), { present: true, color: null, kind: "PETG", name: "PETG" });
assert.deepEqual(C.ctlSpoolInfo({ index: 2, present: false, color: "#ffffff" }, nameOf), { present: false, color: null, kind: "", name: "" });
assert.equal(C.ctlSpoolInfo(undefined).present, false);
assert.equal(C.ctlSpoolInfo({ present: true, color: "red", kind: "" }).color, null, "only #rrggbb");

// The page: Control is Care & Tuning's first tab — [Control] [Care]
// [Bed Leveling], Calibration hidden after them — and the printer card opens it.
const fs = require("fs");
const html = fs.readFileSync(require("path").join(__dirname, "..", "ui", "index.html"), "utf8");
const tabs = html.slice(html.indexOf('id="mt-tabs"'), html.indexOf("</div>", html.indexOf('id="mt-tabs"')));
const at = (t) => tabs.indexOf(`data-mtab="${t}"`);
assert.ok(at("control") > 0 && at("control") < at("care") && at("care") < at("level") && at("level") < at("calib"), "Control, Care, Bed Leveling");
assert.ok(/<button class="seg-btn labeled hidden" data-mtab="calib">/.test(html), "Calibration still hidden");
assert.ok(/id="prn-control"/.test(html) && /id="ct-body"/.test(html));
const maint = fs.readFileSync(require("path").join(__dirname, "..", "ui", "maint.js"), "utf8");
assert.ok(/const MT_TABS = \["care", "level", "control"\]/.test(maint));
// One service, one filament source, components with a compact mode, an opening with a context:
// the printer page's shortcut goes through ctlOpen, as #34's quick panels will.
const ui = (f) => fs.readFileSync(require("path").join(__dirname, "..", "ui", f), "utf8");
const ctl = ui("control.js");
for (const name of ["ctlRun", "ctlRead", "ctlSubscribe", "ctlSpool", "ctlOpen", "ctlBind", "ctlPaint", "ctlHeadHtml", "ctlSpoolHtml", "ctlBedHtml", "ctlLightHtml", "ctlEstopHtml"]) {
  assert.ok(new RegExp(`function ${name}\\(`).test(ctl), name);
}
for (const name of ["ctlHeadHtml", "ctlSpoolHtml", "ctlBedHtml", "ctlLightHtml", "ctlEstopHtml"]) {
  assert.ok(new RegExp(`function ${name}\\([^)]*compact = false`).test(ctl), `${name} has a compact mode`);
}
assert.equal((ctl.match(/invoke\("control_run"/g) || []).length, 1, "one place sends actions");
assert.ok(/ctlOpen\(current\(\)\.id\)/.test(ui("printers.js")), "the printer page opens Control through ctlOpen");
assert.ok(!/invoke\("control_run"/.test(ui("printers.js")) && !/invoke\("control_run"/.test(ui("maint.js")));

// A head's material and colour, from the printer's list (as its screen).
const mats = [
  { kind: "PLA", vendors: [{ name: "Generic", subs: [""] }, { name: "Snapmaker", subs: ["", "Silk", "SnapSpeed"] }] },
  { kind: "PETG", vendors: [{ name: "Generic", subs: ["", "HF"] }] },
];
const ucfg = { ...cfg, materials: mats };
assert.equal(C.ctlWhy("filament", idle, ucfg, { n: 2 }), "");
assert.equal(C.ctlWhy("filament", { ...idle, heads: idle.heads.map((h) => (h.index === 2 ? { ...h, official: true } : h)) }, ucfg, { n: 2 }), "ctl.why.official", "an RFID spool says itself");
assert.equal(C.ctlWhy("filament", idle, cfg, { n: 2 }), "ctl.why.missing", "no list, nothing to declare");
assert.equal(C.ctlWhy("filament", { ...idle, state: "printing" }, ucfg, { n: 2 }), "ctl.why.printing");
// Loading asks first, unless the spool's tag tells.
assert.equal(C.ctlLoadAsks({ official: false }, ucfg), true);
assert.equal(C.ctlLoadAsks({}, ucfg), true);
assert.equal(C.ctlLoadAsks({ official: true }, ucfg), false);
assert.equal(C.ctlLoadAsks({ official: false }, cfg), false, "no list: loads at once, as before");
// What is offered: the head's declaration when listed, else Generic PLA, white.
assert.deepEqual(C.ctlFilamentPick(mats, { present: true, kind: "PLA", vendor: "Snapmaker", sub_type: "Silk", color: "#FF7A1A" }), { material: "PLA", vendor: "Snapmaker", sub_type: "Silk", color: "#ff7a1a" });
assert.deepEqual(C.ctlFilamentPick(mats, { present: true, kind: "PETG", vendor: "Polymaker", sub_type: "HF", color: "#000000" }), { material: "PETG", vendor: "Generic", sub_type: "HF", color: "#000000" }, "an unlisted vendor: the first");
assert.deepEqual(C.ctlFilamentPick(mats, { present: false, kind: "", vendor: "", sub_type: "", color: "#ffffff" }), { material: "PLA", vendor: "Generic", sub_type: "", color: "#ffffff" }, "an unloaded head");
assert.equal(C.ctlFilamentPick([], {}), null);

console.log("control: ok");
