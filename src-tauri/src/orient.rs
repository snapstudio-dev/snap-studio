//! 3D convex hull and automatic orientation of an object.
//!
//! Orientation faithfully follows Snapmaker Orca's "Auto orient"
//! (`libslic3r/Orient.cpp`, default "optimize support interface area" mode):
//! same candidate orientations, same measurements, same cost function. Only
//! difference: Orca penalizes support more on faces marked "appearance", a
//! mark our files do not carry.

use crate::mesh::Tri;
use anyhow::{anyhow, Result};
use std::collections::HashMap;

type V3 = [f64; 3];

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}
fn unit(a: V3) -> V3 {
    let l = norm(a);
    if l > 0.0 {
        [a[0] / l, a[1] / l, a[2] / l]
    } else {
        a
    }
}

// ------------------------------------------------------------ convex hull

/// Convex hull: vertices and triangles facing outwards.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Hull {
    pub points: Vec<[f32; 3]>,
    pub faces: Vec<[u32; 3]>,
}

struct Face {
    v: [usize; 3],
    n: V3,
    d: f64,
    outside: Vec<usize>,
    alive: bool,
}

impl Face {
    fn new(p: &[V3], v: [usize; 3]) -> Face {
        let n = unit(cross(sub(p[v[1]], p[v[0]]), sub(p[v[2]], p[v[0]])));
        Face { v, n, d: dot(n, p[v[0]]), outside: Vec::new(), alive: true }
    }
    fn dist(&self, q: V3) -> f64 {
        dot(self.n, q) - self.d
    }
}

/// Distinct vertices of a mesh (merged to the micron).
pub fn unique_points(tris: &[Tri]) -> Vec<V3> {
    let mut seen: HashMap<[i64; 3], ()> = HashMap::new();
    let mut out = Vec::new();
    for t in tris {
        for v in &t.v {
            let k = [(v[0] * 1000.0) as i64, (v[1] * 1000.0) as i64, (v[2] * 1000.0) as i64];
            if seen.insert(k, ()).is_none() {
                out.push([v[0] as f64, v[1] as f64, v[2] as f64]);
            }
        }
    }
    out
}

/// 3D Quickhull. Fails on a flat or degenerate cloud.
pub fn convex_hull(p: &[V3]) -> Result<Hull> {
    if p.len() < 4 {
        return Err(anyhow!("too few points"));
    }
    // Scale for tolerances.
    let (mut lo, mut hi) = ([f64::MAX; 3], [f64::MIN; 3]);
    for q in p {
        for k in 0..3 {
            lo[k] = lo[k].min(q[k]);
            hi[k] = hi[k].max(q[k]);
        }
    }
    let scale = norm(sub(hi, lo)).max(1e-9);
    let eps = scale * 1e-9 * 16.0;

    // Initial simplex: X extremes, farthest point from the line, then from the plane.
    let (mut a, mut b) = (0, 0);
    for (i, q) in p.iter().enumerate() {
        if q[0] < p[a][0] {
            a = i;
        }
        if q[0] > p[b][0] {
            b = i;
        }
    }
    if norm(sub(p[b], p[a])) < eps {
        // All aligned on X: look for any distinct pair.
        b = (0..p.len()).max_by(|&i, &j| norm(sub(p[i], p[a])).total_cmp(&norm(sub(p[j], p[a])))).unwrap();
    }
    let ab = sub(p[b], p[a]);
    let c = (0..p.len()).max_by(|&i, &j| norm(cross(ab, sub(p[i], p[a]))).total_cmp(&norm(cross(ab, sub(p[j], p[a]))))).unwrap();
    let nrm = unit(cross(ab, sub(p[c], p[a])));
    if norm(cross(ab, sub(p[c], p[a]))) < eps * scale {
        return Err(anyhow!("collinear points"));
    }
    let d = (0..p.len()).max_by(|&i, &j| dot(nrm, sub(p[i], p[a])).abs().total_cmp(&dot(nrm, sub(p[j], p[a])).abs())).unwrap();
    if dot(nrm, sub(p[d], p[a])).abs() < eps {
        return Err(anyhow!("flat object"));
    }

    let mut faces: Vec<Face> = Vec::new();
    let tet = [a, b, c, d];
    for f in [[a, b, c], [a, c, d], [a, d, b], [b, d, c]] {
        let mut face = Face::new(p, f);
        // The fourth vertex must be behind the face.
        let other = *tet.iter().find(|x| !f.contains(x)).unwrap();
        if face.dist(p[other]) > 0.0 {
            face = Face::new(p, [f[0], f[2], f[1]]);
        }
        faces.push(face);
    }
    // Oriented edge → face.
    let mut edges: HashMap<(usize, usize), usize> = HashMap::new();
    for (i, f) in faces.iter().enumerate() {
        for k in 0..3 {
            edges.insert((f.v[k], f.v[(k + 1) % 3]), i);
        }
    }
    // Outside points, each attached to a face it sees.
    for (i, q) in p.iter().enumerate() {
        if tet.contains(&i) {
            continue;
        }
        if let Some(f) = faces.iter_mut().find(|f| f.dist(*q) > eps) {
            f.outside.push(i);
        }
    }

    let mut stack: Vec<usize> = (0..faces.len()).collect();
    while let Some(fi) = stack.pop() {
        if !faces[fi].alive || faces[fi].outside.is_empty() {
            continue;
        }
        // Farthest point from the face.
        let far = *faces[fi].outside.iter().max_by(|&&i, &&j| faces[fi].dist(p[i]).total_cmp(&faces[fi].dist(p[j]))).unwrap();
        let q = p[far];
        // Faces visible from this point, by adjacency.
        let mut visible = vec![fi];
        let mut seen = std::collections::HashSet::from([fi]);
        let mut k = 0;
        while k < visible.len() {
            let f = visible[k];
            k += 1;
            let v = faces[f].v;
            for e in 0..3 {
                if let Some(&nb) = edges.get(&(v[(e + 1) % 3], v[e])) {
                    if !seen.contains(&nb) && faces[nb].alive && faces[nb].dist(q) > eps {
                        seen.insert(nb);
                        visible.push(nb);
                    }
                }
            }
        }
        // Horizon: edges of visible faces whose neighbor is not visible.
        let mut horizon = Vec::new();
        for &f in &visible {
            let v = faces[f].v;
            for e in 0..3 {
                let (x, y) = (v[e], v[(e + 1) % 3]);
                match edges.get(&(y, x)) {
                    Some(nb) if seen.contains(nb) => {}
                    _ => horizon.push((x, y)),
                }
            }
        }
        // Removal of the visible faces, collecting their points.
        let mut orphans = Vec::new();
        for &f in &visible {
            faces[f].alive = false;
            let v = faces[f].v;
            for e in 0..3 {
                edges.remove(&(v[e], v[(e + 1) % 3]));
            }
            orphans.append(&mut faces[f].outside);
        }
        // New faces: each horizon edge joined to the point.
        let mut created = Vec::new();
        for (x, y) in horizon {
            let nf = Face::new(p, [x, y, far]);
            let id = faces.len();
            for e in 0..3 {
                edges.insert((nf.v[e], nf.v[(e + 1) % 3]), id);
            }
            faces.push(nf);
            created.push(id);
        }
        for i in orphans {
            if i == far {
                continue;
            }
            let mut best: Option<(usize, f64)> = None;
            for &f in &created {
                let dd = faces[f].dist(p[i]);
                if dd > eps && best.is_none_or(|(_, b)| dd > b) {
                    best = Some((f, dd));
                }
            }
            if let Some((f, _)) = best {
                faces[f].outside.push(i);
            }
        }
        stack.extend(created);
    }

    // Vertices actually used, renumbered.
    let mut index: HashMap<usize, u32> = HashMap::new();
    let mut points = Vec::new();
    let mut out = Vec::new();
    for f in faces.iter().filter(|f| f.alive) {
        let mut tri = [0u32; 3];
        for k in 0..3 {
            let id = *index.entry(f.v[k]).or_insert_with(|| {
                let q = p[f.v[k]];
                points.push([q[0] as f32, q[1] as f32, q[2] as f32]);
                (points.len() - 1) as u32
            });
            tri[k] = id;
        }
        out.push(tri);
    }
    Ok(Hull { points, faces: out })
}

// ------------------------------------------------------------ orientation

/// Orca's coefficients, "optimize support interface area" mode
/// (`OrientParamsArea`).
const RELATIVE_F: f64 = 20.0;
const CONTOUR_F: f64 = 0.5;
const BOTTOM_F: f64 = 2.5;
const BOTTOM_HULL_F: f64 = 0.1;
const TAR_C: f64 = 0.1;
const TAR_D: f64 = 1.0;
const TAR_LAF: f64 = 0.001;
const FIRST_LAY_H: f64 = 0.2;
const LAF_MAX: f64 = 0.999;
const LAF_MIN: f64 = 0.97;
const BOTTOM_MIN: f64 = 0.1;
const EPSILON: f64 = 1e-4;

struct Facets {
    /// Vertices per face (3 × 3).
    v: Vec<[V3; 3]>,
    n: Vec<V3>,
    area: Vec<f64>,
}

impl Facets {
    fn from_tris(tris: &[[V3; 3]]) -> Facets {
        let mut f = Facets { v: Vec::with_capacity(tris.len()), n: Vec::new(), area: Vec::new() };
        for t in tris {
            let c = cross(sub(t[1], t[0]), sub(t[2], t[0]));
            let a = norm(c) / 2.0;
            if a <= 0.0 {
                continue;
            }
            f.v.push(*t);
            f.n.push(unit(c));
            f.area.push(a);
        }
        f
    }
}

/// Directions of the faces with the largest cumulative area (normals grouped
/// to the thousandth; the exact normal of the group's largest face is kept).
fn top_directions(f: &Facets, count: usize) -> Vec<V3> {
    let mut groups: HashMap<[i64; 3], (f64, f64, V3)> = HashMap::new();
    for i in 0..f.n.len() {
        let n = f.n[i];
        let key = [(n[0] * 1000.0).floor() as i64, (n[1] * 1000.0).floor() as i64, (n[2] * 1000.0).floor() as i64];
        let g = groups.entry(key).or_insert((0.0, 0.0, n));
        g.0 += f.area[i];
        if f.area[i] > g.1 {
            g.1 = f.area[i];
            g.2 = n;
        }
    }
    let mut list: Vec<(f64, V3)> = groups.into_values().map(|(total, _, n)| (total, n)).collect();
    list.sort_by(|a, b| b.0.total_cmp(&a.0));
    list.into_iter().take(count).map(|(_, n)| n).collect()
}

/// Cost of an orientation (`up`: the direction that becomes vertical).
fn cost(mesh: &Facets, hull: &Facets, up: V3, ascent: f64) -> f64 {
    let mut min_z = f64::MAX;
    for t in &mesh.v {
        for v in t {
            min_z = min_z.min(dot(*v, up));
        }
    }
    let zmax = |t: &[V3; 3]| dot(t[0], up).max(dot(t[1], up)).max(dot(t[2], up));
    let (mut bottom, mut overhang, mut laf) = (0.0, 0.0, 0.0);
    for i in 0..mesh.v.len() {
        let zm = zmax(&mesh.v[i]);
        let a = mesh.area[i];
        let in_first = zm < min_z + FIRST_LAY_H - EPSILON;
        let in_half = zm < min_z + FIRST_LAY_H / 2.0 - EPSILON;
        if in_first {
            bottom += a * 0.5;
        }
        if in_half {
            bottom += a;
        }
        let proj = dot(mesh.n[i], up);
        if proj < ascent && !in_half {
            overhang += a;
        }
        let pa = proj.abs();
        if pa < LAF_MAX && pa > LAF_MIN && zm > min_z + FIRST_LAY_H {
            laf += a;
        }
    }
    let mut bottom_hull = 0.0;
    for i in 0..hull.v.len() {
        if zmax(&hull.v[i]) < min_z + FIRST_LAY_H - EPSILON {
            bottom_hull += hull.area[i];
        }
    }
    let contour = 4.0 * bottom.sqrt();
    let mut c = RELATIVE_F * (overhang * TAR_C + TAR_D + TAR_LAF * laf)
        / (TAR_D + CONTOUR_F * contour + BOTTOM_F * bottom + BOTTOM_HULL_F * bottom_hull);
    if bottom < BOTTOM_MIN {
        c += 100.0;
    }
    c
}

/// Best "up" direction for a mesh (object frame).
///
/// `threshold_deg`: the profile's overhang angle (`support_threshold_angle`).
pub fn best_up(tris: &[Tri], threshold_deg: f64) -> Result<V3> {
    let mesh_tris: Vec<[V3; 3]> = tris.iter().map(|t| t.v.map(|v| [v[0] as f64, v[1] as f64, v[2] as f64])).collect();
    let mesh = Facets::from_tris(&mesh_tris);
    let hull = convex_hull(&unique_points(tris))?;
    let hp: Vec<V3> = hull.points.iter().map(|v| [v[0] as f64, v[1] as f64, v[2] as f64]).collect();
    let hull_tris: Vec<[V3; 3]> = hull.faces.iter().map(|f| f.map(|i| hp[i as usize])).collect();
    let hull_f = Facets::from_tris(&hull_tris);

    // Candidates: direction sent downwards (Orca calls them "orientations").
    let mut downs: Vec<V3> = vec![[0.0, 0.0, -1.0]];
    downs.extend(top_directions(&mesh, 10));
    downs.extend(top_directions(&hull_f, 14));
    let s = std::f64::consts::FRAC_1_SQRT_2;
    #[rustfmt::skip]
    let fixed: [V3; 18] = [
        [0.0, 0.0, -1.0], [s, 0.0, -s], [0.0, s, -s], [-s, 0.0, -s], [0.0, -s, -s],
        [1.0, 0.0, 0.0], [s, s, 0.0], [0.0, 1.0, 0.0], [-s, s, 0.0],
        [-1.0, 0.0, 0.0], [-s, -s, 0.0], [0.0, -1.0, 0.0], [s, -s, 0.0],
        [s, 0.0, s], [0.0, s, s], [-s, 0.0, s], [0.0, -s, s], [0.0, 0.0, 1.0],
    ];
    downs.extend(fixed);
    let mut uniq: Vec<V3> = Vec::new();
    for d in downs {
        if norm(d) < 1e-9 || uniq.iter().any(|u| norm(sub(*u, d)) < 1e-7) {
            continue;
        }
        uniq.push(d);
    }

    // Overhang: normal within `threshold` of the downward vertical.
    let ascent = (std::f64::consts::PI - threshold_deg.to_radians()).cos();
    let mut results: Vec<(f64, V3)> = uniq
        .iter()
        .map(|d| {
            let up = [-d[0], -d[1], -d[2]];
            (cost(&mesh, &hull_f, up, ascent), up)
        })
        .collect();
    results.sort_by(|a, b| a.0.total_cmp(&b.0));
    // On a tie, Orca keeps the original orientation rather than flip the object.
    let best = results[0];
    let origin = [0.0, 0.0, 1.0];
    if (dot(best.1, origin) - 1.0).abs() > EPSILON
        && results.iter().any(|r| (r.0 - best.0).abs() < EPSILON && (dot(r.1, origin) - 1.0).abs() < EPSILON * EPSILON)
    {
        return Ok(origin);
    }
    Ok(best.1)
}

/// Rotation (3 × 3, rows) bringing `from` onto `to` by the shortest path.
pub fn rotation_between(from: V3, to: V3) -> [[f64; 3]; 3] {
    let (a, b) = (unit(from), unit(to));
    let c = dot(a, b);
    let v = cross(a, b);
    let s = norm(v);
    if s < 1e-12 {
        if c > 0.0 {
            return [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        }
        // Half-turn around a perpendicular axis.
        let axis = unit(if a[0].abs() < 0.9 { cross(a, [1.0, 0.0, 0.0]) } else { cross(a, [0.0, 1.0, 0.0]) });
        let [x, y, z] = axis;
        return [
            [2.0 * x * x - 1.0, 2.0 * x * y, 2.0 * x * z],
            [2.0 * x * y, 2.0 * y * y - 1.0, 2.0 * y * z],
            [2.0 * x * z, 2.0 * y * z, 2.0 * z * z - 1.0],
        ];
    }
    let k = unit(v);
    let (sin, cos) = (s, c);
    let [x, y, z] = k;
    let t = 1.0 - cos;
    [
        [t * x * x + cos, t * x * y - sin * z, t * x * z + sin * y],
        [t * x * y + sin * z, t * y * y + cos, t * y * z - sin * x],
        [t * x * z - sin * y, t * y * z + sin * x, t * z * z + cos],
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tri(a: V3, b: V3, c: V3) -> Tri {
        Tri { v: [a, b, c].map(|v| [v[0] as f32, v[1] as f32, v[2] as f32]), c: [0, 0, 0] }
    }

    /// Prism with flat faces from a convex or concave polygon (Z extrusion).
    fn extrude(poly: &[[f64; 2]], h: f64) -> Vec<Tri> {
        let n = poly.len();
        let mut t = Vec::new();
        // Side faces, polygon counter-clockwise.
        for i in 0..n {
            let (a, b) = (poly[i], poly[(i + 1) % n]);
            t.push(tri([a[0], a[1], 0.0], [b[0], b[1], 0.0], [b[0], b[1], h]));
            t.push(tri([a[0], a[1], 0.0], [b[0], b[1], h], [a[0], a[1], h]));
        }
        // Bottom and top as fans from the first vertex (L polygon chosen so the fan
        // stays valid).
        for i in 1..n - 1 {
            let (a, b, c) = (poly[0], poly[i], poly[i + 1]);
            t.push(tri([a[0], a[1], 0.0], [c[0], c[1], 0.0], [b[0], b[1], 0.0]));
            t.push(tri([a[0], a[1], h], [b[0], b[1], h], [c[0], c[1], h]));
        }
        t
    }

    fn check_hull(points: &[V3], h: &Hull) {
        // All points inside the hull, faces facing outwards.
        let hp: Vec<V3> = h.points.iter().map(|v| [v[0] as f64, v[1] as f64, v[2] as f64]).collect();
        let center = hp.iter().fold([0.0; 3], |a, v| [a[0] + v[0], a[1] + v[1], a[2] + v[2]]).map(|x| x / hp.len() as f64);
        for f in &h.faces {
            let [a, b, c] = f.map(|i| hp[i as usize]);
            let n = unit(cross(sub(b, a), sub(c, a)));
            assert!(dot(n, sub(center, a)) < 0.0, "face turned inwards");
            for q in points {
                assert!(dot(n, sub(*q, a)) < 1e-3, "point outside the hull");
            }
        }
        // Euler: V − E + F = 2 for a closed triangulated surface.
        let mut edges = std::collections::HashSet::new();
        for f in &h.faces {
            for k in 0..3 {
                let (x, y) = (f[k], f[(k + 1) % 3]);
                edges.insert((x.min(y), x.max(y)));
            }
        }
        assert_eq!(h.points.len() as i64 - edges.len() as i64 + h.faces.len() as i64, 2);
    }

    #[test]
    fn hull_of_a_cube_with_inner_points() {
        let mut pts = Vec::new();
        for i in 0..2 {
            for j in 0..2 {
                for k in 0..2 {
                    pts.push([i as f64 * 10.0, j as f64 * 10.0, k as f64 * 10.0]);
                }
            }
        }
        for i in 0..200 {
            let f = i as f64;
            pts.push([1.0 + (f * 0.37) % 8.0, 1.0 + (f * 0.53) % 8.0, 1.0 + (f * 0.71) % 8.0]);
        }
        let h = convex_hull(&pts).unwrap();
        assert_eq!(h.points.len(), 8, "only the corners remain");
        check_hull(&pts, &h);
    }

    #[test]
    fn hull_of_a_sphere_cloud() {
        let mut pts = Vec::new();
        for i in 0..40 {
            for j in 0..40 {
                let th = i as f64 / 40.0 * std::f64::consts::PI;
                let ph = j as f64 / 40.0 * 2.0 * std::f64::consts::PI;
                pts.push([20.0 * th.sin() * ph.cos(), 20.0 * th.sin() * ph.sin(), 20.0 * th.cos()]);
            }
        }
        // Inside points.
        for i in 0..500 {
            let f = i as f64;
            pts.push([(f * 0.13) % 10.0 - 5.0, (f * 0.29) % 10.0 - 5.0, (f * 0.41) % 10.0 - 5.0]);
        }
        let h = convex_hull(&pts).unwrap();
        check_hull(&pts, &h);
    }

    /// An "L" lying flat (large face down) stays lying.
    #[test]
    fn a_flat_l_stays_flat() {
        let l = [[0.0, 0.0], [60.0, 0.0], [60.0, 10.0], [10.0, 10.0], [10.0, 40.0], [0.0, 40.0]];
        let t = extrude(&l, 5.0);
        let up = best_up(&t, 30.0).unwrap();
        assert!((up[2] - 1.0).abs() < 1e-6, "{up:?}");
    }

    /// A pyramid standing on its tip flips onto its base.
    #[test]
    fn a_pyramid_on_its_tip_turns_over() {
        // Square base on top (Z = 30), tip at the bottom (Z = 0).
        let (b, h) = (20.0, 30.0);
        let top = [[-b, -b, h], [b, -b, h], [b, b, h], [-b, b, h]];
        let tip = [0.0, 0.0, 0.0];
        let mut t = vec![tri(top[0], top[1], top[2]), tri(top[0], top[2], top[3])];
        for i in 0..4 {
            t.push(tri(top[(i + 1) % 4], top[i], tip));
        }
        let up = best_up(&t, 30.0).unwrap();
        assert!((up[2] + 1.0).abs() < 1e-6, "the base goes down: {up:?}");
    }

    /// A resting cube does not move: all its faces are equal, the original wins.
    #[test]
    fn a_cube_keeps_its_orientation() {
        let sq = [[0.0, 0.0], [20.0, 0.0], [20.0, 20.0], [0.0, 20.0]];
        let up = best_up(&extrude(&sq, 20.0), 30.0).unwrap();
        assert!((up[2] - 1.0).abs() < 1e-6, "{up:?}");
    }

    #[test]
    fn rotation_between_maps_vectors() {
        for (a, b) in [([0.0, 0.0, -1.0], [0.0, 0.0, 1.0]), ([1.0, 0.0, 0.0], [0.0, 0.0, 1.0]), ([0.3, -0.5, 0.8], [0.0, 0.0, 1.0])] {
            let r = rotation_between(a, b);
            let a = unit(a);
            let m = [dot(r[0], a), dot(r[1], a), dot(r[2], a)];
            assert!(norm(sub(m, unit(b))) < 1e-9, "{a:?} → {m:?}");
        }
    }
}
#[cfg(test)]
mod bench {
    #[test]
    #[ignore]
    fn hull_speed() {
        let mut pts = Vec::new();
        for i in 0..200 {
            for j in 0..200 {
                let th = (i as f64 + 0.5) / 200.0 * std::f64::consts::PI;
                let ph = j as f64 / 200.0 * 2.0 * std::f64::consts::PI;
                pts.push([20.0 * th.sin() * ph.cos(), 20.0 * th.sin() * ph.sin(), 20.0 * th.cos()]);
            }
        }
        for i in 0..160_000 {
            let f = i as f64;
            pts.push([(f * 0.13) % 20.0 - 10.0, (f * 0.29) % 20.0 - 10.0, (f * 0.41) % 20.0 - 10.0]);
        }
        let t = std::time::Instant::now();
        let h = super::convex_hull(&pts).unwrap();
        println!("{} points → {} vertices, {} faces in {:?}", pts.len(), h.points.len(), h.faces.len(), t.elapsed());
    }
}
