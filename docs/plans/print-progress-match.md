# Print progress and time left: the app and the printer disagree

Partly implemented in [#100](https://github.com/kameka22/snap-studio/pull/100):
step 3 (the slicer-based time left) and its tests, before the measure; the
measure itself has a script, `scripts/measure-progress.sh`. Left: step 1
during a print on the U1, then steps 2 and 4 and the simulator case of
step 5, which depend on it.

## Measured on a finished print (U1, firmware 2.1.0, 2026-11-11)

A 4-colour print sliced by Snapmaker Orca 2.4.0, read after it ended:

- **The slicer's estimate holds**: `estimated_time` 5592 s, `print_duration`
  5616 s at the end, 0.4 % apart. Step 3 rests on it.
- **The file's `M73 P` is time-based**, with `R` (minutes left): 193 lines,
  up to 12.7 points from the file position (`M73 P20` at 10.9 % of the file,
  `P80` at 89.5 %), and close to it now and then (`P60` at 59.8 %). The
  formula is therefore chosen once per job: time-based as soon as the
  progress leaves the file position, kept until the next job.
- **No other progress object**: among the firmware's own objects
  (`machine_state_manager`, `print_task_config`, `filament_feed`, ...) none
  carries a percentage or a time, so the screen most likely reads Klipper's.

## Measured during a print (U1, firmware 2.1.0, 2026-11-11)

A 25-layer print (`estimated_time` 347 s), the printer read every 5 s and
the screen's percentage noted next to Snap Studio's at the same moments
(`scripts/measure-progress.sh` aside, a live log):

| Screen | App (`M73 P`) | File | G-code bytes read |
|---|---|---|---|
| 5 | 9 | 10.7–11.6 % | 3–4 % |
| 17 | 24 | 22.6–24.0 % | 16–18 % |
| 25 | 33 | 29.1–30.7 % | 24–26 % |
| 50 | 53 | 50.0–51.8 % | 48–50 % |
| 60 | 60 | 59.8–61.8 % | 59–61 % |
| 75 | 77 | 73.2–75.0 % | 74–76 % |
| 90 | 89 | 84.8–86.6 % | 88–90 % |
| 95 | 93 | 89.6–91.2 % | 93–95 % |

- **`display_status.progress` follows `M73 P`** on the U1, a share of the
  time: the app showed it.
- **The screen shows the share of the print's G-code read**: the file
  position between Moonraker's `gcode_start_byte` and `gcode_end_byte`
  (the header with the thumbnails before, the slicer's settings after), as
  Mainsail and Fluidd's "file relative" progress. It fits every reading
  within the reading delay, and the earlier print too (`M73 P40` at 37.8 %,
  38 on the screen). Neither the layers nor the filament used fit all of
  them.
- The time left on the screen is not measured yet.

During a print, the percentage and the time left shown by Snap Studio
(Printers, Prints, the 3D printer view, the send sheet) are not those shown
on the U1's screen.

## How the app computes them today

Everything comes from one place, `apply_status` in
`src-tauri/src/printers.rs:668-701`, fed by the HTTP query (`status`) and by
the live feed (`watch.rs`, merged snapshot):

- **Percentage**: `display_status.progress`, or else
  `virtual_sdcard.progress` (`:689-694`). Klipper's `display_status.progress`
  is the last `M73 P` the G-code sent when there is one, otherwise the
  position in the file (bytes read / file size), the same as
  `virtual_sdcard.progress`.
- **Time left**: not read from the printer. The app extrapolates it from
  that percentage: `elapsed × (1 − p) / p`, with `elapsed =
  print_stats.print_duration`, only above 2 % (`:696-701`).
- **Display**: `Math.round` of the percentage everywhere
  (`ui/printers.js:307`, `ui/prints.js:125, 327, 576`,
  `ui/printer3d.js:210-211`, `ui/control.js:619`). The time left goes
  through `fmtHms` (`ui/printers.js:187-192, 322`; it rounds the seconds
  then floors the minutes), `fmtDuration` (`ui/app.js:91`, in
  `ui/prints.js:583-584`) and, as an end time, `fmtClock`
  (`ui/prints.js:328, 567, 584`, `ui/slice.js:937`).

## Likely causes of the gap

1. **A different time left.** The extrapolation assumes a constant speed
   over the file. It is wrong at the start (heating, bed leveling and the
   purge count in `print_duration` but not in the bytes), and whenever the
   speed changes (first layer, supports, tool changes of the U1, which are
   long and take few bytes). The U1's screen most likely shows the slicer's
   estimate (`M73 R`, or the file's `estimated_time` minus the time spent),
   which follows the real schedule.
2. **A different percentage.** If the U1's screen shows the position in the
   file and the G-code sends `M73 P` (time-based, from the slicer), or the
   reverse, the two numbers drift apart, by a lot on prints with many tool
   changes.
3. **Rounding.** `Math.round` against a screen that may floor: at most 1 %,
   but visible at 99 % / 100 %.

What the U1's screen reads is not documented: it has to be measured (step 1).

One limit to keep in mind: Klipper does not keep `M73 R` (time left sent
by the G-code); only `M73 P` ends up in `display_status.progress`. If the
screen shows `M73 R` and the U1 does not expose it in an object of its
own, the app can only come close to it, from `estimated_time` and
`M73 P`, not show the exact same minutes.

## Plan

1. **Measure on the U1** (no code). During a print of a few colours,
   several times (start, first layer, a tool change, middle, end), note
   what the screen shows and save:
   - `/printer/objects/list`, then a full query of every object that is
     not standard Klipper (the U1 has some: `print_task_config`), to find
     a progress or time left of its own;
   - `/printer/objects/query?print_stats&display_status&virtual_sdcard`;
   - `/server/files/metadata` of the job (`estimated_time`), and whether
     the G-code contains `M73` (`P` and `R`).

   `scripts/measure-progress.sh <address> [port] [label]` saves all of this
   in one folder per moment (`measures/progress/`, not committed), with a
   `screen.txt` to write what the screen shows.

   That tells which value the screen uses for each number, and whether
   the U1 exposes the time left it shows.
2. **The same percentage as the screen**: measured, the screen counts the
   share of the print's G-code read, not `M73 P`. Done in `apply_estimate`
   with `gcode_start_byte` and `gcode_end_byte`, read with the estimate,
   while printing or paused; the time left keeps the time-based `M73 P`.
   Control reads it the same way. Without those bytes, the printer's
   percentage stays.
3. **The same time left as the screen**: a slicer-based estimate instead of
   the extrapolation.
   - Read the job's `estimated_time` at each new job, not per file name
     (the slicer can write a new file under the same name): when the state
     turns to `printing` with another name or another start. Kept with the
     job in both paths, the poll (`printers.rs`) and the live feed
     (`watch.rs`). The metadata is read beside the status, never before it:
     it must not delay the status (4 s timeout when the printer is slow).
   - Time left = `estimated_time × (1 − p)` with the time-based `p` of
     `M73 P`, or `max(0, estimated_time − print_duration)` without it, as
     Mainsail's "slicer" estimate does. Scaled by the speed factor only if
     step 1 shows that the screen does it.
   - Back to the current extrapolation when the file has no estimate
     (G-code from another slicer).
4. **Rounding** like the screen (floor or round, per step 1), in one helper
   for the percentage used by every view (`fmtPct`), and the same rule for
   the time left in `fmtHms` and `fmtDuration`.
5. **Tests**: `printers.rs` tests with recorded U1 answers from step 1 (with
   and without `M73`, with and without `estimated_time`). The simulator
   gives `estimated_time` already, but the same value to
   `display_status.progress` and `virtual_sdcard.progress`
   (`sim/machine.rs:1086-1089`): a time-based `M73 P` that differs from the
   file position is to be added, and its scenario checks the new time
   left.

No new interface string. Changelog: Unreleased › Fixed.

## Open questions

- Which values the U1's screen uses (step 1 answers it), and whether its
  time left can be matched exactly or only closely (see `M73 R` above).
- If the screen's estimate itself is poor, should the app follow it anyway?
  Proposed: yes, the same numbers on both is what is asked; a better
  estimate can come later, for both.
