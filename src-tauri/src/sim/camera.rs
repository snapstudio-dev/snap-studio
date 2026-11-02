//! The camera's picture: no image of a print, a card saying what the printer
//! does (its name, state, layer, progress, time) with SIMULATED across it,
//! so that a screenshot cannot pass for a real machine.

use image::{Rgb, RgbImage};

pub const W: u32 = 640;
pub const H: u32 = 360;

/// What the picture shows.
pub struct Card {
    pub name: String,
    pub state: String,
    pub layer: Option<(u32, u32)>,
    pub progress: f64,
    /// Simulated seconds since the printer started.
    pub clock_s: f64,
    pub accent: [u8; 3],
}

/// 5 × 7 glyphs, one row per byte (bit 4 on the left).
fn glyph(c: char) -> [u8; 7] {
    match c.to_ascii_uppercase() {
        'A' => [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
        'B' => [0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E],
        'C' => [0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E],
        'D' => [0x1E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1E],
        'E' => [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F],
        'F' => [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10],
        'G' => [0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F],
        'H' => [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
        'I' => [0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E],
        'J' => [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C],
        'K' => [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
        'L' => [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F],
        'M' => [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11],
        'N' => [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
        'O' => [0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
        'P' => [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10],
        'Q' => [0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D],
        'R' => [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11],
        'S' => [0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E],
        'T' => [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
        'U' => [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
        'V' => [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04],
        'W' => [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0A],
        'X' => [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11],
        'Y' => [0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04],
        'Z' => [0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F],
        '0' => [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
        '1' => [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
        '2' => [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F],
        '3' => [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E],
        '4' => [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
        '5' => [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
        '6' => [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
        '7' => [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
        '8' => [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
        '9' => [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
        ':' => [0x00, 0x0C, 0x0C, 0x00, 0x0C, 0x0C, 0x00],
        '.' => [0x00, 0x00, 0x00, 0x00, 0x00, 0x0C, 0x0C],
        '-' => [0x00, 0x00, 0x00, 0x1F, 0x00, 0x00, 0x00],
        '/' => [0x01, 0x01, 0x02, 0x04, 0x08, 0x10, 0x10],
        '%' => [0x18, 0x19, 0x02, 0x04, 0x08, 0x13, 0x03],
        '_' => [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1F],
        ' ' => [0; 7],
        _ => [0x1F, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1F],
    }
}

fn text(img: &mut RgbImage, s: &str, x: u32, y: u32, scale: u32, color: [u8; 3]) {
    for (k, c) in s.chars().enumerate() {
        let g = glyph(c);
        let gx = x + k as u32 * 6 * scale;
        for (row, bits) in g.iter().enumerate() {
            for col in 0..5 {
                if bits & (0x10 >> col) == 0 {
                    continue;
                }
                for dy in 0..scale {
                    for dx in 0..scale {
                        let (px, py) = (gx + col * scale + dx, y + row as u32 * scale + dy);
                        if px < W && py < H {
                            img.put_pixel(px, py, Rgb(color));
                        }
                    }
                }
            }
        }
    }
}

fn rect(img: &mut RgbImage, x: u32, y: u32, w: u32, h: u32, color: [u8; 3]) {
    for py in y..(y + h).min(H) {
        for px in x..(x + w).min(W) {
            img.put_pixel(px, py, Rgb(color));
        }
    }
}

/// The picture, as a JPEG.
pub fn frame(c: &Card) -> Vec<u8> {
    let mut img = RgbImage::from_pixel(W, H, Rgb([24, 26, 30]));
    // A faint grid: the bed seen from above.
    for y in (0..H).step_by(24) {
        rect(&mut img, 0, y, W, 1, [34, 37, 43]);
    }
    for x in (0..W).step_by(24) {
        rect(&mut img, x, 0, 1, H, [34, 37, 43]);
    }
    rect(&mut img, 0, 0, W, 6, c.accent);
    text(&mut img, &c.name, 24, 24, 4, [235, 235, 240]);
    text(&mut img, &c.state, 24, 70, 3, c.accent);
    let layer = c.layer.map(|(a, b)| format!("LAYER {a}/{b}")).unwrap_or_default();
    text(&mut img, &layer, 24, 106, 3, [200, 200, 210]);
    let t = c.clock_s.max(0.0) as u64;
    text(&mut img, &format!("{:02}:{:02}:{:02}", t / 3600, t / 60 % 60, t % 60), 440, 106, 3, [150, 150, 160]);
    // Progress bar.
    let p = c.progress.clamp(0.0, 1.0);
    rect(&mut img, 24, 146, W - 48, 18, [52, 56, 64]);
    rect(&mut img, 24, 146, ((W - 48) as f64 * p) as u32, 18, c.accent);
    text(&mut img, &format!("{:.0}%", p * 100.0), 24, 172, 2, [200, 200, 210]);
    // The word that matters.
    rect(&mut img, 0, 230, W, 84, [150, 28, 28]);
    text(&mut img, "SIMULATED", (W - 9 * 6 * 8) / 2, 242, 8, [255, 255, 255]);
    let mut out = std::io::Cursor::new(Vec::new());
    let _ = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80).encode_image(&img);
    out.into_inner()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_picture_is_a_jpeg() {
        let jpg = frame(&Card {
            name: "Sim U1 Alpha".into(),
            state: "PRINTING".into(),
            layer: Some((12, 80)),
            progress: 0.4,
            clock_s: 3725.0,
            accent: [47, 111, 214],
        });
        assert_eq!(&jpg[..2], &[0xFF, 0xD8]);
        let img = image::load_from_memory(&jpg).unwrap();
        assert_eq!((img.width(), img.height()), (W, H));
    }
}
