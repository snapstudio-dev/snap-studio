//! The G-code and macros a simulated U1 understands: what the app sends
//! (Control, Bed leveling, the print preparation) and a few usual ones.
//! Anything else gets Klipper's own answer, `Unknown command:"X"`, which
//! the app reads (`printers::unknown_commands`).

use super::machine::{Machine, MeshPhase, OpKind, Probe};
use super::scenario::Spool;
use std::collections::HashMap;

/// What a line does: done, a wait for an operation, or Klipper's error.
#[derive(Debug, PartialEq)]
pub enum Exec {
    Done,
    Wait(u64),
    Fail(String),
}

/// A line's answer: its responses (`notify_gcode_response`) and outcome.
#[derive(Debug)]
pub struct Outcome {
    pub out: Vec<String>,
    pub exec: Exec,
}

/// `NAME=value NAME2="quoted value"` and `X10 Y-2` alike.
pub fn params(rest: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut chars = rest.chars().peekable();
    loop {
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        let mut key = String::new();
        while let Some(&c) = chars.peek() {
            if c == '=' || c.is_whitespace() {
                break;
            }
            key.push(c);
            chars.next();
        }
        if key.is_empty() {
            break;
        }
        if chars.peek() == Some(&'=') {
            chars.next();
            let mut val = String::new();
            if chars.peek() == Some(&'"') {
                chars.next();
                for c in chars.by_ref() {
                    if c == '"' {
                        break;
                    }
                    val.push(c);
                }
            } else {
                while let Some(&c) = chars.peek() {
                    if c.is_whitespace() {
                        break;
                    }
                    val.push(c);
                    chars.next();
                }
            }
            out.insert(key.to_ascii_uppercase(), val);
        } else {
            // Classic G-code: a letter and its number.
            let up = key.to_ascii_uppercase();
            let mut chars = up.chars();
            let k = chars.next().map(String::from).unwrap_or_default();
            out.insert(k, chars.as_str().to_string());
        }
    }
    out
}

fn num(p: &HashMap<String, String>, k: &str) -> Option<f64> {
    p.get(k).and_then(|v| v.trim().parse::<f64>().ok()).filter(|x| x.is_finite())
}

fn head_param(p: &HashMap<String, String>, k: &str) -> Result<u8, String> {
    match num(p, k) {
        Some(n) if (0.0..4.0).contains(&n) => Ok(n as u8),
        _ => Err(format!("Invalid {k}")),
    }
}

impl Machine {
    /// Runs one line.
    pub fn exec(&mut self, line: &str) -> Outcome {
        let mut out = Vec::new();
        let exec = self.exec_into(line, &mut out);
        Outcome { out, exec }
    }

    fn exec_into(&mut self, line: &str, out: &mut Vec<String>) -> Exec {
        let line = line.split(';').next().unwrap_or("").trim();
        if line.is_empty() {
            return Exec::Done;
        }
        let (cmd, rest) = line.split_once(char::is_whitespace).unwrap_or((line, ""));
        let cmd = cmd.to_ascii_uppercase();
        let p = params(rest);
        // A shut down Klipper only restarts.
        if self.klippy != super::machine::Klippy::Ready && !matches!(cmd.as_str(), "FIRMWARE_RESTART" | "RESTART" | "M112" | "STATUS") {
            return Exec::Fail(format!("Printer is not ready: {}", self.klippy.message()));
        }
        let printing = self.run.is_some();
        let fail = |m: &str| Exec::Fail(m.to_string());
        let wait = |m: &mut Machine, kind: OpKind, secs: f64| Exec::Wait(m.start_op(kind, secs));
        match cmd.as_str() {
            "G28" => {
                let mut axes: String = ["X", "Y", "Z"].iter().filter(|a| p.contains_key(**a)).map(|a| a.to_ascii_lowercase()).collect();
                if axes.is_empty() {
                    axes = "xyz".into();
                }
                if axes == "z" && !(self.homed.contains('x') && self.homed.contains('y')) {
                    return fail("Must home X and Y before Z");
                }
                wait(self, OpKind::Home(axes.clone()), 4.0 * axes.len() as f64)
            }
            "G90" => {
                self.relative = false;
                Exec::Done
            }
            "G91" => {
                self.relative = true;
                Exec::Done
            }
            "SAVE_GCODE_STATE" => {
                let name = p.get("NAME").cloned().unwrap_or_else(|| "default".into());
                self.save_gcode_state(name);
                Exec::Done
            }
            "RESTORE_GCODE_STATE" => {
                let name = p.get("NAME").cloned().unwrap_or_else(|| "default".into());
                self.restore_gcode_state(&name);
                Exec::Done
            }
            "G0" | "G1" => {
                let limits = [(0.0, 271.0), (0.0, 335.0), (-6.0, 275.0)];
                let mut to = self.pos;
                let mut dist: f64 = 0.0;
                for (i, a) in ["X", "Y", "Z"].iter().enumerate() {
                    if let Some(v) = num(&p, a) {
                        if !self.homed.contains(a.to_ascii_lowercase().as_str()) {
                            return fail("Must home axis first");
                        }
                        to[i] = if self.relative { self.pos[i] + v } else { v };
                        if to[i] < limits[i].0 - 1e-6 || to[i] > limits[i].1 + 1e-6 {
                            return Exec::Fail(format!("Move out of range: {:.3} {:.3} {:.3} [0.000]", to[0], to[1], to[2]));
                        }
                        dist = dist.max((to[i] - self.pos[i]).abs());
                    }
                }
                self.pos = to;
                if dist > 0.0 {
                    let f = num(&p, "F").unwrap_or(6000.0).max(60.0) / 60.0;
                    return wait(self, OpKind::Timed, dist / f);
                }
                Exec::Done
            }
            "G4" => wait(self, OpKind::Timed, num(&p, "P").unwrap_or(0.0) / 1000.0 + num(&p, "S").unwrap_or(0.0)),
            "M84" | "M18" => {
                self.homed.clear();
                Exec::Done
            }
            _ if cmd.len() >= 2 && cmd.starts_with('T') && cmd[1..].chars().all(|c| c.is_ascii_digit()) => {
                let n: usize = cmd[1..].parse().unwrap_or(99);
                if n > 3 {
                    return Exec::Fail(format!("Unknown command:\"{cmd}\""));
                }
                if printing {
                    return fail("Printer is busy");
                }
                if self.active == n as u8 && self.homed.contains('x') {
                    return Exec::Done;
                }
                wait(self, OpKind::Tool(n as u8), 6.0)
            }
            "M104" | "M109" => {
                let n = match num(&p, "T") {
                    Some(t) if (0.0..4.0).contains(&t) => t as u8,
                    Some(_) => return fail("Invalid T"),
                    None => self.active,
                };
                let s = num(&p, "S").unwrap_or(0.0);
                if s > 300.0 {
                    return Exec::Fail(format!("Requested temperature ({s:.1}) out of range (0.0:300.0)"));
                }
                self.heads[n as usize].nozzle.target = s.max(0.0);
                if cmd == "M109" {
                    return wait(self, OpKind::Heat(n), 0.0);
                }
                Exec::Done
            }
            "M140" | "M190" => {
                let s = num(&p, "S").unwrap_or(0.0);
                if s > 100.0 {
                    return Exec::Fail(format!("Requested temperature ({s:.1}) out of range (0.0:100.0)"));
                }
                self.bed.target = s.max(0.0);
                if cmd == "M190" {
                    return wait(self, OpKind::Heat(4), 0.0);
                }
                Exec::Done
            }
            "TURN_OFF_HEATERS" => {
                for h in self.heads.iter_mut() {
                    h.nozzle.target = 0.0;
                }
                self.bed.target = 0.0;
                Exec::Done
            }
            "M106" => {
                self.fan = (num(&p, "S").unwrap_or(255.0) / 255.0).clamp(0.0, 1.0);
                Exec::Done
            }
            "M107" => {
                self.fan = 0.0;
                Exec::Done
            }
            "SET_FAN_SPEED" => {
                if p.get("FAN").map(String::as_str) != Some("cavity_fan") {
                    return fail("Unknown fan");
                }
                self.cavity_fan = num(&p, "SPEED").unwrap_or(0.0).clamp(0.0, 1.0);
                Exec::Done
            }
            "SET_LED" => {
                if p.get("LED").map(String::as_str) != Some("cavity_led") {
                    return fail("Unknown LED");
                }
                self.light = num(&p, "WHITE").unwrap_or(0.0) > 0.0;
                Exec::Done
            }
            "SET_PURIFIER" => {
                self.purifier = num(&p, "SPEED").unwrap_or(0.0) > 0.0;
                Exec::Done
            }
            "AUTO_FEEDING" => {
                let n = match head_param(&p, "EXTRUDER") {
                    Ok(n) => n,
                    Err(e) => return Exec::Fail(e),
                };
                if printing {
                    return fail("Printer is busy");
                }
                let load = num(&p, "LOAD") == Some(1.0);
                let unload = num(&p, "UNLOAD") == Some(1.0);
                let h = &self.heads[n as usize];
                if load {
                    if h.loaded {
                        return Exec::Fail(format!("extruder{n} is already loaded"));
                    }
                    if !h.inserted {
                        return Exec::Fail(format!("No filament in the port of extruder{n}"));
                    }
                    return wait(self, OpKind::Feed { head: n, load: true }, 45.0);
                }
                if unload {
                    if !h.loaded {
                        return Exec::Fail(format!("extruder{n} is empty"));
                    }
                    return wait(self, OpKind::Feed { head: n, load: false }, 40.0);
                }
                Exec::Done
            }
            "INNER_FILAMENT_UNLOAD" => {
                let n = head_param(&p, "EXTRUDER").unwrap_or(self.active);
                wait(self, OpKind::Feed { head: n, load: false }, 40.0)
            }
            "CONTROL_EXTRUDE_ACTION" | "CONTROL_RETRACT_ACTION" => {
                let n = match head_param(&p, "EXTRUDER") {
                    Ok(n) => n,
                    Err(e) => return Exec::Fail(e),
                };
                if self.heads[n as usize].nozzle.temp < 170.0 {
                    return fail("Extrude below minimum temp");
                }
                wait(self, OpKind::Timed, 8.0)
            }
            "ROUGHLY_CLEAN_NOZZLE" | "INNER_ROUGHLY_CLEAN_NOZZLE" => {
                if !(self.homed.contains('x') && self.homed.contains('y')) {
                    return fail("Must home axis first");
                }
                wait(self, OpKind::Timed, 25.0)
            }
            "MOVE_TO_DISCARD_FILAMENT_POSITION" => {
                if !(self.homed.contains('x') && self.homed.contains('y')) {
                    return fail("Must home axis first");
                }
                self.pos[0] = 135.0;
                self.pos[1] = 250.0;
                wait(self, OpKind::Timed, 3.0)
            }
            "SET_PRINT_FILAMENT_CONFIG" => {
                let n = match head_param(&p, "CONFIG_EXTRUDER") {
                    Ok(n) => n,
                    Err(e) => return Exec::Fail(e),
                };
                let h = &mut self.heads[n as usize];
                if h.spool.official {
                    return fail("The spool's RFID tag decides its material");
                }
                let rgba = p.get("FILAMENT_COLOR_RGBA").cloned().unwrap_or_default();
                h.spool = Spool {
                    kind: p.get("FILAMENT_TYPE").cloned().unwrap_or_default(),
                    sub_type: p.get("FILAMENT_SUBTYPE").cloned().unwrap_or_default(),
                    vendor: p.get("VENDOR").cloned().unwrap_or_else(|| "Generic".into()),
                    color: format!("#{}", rgba.get(..6).unwrap_or("FFFFFF").to_ascii_lowercase()),
                    present: h.loaded,
                    official: false,
                };
                Exec::Done
            }
            "SET_PRINT_EXTRUDER_MAP" => {
                let (Some(t), Some(h)) = (num(&p, "CONFIG_EXTRUDER"), num(&p, "MAP_EXTRUDER")) else {
                    return fail("CONFIG_EXTRUDER and MAP_EXTRUDER required");
                };
                if !(0.0..16.0).contains(&t) || !(0.0..4.0).contains(&h) {
                    return fail("Invalid extruder");
                }
                self.map[t as usize] = h as u8;
                Exec::Done
            }
            "SET_PRINT_USED_EXTRUDERS" => {
                let list: Option<Vec<u8>> =
                    p.get("EXTRUDERS").map(|v| v.split(',').filter_map(|x| x.trim().parse().ok()).filter(|x| *x < 4).collect());
                self.used = list.unwrap_or_default();
                Exec::Done
            }
            "SET_PRINT_PREFERENCE" => {
                let on = num(&p, "VALUE").unwrap_or(0.0) != 0.0;
                match p.get("KEY").map(|k| k.to_ascii_lowercase()).as_deref() {
                    Some("bed_level") => self.prefs[0] = on,
                    Some("flow_calibrate") => self.prefs[1] = on,
                    Some("time_lapse_camera") => self.prefs[2] = on,
                    _ => return fail("Unknown KEY"),
                }
                Exec::Done
            }
            "SET_PRINT_PREFERENCES" => {
                for (i, k) in ["BED_LEVEL", "FLOW_CALIBRATE", "TIME_LAPSE_CAMERA"].iter().enumerate() {
                    if let Some(v) = num(&p, k) {
                        self.prefs[i] = v != 0.0;
                    }
                }
                Exec::Done
            }
            "AUTO_BED_MESH_CALIBRATE" | "BED_MESH_CALIBRATE" => {
                if printing {
                    return fail("Printer is busy");
                }
                if !(self.homed.contains('x') && self.homed.contains('y') && self.homed.contains('z')) {
                    return fail("Must home axis first");
                }
                let auto = cmd == "AUTO_BED_MESH_CALIBRATE";
                let total = (super::mesh::COUNT * super::mesh::COUNT) as u32;
                if auto {
                    let t = num(&p, "TEMP").unwrap_or(60.0).clamp(0.0, 100.0);
                    self.bed.target = t;
                    self.probe = Probe { state: "preheating", current: 0, total, preheat_total: 120.0, preheat_left: 120.0 };
                    return wait(self, OpKind::Mesh { auto, phase: MeshPhase::Heating, point: 0 }, 0.0);
                }
                self.probe = Probe { state: "probing", current: 0, total, preheat_total: 0.0, preheat_left: 0.0 };
                wait(self, OpKind::Mesh { auto, phase: MeshPhase::Probing, point: 0 }, total as f64 * 1.2)
            }
            "M117" => Exec::Done,
            "RESPOND" => {
                out.push(format!("echo: {}", p.get("MSG").cloned().unwrap_or_default()));
                Exec::Done
            }
            "STATUS" => {
                out.push(format!("// Klipper state: {}", if self.klippy == super::machine::Klippy::Ready { "Ready" } else { "Shutdown" }));
                Exec::Done
            }
            "M115" => {
                out.push(format!("ok FIRMWARE_NAME:Klipper FIRMWARE_VERSION:v0.12.0-sim U1 {}", self.spec.firmware));
                Exec::Done
            }
            "PAUSE" => {
                if !self.pause() {
                    return fail("Print already paused");
                }
                Exec::Done
            }
            "RESUME" => match self.resume() {
                Ok(()) => Exec::Done,
                Err(e) => Exec::Fail(e),
            },
            "CANCEL_PRINT" => match self.cancel() {
                Ok(()) => Exec::Done,
                Err(e) => Exec::Fail(e),
            },
            "M112" => {
                self.shutdown("Shutdown due to M112 command");
                Exec::Done
            }
            "FIRMWARE_RESTART" | "RESTART" => {
                self.firmware_restart();
                Exec::Done
            }
            _ => {
                out.push(format!("// Unknown command:\"{cmd}\""));
                Exec::Done
            }
        }
    }

    /// The abort of a measurement in progress (`bed_mesh/abort_probe_mesh`).
    pub fn abort_mesh(&mut self) -> Result<(), String> {
        let Some(op) = self.op.as_mut() else { return Err("No bed mesh probing in progress".into()) };
        match &op.kind {
            OpKind::Mesh { auto, phase, point } if matches!(phase, MeshPhase::Preheating | MeshPhase::Prescanning | MeshPhase::Probing) => {
                op.kind = OpKind::Mesh { auto: *auto, phase: MeshPhase::Aborting, point: *point };
                op.left = 2.0;
                self.probe.state = "aborting";
                Ok(())
            }
            OpKind::Mesh { .. } => Err("Probing has not started yet: only the emergency stop can stop the heating".into()),
            _ => Err("No bed mesh probing in progress".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::scenario::load;

    fn alpha() -> Machine {
        Machine::new(load("solo").unwrap().printers[0].clone(), 1.0, 0.0, None)
    }

    /// Runs a script to its end, the clock moving as needed.
    fn run(m: &mut Machine, script: &str) -> Result<Vec<String>, String> {
        let mut out = Vec::new();
        for line in script.lines() {
            let o = m.exec(line);
            out.extend(o.out);
            match o.exec {
                Exec::Done => {}
                Exec::Fail(e) => return Err(e),
                Exec::Wait(id) => {
                    let mut t = m.last;
                    loop {
                        if let Some(r) = m.op_result(id) {
                            r?;
                            break;
                        }
                        t += 1.0;
                        m.sync(t);
                        assert!(t < 100_000.0, "never ends");
                    }
                }
            }
        }
        Ok(out)
    }

    #[test]
    fn parameters_of_both_kinds() {
        let p = params(r#"CONFIG_EXTRUDER=2 VENDOR="Generic" FILAMENT_SUBTYPE="95A HF" FILAMENT_COLOR_RGBA=FF7A1AFF"#);
        assert_eq!((p["CONFIG_EXTRUDER"].as_str(), p["FILAMENT_SUBTYPE"].as_str(), p["VENDOR"].as_str()), ("2", "95A HF", "Generic"));
        // A word that is not ASCII (a message) never splits inside a character.
        let p = params("État 10");
        assert_eq!((p["É"].as_str(), p["1"].as_str()), ("TAT", "0"));
        assert!(alpha().exec("M117 État 2/3").exec == Exec::Done);
        let p = params("X10 Y-2.5 F6000");
        assert_eq!((p["X"].as_str(), p["Y"].as_str(), p["F"].as_str()), ("10", "-2.5", "6000"));
    }

    #[test]
    fn the_controls_scripts() {
        let mut m = alpha();
        // Not homed: no move.
        assert!(run(&mut m, "G91\nG0 X10 F6000").is_err());
        run(&mut m, "G28\nG90").unwrap();
        assert_eq!(m.homed, "xyz");
        run(&mut m, "SAVE_GCODE_STATE NAME=snapstudio_jog\nG91\nG0 X10 F6000\nRESTORE_GCODE_STATE NAME=snapstudio_jog").unwrap();
        assert_eq!((m.pos[0], m.relative), (145.0, false));
        run(&mut m, "T2 A0").unwrap();
        assert_eq!(m.active, 2);
        assert_eq!(m.heads[2].switch_count, 252);
        run(&mut m, "M104 T2 S215 A0\nM140 S60").unwrap();
        assert_eq!((m.heads[2].nozzle.target, m.bed.target), (215.0, 60.0));
        assert!(run(&mut m, "CONTROL_EXTRUDE_ACTION EXTRUDER=2").is_err(), "cold");
        run(&mut m, "M109 T2 S215").unwrap();
        run(&mut m, "CONTROL_EXTRUDE_ACTION EXTRUDER=2").unwrap();
        run(&mut m, "SET_LED LED=cavity_led WHITE=0\nSET_FAN_SPEED FAN=cavity_fan SPEED=0.20\nSET_PURIFIER FAN=inner SPEED=1\nM106 S128")
            .unwrap();
        assert!(!m.light && (m.cavity_fan - 0.2).abs() < 1e-9 && m.purifier && (m.fan - 128.0 / 255.0).abs() < 1e-9);
        // Unload then load a head.
        run(&mut m, "AUTO_FEEDING EXTRUDER=1 UNLOAD=1").unwrap();
        assert!(!m.heads[1].loaded);
        assert!(run(&mut m, "AUTO_FEEDING EXTRUDER=1 LOAD=1").is_err(), "nothing in the port");
        m.heads[1].inserted = true;
        run(&mut m, "AUTO_FEEDING EXTRUDER=1 LOAD=1").unwrap();
        assert!(m.heads[1].loaded);
        // A head's material; never a tagged spool's.
        run(&mut m, r#"SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER=0 VENDOR="Generic" FILAMENT_TYPE="PETG" FILAMENT_SUBTYPE="HF" FILAMENT_COLOR_RGBA=00FF00FF"#).unwrap();
        assert_eq!((m.heads[0].spool.kind.as_str(), m.heads[0].spool.color.as_str()), ("PETG", "#00ff00"));
        assert!(run(&mut m, "SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER=2 FILAMENT_TYPE=PLA").is_err());
        // Klipper's answer to what it does not know.
        let out = run(&mut m, "SOMETHING_ELSE X=1").unwrap();
        assert_eq!(out, vec!["// Unknown command:\"SOMETHING_ELSE\"".to_string()]);
        assert_eq!(crate::printers::unknown_commands(&out, "SOMETHING_ELSE X=1"), vec!["SOMETHING_ELSE"]);
        // The emergency stop, then a restart.
        run(&mut m, "M112").unwrap();
        assert!(run(&mut m, "G28").is_err());
        run(&mut m, "FIRMWARE_RESTART").unwrap();
        assert_eq!(m.homed, "");
        run(&mut m, "G28").unwrap();
    }

    #[test]
    fn a_bed_mesh_like_the_u1() {
        let mut m = alpha();
        let before = m.mesh.clone();
        assert!(run(&mut m, "AUTO_BED_MESH_CALIBRATE TEMP=60").is_err(), "homed first");
        run(&mut m, "G28\nAUTO_BED_MESH_CALIBRATE TEMP=60\nM140 S0").unwrap();
        assert_eq!((m.probe.state, m.probe.current, m.probe.total), ("completed", 169, 169));
        assert_ne!(m.mesh, before);
        assert_eq!(m.main_state, super::super::machine::IDLE);
        // Aborted while probing.
        let o = m.exec("AUTO_BED_MESH_CALIBRATE TEMP=55");
        let Exec::Wait(id) = o.exec else { panic!() };
        assert!(m.abort_mesh().is_err(), "still heating");
        let mut t = m.last;
        while m.probe.state != "probing" {
            t += 1.0;
            m.sync(t);
        }
        m.abort_mesh().unwrap();
        m.sync(t + 5.0);
        assert_eq!(m.op_result(id), Some(Err("Bed mesh probing aborted".into())));
        assert_eq!(m.probe.state, "aborted");
    }
}
