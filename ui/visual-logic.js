"use strict";
/* Pictures for the slice settings' lists (visual.js, slice-adv.js): which
   control a list gets, the support styles a support type allows, the
   entries with a value the list does not offer. Pure, for
   scripts/test-visual.js. */

/* The control for a list of `n` options of which `icons` have a picture:
   mostly pictured, inline pills up to 3 options, a grid of pictures
   beyond; without pictures, a segmented control up to 4 short options
   (`labels`, VP_SEG_CHARS in all, so that it fits a row), a select beyond. */
const VP_SEG_CHARS = 50;
function vpMode(n, icons, labels = []) {
  if (n > 0 && icons * 2 >= n) return n <= 3 ? "pills" : "visual";
  return n <= 4 && labels.join("").length <= VP_SEG_CHARS ? "segmented" : "select";
}

/* Columns of the grid: 2 for 4 cards or fewer, 3 beyond. */
const vpColumns = (n) => (n <= 4 ? 2 : 3);

/* Support styles by support type, as Orca offers them (ConfigManipulation.cpp,
   Tab.cpp): the engine takes any other as "default", which is grid for
   normal supports and organic for tree ones. */
const VP_STYLES = {
  normal: ["default", "grid", "snug"],
  tree: ["default", "tree_slim", "tree_strong", "tree_hybrid", "organic"],
};
const vpSupportKind = (type) => (String(type || "").startsWith("tree") ? "tree" : "normal");
const vpStyles = (type) => VP_STYLES[vpSupportKind(type)];

/* The style once the support type becomes `type`: kept when it suits it,
   "default" otherwise — as Orca's settings do. */
const vpStyleAfterType = (type, style) => (vpStyles(type).includes(style) ? style : "default");

/* A list's options ([value, label]) with the current `value`: when the
   list does not offer it — a value from a project or an older profile, or
   one hidden here — an extra entry, chosen and not pickable, so that the
   list never shows another value than the one sliced with. `known`: every
   value of the setting (hidden ones included). Each: { value, label,
   state: "ok" | "unknown" | "hidden" }. */
function vpEntries(options, value, known = []) {
  const out = options.map(([v, label]) => ({ value: String(v), label: String(label), state: "ok" }));
  const v = value == null ? "" : String(value);
  if (v !== "" && !out.some((e) => e.value === v)) {
    out.push({ value: v, label: v, state: known.includes(v) ? "hidden" : "unknown" });
  }
  return out;
}

if (typeof module !== "undefined") module.exports = { VP_SEG_CHARS, vpMode, vpColumns, VP_STYLES, vpSupportKind, vpStyles, vpStyleAfterType, vpEntries };
