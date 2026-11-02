//! A simulated Snapmaker U1 behind its fake Moonraker: four heads with
//! their spools, heaters that move toward their target, a toolhead, the
//! print runner, the bed mesh measurement, the counters, the history, the
//! camera and the faults. Time moves by `sync` (real seconds, turned into
//! simulated ones by the time factor); what the app reads comes out as
//! Klipper's objects.

use super::faults::{Fault, Scheduled};
use super::print::{preamble, rate, Plan};
use super::scenario::{PrinterSpec, Spool, Start};
use super::{fixtures, mesh};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

pub const AMBIENT: f64 = 25.0;
/// Klipper's objects of a U1, as `printer.objects.list` gives them.
pub const OBJECTS: [&str; 30] = [
    "webhooks",
    "configfile",
    "heaters",
    "print_task_config",
    "print_stats",
    "display_status",
    "virtual_sdcard",
    "idle_timeout",
    "machine_state_manager",
    "toolhead",
    "gcode_move",
    "extruder",
    "extruder1",
    "extruder2",
    "extruder3",
    "heater_bed",
    "chamber",
    "fan",
    "fan_generic cavity_fan",
    "led cavity_led",
    "purifier",
    "filament_feed left",
    "filament_feed right",
    "filament_motion_sensor e0_filament",
    "filament_motion_sensor e1_filament",
    "filament_motion_sensor e2_filament",
    "filament_motion_sensor e3_filament",
    "bed_mesh",
    "exclude_object",
    "system_stats",
];

/// What the network side does with the port.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Net {
    Open,
    /// Connections refused (and live ones closed).
    Refusing,
    /// Port closed.
    Closed,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Klippy {
    Ready,
    Shutdown(String),
    Error(String),
}

impl Klippy {
    pub fn state(&self) -> &'static str {
        match self {
            Klippy::Ready => "ready",
            Klippy::Shutdown(_) => "shutdown",
            Klippy::Error(_) => "error",
        }
    }
    pub fn message(&self) -> String {
        match self {
            Klippy::Ready => "Printer is ready".into(),
            Klippy::Shutdown(m) | Klippy::Error(m) => m.clone(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Heater {
    pub temp: f64,
    pub target: f64,
    /// Heating, °C per simulated second.
    rise: f64,
    /// Cooling time constant, simulated seconds.
    tau: f64,
}

impl Heater {
    fn new(rise: f64, tau: f64) -> Heater {
        Heater { temp: AMBIENT, target: 0.0, rise, tau }
    }

    fn step(&mut self, dt: f64) {
        if self.target > self.temp {
            self.temp = (self.temp + self.rise * dt).min(self.target);
        } else if self.temp > AMBIENT {
            // Off: it cools toward the room, and holds at its target.
            let cooled = AMBIENT + (self.temp - AMBIENT) * (-dt / self.tau).exp();
            self.temp = if self.target > 0.0 { cooled.max(self.target) } else { cooled };
        }
    }

    pub fn reached(&self) -> bool {
        self.target <= 0.0 || (self.temp - self.target).abs() < 1.0
    }

    fn json(&self) -> Value {
        let power = if self.target > self.temp + 0.5 {
            1.0
        } else if self.target > 0.0 {
            0.35
        } else {
            0.0
        };
        json!({ "temperature": (self.temp * 100.0).round() / 100.0, "target": self.target, "power": power })
    }
}

/// One of the four heads, with its spool and its feed channel.
#[derive(Clone, Debug)]
pub struct Head {
    pub nozzle: Heater,
    pub spool: Spool,
    /// Filament in the head (its motion sensor).
    pub loaded: bool,
    /// Filament in the feed module's port.
    pub inserted: bool,
    pub auto_feed: bool,
    pub switch_count: u64,
    pub last_maintenance_count: u64,
    pub retry_count: u64,
    pub error_count: u64,
}

/// A print running.
#[derive(Clone, Debug)]
pub struct Run {
    pub file: String,
    pub plan: Arc<Plan>,
    /// Simulated seconds since the start, preamble included.
    pub t: f64,
    pub pre: f64,
    pub rate: f64,
    pub paused: bool,
    /// G-code tool → head.
    pub map: [u8; 16],
    next_change: usize,
    /// Index in `history`.
    job: usize,
}

impl Run {
    /// Seconds into the file.
    pub fn file_t(&self) -> f64 {
        (self.t - self.pre).clamp(0.0, self.plan.total)
    }
    pub fn progress(&self) -> f64 {
        self.file_t() / self.plan.total
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum MeshPhase {
    Heating,
    Preheating,
    Prescanning,
    Probing,
    Aborting,
}

/// Something the printer does that takes time; a script waits for it.
#[derive(Clone, Debug, PartialEq)]
pub enum OpKind {
    Home(String),
    Tool(u8),
    Feed {
        head: u8,
        load: bool,
    },
    /// A heater reaching its target: a head, or the bed (4).
    Heat(u8),
    Timed,
    Mesh {
        auto: bool,
        phase: MeshPhase,
        point: u32,
    },
}

#[derive(Clone, Debug)]
pub struct Op {
    pub id: u64,
    pub kind: OpKind,
    /// Simulated seconds left in its current phase.
    pub left: f64,
}

/// The faults in force.
#[derive(Clone, Debug, Default)]
pub struct Faults {
    /// Real seconds (clock) until which connections are refused.
    pub refuse_until: f64,
    /// Until when the port is closed (infinity: until cleared).
    pub closed_until: f64,
    pub slow_ms: u64,
    pub upload_fail: Option<f64>,
    pub start_refused: Option<String>,
    pub no_start_local_print: bool,
    pub camera_off: bool,
    pub pick_fail: bool,
    pub disk_full: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Probe {
    pub state: &'static str,
    pub current: u32,
    pub total: u32,
    pub preheat_total: f64,
    pub preheat_left: f64,
}

/// `print_stats` and what goes with it.
#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub state: String,
    pub filename: String,
    pub message: String,
    pub duration: f64,
    pub total: f64,
    pub filament: f64,
    pub layer: Option<(u32, u32)>,
    pub progress: f64,
}

pub struct Machine {
    pub spec: PrinterSpec,
    pub factor: f64,
    /// Clock time of the last `sync`.
    pub last: f64,
    /// Unix time at clock 0.
    pub epoch: f64,
    /// Simulated seconds since the start.
    pub sim_s: f64,
    pub klippy: Klippy,
    pub heads: Vec<Head>,
    pub bed: Heater,
    pub chamber: Heater,
    pub homed: String,
    pub pos: [f64; 4],
    pub active: u8,
    pub relative: bool,
    saved_states: HashMap<String, bool>,
    pub fan: f64,
    pub cavity_fan: f64,
    pub light: bool,
    pub purifier: bool,
    pub purifier_s: f64,
    /// Tool → head, as `SET_PRINT_EXTRUDER_MAP` set it.
    pub map: [u8; 16],
    pub used: Vec<u8>,
    /// bed_level, flow_calibrate, time_lapse_camera.
    pub prefs: [bool; 3],
    pub ps: Stats,
    pub run: Option<Run>,
    pub op: Option<Op>,
    op_seq: u64,
    done: VecDeque<(u64, Result<(), String>)>,
    pub mesh: Vec<Vec<f64>>,
    pub mesh_runs: u64,
    pub probe: Probe,
    pub main_state: u8,
    pub camera_until: f64,
    /// (date_index, video file in `camera`).
    pub timelapses: Vec<(String, String)>,
    pub history: Vec<Value>,
    next_job: u64,
    pub faults: Faults,
    scheduled: Vec<(Scheduled, f64)>,
    /// Notifications to push: (method, params).
    pub events: Vec<(String, Value)>,
    /// What was pushed last (`notify_status_update` sends the changes).
    pushed: Map<String, Value>,
    pub idle: &'static str,
    /// Timelapses to write when the print ends: (date_index, seconds).
    pub pending_timelapse: Vec<(String, f64)>,
}

/// Machine state numbers (`machine_state_manager.main_state`).
pub const IDLE: u8 = 0;
pub const PRINTING: u8 = 1;
pub const BED_LEVELING: u8 = 3;
pub const AUTO_LOAD: u8 = 9;
pub const AUTO_UNLOAD: u8 = 10;

fn round(x: f64, digits: i32) -> f64 {
    let k = 10f64.powi(digits);
    (x * k).round() / k
}

pub fn head_name(i: u8) -> String {
    if i == 0 {
        "extruder".into()
    } else {
        format!("extruder{i}")
    }
}

impl Machine {
    /// A printer as its scenario starts it. `print`: the plan of the file
    /// it prints at launch.
    pub fn new(spec: PrinterSpec, factor: f64, epoch: f64, print: Option<Arc<Plan>>) -> Machine {
        let heads: Vec<Head> = (0..4)
            .map(|i| {
                let s = spec.spool(i);
                Head {
                    nozzle: Heater::new(4.0, 40.0),
                    loaded: s.present,
                    inserted: s.present,
                    auto_feed: true,
                    switch_count: spec.switch_counts.get(i).copied().unwrap_or(0),
                    last_maintenance_count: 0,
                    retry_count: 0,
                    error_count: 0,
                    spool: s,
                }
            })
            .collect();
        let mut m = Machine {
            factor,
            last: 0.0,
            epoch,
            sim_s: 0.0,
            klippy: Klippy::Ready,
            heads,
            bed: Heater::new(1.0, 300.0),
            chamber: Heater::new(0.1, 900.0),
            homed: String::new(),
            pos: [0.0, 0.0, 0.0, 0.0],
            active: 0,
            relative: false,
            saved_states: HashMap::new(),
            fan: 0.0,
            cavity_fan: 0.0,
            light: true,
            purifier: false,
            purifier_s: 3600.0 * 12.0,
            map: std::array::from_fn(|i| i as u8),
            used: Vec::new(),
            prefs: [false; 3],
            ps: Stats { state: "standby".into(), ..Default::default() },
            run: None,
            op: None,
            op_seq: 0,
            done: VecDeque::new(),
            mesh: mesh::surface(spec.mesh_seed, 0),
            mesh_runs: 1,
            probe: Probe { state: "idle", ..Default::default() },
            main_state: IDLE,
            camera_until: f64::NEG_INFINITY,
            timelapses: Vec::new(),
            history: Vec::new(),
            next_job: 1,
            faults: Faults { closed_until: f64::NEG_INFINITY, refuse_until: f64::NEG_INFINITY, ..Default::default() },
            scheduled: spec.faults.iter().map(|s| (s.clone(), s.after)).collect(),
            events: Vec::new(),
            pushed: Map::new(),
            idle: "Idle",
            pending_timelapse: Vec::new(),
            spec,
        };
        m.seed_history();
        match (m.spec.start, print) {
            (Start::Printing | Start::Paused, Some(plan)) => {
                let file = m.spec.print.clone().unwrap_or_default();
                m.homed = "xyz".into();
                let tools = plan.tools.clone();
                m.used = tools.clone();
                m.begin(&file, plan.clone(), [false; 3], 0.0);
                if let Some(r) = m.run.as_mut() {
                    r.t = m.spec.progress.clamp(0.0, 0.99) * plan.total;
                }
                // Already hot.
                for t in tools {
                    let h = m.map[t as usize] as usize;
                    m.heads[h].nozzle.temp = plan.nozzle_temp;
                }
                m.bed.temp = plan.bed_temp;
                m.advance_print(0.0);
                if m.spec.start == Start::Paused {
                    m.pause();
                }
            }
            (Start::Error, _) => {
                m.ps.state = "error".into();
                m.ps.filename = m.spec.print.clone().unwrap_or_default();
                m.ps.message = "Heater extruder not heating at expected rate".into();
            }
            (Start::KlippyShutdown, _) => {
                m.klippy = Klippy::Shutdown("MCU 'mcu' shutdown: Timer too close".into());
            }
            _ => {}
        }
        m
    }

    fn seed_history(&mut self) {
        let mut past = self.spec.history.clone();
        past.sort_by(|a, b| b.days_ago.total_cmp(&a.days_ago));
        for p in past {
            let dur = p.minutes as f64 * 60.0;
            let end = self.epoch - p.days_ago * 86_400.0;
            let id = self.job_id();
            self.history.push(json!({
                "job_id": id, "filename": p.file, "status": p.status, "exists": true,
                "start_time": end - dur - 120.0, "end_time": end,
                "print_duration": dur, "total_duration": dur + 120.0,
                "filament_used": p.filament_m * 1000.0,
                "metadata": { "first_layer_bed_temp": 60.0, "estimated_time": dur },
                "auxiliary_data": []
            }));
        }
    }

    fn job_id(&mut self) -> String {
        let id = format!("{:06X}", self.next_job);
        self.next_job += 1;
        id
    }

    pub fn wall(&self) -> f64 {
        self.epoch + self.last
    }

    /// Moves the machine to clock time `now`.
    pub fn sync(&mut self, now: f64) {
        let dt = now - self.last;
        if dt > 0.0 {
            self.last = now;
            self.step(dt);
        }
        // Scheduled faults.
        let mut due = Vec::new();
        for (s, at) in self.scheduled.iter_mut() {
            if *at <= now {
                due.push(s.fault.clone());
                *at = match s.every {
                    Some(e) if e > 0.0 => *at + e,
                    _ => f64::INFINITY,
                };
            }
        }
        self.scheduled.retain(|(_, at)| at.is_finite());
        for f in due {
            self.inject(f);
        }
    }

    fn step(&mut self, dt_real: f64) {
        let dt = dt_real * self.factor;
        self.sim_s += dt;
        for h in self.heads.iter_mut() {
            h.nozzle.step(dt);
        }
        self.bed.step(dt);
        // The chamber follows the bed, a little.
        self.chamber.target = 0.0;
        let warm = AMBIENT + (self.bed.temp - AMBIENT) * 0.25;
        self.chamber.temp += (warm - self.chamber.temp) * (1.0 - (-dt / 600.0).exp());
        if self.purifier {
            self.purifier_s += dt;
        }
        self.step_op(dt);
        self.advance_print(dt_real);
        self.idle = if self.run.as_ref().is_some_and(|r| !r.paused) || self.op.is_some() {
            "Printing"
        } else if self.homed.is_empty() {
            "Idle"
        } else {
            "Ready"
        };
    }

    /* ------------------------------------------------------------ ops */

    pub fn start_op(&mut self, kind: OpKind, left: f64) -> u64 {
        self.op_seq += 1;
        let id = self.op_seq;
        match &kind {
            OpKind::Mesh { .. } => self.main_state = BED_LEVELING,
            OpKind::Feed { load: true, .. } => self.main_state = AUTO_LOAD,
            OpKind::Feed { load: false, .. } => self.main_state = AUTO_UNLOAD,
            _ => {}
        }
        self.op = Some(Op { id, kind, left });
        id
    }

    /// The op's outcome once it is over.
    pub fn op_result(&self, id: u64) -> Option<Result<(), String>> {
        if self.op.as_ref().is_some_and(|o| o.id == id) {
            return None;
        }
        Some(self.done.iter().find(|(i, _)| *i == id).map(|(_, r)| r.clone()).unwrap_or(Ok(())))
    }

    fn end_op(&mut self, r: Result<(), String>) {
        if let Some(op) = self.op.take() {
            if self.run.is_none() {
                self.main_state = IDLE;
            }
            if let Err(e) = &r {
                self.respond(format!("!! {e}"));
            }
            self.done.push_back((op.id, r));
            while self.done.len() > 64 {
                self.done.pop_front();
            }
        }
    }

    /// A G-code response, pushed to every client.
    pub fn respond(&mut self, line: String) {
        self.events.push(("notify_gcode_response".into(), json!([line])));
    }

    fn step_op(&mut self, mut dt: f64) {
        while dt > 0.0 {
            let Some(op) = self.op.as_mut() else { return };
            match op.kind.clone() {
                OpKind::Heat(i) => {
                    let h = if i < 4 { &self.heads[i as usize].nozzle } else { &self.bed };
                    if h.reached() {
                        self.end_op(Ok(()));
                    }
                    return;
                }
                OpKind::Mesh { auto, phase, point } => {
                    if phase == MeshPhase::Heating {
                        if self.bed.reached() {
                            op.kind = OpKind::Mesh { auto, phase: MeshPhase::Preheating, point };
                            op.left = 120.0;
                            self.probe = Probe {
                                state: "preheating",
                                current: 0,
                                total: (mesh::COUNT * mesh::COUNT) as u32,
                                preheat_total: 120.0,
                                preheat_left: 120.0,
                            };
                            continue;
                        }
                        return;
                    }
                    let used = dt.min(op.left);
                    op.left -= used;
                    dt -= used;
                    if phase == MeshPhase::Preheating {
                        self.probe.preheat_left = round(op.left.max(0.0), 0);
                    }
                    if phase == MeshPhase::Probing {
                        let total = self.probe.total.max(1);
                        let per = 1.2;
                        let left_points = (op.left / per).ceil() as u32;
                        self.probe.current = total.saturating_sub(left_points).min(total);
                    }
                    if op.left > 1e-9 {
                        return;
                    }
                    match phase {
                        MeshPhase::Preheating => {
                            op.kind = OpKind::Mesh { auto, phase: MeshPhase::Prescanning, point };
                            op.left = 10.0;
                            self.probe.state = "prescanning";
                            self.probe.preheat_left = 0.0;
                        }
                        MeshPhase::Prescanning => {
                            op.kind = OpKind::Mesh { auto, phase: MeshPhase::Probing, point };
                            op.left = self.probe.total as f64 * 1.2;
                            self.probe.state = "probing";
                        }
                        MeshPhase::Probing => {
                            self.mesh = mesh::surface(self.spec.mesh_seed, self.mesh_runs);
                            self.mesh_runs += 1;
                            self.probe.state = "completed";
                            self.probe.current = self.probe.total;
                            self.end_op(Ok(()));
                        }
                        MeshPhase::Aborting => {
                            self.probe.state = "aborted";
                            self.end_op(Err("Bed mesh probing aborted".into()));
                        }
                        MeshPhase::Heating => {}
                    }
                }
                kind => {
                    let used = dt.min(op.left);
                    op.left -= used;
                    dt -= used;
                    if op.left > 1e-9 {
                        return;
                    }
                    let r = self.finish_op(&kind);
                    self.end_op(r);
                }
            }
        }
    }

    fn finish_op(&mut self, kind: &OpKind) -> Result<(), String> {
        match kind {
            OpKind::Home(axes) => {
                for a in axes.chars() {
                    if !self.homed.contains(a) {
                        self.homed.push(a);
                    }
                }
                let mut h: Vec<char> = self.homed.chars().collect();
                h.sort_unstable();
                self.homed = h.into_iter().collect();
                if axes.contains('x') {
                    self.pos[0] = 135.0;
                }
                if axes.contains('y') {
                    self.pos[1] = 135.0;
                }
                if axes.contains('z') {
                    self.pos[2] = 10.0;
                }
                Ok(())
            }
            OpKind::Tool(n) => self.pick(*n),
            OpKind::Feed { head, load } => {
                let h = &mut self.heads[*head as usize];
                if *load {
                    h.loaded = true;
                    h.spool.present = true;
                    if h.spool.kind.is_empty() {
                        h.spool = Spool {
                            kind: "PLA".into(),
                            color: "#ffffff".into(),
                            vendor: "Generic".into(),
                            sub_type: String::new(),
                            present: true,
                            official: false,
                        };
                    }
                } else {
                    h.loaded = false;
                    h.inserted = false;
                    h.spool = Spool::empty();
                }
                if !self.homed.contains('x') {
                    self.homed = format!("xy{}", if self.homed.contains('z') { "z" } else { "" });
                }
                self.active = *head;
                Ok(())
            }
            _ => Ok(()),
        }
    }

    /// Picks head `n` (U1: it homes X and Y itself first).
    pub fn pick(&mut self, n: u8) -> Result<(), String> {
        if self.faults.pick_fail {
            self.faults.pick_fail = false;
            let h = &mut self.heads[n as usize];
            h.error_count += 1;
            h.retry_count += 1;
            return Err(format!("Failed to pick up extruder{n}: head not detected"));
        }
        if !self.homed.contains('x') || !self.homed.contains('y') {
            self.homed = format!("xy{}", if self.homed.contains('z') { "z" } else { "" });
        }
        if self.active != n {
            self.heads[n as usize].switch_count += 1;
            self.active = n;
        }
        Ok(())
    }

    pub fn save_gcode_state(&mut self, name: String) {
        self.saved_states.insert(name, self.relative);
    }

    pub fn restore_gcode_state(&mut self, name: &str) {
        if let Some(r) = self.saved_states.get(name) {
            self.relative = *r;
        }
    }

    /// Emergency stop and Klipper shutdown: everything stops.
    pub fn shutdown(&mut self, msg: &str) {
        if let Some(op) = &self.op {
            if matches!(op.kind, OpKind::Mesh { .. }) {
                self.probe.state = "aborted";
            }
        }
        self.end_op(Err(msg.to_string()));
        if self.run.is_some() {
            self.end_print("klippy_shutdown", "error", msg);
        }
        for h in self.heads.iter_mut() {
            h.nozzle.target = 0.0;
        }
        self.bed.target = 0.0;
        self.homed.clear();
        self.main_state = IDLE;
        self.klippy = Klippy::Shutdown(msg.to_string());
        self.events.push(("notify_klippy_shutdown".into(), json!([])));
    }

    pub fn firmware_restart(&mut self) {
        self.end_op(Err("Firmware restart".into()));
        if self.run.is_some() {
            self.end_print("klippy_shutdown", "error", "Firmware restart");
        }
        for h in self.heads.iter_mut() {
            h.nozzle.target = 0.0;
        }
        self.bed.target = 0.0;
        self.homed.clear();
        self.main_state = IDLE;
        if self.probe.state != "idle" {
            self.probe = Probe { state: "idle", ..Default::default() };
        }
        self.klippy = Klippy::Ready;
        self.events.push(("notify_klippy_disconnected".into(), json!([])));
        self.events.push(("notify_klippy_ready".into(), json!([])));
    }

    /* ------------------------------------------------------------ print */

    /// Starts a print; the error is the printer's refusal.
    pub fn start_print(
        &mut self,
        file: &str,
        plan: Result<Arc<Plan>, String>,
        opts: [bool; 3],
        map_table: &[[u8; 2]],
    ) -> Result<(), String> {
        if self.klippy != Klippy::Ready {
            return Err(format!("Klippy not ready: {}", self.klippy.message()));
        }
        if matches!(self.ps.state.as_str(), "printing" | "paused") {
            return Err("Printer is busy".into());
        }
        if self.op.is_some() {
            return Err("Printer is busy with another task".into());
        }
        for [t, h] in map_table {
            if (*t as usize) < 16 && *h < 4 {
                self.map[*t as usize] = *h;
            }
        }
        match plan {
            Ok(plan) => {
                // The heads used, after the mapping.
                let mut used: Vec<u8> = plan.tools.iter().map(|t| self.map[(*t as usize).min(15)]).collect();
                used.sort_unstable();
                used.dedup();
                if let Some(h) = used.iter().find(|h| !self.heads[**h as usize].loaded) {
                    return Err(format!("No filament in extruder{h}"));
                }
                self.used = used;
                self.prefs = opts;
                self.begin(file, plan, opts, preamble(opts[0], opts[1]));
                Ok(())
            }
            Err(msg) => {
                // Started, then failed at once, as the U1 does with a file it
                // cannot print.
                self.prefs = opts;
                self.begin_failed(file, &msg);
                Ok(())
            }
        }
    }

    fn begin(&mut self, file: &str, plan: Arc<Plan>, opts: [bool; 3], pre: f64) {
        let job = self.job_id();
        let wall = self.wall();
        self.history.push(json!({
            "job_id": job, "filename": file, "status": "in_progress", "exists": true,
            "start_time": wall, "end_time": null, "print_duration": 0.0, "total_duration": 0.0, "filament_used": 0.0,
            "metadata": { "first_layer_bed_temp": plan.bed_temp, "estimated_time": plan.total }, "auxiliary_data": []
        }));
        let r = rate(self.factor, pre + plan.total);
        for t in &plan.tools {
            let h = self.map[(*t as usize).min(15)] as usize;
            self.heads[h].nozzle.target = plan.nozzle_temp;
        }
        self.bed.target = plan.bed_temp;
        self.fan = 0.0;
        self.ps =
            Stats { state: "printing".into(), filename: file.to_string(), layer: Some((0, plan.total_layers())), ..Default::default() };
        self.main_state = PRINTING;
        self.prefs = opts;
        self.run = Some(Run {
            file: file.to_string(),
            plan,
            t: 0.0,
            pre,
            rate: r,
            paused: false,
            map: self.map,
            next_change: 0,
            job: self.history.len() - 1,
        });
    }

    fn begin_failed(&mut self, file: &str, msg: &str) {
        let job = self.job_id();
        let wall = self.wall();
        self.history.push(json!({
            "job_id": job, "filename": file, "status": "error", "exists": true, "start_time": wall, "end_time": wall,
            "print_duration": 0.0, "total_duration": 0.0, "filament_used": 0.0, "metadata": {}, "auxiliary_data": []
        }));
        self.ps = Stats { state: "error".into(), filename: file.to_string(), message: msg.to_string(), ..Default::default() };
    }

    /// The print's clock: `dt_real` real seconds at the print's rate.
    fn advance_print(&mut self, dt_real: f64) {
        let Some(run) = self.run.as_mut() else { return };
        if !run.paused {
            run.t += dt_real * run.rate;
        }
        let ft = run.t - run.pre;
        // Tool changes passed.
        let mut picks = Vec::new();
        while run.next_change < run.plan.changes.len() && run.plan.changes[run.next_change].0 <= ft {
            let tool = run.plan.changes[run.next_change].1;
            picks.push(run.map[(tool as usize).min(15)]);
            run.next_change += 1;
        }
        let run = run.clone();
        for h in picks {
            if let Err(e) = self.pick(h) {
                self.respond(format!("!! {e}"));
                self.end_print("error", "error", &e);
                return;
            }
        }
        let p = run.progress();
        self.ps.duration = run.file_t();
        self.ps.total = run.t;
        self.ps.filament = p * run.plan.filament_mm;
        self.ps.progress = p;
        self.ps.layer = Some((if ft <= 0.0 { 0 } else { run.plan.layer_at(ft) }, run.plan.total_layers()));
        if let Some(j) = self.history.get_mut(run.job) {
            j["print_duration"] = json!(round(self.ps.duration, 1));
            j["total_duration"] = json!(round(run.t, 1));
            j["filament_used"] = json!(round(self.ps.filament, 1));
        }
        if ft >= run.plan.total {
            self.ps.progress = 1.0;
            self.ps.duration = run.plan.total;
            self.ps.filament = run.plan.filament_mm;
            self.end_print("completed", "complete", "");
        }
    }

    /// The end of the print: `status` for the history, `state` for
    /// `print_stats`.
    pub fn end_print(&mut self, status: &str, state: &str, msg: &str) {
        let Some(run) = self.run.take() else { return };
        let wall = self.wall();
        if let Some(j) = self.history.get_mut(run.job) {
            j["status"] = json!(status);
            j["end_time"] = json!(wall);
            j["print_duration"] = json!(round(run.file_t(), 1));
            j["total_duration"] = json!(round(run.t, 1));
            j["filament_used"] = json!(round(run.progress() * run.plan.filament_mm, 1));
        }
        self.ps.state = state.to_string();
        self.ps.message = msg.to_string();
        for h in self.heads.iter_mut() {
            h.nozzle.target = 0.0;
        }
        self.bed.target = 0.0;
        self.fan = 0.0;
        self.main_state = IDLE;
        if status == "completed" && self.prefs[2] {
            // The camera's video of the print, written by the network side.
            let date = fixtures::date_index(wall);
            self.pending_timelapse.push((date, (run.plan.total / 30.0).clamp(5.0, 120.0)));
        }
    }

    pub fn pause(&mut self) -> bool {
        match self.run.as_mut() {
            Some(r) if !r.paused => {
                r.paused = true;
                self.ps.state = "paused".into();
                true
            }
            _ => false,
        }
    }

    pub fn resume(&mut self) -> Result<(), String> {
        let Some(r) = self.run.as_ref() else { return Err("Print is not paused, resume aborted".into()) };
        if !r.paused {
            return Err("Print is not paused, resume aborted".into());
        }
        // Every head the print uses must have its filament back.
        if let Some(h) = self.used.iter().find(|h| !self.heads[**h as usize].loaded) {
            return Err(format!("Filament runout on extruder{h}: load filament before resuming"));
        }
        if let Some(r) = self.run.as_mut() {
            r.paused = false;
        }
        self.ps.state = "printing".into();
        self.ps.message.clear();
        Ok(())
    }

    pub fn cancel(&mut self) -> Result<(), String> {
        if self.run.is_none() {
            return Err("No print in progress".into());
        }
        self.end_print("cancelled", "cancelled", "");
        Ok(())
    }

    /* ------------------------------------------------------------ faults */

    pub fn inject(&mut self, f: Fault) {
        let now = self.last;
        match f {
            Fault::Disconnect { secs } => self.faults.refuse_until = now + secs.max(0.0),
            Fault::Unreachable { secs } => self.faults.closed_until = if secs > 0.0 { now + secs } else { f64::INFINITY },
            Fault::Slow { ms } => self.faults.slow_ms = ms,
            Fault::KlippyShutdown { message } => self.shutdown(&message.unwrap_or_else(|| "MCU 'mcu' shutdown: Timer too close".into())),
            Fault::KlippyError { message } => {
                let msg = message.unwrap_or_else(|| "Unable to connect to MCU 'mcu' (simulated)".into());
                self.shutdown(&msg);
                self.klippy = Klippy::Error(msg);
                self.events.retain(|(m, _)| m != "notify_klippy_shutdown");
                self.events.push(("notify_klippy_disconnected".into(), json!([])));
            }
            Fault::Runout { head } => {
                let i = (head as usize).min(3);
                let h = &mut self.heads[i];
                h.loaded = false;
                h.inserted = false;
                h.spool.present = false;
                if self.run.as_ref().is_some_and(|r| !r.paused) && self.used.contains(&(i as u8)) {
                    self.pause();
                    self.ps.message = format!("Filament runout detected on extruder{i}");
                    self.respond(format!("// Filament runout detected on extruder{i}"));
                }
            }
            Fault::UploadFail { at } => self.faults.upload_fail = Some(at.clamp(0.0, 100.0)),
            Fault::StartRefused { message } => {
                self.faults.start_refused = Some(message.unwrap_or_else(|| "Nozzle type does not match the file".into()))
            }
            Fault::NoStartLocalPrint => self.faults.no_start_local_print = true,
            Fault::CameraOff => self.faults.camera_off = true,
            Fault::HeadPickFail => self.faults.pick_fail = true,
            Fault::PrintError { message } => {
                let msg = message.unwrap_or_else(|| "Simulated print error".into());
                if self.run.is_some() {
                    self.respond(format!("!! {msg}"));
                    self.end_print("error", "error", &msg);
                }
            }
            Fault::DiskFull => self.faults.disk_full = true,
        }
    }

    /// Back to normal: every fault in force goes (Klipper's state stays
    /// until a firmware restart).
    pub fn clear_faults(&mut self) {
        self.faults = Faults { closed_until: f64::NEG_INFINITY, refuse_until: f64::NEG_INFINITY, ..Default::default() };
        self.scheduled.clear();
    }

    pub fn net(&self) -> Net {
        if self.last < self.faults.closed_until {
            Net::Closed
        } else if self.last < self.faults.refuse_until {
            Net::Refusing
        } else {
            Net::Open
        }
    }

    /// The faults in force, by name (Developer section).
    pub fn fault_names(&self) -> Vec<&'static str> {
        let f = &self.faults;
        let mut out = Vec::new();
        if self.last < f.refuse_until {
            out.push("disconnect");
        }
        if self.last < f.closed_until {
            out.push("unreachable");
        }
        for (on, n) in [
            (f.slow_ms > 0, "slow"),
            (f.upload_fail.is_some(), "upload_fail"),
            (f.start_refused.is_some(), "start_refused"),
            (f.no_start_local_print, "no_start_local_print"),
            (f.camera_off, "camera_off"),
            (f.pick_fail, "head_pick_fail"),
            (f.disk_full, "disk_full"),
            (matches!(self.klippy, Klippy::Shutdown(_)), "klippy_shutdown"),
            (matches!(self.klippy, Klippy::Error(_)), "klippy_error"),
        ] {
            if on {
                out.push(n);
            }
        }
        out
    }

    /// Puts a spool in head `n`'s port and loads it (Developer section): a
    /// runout is over, the spool check has something new to read.
    pub fn set_spool(&mut self, n: u8, spool: Spool) {
        let h = &mut self.heads[(n as usize).min(3)];
        h.loaded = spool.present;
        h.inserted = spool.present;
        h.spool = spool;
    }

    /* ------------------------------------------------------------ objects */

    pub fn camera_on(&self) -> bool {
        !self.faults.camera_off && self.last < self.camera_until
    }

    /// One of Klipper's objects, whole.
    pub fn object(&self, name: &str) -> Option<Value> {
        let busy = self.run.is_some();
        Some(match name {
            "webhooks" => json!({ "state": self.klippy.state(), "state_message": self.klippy.message() }),
            "configfile" => json!({ "settings": fixtures::settings(), "save_config_pending": false }),
            "heaters" => json!({
                "available_heaters": ["heater_bed", "extruder", "extruder1", "extruder2", "extruder3"],
                "available_sensors": ["heater_bed", "extruder", "extruder1", "extruder2", "extruder3", "chamber"]
            }),
            "print_task_config" => {
                let s = |f: &dyn Fn(&Head) -> Value| self.heads.iter().map(f).collect::<Vec<_>>();
                json!({
                    "filament_type": s(&|h| if h.spool.kind.is_empty() { json!("NONE") } else { json!(h.spool.kind) }),
                    "filament_sub_type": s(&|h| if h.spool.kind.is_empty() { json!("NONE") } else { json!(h.spool.sub_type) }),
                    "filament_vendor": s(&|h| if h.spool.kind.is_empty() { json!("NONE") } else { json!(h.spool.vendor) }),
                    "filament_color_rgba": s(&|h| {
                        let [r, g, b] = fixtures::rgb(&h.spool.color);
                        json!(format!("{r:02X}{g:02X}{b:02X}FF"))
                    }),
                    "filament_color": s(&|h| {
                        let [r, g, b] = fixtures::rgb(&h.spool.color);
                        json!(0xFF00_0000u64 | (r as u64) << 16 | (g as u64) << 8 | b as u64)
                    }),
                    "filament_exist": s(&|h| json!(h.spool.present && h.loaded)),
                    "filament_official": s(&|h| json!(h.spool.official)),
                    "extruders_used": self.used,
                    "extruder_map_table": (0..4u8).map(|t| [t, self.map[t as usize]]).collect::<Vec<_>>(),
                    "auto_bed_leveling": self.prefs[0],
                    "flow_calibrate": self.prefs[1],
                    "time_lapse_camera": self.prefs[2],
                })
            }
            "print_stats" => json!({
                "filename": self.ps.filename,
                "total_duration": round(self.run.as_ref().map(|r| r.t).unwrap_or(self.ps.total), 2),
                "print_duration": round(self.ps.duration, 2),
                "filament_used": round(self.ps.filament, 2),
                "state": self.ps.state,
                "message": self.ps.message,
                "info": {
                    "total_layer": self.ps.layer.map(|l| l.1),
                    "current_layer": self.ps.layer.map(|l| l.0),
                },
            }),
            "display_status" => json!({ "progress": round(self.ps.progress, 4), "message": null }),
            "virtual_sdcard" => json!({
                "file_path": if self.ps.filename.is_empty() { Value::Null } else { json!(format!("/home/sim/printer_data/gcodes/{}", self.ps.filename)) },
                "progress": round(self.ps.progress, 4),
                "is_active": self.run.as_ref().is_some_and(|r| !r.paused),
                "file_position": 0,
                "file_size": 0,
            }),
            "idle_timeout" => json!({ "state": self.idle, "printing_time": if busy { round(self.ps.total, 1) } else { 0.0 } }),
            "machine_state_manager" => {
                json!({ "main_state": self.main_state, "action_code": if self.main_state == IDLE { "IDLE" } else { "BUSY" } })
            }
            "toolhead" => json!({
                "homed_axes": self.homed,
                "position": self.pos,
                "extruder": head_name(self.active),
                "print_time": round(self.sim_s, 2),
                "estimated_print_time": round(self.sim_s, 2),
                "max_velocity": 500.0,
                "max_accel": 20000.0,
                "axis_minimum": [0.0, 0.0, -6.0, 0.0],
                "axis_maximum": [271.0, 335.0, 275.0, 0.0],
            }),
            "gcode_move" => json!({
                "speed_factor": 1.0, "extrude_factor": 1.0, "speed": 1500.0,
                "absolute_coordinates": !self.relative, "absolute_extrude": false,
                "position": self.pos, "gcode_position": self.pos, "homing_origin": [0.0, 0.0, 0.0, 0.0],
            }),
            "extruder" | "extruder1" | "extruder2" | "extruder3" => {
                let i = name.trim_start_matches("extruder").parse::<usize>().unwrap_or(0);
                let h = self.heads.get(i)?;
                let mut v = h.nozzle.json();
                let o = v.as_object_mut()?;
                o.insert("can_extrude".into(), json!(h.nozzle.temp >= 170.0));
                o.insert("pressure_advance".into(), json!(0.02));
                o.insert("smooth_time".into(), json!(0.04));
                o.insert("nozzle_diameter".into(), json!(0.4));
                o.insert("nozzle_volume_type".into(), json!("standard"));
                o.insert("switch_count".into(), json!(h.switch_count));
                o.insert("last_maintenance_count".into(), json!(h.last_maintenance_count));
                o.insert("retry_count".into(), json!(h.retry_count));
                o.insert("error_count".into(), json!(h.error_count));
                v
            }
            "heater_bed" => self.bed.json(),
            "chamber" => json!({ "temperature": round(self.chamber.temp, 2), "target": 0.0 }),
            "fan" => json!({ "speed": round(self.fan, 3), "rpm": null }),
            "fan_generic cavity_fan" => json!({ "speed": round(self.cavity_fan, 3), "rpm": null }),
            "led cavity_led" => json!({ "color_data": [[0.0, 0.0, 0.0, if self.light { 1.0 } else { 0.0 }]] }),
            "purifier" => json!({
                "power_detected": true,
                "inner_fan": { "speed": if self.purifier { 1.0 } else { 0.0 } },
                "exhaust_fan": { "speed": 0.0 },
                "inner_fan_work_time": round(self.purifier_s, 0),
            }),
            "filament_feed left" | "filament_feed right" => {
                let first = if name.ends_with("left") { 0 } else { 2 };
                let mut o = Map::new();
                for i in first..first + 2 {
                    let h = &self.heads[i];
                    let state = if h.loaded {
                        "load_finish"
                    } else if h.inserted {
                        "preload_finish"
                    } else {
                        "wait_insert"
                    };
                    o.insert(
                        format!("extruder{i}"),
                        json!({ "module_exist": true, "filament_detected": h.inserted, "disable_auto": !h.auto_feed, "channel_state": state }),
                    );
                }
                Value::Object(o)
            }
            _ if name.starts_with("filament_motion_sensor e") => {
                let i = name.trim_start_matches("filament_motion_sensor e").trim_end_matches("_filament").parse::<usize>().ok()?;
                json!({ "filament_detected": self.heads.get(i)?.loaded, "enabled": true })
            }
            "bed_mesh" => {
                let points = json!(self.mesh);
                json!({
                    "profile_name": "default",
                    "mesh_min": mesh::MIN,
                    "mesh_max": mesh::MAX,
                    "probed_matrix": points,
                    "mesh_matrix": points,
                    "profiles": { "default": { "points": points, "mesh_params": {
                        "min_x": mesh::MIN[0], "max_x": mesh::MAX[0], "min_y": mesh::MIN[1], "max_y": mesh::MAX[1],
                        "x_count": mesh::COUNT, "y_count": mesh::COUNT, "algo": "bicubic"
                    } } },
                    "progress": {
                        "current_point": self.probe.current,
                        "total_points": self.probe.total,
                        "probe_state": self.probe.state,
                        "preheat_total_duration": self.probe.preheat_total,
                        "preheat_remaining_time": self.probe.preheat_left,
                    },
                })
            }
            "exclude_object" => json!({ "objects": [], "excluded_objects": [], "current_object": null }),
            "system_stats" => json!({ "sysload": 0.4, "cputime": round(self.last, 1) }),
            _ => return None,
        })
    }

    /// `objects/query` and `objects/subscribe`: each object asked, whole or
    /// only the fields listed; unknown objects are left out.
    pub fn query(&self, wanted: &[(String, Option<Vec<String>>)]) -> Map<String, Value> {
        let mut out = Map::new();
        for (name, fields) in wanted {
            let Some(v) = self.object(name) else { continue };
            let v = match (fields, v) {
                (Some(f), Value::Object(o)) => Value::Object(o.into_iter().filter(|(k, _)| f.iter().any(|x| x == k)).collect()),
                (_, v) => v,
            };
            out.insert(name.clone(), v);
        }
        out
    }

    /// What changed since the last push (`notify_status_update`), field
    /// by field; `configfile` never changes.
    pub fn changes(&mut self) -> Option<Map<String, Value>> {
        let mut diff = Map::new();
        for name in OBJECTS.iter().filter(|n| **n != "configfile") {
            let Some(Value::Object(now)) = self.object(name) else { continue };
            let before = self.pushed.get(*name).and_then(|v| v.as_object());
            let mut d = Map::new();
            for (k, v) in &now {
                if before.and_then(|b| b.get(k)) != Some(v) {
                    d.insert(k.clone(), v.clone());
                }
            }
            if !d.is_empty() {
                diff.insert(name.to_string(), Value::Object(d));
            }
            self.pushed.insert(name.to_string(), Value::Object(now));
        }
        (!diff.is_empty()).then_some(diff)
    }

    /// `/server/history/totals`.
    pub fn totals(&self) -> Value {
        let done: Vec<&Value> = self.history.iter().filter(|j| j["status"] != "in_progress").collect();
        let sum = |k: &str| done.iter().filter_map(|j| j[k].as_f64()).sum::<f64>();
        let max = |k: &str| done.iter().filter_map(|j| j[k].as_f64()).fold(0.0, f64::max);
        json!({ "job_totals": {
            "total_jobs": done.len(),
            "total_time": round(sum("total_duration") + 3_600.0 * 40.0, 1),
            "total_print_time": round(sum("print_duration") + 3_600.0 * 36.0, 1),
            "total_filament_used": round(sum("filament_used") + 120_000.0, 1),
            "longest_job": round(max("total_duration"), 1),
            "longest_print": round(max("print_duration"), 1),
        } })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::scenario::load;

    fn alpha() -> Machine {
        Machine::new(load("solo").unwrap().printers[0].clone(), 1.0, 1.76e9, None)
    }

    #[test]
    fn heaters_ramp_toward_their_target() {
        let mut m = alpha();
        m.heads[0].nozzle.target = 220.0;
        m.bed.target = 60.0;
        m.sync(10.0);
        assert!((m.heads[0].nozzle.temp - 65.0).abs() < 1e-6, "{}", m.heads[0].nozzle.temp);
        assert!((m.bed.temp - 35.0).abs() < 1e-6);
        m.sync(100.0);
        assert_eq!((m.heads[0].nozzle.temp, m.bed.temp), (220.0, 60.0));
        m.heads[0].nozzle.target = 0.0;
        m.sync(140.0);
        assert!(m.heads[0].nozzle.temp < 110.0 && m.heads[0].nozzle.temp > AMBIENT, "cools down, slower and slower");
        // Faster at ×10.
        let mut fast = Machine::new(load("solo").unwrap().printers[0].clone(), 10.0, 0.0, None);
        fast.bed.target = 60.0;
        fast.sync(3.5);
        assert_eq!(fast.bed.temp, 60.0);
    }

    #[test]
    fn the_objects_of_a_u1() {
        let m = alpha();
        let st = m.query(&OBJECTS.iter().map(|n| (n.to_string(), None)).collect::<Vec<_>>());
        let mut s = crate::printers::Status::default();
        crate::printers::apply_status(&Value::Object(st.clone()), &mut s);
        assert_eq!(s.state, "standby");
        assert_eq!(s.nozzles.len(), 4);
        assert_eq!(s.filaments.len(), 4);
        assert_eq!(s.filaments[1].color.as_deref(), Some("#1a1a1a"));
        let c = crate::control::parse_state(&Value::Object(st.clone()));
        assert_eq!((c.main_state.as_str(), c.heads.len(), c.heads[2].official, c.heads[0].loaded()), ("IDLE", 4, Some(true), Some(true)));
        let cfg = crate::control::parse_config(&st["configfile"]["settings"]);
        assert!(cfg.u1 && cfg.light && cfg.purifier && cfg.chamber_fan);
        let b = crate::bedmesh::parse(&Value::Object(st.clone()));
        assert!(b.supported && b.mesh.is_some() && b.config.as_ref().is_some_and(|c| c.auto_macro && c.count == [13, 13]));
        // Only the fields asked.
        let q = m.query(&[("toolhead".into(), Some(vec!["homed_axes".into()])), ("nothing".into(), None)]);
        assert_eq!(Value::Object(q), json!({ "toolhead": { "homed_axes": "" } }));
    }

    #[test]
    fn changes_carry_only_what_moved() {
        let mut m = alpha();
        assert!(m.changes().is_some_and(|d| d.contains_key("print_stats")), "the first push carries everything");
        assert!(m.changes().is_none());
        m.bed.target = 60.0;
        m.sync(1.0);
        let d = m.changes().unwrap();
        assert!(d["heater_bed"].get("target").is_some() && d["heater_bed"].get("temperature").is_some());
        assert!(!d.contains_key("print_stats"));
    }
}
