"use strict";
/* Virtual heads: a color mixed from two loaded heads, which Snapmaker
   Orca's "Full Spectrum" prints by alternating them layer by layer (its
   mixed filaments). Pure rules, for scripts/test-virtual.js.

   A printer keeps its virtual heads as [{ uid, a, b, pct }] (heads.js):
   `a`, `b` two physical heads, `pct` the share of `b`. In every head field
   (an object's heads and pick, the colour mapping, the per-file map, a
   picker's value), a virtual head is the number 100 + uid: never mistaken
   for a physical head, stable when another one is deleted. A value whose
   uid no longer exists is an orphan: it means "no head", and is never
   replaced by a guessed one. */

const VH_BASE = 100;
const VH_MAX = 8;

const vhIs = (h) => h != null && h !== "" && Number.isInteger(+h) && +h >= VH_BASE;
const vhUid = (h) => +h - VH_BASE;
const vhValue = (uid) => VH_BASE + uid;
const vhFind = (list, h) => (vhIs(h) ? (list || []).find((v) => v.uid === vhUid(h)) || null : null);
/* A virtual value whose head is gone. */
const vhOrphan = (list, h) => vhIs(h) && !vhFind(list, h);

/* "V1", "V2"… by order of creation among the printer's current ones. */
const vhName = (list, h) => {
  const i = (list || []).findIndex((v) => v.uid === vhUid(h));
  return i < 0 ? "" : `V${i + 1}`;
};

/* The slider's seven notches, 4:1 to 1:4, as the share of B: the
   cadences Orca prints (vhCadence gives them back). */
const VH_PCTS = [20, 25, 33, 50, 67, 75, 80];
const vhPct = (notch) => VH_PCTS[Math.min(VH_PCTS.length, Math.max(1, notch | 0)) - 1];
/* The notch nearest to a share. */
function vhNotch(pct) {
  let best = 0;
  VH_PCTS.forEach((p, i) => Math.abs(p - pct) < Math.abs(VH_PCTS[best] - pct) && (best = i));
  return best + 1;
}

const vhGcd = (a, b) => (b ? vhGcd(b, a % b) : a);
/* Layers of A and of B in a cycle, as Orca's compute_gradient_ratios: the
   minority side gets one layer, the majority round(major / minor), the
   pair reduced. [1, 0] / [0, 1] at the ends. */
function vhCadence(pct) {
  const b = Math.min(100, Math.max(0, Math.round(+pct || 0)));
  const a = 100 - b;
  if (!b) return [1, 0];
  if (!a) return [0, 1];
  const [ra, rb] = a >= b ? [Math.max(1, Math.round(a / b)), 1] : [1, Math.max(1, Math.round(b / a))];
  const g = vhGcd(ra, rb);
  return [ra / g, rb / g];
}
/* The share of B layers in a cycle: what the eye mixes (Orca's preview
   color uses it). */
const vhShare = (pct) => {
  const [a, b] = vhCadence(pct);
  return b / (a + b);
};
const vhRatio = (pct) => vhCadence(pct).join(":");

/* A virtual head's components on the plate: `set` of head values →
   the physical heads (a virtual one gives its two, an orphan none). */
function vhPhysical(set, list) {
  const out = new Set();
  for (const h of set) {
    if (!vhIs(h)) out.add(+h);
    else {
      const v = vhFind(list, h);
      if (v) out.add(v.a).add(v.b);
    }
  }
  return out;
}

/* The same mix as another one (the same pair at the same cadence, either
   way round), other than `except` (its uid, when editing). */
function vhDuplicate(list, { a, b, pct }, except = null) {
  const cad = vhCadence(pct).join(":");
  return (list || []).find((v) => v.uid !== except && (
    (v.a === a && v.b === b && vhCadence(v.pct).join(":") === cad) ||
    (v.a === b && v.b === a && vhCadence(100 - v.pct).join(":") === cad)
  )) || null;
}

const vhCanAdd = (list) => (list || []).length < VH_MAX;

/* What can be mixed: the heads holding a spool whose color is read. */
const vhLoaded = (slots) => (slots || []).filter((s) => s.present && s.color).map((s) => s.index);

/* A spool read: the virtual heads to delete, with the heads that made
   them go. A virtual head is only made of loaded spools, so a read saying
   one of its heads is empty means that spool was unloaded — even while the
   app was closed. A head missing from the read (offline, nothing read)
   deletes nothing; a component beyond the heads the read reports does. */
function vhUnloaded(list, slots) {
  if (!Array.isArray(slots) || !slots.length) return [];
  const empty = new Set(slots.filter((s) => !s.present).map((s) => s.index));
  const count = Math.max(...slots.map((s) => s.index)) + 1;
  return (list || [])
    .map((v) => ({ v, out: [v.a, v.b].filter((h) => empty.has(h) || h >= count) }))
    .filter((g) => g.out.length);
}

/* The engine's side of a slice: the virtual heads the plate uses (values),
   in a stable order (by uid), the k-th becoming head `n + k` (the
   engine's filament n + k + 1). `heads`: [{ a, b, pct, uid }]; `index(h)`:
   what to send for a value; orphans give null. */
function vhEngine(values, list, n) {
  const used = [...new Set([...values].filter((h) => vhFind(list, h)).map((h) => +h))].sort((x, y) => x - y);
  const heads = used.map((h) => vhFind(list, h));
  const at = new Map(used.map((h, k) => [h, n + k]));
  return { heads, index: (h) => (vhIs(h) ? at.get(+h) ?? null : +h) };
}

/* Two spools far apart in light: with opaque filaments a dark layer hides
   the light one under it, so the print looks darker and more striped than
   the swatch. The difference of the colors' relative luminance (WCAG, from
   sRGB `#rrggbb`), 0 to 1 (black and white: 1); null for a color not read.
   The sheet warns from VH_CONTRAST_WARN on, never blocking. */
const VH_CONTRAST_WARN = 0.5;
function vhLuminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
function vhContrast(a, b) {
  const la = vhLuminance(a), lb = vhLuminance(b);
  return la == null || lb == null ? null : Math.abs(la - lb);
}
const vhContrastWarn = (a, b) => (vhContrast(a, b) ?? 0) >= VH_CONTRAST_WARN;

/* Smooth mix (each layer of a virtual head split between its two heads)
   is a plate's switch, on unless the plate says otherwise; it matters only
   when the plate prints with a virtual head (`values`: its head values). */
const vhSmoothOn = (plate) => plate?.smoothMix !== false;
const vhUsesVirtual = (values, list) => [...(values || [])].some((h) => !!vhFind(list, h));

/* A color mixed in linear light: the swatch's stand-in until the engine's
   mixer (mix_colors) answers. */
function vhMixLinear(a, b, t) {
  const rgb = (h) => {
    const m = /^#?([0-9a-f]{6})/i.exec(String(h || ""));
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  };
  const x = rgb(a), y = rgb(b);
  if (!x || !y) return x ? a : b || "";
  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const srgb = (v) => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
  return "#" + x.map((c, i) => srgb(lin(c) * (1 - t) + lin(y[i]) * t).toString(16).padStart(2, "0")).join("");
}

if (typeof module !== "undefined") {
  module.exports = { VH_BASE, VH_MAX, VH_PCTS, VH_CONTRAST_WARN, vhLuminance, vhContrast, vhContrastWarn, vhSmoothOn, vhUsesVirtual, vhIs, vhUid, vhValue, vhFind, vhOrphan, vhName, vhPct, vhNotch, vhCadence, vhShare, vhRatio, vhPhysical, vhDuplicate, vhCanAdd, vhLoaded, vhUnloaded, vhEngine, vhMixLinear };
}
