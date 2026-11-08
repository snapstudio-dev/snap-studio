//! Writing 3MF files.
//!
//! [`write_multipart`] / [`write_objects`] compose a new 3MF from parts, each
//! with its head, for a plate one arranges oneself or an AI result.
//!
//! Beware downstream: Orca's command line rearranges the plate on its own. For
//! the placement written here to be the one printed, it must be called with
//! `--arrange 0`. Verified: without the flag parts are moved, with it they
//! stay within 0.3 mm — the gap being half the extrusion bead's width.

use crate::mesh::{Mat, Tri};
use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

/// An object to put on the plate.
#[cfg(test)]
pub struct SceneObject {
    pub name: String,
    /// Triangles in the object's frame.
    pub tris: Vec<Tri>,
    /// Placement on the plate.
    pub transform: Mat,
    /// Assigned head, 1 to 4; `None` lets the slicer decide.
    pub extruder: Option<u8>,
}

#[allow(dead_code)]
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Merges identical vertices: a mesh with shared vertices slices much better
/// than a triangle soup. One entry per triangle, in order: `None` for a
/// degenerate one (two vertices the same), which makes the slicer's repair
/// fail. The writer follows this list, so the two never disagree on which
/// triangles are kept: a second test there, by float equality, took `-0.0`
/// (a mirrored object) for `0.0` and shifted every later index.
#[allow(dead_code)]
fn weld(tris: &[Tri]) -> (Vec<[f32; 3]>, Vec<Option<[u32; 3]>>) {
    let mut verts: Vec<[f32; 3]> = Vec::with_capacity(tris.len());
    let mut index: HashMap<[u32; 3], u32> = HashMap::with_capacity(tris.len());
    let mut faces = Vec::with_capacity(tris.len());
    // `+ 0.0` turns -0.0 into 0.0: the same point, one vertex.
    let bits = |x: f32| (x + 0.0).to_bits();
    for t in tris {
        let mut f = [0u32; 3];
        for (k, v) in t.v.iter().enumerate() {
            let key = [bits(v[0]), bits(v[1]), bits(v[2])];
            let id = *index.entry(key).or_insert_with(|| {
                verts.push(*v);
                (verts.len() - 1) as u32
            });
            f[k] = id;
        }
        faces.push((f[0] != f[1] && f[1] != f[2] && f[0] != f[2]).then_some(f));
    }
    (verts, faces)
}

fn mat_str(m: &Mat) -> String {
    m.0.iter().map(|v| format!("{v}")).collect::<Vec<_>>().join(" ")
}

/// Id of the material group (color palette).
const MAT_ID: u32 = 1;

/// Writes a mesh as an `<object>` of the model, colors included.
///
/// `paint` (empty, or one entry per triangle) is written as `paint_color`,
/// the multicolor painting Orca reads (`paint.rs`).
fn write_mesh_object<W: Write>(
    w: &mut W,
    id: u32,
    name: &str,
    tris: &[Tri],
    paint: &[Option<Box<str>>],
    color_id: &HashMap<[u8; 3], usize>,
) -> Result<()> {
    let (verts, faces) = weld(tris);
    if faces.iter().all(Option::is_none) {
        return Err(anyhow!(crate::t!("err.object_empty", name = name)));
    }
    let single = tris.first().map(|t| t.c).filter(|c| tris.iter().all(|t| t.c == *c));
    match single {
        Some(c) => {
            writeln!(w, r#"  <object id="{id}" type="model" name="{}" pid="{MAT_ID}" pindex="{}">"#, xml_escape(name), color_id[&c])?
        }
        None => writeln!(w, r#"  <object id="{id}" type="model" name="{}">"#, xml_escape(name))?,
    }
    writeln!(w, "   <mesh>")?;
    writeln!(w, "    <vertices>")?;
    for v in &verts {
        writeln!(w, r#"     <vertex x="{:.6}" y="{:.6}" z="{:.6}"/>"#, v[0], v[1], v[2])?;
    }
    writeln!(w, "    </vertices>")?;
    writeln!(w, "    <triangles>")?;
    for (ti, (t, f)) in tris.iter().zip(&faces).enumerate() {
        // `weld` decides which triangles are degenerate: nothing is retested here.
        let Some(f) = f else { continue };
        let painted = match paint.get(ti) {
            Some(Some(p)) => format!(r#" paint_color="{p}""#),
            _ => String::new(),
        };
        if single.is_some() {
            writeln!(w, r#"     <triangle v1="{}" v2="{}" v3="{}"{painted}/>"#, f[0], f[1], f[2])?;
        } else {
            writeln!(w, r#"     <triangle v1="{}" v2="{}" v3="{}" pid="{MAT_ID}" p1="{}"{painted}/>"#, f[0], f[1], f[2], color_id[&t.c])?;
        }
    }
    writeln!(w, "    </triangles>")?;
    writeln!(w, "   </mesh>")?;
    writeln!(w, "  </object>")?;
    Ok(())
}

type Archive = zip::ZipWriter<BufWriter<File>>;

/// Opens the archive and writes the fixed parts, up to the start of the model.
fn begin_archive(dst: &Path) -> Result<(Archive, zip::write::SimpleFileOptions)> {
    let out = File::create(dst)?;
    let mut z = zip::ZipWriter::new(BufWriter::new(out));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    z.start_file("[Content_Types].xml", opts)?;
    z.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
</Types>"#,
    )?;

    z.start_file("_rels/.rels", opts)?;
    z.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>"#,
    )?;

    z.start_file("3D/3dmodel.model", opts)?;
    Ok((z, opts))
}

fn begin_model<W: Write>(w: &mut W) -> Result<()> {
    writeln!(w, r#"<?xml version="1.0" encoding="UTF-8"?>"#)?;
    writeln!(w, r#"<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">"#)?;
    writeln!(w, r#" <metadata name="Application">Snap Studio</metadata>"#)?;
    writeln!(w, " <resources>")?;
    Ok(())
}

/// A global palette: each color met becomes a material.
fn write_palette<W: Write>(w: &mut W, groups: &[&[Tri]]) -> Result<HashMap<[u8; 3], usize>> {
    let mut palette: Vec<[u8; 3]> = Vec::new();
    let mut color_id: HashMap<[u8; 3], usize> = HashMap::new();
    for tris in groups {
        for t in tris.iter() {
            color_id.entry(t.c).or_insert_with(|| {
                palette.push(t.c);
                palette.len() - 1
            });
        }
    }
    if !palette.is_empty() {
        writeln!(w, r#"  <basematerials id="{MAT_ID}">"#)?;
        for (i, c) in palette.iter().enumerate() {
            writeln!(w, r##"   <base name="Couleur {}" displaycolor="#{:02X}{:02X}{:02X}FF"/>"##, i + 1, c[0], c[1], c[2])?;
        }
        writeln!(w, "  </basematerials>")?;
    }
    Ok(color_id)
}

/// A part of a composite object, printed by a given head (1 to 16).
pub struct Part {
    pub name: String,
    pub tris: Vec<Tri>,
    pub extruder: u8,
    /// Painting of each triangle, its states already heads (1 to 16); empty
    /// for an unpainted part.
    pub paint: Vec<Option<Box<str>>>,
}

/// An object of a plate made of parts, with its own settings: written as
/// the object's `<metadata>` in `model_settings.config`, which Orca reads as
/// the object's config (the prime pillars' walls-only settings).
pub struct Object {
    pub name: String,
    pub parts: Vec<Part>,
    pub settings: Vec<(String, String)>,
}

/// Writes a single object made of several parts, each with its head.
///
/// It is the form the slicer expects for a multicolor model: a single object
/// stays in one piece (a part placed up high does not fall back onto the
/// plate), and `model_settings.config` assigns a head to each part.
pub fn write_multipart(dst: &Path, name: &str, parts: &[Part], transform: &Mat) -> Result<()> {
    write_composites(dst, &[(name, parts, *transform, &[])])
}

/// Writes several objects made of parts, in this order, placements already
/// applied to the triangles (plate scene).
pub fn write_objects(dst: &Path, objects: &[Object]) -> Result<()> {
    let list: Vec<Composite> =
        objects.iter().map(|o| (o.name.as_str(), o.parts.as_slice(), Mat::IDENTITY, o.settings.as_slice())).collect();
    write_composites(dst, &list)
}

/// An object to write: name, parts, placement, own settings.
type Composite<'a> = (&'a str, &'a [Part], Mat, &'a [(String, String)]);

/// Composite objects: each part is a mesh, each object an assembly of its
/// parts, placed in the `<build>`.
fn write_composites(dst: &Path, objects: &[Composite]) -> Result<()> {
    if objects.is_empty() || objects.iter().any(|(_, p, _, _)| p.is_empty()) {
        return Err(anyhow!(crate::t!("err.no_part")));
    }
    let (mut z, opts) = begin_archive(dst)?;
    let mut w = std::io::BufWriter::with_capacity(1 << 20, &mut z);
    begin_model(&mut w)?;
    let all: Vec<&[Tri]> = objects.iter().flat_map(|(_, parts, _, _)| parts.iter().map(|p| p.tris.as_slice())).collect();
    let color_id = write_palette(&mut w, &all)?;

    // Ids: parts first (from 2), then the composite objects.
    let mut next = 2u32;
    let mut part_ids: Vec<Vec<u32>> = Vec::new();
    for (_, parts, _, _) in objects {
        let mut ids = Vec::new();
        for p in parts.iter() {
            write_mesh_object(&mut w, next, &p.name, &p.tris, &p.paint, &color_id)?;
            ids.push(next);
            next += 1;
        }
        part_ids.push(ids);
    }
    let mut whole_ids = Vec::new();
    for ((name, _, _, _), ids) in objects.iter().zip(&part_ids) {
        writeln!(w, r#"  <object id="{next}" type="model" name="{}">"#, xml_escape(name))?;
        writeln!(w, "   <components>")?;
        for id in ids {
            writeln!(w, r#"    <component objectid="{id}"/>"#)?;
        }
        writeln!(w, "   </components>")?;
        writeln!(w, "  </object>")?;
        whole_ids.push(next);
        next += 1;
    }
    writeln!(w, " </resources>")?;
    writeln!(w, " <build>")?;
    for ((_, _, xf, _), id) in objects.iter().zip(&whole_ids) {
        writeln!(w, r#"  <item objectid="{id}" transform="{}"/>"#, mat_str(xf))?;
    }
    writeln!(w, " </build>")?;
    writeln!(w, "</model>")?;
    w.flush()?;
    drop(w);

    z.start_file("Metadata/model_settings.config", opts)?;
    let mut s = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<config>\n");
    for (((name, parts, _, settings), ids), whole) in objects.iter().zip(&part_ids).zip(&whole_ids) {
        s.push_str(&format!("  <object id=\"{whole}\">\n"));
        s.push_str(&format!("    <metadata key=\"name\" value=\"{}\"/>\n", xml_escape(name)));
        s.push_str(&format!("    <metadata key=\"extruder\" value=\"{}\"/>\n", parts[0].extruder.clamp(1, 16)));
        for (k, v) in settings.iter() {
            s.push_str(&format!("    <metadata key=\"{}\" value=\"{}\"/>\n", xml_escape(k), xml_escape(v)));
        }
        for (p, id) in parts.iter().zip(ids) {
            s.push_str(&format!("    <part id=\"{id}\" subtype=\"normal_part\">\n"));
            s.push_str(&format!("      <metadata key=\"name\" value=\"{}\"/>\n", xml_escape(&p.name)));
            s.push_str(&format!("      <metadata key=\"extruder\" value=\"{}\"/>\n", p.extruder.clamp(1, 16)));
            s.push_str("    </part>\n");
        }
        s.push_str("  </object>\n");
    }
    s.push_str("</config>\n");
    z.write_all(s.as_bytes())?;
    z.finish()?;
    Ok(())
}

/// Adds a file to a 3MF already written.
pub fn append_entry(dst: &Path, name: &str, data: &[u8]) -> Result<()> {
    let f = std::fs::OpenOptions::new().read(true).write(true).open(dst)?;
    let mut z = zip::ZipWriter::new_append(f)?;
    z.start_file(name, zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated))?;
    z.write_all(data)?;
    z.finish()?;
    Ok(())
}

/// Writes a geometry 3MF holding the objects and their placements.
#[cfg(test)]
pub fn write_scene(dst: &Path, objects: &[SceneObject]) -> Result<()> {
    if objects.is_empty() {
        return Err(anyhow!(crate::t!("err.no_object_to_write")));
    }
    let (mut z, opts) = begin_archive(dst)?;
    let mut w = std::io::BufWriter::with_capacity(1 << 20, &mut z);
    begin_model(&mut w)?;
    let all: Vec<&[Tri]> = objects.iter().map(|o| o.tris.as_slice()).collect();
    let color_id = write_palette(&mut w, &all)?;

    for (i, o) in objects.iter().enumerate() {
        // Id 1 is taken by the materials.
        write_mesh_object(&mut w, i as u32 + 2, &o.name, &o.tris, &[], &color_id)?;
    }

    writeln!(w, " </resources>")?;
    writeln!(w, " <build>")?;
    for (i, o) in objects.iter().enumerate() {
        writeln!(w, r#"  <item objectid="{}" transform="{}"/>"#, i as u32 + 2, mat_str(&o.transform))?;
    }
    writeln!(w, " </build>")?;
    writeln!(w, "</model>")?;
    w.flush()?;
    drop(w);

    // Per-object settings read by Orca and Bambu Studio: name and assigned head.
    z.start_file("Metadata/model_settings.config", opts)?;
    let mut s = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<config>\n");
    for (i, o) in objects.iter().enumerate() {
        s.push_str(&format!("  <object id=\"{}\">\n", i as u32 + 2));
        s.push_str(&format!("    <metadata key=\"name\" value=\"{}\"/>\n", xml_escape(&o.name)));
        if let Some(e) = o.extruder {
            s.push_str(&format!("    <metadata key=\"extruder\" value=\"{}\"/>\n", e.clamp(1, 16)));
        }
        s.push_str("  </object>\n");
    }
    s.push_str("</config>\n");
    z.write_all(s.as_bytes())?;

    z.finish()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh;
    use std::io::Read;

    fn cube(size: f32, color: [u8; 3]) -> Vec<Tri> {
        let s = size;
        #[rustfmt::skip]
        let p = [
            [0., 0., 0.], [s, 0., 0.], [s, s, 0.], [0., s, 0.],
            [0., 0., s], [s, 0., s], [s, s, s], [0., s, s],
        ];
        #[rustfmt::skip]
        let faces = [
            [0, 2, 1], [0, 3, 2], // dessous
            [4, 5, 6], [4, 6, 7], // dessus
            [0, 1, 5], [0, 5, 4],
            [1, 2, 6], [1, 6, 5],
            [2, 3, 7], [2, 7, 6],
            [3, 0, 4], [3, 4, 7],
        ];
        faces.iter().map(|f| Tri { v: [p[f[0]], p[f[1]], p[f[2]]], c: color }).collect()
    }

    /// Objects keep their order and their own settings: each object's block
    /// of `model_settings.config` holds its keys, after its name and head.
    #[test]
    fn objects_carry_their_settings() {
        let dir = std::env::temp_dir().join("snapstudio_w3mf_settings");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("objects.3mf");
        let part = |name: &str, x: f32, head: u8| Part {
            name: name.into(),
            tris: cube(10.0, [200, 40, 40])
                .into_iter()
                .map(|mut t| {
                    for v in &mut t.v {
                        v[0] += x;
                    }
                    t
                })
                .collect(),
            extruder: head,
            paint: vec![],
        };
        write_objects(
            &path,
            &[
                Object {
                    name: "pillar".into(),
                    parts: vec![part("ring", 0.0, 2)],
                    settings: vec![("sparse_infill_density".into(), "0%".into()), ("brim_type".into(), "outer_only".into())],
                },
                Object { name: "model & co".into(), parts: vec![part("a", 50.0, 1), part("b", 70.0, 3)], settings: vec![] },
            ],
        )
        .unwrap();
        let mut zip = crate::model3mf::open(&path).unwrap();
        let cfg = String::from_utf8(crate::model3mf::read_entry(&mut zip, "Metadata/model_settings.config").unwrap()).unwrap();
        let blocks: Vec<&str> = cfg.split("<object ").skip(1).collect();
        assert_eq!(blocks.len(), 2);
        assert!(blocks[0].contains(r#"<metadata key="name" value="pillar"/>"#), "first in the list: {cfg}");
        assert!(blocks[0].contains(r#"<metadata key="sparse_infill_density" value="0%"/>"#));
        assert!(blocks[0].contains(r#"<metadata key="brim_type" value="outer_only"/>"#));
        let head = blocks[0].split("<part").next().unwrap();
        assert!(head.contains("sparse_infill_density"), "the object's, not a part's");
        assert!(blocks[1].contains("model &amp; co") && !blocks[1].contains("sparse_infill_density"), "{cfg}");
        let m = mesh::load_mesh(&mut zip, 100_000).unwrap();
        assert_eq!(m.tris.len(), 36);
        let mut heads: Vec<u8> = m.extruders.clone();
        heads.dedup();
        assert_eq!(heads, vec![2, 1, 3], "parts on their heads, in order");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// What is written must be read back identically by our own reader.
    #[test]
    fn round_trip() {
        let dir = std::env::temp_dir().join("snapstudio_w3mf");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("scene.3mf");

        let mut place = Mat::IDENTITY;
        place.0[9] = 100.0; // X translation of the second cube
        place.0[10] = 50.0;
        let objects = vec![
            SceneObject { name: "red cube".into(), tris: cube(10.0, [200, 40, 40]), transform: Mat::IDENTITY, extruder: Some(1) },
            SceneObject { name: "blue cube".into(), tris: cube(20.0, [40, 60, 200]), transform: place, extruder: Some(3) },
        ];
        write_scene(&path, &objects).unwrap();

        let mut zip = crate::model3mf::open(&path).unwrap();
        let m = mesh::load_mesh(&mut zip, 100_000).unwrap();
        assert_eq!(m.tris.len(), 24, "two cubes of twelve triangles");

        // The second cube is indeed moved: the extent goes from 0 to 120 in X.
        assert!((m.min[0] - 0.0).abs() < 1e-4, "min x = {}", m.min[0]);
        assert!((m.max[0] - 120.0).abs() < 1e-4, "max x = {}", m.max[0]);
        assert!((m.max[1] - 70.0).abs() < 1e-4, "max y = {}", m.max[1]);

        // Material colors survive the round trip.
        assert!(m.tris.iter().any(|t| t.c == [200, 40, 40]));
        assert!(m.tris.iter().any(|t| t.c == [40, 60, 200]));

        // Vertices are shared: eight per cube, not three per triangle.
        let data = std::fs::read(&path).unwrap();
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(data)).unwrap();
        let mut xml = String::new();
        z.by_name("3D/3dmodel.model").unwrap().read_to_string(&mut xml).unwrap();
        assert_eq!(xml.matches("<vertex ").count(), 16, "8 vertices per cube");
        assert!(xml.contains(r#"name="red cube""#));
        let mut cfg = String::new();
        z.by_name("Metadata/model_settings.config").unwrap().read_to_string(&mut cfg).unwrap();
        assert!(cfg.contains(r#"key="extruder" value="3""#), "head assigned");
    }

    /// Composes a plate of two copies, for the real slicing test.
    #[test]
    fn dump_scene() {
        let (Ok(src), Ok(dst)) = (std::env::var("SCENE_SRC"), std::env::var("SCENE_OUT")) else {
            return;
        };
        let mut zip = crate::model3mf::open(Path::new(&src)).unwrap();
        let m = mesh::load_mesh(&mut zip, 2_000_000).unwrap();
        let size = m.size();
        // Put the part back at the origin, then lay two side by side.
        let recenter = |dx: f32, dy: f32| {
            let mut t = Mat::IDENTITY;
            t.0[9] = -m.min[0] + dx;
            t.0[10] = -m.min[1] + dy;
            t.0[11] = -m.min[2];
            t
        };
        let objects = vec![
            SceneObject { name: "piece A".into(), tris: m.tris.clone(), transform: recenter(30.0, 30.0), extruder: Some(1) },
            SceneObject { name: "piece B".into(), tris: m.tris.clone(), transform: recenter(40.0 + size[0], 30.0), extruder: Some(2) },
        ];
        write_scene(Path::new(&dst), &objects).unwrap();
        println!("written: {dst} ({} triangles per part, footprint {:.1} x {:.1} mm)", m.tris.len(), size[0], size[1]);
    }
}

#[cfg(test)]
mod weld_tests {
    use super::weld;
    use crate::mesh::Tri;

    fn tri(a: [f32; 3], b: [f32; 3], c: [f32; 3]) -> Tri {
        Tri { v: [a, b, c], c: [255, 255, 255] }
    }

    #[test]
    fn degenerate_triangles_are_decided_once() {
        let tris = vec![
            tri([0., 0., 0.], [1., 0., 0.], [0., 1., 0.]),
            // -0.0 is 0.0 (a mirrored object): the same vertex, a degenerate triangle.
            tri([0., 0., 0.], [-0.0, 0., 0.], [1., 0., 0.]),
            tri([0., 0., 0.], [0., 1., 0.], [0., 0., 1.]),
        ];
        let (verts, faces) = weld(&tris);
        assert_eq!(faces.len(), tris.len(), "one entry per triangle, in order");
        assert!(faces[1].is_none(), "the degenerate one is marked, not dropped");
        assert_eq!(verts.len(), 4, "-0.0 welded with 0.0");
        assert_eq!(faces[2], Some([0, 2, 3]), "indices follow the welded vertices");
    }
}
