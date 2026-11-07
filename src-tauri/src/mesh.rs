//! Reading 3MF geometry (core + multi-file "production" extension).

use crate::model3mf::{read_entry, Zip};
use anyhow::{anyhow, Result};
use quick_xml::events::Event;
use std::collections::HashMap;

/// 3MF 4x3 matrix: row 3 = translation, point' = [x y z 1] * M.
#[derive(Clone, Copy, Debug)]
pub struct Mat(pub [f32; 12]);

impl Mat {
    pub const IDENTITY: Mat = Mat([1., 0., 0., 0., 1., 0., 0., 0., 1., 0., 0., 0.]);

    fn parse(s: &str) -> Mat {
        let mut m = Mat::IDENTITY;
        for (i, tok) in s.split_whitespace().take(12).enumerate() {
            m.0[i] = tok.parse().unwrap_or(m.0[i]);
        }
        m
    }

    #[inline]
    fn apply(&self, p: [f32; 3]) -> [f32; 3] {
        let m = &self.0;
        [
            p[0] * m[0] + p[1] * m[3] + p[2] * m[6] + m[9],
            p[0] * m[1] + p[1] * m[4] + p[2] * m[7] + m[10],
            p[0] * m[2] + p[1] * m[5] + p[2] * m[8] + m[11],
        ]
    }

    /// Determinant of the linear part: negative for a mirroring transform.
    fn det(&self) -> f32 {
        let m = &self.0;
        m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])
    }

    /// `self` applied first, then `parent`.
    fn then(&self, parent: &Mat) -> Mat {
        let (c, p) = (&self.0, &parent.0);
        let mut o = [0f32; 12];
        for i in 0..3 {
            for j in 0..3 {
                o[i * 3 + j] = c[i * 3] * p[j] + c[i * 3 + 1] * p[3 + j] + c[i * 3 + 2] * p[6 + j];
            }
        }
        for j in 0..3 {
            o[9 + j] = c[9] * p[j] + c[10] * p[3 + j] + c[11] * p[6 + j] + p[9 + j];
        }
        Mat(o)
    }
}

#[derive(Default)]
struct Obj {
    verts: Vec<[f32; 3]>,
    tris: Vec<[u32; 3]>,
    /// Optional color per triangle (p1 attribute -> material group).
    tri_colors: Vec<Option<[u8; 3]>>,
    /// Multicolor painting per triangle (`paint.rs`); empty when the object
    /// has none, shorter than `tris` when its last triangles have none.
    paint: Vec<Option<Box<str>>>,
    color: Option<[u8; 3]>,
    components: Vec<(Option<String>, u32, Mat)>,
}

#[derive(Default)]
struct Part {
    objects: HashMap<u32, Obj>,
    build: Vec<(u32, Mat, Option<String>)>,
}

#[derive(Clone, Copy)]
pub struct Tri {
    pub v: [[f32; 3]; 3],
    pub c: [u8; 3],
}

#[derive(Default)]
pub struct MeshData {
    pub tris: Vec<Tri>,
    pub min: [f32; 3],
    pub max: [f32; 3],
    pub truncated: bool,
    /// Model color of each triangle (1 to 16): its dominant painted
    /// filament, otherwise its volume's extruder (`model_settings.config`).
    /// Empty when the file declares neither.
    pub extruders: Vec<u8>,
    /// Painted meshes only (both empty otherwise): the extruder of each
    /// triangle's volume, and its painting as read.
    pub volumes: Vec<u8>,
    pub paint: Vec<Option<Box<str>>>,
}

impl MeshData {
    pub fn size(&self) -> [f32; 3] {
        [self.max[0] - self.min[0], self.max[1] - self.min[1], self.max[2] - self.min[2]]
    }
}

fn parse_color(s: &str) -> Option<[u8; 3]> {
    let s = s.trim().trim_start_matches('#');
    // `get`: a non-ASCII character at a cut gives None, not a panic.
    Some([
        u8::from_str_radix(s.get(0..2)?, 16).ok()?,
        u8::from_str_radix(s.get(2..4)?, 16).ok()?,
        u8::from_str_radix(s.get(4..6)?, 16).ok()?,
    ])
}

/// Parses a .model file (root or external object).
fn parse_part(data: &[u8]) -> Part {
    let mut part = Part::default();
    let mut reader = quick_xml::Reader::from_reader(data);
    reader.config_mut().trim_text(true);
    reader.config_mut().check_end_names = false;
    let mut buf = Vec::new();

    // Color groups: id -> palette
    let mut groups: HashMap<u32, Vec<[u8; 3]>> = HashMap::new();
    let mut cur_group: Option<u32> = None;

    let mut cur_id: Option<u32> = None;
    let mut cur = Obj::default();
    let mut cur_pid: Option<u32> = None;
    let mut cur_pindex: usize = 0;
    let mut pending_tri_refs: Vec<(usize, u32, u32)> = Vec::new(); // (index triangle, pid, p1)

    loop {
        let ev = reader.read_event_into(&mut buf);
        let empty = matches!(&ev, Ok(Event::Empty(_)));
        match ev {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                match e.local_name().as_ref() {
                    "basematerials" | "colorgroup" => {
                        let mut id = None;
                        for a in e.attributes().flatten() {
                            if a.key.local_name().as_ref() == "id" {
                                id = crate::model3mf::aval(&a).parse::<u32>().ok();
                            }
                        }
                        cur_group = id;
                        if let Some(id) = id {
                            groups.entry(id).or_default();
                        }
                    }
                    "base" | "color" => {
                        if let Some(g) = cur_group {
                            let mut col = None;
                            for a in e.attributes().flatten() {
                                let k = a.key.local_name();
                                if k.as_ref() == "displaycolor" || k.as_ref() == "color" {
                                    col = parse_color(&crate::model3mf::aval(&a));
                                }
                            }
                            groups.entry(g).or_default().push(col.unwrap_or([200, 200, 205]));
                        }
                    }
                    "object" => {
                        cur = Obj::default();
                        pending_tri_refs.clear();
                        cur_pid = None;
                        cur_pindex = 0;
                        for a in e.attributes().flatten() {
                            let v = crate::model3mf::aval(&a);
                            match a.key.local_name().as_ref() {
                                "id" => cur_id = v.parse().ok(),
                                "pid" => cur_pid = v.parse().ok(),
                                "pindex" => cur_pindex = v.parse().unwrap_or(0),
                                _ => {}
                            }
                        }
                    }
                    "vertex" => {
                        let (mut x, mut y, mut z) = (0f32, 0f32, 0f32);
                        for a in e.attributes().flatten() {
                            let v = crate::model3mf::aval(&a);
                            match a.key.local_name().as_ref() {
                                "x" => x = v.parse().unwrap_or(0.),
                                "y" => y = v.parse().unwrap_or(0.),
                                "z" => z = v.parse().unwrap_or(0.),
                                _ => {}
                            }
                        }
                        cur.verts.push([x, y, z]);
                    }
                    "triangle" => {
                        let (mut a1, mut a2, mut a3) = (0u32, 0u32, 0u32);
                        let (mut pid, mut p1, mut paint) = (None, None, None);
                        for a in e.attributes().flatten() {
                            let v = crate::model3mf::aval(&a);
                            match a.key.local_name().as_ref() {
                                "v1" => a1 = v.parse().unwrap_or(0),
                                "v2" => a2 = v.parse().unwrap_or(0),
                                "v3" => a3 = v.parse().unwrap_or(0),
                                "pid" => pid = v.parse::<u32>().ok(),
                                "p1" => p1 = v.parse::<u32>().ok(),
                                // Bambu Studio and Orca; PrusaSlicer's is `slic3rpe:mmu_segmentation`.
                                "paint_color" | "mmu_segmentation" if !v.is_empty() => paint = Some(v.into()),
                                _ => {}
                            }
                        }
                        let idx = cur.tris.len();
                        cur.tris.push([a1, a2, a3]);
                        cur.tri_colors.push(None);
                        if let Some(p) = paint {
                            cur.paint.resize(idx, None);
                            cur.paint.push(Some(p));
                        }
                        if let (Some(pid), Some(p1)) = (pid.or(cur_pid), p1) {
                            pending_tri_refs.push((idx, pid, p1));
                        }
                    }
                    "component" => {
                        let (mut objectid, mut path, mut xf) = (0u32, None, Mat::IDENTITY);
                        for a in e.attributes().flatten() {
                            let v = crate::model3mf::aval(&a);
                            match a.key.local_name().as_ref() {
                                "objectid" => objectid = v.parse().unwrap_or(0),
                                "path" => path = Some(v.to_string()),
                                "transform" => xf = Mat::parse(&v),
                                _ => {}
                            }
                        }
                        cur.components.push((path, objectid, xf));
                    }
                    "item" => {
                        let (mut objectid, mut xf, mut path) = (0u32, Mat::IDENTITY, None);
                        for a in e.attributes().flatten() {
                            let v = crate::model3mf::aval(&a);
                            match a.key.local_name().as_ref() {
                                "objectid" => objectid = v.parse().unwrap_or(0),
                                "transform" => xf = Mat::parse(&v),
                                "path" => path = Some(v.to_string()),
                                _ => {}
                            }
                        }
                        part.build.push((objectid, xf, path));
                    }
                    _ => {}
                }
                if empty {
                    if matches!(e.local_name().as_ref(), "basematerials" | "colorgroup") {
                        cur_group = None;
                    }
                }
            }
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                "basematerials" | "colorgroup" => cur_group = None,
                "object" => {
                    if let Some(id) = cur_id.take() {
                        // Colors resolved here, from the groups read so far: a
                        // group declared after the object (never seen from a
                        // slicer; the spec puts resources before their use)
                        // would leave the object uncolored.
                        let mut obj = std::mem::take(&mut cur);
                        obj.color = cur_pid.and_then(|pid| groups.get(&pid)).and_then(|g| g.get(cur_pindex).copied());
                        for (ti, pid, p1) in pending_tri_refs.drain(..) {
                            if let Some(c) = groups.get(&pid).and_then(|g| g.get(p1 as usize)) {
                                obj.tri_colors[ti] = Some(*c);
                            }
                        }
                        part.objects.insert(id, obj);
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    part
}

/// An object occurrence in the scene, already resolved (file, id, transform).
struct Inst {
    part_key: String,
    objid: u32,
    /// `<build>` object this occurrence comes from.
    root: u32,
    xf: Mat,
    color: Option<[u8; 3]>,
}

struct Ctx<'a> {
    zip: &'a mut Zip,
    parts: HashMap<String, Part>,
}

impl<'a> Ctx<'a> {
    /// Loads a .model file of the container (only once).
    fn part(&mut self, key: &str) -> bool {
        if self.parts.contains_key(key) {
            return true;
        }
        let Some(data) = read_entry(self.zip, key.trim_start_matches('/')) else {
            return false;
        };
        self.parts.insert(key.to_string(), parse_part(&data));
        true
    }

    /// Resolves components recursively without touching the meshes.
    #[allow(clippy::too_many_arguments)]
    fn collect(&mut self, part_key: &str, objid: u32, root: u32, xf: Mat, inherited: Option<[u8; 3]>, depth: u32, out: &mut Vec<Inst>) {
        if depth > 12 || out.len() > 100_000 {
            return;
        }
        if !self.part(part_key) {
            return;
        }
        let Some(obj) = self.parts.get(part_key).and_then(|p| p.objects.get(&objid)) else {
            return;
        };
        let color = obj.color.or(inherited);
        let has_mesh = !obj.tris.is_empty();
        let components = obj.components.clone();
        if has_mesh {
            out.push(Inst { part_key: part_key.to_string(), objid, root, xf, color });
        }
        for (path, id, cxf) in components {
            let key = path.unwrap_or_else(|| part_key.to_string());
            self.collect(&key, id, root, cxf.then(&xf), color, depth + 1, out);
        }
    }
}

/// Loads and flattens the 3MF file's geometry.
pub fn load_mesh(zip: &mut Zip, budget: usize) -> Result<MeshData> {
    let root_key = "3D/3dmodel.model".to_string();
    let mut ctx = Ctx { zip, parts: HashMap::new() };
    if !ctx.part(&root_key) {
        return Err(anyhow!(crate::t!("err.no_model")));
    }

    // 1. Scene resolution: which objects, where, in what color.
    let build: Vec<(u32, Mat, Option<String>)> = ctx.parts.get(&root_key).map(|p| p.build.clone()).unwrap_or_default();
    let mut insts = Vec::new();
    if build.is_empty() {
        // Some exports have no <build>: take all the objects.
        let ids: Vec<u32> = ctx.parts.get(&root_key).map(|p| p.objects.keys().copied().collect()).unwrap_or_default();
        for id in ids {
            ctx.collect(&root_key, id, id, Mat::IDENTITY, None, 0, &mut insts);
        }
    } else {
        for (id, xf, path) in build {
            let key = path.unwrap_or_else(|| root_key.clone());
            ctx.collect(&key, id, id, xf, None, 0, &mut insts);
        }
    }

    emit(&mut ctx, &insts, budget)
}

/// Emits the transformed triangles of the occurrences, without copying meshes.
/// Above this many triangles a mesh is not read whole: one in so many is
/// kept, to stay within memory (the mesh is marked truncated, and slicing
/// refuses it). Below, the whole mesh is read and, for display, decimated.
const READ_CAP: usize = 8_000_000;

fn emit(ctx: &mut Ctx<'_>, insts: &[Inst], budget: usize) -> Result<MeshData> {
    let total: usize = insts.iter().filter_map(|i| ctx.parts.get(&i.part_key)?.objects.get(&i.objid)).map(|o| o.tris.len()).sum();
    let cap = budget.max(READ_CAP);
    let step = if total > cap { (total as f32 / cap as f32).ceil() as usize } else { 1 };
    let mut tris: Vec<Tri> = Vec::with_capacity(total.min(cap) + 8);
    // Extruder of each occurrence: the part's, otherwise the object's.
    let settings = crate::model3mf::extruder_settings(ctx.zip);
    let painted =
        insts.iter().filter_map(|i| ctx.parts.get(&i.part_key)?.objects.get(&i.objid)).any(|o| o.paint.iter().any(Option::is_some));
    let mut extruders: Vec<u8> = Vec::new();
    let mut volumes: Vec<u8> = Vec::new();
    let mut paint: Vec<Option<Box<str>>> = Vec::new();
    let mut min = [f32::MAX; 3];
    let mut max = [f32::MIN; 3];
    for inst in insts {
        let Some(obj) = ctx.parts.get(&inst.part_key).and_then(|p| p.objects.get(&inst.objid)) else {
            continue;
        };
        let base = inst.color;
        let ext = settings.get(&inst.root).map(|(obj, parts)| parts.get(&inst.objid).copied().filter(|e| *e > 0).unwrap_or(*obj).max(1));
        // A painted mesh needs a model color for every triangle: extruder 1
        // stands for an undeclared volume, as in the slicers.
        let ext = ext.or(painted.then_some(1));
        // A mirroring placement (an object mirrored in its slicer) turns the
        // faces inside out: their winding is restored, and the slicer would
        // otherwise flip them itself — moving split painting either way.
        let mirrored = inst.xf.det() < 0.0;
        for (i, t) in obj.tris.iter().enumerate() {
            // Beyond what memory allows, sample rather than stop: the
            // silhouette stays right (and the mesh says it is incomplete).
            if step > 1 && i % step != 0 {
                continue;
            }
            let (a, b, c) = (t[0] as usize, t[1] as usize, t[2] as usize);
            if a >= obj.verts.len() || b >= obj.verts.len() || c >= obj.verts.len() {
                continue;
            }
            let mut v = [inst.xf.apply(obj.verts[a]), inst.xf.apply(obj.verts[b]), inst.xf.apply(obj.verts[c])];
            if mirrored {
                v.swap(1, 2);
            }
            for p in &v {
                for k in 0..3 {
                    min[k] = min[k].min(p[k]);
                    max[k] = max[k].max(p[k]);
                }
            }
            tris.push(Tri { v, c: obj.tri_colors[i].or(base).unwrap_or(crate::render::DEFAULT_COLOR) });
            if let Some(e) = ext {
                let p = obj.paint.get(i).and_then(Option::as_deref).and_then(|p| {
                    if mirrored {
                        crate::paint::reordered(p).map(Into::into)
                    } else {
                        Some(p.into())
                    }
                });
                // State 0 is the volume's own extruder.
                let shown = p.as_deref().and_then(crate::paint::dominant).filter(|s| *s > 0).unwrap_or(e);
                extruders.resize(tris.len() - 1, 1);
                extruders.push(shown);
                if painted {
                    volumes.push(e);
                    paint.push(p);
                }
            }
        }
    }

    if tris.is_empty() {
        return Err(anyhow!(crate::t!("err.no_geometry")));
    }
    // Occurrences without a setting are attached to extruder 1.
    if !extruders.is_empty() {
        extruders.resize(tris.len(), 1);
    }
    let mut m = MeshData { extruders, volumes, paint, tris, min, max, truncated: step > 1 };
    downsample(&mut m, budget);
    Ok(m)
}

/// Every model color a mesh uses: its triangles' and, for painted ones, each
/// state of their painting — a fine stroke inside a split triangle never
/// dominates it, yet needs a head.
pub fn colors_used(m: &MeshData) -> Vec<u8> {
    let mut used: Vec<u8> = m.extruders.clone();
    for (p, vol) in m.paint.iter().zip(&m.volumes) {
        if let Some(p) = p {
            used.extend(crate::paint::states(p).into_iter().map(|s| if s == 0 { *vol } else { s }));
        }
    }
    used.sort_unstable();
    used.dedup();
    used
}

/// An occurrence of the `<build>`: object, placement in the scene.
#[derive(Clone, Copy, Debug)]
pub struct BuildItem {
    pub objid: u32,
    pub xf: Mat,
}

const ROOT_KEY: &str = "3D/3dmodel.model";

/// Occurrences of the main model's `<build>`, in file order (the tests'
/// view of it; the app goes through `root_items`).
#[cfg(test)]
pub fn build_items(zip: &mut Zip) -> Result<Vec<BuildItem>> {
    let mut ctx = Ctx { zip, parts: HashMap::new() };
    root_items(&mut ctx)
}

/// The root part parsed (once per context) and its occurrences.
fn root_items(ctx: &mut Ctx) -> Result<Vec<BuildItem>> {
    if !ctx.part(ROOT_KEY) {
        return Err(anyhow!(crate::t!("err.no_model")));
    }
    let part = ctx.parts.get(ROOT_KEY).unwrap();
    let mut items: Vec<BuildItem> = part.build.iter().map(|(id, xf, _)| BuildItem { objid: *id, xf: *xf }).collect();
    if items.is_empty() {
        let mut ids: Vec<u32> = part.objects.keys().copied().collect();
        ids.sort_unstable();
        items = ids.into_iter().map(|objid| BuildItem { objid, xf: Mat::IDENTITY }).collect();
    }
    Ok(items)
}

/// An object of the `<build>`, isolated for the plate.
pub struct ItemMesh {
    /// Triangles centered on the bounding box center, oriented as in the file
    /// (the linear part of the placement is applied).
    pub mesh: MeshData,
    /// Position of the center in the file's scene.
    pub center: [f32; 3],
}

/// Loads occurrence `index` of the `<build>`, in its own frame.
pub fn load_item(zip: &mut Zip, index: usize, budget: usize) -> Result<ItemMesh> {
    let mut ctx = Ctx { zip, parts: HashMap::new() };
    let item = *root_items(&mut ctx)?.get(index).ok_or_else(|| anyhow!(crate::t!("err.no_object", index = index)))?;
    item_mesh(&mut ctx, item, budget)
}

/// Every occurrence of the `<build>`, each in its own frame, with the
/// container's parts parsed once for all of them (the root `.model` of a
/// dense file is long to read: once per object would multiply it).
pub fn load_items(zip: &mut Zip, budget: usize) -> Result<Vec<(BuildItem, ItemMesh)>> {
    let mut ctx = Ctx { zip, parts: HashMap::new() };
    let items = root_items(&mut ctx)?;
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        out.push((item, item_mesh(&mut ctx, item, budget)?));
    }
    Ok(out)
}

/// One occurrence, in its own frame, from a context whose root is parsed.
fn item_mesh(ctx: &mut Ctx, item: BuildItem, budget: usize) -> Result<ItemMesh> {
    // The file's orientation and scale kept, translation removed: the position
    // becomes the plate's.
    let mut lin = item.xf;
    let t = [lin.0[9], lin.0[10], lin.0[11]];
    lin.0[9] = 0.0;
    lin.0[10] = 0.0;
    lin.0[11] = 0.0;
    let mut insts = Vec::new();
    ctx.collect(ROOT_KEY, item.objid, item.objid, lin, None, 0, &mut insts);
    let mut mesh = emit(ctx, &insts, budget)?;
    #[rustfmt::skip]
    let c = [
        (mesh.min[0] + mesh.max[0]) / 2.0,
        (mesh.min[1] + mesh.max[1]) / 2.0,
        (mesh.min[2] + mesh.max[2]) / 2.0,
    ];
    for tri in &mut mesh.tris {
        for v in &mut tri.v {
            for k in 0..3 {
                v[k] -= c[k];
            }
        }
    }
    for k in 0..3 {
        mesh.min[k] -= c[k];
        mesh.max[k] -= c[k];
    }
    Ok(ItemMesh { mesh, center: [c[0] + t[0], c[1] + t[1], c[2] + t[2]] })
}

/// What can be said about a mesh without slicing it.
#[derive(serde::Serialize, Clone, Copy)]
pub struct Stats {
    pub triangles: usize,
    pub size: [f32; 3],
    /// Volume in cubic centimeters, computed as a sum of tetrahedra. Only
    /// meaningful if the mesh is closed.
    pub volume_cm3: f32,
    /// `None` when the mesh is too dense to check cheaply.
    pub watertight: Option<bool>,
}

/// Beyond this, the watertightness check costs more than it brings: it
/// indexes three edges per face, and would delay the preview it comes with.
const WATERTIGHT_BUDGET: usize = 400_000;

/// Watertight in the edge sense: each edge must be shared by exactly two
/// faces. It is the test that best predicts whether a slicer accepts the part.
///
/// Vertices are rounded to the micron before comparing: two floats from
/// different computations often describe the same point without being equal.
fn edges_are_paired(tris: &[Tri]) -> bool {
    let key = |p: [f32; 3]| -> [i64; 3] {
        [(p[0] as f64 * 1000.0).round() as i64, (p[1] as f64 * 1000.0).round() as i64, (p[2] as f64 * 1000.0).round() as i64]
    };
    let mut ids: HashMap<[i64; 3], u32> = HashMap::with_capacity(tris.len());
    let mut edges: HashMap<(u32, u32), i32> = HashMap::with_capacity(tris.len() * 2);
    for t in tris {
        let mut v = [0u32; 3];
        for (k, p) in t.v.iter().enumerate() {
            let next = ids.len() as u32;
            v[k] = *ids.entry(key(*p)).or_insert(next);
        }
        if v[0] == v[1] || v[1] == v[2] || v[0] == v[2] {
            continue; // degenerate triangle: it closes nothing
        }
        for (a, b) in [(v[0], v[1]), (v[1], v[2]), (v[2], v[0])] {
            let e = if a < b { (a, b) } else { (b, a) };
            *edges.entry(e).or_insert(0) += 1;
        }
    }
    !edges.is_empty() && edges.values().all(|&n| n == 2)
}

pub fn stats(m: &MeshData) -> Stats {
    let mut vol = 0f64;
    for t in &m.tris {
        let [a, b, c] = t.v;
        vol += (a[0] as f64 * (b[1] as f64 * c[2] as f64 - b[2] as f64 * c[1] as f64)
            - a[1] as f64 * (b[0] as f64 * c[2] as f64 - b[2] as f64 * c[0] as f64)
            + a[2] as f64 * (b[0] as f64 * c[1] as f64 - b[1] as f64 * c[0] as f64))
            / 6.0;
    }
    Stats {
        triangles: m.tris.len(),
        size: m.size(),
        volume_cm3: (vol.abs() / 1000.0) as f32,
        watertight: (m.tris.len() <= WATERTIGHT_BUDGET).then(|| edges_are_paired(&m.tris)),
    }
}

/// Keeps the triangles `keep` accepts, their colors and painting with them;
/// the bounding box follows.
pub fn retain_tris(m: &mut MeshData, keep: impl Fn(usize) -> bool) {
    fn filter<T>(v: &mut Vec<T>, keep: &impl Fn(usize) -> bool) {
        let mut i = 0usize;
        v.retain(|_| {
            let k = keep(i);
            i += 1;
            k
        });
    }
    filter(&mut m.tris, &keep);
    filter(&mut m.extruders, &keep);
    filter(&mut m.volumes, &keep);
    filter(&mut m.paint, &keep);
    m.min = [f32::MAX; 3];
    m.max = [f32::MIN; 3];
    for t in &m.tris {
        for v in &t.v {
            for k in 0..3 {
                m.min[k] = m.min[k].min(v[k]);
                m.max[k] = m.max[k].max(v[k]);
            }
        }
    }
}

/// Moves a mesh so its bounding box is centered on the origin; returns the
/// former center.
pub fn recenter(m: &mut MeshData) -> [f32; 3] {
    let c = [(m.min[0] + m.max[0]) / 2.0, (m.min[1] + m.max[1]) / 2.0, (m.min[2] + m.max[2]) / 2.0];
    for t in &mut m.tris {
        for v in &mut t.v {
            for k in 0..3 {
                v[k] -= c[k];
            }
        }
    }
    for k in 0..3 {
        m.min[k] -= c[k];
        m.max[k] -= c[k];
    }
    c
}

/// Reduces a mesh to the viewer's budget, by vertex clustering.
///
/// The space is cut into cubes; every vertex of a cube moves to the mean of
/// that cube's vertices. A triangle whose three corners land in three cubes
/// survives (with its color, extruder and painting); the others flatten and
/// go, and so do duplicates. The surface stays closed: no holes, unlike
/// keeping one triangle in so many (a dense mesh showed as lace). The cube
/// size is set from the surface area, then adjusted until the count fits.
///
/// The bounding box stays the full mesh's: the display is lightened, the
/// object is not trimmed. The mesh is marked truncated (slicing refuses it).
pub fn downsample(mesh: &mut MeshData, budget: usize) {
    let n = mesh.tris.len();
    if budget == 0 || n <= budget {
        return;
    }
    let area: f64 = mesh.tris.iter().map(|t| tri_area(&t.v) as f64).sum();
    let diag = (0..3).map(|k| (mesh.max[k] - mesh.min[k]).powi(2)).sum::<f32>().sqrt().max(1e-3);
    // A surface of area A in cubes of side s keeps about 2·A / s² triangles.
    let mut cell = ((2.0 * area / budget as f64).sqrt() as f32).clamp(diag * 1e-6, diag);
    let mut chosen: Option<f32> = None;
    for _ in 0..10 {
        let count = cluster(&mesh.tris, mesh.min, cell).0.iter().filter(|k| k.is_some()).count();
        if count == 0 {
            // Everything collapsed: finer cubes.
            cell *= 0.5;
            continue;
        }
        chosen = Some(cell);
        if count <= budget {
            break;
        }
        cell *= ((count as f32 / budget as f32).sqrt() * 1.03).max(1.05);
    }
    let Some(cell) = chosen else { return };
    let (keep, reps) = cluster(&mesh.tris, mesh.min, cell);
    let mut out = Vec::with_capacity(budget.min(n));
    for (t, k) in mesh.tris.iter().zip(&keep) {
        if let Some(k) = k {
            out.push(Tri { v: [reps[k[0]], reps[k[1]], reps[k[2]]], c: t.c });
        }
    }
    mesh.tris = out;
    // Extruders and painting follow their triangles.
    fn keep_marked<T>(v: &mut Vec<T>, keep: &[Option<[usize; 3]>]) {
        if v.len() != keep.len() {
            return;
        }
        let mut i = 0usize;
        v.retain(|_| {
            let k = keep[i].is_some();
            i += 1;
            k
        });
    }
    keep_marked(&mut mesh.extruders, &keep);
    keep_marked(&mut mesh.volumes, &keep);
    keep_marked(&mut mesh.paint, &keep);
    mesh.truncated = true;
}

fn tri_area(v: &[[f32; 3]; 3]) -> f32 {
    let a = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]];
    let b = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]];
    let c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    0.5 * (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt()
}

/// Clusters the vertices in cubes of side `cell` from `origin`: for each
/// triangle, the cubes of its corners when it survives (three distinct
/// cubes, first of its kind), and each cube's mean position.
fn cluster(tris: &[Tri], origin: [f32; 3], cell: f32) -> (Vec<Option<[usize; 3]>>, Vec<[f32; 3]>) {
    use std::collections::{HashMap, HashSet};
    let mut ids: HashMap<[i32; 3], usize> = HashMap::new();
    let mut sums: Vec<([f64; 3], u32)> = Vec::new();
    let mut id_of = |p: &[f32; 3]| -> usize {
        let key = [0, 1, 2].map(|k| ((p[k] - origin[k]) / cell).floor() as i32);
        let next = sums.len();
        let id = *ids.entry(key).or_insert(next);
        if id == next {
            sums.push(([0.0; 3], 0));
        }
        let s = &mut sums[id];
        for k in 0..3 {
            s.0[k] += p[k] as f64;
        }
        s.1 += 1;
        id
    };
    let mut seen: HashSet<[usize; 3]> = HashSet::new();
    let keep = tris
        .iter()
        .map(|t| {
            let k = [id_of(&t.v[0]), id_of(&t.v[1]), id_of(&t.v[2])];
            if k[0] == k[1] || k[1] == k[2] || k[0] == k[2] {
                return None;
            }
            let mut sorted = k;
            sorted.sort_unstable();
            seen.insert(sorted).then_some(k)
        })
        .collect();
    let reps = sums.iter().map(|(s, n)| [0, 1, 2].map(|k| (s[k] / *n as f64) as f32)).collect();
    (keep, reps)
}

/// Serializes the mesh for the WebGL viewer.
///
/// Layout, all little-endian:
/// `"3MFM"` | version u8 | flags u8 (bit 0: sampled mesh) |
/// reserved u8×2 | triangle count u32 |
/// min x,y,z f32 | max x,y,z f32 | positions (9 f32 per triangle) |
/// colors (3 u8 per triangle).
///
/// Version 2 (only when every triangle's model extruder is known) appends
/// the extruders (1 u8 per triangle) and sets flag bit 1. Everything before
/// is laid out as in version 1, so a v1 reader still decodes it; without
/// extruders the output is exactly version 1.
pub fn encode(mesh: &MeshData) -> Vec<u8> {
    let n = mesh.tris.len();
    let with_ext = n > 0 && mesh.extruders.len() == n;
    let mut out = Vec::with_capacity(36 + n * (36 + 3 + with_ext as usize));
    out.extend_from_slice(b"3MFM");
    out.push(if with_ext { 2 } else { 1 });
    out.push(if mesh.truncated { 1 } else { 0 } | if with_ext { 2 } else { 0 });
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(&(n as u32).to_le_bytes());
    for v in mesh.min.iter().chain(mesh.max.iter()) {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for t in &mesh.tris {
        for v in &t.v {
            for c in v {
                out.extend_from_slice(&c.to_le_bytes());
            }
        }
    }
    for t in &mesh.tris {
        out.extend_from_slice(&t.c);
    }
    if with_ext {
        out.extend_from_slice(&mesh.extruders);
    }
    out
}

/// Small painted 3MF files for the tests, built as Bambu Studio writes them.
#[cfg(test)]
pub mod testkit {
    use std::io::Write;
    use std::path::Path;

    /// A 10 mm cube; `paint[i]` paints triangle `i` (`""`: none). The object
    /// is declared on `extruder` in `model_settings.config` when given.
    pub fn painted_cube(dst: &Path, paint: &[&str], extruder: Option<u8>) {
        painted_cube_with(dst, paint, extruder, "1 0 0 0 1 0 0 0 1 50 50 0", &[]);
    }

    /// The same, placed by `transform` in the `<build>`, with the project's
    /// filament colors (`project_settings.config`) when given.
    pub fn painted_cube_with(dst: &Path, paint: &[&str], extruder: Option<u8>, transform: &str, filaments: &[&str]) {
        #[rustfmt::skip]
        let p = [[0., 0., 0.], [10., 0., 0.], [10., 10., 0.], [0., 10., 0.], [0., 0., 10.], [10., 0., 10.], [10., 10., 10.], [0., 10., 10.]];
        #[rustfmt::skip]
        let f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
        let mut m = String::from(
            r#"<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>"#,
        );
        for v in p {
            m.push_str(&format!(r#"<vertex x="{}" y="{}" z="{}"/>"#, v[0], v[1], v[2]));
        }
        m.push_str("</vertices><triangles>");
        for (i, t) in f.iter().enumerate() {
            let paint = paint.get(i).filter(|s| !s.is_empty()).map(|s| format!(r#" paint_color="{s}""#)).unwrap_or_default();
            m.push_str(&format!(r#"<triangle v1="{}" v2="{}" v3="{}"{paint}/>"#, t[0], t[1], t[2]));
        }
        m.push_str(&format!(
            r#"</triangles></mesh></object></resources><build><item objectid="1" transform="{transform}"/></build></model>"#
        ));
        let mut z = zip::ZipWriter::new(std::fs::File::create(dst).unwrap());
        let o = zip::write::SimpleFileOptions::default();
        z.start_file("3D/3dmodel.model", o).unwrap();
        z.write_all(m.as_bytes()).unwrap();
        if let Some(e) = extruder {
            z.start_file("Metadata/model_settings.config", o).unwrap();
            let cfg = format!(
                r#"<?xml version="1.0" encoding="UTF-8"?><config><object id="1"><metadata key="name" value="cube"/><metadata key="extruder" value="{e}"/></object></config>"#
            );
            z.write_all(cfg.as_bytes()).unwrap();
        }
        if !filaments.is_empty() {
            z.start_file("Metadata/project_settings.config", o).unwrap();
            let list = filaments.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(",");
            z.write_all(
                format!(r#"{{"filament_colour":[{list}],"filament_type":[{}]}}"#, vec!["\"PLA\""; filaments.len()].join(",")).as_bytes(),
            )
            .unwrap();
        }
        z.finish().unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes the encoded mesh of a real file, for the viewer test.
    #[test]
    fn dump_for_viewer() {
        let (Ok(src), Ok(out)) = (std::env::var("DUMP_3MF"), std::env::var("DUMP_OUT")) else {
            return;
        };
        let mut zip = crate::model3mf::open(std::path::Path::new(&src)).unwrap();
        let m = load_mesh(&mut zip, 900_000).unwrap();
        let bytes = encode(&m);
        println!("{} triangles, {} octets, encombrement {:?}", m.tris.len(), bytes.len(), m.size());
        std::fs::write(out, bytes).unwrap();
    }

    /// The encoding must match what the viewer reads.
    #[test]
    fn encode_layout() {
        let m = MeshData {
            extruders: Vec::new(),
            tris: vec![
                Tri { v: [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]], c: [10, 20, 30] },
                Tri { v: [[0., 0., 1.], [1., 0., 1.], [0., 1., 1.]], c: [40, 50, 60] },
            ],
            min: [0., 0., 0.],
            max: [1., 1., 1.],
            truncated: true,
            volumes: Vec::new(),
            paint: Vec::new(),
        };
        let b = encode(&m);
        assert_eq!(&b[0..4], b"3MFM");
        assert_eq!(b[4], 1, "version");
        assert_eq!(b[5], 1, "sampling flag");
        assert_eq!(u32::from_le_bytes(b[8..12].try_into().unwrap()), 2);
        assert_eq!(b.len(), 36 + 2 * 36 + 2 * 3);
        // First coordinate of the second vertex of the first triangle.
        let off = 36 + 3 * 4;
        assert_eq!(f32::from_le_bytes(b[off..off + 4].try_into().unwrap()), 1.0);
        // Colors at the end of the buffer.
        assert_eq!(&b[b.len() - 6..], &[10, 20, 30, 40, 50, 60]);
    }

    #[test]
    fn encode_v2_appends_extruders_after_the_v1_layout() {
        let tri = |c| Tri { v: [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]], c };
        let mut m = MeshData {
            extruders: vec![1, 3],
            tris: vec![tri([10, 20, 30]), tri([40, 50, 60])],
            min: [0.; 3],
            max: [1.; 3],
            truncated: false,
            volumes: Vec::new(),
            paint: Vec::new(),
        };
        let b = encode(&m);
        assert_eq!(b[4], 2, "version 2");
        assert_eq!(b[5] & 2, 2, "extruder flag");
        assert_eq!(b.len(), 36 + 2 * 36 + 2 * 3 + 2);
        // v1 part unchanged: colors right after the positions.
        let col = 36 + 2 * 36;
        assert_eq!(&b[col..col + 6], &[10, 20, 30, 40, 50, 60]);
        assert_eq!(&b[b.len() - 2..], &[1, 3]);
        // Extruders not matching the triangles: plain version 1.
        m.extruders = vec![1];
        let b1 = encode(&m);
        assert_eq!((b1[4], b1[5] & 2), (1, 0));
        assert_eq!(b1.len(), 36 + 2 * 36 + 2 * 3);
    }

    /// A UV sphere of `rings` × `segs` quads (two triangles each).
    fn sphere(rings: usize, segs: usize, r: f32) -> MeshData {
        let p = |i: usize, j: usize| {
            let th = std::f32::consts::PI * i as f32 / rings as f32;
            let ph = 2.0 * std::f32::consts::PI * j as f32 / segs as f32;
            [r * th.sin() * ph.cos(), r * th.sin() * ph.sin(), r * th.cos()]
        };
        let mut tris = Vec::new();
        for i in 0..rings {
            for j in 0..segs {
                let (a, b, c, d) = (p(i, j), p(i + 1, j), p(i + 1, j + 1), p(i, j + 1));
                tris.push(Tri { v: [a, b, c], c: [(j % 250) as u8, 0, 0] });
                tris.push(Tri { v: [a, c, d], c: [(j % 250) as u8, 0, 0] });
            }
        }
        let n = tris.len();
        MeshData {
            extruders: (0..n).map(|i| (i % 4) as u8 + 1).collect(),
            tris,
            min: [-r; 3],
            max: [r; 3],
            truncated: false,
            volumes: Vec::new(),
            paint: Vec::new(),
        }
    }

    #[test]
    fn decimation_keeps_the_surface_whole() {
        let mut m = sphere(300, 600, 50.0);
        let before: f32 = m.tris.iter().map(|t| tri_area(&t.v)).sum();
        downsample(&mut m, 40_000);
        assert!(m.tris.len() <= 40_000 && m.tris.len() > 20_000, "{}", m.tris.len());
        assert!(m.truncated);
        // No holes: the area stays (sampling one triangle in nine kept 11 %).
        let after: f32 = m.tris.iter().map(|t| tri_area(&t.v)).sum();
        assert!((after / before - 1.0).abs() < 0.05, "area {before} → {after}");
        // Every corner stays on the sphere.
        for t in &m.tris {
            for v in &t.v {
                let d = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
                assert!((d - 50.0).abs() < 1.5, "{d}");
            }
        }
        // The bounding box is the full mesh's.
        assert_eq!((m.min, m.max), ([-50.0; 3], [50.0; 3]));
    }

    #[test]
    fn downsample_keeps_extruders_aligned() {
        let mut m = sphere(60, 120, 20.0);
        // The model color of each triangle, tied to its color.
        m.extruders = m.tris.iter().map(|t| t.c[0] % 4 + 1).collect();
        downsample(&mut m, 2_000);
        assert_eq!(m.tris.len(), m.extruders.len());
        for (t, e) in m.tris.iter().zip(&m.extruders) {
            assert_eq!(t.c[0] % 4 + 1, *e);
        }
        // Small enough already: untouched.
        let mut small = sphere(4, 8, 1.0);
        downsample(&mut small, 1_000);
        assert_eq!((small.tris.len(), small.truncated), (64, false));
    }

    /// A real dense file (MakerWorld's "10 different pumpkins" has meshes of
    /// up to 1.5 M triangles): every object, read for the viewer, keeps its
    /// surface. `PUMPKINS=…/10+Pumpkins.3mf cargo test --lib real_dense -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_dense_file_keeps_its_surface() {
        let path = std::env::var("PUMPKINS").expect("PUMPKINS");
        let n = crate::plate::items(std::path::Path::new(&path)).unwrap().len();
        assert!(n > 0);
        let mut zip = crate::model3mf::open(std::path::Path::new(&path)).unwrap();
        for i in 0..n {
            let full = load_item(&mut zip, i, usize::MAX).unwrap().mesh;
            let shown = load_item(&mut zip, i, 400_000).unwrap().mesh;
            let area = |m: &MeshData| m.tris.iter().map(|t| tri_area(&t.v) as f64).sum::<f64>();
            let (a, b) = (area(&full), area(&shown));
            println!("object {i}: {} → {} triangles, area {:.0} → {:.0} mm²", full.tris.len(), shown.tris.len(), a, b);
            assert!(shown.tris.len() <= 400_000);
            assert!((b / a - 1.0).abs() < 0.05, "object {i} lost its surface");
        }
    }
}

#[cfg(test)]
mod stats_tests {
    use super::*;

    #[test]
    fn a_closed_cube_is_watertight() {
        let tris = crate::stl::tests_cube();
        let m =
            MeshData { extruders: Vec::new(), min: [0.; 3], max: [10.; 3], tris, truncated: false, volumes: Vec::new(), paint: Vec::new() };
        let s = stats(&m);
        assert_eq!(s.triangles, 12);
        assert_eq!(s.watertight, Some(true));
        // 10 mm sides: 1 cm³.
        assert!((s.volume_cm3 - 1.0).abs() < 1e-3, "volume {}", s.volume_cm3);
    }

    #[test]
    fn an_open_cube_is_not() {
        let mut tris = crate::stl::tests_cube();
        tris.truncate(10); // remove one face
        let m =
            MeshData { extruders: Vec::new(), min: [0.; 3], max: [10.; 3], tris, truncated: false, volumes: Vec::new(), paint: Vec::new() };
        assert_eq!(stats(&m).watertight, Some(false));
    }

    #[test]
    fn painted_triangles_take_their_dominant_color() {
        let dir = std::env::temp_dir().join("snapstudio_paint_read");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cube.3mf");
        // Triangle 0: filament 5; 1: filament 2; 2: split, mostly 3 with a
        // stroke of 6; 3: state 0 (the volume's); the rest unpainted.
        let split = "3C0C0C0C3"; // split in 4 (code 3), then 3, 3, 3 and 6 (read from the end)
        assert_eq!(crate::paint::states(split), vec![3, 6]);
        testkit::painted_cube(&path, &["2C", "8", split, "0"], Some(4));
        let mut zip = crate::model3mf::open(&path).unwrap();
        let it = load_item(&mut zip, 0, usize::MAX).unwrap();
        let m = &it.mesh;
        assert_eq!(&m.extruders[..5], &[5, 2, 3, 4, 4]);
        assert_eq!(m.volumes, vec![4; 12]);
        assert_eq!(m.paint[0].as_deref(), Some("2C"));
        assert_eq!(m.paint[5], None);
        // The stroke of 6 never dominates, yet it is a color of the object.
        assert_eq!(colors_used(m), vec![2, 3, 4, 5, 6]);
    }

    #[test]
    fn paint_without_settings_stands_on_extruder_one() {
        let dir = std::env::temp_dir().join("snapstudio_paint_read");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bare.3mf");
        testkit::painted_cube(&path, &["1C"], None);
        let mut zip = crate::model3mf::open(&path).unwrap();
        let m = load_mesh(&mut zip, usize::MAX).unwrap();
        assert_eq!(m.extruders[0], 4);
        assert!(m.extruders[1..].iter().all(|e| *e == 1));
        assert_eq!(colors_used(&m), vec![1, 4]);
    }

    #[test]
    fn unpainted_files_are_unchanged() {
        let dir = std::env::temp_dir().join("snapstudio_paint_read");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("plain.3mf");
        testkit::painted_cube(&path, &[], None);
        let mut zip = crate::model3mf::open(&path).unwrap();
        let m = load_mesh(&mut zip, usize::MAX).unwrap();
        assert!(m.extruders.is_empty() && m.volumes.is_empty() && m.paint.is_empty());
    }

    /// A real painted file, read by hand:
    /// `PAINT_3MF=… cargo test --lib real_painted_file -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_painted_file() {
        let path = std::env::var("PAINT_3MF").expect("PAINT_3MF");
        let mut zip = crate::model3mf::open(std::path::Path::new(&path)).unwrap();
        let n = build_items(&mut zip).unwrap().len();
        for i in 0..n {
            let m = load_item(&mut zip, i, usize::MAX).unwrap().mesh;
            let mut shown = std::collections::BTreeMap::<u8, usize>::new();
            for e in &m.extruders {
                *shown.entry(*e).or_default() += 1;
            }
            println!("item {i}: {} triangles, colors {:?}, shown {shown:?}", m.tris.len(), colors_used(&m));
        }
    }

    /// An object mirrored in its slicer (negative determinant in the build):
    /// faces back outward, split painting flattened, whole painting kept.
    #[test]
    fn mirrored_placement_restores_the_winding() {
        let dir = std::env::temp_dir().join("snapstudio_paint_read");
        std::fs::create_dir_all(&dir).unwrap();
        let signed_volume = |m: &MeshData| -> f32 {
            m.tris
                .iter()
                .map(|t| {
                    let [a, b, c] = t.v;
                    a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])
                })
                .sum::<f32>()
                / 6.0
        };
        let paint = ["2C", "", "3C0C0C0C3"];
        let plain = dir.join("plain-placed.3mf");
        testkit::painted_cube(&plain, &paint, Some(1));
        let mirror = dir.join("mirrored.3mf");
        testkit::painted_cube_with(&mirror, &paint, Some(1), "-1 0 0 0 1 0 0 0 1 50 50 0", &[]);
        let m = load_mesh(&mut crate::model3mf::open(&plain).unwrap(), usize::MAX).unwrap();
        assert!(signed_volume(&m) > 0.0);
        assert!(crate::paint::is_split(m.paint[2].as_deref().unwrap()));
        let m = load_mesh(&mut crate::model3mf::open(&mirror).unwrap(), usize::MAX).unwrap();
        assert!(signed_volume(&m) > 0.0, "faces outward after a mirror");
        assert_eq!(m.paint[0].as_deref(), Some("2C"));
        assert_eq!(m.paint[2].as_deref(), Some(crate::paint::whole(3).as_str()));
    }

    #[test]
    fn downsample_keeps_painting_aligned() {
        let dir = std::env::temp_dir().join("snapstudio_paint_read");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sampled.3mf");
        let paint: Vec<String> = (0..12).map(|i| crate::paint::whole(i as u8 + 1)).collect();
        let refs: Vec<&str> = paint.iter().map(String::as_str).collect();
        testkit::painted_cube(&path, &refs, Some(1));
        let mut m = load_mesh(&mut crate::model3mf::open(&path).unwrap(), usize::MAX).unwrap();
        downsample(&mut m, 4);
        // A cube cannot lose triangles without collapsing whole: it is kept
        // (never emptied), and stays aligned either way.
        let n = m.tris.len();
        assert!(n > 0 && n <= 12, "{n}");
        assert_eq!((m.extruders.len(), m.volumes.len(), m.paint.len()), (n, n, n));
        // Each triangle kept keeps its own painting: whole(k) is extruder k.
        for (e, p) in m.extruders.iter().zip(&m.paint) {
            assert_eq!(p.as_deref(), Some(crate::paint::whole(*e).as_str()));
        }
    }
}

#[cfg(test)]
mod hex_tests {
    use super::parse_color;

    #[test]
    fn colours_cut_safely() {
        assert_eq!(parse_color(" #FF8000FF "), Some([255, 128, 0]));
        assert_eq!(parse_color("aé0000"), None);
        assert_eq!(parse_color("aaaaaé"), None);
    }
}
