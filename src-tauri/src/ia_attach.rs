//! Files attached to an AI conversation: images, and 3D models (STL, 3MF)
//! for Claude to modify or build on.
//!
//! The view hands paths — dropped on the window, chosen in the dialog, pasted
//! — and each is checked here before it shows as a thumbnail or a chip
//! (`inspect`). A model is copied at send time into the working folder's
//! `sources/` (`stage_model`): the built-in sandbox reads nothing outside
//! that folder, and the container only mounts it. It is converted to the
//! app's 3MF layout on the way, so that `tools/mf.py` reads it like
//! `source.3mf` (trimesh's own 3MF reader needs lxml and networkx, which
//! the workspace does not have).

use crate::write3mf::Part;
use anyhow::{anyhow, Result};
use serde::Serialize;
use std::path::Path;

/// An image is scaled down by the view anyway: this only keeps a huge file
/// from crossing the bridge.
pub const MAX_IMAGE_BYTES: u64 = 30 << 20;
pub const MAX_MODEL_BYTES: u64 = 200 << 20;
/// Beyond it the mesh reader samples (`mesh.rs`, `READ_CAP`): Claude must
/// never get a decimated source.
pub const MAX_MODEL_TRIS: usize = 8_000_000;
/// Folder of the working folder where attached models go.
pub const SOURCES: &str = "sources";

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    /// With its MIME type.
    Image(&'static str),
    Model,
}

/// What a file may be attached as, from its extension.
pub fn kind_of(path: &Path) -> Option<Kind> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => Kind::Image("image/png"),
        "jpg" | "jpeg" => Kind::Image("image/jpeg"),
        "gif" => Kind::Image("image/gif"),
        "webp" => Kind::Image("image/webp"),
        "stl" | "3mf" => Kind::Model,
        _ => return None,
    })
}

/// A file checked for the view.
#[derive(Serialize, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Staged {
    /// Its bytes in base64: the view scales it like a chosen image.
    Image {
        name: String,
        media_type: String,
        data: String,
    },
    Model {
        path: String,
        name: String,
        bytes: u64,
        tris: usize,
        parts: usize,
        size_mm: [f32; 3],
    },
    /// `reason`: "type", "size", "tris" (with `max`) or "unreadable".
    Rejected {
        name: String,
        reason: &'static str,
        max: Option<u64>,
    },
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

/// The parts of a model, as Claude will get them: a 3MF one part per head
/// (all its objects and plates, as "Edit with AI" does), an STL one part.
fn read_parts(path: &Path) -> Result<Vec<Part>> {
    if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("stl")) {
        let m = crate::stl::read(path)?;
        Ok(vec![Part { name: "part-1".into(), tris: m.tris, extruder: 1, paint: Vec::new() }])
    } else {
        crate::ia::parts_of_3mf(path)
    }
}

/// Same, refused when empty or too big for Claude's tools.
pub fn model_parts(path: &Path) -> Result<Vec<Part>> {
    let parts = read_parts(path)?;
    let tris = triangles(&parts);
    if tris == 0 {
        return Err(anyhow!(crate::t!("err.object_empty", name = file_name(path))));
    }
    if tris > MAX_MODEL_TRIS {
        return Err(anyhow!(crate::t!("err.model_tris", name = file_name(path), max = MAX_MODEL_TRIS)));
    }
    Ok(parts)
}

fn triangles(parts: &[Part]) -> usize {
    parts.iter().map(|p| p.tris.len()).sum()
}

/// Width, depth and height of the parts together, in millimeters.
pub fn size_of(parts: &[Part]) -> [f32; 3] {
    let (mut lo, mut hi) = ([f32::MAX; 3], [f32::MIN; 3]);
    for v in parts.iter().flat_map(|p| p.tris.iter()).flat_map(|t| t.v) {
        for k in 0..3 {
            lo[k] = lo[k].min(v[k]);
            hi[k] = hi[k].max(v[k]);
        }
    }
    if lo[0] > hi[0] {
        return [0.0; 3];
    }
    [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]
}

/// Checks a file the user wants to attach. Reads, never writes.
pub fn inspect(path: &Path) -> Staged {
    let name = file_name(path);
    let rejected = |reason, max| Staged::Rejected { name: name.clone(), reason, max };
    let Some(kind) = kind_of(path) else { return rejected("type", None) };
    crate::access::ensure_file(path);
    let Ok(meta) = std::fs::metadata(path) else { return rejected("unreadable", None) };
    if !meta.is_file() {
        return rejected("type", None);
    }
    match kind {
        Kind::Image(media_type) => {
            if meta.len() > MAX_IMAGE_BYTES {
                return rejected("size", Some(MAX_IMAGE_BYTES));
            }
            match std::fs::read(path) {
                Ok(bytes) => Staged::Image { name, media_type: media_type.into(), data: crate::util::b64_encode(&bytes) },
                Err(_) => rejected("unreadable", None),
            }
        }
        Kind::Model => {
            if meta.len() > MAX_MODEL_BYTES {
                return rejected("size", Some(MAX_MODEL_BYTES));
            }
            let Ok(parts) = read_parts(path) else { return rejected("unreadable", None) };
            let tris = triangles(&parts);
            if tris == 0 {
                return rejected("unreadable", None);
            }
            if tris > MAX_MODEL_TRIS {
                return rejected("tris", Some(MAX_MODEL_TRIS as u64));
            }
            Staged::Model {
                path: path.to_string_lossy().to_string(),
                bytes: meta.len(),
                tris,
                parts: parts.len(),
                size_mm: size_of(&parts),
                name,
            }
        }
    }
}

/// A model copied into the working folder, as the log and Claude know it.
#[derive(Serialize, Clone, Debug)]
pub struct StagedModel {
    /// File name in `sources/`.
    pub name: String,
    /// Name of the file the user attached (never its path).
    pub original: String,
    pub tris: usize,
    pub parts: usize,
    pub size_mm: [f32; 3],
}

/// Copies a model into `sources/` of the working folder, converted to the
/// app's 3MF layout, under a numbered name.
pub fn stage_model(ws: &Path, path: &Path) -> Result<StagedModel> {
    let original = file_name(path);
    crate::access::ensure_file(path);
    let meta = std::fs::metadata(path).map_err(|_| anyhow!(crate::t!("err.model_gone", name = original)))?;
    if meta.len() > MAX_MODEL_BYTES {
        return Err(anyhow!(crate::t!("err.model_too_big", name = original, max = format!("{} MB", MAX_MODEL_BYTES >> 20))));
    }
    let parts = model_parts(path)?;
    let dir = ws.join(SOURCES);
    std::fs::create_dir_all(&dir)?;
    let stem = Path::new(&original).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let name = crate::chat::attachment_name(&dir, &format!("{stem}.3mf"));
    crate::ia::write_3mf(&dir.join(&name), &stem, &parts)?;
    Ok(StagedModel { name, original, tris: triangles(&parts), parts: parts.len(), size_mm: size_of(&parts) })
}

/// A size that suggests another unit than the millimeter.
pub fn odd_scale(size: [f32; 3]) -> bool {
    let longest = size.iter().copied().fold(0.0, f32::max);
    longest < 1.0 || longest > 1000.0
}

/// The user's text followed by the list of the models attached to it, for
/// Claude (always in English, as `CLAUDE.md`).
pub fn with_models(text: &str, models: &[StagedModel]) -> String {
    if models.is_empty() {
        return text.to_string();
    }
    let mut s = String::from("Attached source models (in the working folder; read them with `mf.read`, never modify them):\n");
    for m in models {
        let [x, y, z] = m.size_mm;
        s.push_str(&format!(
            "- `{SOURCES}/{}` — from {}, {} part(s), {} triangles, {x:.1} × {y:.1} × {z:.1} mm",
            m.name, m.original, m.parts, m.tris
        ));
        if odd_scale(m.size_mm) {
            s.push_str(" (a size that suggests another unit than millimeters: ask the user)");
        }
        s.push('\n');
    }
    if text.trim().is_empty() {
        s.trim_end().to_string()
    } else {
        format!("{text}\n\n{}", s.trim_end())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("snapstudio-attach-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// A 10 mm cube, as a one-part STL.
    fn cube_stl(dst: &Path) {
        crate::stl::write(dst, &crate::stl::tests_cube()).unwrap();
    }

    /// Two cubes printed by heads 1 and 2.
    fn two_heads_3mf(dst: &Path) {
        let cube = crate::stl::tests_cube();
        let moved: Vec<_> = cube.iter().map(|t| crate::mesh::Tri { v: t.v.map(|p| [p[0] + 20.0, p[1], p[2]]), c: t.c }).collect();
        let parts = [
            Part { name: "a".into(), tris: cube, extruder: 1, paint: Vec::new() },
            Part { name: "b".into(), tris: moved, extruder: 2, paint: Vec::new() },
        ];
        crate::ia::write_3mf(dst, "two", &parts).unwrap();
    }

    #[test]
    fn kinds_come_from_the_extension() {
        assert_eq!(kind_of(Path::new("a.PNG")), Some(Kind::Image("image/png")));
        assert_eq!(kind_of(Path::new("a.jpeg")), Some(Kind::Image("image/jpeg")));
        assert_eq!(kind_of(Path::new("a.Stl")), Some(Kind::Model));
        assert_eq!(kind_of(Path::new("C:\\Users\\me\\Desktop\\b.3MF")), Some(Kind::Model));
        for p in ["a.obj", "a.gcode", "a.svg", "README", ".stl"] {
            assert_eq!(kind_of(Path::new(p)), None, "{p}");
        }
    }

    #[test]
    fn files_are_checked_before_they_are_attached() {
        let d = tmp("inspect");
        let reason = |s: Staged| match s {
            Staged::Rejected { reason, .. } => reason,
            other => panic!("not rejected: {other:?}"),
        };
        std::fs::write(d.join("notes.txt"), "hi").unwrap();
        assert_eq!(reason(inspect(&d.join("notes.txt"))), "type");
        assert_eq!(reason(inspect(&d.join("gone.stl"))), "unreadable");
        std::fs::create_dir_all(d.join("folder.stl")).unwrap();
        assert_eq!(reason(inspect(&d.join("folder.stl"))), "type");
        std::fs::write(d.join("junk.stl"), "solid nothing here\nendsolid").unwrap();
        assert_eq!(reason(inspect(&d.join("junk.stl"))), "unreadable");
        std::fs::write(d.join("junk.3mf"), "not a zip").unwrap();
        assert_eq!(reason(inspect(&d.join("junk.3mf"))), "unreadable");
        // Too big: refused from its size alone, never read.
        let big = std::fs::File::create(d.join("big.stl")).unwrap();
        big.set_len(MAX_MODEL_BYTES + 1).unwrap();
        match inspect(&d.join("big.stl")) {
            Staged::Rejected { reason, max, .. } => assert_eq!((reason, max), ("size", Some(MAX_MODEL_BYTES))),
            other => panic!("{other:?}"),
        }
        let big = std::fs::File::create(d.join("big.png")).unwrap();
        big.set_len(MAX_IMAGE_BYTES + 1).unwrap();
        assert_eq!(reason(inspect(&d.join("big.png"))), "size");

        cube_stl(&d.join("cube.stl"));
        match inspect(&d.join("cube.stl")) {
            Staged::Model { name, tris, parts, size_mm, bytes, path } => {
                assert_eq!((name.as_str(), tris, parts), ("cube.stl", 12, 1));
                assert!(size_mm.iter().all(|s| (s - 10.0).abs() < 1e-3), "{size_mm:?}");
                assert!(bytes > 0 && path.ends_with("cube.stl"));
            }
            other => panic!("{other:?}"),
        }
        two_heads_3mf(&d.join("two.3mf"));
        match inspect(&d.join("two.3mf")) {
            Staged::Model { parts, tris, size_mm, .. } => {
                assert_eq!((parts, tris), (2, 24));
                assert!((size_mm[0] - 30.0).abs() < 1e-3, "both cubes: {size_mm:?}");
            }
            other => panic!("{other:?}"),
        }
        std::fs::write(d.join("dot.png"), [0x89, b'P', b'N', b'G']).unwrap();
        match inspect(&d.join("dot.png")) {
            Staged::Image { name, media_type, data } => {
                assert_eq!((name.as_str(), media_type.as_str()), ("dot.png", "image/png"));
                assert_eq!(crate::util::b64_decode(&data).unwrap(), [0x89, b'P', b'N', b'G']);
            }
            other => panic!("{other:?}"),
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_view_gets_tagged_objects() {
        let v = serde_json::to_value(Staged::Rejected { name: "a.obj".into(), reason: "type", max: None }).unwrap();
        assert_eq!(v["kind"], "rejected");
        assert_eq!(v["reason"], "type");
        let v = serde_json::to_value(Staged::Model {
            path: "/x/a.stl".into(),
            name: "a.stl".into(),
            bytes: 1,
            tris: 12,
            parts: 1,
            size_mm: [1.0, 2.0, 3.0],
        })
        .unwrap();
        assert_eq!((v["kind"].as_str(), v["size_mm"][2].as_f64()), (Some("model"), Some(3.0)));
    }

    #[test]
    fn models_are_copied_into_sources_as_3mf() {
        let d = tmp("stage");
        let ws = d.join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        let src = d.join("evil name.stl");
        cube_stl(&src);

        let m = stage_model(&ws, &src).unwrap();
        assert_eq!(m.name, "001-evil-name.3mf", "numbered, no spaces");
        assert_eq!((m.original.as_str(), m.parts, m.tris), ("evil name.stl", 1, 12));
        let parts = crate::ia::parts_of_3mf(&ws.join(SOURCES).join(&m.name)).unwrap();
        assert_eq!((parts.len(), parts[0].extruder, parts[0].tris.len()), (1, 1, 12));

        // The same file again, then a deletion: never a number used twice.
        assert_eq!(stage_model(&ws, &src).unwrap().name, "002-evil-name.3mf");
        std::fs::remove_file(ws.join(SOURCES).join("001-evil-name.3mf")).unwrap();
        assert_eq!(stage_model(&ws, &src).unwrap().name, "003-evil-name.3mf");

        two_heads_3mf(&d.join("two.3mf"));
        let m = stage_model(&ws, &d.join("two.3mf")).unwrap();
        let parts = crate::ia::parts_of_3mf(&ws.join(SOURCES).join(&m.name)).unwrap();
        assert_eq!(parts.iter().map(|p| p.extruder).collect::<Vec<_>>(), [1, 2], "the heads stay");

        assert!(stage_model(&ws, &d.join("moved.stl")).is_err(), "a file gone since it was attached");
        std::fs::write(d.join("junk.3mf"), "x").unwrap();
        assert!(stage_model(&ws, &d.join("junk.3mf")).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Claude reads a staged model with the workspace's own tool, as told.
    /// Needs Python with trimesh: `SS_PYTHON=python3 cargo test`.
    #[test]
    fn mf_reads_a_staged_model() {
        let Ok(python) = std::env::var("SS_PYTHON") else { return };
        let d = tmp("mf");
        let ws = d.join("workspace");
        std::fs::create_dir_all(ws.join("tools")).unwrap();
        std::fs::write(ws.join("tools/mf.py"), include_str!("ia_tools/mf.py")).unwrap();
        two_heads_3mf(&d.join("two.3mf"));
        cube_stl(&d.join("cube.stl"));
        let a = stage_model(&ws, &d.join("two.3mf")).unwrap();
        let b = stage_model(&ws, &d.join("cube.stl")).unwrap();
        let script = format!(
            "import sys; sys.path.insert(0, 'tools'); import mf\nfor f in ['{}', '{}']:\n    print(f, [(p.extruder, len(p.mesh.faces), p.mesh.is_watertight) for p in mf.read('sources/' + f)])",
            a.name, b.name
        );
        let out = std::process::Command::new(&python).args(["-c", &script]).current_dir(&ws).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.contains("[(1, 12, True), (2, 12, True)]"), "{text}");
        assert!(text.contains(&format!("{} [(1, 12, True)]", b.name)), "{text}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn claude_is_told_where_the_models_are() {
        let m = |name: &str, size_mm| StagedModel { name: name.into(), original: "bracket.stl".into(), tris: 12, parts: 1, size_mm };
        assert_eq!(with_models("hello", &[]), "hello");
        let t = with_models("Make it 2 mm thicker", &[m("002-bracket.3mf", [40.0, 20.0, 10.0])]);
        assert!(t.starts_with("Make it 2 mm thicker\n\nAttached source models"), "{t}");
        assert!(t.contains("- `sources/002-bracket.3mf` — from bracket.stl, 1 part(s), 12 triangles, 40.0 × 20.0 × 10.0 mm"), "{t}");
        assert!(!t.contains("another unit"));
        let t = with_models("", &[m("001-tiny.3mf", [0.4, 0.2, 0.1])]);
        assert!(t.starts_with("Attached source models") && t.contains("another unit"), "{t}");
        assert!(odd_scale([2000.0, 1.0, 1.0]) && !odd_scale([270.0, 270.0, 270.0]));
    }
}
