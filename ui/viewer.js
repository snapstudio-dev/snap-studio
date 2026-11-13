"use strict";
/* 3D viewer.
   The mesh is served as binary by Rust (mesh:// protocol); rendering is
   done in WebGL2 with no library: flat shading computed from screen
   derivatives, so no normals to carry. */

const V = {
  gl: null,
  /* Called on close when someone borrowed the viewer. */
  onClose: null,
  mesh: null,       // { prog, vao, count, min, max, truncated }
  paths: null,      // G-code toolpaths
  layer: 0,         // highest layer shown
  showTravel: false,
  grid: null,       // { prog, vao, count }
  bed: null,        // plate and logo, see buildBed
  cam: { yaw: -0.62, pitch: 0.46, dist: 260, target: [0, 0, 0] },
  drag: null,
  path: null,
  showPlate: true,
  frameWithBed: false, // framing includes the bed when shown (AI preview)
  raf: 0,
  /* Slice preview in progress: summary, head colors, actions. */
  preview: null,
  /* "material": filament color shaded by feature (default);
     "feature": one color per path type; "tool": plain color per head. */
  colorMode: "material",
  /* Filament colors written in the G-code ([r,g,b] or null per head). */
  fileColors: [],
};

/* Fallback head colors, when the spool is not known. */
const TOOL_COLORS = [[0, 122, 255], [255, 149, 0], [52, 199, 89], [175, 82, 222]];

/* Snapmaker U1 bed, in millimeters. */
const PLATE = { w: 270, d: 270, step: 10 };

/* ---------------------------------------------------------------- matrices */

const m4 = {
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] =
          a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  },
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    const o = new Float32Array(16);
    o[0] = f / aspect;
    o[5] = f;
    o[10] = (far + near) / (near - far);
    o[11] = -1;
    o[14] = (2 * far * near) / (near - far);
    return o;
  },
  lookAt(eye, center, up) {
    const z = norm3(sub3(eye, center));
    const x = norm3(cross3(up, z));
    const y = cross3(z, x);
    return new Float32Array([
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1,
    ]);
  },
};
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/* ---------------------------------------------------------------- shaders */

const MESH_VS = `#version 300 es
in vec3 aPos;
in vec3 aCol;
uniform mat4 uMVP;
uniform mat4 uMV;
out vec3 vCol;
out vec3 vPosV;
void main() {
  vCol = aCol;
  vPosV = (uMV * vec4(aPos, 1.0)).xyz;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const MESH_FS = `#version 300 es
precision highp float;
in vec3 vCol;
in vec3 vPosV;
out vec4 frag;
void main() {
  // Normal rebuilt from the surface: flat shading, no normals carried.
  vec3 n = normalize(cross(dFdx(vPosV), dFdy(vPosV)));
  if (n.z < 0.0) n = -n;
  vec3 key = normalize(vec3(-0.45, 0.72, 0.58));
  vec3 fill = normalize(vec3(0.75, -0.15, 0.35));
  float diff = max(dot(n, key), 0.0);
  float fl = max(dot(n, fill), 0.0) * 0.22;
  float amb = 0.32 + 0.16 * (n.z * 0.5 + 0.5);
  float rim = pow(1.0 - clamp(n.z, 0.0, 1.0), 3.0) * 0.45;
  vec3 h = normalize(key + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(n, h), 0.0), 26.0) * 0.28;
  vec3 c = vCol * (amb + diff * 0.82 + fl) + spec + rim * vec3(0.82, 0.86, 1.0);
  frag = vec4(c, 1.0);
}`;

/* Width assumed when the G-code does not say (mm). */
const DEFAULT_WIDTH = 0.42;
/* The encoded heights' step (mm, gcode.rs HEIGHT_STEP). */
const HEIGHT_STEP = 0.005;

/* The toolpath buffer's segments as read by the shaders, straight from the
   buffer gcode.rs writes (one instance per segment): both ends quantized
   in the box `uOrigin` + `uSpan`, then the feature, head, width
   (1/100 mm) and height (HEIGHT_STEP) as bytes. The color comes from the
   palette, a texture of one texel per head (column) and feature (row):
   changing the color mode rewrites 192 texels, not the segments. `uFixed`
   (alpha 1) paints them all one color: the travel moves. Their locations
   are fixed (SEG_ATTRS), so one vertex array serves every program. */
const SEG_ATTRS = ["aA", "aB", "aFeat", "aTool", "aW", "aH"];
const SEG_GLSL = `
in vec3 aA;
in vec3 aB;
in uint aFeat;
in uint aTool;
in uint aW;
in uint aH;
uniform vec3 uOrigin;
uniform vec3 uSpan;
uniform highp sampler2D uPal;
uniform vec4 uFixed;
vec3 segPos(vec3 q) { return uOrigin + q * uSpan; }
vec3 segCol() {
  if (uFixed.a > 0.0) return uFixed.rgb;
  return texelFetch(uPal, ivec2(int(min(aTool, 15u)), int(min(aFeat, 11u))), 0).rgb;
}
float segWidth() { return aW > 0u ? float(aW) / 100.0 : ${DEFAULT_WIDTH.toFixed(2)}; }
float segHeight() { return float(aH) * ${HEIGHT_STEP.toFixed(3)}; }
`;

/* Plain lines: two vertices per instance, a then b. */
const PATH_VS = `#version 300 es
${SEG_GLSL}
uniform mat4 uMVP;
out vec3 vCol;
void main() {
  vCol = segCol();
  gl_Position = uMVP * vec4(segPos(gl_VertexID == 0 ? aA : aB), 1.0);
}`;

const PATH_FS = `#version 300 es
precision highp float;
in vec3 vCol;
uniform float uAlpha;
out vec4 frag;
void main() { frag = vec4(vCol, uAlpha); }`;

/* Extrusions as ribbons: each segment (one instance) becomes a quad facing
   the camera, shaded like a cylinder — light in the middle, dark at the
   edges. Its size is the extrusion's cross-section, as Snapmaker Orca draws
   it: an ellipse `w` wide and `h` high (the layer's or sub-layer's height),
   its top at the segment's Z. The quad spans that ellipse's outline as seen
   from the eye, so a line seen from the side is as tall as its layer, never
   as tall as it is wide: the alternating layers of a virtual head show as
   thin bands, not overlapping strips. One pixel wide at least. The same
   buffer as the lines (no copy). */
const RIB_VS = `#version 300 es
${SEG_GLSL}
uniform mat4 uMVP;
uniform vec2 uViewport;
uniform vec3 uEye;
out vec3 vCol;
out float vSide;
void main() {
  // Six vertices: two triangles; t along the segment, s across.
  int id = gl_VertexID;
  float t = (id == 1 || id == 2 || id == 4) ? 1.0 : 0.0;
  float s = (id == 2 || id == 4 || id == 5) ? 1.0 : -1.0;
  vec3 A = segPos(aA), B = segPos(aB);
  float aW = segWidth(), aH = segHeight();
  vec3 seg = B - A;
  float len = length(seg);
  vec3 d = len > 1e-6 ? seg / len : vec3(1.0, 0.0, 0.0);
  // The cross-section's axes: n across (horizontal), u up.
  vec3 n = cross(d, vec3(0.0, 0.0, 1.0));
  n = length(n) > 1e-4 ? normalize(n) : vec3(1.0, 0.0, 0.0);
  vec3 u = cross(n, d);
  float hw = 0.5 * aW;
  // A height not known: as tall as wide (the round line of before).
  float hh = 0.5 * (aH > 0.0 ? aH : aW);
  // Its top at the segment's Z, its ends past the segment by a half-width
  // along it (joints overlap).
  vec3 c = mix(A, B, t) - u * hh + d * (t * 2.0 - 1.0) * hw;
  // The ellipse's outline seen from the eye: the point of the ellipse
  // furthest along e, across the line and the view.
  vec3 e = cross(d, uEye - c);
  e = length(e) > 1e-6 ? normalize(e) : n;
  float en = dot(e, n), eu = dot(e, u);
  vec3 off = (hw * hw * en * n + hh * hh * eu * u) / max(1e-6, sqrt(hw * hw * en * en + hh * hh * eu * eu));
  vec4 pc = uMVP * vec4(c, 1.0);
  vec4 p = uMVP * vec4(c + off * s, 1.0);
  // One pixel wide at least: a line far away does not vanish.
  vec2 px = (p.xy / p.w - pc.xy / pc.w) * uViewport;
  if (length(px) < 0.5) {
    vec4 pa = uMVP * vec4(A, 1.0), pb = uMVP * vec4(B, 1.0);
    vec2 dir = pb.xy / pb.w - pa.xy / pa.w;
    dir = length(dir) > 1e-6 ? normalize(dir * uViewport) : vec2(1.0, 0.0);
    vec2 side = length(px) > 1e-4 ? normalize(px) : vec2(-dir.y, dir.x) * s;
    p = vec4((pc.xy / pc.w + side * 0.5 / uViewport) * p.w, p.z, p.w);
  }
  gl_Position = p;
  vCol = segCol();
  vSide = s;
}`;

const RIB_FS = `#version 300 es
precision highp float;
in vec3 vCol;
in float vSide;
out vec4 frag;
void main() {
  float c = sqrt(max(0.0, 1.0 - vSide * vSide));
  vec3 col = vCol * (0.45 + 0.6 * c) + pow(c, 12.0) * 0.18;
  frag = vec4(col, 1.0);
}`;

/* Beyond this, back to plain lines, which show no relief. The ribbons are
   drawn from the same buffer as the lines (no memory of their own), so
   this is the Rust cap (gcode.rs MAX_SEGS): a long print keeps its shading
   now that all its layers are kept. */
const RIBBON_MAX = 10_000_000;
/* The travel moves' color. */
const TRAVEL_RGB = [96, 104, 126];

/* Feature keys and colors, the same as the thumbnails computed in Rust. */
const FEATURES = [
  ["other", [150, 158, 175]],
  ["outer_wall", [232, 108, 62]],
  ["inner_wall", [236, 168, 84]],
  ["top", [226, 84, 106]],
  ["bottom", [120, 170, 226]],
  ["infill", [150, 120, 214]],
  ["solid_infill", [98, 186, 160]],
  ["bridge", [70, 150, 235]],
  ["support", [120, 132, 154]],
  ["skirt", [214, 200, 96]],
  ["prime_tower", [180, 120, 190]],
  ["overhang", [242, 96, 96]],
];
const featureName = (i) => tr("feature." + FEATURES[Math.min(i, FEATURES.length - 1)][0]);

const LINE_VS = `#version 300 es
in vec3 aPos;
in float aMain;
uniform mat4 uMVP;
out float vMain;
void main() {
  vMain = aMain;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const LINE_FS = `#version 300 es
precision highp float;
in float vMain;
uniform vec3 uColor;
out vec4 frag;
void main() { frag = vec4(uColor, mix(0.22, 0.65, vMain)); }`;

function compile(gl, src, type) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error("shader: " + gl.getShaderInfoLog(s));
  }
  return s;
}

/* `attrs`: attribute names bound to locations 0, 1, … */
function program(gl, vs, fs, attrs = []) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, vs, gl.VERTEX_SHADER));
  gl.attachShader(p, compile(gl, fs, gl.FRAGMENT_SHADER));
  attrs.forEach((a, i) => gl.bindAttribLocation(p, i, a));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error("link: " + gl.getProgramInfoLog(p));
  }
  return p;
}

/* ---------------------------------------------------------------- data */

/* Decodes the buffer produced by `mesh::encode` in Rust. */
function decodeMesh(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "3MFM") throw new Error("unexpected mesh format");
  const truncated = (dv.getUint8(5) & 1) === 1;
  const n = dv.getUint32(8, true);
  const min = [dv.getFloat32(12, true), dv.getFloat32(16, true), dv.getFloat32(20, true)];
  const max = [dv.getFloat32(24, true), dv.getFloat32(28, true), dv.getFloat32(32, true)];
  const pos = new Float32Array(buf, 36, n * 9);
  const triCol = new Uint8Array(buf, 36 + n * 36, n * 3);
  // One color per triangle: copied onto its three vertices.
  const col = new Uint8Array(n * 9);
  for (let i = 0; i < n; i++) {
    const r = triCol[i * 3], g = triCol[i * 3 + 1], b = triCol[i * 3 + 2];
    for (let k = 0; k < 3; k++) {
      col[i * 9 + k * 3] = r;
      col[i * 9 + k * 3 + 1] = g;
      col[i * 9 + k * 3 + 2] = b;
    }
  }
  // Version 2 (flag bit 1): the model extruder of each triangle follows,
  // copied onto its vertices. A v1 buffer has none.
  let ext = null;
  if ((dv.getUint8(5) & 2) === 2 && buf.byteLength >= 36 + n * 40) {
    const triExt = new Uint8Array(buf, 36 + n * 39, n);
    ext = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) ext[i * 3] = ext[i * 3 + 1] = ext[i * 3 + 2] = triExt[i];
  }
  return { n, min, max, pos, col, truncated, ext };
}

/* Decodes the buffer produced by `gcode::encode` (version 4, 68-byte
   header): segments sorted by layer, each the 16 bytes the shaders read
   (`segs`, sent to the GPU as is), then the filament colors. The small
   arrays are copied, so the buffer goes once on the GPU. */
function decodeGcode(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "3MFG" || dv.getUint8(4) !== 4) throw new Error("unexpected toolpath format");
  const flags = dv.getUint8(5);
  const featMask = dv.getUint16(6, true);
  const n = dv.getUint32(8, true);
  const layers = dv.getUint32(12, true);
  const f3 = (o) => [0, 1, 2].map((i) => dv.getFloat32(o + i * 4, true));
  const toolMask = dv.getUint16(64, true);
  // Per layer: where its segments end (all the layers below included), and
  // the top of its extrusions (the one below for a layer without).
  const ends = new Uint32Array(buf.slice(68, 68 + layers * 4));
  const layerZ = new Float32Array(buf.slice(68 + layers * 4, 68 + layers * 8));
  const pos = 68 + layers * 8;
  const fileColors = [];
  let o = pos + n * 16;
  const k = dv.getUint8(o++);
  for (let i = 0; i < k; i++, o += 4) {
    fileColors.push(dv.getUint8(o) ? [dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3)] : null);
  }
  const bits = (m) => [...Array(16).keys()].filter((b) => m & (1 << b));
  return {
    n,
    layers,
    min: f3(16),
    max: f3(28),
    origin: f3(40),
    span: f3(52),
    simplified: (flags & 1) === 1,
    travel: (flags & 2) === 2,
    ends,
    layerZ,
    segs: new Uint8Array(buf, pos, n * 16),
    fileColors,
    feats: [...new Set(bits(featMask).map((f) => Math.min(f, FEATURES.length - 1)))],
    tools: bits(toolMask),
  };
}

/* Color of a head: spool read on the printer (slice preview), otherwise
   the one the slicer wrote in the G-code, otherwise the palette. */
function toolRgb(t) {
  return V.preview?.toolColors?.[t] || V.fileColors?.[t] || TOOL_COLORS[t % TOOL_COLORS.length];
}

/* "Material" mode: the filament color, shaded by feature to keep the
   structure readable. `k` darkens, `w` lightens towards white, `g`
   desaturates towards grey. Indices into `FEATURES`. */
const MATERIAL_SHADE = [
  { k: 0.85 }, // other
  { k: 1 }, // outer wall
  { k: 0.8 }, // inner wall
  { w: 0.18 }, // top surface
  { k: 0.9 }, // bottom surface
  { k: 0.62 }, // infill
  { k: 0.74 }, // solid infill
  { w: 0.12 }, // bridge
  { g: 0.75, k: 0.78 }, // support
  { k: 0.88 }, // skirt and brim
  { g: 0.6, k: 0.72 }, // prime tower
  { w: 0.06 }, // overhang
];

function shade(rgb, feat) {
  let [r, g, b] = rgb.map((x) => x / 255);
  const sh = MATERIAL_SHADE[feat] || {};
  // A very dark filament gets a little lighter: otherwise its shades vanish.
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (lum < 0.12) [r, g, b] = [r, g, b].map((x) => x + (0.12 - lum));
  if (sh.g) {
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    [r, g, b] = [r, g, b].map((x) => x + (l - x) * sh.g);
  }
  if (sh.w) [r, g, b] = [r, g, b].map((x) => x + (1 - x) * sh.w);
  if (sh.k) [r, g, b] = [r, g, b].map((x) => x * sh.k);
  return [r, g, b].map((x) => Math.max(0, Math.min(1, x)) * 255);
}

/* The palette by mode, one texel per head (16 columns) and feature (12
   rows): material (default), path feature, or head in plain color. */
function palette(mode) {
  const px = new Uint8Array(16 * FEATURES.length * 4);
  for (let f = 0; f < FEATURES.length; f++) {
    for (let t = 0; t < 16; t++) {
      const c = mode === "material" ? shade(toolRgb(t), f) : mode === "tool" ? toolRgb(t) : FEATURES[f][1];
      px.set([...c.map(Math.round), 255], (f * 16 + t) * 4);
    }
  }
  return px;
}

/* Palette texture on unit 1 (the bed's is on unit 0). */
function uploadPalette(gl, tex, mode) {
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 16, FEATURES.length, 0, gl.RGBA, gl.UNSIGNED_BYTE, palette(mode));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.activeTexture(gl.TEXTURE0);
}

function setColorMode(mode) {
  V.colorMode = mode;
  const p = V.paths;
  if (!p) return;
  uploadPalette(V.gl, p.pal, mode);
  document.querySelectorAll("#v-colors [data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  renderLegend(p.feats);
  schedule();
}

/* One decoded buffer on the GPU: its bytes as they came, one instance per
   segment. */
function buildSegments(gl, d) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, d.segs, gl.STATIC_DRAW);
  const n = d.n;
  // Ends a then b, normalized: 12 bytes per segment.
  for (const [loc, off] of [[0, 0], [1, 6]]) {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.UNSIGNED_SHORT, true, 12, off);
    gl.vertexAttribDivisor(loc, 1);
  }
  // Feature, head, width, height: a byte each, one array after the other.
  for (let a = 0; a < 4; a++) {
    gl.enableVertexAttribArray(2 + a);
    gl.vertexAttribIPointer(2 + a, 1, gl.UNSIGNED_BYTE, 0, n * (12 + a));
    gl.vertexAttribDivisor(2 + a, 1);
  }
  gl.bindVertexArray(null);
  return { vao, buf, ends: d.ends, origin: d.origin, span: d.span };
}

function buildPaths(gl, data) {
  const prog = program(gl, PATH_VS, PATH_FS, SEG_ATTRS);
  // Shaded ribbons, except for a huge G-code: plain lines.
  const ribbons = data.n <= RIBBON_MAX ? program(gl, RIB_VS, RIB_FS, SEG_ATTRS) : null;
  const pal = gl.createTexture();
  uploadPalette(gl, pal, V.colorMode);
  return {
    prog,
    ribbons,
    pal,
    extr: buildSegments(gl, data),
    // Loaded when first shown (loadTravel).
    trav: null,
    travLoading: false,
    min: data.min,
    max: data.max,
    layers: data.layers,
    layerZ: data.layerZ,
    simplified: data.simplified,
    n: data.n,
    feats: data.feats,
    tools: data.tools,
  };
}

/* The travel moves, fetched the first time they are shown. */
function loadTravel() {
  const p = V.paths;
  if (!p || p.trav || p.travLoading) return;
  p.travLoading = true;
  fetchBinary("gcode", V.path, V.bust, "&t=1")
    .then((buf) => {
      if (V.paths !== p) return;
      p.trav = buildSegments(V.gl, decodeGcode(buf));
      schedule();
    })
    .catch((e) => {
      p.travLoading = false;
      console.warn("travel moves:", e);
    });
}

function buildMesh(gl, data) {
  const prog = program(gl, MESH_VS, MESH_FS);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const pb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, pb);
  gl.bufferData(gl.ARRAY_BUFFER, data.pos, gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);

  const cb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, cb);
  gl.bufferData(gl.ARRAY_BUFFER, data.col, gl.STATIC_DRAW);
  const aCol = gl.getAttribLocation(prog, "aCol");
  gl.enableVertexAttribArray(aCol);
  gl.vertexAttribPointer(aCol, 3, gl.UNSIGNED_BYTE, true, 0, 0);

  gl.bindVertexArray(null);
  // The buffers are kept to be freed: deleting a VAO does not free them.
  return { prog, vao, bufs: [pb, cb], count: data.n * 3, min: data.min, max: data.max, truncated: data.truncated };
}

/* Bed grid: lines every 10 mm, emphasized border. */
function buildGrid(gl, w = PLATE.w, d = PLATE.d) {
  const pos = [];
  const main = [];
  const line = (a, b, strong) => {
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    main.push(strong, strong);
  };
  for (let x = 0; x <= w + 1e-6; x += PLATE.step) {
    line([x, 0, 0], [x, d, 0], x % 50 === 0 ? 1 : 0);
  }
  for (let y = 0; y <= d + 1e-6; y += PLATE.step) {
    line([0, y, 0], [w, y, 0], y % 50 === 0 ? 1 : 0);
  }
  // Border: the bed keeps a sharp outline even off the 10 mm step.
  line([0, 0, 0], [w, 0, 0], 1);
  line([w, 0, 0], [w, d, 0], 1);
  line([w, d, 0], [0, d, 0], 1);
  line([0, d, 0], [0, 0, 0], 1);
  const prog = program(gl, LINE_VS, LINE_FS);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const pb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, pb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pos), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
  const mb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, mb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(main), gl.STATIC_DRAW);
  const aMain = gl.getAttribLocation(prog, "aMain");
  gl.enableVertexAttribArray(aMain);
  gl.vertexAttribPointer(aMain, 1, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return { prog, vao, bufs: [pb, mb], count: pos.length / 3 };
}

/* Frees a drawable (VAO, its buffers, its program): a VAO deleted alone
   leaves its buffers on the GPU. */
function disposeDrawable(gl, d) {
  if (!d) return;
  gl.deleteVertexArray(d.vao);
  for (const b of d.bufs || []) gl.deleteBuffer(b);
  gl.deleteProgram(d.prog);
}

/* ---------------------------------------------------------------- physical bed */

/* Known plates, from Snapmaker Orca's profiles (`bed_model`, `bed_texture`
   of the printer model): plate mesh, logo. */
const BED_ASSETS = {
  "Snapmaker U1": { model: "assets/bed/u1-bed.stl", texture: "assets/bed/u1-texture.svg" },
};
/* Orca's colors: plate (Bed3D), printable area (PartPlate), lines. */
const BED_COLORS = { plate: [0.3255, 0.337, 0.337], area: [0.267, 0.278, 0.278], grid: [0.62, 0.64, 0.64] };
/* Orca lowers the plate under the bed so it does not hide the grid. */
const BED_MODEL_Z = -0.43;

const TEX_VS = `#version 300 es
in vec3 aPos;
in vec2 aUV;
uniform mat4 uMVP;
out vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const TEX_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec4 uColor;
uniform bool uUseTex;
out vec4 frag;
void main() { frag = uUseTex ? texture(uTex, vUV) * uColor : uColor; }`;

/* Plate files, read once for all graphics contexts. */
const BED_FILES = new Map();
function bedFile(url, load) {
  if (!BED_FILES.has(url)) BED_FILES.set(url, load(url));
  return BED_FILES.get(url);
}

/* Binary STL: 80-byte header, the facet count, then 50 bytes per facet
   (normal, three vertices, attribute). */
async function loadStl(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(tr("err.http_status", { status: r.status }));
  const buf = await r.arrayBuffer();
  const dv = new DataView(buf);
  const n = dv.getUint32(80, true);
  if (84 + n * 50 > buf.byteLength) throw new Error("binary STL expected");
  const pos = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 9; k++) pos[i * 9 + k] = dv.getFloat32(84 + i * 50 + 12 + k * 4, true);
  }
  return pos;
}

function loadImage(url) {
  return new Promise((ok, ko) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => ko(new Error(`unreadable image: ${url}`));
    img.src = url;
  });
}

/* Bed of a known printer model, null otherwise. Files arrive later:
   `onReady` then asks for a new render. */
function buildBed(gl, w, d, model, onReady) {
  const a = BED_ASSETS[model];
  if (!a) return null;
  const bed = { w, d, model, plate: null, texture: null };

  // Printable area: backing for the background and the logo. The top of
  // the image goes to the back of the bed.
  bed.tex = program(gl, TEX_VS, TEX_FS);
  bed.quad = gl.createVertexArray();
  gl.bindVertexArray(bed.quad);
  const qb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, qb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    0, 0, 0, 0, 1, w, 0, 0, 1, 1, w, d, 0, 1, 0,
    0, 0, 0, 0, 1, w, d, 0, 1, 0, 0, d, 0, 0, 0,
  ]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(bed.tex, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 20, 0);
  const aUV = gl.getAttribLocation(bed.tex, "aUV");
  gl.enableVertexAttribArray(aUV);
  gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 20, 12);
  gl.bindVertexArray(null);
  bed.quadBuf = qb;

  // Plate: the manufacturer's mesh, centered on the printable area.
  bedFile(a.model, loadStl)
    .then((src) => {
      const pos = new Float32Array(src.length);
      for (let i = 0; i < src.length; i += 3) {
        pos[i] = src[i] + w / 2;
        pos[i + 1] = src[i + 1] + d / 2;
        pos[i + 2] = src[i + 2] + BED_MODEL_Z;
      }
      const prog = program(gl, MESH_VS, MESH_FS);
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const pb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, pb);
      gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
      const p = gl.getAttribLocation(prog, "aPos");
      gl.enableVertexAttribArray(p);
      gl.vertexAttribPointer(p, 3, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      const plate = { prog, vao, bufs: [pb], count: pos.length / 3, aCol: gl.getAttribLocation(prog, "aCol") };
      // The bed was replaced while its model loaded: nothing to keep.
      if (bed.disposed) {
        disposeDrawable(gl, plate);
        return;
      }
      bed.plate = plate;
      onReady?.();
    })
    .catch((e) => console.warn("plaque :", e.message));

  // Logo: the SVG is rasterized at 2048 px at most, as in Orca.
  bedFile(a.texture, loadImage)
    .then((img) => {
      const k = 2048 / Math.max(w, d);
      const cv = document.createElement("canvas");
      cv.width = Math.round(w * k);
      cv.height = Math.round(d * k);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      // Grazing view: anisotropic filtering keeps the logo sharp.
      const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
      if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
      gl.bindTexture(gl.TEXTURE_2D, null);
      if (bed.disposed) {
        gl.deleteTexture(tex);
        return;
      }
      bed.texture = tex;
      onReady?.();
    })
    .catch((e) => console.warn("bed logo:", e.message));
  return bed;
}

function disposeBed(gl, bed) {
  if (!bed) return;
  bed.disposed = true;
  gl.deleteVertexArray(bed.quad);
  if (bed.quadBuf) gl.deleteBuffer(bed.quadBuf);
  gl.deleteProgram(bed.tex);
  disposeDrawable(gl, bed.plate);
  if (bed.texture) gl.deleteTexture(bed.texture);
}

/* Bed, bottom to top as in Orca: plate, printable area, grid, logo. Only
   the plate writes depth; the rest is layered, and the objects, drawn
   afterwards, come in front. Without a known plate: the grid. */
function drawBed(gl, bed, grid, vp, view, light) {
  if (bed?.plate) {
    const p = bed.plate;
    gl.useProgram(p.prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(p.prog, "uMVP"), false, vp);
    gl.uniformMatrix4fv(gl.getUniformLocation(p.prog, "uMV"), false, view);
    gl.bindVertexArray(p.vao);
    gl.vertexAttrib3f(p.aCol, ...BED_COLORS.plate);
    gl.drawArrays(gl.TRIANGLES, 0, p.count);
  }
  gl.depthMask(false);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  if (bed) {
    gl.useProgram(bed.tex);
    gl.uniformMatrix4fv(gl.getUniformLocation(bed.tex, "uMVP"), false, vp);
    gl.uniform1i(gl.getUniformLocation(bed.tex, "uUseTex"), 0);
    gl.uniform4fv(gl.getUniformLocation(bed.tex, "uColor"), [...BED_COLORS.area, 1]);
    gl.bindVertexArray(bed.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  if (grid) {
    gl.useProgram(grid.prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(grid.prog, "uMVP"), false, vp);
    gl.uniform3fv(
      gl.getUniformLocation(grid.prog, "uColor"),
      bed ? BED_COLORS.grid : light ? [0.45, 0.48, 0.56] : [0.55, 0.6, 0.72]
    );
    gl.bindVertexArray(grid.vao);
    gl.drawArrays(gl.LINES, 0, grid.count);
  }
  if (bed?.texture) {
    // Premultiplied texture: logo edges without a dark fringe.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(bed.tex);
    gl.uniform1i(gl.getUniformLocation(bed.tex, "uUseTex"), 1);
    gl.uniform4fv(gl.getUniformLocation(bed.tex, "uColor"), [0.92, 0.92, 0.92, 0.92]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bed.texture);
    gl.uniform1i(gl.getUniformLocation(bed.tex, "uTex"), 0);
    gl.bindVertexArray(bed.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  gl.disable(gl.BLEND);
  gl.depthMask(true);
  gl.bindVertexArray(null);
}

/* ---------------------------------------------------------------- render */

/* The picture is cleared with the viewer's own CSS background
   (var(--content-bg)), so it melts into the screen around it, in light and
   dark alike. Read once, again after a theme change. */
let V_CLEAR = null;
function viewerClear() {
  if (!V_CLEAR) {
    const m = getComputedStyle($("viewer")).backgroundColor.match(/[\d.]+/g) || [];
    V_CLEAR = m.length >= 3 ? m.slice(0, 3).map((x) => +x / 255) : [0.953, 0.953, 0.961];
  }
  return V_CLEAR;
}

/* Pixels kept clear at the top of the picture: docked in the AI preview,
   the floating controls (ia.js sets V.insetTop). Full screen, none. */
function viewInsetTop() {
  return $("viewer").classList.contains("docked") ? V.insetTop || 0 : 0;
}

function frameCamera() {
  const m = V.paths || V.mesh;
  if (!m) return;
  let lo = m.min;
  let hi = m.max;
  // Asked by the AI preview: with the bed shown, the frame takes it in too;
  // bed hidden, the object alone, closer.
  if (V.frameWithBed && V.showPlate && !V.paths) {
    lo = [Math.min(lo[0], 0), Math.min(lo[1], 0), Math.min(lo[2], 0)];
    hi = [Math.max(hi[0], PLATE.w), Math.max(hi[1], PLATE.d), hi[2]];
  }
  V.cam.target = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1);
  // The field of view is vertical: a pane taller than wide would cut the
  // sides, so step back in proportion.
  // Under a band kept clear at the top, the object fits in what is left.
  const c = V.gl?.canvas;
  const ch = c?.clientHeight || 0;
  const free = Math.max(ch - viewInsetTop(), 1);
  const aspect = ch ? c.clientWidth / free : 1;
  V.cam.dist = size * 2.1 * (aspect < 1 ? 1 / aspect : 1) * (ch ? ch / free : 1);
  V.cam.yaw = -0.62;
  V.cam.pitch = 0.46;
  // Framed by the app: a resize may frame again (ia.js), until the user
  // turns, pans or zooms.
  V.framed = true;
  draw();
}

function draw() {
  const gl = V.gl;
  if (!gl) return;
  const canvas = gl.canvas;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  gl.viewport(0, 0, w, h);
  const light = !isDark();
  gl.clearColor(...viewerClear(), 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);

  const c = V.cam;
  const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
  const eye = add3(c.target, [
    c.dist * cp * Math.sin(c.yaw),
    -c.dist * cp * Math.cos(c.yaw),
    c.dist * sp,
  ]);
  const view = m4.lookAt(eye, c.target, [0, 0, 1]);
  const proj = m4.perspective(0.72, Math.max(w / Math.max(h, 1), 0.01), Math.max(c.dist / 100, 0.5), c.dist * 12 + 2000);
  // A band kept clear at the top: the picture's centre moves to the middle
  // of what is left below it.
  const top = viewInsetTop();
  if (top && canvas.clientHeight) proj[9] += top / canvas.clientHeight;
  const mvp = m4.mul(proj, view);

  if (V.showPlate && V.grid) drawBed(gl, V.bed, V.grid, mvp, view, light);

  if (V.paths) {
    const p = V.paths;
    const upto = Math.min(V.layer, p.layers - 1);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, p.pal);
    gl.activeTexture(gl.TEXTURE0);
    // The uniforms every segment program reads, for one buffer.
    const use = (prog, part, fixed) => {
      gl.useProgram(prog);
      const u = (name) => gl.getUniformLocation(prog, name);
      gl.uniformMatrix4fv(u("uMVP"), false, mvp);
      gl.uniform3fv(u("uOrigin"), part.origin);
      gl.uniform3fv(u("uSpan"), part.span);
      gl.uniform1i(u("uPal"), 1);
      gl.uniform4fv(u("uFixed"), fixed ? [...fixed.map((c) => c / 255), 1] : [0, 0, 0, 0]);
      gl.bindVertexArray(part.vao);
      return u;
    };
    if (V.showTravel && p.trav) {
      const u = use(p.prog, p.trav, TRAVEL_RGB);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(u("uAlpha"), 0.3);
      gl.drawArraysInstanced(gl.LINES, 0, 2, p.trav.ends[upto]);
      gl.disable(gl.BLEND);
    }
    if (p.ribbons) {
      const u = use(p.ribbons, p.extr);
      // Pixels per normalized screen unit, and the eye: the lines' outline.
      gl.uniform2f(u("uViewport"), w / 2, h / 2);
      gl.uniform3fv(u("uEye"), eye);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, p.extr.ends[upto]);
    } else {
      const u = use(p.prog, p.extr);
      gl.uniform1f(u("uAlpha"), 1);
      gl.drawArraysInstanced(gl.LINES, 0, 2, p.extr.ends[upto]);
    }
  }

  if (V.mesh) {
    gl.useProgram(V.mesh.prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(V.mesh.prog, "uMVP"), false, mvp);
    gl.uniformMatrix4fv(gl.getUniformLocation(V.mesh.prog, "uMV"), false, view);
    gl.bindVertexArray(V.mesh.vao);
    gl.drawArrays(gl.TRIANGLES, 0, V.mesh.count);
  }
  gl.bindVertexArray(null);
}

const schedule = () => {
  if (V.raf) return;
  V.raf = requestAnimationFrame(() => {
    V.raf = 0;
    draw();
  });
};
window.addEventListener("themechange", () => {
  V_CLEAR = null;
  schedule();
});

/* Depending on the platform, Tauri serves custom protocols in one form or
   the other: try both. */
async function fetchBinary(scheme, path, bust, extra = "") {
  const q =
    `/b?p=${encodeURIComponent(path)}` + (bust ? `&v=${encodeURIComponent(bust)}` : "") + extra;
  return fetchScheme(scheme, q);
}

/* ---------------------------------------------------------------- opening */

function disposeScene() {
  const gl = V.gl;
  if (!gl) return;
  if (V.mesh) {
    disposeDrawable(gl, V.mesh);
    V.mesh = null;
  }
  if (V.paths) {
    const p = V.paths;
    for (const part of [p.extr, p.trav].filter(Boolean)) {
      gl.deleteVertexArray(part.vao);
      gl.deleteBuffer(part.buf);
    }
    if (p.ribbons) gl.deleteProgram(p.ribbons);
    gl.deleteProgram(p.prog);
    gl.deleteTexture(p.pal);
    V.paths = null;
  }
}

/* Mouse controls reminder, following the wheel setting. */
function viewerHint() {
  const acts = { zoom: "viewer.wheel.zoom", pan: "viewer.wheel.pan", orbit: "viewer.wheel.orbit" };
  $("v-hint").textContent = tr("viewer.drag_hint") + " · " + tr(acts[state.wheelAction] || acts.zoom);
}

window.addEventListener("langchange", () => {
  if ($("viewer").classList.contains("hidden")) return;
  viewerHint();
  if (V.statsText) showStats();
  if (V.paths) {
    updateLayerLabel();
    renderLegend(V.paths.feats);
  }
  if (V.preview) renderPreviewPanel();
});

async function openViewer(path, name, kind, bust) {
  const box = $("viewer");
  box.classList.remove("hidden");
  $("v-name").textContent = name || "";
  $("v-stats").textContent = "";
  $("v-msg").textContent = tr("viewer.loading_mesh");
  $("v-msg").classList.remove("hidden");
  viewerHint();
  V.path = path;
  V.bust = bust;
  V.statsText = null;
  V.statsTip = null;
  $("v-stats").title = "";

  const canvas = $("v-canvas");
  if (!V.gl) {
    V.gl = canvas.getContext("webgl2", { antialias: true, depth: true });
    if (!V.gl) {
      $("v-msg").textContent = tr("viewer.no_webgl");
      return;
    }
    V.grid = buildGrid(V.gl);
    V.bed = buildBed(V.gl, PLATE.w, PLATE.d, "Snapmaker U1", schedule);
    bindInteractions(canvas);
  }

  const gcode = kind === "gcode";
  // A slice preview keeps its panel; an ordinary opening clears it.
  if (!V.preview || V.preview.path !== path) hidePreviewPanel();
  $("v-layers").classList.toggle("hidden", !gcode);
  $("v-legend").classList.toggle("hidden", !gcode);
  $("v-travel-sw").classList.toggle("hidden", !gcode);
  $("v-colors").classList.toggle("hidden", !gcode);

  try {
    const buf = await fetchBinary(gcode ? "gcode" : "mesh", path, bust);
    if (V.path !== path) return;
    disposeScene();
    const dim = (mn, mx) =>
      [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]]
        .map((x) => fmtDec(x, 1))
        .join(" × ") + " mm";

    if (gcode) {
      const data = decodeGcode(buf);
      // Colors written by the slicer: base of the "Material" mode.
      V.fileColors = data.fileColors;
      // G-code colors known: the preview panel picks them up.
      if (V.preview && V.preview.path === path) renderPreviewPanel();
      V.paths = buildPaths(V.gl, data);
      if (V.showTravel) loadTravel();
      document.querySelectorAll("#v-colors [data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === V.colorMode));
      V.layer = data.layers - 1;
      setupLayerSlider(data);
      renderLegend(data.feats);
      V.statsText = () =>
        `${dim(data.min, data.max)} · ${tr("viewer.layers", { n: data.layers })} · ` +
        tr("viewer.segments", { n: data.n }) + (data.simplified ? " · " + tr("viewer.simplified") : "");
      // A very long print: every layer, less detail; said on hover.
      if (data.simplified) V.statsTip = () => tr("viewer.simplified_tip");
    } else {
      const data = decodeMesh(buf);
      V.mesh = buildMesh(V.gl, data);
      V.statsText = () =>
        `${dim(data.min, data.max)} · ${tr("viewer.triangles", { n: data.n })}` +
        (data.truncated ? " " + tr("files.info.sampled") : "");
    }
    showStats();
    $("v-msg").classList.add("hidden");
    frameCamera();
  } catch (e) {
    // A newer file took the viewer meanwhile: this one's failure is moot.
    if (V.path !== path) return;
    $("v-msg").textContent = tr(gcode ? "viewer.bad_paths" : "viewer.bad_mesh", { err: e.message });
  }
}

function showStats() {
  $("v-stats").textContent = V.statsText();
  $("v-stats").title = V.statsTip ? V.statsTip() : "";
}

function setupLayerSlider(data) {
  const s = $("v-layer");
  s.min = 1;
  s.max = data.layers;
  s.value = data.layers;
  updateLayerLabel();
}

function updateLayerLabel() {
  const p = V.paths;
  if (!p) return;
  const n = V.layer + 1;
  $("v-layer-n").textContent = tr("viewer.layer_of", { n, total: p.layers });
  const z = p.layerZ[Math.min(V.layer, p.layerZ.length - 1)];
  const t = V.preview?.stats?.layer_end_s?.[Math.min(V.layer, (V.preview.stats.layer_end_s.length || 1) - 1)];
  $("v-layer-z").textContent =
    (z ? `Z ${fmtDec(z, 2)} mm` : "") + (t != null ? ` · ${fmtSpan(t)}` : "");
}

function renderLegend(feats) {
  const tools = V.paths?.tools || [];
  const name = (t) => V.preview?.toolNames?.[t];
  const sw = (c) => `<i style="background:rgb(${c.map(Math.round).join(",")})"></i>`;
  if (V.colorMode === "tool" || V.colorMode === "material") {
    const heads = tools.map((t) => `<span class="leg">${sw(toolRgb(t))}T${t}${name(t) ? " · " + esc(name(t)) : ""}</span>`);
    // Material: the shades of the first head, to read the structure.
    const base = toolRgb(tools[0] ?? 0);
    const shades =
      V.colorMode === "material"
        ? feats.map((f) => `<span class="leg sub">${sw(shade(base, f))}${esc(featureName(f))}</span>`)
        : [];
    $("v-legend").innerHTML = heads.join("") + (shades.length ? '<span class="leg-sep"></span>' + shades.join("") : "");
    return;
  }
  $("v-legend").innerHTML = feats
    .map((f) => {
      return `<span class="leg">${sw(FEATURES[f][1])}${esc(featureName(f))}</span>`;
    })
    .join("");
}

function closeViewer() {
  // Docked in a conversation, the viewer is part of the screen: Esc must
  // not make it disappear.
  if ($("viewer").classList.contains("docked")) return;
  // Enlarged from a conversation, it must go back there rather than close.
  if (V.onClose) {
    const back = V.onClose;
    V.onClose = null;
    back();
    return;
  }
  $("viewer").classList.add("hidden");
  V.path = null;
  if (V.preview) {
    const pv = V.preview;
    hidePreviewPanel();
    if (pv.onClose) pv.onClose();
  }
}

/* ------------------------------------------------------------ slice preview */

const fmtSpan = (s) => {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return tr("units.hm", { h, m: String(m).padStart(2, "0") });
  if (m) return tr("units.min", { m }) + (m < 10 && sec ? " " + String(sec).padStart(2, "0") + " s" : "");
  return `${sec} s`;
};
const fmtG = (x, d = 1) => fmtDec(x ?? 0, d);

/* Opens a sliced G-code with its summary. `opts`: path, name, stats,
   toolColors ([r,g,b] per head), toolNames, onSend, onSave, onEdit, onClose,
   and the engine's support warnings (`warnings`, `onSupports`). */
function openPreview(opts) {
  V.preview = opts;
  V.colorMode = "material";
  V.fileColors = [];
  renderPreviewPanel();
  $("v-panel").classList.remove("hidden");
  $("viewer").classList.add("previewing");
  return openViewer(opts.path, opts.name, "gcode");
}

function hidePreviewPanel() {
  V.preview = null;
  // Each opening starts again in "Material" mode.
  V.colorMode = "material";
  $("v-panel").classList.add("hidden");
  $("viewer").classList.remove("previewing");
}

/* Why an object needs supports, in words: the engine's reasons
   (`slice::support_warnings`) and the Prepare hint's (`support_hint.rs`). */
const SUPPORT_REASONS = { floating: "supports.reason.floating", cantilever: "supports.reason.cantilever", overhangs: "supports.reason.overhangs" };

function renderPreviewPanel() {
  const st = V.preview.stats || {};
  // Objects the engine says need supports: one line each, the reason in
  // words (its own English sentence for a reason it does not name).
  const warn = V.preview.warnings || [];
  $("vp-supports").classList.toggle("hidden", !warn.length || !V.preview.onSupports);
  $("vp-supports-text").innerHTML = warn
    .map((w) => `<div>${esc(SUPPORT_REASONS[w.reason] ? tr("supports.banner", { name: w.object, reason: tr(SUPPORT_REASONS[w.reason]) }) : w.text)}</div>`)
    .join("");
  $("vp-time").textContent = st.print_time_s ? fmtSpan(st.print_time_s) : "—";
  $("vp-first").textContent = [
    st.first_layer_s ? tr("viewer.first_layer", { t: fmtSpan(st.first_layer_s) }) : "",
    st.layers ? tr("viewer.layers", { n: st.layers }) : "",
  ].filter(Boolean).join(" · ");

  // One row per extruding head, then the total.
  const tools = st.tools?.length ? st.tools : [0];
  const rows = tools.map((t) => {
    const c = toolRgb(t);
    const g = st.per_tool_g?.[t], m = st.per_tool_m?.[t];
    return `<div class="grow-row"><span class="swatch" style="background:rgb(${c[0]},${c[1]},${c[2]})"></span>
      <span class="k">T${t}${V.preview.toolNames?.[t] ? `<span class="sub">${esc(V.preview.toolNames[t])}</span>` : ""}</span>
      <span class="val">${g != null ? fmtG(g) + " g" : ""}${m != null ? `<span class="sub">${fmtG(m, 2)} m</span>` : ""}</span></div>`;
  });
  if (tools.length > 1 || st.cost) {
    rows.push(`<div class="grow-row total"><span class="k">${esc(tr("prints.total"))}</span><span class="val">${
      st.filament_g != null ? fmtG(st.filament_g) + " g" : "—"
    }${st.cost ? `<span class="sub">${fmtG(st.cost, 2)} €</span>` : ""}</span></div>`);
  }
  $("vp-fil").innerHTML = rows.join("");

  // Breakdown: path features then travel, as a share of the total.
  const total = (st.features || []).reduce((a, f) => a + f.seconds, 0) + (st.travel_s || 0);
  const feat = (st.features || []).map((f) => ({ name: featureName(f.feature), c: FEATURES[Math.min(f.feature, FEATURES.length - 1)][1], s: f.seconds }));
  if (st.travel_s > 0) feat.push({ name: tr("viewer.travel"), c: [96, 104, 126], s: st.travel_s });
  $("vp-feat").innerHTML = feat
    .map((f) => {
      const pct = total ? (f.s * 100) / total : 0;
      return `<div class="grow-row vp-feat"><span class="swatch sq" style="background:rgb(${f.c[0]},${f.c[1]},${f.c[2]})"></span>
        <span class="k">${esc(f.name)}</span>
        <span class="vp-bar"><i style="width:${pct.toFixed(1)}%"></i></span>
        <span class="val">${fmtSpan(f.s)}</span></div>`;
    })
    .join("");
}

$("v-colors").addEventListener("click", (e) => {
  const b = e.target.closest("[data-mode]");
  if (b) setColorMode(b.dataset.mode);
});
$("vp-send").addEventListener("click", () => V.preview?.onSend?.());
$("vp-save").addEventListener("click", () => V.preview?.onSave?.());
$("vp-edit").addEventListener("click", () => V.preview?.onEdit?.());
$("vp-supports-go").addEventListener("click", () => V.preview?.onSupports?.());

/* Moves the camera target in the screen plane. */
function panBy(dx, dy) {
  const c = V.cam;
  const right = [Math.cos(c.yaw), Math.sin(c.yaw), 0];
  const up = [
    -Math.sin(c.yaw) * Math.sin(c.pitch),
    Math.cos(c.yaw) * Math.sin(c.pitch),
    Math.cos(c.pitch),
  ];
  const k = c.dist * 0.0022;
  c.target = add3(c.target, [
    (-right[0] * dx + up[0] * dy) * k,
    (-right[1] * dx + up[1] * dy) * k,
    (-right[2] * dx + up[2] * dy) * k,
  ]);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function bindInteractions(canvas) {
  canvas.addEventListener("mousedown", (e) => {
    // Right click or pressed wheel: pan, as in CAD software.
    V.drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 1 || e.button === 2 };
    e.preventDefault();
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  addEventListener("mousemove", (e) => {
    if (!V.drag || $("viewer").classList.contains("hidden")) return;
    const dx = e.clientX - V.drag.x;
    const dy = e.clientY - V.drag.y;
    V.drag.x = e.clientX;
    V.drag.y = e.clientY;
    if (dx || dy) V.framed = false;
    if (V.drag.pan) {
      panBy(dx, dy);
    } else {
      // The scene follows the cursor: dragging left takes it left, like the
      // sideways pan just above.
      V.cam.yaw -= dx * 0.008;
      V.cam.pitch = Math.max(-1.45, Math.min(1.45, V.cam.pitch + dy * 0.008));
    }
    schedule();
  });
  addEventListener("mouseup", () => (V.drag = null));
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      // Settings come from app.js; they are saved between launches.
      const dir = state.invertWheel ? -1 : 1;
      const speed = state.wheelSpeed || 1;
      // A trackpad pinch arrives as a wheel event with ctrl: always a zoom, and
      // never inverted, otherwise the gesture becomes counter-intuitive.
      const pinch = e.ctrlKey;
      // ⇧ + scroll moves the view (a trackpad's ⇧ + two fingers).
      const action = pinch ? "zoom" : e.shiftKey ? "pan" : state.wheelAction || "zoom";
      V.framed = false;

      if (action === "zoom") {
        const s = pinch ? 1 : dir;
        V.cam.dist = clamp(V.cam.dist * Math.exp(e.deltaY * 0.0012 * s * speed), 2, 4000);
      } else if (action === "pan") {
        panBy(-e.deltaX * dir * speed, -e.deltaY * dir * speed);
      } else {
        V.cam.yaw += e.deltaX * 0.006 * dir * speed;
        V.cam.pitch = clamp(V.cam.pitch - e.deltaY * 0.006 * dir * speed, -1.45, 1.45);
      }
      schedule();
    },
    { passive: false }
  );
  canvas.addEventListener("dblclick", frameCamera);
  addEventListener("resize", schedule);
}

$("v-layer").addEventListener("input", () => {
  V.layer = +$("v-layer").value - 1;
  updateLayerLabel();
  schedule();
});
$("v-travel").addEventListener("change", () => {
  V.showTravel = $("v-travel").checked;
  if (V.showTravel) loadTravel();
  draw();
});
$("v-close").addEventListener("click", closeViewer);
$("v-reset").addEventListener("click", frameCamera);
$("v-plate").addEventListener("change", () => {
  V.showPlate = $("v-plate").checked;
  draw();
});
document.addEventListener("keydown", (e) => {
  const box = $("viewer");
  // Docked in a conversation, the keyboard belongs to the terminal: an "R"
  // in the middle of a sentence must not reframe the camera.
  if (box.classList.contains("hidden") || box.classList.contains("docked")) return;
  // A sheet open on top (send to printer) keeps the keyboard.
  if (document.querySelector(".modal:not(.hidden)")) return;
  if (e.key === "Escape") closeViewer();
  if (e.key.toLowerCase() === "r") frameCamera();
});
