/* Printing "by object" (print_sequence): each object printed whole, one
   after the other, in the plate list's order. The head then passes over
   the objects already printed, so the plate must leave it room — the same
   checks as Snapmaker Orca's (Print.cpp, sequential_print_clearance_valid,
   2.4.0), made live in Prepare instead of failing at slice time:
   - side by side: every footprint grown by half the head's clearance
     radius must stay clear of the others (the objects at least the radius
     apart), unless every object is lower than the nozzle;
   - in height: an object printed before another may not be taller than
     the gantry rod when the later one is in its row (their Y ranges meet),
     nor taller than the lid otherwise; the last one has the whole height. */

/* The U1's clearances (Snapmaker U1 machine profile; lid from
   fdm_toolchanger, nozzle height the engine's default), when the profile
   gives none. */
const SQ_U1 = { radius: 72.5, rod: 27.5, lid: 140, nozzle: 2.5, height: 270.05 };

/* The engine's MAX_OUTER_NOZZLE_DIAMETER: the gap between objects lower
   than the nozzle. */
const SQ_SHORT_GAP = 4;

/* The clearances from a profile reader (key → value), the U1's otherwise. */
function sqClearance(get = () => undefined) {
  const scalar = (k) => Array.isArray(get(k)) ? get(k)[0] : get(k);
  const num = (k, d) => {
    const v = parseFloat(scalar(k));
    return isFinite(v) && v >= 0 ? v : d;
  };
  const c = {
    radius: num("extruder_clearance_radius", SQ_U1.radius),
    rod: num("extruder_clearance_height_to_rod", SQ_U1.rod),
    lid: num("extruder_clearance_height_to_lid", SQ_U1.lid),
    nozzle: num("nozzle_height", SQ_U1.nozzle),
    height: num("printable_height", SQ_U1.height),
  };
  if (String(get("skirt_type")) === "perobject" && num("skirt_loops", 0) > 0) {
    const maximum = (k, fallback) => {
      const raw = get(k), values = (Array.isArray(raw) ? raw : [raw]).map(parseFloat).filter((v) => isFinite(v) && v > 0);
      return values.length ? Math.max(...values) : fallback;
    };
    const nozzles = get("nozzle_diameter");
    const support = Math.max(0, num("support_filament", 0) - 1);
    const nozzle = parseFloat(Array.isArray(nozzles) ? nozzles[support] ?? nozzles[0] : nozzles) || .4;
    const maxNozzle = maximum("nozzle_diameter", .4);
    const absolute = (value, base) => String(value).includes("%") ? parseFloat(value) * base / 100 : parseFloat(value);
    // object_skirt_offset uses the largest nozzle for its initial width;
    // skirt_flow uses the first object's support nozzle for its flow.
    const initial = absolute(scalar("initial_layer_line_width"), maxNozzle) || 0;
    const flowInitial = absolute(scalar("initial_layer_line_width"), nozzle) || 0;
    const width = flowInitial > 0 ? flowInitial : absolute(scalar("line_width"), nozzle) || 1.125 * nozzle;
    const height = absolute(scalar("initial_layer_print_height"), num("layer_height", .2)) || .2;
    c.skirt = {
      distance: num("skirt_distance", 2), loops: num("skirt_loops", 1),
      width, initial, spacing: Math.max(0, width - height * (1 - Math.PI / 4)),
      tall: String(get("draft_shield")) === "enabled" || num("skirt_height", 1) * maximum("max_layer_height", .3) > c.nozzle,
    };
  }
  return c;
}

/* The distance the engine wants between two footprints: the radius (each
   grown by half of it, less 0.1 mm), or almost nothing when every object is
   lower than the nozzle. */
function sqGap(items, c) {
  const short = items.length > 0 && items.every((o) => o.height < c.nozzle);
  const skirt = c.skirt;
  let offset = 0;
  if (skirt) {
    const extent = skirt.distance + skirt.width + (skirt.loops - 1) * skirt.spacing;
    offset = short ? extent : skirt.tall ? skirt.distance + skirt.initial : Math.max(0, extent - c.radius / 2);
  }
  return Math.max(0, (short ? Math.max(SQ_SHORT_GAP / 2, offset) : c.radius / 2 + offset) - .1) * 2;
}

const sqSub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const sqDot = (a, b) => a[0] * b[0] + a[1] * b[1];

/* Distance from p to the segment ab. */
function sqSegDist(p, a, b) {
  const ab = sqSub(b, a);
  const l = sqDot(ab, ab);
  const t = l > 0 ? Math.max(0, Math.min(1, sqDot(sqSub(p, a), ab) / l)) : 0;
  const q = [a[0] + ab[0] * t, a[1] + ab[1] * t];
  return Math.hypot(p[0] - q[0], p[1] - q[1]);
}

/* Two convex polygons overlap: no edge normal of either separates them. */
function sqOverlap(a, b) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const n = [q[1] - p[1], p[0] - q[0]];
      const span = (s) => s.reduce(([lo, hi], v) => [Math.min(lo, sqDot(v, n)), Math.max(hi, sqDot(v, n))], [Infinity, -Infinity]);
      const [a0, a1] = span(a), [b0, b1] = span(b);
      if (a1 < b0 || b1 < a0) return false;
    }
  }
  return true;
}

/* Smallest distance between two convex polygons (0 when they meet). A
   point or a segment counts as a polygon. */
function sqDist(a, b) {
  if (!a.length || !b.length) return Infinity;
  const inside = (p, poly) => {
    if (poly.length < 3) return false;
    let sign = 0;
    for (let i = 0; i < poly.length; i++) {
      const v = sqSub(poly[(i + 1) % poly.length], poly[i]), w = sqSub(p, poly[i]);
      const cross = v[0] * w[1] - v[1] * w[0];
      if (Math.abs(cross) < 1e-10) continue;
      if (sign && Math.sign(cross) !== sign) return false;
      sign = Math.sign(cross);
    }
    return true;
  };
  if (a.some((p) => inside(p, b)) || b.some((p) => inside(p, a))) return 0;
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    const p = a[i], q = a[(i + 1) % a.length], u = b[j], v = b[(j + 1) % b.length];
    if (cross(p, q, u) * cross(p, q, v) < 0 && cross(u, v, p) * cross(u, v, q) < 0) return 0;
  }
  let d = Infinity;
  const edges = (poly) => (poly.length === 1 ? [[poly[0], poly[0]]] : poly.map((p, i) => [p, poly[(i + 1) % poly.length]]));
  for (const [p, q] of edges(b)) for (const v of a) d = Math.min(d, sqSegDist(v, p, q));
  for (const [p, q] of edges(a)) for (const v of b) d = Math.min(d, sqSegDist(v, p, q));
  return d;
}

/* A convex footprint grown by `d` with round corners (counter-clockwise or
   not), for drawing the room the head needs around it. */
function sqGrow(poly, d, steps = 6) {
  if (!poly.length) return [];
  if (poly.length === 2 && d > 0) {
    const [a, b] = poly, angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    return [b, a].flatMap((p, end) => Array.from({ length: steps * 2 + 1 }, (_, i) => {
      const t = angle - Math.PI / 2 + end * Math.PI + i * Math.PI / (steps * 2);
      return [p[0] + d * Math.cos(t), p[1] + d * Math.sin(t)];
    }));
  }
  if (poly.length < 3 || d <= 0) {
    if (d <= 0) return poly.map((p) => [p[0], p[1]]);
    const c = poly.reduce((s, p) => [s[0] + p[0] / poly.length, s[1] + p[1] / poly.length], [0, 0]);
    return Array.from({ length: steps * 4 }, (_, i) => {
      const t = (i / (steps * 4)) * 2 * Math.PI;
      return [c[0] + d * Math.cos(t), c[1] + d * Math.sin(t)];
    });
  }
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    area += p[0] * q[1] - q[0] * p[1];
  }
  const ccw = area > 0;
  const normal = (p, q) => {
    const e = sqSub(q, p), l = Math.hypot(e[0], e[1]) || 1;
    return ccw ? [e[1] / l, -e[0] / l] : [-e[1] / l, e[0] / l];
  };
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const prev = poly[(i + poly.length - 1) % poly.length], p = poly[i], next = poly[(i + 1) % poly.length];
    const n0 = normal(prev, p), n1 = normal(p, next);
    let a0 = Math.atan2(n0[1], n0[0]), a1 = Math.atan2(n1[1], n1[0]);
    // Turn the short way, in the polygon's direction.
    if (ccw) while (a1 < a0) a1 += 2 * Math.PI;
    else while (a1 > a0) a1 -= 2 * Math.PI;
    const k = Math.max(1, Math.ceil((Math.abs(a1 - a0) / (Math.PI / 2)) * steps));
    for (let j = 0; j <= k; j++) {
      const t = a0 + ((a1 - a0) * j) / k;
      out.push([p[0] + d * Math.cos(t), p[1] + d * Math.sin(t)]);
    }
  }
  return out;
}

const sqBox = (poly) =>
  poly.reduce((b, p) => ({ x0: Math.min(b.x0, p[0]), y0: Math.min(b.y0, p[1]), x1: Math.max(b.x1, p[0]), y1: Math.max(b.y1, p[1]) }), {
    x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity,
  });

/* The plate checked for printing by object. `items`: in print order,
   { id, foot (top-view footprint on the bed, convex), height }. Returns
   the gap wanted, the pairs too close ([id, id]), the objects too tall
   ({ id, limit, why: "rod" | "lid" }) and every object's number (from 1). */
function sqCheck(items, c = SQ_U1) {
  const gap = sqGap(items, c);
  const close = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (sqDist(items[i].foot, items[j].foot) < gap) close.push([items[i].id, items[j].id]);
    }
  }
  const tall = [];
  items.forEach((o, k) => {
    if (k === items.length - 1) {
      if (o.height > c.height) tall.push({ id: o.id, limit: c.height, why: "height" });
      return;
    }
    // A later object in its row (the later one's footprint grown as the
    // engine grows it): the gantry rod passes over this one.
    const b = sqBox(o.foot);
    const inRow = items.slice(k + 1).some((p) => {
      const q = sqBox(p.foot);
      return Math.min(b.y1, q.y1 + gap / 2) - Math.max(b.y0, q.y0 - gap / 2) > 0;
    });
    const limit = inRow ? c.rod : c.lid;
    if (o.height > limit) tall.push({ id: o.id, limit, why: inRow ? "rod" : "lid" });
  });
  return { gap, close, tall, order: Object.fromEntries(items.map((o, k) => [o.id, k + 1])) };
}

/* Why the plate cannot print by object, or null: colour changes at a
   height (the whole plate changes head together) or a virtual head (it
   changes heads at every layer, which needs a tower). */
function sqBlocked({ assoc = "object", virtual = false } = {}) {
  if (assoc === "height") return "height";
  if (virtual) return "virtual";
  return null;
}

/* The list's ids with `moved` taken out and put back before `before`
   (null: at the end), in their own order. */
function sqMove(ids, moved, before) {
  const set = new Set(moved);
  const rest = ids.filter((id) => !set.has(id));
  const at = before == null || set.has(before) ? -1 : rest.indexOf(before);
  const keep = ids.filter((id) => set.has(id));
  if (at < 0) return before != null && set.has(before) ? ids.slice() : [...rest, ...keep];
  return [...rest.slice(0, at), ...keep, ...rest.slice(at)];
}

if (typeof module !== "undefined") {
  module.exports = { SQ_U1, sqClearance, sqGap, sqDist, sqOverlap, sqGrow, sqCheck, sqBlocked, sqMove };
}
