//! Does an object probably need supports? A hint for Prepare, before any
//! slice, read on the mesh as it sits on the plate (scale and rotation
//! applied, resting on the bed).
//!
//! It looks for what Snapmaker Orca's own check warns about while slicing
//! with supports off (`PrintObject::is_support_necessary`, through
//! `TreeSupport::detect_overhangs`), which works on the layers:
//!
//! - **Floating regions:** something starts in the air. On the mesh, a low
//!   point (a vertex, or a patch within a layer of it, lower than all
//!   around) above the bed, with no other part of the object right under
//!   it. The same fact Orca finds, read without layers.
//! - **Floating cantilevers:** an overhang whose far point is more than
//!   6 mm from what holds it one layer down. Orca measures the corners of
//!   each layer's overhang; here, the corners of each overhang patch (faces
//!   pointing down more than the profile's angle) to the nearest support
//!   one layer lower: a wall going down from the patch's edge, another part
//!   right under it, a lower part of the patch itself, or the bed. An
//!   approximation, right on the clear cases (a "T", a shelf), and kept
//!   quiet on bridges, which are held at their corners.
//!
//! Plain overhang area is measured too, but never raises the hint on its
//! own: bridges, holes and chamfers print fine without supports. The
//! engine's warning after the slice (`slice::support_warnings`) has the
//! last word.

use crate::mesh::Tri;
use serde::Serialize;
use std::collections::HashMap;

/// A layer, as the check reasons in layers (mm).
const LAYER: f32 = 0.2;
/// A low point up to this height rests on the bed: the first layer.
const BED: f32 = 0.25;
/// Orca's threshold for a cantilever (`cantilevel_dist_thresh`, mm).
const CANTILEVER: f32 = 6.0;
/// Reaches are measured up to this distance (mm): far enough to tell.
const REACH_CAP: f32 = 4.0 * CANTILEVER;
/// Overhang area (mm²) past which an object "may" need supports: shown by
/// the overhang view only, never as a hint.
const MAYBE_AREA: f32 = 100.0;
/// Spacing of the points sampled on a surface (mm).
const SAMPLE: f32 = 1.0;
/// Samples per overhang patch at most: a wide one is sampled more loosely.
const MAX_SAMPLES: f32 = 20_000.0;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    /// Nothing that needs supports.
    None,
    /// Large overhangs only: bridges, holes or chamfers may well print.
    Maybe,
    /// Something starts in the air, or a long overhang sticks out.
    Likely,
}

/// What the mesh says about one object.
#[derive(Serialize, Clone, Debug)]
pub struct Hint {
    pub verdict: Verdict,
    /// Why, when `likely`: `floating` or `cantilever`.
    pub reason: Option<&'static str>,
    /// Regions that start in the air.
    pub floating: usize,
    /// The longest overhang reach found (mm), capped at `REACH_CAP`.
    pub reach: f32,
    /// Area of the faces pointing down more than the angle, above the bed (mm²).
    pub overhang_area: f32,
}

/// The hints of a plate, and the overhang angle they used (the overhang
/// view colors with the same).
#[derive(Serialize, Clone, Debug)]
pub struct Report {
    pub threshold: f64,
    /// One per object asked, in order; none for an object that cannot be read.
    pub items: Vec<Option<Hint>>,
}

/// The hint for triangles placed on the plate (lowest point at z = 0).
/// `threshold_deg`: the profile's overhang angle (`support_threshold_angle`).
pub fn analyse(tris: &[Tri], threshold_deg: f64) -> Hint {
    let m = Mesh::weld(tris);
    let mut below = Below::new(&m);
    let floating = floating_regions(&m, &mut below);
    let (reach, overhang_area) = overhangs(&m, &mut below, threshold_deg);
    let (verdict, reason) = if floating > 0 {
        (Verdict::Likely, Some("floating"))
    } else if reach > CANTILEVER {
        (Verdict::Likely, Some("cantilever"))
    } else if overhang_area > MAYBE_AREA {
        (Verdict::Maybe, None)
    } else {
        (Verdict::None, None)
    };
    Hint { verdict, reason, floating, reach, overhang_area }
}

// ------------------------------------------------------------ mesh

/// Triangles welded on their exact coordinates, with the faces around each
/// vertex and the number of shells (connected pieces).
struct Mesh {
    p: Vec<[f32; 3]>,
    f: Vec<[u32; 3]>,
    /// Faces around vertex `v`: `vf[vf_at[v]..vf_at[v + 1]]`.
    vf_at: Vec<u32>,
    vf: Vec<u32>,
    shells: usize,
}

impl Mesh {
    fn weld(tris: &[Tri]) -> Mesh {
        let mut ids: HashMap<[u32; 3], u32> = HashMap::with_capacity(tris.len());
        let mut p: Vec<[f32; 3]> = Vec::with_capacity(tris.len() / 2 + 3);
        let mut f = Vec::with_capacity(tris.len());
        for t in tris {
            let mut vs = [0u32; 3];
            for (k, v) in t.v.iter().enumerate() {
                // + 0.0 turns -0.0 into 0.0: one vertex, not two.
                let key = [(v[0] + 0.0).to_bits(), (v[1] + 0.0).to_bits(), (v[2] + 0.0).to_bits()];
                vs[k] = *ids.entry(key).or_insert_with(|| {
                    p.push(*v);
                    (p.len() - 1) as u32
                });
            }
            if vs[0] != vs[1] && vs[1] != vs[2] && vs[0] != vs[2] {
                f.push(vs);
            }
        }
        let n = p.len();
        let mut vf_at = vec![0u32; n + 1];
        for t in &f {
            for &v in t {
                vf_at[v as usize + 1] += 1;
            }
        }
        for i in 0..n {
            vf_at[i + 1] += vf_at[i];
        }
        let mut fill = vf_at.clone();
        let mut vf = vec![0u32; f.len() * 3];
        for (i, t) in f.iter().enumerate() {
            for &v in t {
                vf[fill[v as usize] as usize] = i as u32;
                fill[v as usize] += 1;
            }
        }
        // Shells: union-find over the faces' vertices.
        let mut parent: Vec<u32> = (0..n as u32).collect();
        fn find(p: &mut [u32], mut x: u32) -> u32 {
            while p[x as usize] != x {
                p[x as usize] = p[p[x as usize] as usize];
                x = p[x as usize];
            }
            x
        }
        for t in &f {
            let r0 = find(&mut parent, t[0]);
            for &v in &t[1..] {
                let r = find(&mut parent, v);
                if r != r0 {
                    parent[r as usize] = r0;
                }
            }
        }
        // Shells: the roots, among the vertices faces use.
        let mut roots: Vec<u32> = f.iter().map(|t| t[0]).collect();
        for r in roots.iter_mut() {
            *r = find(&mut parent, *r);
        }
        roots.sort_unstable();
        roots.dedup();
        Mesh { p, f, vf_at, vf, shells: roots.len() }
    }

    fn faces_of(&self, v: u32) -> &[u32] {
        &self.vf[self.vf_at[v as usize] as usize..self.vf_at[v as usize + 1] as usize]
    }

    fn z(&self, v: u32) -> f32 {
        self.p[v as usize][2]
    }

    fn corners(&self, f: u32) -> [[f32; 3]; 3] {
        self.f[f as usize].map(|v| self.p[v as usize])
    }

    /// Outward normal (by the winding), not unit: twice the area long.
    fn normal(&self, f: u32) -> [f32; 3] {
        let [a, b, c] = self.corners(f);
        let (u, w) = (sub(b, a), sub(c, a));
        [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
    }
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn len(a: [f32; 3]) -> f32 {
    (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt()
}

/// Points spread over a triangle about `step` apart, its corners included
/// (only its center when it is smaller than that), drawn a hair inwards so
/// that a point on a shared edge belongs to one side.
fn samples(t: [[f32; 3]; 3], step: f32, out: &mut Vec<[f32; 3]>) {
    let longest = len(sub(t[1], t[0])).max(len(sub(t[2], t[1]))).max(len(sub(t[0], t[2])));
    let c = [0, 1, 2].map(|k| (t[0][k] + t[1][k] + t[2][k]) / 3.0);
    let n = (longest / step).ceil().min(64.0) as usize;
    if n <= 1 {
        out.push(c);
        return;
    }
    for i in 0..=n {
        for j in 0..=n - i {
            let (a, b) = (i as f32 / n as f32, j as f32 / n as f32);
            let q = [0, 1, 2].map(|k| t[0][k] + a * (t[1][k] - t[0][k]) + b * (t[2][k] - t[0][k]));
            out.push([0, 1, 2].map(|k| c[k] + 0.98 * (q[k] - c[k])));
        }
    }
}

// ------------------------------------------------------------ what is below

/// Is there another part of the object right under a point? Only asked
/// when the mesh holds several shells: a point just under a shell's own
/// downward face is outside it. Faces bucketed on a grid seen from above,
/// built on first use.
struct Below<'a> {
    m: &'a Mesh,
    grid: Option<Grid>,
}

struct Grid {
    min: [f32; 2],
    cell: f32,
    nx: usize,
    ny: usize,
    at: Vec<u32>,
    faces: Vec<u32>,
}

impl<'a> Below<'a> {
    fn new(m: &'a Mesh) -> Self {
        Below { m, grid: None }
    }

    fn grid(&mut self) -> &Grid {
        let m = self.m;
        self.grid.get_or_insert_with(|| {
            let (mut lo, mut hi) = ([f32::MAX; 2], [f32::MIN; 2]);
            for p in &m.p {
                for k in 0..2 {
                    lo[k] = lo[k].min(p[k]);
                    hi[k] = hi[k].max(p[k]);
                }
            }
            let side = ((m.f.len() as f32).sqrt().ceil() as usize).clamp(1, 256);
            let cell = ((hi[0] - lo[0]).max(hi[1] - lo[1]) / side as f32).max(1e-3);
            let nx = ((hi[0] - lo[0]) / cell) as usize + 1;
            let ny = ((hi[1] - lo[1]) / cell) as usize + 1;
            let span = |f: u32| {
                let t = m.corners(f);
                let x0 = ((t.iter().map(|p| p[0]).fold(f32::MAX, f32::min) - lo[0]) / cell) as usize;
                let x1 = ((t.iter().map(|p| p[0]).fold(f32::MIN, f32::max) - lo[0]) / cell) as usize;
                let y0 = ((t.iter().map(|p| p[1]).fold(f32::MAX, f32::min) - lo[1]) / cell) as usize;
                let y1 = ((t.iter().map(|p| p[1]).fold(f32::MIN, f32::max) - lo[1]) / cell) as usize;
                (x0, x1.min(nx - 1), y0, y1.min(ny - 1))
            };
            let mut at = vec![0u32; nx * ny + 1];
            for f in 0..m.f.len() as u32 {
                let (x0, x1, y0, y1) = span(f);
                for y in y0..=y1 {
                    for x in x0..=x1 {
                        at[y * nx + x + 1] += 1;
                    }
                }
            }
            for i in 0..nx * ny {
                at[i + 1] += at[i];
            }
            let mut fill = at.clone();
            let mut faces = vec![0u32; at[nx * ny] as usize];
            for f in 0..m.f.len() as u32 {
                let (x0, x1, y0, y1) = span(f);
                for y in y0..=y1 {
                    for x in x0..=x1 {
                        faces[fill[y * nx + x] as usize] = f;
                        fill[y * nx + x] += 1;
                    }
                }
            }
            Grid { min: lo, cell, nx, ny, at, faces }
        })
    }

    /// Whether `q` lies inside the object: the nearest face straight under
    /// it points down (the underside of something it is in), or the
    /// nearest above points up. Unlike a count of crossings, right where
    /// shells overlap or touch (welded together on a shared corner).
    fn inside(&mut self, q: [f32; 3]) -> bool {
        if self.m.shells < 2 {
            return false;
        }
        // Nudged off the axes: a point exactly on an edge shared by two
        // faces of a flat side (a square's diagonal) would hit both.
        let (x, y) = (q[0] + 1.3e-3, q[1] + 2.1e-3);
        let m = self.m;
        let g = self.grid();
        let (cx, cy) = ((x - g.min[0]) / g.cell, (y - g.min[1]) / g.cell);
        if cx < 0.0 || cy < 0.0 || cx as usize >= g.nx || cy as usize >= g.ny {
            return false;
        }
        let cell = cy as usize * g.nx + cx as usize;
        // (height, facing up) of the nearest face under and over q.
        let (mut under, mut over): (Option<(f32, bool)>, Option<(f32, bool)>) = (None, None);
        for &f in &g.faces[g.at[cell] as usize..g.at[cell + 1] as usize] {
            let [a, b, c] = m.corners(f);
            // Twice the area seen from above, signed: positive facing up.
            let d = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
            if d.abs() < 1e-9 {
                continue;
            }
            let u = ((x - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (y - a[1])) / d;
            let v = ((b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1])) / d;
            if u < 0.0 || v < 0.0 || u + v > 1.0 {
                continue;
            }
            let z = a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]);
            if z <= q[2] {
                if under.is_none_or(|(h, _)| z > h) {
                    under = Some((z, d > 0.0));
                }
            } else if over.is_none_or(|(h, _)| z < h) {
                over = Some((z, d > 0.0));
            }
        }
        under.is_some_and(|(_, up)| !up) || over.is_some_and(|(_, up)| up)
    }
}

// ------------------------------------------------------------ floating regions

/// Low points above the bed with nothing under them. Vertices are taken
/// from the lowest up; each grows the region within a layer above it. A
/// region that reaches lower ground (a vertex already seen) is not a low
/// point; one walled in by higher vertices is, unless another shell holds
/// it from below. Each vertex is visited once.
fn floating_regions(m: &Mesh, below: &mut Below) -> usize {
    let n = m.p.len();
    let mut order: Vec<u32> = (0..n as u32).filter(|&v| m.vf_at[v as usize] < m.vf_at[v as usize + 1]).collect();
    order.sort_unstable_by(|&a, &b| m.z(a).total_cmp(&m.z(b)));
    let mut owner = vec![u32::MAX; n];
    let mut count = 0;
    let mut region: Vec<u32> = Vec::new();
    let mut stack: Vec<u32> = Vec::new();
    for (id, &seed) in order.iter().enumerate() {
        let id = id as u32;
        if owner[seed as usize] != u32::MAX {
            continue;
        }
        owner[seed as usize] = id;
        let z0 = m.z(seed);
        if z0 <= BED {
            continue;
        }
        region.clear();
        stack.clear();
        region.push(seed);
        stack.push(seed);
        let mut lower = false;
        'grow: while let Some(u) = stack.pop() {
            for &f in m.faces_of(u) {
                for nb in m.f[f as usize] {
                    let o = owner[nb as usize];
                    if o == id || m.z(nb) >= z0 + LAYER {
                        continue;
                    }
                    if o != u32::MAX || m.z(nb) < z0 {
                        lower = true;
                        break 'grow;
                    }
                    owner[nb as usize] = id;
                    region.push(nb);
                    stack.push(nb);
                }
            }
        }
        if lower {
            continue;
        }
        // A low point in the air: held by another shell right under it?
        let mut pts = Vec::new();
        for &v in &region {
            for &f in m.faces_of(v) {
                if m.f[f as usize].iter().all(|&w| owner[w as usize] == id) {
                    samples(m.corners(f), SAMPLE, &mut pts);
                }
            }
        }
        if pts.is_empty() {
            // A single point (a spike's tip): around it.
            let s = m.p[seed as usize];
            for &f in m.faces_of(seed) {
                let t = m.corners(f);
                pts.push([0, 1, 2].map(|k| s[k] + 0.1 * ((t[0][k] + t[1][k] + t[2][k]) / 3.0 - s[k])));
            }
        }
        let step = pts.len().div_ceil(512).max(1);
        let held = pts.iter().step_by(step).any(|q| below.inside([q[0], q[1], z0 - LAYER / 2.0]));
        if !held {
            count += 1;
        }
    }
    count
}

// ------------------------------------------------------------ overhangs

/// A point that holds an overhang one layer down.
#[derive(Clone, Copy)]
struct Anchor {
    p: [f32; 3],
    /// A wall going down from the patch's edge, or another shell under the
    /// patch: holds what is at most a layer above it.
    from_below: bool,
    /// A point of the patch itself: holds what is a layer or more above it
    /// (and everything when it lies on the bed).
    patch: bool,
}

impl Anchor {
    fn holds(&self, z: f32) -> bool {
        (self.from_below && self.p[2] >= z - LAYER) || (self.patch && (self.p[2] <= z - LAYER || self.p[2] <= BED))
    }
}

/// The longest overhang reach and the overhang area. Faces pointing down
/// more than the angle, above the bed, are grouped in patches through their
/// edges; for each patch, the corners of its outline are measured to the
/// nearest anchor that holds them.
fn overhangs(m: &Mesh, below: &mut Below, threshold_deg: f64) -> (f32, f32) {
    let cos_t = threshold_deg.to_radians().cos() as f32;
    let nf = m.f.len();
    let mut area = 0.0f32;
    let over: Vec<bool> = (0..nf as u32)
        .map(|f| {
            let n = m.normal(f);
            let l = len(n);
            let top = m.f[f as usize].iter().map(|&v| m.z(v)).fold(f32::MIN, f32::max);
            let is = l > 0.0 && -n[2] / l >= cos_t && top > BED;
            if is {
                area += l / 2.0;
            }
            is
        })
        .collect();

    let mut patch = vec![u32::MAX; nf];
    let mut reach = 0.0f32;
    let mut faces: Vec<u32> = Vec::new();
    let mut stack: Vec<u32> = Vec::new();
    for start in 0..nf as u32 {
        if !over[start as usize] || patch[start as usize] != u32::MAX {
            continue;
        }
        // The patch, its outline (vertex → neighbours along it) and the
        // edges a wall holds from below.
        faces.clear();
        patch[start as usize] = start;
        stack.push(start);
        let mut outline: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut walls: Vec<(u32, u32)> = Vec::new();
        while let Some(f) = stack.pop() {
            faces.push(f);
            let t = m.f[f as usize];
            for k in 0..3 {
                let (a, b) = (t[k], t[(k + 1) % 3]);
                let mut inner = false;
                let mut held = false;
                for &g in m.faces_of(a) {
                    let tg = m.f[g as usize];
                    if g == f || !tg.contains(&b) {
                        continue;
                    }
                    if over[g as usize] {
                        inner = true;
                        if patch[g as usize] == u32::MAX {
                            patch[g as usize] = start;
                            stack.push(g);
                        }
                    } else {
                        let c = tg.iter().copied().find(|&w| w != a && w != b).unwrap_or(a);
                        held |= m.z(c) < m.z(a).min(m.z(b)) - 1e-4;
                    }
                }
                if !inner {
                    outline.entry(a).or_default().push(b);
                    outline.entry(b).or_default().push(a);
                    if held {
                        walls.push((a, b));
                    }
                }
            }
        }

        // Anchors: along the held edges, and over the patch.
        let patch_area: f32 = faces.iter().map(|&f| len(m.normal(f)) / 2.0).sum();
        let step = SAMPLE.max((patch_area / MAX_SAMPLES).sqrt());
        let mut anchors: Vec<Anchor> = Vec::new();
        for &(a, b) in &walls {
            let (pa, pb) = (m.p[a as usize], m.p[b as usize]);
            let n = (len(sub(pb, pa)) / (step / 2.0)).ceil().clamp(1.0, 200.0) as usize;
            for i in 0..=n {
                let s = i as f32 / n as f32;
                let p = [0, 1, 2].map(|k| pa[k] + s * (pb[k] - pa[k]));
                anchors.push(Anchor { p, from_below: true, patch: false });
            }
        }
        let mut pts = Vec::new();
        for &f in &faces {
            samples(m.corners(f), step, &mut pts);
        }
        for p in pts {
            let from_below = below.inside([p[0], p[1], p[2] - LAYER / 2.0]);
            anchors.push(Anchor { p, from_below, patch: true });
        }
        let near = Near::new(&anchors, 2.0 * step);

        // The corners of the outline: where it turns, seen from above.
        for (&v, nbs) in &outline {
            let p = m.p[v as usize];
            if nbs.len() == 2 {
                let (a, b) = (m.p[nbs[0] as usize], m.p[nbs[1] as usize]);
                let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
                let l = (dx * dx + dy * dy).sqrt();
                if l > 0.0 && ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx).abs() / l < 0.02 {
                    continue;
                }
            }
            if let Some(d) = near.reach(&anchors, p) {
                reach = reach.max(d);
            }
        }
    }
    (reach, area)
}

/// Anchors bucketed on a grid seen from above, for the nearest one that
/// holds a point.
struct Near {
    cell: f32,
    buckets: HashMap<(i32, i32), Vec<u32>>,
}

impl Near {
    fn new(anchors: &[Anchor], cell: f32) -> Near {
        let mut buckets: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
        for (i, a) in anchors.iter().enumerate() {
            buckets.entry(Self::key(a.p, cell)).or_default().push(i as u32);
        }
        Near { cell, buckets }
    }

    fn key(p: [f32; 3], cell: f32) -> (i32, i32) {
        ((p[0] / cell).floor() as i32, (p[1] / cell).floor() as i32)
    }

    /// Horizontal distance from `p` to the nearest anchor holding it, up to
    /// `REACH_CAP`; none when nothing in the patch holds it (Orca skips
    /// those: a region in the air is the floating test's).
    fn reach(&self, anchors: &[Anchor], p: [f32; 3]) -> Option<f32> {
        let (cx, cy) = Self::key(p, self.cell);
        let rings = (REACH_CAP / self.cell).ceil() as i32 + 1;
        let mut best = f32::MAX;
        for r in 0..=rings {
            for y in cy - r..=cy + r {
                for x in cx - r..=cx + r {
                    if (y - cy).abs() != r && (x - cx).abs() != r {
                        continue;
                    }
                    let Some(list) = self.buckets.get(&(x, y)) else { continue };
                    for &i in list {
                        let a = &anchors[i as usize];
                        if a.holds(p[2]) {
                            best = best.min(((a.p[0] - p[0]).powi(2) + (a.p[1] - p[1]).powi(2)).sqrt());
                        }
                    }
                }
            }
            // Ring r covers every point closer than r cells.
            if best <= r as f32 * self.cell {
                return Some(best.min(REACH_CAP));
            }
        }
        if best < f32::MAX {
            return Some(best.min(REACH_CAP));
        }
        anchors.iter().any(|a| a.holds(p[2])).then_some(REACH_CAP)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A box's 12 triangles, facing outwards.
    fn cuboid(lo: [f32; 3], hi: [f32; 3]) -> Vec<Tri> {
        let (a, b) = (lo, hi);
        #[rustfmt::skip]
        let p = [
            [a[0], a[1], a[2]], [b[0], a[1], a[2]], [b[0], b[1], a[2]], [a[0], b[1], a[2]],
            [a[0], a[1], b[2]], [b[0], a[1], b[2]], [b[0], b[1], b[2]], [a[0], b[1], b[2]],
        ];
        #[rustfmt::skip]
        let f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
                 [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
        f.iter().map(|t| Tri { v: [p[t[0]], p[t[1]], p[t[2]]], c: [200; 3] }).collect()
    }

    /// Triangles of a simple polygon (counter-clockwise), by ear clipping.
    fn ears(p: &[[f32; 2]]) -> Vec<[usize; 3]> {
        let cross = |o: [f32; 2], a: [f32; 2], b: [f32; 2]| (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        let mut idx: Vec<usize> = (0..p.len()).collect();
        let mut out = Vec::new();
        while idx.len() > 3 {
            let n = idx.len();
            let ear = (0..n)
                .find(|&i| {
                    let (a, b, c) = (idx[(i + n - 1) % n], idx[i], idx[(i + 1) % n]);
                    cross(p[a], p[b], p[c]) > 0.0
                        && !idx.iter().any(|&j| {
                            j != a
                                && j != b
                                && j != c
                                && cross(p[a], p[b], p[j]) > 0.0
                                && cross(p[b], p[c], p[j]) > 0.0
                                && cross(p[c], p[a], p[j]) > 0.0
                        })
                })
                .expect("an ear");
            out.push([idx[(ear + n - 1) % n], idx[ear], idx[(ear + 1) % n]]);
            idx.remove(ear);
        }
        out.push([idx[0], idx[1], idx[2]]);
        out
    }

    /// One closed surface from an outline in (x, z), counter-clockwise,
    /// extruded along Y: what a modeller exports after a union, every
    /// face welded.
    fn extrude(outline: &[[f32; 2]], depth: f32) -> Vec<Tri> {
        let n = outline.len();
        let at = |i: usize, y: f32| [outline[i % n][0], y, outline[i % n][1]];
        let mut out = Vec::new();
        for i in 0..n {
            let (a0, b0, a1, b1) = (at(i, 0.0), at(i + 1, 0.0), at(i, depth), at(i + 1, depth));
            out.push(Tri { v: [a0, a1, b1], c: [200; 3] });
            out.push(Tri { v: [a0, b1, b0], c: [200; 3] });
        }
        for [a, b, c] in ears(outline) {
            out.push(Tri { v: [at(a, 0.0), at(b, 0.0), at(c, 0.0)], c: [200; 3] });
            out.push(Tri { v: [at(a, depth), at(c, depth), at(b, depth)], c: [200; 3] });
        }
        out
    }

    /// Faces all point outwards: the signed volume is positive.
    fn volume(tris: &[Tri]) -> f32 {
        tris.iter()
            .map(|t| {
                let [a, b, c] = t.v;
                (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
            })
            .sum()
    }

    fn rotate_x_90(tris: &mut [Tri]) {
        for t in tris.iter_mut() {
            for v in &mut t.v {
                *v = [v[0], -v[2], v[1]];
            }
        }
        // Back on the bed.
        let zmin = tris.iter().flat_map(|t| t.v.iter().map(|v| v[2])).fold(f32::MAX, f32::min);
        for t in tris {
            for v in &mut t.v {
                v[2] -= zmin;
            }
        }
    }

    fn concat(parts: Vec<Vec<Tri>>) -> Vec<Tri> {
        parts.into_iter().flatten().collect()
    }

    // The engine's check on the same models (see docs/plans/support-needed-hint.md).

    #[test]
    fn a_cube_needs_nothing() {
        let h = analyse(&cuboid([0.0; 3], [20.0; 3]), 30.0);
        assert_eq!(h.verdict, Verdict::None, "{h:?}");
        assert_eq!(h.overhang_area, 0.0);
    }

    #[test]
    fn a_t_has_a_cantilever() {
        // A 10 mm column with a 50 mm arm on top, 20 mm on each side.
        let welded =
            extrude(&[[20.0, 0.0], [30.0, 0.0], [30.0, 10.0], [50.0, 10.0], [50.0, 15.0], [0.0, 15.0], [0.0, 10.0], [20.0, 10.0]], 10.0);
        assert!((volume(&welded) - 1000.0 - 2500.0).abs() < 1e-2, "{}", volume(&welded));
        let h = analyse(&welded, 30.0);
        assert_eq!((h.verdict, h.reason, h.floating), (Verdict::Likely, Some("cantilever"), 0), "{h:?}");
        assert!(h.reach > 15.0, "{h:?}");
        // The same as two boxes, overlapping (a model not merged).
        let boxes = concat(vec![cuboid([20.0, 0.0, 0.0], [30.0, 10.0, 12.0]), cuboid([0.0, 0.0, 10.0], [50.0, 10.0, 15.0])]);
        let h = analyse(&boxes, 30.0);
        assert_eq!((h.verdict, h.reason, h.floating), (Verdict::Likely, Some("cantilever"), 0), "{h:?}");
    }

    #[test]
    fn a_hanging_block_floats() {
        // A column with an arm, and a block hanging under the arm's end.
        let tris = concat(vec![
            cuboid([20.0, 0.0, 0.0], [30.0, 10.0, 20.0]),
            cuboid([20.0, 0.0, 20.0], [50.0, 10.0, 25.0]),
            cuboid([42.0, 0.0, 10.0], [50.0, 10.0, 21.0]),
        ]);
        let h = analyse(&tris, 30.0);
        assert_eq!((h.verdict, h.reason), (Verdict::Likely, Some("floating")), "{h:?}");
        assert_eq!(h.floating, 1);
    }

    #[test]
    fn a_piece_in_the_air_floats() {
        let tris = concat(vec![cuboid([0.0; 3], [10.0; 3]), cuboid([30.0, 0.0, 5.0], [40.0, 10.0, 15.0])]);
        let h = analyse(&tris, 30.0);
        assert_eq!((h.verdict, h.floating), (Verdict::Likely, 1), "{h:?}");
    }

    #[test]
    fn a_bridge_needs_nothing() {
        // A 30 mm bridge between two pillars, welded and as three boxes.
        let welded =
            extrude(&[[0.0, 0.0], [10.0, 0.0], [10.0, 20.0], [40.0, 20.0], [40.0, 0.0], [50.0, 0.0], [50.0, 25.0], [0.0, 25.0]], 10.0);
        let h = analyse(&welded, 30.0);
        assert_eq!(h.reason, None, "{h:?}");
        assert!(h.verdict != Verdict::Likely);
        let boxes = concat(vec![
            cuboid([0.0, 0.0, 0.0], [10.0, 10.0, 20.0]),
            cuboid([40.0, 0.0, 0.0], [50.0, 10.0, 20.0]),
            cuboid([0.0, 0.0, 20.0], [50.0, 10.0, 25.0]),
        ]);
        let h = analyse(&boxes, 30.0);
        assert_eq!(h.reason, None, "{h:?}");
        assert_eq!(h.floating, 0);
    }

    #[test]
    fn a_rotation_changes_the_answer() {
        // The T, laid on its back (rotated 90° around X): a flat shape on
        // the bed, nothing to hold.
        let mut t =
            extrude(&[[20.0, 0.0], [30.0, 0.0], [30.0, 10.0], [50.0, 10.0], [50.0, 15.0], [0.0, 15.0], [0.0, 10.0], [20.0, 10.0]], 10.0);
        rotate_x_90(&mut t);
        let h = analyse(&t, 30.0);
        assert_eq!(h.verdict, Verdict::None, "{h:?}");
    }

    #[test]
    fn a_gentle_slope_is_no_cantilever() {
        // A wedge whose underside rises 20° from a wall: an overhang, held
        // layer by layer, as Orca sees it.
        let r = 20f32.to_radians().tan();
        let welded =
            extrude(&[[0.0, 0.0], [5.0, 0.0], [5.0, 2.0], [35.0, 2.0 + 30.0 * r], [35.0, 4.0 + 30.0 * r], [0.0, 4.0 + 30.0 * r]], 10.0);
        let h = analyse(&welded, 30.0);
        assert_eq!(h.reason, None, "{h:?}");
        assert!(h.overhang_area > 0.0);
    }

    /// A dense ball resting on the bed: its underside overhangs, held layer
    /// by layer from the bed up. Large overhangs, no more.
    #[test]
    fn a_ball_on_the_bed_may_only_need_supports() {
        let (r, rings, segs) = (20.0f32, 200, 400);
        let at = |i: usize, j: usize| {
            let (th, ph) = (std::f32::consts::PI * i as f32 / rings as f32, std::f32::consts::TAU * j as f32 / segs as f32);
            // The poles are single points, welded.
            let (s, c) = if i == 0 || i == rings { (0.0, if i == 0 { 1.0 } else { -1.0 }) } else { (th.sin(), th.cos()) };
            let ph = if s == 0.0 { 0.0 } else { ph };
            [r * s * ph.cos(), r * s * ph.sin(), r + r * c]
        };
        let mut tris = Vec::new();
        for i in 0..rings {
            for j in 0..segs {
                let (a, b, c, d) = (at(i, j), at(i, j + 1), at(i + 1, j), at(i + 1, j + 1));
                if i > 0 {
                    tris.push(Tri { v: [a, c, b], c: [200; 3] });
                }
                if i + 1 < rings {
                    tris.push(Tri { v: [b, c, d], c: [200; 3] });
                }
            }
        }
        assert!(volume(&tris) > 0.0);
        let t0 = std::time::Instant::now();
        let h = analyse(&tris, 30.0);
        eprintln!("{} triangles in {:?}: {h:?}", tris.len(), t0.elapsed());
        assert_eq!((h.verdict, h.floating), (Verdict::Maybe, 0), "{h:?}");
    }
}
