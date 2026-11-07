"use strict";
/* Advanced settings of the slice sheet, Snapmaker Orca style.

   Supports, Brim, Seam and Multi-material each open a sub-panel inside the
   sheet. Every field is an Orca process key, described by
   `assets/orca-settings.<lang>.json` (label, unit, values, tooltip) and
   checked against the shipped engine (Snapmaker Orca 2.4.0). Only values
   that differ from the chosen profile are kept, in `SL.adv`, remembered per
   machine profile, and sent to the engine as `overrides` (which win over the
   profile and the quick settings, see slice.rs). */

const ADV = { schema: null, defaults: {}, cat: null, seq: 0 };
SL.adv = SL.adv || {};

/* Engine defaults (Snapmaker Orca 2.4.0, PrintConfig.cpp) for the keys a
   profile may leave out: the engine then applies these. */
const ADV_ENGINE_DEFAULTS = {
  seam_position: "aligned", staggered_inner_seams: "0", seam_gap: "10%",
  support_type: "normal(auto)", support_style: "default", support_threshold_angle: "30",
  support_on_build_plate_only: "0", support_critical_regions_only: "0", support_remove_small_overhang: "1",
  support_top_z_distance: "0.2", support_bottom_z_distance: "0.2", support_interface_top_layers: "3",
  support_interface_bottom_layers: "0", support_interface_pattern: "auto", support_interface_spacing: "0.5",
  support_base_pattern: "default", support_base_pattern_spacing: "2.5", support_object_xy_distance: "0.35",
  bridge_no_support: "0", tree_support_branch_angle: "40", tree_support_branch_angle_organic: "40",
  tree_support_branch_distance: "5", tree_support_branch_distance_organic: "1", tree_support_branch_diameter: "5",
  tree_support_branch_diameter_organic: "2", tree_support_tip_diameter: "0.8", tree_support_wall_count: "0",
  tree_support_auto_brim: "1", tree_support_brim_width: "3", support_filament: "0", support_interface_filament: "0",
  brim_type: "auto_brim", brim_width: "0", brim_object_gap: "0", brim_ears_max_angle: "125",
  enable_prime_tower: "0", prime_tower_width: "60", prime_volume: "45", prime_tower_brim_width: "3",
  flush_into_infill: "0", flush_into_objects: "0", flush_into_support: "1",
  wall_filament: "1", sparse_infill_filament: "1", solid_infill_filament: "1",
  wipe_tower_filament: "0", ooze_prevention: "0", standby_temperature_delta: "-5", preheat_time: "30",
  // A filament key (sent to every filament, slice.rs): 0 on the U1's.
  idle_temperature: "0", print_sequence: "by layer",
  // Quality, Infill, Walls, Surfaces, Other (#60).
  initial_layer_print_height: "0.2", line_width: "0", initial_layer_line_width: "0", outer_wall_line_width: "0",
  top_surface_line_width: "0", elefant_foot_compensation: "0", xy_hole_compensation: "0", xy_contour_compensation: "0",
  resolution: "0.01", enable_arc_fitting: "0", enable_overhang_speed: "1", overhang_1_4_speed: "0", overhang_2_4_speed: "0",
  overhang_3_4_speed: "0", overhang_4_4_speed: "0", detect_overhang_wall: "1", bridge_flow: "1", thick_bridges: "0",
  sparse_infill_pattern: "crosshatch", infill_direction: "45", infill_wall_overlap: "15%", infill_anchor: "400%",
  infill_anchor_max: "20", infill_combination: "0", minimum_sparse_infill_area: "15",
  wall_generator: "arachne", wall_sequence: "inner wall/outer wall", wall_direction: "auto", precise_outer_wall: "1",
  detect_thin_wall: "0", only_one_wall_top: "0", only_one_wall_first_layer: "0", extra_perimeters_on_overhangs: "0",
  top_shell_layers: "4", bottom_shell_layers: "3", top_shell_thickness: "0.6", bottom_shell_thickness: "0",
  ensure_vertical_shell_thickness: "ensure_all", top_surface_pattern: "monotonicline", bottom_surface_pattern: "monotonic",
  internal_solid_infill_pattern: "monotonic", ironing_type: "no ironing", ironing_pattern: "rectilinear", ironing_flow: "10%",
  ironing_spacing: "0.1", ironing_speed: "20", spiral_mode: "0", fuzzy_skin: "none", fuzzy_skin_thickness: "0.2",
  fuzzy_skin_point_distance: "0.3", skirt_loops: "1", skirt_distance: "2", skirt_height: "1", draft_shield: "disabled",
  reduce_crossing_wall: "0", reduce_infill_retraction: "0",
  // The tower's shape, for its estimate in Prepare (prepare-tower.js).
  wipe_tower_wall_type: "rectangle", wipe_tower_rib_width: "8", wipe_tower_extra_rib_length: "0",
  wipe_tower_extra_spacing: "100%",
};
/* The prime tower's switch is the plate's (prepare-tower.js), never the
   profile's: a new plate starts without a tower. */
const advVal = (k) => (k === "enable_prime_tower" ? (PR.tower.on ? "1" : "0") : k in SL.adv ? SL.adv[k] : ADV.defaults[k]);
const advOn = (k) => String(advVal(k)) === "1" || advVal(k) === true;
const multiHead = () => headCount() > 1;
const isTree = () => String(advVal("support_type") || "").startsWith("tree");
/* Orca: a tree support in "default" style is organic ("Default (Grid/Organic)"). */
const isOrganic = () => isTree() && ["organic", "default"].includes(advVal("support_style"));

/* Keys holding a head number, 1-based. The support ones and the prime
   tower's accept 0 ("default": the engine picks); the per-feature ones
   start at 1. */
const ADV_FILAMENT = new Set(["support_filament", "support_interface_filament", "wall_filament", "sparse_infill_filament", "solid_infill_filament", "wipe_tower_filament"]);
const ADV_HEAD_AUTO = new Set(["support_filament", "support_interface_filament", "wipe_tower_filament"]);
/* Steps finer (or coarser) than a tenth of a millimetre. */
const ADV_STEPS = {
  line_width: 0.01, initial_layer_line_width: 0.01, outer_wall_line_width: 0.01, top_surface_line_width: 0.01,
  elefant_foot_compensation: 0.01, xy_hole_compensation: 0.01, xy_contour_compensation: 0.01, resolution: 0.001,
  initial_layer_print_height: 0.01, bridge_flow: 0.05, ironing_spacing: 0.01, fuzzy_skin_thickness: 0.05,
  fuzzy_skin_point_distance: 0.05, top_shell_thickness: 0.1, bottom_shell_thickness: 0.1,
  overhang_1_4_speed: 1, overhang_2_4_speed: 1, overhang_3_4_speed: 1, overhang_4_4_speed: 1, ironing_speed: 1,
  infill_direction: 1, minimum_sparse_infill_area: 1, skirt_distance: 0.5, infill_anchor_max: 1,
};
/* Units the settings catalog leaves out. */
const ADV_UNITS = { standby_temperature_delta: "°C", idle_temperature: "°C", infill_anchor_max: "mm" };
/* Values hidden from a list: handled elsewhere ("no_brim" is the switch) or
   needing tools the app does not have (painted brim). */
const ADV_HIDE = { brim_type: ["no_brim", "painted"] };
/* Values a list offers by the others (visual-logic.js): the support styles
   that suit the support type. */
const ADV_OPTIONS = { support_style: () => vpStyles(advVal("support_type")) };
/* A control forced for a list: "select", "segmented", "pills" or
   "visual"; otherwise vpMode() decides from its options and pictures. */
const ADV_UI = {};

/* Sub-panels: groups of keys, with the conditions under which they apply. */
const ADV_CATS = {
  support: {
    title: "slice.supports",
    groups: [
      { t: "slice.adv.g.support", keys: ["support_type", "support_style", "support_threshold_angle", "support_on_build_plate_only", "support_critical_regions_only", "support_remove_small_overhang"] },
      { t: "slice.adv.g.interface", keys: ["support_top_z_distance", "support_bottom_z_distance", "support_interface_top_layers", "support_interface_bottom_layers", "support_interface_pattern", "support_interface_spacing"] },
      { t: "slice.adv.g.base", keys: ["support_base_pattern", "support_base_pattern_spacing", "support_object_xy_distance", "bridge_no_support"] },
      {
        t: "slice.adv.g.tree",
        when: isTree,
        keys: () => [
          ...(isOrganic()
            ? ["tree_support_branch_angle_organic", "tree_support_branch_distance_organic", "tree_support_branch_diameter_organic"]
            : ["tree_support_branch_angle", "tree_support_branch_distance", "tree_support_branch_diameter"]),
          "tree_support_tip_diameter", "tree_support_wall_count", "tree_support_auto_brim", "tree_support_brim_width",
        ],
      },
      { t: "slice.adv.g.support_filament", when: multiHead, keys: ["support_filament", "support_interface_filament"] },
    ],
  },
  brim: { title: "slice.brim", groups: [{ t: "slice.brim", keys: ["brim_type", "brim_width", "brim_object_gap", "brim_ears_max_angle"] }] },
  seam: { title: "slice.adv.seam", groups: [{ t: "slice.adv.seam", keys: ["seam_position", "staggered_inner_seams", "seam_gap"] }] },
  // The quick settings' detailed panels (the ⚙ of the Quality section and
  // of the Infill and Walls tiles), and the Surfaces and Other rows.
  quality: {
    title: "slice.quality",
    groups: [
      { t: "slice.adv.g.first_layer", keys: ["initial_layer_print_height"] },
      { t: "slice.adv.g.widths", keys: ["line_width", "initial_layer_line_width", "outer_wall_line_width", "top_surface_line_width"] },
      { t: "slice.adv.g.precision", keys: ["elefant_foot_compensation", "xy_hole_compensation", "xy_contour_compensation", "resolution", "enable_arc_fitting"] },
      { t: "slice.adv.g.overhangs", keys: ["detect_overhang_wall", "enable_overhang_speed", "overhang_1_4_speed", "overhang_2_4_speed", "overhang_3_4_speed", "overhang_4_4_speed", "bridge_flow", "thick_bridges"] },
    ],
  },
  infill: {
    title: "slice.infill",
    groups: [
      { t: "slice.infill", keys: ["sparse_infill_pattern", "infill_direction", "infill_wall_overlap"] },
      { t: "slice.adv.g.anchor", keys: ["infill_anchor", "infill_anchor_max"] },
      { t: "slice.adv.g.infill_more", keys: ["infill_combination", "minimum_sparse_infill_area"] },
    ],
  },
  walls: {
    title: "slice.walls",
    groups: [
      { t: "slice.walls", keys: ["wall_generator", "wall_sequence", "wall_direction"] },
      { t: "slice.adv.g.walls_more", keys: ["precise_outer_wall", "detect_thin_wall", "only_one_wall_top", "only_one_wall_first_layer", "extra_perimeters_on_overhangs"] },
    ],
  },
  surfaces: {
    title: "slice.adv.surfaces",
    groups: [
      { t: "slice.adv.g.shells", keys: ["top_shell_layers", "top_shell_thickness", "bottom_shell_layers", "bottom_shell_thickness", "ensure_vertical_shell_thickness"] },
      { t: "slice.adv.g.patterns", keys: ["top_surface_pattern", "bottom_surface_pattern", "internal_solid_infill_pattern"] },
      { t: "slice.adv.g.ironing", keys: ["ironing_type", "ironing_pattern", "ironing_flow", "ironing_spacing", "ironing_speed"] },
    ],
  },
  other: {
    title: "slice.adv.other",
    groups: [
      { t: "slice.adv.g.sequence", keys: ["print_sequence", "spiral_mode"] },
      { t: "slice.adv.g.fuzzy", keys: ["fuzzy_skin", "fuzzy_skin_thickness", "fuzzy_skin_point_distance"] },
      { t: "slice.adv.g.skirt", keys: ["skirt_loops", "skirt_distance", "skirt_height", "draft_shield"] },
      { t: "slice.adv.g.travel", keys: ["reduce_crossing_wall", "reduce_infill_retraction"] },
    ],
  },
  mm: {
    title: "slice.adv.mm",
    groups: [
      // The tower's switch is on the sheet (#s-tower-sw), as Supports' and Brim's.
      { t: "slice.adv.g.tower", keys: ["wipe_tower_filament", "prime_tower_width", "prime_volume", "prime_tower_brim_width"] },
      { t: "slice.adv.g.ooze", keys: ["ooze_prevention", "standby_temperature_delta", "preheat_time", "idle_temperature"] },
      { t: "slice.adv.g.flush", keys: ["flush_into_infill", "flush_into_objects", "flush_into_support"] },
      { t: "slice.adv.g.features", keys: ["wall_filament", "sparse_infill_filament", "solid_infill_filament"] },
    ],
  },
};

/* A field shown only when it means something. */
const ADV_WHEN = {
  brim_ears_max_angle: () => advVal("brim_type") === "brim_ears",
  tree_support_brim_width: () => !advOn("tree_support_auto_brim"),
  // The tower's own settings stay shown with it off, as Supports' (its
  // switch is on the sheet; the panel says they wait for it).
  // The other heads' temperature while one prints: with ooze prevention.
  standby_temperature_delta: () => advOn("ooze_prevention"),
  preheat_time: () => advOn("ooze_prevention"),
  idle_temperature: () => advOn("ooze_prevention"),
  // Each with the setting it details (adv-logic.js).
  ...Object.fromEntries(Object.keys(ADV_DEPENDS).map((k) => [k, () => advShown(k, advVal)])),
};

/* Category keys that apply right now (multi-material only with several
   heads; brim keys only with the brim on). */
function advCatKeys(cat) {
  if (cat === "mm" && !multiHead()) return [];
  return ADV_CATS[cat].groups
    .filter((g) => !g.when || g.when())
    .flatMap((g) => (typeof g.keys === "function" ? g.keys() : g.keys));
}

/* Heads flagged in a head picker when the plate's materials do not all
   bond (spTowerAdvice; #s-tower says why): for the walls, the heads whose
   material does not bond with another of the plate's; for the tower's
   wall, the choices that leave it mixed — a head the plate does not print
   with, or Automatic — since a head it prints with is the fix. */
function advWarnHeads(k) {
  if (k !== "wipe_tower_filament" && k !== "wall_filament") return { heads: [], auto: false };
  const used = advTowerHeads();
  const a = spTowerAdvice({ heads: used, tower: advTowerOn(), wall: null });
  if (!a) return { heads: [], auto: false };
  if (k === "wall_filament") return { heads: [...new Set(a.pairs.flat())], auto: false };
  const fix = new Set(a.families.flatMap((g) => g.heads));
  return { heads: Array.from({ length: headCount() }, (_, h) => h).filter((h) => !fix.has(h)), auto: true };
}

/* Heads offered to the per-feature filament fields (swatch-logic.js
   swHeads, values from 1): from the shared "Heads and spools" state when
   heads.js is loaded, otherwise the heads configured in this sheet
   (renderHeads). */
function advHeadChoices(k) {
  const pid = typeof headsCount === "function" ? currentPrinter()?.id : null;
  const list = SL.lists?.filaments || null;
  const names = pid
    ? Array.from({ length: headsCount(pid) }, (_, i) => headsProfile(pid, i, list).name || "")
    : [...document.querySelectorAll("#s-heads select")].map((s) => s.value);
  const material = (h) => list?.find((f) => f.name === names[h])?.ftype || spMaterialFromName(names[h] || "");
  const heads = swHeads({ count: names.length, slots: pid ? headsSlots(pid) : SL.slots, material, base: 1, warn: advWarnHeads(k).heads });
  return heads.map((e) => ({ ...e, label: `T${e.h}${names[e.h] ? " · " + names[e.h] : ""}` }));
}

async function advSchema() {
  // Same catalog as the profile details (profiles.js).
  ADV.schema = await pdSchema();
  return ADV.schema;
}

/* Values sent to the engine: the kept differences, minus what does not
   apply (brim type with the brim off: the switch's "no_brim" must win). */
function advOverrides() {
  const o = { ...(SL.adv || {}) };
  // Sent either way: off unless the plate turns it on, whatever the profile.
  o.enable_prime_tower = advVal("enable_prime_tower");
  if (!$("s-brim").checked) for (const k of advCatKeysAll("brim")) delete o[k];
  if (!multiHead()) {
    for (const k of advCatKeysAll("mm")) delete o[k];
    delete o.support_filament;
    delete o.support_interface_filament;
  }
  // A setting hidden because the one it details is off (ADV_WHEN: ironing's
  // details without ironing…) is neither sent nor counted; SL.adv keeps it
  // for when that setting is on again.
  for (const k in o) if (ADV_WHEN[k] && !ADV_WHEN[k]()) delete o[k];
  for (const k in o) o[k] = String(o[k]);
  return o;
}
/* Every key of a category, whatever applies now (counting, resetting);
   with a `level`, only those of the groups it shows. */
const ADV_TREE_ALL = ["tree_support_branch_angle", "tree_support_branch_angle_organic", "tree_support_branch_distance", "tree_support_branch_distance_organic", "tree_support_branch_diameter", "tree_support_branch_diameter_organic", "tree_support_tip_diameter", "tree_support_wall_count", "tree_support_auto_brim", "tree_support_brim_width"];
function advCatKeysAll(cat, level = null) {
  return ADV_CATS[cat].groups
    .filter((g) => !level || advLevelShows(cat, g.t, level))
    .flatMap((g) => (typeof g.keys === "function" ? ADV_TREE_ALL : g.keys));
}
const advCountOf = (cat, level = null) => advCatKeysAll(cat, level).filter((k) => k in SL.adv && (!ADV_WHEN[k] || ADV_WHEN[k]())).length;
/* The advanced differences, for the summary: not the tower's switch,
   which is on the sheet. */
function advCount() {
  return Object.keys(advOverrides()).filter((k) => k !== "enable_prime_tower").length;
}

/* Machine profile changed: its remembered differences come back. */
function advLoad(saved) {
  SL.adv = { ...(saved || {}) };
  // Once remembered per machine: now the plate's.
  delete SL.adv.enable_prime_tower;
  advRefreshDefaults();
}

/* Reference values: the chosen profile with the quick settings, without
   the advanced differences. They also give the Speed adjustment its
   profile values (speed.js); a slice waits for them (`ADV.ready`). */
function advRefreshDefaults() {
  return (ADV.ready = advRefreshNow());
}
async function advRefreshNow() {
  const machine = $("s-machine").value, process = $("s-process").value;
  const seq = ++ADV.seq;
  if (machine && process) {
    try {
      const d = await invoke("slice_details", {
        name: process, machine, simple: currentSimple(),
        overrides: $("s-bed").value ? { curr_bed_type: $("s-bed").value } : {}, color: null,
      });
      if (seq !== ADV.seq) return;
      ADV.defaults = { ...ADV_ENGINE_DEFAULTS, ...Object.fromEntries(Object.entries(d?.values || {}).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])) };
      await spdSetProfile(d?.values || null);
    } catch {
      ADV.defaults = { ...ADV_ENGINE_DEFAULTS };
      await spdSetProfile(null);
    }
    if (seq !== ADV.seq) return;
  }
  // With the brim switch on, the quick settings send "outer_only".
  if ($("s-brim").checked) ADV.defaults.brim_type = "outer_only";
  // Differences equal to the new profile's values are no longer differences.
  for (const k of Object.keys(SL.adv)) if (String(SL.adv[k]) === String(ADV.defaults[k])) delete SL.adv[k];
  await advSchema().catch(() => null);
  advRenderRows();
  if (ADV.cat) advRenderPanel();
}

function advRemember() {
  const machine = $("s-machine").value;
  if (machine) remember(machine, { adv: SL.adv });
}

/* ------------------------------------------------------------ main rows */

function advLabel(k, v = advVal(k)) {
  const def = ADV.schema?.keys?.[k];
  if (v == null || v === "") return "";
  if (ADV_FILAMENT.has(k)) return +v > 0 ? `T${+v - 1}` : tr("slice.adv.default_head");
  // A list's option by its name; a number with suggested values (an
  // anchor length) keeps its unit when it is not one of them.
  if (def?.enum && (def.type === "enum" || v in def.enum)) return advOptLabel(k, v);
  if (def?.type === "bool") return tr(String(v) === "1" ? "common.yes" : "common.no");
  const unit = def?.unit || ADV_UNITS[k];
  return `${v}${unit && !String(v).endsWith("%") ? " " + unit : ""}`;
}

function advRenderRows() {
  if (!$("s-adv-mm-row")) return;
  $("s-adv-mm-row").classList.toggle("hidden", !multiHead());
  const sum = {
    support: $("s-supports").checked ? advLabel("support_type") : tr("slice.adv.off"),
    brim: $("s-brim").checked ? advLabel("brim_type", SL.adv.brim_type || "outer_only") : tr("slice.adv.off"),
    seam: advLabel("seam_position"),
    // Off with a virtual head: advised (it changes heads at every layer).
    mm: !advOn("enable_prime_tower")
      ? tr(prTowerVirtualUsed() ? "prepare.tower.virtual_hint" : "slice.adv.mm_no_tower")
      : prPillarsShown()
      ? tr("slice.tower.per_material")
      : +advVal("wipe_tower_filament") > 0
      ? tr("slice.adv.mm_tower_wall", { t: `T${+advVal("wipe_tower_filament") - 1}` })
      : tr("slice.adv.mm_tower"),
    surfaces: [
      tr("slice.adv.sum.shells", { top: advVal("top_shell_layers") ?? "—", bottom: advVal("bottom_shell_layers") ?? "—" }),
      advVal("ironing_type") && advVal("ironing_type") !== "no ironing" ? advLabel("ironing_type") : tr("slice.adv.sum.no_ironing"),
    ].join(" · "),
    other: [
      advLabel("print_sequence"),
      advOn("spiral_mode") && ADV.schema?.keys?.spiral_mode?.label,
      advVal("fuzzy_skin") && advVal("fuzzy_skin") !== "none" && ADV.schema?.keys?.fuzzy_skin?.label,
    ].filter(Boolean).join(" · "),
  };
  // The plate's switch, disabled with its reason when no tower can be
  // printed (as in Prepare).
  const tower = prTowerState();
  $("s-tower-sw").checked = advOn("enable_prime_tower");
  $("s-tower-sw").disabled = !!tower.reason || !!SL.job;
  $("s-tower-sw").title = tower.reason ? tr(`prepare.tower.why.${tower.reason}`) : "";
  for (const cat of Object.keys(ADV_CATS)) {
    // Quality, Infill and Walls have no row of their own: no summary.
    const s = $("s-adv-sum-" + cat);
    if (s) s.textContent = sum[cat] || "";
    // The keys the level shows: the hidden ones are in the hint below.
    const n = advCountOf(cat, slLevel());
    const btn = document.querySelector(`.sl-adv-btn[data-adv="${cat}"]`);
    btn.classList.toggle("mod", n > 0);
    btn.querySelector(".sl-adv-n").textContent = n || "";
    // Ten such buttons on the sheet: each says which panel it opens.
    btn.setAttribute("aria-label", `${tr("slice.adv.open")} — ${tr(ADV_CATS[cat].title)}${n ? ` (${n})` : ""}`);
  }
  slLevelHint();
  spdRenderRow();
  slSummary();
}

/* ------------------------------------------------------------ sub-panel */

async function advOpen(cat) {
  await advSchema();
  ADV.cat = cat;
  advFit();
  // The sheet can change height while the panel is open (spools read,
  // window resized): the panel follows.
  ADV.ro ||= new ResizeObserver(() => ADV.cat && advFit());
  ADV.ro.observe(document.querySelector("#smodal .sl-areas"));
  ADV.ro.observe(document.querySelector("#smodal .sl-box"));
  $("s-adv").classList.remove("hidden");
  advRenderPanel();
  requestAnimationFrame(() => $("s-adv-back").focus());
}

/* Covers exactly the sheet's areas: header and footer stay. */
function advFit() {
  const cols = document.querySelector("#smodal .sl-areas");
  Object.assign($("s-adv").style, { top: cols.offsetTop + "px", height: cols.offsetHeight + "px" });
}

function advClose() {
  if (PK.grid && $("s-adv-body").contains(PK.anchor)) closePicker();
  ADV.cat = null;
  ADV.styleNote = "";
  ADV.ro?.disconnect();
  $("s-adv").classList.add("hidden");
  advRenderRows();
}

function advField(k) {
  const def = ADV.schema?.keys?.[k];
  if (!def) return "";
  const v = advVal(k);
  const mod = k in SL.adv;
  let input;
  if (ADV_FILAMENT.has(k)) {
    // The select holds every value the head picker (advEnhance) may show,
    // a head this printer lacks included: kept, never silently changed.
    const opts = [...(ADV_HEAD_AUTO.has(k) ? [{ value: "0", label: tr("slice.adv.default_head") }] : []), ...advHeadChoices(k)];
    if (v != null && v !== "" && !opts.some((o) => o.value === String(v))) opts.push({ value: String(v), label: `T${+v - 1}` });
    input = `<select class="field" data-k="${k}">${opts
      .map((o) => `<option value="${o.value}"${String(v ?? opts[0].value) === o.value ? " selected" : ""}>${esc(o.label)}</option>`)
      .join("")}</select>`;
  } else if (def.type === "enum") {
    // A value the list does not offer stays shown as it is, chosen and not
    // pickable: the select would show its first option instead.
    const entries = vpEntries(advOptions(k), v, Object.keys(def.enum));
    input = `<select class="field" data-k="${k}">${entries
      .map((e) => {
        const label = e.state === "ok" ? e.label : tr(e.state === "hidden" ? "vp.hidden" : "vp.unknown", { v: def.enum[e.value] ?? e.value });
        return `<option value="${esc(e.value)}"${String(v) === e.value ? " selected" : ""}${e.state === "ok" ? "" : " disabled"}>${esc(label)}</option>`;
      })
      .join("")}</select>${k === "support_style" && ADV.styleNote ? `<small class="adv-note" role="status">${esc(ADV.styleNote)}</small>` : ""}`;
  } else if (def.type === "bool") {
    input = `<input type="checkbox" class="sw" role="switch" data-k="${k}"${String(v) === "1" ? " checked" : ""} />`;
  } else {
    // A percentage, or a "mm or %" value given in % (a line width in mm
    // stays in mm: "0.42" is not 0.42 %).
    const pct = String(v ?? "").endsWith("%") || def.unit === "%";
    const num = v == null ? "" : String(v).replace(/%$/, "");
    // Whole numbers and percentages by one, millimetres and the rest by a
    // tenth, unless the setting asks for finer (ADV_STEPS).
    const step = ADV_STEPS[k] ?? (def.type === "int" || pct ? 1 : 0.1);
    input = `<input type="number" class="field num" step="${step}" data-k="${k}" data-pct="${pct ? 1 : ""}" value="${esc(num)}" /><span class="unit">${esc(pct ? "%" : (def.unit || ADV_UNITS[k] || "").replace(/\s+(?:ou|or)\s+%$/, ""))}</span>`;
  }
  return `<div class="grow-row adv-row${mod ? " mod" : ""}" title="${esc(def.tooltip || "")}">
    <span class="k">${esc(def.label)}${mod ? `<small class="sub">${esc(tr("slice.adv.profile_value", { v: advLabel(k, ADV.defaults[k]) || "—" }))}</small>` : ""}</span>
    ${mod ? `<button class="adv-reset" data-reset="${k}" title="${esc(tr("slice.adv.reset"))}">↺</button>` : ""}
    ${input}
  </div>`;
}

function advRenderPanel() {
  if (ADV.cat === "speed") return spdRenderPanel();
  const c = ADV_CATS[ADV.cat];
  if (!c) return;
  $("s-adv-title").textContent = tr(c.title);
  $("s-adv-reset").classList.toggle("hidden", advCountOf(ADV.cat, slLevel()) === 0);
  const note = ADV.cat === "support" && !$("s-supports").checked ? tr("slice.adv.support_off")
    : ADV.cat === "brim" && !$("s-brim").checked ? tr("slice.adv.brim_off")
    : ADV.cat === "mm" && !advOn("enable_prime_tower") ? tr("slice.adv.tower_off")
    : "";
  const groups = c.groups
    .filter((g) => (!g.when || g.when()) && advLevelShows(ADV.cat, g.t, slLevel()))
    .map((g) => {
      const keys = (typeof g.keys === "function" ? g.keys() : g.keys).filter((k) => !ADV_WHEN[k] || ADV_WHEN[k]());
      const rows = keys.map(advField).join("");
      if (!rows) return "";
      // One tower per material: the single tower's settings do nothing.
      if (g.t === "slice.adv.g.tower" && prPillarsShown()) {
        return `<div class="set-section">${esc(tr(g.t))}</div><div class="sl-adv-note info">${esc(tr("slice.tower.single_only"))}</div><fieldset class="group adv-off" disabled>${rows}</fieldset>`;
      }
      return `<div class="set-section">${esc(tr(g.t))}</div><div class="group">${rows}</div>`;
    })
    .join("");
  // Smooth mix, with a virtual head on the plate: the plate's switch, not
  // a profile's setting.
  const smooth =
    ADV.cat === "mm" && slMixes()
      ? `<div class="group sl-mix"><div class="grow-row adv-row">
          <span class="k"><label for="s-smooth-mix">${esc(tr("slice.mix.smooth"))}</label><small class="sl-mix-hint">${esc(tr("slice.mix.smooth_hint"))}</small></span>
          <input type="checkbox" id="s-smooth-mix" class="sw" role="switch"${vhSmoothOn(PR) ? " checked" : ""}${SL.job ? " disabled" : ""} />
        </div></div>`
      : "";
  // A head popover opened on a field about to be redrawn goes with it.
  if (PK.grid && $("s-adv-body").contains(PK.anchor)) closePicker();
  // Smooth mix first: the note above the groups is about the tower.
  $("s-adv-body").innerHTML = smooth + (note ? `<div class="sl-adv-note">${esc(note)}</div>` : "") + groups;
  advEnhance();
  steppersIn($("s-adv-body"));
}

/* A list's options, [value, label], in the catalog's order: hidden values
   left out, and those another setting rules out. */
function advOptions(k) {
  const def = ADV.schema?.keys?.[k];
  const hide = ADV_HIDE[k] || [];
  const only = ADV_OPTIONS[k]?.();
  return Object.keys(def?.enum || {})
    .filter((v) => !hide.includes(v) && (!only || only.includes(v)))
    .map((v) => [v, advOptLabel(k, v)]);
}

/* An option's words, from the catalog. */
const advOptLabel = (k, v) => ADV.schema?.keys?.[k]?.enum?.[v] ?? v;

/* An option's picture and its one-line explanation. */
const advIcon = (k, v) => SLICE_ICONS[k]?.[v] || SLICE_ICON_UNKNOWN;
function advDesc(k, v) {
  // The patterns (infill, surfaces, ironing) share their explanations.
  for (const key of [`slice.vp.${k}.${v}`, ...(ADV_PATTERNS.has(k) ? [`slice.vp.pattern.${v}`] : [])]) {
    const d = tr(key);
    if (d !== key) return d;
  }
  return "";
}
const ADV_PATTERNS = new Set(["sparse_infill_pattern", "top_surface_pattern", "bottom_surface_pattern", "internal_solid_infill_pattern", "ironing_pattern"]);

/* The control a list gets (ADV_UI, otherwise vpMode). */
function advUi(k) {
  const opts = advOptions(k);
  return ADV_UI[k] || vpMode(opts.length, opts.filter(([v]) => SLICE_ICONS[k]?.[v]).length, opts.map(([, l]) => l));
}

/* The fields as pickers: heads with their spools' colours and materials,
   lists with pictures or segments. */
function advEnhance() {
  $("s-adv-body").querySelectorAll("select[data-k]").forEach((sel) => {
    const k = sel.dataset.k;
    const def = ADV.schema?.keys?.[k];
    if (!ADV_FILAMENT.has(k)) {
      if (def?.type !== "enum") return;
      const ui = advUi(k);
      // The group's name: the field's, not the row's text with its
      // "Profile value" line.
      const name = () => def.label;
      if (ui === "visual") {
        const mod = k in SL.adv;
        visualSelect(sel, {
          icons: (v) => advIcon(k, v),
          desc: (v) => advDesc(k, v),
          label: def.label,
          columns: vpColumns(advOptions(k).length),
          note: () => (mod ? tr("slice.adv.profile_value", { v: advLabel(k, ADV.defaults[k]) || "—" }) : ""),
        });
      } else if (ui === "pills") {
        segmented(sel, { cls: "visual", icons: (v) => `<span class="vp-ico">${advIcon(k, v)}</span>`, titleOf: (v) => advDesc(k, v), name });
      } else if (ui === "segmented") {
        segmented(sel, { titleOf: (v) => advDesc(k, v), name });
      }
      return;
    }
    swatchSelect(sel, () => advHeadChoices(k), {
      auto: ADV_HEAD_AUTO.has(k) ? () => ({ value: "0", warn: advWarnHeads(k).auto }) : null,
      base: 1,
      label: ADV.schema?.keys?.[k]?.label || "",
      warnTag: tr(k === "wipe_tower_filament" ? "swatch.tower_mixed" : "swatch.no_bond"),
    });
  });
}

function advSet(k, v) {
  if (k === "enable_prime_tower") return prTowerSetOn(String(v) === "1");
  if (v === "" || v == null || String(v) === String(ADV.defaults[k])) delete SL.adv[k];
  else SL.adv[k] = String(v);
  ADV.styleNote = "";
  // A support type the style does not suit: the style goes back to
  // Default, as in Orca's settings — the engine would take it so anyway.
  if (k === "support_type") {
    const style = advVal("support_style");
    const next = vpStyleAfterType(advVal("support_type"), style);
    if (next !== style) {
      if (String(ADV.defaults.support_style) === next) delete SL.adv.support_style;
      else SL.adv.support_style = next;
      const kind = VP_STYLES.tree.includes(style) ? "tree" : "normal";
      ADV.styleNote = tr("slice.vp.style_reset", { style: advOptLabel("support_style", style), kind: tr(`slice.vp.kind.${kind}`) });
    }
  }
  advRemember();
  advRenderPanel();
  advRenderRows();
  // A head chosen for supports, walls or infill counts for the plate.
  if (ADV_FILAMENT.has(k) && typeof pdBedLine === "function") pdBedLine();
}

/* Heads the advanced settings send elements to — supports (when on),
   walls, infill, the tower's wall (`tower`: when it is printed) — as the
   engine gets them: { key: head }. */
function advHeads({ tower = true } = {}) {
  const o = advOverrides();
  const out = {};
  for (const k of ADV_FILAMENT) {
    const v = +o[k];
    if (!(v > 0)) continue;
    if (k.startsWith("support") && !$("s-supports").checked) continue;
    // The tower's outer wall: only with a tower.
    if (k === "wipe_tower_filament" && !(tower && advTowerOn())) continue;
    out[k] = v - 1;
  }
  return out;
}

/* Those heads, short, for the summary: { supports: "T3", others: "walls T1" }. */
function advHeadsSummary() {
  const h = advHeads();
  const list = (...keys) => [...new Set(keys.map((k) => h[k]).filter((x) => x != null))].map((x) => "T" + x).join("/");
  const others = [
    h.wall_filament != null && tr("slice.sum.h.walls", { t: list("wall_filament") }),
    list("sparse_infill_filament", "solid_infill_filament") && tr("slice.sum.h.infill", { t: list("sparse_infill_filament", "solid_infill_filament") }),
  ].filter(Boolean);
  return { supports: list("support_filament", "support_interface_filament"), others: others.join(" · ") };
}

/* ------------------------------------------------------------ prime tower */

/* A prime tower is printed: on, with two heads used or more, layer by
   layer (the engine prints none object by object) — the tower Prepare
   shows (prTowerState). */
const advTowerOn = () => multiHead() && prTowerShown();

/* The heads the plate prints with — its colors' heads, and those the
   advanced settings send supports, walls, infill or the tower's wall to —
   with their filament's material (the profile's type, else its name). */
function advTowerHeads() {
  const names = [...document.querySelectorAll("#s-heads select")].map((s) => s.value);
  const used = new Set([...slUsedSet(), ...Object.values(advHeads())].filter((n) => n < names.length));
  return [...used].sort((a, b) => a - b).map((n) => {
    const p = SL.lists?.filaments?.find((f) => f.name === names[n]);
    return { n, material: p?.ftype || spMaterialFromName(names[n]) };
  });
}

/* The tower shared by materials that do not bond (spoolcheck.js): it
   comes off or collapses. Said above the Slice button, with the fixes the
   engine allows (one tower per plate): no tower — the U1's tower only
   primes the nozzle, ooze prevention covers the rest — or its outer wall
   in one material, the wiki's advice (the inside still mixes). */
function advRenderTower() {
  const box = $("s-tower");
  if (!box) return;
  const wall = +advVal("wipe_tower_filament") > 0 ? +advVal("wipe_tower_filament") - 1 : null;
  const a = spTowerAdvice({ heads: advTowerHeads(), tower: advTowerOn(), wall });
  const heads = (g) => g.heads.map((n) => "T" + n).join(", ");
  // One tower per material, Prepare's choice too (prepare-pillars.js).
  const material = typeof prPillarOffered === "function" && prPillarOffered()
    ? `<button class="btn small" data-tower="material">${esc(tr("slice.tower.per_material"))}</button>`
    : "";
  let html = "";
  if (multiHead() && prPillarsShown()) {
    // No shared tower any more: said, with the way back.
    const list = pmGroups(prPillarHeads()).map((g) => `<b>${esc(prPillarFamily(g))}</b> (${esc(heads(g))})`).join(" · ");
    html = `<span class="sl-tower-t">${tr("slice.tower.per_material_on", { list })}</span>
      <span class="sl-tower-acts"><button class="btn small" data-tower="single">${esc(tr("prepare.tower.kind.single"))}</button></span>`;
  } else if (a) {
    const list = a.families.map((g) => `<b>${esc(g.family)}</b> (${esc(heads(g))})`).join(" · ");
    const off = `<button class="btn small" data-tower="off">${esc(tr("slice.tower.off"))}</button>`;
    if (a.state === "walled") {
      const g = a.families.find((x) => x.heads.includes(wall));
      html = `<span class="sl-tower-t">${tr("slice.tower.walled", { m: `<b>${esc(g.family)}</b>`, t: `T${wall}` })}</span>
        <span class="sl-tower-acts">${off}${material}<button class="btn small" data-tower="undo">${esc(tr("slice.tower.undo"))}</button></span>`;
    } else {
      const walls = a.families
        .map((g) => `<button class="btn small" data-tower-wall="${g.heads[0]}">${esc(tr("slice.tower.wall", { m: g.family, t: `T${g.heads[0]}` }))}</button>`)
        .join("");
      html = `<span class="sl-tower-t">${tr("slice.tower.conflict", { list })}</span><span class="sl-tower-acts">${off}${material}${walls}</span>`;
    }
  }
  box.classList.toggle("info", multiHead() && prPillarsShown());
  // Rewritten only when it changes (the summary is refreshed often): a
  // focused button keeps its focus, the screen reader is not repeated.
  if (html === ADV.tower) return;
  ADV.tower = html;
  box.innerHTML = html;
  box.classList.toggle("hidden", !html);
  // Locked while slicing, as the sheet's other settings (showSliceBusy).
  box.querySelectorAll("button").forEach((b) => (b.disabled = !!SL.job));
}

// The prime tower's switch, on the sheet.
$("s-tower-sw").addEventListener("change", (e) => advSet("enable_prime_tower", e.target.checked ? "1" : "0"));

$("s-tower")?.addEventListener("click", (e) => {
  const b = e.target.closest("[data-tower], [data-tower-wall]");
  if (!b) return;
  if (b.dataset.tower === "off") advSet("enable_prime_tower", "0");
  else if (b.dataset.tower === "material" || b.dataset.tower === "single") prTowerSetKind(b.dataset.tower);
  else if (b.dataset.tower === "undo") advSet("wipe_tower_filament", null);
  else advSet("wipe_tower_filament", String(+b.dataset.towerWall + 1));
});

/* An emptied plate is a new print: the heads chosen for supports, walls
   or infill are forgotten, in every machine's memory — the spools will
   have changed, and a PETG support head once raised a PLA print's plate
   to 80°. The other advanced settings stay. */
function advForgetHeads() {
  for (const k of ADV_FILAMENT) delete SL.adv[k];
  for (const m of Object.values(SL.memory)) {
    if (m && typeof m === "object" && m.adv) for (const k of ADV_FILAMENT) delete m.adv[k];
  }
  localStorage.setItem("snapstudio.slice", JSON.stringify(SL.memory));
}

$("s-adv-body").addEventListener("change", (e) => {
  if (e.target.id === "s-smooth-mix") return prSetSmoothMix(e.target.checked);
  const el = e.target.closest("[data-k]");
  if (!el) return;
  const k = el.dataset.k;
  let v;
  if (el.type === "checkbox") v = el.checked ? "1" : "0";
  else if (el.type === "number") v = el.value === "" ? null : el.value + (el.dataset.pct ? "%" : "");
  else v = el.value;
  advSet(k, v);
});
$("s-adv-body").addEventListener("click", (e) => {
  const b = e.target.closest("[data-reset]");
  if (b) advSet(b.dataset.reset, null);
});
$("s-adv-back").addEventListener("click", advClose);
// Anchored to a scrolling panel: the head popover closes rather than float.
$("s-adv-body").addEventListener("scroll", () => PK.grid && closePicker(), { passive: true });
$("s-adv-reset").addEventListener("click", () => {
  if (ADV.cat === "speed") return spdResetAll();
  // Only what the level shows: Basic never changes a hidden value.
  for (const k of advCatKeysAll(ADV.cat, slLevel())) delete SL.adv[k];
  advRemember();
  advRenderPanel();
  advRenderRows();
});
document.querySelectorAll(".sl-adv-btn").forEach((b) => b.addEventListener("click", () => advOpen(b.dataset.adv)));
$("smodal").addEventListener("change", (e) => {
  if (e.target.matches("#s-supports, #s-brim, #s-bed")) advRefreshDefaults();
  else if (e.target.matches("#s-heads select")) advRenderRows();
});
window.addEventListener("langchange", () => {
  if ($("smodal").classList.contains("hidden")) return;
  advSchema().then(() => {
    advRenderRows();
    if (ADV.cat) advRenderPanel();
  });
});

/* ------------------------------------------------------------ levels */

/* Basic shows the sheet as it was in 0.14.2, Advanced every setting
   (adv-logic.js). The level only changes what is shown: advOverrides(),
   "Save as Custom Profile…" and the summary keep every difference. One
   saved value (state.sliceLevel), two controls: the sheet's title bar and
   Settings → Prepare. Someone who never chose one starts in Basic, or in
   Advanced if they already changed one of its settings: set once, at the
   first start that needs it. */
if (!sliceLevelValid(state.sliceLevel)) {
  state.sliceLevel = sliceLevelDefault(SL.memory);
  save();
}
const slLevel = () => state.sliceLevel;

/* The multi-material keys only apply with several heads (advOverrides). */
const ADV_MM_KEYS = new Set(advCatKeysAll("mm"));
/* A kept difference that applies now (as advCountOf). */
const advApplies = (k) => (!ADV_WHEN[k] || ADV_WHEN[k]()) && (!ADV_MM_KEYS.has(k) || multiHead());

/* The one way to change the level, from either control: both follow,
   then the sheet. A value already set is ignored (no loop between the
   two selects). */
function slLevelSet(level) {
  if (!sliceLevelValid(level) || level === state.sliceLevel) return;
  state.sliceLevel = level;
  save();
  slLevelApply();
}

/* The level on the controls and the sheet: rows and buttons marked
   data-level="advanced" hidden in Basic (CSS), the open panel closed when
   Basic hides it, redrawn otherwise (Multi-material without its ooze
   group), the counters and the hint redone. Never touches a value. */
function slLevelApply() {
  const level = slLevel();
  for (const id of ["s-level", "set-slice-level"]) if ($(id) && $(id).value !== level) $(id).value = level;
  $("smodal").classList.toggle("sl-basic", level === "basic");
  if ($("smodal").classList.contains("hidden")) return;
  if (ADV.cat && !advLevelShows(ADV.cat, null, level)) return advClose();
  if (ADV.cat) advRenderPanel();
  advRenderRows();
}

/* Basic: how many advanced settings differ, with a way to show them. */
function slLevelHint() {
  const n = advHiddenKeys(SL.adv, slLevel(), advApplies).length;
  $("s-level-hint").classList.toggle("hidden", !n);
  if (n) $("s-level-hint-t").textContent = tr("slice.level.hint", { n });
}

$("s-level").addEventListener("change", (e) => slLevelSet(e.target.value));
$("set-slice-level").addEventListener("change", (e) => slLevelSet(e.target.value));
$("s-level-show").addEventListener("click", () => {
  slLevelSet("advanced");
  // The hint is gone: the focus goes to the level it changed.
  $("s-level")._seg?.box.querySelector('[aria-checked="true"]')?.focus();
});
segmented("s-level", { cls: "compact" });
slLevelApply();

/* ------------------------------------------------------ save as profile */

function advSaveOpen() {
  const process = $("s-process").value;
  if (!process) return;
  $("advsave-base").textContent = tr("slice.adv.save.base", { name: process });
  $("advsave-name").value = tr("slice.adv.save.default", { name: process.replace(/ @.*$/, "") });
  const n = advCount() + spdNChanged();
  $("advsave-what").textContent = tr("slice.adv.save.what", { n });
  $("advsave-msg").textContent = "";
  $("advsave-msg").className = "pf-test";
  openSheet($("advsave"));
  requestAnimationFrame(() => $("advsave-name").select());
}

async function advSaveGo() {
  const name = $("advsave-name").value.trim();
  const base = $("s-process").value;
  const machine = $("s-machine").value;
  if (!name) return;
  const exists = SL.lists?.processes?.find((p) => p.name === name);
  if (exists && !exists.user) {
    $("advsave-msg").textContent = tr("err.preset_exists", { name });
    $("advsave-msg").className = "pf-test err";
    return;
  }
  if (exists && !(await confirmDelete(tr("slice.adv.save.replace_title"), tr("slice.adv.save.replace_text", { name }), tr("slice.adv.save.replace")))) return;
  try {
    await invoke("slice_save_process", { name, base, simple: currentSimple(), overrides: { ...advOverrides(), ...spdOverrides() } });
  } catch (e) {
    $("advsave-msg").textContent = String(e);
    $("advsave-msg").className = "pf-test err";
    return;
  }
  closeSheet($("advsave"));
  // The new profile carries the differences: it becomes the choice, clean.
  SL.lists = await invoke("slice_lists", { machine }).catch(() => SL.lists);
  fillSelect($("s-process"), SL.lists.processes, name);
  // The speed, too, is now the profile's.
  SL.adv = {};
  SL.speed = spdReset();
  remember(machine, { process: name, adv: {}, speed: SL.speed });
  $("s-process").dispatchEvent(new Event("change", { bubbles: true }));
  toast(tr("slice.adv.save.done", { name }));
}

$("s-save-process").addEventListener("click", advSaveOpen);
$("advsave-go").addEventListener("click", advSaveGo);
$("advsave-cancel").addEventListener("click", () => closeSheet($("advsave")));
$("advsave").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.stopPropagation();
    closeSheet($("advsave"));
  } else if (e.key === "Enter") {
    e.preventDefault();
    advSaveGo();
  }
});

/* The sub-panel closes with the sheet: it reopens on the main settings. */
new MutationObserver(() => {
  if (ADV.cat && $("smodal").classList.contains("hidden")) advClose();
}).observe($("smodal"), { attributes: true, attributeFilter: ["class"] });

/* Heads changed in "Heads and spools" (heads.js): the filament fields follow. */
window.addEventListener("headschange", () => {
  if (ADV.cat) advRenderPanel();
});
