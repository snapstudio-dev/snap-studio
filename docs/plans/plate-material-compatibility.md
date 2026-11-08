# Plate and material compatibility warnings

Merged in [#16](https://github.com/kameka22/snap-studio/pull/16)
(2026-11-04). Implemented (see [Implementation](#implementation)). The rule
table was marked for review before merging; the pull request has no review
comment, and that review is not requested again. Graphic Effect stays the
least sure pair in [Open questions](#open-questions-for-the-owner).

Scope approved by the owner: warn when the build plate and the materials do
not go together, and show a glue tip when the pair needs one, when preparing
or sending a print. On 2026-11-04 the owner added five points on the
**Control** side, all in this PR.

## Today

- The plate exists only in Prepare: the slice sheet's plate menu (`s-bed`,
  `ui/slice.js:216`), sent to the engine as `curr_bed_type`. The U1 offers
  Textured PEI, High Temp (smooth PEI) and Graphic Effect
  (`Index::bed_types`, `src-tauri/src/presets.rs:463`). The choice is not
  kept per printer and Control does not know it.
- Control shows the bed (gauge and target slider, `ctlBedHtml`,
  `ui/control.js:207`) and lets the user declare or load a head's material
  (`ctlFilament`, `ui/control.js:585`). Spools are also read by RFID.
- The spool check (`ui/spoolcheck.js`) already opens one sheet before every
  start: Send from Prepare (`ui/slice.js:982`), a printer file
  (`ui/slice.js:1069`) and the queue (`ui/prints.js:1134`). It compares
  materials by family (`spMaterialFamily`).

## The rules

One table, `ui/plate-rules.js` (pure, tested in `scripts/test-*.js`):
material family (`spMaterialFamily`) × plate (`curr_bed_type` value) →
`ok`, `warn` (with a reason key) or `glue` (with the treatment and the
reason). Unknown material or plate: `ok`, nothing shown. The examples from
the PR (TPU, PETG on smooth PEI) are the starting point; the full table is
written at implementation and was marked for review by the owner before
merging. #16 merged without a review comment; that review is not a gate
anymore. It is
a data table so it can be edited later without touching the logic. The
copy names materials generically.

## 1. The plate on the printer (base of the other points)

- A **plate** menu in Control's Bed card (full and compact), with the
  machine's plates (`bed_types`). Saved per printer (by printer id, with the
  other per-printer settings); unset by default ("Not set").
- Prepare's plate menu takes it as its default when that printer is chosen;
  the user can still change it for one slice.
- Every check below compares against it. Unset: the checks that need it are
  skipped, never guessed.

## 2. Check when a spool is loaded

- When a head's material is declared or loaded from Control
  (`ctlFilament`), and when the printer reports a new spool on a head
  (RFID, seen through the Control polling), the material is checked against
  the plate set in point 1.
- `warn`: a small sheet, **Continue** / **Cancel** for a declaration from
  Control; for an RFID spool (nothing to cancel), a non-blocking notice in
  the head's card.
- `glue`: the glue tip with its simple diagram (plate, glue, part) and a
  short text.
- Once per head and spool: the same spool polled again does not warn again.

## 3. Check at start from the queue or the printer's files

- For a file already sliced, the plate it was sliced for comes from the
  slice record when there is one, otherwise from the G-code's
  `curr_bed_type` line in its settings block (to check that Orca writes it in
  the U1's G-code).
- It is compared with the plate set on the printer and with the materials
  the print uses. A mismatch is added to the **existing spool check sheet**
  as one more row, not a second dialog. Same Continue / Cancel.
- Send from Prepare gets the same row (the original scope of this PR).

## 4. Suggested bed temperature

- In Control's Bed card, when a head has a known material and the plate is
  set: a small "Suggested: {t} °C" chip next to the slider, from the
  filament profile's temperature for that plate (`textured_plate_temp`,
  `hot_plate_temp`…, as `ui/profiles.js` already reads them). Clicking it
  sets the target. With several materials, the highest of the heads in use,
  and the chip says so. Never changes the target by itself.

## 5. Glue reminder before the start

- When the pair needs glue, the start sheet (spool check) shows a
  **"Glue applied"** box to tick before Start; Start stays enabled (it is a
  reminder, not a lock).

## "Don't show again"

Per warning type (incompatible pair, glue tip, glue reminder, plate
mismatch at start), as in the original scope, re-enableable in **Settings ›
Prepare**. The suggested temperature chip is not a warning and has no
switch.

## Strings and docs

- All new strings in the 9 catalogs (`python3 scripts/check-i18n.py` clean).
- CHANGELOG line under *Unreleased › Added* at implementation, for example:
  "**Plate and materials**: Snap Studio knows which plate is on each printer
  (Control), warns when a material does not suit it, when a spool is loaded
  and before a print starts, suggests the bed temperature and reminds to
  apply glue when needed."
- `docs/plans/README.md` state updated.

## Checks at implementation

- Rule table tests on every pair (pure function).
- Plate set in Control → Prepare's default; changed in Prepare for one slice
  → printer's plate unchanged.
- Declare / load a material in Control: warn and glue cases; RFID spool
  change in the printer simulator (dev builds, #87).
- Start from the queue and from a printer file with a different plate: one
  row in the spool check sheet; Send from Prepare likewise.
- Suggested temperature with one and with two materials.
- "Don't show again" for each type, then re-enabled in Settings.
- Unset plate, unknown material, printer with no spools: nothing shown.

## Implementation

- **Rules** (`ui/plate-rules.js`, `scripts/test-plate.js`): `PLATE_RULES`,
  per plate value and material family, `warn` or `glue` with a reason
  (`stick`, `heat`, `bond`, `grip`). Every pair is tested; anything the
  table does not name is fine; unknown plate or material: nothing.
- **1. Plate per printer** (`heads.js` `headsPlate`, `control.js`): a
  plate menu in the Bed card (full and compact), "Not set" first, saved
  with the printer's heads; the slice sheet takes it as its default
  (`fillBeds`), a change there is that slice's.
- **2. Spool loaded** (`ui/plate.js`): declaring a head's material in
  Control asks first (`plateAsk`: Continue / Cancel, or the glue tip with
  its drawing). A new spool on a head (RFID or the printer's screen) puts a
  notice in its card ("How?" opens the tip, × closes it), once per head
  and spool (`snapstudio.plate.seen`); a printer read for the first time
  takes its spools as they are; changing the plate checks the spools
  loaded. Prepare asks the same when slicing (`startSlice`).
- **3. At start** (`spoolcheck.js`): the spool check sheet gets the plate
  rows (another plate than sliced for, a material that does not suit the
  printer's plate) and opens for them alone. The sliced plate: the slice
  record's `bed`, else the G-code's `curr_bed_type` (`SliceStats.bed_type`;
  for a file on the printer, `pf_plate` reads its last 256 KB with an HTTP
  range). Checked with the real engine: Orca writes it in the U1's G-code
  settings block (`engine_writes_the_plate`, ignored test).
- **4. Suggested temperature** (`control.js` `ctlSuggest`): the loaded
  heads' filament profiles (`slice_details`) for the printer's plate, the
  highest; the chip sets the target on click.
- **5. Glue reminder**: a "Glue applied" box in the start sheet; Send /
  Start never waits for it.
- **Don't show again**: four kinds (`pair`, `glue`, `reminder`,
  `mismatch`, `snapstudio.plate.hide`), four switches in Settings ›
  Prepare.

### The rule table (first version, to review)

Pairs not listed are fine (nothing shown).

| Plate | Glue (reason) | Warning (reason) |
|---|---|---|
| Textured PEI | PA, PC (grip) | PP, PE (does not stick) |
| Smooth PEI (High Temp) | PETG, PCTG, PET, TPU, TPE, PEBA (bonds too strongly); PA, PC (grip) | PP, PE (does not stick) |
| Graphic Effect | PETG, TPU, TPE (bonds too strongly) | ABS, ASA, PC, PA (needs a hotter bed); PP, PE (does not stick) |
| Cool Plate | PETG, PCTG (bonds too strongly) | ABS, ASA, PC, PA (needs a hotter bed); PP, PE (does not stick) |
| Textured Cool Plate | — | ABS, ASA, PC, PA (needs a hotter bed); PP, PE (does not stick) |
| Engineering Plate | PLA, PA, PC (grip); PETG, TPU (bonds too strongly) | PP, PE (does not stick) |
| Supertack Plate | PETG, TPU, TPE (bonds too strongly) | PP, PE (does not stick) |

## Open questions for the owner

- The rule table's content (above). It was flagged for review before
  merging; #16 has since merged with no review comment, so it is not asked
  again as a gate. The Graphic
  Effect plate's rules are the least sure: Snapmaker's guidance for it is
  not known here. An owner may still correct that pair later.
- Whether point 1's plate should also be read from the U1 itself, if its
  firmware ever reports the plate (not known today).
