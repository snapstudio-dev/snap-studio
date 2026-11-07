// Physically based materials for the Snapmaker U1 model.
// (Snap Studio: imports made relative to the vendored three.js; a light
// strip, an empty spool and a nozzle that glows when hot added.)
// All colours are sRGB hex; three.js converts them to linear internally.
import * as THREE from '../vendor/three/three.module.js';

const hasDOM = typeof document !== 'undefined';

export const BODY_HEX = '#eeeeec';

function canvasTexture(w, h, draw) {
  if (!hasDOM) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export function drawLogo(ctx, w, h) {
  ctx.fillStyle = BODY_HEX;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#6e6e70';
  ctx.font = `600 ${Math.round(h * 0.58)}px "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText('snapmaker', w * 0.04, h * 0.52);
}

export function drawScreen(ctx, w, h) {
  const s = w / 640;
  ctx.fillStyle = '#0c0e12'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#181b21'; ctx.fillRect(0, 0, w, 56 * s);
  ctx.fillStyle = '#c8cbd2'; ctx.font = `${26 * s}px "IBM Plex Sans", Arial, sans-serif`; ctx.textBaseline = 'top';
  ctx.fillText('Snapmaker U1', 24 * s, 14 * s);
  ctx.fillStyle = '#8c8f96'; ctx.fillText('12:40', 520 * s, 14 * s);
  const rr = (x, y, ww, hh, r, fill) => {
    ctx.fillStyle = fill; ctx.beginPath(); ctx.roundRect(x * s, y * s, ww * s, hh * s, r * s); ctx.fill();
  };
  rr(24, 84, 592, 216, 18, '#1c2028');
  ctx.fillStyle = '#f0f0f0'; ctx.font = `700 ${44 * s}px "IBM Plex Sans", Arial, sans-serif`;
  ctx.fillText('Ready', 48 * s, 104 * s);
  ctx.fillStyle = '#a0a5af'; ctx.font = `${26 * s}px "IBM Plex Sans", Arial, sans-serif`;
  ctx.fillText('Bed 25 °C    Nozzle 26 °C', 48 * s, 168 * s);
  ['#f0f0eb', '#d21e1e', '#141414', '#fab90f'].forEach((c, i) => rr(48 + i * 70, 222, 54, 54, 10, c));
  rr(420, 222, 172, 54, 12, '#f26a0d');
  ctx.fillStyle = '#fff'; ctx.fillText('Print', 466 * s, 234 * s);
  ctx.fillStyle = '#121419'; ctx.fillRect(0, 330 * s, w, 70 * s);
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = i === 0 ? '#f26a0d' : '#464a52';
    ctx.beginPath(); ctx.arc((255 + i * 40) * s, 363 * s, 7 * s, 0, Math.PI * 2); ctx.fill();
  }
}

// fine winding lines, used as a bump map on the filament
function drawWinding(ctx, w, h) {
  ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#b0b0b0'; ctx.lineWidth = 1;
  for (let y = 0.5; y < h; y += 3) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
}

export function createMaterials(opts = {}) {
  const spools = Object.assign({
    leftTop: '#141414', leftBottom: '#f9b60e', rightTop: '#efede0', rightBottom: '#d61414',
  }, opts.spools || {});

  const logoTex = canvasTexture(1024, 256, drawLogo);
  const screenTex = canvasTexture(640, 400, drawScreen);
  const windTex = canvasTexture(256, 256, drawWinding);
  if (windTex) { windTex.wrapS = windTex.wrapT = THREE.RepeatWrapping; windTex.repeat.set(1, 24); windTex.colorSpace = THREE.NoColorSpace; }

  const filament = (hex) => new THREE.MeshStandardMaterial({
    color: hex, roughness: 0.55, metalness: 0, bumpMap: windTex, bumpScale: 0.0006,
  });

  const M = {
    body: new THREE.MeshPhysicalMaterial({
      color: BODY_HEX, roughness: 0.36, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.22,
    }),
    bodySatin: new THREE.MeshStandardMaterial({ color: '#e2e2e0', roughness: 0.5 }),
    dark: new THREE.MeshStandardMaterial({ color: '#1c1c1f', roughness: 0.6 }),
    deck: new THREE.MeshStandardMaterial({ color: '#17171a', roughness: 0.45 }),
    black: new THREE.MeshStandardMaterial({ color: '#0b0b0c', roughness: 0.7 }),
    gray: new THREE.MeshStandardMaterial({ color: '#73757a', roughness: 0.5 }),
    steel: new THREE.MeshStandardMaterial({ color: '#c6c8cc', roughness: 0.22, metalness: 0.95 }),
    brass: new THREE.MeshStandardMaterial({ color: '#cc9f40', roughness: 0.35, metalness: 0.85 }),
    glass: new THREE.MeshPhysicalMaterial({
      color: '#b4bcc6', roughness: 0.02, metalness: 0, transmission: 1, thickness: 0.006, ior: 1.5,
      attenuationColor: '#3d4855', attenuationDistance: 0.02,
    }),
    orange: new THREE.MeshPhysicalMaterial({ color: '#f26a0d', roughness: 0.35, clearcoat: 0.4 }),
    yellow: new THREE.MeshStandardMaterial({ color: '#fcb315', roughness: 0.4 }),
    gold: new THREE.MeshStandardMaterial({ color: '#b3945c', roughness: 0.65, metalness: 0.35 }),
    card: new THREE.MeshStandardMaterial({ color: '#ccad80', roughness: 0.9 }),
    filLeftTop: filament(spools.leftTop),
    filLeftBottom: filament(spools.leftBottom),
    filRightTop: filament(spools.rightTop),
    filRightBottom: filament(spools.rightBottom),
    ptfe: new THREE.MeshPhysicalMaterial({
      color: '#f1ead9', roughness: 0.3, transmission: 0.6, thickness: 0.003, ior: 1.35,
    }),
    sheath: new THREE.MeshStandardMaterial({ color: '#141416', roughness: 0.7 }),
    red: new THREE.MeshStandardMaterial({ color: '#d80d0d', roughness: 0.4 }),
    logo: new THREE.MeshStandardMaterial({ map: logoTex, color: logoTex ? '#ffffff' : BODY_HEX, roughness: 0.42 }),
    screen: new THREE.MeshStandardMaterial({
      map: screenTex, color: '#ffffff', roughness: 0.2, emissiveMap: screenTex, emissive: '#ffffff', emissiveIntensity: 0.9,
    }),
    // Snap Studio: the chamber light strip (emissive when on), each head's
    // nozzle (glows with its temperature), an empty spool's ghost.
    light: new THREE.MeshStandardMaterial({ color: '#fdfbf2', roughness: 0.4, emissive: '#fff4d6', emissiveIntensity: 0 }),
    nozzle: new THREE.MeshStandardMaterial({ color: '#cc9f40', roughness: 0.35, metalness: 0.85, emissive: '#ff6a1a', emissiveIntensity: 0 }),
    empty: new THREE.MeshStandardMaterial({ color: '#9a9ca2', roughness: 0.8, transparent: true, opacity: 0.35 }),
  };

  // redraw the logo once the web font has arrived
  if (hasDOM && document.fonts && logoTex) {
    document.fonts.ready.then(() => { drawLogo(logoTex.image.getContext('2d'), 1024, 256); logoTex.needsUpdate = true; });
  }
  return M;
}
