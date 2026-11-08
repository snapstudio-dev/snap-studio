// Parametric three.js model of the Snapmaker U1.
// (Snap Studio: imports made relative to the vendored three.js; the parts
// the 3D printer view makes clickable are named groups — bed, dock0–3,
// light, toolhead, spools — and the API sets their live state.)
// Units: metres. Axes: X right, Y up, Z toward the viewer (front of the printer).
// The group's origin is on the floor, under the centre of the enclosure.
import * as THREE from '../vendor/three/three.module.js';
import { RoundedBoxGeometry } from '../vendor/three/addons/RoundedBoxGeometry.js';
import { mergeGeometries, toCreasedNormals } from '../vendor/three/addons/BufferGeometryUtils.js';
import { createMaterials } from './u1-materials.js';

export const U1 = {
  W: 0.40, H: 0.43, D: 0.40,          // enclosure
  T: 0.012,                            // wall thickness
  R: 0.022,                            // vertical corner radius
  STEP: 0.012,                         // lower back panel recess
  Y_STEP: 0.305,                       // where the upper rear block starts
  RIM: 0.026,
  DOOR: { x0: -0.165, x1: 0.165, y0: 0.045, y1: 0.315 },
  WIN: { x0: -0.110, x1: 0.110, y0: 0.085, y1: 0.265 },   // rear window, clear of the power column on the left
  OVERALL: { w: 0.584, d: 0.499, h: 0.730 },
};

// ------------------------------------------------------------------ 2D helpers
// Closed rounded-rectangle polyline in the (x, z) plane, starting at the front centre (0, +d/2)
// and travelling toward +x, i.e. front edge, right side, back edge, left side.
function rrect(w, d, r, seg = 12) {
  const hw = w / 2, hd = d / 2, pts = [[0, hd]];
  const arc = (cx, cz, a0, a1) => {
    for (let i = 0; i <= seg; i++) { const a = a0 + (a1 - a0) * i / seg; pts.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]); }
  };
  arc(hw - r, hd - r, Math.PI / 2, 0);
  arc(hw - r, -hd + r, 0, -Math.PI / 2);
  arc(-hw + r, -hd + r, -Math.PI / 2, -Math.PI);
  arc(-hw + r, hd - r, -Math.PI, -1.5 * Math.PI);
  pts.push([0, hd]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, cum, L: cum[cum.length - 1] };
}

function pointAt(poly, s) {
  const { pts, cum, L } = poly;
  s = ((s % L) + L) % L;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
  return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
}

// Points along the perimeter from sA forward to sB (wrapping), end points included.
function slice(poly, sA, sB) {
  const { pts, cum, L } = poly;
  sA = ((sA % L) + L) % L; sB = ((sB % L) + L) % L;
  if (sB <= sA) sB += L;
  const out = [pointAt(poly, sA)];
  for (let k = 0; k < 2; k++) {
    for (let i = 0; i < pts.length - 1; i++) {
      const s = cum[i] + k * L;
      if (s > sA + 1e-9 && s < sB - 1e-9) out.push(pts[i]);
    }
  }
  out.push(pointAt(poly, sB));
  return out;
}

const sFront = (poly, x) => (x >= 0 ? x : poly.L + x);
const sBack = (poly, x) => poly.L / 2 - x;

function toShape(points) {
  // shape y maps to world -z after rotateX(-90°)
  return new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, -z)));
}

function extrudeY(shape, h, y0 = 0, zc = 0, bevel = 0) {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: bevel ? h - 2 * bevel : h, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 3, curveSegments: 1,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y0 + (bevel || 0), zc);
  return geo;
}

// One horizontal slice of the enclosure shell: a rounded ring, optionally opened at the front and/or back.
function shellSection({ w, d, r, t, y0, y1, zc, front = 0, back = 0 }) {
  const outer = rrect(w, d, r), inner = rrect(w - 2 * t, d - 2 * t, r - t);
  const gapsO = [], gapsI = [];
  if (front) { gapsO.push([sFront(outer, -front), sFront(outer, front)]); gapsI.push([sFront(inner, -front), sFront(inner, front)]); }
  if (back) { gapsO.push([sBack(outer, back), sBack(outer, -back)]); gapsI.push([sBack(inner, back), sBack(inner, -back)]); }
  const geos = [];
  if (gapsO.length === 0) {
    const shape = toShape(outer.pts.slice(0, -1));
    shape.holes.push(new THREE.Path(inner.pts.slice(0, -1).map(([x, z]) => new THREE.Vector2(x, -z))));
    geos.push(extrudeY(shape, y1 - y0, y0, zc));
  } else {
    const n = gapsO.length;
    for (let i = 0; i < n; i++) {
      const A = gapsO[i], B = gapsO[(i + 1) % n], Ai = gapsI[i], Bi = gapsI[(i + 1) % n];
      const ring = slice(outer, A[1], B[0]).concat(slice(inner, Ai[1], Bi[0]).reverse());
      geos.push(extrudeY(toShape(ring), y1 - y0, y0, zc));
    }
  }
  return geos.length === 1 ? geos[0] : mergeGeometries(geos);
}

// ------------------------------------------------------------------ model
export function createSnapmakerU1(options = {}) {
  const M = options.materials || createMaterials(options);
  const { W, H, D, T, R, STEP, Y_STEP, RIM, DOOR, WIN } = U1;
  const hx = W / 2, hz = D / 2;
  const root = new THREE.Group();
  root.name = 'SnapmakerU1';
  root.position.y = 0.012;                     // feet height: the enclosure floor sits 12 mm above ground

  const add = (geo, mat, pos = [0, 0, 0], parent = root, opts = {}) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(...pos);
    m.castShadow = opts.shadow !== false;
    m.receiveShadow = true;
    if (opts.rot) m.rotation.set(...opts.rot);
    if (opts.name) m.name = opts.name;
    parent.add(m);
    return m;
  };
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const rbox = (w, h, d, r = 0.004) => new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2, h / 2, d / 2));
  const cyl = (r, h, seg = 40) => new THREE.CylinderGeometry(r, r, h, seg);
  const ROT_X = [Math.PI / 2, 0, 0], ROT_Z = [0, 0, Math.PI / 2];

  // ---- enclosure shell, built as stacked rounded rings
  const lower = { w: W, d: D - STEP, r: R, t: T, zc: STEP / 2 }, upper = { w: W, d: D, r: R, t: T, zc: 0 };
  const sections = [
    { ...lower, y0: 0, y1: DOOR.y0 },
    { ...lower, y0: DOOR.y0, y1: WIN.y0, front: DOOR.x1 },
    { ...lower, y0: WIN.y0, y1: WIN.y1, front: DOOR.x1, back: WIN.x1 },
    { ...lower, y0: WIN.y1, y1: Y_STEP, front: DOOR.x1 },
    { ...upper, y0: Y_STEP, y1: DOOR.y1, front: DOOR.x1 },
    { ...upper, y0: DOOR.y1, y1: H - T },
  ];
  const shell = toCreasedNormals(mergeGeometries(sections.map(shellSection)), Math.PI / 5);
  add(shell, M.body, [0, 0, 0], root, { name: 'shell' });
  add(box(W - 2 * T, T, D - STEP - 2 * T), M.body, [0, T / 2, STEP / 2]);                    // floor plate
  // top rim with bevelled edges
  {
    const b = 0.002;
    const outer = rrect(W - 2 * b, D - 2 * b, R - b), hole = rrect(W - 2 * RIM + 2 * b, D - 2 * RIM + 2 * b, 0.008);
    const shape = toShape(outer.pts.slice(0, -1));
    shape.holes.push(new THREE.Path(hole.pts.slice(0, -1).map(([x, z]) => new THREE.Vector2(x, -z))));
    add(extrudeY(shape, T, H - T, 0, b), M.body);
  }
  const deckY = H - T - 0.004;                 // reference height of the open top (no cover: the gantry is visible from above)

  // ---- dark interior liners
  const li = 0.004, innerD = D - STEP - 2 * T;
  add(box(li, H - 2 * T, innerD), M.dark, [-hx + T + li / 2, H / 2, STEP / 2], root, { shadow: false });
  add(box(li, H - 2 * T, innerD), M.dark, [hx - T - li / 2, H / 2, STEP / 2], root, { shadow: false });
  add(box(W - 2 * T, li, innerD), M.dark, [0, T + li / 2, STEP / 2], root, { shadow: false });
  {
    const zb = -hz + STEP + T + li / 2, wi = W - 2 * T;
    add(box(wi, WIN.y0 - T, li), M.dark, [0, (WIN.y0 + T) / 2, zb], root, { shadow: false });
    add(box(wi, H - T - WIN.y1, li), M.dark, [0, (H - T + WIN.y1) / 2, zb], root, { shadow: false });
    add(box(WIN.x0 + hx - T, WIN.y1 - WIN.y0, li), M.dark, [(WIN.x0 - hx + T) / 2, (WIN.y0 + WIN.y1) / 2, zb], root, { shadow: false });
    add(box(hx - T - WIN.x1, WIN.y1 - WIN.y0, li), M.dark, [(WIN.x1 + hx - T) / 2, (WIN.y0 + WIN.y1) / 2, zb], root, { shadow: false });
  }

  // ---- feet
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(cyl(0.016, 0.012), M.black, [sx * (hx - 0.04), -0.006, sz * (hz - 0.045)]);

  // ---- door (hinged on the left, pivot group so it can open)
  const zf = hz, fr = 0.012, dz = 0.006;
  const dcy = (DOOR.y0 + DOOR.y1) / 2, dw = DOOR.x1 - DOOR.x0 + 2 * fr, dh = DOOR.y1 - DOOR.y0 + 2 * fr;
  const door = new THREE.Group();
  door.name = 'door';
  door.position.set(DOOR.x0 - fr, 0, zf + dz / 2);          // hinge line
  root.add(door);
  const dx = (x) => x - (DOOR.x0 - fr);                       // to door-local x
  add(rbox(dw, fr, dz, 0.002), M.dark, [dx(0), DOOR.y1 + fr / 2, 0], door);
  add(rbox(dw, fr, dz, 0.002), M.dark, [dx(0), DOOR.y0 - fr / 2, 0], door);
  add(rbox(fr, dh, dz, 0.002), M.dark, [dx(DOOR.x0 - fr / 2), dcy, 0], door);
  add(rbox(fr, dh, dz, 0.002), M.dark, [dx(DOOR.x1 + fr / 2), dcy, 0], door);
  add(box(DOOR.x1 - DOOR.x0, DOOR.y1 - DOOR.y0, 0.004), M.glass, [dx(0), dcy, 0], door, { shadow: false, name: 'doorGlass' });
  add(rbox(0.010, 0.060, 0.014, 0.003), M.orange, [dx(DOOR.x1 + fr + 0.004), dcy + 0.02, dz / 2 + 0.002], door);
  for (const yy of [DOOR.y0 + 0.03, DOOR.y1 - 0.03]) add(cyl(0.006, 0.02), M.gray, [DOOR.x0 - fr - 0.003, yy, zf + dz / 2]);

  // ---- front band: logo + touchscreen
  add(new THREE.PlaneGeometry(0.096, 0.024), M.logo, [-0.118, 0.372, zf + 0.0004], root, { shadow: false });
  add(rbox(0.080, 0.054, 0.004, 0.004), M.black, [0.125, 0.372, zf + 0.002]);
  add(new THREE.PlaneGeometry(0.068, 0.0425), M.screen, [0.125, 0.372, zf + 0.0045], root, { shadow: false });

  // ---- rear: window, electrics
  {
    const zb = -hz + STEP, wfr = 0.010;
    const ww = WIN.x1 - WIN.x0 + 2 * wfr, wh = WIN.y1 - WIN.y0 + 2 * wfr, wcy = (WIN.y0 + WIN.y1) / 2;
    add(rbox(ww, wfr, 0.004, 0.0015), M.dark, [0, WIN.y1 + wfr / 2, zb - 0.002]);
    add(rbox(ww, wfr, 0.004, 0.0015), M.dark, [0, WIN.y0 - wfr / 2, zb - 0.002]);
    add(rbox(wfr, wh, 0.004, 0.0015), M.dark, [WIN.x0 - wfr / 2, wcy, zb - 0.002]);
    add(rbox(wfr, wh, 0.004, 0.0015), M.dark, [WIN.x1 + wfr / 2, wcy, zb - 0.002]);
    add(box(WIN.x1 - WIN.x0, WIN.y1 - WIN.y0, 0.003), M.glass, [0, wcy, zb - 0.001], root, { shadow: false });
    const ex = 0.160;
    add(box(0.016, 0.008, 0.002), M.black, [ex + 0.008, 0.145, zb - 0.001]);
    add(box(0.010, 0.010, 0.002), M.black, [ex - 0.010, 0.145, zb - 0.001]);
    add(box(0.030, 0.020, 0.004), M.black, [ex, 0.112, zb - 0.002]);
    add(rbox(0.022, 0.013, 0.004, 0.002), M.red, [ex, 0.112, zb - 0.005]);
    add(box(0.032, 0.040, 0.004), M.black, [ex, 0.070, zb - 0.002]);
    add(box(0.024, 0.014, 0.002), M.gray, [ex, 0.070, zb - 0.005]);
    add(box(0.050, 0.025, 0.001), M.gray, [0, 0.040, zb - 0.0005], root, { shadow: false });
  }

  // ---- chamber: bed, gantry, toolhead
  const bedY = 0.115;
  const bed = new THREE.Group();
  bed.name = 'bed';
  root.add(bed);
  add(rbox(0.29, 0.030, 0.29, 0.004), M.dark, [0, bedY - 0.017, STEP / 2], bed);
  add(box(0.27, 0.004, 0.27), M.gold, [0, bedY, STEP / 2], bed);
  for (const sx of [-1, 1]) add(cyl(0.006, bedY - 0.03), M.steel, [sx * 0.14, (bedY - 0.03) / 2 + 0.016, -0.16]);
  const railY = deckY - 0.03;
  for (const sx of [-1, 1]) {
    add(cyl(0.005, innerD - 0.01), M.steel, [sx * (hx - T - 0.014), railY, STEP / 2], root, { rot: ROT_X });
    add(rbox(0.016, 0.040, 0.050, 0.003), M.dark, [sx * (hx - T - 0.014), railY, 0.02]);
  }
  add(rbox(W - 2 * T - 0.034, 0.022, 0.030, 0.003), M.dark, [0, railY, 0.02]);
  // chamber light: a strip under the front of the top rim
  const light = new THREE.Group();
  light.name = 'light';
  root.add(light);
  add(rbox(W - 2 * RIM - 0.04, 0.006, 0.014, 0.002), M.light, [0, H - T - 0.006, hz - RIM - 0.006], light, { shadow: false });
  const toolhead = new THREE.Group();
  toolhead.name = 'toolhead';
  toolhead.position.set(0, railY, 0.055);
  root.add(toolhead);
  add(rbox(0.062, 0.075, 0.045, 0.005), M.gray, [0, -0.047, 0], toolhead);
  add(rbox(0.050, 0.030, 0.040, 0.003), M.dark, [0, -0.099, 0], toolhead);
  const nozzle = add(new THREE.ConeGeometry(0.006, 0.012, 16), M.nozzle, [0, -0.120, 0], toolhead, { rot: [Math.PI, 0, 0], name: 'nozzle' });

  // ---- top: tool docks + PTFE loops
  const dockZ = -hz + 0.062, dockY0 = deckY + 0.011, dockXs = [-0.12, -0.04, 0.04, 0.12];
  add(rbox(W - 2 * RIM + 0.012, 0.010, 0.090, 0.002), M.dark, [0, deckY + 0.006, dockZ]);   // rear bridge carrying the docks
  const tubeGeo = (points, r, closedCurve = false) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), closedCurve, 'centripetal', 0.5), 48, r, 12, false);
  const yTop = 0.73 - root.position.y, zBack = -hz + 0.006;
  const docks = [];
  for (const [di, x] of dockXs.entries()) {
    // dock `di` holds head T`di`; its head part hides while that head rides the carriage
    const dock = new THREE.Group();
    dock.name = 'dock' + di;
    root.add(dock);
    docks.push(dock);
    add(rbox(0.052, 0.062, 0.058, 0.005), M.black, [x, dockY0 + 0.031, dockZ], dock);
    const parked = new THREE.Group();
    parked.name = 'parked' + di;
    dock.add(parked);
    add(rbox(0.030, 0.006, 0.014, 0.002), M.yellow, [x, dockY0 + 0.064, dockZ + 0.012], parked);
    add(rbox(0.040, 0.012, 0.040, 0.004), M.gray, [x, dockY0 + 0.068, dockZ], parked);
    add(cyl(0.0045, 0.010), M.sheath, [x, dockY0 + 0.079, dockZ]);
    add(cyl(0.0045, 0.012), M.sheath, [x, H + 0.006, zBack]);
    // front leg, loop over the top, rear leg
    const yLoop = yTop - 0.06, ySplit = H + 0.20;
    add(tubeGeo([[x, dockY0 + 0.084, dockZ], [x, ySplit, dockZ]], 0.0040), M.sheath);
    const loop = [[x, ySplit, dockZ], [x, yLoop, dockZ]];
    const zc = (dockZ + zBack) / 2, rz = (dockZ - zBack) / 2;
    for (let i = 1; i < 16; i++) { const a = Math.PI * i / 16; loop.push([x, yLoop + 0.06 * Math.sin(a), zc + rz * Math.cos(a)]); }
    loop.push([x, yLoop, zBack], [x, ySplit, zBack]);
    add(tubeGeo(loop, 0.0032), M.ptfe, [0, 0, 0], root, { shadow: false });
    add(tubeGeo([[x, ySplit, zBack], [x, H + 0.012, zBack]], 0.0040), M.sheath);
    for (const yy of [H + 0.12, H + 0.17]) { add(cyl(0.0055, 0.012), M.black, [x, yy, dockZ]); add(cyl(0.0055, 0.012), M.black, [x, yy, zBack]); }
  }

  // ---- spools: two per side on white holders
  const SR = 0.095, SW = 0.062, HR = 0.027;
  const spoolProfile = [
    [HR, -SW / 2], [SR, -SW / 2], [SR, -SW / 2 + 0.004], [HR + 0.006, -SW / 2 + 0.004],
    [HR + 0.006, SW / 2 - 0.004], [SR, SW / 2 - 0.004], [SR, SW / 2], [HR, SW / 2], [HR, -SW / 2],
  ];
  const spoolGeo = new THREE.LatheGeometry(spoolProfile.map(([r, y]) => new THREE.Vector2(r, y)), 64);
  const filW = SW - 0.010, filR0 = HR + 0.006, filR1 = SR - 0.006;
  const filGeo = new THREE.LatheGeometry([[filR0, -filW / 2], [filR1, -filW / 2], [filR1, filW / 2], [filR0, filW / 2], [filR0, -filW / 2]].map(([r, y]) => new THREE.Vector2(r, y)), 96);
  const spoolSpec = [
    { side: -1, y: 0.315, z: -0.045, mat: M.filLeftTop, name: 'spoolLeftTop' },
    { side: -1, y: 0.120, z: 0.035, mat: M.filLeftBottom, name: 'spoolLeftBottom' },
    { side: 1, y: 0.315, z: -0.045, mat: M.filRightTop, name: 'spoolRightTop' },
    { side: 1, y: 0.120, z: 0.035, mat: M.filRightBottom, name: 'spoolRightBottom' },
  ];
  const spools = {};
  for (const s of spoolSpec) {
    const xc = s.side * (hx + 0.012 + SW / 2 + 0.010);
    add(rbox(0.024, 0.034, 0.064, 0.006), M.bodySatin, [s.side * (hx + 0.011), s.y, s.z]);
    add(cyl(HR - 0.004, SW + 0.030), M.bodySatin, [xc, s.y, s.z], root, { rot: ROT_Z });
    add(cyl(HR + 0.004, 0.006), M.bodySatin, [xc + s.side * (SW / 2 + 0.012), s.y, s.z], root, { rot: ROT_Z });
    const g = new THREE.Group();
    g.position.set(xc, s.y, s.z);
    g.rotation.z = Math.PI / 2;
    g.name = s.name;
    root.add(g);
    add(spoolGeo, M.card, [0, 0, 0], g);
    add(filGeo, s.mat, [0, 0, 0], g, { name: s.name + 'Filament' });
    spools[s.name] = g;
  }
  for (const side of [-1, 1]) add(rbox(0.034, 0.046, 0.062, 0.005), M.black, [side * (hx + 0.017), 0.100, -0.140]);

  // ---- API
  // Spools by head (Snap Studio): T0 left top, T1 left bottom, T2 right top, T3 right bottom.
  const SPOOL_OF_HEAD = ['spoolLeftTop', 'spoolLeftBottom', 'spoolRightTop', 'spoolRightBottom'];
  const FIL_OF_HEAD = [M.filLeftTop, M.filLeftBottom, M.filRightTop, M.filRightBottom];
  const api = {
    group: root, door, toolhead, spools, materials: M, bed, light, docks, nozzle, SPOOL_OF_HEAD,
    /** the colour of the spool on head n, or null for an empty holder */
    setSpool(n, hex) {
      const g = spools[SPOOL_OF_HEAD[n]];
      if (!g) return;
      const fil = g.getObjectByName(SPOOL_OF_HEAD[n] + 'Filament');
      if (hex) { FIL_OF_HEAD[n].color.set(hex); fil.material = FIL_OF_HEAD[n]; fil.visible = true; }
      else { fil.material = M.empty; }
    },
    /** the chamber light on or off */
    setLight(on) { M.light.emissiveIntensity = on ? 2.2 : 0; },
    /** the head riding the carriage (null: none), its dock shown empty */
    setActiveHead(n) {
      docks.forEach((d, i) => { d.getObjectByName('parked' + i).visible = i !== n; });
      toolhead.visible = n != null;
      if (n != null) toolhead.position.x = THREE.MathUtils.clamp(dockXs[n], -0.13, 0.13);
    },
    /** the nozzle's glow, 0 (cold) to 1 (at printing temperature) */
    setHeat(t) { M.nozzle.emissiveIntensity = 2.5 * THREE.MathUtils.clamp(t, 0, 1); },
    /** open the door: t in [0, 1] */
    setDoor(t) { door.rotation.y = -THREE.MathUtils.degToRad(105) * THREE.MathUtils.clamp(t, 0, 1); },
    /** move the toolhead inside the chamber, x and z in metres relative to the bed centre */
    setToolhead(x, z) { toolhead.position.x = THREE.MathUtils.clamp(x, -0.13, 0.13); toolhead.position.z = THREE.MathUtils.clamp(z, -0.1, 0.12); },
    /** rotate the spools (radians) */
    spinSpools(angle) { for (const g of Object.values(spools)) g.rotation.x = angle; },
  };
  root.userData.api = api;
  return api;
}
