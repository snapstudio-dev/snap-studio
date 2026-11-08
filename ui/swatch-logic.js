"use strict";
/* Head pickers shown as spools (slice-ui.js swatchSelect, Prepare's
   palette): the entries of a picker, the edge of a colour dot, the moves
   of the keyboard. Pure, for scripts/test-swatch.js. */

/* Relative luminance of "#rrggbb" (alpha ignored), 0 to 1; null when it is
   not a colour. */
function swLuma(hex) {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(hex || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((c) => lin(c / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/* A dot close to white or to black gets an edge in the text's colour: a
   white spool vanishes on the light theme, a black one on the dark. */
function swEdge(hex) {
  const l = swLuma(hex);
  return l != null && (l > 0.85 || l < 0.02);
}

/* What a picker shows of each head. `count`: the printer's heads; `slots`:
   its spools as read ({ index, present, kind, color }), empty when offline;
   `material(h)`: the material of the profile the head slices with, if
   known — what the slice gets, else the spool's; `base`: the number of head 0 in the select's values (1 for the
   slice sheet's advanced keys, 0 elsewhere); `warn`: heads to flag.
   Each: { value, h, kind, color, state, disabled, warn } where state is
   "ok", "empty" (known empty, still pickable: a spool can be loaded before
   printing), "unknown" (loaded, colour not read) or "none" (nothing read). */
function swHeads({ count, slots = [], material = () => "", base = 0, warn = [] }) {
  return Array.from({ length: Math.max(0, count | 0) }, (_, h) => {
    const s = (slots || []).find((x) => x.index === h);
    const state = !s ? "none" : !s.present ? "empty" : s.color ? "ok" : "unknown";
    return {
      value: String(h + base),
      h,
      kind: material(h) || (s?.present && s.kind) || "",
      color: s?.present && s.color ? s.color : "",
      state,
      disabled: false,
      warn: warn.includes(h),
    };
  });
}

/* The picker's list: "Automatic" first when `auto` ({ value, warn }) is set, the heads, and
   a stored value no head matches (a printer with fewer heads chosen since)
   kept as "unavailable" — shown, never silently changed, not pickable. */
function swEntries(heads, { value = null, auto = null, base = 0 } = {}) {
  const out = [];
  if (auto) out.push({ value: auto.value, h: null, kind: "", color: "", state: "auto", disabled: false, warn: !!auto.warn });
  out.push(...heads);
  const v = value == null ? null : String(value);
  if (v != null && v !== "" && !out.some((e) => e.value === v) && /^\d+$/.test(v) && +v - base >= 0) {
    // A virtual head no longer there (100 + uid) is no physical head.
    const gone = +v >= 100;
    out.push({ value: v, h: gone ? null : +v - base, v: gone ? { gone: true } : undefined, kind: "", color: "", state: "unavailable", disabled: true, warn: false });
  }
  return out;
}

/* The virtual heads of a picker (virtual-logic.js): `list` the printer's
   [{ uid, a, b, pct }], `colorOf(v)` its mix, `name(v)` "V1",
   `bonds(v)` false when its two materials no longer bond, `parts(v)` its
   two heads' colors. Each: { value (100 + uid), h: null, v: { name, a, b,
   ratio, ca, cb }, color, state: "ok", warn }. */
function swVirtual({ list = [], colorOf = () => "", name = () => "", ratio = () => "", bonds = () => true, parts = () => ["", ""] }) {
  return list.map((v) => ({
    value: String(100 + v.uid),
    h: null,
    v: { name: name(v), a: v.a, b: v.b, ratio: ratio(v), ca: parts(v)[0] || "", cb: parts(v)[1] || "" },
    kind: "",
    color: colorOf(v) || "",
    state: "ok",
    disabled: false,
    warn: bonds(v) === false,
  }));
}

/* Roving focus among `items` ({ disabled }): the next one for `key` from
   `i`, skipping disabled ones; -1 when none can take it. Left and Right
   (and, in a single column, Up and Down) move by one, wrapping; in a grid
   of `cols` columns Up and Down move by a row, without wrapping (the focus
   stays at an edge). */
const SW_KEYS = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1, Home: "first", End: "last" };
function swMove(items, i, key, cols = 1) {
  const k = SW_KEYS[key];
  const ok = items.map((x, j) => (x && !x.disabled ? j : -1)).filter((j) => j >= 0);
  if (k == null || !ok.length) return -1;
  if (k === "first") return ok[0];
  if (k === "last") return ok[ok.length - 1];
  const n = items.length;
  if (cols > 1 && (key === "ArrowUp" || key === "ArrowDown")) {
    for (let j = i + k * cols; j >= 0 && j < n; j += k * cols) if (ok.includes(j)) return j;
    return ok.includes(i) ? i : -1;
  }
  for (let s = 1; s <= n; s++) {
    const j = (((i + k * s) % n) + n) % n;
    if (ok.includes(j)) return j;
  }
  return -1;
}

if (typeof module !== "undefined") module.exports = { swLuma, swEdge, swHeads, swEntries, swVirtual, swMove, SW_KEYS };
