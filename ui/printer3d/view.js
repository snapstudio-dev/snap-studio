// The 3D printer view (#34): the U1 model in a scene, its parts clickable.
// Loaded on demand by printer3d.js (import()), which draws the overlays and
// owns the data; this module only draws. The pure rules (zones, sides,
// easing) are in printer3d-logic.js.
import * as THREE from '../vendor/three/three.module.js';
import { RoomEnvironment } from '../vendor/three/addons/RoomEnvironment.js';
import { createSnapmakerU1 } from './u1-model.js';

const TARGET = new THREE.Vector3(0, 0.37, 0);
const PITCH = 0.16; // the camera a little above, as someone standing in front
// Outline widths, metres: hovered, chosen, and the chosen part's halo.
const HULL = { hover: 0.0028, chosen: 0.0055, glow: 0.013 };

// An outline: the part's back faces pushed out along their normals.
function hullMaterial(color, width, opacity = 1) {
  const m = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide, transparent: true, opacity, depthWrite: false });
  m.onBeforeCompile = (s) => {
    s.uniforms.uHull = { value: width };
    s.vertexShader = 'uniform float uHull;\n' + s.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += normal * uHull;');
  };
  return m;
}

/** A view in `host`; null without WebGL (the caller keeps its 2D picture).
 *  on.hover(zone, x, y) on hovering a part (zone null: none), on.pick(zone)
 *  on clicking one, on.turn(side) once a turn ends. */
export function createView(host, on = {}) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch {
    return null;
  }
  if (!renderer.getContext()) return null;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Faded in on its first frame: no blank square while the scene builds.
  renderer.domElement.style.opacity = '0';
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 20);
  const key = new THREE.DirectionalLight('#ffffff', 1.6);
  key.position.set(0.9, 2.2, 1.4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -0.6, right: 0.6, top: 0.6, bottom: -0.6, near: 0.5, far: 5 });
  key.shadow.radius = 6;
  key.shadow.bias = -0.0004;
  scene.add(key, new THREE.HemisphereLight('#ffffff', '#8a8a90', 0.5));
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.ShadowMaterial({ opacity: 0.16 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const u1 = createSnapmakerU1();
  const root = u1.group;
  // The door's glass lets the outline of what is behind it through.
  u1.materials.glass.depthWrite = false;
  scene.add(root);
  root.updateMatrixWorld(true);

  // The part printing: a block on the bed, as high as the print is done.
  const bedTop = new THREE.Box3().setFromObject(u1.bed).max.y - root.position.y;
  const partMat = new THREE.MeshStandardMaterial({ color: '#888888', roughness: 0.5 });
  const part = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1, 0.06), partMat);
  part.visible = false;
  part.castShadow = true;
  root.add(part);

  // The clickable parts, by zone: their meshes, each with an outline and
  // a halo (shown when chosen).
  const zones = new Map(); // zone → [{ line, glow }]
  const hover = hullMaterial('#7fb2ff', HULL.hover, 0.9);
  const chosen = hullMaterial('#0a84ff', HULL.chosen);
  const glow = hullMaterial('#0a84ff', HULL.glow, 0.22);
  const addZone = (zone, group) => {
    const hulls = [];
    const meshes = [];
    group.traverse((m) => m.isMesh && !m.userData.hull && meshes.push(m));
    for (const m of meshes) {
      const hull = (mat, order) => {
        const h = new THREE.Mesh(m.geometry, mat);
        h.userData.hull = true;
        h.visible = false;
        h.renderOrder = order;
        h.raycast = () => {};
        m.add(h);
        return h;
      };
      hulls.push({ line: hull(hover, -1), glow: hull(glow, -2) });
    }
    zones.set(zone, hulls);
  };
  u1.SPOOL_OF_HEAD.forEach((name, n) => addZone(`spool:${n}`, u1.spools[name]));
  u1.docks.forEach((d, n) => addZone(`dock:${n}`, d));
  addZone('toolhead', u1.toolhead);
  addZone('bed', u1.bed);
  addZone('light', u1.light);

  const st = { active: null, printing: false, yaw: 0, from: 0, to: 0, t0: 0, dur: 0, side: 'front', hover: null, chosen: null, spin: 0 };
  // A head's parts: its dock, its spool, and the carriage when it is the
  // active one (a hovered spool alone).
  const partsOf = (zone, whole) => {
    const z = p3dParse(zone);
    if (z?.kind !== 'head') return zones.get(zone) || [];
    return [...zones.get(`dock:${z.n}`), ...(whole ? zones.get(`spool:${z.n}`) : []), ...(st.active === z.n ? zones.get('toolhead') : [])];
  };
  const outline = () => {
    for (const hulls of zones.values()) hulls.forEach((h) => (h.line.visible = h.glow.visible = false));
    if (st.hover) partsOf(st.hover, false).forEach((h) => { h.line.material = hover; h.line.visible = true; });
    if (st.chosen) partsOf(st.chosen, true).forEach((h) => { h.line.material = chosen; h.line.visible = h.glow.visible = true; });
  };

  // ---- framing: the whole printer, centred in the stage (a panel opening
  // over the right does not move it)
  function frame() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    // Resized only when it changes: a canvas resized is cleared.
    const size = renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const vfov = THREE.MathUtils.degToRad(camera.fov);
    const needH = 0.98, needW = 0.9; // the model with its spools and tubes, a margin around
    const dist = Math.max(needH / 2 / Math.tan(vfov / 2), needW / 2 / (Math.tan(vfov / 2) * (w / h)));
    camera.position.set(0, TARGET.y + Math.sin(PITCH) * dist, Math.cos(PITCH) * dist);
    camera.lookAt(TARGET);
    camera.updateProjectionMatrix();
    draw();
  }

  // ---- drawing: on demand, continuously only while something moves
  let raf = 0, alive = true, shown = true;
  let waiters = []; // ready(): told once a frame is on screen
  const draw = () => { if (!raf && alive && shown) raf = requestAnimationFrame(tick); };
  function tick(now) {
    raf = 0;
    let moving = false;
    if (st.dur) {
      const t = Math.min(1, (now - st.t0) / st.dur);
      st.yaw = st.from + (st.to - st.from) * p3dEase(t);
      if (t >= 1) { st.dur = 0; on.turn?.(st.side); } else moving = true;
    }
    root.rotation.y = st.yaw;
    if (st.printing && st.active != null) {
      // The active spool unwinds slowly.
      st.spin += 0.01;
      u1.spools[u1.SPOOL_OF_HEAD[st.active]].rotation.x = st.spin;
      moving = true;
    }
    renderer.render(scene, camera);
    if (renderer.domElement.style.opacity === '0') renderer.domElement.style.opacity = '1';
    if (waiters.length) {
      const w = waiters;
      waiters = [];
      // One frame later: the picture has reached the screen.
      requestAnimationFrame(() => w.forEach((f) => f()));
    }
    if (moving) draw();
  }

  // ---- turning: a side (the short way round), or by dragging
  function turn(side, ms = 650) {
    const to = p3dYawTo(st.yaw, side);
    st.side = side;
    if (ms <= 0 || Math.abs(to - st.yaw) < 1e-3) { st.yaw = to; st.dur = 0; on.turn?.(side); return draw(); }
    Object.assign(st, { from: st.yaw, to, t0: performance.now(), dur: ms });
    draw();
  }

  // ---- picking: the first part under the pointer; glass does not hide
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pick(e) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    for (const hit of ray.intersectObject(root, true)) {
      const names = [];
      for (let o = hit.object; o && o !== scene; o = o.parent) names.push(o.name);
      const zone = p3dZoneOf(names, st.active);
      if (zone) return zone;
      const m = hit.object.material;
      if (!(m.transmission > 0 || m.transparent)) return null;
    }
    return null;
  }

  const el = renderer.domElement;
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, yaw: st.yaw, moved: false };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (drag) {
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 4) drag.moved = true;
      if (drag.moved) {
        st.dur = 0;
        st.yaw = drag.yaw + dx * 0.008;
        draw();
        return;
      }
    }
    const zone = pick(e);
    if (zone !== st.hover) {
      st.hover = zone;
      el.style.cursor = zone ? 'pointer' : 'grab';
      outline();
      draw();
    }
    on.hover?.(zone, e.clientX, e.clientY);
  });
  el.addEventListener('pointerup', (e) => {
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.moved) {
      // Dropped near a side: that side is the one shown.
      const side = p3dSideAt(st.yaw);
      st.side = side;
      on.turn?.(side, true);
      return;
    }
    on.pick?.(pick(e));
  });
  el.addEventListener('pointerleave', () => {
    if (drag) return;
    st.hover = null;
    outline();
    draw();
    on.hover?.(null);
  });
  el.style.cursor = 'grab';

  const resize = new ResizeObserver(frame);
  resize.observe(host);

  return {
    turn,
    get side() { return st.side; },
    /** the zone whose panel is open, outlined */
    choose(zone) { st.chosen = zone; outline(); draw(); },
    /** the printer's state: spools [hex|null ×4], active head, its heat 0–1,
     *  light, carriage {x,z}, printing, progress 0–1, the part's colour */
    setState(s) {
      (s.spools || []).forEach((hex, n) => u1.setSpool(n, hex));
      st.active = s.active ?? null;
      u1.setActiveHead(st.active);
      u1.setHeat(s.heat || 0);
      u1.setLight(!!s.light);
      if (s.carriage) u1.setToolhead(s.carriage.x, s.carriage.z);
      st.printing = !!s.printing;
      const hgt = st.printing && s.progress > 0 ? 0.004 + 0.07 * s.progress : 0;
      part.visible = hgt > 0;
      if (hgt) {
        part.scale.y = hgt;
        part.position.set(u1.toolhead.position.x * 0.2, bedTop + hgt / 2, 0.006);
        partMat.color.set(s.partColor || '#888888');
      }
      outline();
      draw();
    },
    /** dark themes: a softer shadow, a little less light; the outlines in
     *  the theme's accent */
    setTheme(dark, accent) {
      if (accent) {
        chosen.color.set(accent);
        glow.color.set(accent);
        hover.color.set(accent).lerp(new THREE.Color(dark ? '#000000' : '#ffffff'), 0.35);
      }
      floor.material.opacity = dark ? 0.32 : 0.16;
      renderer.toneMappingExposure = dark ? 0.92 : 1;
      draw();
    },
    /** resolves once a frame of the scene is on screen */
    ready() {
      return new Promise((resolve) => {
        waiters.push(resolve);
        draw();
      });
    },
    /** stops drawing while hidden */
    setShown(v) {
      if (v === shown && v) return;
      shown = v;
      if (!v) return;
      // Drawn at once when shown again: the browser may have dropped the
      // last picture while the page was hidden.
      frame();
      cancelAnimationFrame(raf);
      raf = 0;
      tick(performance.now());
    },
    dispose() {
      alive = false;
      cancelAnimationFrame(raf);
      resize.disconnect();
      renderer.dispose();
      el.remove();
    },
  };
}
