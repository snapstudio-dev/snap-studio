/* Prepare view: pure rules shared by the plate and its tests (no DOM, no
   WebGL). Objects are given as top-view footprints (points in mm) or as
   precomputed bed states, so node can run them. */

/* On the bed: "in", "partial" (sticks out) or "out" (beside it). */
function plBedState(pts, bed) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const e = 0.1, { w, d } = bed;
  if (x1 < -e || y1 < -e || x0 > w + e || y0 > d + e) return "out";
  if (x0 < -e || y0 < -e || x1 > w + e || y1 > d + e) return "partial";
  return "in";
}

/* The two groups of the object list, in plate order. An object that
   sticks out stays with the plate (it blocks slicing until it is fixed).
   Only "in" objects are sliced. One list per plate when plates come. */
function plGroups(objects, stateOf) {
  const on = [], off = [];
  let partial = 0, sliced = 0;
  for (const o of objects) {
    const st = stateOf(o);
    if (st === "out") off.push(o);
    else {
      on.push(o);
      if (st === "partial") partial++;
      else sliced++;
    }
  }
  return { on, off, partial, sliced };
}

/* Objects handed to slicing: those fully on the bed. */
const plSliced = (objects, stateOf) => objects.filter((o) => stateOf(o) === "in");

/* Slider bounds and steps of an inspector field. `step` is the slider's
   own grain, `fine` the wheel / arrow step and `coarse` the same with ⇧.
   A setting ("purge": the prime tower's volume) brings its bounds, `lim`. */
function plRange(kind, bed, axis = 0, lim = null) {
  if (kind === "pos") return { min: 0, max: axis ? bed.d : bed.w, step: 0.5, fine: 1, coarse: 10 };
  if (kind === "purge") return { min: lim?.min ?? 15, max: lim?.max ?? 90, step: 1, fine: 1, coarse: 5 };
  if (kind === "rot") return { min: -180, max: 180, step: 1, fine: 1, coarse: 15 };
  return { min: 10, max: 400, step: 1, fine: 1, coarse: 10 };
}

/* Magnetic notches every 15 degrees: a value within `pull` of one sticks
   to it, unless snapping is off (⇧). */
function plSnapAngle(v, free, pull = 3) {
  if (free) return v;
  const r = Math.round(v / 15) * 15;
  return Math.abs(v - r) <= pull ? r : v;
}

const plWrapDeg = (a) => {
  let x = ((a % 360) + 360) % 360;
  if (x > 180) x -= 360;
  return Math.round(x * 100) / 100;
};

/* One wheel / arrow step from `v` (dir = +1 or -1): a rotation wraps
   around, the others stay within the slider's bounds. A coarse rotation
   step lands on the 15 degree notches. A value already beyond the bounds
   (a scale typed at 2540 %, an object parked beside the bed) just takes
   the step: clamping it would throw it back to the bound in one notch. */
function plNudge(kind, v, dir, coarse, bed, axis = 0, lim = null) {
  const r = plRange(kind, bed, axis, lim);
  const s = coarse ? r.coarse : r.fine;
  let x = coarse ? (dir > 0 ? Math.floor(v / s + 1e-9) + 1 : Math.ceil(v / s - 1e-9) - 1) * s : v + dir * s;
  x = Math.round(x * 100) / 100;
  if (kind === "rot") return plWrapDeg(x);
  if (v < r.min || v > r.max) return kind === "scale" ? Math.max(1, x) : x;
  return Math.min(r.max, Math.max(r.min, x));
}

/* Smallest move [dx, dy] bringing a top-view box fully on the bed, or null
   when the box is larger than the bed. */
function plInside(box, bed) {
  const bw = box.x1 - box.x0, bd = box.y1 - box.y0;
  if (bw > bed.w + 0.1 || bd > bed.d + 0.1) return null;
  const dx = box.x0 < 0 ? -box.x0 : box.x1 > bed.w ? bed.w - box.x1 : 0;
  const dy = box.y0 < 0 ? -box.y0 : box.y1 > bed.d ? bed.d - box.y1 : 0;
  return [dx, dy];
}

/* Parking spot beside the bed for a box of `bw` × `bd` mm: corner
   [x0, y0]. The parking area starts on the bed's right, aligned with its
   front edge, and is no wider than the bed: objects go in rows, left to
   right, a new row when one is full — many objects make several rows, not
   one line running far away. The first free place wins (row by row), so a
   gap left by an object put back on the bed is used again. */
function plParkSpot(parked, bed, bw, bd, gap = 10) {
  const x0 = bed.w + 20, x1 = x0 + bed.w;
  const near = parked.filter((b) => b.x1 > x0 - gap).sort((a, b) => a.x0 - b.x0);
  const ys = [...new Set([0, ...near.map((b) => b.y1 + gap)])].filter((y) => y >= 0).sort((a, b) => a - b);
  for (const y of ys) {
    // Leftmost free place in the row: only the boxes of this band count,
    // swept left to right (fast with hundreds of objects).
    let x = x0;
    for (const b of near) {
      if (y + bd + gap <= b.y0 || b.y1 + gap <= y || b.x1 + gap <= x) continue;
      if (x + bw + gap <= b.x0) break;
      x = b.x1 + gap;
    }
    // Within the area's width (a box wider than it starts a row alone).
    if (x === x0 || x + bw <= x1) return [x, y];
  }
  return [x0, ys[ys.length - 1] ?? 0];
}

/* Shift-click in the list: the ids from the anchor to the clicked one,
   both included, in the displayed order. Without an anchor still listed,
   only the clicked one. */
function plRangeIds(order, anchor, id) {
  const a = order.indexOf(anchor), b = order.indexOf(id);
  if (b < 0) return [];
  if (a < 0) return [id];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/* Point [x, y, z] through a column-major 4 × 4 matrix, to normalized
   device coordinates [x, y] (−1…1, y up); null behind the eye. */
function plProject(m, p) {
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  if (w <= 1e-6) return null;
  return [
    (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w,
    (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w,
  ];
}

/* Screen box (pixels, y down) of points seen through `m` in a `w` × `h`
   view; null when none is in front of the eye. */
function plScreenBox(m, pts, w, h) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    const q = plProject(m, p);
    if (!q) continue;
    const x = ((q[0] + 1) / 2) * w, y = ((1 - q[1]) / 2) * h;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}

/* Rubber band: ids of the boxes ({ id, x0, y0, x1, y1 }) the rectangle
   touches, the rectangle given by two corners in any order. */
function plMarquee(a, b, boxes) {
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  return boxes.filter((r) => r && r.x1 >= x0 && r.x0 <= x1 && r.y1 >= y0 && r.y0 <= y1).map((r) => r.id);
}

/* Scale split into X, Y, Z: when asked for, and always for a scale that
   is not uniform (one slider could not show it). */
const plUniform = (s) => Math.abs(s[0] - s[1]) < 1e-9 && Math.abs(s[1] - s[2]) < 1e-9;
const plScaleSplit = (scale, wanted) => !!wanted || !plUniform(scale);

/* Toolbar of the plate: which buttons show, which act. Only the useful
   ones show; Save, Clear and Slice stay, disabled when they cannot act.
   A button busy (orienting, splitting) or a tool still on stays in view. */
function plTools({ n = 0, sel = 0, onBed = 0, sliceable = false, tool = null, orienting = false, splitting = false, overhangs = false }) {
  const t = (show, on) => ({ show: !!show, on: !!(show && on) });
  return {
    "p-rotate": t(sel || tool === "rotate", true),
    "p-face": t(n || tool === "face", true),
    "p-orient": t(sel || onBed || orienting, !orienting),
    "p-arrange": t(onBed, true),
    "p-overhangs": t(n || overhangs, true),
    "p-dup": t(sel, true),
    "p-split": t(sel || splitting, !splitting && sel),
    "p-del": t(sel, true),
    "p-save": { show: true, on: n > 0 },
    "p-clear": { show: true, on: n > 0 },
    "p-slice": { show: true, on: !!sliceable },
  };
}

/* The bulk button of one side of the list (on or off the plate): "all"
   when no object of that side is selected, or every one of them is;
   "some", with the count, otherwise. Only this side's objects count: a
   mixed selection gives each side its own number. */
function plBulk(selected, side) {
  const n = side.filter((o) => selected.has(o.id)).length;
  return n > 0 && n < side.length ? { mode: "some", n } : { mode: "all", n: side.length };
}

/* ------------------------------------------------------------ colour modes */

/* Colours of the objects on the plate (the sliced ones), in order of first
   appearance: the global mapping of the "by colour" mode is about these;
   a colour only off-plate objects carry comes back with them. */
function plPlateColours(objects, stateOf, coloursOf) {
  const out = [];
  for (const o of objects) {
    if (stateOf(o) === "out") continue;
    for (const c of coloursOf(o)) if (!out.includes(c)) out.push(c);
  }
  return out;
}

/* Object → colour: a colour takes the head every on-plate object using it
   points to; objects that disagree, or none using it, leave it unmapped
   (null), to be chosen by hand before slicing. */
function plMigrateToColour(objects, stateOf, headsOf, colours) {
  const out = {};
  for (const c of colours) {
    let h = null, conflict = false;
    for (const o of objects) {
      if (stateOf(o) === "out") continue;
      const m = headsOf(o)[c];
      if (m == null) continue;
      if (h == null) h = m;
      else if (h !== m) conflict = true;
    }
    out[c] = conflict ? null : h;
  }
  return out;
}

/* Colour → object: each on-plate object takes the global head of each of
   its colours as its own choice; an unmapped colour leaves the object's
   choice as it was. The new `heads` of each object, by id. */
function plMigrateToObject(objects, stateOf, coloursOf, colourHeads) {
  const out = {};
  for (const o of objects) {
    if (stateOf(o) === "out") continue;
    const heads = { ...(o.heads || {}) };
    for (const c of coloursOf(o)) if (colourHeads[c] != null) heads[c] = colourHeads[c];
    out[o.id] = heads;
  }
  return out;
}

/* "By colour" mode: the on-plate objects the 3MF gives no colour, and
   that have no head picked by hand either: each blocks the slice until
   one is chosen on its row. Their ids. */
function plUncoloured(objects, stateOf, ownColoursOf) {
  return objects.filter((o) => stateOf(o) !== "out" && !ownColoursOf(o).length && o.pick == null).map((o) => o.id);
}

/* The plate's colours still without a head: they block the slice. */
const plUnmapped = (colours, colourHeads) => colours.filter((c) => colourHeads[c] == null);

/* "By colour" mode, an object's "Colour…" palette for `n` heads: each head,
   the picked one on; "the plate's colours" only once a head is picked;
   `single`: one head, nothing to choose between. */
function plPalette(pick, n) {
  const count = Math.max(1, n | 0);
  return { heads: Array.from({ length: count }, (_, h) => ({ h, on: pick === h })), plate: pick != null, single: count === 1 };
}

/* ------------------------------------------------------------ supports hint */

/* The supports badge of the plate: the objects whose mesh hint says
   supports are "likely" needed (`support_hint.rs`), while supports are off.
   Their ids and names, and the reasons once each; null when there is
   nothing to say. `objects`: those sliced (on the plate). */
function plSupportBadge(objects, hintOf, supportsOn) {
  if (supportsOn) return null;
  const hit = objects.filter((o) => hintOf(o)?.verdict === "likely");
  if (!hit.length) return null;
  return {
    ids: hit.map((o) => o.id),
    names: hit.map((o) => o.name),
    reasons: [...new Set(hit.map((o) => hintOf(o).reason).filter(Boolean))],
  };
}

/* What the hint of an object depends on: its mesh, its tilt (rotations
   around X then Y; the last, around Z, turns it on the bed) and scale, and
   the overhang angle; not where it sits on the bed. */
const plHintKey = (o, angle) =>
  [o.path, o.item, o.piece ?? "", +o.rot[0].toFixed(3), +o.rot[1].toFixed(3), ...o.scale.map((s) => +s.toFixed(4)), angle ?? ""].join("|");

/* The keyboard is in a field where ⌘Z undoes typing: a text box, a number,
   a list, a text area. A slider, a checkbox or a switch has nothing to undo,
   so the plate's shortcuts still apply there (it keeps the keyboard after a
   drag). `el`: the key event's target. */
const PL_NOT_TYPED = new Set(["range", "checkbox", "radio", "button", "submit", "reset", "color", "file", "image"]);
function plTyping(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName || "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  return !PL_NOT_TYPED.has(String(el.type || "text").toLowerCase());
}

if (typeof module !== "undefined") {
  module.exports = { plTyping, plPalette, plUncoloured, plPlateColours, plMigrateToColour, plMigrateToObject, plUnmapped, plBulk, plBedState, plGroups, plSliced, plRange, plSnapAngle, plWrapDeg, plNudge, plInside, plParkSpot, plRangeIds, plProject, plScreenBox, plMarquee, plUniform, plScaleSplit, plTools, plSupportBadge, plHintKey };
}
