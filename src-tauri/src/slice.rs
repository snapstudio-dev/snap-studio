//! Background slicing with the Snapmaker Orca engine.
//!
//! The engine runs headless: it receives complete configurations written by
//! [`crate::presets`], a geometry file, and returns a G-code. Nothing shows on
//! screen; the app stays in charge of the run.
//!
//! Two flags are essential and easy to forget: `--arrange 0`, without which
//! the engine rearranges the plate and ignores the requested placement, and
//! `--allow-newer-file`, without which it refuses projects saved by a newer
//! version than its own.

use crate::presets::{self, Index};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

static INDEX: OnceLock<Mutex<Option<(PathBuf, Arc<Index>)>>> = OnceLock::new();

/// Preset inventory, read again only when the application changes (or a
/// user preset is saved).
fn index_for(app: &Path) -> Result<Arc<Index>> {
    let cell = INDEX.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().unwrap();
    if let Some((p, idx)) = guard.as_ref() {
        if p == app {
            return Ok(idx.clone());
        }
    }
    let idx = Arc::new(Index::build(app)?);
    *guard = Some((app.to_path_buf(), idx.clone()));
    Ok(idx)
}

/// Slicing engine: the one Snap Studio downloaded (`engine.rs`).
///
/// `SNAPSTUDIO_ENGINE` designates a specific engine (`.app`, executable or
/// `AppRun`): this is how the CI tries out a slimmed-down engine. While no
/// engine is referenced (development build), the installed Snapmaker Orca is
/// the fallback.
pub fn engine() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("SNAPSTUDIO_ENGINE").filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(p));
    }
    if crate::engine::referenced() {
        return crate::engine::installed();
    }
    // Snapmaker Orca only: another slicer's profiles are not the U1's, and
    // its command line may differ (`err.not_orca` says so otherwise).
    crate::slicers::list().iter().find(|s| s.name == "Snapmaker Orca").map(|s| PathBuf::from(&s.path))
}

/// Engine data folder (logs, cache): Snap Studio's own, so as never to write
/// into Snapmaker Orca's nor create one.
fn engine_datadir() -> PathBuf {
    let d = dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("fr.carlini.snapstudio").join("engine").join("data");
    let _ = std::fs::create_dir_all(&d);
    d
}

fn binary(app: &Path) -> Result<PathBuf> {
    crate::slicers::executable(app)
}

#[derive(Serialize, Clone)]
pub struct PresetLists {
    pub machines: Vec<presets::PresetDto>,
    pub processes: Vec<presets::PresetDto>,
    pub filaments: Vec<presets::PresetDto>,
    /// Presets selected in Snapmaker Orca.
    pub selected: std::collections::HashMap<String, String>,
    pub extruders: usize,
    pub engine: Option<String>,
    /// The machine's plates and the default one.
    pub bed_types: Vec<presets::BedType>,
    pub bed_type: String,
}

/// Effective content of a preset for the details sheet: what the engine will
/// receive, quick settings, plate and spool color included.
pub fn details(
    name: &str,
    machine: &str,
    simple: Option<Simple>,
    overrides: &Map<String, Value>,
    color: Option<&str>,
) -> Result<presets::Details> {
    let app = engine().ok_or_else(|| anyhow!(crate::engine::missing()))?;
    let idx = index_for(&app)?;
    let extra = match idx.kind_of(name) {
        Some(presets::Kind::Process) => {
            let mut o = simple.unwrap_or_default().to_overrides();
            for (k, v) in overrides {
                o.insert(k.clone(), v.clone());
            }
            presets::process_extra(&idx, machine, &o)
        }
        Some(presets::Kind::Filament) => {
            let mut e = presets::filament_extra(color);
            e.extend(presets::filament_overrides(overrides));
            e
        }
        _ => Map::new(),
    };
    idx.details(name, &extra).ok_or_else(|| anyhow!(crate::t!("err.unknown_preset", name = name)))
}

/// Saves the effective settings (quick settings, then overrides) as a user
/// process preset inheriting `base`; the inventory is read again.
pub fn save_process(name: &str, base: &str, simple: Option<Simple>, overrides: &Map<String, Value>) -> Result<String> {
    let app = engine().ok_or_else(|| anyhow!(crate::engine::missing()))?;
    let idx = index_for(&app)?;
    let mut values = simple.unwrap_or_default().to_overrides();
    for (k, v) in overrides {
        // The plate is chosen per slice, not part of a process preset; nor
        // are the filaments' own keys.
        if k != "curr_bed_type" && !presets::FILAMENT_OVERRIDES.contains(&k.as_str()) {
            values.insert(k.clone(), v.clone());
        }
    }
    presets::save_user_process(&idx, name, base, &values)?;
    if let Some(cell) = INDEX.get() {
        *cell.lock().unwrap() = None;
    }
    Ok(name.trim().to_string())
}

/// Lists that can be offered, filtered for the requested machine.
pub fn lists(machine: Option<&str>) -> Result<PresetLists> {
    let app = engine().ok_or_else(|| anyhow!(crate::engine::missing()))?;
    let idx = index_for(&app)?;
    let machines = idx.machines();
    let chosen = machine
        .map(String::from)
        .or_else(|| idx.selected.get("machine").cloned())
        .filter(|m| machines.iter().any(|x| &x.name == m))
        .or_else(|| machines.first().map(|m| m.name.clone()))
        .ok_or_else(|| anyhow!(crate::t!("err.no_machine")))?;
    let (bed_types, bed_type) = idx.bed_types(&chosen);
    Ok(PresetLists {
        bed_types,
        bed_type,
        processes: idx.processes_for(&chosen),
        filaments: idx.filaments_for(&chosen),
        extruders: idx.extruder_count(&chosen),
        machines,
        selected: idx.selected.clone(),
        engine: Some(app.to_string_lossy().to_string()),
    })
}

/// Simplified settings laid over the chosen preset.
///
/// A field left empty keeps the preset's value: only what the user actually
/// touched is rewritten.
#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
pub struct Simple {
    /// Layer height in millimeters.
    pub layer_height: Option<f32>,
    /// Infill in percent.
    pub infill: Option<f32>,
    /// Number of walls.
    pub walls: Option<u32>,
    pub supports: Option<bool>,
    pub brim: Option<bool>,
}

fn num(cfg: &Map<String, Value>, key: &str) -> Option<f32> {
    let v = cfg.get(key)?;
    match v {
        Value::String(s) => s.trim_end_matches('%').trim().parse().ok(),
        Value::Number(n) => n.as_f64().map(|x| x as f32),
        _ => None,
    }
}

fn flag(cfg: &Map<String, Value>, key: &str) -> Option<bool> {
    match cfg.get(key)? {
        Value::String(s) => Some(matches!(s.as_str(), "1" | "true")),
        Value::Bool(b) => Some(*b),
        _ => None,
    }
}

impl Simple {
    /// Values carried by the preset, to prefill the UI.
    pub fn from_config(cfg: &Map<String, Value>) -> Simple {
        Simple {
            layer_height: num(cfg, "layer_height"),
            infill: num(cfg, "sparse_infill_density"),
            walls: num(cfg, "wall_loops").map(|w| w as u32),
            supports: flag(cfg, "enable_support"),
            brim: cfg.get("brim_type").and_then(|v| v.as_str()).map(|t| t != "no_brim"),
        }
    }

    /// Translation into configuration keys, in the format the engine expects:
    /// strings, with the percentage for infill.
    pub fn to_overrides(&self) -> Map<String, Value> {
        let mut m = Map::new();
        let mut put = |k: &str, v: String| {
            m.insert(k.into(), Value::String(v));
        };
        if let Some(h) = self.layer_height {
            put("layer_height", format!("{h}"));
        }
        if let Some(i) = self.infill {
            put("sparse_infill_density", format!("{}%", i.round() as i32));
        }
        if let Some(w) = self.walls {
            put("wall_loops", format!("{w}"));
        }
        if let Some(s) = self.supports {
            put("enable_support", if s { "1".into() } else { "0".into() });
        }
        if let Some(b) = self.brim {
            put("brim_type", if b { "outer_only".into() } else { "no_brim".into() });
        }
        m
    }
}

/// Starting values of a given preset.
/// The quick settings of a process preset (the machine does not change
/// them: a process is what it is whichever machine prints it).
pub fn defaults(process: &str) -> Result<Simple> {
    let app = engine().ok_or_else(|| anyhow!(crate::engine::missing()))?;
    let idx = index_for(&app)?;
    let cfg = idx.resolve(process)?;
    Ok(Simple::from_config(&cfg))
}

#[derive(Deserialize, Clone, Default)]
pub struct Request {
    pub source: String,
    pub machine: String,
    pub process: String,
    pub filaments: Vec<String>,
    /// Simplified settings; explicit overrides win.
    #[serde(default)]
    pub simple: Option<Simple>,
    #[serde(default)]
    pub overrides: Map<String, Value>,
    /// Destination folder; by default, next to the original file.
    #[serde(default)]
    pub out_dir: Option<String>,
    /// Real spool color of each head (`#rrggbb`), if known.
    #[serde(default)]
    pub colors: Vec<Option<String>>,
    /// Head (0 to 3) printing each model extruder: entry `i` is about the file's
    /// extruder `i + 1`. Empty: single-color model.
    #[serde(default)]
    pub extruder_map: Vec<u8>,
    /// The Prepare view's plate: placed objects. When given, it replaces
    /// `source` (which may stay empty).
    #[serde(default)]
    pub scene: Vec<crate::plate::SceneItem>,
    /// Name given to a scene's result (G-code name).
    #[serde(default)]
    pub name: Option<String>,
    /// The virtual heads the plate uses, in order: the `k`-th is head
    /// `n + k` in the extruder maps (`n` physical heads), so the engine's
    /// virtual filament `n + k + 1`.
    #[serde(default)]
    pub virtual_heads: Vec<VirtualHead>,
    /// One prime tower per material: the pillars to print, first in the
    /// object list, with the engine's tower off (`PILLAR_OVERRIDES`).
    #[serde(default)]
    pub pillars: Vec<crate::plate::Pillar>,
    /// Smooth mix: with a virtual head, each layer of a mixed region is split
    /// into sub-layers, one per head (`SMOOTH_MIX_OVERRIDES`). Absent: off.
    #[serde(default)]
    pub smooth_mix: bool,
}

/// What printing pillars needs from the engine: no tower of its own, the
/// objects printed in the list's order (each head primes on its ring
/// before the model), no support layer of its own between two object
/// layers (it would change heads where no pillar layer is). They win over
/// every other setting (the UI sends them too).
pub const PILLAR_OVERRIDES: [(&str, &str); 3] =
    [("enable_prime_tower", "0"), ("print_order", "as_obj_list"), ("independent_support_layer_height", "0")];

/// Smooth mix, as Snapmaker's guide asks when a whole object uses a mixed
/// color: "Subdivide Mix Layer", "Full domain" and "Apply subdivision to
/// infill" (Snapmaker Orca's Color Mixing group). Every layer of a mixed
/// region is split into sub-layers, one per head, walls and infill alike;
/// their heights stay within the engine's Local-Z bounds (0.04 to 0.16 mm by
/// default, not sent).
pub const SMOOTH_MIX_OVERRIDES: [&str; 3] = ["dithering_local_z_mode", "dithering_local_z_whole_objects", "dithering_local_z_infill"];

/// The settings a request sends on top of the profiles: its simplified
/// settings, its own overrides (the sheet's differences), the virtual heads'
/// mixes and smooth mix (a key set by hand wins), then the pillars' keys,
/// which have the last word.
pub fn request_overrides(req: &Request) -> Map<String, Value> {
    let mut overrides = req.simple.clone().unwrap_or_default().to_overrides();
    for (k, v) in &req.overrides {
        overrides.insert(k.clone(), v.clone());
    }
    // Virtual heads: the engine's command line keeps the mixes from the
    // process settings (checked by engine_virtual_head_alternates).
    if !req.virtual_heads.is_empty() {
        overrides.insert("mixed_filament_definitions".into(), Value::String(mixed_definitions(&req.virtual_heads)));
        if req.smooth_mix {
            for k in SMOOTH_MIX_OVERRIDES {
                if !req.overrides.contains_key(k) {
                    overrides.insert(k.into(), Value::String("1".into()));
                }
            }
        }
    }
    if !req.pillars.is_empty() && !req.scene.is_empty() {
        for (k, v) in PILLAR_OVERRIDES {
            overrides.insert(k.into(), Value::String(v.into()));
        }
    }
    overrides
}

/// A virtual head: two physical heads (from 0) the engine alternates layer
/// by layer, `pct` the share of `b` (Snapmaker Orca's mixed filament), and
/// its preview color for the G-code's images.
#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq)]
pub struct VirtualHead {
    pub a: u8,
    pub b: u8,
    pub pct: u8,
    #[serde(default)]
    pub color: Option<String>,
}

/// Orca's `mixed_filament_definitions`, one row per virtual head as its
/// `serialize_custom_entries` writes them: components from 1, enabled,
/// custom (the layer cadence comes from the percent), no pointillism, no
/// gradient, `Simple` distribution, no Local-Z, no bias, not deleted, not
/// auto-generated, a stable id.
pub fn mixed_definitions(heads: &[VirtualHead]) -> String {
    heads
        .iter()
        .enumerate()
        .map(|(k, v)| format!("{},{},1,1,{},0,g,w,m2,z0,xa0,xb0,d0,o0,u{}", v.a + 1, v.b + 1, v.pct.min(100), k + 1))
        .collect::<Vec<_>>()
        .join(";")
}

/// Overhang angle of the print profile (`support_threshold_angle`), which
/// guides auto-orientation; 30° by default or if the profile says 0.
pub fn support_threshold(process: Option<&str>) -> f64 {
    let read = || -> Option<f64> {
        let app = engine()?;
        let idx = index_for(&app).ok()?;
        let p = process.map(String::from).or_else(|| idx.selected.get("print").cloned())?;
        let cfg = idx.flatten(&p)?;
        let v = cfg.get("support_threshold_angle")?;
        let s = match v {
            Value::Array(a) => a.first()?.as_str()?.to_string(),
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => return None,
        };
        s.trim().parse::<f64>().ok()
    };
    match read() {
        Some(a) if a > 0.0 && a < 90.0 => a,
        _ => 30.0,
    }
}

/// A machine's bed: usable dimensions in millimeters and printer model, which
/// designates the plate and logo to draw.
#[derive(Serialize, Clone)]
pub struct Bed {
    pub w: f32,
    pub d: f32,
    pub model: Option<String>,
}

/// A machine's bed; the U1's by default.
pub fn bed(machine: Option<&str>) -> Bed {
    let u1 = Bed { w: 270.0, d: 270.0, model: Some("Snapmaker U1".into()) };
    let Some(app) = engine() else { return u1 };
    let Ok(idx) = index_for(&app) else { return u1 };
    let m = machine.map(String::from).or_else(|| idx.selected.get("machine").cloned());
    match m {
        Some(m) => {
            let (w, d) = idx.plate_size(&m);
            Bed { w, d, model: idx.printer_model(&m) }
        }
        None => u1,
    }
}

#[derive(Serialize, Clone, Default)]
pub struct Progress {
    pub id: String,
    /// preparation | slicing | preview | error | cancelled
    pub phase: String,
    pub elapsed_s: f32,
    pub message: Option<String>,
    /// In the `preview` phase: temporary G-code, in the working folder.
    pub gcode: Option<String>,
    /// The job's progress, from 0 to 100, never going back.
    pub percent: Option<f32>,
    /// The stage under way while slicing (`slice.stage.*`).
    pub stage: Option<String>,
    /// Slicing summary, in the `preview` phase.
    pub stats: Option<crate::gcode::SliceStats>,
}

/// Finished slice awaiting a decision: save, send, discard.
struct Preview {
    work: PathBuf,
    gcode: PathBuf,
    source: PathBuf,
    out_dir: Option<PathBuf>,
    /// Order of arrival: the oldest go when there are too many.
    seq: u64,
    /// Where `save` last put it: saving again overwrites that copy only.
    saved: Option<PathBuf>,
}

fn previews() -> &'static Mutex<std::collections::HashMap<String, Preview>> {
    static P: OnceLock<Mutex<std::collections::HashMap<String, Preview>>> = OnceLock::new();
    P.get_or_init(Default::default)
}

/// Previews kept at once. The sheet shows one; a few more cover a print
/// being sent while the next slice runs. Beyond that, the oldest working
/// folders (a whole plate.3mf and its G-code each) would pile up in the
/// temporary folder until `discard`, which only the sheet calls.
const MAX_PREVIEWS: usize = 8;

/// Keeps a finished slice, letting the oldest go past `MAX_PREVIEWS`.
fn remember_preview(id: String, p: Preview) {
    remember_in(&mut previews().lock().unwrap(), id, p, MAX_PREVIEWS);
}

fn remember_in(list: &mut std::collections::HashMap<String, Preview>, id: String, p: Preview, max: usize) {
    list.insert(id, p);
    while list.len() > max {
        let Some(oldest) = list.iter().min_by_key(|(_, p)| p.seq).map(|(k, _)| k.clone()) else { break };
        if let Some(p) = list.remove(&oldest) {
            let _ = std::fs::remove_dir_all(&p.work);
        }
    }
}

fn next_seq() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(1);
    N.fetch_add(1, Ordering::Relaxed)
}

/// Prefix of the working folders, in the system's temporary folder.
const WORK_PREFIX: &str = "snapstudio_slice_";

/// A slice under way: its engine process once started. Registered from the
/// first step, so that `cancel` reaches a job still preparing (presets,
/// scene written out), which can take a while on a dense plate.
struct Job {
    pid: Option<u32>,
}

type Jobs = Mutex<std::collections::HashMap<String, Job>>;

fn jobs() -> &'static Jobs {
    static J: OnceLock<Jobs> = OnceLock::new();
    J.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn emit(app: &AppHandle, p: Progress) {
    let _ = app.emit("slice-progress", p);
}

/// Extracts the useful message from the engine's logs.
fn engine_error(out: &str) -> String {
    let lines: Vec<&str> = out
        .lines()
        .filter(|l| {
            let l = l.trim();
            !l.is_empty()
                && !l.contains("sentry")
                && !l.contains("StaticPrintConfigs")
                && !l.contains("Sentry session")
                && !l.contains("calc_exclude_triangles")
        })
        .collect();
    // "run found error, exit" ends every output and tells nothing: the useful
    // message is the line just before.
    let useful: Vec<&str> = lines.iter().filter(|l| !l.contains("run found error")).cloned().collect();
    let pick = useful
        .iter()
        .rev()
        .find(|l| l.contains("[error]") || l.contains("not compatible") || l.contains("not in range") || l.contains("Param values"))
        .or_else(|| useful.last())
        .or_else(|| lines.last())
        .copied();
    // Paths that cross (two objects, or an object and the prime tower):
    // the engine only names the plate.
    if pick.is_some_and(|l| l.contains("found slicing result conflict")) {
        return crate::t!("err.slice_conflict");
    }
    let silent = crate::t!("err.engine_silent");
    let raw = pick.unwrap_or(&silent).trim();
    // Remove the timestamp and thread, unreadable in the UI.
    match raw.rfind("]   ") {
        Some(i) => raw[i + 4..].trim().to_string(),
        None => raw.to_string(),
    }
}

/// Output name enriched with the material and duration, as Orca does.
fn output_name(source: &Path, gcode: &Path) -> String {
    let stem = source.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "piece".into());
    let mut bits = vec![stem];
    if let Ok(f) = std::fs::File::open(gcode) {
        if let Ok(d) = crate::gcode::parse(f) {
            if let Some(t) = d.meta.filaments.first() {
                bits.push(t.clone());
            }
            if let Some(s) = d.meta.print_time_s {
                let (h, m) = (s / 3600, (s % 3600) / 60);
                bits.push(if h > 0 { format!("{h}h{m:02}m") } else { format!("{m}m") });
            }
        }
    }
    format!("{}.gcode", bits.join("_"))
}

/// Beyond this, bundled slicing is no longer reasonable in memory.
const SLICE_TRI_BUDGET: usize = 8_000_000;

/// Rewrites a 3MF's geometry into a new file, centered on the bed and resting
/// at Z = 0.
///
/// `extruder_map[i]` gives the head (0 to 3) printing the model's extruder
/// `i + 1`. When the model declares its extruders, the geometry becomes a
/// single object with several parts, each assigned to its head; otherwise, a
/// single block left to the first head's filament.
fn rewrite_centered(source: &Path, work: &Path, plate: (f32, f32), extruder_map: &[u8]) -> Result<PathBuf> {
    let is_stl = source.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("stl"));
    let m = if is_stl {
        crate::stl::read(source)?
    } else {
        let mut zip = crate::model3mf::open(source)?;
        crate::mesh::load_mesh(&mut zip, SLICE_TRI_BUDGET)?
    };
    if m.truncated {
        return Err(anyhow!(crate::t!("err.model_too_dense", n = m.tris.len())));
    }
    let size = m.size();
    if size[0] > plate.0 || size[1] > plate.1 {
        return Err(anyhow!(crate::t!(
            "err.part_too_big",
            w = format!("{:.0}", size[0]),
            d = format!("{:.0}", size[1]),
            pw = format!("{:.0}", plate.0),
            pd = format!("{:.0}", plate.1)
        )));
    }
    let mut t = crate::mesh::Mat::IDENTITY;
    t.0[9] = (plate.0 - size[0]) / 2.0 - m.min[0];
    t.0[10] = (plate.1 - size[1]) / 2.0 - m.min[1];
    t.0[11] = -m.min[2];

    let name = source.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "piece".into());
    let dst = work.join(format!("{name}.3mf"));

    // Destination heads: one part per head, grouping the model extruders sent
    // to the same head; painting kept.
    let head_of = |model_ext: u8| -> u8 { extruder_map.get(model_ext.saturating_sub(1) as usize).copied().unwrap_or(0).min(15) };
    let parts = crate::plate::parts_by_head(&name, m, head_of, false);
    crate::write3mf::write_multipart(&dst, &name, &parts, &t)?;
    Ok(dst)
}

/// Color of each head for the G-code's images: its spool's, otherwise its
/// filament profile's (`filament_colour`, always set by `presets::prepare`).
fn head_colors(spools: &[Option<String>], filaments: &[PathBuf]) -> Vec<Option<[u8; 3]>> {
    filaments
        .iter()
        .enumerate()
        .map(|(i, f)| {
            spools.get(i).and_then(|c| c.as_deref()).and_then(crate::plate::hex_rgb).or_else(|| {
                let v: serde_json::Value = serde_json::from_slice(&std::fs::read(f).ok()?).ok()?;
                v["filament_colour"].get(0)?.as_str().and_then(crate::plate::hex_rgb)
            })
        })
        .collect()
}

/// The plate as sent to the engine, each triangle in its head's color:
/// written extruders are heads from 1, painting included.
fn plate_mesh(input: &Path, heads: &[Option<[u8; 3]>]) -> Option<crate::mesh::MeshData> {
    let mut zip = crate::model3mf::open(input).ok()?;
    let mut m = crate::mesh::load_mesh(&mut zip, 400_000).ok()?;
    if m.extruders.len() == m.tris.len() {
        for (t, e) in m.tris.iter_mut().zip(&m.extruders) {
            if let Some(Some(c)) = heads.get(e.saturating_sub(1) as usize) {
                t.c = *c;
            }
        }
    }
    Some(m)
}

/// Filaments declared by a model, to associate them with heads.
#[derive(Serialize, Clone, Debug, Default)]
pub struct ModelInfo {
    /// One per model extruder (material, color), when the project declares them.
    pub filaments: Vec<crate::model3mf::ProjectFilament>,
    /// Extruders the model's objects declare (from 1). Painted colors are
    /// not read here — it would mean the whole mesh: each plate object lists
    /// its own (`plate::items`).
    pub used: Vec<u8>,
}

pub fn model_info(source: &Path) -> Result<ModelInfo> {
    if crate::scan::kind_of(source) != Some("3mf") {
        return Ok(ModelInfo::default());
    }
    let mut zip = crate::model3mf::open(source)?;
    let filaments = crate::model3mf::project_filaments(&mut zip);
    let mut used: Vec<u8> = crate::model3mf::extruder_settings(&mut zip)
        .values()
        .flat_map(|(obj, parts)| {
            // The object's extruder only applies to itself if it has no parts, or to
            // its parts that do not declare one.
            let obj = (*obj).max(1);
            if parts.is_empty() {
                vec![obj]
            } else {
                parts.values().map(|e| if *e > 0 { *e } else { obj }).collect()
            }
        })
        .collect();
    used.sort_unstable();
    used.dedup();
    if used.is_empty() {
        used.push(1);
    }
    let filaments = if filaments.is_empty() { part_colors(&mut zip) } else { filaments };
    Ok(ModelInfo { filaments, used })
}

/// Colors of a model without project filaments — the AI tab's files, and
/// other plain 3MF: for each head, the color most of its triangles carry.
fn part_colors(zip: &mut crate::model3mf::Zip) -> Vec<crate::model3mf::ProjectFilament> {
    let Ok(m) = crate::mesh::load_mesh(zip, 200_000) else {
        return Vec::new();
    };
    let mut count: std::collections::BTreeMap<u8, std::collections::HashMap<[u8; 3], usize>> = Default::default();
    for (i, t) in m.tris.iter().enumerate() {
        if t.c == crate::render::DEFAULT_COLOR {
            continue;
        }
        let head = m.extruders.get(i).copied().unwrap_or(1).max(1);
        *count.entry(head).or_default().entry(t.c).or_default() += 1;
    }
    count
        .into_iter()
        .filter_map(|(head, colors)| {
            let (c, _) = colors.into_iter().max_by_key(|(_, n)| *n)?;
            Some(crate::model3mf::ProjectFilament {
                index: head,
                kind: String::new(),
                color: Some(format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])),
            })
        })
        .collect()
}

/// Starts a slice. Returns the job id.
pub fn start(app_handle: AppHandle, req: Request) -> Result<String> {
    let id = format!(
        "{:x}",
        crate::util::fnv1a(&[
            req.source.as_bytes(),
            &std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0).to_le_bytes(),
        ])
    );
    let engine_app = engine().ok_or_else(|| anyhow!(crate::engine::missing()))?;
    let bin = binary(&engine_app)?;
    let idx = index_for(&engine_app)?;
    let job_id = id.clone();

    std::thread::spawn(move || {
        let handle = app_handle.clone();
        run_job(bin, idx, req, job_id, &move |p| emit(&handle, p));
    });

    Ok(id)
}

/// Full run of a slice, independent of Tauri to stay testable.
pub fn run_job(bin: PathBuf, idx: Arc<Index>, req: Request, job_id: String, report: &(dyn Fn(Progress) + Send + Sync)) {
    {
        let t0 = std::time::Instant::now();
        let el = |t: &std::time::Instant| t.elapsed().as_secs_f32();
        report(Progress {
            id: job_id.clone(),
            phase: "preparation".into(),
            elapsed_s: 0.0,
            message: None,
            gcode: None,
            ..Default::default()
        });

        let work = std::env::temp_dir().join(format!("{WORK_PREFIX}{job_id}"));
        // Nothing of a failed slice is worth keeping: its folder goes now,
        // not with the day-old ones at the next start.
        let fail = |msg: String| {
            report(Progress {
                id: job_id.clone(),
                phase: "error".into(),
                elapsed_s: el(&t0),
                message: Some(msg),
                gcode: None,
                ..Default::default()
            });
            jobs().lock().unwrap().remove(&job_id);
            let _ = std::fs::remove_dir_all(&work);
        };
        let cancelled_now = || {
            let _ = std::fs::remove_dir_all(&work);
            report(Progress {
                id: job_id.clone(),
                phase: "cancelled".into(),
                elapsed_s: el(&t0),
                message: None,
                gcode: None,
                ..Default::default()
            });
        };
        // `cancel` removes the job: from here on, its absence means "stop".
        jobs().lock().unwrap().insert(job_id.clone(), Job { pid: None });
        let is_cancelled = || !jobs().lock().unwrap().contains_key(&job_id);
        let _ = std::fs::create_dir_all(&work);

        let overrides = request_overrides(&req);
        let prep = match presets::prepare(&idx, &work, &req.machine, &req.process, &req.filaments, &req.colors, &overrides) {
            Ok(p) => p,
            Err(e) => return fail(crate::util::ui_err(e)),
        };
        if is_cancelled() {
            return cancelled_now();
        }

        // The engine crashes loading a 3MF with external geometry ("production"
        // extension), and on projects too. So the geometry is re-emitted into a
        // new file, as one block, resting at the center of the bed. It is also what
        // guarantees the part is printable where it is seen.
        // A scene has no source file: the result takes the plate's name, in the
        // folder of its first object.
        let scene_source = req.scene.first().map(|it| {
            // The plate's name becomes a file name: no separator, no control
            // character (they would send the result to a folder that is not there).
            let name = req
                .name
                .as_deref()
                .map(|n| n.chars().map(|c| if c == '/' || c == '\\' || c.is_control() { '_' } else { c }).collect::<String>())
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| "plate".into());
            Path::new(&it.path).with_file_name(format!("{name}.3mf"))
        });
        let source = scene_source.as_deref().unwrap_or(Path::new(&req.source));
        let mut arrange = "0";
        let is_stl = source.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("stl"));
        let input = if !req.scene.is_empty() {
            let dst = work.join("plate.3mf");
            match crate::plate::write_scene(&req.scene, &req.pillars, idx.plate_size(&req.machine), &dst) {
                Ok(_) => dst,
                Err(e) => return fail(crate::util::ui_err(e)),
            }
        } else if crate::scan::kind_of(source) == Some("3mf") || is_stl {
            match rewrite_centered(source, &work, idx.plate_size(&req.machine), &req.extruder_map) {
                Ok(p) => p,
                Err(e) => return fail(crate::util::ui_err(e)),
            }
        } else {
            // Other formats go as is: it is up to the engine to put them on the bed.
            arrange = "2";
            source.to_path_buf()
        };

        // Writing the scene out is the long part of the preparation.
        if is_cancelled() {
            return cancelled_now();
        }
        let out = work.join("out");
        let _ = std::fs::create_dir_all(&out);
        let settings = format!("{};{}", prep.machine.display(), prep.process.display());
        let fils = prep.filaments.iter().map(|f| f.display().to_string()).collect::<Vec<_>>().join(";");

        report(Progress {
            id: job_id.clone(),
            phase: "slicing".into(),
            elapsed_s: el(&t0),
            message: None,
            gcode: None,
            ..Default::default()
        });

        let mut cmd = std::process::Command::new(&bin);
        crate::util::no_window(&mut cmd);
        cmd.args(["--arrange", arrange, "--allow-newer-file", "--slice", "0"])
            .arg("--datadir")
            .arg(engine_datadir())
            .arg("--load-settings")
            .arg(&settings)
            .arg("--load-filaments")
            .arg(&fils)
            .arg("--outputdir")
            .arg(&out)
            // Info level: the log announces each stage, read live for the
            // progress (`Tracker`).
            .args(["--debug", "3"]);
        // The engine's JSON progress lines, where its build writes them
        // (Linux): a floor under the log's stages.
        let pipe = progress_pipe(&work).and_then(|p| open_pipe(&p).map(|f| (p, f)));
        if let Some((p, _)) = &pipe {
            cmd.arg("--pipe").arg(p);
        }
        let child = cmd.arg(&input).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(e) => return fail(crate::t!("err.engine_start", err = e)),
        };
        // Registered with its process, unless cancelled meanwhile: then the
        // engine just started has nothing to do.
        let registered = match jobs().lock().unwrap().get_mut(&job_id) {
            Some(job) => {
                job.pid = Some(child.id());
                true
            }
            None => false,
        };
        if !registered {
            terminate(child.id());
            let _ = child.wait();
            return cancelled_now();
        }

        // The engine's output is read as it comes (its stages move the
        // progress), the pipe too; the progress is reported a few times a
        // second, from here. Scoped threads borrow the tracker and the log.
        let stop = std::sync::atomic::AtomicBool::new(false);
        let tracker = Mutex::new(Tracker::new());
        let logs = Mutex::new(String::new());
        let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
        let status = std::thread::scope(|sc| {
            if let Some((_, f)) = pipe {
                let (stop, tracker) = (&stop, &tracker);
                sc.spawn(move || progress_loop(f, stop, |p| tracker.lock().unwrap().pipe(p.overall)));
            }
            for (stream, live) in [
                (stdout.map(|o| Box::new(o) as Box<dyn std::io::Read + Send>), true),
                (stderr.map(|e| Box::new(e) as Box<dyn std::io::Read + Send>), false),
            ] {
                let Some(stream) = stream else { continue };
                let (tracker, logs) = (&tracker, &logs);
                sc.spawn(move || {
                    use std::io::BufRead;
                    for line in std::io::BufReader::new(stream).split(b'\n').map_while(Result::ok) {
                        let line = String::from_utf8_lossy(&line);
                        if live {
                            tracker.lock().unwrap().line(&line, t0.elapsed().as_secs_f32());
                        }
                        if !progress_only(&line) {
                            let mut l = logs.lock().unwrap();
                            l.push_str(&line);
                            l.push('\n');
                        }
                    }
                });
            }
            let mut shown = -1.0f32;
            let status = loop {
                match child.try_wait() {
                    Ok(Some(s)) => break Ok(s),
                    Ok(None) => {}
                    Err(e) => break Err(e),
                }
                let (pct, stage) = {
                    let mut t = tracker.lock().unwrap();
                    (job_percent(t.at(t0.elapsed().as_secs_f32())), t.stage_name())
                };
                if pct - shown >= 0.5 {
                    shown = pct;
                    report(Progress {
                        id: job_id.clone(),
                        phase: "slicing".into(),
                        elapsed_s: t0.elapsed().as_secs_f32(),
                        stage: Some(stage.into()),
                        percent: Some(pct),
                        ..Default::default()
                    });
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            };
            stop.store(true, std::sync::atomic::Ordering::Relaxed);
            status
        });
        let status = match status {
            Ok(s) => s,
            Err(e) => return fail(crate::util::ui_err(e)),
        };
        let cancelled = jobs().lock().unwrap().remove(&job_id).is_none();
        if cancelled {
            return cancelled_now();
        }

        let logs = logs.into_inner().unwrap();
        if !status.success() {
            let mut msg = engine_error(&logs);
            if msg == crate::t!("err.engine_silent") {
                if let Some(code) = status.code() {
                    msg = format!("{msg} (code {code})");
                } else {
                    msg = crate::t!("err.engine_killed");
                }
            }
            return fail(msg);
        }

        let produced = std::fs::read_dir(&out)
            .ok()
            .map(|rd| {
                rd.flatten().map(|e| e.path()).filter(|p| p.extension().and_then(|x| x.to_str()) == Some("gcode")).collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let Some(first) = produced.first() else {
            return fail(engine_error(&logs));
        };

        // The engine is done: the G-code's images and summary remain.
        report(Progress {
            id: job_id.clone(),
            phase: "slicing".into(),
            elapsed_s: el(&t0),
            stage: Some("finishing".into()),
            percent: Some(job_percent(1.0).max(99.0)),
            ..Default::default()
        });

        // The printer's screen shows the print from images in the G-code,
        // which the engine's command line does not write (`gcode_thumbs`).
        // Never a reason to fail the slice.
        // A virtual head shows its mix, after the physical heads.
        let mut colors = head_colors(&req.colors, &prep.filaments);
        colors.extend(req.virtual_heads.iter().map(|v| v.color.as_deref().and_then(crate::plate::hex_rgb)));
        if let Some(mesh) = plate_mesh(&input, &colors) {
            for g in &produced {
                if let Err(e) = crate::gcode_thumbs::embed(g, &mesh) {
                    eprintln!("[slice] G-code images: {e}");
                }
            }
        }

        // The G-code stays in the working folder: it is a preview, which the user
        // will save, send to the printer or discard.
        let stats = std::fs::File::open(first).ok().and_then(|f| crate::gcode::parse(f).ok()).map(|d| crate::gcode::stats(&d));
        report(Progress {
            id: job_id.clone(),
            phase: "slicing".into(),
            elapsed_s: el(&t0),
            stage: Some("finishing".into()),
            percent: Some(100.0),
            ..Default::default()
        });
        remember_preview(
            job_id.clone(),
            Preview {
                work: work.clone(),
                gcode: first.clone(),
                source: source.to_path_buf(),
                out_dir: req.out_dir.as_ref().map(PathBuf::from),
                seq: next_seq(),
                saved: None,
            },
        );

        report(Progress {
            id: job_id.clone(),
            phase: "preview".into(),
            elapsed_s: el(&t0),
            gcode: Some(first.to_string_lossy().to_string()),
            stats,
            ..Default::default()
        });
    }
}

/// Temporary G-code of a preview.
pub fn preview_gcode(id: &str) -> Option<PathBuf> {
    previews().lock().unwrap().get(id).map(|p| p.gcode.clone())
}

/// Saves the preview under a meaningful name, next to the model by default.
/// The preview stays available (for sending to the printer, for instance).
/// A file already there under that name is kept: the new one is numbered,
/// as a download is — unless it is this preview's own earlier save, which
/// is the same G-code, written again.
pub fn save(id: &str, dir: Option<&str>) -> Result<PathBuf> {
    // Paths taken under the lock, copy done outside it.
    let (gcode, dest) = {
        let list = previews().lock().unwrap();
        let p = list.get(id).ok_or_else(|| anyhow!(crate::t!("err.no_preview")))?;
        let dest_dir = dir
            .map(PathBuf::from)
            .or_else(|| p.out_dir.clone())
            .or_else(|| p.source.parent().map(|d| d.to_path_buf()))
            .unwrap_or_else(std::env::temp_dir);
        let dest = match &p.saved {
            Some(s) if s.parent() == Some(dest_dir.as_path()) => s.clone(),
            _ => crate::library::unique_path(&dest_dir, &output_name(&p.source, &p.gcode)),
        };
        (p.gcode.clone(), dest)
    };
    std::fs::copy(&gcode, &dest).map_err(|e| anyhow!(crate::t!("err.gcode_copy", err = e)))?;
    if let Some(p) = previews().lock().unwrap().get_mut(id) {
        p.saved = Some(dest.clone());
    }
    Ok(dest)
}

/// Original model of a preview.
pub fn preview_source(id: &str) -> Option<String> {
    previews().lock().unwrap().get(id).map(|p| p.source.to_string_lossy().to_string())
}

/// File name offered for a preview (saving, sending).
pub fn preview_name(id: &str) -> Option<String> {
    let list = previews().lock().unwrap();
    let p = list.get(id)?;
    Some(output_name(&p.source, &p.gcode))
}

/// Discards a preview: its working folder goes away.
pub fn discard(id: &str) {
    if let Some(p) = previews().lock().unwrap().remove(id) {
        let _ = std::fs::remove_dir_all(&p.work);
    }
}

/// Removes working folders left by a previous session (app quit with a
/// preview open, crash).
pub fn cleanup_stale() {
    let Ok(rd) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    let day = std::time::Duration::from_secs(24 * 3600);
    for e in rd.flatten() {
        if !e.file_name().to_string_lossy().starts_with(WORK_PREFIX) {
            continue;
        }
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > day);
        if old {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// Creates the named pipe through which the engine announces its progress.
#[cfg(unix)]
fn progress_pipe(work: &Path) -> Option<PathBuf> {
    let p = work.join("progress.pipe");
    let _ = std::fs::remove_file(&p);
    let c = std::ffi::CString::new(p.to_string_lossy().as_bytes()).ok()?;
    // SAFETY: valid C path, NUL-terminated, for the duration of the call.
    let r = unsafe { libc::mkfifo(c.as_ptr(), 0o600) };
    (r == 0).then_some(p)
}

#[cfg(not(unix))]
fn progress_pipe(_work: &Path) -> Option<PathBuf> {
    None
}

/// Opens the pipe for reading, before the launch: the engine opens it for
/// non-blocking writing, which fails as long as there is no reader.
#[cfg(unix)]
fn open_pipe(pipe: &Path) -> Option<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(pipe).ok()
}

#[cfg(not(unix))]
fn open_pipe(_pipe: &Path) -> Option<std::fs::File> {
    None
}

/// Reads the engine's progress JSON lines (`--pipe`) until `stop` turns
/// true. Only Linux builds of the engine write them; on macOS and Windows
/// the pipe stays silent and the log's stages tell the progress (`Tracker`).
fn progress_loop(mut f: std::fs::File, stop: &std::sync::atomic::AtomicBool, on: impl Fn(PipeProgress)) {
    use std::io::Read;
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    let pause = std::time::Duration::from_millis(100);
    loop {
        let done = stop.load(std::sync::atomic::Ordering::Relaxed);
        match f.read(&mut chunk) {
            Ok(n) if n > 0 => {
                buf.extend_from_slice(&chunk[..n]);
                while let Some(i) = buf.iter().position(|b| *b == b'\n') {
                    let line: Vec<u8> = buf.drain(..=i).collect();
                    if let Some(p) = parse_progress(&String::from_utf8_lossy(&line)) {
                        on(p);
                    }
                }
            }
            // Nothing to read: no writer yet, or empty pipe.
            _ if done => break,
            _ => std::thread::sleep(pause),
        }
    }
}

/// A line from the engine's pipe: `{"plate_index", "plate_count",
/// "plate_percent", "total_percent", "message"}`.
#[derive(Debug, Clone, PartialEq)]
struct PipeProgress {
    /// Overall progress, 0–1: the larger of the engine's total and what its
    /// plate index and plate percentage give.
    overall: f32,
    message: Option<String>,
}

fn parse_progress(line: &str) -> Option<PipeProgress> {
    let v: Value = serde_json::from_str(line.trim_matches(|c: char| c == '\0' || c.is_whitespace())).ok()?;
    let num = |k: &str| v.get(k).and_then(|x| x.as_f64()).map(|x| x as f32);
    let total = num("total_percent").map(|t| t.clamp(0.0, 100.0) / 100.0);
    // Plates count from 1; a plate's percentage within its share.
    let by_plate = match (num("plate_index"), num("plate_count"), num("plate_percent")) {
        (Some(i), Some(n), Some(pp)) if n >= 1.0 && i >= 1.0 => Some(((i - 1.0).min(n - 1.0) + pp.clamp(0.0, 100.0) / 100.0) / n),
        _ => None,
    };
    let overall = match (total, by_plate) {
        (None, None) => return None,
        (a, b) => a.unwrap_or(0.0).max(b.unwrap_or(0.0)),
    };
    let message = v.get("message").or_else(|| v.get("warning")).and_then(|x| x.as_str()).filter(|m| !m.is_empty()).map(String::from);
    Some(PipeProgress { overall, message })
}

/// The engine's stages as its log (`--debug 3`) announces them, in order:
/// the line's start, the stage's name (`slice.stage.*`), and where in a
/// plate's work it starts (0–1, from timings of real slices: the walls and
/// the overhangs take most of it, the G-code export a fifth).
const STAGES: &[(&str, &str, f32)] = &[
    ("Starting the slicing process", "slicing", 0.00),
    ("Slicing volumes...", "slicing", 0.02),
    ("Make overhang printable...", "overhangs", 0.06),
    ("Generating walls...", "walls", 0.28),
    ("Detecting solid surfaces...", "surfaces", 0.40),
    ("Preparing fill surfaces...", "surfaces", 0.43),
    ("Discovering vertical shells...", "surfaces", 0.44),
    ("Processing external surfaces...", "surfaces", 0.50),
    ("Bridge over infill - Start", "infill", 0.52),
    ("Slicing process finished", "gcode", 0.76),
    ("Exporting G-code...", "gcode", 0.78),
    ("Exporting G-code finished", "gcode", 0.98),
];

/// The engine's load (reading the model and the presets) before the first
/// plate: this share of the whole.
const LOAD_SHARE: f32 = 0.06;

/// The engine's progress from its log, 0–1, never going back: each stage's
/// line moves it to that stage's start; meanwhile it creeps towards the next
/// stage without reaching it, so the bar keeps moving where the engine
/// says nothing (infill, supports). Several plates share the whole equally.
#[derive(Debug, Clone)]
struct Tracker {
    plates: u32,
    /// Current plate, from 0; None while loading.
    plate: Option<u32>,
    /// Current stage (index in STAGES), and when it started (s).
    stage: Option<usize>,
    since: f32,
    /// A floor from the pipe (Linux engines), and the last value given.
    floor: f32,
    last: f32,
}

impl Tracker {
    fn new() -> Self {
        Tracker { plates: 1, plate: None, stage: None, since: 0.0, floor: 0.0, last: 0.0 }
    }

    /// A line of the engine's log at time `t` (s).
    fn line(&mut self, line: &str, t: f32) {
        // "[date] [thread] [info]    Message": the message after the tags.
        let msg = line.rsplit("]   ").next().unwrap_or(line).trim_start();
        if let Some(n) = after(msg, "total plate count ").and_then(|r| r.split_whitespace().next()).and_then(|n| n.parse::<u32>().ok()) {
            self.plates = n.max(1);
        } else if let Some(k) = after(msg, "start Print::process for partplate ").and_then(|r| r.trim().parse::<u32>().ok()) {
            self.plate = Some(k.saturating_sub(1).min(self.plates - 1));
            self.stage = None;
            self.since = t;
        } else if let Some(i) = STAGES.iter().position(|(start, _, _)| msg.starts_with(start)) {
            // A plate's work without its announcement (one plate): the first.
            if self.plate.is_none() {
                self.plate = Some(0);
            }
            if self.stage.map_or(true, |s| i >= s) {
                self.stage = Some(i);
                self.since = t;
            }
        }
    }

    /// A floor from the pipe (0–1).
    fn pipe(&mut self, overall: f32) {
        self.floor = self.floor.max(overall.clamp(0.0, 1.0));
    }

    /// The stage under way (`slice.stage.*`).
    fn stage_name(&self) -> &'static str {
        match (self.plate, self.stage) {
            (None, _) => "loading",
            (Some(_), None) => "slicing",
            (Some(_), Some(i)) => STAGES[i].1,
        }
    }

    /// The progress at time `t` (s), 0–1.
    fn at(&mut self, t: f32) -> f32 {
        let span = (1.0 - LOAD_SHARE) / self.plates as f32;
        let est = match self.plate {
            // Loading: towards the load's share, slowly.
            None => LOAD_SHARE * creep(t - self.since, 4.0),
            Some(k) => {
                let (from, to) = match self.stage {
                    None => (0.0, STAGES[0].2.max(0.02)),
                    Some(i) => (STAGES[i].2, STAGES.get(i + 1).map_or(1.0, |s| s.2)),
                };
                let within = from + (to - from) * creep(t - self.since, 3.0);
                LOAD_SHARE + span * (k as f32 + within)
            }
        };
        self.last = self.last.max(est).max(self.floor).min(1.0);
        self.last
    }
}

fn after<'a>(s: &'a str, key: &str) -> Option<&'a str> {
    s.find(key).map(|i| &s[i + key.len()..])
}

/// How far into a stage of unknown length after `dt` seconds (0 to 0.9):
/// quick at first, slower and slower, never at the end.
fn creep(dt: f32, tau: f32) -> f32 {
    0.9 * (1.0 - (-dt.max(0.0) / tau).exp())
}

/// The engine's log lines that tell the progress only: kept out of the
/// output read for an error (`engine_error`), as before `--debug 3`.
fn progress_only(line: &str) -> bool {
    line.contains("] [info]") || line.contains("] [debug]")
}

/// The job's percentage (0–100) for the engine's progress (0–1): the
/// preparation before it, the G-code's images and summary after it.
fn job_percent(engine: f32) -> f32 {
    3.0 + 94.0 * engine.clamp(0.0, 1.0)
}

#[cfg(unix)]
fn terminate(pid: u32) {
    // A pid that does not fit would wrap negative: a whole process group.
    let Ok(pid) = libc::pid_t::try_from(pid) else { return };
    // SAFETY: plain signal sent to a process we started.
    unsafe { libc::kill(pid, libc::SIGTERM) };
}

#[cfg(windows)]
fn terminate(pid: u32) {
    let mut cmd = std::process::Command::new("taskkill");
    crate::util::no_window(&mut cmd);
    let _ = cmd.args(["/PID", &pid.to_string(), "/T", "/F"]).status();
}

/// Interrupts a slice, preparing or running. False: no such job (done, or
/// already cancelled).
pub fn cancel(id: &str) -> bool {
    let job = jobs().lock().unwrap().remove(id);
    match job {
        // The engine has nothing to save, the working folder is cleaned up by
        // the thread waiting for it.
        Some(Job { pid: Some(pid) }) => {
            terminate(pid);
            true
        }
        // Still preparing: the thread sees the job gone at its next step.
        Some(Job { pid: None }) => true,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_is_found() {
        let Some(app) = engine() else { return };
        let bin = binary(&app).unwrap();
        println!("engine: {}", bin.display());
        assert!(bin.is_file());
    }

    #[test]
    fn lists_are_filtered() {
        let Ok(l) = lists(None) else { return };
        println!("{} machines, {} processes, {} filaments, {} heads", l.machines.len(), l.processes.len(), l.filaments.len(), l.extruders);
        assert!(!l.machines.is_empty());
        assert!(!l.processes.is_empty(), "processes compatible with the chosen machine");
    }

    /// Full run: preparation, slicing, file put in the right place.
    #[test]
    fn full_job_produces_gcode() {
        let (Some(app), Ok(model)) = (engine(), std::env::var("SLICE_MODEL")) else {
            return;
        };
        let idx = index_for(&app).unwrap();
        let l = lists(None).unwrap();
        let machine = l.selected.get("machine").cloned().unwrap_or_else(|| l.machines[0].name.clone());
        let process = l.processes[0].name.clone();
        let filament = l.filaments.iter().find(|f| f.name.contains("PLA")).unwrap_or(&l.filaments[0]).name.clone();

        let out_dir = std::env::temp_dir().join("snapstudio_job_out");
        let _ = std::fs::remove_dir_all(&out_dir);
        std::fs::create_dir_all(&out_dir).unwrap();

        let seen: Arc<Mutex<Vec<Progress>>> = Default::default();
        let sink = seen.clone();
        run_job(
            binary(&app).unwrap(),
            idx,
            Request {
                source: model,
                machine: machine.clone(),
                process: process.clone(),
                filaments: vec![filament.clone()],
                simple: None,
                overrides: Map::new(),
                out_dir: Some(out_dir.to_string_lossy().to_string()),
                ..Default::default()
            },
            "test".into(),
            &move |p| sink.lock().unwrap().push(p),
        );

        let got = seen.lock().unwrap();
        let phases: Vec<&str> = got.iter().map(|p| p.phase.as_str()).collect();
        println!("phases: {phases:?}");
        if let Some(last) = got.last() {
            println!("last: {} in {:.1} s, message {:?}, file {:?}", last.phase, last.elapsed_s, last.message, last.gcode);
        }
        assert_eq!(phases.first(), Some(&"preparation"));
        assert!(phases.contains(&"slicing"));
        let last = got.last().unwrap();
        assert_eq!(last.phase, "preview", "message : {:?}", last.message);
        let stats = last.stats.clone().expect("summary attached to the preview");
        println!("bilan : {stats:?}");
        assert!(stats.print_time_s.unwrap_or(0) > 0, "estimated time");
        let tmp = PathBuf::from(last.gcode.clone().unwrap());
        assert!(tmp.is_file(), "preview in the working folder");
        let g = save("test", None).unwrap();
        assert!(g.is_file(), "the G-code is put down");
        assert!(g.starts_with(&out_dir), "in the requested folder");
        assert!(std::fs::metadata(&g).unwrap().len() > 10_000);
        println!("→ {}", g.file_name().unwrap().to_string_lossy());
    }

    #[test]
    fn simple_reads_and_writes_preset_values() {
        let Ok(l) = lists(None) else { return };
        let process = l.processes.iter().find(|p| p.name.contains("0.20")).unwrap_or(&l.processes[0]).name.clone();
        let d = defaults(&process).unwrap();
        println!("“{process}” → {d:?}");
        assert!(d.layer_height.unwrap_or(0.0) > 0.0);
        assert!(d.infill.unwrap_or(-1.0) >= 0.0, "infill read");
        assert!(d.walls.unwrap_or(0) >= 1, "walls read");

        // Nothing touched, nothing rewritten.
        assert!(Simple::default().to_overrides().is_empty());

        let s = Simple { layer_height: Some(0.28), infill: Some(25.0), walls: Some(3), supports: Some(true), brim: Some(false) };
        let o = s.to_overrides();
        assert_eq!(o["layer_height"], "0.28");
        assert_eq!(o["sparse_infill_density"], "25%", "the engine expects a percentage");
        assert_eq!(o["wall_loops"], "3");
        assert_eq!(o["enable_support"], "1");
        assert_eq!(o["brim_type"], "no_brim");
    }

    /// A forced layer height must end up in the G-code produced.
    #[test]
    fn override_reaches_the_gcode() {
        let (Some(app), Ok(model)) = (engine(), std::env::var("SLICE_MODEL")) else {
            return;
        };
        let l = lists(None).unwrap();
        let machine = l.selected.get("machine").cloned().unwrap_or_else(|| l.machines[0].name.clone());
        let process = l.processes[0].name.clone();
        let filament = l.filaments.iter().find(|f| f.name.contains("PLA")).unwrap_or(&l.filaments[0]).name.clone();
        let out_dir = std::env::temp_dir().join("snapstudio_job_ovr");
        let _ = std::fs::remove_dir_all(&out_dir);
        std::fs::create_dir_all(&out_dir).unwrap();

        let seen: Arc<Mutex<Vec<Progress>>> = Default::default();
        let sink = seen.clone();
        run_job(
            binary(&app).unwrap(),
            index_for(&app).unwrap(),
            Request {
                source: model,
                machine,
                process,
                filaments: vec![filament],
                simple: Some(Simple { layer_height: Some(0.3), infill: Some(5.0), ..Default::default() }),
                overrides: Map::new(),
                out_dir: Some(out_dir.to_string_lossy().to_string()),
                ..Default::default()
            },
            "ovr".into(),
            &move |p| sink.lock().unwrap().push(p),
        );
        let got = seen.lock().unwrap();
        let last = got.last().unwrap();
        assert_eq!(last.phase, "preview", "message : {:?}", last.message);
        let g = PathBuf::from(last.gcode.clone().unwrap());
        let d = crate::gcode::parse(std::fs::File::open(&g).unwrap()).unwrap();
        println!("layer asked 0.30 mm → {:?} announced, {} layers, {:.1} s", d.meta.layer_height, d.layers + 1, last.elapsed_s);
        assert_eq!(d.meta.layer_height, Some(0.3), "the forced layer height is applied");
    }

    /// A project with external geometry — the "production" extension — used to
    /// crash the engine without any message. The geometry is now re-emitted as
    /// one block before being sliced.
    #[test]
    fn production_extension_project_slices() {
        let (Some(app), Ok(model)) = (engine(), std::env::var("PROJECT_MODEL")) else {
            return;
        };
        // The file must really be of the type that caused the problem.
        let z = crate::model3mf::open(Path::new(&model)).unwrap();
        let names = crate::model3mf::entry_names(&z);
        assert!(names.iter().any(|n| n.starts_with("3D/Objects/")), "this test targets a 3MF with external geometry");
        drop(z);

        let l = lists(None).unwrap();
        let machine = l.selected.get("machine").cloned().unwrap_or_else(|| l.machines[0].name.clone());
        let out_dir = std::env::temp_dir().join("snapstudio_job_prod");
        let _ = std::fs::remove_dir_all(&out_dir);
        std::fs::create_dir_all(&out_dir).unwrap();
        let seen: Arc<Mutex<Vec<Progress>>> = Default::default();
        let sink = seen.clone();
        run_job(
            binary(&app).unwrap(),
            index_for(&app).unwrap(),
            Request {
                source: model,
                machine,
                process: l.processes[0].name.clone(),
                filaments: vec![l.filaments[0].name.clone()],
                simple: None,
                overrides: Map::new(),
                out_dir: Some(out_dir.to_string_lossy().to_string()),
                ..Default::default()
            },
            "prod".into(),
            &move |p| sink.lock().unwrap().push(p),
        );
        let got = seen.lock().unwrap();
        let last = got.last().unwrap();
        assert_eq!(last.phase, "preview", "message : {:?}", last.message);
        println!("→ {}", last.gcode.clone().unwrap());
    }

    #[test]
    fn engine_progress_lines_are_read() {
        let p = parse_progress(r#"{"plate_index":1,"plate_count":1,"plate_percent":40,"total_percent":37,"message":"Generating G-code"}"#)
            .unwrap();
        assert!((p.overall - 0.40).abs() < 1e-6, "the plate's own 40 % beats a lower total");
        assert_eq!(p.message.as_deref(), Some("Generating G-code"));
        assert!(parse_progress("bruit").is_none());
        let p = parse_progress("{\"total_percent\":100,\"message\":\"\"}\0\0").unwrap();
        assert!(p.message.is_none() && p.overall == 1.0, "empty message ignored, NUL bytes tolerated");
        // Several plates: the second of three, half done, is half-way through
        // the second third.
        let p = parse_progress(r#"{"plate_index":2,"plate_count":3,"plate_percent":50,"total_percent":10}"#).unwrap();
        assert!((p.overall - 0.5).abs() < 1e-6);
        assert!(parse_progress(r#"{"message":"no number"}"#).is_none());
    }

    /// The engine's log, as a real slice wrote it on macOS (`--debug 3`,
    /// Snapmaker Orca 2.4, a 12 s slice), moves the progress forward, stage
    /// by stage, never back, to the end.
    #[test]
    fn progress_follows_the_engine_log() {
        let log = [
            (0.0, "[2026-10-24 16:44:55.073855] [0x1] [info]    Will use pipe /tmp/progress.pipe"),
            (0.8, "[2026-10-24 16:44:55.893044] [0x1] [info]    Need to slice for plate 0, total plate count 1 partplates!"),
            (0.9, "[2026-10-24 16:44:55.956181] [0x1] [info]    start Print::process for partplate 1"),
            (0.9, "[2026-10-24 16:44:55.957023] [0x1] [info]    Starting the slicing process. Resident memory: 158MB"),
            (0.9, "[2026-10-24 16:44:55.957128] [0x1] [info]    Slicing volumes... Resident memory: 158MB"),
            (1.2, "[2026-10-24 16:44:56.254114] [0x1] [info]    Make overhang printable..."),
            (4.8, "[2026-10-24 16:44:59.838819] [0x1] [info]    Generating walls... Resident memory: 408MB"),
            (6.0, "[2026-10-24 16:45:01.026199] [0x1] [info]    Detecting solid surfaces... Resident memory: 409MB"),
            (6.2, "[2026-10-24 16:45:01.272778] [0x1] [info]    Preparing fill surfaces... Resident memory: 414MB"),
            (6.2, "[2026-10-24 16:45:01.272843] [0x1] [info]    Discovering vertical shells... Resident memory: 414MB"),
            (6.9, "[2026-10-24 16:45:01.968405] [0x1] [info]    Processing external surfaces... Resident memory: 428MB"),
            (7.0, "[2026-10-24 16:45:02.083037] [0x1] [info]    Bridge over infill - Start Resident memory: 428MB"),
            (9.3, "[2026-10-24 16:45:04.386407] [0x1] [info]    Slicing process finished. Resident memory: 442MB"),
            (9.3, "[2026-10-24 16:45:04.386857] [0x1] [info]    Exporting G-code... Resident memory: 442MB"),
            (11.5, "[2026-10-24 16:45:06.604310] [0x1] [info]    Exporting G-code finished Resident memory: 731MB"),
        ];
        let mut t = Tracker::new();
        assert_eq!(t.stage_name(), "loading");
        let mut last = 0.0;
        let mut seen = vec![];
        for (at, line) in log {
            // Ticks between lines: the bar creeps, never back.
            for k in 0..5 {
                let p = t.at(at - 0.5 + k as f32 * 0.1);
                assert!(p >= last, "{p} after {last}");
                last = p;
            }
            t.line(line, at);
            let p = t.at(at);
            assert!(p >= last);
            last = p;
            seen.push((t.stage_name(), p));
        }
        // Each stage starts where the table says, within the plate's share.
        let at = |name: &str| seen.iter().find(|(s, _)| *s == name).unwrap().1;
        assert!(at("walls") > 0.25 && at("walls") < 0.35, "{}", at("walls"));
        assert!(at("gcode") > 0.7 && at("gcode") < 0.8, "{}", at("gcode"));
        assert!(last > 0.9 && last < 1.0, "the export done, not yet the end: {last}");
        // Within a long stage, it moves, but stops short of the next one.
        let mut s = Tracker::new();
        s.line("[x] [0x1] [info]    Make overhang printable...", 0.0);
        let (a, b) = (s.at(1.0), s.at(30.0));
        assert!(a > LOAD_SHARE + 0.06 * (1.0 - LOAD_SHARE) && b > a && b < LOAD_SHARE + 0.28 * (1.0 - LOAD_SHARE));
        // A stage seen out of order does not move it back.
        let before = s.at(30.0);
        s.line("[x] [0x1] [info]    Slicing volumes...", 31.0);
        assert!(s.at(31.0) >= before);
    }

    /// Several plates share the whole: the second of two starts half-way.
    #[test]
    fn progress_counts_the_plates() {
        let mut t = Tracker::new();
        t.line("[x] [0x1] [info]    Need to slice for plate 0, total plate count 2 partplates!", 0.0);
        t.line("[x] [0x1] [info]    start Print::process for partplate 1", 0.1);
        t.line("[x] [0x1] [info]    Exporting G-code finished Resident memory: 1MB", 5.0);
        let first = t.at(5.0);
        assert!(first < LOAD_SHARE + 0.5 * (1.0 - LOAD_SHARE), "{first}");
        t.line("[x] [0x1] [info]    start Print::process for partplate 2", 5.1);
        t.line("[x] [0x1] [info]    Starting the slicing process.", 5.1);
        let second = t.at(5.1);
        assert!(second >= LOAD_SHARE + 0.5 * (1.0 - LOAD_SHARE) - 1e-6 && second >= first, "{second}");
        // The pipe, where it speaks, is a floor.
        t.pipe(0.95);
        assert!(t.at(5.2) >= 0.95);
        // The job's scale: the preparation before, the images after.
        assert_eq!(job_percent(0.0), 3.0);
        assert_eq!(job_percent(1.0), 97.0);
        // The log's info lines stay out of what an error is read from.
        assert!(progress_only("[2026] [0x1] [info]    Generating walls..."));
        assert!(!progress_only("[2026] [0x1] [error]   Nothing to be sliced"));
    }

    /// Extruders used: the parts', the object's for parts that declare none;
    /// project filaments read with their color.
    #[test]
    fn model_info_counts_part_extruders() {
        use std::io::Write;
        let tmp = std::env::temp_dir().join("snapstudio-model-info.3mf");
        let mut z = zip::ZipWriter::new(std::fs::File::create(&tmp).unwrap());
        let o = zip::write::SimpleFileOptions::default();
        z.start_file("Metadata/model_settings.config", o).unwrap();
        z.write_all(
            br#"<config>
  <object id="7"><metadata key="extruder" value="1"/>
    <part id="1" subtype="normal_part"><metadata key="extruder" value="2"/></part>
    <part id="2" subtype="normal_part"><metadata key="extruder" value="3"/></part>
    <part id="3" subtype="normal_part"/>
  </object>
  <object id="9"><metadata key="extruder" value="4"/></object>
</config>"#,
        )
        .unwrap();
        z.start_file("Metadata/project_settings.config", o).unwrap();
        z.write_all(br##"{"filament_type":["PLA","PETG"],"filament_colour":["#FF0000FF","#00FF00"]}"##).unwrap();
        z.finish().unwrap();
        let info = model_info(&tmp).unwrap();
        // Part 3 without an extruder: the object's (1); object 9, without parts, 4.
        assert_eq!(info.used, vec![1, 2, 3, 4]);
        assert_eq!(info.filaments.len(), 2);
        assert_eq!(info.filaments[0].color.as_deref(), Some("#ff0000"));
        assert_eq!(info.filaments[1].kind, "PETG");
        let _ = std::fs::remove_file(&tmp);
    }

    /// A two-extruder model becomes an object with two parts, each on the
    /// requested head.
    #[test]
    fn multicolor_model_keeps_its_heads() {
        use crate::mesh::{Mat, Tri};
        let tmp = std::env::temp_dir().join("snapstudio-multicolor-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let tri = |z: f32| Tri { v: [[0., 0., z], [10., 0., z], [0., 10., z + 1.]], c: [200, 30, 30] };
        let src = tmp.join("two.3mf");
        crate::write3mf::write_multipart(
            &src,
            "two",
            &[
                crate::write3mf::Part { name: "bas".into(), tris: vec![tri(0.)], extruder: 1, paint: Vec::new() },
                crate::write3mf::Part { name: "haut".into(), tris: vec![tri(20.)], extruder: 2, paint: Vec::new() },
            ],
            &Mat::IDENTITY,
        )
        .unwrap();
        let info = model_info(&src).unwrap();
        assert_eq!(info.used, vec![1, 2]);

        // Extruder 1 → head 3, extruder 2 → head 0.
        let out = rewrite_centered(&src, &tmp, (270.0, 270.0), &[3, 0]).unwrap();
        let mut zip = crate::model3mf::open(&out).unwrap();
        let m = crate::mesh::load_mesh(&mut zip, 1_000).unwrap();
        assert_eq!(m.extruders.len(), m.tris.len());
        let low = m.tris.iter().position(|t| t.v[0][2] < 1.0).unwrap();
        let high = m.tris.iter().position(|t| t.v[0][2] > 10.0).unwrap();
        assert_eq!(m.extruders[low], 4, "bottom on head 3");
        assert_eq!(m.extruders[high], 1, "top on head 0");
        assert!(m.tris[high].v[0][2] > 15.0, "the high part stays up");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Real slice of a two-color model (machine with the engine installed).
    #[test]
    fn multicolor_job_uses_two_heads() {
        let Some(app) = engine() else { return };
        let Ok(l) = lists(None) else { return };
        if l.extruders < 2 {
            return;
        }
        use crate::mesh::{Mat, Tri};
        let tmp = std::env::temp_dir().join("snapstudio-multicolor-slice");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // Two stacked 10 mm cubes.
        let cube = |z0: f32| -> Vec<Tri> {
            let s = 10.0;
            #[rustfmt::skip]
            let p = [
                [0., 0., z0], [s, 0., z0], [s, s, z0], [0., s, z0],
                [0., 0., z0 + s], [s, 0., z0 + s], [s, s, z0 + s], [0., s, z0 + s],
            ];
            #[rustfmt::skip]
            let f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
                     [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
            f.iter().map(|t| Tri { v: [p[t[0]], p[t[1]], p[t[2]]], c: [120, 120, 120] }).collect()
        };
        let src = tmp.join("bicolore.3mf");
        crate::write3mf::write_multipart(
            &src,
            "bicolore",
            &[
                crate::write3mf::Part { name: "bas".into(), tris: cube(0.0), extruder: 1, paint: Vec::new() },
                crate::write3mf::Part { name: "haut".into(), tris: cube(10.0), extruder: 2, paint: Vec::new() },
            ],
            &Mat::IDENTITY,
        )
        .unwrap();
        let machine = l.selected.get("machine").cloned().unwrap_or_else(|| l.machines[0].name.clone());
        let fil = l.filaments.iter().find(|f| f.name.contains("PLA")).unwrap_or(&l.filaments[0]).name.clone();
        let seen: Arc<Mutex<Vec<Progress>>> = Default::default();
        let sink = seen.clone();
        run_job(
            binary(&app).unwrap(),
            index_for(&app).unwrap(),
            Request {
                source: src.to_string_lossy().to_string(),
                machine,
                process: l.processes[0].name.clone(),
                filaments: vec![fil.clone(), fil.clone(), fil.clone(), fil],
                extruder_map: vec![0, 1],
                ..Default::default()
            },
            "bicolore".into(),
            &move |p| sink.lock().unwrap().push(p),
        );
        let got = seen.lock().unwrap();
        let last = got.last().unwrap();
        assert_eq!(last.phase, "preview", "message : {:?}", last.message);
        let tools = last.stats.clone().unwrap().tools;
        println!("heads used: {tools:?}");
        assert!(tools.contains(&0) && tools.contains(&1), "both heads extrude");
        discard("bicolore");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Real slice of a plate scene: two placed objects, one rotated; the G-code
    /// must find them where the plate put them.
    /// Smoke test of an engine: real U1 0.4 mm profiles, two cubes on two heads.
    /// Run by the "Engine" CI on each slimmed engine:
    /// `SNAPSTUDIO_ENGINE=… cargo test --lib engine_smoke -- --ignored`.
    #[test]
    #[ignore]
    fn engine_smoke() {
        let app = engine().expect("SNAPSTUDIO_ENGINE: engine to try out");
        println!("engine: {}", app.display());
        let machine = "Snapmaker U1 (0.4 nozzle)".to_string();
        let l = lists(Some(&machine)).expect("profiles readable in the engine");
        assert!(l.machines.iter().any(|m| m.name == machine), "U1 0.4 machine profile");
        let process = l.processes.iter().find(|p| p.name.starts_with("0.20mm Standard")).unwrap_or(&l.processes[0]).name.clone();
        let pla = l.filaments.iter().find(|f| f.name.contains("PLA")).expect("un filament PLA").name.clone();
        use crate::mesh::{Mat, Tri};
        let tmp = std::env::temp_dir().join("snapstudio-engine-smoke");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let cube = |s: f32| -> Vec<Tri> {
            #[rustfmt::skip]
            let p = [[0., 0., 0.], [s, 0., 0.], [s, s, 0.], [0., s, 0.], [0., 0., s], [s, 0., s], [s, s, s], [0., s, s]];
            #[rustfmt::skip]
            let f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
                     [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
            f.iter().map(|t| Tri { v: [p[t[0]], p[t[1]], p[t[2]]], c: [120, 120, 120] }).collect()
        };
        let src = tmp.join("cubes.3mf");
        crate::write3mf::write_scene(
            &src,
            &[
                crate::write3mf::SceneObject { name: "a".into(), tris: cube(12.0), transform: Mat::IDENTITY, extruder: None },
                crate::write3mf::SceneObject { name: "b".into(), tris: cube(12.0), transform: Mat::IDENTITY, extruder: None },
            ],
        )
        .unwrap();
        // One cube per head: T0 and T1.
        let item = |i: usize, x: f32, head: u8| crate::plate::SceneItem {
            path: src.to_string_lossy().to_string(),
            item: i,
            name: format!("cube {i}"),
            pos: [x, 100.0],
            rot: [0.0, 0.0, 0.0],
            scale: [1.0, 1.0, 1.0],
            extruder_map: vec![head],
            piece: None,
        };
        let seen: Arc<Mutex<Vec<Progress>>> = Default::default();
        let sink = seen.clone();
        let t0 = std::time::Instant::now();
        run_job(
            binary(&app).unwrap(),
            index_for(&app).unwrap(),
            Request {
                machine,
                process,
                filaments: vec![pla.clone(), pla],
                scene: vec![item(0, 100.0, 0), item(1, 170.0, 1)],
                name: Some("smoke".into()),
                ..Default::default()
            },
            "smoke".into(),
            &move |p| sink.lock().unwrap().push(p),
        );
        let got = seen.lock().unwrap();
        let last = got.last().unwrap();
        assert_eq!(last.phase, "preview", "slicing failed: {:?}", last.message);
        let path = last.gcode.clone().unwrap();
        let stats = last.stats.clone().expect("bilan");
        println!("G-code in {:.1} s: {} · {:?} · heads {:?}", t0.elapsed().as_secs_f32(), path, stats.print_time_s, stats.tools);
        assert!(std::fs::metadata(&path).unwrap().len() > 10_000, "non-empty G-code");
        assert!(stats.tools.contains(&0) && stats.tools.contains(&1), "both heads are used");
        discard("smoke");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// The progress a real slice reports, event by event, with its time:
    /// to check it follows the engine's work.
    /// `TRACE_3MF=model.3mf cargo test --lib engine_progress_trace -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn engine_progress_trace() {
        let app = engine().expect("an engine (SNAPSTUDIO_ENGINE or the installed one)");
        let src = std::env::var("TRACE_3MF").expect("TRACE_3MF: a model to slice");
        let machine = "Snapmaker U1 (0.4 nozzle)".to_string();
        let l = lists(Some(&machine)).unwrap();
        let process = l.processes.iter().find(|p| p.name.starts_with("0.20mm Standard")).unwrap_or(&l.processes[0]).name.clone();
        let pla = l.filaments.iter().find(|f| f.name.contains("PLA")).unwrap().name.clone();
        let t0 = std::time::Instant::now();
        run_job(
            binary(&app).unwrap(),
            index_for(&app).unwrap(),
            Request { source: src, machine, process, filaments: vec![pla; 4], ..Default::default() },
            "trace".into(),
            &move |p| {
                eprintln!(
                    "{:6.2}s {} {:?} {:?} {:?}",
                    t0.elapsed().as_secs_f32(),
                    p.phase,
                    p.stage,
                    p.percent.map(|x| x.round()),
                    p.message
                )
            },
        );
        discard("trace");
    }

    /// The G-code's images color each part with its head's spool, painting
    /// included; a head without a known spool takes its profile's color.
    #[test]
    fn plate_images_take_the_heads_colors() {
        let dir = std::env::temp_dir().join("snapstudio_plate_mesh");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("cube.3mf");
        // Volume on extruder 1, triangle 0 painted with filament 2.
        crate::mesh::testkit::painted_cube(&src, &["8"], Some(1));
        let scene = vec![crate::plate::SceneItem {
            path: src.to_string_lossy().to_string(),
            item: 0,
            name: "cube".into(),
            pos: [100.0, 100.0],
            rot: [0.0; 3],
            scale: [1.0; 3],
            // Color 1 → T2, color 2 → T0.
            extruder_map: vec![2, 0],
            piece: None,
        }];
        let plate = dir.join("plate.3mf");
        crate::plate::write_scene(&scene, &[], (270.0, 270.0), &plate).unwrap();
        let profile = dir.join("filament_0.json");
        std::fs::write(&profile, r##"{"filament_colour":["#00FF00"]}"##).unwrap();
        let other = dir.join("filament_1.json");
        std::fs::write(&other, "{}").unwrap();
        // T0: no spool color, its profile's green; T1: none at all; T2: a red spool.
        let heads = head_colors(&[None, None, Some("#FF0000".into())], &[profile, other.clone(), other]);
        assert_eq!(heads, vec![Some([0, 255, 0]), None, Some([255, 0, 0])]);
        let m = plate_mesh(&plate, &heads).unwrap();
        assert_eq!(m.tris[0].c, [0, 255, 0], "painted with color 2, on T0");
        assert_eq!(m.tris[1].c, [255, 0, 0], "the volume's color 1, on T2");
    }

    /// A painted model really prints in its colors: the engine must use one
    /// head per painted color, as the plate chose them — even when the
    /// spools' colors are unknown (the engine counts filaments by color).
    /// `SNAPSTUDIO_ENGINE=… PAINT_3MF=… PAINT_ITEM=0 cargo test --lib engine_painted -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn engine_painted() {
        let app = engine().expect("SNAPSTUDIO_ENGINE: engine to try out");
        let src = std::env::var("PAINT_3MF").expect("PAINT_3MF: a painted 3MF");
        let index: usize = std::env::var("PAINT_ITEM").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
        let machine = "Snapmaker U1 (0.4 nozzle)".to_string();
        let l = lists(Some(&machine)).expect("profiles readable in the engine");
        let process = l.processes.iter().find(|p| p.name.starts_with("0.20mm Standard")).unwrap_or(&l.processes[0]).name.clone();
        let pla = l.filaments.iter().find(|f| f.name.contains("PLA")).expect("a PLA filament").name.clone();
        // The object's colors, spread over the heads in order.
        let mut zip = crate::model3mf::open(Path::new(&src)).unwrap();
        let mesh = crate::mesh::load_item(&mut zip, index, usize::MAX).unwrap().mesh;
        let colors = crate::mesh::colors_used(&mesh);
        let mut map = vec![0u8; *colors.iter().max().unwrap() as usize];
        for (h, c) in colors.iter().enumerate() {
            map[*c as usize - 1] = (h % 4) as u8;
        }
        println!("colors {colors:?} → heads {map:?}");
        let seen: Arc<Mutex<Vec<Progress>>> = Default::default();
        let sink = seen.clone();
        run_job(
            binary(&app).unwrap(),
            index_for(&app).unwrap(),
            Request {
                machine,
                process,
                filaments: vec![pla; 4],
                // No spool colors: the hardest case (`presets::prepare`).
                scene: vec![crate::plate::SceneItem {
                    path: src.clone(),
                    item: index,
                    name: "painted".into(),
                    pos: [135.0, 135.0],
                    rot: [0.0, 0.0, 0.0],
                    scale: [1.0, 1.0, 1.0],
                    extruder_map: map,
                    piece: None,
                }],
                name: Some("painted".into()),
                ..Default::default()
            },
            "painted".into(),
            &move |p| sink.lock().unwrap().push(p),
        );
        let got = seen.lock().unwrap();
        let last = got.last().unwrap();
        assert_eq!(last.phase, "preview", "slicing failed: {:?}", last.message);
        let stats = last.stats.clone().expect("stats");
        println!("heads used {:?}", stats.tools);
        // The printer's screen gets the print's picture (`gcode_thumbs`).
        let gcode = std::fs::read_to_string(last.gcode.as_ref().unwrap()).unwrap();
        assert!(gcode.contains("; thumbnail begin 48x48") && gcode.contains("; thumbnail begin 300x300"), "images in the G-code");
        if let Ok(dst) = std::env::var("PAINT_THUMB") {
            let png = crate::gcode::embedded_thumbnail(gcode.as_bytes()).unwrap();
            std::fs::write(dst, png).unwrap();
        }
        let want: Vec<u8> = (0..colors.len().min(4) as u8).collect();
        assert!(want.iter().all(|h| stats.tools.contains(h)), "every color's head prints");
        discard("painted");
    }

    /// Advanced settings reach the engine: a real slice with the overrides the
    /// slice sheet's sub-panels send, read back from the G-code's config block.
    /// `SNAPSTUDIO_ENGINE=… cargo test --lib engine_advanced_overrides -- --ignored`.
    #[test]
    #[ignore]
    fn engine_advanced_overrides() {
        let app = engine().expect("SNAPSTUDIO_ENGINE: engine to try out");
        let machine = "Snapmaker U1 (0.4 nozzle)".to_string();
        let l = lists(Some(&machine)).expect("profiles");
        let process = l.processes.iter().find(|p| p.name.starts_with("0.20mm Standard")).unwrap_or(&l.processes[0]).name.clone();
        let pla = l.filaments.iter().find(|f| f.name.contains("PLA")).expect("PLA").name.clone();
        use crate::mesh::{Mat, Tri};
        let tmp = std::env::temp_dir().join("snapstudio-engine-adv");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // An overhanging "T": supports have something to do.
        let bx = |x0: f32, y0: f32, z0: f32, x1: f32, y1: f32, z1: f32| -> Vec<Tri> {
            #[rustfmt::skip]
            let p = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
            #[rustfmt::skip]
            let f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
                     [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
            f.iter().map(|t| Tri { v: [p[t[0]], p[t[1]], p[t[2]]], c: [120, 120, 120] }).collect()
        };
        let mut t = bx(8.0, 8.0, 0.0, 12.0, 12.0, 10.0);
        t.extend(bx(0.0, 0.0, 10.0, 20.0, 20.0, 13.0));
        let src = tmp.join("t.3mf");
        crate::write3mf::write_scene(
            &src,
            &[crate::write3mf::SceneObject { name: "t".into(), tris: t, transform: Mat::IDENTITY, extruder: None }],
        )
        .unwrap();
        let mut overrides = Map::new();
        for (k, v) in [
            ("seam_position", "back"),
            ("seam_gap", "12%"),
            ("staggered_inner_seams", "1"),
            ("support_type", "tree(auto)"),
            ("support_style", "tree_slim"),
            ("support_interface_top_layers", "3"),
            ("support_threshold_angle", "40"),
            ("tree_support_branch_angle", "35"),
            // The lists chosen from pictures (#59).
            ("support_base_pattern", "honeycomb"),
            ("support_interface_pattern", "concentric"),
            // One per panel of #60: Quality, Infill, Walls, Surfaces, Other.
            ("initial_layer_print_height", "0.3"),
            ("elefant_foot_compensation", "0.1"),
            ("sparse_infill_pattern", "gyroid"),
            ("infill_direction", "30"),
            ("wall_generator", "arachne"),
            ("wall_sequence", "outer wall/inner wall"),
            ("top_shell_layers", "6"),
            ("top_surface_pattern", "concentric"),
            ("ironing_type", "top"),
            ("skirt_loops", "2"),
            ("fuzzy_skin", "external"),
            ("brim_type", "brim_ears"),
            ("brim_width", "7"),
            ("brim_object_gap", "0.2"),
            ("enable_prime_tower", "1"),
            ("prime_tower_width", "40"),
            ("flush_into_infill", "1"),
            ("wall_filament", "2"),
            ("support_filament", "2"),
            // The prime tower's wall and ooze prevention (#35); the idle
            // temperature goes to the filaments.
            ("wipe_tower_filament", "1"),
            ("ooze_prevention", "1"),
            ("standby_temperature_delta", "-40"),
            ("preheat_time", "45"),
            ("idle_temperature", "150"),
        ] {
            overrides.insert(k.into(), Value::String(v.into()));
        }
        let seen: Arc<Mutex<Vec<Progress>>> = Default::default();
        let sink = seen.clone();
        run_job(
            binary(&app).unwrap(),
            index_for(&app).unwrap(),
            Request {
                machine,
                process,
                filaments: vec![pla.clone(), pla],
                scene: vec![crate::plate::SceneItem {
                    path: src.to_string_lossy().to_string(),
                    item: 0,
                    name: "t".into(),
                    pos: [120.0, 120.0],
                    rot: [0.0; 3],
                    scale: [1.0; 3],
                    extruder_map: vec![0],
                    piece: None,
                }],
                simple: Some(Simple { supports: Some(true), brim: Some(true), ..Default::default() }),
                overrides,
                name: Some("adv".into()),
                ..Default::default()
            },
            "adv".into(),
            &move |p| sink.lock().unwrap().push(p),
        );
        let got = seen.lock().unwrap();
        let last = got.last().unwrap();
        assert_eq!(last.phase, "preview", "slicing failed: {:?}", last.message);
        let gcode = std::fs::read_to_string(last.gcode.clone().unwrap()).unwrap();
        for (k, v) in [
            ("seam_position", "back"),
            ("seam_gap", "12%"),
            ("enable_support", "1"),
            ("support_type", "tree(auto)"),
            ("support_style", "tree_slim"),
            ("support_interface_top_layers", "3"),
            ("brim_type", "brim_ears"),
            ("support_base_pattern", "honeycomb"),
            ("support_interface_pattern", "concentric"),
            ("initial_layer_print_height", "0.3"),
            ("elefant_foot_compensation", "0.1"),
            ("sparse_infill_pattern", "gyroid"),
            ("infill_direction", "30"),
            ("wall_generator", "arachne"),
            ("wall_sequence", "outer wall/inner wall"),
            ("top_shell_layers", "6"),
            ("top_surface_pattern", "concentric"),
            ("ironing_type", "top"),
            ("skirt_loops", "2"),
            ("fuzzy_skin", "external"),
            ("brim_width", "7"),
            ("enable_prime_tower", "1"),
            ("prime_tower_width", "40"),
            ("wall_filament", "2"),
            ("support_filament", "2"),
            ("wipe_tower_filament", "1"),
            ("ooze_prevention", "1"),
            ("standby_temperature_delta", "-40"),
            ("preheat_time", "45"),
            ("idle_temperature", "150,150,150,150"),
        ] {
            let line = format!("; {k} = {v}");
            assert!(gcode.contains(&line), "missing in G-code: {line}");
        }
        let stats = last.stats.clone().unwrap();
        println!("heads used: {:?}", stats.tools);
        assert!(stats.tools.contains(&1), "wall/support filament 2 extrudes on T1");
        discard("adv");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// The prime tower lands where Prepare put it: a two-head plate sliced
    /// with `wipe_tower_x` / `wipe_tower_y` (front-left corner, one per
    /// plate) and `wipe_tower_rotation_angle`, the tower read back from the
    /// G-code's moves. Off, no tower is printed, whatever the profile says.
    /// `SNAPSTUDIO_ENGINE=… cargo test --lib engine_prime_tower_position -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn engine_prime_tower_position() {
        let app = engine().expect("SNAPSTUDIO_ENGINE: engine to try out");
        let machine = "Snapmaker U1 (0.4 nozzle)".to_string();
        let l = lists(Some(&machine)).expect("profiles");
        let process = l.processes.iter().find(|p| p.name.starts_with("0.20mm Standard")).unwrap_or(&l.processes[0]).name.clone();
        let pla = l.filaments.iter().find(|f| f.name.contains("PLA")).expect("PLA").name.clone();
        use crate::mesh::{Mat, Tri};
        let tmp = std::env::temp_dir().join("snapstudio-engine-tower");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // Two 20 × 20 × 10 mm boxes, one per head.
        let bx = |x0: f32, y0: f32, x1: f32, y1: f32| -> Vec<Tri> {
            let (z0, z1) = (0.0, 10.0);
            #[rustfmt::skip]
            let p = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
            #[rustfmt::skip]
            let f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
                     [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
            f.iter().map(|t| Tri { v: [p[t[0]], p[t[1]], p[t[2]]], c: [120, 120, 120] }).collect()
        };
        let src = tmp.join("two.3mf");
        crate::write3mf::write_scene(
            &src,
            &[
                crate::write3mf::SceneObject { name: "a".into(), tris: bx(0.0, 0.0, 20.0, 20.0), transform: Mat::IDENTITY, extruder: None },
                crate::write3mf::SceneObject { name: "b".into(), tris: bx(0.0, 0.0, 20.0, 20.0), transform: Mat::IDENTITY, extruder: None },
            ],
        )
        .unwrap();
        let slice = |id: &str, tower: &[(&str, Value)]| {
            let mut overrides = Map::new();
            for (k, v) in tower {
                overrides.insert((*k).into(), v.clone());
            }
            let seen: Arc<Mutex<Vec<Progress>>> = Default::default();
            let sink = seen.clone();
            let item = |i: usize, x: f32, head: u8| crate::plate::SceneItem {
                path: src.to_string_lossy().to_string(),
                item: i,
                name: format!("o{i}"),
                pos: [x, 135.0],
                rot: [0.0; 3],
                scale: [1.0; 3],
                extruder_map: vec![head],
                piece: None,
            };
            run_job(
                binary(&app).unwrap(),
                index_for(&app).unwrap(),
                Request {
                    machine: machine.clone(),
                    process: process.clone(),
                    filaments: vec![pla.clone(), pla.clone()],
                    scene: vec![item(0, 120.0, 0), item(1, 150.0, 1)],
                    overrides,
                    name: Some(id.into()),
                    ..Default::default()
                },
                id.into(),
                &move |p| sink.lock().unwrap().push(p),
            );
            let last = seen.lock().unwrap().last().cloned().unwrap();
            assert_eq!(last.phase, "preview", "slicing failed: {:?}", last.message);
            let stats = last.stats.clone().unwrap();
            assert!(stats.tools.contains(&0) && stats.tools.contains(&1), "both heads extrude");
            discard(id);
            stats.tower
        };
        let s = |v: &str| Value::String(v.into());
        let list = |v: &str| Value::Array(vec![Value::String(v.into())]);
        // A plain wall and no brim: the box is the tower itself.
        let at = |x: &str, y: &str, a: &str| {
            vec![
                ("enable_prime_tower", s("1")),
                ("prime_tower_width", s("40")),
                ("wipe_tower_wall_type", s("rectangle")),
                ("prime_tower_brim_width", s("0")),
                ("wipe_tower_x", list(x)),
                ("wipe_tower_y", list(y)),
                ("wipe_tower_rotation_angle", s(a)),
            ]
        };
        let near = |a: f32, b: f32| (a - b).abs() < 0.2;
        let t = slice("tower-a", &at("200", "30", "0")).expect("a tower");
        println!("at (200, 30), 0°: {t:?}");
        assert!(near(t.x, 200.0) && near(t.y, 30.0), "placed at its front-left corner: {t:?}");
        assert!(near(t.x0, 0.0) && near(t.y0, 0.0) && near(t.w, 40.0), "{t:?}");
        let t = slice("tower-b", &at("60", "150", "90")).expect("a tower");
        println!("at (60, 150), 90°: {t:?}");
        assert!(near(t.x0, 0.0) && near(t.y0, 0.0) && near(t.w, 40.0), "turned around that corner: {t:?}");
        // The U1's own tower (rib walls, 5 mm brim): a square from the
        // corner, only the brim beyond it (2.4.1 offsets the ribs inside:
        // 2.4.0's box started 9.7 mm out).
        let t = slice("tower-rib", &[("enable_prime_tower", s("1")), ("wipe_tower_x", list("150")), ("wipe_tower_y", list("200"))])
            .expect("a tower");
        println!("U1 tower at (150, 200): {t:?}");
        assert!((t.x0 + 5.0).abs() < 0.5 && (t.y0 + 5.0).abs() < 0.5 && (t.w - t.d).abs() < 3.0, "{t:?}");
        // Off: none, though the U1's profiles turn it on.
        assert_eq!(slice("tower-off", &[("enable_prime_tower", s("0"))]), None);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Tower sizes on the engine in SNAPSTUDIO_ENGINE, for `ptEstimate`'s
    /// calibration (scripts/test-tower.js): one box per head, a material per
    /// head (`PLA`, `PETG`, `TPU`: one adhesiveness category each on 2.4.1).
    /// Prints one line per case; `TOWER_GCODE_DIR` keeps each case's G-code.
    /// `cargo test --lib engine_tower_sizes -- --ignored --nocapture`
    #[test]
    #[ignore = "needs a slicing engine (SNAPSTUDIO_ENGINE)"]
    fn engine_tower_sizes() {
        let app = engine().expect("SNAPSTUDIO_ENGINE: engine to try out");
        let machine = "Snapmaker U1 (0.4 nozzle)".to_string();
        let l = lists(Some(&machine)).expect("profiles");
        let process = l.processes.iter().find(|p| p.name.starts_with("0.20mm Standard")).unwrap_or(&l.processes[0]).name.clone();
        let find = |m: &str| {
            l.filaments
                .iter()
                .find(|f| f.ftype.as_deref() == Some(m) && f.vendor.as_deref() != Some("Generic"))
                .or_else(|| l.filaments.iter().find(|f| f.ftype.as_deref() == Some(m)))
                .unwrap_or_else(|| panic!("a {m} profile"))
                .name
                .clone()
        };
        let idx = index_for(&app).unwrap();
        for m in ["PLA", "PETG", "TPU"] {
            let f = idx.flatten(&find(m)).unwrap_or_default();
            println!(
                "{m}: {} · category {:?} · minimal purge {:?}",
                find(m),
                f.get("filament_adhesiveness_category"),
                f.get("filament_minimal_purge_on_wipe_tower")
            );
        }
        use crate::mesh::{Mat, Tri};
        let tmp = std::env::temp_dir().join("snapstudio-engine-tower-sizes");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        #[rustfmt::skip]
        let p = [[0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [10.0, 10.0, 0.0], [0.0, 10.0, 0.0], [0.0, 0.0, 10.0], [10.0, 0.0, 10.0], [10.0, 10.0, 10.0], [0.0, 10.0, 10.0]];
        #[rustfmt::skip]
        let f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
                 [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
        let cube: Vec<Tri> = f.iter().map(|t| Tri { v: [p[t[0]], p[t[1]], p[t[2]]], c: [120, 120, 120] }).collect();
        let src = tmp.join("cube.3mf");
        crate::write3mf::write_scene(
            &src,
            &[crate::write3mf::SceneObject { name: "c".into(), tris: cube, transform: Mat::IDENTITY, extruder: None }],
        )
        .unwrap();
        let keep = std::env::var_os("TOWER_GCODE_DIR").map(PathBuf::from);
        let s = |v: &str| Value::String(v.into());
        let run = |label: &str, mats: &[&str], set: &[(&str, &str)]| {
            let mut overrides = Map::new();
            overrides.insert("enable_prime_tower".into(), s("1"));
            overrides.insert("wipe_tower_x".into(), Value::Array(vec![s("150")]));
            overrides.insert("wipe_tower_y".into(), Value::Array(vec![s("200")]));
            for (k, v) in set {
                overrides.insert((*k).into(), s(v));
            }
            let seen: Arc<Mutex<Vec<Progress>>> = Default::default();
            let sink = seen.clone();
            let id = format!("tower-{}", label.replace(' ', "-"));
            let scene = (0..mats.len())
                .map(|i| crate::plate::SceneItem {
                    path: src.to_string_lossy().to_string(),
                    item: 0,
                    name: format!("o{i}"),
                    pos: [60.0 + 25.0 * i as f32, 100.0],
                    rot: [0.0; 3],
                    scale: [1.0; 3],
                    extruder_map: vec![i as u8],
                    piece: None,
                })
                .collect();
            run_job(
                binary(&app).unwrap(),
                index_for(&app).unwrap(),
                Request {
                    machine: machine.clone(),
                    process: process.clone(),
                    filaments: mats.iter().map(|m| find(m)).collect(),
                    scene,
                    overrides,
                    name: Some(id.clone()),
                    ..Default::default()
                },
                id.clone(),
                &move |p| sink.lock().unwrap().push(p),
            );
            let last = seen.lock().unwrap().last().cloned().unwrap();
            if last.phase != "preview" {
                println!("{label} [{}]: failed: {:?}", mats.join("+"), last.message);
                return;
            }
            if let (Some(dir), Some(g)) = (&keep, &last.gcode) {
                let _ = std::fs::create_dir_all(dir);
                let _ = std::fs::copy(g, dir.join(format!("{id}-{}.gcode", mats.join("-"))));
            }
            let t = last.stats.and_then(|s| s.tower);
            match t {
                Some(t) => println!("{label} [{}]: x0 {:.2} y0 {:.2} w {:.2} d {:.2}", mats.join("+"), t.x0, t.y0, t.w, t.d),
                None => println!("{label} [{}]: no tower", mats.join("+")),
            }
            discard(&id);
        };
        let plain = |layer: &'static str, width: &'static str, volume: &'static str| {
            [
                ("wipe_tower_wall_type", "rectangle"),
                ("prime_tower_brim_width", "0"),
                ("layer_height", layer),
                ("prime_tower_width", width),
                ("prime_volume", volume),
            ]
        };
        // One category: test-tower.js's plain-wall cases.
        for (heads, layer, width, volume) in [
            (2, "0.2", "40", "45"),
            (3, "0.2", "40", "45"),
            (4, "0.2", "40", "45"),
            (2, "0.2", "60", "45"),
            (4, "0.2", "60", "45"),
            (2, "0.2", "40", "90"),
            (4, "0.2", "40", "90"),
            (2, "0.12", "40", "45"),
            (4, "0.12", "40", "45"),
            (4, "0.12", "40", "90"),
            (2, "0.2", "40", "15"),
            (4, "0.2", "40", "15"),
            (2, "0.2", "40", "30"),
            (4, "0.2", "40", "30"),
        ] {
            let mats = vec!["PLA"; heads];
            run(&format!("plain {heads}h {layer} {width}w {volume}v"), &mats, &plain(layer, width, volume));
        }
        // The U1's own tower (rib walls, its brim): one category.
        for heads in [2, 3, 4] {
            for volume in ["45", "15", "30"] {
                run(&format!("rib {heads}h {volume}v"), &vec!["PLA"; heads], &[("prime_volume", volume)]);
            }
        }
        // Several categories.
        for mats in [
            vec!["PLA", "PETG"],
            vec!["PLA", "PLA", "PETG"],
            vec!["PLA", "PETG", "TPU"],
            vec!["PLA", "PLA", "PETG", "PETG"],
            vec!["PLA", "PETG", "PETG", "PETG"],
        ] {
            run("plain 0.2 40w 45v", &mats, &plain("0.2", "40", "45"));
            run("rib 45v", &mats, &[("prime_volume", "45")]);
        }
        // The outer wall in one material (`wipe_tower_filament`, 1-based).
        let mut walled = plain("0.2", "40", "45").to_vec();
        walled.push(("wipe_tower_filament", "1"));
        run("plain walled T1", &["PLA", "PETG"], &walled);
        run("rib walled T1", &["PLA", "PETG"], &[("prime_volume", "45"), ("wipe_tower_filament", "1")]);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Smooth mix: the three keys only with a virtual head and the switch
    /// on; a value set by hand wins; the pillars' keys still apply.
    #[test]
    fn smooth_mix_overrides() {
        let v = VirtualHead { a: 0, b: 2, pct: 50, color: None };
        let smooth = |o: &Map<String, Value>| SMOOTH_MIX_OVERRIDES.map(|k| o.get(k).and_then(|x| x.as_str()).map(String::from));
        let on = [Some("1".to_string()), Some("1".into()), Some("1".into())];
        let req = |heads: Vec<VirtualHead>, smooth_mix: bool| Request { virtual_heads: heads, smooth_mix, ..Default::default() };
        assert_eq!(smooth(&request_overrides(&req(vec![v.clone()], true))), on);
        assert_eq!(smooth(&request_overrides(&req(vec![v.clone()], false))), [None, None, None], "off: nothing sent");
        assert_eq!(smooth(&request_overrides(&req(vec![], true))), [None, None, None], "no virtual head: nothing sent");
        let o = request_overrides(&req(vec![], false));
        assert!(!o.contains_key("mixed_filament_definitions"));
        assert!(!o.keys().any(|k| k.starts_with("dithering_") || k.starts_with("mixed_filament_height")), "{o:?}");
        // A key set by hand in Advanced wins.
        let mut r = req(vec![v.clone()], true);
        r.overrides.insert("dithering_local_z_infill".into(), Value::String("0".into()));
        assert_eq!(smooth(&request_overrides(&r)), [Some("1".into()), Some("1".into()), Some("0".into())]);
        // With per-material pillars: both sets, the pillars' unchanged.
        r.scene = vec![crate::plate::SceneItem {
            path: String::new(),
            item: 0,
            name: String::new(),
            pos: [0.0; 2],
            rot: [0.0; 3],
            scale: [1.0; 3],
            extruder_map: vec![],
            piece: None,
        }];
        r.pillars = vec![crate::plate::Pillar { name: "p".into(), x: 10.0, y: 10.0, rings: vec![], brim: 0.0 }];
        r.overrides.insert("enable_prime_tower".into(), Value::String("1".into()));
        let o = request_overrides(&r);
        for (k, val) in PILLAR_OVERRIDES {
            assert_eq!(o.get(k).and_then(|x| x.as_str()), Some(val), "{k}");
        }
        assert_eq!(o.get("dithering_local_z_mode").and_then(|x| x.as_str()), Some("1"));
        assert!(o.get("mixed_filament_definitions").is_some());
    }

    /// The engine's mixed filaments, as Orca serializes them.
    #[test]
    fn mixed_definitions_rows() {
        let v = |a, b, pct| VirtualHead { a, b, pct, color: None };
        assert_eq!(mixed_definitions(&[]), "");
        assert_eq!(mixed_definitions(&[v(0, 2, 33)]), "1,3,1,1,33,0,g,w,m2,z0,xa0,xb0,d0,o0,u1");
        assert_eq!(
            mixed_definitions(&[v(0, 2, 33), v(3, 1, 80)]),
            "1,3,1,1,33,0,g,w,m2,z0,xa0,xb0,d0,o0,u1;4,2,1,1,80,0,g,w,m2,z0,xa0,xb0,d0,o0,u2"
        );
        let r: Request = serde_json::from_str(
            r##"{"source":"","machine":"m","process":"p","filaments":[],"virtual_heads":[{"a":0,"b":2,"pct":33,"color":"#2f8d38"}]}"##,
        )
        .unwrap();
        assert_eq!(r.virtual_heads, vec![VirtualHead { a: 0, b: 2, pct: 33, color: Some("#2f8d38".into()) }]);
    }

    /// A virtual head reaches the engine: a 10 mm cube on V1 (T0 + T2, 2:1)
    /// at 0.1 mm, the mix in the process settings, prints T0, T0, T2 layer
    /// after layer; the G-code has only physical tools.
    /// `SNAPSTUDIO_ENGINE=… cargo test --lib engine_virtual_head_alternates -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn engine_virtual_head_alternates() {
        let app = engine().expect("SNAPSTUDIO_ENGINE: engine to try out");
        let machine = "Snapmaker U1 (0.4 nozzle)".to_string();
        let l = lists(Some(&machine)).expect("profiles");
        let process = l.processes.iter().find(|p| p.name.starts_with("0.10mm")).expect("a 0.10 mm profile").name.clone();
        let pla = l.filaments.iter().find(|f| f.name.contains("PLA")).expect("PLA").name.clone();
        use crate::mesh::{Mat, Tri};
        let tmp = std::env::temp_dir().join("snapstudio-engine-mix");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        #[rustfmt::skip]
        let p = [[0., 0., 0.], [10., 0., 0.], [10., 10., 0.], [0., 10., 0.], [0., 0., 10.], [10., 0., 10.], [10., 10., 10.], [0., 10., 10.]];
        #[rustfmt::skip]
        let f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
        let tris: Vec<Tri> = f.iter().map(|t| Tri { v: [p[t[0]], p[t[1]], p[t[2]]], c: [120, 120, 120] }).collect();
        let src = tmp.join("cube.3mf");
        crate::write3mf::write_scene(
            &src,
            &[crate::write3mf::SceneObject { name: "c".into(), tris, transform: Mat::IDENTITY, extruder: None }],
        )
        .unwrap();
        let mut overrides = Map::new();
        overrides.insert("enable_prime_tower".into(), Value::String("0".into()));
        let seen: Arc<Mutex<Vec<Progress>>> = Default::default();
        let sink = seen.clone();
        run_job(
            binary(&app).unwrap(),
            index_for(&app).unwrap(),
            Request {
                machine,
                process,
                filaments: vec![pla; 4],
                // Head 4: the first virtual head on a 4-head printer.
                scene: vec![crate::plate::SceneItem {
                    path: src.to_string_lossy().to_string(),
                    item: 0,
                    name: "c".into(),
                    pos: [135.0, 135.0],
                    rot: [0.0; 3],
                    scale: [1.0; 3],
                    extruder_map: vec![4],
                    piece: None,
                }],
                virtual_heads: vec![VirtualHead { a: 0, b: 2, pct: 33, color: Some("#2f8d38".into()) }],
                overrides,
                name: Some("mix".into()),
                ..Default::default()
            },
            "mix".into(),
            &move |p| sink.lock().unwrap().push(p),
        );
        let last = seen.lock().unwrap().last().cloned().unwrap();
        assert_eq!(last.phase, "preview", "slicing failed: {:?}", last.message);
        let gcode = std::fs::read_to_string(last.gcode.clone().unwrap()).unwrap();
        assert!(gcode.contains("; mixed_filament_definitions = 1,3,1,1,33,"), "the mix reached the engine");
        // The tool printing each layer's features.
        let (mut tool, mut layer, mut per_layer) =
            (None::<u8>, -1i32, std::collections::BTreeMap::<i32, std::collections::BTreeSet<u8>>::new());
        for l in gcode.lines() {
            if l.starts_with(";LAYER_CHANGE") {
                layer += 1;
            } else if let Some(t) = l.strip_prefix('T').and_then(|t| t.trim().parse::<u8>().ok()) {
                tool = Some(t);
            } else if l.starts_with(";TYPE:") && layer >= 0 {
                if let Some(t) = tool {
                    per_layer.entry(layer).or_default().insert(t);
                }
            }
        }
        let seq: Vec<u8> = per_layer.values().map(|s| *s.iter().next().unwrap()).collect();
        println!("tools by layer: {:?}", &seq[..seq.len().min(12)]);
        assert!(per_layer.values().all(|s| s.len() == 1), "one head per layer");
        assert!(seq.len() >= 90, "a 10 mm cube at 0.1 mm: {} layers", seq.len());
        assert!(seq.chunks(3).take(seq.len() / 3).all(|c| c == [0, 0, 2]), "T0, T0, T2: {seq:?}");
        assert_eq!(last.stats.unwrap().tools, vec![0, 2], "only physical tools");
        discard("mix");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// One prime tower per material through the app's path: the
    /// feasibility test's plate (a 30 mm PLA cube in two halves on T0 / T1,
    /// a 20 mm PETG cube on T2) with the pillars the UI makes for it (a
    /// two-ring PLA pillar, a PETG tube), sliced, its G-code read back:
    /// 1. every extrusion on a ring is by that ring's head;
    /// 2. on every layer, each head starts on its pillar;
    /// 3. each ring stops at its head's last layer on the model (± 1);
    /// 4. no engine tower, nothing extruded outside the objects;
    /// 5. after each tool change, the head primes above its pillar.
    /// The overrides are the engine's even when the request says otherwise.
    /// `SNAPSTUDIO_ENGINE=… cargo test --lib engine_material_pillars -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn engine_material_pillars() {
        let app = engine().expect("SNAPSTUDIO_ENGINE: engine to try out");
        let machine = "Snapmaker U1 (0.4 nozzle)".to_string();
        let l = lists(Some(&machine)).expect("profiles");
        let process = l.processes.iter().find(|p| p.name.starts_with("0.20mm Standard")).unwrap_or(&l.processes[0]).name.clone();
        let fil = |want: &str, fallback: &str| {
            l.filaments
                .iter()
                .find(|f| f.name == want)
                .or_else(|| l.filaments.iter().find(|f| f.name.contains(fallback) && !f.name.contains("Support")))
                .expect(fallback)
                .name
                .clone()
        };
        let (pla, petg) = (fil("Snapmaker PLA Basic @U1", "PLA"), fil("Snapmaker PETG HF", "PETG"));
        use crate::mesh::{Mat, Tri};
        let tmp = std::env::temp_dir().join("snapstudio-engine-pillars");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let bx = |x0: f32, y0: f32, x1: f32, y1: f32, h: f32| -> Vec<Tri> {
            #[rustfmt::skip]
            let p = [[x0, y0, 0.], [x1, y0, 0.], [x1, y1, 0.], [x0, y1, 0.], [x0, y0, h], [x1, y0, h], [x1, y1, h], [x0, y1, h]];
            #[rustfmt::skip]
            let f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
            f.iter().map(|t| Tri { v: [p[t[0]], p[t[1]], p[t[2]]], c: [120, 120, 120] }).collect()
        };
        let part = |name: &str, tris: Vec<Tri>, extruder: u8| crate::write3mf::Part { name: name.into(), tris, extruder, paint: vec![] };
        let pla_src = tmp.join("pla.3mf");
        crate::write3mf::write_multipart(
            &pla_src,
            "pla",
            &[part("a", bx(0., 0., 15., 30., 30.), 1), part("b", bx(15., 0., 30., 30., 30.), 2)],
            &Mat::IDENTITY,
        )
        .unwrap();
        let petg_src = tmp.join("petg.3mf");
        crate::write3mf::write_multipart(&petg_src, "petg", &[part("c", bx(0., 0., 20., 20., 20.), 1)], &Mat::IDENTITY).unwrap();
        let item = |src: &Path, name: &str, pos: [f32; 2], map: Vec<u8>| crate::plate::SceneItem {
            path: src.to_string_lossy().to_string(),
            item: 0,
            name: name.into(),
            pos,
            rot: [0.0; 3],
            scale: [1.0; 3],
            extruder_map: map,
            piece: None,
        };
        let scene = vec![item(&pla_src, "pla", [125.0, 135.0], vec![0, 1]), item(&petg_src, "petg", [170.0, 135.0], vec![2])];
        // As pillar-logic.js makes them: the rings 16/12 and 12/8 mm, the tube
        // 15/11 mm, on the layer grid (0.25 mm, then 0.2 mm), a 3 mm brim.
        use crate::plate::{Pillar, Ring};
        let pillars = vec![
            Pillar {
                name: "Prime tower · PLA".into(),
                x: 60.0,
                y: 135.0,
                brim: 3.0,
                rings: vec![Ring { head: 0, d_out: 16.0, d_in: 12.0, h: 30.05 }, Ring { head: 1, d_out: 12.0, d_in: 8.0, h: 30.05 }],
            },
            Pillar {
                name: "Prime tower · PETG".into(),
                x: 220.0,
                y: 135.0,
                brim: 3.0,
                rings: vec![Ring { head: 2, d_out: 15.0, d_in: 11.0, h: 20.05 }],
            },
        ];
        let mut overrides = Map::new();
        // What a sheet might hold: the pillars' overrides win.
        overrides.insert("print_order".into(), Value::String("default".into()));
        overrides.insert("enable_prime_tower".into(), Value::String("1".into()));
        let seen: Arc<Mutex<Vec<Progress>>> = Default::default();
        let sink = seen.clone();
        run_job(
            binary(&app).unwrap(),
            index_for(&app).unwrap(),
            Request {
                machine,
                process,
                filaments: vec![pla.clone(), pla.clone(), petg, pla],
                scene,
                pillars: pillars.clone(),
                overrides,
                name: Some("pillars".into()),
                ..Default::default()
            },
            "pillars".into(),
            &move |p| sink.lock().unwrap().push(p),
        );
        let last = seen.lock().unwrap().last().cloned().unwrap();
        assert_eq!(last.phase, "preview", "slicing failed: {:?}", last.message);
        let path = last.gcode.clone().unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        for (k, v) in PILLAR_OVERRIDES {
            assert!(text.contains(&format!("; {k} = {v}\n")), "{k} = {v} reached the engine");
        }
        let g = crate::gcode::parse(std::fs::File::open(&path).unwrap()).unwrap();
        // Which ring (pillar, head) a point is on, if any: within its annulus,
        // half a line width of slack.
        let on_ring = |x: f32, y: f32| -> Option<(usize, u8)> {
            for (i, p) in pillars.iter().enumerate() {
                let r = ((x - p.x).powi(2) + (y - p.y).powi(2)).sqrt();
                for ring in &p.rings {
                    if r >= ring.d_in / 2.0 - 0.25 && r <= ring.d_out / 2.0 + 0.25 {
                        return Some((i, ring.head));
                    }
                }
            }
            None
        };
        let on_pillar = |x: f32, y: f32, slack: f32| {
            pillars.iter().position(|p| ((x - p.x).powi(2) + (y - p.y).powi(2)).sqrt() <= p.rings[0].d_out / 2.0 + slack)
        };
        let ext: Vec<&crate::gcode::Seg> = g.segs.iter().filter(|s| !s.travel).collect();
        // 1. Rings by their own head (the ring's own walls; the brim and the
        // shared edge between two rings aside).
        let mut wrong = 0;
        let mut on_rings = 0;
        for s in &ext {
            if let (Some((pa, ha)), Some((pb, hb))) = (on_ring(s.a[0], s.a[1]), on_ring(s.b[0], s.b[1])) {
                if pa == pb && ha == hb && s.layer > 0 {
                    on_rings += 1;
                    let shared = pillars[pa].rings.iter().any(|r| {
                        r.head != ha && {
                            let rr = ((s.a[0] - pillars[pa].x).powi(2) + (s.a[1] - pillars[pa].y).powi(2)).sqrt();
                            (rr - r.d_out / 2.0).abs() < 0.3 || (rr - r.d_in / 2.0).abs() < 0.3
                        }
                    });
                    if s.tool != ha && !shared {
                        wrong += 1;
                    }
                }
            }
        }
        println!("1. ring extrusions: {on_rings}, by another head: {wrong}");
        assert!(on_rings > 1000, "the rings are printed");
        assert_eq!(wrong, 0, "each ring by its own head");
        // 2. Per layer and head, the first extrusion is on that head's pillar.
        let mut first: std::collections::BTreeMap<(u16, u8), [f32; 3]> = Default::default();
        for s in &ext {
            first.entry((s.layer, s.tool)).or_insert(s.a);
        }
        let late: Vec<_> =
            first.iter().filter(|((layer, _), a)| *layer > 0 && on_pillar(a[0], a[1], 4.0).is_none()).map(|(k, _)| *k).collect();
        println!("2. layer × head starts: {}, not on a pillar: {}", first.len(), late.len());
        assert!(late.is_empty(), "each head starts on its pillar: {:?}", &late[..late.len().min(8)]);
        // 3. Each ring's last layer, against its head's last layer on the model.
        let last_layer =
            |pred: &dyn Fn(&crate::gcode::Seg) -> bool| ext.iter().filter(|s| pred(s)).map(|s| s.layer).max().unwrap_or(0) as i32;
        for p in &pillars {
            for r in &p.rings {
                let ring = last_layer(&|s| s.tool == r.head && on_pillar(s.a[0], s.a[1], 4.0).is_some());
                let model = last_layer(&|s| s.tool == r.head && on_pillar(s.a[0], s.a[1], 4.0).is_none());
                println!("3. T{}: ring to layer {ring}, model to layer {model}", r.head);
                assert!((ring - model).abs() <= 1, "T{} ring {ring} vs model {model}", r.head);
            }
        }
        // 4. No engine tower, nothing outside the objects (pillars with their
        // brims, the parts with a margin for theirs).
        assert!(!text.contains(";TYPE:Prime tower"), "no engine tower");
        assert!(last.stats.as_ref().unwrap().tower.is_none());
        let parts = [(125.0f32 - 15.0, 135.0f32 - 15.0, 125.0f32 + 15.0, 135.0f32 + 15.0), (160.0, 125.0, 180.0, 145.0)];
        let stray = ext
            .iter()
            .filter(|s| {
                s.layer > 0
                    && on_pillar(s.a[0], s.a[1], 4.5).is_none()
                    && !parts.iter().any(|b| s.a[0] > b.0 - 8.0 && s.a[0] < b.2 + 8.0 && s.a[1] > b.1 - 8.0 && s.a[1] < b.3 + 8.0)
            })
            .count();
        println!("4. extrusions outside the objects: {stray}");
        assert_eq!(stray, 0);
        // 5. After each tool change, the standstill prime is above a pillar.
        let (mut x, mut y, mut layer, mut changed) = (0.0f32, 0.0f32, -1i32, false);
        let (mut primes, mut off) = (0, Vec::new());
        for line in text.lines() {
            let l = line.split(';').next().unwrap_or("").trim();
            if line.starts_with(";LAYER_CHANGE") {
                layer += 1;
            } else if layer >= 0 && l.len() >= 2 && l.starts_with('T') && l[1..].parse::<u8>().is_ok() {
                changed = true;
            } else if l.starts_with("G0 ") || l.starts_with("G1 ") {
                let mut e = None;
                let mut moved = false;
                for w in l.split_whitespace().skip(1) {
                    let (k, v) = w.split_at(1);
                    match (k, v.parse::<f32>()) {
                        ("X", Ok(v)) => {
                            x = v;
                            moved = true;
                        }
                        ("Y", Ok(v)) => {
                            y = v;
                            moved = true;
                        }
                        ("E", Ok(v)) => e = Some(v),
                        _ => {}
                    }
                }
                if changed && !moved && e.is_some_and(|e| e >= 3.0) {
                    primes += 1;
                    if on_pillar(x, y, 4.0).is_none() {
                        off.push((layer, x, y));
                    }
                    changed = false;
                }
            }
        }
        println!("5. primes after a tool change: {primes}, off the pillars: {}", off.len());
        assert!(primes > 100, "the U1 primes after its tool changes");
        assert!(off.is_empty(), "{:?}", &off[..off.len().min(8)]);
        let st = last.stats.unwrap();
        println!("time {:?} s, filament {:?} g, tools {:?}", g.meta.print_time_s, g.meta.filament_g, st.tools);
        discard("pillars");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Smooth mix reaches the engine: a 30 × 30 × 20 mm box on a 1:1 virtual
    /// head (T0 + T2) at 0.20 mm. On, the three keys are in the G-code, every
    /// layer is split into 0.10 mm sub-layers, one per head, walls and
    /// infill alike, with about twice the tool changes; off, one head per
    /// layer, as before.
    /// `SNAPSTUDIO_ENGINE=… cargo test --lib engine_virtual_head_smooth_mix -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn engine_virtual_head_smooth_mix() {
        let app = engine().expect("SNAPSTUDIO_ENGINE: engine to try out");
        let machine = "Snapmaker U1 (0.4 nozzle)".to_string();
        let l = lists(Some(&machine)).expect("profiles");
        let process = l.processes.iter().find(|p| p.name.starts_with("0.20mm Standard")).expect("a 0.20 mm profile").name.clone();
        let pla = l.filaments.iter().find(|f| f.name.contains("PLA") && !f.name.contains("Support")).expect("PLA").name.clone();
        use crate::mesh::{Mat, Tri};
        let tmp = std::env::temp_dir().join("snapstudio-engine-smooth");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        #[rustfmt::skip]
        let p = [[0., 0., 0.], [30., 0., 0.], [30., 30., 0.], [0., 30., 0.], [0., 0., 20.], [30., 0., 20.], [30., 30., 20.], [0., 30., 20.]];
        #[rustfmt::skip]
        let f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
        let tris: Vec<Tri> = f.iter().map(|t| Tri { v: [p[t[0]], p[t[1]], p[t[2]]], c: [120, 120, 120] }).collect();
        let src = tmp.join("box.3mf");
        crate::write3mf::write_scene(
            &src,
            &[crate::write3mf::SceneObject { name: "box".into(), tris, transform: Mat::IDENTITY, extruder: None }],
        )
        .unwrap();
        // One slice: its G-code.
        let slice = |id: &str, smooth: bool| -> String {
            let mut overrides = Map::new();
            overrides.insert("enable_prime_tower".into(), Value::String("0".into()));
            let seen: Arc<Mutex<Vec<Progress>>> = Default::default();
            let sink = seen.clone();
            run_job(
                binary(&app).unwrap(),
                index_for(&app).unwrap(),
                Request {
                    machine: machine.clone(),
                    process: process.clone(),
                    filaments: vec![pla.clone(); 4],
                    scene: vec![crate::plate::SceneItem {
                        path: src.to_string_lossy().to_string(),
                        item: 0,
                        name: "box".into(),
                        pos: [135.0, 135.0],
                        rot: [0.0; 3],
                        scale: [1.0; 3],
                        extruder_map: vec![4],
                        piece: None,
                    }],
                    virtual_heads: vec![VirtualHead { a: 0, b: 2, pct: 50, color: None }],
                    smooth_mix: smooth,
                    overrides,
                    name: Some(id.into()),
                    ..Default::default()
                },
                id.into(),
                &move |p| sink.lock().unwrap().push(p),
            );
            let last = seen.lock().unwrap().last().cloned().unwrap();
            assert_eq!(last.phase, "preview", "slicing failed: {:?}", last.message);
            let g = std::fs::read_to_string(last.gcode.clone().unwrap()).unwrap();
            discard(id);
            g
        };
        // Per layer: its top, its height, and the tools printing its walls
        // and its infill. The tool-change block extrudes before the layer's
        // first ;TYPE:, so the type starts empty at each layer.
        struct Layer {
            z: f32,
            /// The thinnest ;HEIGHT: in it.
            h: f32,
            walls: std::collections::BTreeSet<u8>,
            infill: std::collections::BTreeSet<u8>,
        }
        let read = |g: &str| -> (Vec<Layer>, usize) {
            let (mut layers, mut tool, mut kind, mut changes) = (Vec::<Layer>::new(), None::<u8>, String::new(), 0usize);
            for line in g.lines() {
                if line.starts_with(";LAYER_CHANGE") {
                    layers.push(Layer { z: 0.0, h: 0.0, walls: Default::default(), infill: Default::default() });
                    kind.clear();
                } else if let (Some(v), Some(l)) = (line.strip_prefix(";Z:"), layers.last_mut()) {
                    l.z = v.trim().parse().unwrap_or(0.0);
                } else if let (Some(v), Some(l)) = (line.strip_prefix(";HEIGHT:"), layers.last_mut()) {
                    // A sub-layer's own height: the thinnest of the layer.
                    let h: f32 = v.trim().parse().unwrap_or(0.0);
                    l.h = if l.h > 0.0 { l.h.min(h) } else { h };
                } else if let Some(t) = line.strip_prefix('T').and_then(|t| t.trim().parse::<u8>().ok()) {
                    if !layers.is_empty() && tool.is_some_and(|x| x != t) {
                        changes += 1;
                    }
                    tool = Some(t);
                } else if let Some(k) = line.strip_prefix(";TYPE:") {
                    kind = k.trim().to_string();
                } else if line.starts_with("G1 ") && line.contains(" E") && line.contains('X') {
                    if let (Some(l), Some(t)) = (layers.last_mut(), tool) {
                        if kind.ends_with("wall") {
                            l.walls.insert(t);
                        } else if kind.contains("infill") {
                            l.infill.insert(t);
                        }
                    }
                }
            }
            (layers, changes)
        };
        let keys = |g: &str| SMOOTH_MIX_OVERRIDES.iter().map(|k| g.contains(&format!("; {k} = 1\n"))).collect::<Vec<_>>();

        let off = slice("smooth-off", false);
        let (layers_off, changes_off) = read(&off);
        assert_eq!(keys(&off), [false; 3], "off: none of the keys");
        assert!(layers_off.iter().all(|l| l.walls.len() <= 1 && l.infill.len() <= 1), "off: one head per layer");

        let on = slice("smooth-on", true);
        let (layers_on, changes_on) = read(&on);
        assert_eq!(keys(&on), [true; 3], "on: the three keys reached the engine");
        let heights: std::collections::BTreeSet<String> = layers_on.iter().skip(1).map(|l| format!("{:.2}", l.h)).collect();
        println!(
            "off: {} layers, {changes_off} tool changes; on: {} layers, {changes_on} tool changes, heights {heights:?}",
            layers_off.len(),
            layers_on.len()
        );
        // Sub-layers grouped by the 0.20 mm layer they make up (above the
        // first): both heads print its walls and its infill.
        let mut by_layer: std::collections::BTreeMap<i32, (std::collections::BTreeSet<u8>, std::collections::BTreeSet<u8>)> =
            Default::default();
        let first = layers_on.first().map(|l| l.z).unwrap_or(0.2);
        for l in layers_on.iter().filter(|l| l.z > first + 0.01) {
            let e = by_layer.entry(((l.z - first - 0.001) / 0.2).floor() as i32).or_default();
            e.0.extend(&l.walls);
            e.1.extend(&l.infill);
        }
        let full = by_layer.values().filter(|(w, i)| w.len() == 2 && i.len() == 2).count();
        println!("on: {full} of {} layers with both heads on walls and infill", by_layer.len());
        assert!(by_layer.len() > 80);
        // The top shell may close on one head: the last layers aside.
        assert!(by_layer.values().take(by_layer.len() - 5).all(|(w, _)| w == &[0u8, 2].into()), "walls by both heads on every layer");
        assert!(full * 10 >= by_layer.len() * 8, "infill by both heads on most layers: {full} / {}", by_layer.len());
        assert!(layers_on.iter().skip(1).all(|l| l.h >= 0.04 - 1e-3), "never below the 0.04 mm bound");
        assert!(heights.contains("0.10"), "0.10 mm sub-layers: {heights:?}");
        assert!(changes_on as f32 >= changes_off as f32 * 1.7, "about twice the tool changes: {changes_off} → {changes_on}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// The Speed adjustment reaches the engine: the values the slice sheet
    /// sends at 75 % (lists per nozzle flow type, as in the U1 profiles) are
    /// in the G-code's config block and slow the print down; with no
    /// override the config block is the profile's.
    /// `SNAPSTUDIO_ENGINE=… cargo test --lib engine_speed_overrides -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn engine_speed_overrides() {
        let app = engine().expect("SNAPSTUDIO_ENGINE: engine to try out");
        let machine = "Snapmaker U1 (0.4 nozzle)".to_string();
        let l = lists(Some(&machine)).expect("profiles");
        let process = "0.20mm Standard @Snapmaker U1 (0.4 nozzle)".to_string();
        assert!(l.processes.iter().any(|p| p.name == process), "{process}");
        let pla = l.filaments.iter().find(|f| f.name.contains("PLA")).expect("PLA").name.clone();
        use crate::mesh::{Mat, Tri};
        let tmp = std::env::temp_dir().join("snapstudio-engine-speed");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let s = 30.0f32;
        #[rustfmt::skip]
        let p = [[0., 0., 0.], [s, 0., 0.], [s, s, 0.], [0., s, 0.], [0., 0., s], [s, 0., s], [s, s, s], [0., s, s]];
        #[rustfmt::skip]
        let f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
                 [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
        let tris: Vec<Tri> = f.iter().map(|t| Tri { v: [p[t[0]], p[t[1]], p[t[2]]], c: [120, 120, 120] }).collect();
        let src = tmp.join("cube.3mf");
        crate::write3mf::write_scene(
            &src,
            &[crate::write3mf::SceneObject { name: "cube".into(), tris, transform: Mat::IDENTITY, extruder: None }],
        )
        .unwrap();
        let slice = |id: &str, overrides: Map<String, Value>| {
            let seen: Arc<Mutex<Vec<Progress>>> = Default::default();
            let sink = seen.clone();
            run_job(
                binary(&app).unwrap(),
                index_for(&app).unwrap(),
                Request {
                    machine: machine.clone(),
                    process: process.clone(),
                    filaments: vec![pla.clone()],
                    scene: vec![crate::plate::SceneItem {
                        path: src.to_string_lossy().to_string(),
                        item: 0,
                        name: "cube".into(),
                        pos: [135.0, 135.0],
                        rot: [0.0; 3],
                        scale: [1.0; 3],
                        extruder_map: vec![0],
                        piece: None,
                    }],
                    overrides,
                    name: Some(id.into()),
                    ..Default::default()
                },
                id.into(),
                &move |p| sink.lock().unwrap().push(p),
            );
            let last = seen.lock().unwrap().last().cloned().unwrap();
            assert_eq!(last.phase, "preview", "slicing failed: {:?}", last.message);
            let gcode = std::fs::read_to_string(last.gcode.clone().unwrap()).unwrap();
            discard(id);
            (gcode, last.stats.unwrap())
        };
        let (base, base_stats) = slice("speed100", Map::new());
        for line in
            ["; outer_wall_speed = 200,500", "; sparse_infill_speed = 270,600", "; default_acceleration = 10000", "; travel_speed = 500"]
        {
            assert!(base.contains(line), "profile value missing: {line}");
        }
        // What the slice sheet computes at 75 % (scripts/test-speed.js).
        let at75: Map<String, Value> = serde_json::from_str(r#"{"outer_wall_speed":["150","375"],"inner_wall_speed":["225","450"],"sparse_infill_speed":["202","450"],"internal_solid_infill_speed":["187","450"],"gap_infill_speed":"187","top_surface_speed":"150","support_speed":"112","support_interface_speed":"60","bridge_speed":"37","default_acceleration":"5620","outer_wall_acceleration":"2810","inner_wall_acceleration":"5620","top_surface_acceleration":"1120"}"#).unwrap();
        let (slow, slow_stats) = slice("speed75", at75);
        for line in [
            "; outer_wall_speed = 150,375",
            "; inner_wall_speed = 225,450",
            "; sparse_infill_speed = 202,450",
            "; gap_infill_speed = 187",
            "; top_surface_speed = 150",
            "; bridge_speed = 37",
            "; default_acceleration = 5620",
            "; outer_wall_acceleration = 2810",
            "; inner_wall_acceleration = 5620",
            "; top_surface_acceleration = 1120",
            "; travel_speed = 500",
            "; initial_layer_speed = 50",
        ] {
            assert!(slow.contains(line), "missing in G-code: {line}");
        }
        let (t0, t1) = (base_stats.print_time_s.unwrap(), slow_stats.print_time_s.unwrap());
        println!("print time: 100 % {t0} s, 75 % {t1} s");
        assert!(t1 > t0, "slower: {t0} s → {t1} s");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn plate_scene_job_keeps_placements() {
        let Some(app) = engine() else { return };
        let Ok(l) = lists(None) else { return };
        use crate::mesh::{Mat, Tri};
        let tmp = std::env::temp_dir().join("snapstudio-scene-slice");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let cube = |s: f32| -> Vec<Tri> {
            #[rustfmt::skip]
            let p = [[0., 0., 0.], [s, 0., 0.], [s, s, 0.], [0., s, 0.], [0., 0., s], [s, 0., s], [s, s, s], [0., s, s]];
            #[rustfmt::skip]
            let f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
                     [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
            f.iter().map(|t| Tri { v: [p[t[0]], p[t[1]], p[t[2]]], c: [120, 120, 120] }).collect()
        };
        let src = tmp.join("cubes.3mf");
        crate::write3mf::write_scene(
            &src,
            &[
                crate::write3mf::SceneObject { name: "a".into(), tris: cube(15.0), transform: Mat::IDENTITY, extruder: None },
                crate::write3mf::SceneObject { name: "b".into(), tris: cube(15.0), transform: Mat::IDENTITY, extruder: None },
            ],
        )
        .unwrap();
        let item = |i: usize, x: f32, rz: f32| crate::plate::SceneItem {
            path: src.to_string_lossy().to_string(),
            item: i,
            name: format!("cube {i}"),
            pos: [x, 60.0],
            rot: [0.0, 0.0, rz],
            scale: [1.0, 1.0, 1.0],
            extruder_map: vec![0],
            piece: None,
        };
        let machine = l.selected.get("machine").cloned().unwrap_or_else(|| l.machines[0].name.clone());
        let fil = l.filaments.iter().find(|f| f.name.contains("PLA")).unwrap_or(&l.filaments[0]).name.clone();
        let seen: Arc<Mutex<Vec<Progress>>> = Default::default();
        let sink = seen.clone();
        run_job(
            binary(&app).unwrap(),
            index_for(&app).unwrap(),
            Request {
                machine,
                process: l.processes[0].name.clone(),
                filaments: vec![fil],
                scene: vec![item(0, 60.0, 0.0), item(1, 180.0, 30.0)],
                name: Some("scene".into()),
                ..Default::default()
            },
            "scene".into(),
            &move |p| sink.lock().unwrap().push(p),
        );
        let got = seen.lock().unwrap();
        let last = got.last().unwrap();
        assert_eq!(last.phase, "preview", "message : {:?}", last.message);
        let g = crate::gcode::parse(std::fs::File::open(last.gcode.clone().unwrap()).unwrap()).unwrap();
        println!("G-code extent: {:?} → {:?}", g.min, g.max);
        assert!(g.min[0] > 40.0 && g.max[0] < 200.0, "the cubes stay around X = 60 and X = 180");
        discard("scene");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn error_message_is_readable() {
        let raw = "Starting Sentry session and setting flags...\n\
                   [2026-09-19 10:26:01.463331] [0x00000001f60b6180] [error]   run 2334: process not compatible with printer.\n\
                   run found error, exit";
        assert_eq!(engine_error(raw), "run 2334: process not compatible with printer.");
        // A tower on a part: said in words, not "plate 1: found slicing result conflict!".
        let raw = "[2026-10-25 20:51:02.1] [0x1] [error]   plate 1: found slicing result conflict!\nrun found error, exit";
        assert_eq!(engine_error(raw), crate::t!("err.slice_conflict"));
    }

    #[test]
    fn output_name_uses_gcode_metadata() {
        let Ok(g) = std::env::var("NAME_GCODE") else { return };
        let n = output_name(Path::new("/tmp/Ma piece.3mf"), Path::new(&g));
        println!("output name: {n}");
        assert!(n.starts_with("Ma piece"));
        assert!(n.ends_with(".gcode"));
    }
}

#[cfg(test)]
mod cancel_and_previews {
    use super::*;

    #[test]
    fn a_preparing_job_can_be_cancelled() {
        jobs().lock().unwrap().insert("lotc-prep".into(), Job { pid: None });
        assert!(cancel("lotc-prep"), "known, still preparing: stopped at its next step");
        assert!(!jobs().lock().unwrap().contains_key("lotc-prep"));
        assert!(!cancel("lotc-prep"), "already gone");
    }

    fn fake_preview(base: &Path, i: usize) -> (PathBuf, Preview) {
        let work = base.join(format!("w{i}"));
        std::fs::create_dir_all(&work).unwrap();
        let gcode = work.join("a.gcode");
        std::fs::write(&gcode, "; test\nG1 X0\n").unwrap();
        let p = Preview {
            work: work.clone(),
            gcode,
            source: base.join("Piece.3mf"),
            out_dir: Some(base.to_path_buf()),
            seq: next_seq(),
            saved: None,
        };
        (work, p)
    }

    #[test]
    fn the_oldest_previews_go_past_the_cap() {
        let base = std::env::temp_dir().join("snapstudio_lotc_cap");
        let _ = std::fs::remove_dir_all(&base);
        let mut list = std::collections::HashMap::new();
        let works: Vec<PathBuf> = (0..5)
            .map(|i| {
                let (work, p) = fake_preview(&base, i);
                remember_in(&mut list, format!("p{i}"), p, 3);
                work
            })
            .collect();
        assert_eq!(list.len(), 3);
        assert!(!works[0].exists() && !works[1].exists(), "the two oldest folders are gone");
        assert!(works[2].exists() && works[4].exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_save_never_overwrites_another_file() {
        let base = std::env::temp_dir().join("snapstudio_lotc_save");
        let _ = std::fs::remove_dir_all(&base);
        let (_, p) = fake_preview(&base, 0);
        let name = output_name(&p.source, &p.gcode);
        // Someone else's G-code under the name the save would take.
        std::fs::write(base.join(&name), "; theirs").unwrap();
        previews().lock().unwrap().insert("lotc-save".into(), p);
        let first = save("lotc-save", None).unwrap();
        assert_ne!(first, base.join(&name), "numbered, not overwritten");
        assert_eq!(std::fs::read_to_string(base.join(&name)).unwrap(), "; theirs");
        // Saving the same preview again writes over its own copy only.
        let again = save("lotc-save", None).unwrap();
        assert_eq!(again, first);
        // Another folder: a fresh name there, the first copy untouched.
        let other = base.join("other");
        std::fs::create_dir_all(&other).unwrap();
        let elsewhere = save("lotc-save", Some(other.to_str().unwrap())).unwrap();
        assert_eq!(elsewhere, other.join(&name));
        assert!(first.is_file());
        previews().lock().unwrap().remove("lotc-save");
        let _ = std::fs::remove_dir_all(&base);
    }
}
