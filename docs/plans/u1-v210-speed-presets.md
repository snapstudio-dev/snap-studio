# Speed presets aligned with U1 firmware V2.1.0

Plan only (draft PR). Small, precise change; not a redesign of the Speed
adjustment (#29).

Asked on 2026-11-05, from the day's watch. U1 firmware V2.1.0 (released
2026-11-04) "adjusted print speed levels to 50/75/100/125/150 for
consistency with Orca and the App".

Source: [Snapmaker U1 firmware V2.1.0 release notes](https://wiki.snapmaker.cn/en/snapmaker_u1/firmware/release_notes/v210)
(Improvements, item 1).

## Today in Snap Studio

- **Slice sheet, Speed** (`ui/speed.js`, `ui/slice-speed.js`, #29): one
  slider, `SPD_MIN = 50` to `SPD_MAX = 120`, `SPD_STEP = 5`, default 100.
  Marks (`SPD_MARKS`): 50 *Very safe*, 75 *Safe*, 100 *Profile*, 120
  *Fast*. Speeds × f, accelerations × f², bridges / first layer / travel
  only slow down, nothing above the machine's limits (`spdCaps`). Nothing
  is sent at 100 %. Tested by `scripts/test-speed.js`
  (`SPD_MARKS` values `[50, 75, 100, 120]` asserted).
- **While printing**: Snap Studio only **reads** the printer's speed
  factor (`gcode_move.speed_factor`, `src-tauri/src/printers.rs`) and shows
  it (printer chip in `ui/printers.js` when ≠ 100 %, the Prints record in
  `ui/prints.js`, the 3D printer view in `ui/printer3d.js`). There is no
  control to change it from the app (no `M220` or speed action in
  `src-tauri/src/control.rs`).

So the firmware's five levels (a live, during-print setting on the
machine) and Snap Studio's slider (a slice-time scaling of the profile)
are different things today; only the scale and the marks can be aligned
without adding a feature.

## Proposed (the small change)

1. **Range**: `SPD_MAX` 120 → **150**. `SPD_MIN` stays 50, `SPD_STEP`
   stays 5 (fine tuning between the levels is kept).
2. **Marks**: exactly the firmware's five levels, **50 / 75 / 100 / 125 /
   150**. Labels: 50 *Very safe*, 75 *Safe*, 100 *Profile*, 125 *Fast*,
   150 *Very fast* (new key `slice.speed.mark.very_fast`; French:
   « Très rapide »). The marks stay clickable as today.
3. **Safety unchanged**: above 100 % the machine limits still cap speeds
   and accelerations (`spdCaps`); at 150 % accelerations ask for × 2.25 and
   will usually hit the cap. The ⚙ panel already shows profile → computed
   values; the existing "capped" hint (`slice-speed.js`, `above`) covers it.
4. **Remembered states**: a saved 120 % stays valid (on a 5 % step, inside
   the range). Nothing to migrate.
5. **Wording**: the tooltips / summary keep saying "% of the profile", so
   the user does not take the slider for the machine's live level.

## Option (not proposed by default): live speed level

If the owner wants it, a follow-up (separate PR) could add the five levels
as a **live control** while a print runs (Prints record and printer view),
the way the printer's screen does. Unknowns to check first, on a U1 with
V2.1.0 and in the simulator: which command the firmware's levels send
(`M220 S…` or a Snapmaker macro), and whether the level also changes
accelerations. Not in this PR.

## Decisions / open questions for the owner

1. Range up to 150 % as the firmware, or keep 120 % as the cap and only
   move the marks (50 / 75 / 100 / 125 with 125 clamped)? The plan assumes
   150.
2. Keep the 5 % step, or snap to the five levels only (25 % steps)?
3. Labels for 125 and 150 (*Fast* / *Very fast*), or the plain percentages
   as the firmware shows them?
4. Live speed level while printing: wanted as a follow-up?

## Out of scope

- Any change to how speeds and accelerations are computed (#29's rules).
- Firmware detection or a minimum firmware version: the slice-time slider
  does not depend on the firmware.

## Files likely touched

- `ui/speed.js` (`SPD_MAX`, `SPD_MARKS`), `ui/slice-speed.js` (marks
  layout only if the fifth label does not fit), `scripts/test-speed.js`
  (marks, normalization up to 150, caps at 150 %).
- `ui/i18n/*.json`: one new key in the 9 catalogs.
- `README.md` (lines on Speed, "50 % to 120 %"), `README.fr.md` (same,
  « 50 % à 120 % »), `docs/technical-overview.md` ("50 to 120 %").

## Testing

- `node scripts/test-speed.js`: marks `[50, 75, 100, 125, 150]`, every
  mark on a step, `spdNormalize({ pct: 200 })` → 150, a 150 % state
  capped by the machine limits on the U1 profile values.
- The above-100 % hint and the ⚙ panel at 125 and 150 %.
- Slice sheet in the app: the five marks fit in English and French, light
  and dark themes; clicking each mark sets the slider.
- A real slice at 150 % on the U1 profile: G-code speeds and accelerations
  at the machine's limits, not above.

## Docs and CHANGELOG

- No CHANGELOG line in this PR (spec only). At implementation, under
  *Unreleased › Changed*, for example: "**Speed** in the slice sheet now
  goes from 50 to 150 % with marks at 50, 75, 100, 125 and 150 %, the
  same levels as the U1 firmware V2.1.0."
- `python3 scripts/check-i18n.py` clean.
