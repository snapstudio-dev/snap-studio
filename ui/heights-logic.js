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
  (changes || [])
    .map((c) => {
      const kind = c.kind === "pause" ? "pause" : "auto";
      // A colour change (M600): the colour the spool is swapped to.
      return kind === "pause" && c.color ? { z: +c.z, ext: c.extruder, kind, swap: c.color } : { z: +c.z, ext: c.extruder, kind };
    })
    .filter((c) => c.z > 0 && c.ext >= 1);

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
   the layers whose main tool differs from the layer below's, and then the
   first printed layer with its head (`start`), so the first colour is
   marked too (with a head change or a pause to mark). `tools[l]` is layer `l`'s main tool (undefined: no
   extrusion). A plate changing
   heads more than `max` times (a virtual head alternates at every layer)
   gets no head marks: they would say nothing. */
function hcMarks(tools, pauses, max = 32) {
  const marks = (pauses || []).map((l) => ({ layer: l, kind: "pause" }));
  const heads = [];
  let prev, first;
  for (let l = 0; l < tools.length; l++) {
    const t = tools[l];
    if (t == null) continue;
    if (prev == null) first = { layer: l, kind: "head", tool: t, start: true };
    else if (t !== prev) heads.push({ layer: l, kind: "head", tool: t });
    prev = t;
  }
  // A plate with pauses only still says which head it starts on.
  const show = first != null && (heads.length > 0 || marks.length > 0) && heads.length <= max;
  if (show) heads.unshift(first);
  if (show) for (const h of heads) if (!marks.some((m) => m.layer === h.layer)) marks.push(h);
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

/* The head bands from the bed up, for the tint:
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
   pause keeps the head). For the slice's heads and the prime tower: with
   `top` (the objects' tallest, mm), the changes they never reach left out,
   as the slice leaves them (hzRequest). */
function hzPlanHeads(plan, top = 0) {
  if (!plan) return [];
  return [plan.base ?? 0, ...(plan.changes || []).filter((c) => c.kind !== "pause" && !hzAbove(c.z, top)).map((c) => c.head)];
}

/* A change at `z` the objects never reach (`top` their tallest, mm; 0 or
   none: unknown, all reached). */
const hzAbove = (z, top) => top > 0 && z >= top - 1e-4;

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
  // At or above the tallest object's top (`plate.top`): never reached, left
  // out (the engine would put them after the last layer).
  }).filter((c) => !hzAbove(c.z, plate.top));
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

/* The file's colour of the start (`i` -1) or of a change: the one it
   swaps to, a pause's included (loaded by hand); null for a row made by
   hand, or a plan typed on an STL. */
function hzWant(plan, i) {
  const c = i < 0 ? null : plan?.changes?.[i];
  const hex = i < 0 ? plan?.baseHex : c?.hex || c?.swap;
  return hzColourGap(hex, hex) === 0 ? hex : null;
}
/* A head's spool far from the file's colour, both known. */
const hzFar = (want, spool) => Number.isFinite(hzColourGap(want, spool)) && hzColourGap(want, spool) > HZ_LOADED;

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

/* Each colour of a plan (`hexes`, in order) on its own head when there are
   enough: the closest pairs first, so two shades never share a head while
   another is free. Map hex → { head, exact, with } (`with` the colour
   already on that head when there were more colours than heads, or none
   left near); null when no head has a colour. */
function hzAssign(hexes, heads) {
  const want = [...new Set((hexes || []).filter(Boolean))];
  const known = (heads || []).filter((h) => hzColourGap(h.color, h.color) === 0);
  if (!known.length) return null;
  const pairs = [];
  for (const hex of want) for (const h of known) pairs.push({ hex, head: h.head, gap: hzColourGap(hex, h.color) });
  pairs.sort((a, b) => a.gap - b.gap);
  const out = new Map(), taken = new Map();
  for (const p of pairs) {
    if (out.has(p.hex) || taken.has(p.head) || !Number.isFinite(p.gap)) continue;
    out.set(p.hex, { head: p.head, exact: p.gap <= HZ_LOADED, with: null });
    taken.set(p.head, p.hex);
  }
  // More colours than heads: the nearest, shared.
  for (const hex of want) {
    if (out.has(hex)) continue;
    const near = hzNearestHead(hex, known);
    if (!near) continue;
    out.set(hex, { ...near, with: taken.get(near.head) ?? null });
  }
  return out;
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

/* No head with a known spool (the printer never answered): the heads
   follow the file's order, said once, and the colours wait (hzRematch). */
const hzKnown = (heads) => (heads || []).some((h) => hzColourGap(h.color, h.color) === 0);
const hzUniq = (warnings) => {
  const seen = new Set();
  return warnings.filter((w) => {
    const k = JSON.stringify(w);
    return seen.has(k) ? false : seen.add(k);
  });
};

/* Two colours of the file on one head (more colours than heads). */
const hzSame = (a, b, nameOf = () => null) => ({ kind: "same", hex: a, name: nameOf(a), with: b, withName: nameOf(b) });

/* A plan from a describe and the printer's heads ([{ head, color }]):
   { plan, warnings: [{ kind: "gap" | "unloaded" | "unknown" | "offline", ... }] }.
   Each height goes to the top of a real layer of the file's layers; the
   start and each change keep the colour they stand for (`baseHex`, `hex`). */
function hzFromDescribe(d, heads) {
  const warnings = [];
  const known = hzKnown(heads);
  if (!known) warnings.push({ kind: "offline" });
  const lh = d.layer_height, first = d.first_layer ?? d.layer_height;
  const names = [d.start, ...d.swaps.map((s) => s.name)].filter(Boolean);
  const map = known ? hzAssign(names.map((n) => hzColourOf(n, d.colours)?.hex), heads) : null;
  const nameOf = (hex) => d.colours.find((c) => c.hex === hex)?.name || null;
  const headOf = (name) => {
    const c = hzColourOf(name, d.colours);
    if (!c) {
      warnings.push({ kind: "unknown", name });
      return { head: 0, hex: null };
    }
    if (!known) return { head: d.colours.indexOf(c) % 4, hex: c.hex };
    const h = map?.get(c.hex);
    if (!h?.exact) warnings.push({ kind: "unloaded", name: c.name || name, hex: c.hex });
    if (h?.with) warnings.push(hzSame(h.with, c.hex, nameOf));
    return { head: h?.head ?? 0, hex: c.hex };
  };
  const start = d.start ? headOf(d.start) : { head: 0, hex: null };
  const changes = d.swaps.map((s) => {
    const snap = hzSnap(s.z, lh, first);
    if (Math.abs(snap.gap) > 0.01) warnings.push({ kind: "gap", z: s.z, to: snap.z });
    const to = headOf(s.name);
    return { z: snap.z, head: to.head, kind: "auto", hex: to.hex };
  });
  return {
    plan: {
      base: start.head, baseHex: start.hex, changes,
      layers: lh ? { layer_height: lh, first_layer: first } : null, src: "describe",
      names: Object.fromEntries(d.colours.map((c) => [c.hex, c.name])),
    },
    warnings: hzUniq(warnings),
  };
}

/* A plan from a 3MF's list (hcFromFile's, extruders from 1), the file's
   colours by extruder ({ 1: "#rrggbb" }) and the printer's heads. A pause
   keeps the head in force; a colour change goes to a loaded head (hzSwap). */
function hzFromFile(hc, colours, layers, heads, own = null) {
  const warnings = [];
  const known = hzKnown(heads);
  if (!known) warnings.push({ kind: "offline" });
  // The object's own extruder starts (the first, when the file says none).
  const start = own >= 1 ? own : 1;
  const exts = [start, ...(hc || []).filter((c) => c.kind !== "pause").map((c) => c.ext)];
  const map = known ? hzAssign(exts.map((e) => colours?.[e]), heads) : null;
  const headOf = (ext) => {
    const hex = colours?.[ext] || null;
    if (!known) return (ext - 1) % 4;
    const h = hex ? map?.get(hex) : hzNearestHead(hex, heads);
    if (!h?.exact) warnings.push({ kind: "unloaded", name: null, hex });
    if (h?.with) warnings.push(hzSame(h.with, hex));
    return h?.head ?? (ext - 1) % 4;
  };
  const lh = layers?.layer_height, first = layers?.first_layer ?? lh;
  const changes = [...(hc || [])]
    .sort((a, b) => a.z - b.z)
    .map((c) => {
      const snap = lh ? hzSnap(c.z, lh, first) : { z: c.z, gap: 0 };
      if (Math.abs(snap.gap) > 0.01) warnings.push({ kind: "gap", z: c.z, to: snap.z });
      if (c.kind === "pause") return hzSwap({ z: snap.z, head: null, kind: c.kind, ...(c.swap ? { swap: c.swap } : {}) }, known ? heads : null);
      return { z: snap.z, head: headOf(c.ext), kind: c.kind, hex: colours?.[c.ext] || null };
    });
  const base = headOf(start);
  let cur = base;
  for (const c of changes) c.head = c.kind === "pause" ? cur : (cur = c.head);
  return {
    plan: { base, baseHex: colours?.[start] || null, changes, layers: lh ? { layer_height: lh, first_layer: first } : null, src: "3mf" },
    warnings: hzUniq(warnings),
  };
}

/* A colour change of the file (a pause with `swap`, the colour the spool
   is swapped to by hand): a head change to the head holding that colour
   when one does (`heads`, the loaded ones), else the pause, for the swap. */
function hzSwap(c, heads) {
  if (c.kind !== "pause" || !c.swap || c.hand) return c;
  const near = heads ? hzNearestHead(c.swap, heads) : null;
  return near?.exact ? { ...c, kind: "auto", head: near.head, hex: c.swap } : c;
}

/* An imported plan made while no spool was known, once the printer's
   heads are: each colour to its head, the "offline" warning replaced by
   the colours no head holds. Null while still none is known. */
function hzRematch(plan, heads) {
  if (!plan || !hzKnown(heads)) return null;
  const warnings = (plan.warnings || []).filter((w) => w.kind !== "offline" && w.kind !== "unloaded" && w.kind !== "same");
  // Heads chosen by hand stay, the import's colours on the others.
  const free = [plan.baseHand ? null : plan.baseHex, ...(plan.changes || []).filter((c) => c.kind !== "pause" && !c.hand).map((c) => c.hex)];
  const map = hzAssign(free.filter(Boolean), heads);
  const headOf = (hex, was, hand) => {
    if (!hex || hand) return was;
    const h = map?.get(hex);
    if (!h?.exact) warnings.push({ kind: "unloaded", name: plan.names?.[hex] ?? null, hex });
    if (h?.with) warnings.push(hzSame(h.with, hex, (x) => plan.names?.[x] ?? null));
    return h?.head ?? was;
  };
  const base = headOf(plan.baseHex, plan.base, plan.baseHand);
  let cur = base;
  const changes = (plan.changes || []).map((c0) => {
    // A colour change the spools now hold: a head change.
    const c = hzSwap(c0, heads);
    const head = c.kind === "pause" ? cur : c !== c0 ? (cur = c.head) : (cur = headOf(c.hex, c.head, c.hand));
    return { ...c, head };
  });
  return { ...plan, base, changes, warnings: hzUniq(warnings) };
}

/* The head in force at `z` (a change at `z` included), a pause keeping
   the one before it. */
function hzHeadAt(plan, z) {
  let cur = plan?.base ?? 0;
  for (const c of [...(plan?.changes || [])].sort((a, b) => a.z - b.z)) {
    if (c.z > z + 1e-6) break;
    if (c.kind !== "pause") cur = c.head;
  }
  return cur;
}

/* What the import said of colour `hex` dropped (its head chosen by hand),
   what it said of the others kept. */
const hzForget = (warnings, hex) =>
  (warnings || []).filter((w) => !(["unloaded", "unknown", "same"].includes(w.kind) && (w.hex === hex || w.with === hex)));

/* A plan as a saved 3MF keeps it for Orca: [{ z, extruder, kind }], each
   head through `extOf` (a model extruder from 1); a pause carries the head
   in force. */
function hzToFile(plan, extOf) {
  let cur = plan?.base ?? 0;
  return [...(plan?.changes || [])]
    .sort((a, b) => a.z - b.z)
    .map((c) => {
      if (c.kind !== "pause") cur = c.head;
      return { z: c.z, extruder: extOf(cur), kind: c.kind === "pause" ? "pause" : "auto" };
    });
}

/* The plan Snap Studio saved beside a 3MF's list (`saved`, with `check`
   the list it was saved with), when that list is still the file's (`hc`,
   hcFromFile's): an edit in another slicer makes it stale. Null otherwise. */
function hzFromSaved(saved, hc) {
  if (!saved || !Array.isArray(saved.changes) || saved.check !== hcKey(hc)) return null;
  const { check, ...plan } = saved;
  return { ...plan, changes: plan.changes.map((c) => ({ ...c })), warnings: [] };
}

/* A change's layer typed (from 2: the first is the start): its height. */
const hzLayerZ = (n, lh, first) => (n >= 2 && lh > 0 && first > 0 ? hzLayerTop(Math.round(n), lh, first) : null);

/* ------------------------------------------------------------ slice settings */

/* A file's settings among `keys` (Orca keys), as strings. */
const hzPick = (cfg, keys) =>
  Object.fromEntries((keys || []).filter((k) => cfg?.[k] != null && cfg[k] !== "").map((k) => [k, String(cfg[k])]));

/* The slice settings a plan brings: a 3MF's own (`settings`), a
   describe's layers and full infill; a plan saved before them, its layers. */
function hzPlanSettings(plan) {
  if (!plan) return {};
  const s = { ...(plan.settings || {}) };
  const l = plan.layers;
  if (l?.layer_height > 0) {
    s.layer_height ??= String(l.layer_height);
    s.initial_layer_print_height ??= String(l.first_layer || l.layer_height);
  }
  if (plan.infill100) s.sparse_infill_density ??= "100%";
  return s;
}

/* The sheet's quick settings among them, each only when given:
   { layer (rounded to the profiles' 0.01 mm), exact (the file's height is
   that), infill, walls, supports, brim }. */
function hzQuick(s) {
  const n = (k) => {
    const x = parseFloat(String(s?.[k] ?? "").replace("%", ""));
    return Number.isFinite(x) ? x : null;
  };
  const out = {};
  if (n("layer_height") > 0) {
    out.layer = Math.round(n("layer_height") * 100) / 100;
    out.exact = Math.abs(out.layer - n("layer_height")) < 1e-6;
  }
  if (n("sparse_infill_density") != null) out.infill = Math.max(0, Math.min(100, n("sparse_infill_density")));
  if (n("wall_loops") != null) out.walls = Math.round(n("wall_loops"));
  if (s?.enable_support != null) out.supports = ["1", "true"].includes(String(s.enable_support));
  // "auto_brim" is Orca's default, not the author's choice.
  if (s?.brim_type != null && s.brim_type !== "auto_brim") out.brim = s.brim_type !== "no_brim";
  return out;
}

/* A file made for the U1 (its printer model): all its settings fit; from
   another printer, not those of its machine and nozzle. */
const hzForU1 = (cfg) => /\bU1\b/i.test(String(cfg?.printer_model || ""));
const HZ_MACHINE_KEYS = new Set([
  "line_width", "initial_layer_line_width", "outer_wall_line_width", "top_surface_line_width",
  "elefant_foot_compensation", "xy_hole_compensation", "xy_contour_compensation", "resolution", "enable_arc_fitting",
  "enable_overhang_speed", "overhang_1_4_speed", "overhang_2_4_speed", "overhang_3_4_speed", "overhang_4_4_speed", "ironing_speed",
]);

/* What the sheet remembers for the machine once a file's settings were
   applied to it (`m`: { before, file }, each { process, simple, adv }): a
   value still the file's is not the person's choice, theirs from before
   is kept; what they changed since is theirs. */
function hzMemo(data, m) {
  if (!m) return data;
  const out = { ...data };
  if ("process" in out && out.process === m.file.process) out.process = m.before.process;
  if (out.simple) {
    const s = { ...out.simple };
    for (const k in m.file.simple) if (s[k] === m.file.simple[k]) s[k] = m.before.simple?.[k];
    out.simple = s;
  }
  if (out.adv) {
    const a = { ...out.adv };
    for (const k in m.file.adv) {
      // Absent: at the profile's value, the file's or one set back to it.
      if (k in a && String(a[k]) !== String(m.file.adv[k])) continue;
      if (m.before.adv && k in m.before.adv) a[k] = m.before.adv[k];
      else delete a[k];
    }
    out.adv = a;
  }
  return out;
}

if (typeof module !== "undefined") {
  module.exports = {
    hcColours, hcFromFile, hcKey, hcRequest, hcMarks, hzToFile, hzFromSaved, hzAssign, hzHeadAt, hzForget, hzAbove, hzSwap, hzWant, hzFar,
    hzLayerTop, hzSnap, hzBands, hzPlanHeads, hzRequest, hzColourGap, hzNearestHead, hzParseDescribe, hzColourOf, hzFromDescribe, hzFromFile, hzRematch, hzLayerZ,
    hzPick, hzPlanSettings, hzQuick, hzMemo, hzForU1, HZ_MACHINE_KEYS,
  };
}
