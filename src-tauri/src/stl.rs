//! STL reading and writing.
//!
//! It is the AI tab's exchange format: the Python tools handle it effortlessly,
//! and the app converts it to 3MF at both ends.
//!
//! An STL carries neither color, nor object name, nor unit — only triangles in
//! millimeters. Both dialects are accepted, binary and text, and only binary
//! is written, four times more compact.

use crate::mesh::{MeshData, Tri};
use anyhow::{anyhow, Result};
#[cfg(test)]
use std::io::{BufWriter, Write};
use std::path::Path;

/// Header (80 B) + triangle count (4 B).
const HEADER: usize = 84;
/// Normal + 3 vertices + attribute: 12 floats and 2 bytes.
const RECORD: usize = 50;

/// True if the file size matches the announced count: exactly, or with a
/// few trailing bytes (some exporters end with padding or a newline), never
/// short of a record.
///
/// The word "solid" at the start is not trusted: many exporters put it in the
/// header of a binary file too.
fn looks_binary(data: &[u8]) -> bool {
    if data.len() < HEADER {
        return false;
    }
    let n = u32::from_le_bytes([data[80], data[81], data[82], data[83]]) as usize;
    n > 0 && n.checked_mul(RECORD).and_then(|body| data.len().checked_sub(HEADER + body)).is_some_and(|extra| extra < RECORD)
}

fn f32_at(data: &[u8], off: usize) -> f32 {
    f32::from_le_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]])
}

fn read_binary(data: &[u8]) -> Vec<[[f32; 3]; 3]> {
    let n = u32::from_le_bytes([data[80], data[81], data[82], data[83]]) as usize;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        // Skip the normal: it is often wrong, and it is recomputed.
        let base = HEADER + i * RECORD + 12;
        let mut v = [[0f32; 3]; 3];
        for (k, vertex) in v.iter_mut().enumerate() {
            for (c, coord) in vertex.iter_mut().enumerate() {
                *coord = f32_at(data, base + k * 12 + c * 4);
            }
        }
        out.push(v);
    }
    out
}

fn read_ascii(text: &str) -> Vec<[[f32; 3]; 3]> {
    let mut out = Vec::new();
    let mut cur = [[0f32; 3]; 3];
    let mut k = 0usize;
    for line in text.lines() {
        let mut it = line.split_whitespace();
        if it.next() != Some("vertex") {
            continue;
        }
        let mut p = [0f32; 3];
        for c in p.iter_mut() {
            match it.next().and_then(|t| t.parse::<f32>().ok()) {
                Some(x) => *c = x,
                None => return out, // truncated line: keep what we have
            }
        }
        cur[k] = p;
        k += 1;
        if k == 3 {
            out.push(cur);
            k = 0;
        }
    }
    out
}

/// Loads an STL, binary or text.
pub fn read(path: &Path) -> Result<MeshData> {
    crate::access::ensure_file(path);
    let data = std::fs::read(path)?;
    if data.len() < 15 {
        return Err(anyhow!(crate::t!("err.stl_empty")));
    }
    let faces = if looks_binary(&data) { read_binary(&data) } else { read_ascii(&String::from_utf8_lossy(&data)) };
    if faces.is_empty() {
        return Err(anyhow!(crate::t!("err.stl_no_triangle")));
    }

    let mut min = [f32::MAX; 3];
    let mut max = [f32::MIN; 3];
    let mut tris = Vec::with_capacity(faces.len());
    for v in faces {
        for p in &v {
            for k in 0..3 {
                min[k] = min[k].min(p[k]);
                max[k] = max[k].max(p[k]);
            }
        }
        tris.push(Tri { v, c: crate::render::DEFAULT_COLOR });
    }
    Ok(MeshData { extruders: Vec::new(), tris, min, max, truncated: false, volumes: Vec::new(), paint: Vec::new() })
}

/// Unit normal of a triangle; zero if the triangle is degenerate.
#[cfg(test)]
fn normal(v: &[[f32; 3]; 3]) -> [f32; 3] {
    let u = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]];
    let w = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]];
    #[rustfmt::skip]
    let n = [
        u[1] * w[2] - u[2] * w[1],
        u[2] * w[0] - u[0] * w[2],
        u[0] * w[1] - u[1] * w[0],
    ];
    let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    if len > 0.0 {
        [n[0] / len, n[1] / len, n[2] / len]
    } else {
        [0.0; 3]
    }
}

/// Writes a binary STL. Colors are lost: the format has none. The app no
/// longer writes STL; tests do, to build the files of older conversations.
#[cfg(test)]
pub fn write(path: &Path, tris: &[Tri]) -> Result<()> {
    if tris.is_empty() {
        return Err(anyhow!(crate::t!("err.no_triangle")));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut w = BufWriter::with_capacity(1 << 20, std::fs::File::create(path)?);

    let mut header = [0u8; 80];
    let tag = b"Snap Studio";
    header[..tag.len()].copy_from_slice(tag);
    w.write_all(&header)?;
    w.write_all(&(tris.len() as u32).to_le_bytes())?;

    for t in tris {
        for c in normal(&t.v) {
            w.write_all(&c.to_le_bytes())?;
        }
        for v in &t.v {
            for c in v {
                w.write_all(&c.to_le_bytes())?;
            }
        }
        w.write_all(&[0, 0])?;
    }
    w.flush()?;
    Ok(())
}

/// 10 mm cube in 12 triangles, for the other modules' tests.
#[cfg(test)]
pub fn tests_cube() -> Vec<Tri> {
    // A 10 mm cube resting at the origin, in 12 triangles.
    #[rustfmt::skip]
    let p = [
        [0., 0., 0.], [10., 0., 0.], [10., 10., 0.], [0., 10., 0.],
        [0., 0., 10.], [10., 0., 10.], [10., 10., 10.], [0., 10., 10.],
    ];
    #[rustfmt::skip]
    let faces = [
        [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
        [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
        [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
    ];
    faces.iter().map(|f| Tri { v: [p[f[0]], p[f[1]], p[f[2]]], c: crate::render::DEFAULT_COLOR }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    use super::tests_cube as cube;

    #[test]
    fn round_trip() {
        let dir = std::env::temp_dir().join("snapstudio-stl-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cube.stl");
        let src = cube();
        write(&path, &src).unwrap();

        let back = read(&path).unwrap();
        assert_eq!(back.tris.len(), src.len(), "same number of triangles");
        assert_eq!(back.min, [0., 0., 0.]);
        assert_eq!(back.max, [10., 10., 10.]);
        for (a, b) in src.iter().zip(back.tris.iter()) {
            assert_eq!(a.v, b.v, "vertices kept byte for byte");
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reads_ascii() {
        let text = "solid essai
 facet normal 0 0 1
  outer loop
   vertex 0 0 0
   vertex 1 0 0
   vertex 0 1 0
  endloop
 endfacet
 facet normal 0 0 1
  outer loop
   vertex 0 0 2
   vertex 1 0 2
   vertex 0 1 2
  endloop
 endfacet
endsolid essai
";
        let dir = std::env::temp_dir().join("snapstudio-stl-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ascii.stl");
        std::fs::write(&path, text).unwrap();
        let m = read(&path).unwrap();
        assert_eq!(m.tris.len(), 2);
        assert_eq!(m.max, [1., 1., 2.]);
        let _ = std::fs::remove_file(&path);
    }

    /// A binary whose header starts with "solid" must not be taken for text:
    /// the format's classic trap.
    #[test]
    fn binary_header_saying_solid() {
        let dir = std::env::temp_dir().join("snapstudio-stl-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("piege.stl");
        write(&path, &cube()).unwrap();
        let mut data = std::fs::read(&path).unwrap();
        data[..5].copy_from_slice(b"solid");
        std::fs::write(&path, &data).unwrap();

        assert!(looks_binary(&data));
        assert_eq!(read(&path).unwrap().tris.len(), 12);
        let _ = std::fs::remove_file(&path);
    }
}
