//! Images of the print inside the G-code, for the printer's screen.
//!
//! The U1 shows a print's picture from its G-code: Moonraker reads the
//! `; thumbnail begin` blocks after the header and serves them to the screen
//! (`server.files.thumbnails_base64`). Snapmaker Orca's interface renders
//! them while exporting (`GCode.cpp`, `thumbnail_cb`), but its command line
//! exports without a renderer (`Snapmaker_Orca.cpp`: `export_gcode(…,
//! nullptr)`): our G-code had none, and the screen showed its default
//! picture. They are rendered here (`render.rs`) and inserted where Orca
//! puts them, in the same format (`GCode/Thumbnails.hpp`).

use crate::mesh::MeshData;
use anyhow::Result;
use std::io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

/// Base64 characters per line, as Orca writes them.
const ROW: usize = 78;

/// The config block closes the G-code: the sizes are read from its end.
const TAIL: u64 = 512 * 1024;

/// Sizes the profile asks for, PNG ones only (`; thumbnails = 48x48/PNG,
/// 300x300/PNG` in the config block; no format means PNG, as in Orca).
pub fn sizes(config: &str) -> Vec<(u32, u32)> {
    let Some(value) = config.lines().find_map(|l| l.strip_prefix("; thumbnails = ")) else {
        return Vec::new();
    };
    value
        .split(',')
        .filter_map(|item| {
            let (dims, format) = item.trim().split_once('/').unwrap_or((item.trim(), "PNG"));
            if !format.trim().eq_ignore_ascii_case("PNG") {
                return None;
            }
            let (w, h) = dims.split_once('x')?;
            let (w, h) = (w.trim().parse::<u32>().ok()?, h.trim().parse::<u32>().ok()?);
            (w > 0 && h > 0 && w <= 2048 && h <= 2048).then_some((w, h))
        })
        .collect()
}

/// Orca's block for one PNG image.
pub fn block(w: u32, h: u32, png: &[u8]) -> String {
    let encoded = crate::util::b64_encode(png);
    let mut out = format!("; THUMBNAIL_BLOCK_START\n\n;\n; thumbnail begin {w}x{h} {}\n", encoded.len());
    for row in encoded.as_bytes().chunks(ROW) {
        out.push_str("; ");
        out.push_str(std::str::from_utf8(row).unwrap_or_default());
        out.push('\n');
    }
    out.push_str("; thumbnail end\n; THUMBNAIL_BLOCK_END\n\n");
    out
}

/// The plate seen as in Orca: three-quarter view framed on the objects,
/// transparent background. A non-square size gets the square render
/// centered.
pub fn image(mesh: &MeshData, w: u32, h: u32) -> Result<Vec<u8>> {
    let side = w.min(h);
    let render = crate::render::render(mesh, side);
    let mut canvas = image::RgbaImage::new(w, h);
    image::imageops::overlay(&mut canvas, &render, ((w - side) / 2) as i64, ((h - side) / 2) as i64);
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(canvas).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)?;
    Ok(png)
}

/// Puts the images the profile asks for into the G-code, right after
/// `; HEADER_BLOCK_END`. False, file untouched, when it asks for none, when
/// the G-code already has some (a future engine), or has no header.
pub fn embed(gcode: &Path, mesh: &MeshData) -> Result<bool> {
    let mut file = std::fs::File::open(gcode)?;
    let len = file.metadata()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(TAIL)))?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail)?;
    let wanted = sizes(&String::from_utf8_lossy(&tail));
    if wanted.is_empty() || mesh.tris.is_empty() {
        return Ok(false);
    }
    file.seek(SeekFrom::Start(0))?;
    let mut rd = BufReader::with_capacity(1 << 16, file);

    // The header, up to its end and the blank line after it.
    let mut head = Vec::new();
    let mut line = Vec::new();
    let mut found = false;
    for _ in 0..200 {
        line.clear();
        if rd.read_until(b'\n', &mut line)? == 0 {
            break;
        }
        head.extend_from_slice(&line);
        if line.starts_with(b"; HEADER_BLOCK_END") {
            found = true;
            break;
        }
    }
    if !found {
        return Ok(false);
    }
    // Orca follows the header with a blank line, then the images if any.
    let mut next = Vec::new();
    rd.read_until(b'\n', &mut next)?;
    if next.iter().all(u8::is_ascii_whitespace) && !next.is_empty() {
        head.extend_from_slice(&next);
        next.clear();
        rd.read_until(b'\n', &mut next)?;
    } else {
        head.push(b'\n');
    }
    if next.starts_with(b"; THUMBNAIL_BLOCK_START") {
        return Ok(false);
    }

    let mut blocks = String::new();
    for (w, h) in wanted {
        blocks.push_str(&block(w, h, &image(mesh, w, h)?));
    }
    let tmp = gcode.with_extension("gcode.thumbs");
    {
        let mut out = BufWriter::with_capacity(1 << 16, std::fs::File::create(&tmp)?);
        out.write_all(&head)?;
        out.write_all(blocks.as_bytes())?;
        out.write_all(&next)?;
        std::io::copy(&mut rd, &mut out)?;
        out.flush()?;
    }
    std::fs::rename(&tmp, gcode)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::Tri;

    fn cube() -> MeshData {
        #[rustfmt::skip]
        let p = [[0., 0., 0.], [10., 0., 0.], [10., 10., 0.], [0., 10., 0.], [0., 0., 10.], [10., 0., 10.], [10., 10., 10.], [0., 10., 10.]];
        #[rustfmt::skip]
        let f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
        MeshData {
            tris: f.iter().map(|t| Tri { v: [p[t[0]], p[t[1]], p[t[2]]], c: [200, 40, 40] }).collect(),
            min: [0.0; 3],
            max: [10.0; 3],
            ..Default::default()
        }
    }

    const GCODE: &str = "; HEADER_BLOCK_START\n; generated by Snapmaker Orca 2.4.0\n; total layer number: 2\n; HEADER_BLOCK_END\n\n; EXECUTABLE_BLOCK_START\nG28\nG1 X10 Y10 E1\n; EXECUTABLE_BLOCK_END\n; CONFIG_BLOCK_START\n; layer_height = 0.2\n; thumbnails = 48x48/PNG, 300x300/PNG\n; CONFIG_BLOCK_END\n";

    #[test]
    fn sizes_follow_the_profile() {
        assert_eq!(sizes("; thumbnails = 48x48/PNG, 300x300/PNG\n"), vec![(48, 48), (300, 300)]);
        // No format is PNG; other formats are not ours to write.
        assert_eq!(sizes("; thumbnails = 600x600\n"), vec![(600, 600)]);
        assert_eq!(sizes("; thumbnails = 300x300/QOI, 32x32/PNG\n"), vec![(32, 32)]);
        assert_eq!(sizes("; thumbnails = \n"), Vec::<(u32, u32)>::new());
        assert_eq!(sizes("; layer_height = 0.2\n"), Vec::<(u32, u32)>::new());
    }

    #[test]
    fn blocks_are_orcas() {
        let png = image(&cube(), 48, 48).unwrap();
        let b = block(48, 48, &png);
        let lines: Vec<&str> = b.trim_end().lines().collect();
        assert_eq!(&lines[..3], &["; THUMBNAIL_BLOCK_START", "", ";"]);
        let len = crate::util::b64_encode(&png).len();
        assert_eq!(lines[3], format!("; thumbnail begin 48x48 {len}"));
        let rows = &lines[4..lines.len() - 2];
        assert!(rows.iter().all(|r| r.starts_with("; ") && r.len() <= ROW + 2));
        assert_eq!(rows.iter().map(|r| r.len() - 2).sum::<usize>(), len);
        assert_eq!(&lines[lines.len() - 2..], &["; thumbnail end", "; THUMBNAIL_BLOCK_END"]);
        assert!(b.ends_with("; THUMBNAIL_BLOCK_END\n\n"));
    }

    #[test]
    fn embedding_puts_the_images_after_the_header_once() {
        let dir = std::env::temp_dir().join("snapstudio_gcode_thumbs");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("plate_1.gcode");
        std::fs::write(&path, GCODE).unwrap();
        assert!(embed(&path, &cube()).unwrap());
        let out = std::fs::read_to_string(&path).unwrap();
        // The header, then the two blocks, then the rest unchanged.
        let head_end = out.find("; HEADER_BLOCK_END\n\n").unwrap() + "; HEADER_BLOCK_END\n\n".len();
        assert_eq!(&out[..head_end], &GCODE[..head_end]);
        assert!(out[head_end..].starts_with("; THUMBNAIL_BLOCK_START\n"));
        assert!(out.ends_with(&GCODE[head_end..]));
        assert_eq!(out.matches("; thumbnail begin").count(), 2);
        let first = out.find("thumbnail begin 48x48").unwrap();
        assert!(first < out.find("thumbnail begin 300x300").unwrap());
        // What a reader of the G-code (Moonraker, our Files tab) gets.
        let png = crate::gcode::embedded_thumbnail(std::fs::File::open(&path).unwrap()).unwrap();
        let img = image::load_from_memory(&png).unwrap();
        assert_eq!((img.width(), img.height()), (300, 300));
        assert_eq!(img.to_rgba8().get_pixel(0, 0)[3], 0, "transparent background");
        assert!(img.to_rgba8().get_pixel(150, 150)[3] > 0, "the object in the middle");
        // Once only.
        assert!(!embed(&path, &cube()).unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), out);
    }

    #[test]
    fn nothing_without_sizes_or_header() {
        let dir = std::env::temp_dir().join("snapstudio_gcode_thumbs");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("none.gcode");
        let without = GCODE.replace("; thumbnails = 48x48/PNG, 300x300/PNG\n", "");
        std::fs::write(&path, &without).unwrap();
        assert!(!embed(&path, &cube()).unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), without);
        let headless = GCODE.replace("; HEADER_BLOCK_END\n", "");
        std::fs::write(&path, &headless).unwrap();
        assert!(!embed(&path, &cube()).unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), headless);
    }
}
