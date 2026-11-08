//! Scenarios: the simulated printers to run and how each starts. Three are
//! built in (`solo`, `farm`, `trouble`, in `src-tauri/sim/scenarios/`); a
//! scenario file of the same shape can be given instead. Written by hand:
//! made-up names, hostnames and serials, `127.0.0.1` only.

use super::faults::Scheduled;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

pub const BUILT_IN: [(&str, &str); 3] = [
    ("solo", include_str!("../../sim/scenarios/solo.json")),
    ("farm", include_str!("../../sim/scenarios/farm.json")),
    ("trouble", include_str!("../../sim/scenarios/trouble.json")),
];

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Scenario {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Time factor, unless the launch gives one.
    #[serde(default)]
    pub speed: Option<f64>,
    pub printers: Vec<PrinterSpec>,
}

/// How a printer is at launch.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Start {
    #[default]
    Idle,
    /// Printing its `print` file, at `progress`.
    Printing,
    /// The same, paused by the user.
    Paused,
    /// Its last print ended in error.
    Error,
    /// Klipper in shutdown.
    KlippyShutdown,
}

/// A spool loaded in a head.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Spool {
    /// Material type ("PLA"…), empty for no spool.
    #[serde(rename = "type")]
    pub kind: String,
    /// "#rrggbb".
    pub color: String,
    #[serde(default = "generic")]
    pub vendor: String,
    #[serde(default)]
    pub sub_type: String,
    #[serde(default = "yes")]
    pub present: bool,
    /// Read from its RFID tag: not editable from the app.
    #[serde(default)]
    pub official: bool,
}

fn generic() -> String {
    "Generic".into()
}
fn yes() -> bool {
    true
}

impl Spool {
    pub fn empty() -> Spool {
        Spool {
            kind: String::new(),
            color: "#ffffff".into(),
            vendor: String::new(),
            sub_type: String::new(),
            present: false,
            official: false,
        }
    }
}

/// A print file the printer holds, generated at launch (`fixtures.rs`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SampleFile {
    pub name: String,
    /// G-code tools it uses.
    #[serde(default = "tool0")]
    pub tools: Vec<u8>,
    #[serde(default = "minutes")]
    pub minutes: u32,
    #[serde(default = "layers")]
    pub layers: u32,
    /// Materials and colours it was sliced for, per tool; the printer's
    /// spools by default.
    #[serde(default)]
    pub materials: Vec<String>,
    #[serde(default)]
    pub colors: Vec<String>,
}

fn tool0() -> Vec<u8> {
    vec![0]
}
fn minutes() -> u32 {
    45
}
fn layers() -> u32 {
    60
}

/// A past print in the printer's history.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PastJob {
    pub file: String,
    /// completed | cancelled | error | klippy_shutdown
    #[serde(default = "completed")]
    pub status: String,
    pub days_ago: f64,
    #[serde(default = "minutes")]
    pub minutes: u32,
    #[serde(default)]
    pub filament_m: f64,
}

fn completed() -> String {
    "completed".into()
}

/// A maintenance task already logged in the app.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct MaintenanceDone {
    pub task: String,
    pub days_ago: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PrinterSpec {
    /// Stable within a scenario: its seeded history and meshes point at it.
    pub id: String,
    pub name: String,
    pub hostname: String,
    pub serial: String,
    #[serde(default = "firmware")]
    pub firmware: String,
    #[serde(default)]
    pub start: Start,
    #[serde(default)]
    pub progress: f64,
    /// The file being printed at launch (one of `files`).
    #[serde(default)]
    pub print: Option<String>,
    #[serde(default = "default_spools")]
    pub spools: Vec<Spool>,
    #[serde(default)]
    pub files: Vec<SampleFile>,
    #[serde(default)]
    pub history: Vec<PastJob>,
    /// Each head's tool changes so far.
    #[serde(default)]
    pub switch_counts: Vec<u64>,
    /// Seed of its bed's shape.
    #[serde(default)]
    pub mesh_seed: u64,
    /// Older meshes in the app's bed leveling history.
    #[serde(default)]
    pub mesh_history: u32,
    #[serde(default)]
    pub maintenance: Vec<MaintenanceDone>,
    /// Files queued for it in the app, by name.
    #[serde(default)]
    pub queue: Vec<String>,
    #[serde(default)]
    pub faults: Vec<Scheduled>,
    /// Size of its disk, in megabytes.
    #[serde(default = "disk_mb")]
    pub disk_mb: u64,
}

fn firmware() -> String {
    "1.2.0".into()
}
fn disk_mb() -> u64 {
    6000
}

/// Four PLA spools of different colours.
pub fn default_spools() -> Vec<Spool> {
    ["#e8e8e8", "#1a1a1a", "#d93a2b", "#2f6fd6"]
        .iter()
        .map(|c| Spool {
            kind: "PLA".into(),
            color: (*c).into(),
            vendor: generic(),
            sub_type: String::new(),
            present: true,
            official: false,
        })
        .collect()
}

impl PrinterSpec {
    /// A new printer, as the Developer section adds one.
    pub fn new(n: usize, name: &str) -> PrinterSpec {
        let slug: String = name
            .to_ascii_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect::<String>()
            .split('-')
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("-");
        PrinterSpec {
            id: format!("sim-extra-{n}"),
            name: name.to_string(),
            hostname: if slug.is_empty() { format!("sim-extra-{n}") } else { slug },
            serial: format!("SIM-0000-{:04}", 100 + n),
            firmware: firmware(),
            start: Start::Idle,
            progress: 0.0,
            print: None,
            spools: default_spools(),
            files: Vec::new(),
            history: Vec::new(),
            switch_counts: Vec::new(),
            mesh_seed: 100 + n as u64,
            mesh_history: 0,
            maintenance: Vec::new(),
            queue: Vec::new(),
            faults: Vec::new(),
            disk_mb: disk_mb(),
        }
    }

    /// The spool of head `i` (none past the given ones).
    pub fn spool(&self, i: usize) -> Spool {
        self.spools.get(i).cloned().unwrap_or_else(Spool::empty)
    }
}

/// A built-in scenario by name, or a scenario file.
pub fn load(which: &str) -> Result<Scenario> {
    let text = match BUILT_IN.iter().find(|(n, _)| *n == which) {
        Some((_, t)) => t.to_string(),
        None => std::fs::read_to_string(which)
            .with_context(|| format!("scenario {which}: not one of {} nor a readable file", names().join(", ")))?,
    };
    let s: Scenario = serde_json::from_str(&text).with_context(|| format!("scenario {which}"))?;
    check(&s)?;
    Ok(s)
}

pub fn names() -> Vec<&'static str> {
    BUILT_IN.iter().map(|(n, _)| *n).collect()
}

/// One id per printer, a name, at most four heads.
pub fn check(s: &Scenario) -> Result<()> {
    let mut ids = std::collections::HashSet::new();
    for p in &s.printers {
        if p.id.trim().is_empty() || !ids.insert(p.id.as_str()) {
            return Err(anyhow!("scenario {}: printer ids must be unique and not empty ({:?})", s.name, p.id));
        }
        if p.name.trim().is_empty() {
            return Err(anyhow!("scenario {}: printer {} has no name", s.name, p.id));
        }
        if p.spools.len() > 4 {
            return Err(anyhow!("scenario {}: printer {} has more than four spools", s.name, p.id));
        }
        if let Some(f) = &p.print {
            if !p.files.iter().any(|x| &x.name == f) {
                return Err(anyhow!("scenario {}: printer {} prints {f}, which is not among its files", s.name, p.id));
            }
        }
        if let Some(f) = p.files.iter().find(|f| f.tools.iter().any(|t| *t > 3)) {
            return Err(anyhow!("scenario {}: printer {}: {} uses a tool past T3 (four heads)", s.name, p.id, f.name));
        }
        for q in &p.queue {
            if !p.files.iter().any(|x| &x.name == q) {
                return Err(anyhow!("scenario {}: printer {} queues {q}, which is not among its files", s.name, p.id));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_scenarios_load() {
        let solo = load("solo").unwrap();
        assert_eq!(solo.printers.len(), 1);
        assert_eq!(solo.printers[0].start, Start::Idle);
        assert_eq!(solo.printers[0].spools.len(), 4);
        let farm = load("farm").unwrap();
        assert_eq!(farm.printers.len(), 4);
        assert!(farm.printers.iter().any(|p| p.start == Start::Printing && (p.progress - 0.4).abs() < 1e-9));
        let trouble = load("trouble").unwrap();
        assert!(trouble.printers.iter().any(|p| p.start == Start::KlippyShutdown));
        assert!(load("nowhere").is_err());
    }

    /// Made-up identities only: no real address, name or serial.
    #[test]
    fn fixtures_are_made_up() {
        for (name, text) in BUILT_IN {
            let s = load(name).unwrap();
            for p in &s.printers {
                assert!(p.name.starts_with("Sim U1 "), "{}", p.name);
                assert!(p.hostname.starts_with("sim-"), "{}", p.hostname);
                assert!(p.serial.starts_with("SIM-0000-"), "{}", p.serial);
            }
            // No IPv4 address at all in the file.
            let re = text.split(|c: char| !(c.is_ascii_digit() || c == '.')).filter(|w| w.matches('.').count() == 3);
            assert_eq!(re.count(), 0, "{name}: an address in the scenario");
        }
    }

    #[test]
    fn a_bad_scenario_is_refused() {
        let mut s = load("solo").unwrap();
        s.printers.push(s.printers[0].clone());
        assert!(check(&s).is_err(), "duplicate id");
        let mut s = load("solo").unwrap();
        s.printers[0].print = Some("missing.gcode".into());
        assert!(check(&s).is_err());
        let mut s = load("solo").unwrap();
        s.printers[0].files[0].tools = vec![0, 4];
        assert!(check(&s).is_err(), "no fifth head");
        let p = PrinterSpec::new(3, "Sim U1 Kilo!");
        assert_eq!((p.id.as_str(), p.hostname.as_str(), p.serial.as_str()), ("sim-extra-3", "sim-u1-kilo", "SIM-0000-0103"));
    }
}
