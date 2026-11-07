"use strict";
/* Settings of the slice sheet's Advanced panels shown only with the one
   they detail (slice-adv.js ADV_WHEN). Pure, for scripts/test-adv.js. */

const advTrue = (v) => String(v) === "1" || v === true || String(v) === "true";

/* key → { on: the setting it details, when(value of that setting) }. */
const ADV_DEPENDS = {
  // The speeds by how much a line overhangs: when it slows down for them.
  ...Object.fromEntries(["overhang_1_4_speed", "overhang_2_4_speed", "overhang_3_4_speed", "overhang_4_4_speed"].map((k) => [k, { on: "enable_overhang_speed", when: advTrue }])),
  // Ironing's pattern, flow, spacing and speed: with ironing.
  ...Object.fromEntries(["ironing_pattern", "ironing_flow", "ironing_spacing", "ironing_speed"].map((k) => [k, { on: "ironing_type", when: (v) => v != null && v !== "no ironing" }])),
  // Fuzzy skin's thickness and spacing: with fuzzy skin.
  ...Object.fromEntries(["fuzzy_skin_thickness", "fuzzy_skin_point_distance"].map((k) => [k, { on: "fuzzy_skin", when: (v) => v != null && v !== "none" }])),
  // The skirt's distance, height and draft shield: with a skirt.
  ...Object.fromEntries(["skirt_distance", "skirt_height", "draft_shield"].map((k) => [k, { on: "skirt_loops", when: (v) => +v > 0 }])),
};

/* Whether `k` is shown, `val(key)` giving the values in effect. */
function advShown(k, val) {
  const d = ADV_DEPENDS[k];
  return !d || d.when(val(d.on));
}

/* ------------------------------------------------------------ levels */

/* The sheet's two levels: Basic shows it as it was in 0.14.2, Advanced
   adds the panels and group below. The level only changes what is shown:
   every value applies in both. */
const SL_LEVELS = ["basic", "advanced"];
const sliceLevelValid = (v) => SL_LEVELS.includes(v);

/* Advanced only: whole panels (slice-adv.js ADV_CATS ids) and groups of
   the other panels (their title ids). */
const ADV_LEVEL_CATS = new Set(["quality", "infill", "walls", "surfaces", "other"]);
const ADV_LEVEL_GROUPS = new Set(["slice.adv.g.ooze"]);

/* Every key those panels and groups hold (scripts/test-adv.js checks the
   list against ADV_CATS). */
const ADV_LEVEL_KEYS = new Set([
  // Quality
  "initial_layer_print_height", "line_width", "initial_layer_line_width", "outer_wall_line_width", "top_surface_line_width",
  "elefant_foot_compensation", "xy_hole_compensation", "xy_contour_compensation", "resolution", "enable_arc_fitting",
  "detect_overhang_wall", "enable_overhang_speed", "overhang_1_4_speed", "overhang_2_4_speed", "overhang_3_4_speed",
  "overhang_4_4_speed", "bridge_flow", "thick_bridges",
  // Infill
  "sparse_infill_pattern", "infill_direction", "infill_wall_overlap", "infill_anchor", "infill_anchor_max", "infill_combination",
  "minimum_sparse_infill_area",
  // Walls
  "wall_generator", "wall_sequence", "wall_direction", "precise_outer_wall", "detect_thin_wall", "only_one_wall_top",
  "only_one_wall_first_layer", "extra_perimeters_on_overhangs",
  // Surfaces
  "top_shell_layers", "top_shell_thickness", "bottom_shell_layers", "bottom_shell_thickness", "ensure_vertical_shell_thickness",
  "top_surface_pattern", "bottom_surface_pattern", "internal_solid_infill_pattern", "ironing_type", "ironing_pattern",
  "ironing_flow", "ironing_spacing", "ironing_speed",
  // Other
  "print_sequence", "spiral_mode", "fuzzy_skin", "fuzzy_skin_thickness", "fuzzy_skin_point_distance", "skirt_loops",
  "skirt_distance", "skirt_height", "draft_shield", "reduce_crossing_wall", "reduce_infill_retraction",
  // Multi-material's ooze prevention group
  "ooze_prevention", "standby_temperature_delta", "preheat_time", "idle_temperature",
]);

/* Whether a panel's group (title id) shows at `level`. */
const advLevelShows = (cat, group, level) => level === "advanced" || (!ADV_LEVEL_CATS.has(cat) && !ADV_LEVEL_GROUPS.has(group));

/* The kept differences (`adv`, key → value) the level hides: the
   advanced-only ones that apply now (`applies(k)`: shown with the setting
   they detail, the multi-material ones with several heads). None in
   Advanced. */
function advHiddenKeys(adv, level, applies = () => true) {
  if (level === "advanced") return [];
  return Object.keys(adv || {}).filter((k) => ADV_LEVEL_KEYS.has(k) && applies(k));
}

/* The first level of someone who never chose one: Advanced when a
   remembered machine profile (snapstudio.slice) already holds an
   advanced-only difference — they used the 0.15 settings, and finding
   them gone would look like a loss — Basic otherwise. */
function sliceLevelDefault(memory) {
  try {
    for (const [name, m] of Object.entries(memory || {})) {
      if (name === "last" || name === "printer" || name.startsWith("printer:")) continue;
      const adv = m && typeof m === "object" ? m.adv : null;
      if (adv && typeof adv === "object" && Object.keys(adv).some((k) => ADV_LEVEL_KEYS.has(k))) return "advanced";
    }
  } catch {}
  return "basic";
}

if (typeof module !== "undefined") {
  module.exports = { ADV_DEPENDS, advShown, advTrue, SL_LEVELS, sliceLevelValid, ADV_LEVEL_CATS, ADV_LEVEL_GROUPS, ADV_LEVEL_KEYS, advLevelShows, advHiddenKeys, sliceLevelDefault };
}
