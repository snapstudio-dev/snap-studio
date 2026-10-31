# Plans

One plan per project in progress. A finished plan leaves this folder: it stays
available in the git history (links below), and what is left to do joins the
lists below.

## In progress

| Plan | Subject | State |
|---|---|---|
| [ai-setup.md](ai-setup.md) | AI dependency checks per mode (welcome step and Settings), AI locked until a mode is ready; Settings with a side menu | Implemented; checks on the Mac left (see the plan) |
| [ai-chat.md](ai-chat.md) | AI conversations as a real chat view (Claude Code stream-json), terminal kept as advanced view | Implemented, with the Claude sign-in window; since #25 the Terminal tab shows the chat's own session (read only). Container mode and macOS checks left (see the plan) |
| [prime-tower-per-material.md](prime-tower-per-material.md) | One prime tower per material: pillars per group of materials that bond (concentric rings, one per head), engine tower off, list order | Implemented in draft PR [#37](https://github.com/kameka22/snap-studio/pull/37); checks on the U1 left (see the plan) |
| [languages.md](languages.md) | German, Spanish, Brazilian Portuguese and Italian (wave 1); Japanese, Simplified Chinese and Korean next (wave 2); Weblate for review | Wave 1 implemented in draft PR [#72](https://github.com/kameka22/snap-studio/pull/72) |
| [printer-files-multi-delete.md](printer-files-multi-delete.md) | Printer files: right-click → Delete on picked files deletes them all and keeps the other picks; Ctrl/Cmd and Shift-click picking outside Select mode | Merged in [#84](https://github.com/kameka22/snap-studio/pull/84), in 0.18.0; checks on a printer left (see the plan) |
| [engine-orca-2.4.1.md](engine-orca-2.4.1.md) | Bundled engine Snapmaker Orca 2.4.0 → 2.4.1: the engine's prime tower in blocks per adhesiveness category (vs #35's warning and #37's pillars), changed defaults, U1 profile changes, 3MF compatibility | Implemented in draft PR [#86](https://github.com/kameka22/snap-studio/pull/86); engine release (kameka22), D2 and a real U1 print left |

## Planned

| Plan | Subject | State |
|---|---|---|
| [ai-agents.md](ai-agents.md) | OpenCode next to Claude Code, one agent active at a time | Written, postponed |
| [ai-builtin-sandbox.md](ai-builtin-sandbox.md) | Claude Code's built-in sandbox as the default sandbox on macOS and Linux; yolobox kept for those who use it | Written, draft PR [#62](https://github.com/kameka22/snap-studio/pull/62) |
| [slice-basic-advanced.md](slice-basic-advanced.md) | Basic and Advanced levels for the slice sheet (title bar and Settings) | Written, draft PR |
| [virtual-heads.md](virtual-heads.md) | Virtual heads: color mixing of two spools (Snapmaker Orca's Full Spectrum), one head token per color in Prepare | Written, draft PR |
| [virtual-heads-smooth-mix.md](virtual-heads-smooth-mix.md) | Virtual heads: smooth mix (Subdivide Mix Layer sent to the engine, on by default) and a warning for colors too far apart | Merged in [#81](https://github.com/kameka22/snap-studio/pull/81), in 0.17.1 |
| [rust-review.md](rust-review.md) | Rust review of `src-tauri/`: renamed Orca presets, protocol pool panics, commands on the UI thread, error context, tests, formatting | Merged in [#82](https://github.com/kameka22/snap-studio/pull/82), in 0.18.0; *Consider* items left |
| [prints-redesign.md](prints-redesign.md) | Prints page redesign: list and record (C, chosen from three mockup directions; the stats go to the printer page and a Statistics page in a follow-up) | Implemented in draft PR [#65](https://github.com/kameka22/snap-studio/pull/65) |
| [ai-source-models.md](ai-source-models.md) | STL and 3MF files as source models in AI conversations (creation sheet and chat); dropped files reach the AI view; a message for files that can't be attached | Merged in [#83](https://github.com/kameka22/snap-studio/pull/83), in 0.18.0; checks in the app on the three systems left |

The other planned features each have a draft pull request: see the
[Roadmap](../../README.md#roadmap).

## To validate on the real machine

Features implemented and tested without the hardware (headless browser, Rust
tests), whose real behavior remains to be checked.

- **Languages**: native menu bar in English, French, German, Spanish,
  Brazilian Portuguese and Italian, rebuilt when the
  language changes in Settings; system language preselected on a fresh
  account; macOS permission prompts in French on a French system
  (`InfoPlist.strings`); the AI terminal answers in the chosen language.
- **Automatic updates**: release N installed, release N+1 published → the
  sheet opens, installation succeeds, the app restarts (macOS, Windows, Linux
  AppImage); tampered file refused.
- **macOS permissions**: with the ad hoc signature, a single access prompt per
  folder, and no longer at every launch (`tccutil reset All
  fr.carlini.snapstudio` to start from scratch).
- **Bed temperature**: slicing a PLA on textured PEI really gives 65 °C (and
  not 35 °C).
- **Prints**: end of print detected, notification, next one offered ("bed
  clear" box); pause, resume, cancel from the record; camera in the record.
- **Network search**: the U1 shows in "On the network" (otherwise: the
  `[discover]` log in the `cargo tauri dev` terminal).
- **Welcome assistant**: first launch on a fresh account.
- **Spool check** (0.10.0): a substituted head really prints the color
  (`print_task_config.extruder_map_table`), `SET_PRINT_USED_EXTRUDERS` with
  the physical heads, and the map back to identity when the print ends; the
  color tolerance (CIEDE2000, 10) against colors read from RFID.
- **Printer files** (unreleased): a multicolor file printed from Files
  prepares all its heads; Add to Queue from a printer's file; timelapses
  under `camera` played (seek) and deleted through the camera service, on
  macOS WKWebView and Windows WebView2.
- **Share** (unreleased): the share menu's position, AirDrop of a timelapse,
  a copied file pasted in the Finder, the QR code from a phone (the macOS
  firewall may ask once).
- **Speed** (unreleased): a print at 75 % — reduced accelerations (f²) and
  the real duration against the estimate; with a high-flow nozzle, the second
  value of the lists is the one used.
- **Prepare** (unreleased): with objects set aside off the plate, only
  those on it are printed; a dense file (as "10+Pumpkins") shows its
  loading and prints with the full mesh.
- **Display** (unreleased, on the Mac): back to System after a forced
  light or dark mode, the app takes the system's mode without staying on
  the forced one; in the macOS theme, the window buttons sit well in the
  floating sidebar.
- **Bed leveling** (unreleased, #21): a measurement from the app on a U1
  (AUTO_BED_MESH_CALIBRATE: the 2 min settle countdown against the
  machine, the probe's preheat, the corner check); the clean stop
  (`bed_mesh/abort_probe_mesh`) ends the probing and the bed is turned
  off; the emergency stop brings the printer back to ready; the
  temperature proposed from Moonraker's history; the shape diagnosis on
  real beds; a lost connection followed until the end.
- **Control** (unreleased, #17): on a U1, each action against the machine —
  `T<n> A0` from the app, `AUTO_FEEDING EXTRUDER=<n>` (does it home or
  heat by itself?), `INNER_FILAMENT_UNLOAD` after picking the head,
  `CONTROL_EXTRUDE_ACTION` / `CONTROL_RETRACT_ACTION` on the active head,
  `ROUGHLY_CLEAN_NOZZLE`, `M106` on the active head's fan, the chamber fan,
  `SET_PURIFIER FAN=inner`, the light; jogging near the edges (Y capped at
  270 mm in front of the head docks, Z ≥ 0.5 mm); the screen of the U1
  while the app drives it; the camera view in the tab.
- **AI sandbox**: if a sandbox restarts while idle, the exit code shown in
  the Terminal tab and the `[chat] Claude ended…` console line say why.

## Later

Ideas dropped or postponed during the work, in no order of priority.

- **Prepare**: brush painting; cutting objects; modifiers and per-object
  settings; Move and Scale handle tools (of little use while the object is
  dragged and the inspector sets the scale). Several plates: see #18.
- **Share**: a light version of a timelapse for social networks (compressed
  video or GIF, needs ffmpeg); the system share sheet on Windows.
- **Printers**: subnet sweep (port 7125) when a printer does not show in mDNS.
- **Profiles**: Snap Studio's own custom profiles (today: Snapmaker Orca's if
  installed, read-only); standalone "Profiles" page; profile editing.
- **G-code preview**: Files view thumbnails in the filament colors (they keep
  the per-path-type colors).
- **Signing**: Apple Developer ID (no more Gatekeeper alert, permissions kept
  from one update to the next) or a stable self-signed certificate.
- **Engine**: switch to a real headless binary if Snapmaker publishes one
  (Snapmaker PR #1006, upstream PR #14161).
- **AI**: Blender / MCP bridge, plate editable from the conversation, keeping
  colors and multiple objects.
- **Languages**: more languages after wave 2 (Orca's tabs already exist in
  19, see [languages.md](languages.md)); internal
  identifiers still named `ia` (commands, storage folder) could become `ai`
  with a data migration.

## Finished plans

| Plan | Subject | In the history |
|---|---|---|
| AI | AI tab: Claude Code conversation, terminal, live preview | `git show 4e65ac3:PLAN-IA.md` |
| Slicing | Built-in slicing, preview, heads and filaments, sending | `git show e3be17e:PLAN-DECOUPE.md` |
| Prepare | Plate, selection, rotation, auto-orientation, arrangement | `git show e3be17e:PLAN-PREPARER.md` |
| Updates | Cross-platform builds, signing, automatic updates | `git show e3be17e:PLAN-MAJ.md` |
| Welcome | Welcome assistant, mDNS printer discovery | `git show a073e0d:PLAN-ACCUEIL.md` |
| Prints | Running prints, queue, history | `git show 0c8eb89:PLAN-IMPRESSIONS.md` |
| Profiles | Profile details, Orca's tabs in French | `git show 0c8eb89:PLAN-PROFILS.md` |
| Engine | Bundled slicing engine: Snapmaker Orca slimmed down by the CI, downloaded and updated by Snap Studio — validated (release `engine-orca-2.4.0`, slicing in the app) | `git show fda95e9:docs/plans/moteur.md` |
| Colors per object | Painted 3MF files keep their colors; one head per color of each object (#7, 0.8.0) | `git show ae3a160:docs/plans/object-colors.md` |
| Maintenance | Maintenance view per printer: counters, tasks, log (#12, 0.9.0) | `git show ae3a160:docs/plans/printer-maintenance.md` |
