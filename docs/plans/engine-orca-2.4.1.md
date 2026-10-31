# Engine: Snapmaker Orca 2.4.0 → 2.4.1

**State: implemented in draft PR #86** (steps 2–10, the review's gaps,
and D2 to D10 decided after the review), **except step 1**: the
`engine-orca-2.4.1` release is not published and `src-tauri/engine.json`
still points at 2.4.0 — kameka22 runs `scripts/engine.sh 2.4.1` once #86
is merged.

## Goal

Snap Studio bundles Snapmaker Orca's command line as its slicing engine,
pinned to [v2.4.0](https://github.com/Snapmaker/OrcaSlicer/tree/v2.4.0).
Snapmaker released
[v2.4.1](https://github.com/Snapmaker/OrcaSlicer/releases/tag/v2.4.1) on
2026-10-28 (published 04:07 Paris time). Its main change for us is a new
prime tower: the engine now splits its single tower into **blocks, one per
adhesiveness category of material**, which overlaps with what #35 (the
"materials that don't bond" warning) and #37 (one tower per material) do
on our side. This plan lists what changes upstream, what it means for Snap
Studio file by file, the decisions to take, and how to upgrade and test.

## Sources read

- The release notes of
  [v2.4.1](https://github.com/Snapmaker/OrcaSlicer/releases/tag/v2.4.1)
  (English part). The screenshots in the notes are hosted on Feishu and
  could not be opened.
- The compare
  [v2.4.0...v2.4.1](https://github.com/Snapmaker/OrcaSlicer/compare/v2.4.0...v2.4.1)
  through the GitHub API. **The API caps the file list at 300 files**, so
  the list is incomplete. Files were therefore read at both tags directly:
  - `src/libslic3r/PrintConfig.cpp`: every option's default, min and max
    diffed by a script;
  - `src/libslic3r/Print.cpp`, `src/libslic3r/GCode/WipeTower2.cpp`;
  - `src/slic3r/GUI/PartPlate.cpp`;
  - `resources/profiles/Snapmaker/filament/fdm_filament_*_category.json`;
  - every U1 process profile, and the U1 0.4 machine profile.
- Snap Studio at `main` (0.18.0): `src-tauri/engine.json`,
  `scripts/engine.sh`, `.github/workflows/engine.yml`, `ui/tower-logic.js`,
  `ui/prepare-tower.js`, `ui/slice-adv.js`, `ui/speed.js`,
  `ui/spoolcheck.js`, `ui/pillar-logic.js`, `src-tauri/src/slice.rs`,
  `src-tauri/src/plate.rs`, `scripts/test-tower.js`, `scripts/test-adv.js`,
  `scripts/test-pillars.js`, and `docs/plans/prime-tower-per-material.md`.

Nothing was sliced with 2.4.1. Each claim below is marked **verified in
the source** or **from the release notes only**, and the rest are open
questions for the measurements.

## What changes upstream

### 1. A prime tower in blocks, one per adhesiveness category

*Verified in the source.*

- A new filament option, `filament_adhesiveness_category` (an integer per
  filament, default `100`, shown in Developer mode only). Snapmaker's
  filament base profiles set it. The values below are quoted from
  `fdm_filament_<type>_category.json` at v2.4.1:

  | Upstream profile | Category |
  |---|---|
  | `pla`, `pla_cf` (and the other PLA variants) | 100 |
  | `abs`, `asa` | 200 |
  | `petg`, `pet`, `pctg` | 300 |
  | `pa` | 400 |
  | `pc` | 500 |
  | `tpu_90a` | 600 |
  | `pva` | 704 |
  | `support_bvoh` | 797 |

  `fdm_filament_common.json` does not set it, so a filament that does not
  inherit one of these profiles gets the default, **100, the same
  category as PLA**.
- For the U1 and other non-Bambu printers, `Print.cpp` now builds the
  tower with `WipeTower2::generate_new` (2.4.0: `generate`) and passes it
  the categories (`set_filament_categories`). `WipeTower2` keeps one
  `WipeTowerBlock` per category (`get_block_by_category`,
  `add_depth_to_block`). The tower's depth on a layer is **the sum of
  its blocks' depths**, and each tool change purges into its own
  category's block. A layer where a category starts or stops is marked
  `Contact` or `Solid` (solid infill up to 4 layers below). This is
  always on: there is no switch for it.
- New tower "interface" options, all off by default and in Developer
  mode: `enable_tower_interface_features`,
  `enable_tower_interface_cooldown_during_tower`, and per filament
  `filament_tower_interface_pre_extrusion_dist` / `_length` /
  `_print_temp`, plus `filament_tower_ironing_area`. There is also
  `prime_tower_enable_framework` ("Internal ribs", Advanced, off).
- *From the release notes only:* the extruder now goes around the tower
  and enters through the outer wall's opening at tool changes.
- *Open question:* the blocks sit side by side in one tower. Whether
  the tower's outer wall and brim are still shared, so that materials
  that don't bond still touch there, has to be measured (see the test plan).

### 2. Default tower position

*Verified in the source, with a caveat.*

- In the **GUI**, `PartPlateList::set_default_wipe_tower_pos_for_plate`
  now puts a new plate's tower at X 13 and **Y = half the plate depth**
  (2.4.0: Y 214.5). That is the middle of the left edge, the "left-center"
  of the release notes.
- The **engine's** defaults are unchanged: `wipe_tower_x` 15 and
  `wipe_tower_y` 220 in `PrintConfig.cpp`, at both tags.
- **Impact on Snap Studio: none by itself.** We slice with the command
  line, and Prepare always sends its own `wipe_tower_x` / `_y` /
  `_rotation_angle` (`prTowerOverrides`). The 15 / 220 fallback in
  `ptSpot` and the `plate.rs` tests remain the engine's defaults. Adopting
  the new place was a product choice: D3 keeps ours.

### 3. Changed defaults and limits

*Verified with a script that diffs every option of `PrintConfig.cpp`.*

| Key | 2.4.0 | 2.4.1 | Where |
|---|---|---|---|
| `max_bridge_length` | 10 | **0** | engine default |
| `raft_first_layer_expansion` ("Initial layer expansion", raft / support first layer) | 2.0, min 0 | **−1 = auto**, min −1 | engine default |
| `bridge_density` (external) | max 100 % | max **120 %** | engine limit (default 100 % unchanged) |
| `support_threshold_angle` | min 0 | min **1** | engine limit (default 30 unchanged) |
| `bridge_flow` | 0.8 | **1** | U1 profile `0.20mm Standard @Snapmaker U1 (0.4 nozzle)` only (engine default already 1) |
| `bridge_density` | 80 % | **100 %** | same U1 profile only (engine default already 100 %) |

The release notes say "Bridge Flow default 0.8 → 1.0" and "External
Bridge Density 80 → 100". At v2.4.0, though, the engine's defaults are
already 1 and 100 %. What changes is the **U1 0.20 mm Standard 0.4
process profile**, the one #37's measurements used. The other U1 process
profiles don't set these keys.

The release notes call `raft_first_layer_expansion` "First Layer
Expansion". It belongs to rafts and supports. It does not expand the
model's own first layer.

No option was removed. New options:
`bottom_color_penetration_layers`, `top_color_penetration_layers` (set in
every U1 process profile), `first_layer_travel_acceleration`,
`first_layer_travel_jerk`, `support_interface_min_area`,
`support_transition_flow_ratio`, `support_transition_perimeter`,
`support_transition_speed`, `tree_support_transition_layers`, plus the
tower options above.

### 4. U1 profiles

*Verified in the source.*

- **Machine** (`Snapmaker U1 (0.4 nozzle).json`, the other nozzles
  changed too):
  - `change_filament_gcode`:
    - waits for the next head's temperature with **`M104` instead of
      `M109`**, so it no longer blocks;
    - lifts to a safe height in "by object" printing.
  - `machine_end_gcode`: the same safe lift.
  - `machine_start_gcode`:
    - adds a pre-extrusion of the first filament (`SM_PRINT_PREEXTRUDE_FILAMENT`);
    - adds fan commands;
    - changes the chamber settings for the weak cooling mode.
  - *From the release notes only:* this avoids nozzle collisions in
    sequential printing (upstream PR
    [#453](https://github.com/Snapmaker/OrcaSlicer/pull/453)).
- **Process**:
  - `top/bottom_color_penetration_layers` are added everywhere;
  - `filename_format` uses `filament_type[initial_tool]`;
  - `tree_support_branch_angle_organic` is now 45 in `fdm_process_U1_common`;
  - the bridge values above.
- **Filaments**: about 30 U1 filament profiles changed (bed temperatures,
  new colors, per the release notes). They were not diffed one by one.

### 5. Fixes that matter to us

*From the release notes only.* The numbers are those of the "Bug Fixes"
list.

- 38: non-SEMM towers (the U1's) now honor the per-filament minimum
  purge. The larger of the filament's and the tower's value wins.
- 39: colors lost or bleeding after slicing multi-color 3MF files.
- 13: the model's skirt overlapped the tower's skirt.
- 11: gaps in the tower when the purge line spacing isn't 100 %. The first
  layer now always uses 100 %.
- 7, 9: the tower preview size changed with the total number of filaments
  and showed unused filaments. Both concern the GUI only, but they confirm
  the size rules changed.
- 34: a per-object skirt took effect on one object only.
- 6: colors could be missing with filament IDs above 16.

### 6. 3MF compatibility

*From the release notes only:* a 3MF saved by 2.4.1 shows an error when
opened in an older Snapmaker Orca. The release notes put this under the
"First Layer Expansion" change. *Likely reason, not verified:* the new
value −1 is below 2.4.0's minimum of 0 for `raft_first_layer_expansion`.

For Snap Studio:

- **Our projects:** we save only a few keys in
  `Metadata/project_settings.config` (`plate.rs`: the tower's switch,
  place and angle, the filaments), not the whole engine config. They
  should open in Orca 2.4.0 and 2.4.1 alike. To check (T6).
- **Orca 2.4.1 projects opened in Snap Studio:** `model3mf.rs` reads the
  geometry and the filaments, not the process config, so the −1 should
  not bother us. To check with a real file (T6).
- **Our own engine 3MF** (`write3mf.rs`): we write it and the bundled
  engine reads it, so both sides upgrade together.

## Impact on Snap Studio, file by file

| File | Today | With 2.4.1 |
|---|---|---|
| `src-tauri/engine.json` | 2.4.0, four archives of the `engine-orca-2.4.0` release | Rewritten by `scripts/engine.sh 2.4.1` (never by hand) |
| `scripts/engine.sh`, `.github/workflows/engine.yml` | Generic per version | **No change needed.** The official v2.4.1 assets have the names the workflow builds (one `.dmg` serves both macOS builds): `Snapmaker_Orca_Mac_universal_V2.4.1.dmg`, `Snapmaker_Orca_Windows_V2.4.1_portable.zip`, `Snapmaker_Orca_Linux_AppImage_Ubuntu2404_V2.4.1.AppImage` (checked through the API) |
| `ui/tower-logic.js` `ptEstimate` | One block: depth = (heads − 1) × lines per tool change, calibrated on 2.4.0 | **Depth = sum of one estimate per category used.** The rib square and the brim margin are recomputed from that depth. A plate with a single category should keep today's size; to re-measure |
| `ui/tower-logic.js` `ptSpot` | Fallback X 15, Y 220, back-left corner first | Unchanged (D3) |
| `ui/prepare-tower.js` | Sends `wipe_tower_x/y/rotation_angle`, reads the sliced size back (`gcode.rs` `TowerBox`) | Unchanged. The real size after slicing stays the reference |
| `ui/slice-adv.js` `ADV_ENGINE_DEFAULTS` | Copied from 2.4.0 | Header says 2.4.1. No listed key changes default. `max_bridge_length` and `raft_first_layer_expansion` are not in the list (they come from the profile or the engine) |
| `ui/slice-adv.js` steps / ranges | `bridge_flow` step only | If the catalog carries limits: `bridge_density` up to 120 %, `support_threshold_angle` from 1 |
| `ui/speed.js` `SPD_ENGINE_DEFAULTS` | Copied from 2.4.0 | **No change of value** (none of its keys changed). Header comment only. The new `first_layer_travel_acceleration` / `_jerk` are left to the engine |
| `ui/assets/orca-settings.*.json` | Generated from v2.4.0 (`scripts/gen-orca-settings.py`) | Regenerate from v2.4.1 for the new settings, labels and translations, and check the `FIXES` table still applies |
| `ui/spoolcheck.js` `spBonds`, `spTowerAdvice` | Our table of families that bond | Aligned on upstream's categories (D4). They already agree on ABS/ASA, PETG/PET/PCTG and the PLA variants. PLA and PVA stop bonding, and PA and PC get their own categories. The same table gives the `filament_adhesiveness_category` Snap Studio sends (D6) |
| `slice.tower.conflict` (9 languages), `slice.tower.walled` | "The prime tower mixes materials that do not bond… may come off or collapse", with "No tower" / "Outer wall in X" | **Probably wrong as worded** with "One tower" on 2.4.1, if the blocks hold (D2). The "outer wall in one material" fix may no longer make sense |
| `ui/pillar-logic.js`, `plate.rs` pillars (#37) | Engine tower off (`enable_prime_tower 0`), ring pillars, `print_order as_obj_list` | Still valid (nothing engine-side changed for them), kept as an option next to the engine's block tower, which becomes the default (D1). Re-check `as_obj_list` and the per-object walls-only settings on 2.4.1 |
| `src-tauri/src/slice.rs` `engine_prime_tower_position` | Opt-in test on 2.4.0 | Run on 2.4.1. Add a case with two categories (PLA + PETG) that checks a tower at the requested corner and its depth |
| `scripts/test-tower.js` | Real depths measured on 2.4.0 | Re-measure on 2.4.1 and add cases with two categories |
| `scripts/test-adv.js`, `test-pillars.js` | Assert the conflict message and the pillar overrides | Follow D1 / D2 |
| `src-tauri/src/slicers.rs` | Detects an installed Snapmaker Orca, comment "V2.4.0" | Comment only |
| Docs: `docs/technical-overview.md` (tower section), `docs/plans/prime-tower-per-material.md`, README / README.fr (engine version, if mentioned), CHANGELOG | 2.4.0 | Updated with the implementation PR. One CHANGELOG line: "Slicing engine updated to Snapmaker Orca 2.4.1", with its user-visible effects |

## Decisions

Decided by kameka22 on 2026-10-31, except D2. The implementation go has
**not** been given yet.

- **D1. #37's per-material towers: kept as an option.** The engine's
  block tower becomes the default "One tower" mode, also on plates whose
  materials don't bond. The per-material pillars stay available as a
  choice next to it.
- **D2. The conflict message (#35): decided after T2 (finding 9).** The
  2.4.1 tower separates the purges but its shared outer wall still mixes
  the materials; with the wall in one material they never meet. So in
  "One tower" mode, on a plate whose materials don't bond and with no wall
  chosen, Snap Studio sets `wipe_tower_filament` itself (the first head of
  the first material, in the plate's order), and the warning becomes an
  information line (`slice.tower.apart`) with the other walls, "No tower"
  and "Per material". `slice.tower.walled` ("its inside still mixes",
  false on 2.4.1) and its Undo are gone; `slice.tower.conflict` remains
  only for a wall chosen on a head with no known material. The automatic
  wall is sent to the engine but is not one of the user's differences (not
  counted, not saved in a preset).
- **D3. Default tower position: ours is kept.** That is X 15, Y 220, the
  back-left corner first, then the other corners and the first free
  spot (`ptSpot`). The new GUI default (middle of the left edge) is not
  followed.
- **D4. Material table: aligned on upstream's categories.** `spBonds`
  follows `filament_adhesiveness_category`: two families bond when they
  share a category. Compared with today's table:
  - PLA and PVA **no longer bond** (100 vs 704);
  - PA and PC are **known**, each in its own category (400, 500), so they
    don't bond with each other or with other families;
  - ABS/ASA (200) and PETG/PET/PCTG (300) are unchanged.

  Families with no upstream category, such as TPE, keep today's
  entries.
- **D5. Bridge defaults: 2.4.1's are adopted.** `max_bridge_length` 0, and
  bridge flow 1 and density 100 % in the U1 0.20 mm Standard 0.4
  profile. They come with the engine and its profiles, and nothing is
  pinned to 2.4.0. The CHANGELOG line says so.
- **D6. Snap Studio sends `filament_adhesiveness_category` itself.** The
  value comes from the filament's material type (`filament_type`, else
  the family from its name), mapped with upstream's table (§ 1). That
  way a user or third-party filament that doesn't inherit a Snapmaker
  base profile gets the right block, instead of 100.
  - A value the flattened profile already carries is kept.
  - A type with no known category is not sent, so the engine default
    applies.
- **D7. New 2.4.1 settings: exposed in this upgrade.** They go in the
  slice sheet, in the groups Orca puts them in (the catalog regenerated
  from `Tab.cpp`):
  - internal ribs (`prime_tower_enable_framework`);
  - top and bottom paint penetration layers;
  - minimum support contact area;
  - the support transition settings;
  - first layer travel acceleration and jerk.

  The options Orca shows only in Developer mode (tower interface
  features, adhesiveness category) are not shown, because the category
  is handled by D6.

Decided by kameka22 after the review (2026-10-31):

- **D8. Support transition settings: not exposed** (finding 11), as Orca
  shows them in no tab; their engine defaults apply.
- **D9. The Developer-mode settings shown before stay in the profile
  details**; only those 2.4.1 added are kept out (finding 12).
- **D10. First layer travel acceleration and jerk in Quality › First
  layer**, the sheet's Speed panel being a percentage of the profile's
  speeds.

## Implementation plan (after the go)

1. **Engine**: `scripts/engine.sh 2.4.1` on an up-to-date `main`. It
   starts `engine.yml`, which builds the archives, runs a test slice on
   the four platforms and publishes the `engine-orca-2.4.1` release (never
   "latest"), then rewrites, commits and pushes `src-tauri/engine.json`.
   *This step publishes a release on kameka22/snap-studio, so kameka22
   runs it, or it needs an explicit OK.*
2. **Catalog**: `python3 scripts/gen-orca-settings.py <OrcaSlicer at
   v2.4.1>`, then `python3 scripts/check-i18n.py`.
3. **Defaults** (D5):
   - the 2.4.1 headers in `slice-adv.js` and `speed.js`;
   - values only where the script diff says so (none today);
   - the `bridge_density` range up to 120 % and `support_threshold_angle`
     from 1;
   - no 2.4.0 bridge values pinned.
4. **New settings** (D7): add the settings listed in D7 to the slice
   sheet's groups (`slice-adv.js`) with their engine defaults in
   `ADV_ENGINE_DEFAULTS`, labels from the regenerated catalog, and tests
   in `test-adv.js`.
5. **Categories** (D4, D6):
   - one table of upstream's categories per family in `spoolcheck.js`;
   - `spBonds` derived from it: same category bonds, and TPE and other
     families without a category keep their entries;
   - the request sends `filament_adhesiveness_category` per filament
     (`slice.rs`, next to the other per-filament keys), except when the
     profile already sets it;
   - tests in `test-spoolcheck.js` and a Rust test on the sent value.
6. **Tower modes** (D1, D3):
   - "One tower" is the engine's block tower, the default on every
     multi-head plate;
   - the per-material pillars of #37 stay an option of the « Tour
     d'amorçage » switch, offered on plates whose materials don't bond;
   - `ptSpot` and its 15 / 220 fallback are unchanged;
   - Prepare's copy and `test-pillars.js` are updated where they present
     the pillars as the fix.
7. **Tower estimate**: `ptEstimate` takes the heads' categories (D6's
   value). Its depth is the sum of the blocks. Recalibrate on 2.4.1
   slices (T1).
8. **Warnings** (D2, decided after T2): the automatic outer wall in one
   material (`advTowerAutoWall`), the information line
   `slice.tower.apart` in the nine languages, `prepare.tower.per_material_why`
   reworded, `slice.tower.walled` and its Undo removed, `test-adv.js`.
9. **Tests**:
   - `node scripts/test-tower.js`, `test-adv.js`, `test-pillars.js`,
     `test-spoolcheck.js` and the other `scripts/test-*.js`;
   - `cargo test --lib`;
   - `engine_prime_tower_position` with `SNAPSTUDIO_ENGINE` pointing to
     2.4.1.
10. **Docs and CHANGELOG**:
    - the docs listed in the impact table;
    - one CHANGELOG line for the engine upgrade and its visible effects:
      the tower in blocks per material by default, the new settings, and
      the bridge defaults.

## Test plan

- **T1, tower size**: re-run `test-tower.js`'s measured cases on 2.4.1.
  These are the plain wall at 2, 3 and 4 heads, 0.2 and 0.12 mm, 40 and
  60 mm, 45 and 90 mm³, and the U1 rib tower, all in one category. Then
  add cases in two and three categories (PLA + PETG, PLA + PETG + TPU).
- **T2, does the tower still mix?** On a PLA + PETG plate, read the
  G-code. Check which head prints the tower's outer wall, the brim, and
  the `Contact` / `Solid` layers, and whether a PETG line ever lands on a
  PLA line. This settles D2.
- **T3, #37 again**: redo the feasibility test of
  `prime-tower-per-material.md` (PLA cube on T0 / T1, PETG cube on T2,
  ring pillars) on 2.4.1:
  - each ring printed by its own head;
  - pillars printed before the model in every layer × head case with
    `as_obj_list`;
  - heights;
  - no new warnings.

  Compare its print time and filament use with the 2.4.1 block tower on
  the same plate.
- **T4, real U1 print**: the same PLA + PETG plate, once with the block
  tower and once with #37's pillars. Check that the tower stays standing
  and doesn't come off, the colors, the time, and the faster tool changes
  (`M104` instead of `M109`: does the next head start before it is hot
  enough?).
- **T5, tower place**: `engine_prime_tower_position` (corner, rotation,
  tower off) on 2.4.1, plus a two-category plate.
- **T6, 3MF**:
  - a Snap Studio project saved after the upgrade opens in Snapmaker
    Orca 2.4.0;
  - a project saved by Orca 2.4.1 opens in Snap Studio, both before and
    after the upgrade;
  - a multi-color 3MF slices with its colors (fix 39).
- **T7, bridges**: slice a bridge test in 0.20 mm Standard on 2.4.0 and
  2.4.1. Note the support under long bridges (`max_bridge_length` 0) and
  the bridge flow.

## Risks

- **3MF**: see § 6. Low for our own files, to confirm (T6).
- **Tower size before slicing**: until `ptEstimate` knows the categories,
  Prepare may show too small a tower on mixed plates. The size read
  after slicing corrects it.
- **Tool changes on the U1** now use `M104`. Upstream made this choice,
  and T4 must confirm it on a real print.
- **Unread upstream changes**: the compare stops at 300 files, so GUI-only
  changes were not all read. They don't affect the command line, but a
  CLI change outside the files read above could have been missed. The
  four-platform test slice in `engine.yml` and T1–T7 are the safety net.

## Review findings / additional needs

Second pass, after the plan: the whole `v2.4.0...v2.4.1` diff read from a
local clone of Snapmaker/OrcaSlicer (463 files; the GitHub compare stopped
at 300), Snap Studio's engine pipeline run on the official 2.4.1 macOS
package, and real slices on both engines through two opt-in tests
(`engine_prime_tower_position`, and `engine_tower_sizes`, added for this
review). Links point at the tags. "Within D1–D7" gaps are implemented in
#86; the others were decided after it (D2, D8–D10) and implemented too.

### Engine pipeline and profiles

1. **2.4.1 profiles start with a UTF-8 BOM — the upgrade fails without a
   fix.** `0.20mm Standard @Snapmaker U1 (0.4 nozzle).json`, the U1's
   default process, and `fdm_process_common.json` now begin with
   `EF BB BF`
   ([file](https://github.com/Snapmaker/OrcaSlicer/blob/v2.4.1/resources/profiles/Snapmaker/process/fdm_process_common.json)).
   Orca reads them; `serde_json` refuses them and `presets.rs` `read_json`
   skipped them silently, so every process inheriting
   `fdm_process_common` became "missing parent" and `engine_smoke` — the
   test slice `engine.yml` runs before publishing — failed on 2.4.1. Files:
   `presets.rs`, `model3mf.rs`, `plate.rs` (a 3MF's
   `project_settings.config` may come from Orca too). **Within D1–D7
   (implemented):** `util::strip_bom` before parsing, with a test. With it,
   `engine_smoke` passes on 2.4.1. This was the only blocker found for
   publishing; it must be merged before `scripts/engine.sh 2.4.1` runs,
   since the workflow tests `main`.
2. **Packaging:** every `engine/keep.txt` pattern still matches the 2.4.1
   macOS package (666 files). The asset names are the ones `engine.yml`
   builds. No new runtime folder is needed: the engine slices with the
   pruned resources. Windows and Linux were not pruned locally; the
   workflow's four-platform test slice covers them. `crashpad_handler`
   was already shipped with 2.4.0. **No change.**
3. **Profiles: no preset added, removed or renamed** in
   `resources/profiles/Snapmaker` (166 files modified only), so every name
   Snap Studio refers to stays valid. Value changes besides the plan's
   bridge values (D5) and penetration layers:
   - bed temperatures of a few U1 filaments: ASA hot plate 110 → 100, PLA
     SnapSpeed (0.6/0.8) hot plate 55 → 65, PLA Matte 0.6 textured
     45 → 65, PVA 65 → 70 (hot and textured);
   - Snapmaker PLA Translucent: `close_fan_the_first_x_layers` 3;
   - `graphic_effect_plate_temp(_initial_layer)` (a plate type the U1
     profiles carry) in 23 files;
   - the high-flow nozzle's list of not-recommended filaments
     (`filament_allow_list`).

   They come with the engine like the bridge values. **Within D1–D7
   (D5's logic, implemented as a CHANGELOG mention):** nothing pinned.
4. **Upstream's category table is wider than § 1's**, and a family is
   decided by the base profile, not by `filament_type`
   ([`fdm_filament_*_category.json`](https://github.com/Snapmaker/OrcaSlicer/tree/v2.4.1/resources/profiles/Snapmaker/filament)):
   PLA, PLA-CF, PLA HS/Matte/Silk 100; ABS, ASA 200; PETG, PETG-CF/GF/HF,
   PET, PCTG 300; PA, PA-CF 400; PC 500; **TPU (90A, 95A HF, unspecified)
   and PEBA 600**; PVA 704; **BVOH 797**. `fdm_filament_common` has none
   (engine default 100). For D4: PEBA now bonds with TPU, BVOH is its own
   category. **Within D1–D7 (implemented).**
5. **`filament_adhesiveness_category` is a filament key**
   (`s_Preset_filament_options` in
   [Preset.cpp](https://github.com/Snapmaker/OrcaSlicer/blob/v2.4.1/src/libslic3r/Preset.cpp)),
   so D6's value goes into each filament JSON `presets::prepare` writes
   (`filament_extra`), not into the process overrides as step 5 of the
   plan says. **Within D6 (implemented there).**

### Prime tower (T1, T2, T5 run on 2.4.1)

6. **Purge per filament (fix 38) changes the tower:** each tool change
   purges `max(prime_volume, filament_minimal_purge_on_wipe_tower[new
   filament])`, and the depth estimate takes the maximum over all
   filaments
   ([Print.cpp](https://github.com/Snapmaker/OrcaSlicer/blob/v2.4.1/src/libslic3r/Print.cpp),
   `effective_wipe_tower_volume`). The U1's PETG HF profile purges at
   least 50 mm³, PLA and TPU 15. `ptEstimate` used `prime_volume` only.
   **Within D1–D7 (step 7, implemented):** the estimate takes the largest
   of the volume and the plate's filaments' minimal purges.
7. **Tower size, measured (T1).** One category: identical to 2.4.0 to the
   tenth of a millimetre on every plain-wall case of `test-tower.js`
   (2–4 heads, 0.2/0.12 mm, 40/60 mm, 30/45/90 mm³), 0.6–1.8 mm deeper at
   15 mm³. Several categories: **one more tool change's worth of depth,
   whatever the number of categories** (two heads PLA + PETG 9.5 → 17.3 mm,
   PLA + PETG + TPU 18.5 → 27.5, PLA + PLA + PETG + PETG 26.3 → 35.3; rib
   tower PLA + PETG 38.8 → 45.8). **Within D1–D7 (step 7, implemented):**
   `ptEstimate` takes the number of categories and adds that change.
8. **The rib tower moved (T5).** WipeTower2 now offsets the rib tower by
   its ribs' extent (`m_rib_offset`, `generate_new`), so the U1's tower
   box starts **−4.9 mm** from the requested corner instead of −9.7 mm
   (same width and depth): the ribs no longer reach out beyond the corner,
   only the brim does. Plain-wall towers are unchanged (position, rotation,
   size). `ptEstimate` placed the box with 2.4.0's rib margin, and
   `engine_prime_tower_position` asserted `x0 < −5`. **Within D3
   (implemented):** the estimate's rib box starts at −brim; the test
   checks a box from about −brim. `ptSpot` and the 15/220 fallback are
   unchanged.
9. **Does the 2.4.1 tower still mix materials? (T2, answers D2).** G-code
   of a two-head PLA + PETG plate, rasterized per layer and head (cells of
   0.25 mm), counting the cells a head prints over the other material's
   cells of the layer below:

   | | Engine's own wall | `wipe_tower_filament` = PLA head ("outer wall in one material") |
   |---|---|---|
   | 2.4.0, plain / rib | ~75,000 / ~95,000 cells, inside and out | ~54,000 / ~59,000, all inside (the purges mix) |
   | 2.4.1, plain / rib | ~21,500 / ~33,500: the outer wall and the line between the two blocks, printed by whichever head ends the layer | **0 / 0** |

   Each material purges into its own block (PETG Y 200–209, PLA 209–218
   in the plain case), but the shared outer wall and the seam between
   blocks still alternate heads layer after layer. With the wall in one
   material, 2.4.1 keeps the materials fully apart. **Decided: D2.**
10. **Travel moves avoid the tower** (`detour_around_wipe_tower`,
    `get_wipe_avoid_pos_x` in
    [GCode.cpp](https://github.com/Snapmaker/OrcaSlicer/blob/v2.4.1/src/libslic3r/GCode.cpp)):
    parked beside it at tool changes. Nothing to do; #37's pillars are
    plain objects and not concerned.

### Settings and catalog (D7)

11. **The support transition settings are in no tab of Orca's.**
    `tree_support_transition_layers`, `support_transition_perimeter`,
    `support_transition_speed` (a legacy key ignored by 2.4.0, live again)
    and `support_transition_flow_ratio` are engine options without a line
    in [Tab.cpp](https://github.com/Snapmaker/OrcaSlicer/blob/v2.4.1/src/slic3r/GUI/Tab.cpp):
    D7's "in the groups Orca puts them in" cannot apply. **Decided: D8,
    not exposed**; their engine defaults (2 layers, perimeter on,
    50 mm/s, 100 %) apply.
12. **Developer-mode options enter the catalog.** Regenerated from 2.4.1,
    the catalog gains 16 settings (785 → 801), among them the tower
    interface options and `filament_adhesiveness_category`, which
    `Tab.cpp` adds but Orca hides outside Developer mode (`comDevelop`).
    **Within D7 (implemented):** `gen-orca-settings.py` skips `comDevelop`
    options, as Orca's GUI does.
13. **Other catalog changes**, all generated, no product choice:
    - `prime_tower_brim_chamfer` and `…_max_width` leave the Prime tower
      group (commented out in `Tab.cpp`; still engine options, never shown
      by Snap Studio);
    - the four `adaptive_pressure_advance*` settings appear in the
      filament tab (uncommented), so they show in a filament's details;
    - `wipe_tower_max_purge_speed` is now labelled "Max speed";
    - `raft_first_layer_expansion` becomes Developer-only (and auto, −1);
      the slice sheet never listed it.

    **Within D7 (implemented by the regeneration).**
14. **New engine warnings**, relayed as Orca writes them like the others
    (`slice.rs`, `message`/`warning`): the Lightning base pattern with a
    support type that does not take it, the Hollow pattern with normal
    supports, two walls on Organic supports without the Hollow pattern.
    The check on the tip diameter is gone. **No change.**

### Corrections to the sections above

- § 2: the **command line** also moved its default tower to the middle of
  the left edge (`y = plate_depth * 0.5`,
  [Snapmaker_Orca.cpp](https://github.com/Snapmaker/OrcaSlicer/blob/v2.4.1/src/Snapmaker_Orca.cpp)),
  but only on its arrange paths, which Snap Studio turns off
  (`--arrange 0`). The conclusion holds: no impact.
- § 6: a 2.4.1 3MF also writes `Snapmaker_Orca:3mfVersion` instead of
  `BambuStudio:3mfVersion`, Snapmaker relationship types for thumbnails
  and G-code, `X-SM-Client-*` headers, no `xmlns:BambuStudio`, and a
  versioned `layer_heights_profile.txt` keyed by 3MF object id
  ([bbs_3mf.cpp](https://github.com/Snapmaker/OrcaSlicer/blob/v2.4.1/src/libslic3r/Format/bbs_3mf.cpp)).
  Snap Studio's readers find thumbnails by entry path and metadata by
  name and depend on none of these; our writers write none of them. The
  only reading risk found was the BOM (finding 1). The virtual heads'
  `mixed_filament_definitions` format is unchanged (locale-safe parsing
  only).
- Impact table: `engine.sh` / `engine.yml` need no change, but the engine
  test slice needed finding 1's fix; `ptEstimate` "a plate with a single
  category should keep today's size" is true for the plain wall only
  (finding 8).
- Implementation step 5: the category goes into the filament JSON
  (finding 5).

## Test results on 2.4.1 (#86)

Run on macOS with the official 2.4.1 package (`SNAPSTUDIO_ENGINE`), the
bundled 2.4.0 for comparison.

- **Engine tests** (`cargo test --lib <name> -- --ignored`), all pass on
  2.4.1: `engine_smoke` (the workflow's test slice; it failed before
  finding 1's fix), `engine_prime_tower_position` (T5),
  `engine_material_pillars` (T3: each ring by its own head, pillars before
  the model, heights), `engine_advanced_overrides`,
  `engine_speed_overrides`, `engine_virtual_head_alternates`,
  `engine_virtual_head_smooth_mix`, `engine_painted` (a painted
  multi-color 3MF: colors and heads, fix 39) and `engine_progress_trace`
  (the stages are still read).
- **T1**: `engine_tower_sizes`, findings 7 and 8; `ptEstimate`
  recalibrated, `scripts/test-tower.js` holds the 2.4.1 measurements.
- **T2**: finding 9.
- **T6**: a 3MF written by the 2.4.1 command line (`--export-3mf`) is read
  by Snap Studio as before (application, filaments, extruders, tower
  place, the mesh's 24,248 triangles); its configs carry no BOM. 2.4.1
  refuses to load a project whose own settings are out of its ranges
  (`tree_support_wall_count` −1, `solid_infill_filament` 0, in two
  downloaded 3MF files): Snap Studio is not concerned, it sends its own 3MF
  and settings. Opening a Snap Studio project in Orca 2.4.0's window was not
  tried (no change to our 3MF writers).
- **T7**: an arch with a 30 mm and a 6 mm bridge, supports on, 0.20 mm
  Standard: 2.4.1 extrudes 4 % more support (10,642 → 11,115 mm) and 3 %
  less bridge; 2.4.0 already supported both bridges of this model.
- **Support threshold angle 0**: 2.4.1 refuses it and the slice fails
  ("not in range [1,90]"); the slice sheet now starts the field at 1 and
  raises a remembered 0.
- **T4** (a real U1 print, block tower against pillars, `M104` tool
  changes) is left for the machine.

