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

if (typeof module !== "undefined") {
  module.exports = { hcColours, hcFromFile, hcKey, hcRequest, hcMarks };
}
