//! Plate of the "Prepare" view: the files' objects, each one's mesh, and
//! the scene written for slicing.
//!
//! A plate object is an occurrence of a file's `<build>`, isolated in its own
//! frame (centered on its bounding box, oriented as in the file). Its
//! placement on the plate fits in three values:
//!
//! 1. `scale`: scale per axis;
//! 2. `rot`: rotations in degrees around X, then Y, then Z;
//! 3. `pos`: (X, Y) position of the center; the object rests on the plate,
//!    its lowest point at Z = 0.
//!
//! The UI applies exactly the same rule for display.

use crate::mesh::{MeshData, Tri};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Beyond this, the bundled slicing gives up (as for a single file).
const FULL_BUDGET: usize = 8_000_000;

/// An object offered to the plate.
#[derive(Serialize, Clone, Debug)]
pub struct PlateItem {
    /// Rank of the occurrence in the file's `<build>`.
    pub index: usize,
    pub name: String,
    /// Center of the object in the file's scene (mm): the plates of a
    /// multi-plate 3MF keep their offset there.
    pub center: [f32; 3],
    /// Bounding box dimensions, file orientation.
    pub size: [f32; 3],
    pub triangles: usize,
    /// Original plate in the file (1 by default).
    pub plate: u32,
    /// Model extruders used by the object (from 1).
    pub extruders: Vec<u8>,
}

fn is_stl(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("stl"))
}

/// Mesh of an object, centered; also returns its center in the file.
/// `piece`: only that piece of the object (`pieces`), centered on itself.
pub fn load(path: &Path, index: usize, piece: Option<usize>, budget: usize) -> Result<(MeshData, [f32; 3])> {
    let Some(k) = piece else {
        return load_whole(path, index, budget);
    };
    // Pieces are found on the whole mesh: a sampled one would cut them.
    let (mut m, c) = load_whole(path, index, FULL_BUDGET)?;
    let (of, count) = piece_of_triangles(&m.tris);
    if k >= count {
        return Err(anyhow!(crate::t!("err.no_object", index = index)));
    }
    crate::mesh::retain_tris(&mut m, |i| of[i] == k as u32);
    let pc = crate::mesh::recenter(&mut m);
    crate::mesh::downsample(&mut m, budget);
    Ok((m, [c[0] + pc[0], c[1] + pc[1], c[2] + pc[2]]))
}

fn load_whole(path: &Path, index: usize, budget: usize) -> Result<(MeshData, [f32; 3])> {
    if is_stl(path) {
        if index != 0 {
            return Err(anyhow!("an STL holds a single object"));
        }
        let mut m = crate::stl::read(path)?;
        crate::mesh::downsample(&mut m, budget);
        let c = crate::mesh::recenter(&mut m);
        return Ok((m, c));
    }
    let mut zip = crate::model3mf::open(path)?;
    let it = crate::mesh::load_item(&mut zip, index, budget)?;
    Ok((it.mesh, it.center))
}

/// The pieces of an object, as Orca's "Split to objects" finds them:
/// triangles connected through shared vertices, numbered in order of first
/// appearance. Returns each triangle's piece and the count.
fn piece_of_triangles(tris: &[Tri]) -> (Vec<u32>, usize) {
    fn find(p: &mut [u32], mut x: u32) -> u32 {
        while p[x as usize] != x {
            p[x as usize] = p[p[x as usize] as usize];
            x = p[x as usize];
        }
        x
    }
    let mut ids: std::collections::HashMap<[u32; 3], u32> = std::collections::HashMap::with_capacity(tris.len());
    let mut parent: Vec<u32> = Vec::with_capacity(tris.len());
    let mut first: Vec<u32> = Vec::with_capacity(tris.len());
    for t in tris {
        let mut vs = [0u32; 3];
        for (k, v) in t.v.iter().enumerate() {
            let key = [v[0].to_bits(), v[1].to_bits(), v[2].to_bits()];
            vs[k] = *ids.entry(key).or_insert_with(|| {
                parent.push(parent.len() as u32);
                (parent.len() - 1) as u32
            });
        }
        let r0 = find(&mut parent, vs[0]);
        for &v in &vs[1..] {
            let r = find(&mut parent, v);
            if r != r0 {
                parent[r as usize] = r0;
            }
        }
        first.push(vs[0]);
    }
    let mut number: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
    let of: Vec<u32> = first
        .iter()
        .map(|&v| {
            let r = find(&mut parent, v);
            let n = number.len() as u32;
            *number.entry(r).or_insert(n)
        })
        .collect();
    (of, number.len())
}

/// A piece of an object, offered to split it.
#[derive(Serialize, Clone, Debug)]
pub struct Piece {
    pub piece: usize,
    /// Its center relative to the object's (object frame, as on the plate).
    pub offset: [f32; 3],
    pub size: [f32; 3],
    pub triangles: usize,
    /// Model colors it uses (from 1).
    pub extruders: Vec<u8>,
}

/// The pieces of object `index` (or of piece `piece` of it, which has one);
/// a single one means it cannot be split.
pub fn pieces(path: &Path, index: usize, piece: Option<usize>) -> Result<Vec<Piece>> {
    let (m, _) = load(path, index, piece, FULL_BUDGET)?;
    let (of, count) = piece_of_triangles(&m.tris);
    // One pass: each piece's box, triangles and colors.
    let mut min = vec![[f32::MAX; 3]; count];
    let mut max = vec![[f32::MIN; 3]; count];
    let mut triangles = vec![0usize; count];
    let mut colors: Vec<std::collections::BTreeSet<u8>> = vec![Default::default(); count];
    for (i, t) in m.tris.iter().enumerate() {
        let k = of[i] as usize;
        triangles[k] += 1;
        for v in &t.v {
            for a in 0..3 {
                min[k][a] = min[k][a].min(v[a]);
                max[k][a] = max[k][a].max(v[a]);
            }
        }
        if let Some(e) = m.extruders.get(i) {
            colors[k].insert(*e);
        }
        if let (Some(Some(p)), Some(vol)) = (m.paint.get(i), m.volumes.get(i)) {
            colors[k].extend(crate::paint::states(p).into_iter().map(|s| if s == 0 { *vol } else { s }));
        }
    }
    let out = (0..count)
        .map(|k| Piece {
            // A piece split again is still that piece.
            piece: if count == 1 { piece.unwrap_or(0) } else { k },
            offset: [(min[k][0] + max[k][0]) / 2.0, (min[k][1] + max[k][1]) / 2.0, (min[k][2] + max[k][2]) / 2.0],
            size: [max[k][0] - min[k][0], max[k][1] - min[k][1], max[k][2] - min[k][2]],
            triangles: triangles[k],
            extruders: if colors[k].is_empty() { vec![1] } else { colors[k].iter().copied().collect() },
        })
        .collect();
    Ok(out)
}

/// A file's objects, ready to put on the plate.
pub fn items(path: &Path) -> Result<Vec<PlateItem>> {
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "object".into());
    if is_stl(path) {
        let (m, c) = load(path, 0, None, FULL_BUDGET)?;
        return Ok(vec![PlateItem {
            index: 0,
            name: stem,
            center: c,
            size: size_of(&m),
            triangles: m.tris.len(),
            plate: 1,
            extruders: vec![1],
        }]);
    }
    let mut zip = crate::model3mf::open(path)?;
    // All at once: the container is parsed a single time for every object.
    let loaded = crate::mesh::load_items(&mut zip, FULL_BUDGET)?;
    let (names, plates) = crate::model3mf::object_settings(&mut zip);
    let many = loaded.len() > 1;
    let mut out = Vec::with_capacity(loaded.len());
    for (i, (b, it)) in loaded.iter().enumerate() {
        let mut extruders = crate::mesh::colors_used(&it.mesh);
        if extruders.is_empty() {
            extruders.push(1);
        }
        out.push(PlateItem {
            index: i,
            name: names.get(&b.objid).cloned().unwrap_or_else(|| if many { format!("{stem} {}", i + 1) } else { stem.clone() }),
            center: it.center,
            size: size_of(&it.mesh),
            triangles: it.mesh.tris.len(),
            plate: plates.get(&b.objid).copied().unwrap_or(1),
            extruders,
        });
    }
    Ok(out)
}

fn size_of(m: &MeshData) -> [f32; 3] {
    [m.max[0] - m.min[0], m.max[1] - m.min[1], m.max[2] - m.min[2]]
}

/// Display mesh of an object. Triangles without their own color take the
/// filament color the project associates with their extruder.
pub fn display_mesh(path: &Path, index: usize, piece: Option<usize>, budget: usize) -> Result<MeshData> {
    let (mut m, _) = load(path, index, piece, budget)?;
    if !is_stl(path) {
        let mut zip = crate::model3mf::open(path)?;
        filament_colored(&mut zip, &mut m);
    }
    Ok(m)
}

/// Colors triangles without a color of their own with the project's
/// filament for their model color (painting included) — what the slicer
/// shows. Used by every view of a 3MF: Prepare, the Files viewer, rendered
/// thumbnails, the AI's copy.
pub fn filament_colored(zip: &mut crate::model3mf::Zip, m: &mut MeshData) {
    if m.extruders.len() != m.tris.len() {
        return;
    }
    let colors: Vec<Option<[u8; 3]>> =
        crate::model3mf::project_filaments(zip).iter().map(|f| f.color.as_deref().and_then(hex_rgb)).collect();
    for (t, e) in m.tris.iter_mut().zip(&m.extruders) {
        if t.c == crate::render::DEFAULT_COLOR {
            if let Some(Some(c)) = colors.get(e.saturating_sub(1) as usize) {
                t.c = *c;
            }
        }
    }
}

pub fn hex_rgb(s: &str) -> Option<[u8; 3]> {
    let h = s.trim_start_matches('#');
    // `get`: a non-ASCII character at the cut gives None, not a panic.
    let n = u32::from_str_radix(h.get(..6)?, 16).ok()?;
    Some([(n >> 16) as u8, (n >> 8) as u8, n as u8])
}

// ------------------------------------------------------------ scene to slice

/// An object resting on the plate, as the UI describes it.
#[derive(Deserialize, Clone, Debug)]
pub struct SceneItem {
    pub path: String,
    pub item: usize,
    #[serde(default)]
    pub name: String,
    pub pos: [f32; 2],
    #[serde(default)]
    pub rot: [f32; 3],
    #[serde(default = "unit_scale")]
    pub scale: [f32; 3],
    /// Head (0 to 3) of each model extruder, as for a single file.
    #[serde(default)]
    pub extruder_map: Vec<u8>,
    /// A piece of the object, once split (`pieces`).
    #[serde(default)]
    pub piece: Option<usize>,
}

fn unit_scale() -> [f32; 3] {
    [1.0, 1.0, 1.0]
}

/// Rotation matrix: X first, then Y, then Z (angles in degrees).
pub fn rotation(rot: [f32; 3]) -> [[f32; 3]; 3] {
    let (a, b, c) = (rot[0].to_radians(), rot[1].to_radians(), rot[2].to_radians());
    let (sa, ca, sb, cb, sc, cc) = (a.sin(), a.cos(), b.sin(), b.cos(), c.sin(), c.cos());
    // Rz · Ry · Rx
    [
        [cc * cb, cc * sb * sa - sc * ca, cc * sb * ca + sc * sa],
        [sc * cb, sc * sb * sa + cc * ca, sc * sb * ca - cc * sa],
        [-sb, cb * sa, cb * ca],
    ]
}

/// Lays the (centered) triangles on the plate following the object's placement.
pub fn place(tris: &mut [Tri], it: &SceneItem) {
    let r = rotation(it.rot);
    let s = it.scale;
    let mut zmin = f32::MAX;
    for t in tris.iter_mut() {
        for v in &mut t.v {
            let p = [v[0] * s[0], v[1] * s[1], v[2] * s[2]];
            *v = [
                r[0][0] * p[0] + r[0][1] * p[1] + r[0][2] * p[2],
                r[1][0] * p[0] + r[1][1] * p[1] + r[1][2] * p[2],
                r[2][0] * p[0] + r[2][1] * p[1] + r[2][2] * p[2],
            ];
            zmin = zmin.min(v[2]);
        }
        // A negative scale flips the faces: restore the winding.
        if s[0] * s[1] * s[2] < 0.0 {
            t.v.swap(1, 2);
        }
    }
    for t in tris.iter_mut() {
        for v in &mut t.v {
            v[0] += it.pos[0];
            v[1] += it.pos[1];
            v[2] -= zmin;
        }
    }
}

/// Outcome of writing a scene.
#[derive(Debug, Default)]
pub struct Written {
    pub kept: usize,
    /// Objects entirely off the plate, not sliced.
    pub skipped: Vec<String>,
}

/// Writes the scene into a 3MF ready for the engine (placements applied,
/// multicolor parts spread over their heads), its prime pillars first.
///
/// An object entirely off the plate is left out (objects of a 3MF's other
/// plates, for instance); an object partly sticking out stops everything,
/// as a pillar off the plate does.
pub fn write_scene(scene: &[SceneItem], pillars: &[Pillar], bed: (f32, f32), dst: &Path) -> Result<Written> {
    write_items(scene, pillars, Some(bed), dst)
}

/// Saves the whole plate as 3MF, without plate checks: only the user's
/// parts, never the pillars. Its prime tower, if shown, and smooth mix, for
/// a plate with a virtual head (`Some(on)`), in the project's settings as
/// Orca keeps them; Snap Studio's own tower data (the kind of tower, the
/// pillars' places) beside it, which Orca ignores.
pub fn save_scene(
    scene: &[SceneItem],
    tower: Option<TowerPlace>,
    smooth_mix: Option<bool>,
    snap: Option<&serde_json::Value>,
    dst: &Path,
) -> Result<()> {
    write_items(scene, &[], None, dst)?;
    let mut settings = tower.map(|t| t.settings()).unwrap_or_else(|| serde_json::json!({}));
    if let Some(on) = smooth_mix {
        for k in crate::slice::SMOOTH_MIX_OVERRIDES {
            settings[k] = serde_json::Value::String(if on { "1" } else { "0" }.into());
        }
    }
    if settings.as_object().is_some_and(|m| !m.is_empty()) {
        crate::write3mf::append_entry(dst, PROJECT_SETTINGS, &serde_json::to_vec_pretty(&settings)?)?;
    }
    if let Some(v) = snap {
        crate::write3mf::append_entry(dst, SNAP_TOWER, &serde_json::to_vec_pretty(v)?)?;
    }
    Ok(())
}

const PROJECT_SETTINGS: &str = "Metadata/project_settings.config";
const SNAP_TOWER: &str = "Metadata/snapstudio_tower.json";

// ------------------------------------------------------------ prime pillars

/// A prime pillar (one prime tower per material): concentric rings around
/// (`x`, `y`), one per head, each a closed tube as tall as its head's last
/// layer, outer ring first. Generated by the UI (pillar-logic.js), written
/// first in the engine's 3MF, never saved.
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct Pillar {
    pub name: String,
    pub x: f32,
    pub y: f32,
    pub rings: Vec<Ring>,
    /// Outer brim, mm.
    #[serde(default)]
    pub brim: f32,
}

/// A ring: its head (0 to 15), outer and inner diameters, height (mm).
#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Ring {
    pub head: u8,
    pub d_out: f32,
    pub d_in: f32,
    pub h: f32,
}

const PILLAR_SIDES: usize = 48;

/// A closed tube around (`cx`, `cy`), radii `ro` > `ri`, from 0 to `h`:
/// outer and inner walls, top and bottom rings, outward normals.
pub fn tube(cx: f32, cy: f32, ro: f32, ri: f32, h: f32) -> Vec<Tri> {
    let n = PILLAR_SIDES;
    let pt = |r: f32, k: usize, z: f32| {
        let a = (k % n) as f32 / n as f32 * std::f32::consts::TAU;
        [cx + r * a.cos(), cy + r * a.sin(), z]
    };
    let c = crate::render::DEFAULT_COLOR;
    let mut t = Vec::with_capacity(n * 8);
    let mut quad = |a: [f32; 3], b: [f32; 3], d: [f32; 3], e: [f32; 3]| {
        t.push(Tri { v: [a, b, d], c });
        t.push(Tri { v: [a, d, e], c });
    };
    for k in 0..n {
        quad(pt(ro, k, 0.), pt(ro, k + 1, 0.), pt(ro, k + 1, h), pt(ro, k, h));
        quad(pt(ri, k + 1, 0.), pt(ri, k, 0.), pt(ri, k, h), pt(ri, k + 1, h));
        quad(pt(ro, k, h), pt(ro, k + 1, h), pt(ri, k + 1, h), pt(ri, k, h));
        quad(pt(ri, k, 0.), pt(ri, k + 1, 0.), pt(ro, k + 1, 0.), pt(ro, k, 0.));
    }
    t
}

/// The settings each pillar carries: walls only (two perimeters on each
/// side of a ring, no infill, no top or bottom layers), a brim, and none
/// of the plate's settings that would add to it.
fn pillar_settings(p: &Pillar) -> Vec<(String, String)> {
    [
        ("sparse_infill_density", "0%".to_string()),
        ("top_shell_layers", "0".into()),
        ("bottom_shell_layers", "0".into()),
        ("wall_loops", "2".into()),
        ("brim_type", if p.brim > 0.0 { "outer_only" } else { "no_brim" }.into()),
        ("brim_width", format!("{}", p.brim.max(0.0))),
        ("enable_support", "0".into()),
        ("seam_position", "aligned".into()),
        ("ironing_type", "no ironing".into()),
        ("fuzzy_skin", "none".into()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect()
}

/// A pillar as an object: one part per ring, on its head.
fn pillar_object(p: &Pillar) -> crate::write3mf::Object {
    let parts = p
        .rings
        .iter()
        .map(|r| crate::write3mf::Part {
            name: format!("{} — T{}", p.name, r.head),
            tris: tube(p.x, p.y, r.d_out / 2.0, r.d_in / 2.0, r.h),
            extruder: r.head.min(15) + 1,
            paint: Vec::new(),
        })
        .collect();
    crate::write3mf::Object { name: p.name.clone(), parts, settings: pillar_settings(p) }
}

/// A plate's prime tower: shown or not, front-left corner and turn
/// (degrees), as the engine places it.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct TowerPlace {
    pub on: bool,
    pub x: f32,
    pub y: f32,
    pub rot: f32,
}

/// The prime tower a 3MF keeps, with whether Snap Studio wrote it (`ours`):
/// an Orca project's switch is its profile's, not a choice of the user.
/// `snap`: Snap Studio's own tower data (one tower per material), and
/// `smooth_mix`: smooth mix on or off for a plate with a virtual head, only
/// from a file Snap Studio wrote.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct FileTower {
    #[serde(flatten)]
    pub place: Option<TowerPlace>,
    pub ours: bool,
    pub snap: Option<serde_json::Value>,
    pub smooth_mix: Option<bool>,
}

impl TowerPlace {
    /// Orca's keys: one position per plate (this one is the first plate).
    fn settings(&self) -> serde_json::Value {
        serde_json::json!({
            "enable_prime_tower": if self.on { "1" } else { "0" },
            "wipe_tower_x": [format!("{:.3}", self.x)],
            "wipe_tower_y": [format!("{:.3}", self.y)],
            "wipe_tower_rotation_angle": format!("{:.3}", self.rot),
        })
    }
}

/// The first plate's prime tower in a 3MF's project settings, and Snap
/// Studio's own tower data, if the file says either.
pub fn tower_of(path: &Path) -> Option<FileTower> {
    if is_stl(path) {
        return None;
    }
    let mut zip = crate::model3mf::open(path).ok()?;
    let settings = crate::model3mf::read_entry(&mut zip, PROJECT_SETTINGS)
        .and_then(|data| serde_json::from_slice::<serde_json::Value>(crate::util::strip_bom(&data)).ok());
    let place = settings.as_ref().and_then(|v| {
        let num = |k: &str| -> Option<f32> {
            let x = v.get(k)?;
            let x = x.as_array().map_or(Some(x), |a| a.first())?;
            x.as_str().and_then(|s| s.trim().parse().ok()).or_else(|| x.as_f64().map(|f| f as f32))
        };
        Some(TowerPlace {
            on: v.get("enable_prime_tower").and_then(|x| x.as_str()) == Some("1"),
            x: num("wipe_tower_x")?,
            y: num("wipe_tower_y")?,
            rot: num("wipe_tower_rotation_angle").unwrap_or(0.0),
        })
    });
    let ours = crate::model3mf::read_meta(&mut zip).application.as_deref() == Some("Snap Studio");
    let snap = if ours {
        crate::model3mf::read_entry(&mut zip, SNAP_TOWER)
            .and_then(|d| serde_json::from_slice::<serde_json::Value>(&d).ok())
            .filter(|v| v.is_object())
    } else {
        None
    };
    // Smooth mix as saved (its first key): an Orca project's is its own
    // profile's, not a choice made here.
    let smooth_mix =
        settings.as_ref().filter(|_| ours).and_then(|v| v.get(crate::slice::SMOOTH_MIX_OVERRIDES[0])?.as_str().map(|s| s == "1"));
    if place.is_none() && snap.is_none() && smooth_mix.is_none() {
        return None;
    }
    Some(FileTower { place, ours, snap, smooth_mix })
}

fn write_items(scene: &[SceneItem], pillars: &[Pillar], bed: Option<(f32, f32)>, dst: &Path) -> Result<Written> {
    let mut objects: Vec<crate::write3mf::Object> = Vec::new();
    let mut written = Written::default();
    // The pillars first: with `print_order = as_obj_list`, each head primes
    // on its ring before printing the model.
    for p in pillars {
        let r = p.rings.iter().map(|r| r.d_out / 2.0).fold(0.0, f32::max);
        if p.rings.is_empty() || r <= 0.0 || p.rings.iter().any(|r| !(r.d_in >= 0.0 && r.d_in < r.d_out && r.h > 0.0)) {
            return Err(anyhow!("bad prime pillar: {}", p.name));
        }
        if let Some(bed) = bed {
            let eps = 0.1;
            if p.x - r < -eps || p.y - r < -eps || p.x + r > bed.0 + eps || p.y + r > bed.1 + eps {
                return Err(anyhow!(crate::t!("err.sticks_out", name = p.name)));
            }
        }
        objects.push(pillar_object(p));
    }
    for it in scene {
        let path = Path::new(&it.path);
        let (mut m, _) = load(path, it.item, it.piece, FULL_BUDGET)?;
        let name = if it.name.is_empty() { format!("object {}", objects.len() + 1) } else { it.name.clone() };
        if m.truncated {
            return Err(anyhow!(crate::t!("err.too_dense", name = name)));
        }
        place(&mut m.tris, it);
        let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for t in &m.tris {
            for v in &t.v {
                x0 = x0.min(v[0]);
                y0 = y0.min(v[1]);
                x1 = x1.max(v[0]);
                y1 = y1.max(v[1]);
            }
        }
        if let Some(bed) = bed {
            // Tolerance of a tenth of a millimeter on the edges.
            let eps = 0.1;
            let outside = x1 < -eps || y1 < -eps || x0 > bed.0 + eps || y0 > bed.1 + eps;
            if outside {
                written.skipped.push(name);
                continue;
            }
            if x0 < -eps || y0 < -eps || x1 > bed.0 + eps || y1 > bed.1 + eps {
                return Err(anyhow!(crate::t!("err.sticks_out", name = name)));
            }
        }

        let head_of = |e: u8| -> u8 { it.extruder_map.get(e.saturating_sub(1) as usize).copied().unwrap_or(0).min(15) };
        let mirrored = it.scale[0] * it.scale[1] * it.scale[2] < 0.0;
        let parts = parts_by_head(&name, m, head_of, mirrored);
        objects.push(crate::write3mf::Object { name, parts, settings: Vec::new() });
    }
    written.kept = objects.len() - pillars.len();
    if written.kept == 0 {
        return Err(anyhow!(crate::t!("prepare.nothing")));
    }
    crate::write3mf::write_objects(dst, &objects)?;
    Ok(written)
}

/// The parts sent to the engine: one per head, grouping the model's
/// volumes by the head printing them (`head_of`: model color → head, 0 to
/// 15).
///
/// A painted mesh keeps its geometry grouped by volume — splitting painted
/// triangles into parts would leave open meshes — and its painting, the
/// states renumbered to the heads (`paint_color` counts filaments from 1,
/// 0 staying "the volume's"). On a `mirrored` object our writer reorders
/// each triangle's vertices, which would move a split triangle's pieces:
/// those get their dominant color instead.
pub fn parts_by_head(name: &str, m: MeshData, head_of: impl Fn(u8) -> u8, mirrored: bool) -> Vec<crate::write3mf::Part> {
    type Group = (Vec<Tri>, Vec<Option<Box<str>>>);
    let mut groups: std::collections::BTreeMap<u8, Group> = Default::default();
    if !m.paint.is_empty() {
        let paint_for_heads = |p: &str| -> Option<Box<str>> {
            let flat;
            let p = if mirrored {
                flat = crate::paint::reordered(p)?;
                flat.as_str()
            } else {
                p
            };
            crate::paint::renumber(p, |s| if s == 0 { 0 } else { head_of(s) + 1 }).map(Into::into)
        };
        for ((t, vol), p) in m.tris.into_iter().zip(m.volumes).zip(m.paint) {
            let g = groups.entry(head_of(vol)).or_default();
            g.0.push(t);
            g.1.push(p.as_deref().and_then(paint_for_heads));
        }
    } else if m.extruders.len() == m.tris.len() {
        for (t, e) in m.tris.into_iter().zip(m.extruders) {
            groups.entry(head_of(e)).or_default().0.push(t);
        }
    } else {
        groups.insert(head_of(1), (m.tris, Vec::new()));
    }
    groups
        .into_iter()
        .map(|(head, (tris, paint))| crate::write3mf::Part {
            name: format!("{name} — T{head}"),
            tris,
            extruder: head + 1,
            paint: if paint.iter().any(Option::is_some) { paint } else { Vec::new() },
        })
        .collect()
}

// ------------------------------------------------------------ orientation

/// Convex hull of an object, in its own frame (the display mesh's): used to
/// rest it exactly and compute its footprint.
pub fn hull(path: &Path, index: usize, piece: Option<usize>) -> Result<crate::orient::Hull> {
    let (m, _) = load(path, index, piece, 1_500_000)?;
    crate::orient::convex_hull(&crate::orient::unique_points(&m.tris))
}

/// Object to orient: the scale matters (it changes the face angles).
#[derive(Deserialize, Clone, Debug)]
pub struct OrientItem {
    pub path: String,
    pub item: usize,
    /// A piece of the object, once split (`pieces`).
    #[serde(default)]
    pub piece: Option<usize>,
    #[serde(default = "unit_scale")]
    pub scale: [f32; 3],
}

/// Rotation (rows) bringing the object's best direction upwards, following
/// Orca's rules (`orient.rs`), in the object's own frame.
pub fn orient(it: &OrientItem, threshold_deg: f64) -> Result<[[f64; 3]; 3]> {
    let (mut m, _) = load(Path::new(&it.path), it.item, it.piece, 300_000)?;
    let s = it.scale;
    for t in &mut m.tris {
        for v in &mut t.v {
            *v = [v[0] * s[0], v[1] * s[1], v[2] * s[2]];
        }
    }
    let up = crate::orient::best_up(&m.tris, threshold_deg)?;
    Ok(crate::orient::rotation_between(up, [0.0, 0.0, 1.0]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::Mat;

    fn cube(z0: f32, s: f32) -> Vec<Tri> {
        #[rustfmt::skip]
        let p = [
            [0., 0., z0], [s, 0., z0], [s, s, z0], [0., s, z0],
            [0., 0., z0 + s], [s, 0., z0 + s], [s, s, z0 + s], [0., s, z0 + s],
        ];
        #[rustfmt::skip]
        let f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
                 [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
        f.iter().map(|t| Tri { v: [p[t[0]], p[t[1]], p[t[2]]], c: [100, 100, 100] }).collect()
    }

    #[test]
    fn rotation_order_is_x_then_y_then_z() {
        // 90° around Z sends X onto Y.
        let r = rotation([0., 0., 90.]);
        let v = [r[0][0], r[1][0], r[2][0]];
        assert!((v[0]).abs() < 1e-6 && (v[1] - 1.0).abs() < 1e-6);
        // X then Z: the Y axis, rotated 90° around X, becomes Z; Z stays Z.
        let r = rotation([90., 0., 90.]);
        let y = [r[0][1], r[1][1], r[2][1]];
        assert!((y[2] - 1.0).abs() < 1e-6, "{y:?}");
    }

    #[test]
    fn placing_rests_the_object_on_the_bed() {
        let mut t = cube(-5.0, 10.0); // centered in Z on 0
        let it = SceneItem {
            path: String::new(),
            item: 0,
            name: "c".into(),
            pos: [100.0, 50.0],
            rot: [0.0, 0.0, 45.0],
            scale: [2.0, 2.0, 2.0],
            extruder_map: vec![],
            piece: None,
        };
        place(&mut t, &it);
        let zmin = t.iter().flat_map(|t| t.v).map(|v| v[2]).fold(f32::MAX, f32::min);
        let zmax = t.iter().flat_map(|t| t.v).map(|v| v[2]).fold(f32::MIN, f32::max);
        assert!(zmin.abs() < 1e-4, "rested: {zmin}");
        assert!((zmax - 20.0).abs() < 1e-3, "scale 2: {zmax}");
    }

    /// A scale per axis is applied in the object's own frame, before its
    /// rotation (as the Prepare view draws it).
    #[test]
    fn placing_honors_a_scale_per_axis() {
        let mut t = cube(-5.0, 10.0);
        let it = SceneItem {
            path: String::new(),
            item: 0,
            name: "c".into(),
            pos: [100.0, 50.0],
            rot: [0.0, 0.0, 90.0],
            scale: [2.0, 1.0, 0.5],
            extruder_map: vec![],
            piece: None,
        };
        place(&mut t, &it);
        let span = |k: usize| {
            let lo = t.iter().flat_map(|t| t.v).map(|v| v[k]).fold(f32::MAX, f32::min);
            let hi = t.iter().flat_map(|t| t.v).map(|v| v[k]).fold(f32::MIN, f32::max);
            hi - lo
        };
        // Turned 90° around Z: the object's X (×2) lies along Y.
        assert!((span(0) - 10.0).abs() < 1e-3, "x: {}", span(0));
        assert!((span(1) - 20.0).abs() < 1e-3, "y: {}", span(1));
        assert!((span(2) - 5.0).abs() < 1e-3, "z: {}", span(2));
    }

    /// A file of two objects, one on the plate, the other far away (a second
    /// plate): the second is left out, the first written in place.
    #[test]
    fn scene_keeps_bed_objects_and_skips_the_others() {
        let tmp = std::env::temp_dir().join("snapstudio-plate-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("two.3mf");
        crate::write3mf::write_scene(
            &src,
            &[
                crate::write3mf::SceneObject { name: "ici".into(), tris: cube(0., 10.), transform: Mat::IDENTITY, extruder: None },
                crate::write3mf::SceneObject { name: "far away".into(), tris: cube(0., 10.), transform: Mat::IDENTITY, extruder: None },
            ],
        )
        .unwrap();
        let found = items(&src).unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].size, [10.0, 10.0, 10.0]);

        let item = |i: usize, x: f32| SceneItem {
            path: src.to_string_lossy().to_string(),
            item: i,
            name: found[i].name.clone(),
            pos: [x, 100.0],
            rot: [0.0, 0.0, 30.0],
            scale: unit_scale(),
            extruder_map: vec![2],
            piece: None,
        };
        let out = tmp.join("scene.3mf");
        let w = write_scene(&[item(0, 100.0), item(1, 600.0)], &[], (270.0, 270.0), &out).unwrap();
        assert_eq!(w.kept, 1);
        assert_eq!(w.skipped, vec![found[1].name.clone()]);

        let mut zip = crate::model3mf::open(&out).unwrap();
        let m = crate::mesh::load_mesh(&mut zip, 10_000).unwrap();
        assert!((m.min[2]).abs() < 1e-3, "rested at Z = 0");
        let cx = (m.min[0] + m.max[0]) / 2.0;
        assert!((cx - 100.0).abs() < 0.01, "centered at X = 100: {cx}");
        assert!(m.extruders.iter().all(|e| *e == 3), "model extruder 1 → head 2");

        // An object sticking out stops slicing.
        let err = write_scene(&[item(0, 268.0)], &[], (270.0, 270.0), &out).unwrap_err();
        assert!(err.to_string().contains("sticks out"), "{err}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// A pillar's tube is closed: every edge is shared by exactly two
    /// triangles, in opposite directions (watertight, consistently wound),
    /// and faces outward (positive volume).
    #[test]
    fn a_pillar_tube_is_closed() {
        let t = tube(50.0, 60.0, 8.0, 6.0, 30.05);
        assert_eq!(t.len(), PILLAR_SIDES * 8);
        let key = |v: [f32; 3]| [(v[0] * 1000.0).round() as i64, (v[1] * 1000.0).round() as i64, (v[2] * 1000.0).round() as i64];
        let mut edges: std::collections::HashMap<([i64; 3], [i64; 3]), i32> = Default::default();
        let mut vol = 0.0f64;
        for tri in &t {
            for i in 0..3 {
                let (a, b) = (key(tri.v[i]), key(tri.v[(i + 1) % 3]));
                *edges.entry((a, b)).or_default() += 1;
            }
            let [a, b, c] = tri.v.map(|p| p.map(|x| x as f64));
            vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0;
        }
        for (&(a, b), &n) in &edges {
            assert_eq!(n, 1, "each directed edge once");
            assert_eq!(edges.get(&(b, a)), Some(&1), "and its reverse once");
        }
        let n = PILLAR_SIDES as f64;
        let ring = |r: f64| n / 2.0 * r * r * (std::f64::consts::TAU / n).sin();
        let want = (ring(8.0) - ring(6.0)) * 30.05;
        assert!((vol - want).abs() < want * 1e-3, "outward: {vol} vs {want}");
    }

    fn pillar(x: f32, y: f32) -> Pillar {
        Pillar {
            name: "Prime tower · PLA".into(),
            x,
            y,
            rings: vec![Ring { head: 1, d_out: 16.0, d_in: 12.0, h: 30.05 }, Ring { head: 0, d_out: 12.0, d_in: 8.0, h: 10.05 }],
            brim: 3.0,
        }
    }

    /// The engine's 3MF: the pillars first, one part per ring on its head,
    /// walls-only settings; then the user's objects. A pillar off the plate
    /// stops the slice, as a part does.
    #[test]
    fn pillars_go_first_in_the_engines_plate() {
        let tmp = std::env::temp_dir().join("snapstudio-plate-pillars");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("one.3mf");
        crate::write3mf::write_scene(
            &src,
            &[crate::write3mf::SceneObject { name: "a".into(), tris: cube(0., 10.), transform: Mat::IDENTITY, extruder: None }],
        )
        .unwrap();
        let item = SceneItem {
            path: src.to_string_lossy().to_string(),
            item: 0,
            name: "part".into(),
            pos: [135.0, 135.0],
            rot: [0.0; 3],
            scale: unit_scale(),
            extruder_map: vec![2],
            piece: None,
        };
        let out = tmp.join("scene.3mf");
        let w = write_scene(std::slice::from_ref(&item), &[pillar(20.0, 250.0)], (270.0, 270.0), &out).unwrap();
        assert_eq!(w.kept, 1, "the user's objects only");
        let mut zip = crate::model3mf::open(&out).unwrap();
        let cfg = String::from_utf8(crate::model3mf::read_entry(&mut zip, "Metadata/model_settings.config").unwrap()).unwrap();
        let blocks: Vec<&str> = cfg.split("<object ").skip(1).collect();
        assert_eq!(blocks.len(), 2);
        assert!(blocks[0].contains("Prime tower · PLA"), "the pillar first: {cfg}");
        for kv in [
            "sparse_infill_density\" value=\"0%",
            "top_shell_layers\" value=\"0",
            "bottom_shell_layers\" value=\"0",
            "wall_loops\" value=\"2",
            "brim_type\" value=\"outer_only",
            "enable_support\" value=\"0",
        ] {
            assert!(blocks[0].contains(kv), "{kv}: {cfg}");
        }
        assert!(blocks[0].contains(r#"<metadata key="extruder" value="2"/>"#), "the outer ring's head: {cfg}");
        assert!(blocks[1].contains("part") && !blocks[1].contains("sparse_infill_density"));
        let m = crate::mesh::load_mesh(&mut zip, 100_000).unwrap();
        let mut heads = m.extruders.clone();
        heads.dedup();
        assert_eq!(heads, vec![2, 1, 3], "outer ring T1, inner ring T0, then the part on T2");
        // Each ring as tall as its head's last layer.
        let top =
            |e: u8| m.tris.iter().zip(&m.extruders).filter(|(_, x)| **x == e).flat_map(|(t, _)| t.v.map(|v| v[2])).fold(0.0f32, f32::max);
        assert!((top(2) - 30.05).abs() < 1e-3 && (top(1) - 10.05).abs() < 1e-3, "{} {}", top(2), top(1));
        // Off the plate, or a ring that makes no sense: refused.
        let err = write_scene(std::slice::from_ref(&item), &[pillar(5.0, 250.0)], (270.0, 270.0), &out).unwrap_err();
        assert!(err.to_string().contains("sticks out"), "{err}");
        let mut bad = pillar(50.0, 50.0);
        bad.rings[0].d_in = 20.0;
        assert!(write_scene(std::slice::from_ref(&item), &[bad], (270.0, 270.0), &out).is_err());
        // Pillars alone are not a plate.
        let far = SceneItem { pos: [900.0, 900.0], ..item };
        assert!(write_scene(&[far], &[pillar(20.0, 250.0)], (270.0, 270.0), &out).is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// A saved plate holds only the user's parts, and Snap Studio's tower
    /// data beside Orca's; read back only from a file Snap Studio wrote.
    #[test]
    fn saved_plate_keeps_its_tower_data_not_its_pillars() {
        let tmp = std::env::temp_dir().join("snapstudio-plate-snaptower");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("one.3mf");
        crate::write3mf::write_scene(
            &src,
            &[crate::write3mf::SceneObject { name: "a".into(), tris: cube(0., 10.), transform: Mat::IDENTITY, extruder: None }],
        )
        .unwrap();
        let item = SceneItem {
            path: src.to_string_lossy().to_string(),
            item: 0,
            name: "a".into(),
            pos: [100.0, 100.0],
            rot: [0.0; 3],
            scale: unit_scale(),
            extruder_map: vec![],
            piece: None,
        };
        let out = tmp.join("saved.3mf");
        let place = TowerPlace { on: true, x: 15.0, y: 220.0, rot: 0.0 };
        let snap = serde_json::json!({ "kind": "material", "row": { "rot": 90 }, "groups": { "PLA": { "split": true } }, "pillars": { "PLA/T0": { "x": 20, "y": 30, "moved": false } } });
        save_scene(std::slice::from_ref(&item), Some(place), None, Some(&snap), &out).unwrap();
        assert_eq!(items(&out).unwrap().len(), 1, "no pillar in the project");
        assert_eq!(tower_of(&out), Some(FileTower { place: Some(place), ours: true, snap: Some(snap.clone()), smooth_mix: None }));
        // The data alone (the switch off): still read.
        save_scene(std::slice::from_ref(&item), None, None, Some(&snap), &out).unwrap();
        assert_eq!(tower_of(&out), Some(FileTower { place: None, ours: true, snap: Some(snap.clone()), smooth_mix: None }));
        // Another application's file: its tower, never our data.
        let foreign = tmp.join("orca.3mf");
        save_scene(std::slice::from_ref(&item), Some(place), None, Some(&snap), &out).unwrap();
        {
            let mut zin = zip::ZipArchive::new(std::fs::File::open(&out).unwrap()).unwrap();
            let mut zout = zip::ZipWriter::new(std::fs::File::create(&foreign).unwrap());
            for i in 0..zin.len() {
                let mut f = zin.by_index(i).unwrap();
                let name = f.name().to_string();
                let mut data = Vec::new();
                std::io::Read::read_to_end(&mut f, &mut data).unwrap();
                if name == "3D/3dmodel.model" {
                    data = String::from_utf8(data).unwrap().replace("Snap Studio", "OrcaSlicer").into_bytes();
                }
                zout.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
                std::io::Write::write_all(&mut zout, &data).unwrap();
            }
            zout.finish().unwrap();
        }
        assert_eq!(tower_of(&foreign), Some(FileTower { place: Some(place), ours: false, snap: None, smooth_mix: None }));
        // Smooth mix, for a plate with a virtual head: Orca's keys in the
        // project's settings, on or off, read back from our files only.
        save_scene(std::slice::from_ref(&item), Some(place), Some(true), None, &out).unwrap();
        let mut zip = crate::model3mf::open(&out).unwrap();
        let cfg: serde_json::Value = serde_json::from_slice(&crate::model3mf::read_entry(&mut zip, PROJECT_SETTINGS).unwrap()).unwrap();
        for k in crate::slice::SMOOTH_MIX_OVERRIDES {
            assert_eq!(cfg[k], "1", "{k}");
        }
        assert_eq!(cfg["wipe_tower_x"], serde_json::json!(["15.000"]), "next to the tower's");
        assert_eq!(tower_of(&out).unwrap().smooth_mix, Some(true));
        save_scene(std::slice::from_ref(&item), None, Some(false), None, &out).unwrap();
        assert_eq!(tower_of(&out), Some(FileTower { place: None, ours: true, snap: None, smooth_mix: Some(false) }));
        save_scene(std::slice::from_ref(&item), None, None, None, &out).unwrap();
        assert_eq!(tower_of(&out), None, "no virtual head: nothing saved");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// An object on a virtual head (head 4 on a 4-head printer) is written
    /// on extruder 5: the engine's first mixed filament.
    #[test]
    fn a_virtual_head_is_written_after_the_physical_ones() {
        let tmp = std::env::temp_dir().join("snapstudio-plate-virtual");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("one.3mf");
        crate::write3mf::write_scene(
            &src,
            &[crate::write3mf::SceneObject { name: "a".into(), tris: cube(0., 10.), transform: Mat::IDENTITY, extruder: None }],
        )
        .unwrap();
        let item = SceneItem {
            path: src.to_string_lossy().to_string(),
            item: 0,
            name: "a".into(),
            pos: [100.0, 100.0],
            rot: [0.0; 3],
            scale: unit_scale(),
            extruder_map: vec![4],
            piece: None,
        };
        let out = tmp.join("scene.3mf");
        write_scene(&[item], &[], (270.0, 270.0), &out).unwrap();
        let mut zip = crate::model3mf::open(&out).unwrap();
        let m = crate::mesh::load_mesh(&mut zip, 10_000).unwrap();
        assert!(!m.extruders.is_empty() && m.extruders.iter().all(|e| *e == 5), "{:?}", &m.extruders[..m.extruders.len().min(4)]);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// A saved plate keeps its prime tower where Orca does (the project's
    /// settings), and reads it back, saying it is ours; without one, none.
    #[test]
    fn saved_plate_keeps_its_tower() {
        let tmp = std::env::temp_dir().join("snapstudio-plate-tower");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("one.3mf");
        crate::write3mf::write_scene(
            &src,
            &[crate::write3mf::SceneObject { name: "a".into(), tris: cube(0., 10.), transform: Mat::IDENTITY, extruder: None }],
        )
        .unwrap();
        let item = SceneItem {
            path: src.to_string_lossy().to_string(),
            item: 0,
            name: "a".into(),
            pos: [100.0, 100.0],
            rot: [0.0; 3],
            scale: unit_scale(),
            extruder_map: vec![],
            piece: None,
        };
        let out = tmp.join("saved.3mf");
        let place = TowerPlace { on: true, x: 12.5, y: 210.25, rot: 90.0 };
        save_scene(std::slice::from_ref(&item), Some(place), None, None, &out).unwrap();
        assert_eq!(tower_of(&out), Some(FileTower { place: Some(place), ours: true, snap: None, smooth_mix: None }));
        assert_eq!(items(&out).unwrap().len(), 1, "the objects still read");
        let mut zip = crate::model3mf::open(&out).unwrap();
        let cfg: serde_json::Value = serde_json::from_slice(&crate::model3mf::read_entry(&mut zip, PROJECT_SETTINGS).unwrap()).unwrap();
        assert_eq!(cfg["wipe_tower_x"], serde_json::json!(["12.500"]), "one per plate, as Orca");
        save_scene(&[item], None, None, None, &out).unwrap();
        assert_eq!(tower_of(&out), None);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// A painted object goes to the engine with its painting, states
    /// renumbered to the heads chosen, geometry in one piece per volume.
    #[test]
    fn scene_keeps_painting_on_the_chosen_heads() {
        let dir = std::env::temp_dir().join("snapstudio_paint_scene");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("cube.3mf");
        // Volume on extruder 4; painted 5, 2, split (3 3 3 6), and 0.
        crate::mesh::testkit::painted_cube(&src, &["2C", "8", "3C0C0C0C3", "0"], Some(4));
        let scene = |scale: [f32; 3]| {
            vec![SceneItem {
                path: src.to_string_lossy().to_string(),
                item: 0,
                name: "cube".into(),
                pos: [100.0, 100.0],
                rot: [0.0, 0.0, 0.0],
                scale,
                // Colors 1…6 → T0 T1 T2 T3 T0 T1.
                extruder_map: vec![0, 1, 2, 3, 0, 1],
                piece: None,
            }]
        };
        let read_back = |dst: &Path| {
            let mut z = crate::model3mf::open(dst).unwrap();
            let settings = crate::model3mf::extruder_settings(&mut z);
            let m = crate::mesh::load_mesh(&mut z, usize::MAX).unwrap();
            (settings, m)
        };

        let dst = dir.join("scene.3mf");
        write_scene(&scene([1.0; 3]), &[], (270.0, 270.0), &dst).unwrap();
        let (settings, m) = read_back(&dst);
        // One part, on the head of extruder 4 (T3, written 4).
        let parts: Vec<u8> = settings.values().flat_map(|(_, p)| p.values().copied()).collect();
        assert_eq!(parts, vec![4]);
        assert_eq!(m.tris.len(), 12);
        // 5 → T0 (1), 2 → T1 (2), split 3 3 3 6 → 3 3 3 2, 0 stays.
        assert_eq!(m.paint[0].as_deref(), Some("4"));
        assert_eq!(m.paint[1].as_deref(), Some("8"));
        assert_eq!(crate::paint::states(m.paint[2].as_deref().unwrap()), vec![2, 3]);
        assert!(crate::paint::is_split(m.paint[2].as_deref().unwrap()));
        assert_eq!(m.paint[3].as_deref(), Some("0"));
        assert_eq!(&m.extruders[..5], &[1, 2, 3, 4, 4]);

        // Mirrored: the split triangle becomes its dominant color.
        write_scene(&scene([-1.0, 1.0, 1.0]), &[], (270.0, 270.0), &dst).unwrap();
        let (_, m) = read_back(&dst);
        assert_eq!(m.paint[2].as_deref(), Some(crate::paint::whole(3).as_str()));
        assert_eq!(m.paint[0].as_deref(), Some("4"));
    }

    /// Two separate cubes in one object, the second painted with filament 2.
    fn two_cubes(dst: &Path) {
        let cube = |x: f32| -> Vec<Tri> {
            #[rustfmt::skip]
            let p = [[0., 0., 0.], [10., 0., 0.], [10., 10., 0.], [0., 10., 0.], [0., 0., 10.], [10., 0., 10.], [10., 10., 10.], [0., 10., 10.]];
            #[rustfmt::skip]
            let f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
            f.iter()
                .map(|t| Tri {
                    v: [t[0], t[1], t[2]].map(|i: usize| {
                        let v: [f32; 3] = p[i];
                        [v[0] + x, v[1], v[2]]
                    }),
                    c: [200, 200, 200],
                })
                .collect()
        };
        let mut tris = cube(0.0);
        tris.extend(cube(30.0));
        let paint = (0..24).map(|i| (i >= 12).then(|| crate::paint::whole(2).into())).collect();
        let part = crate::write3mf::Part { name: "two".into(), tris, extruder: 1, paint };
        crate::write3mf::write_multipart(dst, "two", &[part], &crate::mesh::Mat::IDENTITY).unwrap();
    }

    #[test]
    fn an_object_splits_into_its_pieces() {
        let dir = std::env::temp_dir().join("snapstudio_pieces");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("two.3mf");
        two_cubes(&src);
        let p = pieces(&src, 0, None).unwrap();
        assert_eq!(p.len(), 2);
        assert_eq!((p[0].piece, p[1].piece), (0, 1));
        assert_eq!((p[0].triangles, p[1].triangles), (12, 12));
        // The object is 40 mm wide: its pieces sit 15 mm either side.
        assert!((p[0].offset[0] + 15.0).abs() < 1e-3 && (p[1].offset[0] - 15.0).abs() < 1e-3);
        assert_eq!(p[0].size, [10.0, 10.0, 10.0]);
        assert_eq!((p[0].extruders.clone(), p[1].extruders.clone()), (vec![1], vec![2]));

        // One piece alone: centered on itself, its painting kept.
        let (m, c) = load(&src, 0, Some(1), FULL_BUDGET).unwrap();
        assert_eq!(m.tris.len(), 12);
        assert_eq!((m.min, m.max), ([-5.0; 3], [5.0; 3]));
        assert!((c[0] - 35.0).abs() < 1e-3, "center in the file: {c:?}");
        assert!(m.paint.iter().all(|p| p.as_deref() == Some("8")));
        // A piece split again is itself.
        let again = pieces(&src, 0, Some(1)).unwrap();
        assert_eq!((again.len(), again[0].piece), (1, 1));
        assert!(load(&src, 0, Some(2), FULL_BUDGET).is_err());

        // On the plate, then to the engine: two objects, painting with the second.
        let item = |piece: usize, x: f32| SceneItem {
            path: src.to_string_lossy().to_string(),
            item: 0,
            name: format!("two {piece}"),
            pos: [x, 100.0],
            rot: [0.0; 3],
            scale: [1.0; 3],
            extruder_map: vec![0, 1],
            piece: Some(piece),
        };
        let dst = dir.join("scene.3mf");
        write_scene(&[item(0, 60.0), item(1, 120.0)], &[], (270.0, 270.0), &dst).unwrap();
        let mut z = crate::model3mf::open(&dst).unwrap();
        let built = crate::mesh::build_items(&mut z).unwrap();
        assert_eq!(built.len(), 2);
        let a = crate::mesh::load_item(&mut z, 0, usize::MAX).unwrap().mesh;
        let b = crate::mesh::load_item(&mut z, 1, usize::MAX).unwrap().mesh;
        assert_eq!((a.tris.len(), b.tris.len()), (12, 12));
        assert!(a.paint.is_empty());
        assert_eq!(b.extruders, vec![2; 12], "color 2 → T1, written 2");
    }
}

#[cfg(test)]
mod hex_tests {
    use super::hex_rgb;

    #[test]
    fn colours_cut_safely() {
        assert_eq!(hex_rgb("#ff8000"), Some([255, 128, 0]));
        assert_eq!(hex_rgb("ff8000ff"), Some([255, 128, 0]));
        assert_eq!(hex_rgb("#aaaaaé"), None);
        assert_eq!(hex_rgb("#abc"), None);
    }
}
