"use strict";
/* "Prepare" view: the plate before slicing.

   Each object is an item of a file's <build>, served centered on itself by
   `mesh://…&i=`. Its placement: scale, rotations (X, then Y, then Z, in
   degrees), then position (X, Y) of its center; the object rests on the bed.
   Rust applies the same rule when slicing (`plate.rs`).

   A 3MF with several plates keeps Orca's layout: its first plate lands on
   ours, the others are set beside it, and what is off the plate is not
   sliced. */

const PR = {
  objects: [],
  sel: new Set(),
  /* How colours get their heads: "object" (each object chooses, under its
     row) or "colour" (the plate's colours are assigned once for every
     object, above the list, as Snapmaker Orca does). Starts from the
     Settings default; never kept per file. */
  assoc: "object",
  /* "colour" mode: colour → head, null while unchosen (blocks the slice). */
  colourHeads: {},
  nextId: 1,
  bed: { w: 270, d: 270, model: "Snapmaker U1" },
  gl: null,
  prog: null,
  line: null,
  grid: null,
  /* Bed plate and logo (buildBed), null for an unknown model. */
  plate: null,
  /* Loaded meshes, by file and rank: { vao, count, pos, hull, n } */
  meshes: new Map(),
  cam: { yaw: -0.62, pitch: 0.7, dist: 460, target: [135, 135, 0] },
  drag: null,
  raf: 0,
  framed: false,
  /* Objects whose colors are folded in the list. */
  fold: new Set(),
  /* Supports hint (support_hint.rs), by plHintKey; keys being asked. */
  hints: new Map(),
  hintAsk: new Set(),
  /* Objects the badge names, and whether it is hovered (they are outlined). */
  hintIds: new Set(),
  hintHover: false,
  /* Overhang view, and the angle it colors with (the hint's). */
  overhangs: false,
  overAngle: null,
};

/* Live colors: each vertex carries its model extruder (aExt); when that
   extruder goes to a head holding a spool, the spool's color replaces the
   file's. An empty or unknown head keeps the file's color. */
const PREP_VS = MESH_VS.replace("in vec3 aCol;", "in vec3 aCol;\nin float aExt;\nuniform vec3 uHeadCol[17];\nuniform float uHeadOn[17];")
  .replace("vCol = aCol;", "int e = clamp(int(aExt + 0.5), 0, 16);\n  vCol = uHeadOn[e] > 0.5 ? uHeadCol[e] : aCol;")
  .replace("out vec3 vPosV;", "out vec3 vPosV;\nout vec3 vPosW;\nuniform mat4 uModel;")
  .replace("vPosV = (uMV * vec4(aPos, 1.0)).xyz;", "vPosV = (uMV * vec4(aPos, 1.0)).xyz;\n  vPosW = (uModel * vec4(aPos, 1.0)).xyz;");
/* Overhang view (uOver 1): faces pointing down more than the profile's
   angle, above the first layer, in red. Seen from above, an underside is
   hidden: a second pass (uOver 2) draws the
   hidden ones only, hatched, through what covers them; the winding tells
   their outward side (uFlip: a mirroring scale). */
const PREP_FS = MESH_FS.replace("in vec3 vPosV;", "in vec3 vPosV;\nin vec3 vPosW;")
  .replace("out vec4 frag;", "uniform vec4 uTint;\nuniform float uAlpha;\nuniform float uOver;\nuniform float uOverCos;\nuniform float uFlip;\nuniform vec3 uOverCol;\nuniform vec3 uEye;\nout vec4 frag;")
  .replace(
    "frag = vec4(c, 1.0);",
    `if (uOver > 0.5) {
    vec3 nw = normalize(cross(dFdx(vPosW), dFdy(vPosW)));
    if (dot(nw, uEye - vPosW) < 0.0) nw = -nw;
    if (uOver > 1.5 && gl_FrontFacing == (uFlip > 0.5)) nw = -nw;
    bool over = -nw.z >= uOverCos && vPosW.z > 0.25;
    if (uOver > 1.5) {
      // Hatched: seen through, not on the visible surface.
      if (!over || mod(gl_FragCoord.x + gl_FragCoord.y, 9.0) > 3.0) discard;
      frag = vec4(uOverCol, 0.7);
      return;
    }
    if (over) c = mix(c, uOverCol, 0.75);
  }
  c = mix(c, uTint.rgb, uTint.a);
  frag = vec4(c, uAlpha);`
  );
const FOV = 0.72;

/* Solid-color drawing (rotation rings, hovered facet). */
const SOLID_VS = `#version 300 es
in vec3 aPos;
uniform mat4 uMVP;
void main() { gl_Position = uMVP * vec4(aPos, 1.0); }`;
const SOLID_FS = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 frag;
void main() { frag = uColor; }`;

/* ------------------------------------------------------------ state */

/* An object as stored: placement and choices, never its mesh. */
const prStored = ({ id, name, path, item, piece, pos, rot, scale, size, plate, extruders, heads, pick, cv, free }) => ({
  id, name, path, item, piece, pos, rot, scale, size, plate, extruders, heads, pick, cv, free,
});

function prSave() {
  const objects = PR.objects.map(prStored);
  localStorage.setItem("snapstudio.plate", JSON.stringify({ objects, nextId: PR.nextId, colourHeads: PR.colourHeads, tower: prTowerStored(), smoothMix: vhSmoothOn(PR) }));
  prStatus();
  prPruneMeshes();
  prHintRefresh();
}

/* Smooth mix for the plate's virtual heads (the slice sheet's switch):
   each layer split between the two heads. Kept with the plate. */
function prSetSmoothMix(on) {
  PR.smoothMix = !!on;
  prSave();
  if (typeof slSummary === "function" && !$("smodal").classList.contains("hidden")) slSummary();
}

/* Frees the meshes no object uses any more (removed, cleared, undone):
   their buffers would otherwise stay on the GPU for the session. An object
   brought back by undo loads its mesh again. */
function prPruneMeshes() {
  const used = new Set(PR.objects.map(meshKey));
  for (const [key, m] of PR.meshes) {
    if (used.has(key)) continue;
    if (m.vao && PR.gl) {
      PR.gl.deleteVertexArray(m.vao);
      for (const b of m.bufs || []) PR.gl.deleteBuffer(b);
    }
    PR.meshes.delete(key);
  }
}

/* The objects of a slice (`ids`), kept with the print: a queued print can
   come back to Prepare to be sliced again. */
function prPlateOf(ids) {
  return PR.objects.filter((o) => ids.includes(o.id)).map(prStored);
}

/* A print's plate put back in place of the current one, as one undo step. */
async function prLoadPlate(objects) {
  prRemember();
  PR.objects = objects.map((o) => ({ ...o, id: PR.nextId++ }));
  PR.sel.clear();
  prSave();
  prRenderInspector();
  prSchedule();
  if (PR.gl) await Promise.all(PR.objects.map(prLoadMesh));
  prSchedule();
}

function prLoadState() {
  try {
    const s = JSON.parse(localStorage.getItem("snapstudio.plate") || "null");
    if (s?.objects) {
      PR.objects = s.objects;
      PR.nextId = s.nextId || PR.objects.length + 1;
      PR.colourHeads = s.colourHeads && typeof s.colourHeads === "object" ? s.colourHeads : {};
      // Read by prepare-tower.js (prTowerRestore).
      PR.tower = s.tower;
      // Smooth mix (virtual heads): on unless the plate says otherwise.
      PR.smoothMix = vhSmoothOn(s);
    }
  } catch {}
  // The mode is the Settings default at each start, never the file's.
  PR.assoc = PRUI.assocDefault;
}

/* ------------------------------------------------------------ history */

/* Undo / redo: successive plate states (placements and object list, the
   prime tower's place, its pillars' places and their groups, never the
   meshes), 100 levels. */
const HIST = { undo: [], redo: [] };
const prSnap = () =>
  JSON.stringify({
    objects: PR.objects,
    tower: { x: PR.tower?.x ?? null, y: PR.tower?.y ?? null, rot: PR.tower?.rot || 0, row: PR.tower?.row || { rot: 0 }, groups: PR.tower?.groups || {}, pillars: PR.tower?.pillars || {} },
  });

/* A state back: its objects, and its towers' places (the tower's switch
   and its kind are settings, not undone). */
function prUnsnap(snapshot) {
  const s = JSON.parse(snapshot);
  PR.objects = Array.isArray(s) ? s : s.objects;
  if (s.tower && PR.tower) Object.assign(PR.tower, s.tower);
}

/* Call right before a change. */
function prRemember(snapshot = prSnap()) {
  if (HIST.undo[HIST.undo.length - 1] === snapshot) return;
  HIST.undo.push(snapshot);
  if (HIST.undo.length > 100) HIST.undo.shift();
  HIST.redo = [];
}

function prRestore(from, to) {
  if (!from.length) return;
  to.push(prSnap());
  prUnsnap(from.pop());
  PR.sel = new Set([...PR.sel].filter((id) => PR.objects.some((o) => o.id === id)));
  prSave();
  prRenderInspector();
  prSchedule();
  if (PR.gl) Promise.all(PR.objects.map(prLoadMesh)).then(prSchedule);
}
const prUndo = () => prRestore(HIST.undo, HIST.redo);
const prRedo = () => prRestore(HIST.redo, HIST.undo);

const meshKey = (o) => `${o.path}#${o.item}${o.piece != null ? "#" + o.piece : ""}`;
const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;

/* Rz · Ry · Rx, like `plate::rotation` in Rust. */
function rotation(rot) {
  const [a, b, c] = rot.map(rad);
  const [sa, ca, sb, cb, sc, cc] = [Math.sin(a), Math.cos(a), Math.sin(b), Math.cos(b), Math.sin(c), Math.cos(c)];
  return [
    [cc * cb, cc * sb * sa - sc * ca, cc * sb * ca + sc * sa],
    [sc * cb, sc * sb * sa + cc * ca, sc * sb * ca - cc * sa],
    [-sb, cb * sa, cb * ca],
  ];
}

const applyRS = (r, s, v) => {
  const p = [v[0] * s[0], v[1] * s[1], v[2] * s[2]];
  return [
    r[0][0] * p[0] + r[0][1] * p[1] + r[0][2] * p[2],
    r[1][0] * p[0] + r[1][1] * p[1] + r[1][2] * p[2],
    r[2][0] * p[0] + r[2][1] * p[1] + r[2][2] * p[2],
  ];
};

/* Corners of the object's box (own frame, centered). */
function corners(o) {
  const [x, y, z] = o.size.map((v) => v / 2);
  const out = [];
  for (const i of [-x, x]) for (const j of [-y, y]) for (const k of [-z, z]) out.push([i, j, k]);
  return out;
}

/* Object hull rotated and scaled: lowest and highest point, and footprint
   seen from above (relative to the center). Exact whatever the tilt;
   without a hull, the box corners. Cached per orientation, the hull only
   has a few hundred vertices. */
const SHAPES = new Map();
function shape(o) {
  const mesh = PR.meshes.get(meshKey(o));
  const pts = mesh?.hullPts?.length ? mesh.hullPts : corners(o);
  const key = `${meshKey(o)}|${o.rot}|${o.scale}|${pts.length}`;
  let sh = SHAPES.get(key);
  if (sh) return sh;
  const r = rotation(o.rot);
  let zmin = Infinity, zmax = -Infinity;
  const xy = [];
  for (const p of pts) {
    const w = applyRS(r, o.scale, p);
    zmin = Math.min(zmin, w[2]);
    zmax = Math.max(zmax, w[2]);
    xy.push([w[0], w[1]]);
  }
  sh = { r, zmin, zmax, foot: convexHull(xy) };
  if (SHAPES.size > 500) SHAPES.clear();
  SHAPES.set(key, sh);
  return sh;
}

/* Full placement: rotation-scale, and the translation that rests the object. */
function placement(o) {
  const { r, zmin } = shape(o);
  return { r, t: [o.pos[0], o.pos[1], -zmin] };
}

/* Model matrix (columns, like m4). */
function modelMatrix(o) {
  const { r, t } = placement(o);
  const s = o.scale;
  const m = new Float32Array(16);
  for (let c = 0; c < 3; c++) for (let row = 0; row < 3; row++) m[c * 4 + row] = r[row][c] * s[c];
  m[12] = t[0];
  m[13] = t[1];
  m[14] = t[2];
  m[15] = 1;
  return m;
}

/* Footprint seen from above, on the bed. */
function footprint(o) {
  return shape(o).foot.map((p) => [p[0] + o.pos[0], p[1] + o.pos[1]]);
}

/* Height of the rested object, and center of its box in the scene. */
function worldCenter(o) {
  const sh = shape(o);
  return [o.pos[0], o.pos[1], (sh.zmax - sh.zmin) / 2];
}

/* On the bed: "in", "partial" (sticks out) or "out" (beside it). */
const bedState = (o) => plBedState(footprint(o), PR.bed);

/* Ordered convex footprint (for overlap tests). */
const footprintPoly = (o) => convexHull(footprint(o));

function convexHull(points) {
  const pts = points.map((p) => [p[0], p[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/* Do two convex polygons overlap? (separating axes) */
function polysOverlap(a, b) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const n = [q[1] - p[1], p[0] - q[0]];
      const proj = (P) => P.map((v) => v[0] * n[0] + v[1] * n[1]);
      const pa = proj(a), pb = proj(b);
      // A clean contact (less than 0.2 mm overlap) does not count.
      const len = Math.hypot(n[0], n[1]) || 1;
      if (Math.max(...pa) <= Math.min(...pb) + 0.2 * len || Math.max(...pb) <= Math.min(...pa) + 0.2 * len) return false;
    }
  }
  return true;
}

/* Objects overlapping another on the plate, as Orca flags them, or the
   prime tower ("tower" with them). */
function prOverlaps() {
  const on = PR.objects.filter((o) => bedState(o) !== "out").map((o) => ({ o, poly: footprintPoly(o) }));
  const hit = new Set();
  for (let i = 0; i < on.length; i++) {
    for (let j = i + 1; j < on.length; j++) {
      if (polysOverlap(on[i].poly, on[j].poly)) {
        hit.add(on[i].o.id);
        hit.add(on[j].o.id);
      }
    }
  }
  for (const t of typeof prTowerChecks === "function" ? prTowerChecks() : []) if (t.check.hits.length) for (const id of ["tower", ...t.check.hits]) hit.add(id);
  return hit;
}


/* ------------------------------------------------------------ render */

function prEnsureGL() {
  if (PR.gl) return true;
  const gl = $("p-canvas").getContext("webgl2", { antialias: true, depth: true });
  if (!gl) {
    $("p-msg").textContent = tr("viewer.no_webgl");
    $("p-msg").classList.remove("hidden");
    return false;
  }
  PR.gl = gl;
  PR.prog = program(gl, PREP_VS, PREP_FS);
  PR.line = program(gl, LINE_VS, LINE_FS);
  PR.solid = program(gl, SOLID_VS, SOLID_FS);
  PR.grid = buildGrid(gl, PR.bed.w, PR.bed.d);
  PR.plate = buildBed(gl, PR.bed.w, PR.bed.d, PR.bed.model, prSchedule);
  prBindInteractions($("p-canvas"));
  return true;
}

/* Loading feedback over the plate: the file being read, then its objects
   one by one. A dense 3MF takes a while; the plate says so. */
const PRL = { reading: [], total: 0, done: 0 };
function prLoadingShow() {
  const busy = PRL.reading.length > 0 || PRL.total > PRL.done;
  $("p-loading").classList.toggle("hidden", !busy);
  if (!busy) {
    PRL.total = PRL.done = 0;
    return;
  }
  $("p-loading-text").textContent = PRL.reading.length
    ? tr("prepare.loading.file", { name: PRL.reading[0] })
    : tr("prepare.loading.objects", { done: PRL.done, n: PRL.total });
}

/* An object's mesh, loaded once (copies share it), counted in the plate's
   loading feedback. */
async function prLoadMesh(o) {
  if (PR.meshes.has(meshKey(o))) return PR.meshes.get(meshKey(o));
  PRL.total++;
  prLoadingShow();
  try {
    return await prLoadMeshNow(o);
  } finally {
    PRL.done++;
    prLoadingShow();
  }
}

async function prLoadMeshNow(o) {
  const key = meshKey(o);
  const had = PR.meshes.get(key);
  // A read that failed is tried again after a moment: a passing error
  // must not leave the object invisible (yet selectable) for the session.
  if (had && !(had.failed && Date.now() - had.at > 5000)) return had;
  const entry = { loading: true };
  PR.meshes.set(key, entry);
  const q = `/b?p=${encodeURIComponent(o.path)}&i=${o.item}${o.piece != null ? "&c=" + o.piece : ""}&b=400000`;
  let buf = null, err = null;
  try {
    buf = await fetchScheme("mesh", q);
  } catch (e) {
    err = e;
  }
  if (!buf) {
    PR.meshes.set(key, { failed: String(err?.message || err), at: Date.now() });
    toast(tr("prepare.bad_mesh", { name: o.name }), true);
    return null;
  }
  // Pruned meanwhile (its object removed), or loaded again (undo): the
  // entry now in the cache, if any, is the one to use.
  if (PR.meshes.get(key) !== entry) return PR.meshes.get(key) || null;
  const data = decodeMesh(buf);
  const gl = PR.gl;
  const bufs = [];
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const pb = gl.createBuffer();
  bufs.push(pb);
  gl.bindBuffer(gl.ARRAY_BUFFER, pb);
  gl.bufferData(gl.ARRAY_BUFFER, data.pos, gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(PR.prog, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
  const cb = gl.createBuffer();
  bufs.push(cb);
  gl.bindBuffer(gl.ARRAY_BUFFER, cb);
  gl.bufferData(gl.ARRAY_BUFFER, data.col, gl.STATIC_DRAW);
  const aCol = gl.getAttribLocation(PR.prog, "aCol");
  gl.enableVertexAttribArray(aCol);
  gl.vertexAttribPointer(aCol, 3, gl.UNSIGNED_BYTE, true, 0, 0);
  const aExt = gl.getAttribLocation(PR.prog, "aExt");
  if (data.ext && aExt >= 0) {
    const eb = gl.createBuffer();
    bufs.push(eb);
    gl.bindBuffer(gl.ARRAY_BUFFER, eb);
    gl.bufferData(gl.ARRAY_BUFFER, data.ext, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(aExt);
    gl.vertexAttribPointer(aExt, 1, gl.UNSIGNED_BYTE, false, 0, 0);
  }
  gl.bindVertexArray(null);
  // The extruder of each vertex and whether the mesh was simplified: each
  // colour's top, for the pillars' heights (prepare-pillars.js).
  Object.assign(entry, { loading: false, vao, bufs, count: data.n * 3, n: data.n, pos: data.pos, hasExt: !!data.ext, ext: data.ext, truncated: !!data.truncated });
  PR.meshes.set(key, entry);
  // Convex hull: exact resting, footprint, "lay on face".
  invoke("plate_hull", { path: o.path, item: o.item, piece: o.piece ?? null })
    .then((h) => {
      entry.hullPts = h.points;
      entry.hullFaces = h.faces;
      SHAPES.clear();
      prRenderInspector();
      prSchedule();
    })
    // No hull: the box stands in for resting, footprint and "lay on face"
    // (the face tool says so when it finds nothing to work with).
    .catch((e) => {
      entry.hullErr = String(e?.message || e);
      console.warn("hull:", o.name, entry.hullErr);
    });
  return entry;
}

function prCamera(w, h) {
  const c = PR.cam;
  const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
  const eye = add3(c.target, [c.dist * cp * Math.sin(c.yaw), -c.dist * cp * Math.cos(c.yaw), c.dist * sp]);
  const view = m4.lookAt(eye, c.target, [0, 0, 1]);
  const proj = m4.perspective(FOV, Math.max(w / Math.max(h, 1), 0.01), Math.max(c.dist / 100, 0.5), c.dist * 12 + 4000);
  return { eye, view, proj };
}

function prDraw() {
  const gl = PR.gl;
  if (!gl) return;
  const canvas = gl.canvas;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (!w || !h) return;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  gl.viewport(0, 0, w, h);
  const light = !isDark();
  gl.clearColor(...prClearColor(), 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  const { eye, view, proj } = prCamera(w, h);
  const vp = m4.mul(proj, view);

  // From under the plate, the plate goes: the parts' undersides show.
  if (eye[2] >= 0) drawBed(gl, PR.plate, PR.grid, vp, view, light);
  // Off-plate objects and selection box: translucent.
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  // Objects: red when sticking out, grey and faded when beside the plate
  // (not sliced), tinted
  // with the accent color when selected.
  const accent = accentRgb();
  gl.useProgram(PR.prog);
  const uMVP = gl.getUniformLocation(PR.prog, "uMVP"), uMV = gl.getUniformLocation(PR.prog, "uMV");
  const uTint = gl.getUniformLocation(PR.prog, "uTint"), uAlpha = gl.getUniformLocation(PR.prog, "uAlpha");
  const uModel = gl.getUniformLocation(PR.prog, "uModel"), uOver = gl.getUniformLocation(PR.prog, "uOver");
  const uFlip = gl.getUniformLocation(PR.prog, "uFlip");
  gl.uniform1f(gl.getUniformLocation(PR.prog, "uOverCos"), Math.cos(rad(PR.overAngle ?? 30)));
  gl.uniform3fv(gl.getUniformLocation(PR.prog, "uOverCol"), prTok("--danger", [1, 0.23, 0.19]));
  gl.uniform3fv(gl.getUniformLocation(PR.prog, "uEye"), eye);
  gl.uniform1f(uOver, PR.overhangs ? 1 : 0);
  const boxes = [];
  const overlap = prOverlaps();
  for (const o of PR.objects) {
    const mesh = PR.meshes.get(meshKey(o));
    if (!mesh?.vao) continue;
    const model = modelMatrix(o);
    const st = bedState(o);
    const selected = PR.sel.has(o.id);
    gl.uniformMatrix4fv(uMVP, false, m4.mul(vp, model));
    gl.uniformMatrix4fv(uMV, false, m4.mul(view, model));
    gl.uniformMatrix4fv(uModel, false, model);
    const tint =
      st === "partial" ? [...prTok("--danger", [1, 0.23, 0.19]), 0.45]
      : selected ? [...accent, 0.28]
      : overlap.has(o.id) ? [...prTok("--warning", [1, 0.58, 0]), 0.4]
      : st === "out" ? [0.56, 0.56, 0.58, 0.55]
      : [0, 0, 0, 0];
    gl.uniform4fv(uTint, tint);
    gl.uniform1f(uAlpha, st === "out" ? 0.45 : 1);
    prHeadColors(gl, o, mesh);
    gl.bindVertexArray(mesh.vao);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
    if (selected) boxes.push(o);
  }
  // Overhang view: the undersides hidden behind the parts (those farther
  // than what is drawn), hatched, over them.
  if (PR.overhangs) {
    gl.uniform1f(uOver, 2);
    gl.depthMask(false);
    gl.depthFunc(gl.GREATER);
    for (const o of PR.objects) {
      const mesh = PR.meshes.get(meshKey(o));
      if (!mesh?.vao || bedState(o) === "out") continue;
      const model = modelMatrix(o);
      gl.uniformMatrix4fv(uMVP, false, m4.mul(vp, model));
      gl.uniformMatrix4fv(uMV, false, m4.mul(view, model));
      gl.uniformMatrix4fv(uModel, false, model);
      gl.uniform1f(uFlip, o.scale[0] * o.scale[1] * o.scale[2] < 0 ? 1 : 0);
      gl.bindVertexArray(mesh.vao);
      gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
    }
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
  }

  // Selection box; the supports badge hovered outlines the objects it names.
  prDrawBoxes(gl, vp, boxes, accent);
  if (PR.hintHover) prDrawBoxes(gl, vp, PR.objects.filter((o) => PR.hintIds.has(o.id)), prTok("--warning", [1, 0.58, 0]));
  // The prime tower: translucent, after the parts.
  prTowerDraw(gl, vp, accent);
  // Rotate tool: three rings (ribbons) around the selection, always visible;
  // the hovered or grabbed ring thickens and lightens.
  const f = PR.tool === "rotate" ? ringFrame() : null;
  if (f) {
    gl.disable(gl.DEPTH_TEST);
    const active = PR.drag?.mode === "ring" ? PR.drag.axis : PR.hoverRing;
    AXES.forEach((a, k) => {
      const u = Math.abs(a[2]) > 0.5 ? [1, 0, 0] : [0, 0, 1];
      const v = cross3(a, u);
      const w = Math.max(1, f.r * 0.05) * (k === active ? 1.7 : 1);
      const pts = [];
      const n = 128;
      for (let i = 0; i <= n; i++) {
        const th = (i / n) * Math.PI * 2;
        const dir = add3(u.map((x) => x * Math.cos(th)), v.map((x) => x * Math.sin(th)));
        pts.push(...add3(f.c, dir.map((x) => x * (f.r - w / 2))), ...add3(f.c, dir.map((x) => x * (f.r + w / 2))));
      }
      const col = AXIS_COLORS[k].map((x) => (k === active ? x + (1 - x) * 0.35 : x));
      drawSolid(gl, vp, pts, [...col, 0.9], gl.TRIANGLE_STRIP);
    });
    gl.enable(gl.DEPTH_TEST);
  }

  // Lay on face: hovered facet highlighted.
  if (PR.tool === "face" && PR.hoverFace) {
    const { o, faces } = PR.hoverFace;
    const mesh = PR.meshes.get(meshKey(o));
    const { r, t } = placement(o);
    const pts = [];
    for (const fc of faces) for (const i of fc) pts.push(...add3(applyRS(r, o.scale, mesh.hullPts[i]), t));
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-2, -2);
    drawSolid(gl, vp, pts, [...accent, 0.6], gl.TRIANGLES);
    gl.disable(gl.POLYGON_OFFSET_FILL);
  }
  gl.disable(gl.BLEND);
  gl.bindVertexArray(null);
}

/* Boxes around objects, in one color: the selection, the objects the
   supports badge names. */
function prDrawBoxes(gl, vp, list, color) {
  if (!list.length) return;
  const pts = [];
  for (const o of list) {
    const { r, t } = placement(o);
    // Box slightly bigger than the object: its edges must not merge with the
    // surface, which the depth test would favor.
    const grow = (p, k) => p + Math.sign(p) * Math.max(0.6, Math.abs(o.size[k]) * 0.02) / Math.abs(o.scale[k] || 1);
    const c = corners(o).map((p) => add3(applyRS(r, o.scale, p.map(grow)), t));
    for (const [a, b] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]) {
      pts.push(...c[a], ...c[b]);
    }
  }
  const buf = gl.createBuffer();
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.STREAM_DRAW);
  const aPos = gl.getAttribLocation(PR.line, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
  gl.vertexAttrib1f(gl.getAttribLocation(PR.line, "aMain"), 1);
  gl.useProgram(PR.line);
  gl.uniformMatrix4fv(gl.getUniformLocation(PR.line, "uMVP"), false, vp);
  gl.uniform3fv(gl.getUniformLocation(PR.line, "uColor"), color);
  gl.drawArrays(gl.LINES, 0, pts.length / 3);
  gl.deleteVertexArray(vao);
  gl.deleteBuffer(buf);
}

/* One-off drawing of a single-color shape (with transparency). */
function drawSolid(gl, vp, pts, rgba, mode) {
  const buf = gl.createBuffer();
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.STREAM_DRAW);
  const aPos = gl.getAttribLocation(PR.solid, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
  gl.useProgram(PR.solid);
  gl.uniformMatrix4fv(gl.getUniformLocation(PR.solid, "uMVP"), false, vp);
  gl.uniform4fv(gl.getUniformLocation(PR.solid, "uColor"), rgba);
  gl.drawArrays(mode, 0, pts.length / 3);
  gl.bindVertexArray(null);
  gl.deleteVertexArray(vao);
  gl.deleteBuffer(buf);
}


const prSchedule = () => {
  if (PR.raf) return;
  PR.raf = requestAnimationFrame(() => {
    PR.raf = 0;
    prDraw();
  });
};
/* Theme colors the 3D view draws with, as 0-1 components: its
   background, and the states (sticking out, overlapping) — the
   colour-blind theme changes those. */
let PR_TOK = {};
function prTok(name, fallback) {
  if (!PR_TOK[name]) {
    const m = cssColor(`var(${name})`).match(/[\d.]+/g) || [];
    PR_TOK[name] = m.length >= 3 ? m.slice(0, 3).map((x) => +x / 255) : fallback;
  }
  return PR_TOK[name];
}
const prClearColor = () => prTok("--viewport-bg", [0.953, 0.953, 0.961]);
window.addEventListener("themechange", () => {
  PR_TOK = {};
  prSchedule();
});
addEventListener("resize", () => window.currentView === "prepare" && prSchedule());

/* Resolved accent color (AccentColor included), as 0–1 components. */
function accentRgb() {
  const probe = document.createElement("i");
  probe.style.color = "var(--accent)";
  document.body.appendChild(probe);
  const m = getComputedStyle(probe).color.match(/[\d.]+/g) || [0, 122, 255];
  probe.remove();
  return [m[0] / 255, m[1] / 255, m[2] / 255];
}

function prFrame() {
  const { w, d } = PR.bed;
  PR.cam = { yaw: -0.62, pitch: 0.7, dist: Math.max(w, d) * 2.1, target: [w / 2, d / 2, 0] };
  prSchedule();
}

/* ------------------------------------------------------------ selection */

/* Ray from the eye towards the pixel aimed at. */
function prRay(e) {
  const canvas = $("p-canvas");
  const rect = canvas.getBoundingClientRect();
  const { eye } = prCamera(rect.width, rect.height);
  const f = norm3(sub3(PR.cam.target, eye));
  const right = norm3(cross3(f, [0, 0, 1]));
  const up = cross3(right, f);
  const t = Math.tan(FOV / 2);
  const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const y = 1 - ((e.clientY - rect.top) / rect.height) * 2;
  const aspect = rect.width / Math.max(rect.height, 1);
  const dir = norm3([
    f[0] + right[0] * x * t * aspect + up[0] * y * t,
    f[1] + right[1] * x * t * aspect + up[1] * y * t,
    f[2] + right[2] * x * t * aspect + up[2] * y * t,
  ]);
  return { o: eye, d: dir };
}

/* Point of the Z = 0 plane under the cursor. */
function prBedPoint(e) {
  const { o, d } = prRay(e);
  if (Math.abs(d[2]) < 1e-6) return null;
  const t = -o[2] / d[2];
  return t > 0 ? [o[0] + d[0] * t, o[1] + d[1] * t] : null;
}

/* Object hit by the ray: box, then triangles when the mesh is reasonable.
   Returns the object closest to the eye. */
const prPick = (e) => prPickDist(e)?.o || null;

/* The same, with its distance from the eye: { o, dist }, or null. */
function prPickDist(e) {
  const ray = prRay(e);
  let best = null, bestT = Infinity;
  for (const o of PR.objects) {
    const { r, t } = placement(o);
    // Ray brought into the own frame: Rᵀ, then divided by the scale.
    const toLocal = (v, isPoint) => {
      const p = isPoint ? sub3(v, t) : v;
      const q = [
        r[0][0] * p[0] + r[1][0] * p[1] + r[2][0] * p[2],
        r[0][1] * p[0] + r[1][1] * p[1] + r[2][1] * p[2],
        r[0][2] * p[0] + r[1][2] * p[1] + r[2][2] * p[2],
      ];
      return [q[0] / o.scale[0], q[1] / o.scale[1], q[2] / o.scale[2]];
    };
    const lo = toLocal(ray.o, true), ld = toLocal(ray.d, false);
    const half = o.size.map((v) => v / 2);
    let t0 = -Infinity, t1 = Infinity;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(ld[k]) < 1e-12) {
        if (lo[k] < -half[k] || lo[k] > half[k]) t0 = Infinity;
        continue;
      }
      const a = (-half[k] - lo[k]) / ld[k], b = (half[k] - lo[k]) / ld[k];
      t0 = Math.max(t0, Math.min(a, b));
      t1 = Math.min(t1, Math.max(a, b));
    }
    if (t0 > t1 || t1 < 0) continue;
    let hit = Math.max(t0, 0);
    const mesh = PR.meshes.get(meshKey(o));
    if (mesh?.pos && mesh.n <= 250000) {
      hit = rayTriangles(lo, ld, mesh.pos);
      if (hit == null) continue;
    }
    // Distance comparable between objects: hit point, brought back to the scene.
    const lp = [lo[0] + ld[0] * hit, lo[1] + ld[1] * hit, lo[2] + ld[2] * hit];
    const wp = add3(applyRS(r, o.scale, lp), t);
    const dist = Math.hypot(...sub3(wp, ray.o));
    if (dist < bestT) {
      bestT = dist;
      best = o;
    }
  }
  return best && { o: best, dist: bestT };
}

/* Möller–Trumbore over all triangles; the closest, or null. */
function rayTriangles(o, d, pos) {
  let best = null;
  for (let i = 0; i < pos.length; i += 9) {
    const e1 = [pos[i + 3] - pos[i], pos[i + 4] - pos[i + 1], pos[i + 5] - pos[i + 2]];
    const e2 = [pos[i + 6] - pos[i], pos[i + 7] - pos[i + 1], pos[i + 8] - pos[i + 2]];
    const p = cross3(d, e2);
    const det = dot3(e1, p);
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const s = [o[0] - pos[i], o[1] - pos[i + 1], o[2] - pos[i + 2]];
    const u = dot3(s, p) * inv;
    if (u < 0 || u > 1) continue;
    const q = cross3(s, e1);
    const v = dot3(d, q) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = dot3(e2, q) * inv;
    if (t > 0 && (best == null || t < best)) best = t;
  }
  return best;
}

function prSelect(ids, toggle) {
  if (ids.length === 1) PR.anchor = ids[0];
  if (ids.length || !toggle) PR.towerSel = false;
  if (toggle) {
    for (const id of ids) PR.sel.has(id) ? PR.sel.delete(id) : PR.sel.add(id);
  } else {
    PR.sel = new Set(ids);
  }
  prRenderInspector();
  prSchedule();
}

/* Screen boxes (canvas pixels) of the objects: their rested volume's
   corners, projected. */
function prScreenBoxes() {
  const rect = $("p-canvas").getBoundingClientRect();
  const { view, proj } = prCamera(rect.width, rect.height);
  const vp = m4.mul(proj, view);
  return PR.objects.map((o) => {
    const sh = shape(o);
    const h = sh.zmax - sh.zmin;
    const pts = footprint(o).flatMap(([x, y]) => [[x, y, 0], [x, y, h]]);
    const b = plScreenBox(vp, pts, rect.width, rect.height);
    return b && { id: o.id, ...b };
  });
}

/* The band follows the pointer; the selection follows the band. */
function prMarquee(d, e) {
  const rect = $("p-canvas").getBoundingClientRect();
  const a = [d.x - rect.left, d.y - rect.top], b = [e.clientX - rect.left, e.clientY - rect.top];
  const m = $("p-marquee");
  m.classList.remove("hidden");
  const box = m.offsetParent?.getBoundingClientRect() || rect;
  m.style.left = Math.min(a[0], b[0]) + rect.left - box.left + "px";
  m.style.top = Math.min(a[1], b[1]) + rect.top - box.top + "px";
  m.style.width = Math.abs(b[0] - a[0]) + "px";
  m.style.height = Math.abs(b[1] - a[1]) + "px";
  const sel = new Set([...d.keep, ...plMarquee(a, b, d.boxes)]);
  if (sel.size === PR.sel.size && [...sel].every((id) => PR.sel.has(id))) return;
  PR.sel = sel;
  PR.towerSel = false;
  prRenderInspector();
  prSchedule();
}

/* ------------------------------------------------------------ mouse */

function prBindInteractions(canvas) {
  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    // macOS fires it on the press: wait for the release, the user may drag.
    if (PR.drag?.mode === "pan") {
      PR.drag.menu = { clientX: e.clientX, clientY: e.clientY };
      return;
    }
    // Ctrl-click is a right click on macOS: not while drawing a band.
    if (PR.drag?.mode === "marquee") return;
    // Elsewhere it comes after the release: not after a drag of the view.
    if (PR.lastPan && Date.now() - PR.lastPan.at < 400 && PR.lastPan.moved) return;
    prObjectMenu(e);
  });

  canvas.addEventListener("mousedown", (e) => {
    e.preventDefault();
    // A click in the scene gives the keyboard back to the view (arrows, A,
    // ⌘Z…): `preventDefault` would otherwise keep it in an inspector field.
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    const pan = e.shiftKey || e.button === 1 || e.button === 2;
    const base = { x: e.clientX, y: e.clientY, moved: false };
    // A right click on an object opens its menu only if the mouse does not
    // move: right or ⇧ drag moves the view everywhere, as in Orca.
    if (!pan && PR.tool === "rotate") {
      const rh = ringHit(e);
      if (rh) {
        const f = ringFrame();
        PR.drag = {
          ...base,
          mode: "ring",
          axis: rh.axis,
          c: f.c,
          v0: sub3(rh.p, f.c),
          orig: f.sel.map((o) => ({ o, R: rotation(o.rot), pos: [...o.pos] })),
          before: prSnap(),
        };
        return;
      }
    }
    if (!pan && PR.tool === "face") {
      const fh = faceHit(e);
      if (fh) {
        prLayOnFace(fh);
        return;
      }
      // Nothing to lay on: say why when an object's hull could not be read
      // (once), rather than a click that does nothing.
      const noHull = PR.objects.map((o) => PR.meshes.get(meshKey(o))).find((m) => m?.hullErr);
      if (noHull && !PR.hullSaid) {
        PR.hullSaid = true;
        toast(tr("prepare.orient_failed", { err: noHull.hullErr }), true);
      }
    }
    if (pan) {
      PR.drag = { ...base, mode: "pan" };
      return;
    }
    const near = prPickDist(e);
    // The prime tower, when nearer than any part: moved, or turned with ⌥
    // (around Z only), like a part. A pillar: moved.
    const pick = prTowerPick(e);
    if (pick && !(near?.dist < pick.dist) && !(e.metaKey || e.ctrlKey) && PR.tool !== "face") {
      prTowerSelect(true, pick.key);
      const start = prBedPoint(e);
      if (typeof pick.key === "string") {
        const c = PR.tower.pillars[pick.key];
        if (!start || !c) return;
        PR.drag = { ...base, mode: "pillar", key: pick.key, start, orig: { x: c.x, y: c.y, moved: !!c.moved }, before: prSnap() };
        return;
      }
      const box = prTowerBox();
      if (!start || !box) return;
      const c = ptCorners(PR.tower, box);
      PR.drag = {
        ...base,
        mode: e.altKey ? "tower-rot" : "tower",
        start,
        center: [(c[0][0] + c[2][0]) / 2, (c[0][1] + c[2][1]) / 2],
        orig: { x: PR.tower.x, y: PR.tower.y, rot: PR.tower.rot || 0 },
        box,
        before: prSnap(),
      };
      return;
    }
    const hit = near?.o || null;
    // ⌘/Ctrl dragged from an empty spot: a rubber band, adding what it
    // touches to the selection (⇧ already moves the view, ⌥ rotates).
    if (!hit && (e.metaKey || e.ctrlKey) && e.button === 0) {
      PR.drag = { ...base, mode: "marquee", keep: new Set(PR.sel), boxes: prScreenBoxes() };
      return;
    }
    if (!hit) {
      PR.drag = { ...base, mode: "orbit", clear: true };
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      prSelect([hit.id], true);
    } else if (!PR.sel.has(hit.id)) {
      prSelect([hit.id], false);
    }
    const start = prBedPoint(e);
    if (!start || !PR.sel.has(hit.id)) return;
    const moving = PR.objects.filter((o) => PR.sel.has(o.id));
    PR.drag = {
      ...base,
      mode: e.altKey ? "rotate" : "move",
      // A plain click (no drag) on an object of a multiple selection keeps
      // only it, as in the Finder; dragging moves the group.
      only: e.metaKey || e.ctrlKey ? null : hit.id,
      start,
      center: [...hit.pos],
      orig: moving.map((o) => ({ o, pos: [...o.pos], rz: o.rot[2] })),
      before: prSnap(),
    };
  });
  addEventListener("mousemove", (e) => {
    const d = PR.drag;
    if (!d || window.currentView !== "prepare") return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
    if (d.mode === "marquee") {
      if (d.moved) prMarquee(d, e);
      return;
    }
    if (d.mode === "pan" || d.mode === "orbit") {
      d.x = e.clientX;
      d.y = e.clientY;
      if (d.mode === "pan") prPan(dx, dy);
      else {
        PR.cam.yaw -= dx * 0.008;
        PR.cam.pitch = clamp(PR.cam.pitch + dy * 0.008, -1.5, 1.5);
      }
      prSchedule();
      return;
    }
    if (d.mode === "ring") {
      if (!d.moved) return;
      const a = AXES[d.axis];
      const q = rayPlane(prRay(e), a, d.c);
      if (!q) return;
      if (!d.remembered) {
        prRemember(d.before);
        d.remembered = true;
      }
      const v1 = sub3(q, d.c);
      let ang = deg(Math.atan2(dot3(cross3(d.v0, v1), a), dot3(d.v0, v1)));
      if (e.shiftKey) ang = Math.round(ang / 15) * 15;
      const R = axisAngle(a, rad(ang));
      for (const { o, R: r0, pos } of d.orig) {
        o.rot = eulerOf(mat3mul(R, r0));
        // A group rotates around its common center.
        const rel = [pos[0] - d.c[0], pos[1] - d.c[1], 0];
        const w = [0, 1].map((i) => R[i][0] * rel[0] + R[i][1] * rel[1] + R[i][2] * rel[2]);
        o.pos = [d.c[0] + w[0], d.c[1] + w[1]];
      }
      const lab = $("p-angle"), rect = $("p-canvas").getBoundingClientRect();
      lab.textContent = `${ang > 0 ? "+" : ""}${Math.round(ang * 10) / 10}°`;
      lab.style.left = e.clientX - rect.left + "px";
      lab.style.top = e.clientY - rect.top + "px";
      lab.classList.remove("hidden");
      prRenderProps();
      prSchedule();
      return;
    }
    if (d.mode === "tower" || d.mode === "tower-rot") {
      const p = prBedPoint(e);
      if (!p || !d.moved) return;
      if (!d.remembered) {
        prRemember(d.before);
        d.remembered = true;
      }
      Object.assign(PR.tower, d.orig);
      if (d.mode === "tower") prTowerMove(p[0] - d.start[0], p[1] - d.start[1]);
      else {
        let delta = deg(Math.atan2(p[1] - d.center[1], p[0] - d.center[0]) - Math.atan2(d.start[1] - d.center[1], d.start[0] - d.center[0]));
        if (e.shiftKey) delta = Math.round(delta / 15) * 15;
        prTowerTurn(d.orig.rot + delta, d.box);
      }
      prTowerRenderProps();
      prSchedule();
      return;
    }
    if (d.mode === "pillar") {
      const p = prBedPoint(e);
      if (!p || !d.moved) return;
      if (!d.remembered) {
        prRemember(d.before);
        d.remembered = true;
      }
      Object.assign(PR.tower.pillars[d.key], d.orig);
      prPillarMove(d.key, p[0] - d.start[0], p[1] - d.start[1]);
      prTowerRenderProps();
      prSchedule();
      return;
    }
    if (d.mode === "move" && d.moved) {
      $("p-objects").classList.add("dragging");
      prDropHover(e);
    }
    const p = prBedPoint(e);
    if (!p || !d.moved) return;
    if (!d.remembered) {
      prRemember(d.before);
      d.remembered = true;
    }
    if (d.mode === "move") {
      for (const { o, pos } of d.orig) o.pos = [pos[0] + p[0] - d.start[0], pos[1] + p[1] - d.start[1]];
    } else {
      const a0 = Math.atan2(d.start[1] - d.center[1], d.start[0] - d.center[0]);
      const a1 = Math.atan2(p[1] - d.center[1], p[0] - d.center[0]);
      let delta = deg(a1 - a0);
      // ⇧: 15° steps, as in Orca.
      if (e.shiftKey) delta = Math.round(delta / 15) * 15;
      for (const { o, rz } of d.orig) o.rot = [o.rot[0], o.rot[1], normDeg(rz + delta)];
    }
    prRenderProps();
    prSchedule();
  });
  addEventListener("mouseup", (e) => {
    const d = PR.drag;
    PR.drag = null;
    if (!d || window.currentView !== "prepare") return;
    // Objects dragged from the plate onto the list's off-plate group are
    // taken off it, within the same undo step as the move.
    if (d.mode === "move" && d.moved) {
      const off = prDropOff(document.elementFromPoint(e.clientX, e.clientY));
      prDropEnd();
      if (off) {
        if (!d.remembered) prRemember(d.before);
        prPark(d.orig.map((x) => x.o).filter((o) => PR.objects.includes(o)));
      }
    }
    if (d.mode === "pan") {
      PR.lastPan = { at: Date.now(), moved: d.moved };
      if (d.menu && !d.moved) prObjectMenu(d.menu);
      return;
    }
    if (d.mode === "marquee") {
      $("p-marquee").classList.add("hidden");
      return;
    }
    if (d.mode === "orbit" && !d.moved && d.clear) prSelect([], false);
    $("p-angle").classList.add("hidden");
    if (["move", "rotate", "ring", "tower", "tower-rot", "pillar"].includes(d.mode) && d.moved) {
      prSave();
      prRenderInspector();
    } else if (d.mode === "move" && !d.moved && d.only != null && PR.sel.size > 1) {
      prSelect([d.only], false);
    }
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const dir = state.invertWheel ? -1 : 1;
      const speed = state.wheelSpeed || 1;
      const pinch = e.ctrlKey;
      // ⇧ + scroll moves the view (a trackpad's ⇧ + two fingers).
      const action = pinch ? "zoom" : e.shiftKey ? "pan" : state.wheelAction || "zoom";
      if (action === "zoom") {
        PR.cam.dist = clamp(PR.cam.dist * Math.exp(e.deltaY * 0.0012 * (pinch ? 1 : dir) * speed), 20, 4000);
      } else if (action === "pan") {
        prPan(-e.deltaX * dir * speed, -e.deltaY * dir * speed);
      } else {
        PR.cam.yaw += e.deltaX * 0.006 * dir * speed;
        PR.cam.pitch = clamp(PR.cam.pitch - e.deltaY * 0.006 * dir * speed, -1.5, 1.5);
      }
      prSchedule();
    },
    { passive: false }
  );
  // Hover: ring or facet highlighted; the prime tower's label.
  canvas.addEventListener("mouseleave", () => prTowerHover(null));
  canvas.addEventListener("mousemove", (e) => {
    prTowerHover(e);
    if (PR.drag) return;
    if (PR.tool === "rotate") {
      const k = ringHit(e)?.axis ?? null;
      if (k !== PR.hoverRing) {
        PR.hoverRing = k;
        prSchedule();
      }
    } else if (PR.tool === "face") {
      PR.hoverFace = faceHit(e);
      prSchedule();
    }
  });
  canvas.addEventListener("dblclick", (e) => {
    if (!prPick(e)) prFrame();
  });
}

const normDeg = (a) => {
  let x = ((a % 360) + 360) % 360;
  if (x > 180) x -= 360;
  return Math.round(x * 100) / 100;
};

/* The context menu of the object under the pointer, if any (or the
   prime tower's). */
function prObjectMenu(e) {
  const near = prPickDist(e), tower = prTowerPick(e);
  if (tower && !(near?.dist < tower.dist)) return prTowerMenu(e.clientX, e.clientY, tower.key);
  const hit = near?.o;
  if (!hit) return;
  prMenuFor(hit.id, e.clientX, e.clientY);
}

/* The object's menu, from the plate or from its row in the list. "Colour…"
   acts on this object (`PR.menuId`): the palette in "by colour" mode ("Change
   Colour…" once it has one), its colour/heads frame in "by object" mode. */
function prMenuFor(id, x, y) {
  if (!PR.sel.has(id)) prSelect([id], false);
  const o = PR.objects.find((ob) => ob.id === id);
  PR.menuId = id;
  PR.menuAt = { x, y };
  const many = PR.sel.size > 1;
  const coloured = PR.assoc === "colour" && o && (o.pick != null || prOwnColours(o).length > 0);
  nativeMenu([
    { id: "prep:dup", label: many ? tr("prepare.menu.dup_many", { n: PR.sel.size }) : tr("prepare.menu.dup") },
    { id: "prep:split", label: tr("prepare.menu.split") },
    { id: "prep:center", label: tr("prepare.menu.center") },
    { id: "prep:resetrot", label: tr("prepare.menu.reset_rot") },
    { id: "prep:orient", label: tr("prepare.menu.orient") },
    { id: "prep:facetool", label: tr("prepare.menu.face") },
    { id: "prep:colour", label: tr(coloured ? "prepare.menu.recolour" : "prepare.menu.colour") },
    {},
    { id: "prep:arrange", label: tr("prepare.menu.arrange") },
    {},
    { id: "prep:del", label: many ? tr("prepare.menu.del_many", { n: PR.sel.size }) : tr("prepare.menu.del") },
  ], x, y);
}

function prPan(dx, dy) {
  const c = PR.cam;
  const right = [Math.cos(c.yaw), Math.sin(c.yaw), 0];
  const up = [-Math.sin(c.yaw) * Math.sin(c.pitch), Math.cos(c.yaw) * Math.sin(c.pitch), Math.cos(c.pitch)];
  const k = c.dist * 0.0016;
  c.target = add3(c.target, [
    (-right[0] * dx + up[0] * dy) * k,
    (-right[1] * dx + up[1] * dy) * k,
    (-right[2] * dx + up[2] * dy) * k,
  ]);
}

/* ------------------------------------------------------------ inspector */

function prStatus() {
  const n = PR.objects.length;
  const g = prGroups();
  const out = n - g.sliced;
  sideCount("prepare", n);
  tbSet("prepare", tr("slice.plate"), n ? tr("prepare.count", { n }) + (out ? " · " + tr("prepare.off_count", { n: out }) : "") : "");
  $("p-empty").classList.toggle("hidden", n > 0);
  // The toolbar shows only what can act on the plate as it is; Save,
  // Clear and Slice stay (on the right: the others come and go on their
  // left without moving them).
  // "By colour" mode: a colour without a head, or an uncoloured object
  // without a picked one, blocks the slice.
  const blockers = prBlockers();
  // The prime tower off the plate: the engine would print it there.
  const towerOut = typeof prTowerBlocks === "function" && prTowerBlocks();
  const blocked = blockers.colours.length + blockers.objects.length + blockers.orphans.length + (towerOut ? 1 : 0);
  const tools = plTools({
    n,
    sel: PR.sel.size,
    onBed: g.on.length,
    sliceable: (g.sliced > 0 || g.partial > 0) && !blocked,
    tool: PR.tool,
    orienting: !!PR.orienting,
    splitting: !!PR.splitting,
    overhangs: PR.overhangs,
  });
  for (const [id, t] of Object.entries(tools)) {
    const b = $(id);
    b.classList.toggle("hidden", !t.show);
    b.disabled = !t.on;
  }
  for (const grp of $("p-slice").parentElement.querySelectorAll(":scope > .tb-group")) {
    grp.classList.toggle("hidden", ![...grp.children].some((b) => !b.classList.contains("hidden")));
  }
  // Only the objects fully on the plate are sliced: the button says how
  // many, and why the others are not.
  const slice = $("p-slice");
  slice.textContent = g.sliced ? tr("prepare.slice_n", { n: g.sliced }) : tr("prepare.slice");
  slice.title = [
    blockers.colours.length ? tr("prepare.tip.unmapped", { n: blockers.colours.length }) : "",
    blockers.objects.length ? tr("prepare.tip.uncoloured", { n: blockers.objects.length }) : "",
    blockers.orphans.length ? tr("prepare.tip.orphan", { n: blockers.orphans.length }) : "",
    g.partial ? tr("prepare.tip.partial", { n: g.partial }) : "",
    towerOut ? tr("prepare.tower.off_plate") : "",
    g.off.length ? tr("prepare.tip.off", { n: g.off.length }) : "",
  ].filter(Boolean).join("\n");
}

/* Object list, floating over the plate: the objects on it (sliced) and,
   apart, dimmed, those beside it (not sliced) with a way back. The list is
   one plate's: with several plates, one such list per plate. */
const PR_ICON = {
  plus: '<svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>',
  minus: '<svg viewBox="0 0 24 24"><path d="M5 11h14v2H5z"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path fill-rule="evenodd" d="M12 2.5 23 21.5H1zM11 9.5v6h2v-6zm0 8v2h2v-2z"/></svg>',
  keys: '<svg viewBox="0 0 24 24"><path fill-rule="evenodd" d="M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1m1 2v8h16V8zm1 1h2v2H5zm3 0h2v2H8zm3 0h2v2h-2zm3 0h2v2h-2zm3 0h2v2h-2zM7 13h10v2H7z"/></svg>',
  slider: '<svg viewBox="0 0 24 24"><path d="M3 11h5.2a3 3 0 0 1 5.6 0H21v2h-7.2a3 3 0 0 1-5.6 0H3z"/></svg>',
  // Three sliders (X, Y, Z) / back to one.
  axes: '<svg viewBox="0 0 24 24"><path d="M3 5h3.2a2.5 2.5 0 0 1 4.6 0H21v2H10.8a2.5 2.5 0 0 1-4.6 0H3zm0 6h9.2a2.5 2.5 0 0 1 4.6 0H21v2h-4.2a2.5 2.5 0 0 1-4.6 0H3zm0 6h5.2a2.5 2.5 0 0 1 4.6 0H21v2h-8.2a2.5 2.5 0 0 1-4.6 0H3z"/></svg>',
};

/* Remembered look of the panels: fields typed rather than slid, list and
   off-plate group open or folded. */
const PRUI_KEY = "snapstudio.prep.ui";
const PRUI = (() => {
  let s = {};
  try {
    s = JSON.parse(localStorage.getItem(PRUI_KEY) || "{}") || {};
  } catch {}
  return {
    typing: new Set(Array.isArray(s.typing) ? s.typing : []),
    listFolded: !!s.listFolded,
    offFolded: !!s.offFolded,
    split: !!s.split,
    /* Settings: the colour → head mode Prepare starts with. */
    assocDefault: s.assocDefault === "colour" ? "colour" : "object",
    /* The modal explaining the two modes was dismissed for good. */
    assocExplained: !!s.assocExplained,
    /* The sheet saying a virtual head goes with its spools, likewise. */
    vhExplained: !!s.vhExplained,
  };
})();
const pruiSave = () =>
  localStorage.setItem(
    PRUI_KEY,
    JSON.stringify({
      typing: [...PRUI.typing],
      listFolded: PRUI.listFolded,
      offFolded: PRUI.offFolded,
      split: PRUI.split,
      assocDefault: PRUI.assocDefault,
      assocExplained: PRUI.assocExplained,
      vhExplained: PRUI.vhExplained,
    })
  );

const prGroups = () => plGroups(PR.objects, bedState);

function prRenderInspector() {
  // The tower may have come (a second head, the switch): it takes a spot.
  prTowerEnsurePlaced();
  if (!prTowerSelValid()) PR.towerSel = false;
  const overlap = prOverlaps();
  const live = typeof headsActive === "function";
  const pid = live ? headsActive() : "";
  const slots = live ? headsSlots(pid) : [];
  const n = live ? headsCount(pid) : 0;
  const row = (o) => {
    const st = bedState(o);
    const tag =
      st === "partial" ? `<span class="tag bad">${esc(tr("prepare.tag.over"))}</span>`
      : st === "out" ? (o.plate > 1 ? `<span class="tag">${esc(tr("prepare.tag.plate", { n: o.plate }))}</span>` : "")
      : overlap.has(o.id) ? `<span class="tag warn">${esc(tr("prepare.tag.overlap"))}</span>`
      : "";
    // "By colour" mode, an on-plate object the 3MF gives no colour: a
    // warning until a head is picked for it (a palette), then a chip
    // showing that head, to change it.
    let pickUi = "";
    if (PR.assoc === "colour" && st !== "out" && (o.pick != null || !prOwnColours(o).length)) {
      if (o.pick == null) {
        pickUi = `<button type="button" class="p-ico p-warn" data-pick="${o.id}" title="${esc(tr("prepare.colour.missing"))}">${PR_ICON.warn}</button>`;
      } else if (vhIs(o.pick)) {
        // A virtual head, or one deleted since: no head until one is chosen.
        const v = vhFind(headsVirtual(pid), o.pick);
        pickUi = v
          ? vhToken({ name: vhName(headsVirtual(pid), o.pick), color: headsColorOf(pid, o.pick), ca: hdSpoolColor(pid, v.a), cb: hdSpoolColor(pid, v.b), tag: "button", cls: " p-chip", attrs: ` type="button" data-pick="${o.id}"`, title: tr("prepare.colour.change_virtual", { name: vhName(headsVirtual(pid), o.pick) }) })
          : `<button type="button" class="p-chip p-choose" data-pick="${o.id}">${esc(tr("prepare.choose_head"))}</button><span class="tag warn">${esc(tr("prepare.no_head"))}</span>`;
      } else {
        const s = slots.find((x) => x.index === o.pick);
        const c = s?.present && s.color ? s.color : "";
        pickUi = `<button type="button" class="p-chip" data-pick="${o.id}" title="${esc(tr("prepare.colour.change", { h: o.pick }))}"><i${c ? ` style="background:${esc(c)}"` : ""}></i>T${o.pick}</button>`;
      }
    }
    // One action per row, on its own object: "+" puts an off-plate object
    // on the plate, "−" takes an on-plate one off; an object sticking out
    // keeps its warning instead.
    const act =
      st === "partial" ? `<button type="button" class="p-ico p-warn" data-fix="${o.id}" title="${esc(tr("prepare.fix.title"))}">${PR_ICON.warn}</button>`
      : st === "out" ? `<button type="button" class="p-ico" data-put="${o.id}" title="${esc(tr("prepare.put"))}">${PR_ICON.plus}</button>`
      : `<button type="button" class="p-ico" data-park="${o.id}" title="${esc(tr("prepare.park"))}">${PR_ICON.minus}</button>`;
    // Heads only apply on the plate: an off-plate row has no colour/heads
    // frame, hence nothing to fold.
    const out = st === "out";
    // No colour/heads frame off the plate, nor in "by colour" mode: the
    // plate's banner holds the choices then.
    const bare = out || PR.assoc === "colour";
    const heads = live && !bare ? prHeads(o, pid, slots, n) : {};
    // A color left without a head (its virtual head deleted) unfolds its
    // row: it has to be chosen again.
    const open = !bare && (!PR.fold.has(o.id) || Object.values(heads).some((x) => x.orphan));
    const dots = [...new Set(Object.values(heads).map((x) => x.h))]
      .map((h) => headsColorOf(pid, h))
      .map((c) => (c ? `<i style="background:${esc(c)}"></i>` : ""))
      .join("");
    const head = `<div class="grow-row p-obj${PR.sel.has(o.id) ? " on" : ""}" data-id="${o.id}" role="button" tabindex="0">
      ${bare ? `<span class="p-tw"></span>` : `<span class="p-tw" data-fold="${o.id}">${open ? "▾" : "▸"}</span>`}
      <span class="k">${esc(o.name)}</span>${tag}${pickUi}<span class="p-dots">${dots}</span>${act}</div>`;
    if (!open || !live) return head;
    const model = headsModelNow(o.path);
    return head + prColors(o).map((ext) => {
      const f = model?.filaments?.find((x) => x.index === ext);
      const cur = heads[ext];
      const label = tr("slice.color_n", { n: ext });
      return `<div class="p-color" title="${esc([label, f?.kind, f?.color].filter(Boolean).join(" · "))}">
        <span class="p-sw" style="background:${esc(f?.color || "#999")}"></span>
        <span class="p-color-lbl">${esc(label)}${cur?.orphan ? ` <span class="tag warn">${esc(tr("prepare.no_head"))}</span>` : ""}</span>
        <span class="p-toks">${prHeadToken(cur?.orphan ? null : cur?.h, { pid, slots, n, own: cur?.own, attrs: ` data-obj="${o.id}" data-ext="${ext}"` })}</span>
      </div>`;
    }).join("");
  };
  const g = prGroups();
  const offOpen = !PRUI.offFolded;
  // The bulk buttons follow the selection: "Add 2 Objects" / "Take 1 Off"
  // when part of a side is selected, "Add All" / "Take All Off" otherwise.
  const onBulk = plBulk(PR.sel, g.on), offBulk = plBulk(PR.sel, g.off);
  const bulk = (b, all, some) => (b.mode === "some" ? tr(some, { n: b.n }) : tr(all));
  $("p-list").innerHTML = `${PR.assoc === "colour" ? prColourBanner(live, slots, n) : ""}
    <div class="p-grp p-on">
      <div class="p-grp-head">
        <span class="k">${esc(tr("prepare.on_bed", { n: g.on.length }))}</span>
        ${g.on.length ? `<button type="button" class="btn" data-parkall title="${esc(bulk(onBulk, "prepare.park_all.title", "prepare.park_n.title"))}">${esc(bulk(onBulk, "prepare.park_all", "prepare.park_n"))}</button>` : ""}
      </div>
      ${g.on.length ? `<div class="group">${g.on.map(row).join("")}</div>` : `<div class="vp-sub">${esc(tr("prepare.nothing"))}</div>`}
    </div>
    <div class="p-grp p-off${g.off.length ? "" : " none"}${offOpen ? "" : " folded"}" data-drop="off">
      <div class="p-grp-head">
        <span class="p-tw" data-offfold>${offOpen ? "▾" : "▸"}</span>
        <span class="k">${esc(tr("prepare.off_bed", { n: g.off.length }))}</span>
        ${g.off.length ? `<button type="button" class="btn" data-putall title="${esc(bulk(offBulk, "prepare.put_all.title", "prepare.put_n.title"))}">${esc(bulk(offBulk, "prepare.put_all", "prepare.put_n"))}</button>` : ""}
      </div>
      ${g.off.length ? `<div class="vp-sub">${esc(tr("prepare.off_note", { n: g.off.length }))}</div>` : ""}
      ${g.off.length ? `<div class="group">${g.off.map(row).join("")}</div>` : ""}
      <div class="p-drop-note">${esc(tr("prepare.drop_off"))}</div>
    </div>`;
  const panel = $("p-objects");
  panel.classList.toggle("hidden", PR.objects.length === 0);
  panel.classList.toggle("folded", PRUI.listFolded);
  // Folded, the list's head takes the objects dropped off the plate.
  if (PRUI.listFolded) $("p-objects-head").dataset.drop = "off";
  else delete $("p-objects-head").dataset.drop;
  const fold = $("p-objects-fold");
  fold.textContent = PRUI.listFolded ? "▸" : "▾";
  fold.title = tr(PRUI.listFolded ? "prepare.list.show" : "prepare.list.hide");
  // The total alone: the selection shows on the rows and the bulk buttons.
  $("p-objects-n").textContent = PR.objects.length ? `(${fmtNum(PR.objects.length)})` : "";
  document.querySelectorAll("#p-assoc [data-assoc]").forEach((b) => {
    b.classList.toggle("on", b.dataset.assoc === PR.assoc);
    b.setAttribute("aria-checked", String(b.dataset.assoc === PR.assoc));
  });
  prRenderPrinter();
  prTowerRenderSwitch();
  prRenderProps();
  prStatus();
}

/* Inspector fields. Each one is a slider (live, one undo step per drag)
   or, on request, a typed value; double-clicking the slider's value types
   it once. */
const PF = {
  "p-x": { kind: "pos", axis: 0, get: (o) => o.pos[0], put: (o, v) => (o.pos = [v, o.pos[1]]) },
  "p-y": { kind: "pos", axis: 1, get: (o) => o.pos[1], put: (o, v) => (o.pos = [o.pos[0], v]) },
  "p-rx": { kind: "rot", get: (o) => o.rot[0], put: (o, v) => (o.rot = [normDeg(v), o.rot[1], o.rot[2]]) },
  "p-ry": { kind: "rot", get: (o) => o.rot[1], put: (o, v) => (o.rot = [o.rot[0], normDeg(v), o.rot[2]]) },
  "p-rz": { kind: "rot", get: (o) => o.rot[2], put: (o, v) => (o.rot = [o.rot[0], o.rot[1], normDeg(v)]) },
  "p-scale": {
    kind: "scale",
    get: (o) => o.scale[0] * 100,
    put: (o, v) => {
      const s = Math.max(1, v) / 100;
      o.scale = [s, s, s];
    },
  },
  "p-sx": { kind: "scale", get: (o) => o.scale[0] * 100, put: (o, v) => (o.scale = [Math.max(1, v) / 100, o.scale[1], o.scale[2]]) },
  "p-sy": { kind: "scale", get: (o) => o.scale[1] * 100, put: (o, v) => (o.scale = [o.scale[0], Math.max(1, v) / 100, o.scale[2]]) },
  "p-sz": { kind: "scale", get: (o) => o.scale[2] * 100, put: (o, v) => (o.scale = [o.scale[0], o.scale[1], Math.max(1, v) / 100]) },
  // The prime tower's (prepare-tower.js): its corner, its turn, and its
  // prime volume — a setting, the slice sheet's, not an undo step. A
  // pillar's (prepare-pillars.js): its center, the row's turn.
  "p-tx": { kind: "pos", axis: 0, tower: true, get: (t) => t.x, put: (t, v) => prTowerMove(v - t.x, 0) },
  "p-ty": { kind: "pos", axis: 1, tower: true, get: (t) => t.y, put: (t, v) => prTowerMove(0, v - t.y) },
  "p-trot": {
    kind: "rot",
    tower: true,
    get: (t) => (t === PR.tower ? t.rot || 0 : PR.tower.row?.rot || 0),
    put: (t, v) => (t === PR.tower ? prTowerTurn(v) : prPillarRowTurn(v)),
  },
  "p-tvol": { kind: "purge", tower: true, setting: true, get: () => prTowerNum("prime_volume", 45), put: (t, v) => prTowerSetVolume(v), lim: () => prTowerVolumeRange() },
};
const pfText = (f, v) => {
  const r = Math.round(v * 10) / 10;
  return f.kind === "pos" || !Number.isInteger(r) ? fmtDec(r, 1) : fmtNum(r);
};

function prRenderProps() {
  // The prime tower selected: its own fields.
  if (prTowerRenderProps()) return;
  const sel = PR.objects.filter((o) => PR.sel.has(o.id));
  // The inspector only shows for one selected object.
  $("p-insp").classList.toggle("hidden", sel.length !== 1);
  $("p-props").classList.toggle("hidden", sel.length !== 1);
  if (sel.length !== 1) return;
  const o = sel[0];
  $("p-insp-name").textContent = o.name;
  $("p-insp-name").title = o.name;
  for (const [id, f] of Object.entries(PF)) if (!f.tower) prRenderField(id, f, f.get(o));
  // Scale: one slider (proportions kept) or three, X, Y, Z, free. Split
  // when asked for (remembered) and always for a scale not uniform.
  const split = plScaleSplit(o.scale, PRUI.split);
  $("p-lock").checked = !split;
  $("p-lock").closest(".group").classList.toggle("locked", !split);
  const sb = $("p-scale-split");
  sb.innerHTML = split ? PR_ICON.slider : PR_ICON.axes;
  sb.classList.toggle("on", split);
  sb.setAttribute("aria-pressed", String(split));
  sb.title = tr(split ? "prepare.scale.join" : "prepare.scale.split");
  sb.setAttribute("aria-label", sb.title);
  // Dimensions of the rested volume (box aligned on the bed axes).
  const sh = shape(o);
  const xs = sh.foot.map((p) => p[0]), ys = sh.foot.map((p) => p[1]);
  const dims = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), sh.zmax - sh.zmin].map((v) => fmtDec(v, 1));
  $("p-dims").textContent = `${dims.join(" × ")} mm${o.plate > 1 ? " · " + tr("prepare.file_plate", { n: o.plate }) : ""}`;
}

/* One inspector field: its slider (bounds, value), its typed value, its
   mode. */
function prRenderField(id, f, v) {
  if (document.activeElement !== f.el) f.el.value = Math.round(v * 10) / 10;
  // Not touched while sliding: the browser would drop the drag.
  if (!f.sliding) {
    const r = plRange(f.kind, PR.bed, f.axis, f.lim?.());
    f.range.min = r.min;
    f.range.max = r.max;
    f.range.step = r.step;
    f.range.value = Math.min(r.max, Math.max(r.min, v));
  }
  f.out.textContent = pfText(f, v);
  const typing = PRUI.typing.has(id) || !!f.temp;
  f.row.classList.toggle("typing", typing);
  f.mode.innerHTML = PRUI.typing.has(id) ? PR_ICON.slider : PR_ICON.keys;
  f.mode.title = tr(PRUI.typing.has(id) ? "prepare.mode.slider" : "prepare.mode.text");
  f.mode.setAttribute("aria-label", f.mode.title);
  f.range.setAttribute("aria-label", f.row.querySelector(".k").textContent);
}

/* ⇧ held: no magnetic notches while sliding a rotation. */
let prShift = false;
addEventListener("keydown", (e) => (prShift = e.shiftKey), true);
addEventListener("keyup", (e) => (prShift = e.shiftKey), true);

function prBindField(id) {
  const f = PF[id];
  f.el = $(id);
  f.row = f.el.closest(".p-field");
  f.range = f.row.querySelector(".p-range");
  f.out = f.row.querySelector(".p-val");
  f.mode = f.row.querySelector(".p-mode");
  const { el, range } = f;
  // The selected object, or the prime tower for its fields.
  const target = () => (f.tower ? prTowerTarget() : PR.objects.find((x) => PR.sel.has(x.id)));
  // A setting is not an undo step: the plate's history holds placements.
  const remember = (snapshot) => !f.setting && prRemember(snapshot);
  const apply = (v, commit) => {
    const o = target();
    if (!o || !isFinite(v)) return;
    f.put(o, v);
    prSchedule();
    if (commit) {
      prSave();
      prRenderInspector();
    } else {
      prRenderProps();
    }
  };
  // Typed value: live, one undo step per commit, Esc puts it back.
  let before = null, setting = null;
  el.addEventListener("focus", () => {
    before = prSnap();
    if (f.setting && target()) setting = f.get(target());
  });
  el.addEventListener("input", () => apply(parseFloat(String(el.value).replace(",", ".")), false));
  el.addEventListener("change", () => {
    if (before) remember(before);
    before = prSnap();
    apply(parseFloat(String(el.value).replace(",", ".")), true);
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") el.blur();
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    if (f.setting) {
      if (setting != null && target()) f.put(target(), setting);
    } else if (before) {
      const ids = new Set(PR.sel);
      prUnsnap(before);
      PR.sel = new Set([...ids].filter((i) => PR.objects.some((o) => o.id === i)));
    }
    const o = target();
    if (o) el.value = Math.round(f.get(o) * 10) / 10;
    el.blur();
    prSave();
    prRenderInspector();
    prSchedule();
  });
  el.addEventListener("blur", () => {
    if (!f.temp) return;
    f.temp = false;
    prRenderProps();
  });
  // Slider: the 3D view follows, the drag is one undo step.
  let slide = null;
  const begin = (e) => {
    if (e) prShift = e.shiftKey;
    if (!slide) slide = prSnap();
    f.sliding = true;
  };
  range.addEventListener("pointerdown", begin);
  range.addEventListener("pointermove", (e) => (prShift = e.shiftKey));
  range.addEventListener("input", () => {
    begin();
    let v = +range.value;
    if (f.kind === "rot") {
      v = plSnapAngle(v, prShift);
      range.value = v;
    }
    apply(v, false);
  });
  range.addEventListener("change", () => {
    f.sliding = false;
    if (slide) remember(slide);
    slide = null;
    prSave();
    prRenderInspector();
  });
  const end = () => {
    // A press without a move: nothing changed, nothing remembered.
    f.sliding = false;
    slide = null;
  };
  range.addEventListener("pointerup", () => setTimeout(end, 0));
  range.addEventListener("pointercancel", end);
  // Fine steps (wheel, arrows), ⇧ for bigger ones. A burst is one undo step.
  let at = 0, acc = 0;
  const step = (dir, coarse) => {
    const o = target();
    if (!o) return;
    const now = Date.now();
    if (now - at > 700) remember();
    at = now;
    f.put(o, plNudge(f.kind, f.get(o), dir, coarse, PR.bed, f.axis, f.lim?.()));
    prSave();
    prRenderInspector();
    prSchedule();
  };
  range.addEventListener("keydown", (e) => {
    const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 1, PageDown: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    step(dir, e.shiftKey || e.key.startsWith("Page"));
  });
  range.addEventListener(
    "wheel",
    (e) => {
      // Only a slider in use (focused, after a click or Tab) takes the
      // wheel: passing over one while scrolling the inspector changes
      // nothing.
      if (document.activeElement !== range) return;
      e.preventDefault();
      // ⇧ turns a mouse wheel horizontal on macOS.
      const d = (Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * (e.deltaMode === 1 ? 40 : 1);
      acc += d;
      if (Math.abs(acc) < 40) return;
      step(acc < 0 ? 1 : -1, e.shiftKey);
      acc = 0;
    },
    { passive: false }
  );
  // Double-click the value: type it once.
  f.out.addEventListener("dblclick", () => {
    f.temp = true;
    f.row.classList.add("typing");
    el.focus();
    el.select();
  });
  f.mode.addEventListener("click", () => {
    PRUI.typing.has(id) ? PRUI.typing.delete(id) : PRUI.typing.add(id);
    f.temp = false;
    pruiSave();
    prRenderProps();
    (PRUI.typing.has(id) ? el : range).focus();
  });
}
for (const id of Object.keys(PF)) prBindField(id);

/* Scale split into X, Y, Z (free axes) or one (proportions kept): the
   switch and the section's icon are the same choice, remembered. Joining
   a scale that is not uniform makes it so, from X: one undo step. */
function prScaleSplit(split) {
  PRUI.split = split;
  pruiSave();
  const o = PR.objects.find((x) => PR.sel.has(x.id));
  if (!split && o && !plUniform(o.scale)) {
    prRemember();
    o.scale = [o.scale[0], o.scale[0], o.scale[0]];
    prSave();
    prSchedule();
  }
  prRenderInspector();
}
$("p-lock").addEventListener("change", () => prScaleSplit(!$("p-lock").checked));
// Shown split now (the switch off): the icon joins, and the other way.
$("p-scale-split").addEventListener("click", () => prScaleSplit($("p-lock").checked));

/* ------------------------------------------------- on and off the plate */

/* Puts objects beside the plate (on its right, below those already
   there): they stay in the list, are not sliced. */
function prPark(list) {
  const ids = new Set(list.map((o) => o.id));
  const parked = PR.objects.filter((o) => !ids.has(o.id) && bedState(o) === "out").map((o) => groupBox([o]));
  for (const o of list) {
    const b = groupBox([o]);
    const [x, y] = plParkSpot(parked, PR.bed, b.x1 - b.x0, b.y1 - b.y0);
    o.pos = [o.pos[0] + x - b.x0, o.pos[1] + y - b.y0];
    parked.push(groupBox([o]));
  }
}

/* Off-plate objects back on it, each at the first free spot. One undo
   step; those that find no room stay where they are. */
function prPutOnBed(ids) {
  const list = PR.objects.filter((o) => ids.includes(o.id) && bedState(o) === "out");
  if (!list.length) return;
  const before = prSnap();
  let placed = 0;
  for (const o of list) {
    const b = groupBox([o]);
    const spot = freeSpot(b.x1 - b.x0, b.y1 - b.y0, o.id);
    if (!spot) continue;
    o.pos = [o.pos[0] + spot[0] - b.x0, o.pos[1] + spot[1] - b.y0];
    placed++;
  }
  if (placed) {
    prRemember(before);
    PR.sel = new Set(list.filter((o) => bedState(o) !== "out").map((o) => o.id));
    prSave();
    prRenderInspector();
    prSchedule();
  }
  if (placed < list.length) toast(tr("prepare.no_fit", { n: list.length - placed }), true);
}

/* An object sticking out: brought fully on the plate by the smallest
   move, or taken off it. */
function prFix(id, how) {
  const o = PR.objects.find((x) => x.id === id);
  if (!o || bedState(o) !== "partial") return;
  if (how === "in") {
    const mv = plInside(groupBox([o]), PR.bed);
    if (!mv) {
      toast(tr("prepare.no_fit", { n: 1 }), true);
      return;
    }
    prRemember();
    o.pos = [o.pos[0] + mv[0], o.pos[1] + mv[1]];
  } else {
    prRemember();
    prPark([o]);
  }
  prSave();
  prRenderInspector();
  prSchedule();
}

function prFixMenu(id, x, y) {
  PR.fixId = id;
  nativeMenu([
    { id: "prep:fixin", label: tr("prepare.fix.in") },
    { id: "prep:fixout", label: tr("prepare.fix.out") },
  ], x, y);
}

$("p-objects-fold").addEventListener("click", () => {
  PRUI.listFolded = !PRUI.listFolded;
  pruiSave();
  prRenderInspector();
});

$("p-list").addEventListener("click", (e) => {
  if (PR.rowDrag?.done) return;
  const fold = e.target.closest("[data-fold]");
  if (fold) {
    const id = +fold.dataset.fold;
    PR.fold.has(id) ? PR.fold.delete(id) : PR.fold.add(id);
    prRenderInspector();
    return;
  }
  if (e.target.closest("[data-offfold]")) {
    PRUI.offFolded = !PRUI.offFolded;
    pruiSave();
    prRenderInspector();
    return;
  }
  // Bulk buttons: the selected objects of that side when some are, else
  // the whole side (a mixed selection gives each side its own objects).
  const side = (list) => {
    const b = plBulk(PR.sel, list);
    return (b.mode === "some" ? list.filter((o) => PR.sel.has(o.id)) : list).map((o) => o.id);
  };
  if (e.target.closest("[data-parkall]")) {
    prParkIds(side(prGroups().on));
    return;
  }
  if (e.target.closest("[data-putall]")) {
    prPutOnBed(side(prGroups().off));
    return;
  }
  const put = e.target.closest("[data-put]");
  if (put) {
    prPutOnBed([+put.dataset.put]);
    return;
  }
  const park = e.target.closest("[data-park]");
  if (park) {
    prParkIds([+park.dataset.park]);
    return;
  }
  // The warning or chip of an uncoloured object: the palette, under it.
  const pick = e.target.closest("[data-pick]");
  if (pick) {
    const r = pick.getBoundingClientRect();
    if (PK.prep && PK.anchor === pick && !$("picker").classList.contains("hidden")) return closePicker(true);
    prColourPalette(PR.objects.find((o) => o.id === +pick.dataset.pick), r.left, r.bottom, pick);
    return;
  }
  const fix = e.target.closest("[data-fix]");
  if (fix) {
    const r = fix.getBoundingClientRect();
    prFixMenu(+fix.dataset.fix, r.left, r.bottom + 2);
    return;
  }
  // A color's head: the popover, physical and virtual heads.
  const tok = e.target.closest("[data-hpick]");
  if (tok) {
    if (PK.prep && PK.anchor === tok && !$("picker").classList.contains("hidden")) return closePicker(true);
    if (tok.dataset.ch != null) {
      const ext = +tok.dataset.ch;
      prHeadPicker(tok, PR.colourHeads[ext], (h) => prSetColourHead(ext, h));
    } else {
      const o = PR.objects.find((x) => x.id === +tok.dataset.obj), ext = +tok.dataset.ext;
      if (o) prHeadPicker(tok, prHeads(o)[ext]?.h, (h) => prSetHead(o, ext, h));
    }
    return;
  }
  const row = e.target.closest(".p-obj");
  if (row) prListPick(+row.dataset.id, e);
});
/* A row's menu: the same as the object's on the plate. */
$("p-list").addEventListener("contextmenu", (e) => {
  const row = e.target.closest(".p-obj");
  if (!row) return;
  e.preventDefault();
  prMenuFor(+row.dataset.id, e.clientX, e.clientY);
});
$("p-list").addEventListener("keydown", (e) => {
  const row = e.target.closest?.(".p-obj");
  if (!row || e.target !== row || (e.key !== "Enter" && e.key !== " ")) return;
  e.preventDefault();
  prListPick(+row.dataset.id, e);
});

/* A click in the list: the row alone; ⌘/Ctrl toggles it; ⇧ takes every
   row from the last one clicked (the anchor) to this one, in the order
   shown, added to the selection with ⌘/Ctrl too. */
function prListPick(id, e) {
  const add = e.metaKey || e.ctrlKey;
  if (e.shiftKey && PR.anchor != null) {
    const order = [...$("p-list").querySelectorAll(".p-obj")].map((r) => +r.dataset.id);
    const ids = plRangeIds(order, PR.anchor, id);
    PR.sel = new Set(add ? [...PR.sel, ...ids] : ids);
    prRenderInspector();
    prSchedule();
    return;
  }
  PR.anchor = id;
  prSelect([id], add);
}

/* Every object of the plate taken off it, beside it: one undo step. */
function prParkAll() {
  prParkIds(prGroups().on.map((o) => o.id));
}

/* Takes objects off the plate, beside it, as one undo step: those given
   that are on it (fully or partly). */
function prParkIds(ids) {
  const list = PR.objects.filter((o) => ids.includes(o.id) && bedState(o) !== "out");
  if (!list.length) return;
  prRemember();
  prPark(list);
  prSave();
  prRenderInspector();
  prSchedule();
}

/* Dragging a row: onto the plate (placed under the pointer) or into the
   off-plate group (taken off). Pointer events, not HTML drag and drop:
   the window's file drop would take it. */
const prDropOff = (el) => el?.closest?.('[data-drop="off"]') || null;
function prDropHover(e) {
  const t = prDropOff(document.elementFromPoint(e.clientX, e.clientY));
  for (const z of document.querySelectorAll('#view-prepare [data-drop="off"]')) z.classList.toggle("drop", z === t);
  return t;
}
function prDropEnd() {
  for (const z of document.querySelectorAll("#view-prepare .drop")) z.classList.remove("drop");
  $("p-objects").classList.remove("dragging");
  $("view-prepare").querySelector(".prep-stage").classList.remove("drop-bed");
  $("p-ghost").classList.add("hidden");
}
$("p-list").addEventListener("pointerdown", (e) => {
  const row = e.target.closest(".p-obj");
  if (!row || e.button !== 0 || e.target.closest("button, [data-fold]")) return;
  PR.rowDrag = { id: +row.dataset.id, x: e.clientX, y: e.clientY, on: false, done: false };
});
addEventListener("pointermove", (e) => {
  const d = PR.rowDrag;
  if (!d || d.done) return;
  if (!d.on && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < 6) return;
  const o = PR.objects.find((x) => x.id === d.id);
  if (!o) return;
  if (!d.on) {
    d.on = true;
    // A selected row carries the whole selection.
    d.ids = PR.sel.has(o.id) && PR.sel.size > 1 ? PR.objects.filter((x) => PR.sel.has(x.id)).map((x) => x.id) : [o.id];
    $("p-objects").classList.add("dragging");
    $("p-ghost").textContent = d.ids.length > 1 ? tr("prepare.selected", { n: d.ids.length }) : o.name;
    $("p-ghost").classList.remove("hidden");
  }
  const g = $("p-ghost");
  g.style.left = e.clientX + "px";
  g.style.top = e.clientY + "px";
  const over = document.elementFromPoint(e.clientX, e.clientY);
  prDropHover(e);
  $("view-prepare").querySelector(".prep-stage").classList.toggle("drop-bed", over === $("p-canvas"));
});
addEventListener("pointerup", (e) => {
  const d = PR.rowDrag;
  if (!d) return;
  if (!d.on) {
    PR.rowDrag = null;
    return;
  }
  d.done = true;
  // The click that follows the release is not a selection.
  setTimeout(() => (PR.rowDrag = null), 0);
  const over = document.elementFromPoint(e.clientX, e.clientY);
  const off = prDropOff(over);
  prDropEnd();
  const list = PR.objects.filter((x) => (d.ids || [d.id]).includes(x.id));
  if (!list.length) return;
  if (off) {
    const going = list.filter((x) => bedState(x) !== "out");
    if (!going.length) return;
    prRemember();
    prPark(going);
  } else if (over === $("p-canvas")) {
    const p = prBedPoint(e);
    if (!p) return;
    prRemember();
    // As a block, its center under the pointer.
    const b = groupBox(list);
    const dx = p[0] - (b.x0 + b.x1) / 2, dy = p[1] - (b.y0 + b.y1) / 2;
    for (const x of list) x.pos = [x.pos[0] + dx, x.pos[1] + dy];
  } else return;
  PR.sel = new Set(list.map((x) => x.id));
  prSave();
  prRenderInspector();
  prSchedule();
});

/* ------------------------------------------------------------ adding */

/* Top-view box of a set of objects, from their boxes. */
function groupBox(list) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of list) {
    for (const [x, y] of footprint(o)) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  return { x0, y0, x1, y1 };
}

/* Adds a file's objects. The file's first plate keeps its layout; it is
   placed as is when the plate is empty and it fits, otherwise moved as a
   block to a free spot. The other plates follow, beside it. */
async function prepareAddFile(path, { remember = true } = {}) {
  let items;
  if (typeof headsForget === "function") headsForget(path);
  const name = path.split(/[\\/]/).pop();
  PRL.reading.push(name);
  prLoadingShow();
  try {
    items = await invoke("plate_items", { path });
  } catch (e) {
    toast(`${name} : ${e}`, true);
    return;
  } finally {
    PRL.reading.splice(PRL.reading.indexOf(name), 1);
    prLoadingShow();
  }
  if (!items.length) return;
  const added = items.map((it) => ({
    id: PR.nextId++,
    name: it.name,
    path,
    item: it.index,
    pos: [it.center[0], it.center[1]],
    rot: [0, 0, 0],
    scale: [1, 1, 1],
    size: it.size,
    plate: it.plate,
    extruders: it.extruders,
    cv: COLORS_VERSION,
  }));
  if (remember) prRemember();
  const wasEmpty = PR.objects.length === 0;
  const first = added.filter((o) => o.plate === 1);
  const main = first.length ? first : added;
  const box = groupBox(main);
  const { w, d } = PR.bed;
  const fits = box.x0 >= 0 && box.y0 >= 0 && box.x1 <= w && box.y1 <= d;
  let dx = 0, dy = 0;
  if (!(fits && PR.objects.length === 0)) {
    const bw = box.x1 - box.x0, bd = box.y1 - box.y0;
    const spot = freeSpot(bw, bd) || [(w - bw) / 2, (d - bd) / 2];
    dx = spot[0] - box.x0;
    dy = spot[1] - box.y0;
  }
  for (const o of added) o.pos = [o.pos[0] + dx, o.pos[1] + dy];
  PR.objects.push(...added);
  PR.sel = new Set(main.map((o) => o.id));
  PR.towerSel = false;
  // A saved plate opened as it was: its prime tower too.
  if (wasEmpty && !dx && !dy) await prTowerFromFile(path);
  prSave();
  prRenderInspector();
  if (PR.gl) await Promise.all(added.map(prLoadMesh));
  prSchedule();
  const others = added.length - main.length;
  toast(tr("prepare.added", { n: main.length }) + (others ? " · " + tr("prepare.added_others", { n: others }) : ""));
}

/* Corner of a free area of `bw` × `bd` mm (5 mm margin), center first. */
function freeSpot(bw, bd, except) {
  const { w, d } = PR.bed, m = 5;
  const taken = PR.objects.filter((o) => o.id !== except && bedState(o) !== "out").map((o) => groupBox([o]));
  // The prime tower's place is taken too, or its pillars'.
  const tb = prTowerBox();
  if (tb && PR.tower.x != null) taken.push(ptExtent(PR.tower, tb));
  for (const t of prTowerChecks()) if (t.pillar) taken.push(ptExtent({ x: t.pillar.x, y: t.pillar.y, rot: 0 }, pmBox(t.pillar)));
  const free = (x, y) =>
    x >= 0 && y >= 0 && x + bw <= w && y + bd <= d &&
    taken.every((b) => x + bw + m <= b.x0 || b.x1 + m <= x || y + bd + m <= b.y0 || b.y1 + m <= y);
  const c = [(w - bw) / 2, (d - bd) / 2];
  if (free(...c)) return c;
  let best = null, bestD = Infinity;
  for (let y = 0; y + bd <= d; y += 5) {
    for (let x = 0; x + bw <= w; x += 5) {
      if (!free(x, y)) continue;
      const dist = Math.hypot(x - c[0], y - c[1]);
      if (dist < bestD) {
        bestD = dist;
        best = [x, y];
      }
    }
  }
  return best;
}

function prRemoveSelection() {
  if (!PR.sel.size) return;
  prRemember();
  PR.objects = PR.objects.filter((o) => !PR.sel.has(o.id));
  PR.sel.clear();
  prSave();
  prRenderInspector();
  prSchedule();
}

/* ------------------------------------------------------------ tools */

/* Product of 3 × 3 matrices (rows). */
const mat3mul = (a, b) => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));

/* X, Y, Z angles (degrees) of an Rz · Ry · Rx matrix: the inverse of `rotation`. */
function eulerOf(m) {
  const ry = Math.asin(clamp(-m[2][0], -1, 1));
  let rx, rz;
  if (Math.abs(Math.cos(ry)) > 1e-6) {
    rx = Math.atan2(m[2][1], m[2][2]);
    rz = Math.atan2(m[1][0], m[0][0]);
  } else {
    rx = 0;
    rz = Math.atan2(-m[0][1], m[1][1]);
  }
  return [normDeg(deg(rx)), normDeg(deg(ry)), normDeg(deg(rz))];
}

/* Rotation d'angle `a` (radians) autour d'un axe unitaire (Rodrigues). */
function axisAngle(k, a) {
  const [x, y, z] = k, c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}

/* Shortest rotation bringing `from` onto `to`. */
function rotationBetween(from, to) {
  const a = norm3(from), b = norm3(to);
  const c = dot3(a, b), v = cross3(a, b), s = Math.hypot(...v);
  if (s < 1e-9) {
    if (c > 0) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const axis = norm3(Math.abs(a[0]) < 0.9 ? cross3(a, [1, 0, 0]) : cross3(a, [0, 1, 0]));
    return axisAngle(axis, Math.PI);
  }
  return axisAngle(norm3(v), Math.atan2(s, c));
}

const AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const AXIS_COLORS = [[1, 0.27, 0.23], [0.2, 0.78, 0.35], [0.04, 0.52, 1]];
PR.tool = null;
PR.hoverRing = null;
PR.hoverFace = null;

const TOOL_HINTS = { rotate: "prepare.hint.rotate", face: "prepare.hint.face" };

function prSetTool(t) {
  PR.tool = PR.tool === t ? null : t;
  PR.hoverRing = PR.hoverFace = null;
  $("p-rotate").classList.toggle("on", PR.tool === "rotate");
  $("p-face").classList.toggle("on", PR.tool === "face");
  $("p-toolhint").textContent = PR.tool ? tr(TOOL_HINTS[PR.tool]) : "";
  $("p-toolhint").classList.toggle("hidden", !PR.tool);
  prStatus();
  prSchedule();
}

/* Center and radius of the rings, around the selection. */
function ringFrame() {
  const sel = PR.objects.filter((o) => PR.sel.has(o.id));
  if (!sel.length) return null;
  const b = groupBox(sel);
  const h = Math.max(...sel.map((o) => shape(o).zmax - shape(o).zmin));
  const c = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, h / 2];
  const r = Math.hypot(b.x1 - b.x0, b.y1 - b.y0, h) / 2 + 4;
  return { c, r, sel };
}

/* Point of a ray in the plane perpendicular to `a` through `c`. */
function rayPlane(ray, a, c) {
  const dn = dot3(ray.d, a);
  if (Math.abs(dn) < 1e-6) return null;
  const t = dot3(sub3(c, ray.o), a) / dn;
  return t > 0 ? add3(ray.o, ray.d.map((v) => v * t)) : null;
}

/* Ring under the cursor, if any. */
function ringHit(e) {
  const f = ringFrame();
  if (!f) return null;
  const ray = prRay(e);
  let best = null;
  AXES.forEach((a, k) => {
    // Ring seen edge-on: impossible to grab cleanly.
    if (Math.abs(dot3(ray.d, a)) < 0.08) return;
    const p = rayPlane(ray, a, f.c);
    if (!p) return;
    const err = Math.abs(Math.hypot(...sub3(p, f.c)) - f.r);
    if (err < f.r * 0.12 + 1.5 && (!best || err < best.err)) best = { axis: k, p, err };
  });
  return best;
}

/* Convex hull face under the cursor (lay on face): the face hit and the
   coplanar faces forming a facet with it. */
function faceHit(e) {
  const ray = prRay(e);
  let best = null;
  for (const o of PR.objects) {
    const mesh = PR.meshes.get(meshKey(o));
    if (!mesh?.hullFaces) continue;
    const { r, t } = placement(o);
    const toLocal = (v, isPoint) => {
      const p = isPoint ? sub3(v, t) : v;
      const q = [0, 1, 2].map((j) => r[0][j] * p[0] + r[1][j] * p[1] + r[2][j] * p[2]);
      return [q[0] / o.scale[0], q[1] / o.scale[1], q[2] / o.scale[2]];
    };
    const lo = toLocal(ray.o, true), ld = toLocal(ray.d, false);
    // The object's box first: faces are only tested when it is hit.
    const half = o.size.map((v) => v / 2 + 0.01);
    let t0 = -Infinity, t1 = Infinity;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(ld[k]) < 1e-12) {
        if (lo[k] < -half[k] || lo[k] > half[k]) t0 = Infinity;
        continue;
      }
      const a = (-half[k] - lo[k]) / ld[k], b = (half[k] - lo[k]) / ld[k];
      t0 = Math.max(t0, Math.min(a, b));
      t1 = Math.min(t1, Math.max(a, b));
    }
    if (t0 > t1 || t1 < 0) continue;
    const P = mesh.hullPts;
    mesh.hullFaces.forEach((f, i) => {
      const pos = [...P[f[0]], ...P[f[1]], ...P[f[2]]];
      const hit = rayTriangles(lo, ld, pos);
      if (hit == null) return;
      const wp = add3(applyRS(r, o.scale, [lo[0] + ld[0] * hit, lo[1] + ld[1] * hit, lo[2] + ld[2] * hit]), t);
      const dist = Math.hypot(...sub3(wp, ray.o));
      if (!best || dist < best.dist) best = { o, face: i, dist };
    });
  }
  if (!best) return null;
  const mesh = PR.meshes.get(meshKey(best.o));
  const P = mesh.hullPts;
  const nrm = (f) => norm3(cross3(sub3(P[f[1]], P[f[0]]), sub3(P[f[2]], P[f[0]])));
  const n = nrm(mesh.hullFaces[best.face]);
  const p0 = P[mesh.hullFaces[best.face][0]];
  const tol = Math.max(...best.o.size) * 1e-3 + 1e-4;
  const faces = mesh.hullFaces.filter((f) => dot3(nrm(f), n) > 0.9999 && Math.abs(dot3(n, sub3(P[f[0]], p0))) < tol);
  return { o: best.o, n, faces };
}

/* Lays the targeted facet on the bed. */
function prLayOnFace(hit) {
  const o = hit.o;
  prRemember();
  const r = rotation(o.rot);
  // Normal in the scene: R · S⁻¹ · n (scaling distorts normals).
  const ns = [hit.n[0] / o.scale[0], hit.n[1] / o.scale[1], hit.n[2] / o.scale[2]];
  const nw = norm3([0, 1, 2].map((i) => r[i][0] * ns[0] + r[i][1] * ns[1] + r[i][2] * ns[2]));
  o.rot = eulerOf(mat3mul(rotationBetween(nw, [0, 0, -1]), r));
  PR.hoverFace = null;
  prSave();
  prRenderInspector();
  prSchedule();
}

/* Auto-orientation, Orca's rules (computed in Rust). `all`: the whole
   plate; otherwise the selection, or the whole plate if nothing is selected. */
async function prOrient(all) {
  const onBed = PR.objects.filter((o) => bedState(o) !== "out");
  const targets = all || !PR.sel.size ? onBed : PR.objects.filter((o) => PR.sel.has(o.id));
  if (!targets.length || PR.orienting) return;
  PR.orienting = true;
  prStatus();
  $("p-toolhint").textContent = tr("prepare.orienting", { n: targets.length });
  $("p-toolhint").classList.remove("hidden");
  const before = prSnap();
  try {
    const process = SL.memory[SL.memory.last]?.process || null;
    const mats = await invoke("plate_orient", {
      items: targets.map((o) => ({ path: o.path, item: o.item, piece: o.piece ?? null, scale: o.scale })),
      process,
    });
    prRemember(before);
    // The tilt comes from the computation; the chosen Z rotation is kept.
    targets.forEach((o, i) => (o.rot = eulerOf(mat3mul(rotation([0, 0, o.rot[2]]), mats[i]))));
    prSave();
    prRenderInspector();
    prSchedule();
    toast(tr("prepare.oriented", { n: targets.length }));
  } catch (e) {
    toast(tr("prepare.orient_failed", { err: e }), true);
  } finally {
    PR.orienting = false;
    prStatus();
    $("p-toolhint").textContent = PR.tool ? tr(TOOL_HINTS[PR.tool]) : "";
    $("p-toolhint").classList.toggle("hidden", !PR.tool);
  }
}

/* ------------------------------------------------------------ supports hint */

/* The overhang angle of the hint and the overhang view: the advanced
   settings' when changed there, otherwise the print profile's (read by
   Rust from `process`). */
function prHintAngle() {
  const m = SL.memory.last ? rememberFor(SL.memory.last) : {};
  const a = parseFloat(m.adv?.support_threshold_angle);
  return { process: m.process || null, threshold: a > 0 && a < 90 ? a : null };
}

/* After a change of the plate or of the supports: the badge at once,
   what Rust has to read a moment later. */
function prHintRefresh() {
  clearTimeout(PR.hintTimer);
  PR.hintTimer = setTimeout(prHintAsk, 400);
  prHintRender();
}

/* Asks Rust, in the background, for the hints not known yet: an object
   added, tilted or scaled (moved or turned on the bed, it keeps its own),
   on the plate, while supports are off. The overhang view needs the angle
   only. */
async function prHintAsk() {
  const { process, threshold } = prHintAngle();
  const tag = threshold ?? process;
  const objs = slSupportsNext()
    ? []
    : PR.objects.filter((o) => bedState(o) !== "out" && !PR.hints.has(plHintKey(o, tag)) && !PR.hintAsk.has(plHintKey(o, tag)));
  const keys = [...new Set(objs.map((o) => plHintKey(o, tag)))];
  const angle = PR.overhangs && PR.overTag !== tag;
  if (!keys.length && !angle) return;
  keys.forEach((k) => PR.hintAsk.add(k));
  const items = keys.map((k) => objs.find((o) => plHintKey(o, tag) === k)).map((o) => ({ path: o.path, item: o.item, piece: o.piece ?? null, rot: o.rot, scale: o.scale }));
  try {
    const r = await invoke("plate_support_hint", { items, process, threshold });
    keys.forEach((k, i) => PR.hints.set(k, r.items[i] || { verdict: "none" }));
    PR.overAngle = r.threshold;
    PR.overTag = tag;
  } catch (e) {
    // Not asked again for these: the slice's own check remains.
    console.warn("supports hint:", e);
    keys.forEach((k) => PR.hints.set(k, { verdict: "none" }));
  } finally {
    keys.forEach((k) => PR.hintAsk.delete(k));
  }
  // Old placements go first.
  for (const k of PR.hints.keys()) if (PR.hints.size > 400) PR.hints.delete(k);
  prHintRender();
  prSchedule();
}

/* The badge in the 3D view's bottom-left corner: the objects that
   probably need supports, named (or counted), and why. */
function prHintRender() {
  const { process, threshold } = prHintAngle();
  const tag = threshold ?? process;
  const on = PR.objects.filter((o) => bedState(o) !== "out");
  const b = plSupportBadge(on, (o) => PR.hints.get(plHintKey(o, tag)), slSupportsNext());
  PR.hintIds = new Set(b?.ids || []);
  $("p-supports").classList.toggle("hidden", !b);
  $("p-canvas").parentElement.classList.toggle("p-hinting", !!b);
  if (!b) {
    if (PR.hintHover) {
      PR.hintHover = false;
      prSchedule();
    }
    return;
  }
  const reasons = b.reasons.map((r) => tr(SUPPORT_REASONS[r]));
  const one = b.ids.length === 1;
  $("p-supports-title").textContent = one ? tr("supports.badge") : tr("supports.badge.many", { n: b.ids.length });
  $("p-supports-why").textContent = one ? tr("supports.badge.why", { name: b.names[0], reason: reasons[0] || "" }) : reasons.join(" · ");
  $("p-supports").title = (one ? "" : b.names.join(", ") + "\n") + tr("supports.badge.title");
}

function prSetOverhangs(on) {
  PR.overhangs = on;
  $("p-overhangs").classList.toggle("on", on);
  $("p-overhangs").setAttribute("aria-pressed", String(on));
  prStatus();
  if (on) prHintRefresh();
  prSchedule();
}

$("p-supports").addEventListener("mouseenter", () => {
  PR.hintHover = true;
  prSchedule();
});
$("p-supports").addEventListener("mouseleave", () => {
  PR.hintHover = false;
  prSchedule();
});
$("p-supports-go").addEventListener("click", () => {
  slSetSupports(true);
  toast(tr("supports.on_toast"));
});
$("p-overhangs").addEventListener("click", () => prSetOverhangs(!PR.overhangs));

/* Saves the whole plate as 3MF (the model's parts and extruders kept). */
async function prSavePlate() {
  if (!PR.objects.length) return;
  const dir = state.dir || PR.objects[0].path.replace(/[\\/][^\\/]*$/, "");
  const sep = dir.includes("\\") ? "\\" : "/"; // Windows paths too
  const dest = await window.__TAURI__.dialog
    .save({ defaultPath: dir + sep + tr("prepare.default_name"), filters: [{ name: "3MF", extensions: ["3mf"] }] })
    .catch(() => null);
  if (!dest) return;
  const identity = Array.from({ length: 16 }, (_, i) => i);
  try {
    await invoke("plate_save", {
      scene: PR.objects.map((o) => ({ path: o.path, item: o.item, piece: o.piece ?? null, name: o.name, pos: o.pos, rot: o.rot, scale: o.scale, extruder_map: identity })),
      // The prime tower goes with it, as Orca keeps it (its default place
      // if Prepare never showed it: the pillars printed instead).
      tower: PR.tower.on ? { on: true, x: PR.tower.x ?? 15, y: PR.tower.y ?? 220, rot: PR.tower.rot || 0 } : null,
      // One tower per material: the choice and the pillars' places, never
      // the pillars themselves.
      snap: PR.tower.kind === "material" || Object.keys(PR.tower.pillars || {}).length ? prPillarsFileData() : null,
      // Smooth mix, for a plate with a virtual head: Orca's keys, on or off.
      smooth_mix: prTowerVirtualUsed() ? vhSmoothOn(PR) : null,
      path: dest,
    });
    toast(tr("prepare.saved", { name: dest.split(/[\\/]/).pop() }));
    if (state.dir && dest.startsWith(state.dir)) refresh();
  } catch (e) {
    toast(tr("printers.form.save_failed", { err: e }), true);
  }
}

/* ------------------------------------------------------------ arrangement */

/* Cells (1 mm) covered by the footprint of an object rotated by `rz`,
   grown by `margin`: relative to its center. */
function cellMask(o, rz, margin) {
  const poly = convexHull(footprint({ ...o, pos: [0, 0], rot: [o.rot[0], o.rot[1], rz] }));
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const x0 = Math.floor(Math.min(...xs) - margin), x1 = Math.ceil(Math.max(...xs) + margin);
  const y0 = Math.floor(Math.min(...ys) - margin), y1 = Math.ceil(Math.max(...ys) + margin);
  // Distance from a point to the convex polygon (0 inside).
  const dist = (x, y) => {
    let inside = true, best = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      if (ex * (y - a[1]) - ey * (x - a[0]) < 0) inside = false;
      const t = clamp(((x - a[0]) * ex + (y - a[1]) * ey) / (ex * ex + ey * ey || 1), 0, 1);
      best = Math.min(best, Math.hypot(x - a[0] - t * ex, y - a[1] - t * ey));
    }
    return inside ? 0 : best;
  };
  const cells = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (dist(x + 0.5, y + 0.5) <= margin) cells.push(x, y);
  return { cells, x0, x1, y0, y1, area: (x1 - x0) * (y1 - y0) };
}

/* Auto-arrange: millimeter grid, objects from largest to smallest, each in
   the first free spot (bottom, then left), with a 90° attempt; 6 mm
   between two objects. The group is then recentered, unless it would
   land on the prime tower: the tower never moves, the parts go around it.
   What does not fit is set beside the plate. */
function prArrange() {
  const list = PR.objects.filter((o) => bedState(o) !== "out");
  if (!list.length) return;
  prRemember();
  const W = Math.floor(PR.bed.w), D = Math.floor(PR.bed.d);
  const grid = new Uint8Array(W * D);
  const margin = 3;
  // The prime tower stays: an obstacle, its cells (and the margin) taken;
  // its pillars too.
  const tb = prTowerBox();
  const towers = [];
  if (tb && PR.tower.x != null) towers.push([PR.tower, tb]);
  for (const t of prTowerChecks()) if (t.pillar) towers.push([{ x: t.pillar.x, y: t.pillar.y, rot: 0 }, pmBox(t.pillar)]);
  for (const [at, tb] of towers) {
    const tower = ptExtent(at, tb);
    const poly = ptCorners(at, { x0: tb.x0 - margin, y0: tb.y0 - margin, w: tb.w + 2 * margin, d: tb.d + 2 * margin });
    for (let y = Math.max(0, Math.floor(tower.y0 - margin)); y < Math.min(D, Math.ceil(tower.y1 + margin)); y++) {
      for (let x = Math.max(0, Math.floor(tower.x0 - margin)); x < Math.min(W, Math.ceil(tower.x1 + margin)); x++) {
        if (ptConvexOverlap(poly, [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]], 0)) grid[y * W + x] = 1;
      }
    }
  }
  const plans = list
    .map((o) => {
      // An own rotation (X/Y) is kept as is; only Z varies.
      const tries = [o.rot[2], normDeg(o.rot[2] + 90)].map((rz) => ({ rz, mask: cellMask(o, rz, margin) }));
      return { o, tries, area: Math.min(...tries.map((t) => t.mask.area)) };
    })
    .sort((a, b) => b.area - a.area);
  const fits = (m, cx, cy) => {
    const c = m.cells;
    for (let i = 0; i < c.length; i += 2) {
      const x = cx + c[i], y = cy + c[i + 1];
      if (x < 0 || y < 0 || x >= W || y >= D || grid[y * W + x]) return false;
    }
    return true;
  };
  const placed = [], left = [];
  for (const plan of plans) {
    let best = null;
    for (const t of plan.tries) {
      const m = t.mask;
      search: for (let cy = -m.y0; cy <= D - 1 - m.y1; cy += 1) {
        for (let cx = -m.x0; cx <= W - 1 - m.x1; cx += 1) {
          if (best && (cy > best.cy || (cy === best.cy && cx >= best.cx))) break search;
          if (fits(m, cx, cy)) {
            best = { cx, cy, t };
            break search;
          }
        }
      }
    }
    if (!best) {
      left.push(plan.o);
      continue;
    }
    const c = best.t.mask.cells;
    for (let i = 0; i < c.length; i += 2) grid[(best.cy + c[i + 1]) * W + best.cx + c[i]] = 1;
    placed.push({ o: plan.o, cx: best.cx, cy: best.cy, rz: best.t.rz, m: best.t.mask });
  }
  // Group recentered on the plate, unless that would bring it onto the
  // prime tower or a pillar: it then stays where the grid put it, around.
  if (placed.length) {
    const x0 = Math.min(...placed.map((p) => p.cx + p.m.x0)), x1 = Math.max(...placed.map((p) => p.cx + p.m.x1));
    const y0 = Math.min(...placed.map((p) => p.cy + p.m.y0)), y1 = Math.max(...placed.map((p) => p.cy + p.m.y1));
    let dx = Math.floor((W - 1 - x1 - x0) / 2), dy = Math.floor((D - 1 - y1 - y0) / 2);
    const m = margin;
    const hits = (t) => !(x1 + dx + m <= t.x0 || t.x1 + m <= x0 + dx || y1 + dy + m <= t.y0 || t.y1 + m <= y0 + dy);
    if (towers.some(([at, tb]) => hits(ptExtent(at, tb)))) dx = dy = 0;
    for (const p of placed) {
      p.o.rot = [p.o.rot[0], p.o.rot[1], p.rz];
      p.o.pos = [p.cx + dx, p.cy + dy];
    }
  }
  // What does not fit waits beside the plate, in the parking's free spots:
  // never on top of an object already parked there.
  prPark(left);
  prSave();
  prRenderInspector();
  prSchedule();
  if (left.length) toast(tr("prepare.no_fit", { n: left.length }), true);
}

/* Duplicates the selection; copies go to the nearest free spot. */
function prDuplicate() {
  const sel = PR.objects.filter((o) => PR.sel.has(o.id));
  if (!sel.length) return;
  prRemember();
  const copies = [];
  for (const o of sel) {
    const c = { ...o, id: PR.nextId++, pos: [...o.pos], rot: [...o.rot], scale: [...o.scale], heads: { ...(o.heads || {}) } };
    const b = groupBox([c]);
    PR.objects.push(c);
    const spot = freeSpot(b.x1 - b.x0, b.y1 - b.y0, c.id);
    c.pos = spot ? [c.pos[0] + spot[0] - b.x0, c.pos[1] + spot[1] - b.y0] : [c.pos[0] + 10, c.pos[1] + 10];
    copies.push(c.id);
  }
  PR.sel = new Set(copies);
  prSave();
  prRenderInspector();
  prSchedule();
}

/* Split: each selected object becomes its pieces — the parts of its mesh
   that do not touch (Orca's "Split to objects") — in place, with its
   rotation, scale and color choices. */
async function prSplit() {
  const sel = PR.objects.filter((o) => PR.sel.has(o.id));
  if (!sel.length || PR.splitting) return;
  PR.splitting = true;
  prStatus();
  try {
    const found = await Promise.all(
      sel.map((o) => invoke("plate_pieces", { path: o.path, item: o.item, piece: o.piece ?? null }).catch((e) => (toast(String(e), true), null)))
    );
    const todo = sel.map((o, i) => [o, found[i]]).filter(([, p]) => p && p.length > 1);
    if (!todo.length) {
      toast(tr("prepare.split.single", { n: sel.length }));
      return;
    }
    prRemember();
    const added = [];
    for (const [o, pieces] of todo) {
      const r = rotation(o.rot);
      const at = PR.objects.indexOf(o);
      const made = pieces.map((p, k) => {
        const d = applyRS(r, o.scale, p.offset);
        return {
          id: PR.nextId++,
          name: `${o.name} ${k + 1}`,
          path: o.path,
          item: o.item,
          piece: p.piece,
          pos: [o.pos[0] + d[0], o.pos[1] + d[1]],
          rot: [...o.rot],
          scale: [...o.scale],
          size: p.size,
          plate: o.plate,
          extruders: p.extruders,
          heads: { ...(o.heads || {}) },
          cv: COLORS_VERSION,
        };
      });
      PR.objects.splice(at, 1, ...made);
      added.push(...made);
    }
    PR.sel = new Set(added.map((o) => o.id));
    SHAPES.clear();
    prSave();
    prRenderInspector();
    if (PR.gl) await Promise.all(added.map(prLoadMesh));
    prSchedule();
    toast(tr("prepare.split.done", { n: added.length }));
  } finally {
    PR.splitting = false;
    prStatus();
  }
}

/* Moves the selection, as a block. */
function prMoveSelection(dx, dy, remember = true) {
  if (!PR.sel.size) return;
  if (remember) prRemember();
  for (const o of PR.objects) if (PR.sel.has(o.id)) o.pos = [o.pos[0] + dx, o.pos[1] + dy];
  prSave();
  prRenderInspector();
  prSchedule();
}

function prCenterSelection() {
  const sel = PR.objects.filter((o) => PR.sel.has(o.id));
  if (!sel.length) return;
  const b = groupBox(sel);
  prMoveSelection(PR.bed.w / 2 - (b.x0 + b.x1) / 2, PR.bed.d / 2 - (b.y0 + b.y1) / 2);
}

function prResetRotation() {
  if (!PR.sel.size) return;
  prRemember();
  for (const o of PR.objects) if (PR.sel.has(o.id)) o.rot = [0, 0, 0];
  prSave();
  prRenderInspector();
  prSchedule();
}

/* ------------------------------------------------------------ view */

/* Called when the view shows: graphics context, bed, meshes. */
async function prepareShow() {
  prTowerLoadProfile();
  prStatus();
  prRefreshSpools();
  prEnsureLists();
  if (!prEnsureGL()) return;
  const bed = await invoke("plate_bed", { machine: SL.memory.last || null }).catch(() => null);
  if (bed && (bed.w !== PR.bed.w || bed.d !== PR.bed.d || bed.model !== PR.bed.model)) {
    PR.bed = { w: bed.w, d: bed.d, model: bed.model };
    disposeDrawable(PR.gl, PR.grid);
    PR.grid = buildGrid(PR.gl, PR.bed.w, PR.bed.d);
    disposeBed(PR.gl, PR.plate);
    PR.plate = buildBed(PR.gl, PR.bed.w, PR.bed.d, PR.bed.model, prSchedule);
    PR.framed = false;
  }
  if (!PR.framed) {
    prFrame();
    PR.framed = true;
  }
  prRenderInspector();
  prSchedule();
  await Promise.all([...PR.objects.map(prLoadMesh), prRefreshColors()]);
  prRenderInspector();
  prSchedule();
  // The profile or its overhang angle may have changed meanwhile.
  prHintRefresh();
}

/* Scene handed to slicing: objects on the plate only. */
function prepareScene() {
  const on = plSliced(PR.objects, bedState);
  const partial = PR.objects.filter((o) => bedState(o) === "partial");
  if (partial.length) {
    toast(tr("prepare.sticks_out", { names: partial.map((o) => o.name).join(", "), n: partial.length }), true);
    return null;
  }
  if (!on.length) {
    toast(tr("prepare.nothing"), true);
    return null;
  }
  if (prTowerBlocks()) {
    toast(tr("prepare.tower.off_plate"), true);
    return null;
  }
  const files = [...new Set(on.map((o) => o.path))];
  const name = files.length === 1 ? files[0].split(/[\\/]/).pop().replace(/\.(3mf|stl)$/i, "") : tr("slice.plate").toLowerCase();
  return {
    name,
    files,
    skipped: PR.objects.length - on.length,
    items: on.map((o) => ({ id: o.id, path: o.path, item: o.item, piece: o.piece ?? null, name: o.name, pos: o.pos, rot: o.rot, scale: o.scale, colors: prColors(o), heads: prSliceHeads(o) })),
  };
}

/* ------------------------------------------------------------ events */

$("p-add").addEventListener("click", prAddFiles);
$("p-save").addEventListener("click", prSavePlate);
$("p-clear").addEventListener("click", prClear);
onMenu("prep", async (what) => {
  const byId = (id) => PR.objects.find((o) => o.id === +id);
  if (what === "colour") prColourAction(byId(PR.menuId), PR.menuAt?.x || 0, PR.menuAt?.y || 0);
  if (what === "dup") prDuplicate();
  if (what === "split") prSplit();
  if (what === "center") prCenterSelection();
  if (what === "resetrot") prResetRotation();
  if (what === "arrange") prArrange();
  if (what === "del") prRemoveSelection();
  if (what === "fixin") prFix(PR.fixId, "in");
  if (what === "fixout") prFix(PR.fixId, "out");
  if (what === "orient") prOrient(false);
  if (what === "facetool") prSetTool("face");
  if (what === "save") prSavePlate();
  if (what === "add") prAddFiles();
  if (what === "clear") prClear();
});

/* Files picked from disk, added to the plate. */
async function prAddFiles() {
  const picked = await window.__TAURI__.dialog
    .open({ multiple: true, filters: [{ name: tr("prepare.filter"), extensions: ["3mf", "stl"] }] })
    .catch(() => null);
  for (const p of [].concat(picked || [])) await prepareAddFile(typeof p === "string" ? p : p.path);
}

async function prClear() {
  if (!PR.objects.length) return;
  const ok = await confirmDelete(tr("prepare.clear.title"), tr("prepare.clear.text"), tr("prepare.clear.ok"));
  if (!ok) return;
  prEmpty();
}

/* Empties the plate as one undo step and redraws. A new print starts:
   the heads chosen for supports, walls or infill are forgotten. */
function prEmpty() {
  if (typeof advForgetHeads === "function") advForgetHeads();
  prRemember();
  PR.objects = [];
  PR.sel.clear();
  // A new plate starts in the Settings default mode, with no colour mapped.
  PR.assoc = PRUI.assocDefault;
  PR.colourHeads = {};
  // Nor a prime tower: a new project starts without one. Smooth mix back
  // to its default.
  prTowerRestore(null);
  PR.smoothMix = true;
  PR.towerSel = false;
  prSave();
  prRenderInspector();
  prSchedule();
}
$("p-del").addEventListener("click", prRemoveSelection);
$("p-dup").addEventListener("click", prDuplicate);
$("p-split").addEventListener("click", prSplit);
$("p-rotate").addEventListener("click", () => prSetTool("rotate"));
$("p-face").addEventListener("click", () => prSetTool("face"));
$("p-orient").addEventListener("click", (e) => prOrient(e.shiftKey));
$("p-arrange").addEventListener("click", prArrange);
$("p-slice").addEventListener("click", () => openSlice());

/* ------------------------------------------------- plate already occupied */

/* Preparing new models (Files, AI) while objects already sit on the plate
   asks first: clear it, or keep it and add beside. Only objects on the bed
   count (not those parked beside it), and the plate is looked at once,
   before anything is added: the models being prepared together never
   trigger it. The plate's own "Add" button never asks. */
const OCC_KEY = "snapstudio.plate.noask";
const occAsk = () => localStorage.getItem(OCC_KEY) !== "1";
function occSetAsk(on) {
  if (on) localStorage.removeItem(OCC_KEY);
  else localStorage.setItem(OCC_KEY, "1");
  $("set-plate-ask").checked = on;
}

function occRows(entries) {
  return entries
    .map(({ name, n, dup }) => `<div class="grow-row"><span class="k">${esc(name)}</span>${
      dup ? `<span class="occ-dup">${esc(tr("prepare.occupied.dup"))}</span>` : ""
    }${n > 1 ? `<span class="val">× ${n}</span>` : ""}</div>`)
    .join("");
}

/* "keep" | "clear" | null (cancelled). */
function occConfirm(paths) {
  const on = PR.objects.filter((o) => bedState(o) !== "out");
  if (!on.length || !occAsk()) return Promise.resolve("keep");
  const byFile = new Map();
  for (const o of on) byFile.set(o.path, (byFile.get(o.path) || 0) + 1);
  $("occ-title").textContent = tr("prepare.occupied.title", { n: on.length });
  $("occ-on").innerHTML = occRows([...byFile].map(([p, n]) => ({ name: baseName(p), n })));
  $("occ-new").innerHTML = occRows(paths.map((p) => ({ name: baseName(p), n: 1, dup: byFile.has(p) })));
  $("occ-noask").checked = false;
  const modal = $("occmodal");
  openSheet(modal);
  requestAnimationFrame(() => $("occ-keep").focus());
  return new Promise((resolve) => {
    const done = (v) => {
      if (v && $("occ-noask").checked) occSetAsk(false);
      $("occ-keep").onclick = $("occ-clear").onclick = $("occ-cancel").onclick = modal.onkeydown = null;
      closeSheet(modal);
      resolve(v);
    };
    $("occ-keep").onclick = () => done("keep");
    $("occ-clear").onclick = () => done("clear");
    $("occ-cancel").onclick = () => done(null);
    modal.onkeydown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        done(null);
      }
    };
  });
}

/* Adds models to the plate after the occupied-plate check. */
async function prepareModels(paths) {
  if (!paths.length) return;
  switchView("prepare");
  const choice = await occConfirm(paths);
  if (!choice) return;
  let remember = true;
  if (choice === "clear") {
    // Clearing and adding make one undo step.
    prEmpty();
    remember = false;
  }
  const before = new Set(PR.objects.map((o) => o.id));
  for (const p of paths) await prepareAddFile(p, { remember });
  // The whole multi-selection being prepared ends up selected, not only its
  // last file: it stands apart from what was already on the plate.
  if (paths.length > 1) {
    PR.sel = new Set(PR.objects.filter((o) => !before.has(o.id) && o.plate === 1).map((o) => o.id));
    prRenderInspector();
    prSchedule();
  }
}

$("set-plate-ask").checked = occAsk();
$("set-plate-ask").addEventListener("change", (e) => occSetAsk(e.target.checked));

/* Colour → head mode: the switch above the list, its Settings default and
   the sheet shown before the first switch. */
$("p-assoc").addEventListener("click", (e) => {
  const b = e.target.closest("[data-assoc]");
  if (b) prAssocSwitch(b.dataset.assoc);
});
$("set-assoc").value = PRUI.assocDefault;
$("set-assoc").addEventListener("change", (e) => {
  PRUI.assocDefault = e.target.value === "colour" ? "colour" : "object";
  pruiSave();
});
$("assoc-go").addEventListener("click", () => {
  if ($("assoc-noshow").checked) {
    PRUI.assocExplained = true;
    pruiSave();
  }
  closeSheet($("assocmodal"));
  if (PR.assocPending) prAssocApply(PR.assocPending);
  PR.assocPending = null;
});
$("assoc-cancel").addEventListener("click", () => {
  PR.assocPending = null;
  closeSheet($("assocmodal"));
});

/* Files: "Prepare" adds the selected models to the plate and shows it.
   G-code files are already sliced: they are left out. */
async function prepareFiles(paths) {
  const models = paths
    .map((p) => state.files.find((x) => x.path === p))
    .filter((f) => f && f.kind !== "gcode");
  if (!models.length) {
    if (paths.length) toast(tr("prepare.already_sliced"), true);
    return;
  }
  await prepareModels(models.map((f) => f.path));
}

$("act-slice").addEventListener("click", () => prepareFiles([...state.sel].slice(0, 1)));

/* View keyboard: the menu bar does not have these commands, and ⌘Z/⇧⌘Z
   are intercepted here before the Edit menu (which keeps them in text
   fields). */
let nudgeAt = 0;
document.addEventListener("keydown", (e) => {
  if (window.currentView !== "prepare") return;
  if (document.querySelector(".modal:not(.hidden)")) return;
  // The slice preview covers the plate without leaving the view: its keys
  // (R reframes) must not reach the plate (R rotates, Backspace removes).
  if (!$("viewer").classList.contains("hidden")) return;
  if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === "z") {
    e.preventDefault();
    e.shiftKey ? prRedo() : prUndo();
  } else if (mod && k === "y") {
    e.preventDefault();
    prRedo();
  } else if (mod && k === "d") {
    e.preventDefault();
    prDuplicate();
  } else if (!mod && k === "a") {
    prArrange();
  } else if (!mod && k === "r") {
    prSetTool("rotate");
  } else if (!mod && k === "f") {
    prSetTool("face");
  } else if (!mod && k === "q") {
    prOrient(e.shiftKey);
  } else if (e.key === "Backspace" || e.key === "Delete") {
    e.preventDefault();
    // The prime tower is not removed: its switch is the way.
    if (PR.towerSel) toast(tr("prepare.tower.no_delete"));
    else prRemoveSelection();
  } else if (e.key === "Escape") {
    if (PR.tool) prSetTool(PR.tool);
    else prSelect([], false);
  } else if (e.key.startsWith("Arrow") && PR.towerSel) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const v = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    const now = Date.now();
    if (now - nudgeAt > 700) prRemember();
    nudgeAt = now;
    prTowerMove(v[0], v[1]);
    prSave();
    prRenderInspector();
    prSchedule();
  } else if (e.key.startsWith("Arrow") && PR.sel.size) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const v = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    // A burst of arrows only makes one undo step.
    const now = Date.now();
    prMoveSelection(v[0], v[1], now - nudgeAt > 700);
    nudgeAt = now;
  }
});

window.addEventListener("langchange", () => {
  prRenderInspector();
  if (PR.tool) $("p-toolhint").textContent = tr(TOOL_HINTS[PR.tool]);
});

prLoadState();
prStatus();

/* ---------------------------------------------------- heads and spools */

/* Colors of an object: those of its triangles and painting (plate_items). */
const prColors = (o) => (o.extruders?.length ? o.extruders : [1]);

/* Head printing each color of an object: the object's own choice,
   otherwise the file's (slice sheet memory) or the closest spool.
   { ext: { h, own } } */
function prHeads(o, pid = headsActive(), slots = headsSlots(pid), n = headsCount(pid)) {
  const colors = prColors(o);
  const model = headsModelNow(o.path);
  const base = headsResolve(pid, o.path, { filaments: model?.filaments || [], used: colors }, slots, n);
  const out = {};
  for (const ext of colors) {
    const own = o.heads?.[ext];
    // A virtual head is kept as chosen; one deleted since is an orphan,
    // "no head": never replaced by the deduced head behind the user's back.
    if (vhIs(own)) out[ext] = { h: own, own: true, orphan: vhOrphan(headsVirtual(pid), own) };
    else out[ext] = own != null && own < n ? { h: own, own: true } : { h: base[ext].h, own: false };
  }
  return out;
}

/* A color's head as one token button, opening the head popover: a
   physical head, a virtual head, or "Choose" when it has none (`h` null).
   `own`: chosen by the user, rather than deduced (outlined). One head
   and no virtual head: nothing to choose, a plain token. */
function prHeadToken(h, { pid = headsActive(), slots = headsSlots(pid), n = headsCount(pid), own = true, attrs = "" } = {}) {
  const list = headsVirtual(pid);
  const button = n > 1 || list.length ? ` type="button" data-hpick aria-haspopup="listbox"${attrs}` : attrs;
  const tag = n > 1 || list.length ? "button" : "span";
  const caret = button !== attrs ? `<span class="p-caret" aria-hidden="true">▾</span>` : "";
  if (h == null) return `<${tag} class="sl-token p-choose"${button}>${esc(tr("prepare.choose_head"))}${caret}</${tag}>`;
  if (vhIs(h)) {
    const v = vhFind(list, h);
    const name = vhName(list, h);
    return vhToken({ name, color: headsColorOf(pid, h), ca: hdSpoolColor(pid, v.a), cb: hdSpoolColor(pid, v.b), on: own, tag, cls: " p-tok", attrs: button, title: `${name} · T${v.a} + T${v.b} · ${vhRatio(v.pct)}`, after: caret });
  }
  return headToken({ h, slot: slots.find((x) => x.index === h), on: own, tag, cls: " p-tok", attrs: button, after: caret });
}

/* The head popover for a color: the physical heads, the printer's virtual
   heads, and "Create a virtual head…" (picked for that color once made). */
function prHeadPicker(anchor, value, onPick) {
  const pid = headsActive(), slots = headsSlots(pid), n = headsCount(pid);
  const list = headsVirtual(pid);
  const v = value == null || vhOrphan(list, value) ? null : String(value);
  const canMake = pid && vhCanAdd(list) && vhLoaded(slots).length >= 2;
  openSwatches(anchor, {
    entries: swEntries(swHeads({ count: n, slots }), { value: v != null && !vhIs(v) ? v : null }),
    virtual: list.length ? vsEntries(pid) : null,
    value: v,
    label: tr("swatch.choose_head"),
    note: slots.length ? "" : tr("swatch.connect"),
    foot: canMake ? { label: tr("swatch.create_virtual"), onClick: () => (closePicker(), vsOpen(pid, { done: onPick })) } : null,
    onPick: (x) => onPick(+x),
  });
  PK.prep = true;
}

/* How many of the plate's colors use these head values (virtual heads
   being deleted): by object, each object's color; by colour, each plate
   colour and each object with its own pick. */
function prVirtualUsers(values) {
  const set = new Set(values.map(Number));
  let n = 0;
  for (const o of PR.objects) {
    if (bedState(o) === "out") continue;
    if (PR.assoc === "colour") n += set.has(+o.pick) ? 1 : 0;
    else n += prColors(o).filter((ext) => set.has(+o.heads?.[ext])).length;
  }
  if (PR.assoc === "colour") n += Object.values(PR.colourHeads).filter((h) => set.has(+h)).length;
  return n;
}

/* The plate's colors left without a head (a virtual head deleted since),
   in either mode: they block the slice until one is chosen. */
function prOrphans() {
  // Declarations: prStatus may run before heads.js is read.
  if (typeof headsActive !== "function") return [];
  const pid = headsActive(), list = headsVirtual(pid);
  const out = [];
  const on = PR.objects.filter((o) => bedState(o) !== "out");
  if (PR.assoc === "colour") {
    for (const ext of plPlateColours(PR.objects, bedState, prBannerColours)) if (vhOrphan(list, PR.colourHeads[ext])) out.push({ ext });
    for (const o of on) if (vhOrphan(list, o.pick)) out.push({ o });
  } else {
    for (const o of on) for (const ext of prColors(o)) if (vhOrphan(list, o.heads?.[ext])) out.push({ o, ext });
  }
  return out;
}

/* ------------------------------------------------------------ colour modes */

/* The colours the 3MF gives an object (none: an uncoloured object, which
   "by colour" mode asks a head for, on its row). */
function prOwnColours(o) {
  return o.extruders?.length ? o.extruders : [];
}

/* The colours an object brings to the plate's banner: none once a head
   was picked for it, which prints the whole object. */
function prBannerColours(o) {
  return o.pick != null ? [] : prOwnColours(o);
}

/* The plate's colours, each with what the 3MF says of it (from the first
   on-plate object carrying it): { ext, kind, color }. */
function prPlateColours() {
  return plPlateColours(PR.objects, bedState, prBannerColours).map((ext) => {
    const o = PR.objects.find((x) => bedState(x) !== "out" && prBannerColours(x).includes(ext));
    const f = o ? headsModelNow(o.path)?.filaments?.find((x) => x.index === ext) : null;
    return { ext, kind: f?.kind, color: f?.color };
  });
}

/* What blocks the slice in "by colour" mode: the plate's colours without
   a head, and the uncoloured objects without a picked one. Declarations:
   `prStatus` may run before this point of the file. */
function prBlockers() {
  const orphans = prOrphans();
  if (PR.assoc !== "colour") return { colours: [], objects: [], orphans };
  return {
    colours: plUnmapped(plPlateColours(PR.objects, bedState, prBannerColours), PR.colourHeads),
    objects: plUncoloured(PR.objects, bedState, prOwnColours),
    orphans,
  };
}
function prUnmapped() {
  return prBlockers().colours;
}

/* An object's heads as the slice gets them: its own in "by object" mode;
   in "by colour" mode the plate's, or the head picked for the object on
   its row, which prints the whole object (a colour still unmapped keeps
   the object's; the slice is blocked while one is). */
function prSliceHeads(o) {
  if (PR.assoc !== "colour") return o.heads || {};
  const heads = { ...(o.heads || {}) };
  for (const ext of prColors(o)) {
    if (o.pick != null) heads[ext] = o.pick;
    else if (PR.colourHeads[ext] != null) heads[ext] = PR.colourHeads[ext];
  }
  return heads;
}

/* The head picked for an object in "by colour" mode (null: the plate's
   colours again). */
function prSetPick(o, h) {
  if (!o) return;
  prRemember();
  if (h == null) delete o.pick;
  else o.pick = h;
  prSave();
  prRenderInspector();
  prSchedule();
}

/* The palette: the head popover (slice-ui.js openSwatches), each head
   with the spool it holds, at (x, y) or under `anchor`; "the plate's
   colours" below once a head is picked. A single head is no choice: it is
   taken at once. */
function prColourPalette(o, x, y, anchor = null) {
  if (!o) return;
  const pid = headsActive(), slots = headsSlots(pid), n = headsCount(pid);
  const pal = plPalette(o.pick, n);
  if (pal.single && !pal.plate && !headsVirtual(pid).length) return prSetPick(o, 0);
  const list = headsVirtual(pid);
  openSwatches(anchor || { x, y }, {
    entries: swHeads({ count: pal.heads.length, slots }),
    virtual: list.length ? vsEntries(pid) : null,
    value: o.pick == null || vhOrphan(list, o.pick) ? null : String(o.pick),
    label: tr("prepare.menu.colour"),
    note: slots.length ? "" : tr("swatch.connect"),
    foot: pal.plate ? { label: tr("prepare.colour.plate"), onClick: () => (closePicker(true), prSetPick(o, null)) } : null,
    onPick: (v) => prSetPick(o, +v),
  });
  PK.prep = true;
}
/* The palette goes with what it was opened on. */
const prPaletteClose = () => PK.prep && PK.grid && closePicker();

/* "Colour…" from a menu: the palette in "by colour" mode; in "by object"
   mode the object's colour/heads frame, unfolded in the list. */
function prColourAction(o, x, y) {
  if (!o) return;
  if (PR.assoc === "colour") return prColourPalette(o, x, y);
  PR.fold.delete(o.id);
  if (PRUI.listFolded) {
    PRUI.listFolded = false;
    pruiSave();
  }
  prSelect([o.id], false);
}

/* "By colour" mode: the banner above the list, one row per colour of the
   plate with the same head tokens as an object's frame. */
function prColourBanner(live, slots, n) {
  const cols = prPlateColours();
  if (!cols.length) return "";
  const rows = cols
    .map(({ ext, kind, color }) => {
      const cur = PR.colourHeads[ext];
      // Never chosen, or its virtual head deleted since.
      const orphan = vhOrphan(headsVirtual(live ? headsActive() : ""), cur);
      const unmapped = cur == null || orphan;
      const tokens = live ? prHeadToken(unmapped ? null : cur, { slots, n, own: true, attrs: ` data-ch="${ext}"` }) : "";
      const label = tr("slice.color_n", { n: ext });
      return `<div class="p-color${unmapped ? " unmapped" : ""}" title="${esc([label, kind, color].filter(Boolean).join(" · "))}">
        <span class="p-sw" style="background:${esc(color || "#999")}"></span>
        <span class="p-color-lbl">${esc(label)}${unmapped ? ` <span class="tag warn">${esc(tr(orphan ? "prepare.no_head" : "prepare.assoc.unmapped"))}</span>` : ""}</span>
        <span class="p-toks">${tokens}</span>
      </div>`;
    })
    .join("");
  return `<div class="p-grp p-colours">
      <div class="p-grp-head"><span class="k">${esc(tr("prepare.assoc.colours", { n: cols.length }))}</span></div>
      <div class="group">${rows}</div>
    </div>`;
}

/* A colour of the plate goes to head `h`, for every object. Not an undo
   step: the history holds the objects, not the plate's mapping. */
function prSetColourHead(ext, h) {
  PR.colourHeads = { ...PR.colourHeads, [ext]: h };
  prSave();
  prRenderInspector();
  prSchedule(); // the objects on the plate take the colour
}

/* Changing mode: explained once (a sheet, until dismissed for good),
   then applied with its hand-off of the associations. */
function prAssocSwitch(mode) {
  if (mode === PR.assoc) return;
  if (!PRUI.assocExplained) {
    PR.assocPending = mode;
    $("assoc-noshow").checked = false;
    openSheet($("assocmodal"));
    return;
  }
  prAssocApply(mode);
}

/* Object → colour: a colour every on-plate object sends to the same head
   (chosen or deduced) keeps it, one they disagree on waits for a choice.
   Colour → object: each on-plate object takes the plate's heads as its
   own. One undo step for the objects' heads; the mode itself is not undone. */
function prAssocApply(mode) {
  if (mode === PR.assoc) return;
  prRemember();
  if (mode === "colour") {
    // Only the objects that bring colours to the banner vote: an
    // uncoloured one (its colour is a stand-in) or one with a picked head
    // would otherwise weigh on colour 1.
    const effective = (o) =>
      prBannerColours(o).length ? Object.fromEntries(Object.entries(prHeads(o)).map(([ext, v]) => [ext, v.h])) : {};
    PR.colourHeads = plMigrateToColour(PR.objects, bedState, effective, plPlateColours(PR.objects, bedState, prBannerColours));
  } else {
    const heads = plMigrateToObject(PR.objects, bedState, prBannerColours, PR.colourHeads);
    for (const o of PR.objects) {
      if (heads[o.id]) o.heads = heads[o.id];
      // A head picked for the whole object becomes its choice for each colour.
      if (o.pick != null && bedState(o) !== "out") o.heads = Object.fromEntries(prColors(o).map((ext) => [ext, o.pick]));
    }
  }
  PR.assoc = mode;
  prSave();
  prRenderInspector();
  prSchedule();
}

/* A color of one object goes to head `h`; choosing the default forgets the
   object's own choice. */
function prSetHead(o, ext, h) {
  if (!o) return;
  prRemember();
  const dflt = prHeads({ ...o, heads: {} })[ext]?.h;
  o.heads = { ...(o.heads || {}) };
  if (h === dflt) delete o.heads[ext];
  else o.heads[ext] = h;
  prSave();
  prRenderInspector();
  prSchedule();
}

/* Plates saved before painted colors were read: their colors are read again. */
const COLORS_VERSION = 2;
async function prRefreshColors() {
  const old = PR.objects.filter((o) => o.cv !== COLORS_VERSION);
  if (!old.length) return;
  for (const path of new Set(old.map((o) => o.path))) {
    const items = await invoke("plate_items", { path }).catch(() => null);
    if (!items) continue;
    for (const o of old.filter((x) => x.path === path)) {
      const it = items.find((x) => x.index === o.item);
      if (it) o.extruders = it.extruders;
      o.cv = COLORS_VERSION;
    }
  }
  prSave();
}

/* The head showing each colour of an object on the plate, in the current
   mode: "by object", the object's (chosen or deduced); "by colour", the
   head picked for the object, else the plate's for that colour — an
   unmapped colour has none, and keeps the file's colour as a cue. */
function prShownHeads(o, pid, slots) {
  if (PR.assoc !== "colour") return Object.fromEntries(Object.entries(prHeads(o, pid, slots)).map(([ext, v]) => [ext, v.h]));
  const out = {};
  for (const ext of prColors(o)) {
    const h = o.pick != null ? o.pick : PR.colourHeads[ext];
    if (h != null) out[ext] = h;
  }
  return out;
}

/* Spool color of each color of an object, for the shader. */
function prHeadColors(gl, o, mesh) {
  const col = new Float32Array(17 * 3), on = new Float32Array(17);
  const pid = typeof headsActive === "function" ? headsActive() : "";
  if (pid) {
    const slots = headsSlots(pid);
    for (const [ext, h] of Object.entries(prShownHeads(o, pid, slots))) {
      // A virtual head shows its mix; an orphan keeps the file's color.
      const rgb = hexToRgb(headsColorOf(pid, h));
      if (!rgb || ext > 16) continue;
      on[ext] = 1;
      col.set(rgb.map((v) => v / 255), ext * 3);
    }
  }
  gl.uniform3fv(gl.getUniformLocation(PR.prog, "uHeadCol"), col);
  gl.uniform1fv(gl.getUniformLocation(PR.prog, "uHeadOn"), on);
  const loc = gl.getAttribLocation(PR.prog, "aExt");
  // No color per triangle (STL, older meshes): one-color objects follow
  // their single color, others keep the file's colors.
  const colors = prColors(o);
  if (loc >= 0 && !mesh.hasExt) gl.vertexAttrib1f(loc, colors.length === 1 ? colors[0] : 0);
}

/* Printer whose spools color the list, when there are several: chips
   (slice-ui.js printerChips) over the hidden select, which stays the
   source of truth. */
function prRenderPrinter() {
  const box = $("p-printer");
  if (!box || typeof headsActive !== "function") return;
  const printers = typeof P !== "undefined" ? P.list : [];
  $("p-printers").classList.toggle("hidden", printers.length < 2);
  if (printers.length < 2) return;
  const pid = headsActive();
  box.innerHTML = printers.map((p) => `<option value="${esc(p.id)}"${p.id === pid ? " selected" : ""}>${esc(p.name || p.host)}</option>`).join("");
  $("p-printers").innerHTML = printerChips(printers, pid);
}
$("p-printers").addEventListener("click", (e) => {
  const b = e.target.closest("[data-printer]");
  if (b && !b.disabled) setSelect($("p-printer"), b.dataset.printer);
});
$("p-list").addEventListener("scroll", () => prPaletteClose(), { passive: true });
$("p-printer")?.addEventListener("change", (e) => {
  headsSetActive(e.target.value, "prepare");
  prRefreshSpools();
});

/* The machine profile's head count, for a printer whose spools are not
   known (yet): loaded here when the slice sheet has not been opened. */
async function prEnsureLists() {
  if (typeof SL === "undefined" || SL.lists) return;
  const pid = typeof headsActive === "function" ? headsActive() : "";
  const lists = await invoke("slice_lists", { machine: SL.memory["printer:" + pid] || SL.memory.last || null }).catch(() => null);
  if (!lists || SL.lists) return;
  SL.lists = lists;
  prRenderInspector();
  prSchedule();
}

/* The active printer's spools, asked when Prepare shows: otherwise they were
   only known once the Printers tab, the heads view or the slice sheet had
   asked, and the head buttons stayed gray. The list and the 3D view follow
   when the answer changes them (headschange). */
function prRefreshSpools() {
  if (typeof headsActive !== "function") return;
  const pid = headsActive();
  if (pid) headsRefreshSlots(pid);
}
window.addEventListener("headschange", (e) => {
  if (window.currentView !== "prepare") return;
  // A mix's color from the engine: only colors change, the choices do
  // not; an open popover stays (the list is redrawn once it closes).
  if (e.detail?.what === "mix") {
    prSchedule();
    if (!(PK.prep && PK.grid && !$("picker").classList.contains("hidden"))) prRenderInspector();
    return;
  }
  prPaletteClose();
  prRenderInspector();
  prSchedule();
});
