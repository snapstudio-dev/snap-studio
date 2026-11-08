"use strict";
/* Care & Tuning › Control: the pure part, tested by scripts/test-control.js.
   The same rules as control.rs, so the interface greys out what the
   printer would refuse and says why; control.rs checks them again.

   `st`: control_read's state, `cfg`: its configuration (control.rs). */

const CTL_STEPS = [0.1, 1, 10, 50];
const CTL_Z_FLOOR = 0.5;
const CTL_Z_STEP_MAX = 10;
/* On a U1 the head docks sit behind the bed. */
const CTL_U1_Y_MAX = 270;

const ctlHomed = (st, axes = "xyz") => !!st && [...axes].every((a) => (st.homed || "").includes(a));
const ctlPrinting = (st) => ["printing", "paused"].includes(st?.state);
const ctlMachineBusy = (st) => !!st?.main_state && st.main_state !== "IDLE";

/* The travel range of an axis (0 x, 1 y, 2 z): the printer's, Z never
   under the floor, Y in front of a U1's head docks. */
function ctlRange(cfg, i) {
  const min = i === 2 ? Math.max(cfg.min[2], CTL_Z_FLOOR) : cfg.min[i];
  const max = i === 1 && cfg.u1 ? Math.min(cfg.max[1], CTL_U1_Y_MAX) : cfg.max[i];
  return [min, max];
}

/* Filament in a head (control.rs HeadState): its sensor, else the feed
   module's last load; null: not known. */
function ctlLoaded(h) {
  if (typeof h?.filament === "boolean") return h.filament;
  return h?.feed_state ? h.feed_state === "load_finish" : null;
}

/* Loading asks for the material and colour first, as the printer's
   screen does for a spool without an RFID tag (a tagged one says itself). */
const ctlLoadAsks = (h, cfg) => !!cfg?.materials?.length && h?.official !== true;

/* The material and colour offered for head `slot` (heads.js): what it
   declares when the printer lists it, else Generic PLA; white. */
function ctlFilamentPick(materials, slot) {
  const m = materials.find((x) => x.kind === slot?.kind) || materials.find((x) => x.kind === "PLA") || materials[0];
  if (!m) return null;
  const v = m.vendors.find((x) => x.name === slot?.vendor) || m.vendors[0];
  const sub = v.subs.includes(slot?.sub_type || "") ? slot?.sub_type || "" : v.subs[0];
  const color = slot?.present && /^#[0-9a-f]{6}$/i.test(slot.color || "") ? slot.color.toLowerCase() : "#ffffff";
  return { material: m.kind, vendor: v.name, sub_type: sub, color };
}

/* Why an action cannot run now: an i18n key (ctl.why.*), or "" when it
   can. `kind` as control.rs's Action; `n` the head, `axis` and `dist` a jog. */
function ctlWhy(kind, st, cfg, { n = null, axis = null, dist = 0, axes = "" } = {}) {
  if (!st || !cfg) return "ctl.why.offline";
  if (kind === "emergency_stop") return "";
  if (kind === "light") return cfg.light ? "" : "ctl.why.missing";
  if (ctlPrinting(st)) return "ctl.why.printing";
  if (kind === "firmware_restart") return "";
  if (ctlMachineBusy(st)) return "ctl.why.machine";
  const head = n == null ? null : cfg.heads.find((h) => h.index === n);
  if (n != null && !head) return "ctl.why.missing";
  if (kind === "chamber_fan" && !cfg.chamber_fan) return "ctl.why.missing";
  if (kind === "purifier" && !cfg.purifier) return "ctl.why.missing";
  // Homing: on a U1 X and Y home together, and Z only once they are.
  if (kind === "home") return cfg.u1 && axes === "z" && !ctlHomed(st, "xy") ? "ctl.why.home_xy" : "";
  if (kind === "jog") {
    // Klipper needs the axis moved homed, not the others.
    if (!ctlHomed(st, axis || "xyz")) return "ctl.why.home";
    const i = ["x", "y", "z"].indexOf(axis);
    if (i < 0 || !CTL_STEPS.some((s) => Math.abs(Math.abs(dist) - s) < 1e-9)) return "ctl.why.limit";
    if (i === 2 && Math.abs(dist) > CTL_Z_STEP_MAX) return "ctl.why.zstep";
    const [min, max] = ctlRange(cfg, i);
    const to = st.position[i] + dist;
    return to < min - 1e-6 || to > max + 1e-6 ? "ctl.why.limit" : "";
  }
  // A head's material and colour: from the printer's own list; a spool
  // read from its RFID tag is not edited.
  if (kind === "filament") {
    if (!cfg.u1 || !cfg.materials?.length) return "ctl.why.missing";
    return st.heads.find((x) => x.index === n)?.official ? "ctl.why.official" : "";
  }
  // Loading and unloading: a U1's feed module, which homes X and Y itself.
  if (kind === "load" || kind === "unload") {
    if (!cfg.u1) return "ctl.why.missing";
    const h = st.heads.find((x) => x.index === n) || {};
    const loaded = ctlLoaded(h);
    if (kind === "unload") return loaded === false ? "ctl.why.empty" : "";
    if (loaded === true) return "ctl.why.loaded";
    if (h.auto_feed === false) return "ctl.why.auto_off";
    return h.inserted === false ? "ctl.why.insert" : "";
  }
  // A U1 homes X and Y itself to pick a head (T<n>); cleaning and the
  // purge position need them homed (MOVE_TO_XY_IDLE_POSITION). Another
  // printer: everything homed.
  if (kind === "tool" && !cfg.u1 && !ctlHomed(st)) return "ctl.why.home";
  if (["clean", "purge_position"].includes(kind) && !ctlHomed(st, cfg.u1 ? "xy" : "xyz")) return "ctl.why.home";
  if (kind === "extrude" || kind === "retract") {
    const h = st.heads.find((x) => x.index === n);
    if (!h || h.temp < head.min_extrude_temp) return "ctl.why.cold";
    if (st.active !== n && !cfg.u1 && !ctlHomed(st)) return "ctl.why.home";
  }
  if (kind === "tool" && st.active === n) return "ctl.why.active";
  return "";
}

/* The machine's state in a word for the status bar: offline, printing,
   paused, busy (a U1 procedure), idle. */
function ctlStateOf(st) {
  if (!st) return "offline";
  if (st.state === "printing") return "printing";
  if (st.state === "paused") return "paused";
  if (ctlMachineBusy(st)) return "busy";
  return "idle";
}

/* What a head holds, from heads.js's slot ({ index, present, color, kind,
   sub_type, vendor }): the one filament description the tab and the quick
   panels show. `nameOf` names a colour (colorName), "Cyan PLA". */
function ctlSpoolInfo(slot, nameOf = null) {
  if (!slot || !slot.present) return { present: false, color: null, kind: "", name: "" };
  const color = /^#[0-9a-f]{6}$/i.test(slot.color || "") ? slot.color.toLowerCase() : null;
  const name = [color && nameOf ? nameOf(color) : "", slot.kind || ""].filter(Boolean).join(" ");
  return { present: true, color, kind: slot.kind || "", name: name ? name[0].toUpperCase() + name.slice(1) : "" };
}

/* A temperature's share of its scale, for the gauges (0–1). */
const ctlPct = (v, max) => (max > 0 ? Math.max(0, Math.min(1, (v || 0) / max)) : 0);

/* A heater heating, cooling or steady: for its gauge's colour. */
function ctlHeat(temp, target) {
  if (!(target > 0)) return temp > 45 ? "cooling" : "off";
  return Math.abs(temp - target) <= 3 ? "ready" : temp < target ? "heating" : "cooling";
}

if (typeof module !== "undefined")
  module.exports = { CTL_STEPS, CTL_Z_FLOOR, CTL_U1_Y_MAX, ctlLoaded, ctlLoadAsks, ctlFilamentPick, ctlHomed, ctlRange, ctlWhy, ctlStateOf, ctlSpoolInfo, ctlPct, ctlHeat };
