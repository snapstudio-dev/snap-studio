//! Bed leveling: Klipper's `bed_mesh`, read through Moonraker, and the
//! history of meshes Snap Studio keeps per printer.
//!
//! Klipper keeps only the mesh loaded now (and its saved profiles), without
//! a date: each new full-bed mesh the app sees is stored here with the time
//! it was first seen, or the time a measurement started from the app ended.
//! An adaptive mesh (made by a print over its own area only) is shown but
//! not stored: its deviation cannot be compared with a full bed's.
//!
//! The Snapmaker U1's Klipper adds `progress` to `bed_mesh` (current and
//! total points, probe state, preheat countdown) and the
//! `AUTO_BED_MESH_CALIBRATE TEMP=` macro (heat, soak, mesh) used by its
//! screen; another Klipper gets a plain `BED_MESH_CALIBRATE`.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// A mesh: probed heights (mm) in rows from `min` y to `max` y, each from
/// `min` x to `max` x.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Mesh {
    /// Unix seconds: when the app first saw it (0 for the printer's live mesh).
    #[serde(default)]
    pub at: u64,
    #[serde(default)]
    pub profile: String,
    pub min: [f64; 2],
    pub max: [f64; 2],
    pub points: Vec<Vec<f64>>,
    /// Covers only part of the configured area (adaptive mesh).
    #[serde(default)]
    pub partial: bool,
    /// Measured from Snap Studio.
    #[serde(default)]
    pub by_app: bool,
}

/// `bed_mesh.progress` (U1).
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Progress {
    pub current: u32,
    pub total: u32,
    /// idle | preheating | prescanning | probing | completed | aborting | aborted
    pub state: String,
    pub preheat_total: f64,
    pub preheat_left: f64,
}

/// `[bed_mesh]` as configured.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Config {
    pub min: [f64; 2],
    pub max: [f64; 2],
    pub count: [u32; 2],
    pub samples: u32,
    /// Seconds the U1 waits with the bed hot before probing.
    pub preheat: f64,
    /// The U1's `AUTO_BED_MESH_CALIBRATE` macro exists.
    pub auto_macro: bool,
    /// `[heater_bed] max_temp` (100 °C on the U1): the measurement never
    /// asks for more.
    pub bed_max: f64,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Temp {
    pub current: f64,
    pub target: f64,
}

/// The printer's last print (Moonraker's history): the bed temperature it
/// used suggests the measurement's, its end warns a part may be on the bed.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct LastJob {
    pub filename: String,
    /// completed | cancelled | error | klippy_shutdown | in_progress …
    pub status: String,
    /// Unix seconds, 0 while printing.
    pub end: f64,
    /// `first_layer_bed_temp` from the file's metadata, when the slicer wrote it.
    pub bed_temp: Option<f64>,
}

/// What the printer says now.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Live {
    /// The printer has a `bed_mesh` section.
    pub supported: bool,
    pub mesh: Option<Mesh>,
    pub progress: Option<Progress>,
    pub config: Option<Config>,
    /// `print_stats.state`.
    pub state: String,
    pub homed: String,
    pub bed: Option<Temp>,
    /// Only in a full read (not while following a measurement).
    pub last_job: Option<LastJob>,
}

/// `[3, 3]`, `"3, 3"` or `"3,3"`.
fn pair(v: &Value) -> Option<[f64; 2]> {
    let xs: Vec<f64> = match v {
        Value::Array(a) => a.iter().filter_map(|x| x.as_f64()).collect(),
        Value::String(s) => s.split(',').filter_map(|x| x.trim().parse().ok()).collect(),
        _ => return None,
    };
    (xs.len() == 2 && xs.iter().all(|x| x.is_finite())).then(|| [xs[0], xs[1]])
}

fn count(v: &Value) -> Option<[u32; 2]> {
    match v {
        Value::Number(n) => n.as_u64().map(|n| [n as u32, n as u32]),
        _ => pair(v).map(|[a, b]| [a as u32, b as u32]),
    }
}

/// Rows of finite numbers, at least 2 × 2, all of the same length.
fn matrix(v: &Value) -> Option<Vec<Vec<f64>>> {
    let rows: Vec<Vec<f64>> =
        v.as_array()?.iter().map(|r| r.as_array().map(|r| r.iter().filter_map(|x| x.as_f64()).collect()).unwrap_or_default()).collect();
    let w = rows.first()?.len();
    (rows.len() >= 2 && w >= 2 && rows.iter().all(|r| r.len() == w && r.iter().all(|x| x.is_finite()))).then_some(rows)
}

fn config(settings: &Value) -> Option<Config> {
    let s = settings.get("bed_mesh")?;
    Some(Config {
        min: pair(&s["mesh_min"])?,
        max: pair(&s["mesh_max"])?,
        count: count(&s["probe_count"]).unwrap_or([3, 3]),
        samples: s["samples"].as_u64().unwrap_or(1) as u32,
        preheat: s["preheat_duration"].as_f64().unwrap_or(60.0),
        auto_macro: settings.get("gcode_macro auto_bed_mesh_calibrate").is_some(),
        bed_max: bed_max(settings),
    })
}

/// The bed's highest temperature (`[heater_bed] max_temp`), 100 °C when
/// the printer does not say.
fn bed_max(settings: &Value) -> f64 {
    let v = &settings["heater_bed"]["max_temp"];
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
        .filter(|t: &f64| t.is_finite() && *t > 0.0)
        .unwrap_or(BED_MAX_DEFAULT)
}
const BED_MAX_DEFAULT: f64 = 100.0;

/// Covers less than 85 % of the configured area.
fn is_partial(min: [f64; 2], max: [f64; 2], cfg: Option<&Config>) -> bool {
    let Some(c) = cfg else { return false };
    let area = |a: [f64; 2], b: [f64; 2]| ((b[0] - a[0]) * (b[1] - a[1])).abs();
    let full = area(c.min, c.max);
    full > 0.0 && area(min, max) < 0.85 * full
}

/// The mesh loaded now; none loaded: the `default` profile (or the first).
fn mesh_of(bm: &Value, cfg: Option<&Config>) -> Option<Mesh> {
    let live = matrix(&bm["probed_matrix"]).and_then(|points| {
        Some((bm["profile_name"].as_str().unwrap_or("").to_string(), pair(&bm["mesh_min"])?, pair(&bm["mesh_max"])?, points))
    });
    let (profile, min, max, points) = live.or_else(|| {
        let profiles = bm["profiles"].as_object()?;
        let (name, p) = profiles.get_key_value("default").or_else(|| profiles.iter().next())?;
        let mp = &p["mesh_params"];
        let min = [mp["min_x"].as_f64()?, mp["min_y"].as_f64()?];
        let max = [mp["max_x"].as_f64()?, mp["max_y"].as_f64()?];
        Some((name.clone(), min, max, matrix(&p["points"])?))
    })?;
    Some(Mesh { at: 0, profile, partial: is_partial(min, max, cfg), min, max, points, by_app: false })
}

/// The printer's answer to the objects query (`result.status`).
pub fn parse(status: &Value) -> Live {
    let cfg = config(&status["configfile"]["settings"]);
    let bm = &status["bed_mesh"];
    let progress = bm.get("progress").filter(|p| p.is_object()).map(|p| Progress {
        current: p["current_point"].as_u64().unwrap_or(0) as u32,
        total: p["total_points"].as_u64().unwrap_or(0) as u32,
        state: p["probe_state"].as_str().unwrap_or("").to_string(),
        preheat_total: p["preheat_total_duration"].as_f64().unwrap_or(0.0),
        preheat_left: p["preheat_remaining_time"].as_f64().unwrap_or(0.0),
    });
    let hb = &status["heater_bed"];
    Live {
        supported: bm.is_object(),
        mesh: mesh_of(bm, cfg.as_ref()),
        progress,
        config: cfg,
        state: status["print_stats"]["state"].as_str().unwrap_or("").to_string(),
        homed: status["toolhead"]["homed_axes"].as_str().unwrap_or("").to_string(),
        bed: hb["temperature"].as_f64().map(|current| Temp { current, target: hb["target"].as_f64().unwrap_or(0.0) }),
        last_job: None,
    }
}

/// The newest job of `/server/history/list` (`result`).
pub fn parse_last_job(history: &Value) -> Option<LastJob> {
    let j = history["jobs"].as_array()?.first()?;
    Some(LastJob {
        filename: j["filename"].as_str().unwrap_or("").to_string(),
        status: j["status"].as_str().unwrap_or("").to_string(),
        end: j["end_time"].as_f64().unwrap_or(0.0),
        bed_temp: j["metadata"]["first_layer_bed_temp"].as_f64().filter(|t| t.is_finite() && *t > 0.0),
    })
}

/// Reads the mesh, its settings, the print state, the bed and the last
/// print. `light`: only what a measurement in progress needs (no printer
/// configuration, no history), for a read every 2 s.
pub async fn read(host: &str, port: u16, light: bool) -> Result<Live> {
    let base = crate::printers::base(host, port);
    let config = if light { "" } else { "&configfile=settings" };
    let v = crate::printers::get_json(&format!(
        "{base}/printer/objects/query?bed_mesh&print_stats=state&toolhead=homed_axes&heater_bed{config}"
    ))
    .await?;
    let mut live = parse(&v["result"]["status"]);
    if !light {
        // Without the history component, no last print: not an error.
        if let Ok(h) = crate::printers::get_json(&format!("{base}/server/history/list?limit=1&order=desc")).await {
            live.last_job = parse_last_job(&h["result"]);
        }
    }
    Ok(live)
}

/// Mesh probing in progress.
pub fn busy(p: Option<&Progress>) -> bool {
    p.is_some_and(|p| matches!(p.state.as_str(), "preheating" | "prescanning" | "probing" | "aborting"))
}

/// The measurement: home if needed, heat and soak the bed, probe, bed off.
pub fn measure_script(homed: &str, auto_macro: bool, temp: f64, bed_max: f64) -> String {
    let temp = temp.clamp(0.0, bed_max.max(0.0)).round();
    let mut s = Vec::new();
    if !(homed.contains('x') && homed.contains('y') && homed.contains('z')) {
        s.push("G28".to_string());
    }
    if auto_macro && temp > 0.0 {
        // Snapmaker's own: M140, M190, a 2 min soak, BED_MESH_CALIBRATE.
        s.push(format!("AUTO_BED_MESH_CALIBRATE TEMP={temp}"));
    } else {
        if temp > 0.0 {
            s.push(format!("M190 S{temp}"));
        }
        s.push("BED_MESH_CALIBRATE".to_string());
    }
    if temp > 0.0 {
        s.push("M140 S0".to_string());
    }
    s.join("\n")
}

/// Measures the bed now; returns when the printer is done.
pub async fn measure(host: &str, port: u16, temp: f64) -> Result<()> {
    let live = read(host, port, false).await?;
    if !live.supported {
        return Err(anyhow!(crate::t!("err.no_bed_mesh")));
    }
    if matches!(live.state.as_str(), "printing" | "paused") {
        return Err(anyhow!(crate::t!("err.bed_mesh_printing")));
    }
    if busy(live.progress.as_ref()) {
        return Err(anyhow!(crate::t!("err.bed_mesh_running")));
    }
    let auto = live.config.as_ref().is_some_and(|c| c.auto_macro);
    let bed_max = live.config.as_ref().map_or(BED_MAX_DEFAULT, |c| c.bed_max);
    let script = measure_script(&live.homed, auto, temp, bed_max);
    let r = crate::printers::gcode_script_for(host, port, &script, Duration::from_secs(45 * 60)).await;
    if r.is_err() && temp > 0.0 {
        // Klipper stops a script at its first error: the bed would stay hot
        // (until its idle timeout). Turned off here, whatever happened.
        let _ = crate::printers::gcode_script(host, port, "M140 S0").await;
    }
    r
}

/// Stops the probing cleanly (the U1: Snapmaker's `bed_mesh/abort_probe_mesh`
/// endpoint). It acts while the probe preheats, checks the corners or
/// probes; before that (heating, the 2 min soak) only the emergency stop
/// can. The measurement script then goes on to turn the bed off.
pub async fn abort(host: &str, port: u16) -> Result<()> {
    let r = crate::printers::post_path(host, port, "/printer/bed_mesh/abort_probe_mesh").await?;
    if r["state"].as_str() == Some("error") {
        return Err(anyhow!(r["message"].as_str().unwrap_or("abort_probe_mesh").to_string()));
    }
    Ok(())
}

/// Stops the printer at once (a measurement going wrong: a part left on
/// the bed…): Klipper's emergency stop, then its restart, which takes it
/// back to ready in a few seconds. Heaters and motors are off.
pub async fn stop(host: &str, port: u16) -> Result<()> {
    crate::printers::post_path(host, port, "/printer/emergency_stop").await?;
    tokio::time::sleep(Duration::from_secs(2)).await;
    crate::printers::post_path(host, port, "/printer/firmware_restart").await?;
    Ok(())
}

// ------------------------------------------------------------ history

type Store = HashMap<String, Vec<Mesh>>;

fn store_path() -> PathBuf {
    crate::util::app_dir().join("bed_mesh.json")
}

fn read_store(path: &Path) -> Store {
    std::fs::read(path).ok().and_then(|d| serde_json::from_slice(&d).ok()).unwrap_or_default()
}

fn write_store(path: &Path, s: &Store) -> Result<()> {
    crate::util::write_atomic(path, &serde_json::to_vec(s)?)
}

/// The same mesh: same area and the same heights.
pub fn same(a: &Mesh, b: &Mesh) -> bool {
    let close = |x: f64, y: f64| (x - y).abs() < 1e-6;
    a.min.iter().zip(b.min.iter()).chain(a.max.iter().zip(b.max.iter())).all(|(x, y)| (x - y).abs() < 0.01)
        && a.points.len() == b.points.len()
        && a.points.iter().zip(&b.points).all(|(r, s)| r.len() == s.len() && r.iter().zip(s).all(|(x, y)| close(*x, *y)))
}

/// The `keep` newest, oldest first.
pub fn trim(list: &mut Vec<Mesh>, keep: usize) {
    list.sort_by_key(|m| m.at);
    let keep = keep.max(1);
    if list.len() > keep {
        list.drain(..list.len() - keep);
    }
}

fn record_in(path: &Path, printer: &str, mut mesh: Mesh, keep: usize, by_app: bool, now: u64) -> Result<Vec<Mesh>> {
    if mesh.partial || matrix(&serde_json::to_value(&mesh.points)?).is_none() {
        return Ok(read_store(path).remove(printer).unwrap_or_default());
    }
    let mut s = read_store(path);
    let list = s.entry(printer.to_string()).or_default();
    let before = list.clone();
    match list.iter_mut().find(|m| same(m, &mesh)) {
        Some(m) => m.by_app |= by_app,
        None => {
            mesh.at = now.max(list.iter().map(|m| m.at + 1).max().unwrap_or(0));
            mesh.by_app = by_app;
            list.push(mesh);
        }
    }
    trim(list, keep);
    let out = list.clone();
    if out != before {
        write_store(path, &s)?;
    }
    Ok(out)
}

fn remove_in(path: &Path, printer: &str, at: u64) -> Result<Vec<Mesh>> {
    let mut s = read_store(path);
    let list = s.entry(printer.to_string()).or_default();
    list.retain(|m| m.at != at);
    let out = list.clone();
    write_store(path, &s)?;
    Ok(out)
}

fn trim_in(path: &Path, printer: &str, keep: usize) -> Result<Vec<Mesh>> {
    let mut s = read_store(path);
    let list = s.entry(printer.to_string()).or_default();
    let n = list.len();
    trim(list, keep);
    let out = list.clone();
    if out.len() != n {
        write_store(path, &s)?;
    }
    Ok(out)
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// A printer's stored meshes, oldest first.
pub fn history(printer: &str) -> Vec<Mesh> {
    read_store(&store_path()).remove(printer).unwrap_or_default()
}

/// Stores a full-bed mesh not seen yet (a known one is left as is).
pub fn record(printer: &str, mesh: Mesh, keep: usize, by_app: bool) -> Result<Vec<Mesh>> {
    record_in(&store_path(), printer, mesh, keep, by_app, now())
}

pub fn remove(printer: &str, at: u64) -> Result<Vec<Mesh>> {
    remove_in(&store_path(), printer, at)
}

pub fn keep(printer: &str, keep: usize) -> Result<Vec<Mesh>> {
    trim_in(&store_path(), printer, keep)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A U1 (Snapmaker Klipper), trimmed: 3 × 3 instead of 13 × 13.
    fn u1() -> Value {
        serde_json::json!({
            "bed_mesh": {
                "profile_name": "default",
                "mesh_min": [3.0, 3.0], "mesh_max": [267.0, 267.0],
                "probed_matrix": [[0.05, -0.02, 0.01], [0.0, 0.03, -0.04], [0.12, 0.02, -0.06]],
                "mesh_matrix": [[0.05]],
                "profiles": { "default": { "points": [[0.0, 0.0], [0.0, 0.0]], "mesh_params": { "min_x": 3.0, "max_x": 267.0, "min_y": 3.0, "max_y": 267.0 } } },
                "progress": { "current_point": 28, "total_points": 169, "probe_state": "probing", "preheat_total_duration": 60, "preheat_remaining_time": 0 }
            },
            "print_stats": { "state": "standby" },
            "toolhead": { "homed_axes": "xyz" },
            "heater_bed": { "temperature": 54.8, "target": 55.0 },
            "configfile": { "settings": {
                "bed_mesh": { "mesh_min": [3.0, 3.0], "mesh_max": [267.0, 267.0], "probe_count": [13, 13], "samples": 3 },
                "gcode_macro auto_bed_mesh_calibrate": { "gcode": "..." }
            } }
        })
    }

    #[test]
    fn a_u1_reports_its_mesh_and_progress() {
        let l = parse(&u1());
        assert!(l.supported);
        let m = l.mesh.unwrap();
        assert_eq!((m.min, m.max, m.points.len(), m.partial), ([3.0, 3.0], [267.0, 267.0], 3, false));
        assert_eq!(m.points[2][0], 0.12);
        let p = l.progress.unwrap();
        assert_eq!((p.current, p.total, p.state.as_str()), (28, 169, "probing"));
        assert!(busy(Some(&p)));
        let c = l.config.unwrap();
        assert_eq!((c.count, c.samples, c.preheat, c.auto_macro, c.bed_max), ([13, 13], 3, 60.0, true, 100.0));
        assert_eq!(l.bed, Some(Temp { current: 54.8, target: 55.0 }));
        assert_eq!((l.state.as_str(), l.homed.as_str()), ("standby", "xyz"));
    }

    #[test]
    fn an_adaptive_mesh_is_partial_and_none_loaded_falls_back_on_the_profile() {
        let mut v = u1();
        v["bed_mesh"]["mesh_min"] = serde_json::json!([90.0, 100.0]);
        v["bed_mesh"]["mesh_max"] = serde_json::json!([180.0, 170.0]);
        assert!(parse(&v).mesh.unwrap().partial);
        // No mesh loaded: Klipper's empty matrix; the default profile instead.
        v["bed_mesh"]["probed_matrix"] = serde_json::json!([[]]);
        let m = parse(&v).mesh.unwrap();
        assert_eq!((m.profile.as_str(), m.points.len(), m.partial), ("default", 2, false));
        // No bed_mesh section at all.
        let l = parse(&serde_json::json!({ "print_stats": { "state": "standby" } }));
        assert!(!l.supported && l.mesh.is_none() && l.config.is_none());
        // Strings from the raw config, a single probe count.
        let c = config(&serde_json::json!({ "bed_mesh": { "mesh_min": "10, 10", "mesh_max": "200,200", "probe_count": 5 } })).unwrap();
        assert_eq!((c.min, c.max, c.count, c.auto_macro, c.bed_max), ([10.0, 10.0], [200.0, 200.0], [5, 5], false, 100.0));
        // The bed's max_temp, as a number or the raw config's string.
        let s = serde_json::json!({ "bed_mesh": { "mesh_min": "10, 10", "mesh_max": "200,200" }, "heater_bed": { "max_temp": "120" } });
        assert_eq!(config(&s).unwrap().bed_max, 120.0);
    }

    #[test]
    fn the_last_print_from_the_history() {
        let h = serde_json::json!({ "count": 12, "jobs": [
            { "filename": "Benchy.gcode", "status": "completed", "end_time": 1761050000.5, "metadata": { "first_layer_bed_temp": 65.0 } },
            { "filename": "old.gcode", "status": "completed", "end_time": 1.0 }
        ] });
        let j = parse_last_job(&h).unwrap();
        assert_eq!((j.filename.as_str(), j.status.as_str(), j.end, j.bed_temp), ("Benchy.gcode", "completed", 1761050000.5, Some(65.0)));
        // No metadata, a running job; no job at all.
        let h = serde_json::json!({ "jobs": [{ "filename": "a.gcode", "status": "in_progress", "end_time": null, "metadata": {} }] });
        let j = parse_last_job(&h).unwrap();
        assert_eq!((j.end, j.bed_temp), (0.0, None));
        assert!(parse_last_job(&serde_json::json!({ "jobs": [] })).is_none());
        assert!(parse_last_job(&serde_json::json!({})).is_none());
    }

    #[test]
    fn the_measurement_script() {
        assert_eq!(measure_script("xyz", true, 55.0, 100.0), "AUTO_BED_MESH_CALIBRATE TEMP=55\nM140 S0");
        assert_eq!(measure_script("", true, 60.4, 100.0), "G28\nAUTO_BED_MESH_CALIBRATE TEMP=60\nM140 S0");
        assert_eq!(measure_script("xy", false, 60.0, 100.0), "G28\nM190 S60\nBED_MESH_CALIBRATE\nM140 S0");
        assert_eq!(measure_script("xyz", true, 0.0, 100.0), "BED_MESH_CALIBRATE");
        // Never above the bed's max_temp (100 °C on the U1).
        assert_eq!(measure_script("xyz", false, 500.0, 100.0), "M190 S100\nBED_MESH_CALIBRATE\nM140 S0");
        assert_eq!(measure_script("xyz", true, 110.0, 120.0), "AUTO_BED_MESH_CALIBRATE TEMP=110\nM140 S0");
    }

    fn mesh(z: f64) -> Mesh {
        Mesh {
            at: 0,
            profile: "default".into(),
            min: [3.0, 3.0],
            max: [267.0, 267.0],
            points: vec![vec![0.0, z], vec![z, 0.0]],
            partial: false,
            by_app: false,
        }
    }

    #[test]
    fn the_history_keeps_new_full_meshes_per_printer() {
        let dir = std::env::temp_dir().join(format!("snapstudio_bedmesh_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bed_mesh.json");
        let _ = std::fs::remove_file(&path);
        let l = record_in(&path, "u1", mesh(0.1), 3, false, 100).unwrap();
        assert_eq!((l.len(), l[0].at, l[0].by_app), (1, 100, false));
        // Seen again: not a new one; measured from the app, it says so.
        let l = record_in(&path, "u1", mesh(0.1), 3, true, 200).unwrap();
        assert_eq!((l.len(), l[0].at, l[0].by_app), (1, 100, true));
        // Partial: not stored.
        let mut p = mesh(0.4);
        p.partial = true;
        assert_eq!(record_in(&path, "u1", p, 3, false, 300).unwrap().len(), 1);
        // Another printer apart.
        assert_eq!(record_in(&path, "voron", mesh(0.1), 3, false, 300).unwrap().len(), 1);
        // The newest `keep`, oldest first; the same second gets the next one.
        for (i, z) in [0.2, 0.3, 0.4].iter().enumerate() {
            record_in(&path, "u1", mesh(*z), 3, false, 400 + i as u64 / 2).unwrap();
        }
        let l = read_store(&path).remove("u1").unwrap();
        assert_eq!(l.iter().map(|m| m.at).collect::<Vec<_>>(), vec![400, 401, 402]);
        assert_eq!(l[0].points[0][1], 0.2);
        // Fewer kept afterwards; one removed.
        assert_eq!(trim_in(&path, "u1", 2).unwrap().len(), 2);
        let l = remove_in(&path, "u1", 402).unwrap();
        assert_eq!(l.iter().map(|m| m.at).collect::<Vec<_>>(), vec![401]);
        assert_eq!(read_store(&path)["voron"].len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn trimming_keeps_the_newest_and_at_least_one() {
        let mut l: Vec<Mesh> = [5, 1, 3].iter().map(|&at| Mesh { at, ..mesh(0.0) }).collect();
        trim(&mut l, 2);
        assert_eq!(l.iter().map(|m| m.at).collect::<Vec<_>>(), vec![3, 5]);
        trim(&mut l, 0);
        assert_eq!(l.iter().map(|m| m.at).collect::<Vec<_>>(), vec![5]);
        assert!(same(&mesh(0.1), &mesh(0.1)) && !same(&mesh(0.1), &mesh(0.10001)));
    }

    /// A real printer: `MESH_HOST=192.168.0.144 cargo test --lib bedmesh::tests::real_printer -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_printer() {
        let host = std::env::var("MESH_HOST").expect("MESH_HOST");
        let l = tauri::async_runtime::block_on(read(&host, 7125, false)).unwrap();
        println!("{}", serde_json::to_string_pretty(&l).unwrap());
        assert!(l.supported);
    }
}
