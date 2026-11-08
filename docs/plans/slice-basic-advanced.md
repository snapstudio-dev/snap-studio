# Slice sheet: Basic and Advanced modes

## Goal

Version 0.15 roughly doubled what the slice sheet shows: a ⚙ beside Quality
and on the Infill and Walls tiles, two new rows (Surfaces, Other), the prime
tower's head and ooze prevention in Multi-material. That is right for people
who know Orca, and a lot for a first print.

The sheet gets **two levels**, chosen with a segmented control in its title
bar and in Settings:

- **Basic** shows the sheet **as it was in 0.14.2** (`2b9db55`), before
  #35, #60 and #36 added settings.
- **Advanced** shows everything, as today.

The level only changes **what is shown**. Every value keeps applying in both
levels: hiding never resets, never drops an override, never changes the
slice.

## Names (decided)

- **Basic** / **Advanced** in English, **Essentiel** / **Avancé** in French
  (asked first: Simple / Full). "Advanced" says these are expert settings,
  as in Orca and most slicers.
- The ⚙ buttons, called "Advanced settings" (`slice.adv.open`) and still
  shown in Basic (Speed, Supports, Brim, Seam, Multi-material), are renamed
  **"More settings"** / **« Plus de réglages »** (tooltip and aria label),
  so that Basic shows no buttons called "Advanced".

## What each level shows

Found from `git diff 2b9db55 origin/main -- ui/index.html ui/slice-adv.js`
(0.14.2 → 0.15.0). #57 (steppers), #58 (head pickers) and #59 (pictures for
lists) changed how settings look, not which ones exist: they stay in both
levels.

### Basic (the 0.14.2 sheet)

- **Printer**: printer chips, nozzle, machine profile, "Other profile…".
- **Plate**: bed type and its temperature.
- **Quality**: layer height chips, style chips, process profile, "Other
  profile…". *No ⚙ beside the section title.*
- **Adjustments**:
  - Infill tile (slider), Walls tile (stepper). *No ⚙ on the tiles.*
  - Speed row: slider and its ⚙ panel (`slice-speed.js`, unchanged since
    0.14).
  - Supports row: switch and ⚙ panel, all its groups (support, interface,
    base, tree, support heads).
  - Brim row: switch and ⚙ panel (type, width, gap, ears angle).
  - Multi-material row (several heads): the **prime tower switch**
    (`#s-tower-sw`, shared with Prepare, #36) and its ⚙ panel with
    - Prime tower: `wipe_tower_filament` (see below), `prime_tower_width`,
      `prime_volume`, `prime_tower_brim_width`;
    - Flushing: `flush_into_infill`, `flush_into_objects`,
      `flush_into_support`;
    - Heads per feature: `wall_filament`, `sparse_infill_filament`,
      `solid_infill_filament`.
  - Seam row and ⚙ panel (position, staggered inner seams, gap).
- "Save as Custom Profile…", Heads and spools, Model colors.
- Footer: the prime tower warnings (`#s-tower`, `#s-tower-place`), progress,
  summary, buttons.

Two 0.15 items stay in Basic (decided):

- **The prime tower switch on the Multi-material row.** In 0.14.2 the tower
  was turned on inside that panel (`enable_prime_tower`); 0.15 moved it to
  the row and made it the plate's, shared with Prepare's switch. Hiding it
  would leave Prepare with a switch the sheet does not show.
- **The tower's wall head (`wipe_tower_filament`).** The material warning
  (#35) is shown in both levels — it is about a print that may fail — and its
  one-click fix sets this key. A fix that changes a hidden setting would be
  confusing.

### Advanced only

| Where | What (Orca keys) |
|---|---|
| ⚙ beside **Quality** | first layer height; line widths (`line_width`, `initial_layer_line_width`, `outer_wall_line_width`, `top_surface_line_width`); precision (`elefant_foot_compensation`, `xy_hole_compensation`, `xy_contour_compensation`, `resolution`, `enable_arc_fitting`); overhangs and bridges (`detect_overhang_wall`, `enable_overhang_speed`, `overhang_1_4…4_4_speed`, `bridge_flow`, `thick_bridges`) |
| ⚙ on the **Infill** tile | `sparse_infill_pattern`, `infill_direction`, `infill_wall_overlap`, `infill_anchor`, `infill_anchor_max`, `infill_combination`, `minimum_sparse_infill_area` |
| ⚙ on the **Walls** tile | `wall_generator`, `wall_sequence`, `wall_direction`, `precise_outer_wall`, `detect_thin_wall`, `only_one_wall_top`, `only_one_wall_first_layer`, `extra_perimeters_on_overhangs` |
| **Surfaces** row | shells (`top/bottom_shell_layers`, `top/bottom_shell_thickness`, `ensure_vertical_shell_thickness`), patterns (`top/bottom_surface_pattern`, `internal_solid_infill_pattern`), ironing (`ironing_type` and its four details) |
| **Other** row | `print_sequence`, `spiral_mode`, fuzzy skin (3 keys), skirt (`skirt_loops`, `skirt_distance`, `skirt_height`, `draft_shield`), travel (`reduce_crossing_wall`, `reduce_infill_retraction`) |
| **Multi-material** panel | the Ooze prevention group: `ooze_prevention`, `standby_temperature_delta`, `preheat_time`, `idle_temperature` |

That is 5 panels and one group, about 60 keys.

## Behaviour

### Hidden values keep applying

- `advOverrides()` (`ui/slice-adv.js`) is **not** filtered by level: the
  engine gets every kept difference in both levels. Same for
  `spdOverrides()`.
- "Save as Custom Profile…" (`advSaveOpen` / `advSaveGo`) saves every
  difference; its "N settings" count (`slice.adv.save.what`) stays the total.
- The bottom summary (`slSummary`, `slice.sum.adv`) keeps counting every
  difference: it describes what goes to the engine.
- Switching levels never touches `SL.adv` and never calls `advRemember()`.

### The hint in Basic

In Basic, when settings that only Advanced shows differ from the profile, a
quiet line closes the Adjustments rows (where Surfaces and Other would be):

> ⚙ 3 advanced settings changed · Show

("· Show" switches to Advanced.) FR: « 3 réglages avancés modifiés ·
Afficher ». Singular and plural forms through the catalog's plural objects,
like `slice.sum.adv`. Hidden when the count is 0, and always in Advanced.

The count is `advHiddenCount()`: the advanced-only keys in `SL.adv` that
apply right now (the same `ADV_WHEN` test as `advCountOf`, and the Ooze
group only with several heads, like `advCatKeys("mm")`).

A value coming from the **profile** (a custom profile with ironing, say) is
not "changed": the profile is the reference, as everywhere else on the sheet.

### Panels and counters in Basic

- ⚙ buttons and rows marked Advanced-only are hidden (not disabled).
- The Multi-material panel renders without the Ooze group.
- A panel's ⚙ badge and the `mod` class (`advRenderRows`) count only the
  keys the level shows; hidden ones are in the hint.
- A panel's **Reset** (`#s-adv-reset`) resets only the keys the level
  shows: Basic never changes a hidden value silently. It is hidden when none
  of the shown keys differ.
- Switching to Basic while an Advanced-only panel is open (Quality, Infill,
  Walls, Surfaces, Other) closes it (`advClose()`); with Multi-material open,
  the panel re-renders without the Ooze group.

### The title bar control

In `.sl-head`, right-aligned after `.sl-title`: a hidden
`<select id="s-level">` (`basic`, `advanced`) enhanced by
`segmented("s-level", { cls: "compact" })` (`ui/segmented.js`), as the
other pills. It is a radio group named "Settings shown" for screen readers
(`slice.level`), reachable with Tab, arrows switch. It stays visible while a
panel is open (the header stays above `#s-adv`, `advFit`).

### In Settings

The same choice in **Settings → Prepare** (the pane that already holds the
slice sheet's spool check), a row after "Colour to head assignment":

- **Slice settings shown** / « Réglages de découpe affichés »
- sub: "Basic shows the essentials; Advanced adds quality, infill, walls,
  surfaces and more. Also in the slice window's title bar." / « Essentiel
  montre l'indispensable ; Avancé ajoute qualité, remplissage, parois,
  surfaces et plus. Aussi dans la barre de titre de la fenêtre de découpe. »
- `<select id="set-slice-level">` enhanced with `segmented("set-slice-level")`
  in `ui/settings.js`, beside `segmented("set-assoc")`.

**One value, two controls.** Both selects go through one function,
`slLevelSet(level)`:

1. returns if the level is unchanged (no loop between the two selects'
   "change" events);
2. `state.sliceLevel = level; save()`;
3. sets `.value` on `#s-level` and `#set-slice-level` (each segmented
   control follows its select);
4. `slLevelApply()`: the `sl-basic` class on `#smodal`, `advRenderRows()`,
   the open panel's update (above).

So changing it in Settings while the sheet is open (it cannot be today, but
Settings may become a sheet) or in the sheet updates the other at once.

### Saved value and the first choice

`state.sliceLevel` (`"basic"` | `"advanced"`, `null` until set) joins
`DEFAULTS` and `save()` in `ui/app.js`, beside `wheelAction` and `aiModes`.

When it is `null`, the first open of the sheet (or of Settings) sets it once,
with `sliceLevelDefault(memory)`, a pure function in `ui/adv-logic.js`:

- **Advanced** when a machine profile remembered in `snapstudio.slice`
  (`SL.memory[machine].adv`) already holds an advanced-only key: that person
  has used the 0.15 settings, and finding them gone after an update would
  look like a loss.
- **Basic** otherwise: new installations, and people who never touched the
  new settings (for them the sheet looks like before 0.15).

The result is saved at once and never computed again. The hint covers the
remaining case (an advanced value changed later, then the level set back to
Basic).

### Where the level lives in code

- `ui/adv-logic.js` (pure, tested):
  - `ADV_LEVEL_CATS = new Set(["quality", "infill", "walls", "surfaces", "other"])`;
  - `ADV_LEVEL_GROUPS = new Set(["slice.adv.g.ooze"])` (group title ids, as
    `ADV_CATS` groups have no ids);
  - `ADV_LEVEL_KEYS`: every key of those panels and groups, built from
    `ADV_CATS` in `slice-adv.js` and passed in, or listed here once and
    checked against `ADV_CATS` by the test;
  - `advLevelShows(cat, group, level)`, `advHiddenKeys(adv, level, applies)`
    (`applies(k)`: the `ADV_WHEN` test), `sliceLevelDefault(memory)`,
    `sliceLevelValid(v)`.
- `ui/slice-adv.js`:
  - `advRenderPanel`: skip groups the level hides; per-panel badge and Reset
    on shown keys only (`advCountOf(cat, { level })`);
  - `advRenderRows`: badges, the hint `#s-level-hint`;
  - the per-panel Reset handler: only shown keys;
  - `slLevelSet`, `slLevelApply` (or in `slice-ui.js`, next to the other
    sheet controls).
- `ui/index.html`: `data-level="advanced"` on the Quality section's ⚙, the
  Infill and Walls tiles' ⚙ (`.sl-tile-adv`), the Surfaces and Other rows;
  `#s-level` in `.sl-head`; `#s-level-hint` after the Other row;
  `#set-slice-level` in Settings → Prepare.
- `ui/style.css`: `#smodal.sl-basic [data-level="advanced"] { display: none }`;
  `.sl-head` lays the title left and the control right (the thumbnail stays
  first); the hint in the style of `.sl-note`.
- `ui/slice.js` `openSlice`: compute the default when `null`, then
  `slLevelApply()` before the first render (no flash of Advanced rows).
- `ADV_UI`, `ADV_WHEN`, `ADV_DEPENDS`, `advTowerOn()`, `advWarnHeads()` and
  the presets (`s-process`, "Other profile…", `advRefreshDefaults`) are not
  changed: the level is applied on top, after `ADV_WHEN`. A profile change
  keeps the level.
- Prepare (`prepare-tower.js`) is not affected: its tower switch and size are
  the same in both levels.

## Texts (EN / FR)

| Key | EN | FR |
|---|---|---|
| `slice.level` | Settings shown | Réglages affichés |
| `slice.level.basic` | Basic | Essentiel |
| `slice.level.advanced` | Advanced | Avancé |
| `slice.level.hint` | {one: "1 advanced setting changed", other: "{n} advanced settings changed"} | {one: "1 réglage avancé modifié", other: "{n} réglages avancés modifiés"} |
| `slice.level.show` | Show | Afficher |
| `settings.slice_level` | Slice settings shown | Réglages de découpe affichés |
| `settings.slice_level.sub` | (above) | (above) |
| `slice.adv.open` (changed) | More settings | Plus de réglages |

`python3 scripts/check-i18n.py` must stay clean.

## Tests

- `scripts/test-adv.js` (extended):
  - every key of the Quality, Infill, Walls, Surfaces and Other panels and of
    the Ooze group is advanced-only; Supports, Brim, Seam, the tower group,
    flushing and heads per feature are not;
  - `advHiddenKeys`: counts only advanced-only keys in the differences,
    only those that apply (ironing's details without ironing do not count),
    nothing in Advanced;
  - `sliceLevelDefault`: empty memory → basic; a remembered `ironing_type`
    or `ooze_prevention` → advanced; only Basic keys (`brim_width`,
    `support_type`) → basic; `last`/`printer` entries ignored; a corrupt
    entry → basic.
- `scripts/test-segmented.js`: the level's options give two segments with the
  right one on.
- In the app (headless browser, as the other UI checks): switch in the title
  bar → rows hide/show, the Settings control follows, and back; change an
  Infill pattern in Advanced, switch to Basic → hint "1 advanced setting
  changed", Slice → the override is still sent (`advOverrides()`); Reset in
  Multi-material in Basic leaves `ooze_prevention` set; reload → the level is
  kept.

## Docs (later, after the implementation)

- README: retake `docs/screenshots/slice*.png` in Basic (the default), with
  the control visible in the title bar.
- Site and What's new: one short line, EN and FR, in the next version's
  entry. No detailed list.
- CHANGELOG: the line under *Unreleased* (in this PR).

## For the implementer

After implementing, review your **full diff against `main`** carefully
(hidden values still sent, no Reset touching hidden keys, both controls kept
in sync without loops, i18n, accessibility), fix what you find, and report
the review.
