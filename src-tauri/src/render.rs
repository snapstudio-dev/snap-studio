//! Software rendering of a 3MF mesh (no GPU required) for files without an
//! embedded thumbnail.

use crate::mesh::MeshData;
use image::RgbaImage;

/// Slightly warm grey, readable on a dark background as on a light one.
pub const DEFAULT_COLOR: [u8; 3] = [196, 202, 214];

const SS: u32 = 2; // supersampling

#[inline]
fn norm(v: [f32; 3]) -> [f32; 3] {
    let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if l <= f32::EPSILON {
        [0., 0., 1.]
    } else {
        [v[0] / l, v[1] / l, v[2] / l]
    }
}
#[inline]
fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
#[inline]
fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Three-quarter isometric render, like a slicer preview.
pub fn render(mesh: &MeshData, size: u32) -> RgbaImage {
    render_from(mesh, size, [0.62, -1.0, 0.68])
}

/// Same render, from the requested angle: `eye` points from the object to the viewer.
pub fn render_from(mesh: &MeshData, size: u32, eye: [f32; 3]) -> RgbaImage {
    let w = (size * SS).max(16);
    let wf = w as f32;

    let eye = norm(eye);
    let f = [-eye[0], -eye[1], -eye[2]];
    // Seen from straight above, the vertical can no longer serve as reference:
    // the Y axis is used instead, otherwise the camera frame collapses.
    let axis = if f[0].abs() + f[1].abs() < 1e-3 { [0., 1., 0.] } else { [0., 0., 1.] };
    let right = norm(cross(f, axis));
    let up = cross(right, f);

    let c = [(mesh.min[0] + mesh.max[0]) * 0.5, (mesh.min[1] + mesh.max[1]) * 0.5, (mesh.min[2] + mesh.max[2]) * 0.5];

    // Framing: projection bounds.
    let (mut sx0, mut sy0, mut sx1, mut sy1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for t in &mesh.tris {
        for v in &t.v {
            let rel = [v[0] - c[0], v[1] - c[1], v[2] - c[2]];
            let x = dot(rel, right);
            let y = dot(rel, up);
            sx0 = sx0.min(x);
            sx1 = sx1.max(x);
            sy0 = sy0.min(y);
            sy1 = sy1.max(y);
        }
    }
    let span = (sx1 - sx0).max(sy1 - sy0).max(1e-4);
    let scale = wf * 0.90 / span;
    let ox = wf * 0.5 - (sx0 + sx1) * 0.5 * scale;
    let oy = wf * 0.5 + (sy0 + sy1) * 0.5 * scale;

    let mut color = vec![0f32; (w * w * 3) as usize];
    let mut alpha = vec![0f32; (w * w) as usize];
    let mut zbuf = vec![f32::MAX; (w * w) as usize];

    // Lights expressed in the camera frame (x right, y up, z towards the back).
    let key = norm([-0.45, 0.72, -0.58]);
    let fill = norm([0.75, -0.15, -0.35]);

    for t in &mesh.tris {
        // Projection
        let mut p = [[0f32; 3]; 3];
        for i in 0..3 {
            let rel = [t.v[i][0] - c[0], t.v[i][1] - c[1], t.v[i][2] - c[2]];
            p[i] = [ox + dot(rel, right) * scale, oy - dot(rel, up) * scale, dot(rel, f)];
        }
        let area = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1]);
        if area.abs() < 1e-6 {
            continue;
        }

        // World normal then camera frame, facing the viewer.
        let e1 = [t.v[1][0] - t.v[0][0], t.v[1][1] - t.v[0][1], t.v[1][2] - t.v[0][2]];
        let e2 = [t.v[2][0] - t.v[0][0], t.v[2][1] - t.v[0][1], t.v[2][2] - t.v[0][2]];
        let mut n = norm(cross(e1, e2));
        if dot(n, f) > 0.0 {
            n = [-n[0], -n[1], -n[2]];
        }
        let nv = [dot(n, right), dot(n, up), dot(n, f)];
        let facing = (-nv[2]).clamp(0.0, 1.0);

        let diff = dot(nv, key).max(0.0);
        let fil = dot(nv, fill).max(0.0) * 0.22;
        // Hemispheric ambient: sky above, darker ground.
        let amb = 0.30 + 0.16 * (n[2] * 0.5 + 0.5);
        // Rim light: sets dark parts off the background.
        let rim = (1.0 - facing).powi(3) * 0.55;
        let h = norm([key[0], key[1], key[2] - 1.0]);
        let spec = dot(nv, h).max(0.0).powi(26) * 0.30;

        let lit = amb + diff * 0.82 + fil;
        let base = [t.c[0] as f32 / 255.0, t.c[1] as f32 / 255.0, t.c[2] as f32 / 255.0];
        let rgb = [
            (base[0] * lit + spec + rim * 0.85).min(1.0),
            (base[1] * lit + spec + rim * 0.88).min(1.0),
            (base[2] * lit + spec + rim * 1.0).min(1.0),
        ];

        // Rasterization with a depth buffer.
        let minx = p[0][0].min(p[1][0]).min(p[2][0]).floor().max(0.0) as i64;
        let maxx = (p[0][0].max(p[1][0]).max(p[2][0]).ceil() as i64).min(w as i64 - 1);
        let miny = p[0][1].min(p[1][1]).min(p[2][1]).floor().max(0.0) as i64;
        let maxy = (p[0][1].max(p[1][1]).max(p[2][1]).ceil() as i64).min(w as i64 - 1);
        if minx > maxx || miny > maxy {
            continue;
        }
        let inv_area = 1.0 / area;
        for y in miny..=maxy {
            let py = y as f32 + 0.5;
            for x in minx..=maxx {
                let px = x as f32 + 0.5;
                let w0 = ((p[1][0] - p[0][0]) * (py - p[0][1]) - (px - p[0][0]) * (p[1][1] - p[0][1])) * inv_area;
                let w1 = ((px - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (py - p[0][1])) * inv_area;
                if w0 < 0.0 || w1 < 0.0 || w0 + w1 > 1.0 {
                    continue;
                }
                let z = p[0][2] + w1 * (p[1][2] - p[0][2]) + w0 * (p[2][2] - p[0][2]);
                let idx = (y as u32 * w + x as u32) as usize;
                if z < zbuf[idx] {
                    zbuf[idx] = z;
                    color[idx * 3] = rgb[0];
                    color[idx * 3 + 1] = rgb[1];
                    color[idx * 3 + 2] = rgb[2];
                    alpha[idx] = 1.0;
                }
            }
        }
    }

    // 2x2 reduction (anti-aliasing) into the final image.
    let mut img = RgbaImage::new(size, size);
    for y in 0..size {
        for x in 0..size {
            let (mut r, mut g, mut b, mut a) = (0f32, 0f32, 0f32, 0f32);
            for sy in 0..SS {
                for sx in 0..SS {
                    let idx = ((y * SS + sy) * w + (x * SS + sx)) as usize;
                    r += color[idx * 3];
                    g += color[idx * 3 + 1];
                    b += color[idx * 3 + 2];
                    a += alpha[idx];
                }
            }
            let n = (SS * SS) as f32;
            let cov = a / n;
            let px = if cov > 0.0 {
                let k = 1.0 / a;
                [(r * k * 255.0) as u8, (g * k * 255.0) as u8, (b * k * 255.0) as u8, (cov * 255.0) as u8]
            } else {
                [0, 0, 0, 0]
            };
            img.put_pixel(x, y, image::Rgba(px));
        }
    }
    img
}

/// Path feature colors, aligned on the viewer's.
pub const FEATURE_COLORS: [[u8; 3]; 12] = [
    [150, 158, 175], // autre
    [232, 108, 62],  // outer wall
    [236, 168, 84],  // inner wall
    [226, 84, 106],  // top surface
    [120, 170, 226], // bottom surface
    [150, 120, 214], // remplissage
    [98, 186, 160],  // remplissage plein
    [70, 150, 235],  // pont
    [120, 132, 154], // support
    [214, 200, 96],  // skirt and brim
    [180, 120, 190], // prime tower
    [242, 96, 96],   // surplomb
];

/// Preview render of toolpaths: same isometric framing as meshes, lines with a
/// depth buffer.
pub fn render_paths(segs: &[crate::gcode::Seg], min: [f32; 3], max: [f32; 3], size: u32) -> RgbaImage {
    let w = (size * SS).max(16);
    let wf = w as f32;

    let eye = norm([0.62, -1.0, 0.68]);
    let f = [-eye[0], -eye[1], -eye[2]];
    let right = norm(cross(f, [0., 0., 1.]));
    let up = cross(right, f);
    let c = [(min[0] + max[0]) * 0.5, (min[1] + max[1]) * 0.5, (min[2] + max[2]) * 0.5];

    let project = |p: &[f32; 3]| {
        let rel = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
        (dot(rel, right), dot(rel, up), dot(rel, f))
    };

    // "other" paths come from the start G-code (prime line): they are ignored
    // as soon as real toolpaths exist.
    let has_typed = segs.iter().any(|s| !s.travel && s.feature != 0);
    let drawn = |s: &crate::gcode::Seg| !s.travel && (!has_typed || s.feature != 0);

    let (mut sx0, mut sy0, mut sx1, mut sy1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for s in segs {
        if !drawn(s) {
            continue;
        }
        for p in [&s.a, &s.b] {
            let (x, y, _) = project(p);
            sx0 = sx0.min(x);
            sx1 = sx1.max(x);
            sy0 = sy0.min(y);
            sy1 = sy1.max(y);
        }
    }
    if sx0 > sx1 {
        return RgbaImage::new(size, size);
    }
    let span = (sx1 - sx0).max(sy1 - sy0).max(1e-4);
    let scale = wf * 0.88 / span;
    let ox = wf * 0.5 - (sx0 + sx1) * 0.5 * scale;
    let oy = wf * 0.5 + (sy0 + sy1) * 0.5 * scale;

    let mut color = vec![0f32; (w * w * 3) as usize];
    let mut alpha = vec![0f32; (w * w) as usize];
    let mut zbuf = vec![f32::MAX; (w * w) as usize];
    let thick = ((size as f32 / 120.0).round() as i64).max(1) * SS as i64 / 2 + 1;

    for s in segs {
        if !drawn(s) {
            continue;
        }
        let (ax, ay, az) = project(&s.a);
        let (bx, by, bz) = project(&s.b);
        let (x0, y0) = (ox + ax * scale, oy - ay * scale);
        let (x1, y1) = (ox + bx * scale, oy - by * scale);
        let steps = ((x1 - x0).abs().max((y1 - y0).abs()).ceil() as i64).max(1);
        let base = FEATURE_COLORS[(s.feature as usize).min(FEATURE_COLORS.len() - 1)];
        // Higher layers are a little lighter: it gives relief.
        let t = ((s.a[2] - min[2]) / (max[2] - min[2] + 1e-3)).clamp(0.0, 1.0);
        let shade = 0.68 + 0.32 * t;
        let rgb = [base[0] as f32 / 255.0 * shade, base[1] as f32 / 255.0 * shade, base[2] as f32 / 255.0 * shade];
        for i in 0..=steps {
            let u = i as f32 / steps as f32;
            let px = x0 + (x1 - x0) * u;
            let py = y0 + (y1 - y0) * u;
            let pz = az + (bz - az) * u;
            for dy in -thick..=thick {
                for dx in -thick..=thick {
                    let xi = px as i64 + dx;
                    let yi = py as i64 + dy;
                    if xi < 0 || yi < 0 || xi >= w as i64 || yi >= w as i64 {
                        continue;
                    }
                    let idx = (yi as u32 * w + xi as u32) as usize;
                    if pz < zbuf[idx] {
                        zbuf[idx] = pz;
                        color[idx * 3] = rgb[0];
                        color[idx * 3 + 1] = rgb[1];
                        color[idx * 3 + 2] = rgb[2];
                        alpha[idx] = 1.0;
                    }
                }
            }
        }
    }

    let mut img = RgbaImage::new(size, size);
    for y in 0..size {
        for x in 0..size {
            let (mut r, mut g, mut b, mut a) = (0f32, 0f32, 0f32, 0f32);
            for sy in 0..SS {
                for sx in 0..SS {
                    let idx = ((y * SS + sy) * w + (x * SS + sx)) as usize;
                    r += color[idx * 3];
                    g += color[idx * 3 + 1];
                    b += color[idx * 3 + 2];
                    a += alpha[idx];
                }
            }
            let n = (SS * SS) as f32;
            let cov = a / n;
            let px = if cov > 0.0 {
                let k = 1.0 / a;
                [(r * k * 255.0) as u8, (g * k * 255.0) as u8, (b * k * 255.0) as u8, (cov * 255.0) as u8]
            } else {
                [0, 0, 0, 0]
            };
            img.put_pixel(x, y, image::Rgba(px));
        }
    }
    img
}
