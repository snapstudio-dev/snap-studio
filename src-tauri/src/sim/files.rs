//! A simulated printer's files: Moonraker's roots `gcodes` (read-write),
//! `camera` (read-only, as on a U1: monitor.jpg and the timelapses) and
//! `config` (the materials file), in a folder of its own. What Moonraker
//! reads in a print file (`metadata`) comes from the app's G-code reader.

use super::print::Plan;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const ROOTS: [(&str, &str); 3] = [("gcodes", "rw"), ("camera", "r"), ("config", "r")];

/// A print file as read once (until it changes).
pub struct FileInfo {
    /// Moonraker's `metadata`.
    pub meta: Value,
    /// What printing it does; why it cannot be printed.
    pub plan: std::result::Result<Arc<Plan>, String>,
}

pub struct Files {
    pub dir: PathBuf,
    /// Disk size, bytes.
    pub quota: u64,
    cache: Mutex<HashMap<String, (u128, Arc<FileInfo>)>>,
}

fn mtime(p: &Path) -> (u128, f64) {
    let t = std::fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok());
    t.map(|d| (d.as_nanos(), d.as_secs_f64())).unwrap_or((0, 0.0))
}

/// A path inside a root: no `..`, no absolute path, no backslash.
pub fn clean(rel: &str) -> Result<String> {
    let rel = rel.trim_start_matches('/');
    if rel.is_empty() || rel.contains('\\') || rel.split('/').any(|s| s.is_empty() || s == ".." || s == ".") {
        return Err(anyhow!("invalid path: {rel}"));
    }
    Ok(rel.to_string())
}

impl Files {
    pub fn new(dir: PathBuf, quota: u64) -> Result<Files> {
        for (r, _) in ROOTS {
            std::fs::create_dir_all(dir.join(r))?;
        }
        let cfg = dir.join("config").join("snapmaker");
        std::fs::create_dir_all(&cfg)?;
        std::fs::write(cfg.join("filament_parameters.json"), super::fixtures::FILAMENT_PARAMETERS)?;
        Ok(Files { dir, quota, cache: Mutex::new(HashMap::new()) })
    }

    pub fn root_dir(&self, root: &str) -> Result<PathBuf> {
        ROOTS.iter().find(|(r, _)| *r == root).map(|(r, _)| self.dir.join(r)).ok_or_else(|| anyhow!("Invalid root: {root}"))
    }

    pub fn writable(root: &str) -> bool {
        ROOTS.iter().any(|(r, p)| *r == root && p.contains('w'))
    }

    pub fn path(&self, root: &str, rel: &str) -> Result<PathBuf> {
        Ok(self.root_dir(root)?.join(clean(rel)?))
    }

    /// `/server/files/list`: every file of the root, its folders included.
    pub fn list(&self, root: &str) -> Result<Vec<Value>> {
        let base = self.root_dir(root)?;
        let mut out = Vec::new();
        for e in walkdir::WalkDir::new(&base).into_iter().flatten().filter(|e| e.file_type().is_file()) {
            let Ok(rel) = e.path().strip_prefix(&base) else { continue };
            let rel = rel.to_string_lossy().replace('\\', "/");
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(json!({ "path": rel, "modified": mtime(e.path()).1, "size": size, "permissions": ROOTS.iter().find(|(r, _)| *r == root).map(|(_, p)| *p).unwrap_or("r") }));
        }
        out.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
        Ok(out)
    }

    /// Bytes used on the disk: every root.
    pub fn used(&self) -> u64 {
        walkdir::WalkDir::new(&self.dir)
            .into_iter()
            .flatten()
            .filter_map(|e| e.metadata().ok())
            .filter(|m| m.is_file())
            .map(|m| m.len())
            .sum()
    }

    pub fn forget(&self, rel: &str) {
        if let Ok(mut c) = self.cache.lock() {
            c.remove(rel);
        }
    }

    /// A print file of `gcodes`, read now or before. Slow the first time
    /// (the whole G-code): off the async threads.
    pub fn info(&self, rel: &str) -> Result<Arc<FileInfo>> {
        let rel = clean(rel)?;
        let path = self.path("gcodes", &rel)?;
        if !path.is_file() {
            return Err(anyhow!("File {rel} does not exist"));
        }
        let (stamp, modified) = mtime(&path);
        if let Some((s, i)) = self.cache.lock().ok().and_then(|c| c.get(&rel).cloned()) {
            if s == stamp {
                return Ok(i);
            }
        }
        let info = Arc::new(read_info(&path, &rel, modified)?);
        if let Ok(mut c) = self.cache.lock() {
            c.insert(rel, (stamp, info.clone()));
        }
        Ok(info)
    }
}

/// A `; key = value` of the slicer's settings.
fn setting(path: &Path, key: &str) -> Option<String> {
    let f = std::fs::File::open(path).ok()?;
    std::io::BufReader::new(f).lines().map_while(|l| l.ok()).filter(|l| l.starts_with(';')).find_map(|l| {
        l.trim_start_matches(';').trim().strip_prefix(key).and_then(|r| r.trim_start().strip_prefix('=')).map(|v| v.trim().to_string())
    })
}

fn read_info(path: &Path, rel: &str, modified: f64) -> Result<FileInfo> {
    let size = std::fs::metadata(path)?.len();
    let parsed = crate::gcode::parse_with(std::fs::File::open(path)?, crate::gcode::Keep::None);
    let plan = Plan::from_gcode(std::fs::File::open(path)?).map(Arc::new).map_err(|e| e.to_string());
    let mut meta = json!({ "filename": rel, "size": size, "modified": modified, "print_start_time": null, "job_id": null });
    let Ok(d) = parsed else {
        return Ok(FileInfo { meta, plan });
    };
    let st = crate::gcode::stats(&d);
    let stem = rel.rsplit('/').next().unwrap_or(rel).trim_end_matches(".gcode");
    // The embedded thumbnail, written next to the file as Moonraker does.
    let mut thumbs = Vec::new();
    if let Some(png) = std::fs::File::open(path).ok().and_then(crate::gcode::embedded_thumbnail) {
        let (w, h) = if png.len() > 24 && png.starts_with(b"\x89PNG") {
            (u32::from_be_bytes(png[16..20].try_into().unwrap_or_default()), u32::from_be_bytes(png[20..24].try_into().unwrap_or_default()))
        } else {
            (300, 300)
        };
        let rel_thumb = format!(".thumbs/{stem}-{w}x{h}.png");
        let folder = path.parent().unwrap_or(Path::new("."));
        let _ = std::fs::create_dir_all(folder.join(".thumbs"));
        if std::fs::write(folder.join(&rel_thumb), &png).is_ok() {
            thumbs.push(json!({ "width": w, "height": h, "size": png.len(), "relative_path": rel_thumb }));
        }
    }
    let o = meta.as_object_mut().expect("object");
    let num = |k: &str| setting(path, k).and_then(|v| v.split(',').next().and_then(|x| x.trim().parse::<f64>().ok()));
    o.insert(
        "slicer".into(),
        json!(d.meta.generator.as_deref().map(|g| g.split(' ').take(2).collect::<Vec<_>>().join(" ")).unwrap_or_default()),
    );
    o.insert("estimated_time".into(), json!(st.print_time_s));
    o.insert("layer_count".into(), json!(st.layers.saturating_sub(1)));
    o.insert("layer_height".into(), json!(d.meta.layer_height));
    o.insert("first_layer_height".into(), json!(d.meta.layer_height));
    o.insert("object_height".into(), json!((d.max[2] * 100.0).round() / 100.0));
    o.insert("nozzle_diameter".into(), json!(0.4));
    o.insert("first_layer_bed_temp".into(), json!(num("first_layer_bed_temperature")));
    o.insert("first_layer_extr_temp".into(), json!(num("nozzle_temperature")));
    o.insert("filament_type".into(), json!(st.filament_types.join(";")));
    o.insert("filament_name".into(), json!(st.filament_types.iter().map(|t| format!("Generic {t}")).collect::<Vec<_>>().join(";")));
    o.insert("filament_colors".into(), json!(st.filament_colors));
    o.insert("filament_total".into(), json!(st.per_tool_m.iter().map(|m| *m as f64 * 1000.0).sum::<f64>()));
    o.insert("filament_weights".into(), json!(st.per_tool_g));
    o.insert("filament_weight_total".into(), json!(st.filament_g));
    o.insert("referenced_tools".into(), json!(st.tools));
    o.insert("thumbnails".into(), json!(thumbs));
    Ok(FileInfo { meta, plan })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::fixtures::sample_gcode;
    use crate::sim::scenario::{default_spools, SampleFile};

    #[test]
    fn a_printers_files() {
        let dir = std::env::temp_dir().join(format!("snapstudio-sim-files-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let f = Files::new(dir.clone(), 1 << 30).unwrap();
        let sample = SampleFile { name: "Part.gcode".into(), tools: vec![0, 1], minutes: 20, layers: 8, materials: vec![], colors: vec![] };
        std::fs::write(f.path("gcodes", "Part.gcode").unwrap(), sample_gcode(&sample, &default_spools())).unwrap();
        let i = f.info("Part.gcode").unwrap();
        let m = crate::printer_files::parse_meta(&json!({ "result": i.meta }), "");
        assert_eq!((m.estimated_time, m.layer_count, m.tools.clone()), (Some(1200.0), Some(8), vec![0, 1]));
        assert_eq!(m.filament_types, ["PLA", "PLA"]);
        assert_eq!(m.thumb.as_deref(), Some(".thumbs/Part-300x300.png"));
        assert_eq!(i.meta["first_layer_bed_temp"], 60.0);
        assert!(i.plan.is_ok());
        // The thumbnail lies next to it; the listing has both.
        let list = f.list("gcodes").unwrap();
        let paths: Vec<&str> = list.iter().filter_map(|v| v["path"].as_str()).collect();
        assert_eq!(paths, [".thumbs/Part-300x300.png", "Part.gcode"]);
        assert!(f.list("config").unwrap().iter().any(|v| v["path"] == "snapmaker/filament_parameters.json"));
        assert!(f.path("gcodes", "../config/x").is_err() && f.path("logs", "x").is_err());
        assert!(Files::writable("gcodes") && !Files::writable("camera"));
        assert!(f.used() > 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
