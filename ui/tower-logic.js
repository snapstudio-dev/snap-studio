/* Prime tower in Prepare: pure rules (no DOM, no WebGL), tested by
   scripts/test-tower.js.

   The tower is placed as the engine places it: `wipe_tower_x` /
   `wipe_tower_y` are its front-left corner, `wipe_tower_rotation_angle`
   turns it counter-clockwise around that corner (checked on Snapmaker Orca
   2.4.0, slice.rs engine_prime_tower_position). Its box is what it prints —
   brim and ribs included — in its own frame: from (x0, y0), relative to the
   corner, w × d mm, h high. */

/* Whether the plate gets a tower, and why not: the engine prints one with
   the option on, two heads or more and layer by layer only. `reason`
   ("single", "by_object") says why the option cannot apply, the choice
   itself being kept. */
function ptState({ heads = 0, on = false, sequence = "by layer" }) {
  const reason = heads < 2 ? "single" : sequence === "by object" ? "by_object" : null;
  return { show: !!on && !reason, reason };
}

/* The option on a plate: off unless the plate says otherwise — a new
   project starts without a tower, whatever the profiles say. */
const ptOn = (plate) => plate?.tower?.on === true;

const PT_C = 1 - Math.PI / 4;

/* Estimated box before slicing, as WipeTower2 (the engine's tower for the
   U1 and other non-Bambu printers) lays it out: each tool change of a layer
   fills `prime_volume` in lines across the tower, spaced by
   `wipe_tower_extra_spacing`, plus a ramming line; the deepest layer gives
   the depth (Orca's PartPlate::estimate_wipe_tower_size and
   Print::wipe_tower_data do the same with Bambu's tower). A rib wall makes
   the tower a square of the same area, its ribs reaching out of the
   corners along the diagonals; the brim goes around. Calibrated on
   Snapmaker Orca 2.4.0 slices: within a line per tool change, the rib
   margin a little wide (on the safe side). null below two heads. */
function ptEstimate({
  heads = 2, height = 0, layer = 0.2, width = 60, volume = 45, brim = 3, nozzle = 0.4,
  wall = "rectangle", ribWidth = 8, ribExtra = 8, spacing = 1.2,
}) {
  if (heads < 2) return null;
  const pw = nozzle * 1.25;
  const lh = Math.max(0.01, layer);
  const perChange = (w) => spacing * pw * (volume / (lh * (pw - lh * PT_C) * Math.max(w - 3 * pw, pw)) + 2);
  const depth = (w) => (heads - 1) * perChange(w) + pw;
  let bw = Math.max(width, 2), bd = depth(bw), m = Math.max(0, brim);
  if (wall === "rib") {
    bw = Math.ceil(Math.sqrt(bw * bd) / pw - 1e-9) * pw;
    bd = depth(bw);
    const rib = Math.min(ribWidth, Math.min(bw, bd) / 2);
    m += (Math.max(0, ribExtra) / 2 + rib / 2) / Math.SQRT2;
  }
  const r = (v) => Math.round(v * 100) / 100 + 0;
  return { x0: r(-m), y0: r(-m), w: r(bw + 2 * m), d: r(bd + 2 * m), h: r(height) };
}

/* The box as sliced (gcode.rs TowerBox): the same shape. */
const ptFromGcode = (t) => (t && t.w > 0 && t.d > 0 ? { x0: t.x0, y0: t.y0, w: t.w, d: t.d, h: t.h } : null);

/* Corners of the box on the plate, seen from above: [[x, y] × 4], counter-
   clockwise, for a tower at `t` = { x, y, rot } (degrees). */
function ptCorners(t, box) {
  const a = ((t.rot || 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [
    [box.x0, box.y0], [box.x0 + box.w, box.y0], [box.x0 + box.w, box.y0 + box.d], [box.x0, box.y0 + box.d],
  ].map(([x, y]) => [t.x + x * c - y * s, t.y + x * s + y * c]);
}

/* Top-view extent of the box: { x0, y0, x1, y1 }. */
function ptExtent(t, box) {
  const p = ptCorners(t, box), xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/* The tower turned to `rot` degrees around the middle of its box, which
   stays where it is (the engine turns it around its corner). */
function ptTurn(t, box, rot) {
  const at = (deg) => {
    const a = (deg * Math.PI) / 180, cx = box.x0 + box.w / 2, cy = box.y0 + box.d / 2;
    return [cx * Math.cos(a) - cy * Math.sin(a), cx * Math.sin(a) + cy * Math.cos(a)];
  };
  const [ax, ay] = at(t.rot || 0), [bx, by] = at(rot);
  return { x: t.x + ax - bx, y: t.y + ay - by, rot };
}

/* Do two convex polygons overlap by more than `slack` mm? (separating axes) */
function ptConvexOverlap(a, b, slack = 0.2) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const n = [q[1] - p[1], p[0] - q[0]];
      const len = Math.hypot(n[0], n[1]) || 1;
      const proj = (P) => P.map((v) => (v[0] * n[0] + v[1] * n[1]) / len);
      const pa = proj(a), pb = proj(b);
      if (Math.max(...pa) <= Math.min(...pb) + slack || Math.max(...pb) <= Math.min(...pa) + slack) return false;
    }
  }
  return true;
}

/* On the plate: "in", "partial" or "out", as an object. */
function ptBedState(t, box, bed) {
  const e = ptExtent(t, box), eps = 0.1;
  if (e.x1 < -eps || e.y1 < -eps || e.x0 > bed.w + eps || e.y0 > bed.d + eps) return "out";
  if (e.x0 < -eps || e.y0 < -eps || e.x1 > bed.w + eps || e.y1 > bed.d + eps) return "partial";
  return "in";
}

/* A spot for the tower, its rotation kept: the plate's corners first —
   back-left (the engine's default, X 15 Y 220), back-right, front-left,
   front-right — `edge` mm from the plate's edges; then the first free
   place row by row from the back-left. Free: clear of every part
   footprint (`parts`, convex polygons) by `gap` mm. None free: the
   engine's default, `free` false (the plate shows the overlap). */
function ptSpot(box, bed, parts, rot = 0, { edge = 2, gap = 3, step = 5 } = {}) {
  const ext = ptExtent({ x: 0, y: 0, rot }, box);
  const ew = ext.x1 - ext.x0, ed = ext.y1 - ext.y0;
  const at = (x, y) => ({ x: Math.round((x - ext.x0) * 10) / 10, y: Math.round((y - ext.y0) * 10) / 10, rot });
  const grown = { x0: box.x0 - gap, y0: box.y0 - gap, w: box.w + 2 * gap, d: box.d + 2 * gap };
  const free = (t) => !parts.some((p) => p.length && ptConvexOverlap(ptCorners(t, grown), p, 0));
  const x0 = edge, x1 = bed.w - edge - ew, y0 = edge, y1 = bed.d - edge - ed;
  if (x1 >= x0 && y1 >= y0) {
    for (const [x, y] of [[x0, y1], [x1, y1], [x0, y0], [x1, y0]]) {
      const t = at(x, y);
      if (free(t)) return { ...t, free: true };
    }
    for (let y = y1; y >= y0; y -= step) {
      for (let x = x0; x <= x1; x += step) {
        const t = at(x, y);
        if (free(t)) return { ...t, free: true };
      }
    }
  }
  return { x: 15, y: Math.min(220, Math.max(0, bed.d - 50)), rot, free: false };
}

/* What the real size (read after slicing) stands for: it holds until one
   of these changes — the parts and their heads, the tower's settings, the
   profile (layer height). Not the tower's place nor the parts' places. */
const ptSizeKey = (parts, settings) => JSON.stringify([parts, settings]);

if (typeof module !== "undefined") {
  module.exports = { ptState, ptOn, ptEstimate, ptFromGcode, ptCorners, ptExtent, ptTurn, ptConvexOverlap, ptBedState, ptSpot, ptSizeKey };
}
