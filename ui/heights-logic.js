/* Colour changes at a height (HueForge), step 1: the changes a 3MF keeps
   (Metadata/custom_gcode_per_layer.xml, read by `plate_heights`) go to the
   engine with the plate. Each object keeps its file's list as `hc`:
   [{ z, ext, kind }], `ext` a model extruder from 1, `kind` "auto" (the
   head changes on its own) or "pause" (spool swapped by hand). The engine
   switches the head of the whole plate from each height up, so the plate
   must print with a single head until the first one. Pure functions,
   tested by scripts/test-heights.js. */

/* An object's colours with its changes' (the slice sheet maps them all). */
function hcColours(base, hc) {
  const out = [...(base?.length ? base : [1])];
  for (const c of hc || []) if (!out.includes(c.ext)) out.push(c.ext);
  return out;
}

/* A list as the UI keeps it, from `plate_heights`' changes (extruder from 1). */
const hcFromFile = (changes) =>
  (changes || []).map((c) => ({ z: +c.z, ext: c.extruder, kind: c.kind === "pause" ? "pause" : "auto" })).filter((c) => c.z > 0 && c.ext >= 1);

const hcKey = (hc) => JSON.stringify((hc || []).map((c) => [Math.round(c.z * 1000), c.ext, c.kind]));

/* What the slice sends, or why it cannot: `items` the sliced objects
   ({ base, hc, map }: own colours, changes, head of each extruder `i + 1`
   at `map[i]`, as the engine numbers heads), `plate` what the plate does
   that the changes cannot go with ({ pillars, byObject }).
   { changes: [{ z, head, kind }] } (empty: nothing to send), or
   { error: "mixed" | "heads" | "pillars" | "by_object" }. */
function hcRequest(items, plate = {}) {
  const lists = items.map((it) => it.hc || []);
  if (!lists.some((l) => l.length)) return { changes: [] };
  // The engine changes the whole plate's head: every object must agree.
  if (new Set(lists.map(hcKey)).size > 1) return { error: "mixed" };
  if (plate.pillars) return { error: "pillars" };
  if (plate.byObject) return { error: "by_object" };
  // Below the first change, the plate prints with one head (several
  // colours, a painted part or two heads on the plate: the engine would
  // ignore the list).
  const base = new Set();
  for (const it of items) for (const e of it.base?.length ? it.base : [1]) base.add(it.map[e - 1] ?? 0);
  if (base.size > 1) return { error: "heads" };
  const map = items[0].map;
  const changes = lists[0].map((c) => ({ z: c.z, head: map[c.ext - 1] ?? 0, kind: c.kind }));
  return { changes };
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
