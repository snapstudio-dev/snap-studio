# Mixed nozzle diameters (per head, per object, then per zone)

Plan only (draft PR). Nothing is implemented; no decision below is the
owner's yet unless marked so.

Asked on 2026-11-05, from the day's watch: like Bambu Studio 2.9.1, slice
one model with nozzles of different diameters, each with its own layer
height. On the U1 (four heads) it would let a small nozzle print details
and a large one the body in the same print.

Source: [Bambu Studio 2.9.1 release notes](https://github.com/bambulab/BambuStudio/releases/tag/v02.09.01.70)
("Mixed Nozzle Diameter Slicing and Printing").

## What Bambu Studio 2.9.1 does

- Before 2.9.1, nozzles could already be assigned by **line type** (walls,
  infill, supports: Process › Strength › Advanced).
- 2.9.1 goes down to **regions of a model**: details on a small nozzle, the
  body on a large one, and **each nozzle prints at its own layer height**
  over the same Z range (thin layers for the small one, thick ones for the
  large one).
- Bambu says it needed "extensive refactoring of the slicing architecture"
  and touches slicing, materials, presets and nozzle switching. It ships
  for one machine (H3C) first.

The last point matters most here: this is an **engine** feature, not a UI
feature. Snap Studio does not slice by itself.

## Today in Snap Studio

- **Engine**: Snapmaker Orca 2.4.0, headless (`src-tauri/src/slice.rs`,
  `src-tauri/engine.json`; 2.4.1 in draft #86). Its `PrintConfig.cpp` has
  no per-nozzle layer height option. Layer height is a process setting
  (`layer_height`), one per slice, set from the slice sheet's Basic level
  (`Simple::layer_height`, `slice.rs`).
- **Machine profile**: one per slice, chosen by name (`matchMachine`,
  `ui/slice.js`); the U1 has `Snapmaker U1 (0.2 / 0.4 / 0.6 / 0.8 nozzle)`.
  Each gives the **same** diameter to the four heads
  (`nozzle_diameter: ["0.4","0.4","0.4","0.4"]`) and the matching
  `min_layer_height` / `max_layer_height`. The 0.4 one is the default on a
  tie.
- **Heads**: per printer, a filament profile per head and, per model file,
  which head prints each color (`ui/heads.js`). Prepare can assign heads
  **by object** or **by color** (#52). The 3MF written for the engine gives
  each part its head (`write3mf.rs`, `extruder` metadata).
- **What the printer reports**: each head's `nozzle_diameter` and
  `nozzle_volume_type` (standard / high flow) are already read for the
  Maintenance view (`src-tauri/src/maintenance.rs`, chip in `ui/maint.js`).
  The slice sheet does not use them: a 0.6 nozzle on head 3 is sliced as a
  0.4 if the 0.4 profile is chosen.
- **Line types per head**: not exposed (Orca's `wall_filament`,
  `sparse_infill_filament`, `solid_infill_filament` exist in the engine
  but Snap Studio does not set them).

## Proposed, in steps

Each step is useful alone and can stop there.

### Step 1. Know each head's nozzle (no new slicing feature)

- Read each head's diameter from the printer (already done for
  Maintenance) and show it on the head tokens in Prepare and in the slice
  sheet's heads list (for example "T2 · 0.6").
- When all heads have the same diameter: pick the matching machine profile
  (`(0.6 nozzle)`) instead of the 0.4 default. When they differ: a clear
  notice that mixed nozzles are not sliced yet and which profile is used.
- Warn before sending when the profile's diameter for a head used by the
  print is not the one the printer reports (same row style as the spool
  check sheet, `ui/spoolcheck.js`).

### Step 2. Mixed diameters per head, one layer height

- Send the engine a machine configuration whose `nozzle_diameter` (and the
  per-extruder lists that follow it: `min_layer_height`,
  `max_layer_height`, retraction, …) has one value **per head**, taken
  from the printer, built from the U1 profiles of each size
  (`src-tauri/src/presets.rs` already flattens and overrides configs).
- One layer height for the whole slice, limited to what every head **in
  use** accepts (`min` of the max layer heights, `max` of the mins); the
  slider's range follows, with a short explanation when it narrows.
- Line widths follow each head's diameter (the engine's percentage line
  widths already do).
- To verify first, with the real engine (an ignored Rust test, as
  `engine_writes_the_plate`): that Snapmaker Orca slices a U1 config with
  different diameters per extruder without error, and what it writes for
  each tool change.

### Step 3. Per object: its own layer height

- In Prepare's **by object** mode, an object printed by one head could get
  its own layer height (Orca supports per-object `layer_height` overrides
  on one plate; to verify headless with the U1 profiles). This gives "the
  small nozzle prints the small parts in thin layers" without any engine
  change, for prints made of several objects.
- UI: the object inspector gets a layer height field, defaulting to the
  slice's, limited by its head's nozzle.

### Step 4. Per zone inside one object (Bambu's feature)

- Needs the engine to support it. Options, for the owner:
  - wait for Snapmaker Orca (or upstream OrcaSlicer) to ship it, then
    expose it (follow the engine releases, as for #86);
  - port Bambu Studio's change into Snap Studio's engine build (AGPL on
    both sides, but a large slicing refactor to maintain);
  - not do it.
- Until then the plan stops at step 3. No fake "zones" built by cutting the
  mesh: it would print as separate objects with seams.

## Decisions / open questions for the owner

1. Which steps are in scope for this PR (1 alone, 1 to 2, 1 to 3)?
2. Step 4: wait for the engine, port, or drop?
3. Step 1: when the printer cannot be read (offline), keep today's behavior
   (machine profile chosen by name) or ask for the nozzle sizes by hand?
4. Step 2: should the user be able to override a head's diameter by hand
   (nozzle changed but printer not updated)?
5. Step 2 and the prime tower: with different diameters, does the tower
   (and the per-material pillars, #37) need its own width per head?
6. Should line types per head (walls on one head, infill on another, the
   pre-2.9.1 Bambu feature) be a separate step? It is engine-supported
   today and simpler than zones.

## Out of scope

- Any engine change (step 4 is a decision, not work in this PR).
- Nozzle changes from the app (the user swaps nozzles on the machine).
- High-flow vs standard nozzles: already handled by the profiles' lists
  (second value); unchanged.

## Files likely touched (steps 1 to 3)

- `ui/heads.js`, `ui/slice.js`, `ui/prepare.js` / `ui/prepare-logic.js`
  (head tokens, profile choice, per-object layer height), `ui/spoolcheck.js`
  (nozzle mismatch row).
- `src-tauri/src/presets.rs` (per-extruder machine config),
  `src-tauri/src/slice.rs` (request fields), `src-tauri/src/write3mf.rs`
  (per-object settings in `model_settings.config`).
- `src-tauri/src/sim/` (simulated heads with different diameters, so the
  `farm` scenario can show it).
- `ui/i18n/*.json` (9 catalogs).

## Testing

- Pure tests: layer height range from a set of heads; profile pick from
  the printer's diameters; mismatch detection.
- Rust: per-extruder config built from two profile sizes; ignored engine
  tests for steps 2 and 3 (G-code has the expected tools and layer Zs).
- Simulator: a printer with a 0.2 and a 0.6 head.
- On a U1 with two nozzle sizes: a two-object print, first layer and tool
  changes checked.

## Docs and CHANGELOG

- No CHANGELOG line in this PR (spec only). At implementation, under
  *Unreleased › Added*, for example: "**Mixed nozzles**: Snap Studio reads
  each head's nozzle size, slices with it, and lets each object printed by
  its own head have its own layer height."
- Strings in the 9 catalogs (`python3 scripts/check-i18n.py`); README
  feature list and `docs/plans/README.md` updated at implementation.
