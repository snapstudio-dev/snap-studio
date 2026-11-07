//! Care & Tuning › Control: the printer's basic actions (home, jog, heads,
//! temperatures, filament, fans, light, motors, restart, emergency stop).
//!
//! The interface never sends G-code: it asks for an `Action`, and `plan`
//! turns it into a script, or refuses it, from what the printer says now.
//! The commands are the Snapmaker U1's, checked in Snapmaker/u1-klipper
//! (lava/printer.cfg, lava/fluidd.cfg, klippy/extras): `T<n> A0` to pick a
//! head, `M104 T<n> S… A0`, `AUTO_FEEDING EXTRUDER=<n> LOAD=1` / `UNLOAD=1`
//! (the feed module's own procedures, as the screen: it homes X and Y if
//! needed, picks the head, heats to the filament's temperature),
//! `CONTROL_EXTRUDE_ACTION`, `ROUGHLY_CLEAN_NOZZLE`,
//! `MOVE_TO_DISCARD_FILAMENT_POSITION`, `cavity_fan`, `cavity_led`,
//! `SET_PURIFIER`, `SET_PRINT_FILAMENT_CONFIG` (a head's material and
//! colour, from the list the printer itself holds: config/snapmaker/
//! filament_parameters.json). On another Klipper printer the standard ones still work
//! (home, jog, temperatures, fans, motors).

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

/// What the printer allows, from its configuration (read once).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Config {
    pub heads: Vec<HeadConfig>,
    /// `[heater_bed] max_temp` (100 °C on the U1).
    pub bed_max: f64,
    /// Travel limits per axis (mm), X, Y, Z.
    pub min: [f64; 3],
    pub max: [f64; 3],
    pub chamber_fan: bool,
    pub light: bool,
    pub purifier: bool,
    /// Snapmaker U1 (its macros and its head docks behind the bed).
    pub u1: bool,
    /// The materials a head can be declared with, as the printer lists
    /// them (U1; empty elsewhere or unreadable).
    pub materials: Vec<Material>,
}

/// A material the U1 knows (`filament_parameters.json`): its type, its
/// vendors and each vendor's subtypes, named as the printer's screen
/// writes them ("Generic" and "" for the generic ones).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Material {
    pub kind: String,
    pub vendors: Vec<Vendor>,
}
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Vendor {
    pub name: String,
    pub subs: Vec<String>,
}

/// A JSON object's keys in the file's order (serde_json's map sorts
/// them), with the nested objects'; other values are dropped.
#[derive(Default, Debug)]
struct Keys(Vec<(String, Keys)>);

impl<'de> Deserialize<'de> for Keys {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = Keys;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a JSON value")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut m: A) -> std::result::Result<Keys, A::Error> {
                let mut out = Vec::new();
                while let Some((k, v)) = m.next_entry::<String, Keys>()? {
                    out.push((k, v));
                }
                Ok(Keys(out))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut s: A) -> std::result::Result<Keys, A::Error> {
                while s.next_element::<serde::de::IgnoredAny>()?.is_some() {}
                Ok(Keys::default())
            }
            fn visit_bool<E: serde::de::Error>(self, _: bool) -> std::result::Result<Keys, E> {
                Ok(Keys::default())
            }
            fn visit_i64<E: serde::de::Error>(self, _: i64) -> std::result::Result<Keys, E> {
                Ok(Keys::default())
            }
            fn visit_u64<E: serde::de::Error>(self, _: u64) -> std::result::Result<Keys, E> {
                Ok(Keys::default())
            }
            fn visit_f64<E: serde::de::Error>(self, _: f64) -> std::result::Result<Keys, E> {
                Ok(Keys::default())
            }
            fn visit_str<E: serde::de::Error>(self, _: &str) -> std::result::Result<Keys, E> {
                Ok(Keys::default())
            }
            fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Keys, E> {
                Ok(Keys::default())
            }
        }
        d.deserialize_any(V)
    }
}

/// A name safe inside a quoted G-code parameter.
fn safe_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 32 && s.chars().all(|c| c.is_ascii_alphanumeric() || " -_.+".contains(c))
}

/// The materials of `filament_parameters.json`: `{ "PLA": { "vendor_generic":
/// { "sub_generic": {…}, "sub_Silk": {…} }, "vendor_Snapmaker": … }, … }`,
/// in the file's order.
pub fn parse_materials(json: &str) -> Vec<Material> {
    let Ok(Keys(top)) = serde_json::from_str::<Keys>(json) else { return Vec::new() };
    top.into_iter()
        .filter(|(kind, v)| safe_name(kind) && !v.0.is_empty())
        .filter_map(|(kind, Keys(vendors))| {
            let vendors: Vec<Vendor> = vendors
                .into_iter()
                .filter_map(|(k, Keys(subs))| {
                    let v = k.strip_prefix("vendor_")?;
                    let subs: Vec<String> = subs
                        .into_iter()
                        .filter_map(|(s, _)| s.strip_prefix("sub_").map(|x| if x == "generic" { String::new() } else { x.to_string() }))
                        .filter(|x| x.is_empty() || safe_name(x))
                        .collect();
                    (safe_name(v) && !subs.is_empty())
                        .then(|| Vendor { name: if v == "generic" { "Generic".into() } else { v.to_string() }, subs })
                })
                .collect();
            (!vendors.is_empty()).then_some(Material { kind, vendors })
        })
        .collect()
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct HeadConfig {
    pub index: u8,
    pub max_temp: f64,
    pub min_extrude_temp: f64,
}

/// What the printer says now.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct State {
    /// `print_stats.state`: standby, printing, paused, complete…
    pub state: String,
    /// `machine_state_manager.main_state` (U1): IDLE, BED_LEVELING… ("" elsewhere).
    pub main_state: String,
    pub progress: Option<f64>,
    pub homed: String,
    pub position: [f64; 3],
    /// The active head (index), from `toolhead.extruder`.
    pub active: Option<u8>,
    pub heads: Vec<HeadState>,
    pub bed: Option<Temp>,
    /// 0–1.
    pub part_fan: Option<f64>,
    pub chamber_fan: Option<f64>,
    pub light: Option<bool>,
    pub purifier: Option<bool>,
    /// `idle_timeout.state`: Idle, Ready, Printing.
    pub idle: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct HeadState {
    pub index: u8,
    pub temp: f64,
    pub target: f64,
    /// Filament in the head, from its sensor (`filament_motion_sensor
    /// e<n>_filament`, U1); None elsewhere.
    pub filament: Option<bool>,
    /// The feed module's channel (`filament_feed left|right`, U1): its state
    /// (`load_finish`, `wait_insert`…), filament in its port, automatic
    /// feeding on.
    pub feed_state: Option<String>,
    pub inserted: Option<bool>,
    pub auto_feed: Option<bool>,
    /// The spool read from its RFID tag (`print_task_config.
    /// filament_official`, U1): its material and colour are not editable.
    pub official: Option<bool>,
}

impl HeadState {
    /// Loaded: the head's sensor, else the feed module's last load.
    pub fn loaded(&self) -> Option<bool> {
        self.filament.or_else(|| self.feed_state.as_ref().map(|s| s == "load_finish"))
    }
}

/// `machine_state_manager.main_state`: a number on the U1's firmware
/// (MachineMainState), a name in older answers.
const MAIN_STATES: [&str; 14] = [
    "IDLE",
    "PRINTING",
    "XYZ_OFFSET_CALIBRATE",
    "BED_LEVELING",
    "FLOW_CALIBRATION",
    "SHAPER_CALIBRATE",
    "UPGRADING",
    "ABNORMAL",
    "SCREWS_TILT_ADJUST",
    "AUTO_LOAD",
    "AUTO_UNLOAD",
    "MANUAL_LOAD",
    "PARK_POINT_MANUAL_CALIBRATION",
    "HOMING_ORIGIN_CALIBRATION",
];
fn main_state(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.as_u64().and_then(|i| MAIN_STATES.get(i as usize)).map_or_else(|| n.to_string(), |s| s.to_string()),
        _ => String::new(),
    }
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Temp {
    pub temp: f64,
    pub target: f64,
}

/// What the interface may ask for.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    Home {
        axes: String,
    },
    Jog {
        axis: String,
        dist: f64,
    },
    Tool {
        n: u8,
    },
    NozzleTemp {
        n: u8,
        temp: f64,
    },
    BedTemp {
        temp: f64,
    },
    HeatersOff,
    Load {
        n: u8,
    },
    /// Declares head `n`'s material and colour, as the printer's screen does.
    Filament {
        n: u8,
        vendor: String,
        material: String,
        sub_type: String,
        color: String,
    },
    Unload {
        n: u8,
    },
    Extrude {
        n: u8,
    },
    Retract {
        n: u8,
    },
    Clean,
    PurgePosition,
    PartFan {
        pct: f64,
    },
    ChamberFan {
        pct: f64,
    },
    Purifier {
        on: bool,
    },
    Light {
        on: bool,
    },
    MotorsOff,
    FirmwareRestart,
    EmergencyStop,
}

/// How an action is carried out.
#[derive(Debug, Clone, PartialEq)]
pub enum Plan {
    /// A G-code script, and how long it may take.
    Script(String, Duration),
    /// A bare POST to Moonraker.
    Post(&'static str),
}

const HEADS: [&str; 4] = ["extruder", "extruder1", "extruder2", "extruder3"];
/// The jog steps offered (mm).
pub const STEPS: [f64; 4] = [0.1, 1.0, 10.0, 50.0];
/// The nozzle never goes under this Z by a jog (mm).
pub const Z_FLOOR: f64 = 0.5;
/// A jog in Z moves at most this much.
const Z_STEP_MAX: f64 = 10.0;
/// On a U1 the head docks sit behind the bed: a jog stays in front of them
/// (Snapmaker's own routines keep Y ≤ 250).
const U1_Y_MAX: f64 = 270.0;

fn num(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())).filter(|x| x.is_finite())
}

/// The configuration part of `configfile.settings`.
pub fn parse_config(settings: &Value) -> Config {
    let heads = HEADS
        .iter()
        .enumerate()
        .filter_map(|(i, name)| {
            let s = settings.get(*name)?;
            Some(HeadConfig {
                index: i as u8,
                max_temp: num(&s["max_temp"]).unwrap_or(250.0),
                min_extrude_temp: num(&s["min_extrude_temp"]).unwrap_or(170.0),
            })
        })
        .collect();
    let axis = |a: &str, k: &str, d: f64| num(&settings[format!("stepper_{a}")][k]).unwrap_or(d);
    Config {
        heads,
        bed_max: num(&settings["heater_bed"]["max_temp"]).filter(|t| *t > 0.0).unwrap_or(100.0),
        min: [axis("x", "position_min", 0.0), axis("y", "position_min", 0.0), axis("z", "position_min", 0.0)],
        max: [axis("x", "position_max", 200.0), axis("y", "position_max", 200.0), axis("z", "position_max", 200.0)],
        chamber_fan: settings.get("fan_generic cavity_fan").is_some(),
        light: settings.get("led cavity_led").is_some(),
        purifier: settings.get("purifier").is_some(),
        u1: settings.get("gcode_macro auto_bed_mesh_calibrate").is_some() || settings.get("auto_screws_tilt_adjust").is_some(),
        materials: Vec::new(),
    }
}

/// The objects query's `result.status`.
pub fn parse_state(s: &Value) -> State {
    let th = &s["toolhead"];
    let pos = th["position"].as_array().cloned().unwrap_or_default();
    let p = |i: usize| pos.get(i).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let active = th["extruder"].as_str().and_then(|e| HEADS.iter().position(|h| h == &e)).map(|i| i as u8);
    let heads = HEADS
        .iter()
        .enumerate()
        .filter_map(|(i, name)| {
            let h = s.get(*name)?;
            let sensor = &s[format!("filament_motion_sensor e{i}_filament")];
            // T0 T1 on the left module, T2 T3 on the right; keyed extruder0…3.
            let feed = &s[if i < 2 { "filament_feed left" } else { "filament_feed right" }][format!("extruder{i}")];
            let has_feed = feed.is_object() && feed["module_exist"].as_bool() != Some(false);
            Some(HeadState {
                index: i as u8,
                temp: num(&h["temperature"])?,
                target: num(&h["target"]).unwrap_or(0.0),
                filament: sensor["filament_detected"].as_bool(),
                feed_state: has_feed.then(|| feed["channel_state"].as_str().map(str::to_string)).flatten(),
                inserted: has_feed.then(|| feed["filament_detected"].as_bool()).flatten(),
                auto_feed: has_feed.then(|| feed["disable_auto"].as_bool().map(|d| !d)).flatten(),
                official: s["print_task_config"]["filament_official"].get(i).and_then(|v| v.as_bool()),
            })
        })
        .collect();
    let hb = &s["heater_bed"];
    let led = &s["led cavity_led"]["color_data"];
    let light =
        led.as_array().map(|rows| rows.iter().any(|r| r.as_array().is_some_and(|c| c.iter().any(|x| x.as_f64().unwrap_or(0.0) > 0.0))));
    let pur = &s["purifier"];
    let purifier = pur.is_object().then(|| {
        let speed = |k: &str| pur[k]["speed"].as_f64().unwrap_or(0.0);
        speed("inner_fan") > 0.0 || speed("exhaust_fan") > 0.0
    });
    State {
        state: s["print_stats"]["state"].as_str().unwrap_or("").to_string(),
        main_state: main_state(&s["machine_state_manager"]["main_state"]),
        progress: num(&s["display_status"]["progress"]),
        homed: th["homed_axes"].as_str().unwrap_or("").to_string(),
        position: [p(0), p(1), p(2)],
        active,
        heads,
        bed: num(&hb["temperature"]).map(|temp| Temp { temp, target: num(&hb["target"]).unwrap_or(0.0) }),
        part_fan: num(&s["fan"]["speed"]),
        chamber_fan: num(&s["fan_generic cavity_fan"]["speed"]),
        light,
        purifier,
        idle: s["idle_timeout"]["state"].as_str().unwrap_or("").to_string(),
    }
}

/// Printing or paused: only the emergency stop and the light.
pub fn busy_printing(st: &State) -> bool {
    matches!(st.state.as_str(), "printing" | "paused")
}

/// The U1 in one of its own procedures (bed leveling, knob leveling…).
pub fn busy_machine(st: &State) -> bool {
    !st.main_state.is_empty() && st.main_state != "IDLE"
}

fn homed(st: &State, axes: &str) -> bool {
    axes.chars().all(|a| st.homed.contains(a))
}

/// The action as a script, or why not.
pub fn plan(a: &Action, st: &State, cfg: &Config) -> Result<Plan> {
    let short = |s: String| Ok(Plan::Script(s, Duration::from_secs(60)));
    let long = |s: String, min: u64| Ok(Plan::Script(s, Duration::from_secs(min * 60)));
    // Always: the emergency stop, and the light (also during a print).
    match a {
        Action::EmergencyStop => return Ok(Plan::Post("/printer/emergency_stop")),
        Action::Light { on } => {
            if !cfg.light {
                return Err(anyhow!(crate::t!("err.ctl_missing")));
            }
            return short(format!("SET_LED LED=cavity_led WHITE={}", u8::from(*on)));
        }
        _ => {}
    }
    if busy_printing(st) {
        return Err(anyhow!(crate::t!("err.ctl_printing")));
    }
    if let Action::FirmwareRestart = a {
        return Ok(Plan::Post("/printer/firmware_restart"));
    }
    if busy_machine(st) {
        return Err(anyhow!(crate::t!("err.ctl_machine_busy", state = st.main_state)));
    }
    let head = |n: u8| cfg.heads.iter().find(|h| h.index == n).ok_or_else(|| anyhow!(crate::t!("err.ctl_no_head", n = n)));
    // What must be homed (checked in Snapmaker/u1-klipper): Klipper moves
    // need the axes moved homed; a U1 homes X and Y itself to pick a head
    // (T<n>, the feeder), and its idle position (cleaning, purge) needs
    // X and Y. Another printer: everything.
    let need = |axes: &str| if homed(st, axes) { Ok(()) } else { Err(anyhow!(crate::t!("err.ctl_not_homed"))) };
    let need_home = || need("xyz");
    let need_xy = || need(if cfg.u1 { "xy" } else { "xyz" });
    // Loading and unloading: a U1's feed module, and the head's state.
    let feed_head = |n: u8| {
        if !cfg.u1 {
            return Err(anyhow!(crate::t!("err.ctl_missing")));
        }
        Ok(st.heads.iter().find(|h| h.index == n).cloned().unwrap_or_default())
    };
    // Picks head `n` first, unless it is the active one.
    let pick = |n: u8| if st.active == Some(n) { String::new() } else { format!("T{n} A0\n") };
    match a {
        Action::Home { axes } => {
            let axes = axes.to_lowercase();
            if axes.is_empty() || !axes.chars().all(|c| "xyz".contains(c)) {
                return Err(anyhow!("axes: {axes}"));
            }
            // A U1 homes X and Y together, and Z only once they are
            // (homing_xyz_override).
            let mut axes = axes;
            if cfg.u1 && (axes.contains('x') || axes.contains('y')) {
                axes = format!("xy{}", if axes.contains('z') { "z" } else { "" });
            }
            if cfg.u1 && axes == "z" && !homed(st, "xy") {
                return Err(anyhow!(crate::t!("err.ctl_home_xy_first")));
            }
            let all = ["x", "y", "z"].iter().all(|c| axes.contains(c));
            let list: Vec<String> = ["x", "y", "z"].iter().filter(|c| axes.contains(*c)).map(|c| c.to_uppercase()).collect();
            long(if all { "G28".into() } else { format!("G28 {}", list.join(" ")) }, 3)
        }
        Action::Jog { axis, dist } => {
            let i = ["x", "y", "z"].iter().position(|c| *c == axis.to_lowercase()).ok_or_else(|| anyhow!("axis: {axis}"))?;
            need(["x", "y", "z"][i])?;
            if !dist.is_finite() || !STEPS.iter().any(|s| (dist.abs() - s).abs() < 1e-9) {
                return Err(anyhow!("step: {dist}"));
            }
            if i == 2 && dist.abs() > Z_STEP_MAX {
                return Err(anyhow!(crate::t!("err.ctl_z_step", max = Z_STEP_MAX)));
            }
            let to = st.position[i] + dist;
            let max = if i == 1 && cfg.u1 { cfg.max[1].min(U1_Y_MAX) } else { cfg.max[i] };
            let min = if i == 2 { cfg.min[2].max(Z_FLOOR) } else { cfg.min[i] };
            if to < min - 1e-6 || to > max + 1e-6 {
                return Err(anyhow!(crate::t!("err.ctl_out_of_range", axis = axis.to_uppercase(), min = min, max = max)));
            }
            let f = if i == 2 { 600 } else { 6000 };
            // In relative mode, then the printer's own mode back: a U1 macro
            // may have left it relative (INNER_ROUGHLY_CLEAN_NOZZLE…).
            short(format!(
                "SAVE_GCODE_STATE NAME=snapstudio_jog\nG91\nG0 {}{} F{f}\nRESTORE_GCODE_STATE NAME=snapstudio_jog",
                axis.to_uppercase(),
                fmt_mm(*dist)
            ))
        }
        Action::Tool { n } => {
            head(*n)?;
            if !cfg.u1 {
                need_home()?;
            }
            long(format!("T{n} A0"), 2)
        }
        Action::NozzleTemp { n, temp } => {
            let h = head(*n)?;
            let t = temp.clamp(0.0, h.max_temp).round();
            short(format!("M104 T{n} S{t} A0"))
        }
        Action::BedTemp { temp } => short(format!("M140 S{}", temp.clamp(0.0, cfg.bed_max).round())),
        Action::HeatersOff => short("TURN_OFF_HEATERS".into()),
        // The feed module's procedures (filament_feed.py, FEED_AUTO): it
        // homes X and Y when needed, picks the head and heats to the
        // filament's temperature; without LOAD=1 or UNLOAD=1 it does nothing.
        Action::Load { n } => {
            head(*n)?;
            let hs = feed_head(*n)?;
            if hs.loaded() == Some(true) {
                return Err(anyhow!(crate::t!("err.ctl_loaded", n = n)));
            }
            if hs.auto_feed == Some(false) {
                return Err(anyhow!(crate::t!("err.ctl_auto_off", n = n)));
            }
            if hs.inserted == Some(false) {
                return Err(anyhow!(crate::t!("err.ctl_insert", n = n)));
            }
            long(format!("AUTO_FEEDING EXTRUDER={n} LOAD=1"), 10)
        }
        Action::Filament { n, vendor, material, sub_type, color } => {
            head(*n)?;
            let hs = feed_head(*n)?;
            if hs.official == Some(true) {
                return Err(anyhow!(crate::t!("err.ctl_official", n = n)));
            }
            // Only what the printer lists, as it names it.
            let known = cfg
                .materials
                .iter()
                .find(|m| &m.kind == material)
                .and_then(|m| m.vendors.iter().find(|v| &v.name == vendor))
                .is_some_and(|v| v.subs.contains(sub_type));
            if !known {
                return Err(anyhow!(crate::t!("err.ctl_material", kind = material)));
            }
            let hex = color.trim_start_matches('#');
            if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(anyhow!(crate::t!("err.ctl_color")));
            }
            short(format!(
                "SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER={n} VENDOR=\"{vendor}\" FILAMENT_TYPE=\"{material}\" FILAMENT_SUBTYPE=\"{sub_type}\" FILAMENT_COLOR_RGBA={}FF",
                hex.to_uppercase()
            ))
        }
        Action::Unload { n } => {
            head(*n)?;
            if feed_head(*n)?.loaded() == Some(false) {
                return Err(anyhow!(crate::t!("err.ctl_empty", n = n)));
            }
            long(format!("AUTO_FEEDING EXTRUDER={n} UNLOAD=1"), 10)
        }
        Action::Extrude { n } | Action::Retract { n } => {
            let h = head(*n)?;
            let hot = st.heads.iter().find(|x| x.index == *n).is_some_and(|x| x.temp >= h.min_extrude_temp);
            if !hot {
                return Err(anyhow!(crate::t!("err.ctl_cold", t = h.min_extrude_temp)));
            }
            if st.active != Some(*n) && !cfg.u1 {
                need_home()?;
            }
            let cmd = if matches!(a, Action::Extrude { .. }) { "CONTROL_EXTRUDE_ACTION" } else { "CONTROL_RETRACT_ACTION" };
            long(format!("{}{cmd} EXTRUDER={n}", pick(*n)), 3)
        }
        Action::Clean => {
            need_xy()?;
            long("ROUGHLY_CLEAN_NOZZLE".into(), 5)
        }
        Action::PurgePosition => {
            need_xy()?;
            long("MOVE_TO_DISCARD_FILAMENT_POSITION".into(), 2)
        }
        Action::PartFan { pct } => {
            let s = (pct.clamp(0.0, 100.0) * 255.0 / 100.0).round();
            short(if s <= 0.0 { "M107".into() } else { format!("M106 S{s}") })
        }
        Action::ChamberFan { pct } => {
            if !cfg.chamber_fan {
                return Err(anyhow!(crate::t!("err.ctl_missing")));
            }
            short(format!("SET_FAN_SPEED FAN=cavity_fan SPEED={:.2}", pct.clamp(0.0, 100.0) / 100.0))
        }
        Action::Purifier { on } => {
            if !cfg.purifier {
                return Err(anyhow!(crate::t!("err.ctl_missing")));
            }
            short(format!("SET_PURIFIER FAN=inner SPEED={}", u8::from(*on)))
        }
        Action::MotorsOff => short("M84".into()),
        Action::EmergencyStop | Action::Light { .. } | Action::FirmwareRestart => unreachable!(),
    }
}

/// 10 → "10", 0.1 → "0.1", -50 → "-50".
fn fmt_mm(d: f64) -> String {
    let s = format!("{d:.1}");
    s.strip_suffix(".0").map(str::to_string).unwrap_or(s)
}

const QUERY: &str = "print_stats=state&display_status=progress&machine_state_manager&toolhead=homed_axes,position,extruder\
&heater_bed&extruder&extruder1&extruder2&extruder3&fan=speed&fan_generic%20cavity_fan&led%20cavity_led&purifier&idle_timeout=state\
&filament_feed%20left&filament_feed%20right&filament_motion_sensor%20e0_filament&filament_motion_sensor%20e1_filament\
&filament_motion_sensor%20e2_filament&filament_motion_sensor%20e3_filament&print_task_config=filament_official";

/// The printer's state now; with `config`, its configuration too (and a
/// U1's materials).
pub async fn read(host: &str, port: u16, config: bool) -> Result<(State, Option<Config>)> {
    read_with(host, port, config, config).await
}

async fn read_with(host: &str, port: u16, config: bool, materials: bool) -> Result<(State, Option<Config>)> {
    let base = crate::printers::base(host, port);
    let extra = if config { "&configfile=settings" } else { "" };
    let v = crate::printers::get_json(&format!("{base}/printer/objects/query?{QUERY}{extra}")).await?;
    let s = &v["result"]["status"];
    let mut cfg = config.then(|| parse_config(&s["configfile"]["settings"]));
    // A U1's materials, from the file its firmware reads (best effort).
    if let Some(c) = cfg.as_mut().filter(|c| c.u1 && materials) {
        if let Ok(t) = crate::printers::get_text(&format!("{base}/server/files/config/snapmaker/filament_parameters.json")).await {
            c.materials = parse_materials(&t);
        }
    }
    Ok((parse_state(s), cfg))
}

/// Carries an action out, after checking it against the printer now.
pub async fn run(host: &str, port: u16, action: &Action) -> Result<()> {
    // The materials only to check a declaration against them.
    let (st, cfg) = read_with(host, port, true, matches!(action, Action::Filament { .. })).await?;
    match plan(action, &st, cfg.as_ref().expect("config read"))? {
        Plan::Post(path) => crate::printers::post_path(host, port, path).await.map(|_| ()),
        Plan::Script(s, timeout) => crate::printers::gcode_script_for(host, port, &s, timeout).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape of a U1's filament_parameters.json, in its order.
    const MATERIALS: &str = r#"{"version":"0.0.10","hard_filaments_max_flow_k":0.4,
      "PLA":{"vendor_generic":{"sub_generic":{"load_temp":250}},"vendor_Snapmaker":{"sub_generic":{},"sub_Silk":{},"sub_SnapSpeed":{}}},
      "TPU":{"vendor_generic":{"sub_generic":{}},"vendor_Snapmaker":{"sub_generic":{},"sub_95A HF":{}}},
      "PETG":{"vendor_generic":{"sub_generic":{},"sub_HF":{}}},
      "ABS":{"vendor_generic":{"sub_generic":{}}},
      "BAD\"TYPE":{"vendor_generic":{"sub_generic":{}}},
      "EMPTY":{}}"#;

    fn cfg() -> Config {
        let mut c = cfg_bare();
        c.materials = parse_materials(MATERIALS);
        c
    }

    fn cfg_bare() -> Config {
        parse_config(&serde_json::json!({
            "extruder": { "max_temp": "300", "min_extrude_temp": "170" },
            "extruder1": { "max_temp": 300, "min_extrude_temp": 170 },
            "extruder2": { "max_temp": 300 },
            "extruder3": { "max_temp": 300 },
            "heater_bed": { "max_temp": "100" },
            "stepper_x": { "position_min": 0, "position_max": 271 },
            "stepper_y": { "position_min": 0, "position_max": 335 },
            "stepper_z": { "position_min": -6, "position_max": 275 },
            "fan_generic cavity_fan": {}, "led cavity_led": {}, "purifier": {},
            "gcode_macro auto_bed_mesh_calibrate": {}
        }))
    }

    fn idle() -> State {
        parse_state(&serde_json::json!({
            "print_stats": { "state": "standby" },
            "machine_state_manager": { "main_state": "IDLE", "action_code": "IDLE" },
            "toolhead": { "homed_axes": "xyz", "position": [135.0, 135.0, 10.0, 0.0], "extruder": "extruder1" },
            "extruder": { "temperature": 24.0, "target": 0.0 },
            "extruder1": { "temperature": 210.2, "target": 210.0 },
            "extruder2": { "temperature": 23.0, "target": 0.0 },
            "extruder3": { "temperature": 23.0, "target": 0.0 },
            "heater_bed": { "temperature": 58.0, "target": 60.0 },
            "fan": { "speed": 0.5 }, "fan_generic cavity_fan": { "speed": 0.2 },
            "led cavity_led": { "color_data": [[0.0, 0.0, 0.0, 1.0]] },
            "purifier": { "power_detected": true, "inner_fan": { "speed": 0.0 }, "exhaust_fan": { "speed": 0.0 } },
            "idle_timeout": { "state": "Ready" },
            // T0 T1 loaded, T2 empty with filament in its port, T3 empty.
            "filament_motion_sensor e0_filament": { "filament_detected": true, "enabled": true },
            "filament_motion_sensor e1_filament": { "filament_detected": true, "enabled": true },
            "filament_motion_sensor e2_filament": { "filament_detected": false, "enabled": true },
            "filament_motion_sensor e3_filament": { "filament_detected": false, "enabled": true },
            "filament_feed left": {
                "extruder0": { "module_exist": true, "filament_detected": true, "disable_auto": false, "channel_state": "load_finish" },
                "extruder1": { "module_exist": true, "filament_detected": true, "disable_auto": false, "channel_state": "load_finish" }
            },
            "print_task_config": { "filament_official": [false, false, false, false] },
            "filament_feed right": {
                "extruder2": { "module_exist": true, "filament_detected": true, "disable_auto": false, "channel_state": "preload_finish" },
                "extruder3": { "module_exist": true, "filament_detected": false, "disable_auto": false, "channel_state": "wait_insert" }
            }
        }))
    }

    fn script(a: Action, st: &State) -> String {
        match plan(&a, st, &cfg()).unwrap() {
            Plan::Script(s, _) => s,
            p => panic!("{p:?}"),
        }
    }
    fn refused(a: Action, st: &State) -> bool {
        plan(&a, st, &cfg()).is_err()
    }

    #[test]
    fn reads_the_u1() {
        let c = cfg();
        assert_eq!((c.heads.len(), c.heads[0].max_temp, c.heads[2].min_extrude_temp, c.bed_max), (4, 300.0, 170.0, 100.0));
        assert_eq!((c.min, c.max), ([0.0, 0.0, -6.0], [271.0, 335.0, 275.0]));
        assert!(c.chamber_fan && c.light && c.purifier && c.u1);
        // main_state: a number on the U1's firmware.
        let n = |v: Value| parse_state(&serde_json::json!({ "machine_state_manager": { "main_state": v } })).main_state;
        assert_eq!(
            (n(serde_json::json!(0)), n(serde_json::json!(3)), n(serde_json::json!(10)), n(serde_json::json!(99))),
            ("IDLE".into(), "BED_LEVELING".into(), "AUTO_UNLOAD".into(), "99".into())
        );
        assert_eq!(n(serde_json::json!("IDLE")), "IDLE");
        assert!(!busy_machine(&parse_state(&serde_json::json!({ "machine_state_manager": { "main_state": 0 } }))));
        let s = idle();
        assert_eq!(
            (s.active, s.position, s.part_fan, s.chamber_fan, s.light, s.purifier),
            (Some(1), [135.0, 135.0, 10.0], Some(0.5), Some(0.2), Some(true), Some(false))
        );
        assert_eq!((s.heads.len(), s.heads[1].temp, s.bed.clone().unwrap().target, s.main_state.as_str()), (4, 210.2, 60.0, "IDLE"));
        // Another Klipper: no U1 objects.
        let o = parse_state(
            &serde_json::json!({ "toolhead": { "homed_axes": "", "extruder": "extruder" }, "extruder": { "temperature": 20.0, "target": 0.0 } }),
        );
        assert_eq!((o.active, o.light, o.purifier, o.main_state.as_str()), (Some(0), None, None, ""));
        assert_eq!((o.heads[0].filament, o.heads[0].feed_state.clone(), o.heads[0].loaded()), (None, None, None));
        let h = &s.heads;
        assert_eq!(
            (h[0].loaded(), h[2].loaded(), h[2].inserted, h[3].inserted, h[2].auto_feed),
            (Some(true), Some(false), Some(true), Some(false), Some(true))
        );
        assert!(!parse_config(&serde_json::json!({ "extruder": {} })).u1);
    }

    #[test]
    fn reads_the_materials() {
        let m = parse_materials(MATERIALS);
        // The file's order, the screen's names, nothing unsafe or empty.
        assert_eq!(m.iter().map(|x| x.kind.as_str()).collect::<Vec<_>>(), ["PLA", "TPU", "PETG", "ABS"]);
        assert_eq!(m[0].vendors.iter().map(|v| v.name.as_str()).collect::<Vec<_>>(), ["Generic", "Snapmaker"]);
        assert_eq!(m[0].vendors[1].subs, ["", "Silk", "SnapSpeed"]);
        assert_eq!(m[1].vendors[1].subs, ["", "95A HF"]);
        assert!(parse_materials("not json").is_empty());
        // The live U1's state: no tag on these spools.
        assert_eq!(idle().heads[0].official, Some(false));
    }

    #[test]
    fn declares_a_filament() {
        let s = idle();
        let f = |vendor: &str, material: &str, sub: &str, color: &str| Action::Filament {
            n: 2,
            vendor: vendor.into(),
            material: material.into(),
            sub_type: sub.into(),
            color: color.into(),
        };
        // As the screen writes it: "Generic" and an empty subtype for the generic ones.
        assert_eq!(script(f("Generic", "PLA", "", "#ff7a1a"), &s), "SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER=2 VENDOR=\"Generic\" FILAMENT_TYPE=\"PLA\" FILAMENT_SUBTYPE=\"\" FILAMENT_COLOR_RGBA=FF7A1AFF");
        assert_eq!(script(f("Snapmaker", "TPU", "95A HF", "000000"), &s), "SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER=2 VENDOR=\"Snapmaker\" FILAMENT_TYPE=\"TPU\" FILAMENT_SUBTYPE=\"95A HF\" FILAMENT_COLOR_RGBA=000000FF");
        // Only what the printer lists; a real colour.
        assert!(refused(f("Generic", "PLA", "Silk", "#ffffff"), &s), "Silk is Snapmaker's");
        assert!(refused(f("Generic", "NYLON", "", "#ffffff"), &s));
        assert!(refused(f("Generic", "PLA", "", "#fff"), &s));
        assert!(refused(f("Generic", "PLA", "", "#gg0000"), &s));
        // A spool read from its tag is not edited.
        let mut tagged = s.clone();
        tagged.heads[2].official = Some(true);
        assert!(refused(f("Generic", "PLA", "", "#ffffff"), &tagged));
        // Without the printer's list, nothing is declared.
        assert!(plan(&f("Generic", "PLA", "", "#ffffff"), &s, &cfg_bare()).is_err());
        // As the interface sends it.
        let a: Action =
            serde_json::from_str(r##"{"kind":"filament","n":1,"vendor":"Generic","material":"PETG","sub_type":"HF","color":"#000000"}"##)
                .unwrap();
        assert_eq!(
            a,
            Action::Filament { n: 1, vendor: "Generic".into(), material: "PETG".into(), sub_type: "HF".into(), color: "#000000".into() }
        );
    }

    #[test]
    fn the_scripts() {
        let s = idle();
        assert_eq!(script(Action::Home { axes: "xyz".into() }, &s), "G28");
        // A U1 homes X and Y together.
        assert_eq!(script(Action::Home { axes: "zx".into() }, &s), "G28");
        assert_eq!(script(Action::Home { axes: "x".into() }, &s), "G28 X Y");
        assert_eq!(script(Action::Home { axes: "z".into() }, &s), "G28 Z");
        let other = Config { u1: false, ..cfg() };
        assert_eq!(
            plan(&Action::Home { axes: "zx".into() }, &s, &other).map(|p| format!("{p:?}")).unwrap(),
            format!("{:?}", Plan::Script("G28 X Z".into(), Duration::from_secs(180)))
        );
        // A jog leaves the printer's coordinate mode as it found it.
        assert_eq!(
            script(Action::Jog { axis: "x".into(), dist: 10.0 }, &s),
            "SAVE_GCODE_STATE NAME=snapstudio_jog\nG91\nG0 X10 F6000\nRESTORE_GCODE_STATE NAME=snapstudio_jog"
        );
        assert_eq!(
            script(Action::Jog { axis: "z".into(), dist: -0.1 }, &s),
            "SAVE_GCODE_STATE NAME=snapstudio_jog\nG91\nG0 Z-0.1 F600\nRESTORE_GCODE_STATE NAME=snapstudio_jog"
        );
        assert_eq!(script(Action::Tool { n: 2 }, &s), "T2 A0");
        assert_eq!(script(Action::NozzleTemp { n: 0, temp: 215.4 }, &s), "M104 T0 S215 A0");
        assert_eq!(script(Action::NozzleTemp { n: 0, temp: 999.0 }, &s), "M104 T0 S300 A0", "never above max_temp");
        assert_eq!(script(Action::BedTemp { temp: 120.0 }, &s), "M140 S100");
        assert_eq!(script(Action::HeatersOff, &s), "TURN_OFF_HEATERS");
        // The feed module's procedures, as the screen.
        assert_eq!(script(Action::Load { n: 2 }, &s), "AUTO_FEEDING EXTRUDER=2 LOAD=1");
        assert_eq!(script(Action::Unload { n: 1 }, &s), "AUTO_FEEDING EXTRUDER=1 UNLOAD=1");
        assert_eq!(script(Action::Unload { n: 0 }, &s), "AUTO_FEEDING EXTRUDER=0 UNLOAD=1");
        assert_eq!(script(Action::Extrude { n: 1 }, &s), "CONTROL_EXTRUDE_ACTION EXTRUDER=1");
        assert_eq!(script(Action::Retract { n: 1 }, &s), "CONTROL_RETRACT_ACTION EXTRUDER=1");
        assert_eq!(script(Action::Clean, &s), "ROUGHLY_CLEAN_NOZZLE");
        assert_eq!(script(Action::PurgePosition, &s), "MOVE_TO_DISCARD_FILAMENT_POSITION");
        assert_eq!(script(Action::PartFan { pct: 50.0 }, &s), "M106 S128");
        assert_eq!(script(Action::PartFan { pct: 0.0 }, &s), "M107");
        assert_eq!(script(Action::ChamberFan { pct: 20.0 }, &s), "SET_FAN_SPEED FAN=cavity_fan SPEED=0.20");
        assert_eq!(script(Action::Purifier { on: true }, &s), "SET_PURIFIER FAN=inner SPEED=1");
        assert_eq!(script(Action::Light { on: false }, &s), "SET_LED LED=cavity_led WHITE=0");
        assert_eq!(script(Action::MotorsOff, &s), "M84");
        assert_eq!(plan(&Action::EmergencyStop, &s, &cfg()).unwrap(), Plan::Post("/printer/emergency_stop"));
        assert_eq!(plan(&Action::FirmwareRestart, &s, &cfg()).unwrap(), Plan::Post("/printer/firmware_restart"));
    }

    #[test]
    fn the_safety_rules() {
        let s = idle();
        // Z never under 0.5 mm, never more than 10 mm at a time.
        let low = State { position: [135.0, 135.0, 0.55], ..s.clone() };
        assert!(refused(Action::Jog { axis: "z".into(), dist: -0.1 }, &low));
        assert!(refused(Action::Jog { axis: "z".into(), dist: 50.0 }, &s));
        // The travel limits; on a U1, Y stays in front of the head docks.
        assert!(refused(Action::Jog { axis: "x".into(), dist: 50.0 }, &State { position: [250.0, 135.0, 10.0], ..s.clone() }));
        assert!(refused(Action::Jog { axis: "y".into(), dist: 50.0 }, &State { position: [135.0, 250.0, 10.0], ..s.clone() }));
        assert!(refused(Action::Jog { axis: "x".into(), dist: -10.0 }, &State { position: [5.0, 135.0, 10.0], ..s.clone() }));
        // Only the steps offered.
        assert!(refused(Action::Jog { axis: "x".into(), dist: 7.0 }, &s));
        assert!(refused(Action::Jog { axis: "e".into(), dist: 1.0 }, &s));
        // Not homed: no move, no cleaning; a U1 homes X and Y itself to
        // pick a head (T<n>) and to load or unload.
        let cold = State { homed: "".into(), ..s.clone() };
        for a in [Action::Jog { axis: "x".into(), dist: 1.0 }, Action::Clean, Action::PurgePosition] {
            assert!(refused(a, &cold));
        }
        assert!(!refused(Action::Tool { n: 0 }, &cold));
        assert!(plan(&Action::Tool { n: 0 }, &cold, &Config { u1: false, ..cfg() }).is_err(), "another printer: homed first");
        // Only the axis moved needs homing: after the U1's "G28 X Y", X and Y
        // jog, Z waits; Z homes only once X and Y are.
        let xy = State { homed: "xy".into(), ..s.clone() };
        assert!(!refused(Action::Jog { axis: "x".into(), dist: 1.0 }, &xy));
        assert!(!refused(Action::Jog { axis: "y".into(), dist: -1.0 }, &xy));
        assert!(refused(Action::Jog { axis: "z".into(), dist: 1.0 }, &xy));
        assert!(!refused(Action::Clean, &xy), "cleaning needs X and Y");
        assert!(refused(Action::Home { axes: "z".into() }, &cold), "Z before X and Y: the U1 refuses");
        assert!(!refused(Action::Home { axes: "z".into() }, &xy));
        assert!(!refused(Action::Extrude { n: 1 }, &State { homed: "".into(), ..s.clone() }));
        assert!(!refused(Action::Unload { n: 1 }, &cold));
        assert!(!refused(Action::Load { n: 2 }, &cold));
        // Loading: not a loaded head, not without filament in the port, not
        // with automatic feeding off; unloading: not an empty head.
        assert!(refused(Action::Load { n: 0 }, &s), "already loaded");
        assert!(refused(Action::Load { n: 3 }, &s), "nothing in the port");
        assert!(refused(Action::Unload { n: 3 }, &s), "empty");
        let mut manual = s.clone();
        manual.heads[2].auto_feed = Some(false);
        assert!(refused(Action::Load { n: 2 }, &manual));
        // Without a head sensor, the feed module's last load says.
        let mut nosensor = s.clone();
        nosensor.heads.iter_mut().for_each(|h| h.filament = None);
        assert_eq!((nosensor.heads[0].loaded(), nosensor.heads[2].loaded()), (Some(true), Some(false)));
        // Another Klipper printer has no feed module.
        let bare_u1 = Config { u1: false, ..cfg() };
        assert!(plan(&Action::Load { n: 2 }, &s, &bare_u1).is_err());
        assert!(!refused(Action::Home { axes: "xyz".into() }, &cold));
        assert!(!refused(Action::Extrude { n: 1 }, &cold), "the active head extrudes without homing");
        // A cold nozzle does not extrude; an unknown head is refused.
        assert!(refused(Action::Extrude { n: 2 }, &s));
        assert!(refused(Action::Tool { n: 7 }, &s));
        // Printing: only the emergency stop and the light.
        let printing = State { state: "printing".into(), ..s.clone() };
        assert!(refused(Action::HeatersOff, &printing));
        assert!(refused(Action::FirmwareRestart, &printing));
        assert!(!refused(Action::Light { on: true }, &printing));
        assert!(plan(&Action::EmergencyStop, &printing, &cfg()).is_ok());
        // The U1 busy with its own procedure: refused, restart allowed.
        let leveling = State { main_state: "BED_LEVELING".into(), ..s.clone() };
        assert!(refused(Action::Jog { axis: "x".into(), dist: 1.0 }, &leveling));
        assert!(plan(&Action::FirmwareRestart, &leveling, &cfg()).is_ok());
        // What the printer lacks is refused.
        let bare = parse_config(&serde_json::json!({ "extruder": {} }));
        assert!(plan(&Action::Light { on: true }, &s, &bare).is_err());
        assert!(plan(&Action::ChamberFan { pct: 10.0 }, &s, &bare).is_err());
        // Actions arrive from the interface as JSON.
        let a: Action = serde_json::from_str(r#"{"kind":"jog","axis":"y","dist":-1}"#).unwrap();
        assert_eq!(a, Action::Jog { axis: "y".into(), dist: -1.0 });
        assert!(serde_json::from_str::<Action>(r#"{"kind":"gcode","script":"M112"}"#).is_err(), "no raw G-code");
    }
}
