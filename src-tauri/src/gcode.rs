//! Reading a G-code file: toolpaths, layers and metadata.
//!
//! The markers recognized cover the three families met in practice: Orca and
//! Bambu (`;LAYER_CHANGE`, `;TYPE:`), PrusaSlicer (same markers, other type
//! names) and Cura (`;LAYER:`, upper-case types).

use anyhow::{anyhow, Result};
use std::io::{BufRead, BufReader, Read};

fn feature_id(name: &str) -> u8 {
    let n = name.trim().to_ascii_lowercase();
    let has = |k: &str| n.contains(k);
    if has("overhang") {
        11
    } else if has("outer") || has("external perimeter") || has("wall-outer") {
        1
    } else if has("inner") || has("perimeter") || has("wall-inner") {
        2
    } else if has("top") || has("ironing") {
        3
    } else if has("bottom") {
        4
    } else if has("bridge") {
        7
    } else if has("solid") || has("skin") {
        6
    } else if has("infill") || has("fill") {
        5
    } else if has("support") {
        8
    } else if has("skirt") || has("brim") {
        9
    } else if has("prime tower") || has("wipe tower") {
        10
    } else {
        0
    }
}

#[derive(Clone, Copy)]
pub struct Seg {
    pub a: [f32; 3],
    pub b: [f32; 3],
    pub layer: u16,
    pub feature: u8,
    pub tool: u8,
    pub travel: bool,
    /// Extrusion width in hundredths of a mm (`;WIDTH:`), 0 if unknown.
    pub width: u8,
    /// Extrusion height (layer or sub-layer) in steps of 0.005 mm
    /// (`;HEIGHT:`, else the Z step), 0 if unknown.
    pub height: u8,
}

/// The step of `Seg::height`, mm: fine enough for 0.04 mm sub-layers.
pub const HEIGHT_STEP: f32 = 0.005;

/// A height in mm as `Seg::height` keeps it.
fn height_steps(h: f32) -> u8 {
    if h > 0.0 {
        (h / HEIGHT_STEP).round().clamp(1.0, 255.0) as u8
    } else {
        0
    }
}

#[derive(Default, Clone, serde::Serialize)]
pub struct GMeta {
    pub printer: Option<String>,
    pub profile: Option<String>,
    pub filaments: Vec<String>,
    pub print_time_s: Option<u32>,
    pub first_layer_s: Option<u32>,
    pub filament_g: Option<f32>,
    /// Consumption per extruder, as Orca writes it at the end of the file.
    pub per_tool_mm: Vec<f32>,
    pub per_tool_cm3: Vec<f32>,
    pub per_tool_g: Vec<f32>,
    pub cost: Option<f32>,
    pub layer_height: Option<f32>,
    /// The prime tower's front-left corner (`wipe_tower_x` / `wipe_tower_y`,
    /// the first plate's) and its turn in degrees (`wipe_tower_rotation_angle`).
    pub tower_at: [Option<f32>; 2],
    pub tower_angle: Option<f32>,
    pub total_layers: Option<u32>,
    pub generator: Option<String>,
    /// Color of each filament (`#rrggbb`), empty if the slicer does not write it.
    pub colors: Vec<String>,
    /// The build plate it was sliced for (`curr_bed_type`, Orca's settings
    /// block).
    pub bed_type: Option<String>,
}

/// Times computed by walking the toolpaths (length ÷ speed), ignoring
/// acceleration: they split the total time estimated by the slicer, they do
/// not replace it.
#[derive(Default, Clone)]
pub struct RawTimes {
    /// Extrusion seconds per path feature (index = `feature_id`).
    pub feature: [f32; FEATURE_COUNT],
    pub travel: f32,
    /// Cumulative seconds at the end of each layer.
    pub layer_end: Vec<f32>,
    /// Tools (heads) that actually extruded.
    pub tools: Vec<u8>,
}

pub struct GcodeData {
    /// The segments kept (`Keep`), tiny ones in line merged.
    pub segs: Vec<Seg>,
    /// The last layer's index, over every move of the file (not only the
    /// segments kept).
    pub layers: u16,
    pub min: [f32; 3],
    pub max: [f32; 3],
    pub meta: GMeta,
    /// More than `MAX_SEGS` segments: the whole file is kept, with less
    /// detail on the curves (never cut).
    pub simplified: bool,
    pub times: RawTimes,
    /// The top of each layer's extrusions (mm), over every move; 0 for a
    /// layer without any.
    pub layer_top: Vec<f32>,
    pub keep: Keep,
    /// The prime tower's extrusion points (x, y), over every move, whatever
    /// `keep`: its box needs the rotation, often written after them.
    pub tower_pts: Vec<[f32; 2]>,
    /// The prime tower's top (mm), 0 without a tower.
    pub tower_top: f32,
}

/// Which segments a read keeps: the viewer asks for the extrusions first
/// and for the travel moves only when they are shown; a read for the
/// metadata or the times keeps none.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Keep {
    #[cfg(test)]
    All,
    Extrusions,
    Travel,
    None,
}

/// The segments kept at most. Past it the whole set is simplified further
/// (`Store::shrink`): about 32 bytes per segment here, 18 in the viewer.
const MAX_SEGS: usize = 10_000_000;
/// Segments in line within this distance (mm) are merged, on every file:
/// invisible at any zoom the viewer allows.
const MERGE_TOL: f32 = 0.01;
/// Past this tolerance (mm), one segment in two is dropped instead.
const MAX_TOL: f32 = 1.0;
/// Points merged into one segment at most: bounds the checks per move.
const RUN_MAX: usize = 32;

/// Whether `p` lies within `tol` of the segment `a`–`b`.
fn near_segment(p: [f32; 3], a: [f32; 3], b: [f32; 3], tol: f32) -> bool {
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    let l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    let t = if l2 > 0.0 { ((ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / l2).clamp(0.0, 1.0) } else { 0.0 };
    let d = [ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t];
    d[0] * d[0] + d[1] * d[1] + d[2] * d[2] <= tol * tol
}

/// `b` follows `a` (it starts where `a` ends) and draws the same way.
fn mergeable(a: &Seg, b: &Seg) -> bool {
    a.b == b.a
        && a.layer == b.layer
        && a.feature == b.feature
        && a.tool == b.tool
        && a.travel == b.travel
        && a.width == b.width
        && a.height == b.height
}

/// Merges, in place, the runs of segments that follow each other and stay
/// within `tol` of the segment from the run's start to its end.
fn compact(segs: &mut Vec<Seg>, tol: f32) {
    let n = segs.len();
    let (mut w, mut i) = (0, 0);
    while i < n {
        let mut cur = segs[i];
        let mut j = i + 1;
        // The joints of the run are still in place (`w` never passes `i`).
        while j < n && j - i <= RUN_MAX && mergeable(&cur, &segs[j]) {
            let b = segs[j].b;
            if !(i..j).all(|k| near_segment(segs[k].b, cur.a, b, tol)) {
                break;
            }
            cur.b = b;
            j += 1;
        }
        segs[w] = cur;
        w += 1;
        i = j;
    }
    segs.truncate(w);
}

/// The segments kept, within `cap`: tiny segments in line are merged as
/// they come; when the budget is reached, everything kept so far is
/// simplified further and the rest of the file is read at that level, so
/// the whole height is always there.
struct Store {
    segs: Vec<Seg>,
    /// The points already merged into the last segment, checked again at
    /// each extension.
    run: Vec<[f32; 3]>,
    tol: f32,
    cap: usize,
    /// Past `MAX_TOL`: one segment in `stride` is kept.
    stride: u32,
    seen: u32,
    simplified: bool,
}

impl Store {
    fn new(cap: usize) -> Store {
        // Below, three quarters of the budget would be 0: `shrink` would
        // never get there.
        debug_assert!(cap >= 4);
        Store { segs: Vec::new(), run: Vec::new(), tol: MERGE_TOL, cap, stride: 1, seen: 0, simplified: false }
    }

    fn push(&mut self, s: Seg) {
        if self.stride > 1 {
            self.seen = self.seen.wrapping_add(1);
            if self.seen % self.stride != 0 {
                return;
            }
        }
        if let Some(last) = self.segs.last_mut() {
            if self.run.len() < RUN_MAX && mergeable(last, &s) {
                let (a, b, tol) = (last.a, s.b, self.tol);
                if near_segment(last.b, a, b, tol) && self.run.iter().all(|p| near_segment(*p, a, b, tol)) {
                    self.run.push(last.b);
                    last.b = b;
                    return;
                }
            }
        }
        self.run.clear();
        if self.segs.len() >= self.cap {
            self.shrink();
        }
        // Grown by hand near the cap: doubling would reserve far past it.
        let len = self.segs.len();
        if len == self.segs.capacity() {
            self.segs.reserve_exact(len.max(1024).min(self.cap.saturating_sub(len)).max(1));
        }
        self.segs.push(s);
    }

    /// Back under three quarters of the budget: merges with a larger
    /// tolerance, then, past `MAX_TOL`, keeps one segment in two.
    fn shrink(&mut self) {
        self.simplified = true;
        while self.segs.len() > self.cap * 3 / 4 {
            if self.tol < MAX_TOL {
                self.tol = (self.tol * 4.0).min(MAX_TOL);
                compact(&mut self.segs, self.tol);
            } else {
                let mut i = 0usize;
                self.segs.retain(|_| {
                    i += 1;
                    i % 2 == 1
                });
                self.stride = self.stride.saturating_mul(2);
            }
        }
        self.run.clear();
    }
}
/// Number of features recognized by `feature_id`.
pub const FEATURE_COUNT: usize = 12;

fn num_after(line: &str, key: u8) -> Option<f32> {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i].to_ascii_uppercase();
        if c == b';' {
            return None;
        }
        if c == key && (i == 0 || bytes[i - 1] == b' ') {
            let rest = &line[i + 1..];
            let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+' || c == 'e')).unwrap_or(rest.len());
            return rest[..end].parse().ok();
        }
        i += 1;
    }
    None
}

/// Value of a comment shaped `; key : value` or `;key=value`.
///
/// The separator is required: without it, the `LAYER` key would swallow
/// `layer_height = 0.3` and the real value would never be read.
/// `#FF8800;#00FF00FF;""` → `#rrggbb` colors (alpha removed); an empty or
/// unreadable entry stays empty, to keep each head's index.
fn hex_list(v: &str) -> Vec<String> {
    v.split([';', ','])
        .map(|s| {
            let s = s.trim().trim_matches('"');
            let hex = s.strip_prefix('#').unwrap_or("");
            // `get`, not a byte slice: a non-ASCII character at the cut
            // (a comment of the slicer's) must not end the parse.
            match hex.get(..6) {
                Some(h) if h.chars().all(|c| c.is_ascii_hexdigit()) => format!("#{}", h.to_ascii_lowercase()),
                _ => String::new(),
            }
        })
        .collect()
}

fn comment_value<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let l = line.trim_start_matches(';').trim();
    let low = l.to_ascii_lowercase();
    let k = key.to_ascii_lowercase();
    if !low.starts_with(&k) {
        return None;
    }
    // Separator required: colon, equals, or at least one space. Without this
    // rule, the `LAYER` key would swallow `layer_height = 0.3`.
    let rest = &l[key.len()..];
    match rest.chars().next() {
        None => Some(""),
        Some(c) if c == ':' || c == '=' => Some(rest[1..].trim()),
        Some(c) if c.is_whitespace() => {
            let r = rest.trim_start();
            Some(r.strip_prefix([':', '=']).unwrap_or(r).trim())
        }
        _ => None,
    }
}

fn parse_duration(s: &str) -> Option<u32> {
    // Formats met: "1h 37m 12s", "5843", "2 h 3 m".
    if let Ok(v) = s.trim().parse::<f64>() {
        return Some(v as u32);
    }
    let mut total = 0u32;
    let mut num = String::new();
    let mut any = false;
    for c in s.chars() {
        if c.is_ascii_digit() {
            num.push(c);
        } else if let Ok(v) = num.parse::<u32>() {
            let mult = match c.to_ascii_lowercase() {
                'd' => 86_400,
                'h' => 3_600,
                'm' => 60,
                's' => 1,
                _ => 0,
            };
            if mult > 0 {
                // Saturating: a nonsense "99999999d" must not overflow.
                total = total.saturating_add(v.saturating_mul(mult));
                any = true;
            }
            num.clear();
        } else {
            num.clear();
        }
    }
    any.then_some(total)
}

/// Reads a G-code, keeping every segment (merged where in line): the
/// tests' shorthand.
#[cfg(test)]
pub fn parse(read: impl Read) -> Result<GcodeData> {
    parse_with(read, Keep::All)
}

/// Reads a G-code, keeping the segments `keep` asks for.
pub fn parse_with(read: impl Read, keep: Keep) -> Result<GcodeData> {
    parse_capped(read, keep, MAX_SEGS)
}

pub(crate) fn parse_capped(read: impl Read, keep: Keep, cap: usize) -> Result<GcodeData> {
    let mut rd = BufReader::with_capacity(1 << 20, read);
    let mut store = Store::new(cap);
    let mut meta = GMeta::default();

    let (mut x, mut y, mut z, mut e) = (0f32, 0f32, 0f32, 0f32);
    let mut abs_xyz = true;
    let mut abs_e = true;
    let mut layer: u16 = 0;
    let mut feature: u8 = 0;
    let mut tool: u8 = 0;
    let mut width: u8 = 0;
    // `;HEIGHT:` as written, and the step between the `;Z:` of two layers
    // when the slicer does not write it.
    let mut height: u8 = 0;
    let (mut z_step, mut layer_z) = (0u8, None::<f32>);
    let mut seen_layer_marker = false;
    let mut last_z = f32::MIN;
    let mut moves = 0usize;
    // Framing on the part: typed extrusions (not the start G-code's prime
    // line, which crosses the bed), else any extrusion, else any move.
    let mut frame = [([f32::MAX; 3], [f32::MIN; 3]); 3];
    let mut layer_top: Vec<f32> = Vec::new();
    let (mut tower_pts, mut tower_top): (Vec<[f32; 2]>, f32) = (Vec::new(), 0.0);
    let mut line = String::new();
    // Current speed in mm/min (modal) and times computed segment by segment.
    let mut feed: f32 = 1800.0;
    let mut times = RawTimes::default();
    let mut clock = 0f32;
    let mut tools_used = [false; 16];
    let list = |v: &str| -> Vec<f32> { v.split(|c| c == ',' || c == ';').filter_map(|x| x.trim().parse::<f32>().ok()).collect() };

    loop {
        line.clear();
        let mut raw = Vec::new();
        let n = rd.read_until(b'\n', &mut raw)?;
        if n == 0 {
            break;
        }
        line.push_str(&String::from_utf8_lossy(&raw));
        let l = line.trim_end();
        if l.is_empty() {
            continue;
        }

        if let Some(rest) = l.strip_prefix(';') {
            let r = rest.trim();
            let rl = r.to_ascii_lowercase();
            if rl.starts_with("type:") {
                feature = feature_id(&r[5..]);
            } else if rl.starts_with("width:") {
                // Orca, PrusaSlicer: `;WIDTH:0.42`, width of the extrusions that follow.
                width = r[6..].trim().parse::<f32>().map(|w| (w * 100.0).round().clamp(0.0, 255.0) as u8).unwrap_or(0);
            } else if rl.starts_with("height:") {
                // Orca, PrusaSlicer: `;HEIGHT:0.08`, height of the extrusions
                // that follow (a sub-layer's own, with subdivided mixing).
                height = r[7..].trim().parse::<f32>().map(height_steps).unwrap_or(0);
            } else if rl.starts_with("z:") {
                // `;Z:3.40` at each layer: the step from the previous one.
                if let Ok(v) = r[2..].trim().parse::<f32>() {
                    if let Some(prev) = layer_z.filter(|p| v > *p) {
                        z_step = height_steps(v - prev);
                    }
                    layer_z = Some(v);
                }
            } else if rl == "layer_change" {
                layer = layer.saturating_add(1);
                seen_layer_marker = true;
            } else if let Some(v) = comment_value(l, "LAYER") {
                // Cura: `;LAYER:12`
                if let Ok(n) = v.parse::<i32>() {
                    layer = n.max(0) as u16;
                    seen_layer_marker = true;
                }
            } else if let Some(v) = comment_value(l, "printer_model").or_else(|| comment_value(l, "Printer")) {
                meta.printer.get_or_insert_with(|| v.to_string());
            } else if let Some(v) = comment_value(l, "Profile").or_else(|| comment_value(l, "print_settings_id")) {
                meta.profile.get_or_insert_with(|| v.to_string());
            } else if let Some(v) = comment_value(l, "filament_type") {
                if meta.filaments.is_empty() {
                    meta.filaments = v.split(|c| c == ';' || c == ',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
                }
            } else if let Some(v) = comment_value(l, "total layer number").or_else(|| comment_value(l, "LAYER_COUNT")) {
                meta.total_layers = v.parse().ok();
            } else if let Some(v) = comment_value(l, "layer_height") {
                meta.layer_height = v.parse().ok();
            } else if let Some(v) = comment_value(l, "wipe_tower_rotation_angle") {
                meta.tower_angle = v.parse().ok();
            } else if let Some(v) = comment_value(l, "wipe_tower_x") {
                meta.tower_at[0] = v.split(',').next().and_then(|x| x.trim().parse().ok());
            } else if let Some(v) = comment_value(l, "wipe_tower_y") {
                meta.tower_at[1] = v.split(',').next().and_then(|y| y.trim().parse().ok());
            } else if let Some(v) = comment_value(l, "estimated first layer printing time (normal mode)") {
                meta.first_layer_s = meta.first_layer_s.or_else(|| parse_duration(v));
            } else if let Some(v) = comment_value(l, "model printing time") {
                // Orca: `; model printing time: 1h 2m; total estimated time: 1h 10m`.
                // The total (preheat included) is the useful value; never add up the two
                // durations of the line.
                let total =
                    v.split(';').find_map(|part| comment_value(part, "total estimated time")).unwrap_or(v.split(';').next().unwrap_or(v));
                if let Some(t) = parse_duration(total) {
                    meta.print_time_s = Some(t);
                }
            } else if let Some(v) = comment_value(l, "estimated printing time (normal mode)")
                .or_else(|| comment_value(l, "total estimated time"))
                .or_else(|| comment_value(l, "TIME"))
            {
                meta.print_time_s = meta.print_time_s.or_else(|| parse_duration(v));
            } else if let Some(v) = comment_value(l, "filament used [mm]") {
                meta.per_tool_mm = list(v);
            } else if let Some(v) = comment_value(l, "filament used [cm3]") {
                meta.per_tool_cm3 = list(v);
            } else if let Some(v) = comment_value(l, "filament used [g]") {
                meta.per_tool_g = list(v);
                if meta.filament_g.is_none() {
                    let sum: f32 = meta.per_tool_g.iter().sum();
                    meta.filament_g = (sum > 0.0).then_some(sum);
                }
            } else if let Some(v) = comment_value(l, "total filament cost") {
                meta.cost = v.trim().parse().ok().or(meta.cost);
            } else if let Some(v) = comment_value(l, "filament cost") {
                if meta.cost.is_none() {
                    let sum: f32 = list(v).iter().sum();
                    meta.cost = (sum > 0.0).then_some(sum);
                }
            } else if let Some(v) = comment_value(l, "total filament weight [g]").or_else(|| comment_value(l, "total filament used [g]")) {
                meta.filament_g = v.split(',').next().and_then(|s| s.trim().parse().ok()).or(meta.filament_g);
            } else if let Some(v) = comment_value(l, "curr_bed_type") {
                meta.bed_type = (!v.is_empty()).then(|| v.to_string());
            } else if let Some(v) = comment_value(l, "filament_colour") {
                meta.colors = hex_list(v);
            } else if let Some(v) = comment_value(l, "extruder_colour") {
                // PrusaSlicer: the extruder's color, failing the filament's.
                if meta.colors.iter().all(|c| c.is_empty()) {
                    meta.colors = hex_list(v);
                }
            } else if let Some(v) = comment_value(l, "generated by") {
                meta.generator.get_or_insert_with(|| v.to_string());
            }
            continue;
        }

        // Tool change: T0 to T3.
        if l.len() >= 2 && l.as_bytes()[0].to_ascii_uppercase() == b'T' {
            if let Ok(t) = l[1..].split_whitespace().next().unwrap_or("").parse::<u8>() {
                if t < 16 {
                    tool = t;
                }
            }
            continue;
        }

        let up = l.as_bytes()[0].to_ascii_uppercase();
        if up != b'G' && up != b'M' {
            continue;
        }
        let code: u32 = match l[1..].split(|c: char| !c.is_ascii_digit()).next().unwrap_or("").parse() {
            Ok(c) => c,
            Err(_) => continue,
        };

        match (up, code) {
            (b'G', 90) => abs_xyz = true,
            (b'G', 91) => abs_xyz = false,
            (b'M', 82) => abs_e = true,
            (b'M', 83) => abs_e = false,
            (b'G', 92) => {
                if let Some(v) = num_after(l, b'E') {
                    e = v;
                }
                if let Some(v) = num_after(l, b'X') {
                    x = v;
                }
                if let Some(v) = num_after(l, b'Y') {
                    y = v;
                }
                if let Some(v) = num_after(l, b'Z') {
                    z = v;
                }
            }
            (b'G', 0) | (b'G', 1) => {
                let (px, py, pz) = (x, y, z);
                let nx = num_after(l, b'X');
                let ny = num_after(l, b'Y');
                let nz = num_after(l, b'Z');
                let ne = num_after(l, b'E');
                if let Some(f) = num_after(l, b'F') {
                    if f > 0.0 {
                        feed = f;
                    }
                }
                if abs_xyz {
                    x = nx.unwrap_or(x);
                    y = ny.unwrap_or(y);
                    z = nz.unwrap_or(z);
                } else {
                    x += nx.unwrap_or(0.0);
                    y += ny.unwrap_or(0.0);
                    z += nz.unwrap_or(0.0);
                }
                let de = match (ne, abs_e) {
                    (Some(v), true) => {
                        let d = v - e;
                        e = v;
                        d
                    }
                    (Some(v), false) => {
                        e += v;
                        v
                    }
                    (None, _) => 0.0,
                };

                // Without a layer marker, one is inferred at each Z rise.
                if !seen_layer_marker && z > last_z + 0.01 {
                    if last_z > f32::MIN {
                        layer = layer.saturating_add(1);
                    }
                    last_z = z;
                }

                let moved = (x - px).abs() > 1e-6 || (y - py).abs() > 1e-6 || (z - pz).abs() > 1e-6;
                if !moved {
                    continue;
                }
                // Raw segment time: length ÷ programmed speed.
                let dist = ((x - px).powi(2) + (y - py).powi(2) + (z - pz).powi(2)).sqrt();
                let dt = dist / (feed / 60.0);
                clock += dt;
                if de > 0.0 {
                    times.feature[(feature as usize).min(FEATURE_COUNT - 1)] += dt;
                    tools_used[(tool as usize).min(15)] = true;
                } else {
                    times.travel += dt;
                }
                let li = layer as usize;
                if times.layer_end.len() <= li {
                    let last = times.layer_end.last().copied().unwrap_or(0.0);
                    times.layer_end.resize(li + 1, last);
                }
                times.layer_end[li] = clock;
                moves += 1;
                let travel = de <= 0.0;
                let (a, b) = ([px, py, pz], [x, y, z]);
                let boxes: &[usize] = match (travel, feature) {
                    (true, _) => &[2],
                    (false, 0) => &[1, 2],
                    (false, _) => &[0, 1, 2],
                };
                for &k in boxes {
                    let (mn, mx) = &mut frame[k];
                    for p in [a, b] {
                        for c in 0..3 {
                            mn[c] = mn[c].min(p[c]);
                            mx[c] = mx[c].max(p[c]);
                        }
                    }
                }
                if !travel {
                    if layer_top.len() <= li {
                        layer_top.resize(li + 1, 0.0);
                    }
                    layer_top[li] = layer_top[li].max(z);
                    if feature == 10 {
                        // Each point once: a segment starts where the last ended.
                        for p in [a, b] {
                            if tower_pts.last() != Some(&[p[0], p[1]]) {
                                tower_pts.push([p[0], p[1]]);
                            }
                            tower_top = tower_top.max(p[2]);
                        }
                    }
                }
                let wanted = match keep {
                    #[cfg(test)]
                    Keep::All => true,
                    Keep::Extrusions => !travel,
                    Keep::Travel => travel,
                    Keep::None => false,
                };
                if wanted {
                    store.push(Seg { a, b, layer, feature, tool, travel, width, height: if height > 0 { height } else { z_step } });
                }
            }
            _ => {}
        }
    }

    if moves == 0 {
        return Err(anyhow!(crate::t!("err.no_paths")));
    }
    // Every move counts, kept or not: the slider reaches the last layer.
    let layers = times.layer_end.len().saturating_sub(1).min(u16::MAX as usize) as u16;
    layer_top.resize(layers as usize + 1, 0.0);
    let (min, max) = frame.into_iter().find(|(mn, mx)| mn[0] <= mx[0]).unwrap_or(([0.0; 3], [0.0; 3]));

    times.tools = (0..16u8).filter(|t| tools_used[*t as usize]).collect();
    let Store { segs, simplified, .. } = store;
    Ok(GcodeData { segs, layers, min, max, meta, simplified, times, layer_top, keep, tower_pts, tower_top })
}

/// Time of a path feature in the preview.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
pub struct FeatureTime {
    pub feature: u8,
    pub seconds: f32,
}

/// Summary of a slice for the preview: the slicer's values when it gives
/// them, computed breakdowns scaled to its total time.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct SliceStats {
    pub print_time_s: Option<u32>,
    pub first_layer_s: Option<u32>,
    pub layers: u32,
    pub filament_g: Option<f32>,
    pub per_tool_g: Vec<f32>,
    pub per_tool_m: Vec<f32>,
    pub per_tool_cm3: Vec<f32>,
    pub cost: Option<f32>,
    /// Time breakdown by feature, longest first.
    pub features: Vec<FeatureTime>,
    pub travel_s: f32,
    /// Elapsed time at the end of each layer.
    pub layer_end_s: Vec<f32>,
    /// Heads that actually extrude.
    pub tools: Vec<u8>,
    /// True when no total time was found: everything is computed.
    pub estimated_only: bool,
    /// Material of each G-code tool (`filament_type`), as sliced.
    pub filament_types: Vec<String>,
    /// Color of each G-code tool (`#rrggbb`, empty if unknown), as sliced.
    pub filament_colors: Vec<String>,
    /// The prime tower as printed, if there is one: Prepare shows its real
    /// size once sliced.
    pub tower: Option<TowerBox>,
    /// The build plate it was sliced for (`curr_bed_type`), if written.
    pub bed_type: Option<String>,
}

pub fn stats(d: &GcodeData) -> SliceStats {
    let t = &d.times;
    let raw_total: f32 = t.feature.iter().sum::<f32>() + t.travel;
    // The computation ignores acceleration and preheat: it is scaled to the
    // total announced by the slicer when there is one.
    let k = match d.meta.print_time_s {
        Some(total) if raw_total > 0.0 => total as f32 / raw_total,
        _ => 1.0,
    };
    let mut features: Vec<FeatureTime> =
        t.feature.iter().enumerate().filter(|(_, s)| **s > 0.0).map(|(i, s)| FeatureTime { feature: i as u8, seconds: s * k }).collect();
    features.sort_by(|a, b| b.seconds.total_cmp(&a.seconds));
    SliceStats {
        print_time_s: d.meta.print_time_s.or_else(|| (raw_total > 0.0).then_some(raw_total as u32)),
        first_layer_s: d.meta.first_layer_s,
        layers: d.layers as u32 + 1,
        filament_g: d.meta.filament_g,
        per_tool_g: d.meta.per_tool_g.clone(),
        per_tool_m: d.meta.per_tool_mm.iter().map(|mm| mm / 1000.0).collect(),
        per_tool_cm3: d.meta.per_tool_cm3.clone(),
        cost: d.meta.cost,
        features,
        travel_s: t.travel * k,
        layer_end_s: t.layer_end.iter().map(|s| s * k).collect(),
        tools: t.tools.clone(),
        estimated_only: d.meta.print_time_s.is_none(),
        filament_types: d.meta.filaments.clone(),
        filament_colors: d.meta.colors.clone(),
        tower: tower_box(d, d.meta.tower_at.map(|v| v.unwrap_or(0.0)), d.meta.tower_angle.unwrap_or(0.0)),
        bed_type: d.meta.bed_type.clone(),
    }
}

/// The build plate a G-code was sliced for, from any part of it holding
/// Orca's settings block (`; curr_bed_type = Textured PEI Plate`): the end
/// of a file is enough.
pub fn bed_type(text: &str) -> Option<String> {
    text.lines()
        .filter(|l| l.starts_with(';'))
        .find_map(|l| comment_value(l, "curr_bed_type"))
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

/// The prime tower as printed, in its own frame (turned with it): the
/// corner it was placed at (`x`, `y`, the engine's `wipe_tower_x` /
/// `wipe_tower_y`), then the box its extrusions fill — brim and ribs
/// included — from (`x0`, `y0`) relative to that corner, `w` × `d`, and its
/// height `h`, in mm.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, Default, PartialEq)]
pub struct TowerBox {
    pub x: f32,
    pub y: f32,
    pub x0: f32,
    pub y0: f32,
    pub w: f32,
    pub d: f32,
    pub h: f32,
}

/// The prime tower's extrusions (`;TYPE:Prime tower`), seen in the tower's
/// own frame: the engine turns the tower by `angle` degrees around its
/// front-left corner `at`, so the moves are turned back around it before
/// taking their extent. None without a tower.
pub fn tower_box(d: &GcodeData, at: [f32; 2], angle: f32) -> Option<TowerBox> {
    let (s, c) = (-angle.to_radians()).sin_cos();
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for p in &d.tower_pts {
        let (dx, dy) = (p[0] - at[0], p[1] - at[1]);
        let (x, y) = (dx * c - dy * s, dx * s + dy * c);
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x);
        y1 = y1.max(y);
    }
    (x0 <= x1).then(|| TowerBox { x: at[0], y: at[1], x0, y0, w: x1 - x0, d: y1 - y0, h: d.tower_top })
}

/// Serialization for the viewer, version 4: about 18 bytes per segment,
/// laid out so that the viewer hands it to the GPU as is.
///
/// 68-byte header:
/// `"3MFG"` | version u8 (4) | flags u8 (bit 0: simplified, bit 1: travel
/// moves) | feature mask u16 (bit per extruded feature) | segment count u32 |
/// layer count u32 | framing min f32×3 | max f32×3 | positions' origin
/// f32×3 | span f32×3 | tool mask u16 (bit per extruding head) | reserved
/// u16.
///
/// Then, per layer: the segment count up to its end (u32) and its top Z
/// (f32, the previous layer's when it has no extrusion); per segment:
/// positions (start and end, 6 × u16, `origin + q / 65535 × span`), then
/// in separate arrays feature (u8), head (u8), width (u8, 0.01 mm, 0
/// unknown) and height (u8, `HEIGHT_STEP`); then the colors (count u8, then
/// per head a known flag and RGB).
///
/// Segments are sorted by layer (extrusions before travel within one), the
/// order of the file kept inside: the viewer shows layers up to a given
/// rank by drawing the first segments only.
pub fn encode(data: &GcodeData) -> Vec<u8> {
    let layers = data.layers as usize + 1;
    let n = data.segs.len();
    // Counting sort on (layer, travel): no copy of the segments.
    let key = |s: &Seg| s.layer as usize * 2 + usize::from(s.travel);
    let mut start = vec![0u32; layers * 2 + 1];
    for s in &data.segs {
        start[key(s) + 1] += 1;
    }
    for k in 1..start.len() {
        start[k] += start[k - 1];
    }

    // The positions' box: every point kept, travel included.
    let (mut lo, mut hi) = ([f32::MAX; 3], [f32::MIN; 3]);
    for s in &data.segs {
        for p in [&s.a, &s.b] {
            for c in 0..3 {
                lo[c] = lo[c].min(p[c]);
                hi[c] = hi[c].max(p[c]);
            }
        }
    }
    if n == 0 {
        (lo, hi) = ([0.0; 3], [0.0; 3]);
    }
    let span: [f32; 3] = std::array::from_fn(|c| (hi[c] - lo[c]).max(1e-6));

    let (mut feats, mut tools) = (0u16, 0u16);
    for s in data.segs.iter().filter(|s| !s.travel) {
        feats |= 1 << s.feature.min(15);
        tools |= 1 << s.tool.min(15);
    }

    let colors = &data.meta.colors;
    let k = colors.len().min(16);
    let head = 68 + layers * 8;
    let pos = head;
    let (feat, tool, width, height) = (pos + n * 12, pos + n * 13, pos + n * 14, pos + n * 15);
    let mut out = vec![0u8; pos + n * 16 + 1 + k * 4];

    out[0..4].copy_from_slice(b"3MFG");
    out[4] = 4;
    out[5] = u8::from(data.simplified) | (u8::from(data.keep == Keep::Travel) << 1);
    out[6..8].copy_from_slice(&feats.to_le_bytes());
    out[8..12].copy_from_slice(&(n as u32).to_le_bytes());
    out[12..16].copy_from_slice(&(layers as u32).to_le_bytes());
    for (i, v) in data.min.iter().chain(&data.max).chain(&lo).chain(&span).enumerate() {
        out[16 + i * 4..20 + i * 4].copy_from_slice(&v.to_le_bytes());
    }
    out[64..66].copy_from_slice(&tools.to_le_bytes());

    let mut z = 0f32;
    for l in 0..layers {
        let o = 68 + l * 4;
        out[o..o + 4].copy_from_slice(&start[(l + 1) * 2].to_le_bytes());
        if let Some(t) = data.layer_top.get(l).filter(|t| **t > 0.0) {
            z = *t;
        }
        let o = 68 + layers * 4 + l * 4;
        out[o..o + 4].copy_from_slice(&z.to_le_bytes());
    }

    // A height not written nor stepped: the profile's layer height.
    let fallback = data.meta.layer_height.map(height_steps).unwrap_or(0);
    let q = |v: f32, c: usize| (((v - lo[c]) / span[c]) * 65535.0).round().clamp(0.0, 65535.0) as u16;
    let mut next = start;
    for s in &data.segs {
        let k = key(s);
        let i = next[k] as usize;
        next[k] += 1;
        let o = pos + i * 12;
        for (j, v) in s.a.iter().chain(&s.b).enumerate() {
            out[o + j * 2..o + j * 2 + 2].copy_from_slice(&q(*v, j % 3).to_le_bytes());
        }
        out[feat + i] = s.feature;
        out[tool + i] = s.tool;
        out[width + i] = s.width;
        out[height + i] = if s.height > 0 { s.height } else { fallback };
    }

    // Colors: their count, then per head a flag (1 known, 0 unknown) and the
    // three RGB components.
    let mut o = pos + n * 16;
    out[o] = k as u8;
    o += 1;
    for c in colors.iter().take(16) {
        let rgb = u32::from_str_radix(c.trim_start_matches('#'), 16).ok().filter(|_| c.len() == 7);
        if let Some(v) = rgb {
            out[o..o + 4].copy_from_slice(&[1, (v >> 16) as u8, (v >> 8) as u8, v as u8]);
        }
        o += 4;
    }
    out
}

/// PNG thumbnail encoded in base64 in the comments, if the profile put one.
pub fn embedded_thumbnail(read: impl Read) -> Option<Vec<u8>> {
    let rd = BufReader::with_capacity(1 << 16, read);
    let mut best: Option<Vec<u8>> = None;
    let mut cur: Option<String> = None;
    for line in rd.lines().take(200_000).map_while(Result::ok) {
        let t = line.trim_start_matches(';').trim();
        let tl = t.to_ascii_lowercase();
        if tl.starts_with("thumbnail begin") || tl.starts_with("thumbnail_png begin") {
            cur = Some(String::new());
        } else if tl.starts_with("thumbnail end") || tl.starts_with("thumbnail_png end") {
            if let Some(b64) = cur.take() {
                if let Some(bytes) = crate::util::b64_decode(&b64) {
                    // Keep the largest: it is the most readable as a thumbnail.
                    if best.as_ref().map(|b| bytes.len() > b.len()).unwrap_or(true) {
                        best = Some(bytes);
                    }
                }
            }
        } else if let Some(buf) = cur.as_mut() {
            buf.push_str(t);
        } else if tl.starts_with("g1") || tl.starts_with("g0") {
            break; // past the header, there is no thumbnail any more
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
; generated by OrcaSlicer 2.3.6
; total layer number: 2
;TYPE:Custom
G90
M83
G1 X10 Y10 Z0.2 F3000
;LAYER_CHANGE
;Z:0.2
;TYPE:Outer wall
G1 X20 Y10 E0.5
G1 X20 Y20 E0.5
;TYPE:Sparse infill
G1 X15 Y15 E0.3
;LAYER_CHANGE
;Z:0.4
;TYPE:Inner wall
G1 Z0.4
G1 X10 Y10 E0.4
G1 X30 Y30 F9000
; estimated printing time (normal mode) = 1h 37m 12s
";

    /// Orca's file footer: consumption per head, cost, total time without adding
    /// up the two durations of the "model printing time" line.
    #[test]
    fn orca_footer_statistics() {
        let g = "; HEADER\n;TYPE:Outer wall\nG1 F600\nG1 X10 Y0 E1\n;LAYER_CHANGE\nT1\n;TYPE:Sparse infill\nG1 X10 Y20 E2\nG1 X0 Y20\n\
; filament used [mm] = 1200.50, 300.00\n\
; filament used [cm3] = 2.89, 0.72\n\
; filament used [g] = 3.58, 0.90\n\
; filament cost = 0.07, 0.02\n\
; total filament cost = 0.09\n\
; estimated first layer printing time (normal mode) = 1m 30s\n\
; model printing time: 1h 2m 3s; total estimated time: 1h 10m 0s\n";
        let d = parse(g.as_bytes()).unwrap();
        assert_eq!(d.meta.print_time_s, Some(4200), "the total, not the sum of both");
        assert_eq!(d.meta.first_layer_s, Some(90));
        assert_eq!(d.meta.per_tool_g, vec![3.58, 0.90]);
        assert_eq!(d.meta.cost, Some(0.09));
        let st = stats(&d);
        assert_eq!(st.tools, vec![0, 1]);
        assert_eq!(st.per_tool_m, vec![1.2005, 0.3]);
        let sum: f32 = st.features.iter().map(|f| f.seconds).sum::<f32>() + st.travel_s;
        assert!((sum - 4200.0).abs() < 1.0, "breakdown scaled to the total: {sum}");
        assert_eq!(st.features[0].feature, 5, "infill (20 mm) before the wall (10 mm)");
        assert_eq!(st.layer_end_s.len(), 2);
        assert!((st.layer_end_s[1] - 4200.0).abs() < 1.0);
    }

    #[test]
    fn parse_basics() {
        let d = parse(SAMPLE.as_bytes()).unwrap();
        assert_eq!(d.layers, 2, "two layer changes");
        assert_eq!(d.meta.total_layers, Some(2));
        assert_eq!(d.meta.print_time_s, Some(3600 + 37 * 60 + 12));
        assert!(d.meta.generator.as_deref().unwrap_or("").contains("Orca"));

        let extr: Vec<&Seg> = d.segs.iter().filter(|s| !s.travel).collect();
        let trav: Vec<&Seg> = d.segs.iter().filter(|s| s.travel).collect();
        assert_eq!(extr.len(), 4, "four extrusions");
        // The first positioning and the rapid move are travel moves.
        assert!(trav.len() >= 2, "travel moves detected");

        assert_eq!(extr[0].feature, 1, "outer wall");
        assert_eq!(extr[2].feature, 5, "remplissage");
        assert_eq!(extr[3].feature, 2, "inner wall");
        assert_eq!(extr[3].layer, 2);

        // Framing ignores travel moves: X does not go beyond 20.
        assert!((d.max[0] - 20.0).abs() < 0.01, "max x = {}", d.max[0]);
    }

    /// The separator tells a key from another one starting the same.
    #[test]
    fn comment_keys_need_a_separator() {
        assert_eq!(comment_value("; layer_height = 0.3", "layer_height"), Some("0.3"));
        assert_eq!(comment_value(";LAYER:12", "LAYER"), Some("12"));
        assert_eq!(comment_value("; layer_height = 0.3", "LAYER"), None, "not a prefix");
        assert_eq!(comment_value("; total layer number: 42", "total layer number"), Some("42"));
        // A lone space is a separator too.
        assert_eq!(comment_value("; generated by OrcaSlicer 2.3.6", "generated by"), Some("OrcaSlicer 2.3.6"));
    }

    #[test]
    fn reads_layer_height_from_header() {
        let g = "; generated by Snapmaker Orca\n; layer_height = 0.3\n; total layer number: 10\nG1 X1 Y1 Z0.3 E1\n";
        let d = parse(g.as_bytes()).unwrap();
        assert_eq!(d.meta.layer_height, Some(0.3));
        assert_eq!(d.meta.total_layers, Some(10));
    }

    #[test]
    fn relative_extrusion_is_not_a_travel() {
        // In absolute mode (M82), an E value that does not increase is a retraction.
        let g = "G90\nM82\nG1 X0 Y0 Z0.2\nG1 X10 Y0 E1.0\nG1 X20 Y0 E0.5\n";
        let d = parse(g.as_bytes()).unwrap();
        let extr: Vec<&Seg> = d.segs.iter().filter(|s| !s.travel).collect();
        assert_eq!(extr.len(), 1, "only the E increase is an extrusion");
    }

    /// A version 4 buffer read back: (header fields, segments as
    /// (start, end, feature, tool, width, height), per-layer ends and tops).
    struct Decoded {
        flags: u8,
        feats: u16,
        tools: u16,
        layers: usize,
        segs: Vec<([f32; 3], [f32; 3], u8, u8, u8, u8)>,
        ends: Vec<u32>,
        tops: Vec<f32>,
        colors: Vec<u8>,
    }

    fn decode(b: &[u8]) -> Decoded {
        assert_eq!(&b[0..4], b"3MFG");
        assert_eq!(b[4], 4, "version 4");
        let u32_at = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
        let f32_at = |o: usize| f32::from_le_bytes(b[o..o + 4].try_into().unwrap());
        let n = u32_at(8) as usize;
        let layers = u32_at(12) as usize;
        let origin = [f32_at(40), f32_at(44), f32_at(48)];
        let span = [f32_at(52), f32_at(56), f32_at(60)];
        let pos = 68 + layers * 8;
        let segs = (0..n)
            .map(|i| {
                let v = |j: usize| {
                    let q = u16::from_le_bytes(b[pos + i * 12 + j * 2..pos + i * 12 + j * 2 + 2].try_into().unwrap());
                    origin[j % 3] + q as f32 / 65535.0 * span[j % 3]
                };
                let at = |k: usize| b[pos + n * k + i];
                ([v(0), v(1), v(2)], [v(3), v(4), v(5)], at(12), at(13), at(14), at(15))
            })
            .collect();
        Decoded {
            flags: b[5],
            feats: u16::from_le_bytes([b[6], b[7]]),
            tools: u16::from_le_bytes([b[64], b[65]]),
            layers,
            segs,
            ends: (0..layers).map(|l| u32_at(68 + l * 4)).collect(),
            tops: (0..layers).map(|l| f32_at(68 + layers * 4 + l * 4)).collect(),
            colors: b[pos + n * 16..].to_vec(),
        }
    }

    #[test]
    fn encode_sorted_by_layer() {
        let d = parse(SAMPLE.as_bytes()).unwrap();
        let b = encode(&d);
        let x = decode(&b);
        assert_eq!(x.segs.len(), d.segs.len());
        assert_eq!(x.layers, 3, "layers 0 to 2");
        assert_eq!(b.len(), 68 + 3 * 8 + d.segs.len() * 16 + 1 + d.meta.colors.len() * 4);
        // Per-layer ends: increasing, the last one the whole count.
        assert!(x.ends.windows(2).all(|w| w[0] <= w[1]));
        assert_eq!(*x.ends.last().unwrap() as usize, d.segs.len());
        // Extrusions before travel within a layer, and the order of the
        // file inside each.
        let layer2 = &x.segs[x.ends[1] as usize..];
        assert_eq!(layer2[0].2, 2, "inner wall first");
        assert!((layer2[0].1[0] - 10.0).abs() < 0.01 && (layer2.last().unwrap().1[0] - 30.0).abs() < 0.01, "then the travel");
        assert_eq!(x.feats, 1 << 1 | 1 << 2 | 1 << 5, "outer, inner wall, infill");
        assert_eq!(x.tools, 1);
        // Tops per layer: layer 0 has no extrusion (0), then 0.2 and 0.4.
        assert_eq!(x.tops[0], 0.0);
        assert!((x.tops[1] - 0.2).abs() < 1e-6 && (x.tops[2] - 0.4).abs() < 1e-6, "{:?}", x.tops);
        assert_eq!(x.flags, 0);
    }

    /// Positions come back within the quantization step (1/65535 of the
    /// box), here a 250 mm travel.
    #[test]
    fn encode_quantizes_positions() {
        let g = "G1 X0 Y0 Z0.2
G1 X12.345 Y67.891 E1
G1 X250 Y3 F9000
G1 X100.001 Y100 Z9.87 E2
";
        let d = parse(g.as_bytes()).unwrap();
        let x = decode(&encode(&d));
        assert_eq!(x.segs.len(), d.segs.len());
        let close = |p: [f32; 3], q: [f32; 3]| (0..3).all(|c| (p[c] - q[c]).abs() < 0.004);
        for s in &d.segs {
            assert!(x.segs.iter().any(|e| close(s.a, e.0) && close(s.b, e.1)), "{:?} {:?}", s.a, s.b);
        }
    }

    /// The viewer reads extrusions and travel apart; the layer count, the
    /// tops and the framing are the same in both.
    #[test]
    fn keep_extrusions_or_travel() {
        let e = parse_with(SAMPLE.as_bytes(), Keep::Extrusions).unwrap();
        let t = parse_with(SAMPLE.as_bytes(), Keep::Travel).unwrap();
        let n = parse_with(SAMPLE.as_bytes(), Keep::None).unwrap();
        assert!(e.segs.iter().all(|s| !s.travel) && e.segs.len() == 4);
        assert!(t.segs.iter().all(|s| s.travel) && !t.segs.is_empty());
        assert!(n.segs.is_empty());
        for d in [&t, &n] {
            assert_eq!((d.layers, d.min, d.max), (e.layers, e.min, e.max));
            assert_eq!(d.layer_top, e.layer_top);
        }
        assert_eq!(decode(&encode(&t)).flags, 2, "a travel buffer");
        assert_eq!(stats(&n).layers, 3, "times and layers without any segment");
    }

    /// A layer of `steps` tiny moves around a circle of radius `r`, at `z`.
    fn ring(g: &mut String, z: f32, r: f32, steps: usize) {
        g.push_str(&format!(";LAYER_CHANGE\n;Z:{z}\nG1 X{r} Y0 Z{z} F9000\n;TYPE:Outer wall\n"));
        for i in 1..=steps {
            let a = i as f32 / steps as f32 * std::f32::consts::TAU;
            g.push_str(&format!("G1 X{:.4} Y{:.4} E0.01\n", r * a.cos(), r * a.sin()));
        }
    }

    /// The distance from `p` to the nearest kept extrusion of its layer.
    fn gap(d: &GcodeData, p: [f32; 3]) -> f32 {
        let mut best = f32::MAX;
        for s in d.segs.iter().filter(|s| !s.travel && (s.b[2] - p[2]).abs() < 1e-4) {
            let mut lo = 0f32;
            let mut hi = 1f32;
            // Distance to a segment, by bisection on near_segment.
            for _ in 0..30 {
                let mid = (lo + hi) / 2.0;
                if near_segment(p, s.a, s.b, mid) {
                    hi = mid;
                } else {
                    lo = mid;
                }
            }
            best = best.min(hi);
        }
        best
    }

    /// Tiny segments in line merge into one; a corner, another feature,
    /// width or height, or a curve's sag over 0.01 mm do not.
    #[test]
    fn merges_tiny_segments_in_line() {
        let mut g = String::from("M83\nG1 X0 Y0 Z0.2\n;TYPE:Outer wall\n");
        for i in 1..=30 {
            g.push_str(&format!("G1 X{:.1} Y0 E0.01\n", i as f32 * 0.1));
        }
        g.push_str("G1 X3 Y5 E0.1\n;WIDTH:0.5\nG1 X3 Y10 E0.1\n;TYPE:Inner wall\nG1 X3 Y15 E0.1\n");
        let d = parse(g.as_bytes()).unwrap();
        let e: Vec<&Seg> = d.segs.iter().filter(|s| !s.travel).collect();
        assert_eq!(e.len(), 4, "the line, the corner, a new width, a new feature");
        assert_eq!((e[0].a[0], e[0].b[0]), (0.0, 3.0));
        assert!(!d.simplified);
        // A going back on itself is not "in line".
        let d = parse("M83\nG1 X0 Y0 Z0.2\nG1 X5 Y0 E1\nG1 X1 Y0 E1\n".as_bytes()).unwrap();
        assert_eq!(d.segs.iter().filter(|s| !s.travel).count(), 2);
        // A circle of radius 10 in 0.5 mm steps: each joint sags 0.0125 mm
        // from the chord over two steps, so nothing merges.
        let mut g = String::from("M83\n");
        ring(&mut g, 0.2, 10.0, 126);
        let d = parse(g.as_bytes()).unwrap();
        assert_eq!(d.segs.iter().filter(|s| !s.travel).count(), 126);
    }

    /// Over the budget, nothing is cut: every layer is there, the times
    /// reach the total, and the path stays near the original points.
    #[test]
    fn over_the_budget_simplifies_without_cutting() {
        let mut g = String::from("; total layer number: 40\nM83\n");
        let mut points = Vec::new();
        for l in 0..40 {
            let z = 0.2 * (l + 1) as f32;
            ring(&mut g, z, 20.0, 400);
            for i in 1..=400 {
                let a = i as f32 / 400.0 * std::f32::consts::TAU;
                points.push([20.0 * a.cos(), 20.0 * a.sin(), z]);
            }
        }
        g.push_str("; estimated printing time (normal mode) = 2h 0m 0s\n");
        let full = parse(g.as_bytes()).unwrap();
        let d = parse_capped(g.as_bytes(), Keep::Extrusions, 1_500).unwrap();
        assert!(!full.simplified && d.simplified);
        assert!(d.segs.len() <= 1_500, "{}", d.segs.len());
        assert_eq!(d.layers, full.layers);
        assert_eq!(stats(&d).layers, 41, "the start and the 40 layers");
        assert_eq!(d.segs.iter().map(|s| s.layer).max(), Some(d.layers), "the top layer is drawn");
        let st = stats(&d);
        assert!((st.layer_end_s.last().unwrap() - 7200.0).abs() < 1.0, "{:?}", st.layer_end_s.last());
        assert_eq!(st.layer_end_s, stats(&full).layer_end_s);
        // Every layer keeps segments, and each point of the file stays
        // within the tolerances added up (at most 2 × MAX_TOL).
        for l in 1..=40u16 {
            assert!(d.segs.iter().any(|s| s.layer == l), "layer {l}");
        }
        let worst = points.iter().step_by(7).map(|p| gap(&d, *p)).fold(0f32, f32::max);
        assert!(worst <= 2.0 * MAX_TOL, "{worst}");
    }

    /// Segments that cannot merge (each between two travel moves): past the
    /// largest tolerance, one in two is kept, over the whole height.
    #[test]
    fn unmergeable_segments_are_thinned_evenly() {
        let mut g = String::from("M83\n");
        for l in 0..20 {
            g.push_str(&format!(";LAYER_CHANGE\nG1 Z{}\n", 0.2 * (l + 1) as f32));
            for i in 0..100 {
                g.push_str(&format!("G1 X{} Y{l}\nG1 X{} Y{l} E0.1\n", i * 2, i * 2 + 1));
            }
        }
        let d = parse_capped(g.as_bytes(), Keep::Extrusions, 500).unwrap();
        assert!(d.simplified && d.segs.len() <= 500);
        for l in 1..=20u16 {
            assert!(d.segs.iter().any(|s| s.layer == l), "layer {l}");
        }
    }

    /// Parses a real G-code and writes the preview, for visual checking.
    #[test]
    fn dump_real_gcode() {
        let (Ok(src), Ok(out)) = (std::env::var("GCODE_IN"), std::env::var("GCODE_OUT")) else {
            return;
        };
        let t = std::time::Instant::now();
        let d = parse(std::fs::File::open(&src).unwrap()).unwrap();
        println!(
            "{} segments ({} extrusions), {} layers, {:?} — parsed in {} ms",
            d.segs.len(),
            d.segs.iter().filter(|s| !s.travel).count(),
            d.layers + 1,
            d.meta.printer,
            t.elapsed().as_millis()
        );
        let mut hist = [0usize; 12];
        for sg in d.segs.iter().filter(|s| !s.travel) {
            hist[sg.feature as usize] += 1;
        }
        println!("breakdown by feature: {hist:?}");
        std::fs::write(format!("{out}.bin"), encode(&d)).unwrap();
        let img = crate::render::render_paths(&d.segs, d.min, d.max, 512);
        image::DynamicImage::ImageRgba8(img).save(format!("{out}.png")).unwrap();
    }

    #[test]
    fn reads_filament_colors_and_widths() {
        let g = ";TYPE:Outer wall\n;WIDTH:0.45\nG1 X10 Y0 E1\n;WIDTH:0.62\nG1 X10 Y10 E2\n\
; filament_colour = #FF8800;#00ff00FF;\n";
        let d = parse(g.as_bytes()).unwrap();
        assert_eq!(d.meta.colors, vec!["#ff8800", "#00ff00", ""]);
        let w: Vec<u8> = d.segs.iter().filter(|s| !s.travel).map(|s| s.width).collect();
        assert_eq!(w, vec![45, 62]);
        let x = decode(&encode(&d));
        let w: Vec<u8> = x.segs.iter().map(|s| s.4).collect();
        assert_eq!(w, vec![45, 62]);
        // End of the buffer: 3 colors × 4 bytes, preceded by their count.
        let tail = &x.colors[..];
        assert_eq!(tail[0], 3);
        assert_eq!(&tail[1..5], &[1, 0xff, 0x88, 0x00]);
        assert_eq!(&tail[9..13], &[0, 0, 0, 0], "unknown color");
    }

    /// Heights: `;HEIGHT:` per extrusion (sub-layers of 0.04 mm kept
    /// apart from 0.08 mm layers), else the `;Z:` step, else the profile's
    /// layer height; encoded after the widths, in 0.005 mm steps.
    #[test]
    fn reads_and_encodes_heights() {
        let g = ";LAYER_CHANGE\n;Z:0.2\n;HEIGHT:0.2\nG1 Z0.2\nG1 X10 Y0 E1\n\
;LAYER_CHANGE\n;Z:0.28\n;HEIGHT:0.08\nG1 Z0.28\nG1 X10 Y10 E2\n\
;HEIGHT:0.04\nG1 X0 Y10 E3\n";
        let d = parse(g.as_bytes()).unwrap();
        let h: Vec<u8> = d.segs.iter().filter(|s| !s.travel).map(|s| s.height).collect();
        assert_eq!(h, vec![40, 16, 8], "0.2, 0.08 and 0.04 mm");
        // No ;HEIGHT: — the Z step between layers.
        let g = ";LAYER_CHANGE\n;Z:0.2\nG1 Z0.2\nG1 X10 Y0 E1\n;LAYER_CHANGE\n;Z:0.32\nG1 Z0.32\nG1 X10 Y10 E2\n";
        let d = parse(g.as_bytes()).unwrap();
        let h: Vec<u8> = d.segs.iter().filter(|s| !s.travel).map(|s| s.height).collect();
        assert_eq!(h, vec![0, 24], "the first layer unknown, then 0.12 mm");
        // Neither: the profile's layer height, at encoding.
        let d = parse("G1 X10 Y0 E1\n; layer_height = 0.16\n".as_bytes()).unwrap();
        assert_eq!(d.segs[0].height, 0);
        let heights: Vec<u8> = decode(&encode(&d)).segs.iter().map(|s| s.5).collect();
        assert!(heights.iter().all(|&x| x == 32), "{heights:?}");
        assert_eq!(height_steps(0.0), 0);
        assert_eq!(height_steps(2.0), 255, "clamped");
    }

    #[test]
    fn stats_carry_the_plate() {
        let g = "G1 X1 E1\n; CONFIG_BLOCK_START\n; curr_bed_type = High Temp Plate\n; curr_bed_type_extra = x\n; CONFIG_BLOCK_END\n";
        let st = stats(&parse(g.as_bytes()).unwrap());
        assert_eq!(st.bed_type.as_deref(), Some("High Temp Plate"));
        assert_eq!(bed_type(g).as_deref(), Some("High Temp Plate"));
        // Cut in the middle of a line (a file's end read alone), or absent.
        assert_eq!(bed_type("ype = X\n; curr_bed_type = Textured PEI Plate\n").as_deref(), Some("Textured PEI Plate"));
        assert_eq!(bed_type("; layer_height = 0.2\n"), None);
        assert_eq!(bed_type("; curr_bed_type = \n"), None);
        assert!(stats(&parse("G1 X1 E1\n".as_bytes()).unwrap()).bed_type.is_none());
    }

    #[test]
    fn stats_carry_sliced_materials_and_colors() {
        let g = "G1 X1 E1\n; filament_type = PLA;PETG\n; filament_colour = #FF0000;#000000\n";
        let st = stats(&parse(g.as_bytes()).unwrap());
        assert_eq!(st.filament_types, vec!["PLA", "PETG"]);
        assert_eq!(st.filament_colors, vec!["#ff0000", "#000000"]);
        // Older records (no such fields) still read.
        let old: SliceStats = serde_json::from_str(r#"{"layers":3,"tools":[0]}"#).unwrap();
        assert!(old.filament_types.is_empty() && old.filament_colors.is_empty());
    }

    /// The tower's box, in its own frame: from the corner it was placed at,
    /// read from the config block; turned 90°, its width runs along Y.
    #[test]
    fn tower_box_in_the_tower_frame() {
        let g = "; wipe_tower_x = 100,15\n; wipe_tower_y = 50,220\n; wipe_tower_rotation_angle = 90\n\
                 G1 X0 Y0 Z0.2\n;TYPE:Outer wall\nG1 X10 Y0 E1\n\
                 ;TYPE:Prime tower\nG1 X102 Y48 F600\nG1 X102 Y88 E2\nG1 X76 Y88 E3\nG1 Z5\nG1 X76 Y48 E4\n";
        let d = parse(g.as_bytes()).unwrap();
        assert_eq!(d.meta.tower_at, [Some(100.0), Some(50.0)], "the first plate's");
        let t = stats(&d).tower.unwrap();
        let near = |a: f32, b: f32| (a - b).abs() < 1e-3;
        assert!(near(t.x, 100.0) && near(t.y, 50.0), "{t:?}");
        // 40 mm along Y is the width, 26 mm along −X the depth; the box
        // starts 2 mm before the corner on both sides (a brim).
        assert!(near(t.w, 40.0) && near(t.d, 26.0) && near(t.x0, -2.0) && near(t.y0, -2.0), "{t:?}");
        assert!(near(t.h, 5.0), "{t:?}");
        assert_eq!(stats(&parse("G1 X1 E1\n".as_bytes()).unwrap()).tower, None, "no tower");
        // The same box from a read that keeps no segment (the stats after a
        // slice), or only the travel moves.
        for keep in [Keep::None, Keep::Travel] {
            let k = stats(&parse_with(g.as_bytes(), keep).unwrap()).tower.unwrap();
            assert!(near(k.w, t.w) && near(k.d, t.d) && near(k.x0, t.x0) && near(k.h, t.h), "{keep:?} {k:?}");
        }
    }

    #[test]
    fn prusa_extruder_colour_is_a_fallback() {
        let d = parse("; extruder_colour = \"#112233\"\nG1 X1 E1\n".as_bytes()).unwrap();
        assert_eq!(d.meta.colors, vec!["#112233"]);
    }
}

#[cfg(test)]
mod hex_tests {
    use super::hex_list;

    #[test]
    fn colours_cut_safely() {
        assert_eq!(hex_list("#AABBCC;#112233"), vec!["#aabbcc", "#112233"]);
        // Six bytes that are not six characters: skipped, never a panic.
        assert_eq!(hex_list("#aaaaaé"), vec![""]);
        assert_eq!(hex_list("#é"), vec![""]);
        assert_eq!(hex_list("#aabbccé"), vec!["#aabbcc"]);
    }
}
