//! Simulated Snapmaker U1 printers, for development only (Cargo feature
//! `sim`, docs/DEVELOPMENT.md "Simulated printers").
//!
//! Each simulated printer is a fake Moonraker on `127.0.0.1` and a random
//! port (`server.rs`), with a machine behind it (`machine.rs`): the app's
//! own printer code reaches it over the wire, unchanged. In the app, full
//! simulation is turned on in Settings › Developer (saved in `sim.json`,
//! never in `settings.json`) or with `SNAP_SIM=<scenario>`: the app then
//! works in a `sim` folder of its data folder, emptied at each launch, so
//! the user's real printers and their records are neither shown nor
//! touched. The same simulator runs alone as `u1-sim`.

#[cfg(all(feature = "sim", not(debug_assertions)))]
compile_error!("the printer simulator (feature `sim`) is for development builds only: build a release without it");

pub mod camera;
pub mod clock;
pub mod faults;
pub mod files;
pub mod fixtures;
pub mod machine;
pub mod mesh;
pub mod print;
pub mod scenario;
pub mod script;
pub mod server;
#[cfg(test)]
pub(crate) mod tests;

use anyhow::{anyhow, Result};
use scenario::{PrinterSpec, Scenario, Spool};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use server::Farm;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

/// The labels the interface shows, sent with the status: `ui/` holds none.
pub const LABEL: &str = "SIMULATED";
pub const PILL: &str = "SIMULATION";

/// The Developer section, added to the main window in `sim` builds only.
const DEVELOPER_JS: &str = include_str!("../../sim/ui/developer.js");

/// `sim.json`, in the app's data folder: what the next launch runs.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Config {
    pub on: bool,
    /// A built-in scenario's name, or a scenario file.
    pub scenario: String,
    pub speed: f64,
    /// The printers as edited in the Developer section, in place of the
    /// scenario's; None: the scenario's own.
    pub printers: Option<Vec<PrinterSpec>>,
}

impl Default for Config {
    fn default() -> Self {
        Config { on: false, scenario: "solo".into(), speed: 1.0, printers: None }
    }
}

fn config_path() -> PathBuf {
    crate::util::data_dir().join("sim.json")
}

pub fn config() -> Config {
    std::fs::read(config_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_config(c: &Config) -> Result<()> {
    let _ = std::fs::create_dir_all(crate::util::data_dir());
    crate::util::write_atomic(&config_path(), &serde_json::to_vec_pretty(c)?)
}

/// The simulation running in this app.
pub struct Session {
    pub farm: Option<Farm>,
    pub scenario: String,
    pub speed: f64,
    /// Where the app keeps the printers' data meanwhile.
    pub dir: PathBuf,
    /// Started by `SNAP_SIM` rather than the Developer section.
    pub from_env: bool,
    /// Why the simulated printers could not start (the app still runs in
    /// simulation, with none: never on the real data).
    pub error: Option<String>,
}

static SESSION: OnceLock<Session> = OnceLock::new();

pub fn session() -> Option<&'static Session> {
    SESSION.get()
}

pub fn active() -> bool {
    SESSION.get().is_some()
}

/// The printers' data folder in simulation (`util::app_dir`).
pub fn app_dir() -> Option<PathBuf> {
    SESSION.get().map(|s| s.dir.clone()).or_else(|| tests_dir().cloned())
}

/// The tests' own data folder, set by the end-to-end tests.
fn tests_dir() -> Option<&'static PathBuf> {
    #[cfg(test)]
    {
        tests::DATA.get()
    }
    #[cfg(not(test))]
    {
        None
    }
}

/// `[SIM] ` before a notification's title in simulation.
pub fn tag(title: &str) -> String {
    if active() {
        format!("[SIM] {title}")
    } else {
        title.to_string()
    }
}

/// The address a share's QR code is served on reaches the phone, not the
/// printer: a simulated printer's loopback is replaced by the default route.
pub fn route_toward(toward: &str) -> &str {
    let loopback = toward.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback()) || toward == "localhost";
    if active() && loopback {
        // A documentation address: only the route to it is looked up.
        "192.0.2.1"
    } else {
        toward
    }
}

/// A scenario with the printers edited in the Developer section.
fn scenario_of(name: &str, printers: Option<Vec<PrinterSpec>>) -> Result<Scenario> {
    let mut s = scenario::load(name)?;
    if let Some(p) = printers {
        s.printers = p;
        scenario::check(&s)?;
    }
    Ok(s)
}

/// At launch, before anything reads the printers: `SNAP_SIM` (then
/// `SNAP_SIM_SPEED`), else `sim.json`. Nothing to do otherwise.
pub fn boot() {
    let env = std::env::var("SNAP_SIM").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let cfg = config();
    let (name, printers, from_env) = match &env {
        Some(s) => (s.clone(), None, true),
        None if cfg.on => (cfg.scenario.clone(), cfg.printers.clone(), false),
        None => return,
    };
    let env_speed = std::env::var("SNAP_SIM_SPEED").ok().and_then(|v| v.trim().trim_start_matches(['x', 'X']).parse::<f64>().ok());
    let dir = crate::util::data_dir().join("sim");
    // Fresh at each launch (decision 4).
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::create_dir_all(&dir);
    let started = scenario_of(&name, printers).and_then(|s| {
        let speed = clock::factor(if from_env { env_speed.or(s.speed).unwrap_or(1.0) } else { cfg.speed });
        let farm = tauri::async_runtime::block_on(Farm::start(&s, speed, &dir.join("printers"), Arc::new(clock::Clock::real())))?;
        seed(&s, &farm, &dir)?;
        Ok((s, farm, speed))
    });
    let run = match started {
        Ok((s, farm, speed)) => {
            for p in &farm.printers {
                eprintln!("[sim] {} on 127.0.0.1:{}", p.name, p.port);
            }
            Session { farm: Some(farm), scenario: s.name, speed, dir, from_env, error: None }
        }
        Err(e) => {
            eprintln!("[sim] simulated printers not started: {e:#}");
            Session { farm: None, scenario: name, speed: 1.0, dir, from_env, error: Some(format!("{e:#}")) }
        }
    };
    let _ = SESSION.set(run);
    if let Some(s) = session() {
        if let (Some(farm), Ok(sc)) = (&s.farm, scenario_of(&s.scenario, if from_env { None } else { cfg.printers.clone() })) {
            seed_queue(&sc, farm);
        }
    }
}

/// The simulation's saved printers, with this run's ports, and the app's
/// records the scenario starts from: bed mesh history, maintenance log.
fn seed(s: &Scenario, farm: &Farm, dir: &std::path::Path) -> Result<()> {
    let printers: Vec<crate::printers::Printer> = farm
        .printers
        .iter()
        .map(|p| crate::printers::Printer {
            id: p.id.clone(),
            name: p.name.clone(),
            host: "127.0.0.1".into(),
            port: p.port,
            model: "Snapmaker U1".into(),
            note: String::new(),
        })
        .collect();
    crate::util::write_atomic(&dir.join("printers.json"), &serde_json::to_vec_pretty(&printers)?)?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let mut meshes = serde_json::Map::new();
    let mut log = serde_json::Map::new();
    for p in &s.printers {
        let list: Vec<crate::bedmesh::Mesh> = (0..p.mesh_history as u64)
            .map(|k| crate::bedmesh::Mesh {
                at: now - (p.mesh_history as u64 - k) * 7 * 86_400,
                profile: "default".into(),
                min: mesh::MIN,
                max: mesh::MAX,
                points: mesh::surface(p.mesh_seed, 1000 + k),
                partial: false,
                by_app: k % 2 == 0,
            })
            .collect();
        if !list.is_empty() {
            meshes.insert(p.id.clone(), serde_json::to_value(list)?);
        }
        let entries: Vec<crate::maintenance::Entry> = p
            .maintenance
            .iter()
            .map(|m| crate::maintenance::Entry {
                task: m.task.clone(),
                at: now.saturating_sub((m.days_ago * 86_400.0) as u64),
                print_hours: 30.0,
                swaps: p.switch_counts.iter().map(|c| c.saturating_sub(150)).collect(),
            })
            .collect();
        if !entries.is_empty() {
            log.insert(p.id.clone(), serde_json::to_value(entries)?);
        }
    }
    crate::util::write_atomic(&dir.join("bed_mesh.json"), &serde_json::to_vec(&meshes)?)?;
    crate::util::write_atomic(&dir.join("maintenance.json"), &serde_json::to_vec_pretty(&log)?)?;
    Ok(())
}

/// The prints the scenario queues in the app (once the session is set:
/// the queue lives in the simulation's folder).
fn seed_queue(s: &Scenario, farm: &Farm) {
    for spec in &s.printers {
        let Some(p) = farm.find(&spec.id) else { continue };
        for f in &spec.queue {
            let Ok(path) = p.files.path("gcodes", f) else { continue };
            let tools = spec.files.iter().find(|x| &x.name == f).map(|x| x.tools.clone()).unwrap_or_else(|| vec![0]);
            let new = crate::jobs::NewJob {
                name: f.trim_end_matches(".gcode").to_string(),
                printer_id: spec.id.clone(),
                tools,
                ..Default::default()
            };
            if let Err(e) = crate::jobs::add(&path, new, "queued", "") {
                eprintln!("[sim] {f} not queued: {e:#}");
            }
        }
    }
}

/// Simulated discovery: the running printers, as the network search would
/// find them, without any announcement on the network. The address carries
/// its port: they all share `127.0.0.1`.
pub fn discovered() -> Option<Vec<crate::discover::Found>> {
    let farm = session()?.farm.as_ref();
    Some(
        farm.map(|f| {
            f.printers
                .iter()
                .map(|p| {
                    let m = p.lock();
                    crate::discover::Found {
                        sn: Some(m.spec.serial.clone()),
                        name: p.name.clone(),
                        model: Some("Snapmaker U1".into()),
                        ip: format!("127.0.0.1:{}", p.port),
                        port: p.port,
                        firmware: Some(m.spec.firmware.clone()),
                        service: "snapmaker".into(),
                    }
                })
                .collect()
        })
        .unwrap_or_default(),
    )
}

/* ------------------------------------------------------------ interface */

#[derive(Serialize, Clone, Debug)]
pub struct Status {
    pub on: bool,
    pub scenario: Option<String>,
    pub speed: f64,
    pub from_env: bool,
    pub error: Option<String>,
    /// The saved printers that are simulated.
    pub printers: Vec<String>,
    pub label: &'static str,
    pub pill: &'static str,
}

pub fn status() -> Status {
    let s = session();
    let ports: Vec<u16> = s.and_then(|s| s.farm.as_ref()).map(|f| f.printers.iter().map(|p| p.port).collect()).unwrap_or_default();
    let printers = if s.is_some() {
        crate::printers::load()
            .into_iter()
            .filter(|p| {
                let a = crate::printers::authority(&p.host, p.port);
                let (h, port) = a.rsplit_once(':').unwrap_or((&a, ""));
                matches!(h, "127.0.0.1" | "localhost") && port.parse::<u16>().is_ok_and(|x| ports.contains(&x))
            })
            .map(|p| p.id)
            .collect()
    } else {
        Vec::new()
    };
    Status {
        on: s.is_some(),
        scenario: s.map(|s| s.scenario.clone()),
        speed: s.map(|s| s.speed).unwrap_or(1.0),
        from_env: s.is_some_and(|s| s.from_env),
        error: s.and_then(|s| s.error.clone()),
        printers,
        label: LABEL,
        pill: PILL,
    }
}

/// The main window's script in `sim` builds: the status, then the Developer
/// section.
pub fn init_script() -> String {
    let st = serde_json::to_string(&status()).unwrap_or_else(|_| "null".into());
    format!("window.SIM = {st};\n{DEVELOPER_JS}")
}

#[tauri::command]
pub fn sim_status() -> Status {
    status()
}

/// What the Developer section shows: the saved choice, the scenarios, the
/// printers to edit (`scenario`'s when given), the faults, and the running
/// printers.
#[tauri::command]
pub fn sim_config(scenario: Option<String>) -> Result<Value, String> {
    let cfg = config();
    let which = scenario.clone().unwrap_or_else(|| cfg.scenario.clone());
    let printers = match (&scenario, &cfg.printers) {
        (None, Some(p)) => p.clone(),
        _ => scenario::load(&which).map(|s| s.printers).map_err(|e| format!("{e:#}"))?,
    };
    let scenarios: Vec<Value> = scenario::BUILT_IN
        .iter()
        .filter_map(|(n, _)| {
            scenario::load(n).ok().map(|s| json!({ "name": n, "description": s.description, "printers": s.printers.len() }))
        })
        .collect();
    let running: Vec<Value> =
        session().and_then(|s| s.farm.as_ref()).map(|f| f.printers.iter().map(|p| p.status()).collect()).unwrap_or_default();
    Ok(json!({
        "config": cfg,
        "scenario": which,
        "printers": printers,
        "scenarios": scenarios,
        "faults": faults::NAMES,
        "factors": clock::FACTORS,
        "materials": ["PLA", "PETG", "ABS", "TPU", "PLA-CF"],
        "running": running,
        "status": status(),
    }))
}

/// A new printer for the list (its identity made up).
#[tauri::command]
pub fn sim_new_printer(n: usize, name: String) -> PrinterSpec {
    PrinterSpec::new(n, &name)
}

/// Saves the choice and restarts the app on it (not when simulation stays
/// off: nothing changes then).
#[tauri::command]
pub fn sim_set(app: tauri::AppHandle, config: Config) -> Result<(), String> {
    let mut c = config;
    c.speed = clock::factor(c.speed);
    if c.on {
        scenario_of(&c.scenario, c.printers.clone()).map_err(|e| format!("{e:#}"))?;
    }
    save_config(&c).map_err(|e| format!("{e:#}"))?;
    if c.on || active() {
        app.restart();
    }
    Ok(())
}

fn running(id: &str) -> Result<Arc<server::SimPrinter>, String> {
    session().and_then(|s| s.farm.as_ref()).and_then(|f| f.find(id).cloned()).ok_or_else(|| "not a running simulated printer".to_string())
}

/// Injects a fault (`{"fault": "runout", "head": 1}`), or `clear`s them.
#[tauri::command]
pub fn sim_fault(printer: String, fault: Value) -> Result<Value, String> {
    let p = running(&printer)?;
    if fault["fault"] == "clear" {
        p.clear_faults();
    } else {
        p.inject(serde_json::from_value::<faults::Fault>(fault).map_err(|e| e.to_string())?);
    }
    Ok(p.status())
}

/// Puts a spool in a head (a runout ends, the spool check sees a change).
#[tauri::command]
pub fn sim_spool(printer: String, head: u8, spool: Spool) -> Result<Value, String> {
    if head > 3 {
        return Err(anyhow!("head {head}").to_string());
    }
    let p = running(&printer)?;
    p.set_spool(head, spool);
    Ok(p.status())
}
