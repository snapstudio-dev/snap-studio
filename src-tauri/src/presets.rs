//! Snapmaker Orca presets: inventory, inheritance resolution, and writing
//! complete configurations for the slicing engine.
//!
//! The presets shipped with the app and the user's are only differentials:
//! each carries an `inherits` towards a parent. The command-line engine
//! refuses anything that is not complete — it also requires the `type` and
//! `from` fields, missing from user presets.
//!
//! Two traps found in use, fixed here:
//!
//! * `normalize_fdm` reads `wipe_tower_filament` (process preset) and
//!   `nozzle_diameter` (machine preset) **in the same object**; if the second
//!   is missing, the engine dereferences a null pointer and dies. So
//!   `nozzle_diameter` is copied into the process configuration.
//! * filaments compatible with the 0.4 nozzle have no suffix in their name:
//!   they must be filtered on `compatible_printers`, never on the name.

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Machine,
    Process,
    Filament,
}

impl Kind {
    fn dir(self) -> &'static str {
        match self {
            Kind::Machine => "machine",
            Kind::Process => "process",
            Kind::Filament => "filament",
        }
    }
    fn tag(self) -> &'static str {
        self.dir()
    }
}

struct Entry {
    kind: Kind,
    json: Value,
    user: bool,
}

pub struct Index {
    entries: HashMap<String, Entry>,
    /// Former names of system presets (`renamed_from`) → current name: user
    /// presets made with an older Orca still inherit the old one.
    renamed: HashMap<String, String>,
    /// Presets selected in Snapmaker Orca, if readable.
    pub selected: HashMap<String, String>,
}

/// Why a preset's inheritance does not resolve.
enum Unresolved {
    /// This preset, or an ancestor, is not in the index.
    Missing(String),
    /// A cycle, or a chain deeper than 16.
    Loop,
}

/// Preset bookkeeping keys, of no interest to the user.
const META: &[&str] = &["name", "type", "from", "inherits", "instantiation", "setting_id", "filament_id", "version", "is_custom_defined"];

/// Content of a preset for the details sheet.
#[derive(Serialize, Debug)]
pub struct Details {
    pub name: String,
    pub kind: Kind,
    pub user: bool,
    /// From the preset to its ancestors.
    pub chain: Vec<String>,
    /// Effective values: inheritance resolved, Snap Studio's additions included.
    pub values: Map<String, Value>,
    /// Settings changed by Snap Studio for this slice.
    pub snap: Vec<String>,
    /// Custom preset: settings that differ from the system preset.
    pub custom: Vec<String>,
}

/// Overrides the engine reads from the filament presets, not the process
/// one: a value there is ignored, each filament carrying its own (checked
/// on a real slice, `engine_advanced_overrides`). `idle_temperature`: a
/// head's nozzle temperature while another prints (ooze prevention).
pub const FILAMENT_OVERRIDES: &[&str] = &["idle_temperature"];

/// What Snap Studio adds to the process preset: the plate (the machine's by
/// default), then the user's overrides (but the filaments' own keys).
pub fn process_extra(index: &Index, machine: &str, overrides: &Map<String, Value>) -> Map<String, Value> {
    let (_, bed) = index.bed_types(machine);
    let mut out = Map::new();
    out.insert("curr_bed_type".into(), Value::String(bed));
    for (k, v) in overrides {
        if !FILAMENT_OVERRIDES.contains(&k.as_str()) {
            out.insert(k.clone(), v.clone());
        }
    }
    out
}

/// The user's overrides that go to every filament preset, as the engine
/// reads them there (one value per filament: an array).
pub fn filament_overrides(overrides: &Map<String, Value>) -> Map<String, Value> {
    overrides
        .iter()
        .filter(|(k, _)| FILAMENT_OVERRIDES.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), if v.is_array() { v.clone() } else { Value::Array(vec![v.clone()]) }))
        .collect()
}

/// What Snap Studio adds to a filament preset: the spool's real color.
/// Color of a filament whose spool color is unknown.
const NEUTRAL_COLOR: &str = "#C0C0C0";

pub fn filament_extra(color: Option<&str>) -> Map<String, Value> {
    let mut out = Map::new();
    if let Some(c) = color.filter(|c| is_hex_color(c)) {
        out.insert("filament_colour".into(), Value::Array(vec![Value::String(c.to_uppercase())]));
    }
    out
}

/// Plate type: value expected by the engine, label shown.
#[derive(Serialize, Clone, Debug)]
pub struct BedType {
    pub value: String,
    pub label: String,
}

#[derive(Serialize, Clone)]
pub struct PresetDto {
    pub name: String,
    pub kind: Kind,
    /// True for a preset created by the user.
    pub user: bool,
    /// Filaments only: material (`PLA`, `PETG`…) and vendor, to find the preset
    /// matching a loaded spool.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ftype: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vendor: Option<String>,
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(p).ok()?).ok()
}

/// Snapmaker Orca's data folder.
pub fn datadir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("Snapmaker_Orca")
}

/// Snap Studio's own profiles (`<config>/fr.carlini.snapstudio/profiles/<kind>`):
/// what the app saves never goes into Snapmaker Orca's folder.
pub fn app_profiles_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("fr.carlini.snapstudio").join("profiles")
}

/// Folder of the profiles shipped with the app.
fn system_profiles(app: &Path) -> Option<PathBuf> {
    crate::slicers::resources(app).map(|r| r.join("profiles/Snapmaker"))
}

/// Which presets an index reads besides `app`'s system profiles.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Scope {
    /// The user's presets and Orca's selection too.
    WithUser,
    /// System profiles only: what tests see does not depend on the machine.
    SystemOnly,
}

impl Index {
    /// Inventories `app`'s system profiles and the user's presets (system
    /// profiles only under test).
    pub fn build(app: &Path) -> Result<Index> {
        Self::build_scoped(app, if cfg!(test) { Scope::SystemOnly } else { Scope::WithUser })
    }

    fn build_scoped(app: &Path, scope: Scope) -> Result<Index> {
        let Some(sys) = system_profiles(app).filter(|p| p.is_dir()) else {
            return Err(anyhow!(crate::t!("err.not_orca", path = app.display())));
        };
        let mut entries = HashMap::new();
        let mut renamed = HashMap::new();
        let mut add = |dir: PathBuf, kind: Kind, user: bool, entries: &mut HashMap<String, Entry>| {
            let Ok(rd) = std::fs::read_dir(&dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) != Some("json") {
                    continue;
                }
                let Some(json) = read_json(&p) else { continue };
                let name = json
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .unwrap_or_else(|| p.file_stem().unwrap_or_default().to_string_lossy().to_string());
                if !user {
                    // Several former names, separated by `;`.
                    let old = json.get("renamed_from").and_then(|v| v.as_str()).unwrap_or_default();
                    for alias in old.split(';').map(str::trim).filter(|a| !a.is_empty()) {
                        renamed.entry(alias.to_string()).or_insert_with(|| name.clone());
                    }
                }
                // A user preset hides the system one of the same name.
                if user || !entries.contains_key(&name) {
                    entries.insert(name, Entry { kind, json, user });
                }
            }
        };
        for kind in [Kind::Machine, Kind::Process, Kind::Filament] {
            add(sys.join(kind.dir()), kind, false, &mut entries);
        }
        if scope == Scope::SystemOnly {
            return Ok(Index { entries, renamed, selected: HashMap::new() });
        }
        let ud = datadir().join("user/default");
        for kind in [Kind::Machine, Kind::Process, Kind::Filament] {
            add(ud.join(kind.dir()), kind, true, &mut entries);
        }
        // Snap Studio's own presets, read last: they win over Orca's.
        let own = app_profiles_dir();
        for kind in [Kind::Machine, Kind::Process, Kind::Filament] {
            add(own.join(kind.dir()), kind, true, &mut entries);
        }

        Ok(Index { entries, renamed, selected: read_selected() })
    }

    /// A preset's current name: `name` itself, or the system preset that
    /// was renamed from it.
    fn canonical<'a>(&'a self, name: &'a str) -> &'a str {
        if self.entries.contains_key(name) {
            return name;
        }
        self.renamed.get(name).map_or(name, String::as_str)
    }

    fn entry(&self, name: &str) -> Option<&Entry> {
        self.entries.get(self.canonical(name))
    }

    /// Complete configuration of a preset, inheritance resolved.
    pub fn flatten(&self, name: &str) -> Option<Map<String, Value>> {
        self.flatten_inner(name, &mut HashSet::new(), 0).ok()
    }

    /// As [`Index::flatten`], with an error naming what breaks the chain.
    pub fn resolve(&self, name: &str) -> Result<Map<String, Value>> {
        self.flatten_inner(name, &mut HashSet::new(), 0).map_err(|e| match e {
            Unresolved::Missing(parent) if parent != name => {
                anyhow!(crate::t!("err.inheritance_missing", name = name, parent = parent))
            }
            Unresolved::Missing(_) => anyhow!(crate::t!("err.unknown_preset", name = name)),
            Unresolved::Loop => anyhow!(crate::t!("err.inheritance", name = name)),
        })
    }

    fn flatten_inner(&self, name: &str, seen: &mut HashSet<String>, depth: u32) -> Result<Map<String, Value>, Unresolved> {
        let name = self.canonical(name);
        if depth > 16 || !seen.insert(name.to_string()) {
            return Err(Unresolved::Loop);
        }
        let obj = self.entries.get(name).and_then(|e| e.json.as_object()).ok_or_else(|| Unresolved::Missing(name.to_string()))?;
        let mut out = match obj.get("inherits").and_then(|v| v.as_str()) {
            // A parent that is missing (a user preset from another Orca
            // version), in a cycle or too deep: no configuration at all,
            // rather than a partial one the engine fails on.
            Some(parent) if !parent.is_empty() => self.flatten_inner(parent, seen, depth + 1)?,
            _ => Map::new(),
        };
        for (k, v) in obj {
            if k == "inherits" || k == "from" {
                continue;
            }
            out.insert(k.clone(), v.clone());
        }
        Ok(out)
    }

    pub fn kind_of(&self, name: &str) -> Option<Kind> {
        self.entry(name).map(|e| e.kind)
    }

    /// Inheritance chain, from the preset to its ancestors.
    pub fn chain(&self, name: &str) -> Vec<String> {
        let mut out = vec![];
        let mut cur = Some(self.canonical(name).to_string());
        while let Some(n) = cur.take() {
            if out.contains(&n) || out.len() > 16 {
                break;
            }
            cur = self
                .entries
                .get(&n)
                .and_then(|e| e.json.get("inherits"))
                .and_then(|v| v.as_str())
                .filter(|p| !p.is_empty())
                .map(|p| self.canonical(p).to_string());
            out.push(n);
        }
        out
    }

    /// Content of a preset as it goes to the engine: inheritance resolved, then
    /// `extra`, what Snap Studio adds for this slice.
    pub fn details(&self, name: &str, extra: &Map<String, Value>) -> Option<Details> {
        let e = self.entry(name)?;
        let mut values = self.flatten(name)?;
        let mut snap = vec![];
        for (k, v) in extra {
            if values.get(k) != Some(v) {
                snap.push(k.clone());
            }
            values.insert(k.clone(), v.clone());
        }
        let chain = self.chain(name);
        // Custom preset: what differs from its first system ancestor.
        let custom = chain
            .iter()
            .skip(1)
            .find(|n| self.entries.get(*n).is_some_and(|x| !x.user))
            .filter(|_| e.user)
            .and_then(|base| self.flatten(base))
            .map(|base| {
                let own = self.flatten(name).unwrap_or_default();
                own.iter().filter(|(k, v)| base.get(*k) != Some(*v) && !META.contains(&k.as_str())).map(|(k, _)| k.clone()).collect()
            })
            .unwrap_or_default();
        for k in META {
            values.remove(*k);
        }
        Some(Details { name: name.to_string(), kind: e.kind, user: e.user, chain, values, snap, custom })
    }

    /// Presets of a given type that can be offered to the user.
    fn selectable(&self, kind: Kind) -> Vec<(&String, &Entry)> {
        self.entries
            .iter()
            .filter(|(_, e)| e.kind == kind)
            .filter(|(_, e)| e.user || e.json.get("instantiation").and_then(|v| v.as_str()) == Some("true"))
            .collect()
    }

    pub fn machines(&self) -> Vec<PresetDto> {
        let mut v: Vec<PresetDto> = self
            .selectable(Kind::Machine)
            .into_iter()
            .map(|(n, e)| PresetDto { name: n.clone(), kind: Kind::Machine, user: e.user, ftype: None, vendor: None })
            .collect();
        sort_presets(&mut v);
        v
    }

    /// The chosen machine and its ancestors.
    ///
    /// A custom machine preset inherits the system profile, and the
    /// `compatible_printers` lists cite the parent's name: without walking up, a
    /// custom profile would have no compatible process nor filament.
    fn machine_aliases(&self, machine: &str) -> Vec<String> {
        let mut out = vec![machine.to_string()];
        let mut cur = machine.to_string();
        for _ in 0..16 {
            let Some(parent) = self.entry(&cur).and_then(|e| e.json.get("inherits")).and_then(|v| v.as_str()).filter(|p| !p.is_empty())
            else {
                break;
            };
            // Both names: lists written before the renaming cite the old one.
            out.push(parent.to_string());
            let current = self.canonical(parent);
            if current != parent {
                out.push(current.to_string());
            }
            cur = current.to_string();
        }
        out
    }

    /// Presets compatible with a given machine.
    fn compatible(&self, kind: Kind, machine: &str) -> Vec<PresetDto> {
        let names = self.machine_aliases(machine);
        let mut v: Vec<PresetDto> = self
            .selectable(kind)
            .into_iter()
            .filter_map(|(n, e)| {
                // Compatibility can be declared on the preset itself or inherited from
                // its parent; the resolved inheritance also gives a filament's material
                // and vendor.
                let flat = self.flatten(n).unwrap_or_default();
                let ok = match flat.get("compatible_printers").and_then(|v| v.as_array()) {
                    Some(list) if !list.is_empty() => {
                        list.iter().any(|x| x.as_str().map(|s| names.iter().any(|n| n == s)).unwrap_or(false))
                    }
                    // Without an explicit list, the preset applies to everyone.
                    _ => true,
                };
                if !ok {
                    return None;
                }
                let (ftype, vendor) = if kind == Kind::Filament {
                    (first_str(&flat, "filament_type"), first_str(&flat, "filament_vendor"))
                } else {
                    (None, None)
                };
                Some(PresetDto { name: n.clone(), kind, user: e.user, ftype, vendor })
            })
            .collect();
        sort_presets(&mut v);
        v
    }

    pub fn processes_for(&self, machine: &str) -> Vec<PresetDto> {
        self.compatible(Kind::Process, machine)
    }

    pub fn filaments_for(&self, machine: &str) -> Vec<PresetDto> {
        self.compatible(Kind::Filament, machine)
    }

    /// Usable bed dimensions, in millimeters.
    pub fn plate_size(&self, machine: &str) -> (f32, f32) {
        let corners = self.flatten(machine).and_then(|m| m.get("printable_area").and_then(|v| v.as_array()).cloned()).unwrap_or_default();
        let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for c in corners {
            // "270.5x271" format.
            let Some((a, b)) = c.as_str().and_then(|s| s.split_once('x')) else {
                continue;
            };
            let (Ok(x), Ok(y)) = (a.trim().parse::<f32>(), b.trim().parse::<f32>()) else {
                continue;
            };
            x0 = x0.min(x);
            x1 = x1.max(x);
            y0 = y0.min(y);
            y1 = y1.max(y);
        }
        if x1 > x0 && y1 > y0 {
            (x1 - x0, y1 - y0)
        } else {
            // Unknown shape: the U1's bed, as `slice::bed` assumes too.
            (270.0, 270.0)
        }
    }

    /// Printer model of a machine preset ("Snapmaker U1"…).
    pub fn printer_model(&self, machine: &str) -> Option<String> {
        self.flatten(machine)?.get("printer_model")?.as_str().filter(|s| !s.is_empty()).map(String::from)
    }

    /// Plates offered for a machine, and the default one.
    ///
    /// The bed temperature depends on the chosen plate: each filament profile
    /// carries one per type (`textured_plate_temp`, `cool_plate_temp`…). Without
    /// `curr_bed_type`, the engine takes the Cool Plate — 35 °C for the U1's PLA,
    /// instead of 65 °C.
    pub fn bed_types(&self, machine: &str) -> (Vec<BedType>, String) {
        let cfg = self.flatten(machine).unwrap_or_default();
        let u1 = cfg.get("printer_model").and_then(|v| v.as_str()).is_some_and(|m| m.contains("U1"));
        // Same lists as Orca's interface (`PrintConfig.cpp`).
        let list: &[(&str, &str)] = if u1 {
            &[("Textured PEI Plate", "bed.textured_pei"), ("High Temp Plate", "bed.smooth_pei"), ("Graphic Effect Plate", "bed.graphic")]
        } else {
            &[
                ("Textured PEI Plate", "bed.textured_pei"),
                ("High Temp Plate", "bed.high_temp"),
                ("Cool Plate", "bed.cool"),
                ("Textured Cool Plate", "bed.textured_cool"),
                ("Engineering Plate", "bed.engineering"),
                ("Supertack Plate", "bed.supertack"),
            ]
        };
        // The second element is the label's translation key.
        let types: Vec<BedType> = list.iter().map(|(value, key)| BedType { value: value.to_string(), label: crate::t!(key) }).collect();
        let default = cfg
            .get("default_bed_type")
            .and_then(|v| v.as_str())
            .filter(|d| types.iter().any(|t| t.value == *d))
            .unwrap_or(list[0].0)
            .to_string();
        (types, default)
    }

    /// Number of heads a machine declares.
    pub fn extruder_count(&self, machine: &str) -> usize {
        self.flatten(machine).and_then(|m| m.get("nozzle_diameter").and_then(|v| v.as_array()).map(|a| a.len())).unwrap_or(1).max(1)
    }
}

/// User presets first, then natural alphabetical order.
/// First value of a setting, whether written as a list or as text.
fn first_str(cfg: &Map<String, Value>, key: &str) -> Option<String> {
    let v = cfg.get(key)?;
    let s = match v {
        Value::Array(a) => a.first()?.as_str()?.to_string(),
        Value::String(s) => s.clone(),
        _ => return None,
    };
    let s = s.trim().to_string();
    (!s.is_empty()).then_some(s)
}

fn sort_presets(v: &mut [PresetDto]) {
    v.sort_by(|a, b| b.user.cmp(&a.user).then_with(|| a.name.cmp(&b.name)));
}

/// Presets currently selected in Snapmaker Orca.
fn read_selected() -> HashMap<String, String> {
    let mut out = HashMap::new();
    let p = datadir().join("Snapmaker_Orca.conf");
    let Some(v) = read_json(&p) else { return out };
    if let Some(presets) = v.get("presets").and_then(|p| p.as_object()) {
        for (k, val) in presets {
            if let Some(s) = val.as_str() {
                out.insert(k.clone(), s.to_string());
            }
        }
    }
    out
}

/// Configuration files ready for the slicing engine.
pub struct Prepared {
    pub machine: PathBuf,
    pub process: PathBuf,
    pub filaments: Vec<PathBuf>,
}

/// Declares the machine in `compatible_printers`.
///
/// The engine checks compatibility on the machine preset's **name**. A custom
/// preset is called "… LCA" while processes list the parent's name: without
/// this addition it answers "process not compatible with printer" and stops.
fn declare_compatible(cfg: &mut Map<String, Value>, machine: &str) {
    let Some(list) = cfg.get_mut("compatible_printers").and_then(|v| v.as_array_mut()) else {
        return; // without a list, the preset already applies to every machine
    };
    if !list.iter().any(|x| x.as_str() == Some(machine)) {
        list.push(Value::String(machine.to_string()));
    }
}

/// `#rrggbb`: the only form accepted for a filament color.
fn is_hex_color(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit())
}

fn write_config(dir: &Path, kind: Kind, name: &str, mut cfg: Map<String, Value>, suffix: &str) -> Result<PathBuf> {
    cfg.insert("type".into(), Value::String(kind.tag().into()));
    cfg.insert("name".into(), Value::String(name.into()));
    // The engine only accepts "system" or "User"; our files are complete
    // configurations, not user differentials.
    cfg.insert("from".into(), Value::String("system".into()));
    cfg.insert("instantiation".into(), Value::String("true".into()));
    let path = dir.join(format!("{}{}.json", kind.dir(), suffix));
    std::fs::write(&path, serde_json::to_vec_pretty(&Value::Object(cfg))?).with_context(|| format!("writing {}", path.display()))?;
    Ok(path)
}

/// Saves a user process preset: a differential over `base`, as Orca stores its
/// own (`inherits` + the changed keys), in Snap Studio's own
/// `profiles/process` folder (never in Snapmaker Orca's).
/// Refuses an empty or unsafe name, and the name of a system preset.
pub fn save_user_process(index: &Index, name: &str, base: &str, values: &Map<String, Value>) -> Result<PathBuf> {
    save_user_process_in(index, &app_profiles_dir().join(Kind::Process.dir()), name, base, values)
}

fn save_user_process_in(index: &Index, dir: &Path, name: &str, base: &str, values: &Map<String, Value>) -> Result<PathBuf> {
    let name = name.trim();
    if name.is_empty() || name.len() > 120 || name.contains(['/', '\\', ':']) || name.starts_with('.') {
        return Err(anyhow!(crate::t!("err.bad_preset_name")));
    }
    if index.entries.get(name).is_some_and(|e| !e.user) {
        return Err(anyhow!(crate::t!("err.preset_exists", name = name)));
    }
    if index.kind_of(base) != Some(Kind::Process) {
        return Err(anyhow!(crate::t!("err.unknown_process", name = base)));
    }
    // A user base is flattened into the new preset, which then inherits the
    // base's own system parent: Orca only follows one level for user presets.
    let (parent, mut cfg) = match index.entries.get(base) {
        Some(e) if e.user => {
            let mut own = e.json.as_object().cloned().unwrap_or_default();
            let parent = own.get("inherits").and_then(|v| v.as_str()).unwrap_or("").to_string();
            for k in ["name", "inherits", "from", "type", "instantiation"] {
                own.remove(k);
            }
            (parent, own)
        }
        _ => (base.to_string(), Map::new()),
    };
    for (k, v) in values {
        let v = match v {
            Value::String(_) => v.clone(),
            Value::Bool(b) => Value::String(if *b { "1".into() } else { "0".into() }),
            Value::Number(n) => Value::String(n.to_string()),
            other => other.clone(),
        };
        cfg.insert(k.clone(), v);
    }
    cfg.insert("name".into(), Value::String(name.into()));
    cfg.insert("inherits".into(), Value::String(parent));
    cfg.insert("from".into(), Value::String("User".into()));
    cfg.insert("type".into(), Value::String("process".into()));
    cfg.insert("is_custom_defined".into(), Value::String("0".into()));
    cfg.insert("print_settings_id".into(), Value::String(name.into()));
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let path = dir.join(format!("{name}.json"));
    std::fs::write(&path, serde_json::to_vec_pretty(&Value::Object(cfg))?).with_context(|| format!("writing {}", path.display()))?;
    Ok(path)
}

/// Writes the complete configurations into `dir`.
///
/// `filaments` holds one preset per head; when some are missing, the first is
/// repeated, as Orca's interface does. `colors` carries each spool's real
/// color: it replaces the preset's, and ends up in the G-code and preview.
pub fn prepare(
    index: &Index,
    dir: &Path,
    machine: &str,
    process: &str,
    filaments: &[String],
    colors: &[Option<String>],
    overrides: &Map<String, Value>,
) -> Result<Prepared> {
    std::fs::create_dir_all(dir)?;
    if index.kind_of(machine) != Some(Kind::Machine) {
        return Err(anyhow!(crate::t!("err.unknown_machine", name = machine)));
    }
    if index.kind_of(process) != Some(Kind::Process) {
        return Err(anyhow!(crate::t!("err.unknown_process", name = process)));
    }
    let machine_cfg = index.resolve(machine)?;
    let mut process_cfg = index.resolve(process)?;

    // Without this copy, `normalize_fdm` looks for `nozzle_diameter` next to
    // `wipe_tower_filament` and hits a null pointer.
    if let Some(nd) = machine_cfg.get("nozzle_diameter") {
        process_cfg.insert("nozzle_diameter".into(), nd.clone());
    }
    // The machine's default plate; the user's choice, passed in `overrides`,
    // wins.
    for (k, v) in process_extra(index, machine, overrides) {
        process_cfg.insert(k, v);
    }
    declare_compatible(&mut process_cfg, machine);

    let machine_path = write_config(dir, Kind::Machine, machine, machine_cfg, "")?;
    let process_path = write_config(dir, Kind::Process, process, process_cfg, "")?;

    let count = index.extruder_count(machine);
    let mut paths = Vec::new();
    for i in 0..count {
        let name = filaments.get(i).or_else(|| filaments.first()).ok_or_else(|| anyhow!(crate::t!("err.no_filament")))?;
        if index.kind_of(name) != Some(Kind::Filament) {
            return Err(anyhow!(crate::t!("err.unknown_filament", name = name)));
        }
        let mut cfg = index.resolve(name)?;
        declare_compatible(&mut cfg, machine);
        for (k, v) in filament_extra(colors.get(i).and_then(|c| c.as_deref())) {
            cfg.insert(k, v);
        }
        for (k, v) in filament_overrides(overrides) {
            cfg.insert(k, v);
        }
        // Every filament declares a color: the engine counts the filaments by
        // `filament_colour` when it splits a painted model, and drops the
        // painting of those beyond — a head without a known spool color lost
        // its painted areas.
        if !cfg.get("filament_colour").and_then(Value::as_array).is_some_and(|a| !a.is_empty()) {
            cfg.insert("filament_colour".into(), Value::Array(vec![Value::String(NEUTRAL_COLOR.into())]));
        }
        paths.push(write_config(dir, Kind::Filament, name, cfg, &format!("_{i}"))?);
    }

    Ok(Prepared { machine: machine_path, process: process_path, filaments: paths })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app() -> PathBuf {
        PathBuf::from("/Applications/Snapmaker Orca.app")
    }

    fn index() -> Option<Index> {
        if !app().is_dir() {
            return None;
        }
        Index::build(&app()).ok()
    }

    #[test]
    fn save_user_process_writes_a_differential() {
        let mut entries = HashMap::new();
        entries.insert(
            "0.20mm Standard".to_string(),
            Entry { kind: Kind::Process, json: serde_json::json!({"name": "0.20mm Standard", "layer_height": "0.2"}), user: false },
        );
        let idx = Index { entries, renamed: HashMap::new(), selected: Default::default() };
        let dir = std::env::temp_dir().join("snapstudio-save-process");
        let _ = std::fs::remove_dir_all(&dir);
        let mut v = Map::new();
        v.insert("seam_position".into(), Value::String("back".into()));
        v.insert("enable_prime_tower".into(), Value::Bool(true));
        let p = save_user_process_in(&idx, &dir, "Mine", "0.20mm Standard", &v).unwrap();
        let j: Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
        assert_eq!(j["inherits"], "0.20mm Standard");
        assert_eq!(j["from"], "User");
        assert_eq!(j["seam_position"], "back");
        assert_eq!(j["enable_prime_tower"], "1");
        assert!(save_user_process_in(&idx, &dir, "0.20mm Standard", "0.20mm Standard", &v).is_err(), "system name refused");
        assert!(save_user_process_in(&idx, &dir, "a/b", "0.20mm Standard", &v).is_err(), "unsafe name refused");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn user_machine_inherits_compatibility() {
        let Some(idx) = index() else { return };
        let Some(user_machine) = idx.machines().into_iter().find(|m| m.user) else {
            return;
        };
        let procs = idx.processes_for(&user_machine.name);
        let fils = idx.filaments_for(&user_machine.name);
        println!("custom preset “{}”: {} processes, {} filaments", user_machine.name, procs.len(), fils.len());
        assert!(!procs.is_empty(), "the parent's processes stay compatible");
        assert!(!fils.is_empty(), "the parent's filaments stay compatible");
    }

    #[test]
    fn indexes_and_resolves() {
        let Some(idx) = index() else { return };
        let machines = idx.machines();
        println!("{} machines offered", machines.len());
        let u1 = machines.iter().find(|m| m.name == "Snapmaker U1 (0.4 nozzle)").expect("the U1 0.4 is offered");
        println!("current selection: {:?}", idx.selected.get("machine"));

        let flat = idx.flatten(&u1.name).unwrap();
        assert!(flat.len() > 50, "complete configuration ({} keys)", flat.len());
        assert!(flat.contains_key("nozzle_diameter"));
        assert!(flat.contains_key("machine_start_gcode"), "inherited from the parent");
        assert!(!flat.contains_key("inherits"), "inheritance is resolved");
        assert_eq!(idx.extruder_count(&u1.name), 4, "the U1 has four heads");

        let procs = idx.processes_for(&u1.name);
        let fils = idx.filaments_for(&u1.name);
        println!("{} processes, {} filaments compatible", procs.len(), fils.len());
        assert!(!procs.is_empty() && !fils.is_empty());
        // The naming trap: 0.4 nozzle filaments have no suffix.
        assert!(fils.iter().any(|f| f.name.contains("PLA")), "at least one compatible PLA");
        assert!(!fils.iter().any(|f| f.name.contains("0.2 nozzle")), "no filament for another nozzle");
    }

    /// Profiles of OrcaSlicer's reference clone, if it is there (not versioned).
    fn repo_index() -> Option<Index> {
        let readme = Path::new(env!("CARGO_MANIFEST_DIR")).join("../OrcaSlicer/README.md");
        readme.is_file().then(|| Index::build(&readme).ok()).flatten()
    }

    /// The details shown are exactly what the engine receives.
    /// A filament's own key goes to the filaments, as an array, never to
    /// the process; the rest stays the process's.
    #[test]
    fn filament_keys_go_to_the_filaments() {
        let mut over = Map::new();
        over.insert("idle_temperature".into(), "150".into());
        over.insert("ooze_prevention".into(), "1".into());
        let f = filament_overrides(&over);
        assert_eq!(f.len(), 1);
        assert_eq!(f["idle_temperature"], serde_json::json!(["150"]));
        let mut arr = Map::new();
        arr.insert("idle_temperature".into(), serde_json::json!(["120", "130"]));
        assert_eq!(filament_overrides(&arr)["idle_temperature"], serde_json::json!(["120", "130"]), "an array stays as is");
        let Some(idx) = repo_index().or_else(index) else { return };
        let p = process_extra(&idx, "Snapmaker U1 (0.4 nozzle)", &over);
        assert!(!p.contains_key("idle_temperature") && p["ooze_prevention"] == "1");
    }

    #[test]
    fn details_match_what_the_engine_gets() {
        let Some(idx) = repo_index().or_else(index) else { return };
        let machine = "Snapmaker U1 (0.4 nozzle)";
        let process = idx.processes_for(machine)[0].name.clone();
        let filament = idx.filaments_for(machine).into_iter().find(|f| f.name.contains("PLA")).unwrap().name;
        let mut over = Map::new();
        over.insert("curr_bed_type".into(), "High Temp Plate".into());
        over.insert("wall_loops".into(), "5".into());

        let d = idx.details(&process, &process_extra(&idx, machine, &over)).unwrap();
        assert_eq!(d.kind, Kind::Process);
        assert!(d.chain.len() > 1, "inheritance: {:?}", d.chain);
        assert!(d.snap.contains(&"curr_bed_type".to_string()));
        assert!(!d.values.contains_key("inherits"), "bookkeeping keys removed");

        let dir = std::env::temp_dir().join("snapstudio_details_test");
        let p = prepare(&idx, &dir, machine, &process, &[filament.clone()], &[Some("#ff8800".into())], &over).unwrap();
        let written: Value = serde_json::from_slice(&std::fs::read(&p.process).unwrap()).unwrap();
        for k in ["curr_bed_type", "wall_loops", "layer_height", "sparse_infill_density"] {
            assert_eq!(written.get(k), d.values.get(k), "{k}");
        }
        let f = idx.details(&filament, &filament_extra(Some("#ff8800"))).unwrap();
        let fw: Value = serde_json::from_slice(&std::fs::read(&p.filaments[0]).unwrap()).unwrap();
        assert_eq!(fw["filament_colour"], f.values["filament_colour"]);
        assert_eq!(fw["hot_plate_temp"], f.values["hot_plate_temp"]);
        println!("{}: {:?} · plate {} → {}", process, d.chain, d.values["curr_bed_type"], f.values["hot_plate_temp"]);
    }

    #[test]
    fn prepares_complete_configs() {
        let Some(idx) = index() else { return };
        let machine = "Snapmaker U1 (0.4 nozzle)";
        let process = idx.processes_for(machine)[0].name.clone();
        let filament = idx.filaments_for(machine)[0].name.clone();
        let dir = std::env::temp_dir().join("snapstudio_presets_test");
        let _ = std::fs::remove_dir_all(&dir);

        let p = prepare(&idx, &dir, machine, &process, &[filament.clone()], &[], &Map::new()).unwrap();
        assert_eq!(p.filaments.len(), 4, "one filament per head");

        let m: Value = serde_json::from_slice(&std::fs::read(&p.machine).unwrap()).unwrap();
        assert_eq!(m["type"], "machine");
        assert_eq!(m["from"], "system");
        let pr: Value = serde_json::from_slice(&std::fs::read(&p.process).unwrap()).unwrap();
        assert_eq!(pr["type"], "process");
        assert!(pr.get("nozzle_diameter").is_some(), "nozzle_diameter copied: it is what avoids the crash");
        assert_eq!(pr["curr_bed_type"], "Textured PEI Plate", "the U1's default plate");
        println!("process “{process}”, filament “{filament}” → {}", dir.display());
    }

    /// The slicing engine must accept what we write: run it for real on a model
    /// and expect a G-code.
    #[test]
    fn engine_accepts_prepared_configs() {
        let (Some(idx), Ok(model)) = (index(), std::env::var("SLICE_MODEL")) else {
            return;
        };
        // Start from the presets actually selected in Orca.
        let machine = idx
            .selected
            .get("machine")
            .cloned()
            .filter(|m| idx.kind_of(m) == Some(Kind::Machine))
            .unwrap_or_else(|| "Snapmaker U1 (0.4 nozzle)".into());
        let process = idx
            .selected
            .get("print")
            .cloned()
            .filter(|p| idx.kind_of(p) == Some(Kind::Process))
            .unwrap_or_else(|| idx.processes_for(&machine)[0].name.clone());
        let filament = idx
            .filaments_for(&machine)
            .iter()
            .find(|f| f.name.contains("PLA"))
            .map(|f| f.name.clone())
            .unwrap_or_else(|| idx.filaments_for(&machine)[0].name.clone());

        let dir = std::env::temp_dir().join("snapstudio_slice_it");
        let _ = std::fs::remove_dir_all(&dir);
        let p = prepare(&idx, &dir, &machine, &process, &[filament.clone()], &[], &Map::new()).unwrap();

        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let settings = format!("{};{}", p.machine.display(), p.process.display());
        let fils = p.filaments.iter().map(|f| f.display().to_string()).collect::<Vec<_>>().join(";");
        let t = std::time::Instant::now();
        let out_cmd = std::process::Command::new(crate::slicers::executable(&app()).unwrap())
            .args(["--arrange", "0", "--allow-newer-file", "--slice", "0"])
            .arg("--load-settings")
            .arg(&settings)
            .arg("--load-filaments")
            .arg(&fils)
            .arg("--outputdir")
            .arg(&out)
            .arg(&model)
            .output()
            .expect("engine can be started");
        let status = out_cmd.status;
        let mut msg = String::from_utf8_lossy(&out_cmd.stdout).to_string();
        msg.push_str(&String::from_utf8_lossy(&out_cmd.stderr));
        let tail: Vec<&str> = msg.lines().filter(|l| !l.contains("sentry") && !l.contains("StaticPrintConfigs")).rev().take(4).collect();
        println!("engine: {:?}", tail);

        let produced: Vec<_> = std::fs::read_dir(&out)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("gcode"))
            .collect();
        println!(
            "machine “{machine}”\nprocess “{process}”\nfilament “{filament}”\n→ code {:?} in {} ms, {} file(s): {:?}",
            status.code(),
            t.elapsed().as_millis(),
            produced.len(),
            produced.iter().map(|p| p.file_name().unwrap().to_string_lossy().to_string()).collect::<Vec<_>>()
        );
        assert!(status.success(), "the engine refused the configuration");
        assert!(!produced.is_empty(), "no G-code produced");
        let size = std::fs::metadata(&produced[0]).unwrap().len();
        assert!(size > 1000, "G-code too short ({size} bytes)");
    }

    /// Every preset of this machine's user resolves against the installed
    /// Orca (`cargo test --lib presets -- --ignored`): a user preset whose
    /// parent Orca renamed or removed shows here, not at slicing time.
    #[test]
    #[ignore = "reads the user's own Orca presets"]
    fn the_users_presets_all_resolve() {
        let Ok(idx) = Index::build_scoped(&app(), Scope::WithUser) else { return };
        let broken: Vec<String> =
            idx.entries.iter().filter(|(_, e)| e.user).filter_map(|(n, _)| idx.resolve(n).err().map(|e| format!("{e:#}"))).collect();
        assert!(broken.is_empty(), "{broken:#?}");
    }

    #[test]
    fn applies_overrides() {
        let Some(idx) = index() else { return };
        let machine = "Snapmaker U1 (0.4 nozzle)";
        let process = idx.processes_for(machine)[0].name.clone();
        let filament = idx.filaments_for(machine)[0].name.clone();
        let dir = std::env::temp_dir().join("snapstudio_presets_ovr");
        let mut ovr = Map::new();
        ovr.insert("layer_height".into(), Value::String("0.28".into()));
        let p = prepare(&idx, &dir, machine, &process, &[filament], &[], &ovr).unwrap();
        let pr: Value = serde_json::from_slice(&std::fs::read(&p.process).unwrap()).unwrap();
        assert_eq!(pr["layer_height"], "0.28");
    }
}

#[cfg(test)]
mod inheritance_tests {
    use super::{Entry, Index, Kind};
    use std::collections::HashMap;

    #[test]
    fn a_missing_parent_resolves_to_nothing() {
        let mut entries = HashMap::new();
        entries.insert(
            "Child".to_string(),
            Entry {
                kind: Kind::Process,
                json: serde_json::json!({"name": "Child", "inherits": "Gone", "layer_height": "0.2"}),
                user: true,
            },
        );
        entries.insert(
            "Whole".to_string(),
            Entry {
                kind: Kind::Process,
                json: serde_json::json!({"name": "Whole", "inherits": "Base", "layer_height": "0.2"}),
                user: true,
            },
        );
        entries.insert(
            "Base".to_string(),
            Entry { kind: Kind::Process, json: serde_json::json!({"name": "Base", "wall_loops": "2"}), user: false },
        );
        let idx = Index { entries, renamed: HashMap::new(), selected: Default::default() };
        assert!(idx.flatten("Child").is_none(), "no partial configuration for a parent that is not there");
        let whole = idx.flatten("Whole").unwrap();
        assert_eq!(whole["wall_loops"], "2");
        assert_eq!(whole["layer_height"], "0.2");
    }

    #[test]
    fn a_renamed_parent_resolves_to_its_new_name() {
        let mut entries = HashMap::new();
        entries.insert(
            "Mine".to_string(),
            Entry {
                kind: Kind::Process,
                json: serde_json::json!({"name": "Mine", "inherits": "0.08 Extra Fine", "wall_loops": "4"}),
                user: true,
            },
        );
        entries.insert(
            "0.08mm Standard".to_string(),
            Entry {
                kind: Kind::Process,
                json: serde_json::json!({"name": "0.08mm Standard", "layer_height": "0.08", "wall_loops": "2"}),
                user: false,
            },
        );
        entries.insert(
            "Orphan".to_string(),
            Entry { kind: Kind::Process, json: serde_json::json!({"name": "Orphan", "inherits": "Gone"}), user: true },
        );
        let renamed = HashMap::from([("0.08 Extra Fine".to_string(), "0.08mm Standard".to_string())]);
        let idx = Index { entries, renamed, selected: Default::default() };
        let flat = idx.resolve("Mine").unwrap();
        assert_eq!((flat["layer_height"].as_str(), flat["wall_loops"].as_str()), (Some("0.08"), Some("4")));
        assert_eq!(idx.chain("Mine"), ["Mine", "0.08mm Standard"]);
        assert_eq!(idx.kind_of("0.08 Extra Fine"), Some(Kind::Process));
        let err = idx.resolve("Orphan").unwrap_err().to_string();
        assert!(err.contains("Orphan") && err.contains("Gone"), "{err}");
    }
}
