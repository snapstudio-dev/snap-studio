/* Colour changes at a height (HueForge), step 1: the changes a 3MF keeps
   (Metadata/custom_gcode_per_layer.xml, read by `plate_heights`) go to the
   engine with the plate. Each object keeps its file's list as `hc`:
   [{ z, ext, kind }], `ext` a model extruder from 1, `kind` "auto" (the
   head changes on its own) or "pause" (spool swapped by hand: the head
   stays, `ext` is only what the file says), and the layers the file
   placed them on as `hcl` ({ layer_height, first_layer }). The engine
   switches the head of the whole plate from each height up, so the plate
   must print with a single head until the first one. Pure functions,
   tested by scripts/test-heights.js. */

/* An object's colours with its head changes' (the slice sheet maps them
   all); a pause keeps the head, so adds none. */
function hcColours(base, hc) {
  const out = [...(base?.length ? base : [1])];
  for (const c of hc || []) if (c.kind === "auto" && !out.includes(c.ext)) out.push(c.ext);
  return out;
}

/* A list as the UI keeps it, from `plate_heights`' changes (extruder from 1). */
const hcFromFile = (changes) =>
  (changes || []).map((c) => ({ z: +c.z, ext: c.extruder, kind: c.kind === "pause" ? "pause" : "auto" })).filter((c) => c.z > 0 && c.ext >= 1);

const hcKey = (hc) => JSON.stringify((hc || []).map((c) => [Math.round(c.z * 1000), c.ext, c.kind]));

/* What the slice sends, or why it cannot: `items` the sliced objects
   ({ base, hc, hcl, map, scale }: own colours, changes, their file's
   layers, head of each extruder `i + 1` at `map[i]`, as the engine numbers
   heads, scale), `plate` what the plate does that the changes cannot go
   with ({ pillars, byObject }).
   { changes: [{ z, head, kind }], layers } (no changes: nothing to send),
   or { error: "mixed" | "heads" | "scaled" | "pillars" | "by_object" }.
   A pause carries the head in force at its height. */
function hcRequest(items, plate = {}) {
  const lists = items.map((it) => it.hc || []);
  if (!lists.some((l) => l.length)) return { changes: [] };
  // The engine changes the whole plate's head: every object must agree,
  // on the same layers.
  const key = (it) => hcKey(it.hc) + JSON.stringify(it.hc?.length ? it.hcl || null : null);
  if (new Set(items.map(key)).size > 1) return { error: "mixed" };
  // The heights are the file's: a stretched or squashed object would
  // change colour elsewhere.
  if (items.some((it) => it.hc?.length && Math.abs((it.scale?.[2] ?? 1) - 1) > 1e-6)) return { error: "scaled" };
  if (plate.pillars) return { error: "pillars" };
  if (plate.byObject) return { error: "by_object" };
  // Below the first change, the plate prints with one head (several
  // colours, a painted part or two heads on the plate: the engine would
  // ignore the list).
  const base = new Set();
  for (const it of items) for (const e of it.base?.length ? it.base : [1]) base.add(it.map[e - 1] ?? 0);
  if (base.size > 1) return { error: "heads" };
  let cur = [...base][0] ?? 0;
  const changes = [];
  for (const c of [...lists[0]].sort((a, b) => a.z - b.z)) {
    if (c.kind === "auto") {
      // Each object must send this colour to the same head.
      const heads = new Set(items.map((it) => it.map[c.ext - 1] ?? 0));
      if (heads.size > 1) return { error: "heads" };
      cur = [...heads][0];
    }
    changes.push({ z: c.z, head: cur, kind: c.kind });
  }
  return { changes, layers: items.find((it) => it.hc?.length)?.hcl || null };
}

/* The layers (from 1) the preview marks on its slider: the pauses, and
   the layers whose main tool differs from the layer below's. `tools[l]`
   is layer `l`'s main tool (undefined: no extrusion). A plate changing
   heads more than `max` times (a virtual head alternates at every layer)
   gets no head marks: they would say nothing. */
function hcMarks(tools, pauses, max = 32) {
  const marks = (pauses || []).map((l) => ({ layer: l, kind: "pause" }));
  const heads = [];
  let prev;
  for (let l = 0; l < tools.length; l++) {
    const t = tools[l];
    if (t == null) continue;
    if (prev != null && t !== prev) heads.push({ layer: l, kind: "head", tool: t });
    prev = t;
  }
  if (heads.length <= max) for (const h of heads) if (!marks.some((m) => m.layer === h.layer)) marks.push(h);
  return marks.sort((a, b) => a.layer - b.layer);
}

/* ------------------------------------------------- "By height" mode (step 2)

   The plate's own list, edited in Prepare or imported from HueForge:
   `PR.hz = { base, changes: [{ z, head, kind }], layers, src }`, `base` the
   head the plate starts with, each change's `head` a head as the engine
   numbers them (T0-T3, then the virtual heads), `layers` the file's
   ({ layer_height, first_layer }) when imported, `src` "3mf" | "describe"
   | null. */

const r4 = (x) => Math.round(x * 1e4) / 1e4;

/* The top of layer `n` (from 1): the first layer, then even layers. */
const hzLayerTop = (n, lh, first) => r4(first + (n - 1) * lh);

/* The layer whose top is nearest `z`: { layer, z, gap } (gap in mm, the
   snapped height minus the asked one). Never the first layer, as Rust's
   `Layers::snap`: a change there would be the plate's start. */
function hzSnap(z, lh, first) {
  if (!(lh > 0) || !(first > 0)) return { layer: null, z: r4(z), gap: 0 };
  const layer = Math.max(2, Math.round((z - first) / lh) + 1);
  const top = hzLayerTop(layer, lh, first);
  return { layer, z: top, gap: r4(top - z) };
}

/* The head bands from the bed up, for the ruler and the tint:
   [{ from, to, head, pause }], `to` null for the top one. A pause keeps
   the head (its band starts there, flagged). */
function hzBands(plan) {
  const out = [{ from: 0, to: null, head: plan?.base ?? 0, pause: false }];
  for (const c of [...(plan?.changes || [])].sort((a, b) => a.z - b.z)) {
    const last = out[out.length - 1];
    const head = c.kind === "pause" ? last.head : c.head;
    last.to = c.z;
    out.push({ from: c.z, to: null, head, pause: c.kind === "pause" });
  }
  return out;
}

/* The heads a plan prints with: the start's and each head change's (a
   pause keeps the head). For the slice's heads and the prime tower. */
function hzPlanHeads(plan) {
  if (!plan) return [];
  return [plan.base ?? 0, ...(plan.changes || []).filter((c) => c.kind !== "pause").map((c) => c.head)];
}

/* What the slice sends in "by height" mode, or why it cannot: `items` the
   sliced objects ({ base: own colours, scale }), `plate` as hcRequest's.
   Every object prints with the plate's head until the first change: an
   object with several colours (painted, or a multi-colour file) cannot. */
function hzRequest(plan, items, plate = {}) {
  const changes = [...(plan?.changes || [])].sort((a, b) => a.z - b.z);
  if (items.some((it) => (it.base?.length || 0) > 1)) return { error: "multicolour" };
  if (plan?.src && items.some((it) => Math.abs((it.scale?.[2] ?? 1) - 1) > 1e-6)) return { error: "scaled" };
  if (!changes.length) return { changes: [], base: plan?.base ?? 0 };
  if (plate.pillars) return { error: "pillars" };
  if (plate.byObject) return { error: "by_object" };
  let cur = plan.base ?? 0;
  const out = changes.map((c) => {
    if (c.kind !== "pause") cur = c.head;
    return { z: c.z, head: cur, kind: c.kind === "pause" ? "pause" : "auto" };
  });
  return { changes: out, base: plan.base ?? 0, layers: plan.layers || null };
}

/* RGB distance of two "#rrggbb" (0 same, 441 black/white); Infinity when
   either is not a colour. */
function hzColourGap(a, b) {
  const p = (h) => (/^#?[0-9a-f]{6}/i.test(h || "") ? [0, 2, 4].map((i) => parseInt(h.replace("#", "").slice(i, i + 2), 16)) : null);
  const x = p(a), y = p(b);
  if (!x || !y) return Infinity;
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/* The head holding `hex` (the same colour, else the nearest), from
   `heads` [{ head, color }]: { head, exact } or null when none has a
   colour. "Loaded" is within a small gap (a spool's hex rarely matches
   the file's to the digit). */
const HZ_LOADED = 40;
function hzNearestHead(hex, heads) {
  let best = null;
  for (const h of heads || []) {
    const gap = hzColourGap(hex, h.color);
    if (gap < (best?.gap ?? Infinity)) best = { head: h.head, gap };
  }
  return best && { head: best.head, exact: best.gap <= HZ_LOADED };
}

/* A HueForge "describe" (the text file, or its copy in a MakerWorld page):
   { layer_height, first_layer, infill100, colours: [{ hex, name }],
     start, swaps: [{ layer, z, name }] }, or null when it says none of it.
   The swap heights are the tops of layers (z = base + (n - 1) × layer). */
function hzParseDescribe(text) {
  const t = String(text || "").replace(/\r/g, "");
  const num = (re) => {
    const m = t.match(re);
    return m ? parseFloat(m[1].replace(",", ".")) : null;
  };
  const layer_height = num(/layer height of\s*([\d.,]+)\s*mm/i);
  const first_layer = num(/base layer of\s*([\d.,]+)\s*mm/i);
  const infill100 = /100\s*%\s*infill/i.test(t);
  const colours = [];
  for (const m of t.matchAll(/#([0-9a-f]{6})\b[ \t]*[-–:]?[ \t]*([^\n#]*?)(?:\s*(?:Transmission Distance|TD)\b[^\n#]*)?(?=\n|#[0-9a-f]{6}\b|$)/gi)) {
    colours.push({ hex: `#${m[1].toLowerCase()}`, name: m[2].replace(/[\s\-–:]+$/, "").trim() });
  }
  const start = t.match(/Start with\s+([^\n]+?)(?=\s*[,.;]?\s*(?:At layer|\n|$))/i)?.[1].trim() || null;
  const swaps = [];
  for (const m of t.matchAll(/At layer\s*#?\s*(\d+)\s*\(\s*([\d.,]+)\s*mm\s*\)\s*,?\s*swap to\s+([^\n]+?)(?=\s*(?:for the rest\b|[,.;]?\s*At layer\b|[.;]?\s*\n|[.;]?\s*$))/gi)) {
    swaps.push({ layer: +m[1], z: parseFloat(m[2].replace(",", ".")), name: m[3].trim() });
  }
  if (layer_height == null && !colours.length && !swaps.length) return null;
  return { layer_height, first_layer, infill100, colours, start, swaps };
}

/* The colour line a swap's name stands for: the line whose name holds it
   (as words, any case), else the one sharing most of its words. */
function hzColourOf(name, colours) {
  const words = (s) => String(s || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const want = words(name);
  if (!want.length) return null;
  const has = (c) => {
    const w = words(c.name).join(" ");
    return ` ${w} `.includes(` ${want.join(" ")} `);
  };
  const whole = colours.find(has);
  if (whole) return whole;
  let best = null, score = 0;
  for (const c of colours) {
    const w = new Set(words(c.name));
    const s = want.filter((x) => w.has(x)).length;
    if (s > score) (best = c), (score = s);
  }
  return best;
}

/* A plan from a describe and the printer's heads ([{ head, color }]):
   { plan, warnings: [{ kind: "gap" | "unloaded" | "unknown", ... }] }.
   Each height goes to the top of a real layer of the file's layers. */
function hzFromDescribe(d, heads) {
  const warnings = [];
  const lh = d.layer_height, first = d.first_layer ?? d.layer_height;
  const headOf = (name) => {
    const c = hzColourOf(name, d.colours);
    if (!c) {
      warnings.push({ kind: "unknown", name });
      return { head: 0, hex: null };
    }
    const h = hzNearestHead(c.hex, heads);
    if (!h?.exact) warnings.push({ kind: "unloaded", name: c.name || name, hex: c.hex });
    return { head: h?.head ?? 0, hex: c.hex };
  };
  const base = d.start ? headOf(d.start).head : 0;
  const changes = d.swaps.map((s) => {
    const snap = hzSnap(s.z, lh, first);
    if (Math.abs(snap.gap) > 0.01) warnings.push({ kind: "gap", z: s.z, to: snap.z });
    return { z: snap.z, head: headOf(s.name).head, kind: "auto" };
  });
  const seen = new Set();
  const uniq = warnings.filter((w) => {
    const k = JSON.stringify(w);
    return seen.has(k) ? false : seen.add(k);
  });
  return {
    plan: { base, changes, layers: lh ? { layer_height: lh, first_layer: first } : null, src: "describe" },
    warnings: uniq,
  };
}

/* A plan from a 3MF's list (hcFromFile's, extruders from 1), the file's
   colours by extruder ({ 1: "#rrggbb" }) and the printer's heads. A pause
   keeps the head in force. */
function hzFromFile(hc, colours, layers, heads) {
  const warnings = [];
  const headOf = (ext) => {
    const hex = colours?.[ext];
    const h = hzNearestHead(hex, heads);
    if (!h?.exact) warnings.push({ kind: "unloaded", name: String(ext), hex: hex || null });
    return h?.head ?? Math.max(0, ext - 1);
  };
  const lh = layers?.layer_height, first = layers?.first_layer ?? lh;
  const changes = [...(hc || [])]
    .sort((a, b) => a.z - b.z)
    .map((c) => {
      const snap = lh ? hzSnap(c.z, lh, first) : { z: c.z, gap: 0 };
      if (Math.abs(snap.gap) > 0.01) warnings.push({ kind: "gap", z: c.z, to: snap.z });
      return { z: snap.z, head: c.kind === "pause" ? null : headOf(c.ext), kind: c.kind };
    });
  const base = headOf(1);
  let cur = base;
  for (const c of changes) c.head = c.kind === "pause" ? cur : (cur = c.head);
  const seen = new Set();
  return {
    plan: { base, changes, layers: lh ? { layer_height: lh, first_layer: first } : null, src: "3mf" },
    warnings: warnings.filter((w) => {
      const k = JSON.stringify(w);
      return seen.has(k) ? false : seen.add(k);
    }),
  };
}

if (typeof module !== "undefined") {
  module.exports = {
    hcColours, hcFromFile, hcKey, hcRequest, hcMarks,
    hzLayerTop, hzSnap, hzBands, hzPlanHeads, hzRequest, hzColourGap, hzNearestHead, hzParseDescribe, hzColourOf, hzFromDescribe, hzFromFile,
  };
}
