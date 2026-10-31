# Technical overview

How Snap Studio is built, how it talks to the Snapmaker U1, where its
parameters come from, how it handles errors, and how it is tested. For
building and publishing, see [DEVELOPMENT.md](DEVELOPMENT.md); for what each
version brought, the [CHANGELOG](../CHANGELOG.md). File names point to the
code under `src-tauri/src/` and `ui/`.

## What Snap Studio adds

Three features carry most of the project's own work for the U1. For each one,
what is native (engine, firmware) and what Snap Studio builds is kept apart below.

**One prime tower per material** (`ui/pillar-logic.js`, `ui/prepare-pillars.js`, `slice.rs`;
plan: [plans/prime-tower-per-material.md](plans/prime-tower-per-material.md)).

- *Engine*: Snapmaker Orca, like upstream OrcaSlicer, builds **one prime
  tower per plate** (`Print::m_wipe_tower_data`, one `wipe_tower_x/y` per
  plate). Since 2.4.1 that tower has **one block per adhesiveness
  category** of material (`filament_adhesiveness_category`): each material
  purges into its own block. Its outer wall and the seam between blocks are
  still printed by whichever head ends the layer, so materials that don't
  bond still meet there, unless one head prints the whole wall
  (`wipe_tower_filament`; measured in
  [plans/engine-orca-2.4.1.md](plans/engine-orca-2.4.1.md), T2). Separate
  towers are an open request upstream
  ([OrcaSlicer #8474](https://github.com/SoftFever/OrcaSlicer/issues/8474)).
- *Snap Studio*: groups the plate's heads into cliques of materials that
  bond (`pmGroups`, bonding table in `ui/spoolcheck.js`), and generates one
  pillar per group, with one concentric ring per head (2 mm rings, an 8 mm
  core, a 15 mm tube for a single head). Pillars are as tall as their
  head's last layer and are written into the 3MF sent to the engine as
  ordinary walls-only objects, first in the list, with
  `enable_prime_tower = 0` and `print_order = as_obj_list`. They are placed
  in a free spot, can be moved in Prepare, and are rebuilt at every slice,
  never saved in the user's project. The feature is only offered when two of
  the plate's materials don't bond, and the engine's single tower stays the
  default. Tests: `scripts/test-pillars.js`.

**Virtual heads (color mixing)** (`ui/virtual-logic.js`, `ui/virtual.js`, `slice.rs`, `mixcolor.rs`;
plan: [plans/virtual-heads.md](plans/virtual-heads.md)).

- *Engine*: the mixing is Snapmaker Orca's **Full Spectrum** (2.3.6 and
  later). A *mixed filament* of two physical filaments gets a virtual ID
  after the physical ones, and the engine resolves it to one real head per
  layer (`MixedFilamentManager::resolve`), so the G-code only contains
  `T0`…`T3`.
- *Snap Studio*: the U1-side workflow. A virtual head is created in the
  printer's Heads and spools from **two spools loaded on the U1** and one
  ratio slider (4:1 to 1:4), up to 8 per printer. It is offered next to
  T0–T3 in Prepare's head pickers and sent to the engine as
  `mixed_filament_definitions`. Mixing materials that don't bond is refused.
  When one of its spools is unloaded, the virtual head is deleted and what
  used it waits for a new head before slicing. The swatch uses Snapmaker
  Orca's pigment mixer (`filament_mixer_model.h`, MIT), ported to Rust as is
  so the preview color matches the slicer. Tests: `scripts/test-virtual.js`,
  and `engine_virtual_head_alternates` in `slice.rs`, which slices with the
  real engine and is ignored in CI.

**Print queue** (`jobs.rs`, `ui/prints.js`, `ui/prints-logic.js`).

- *Native*: Snapmaker Orca's Moonraker connection uploads and starts one
  print. It has no print queue for the U1: the "Upload to Queue" button
  of its print-host dialog is commented out, and only PrusaConnect and
  SimplyPrint declare a queue action. The U1's Moonraker
  (Snapmaker/u1-moonraker) loads the standard `job_queue` component as a
  core component, but its `moonraker.conf` has no `[job_queue]` section,
  so automatic transitions stay off. Snap Studio does not use it.
- *Snap Studio*: a queue kept on the computer, per printer, in `jobs.json`,
  with each job's G-code in `jobs/<id>.gcode`, so it survives a restart.
  Jobs come from the slice sheet or a printer's file (**Add to Queue**).
  They can be reordered (`job_move`), moved to another printer or given
  other start options (`job_edit`), or queued again from the history
  (`job_requeue`). A background task polls the printers every 8 s. A
  printer counts as free after two passes in a row, and the UI is then
  asked to **offer** its next job (`queue-next`), once per printer until
  the next print. Nothing starts without the user: the sheet needs "The bed
  is clear and clean", then runs the spool check against the spools loaded
  now (a head remap for that print only, or Edit in Prepare, which
  re-slices and replaces the queued job). Then come the usual start
  checks (printer online and idle, every head used has a spool), the
  upload, and `server.files.start_local_print`. Tests:
  `scripts/test-prints.js` (queued jobs in the list and timeline), and
  `jobs.rs` (history kept and pruned, the queue never pruned, pauses
  tracked).

## 1. Architecture

| Layer | What | Where |
|---|---|---|
| Shell | [Tauri 2](https://tauri.app), a native window with the system webview (WKWebView, WebView2, WebKitGTK). The title bar is integrated on every OS: macOS overlays its traffic lights (`tauri.macos.conf.json`); on Windows and Linux the window has no system decorations and the app draws its own buttons in the same 52 px band, with its own edge resizing and rounded corners on Linux, and a switch back to the system title bar there | `src-tauri/`, `titlebar.rs`, `ui/window-controls.js` |
| Backend | Rust, about 28k lines (tests included): printers, slicing, presets, 3MF read/write, G-code, jobs, camera, sharing, updates | `src-tauri/src/*.rs` |
| Interface | Vanilla JavaScript, no framework or bundler, 65 modules. The pure logic is split into `*-logic.js` files so it can be tested in Node | `ui/` |
| 3D | three.js for the plate, the G-code preview and the parametric U1 model (made by kameka22 for Snap Studio, `ui/printer3d/`) | `ui/printer3d*.js`, `ui/viewer.js` |
| Slicing engine | The official **Snapmaker Orca** package, slimmed down by a CI workflow and run **as a separate headless process**. The app downloads it on first use (about 30 MB), checks its SHA-256 and installs it atomically, so a half-installed engine is never used | `engine.rs`, `slice.rs`, `.github/workflows/engine.yml` |
| AI | Claude Code, run by the app in a sandbox (Claude Code's built-in one on macOS and Linux, or a container). Images and STL/3MF models can be attached; models are copied into the conversation's folder as 3MF, the only place the sandbox reads | `ia.rs`, `chat.rs`, `ia_attach.rs`, `ia_tools/` |

The engine runs headless with complete configurations written by the app (`presets.rs`). Two flags are essential: `--arrange 0`, without which the engine rearranges the plate (measured: with it, parts stay within 0.3 mm of the requested placement), and `--allow-newer-file`.

## 2. How it talks to the U1

No cloud and no account: everything goes over the LAN to the U1's own **Moonraker / Klipper**, the same way Snapmaker Orca and Fluidd do.

- **Discovery** (`discover.rs`): mDNS `_snapmaker._tcp.local` with its TXT record (`sn`, `device_name`, `machine_type`, `version`…), as in Snapmaker Orca's `SSWCP.cpp`. A wake-up query `_services._dns-sd._udp` goes first, because some routers only relay multicast after seeing some. `_moonraker._tcp` is searched at the same time for other Klipper printers.
- **Live state** (`watch.rs`): Moonraker's JSON-RPC WebSocket (`/websocket`), `server.connection.identify`, `printer.objects.list`, `printer.objects.subscribe`, then `notify_status_update`, `notify_gcode_response` and `notify_klippy_ready/shutdown/disconnected`. It reconnects automatically, with a backoff from 2 s to 20 s.
- **Polled state** (`printers.rs`): `/printer/objects/query` on `print_task_config`, `print_stats`, `display_status`, `virtual_sdcard`, `extruder`…`extruder3`, `heater_bed`, `toolhead`, `gcode_move` and `fan`. Spools come from the U1's `print_task_config` (RFID, `filament_official`), the `filament_motion_sensor e0…e3_filament` sensors and the feed modules' `channel_state`.
- **Sending a print**: `POST /server/files/upload`, then, like Snapmaker Orca, **`server.files.start_local_print`** with the options and the head map. The head map is applied with `SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=… MAP_EXTRUDER=…` and `SET_PRINT_USED_EXTRUDERS`. On a firmware without that method, the app falls back to `SET_PRINT_PREFERENCES` and a plain `printer.print.start`. Afterwards it reads `print_task_config` back and reports any option the printer did not apply.
- **Control** (`control.rs`): the UI never sends raw G-code. It asks for an *action*, and `plan()` turns it into a script, or refuses it, based on the printer's current state. The commands are the U1's own, checked in Snapmaker/u1-klipper: `T<n> A0`, `M104 T<n> S… A0`, `AUTO_FEEDING EXTRUDER=<n> LOAD=1 / UNLOAD=1`, `CONTROL_EXTRUDE_ACTION`, `ROUGHLY_CLEAN_NOZZLE`, `MOVE_TO_DISCARD_FILAMENT_POSITION`, `cavity_fan`, `cavity_led`, `SET_PURIFIER` and `SET_PRINT_FILAMENT_CONFIG`. The material list is read from the printer's `config/snapmaker/filament_parameters.json`. Emergency stop and firmware restart use `/printer/emergency_stop` and `/printer/firmware_restart`.
- **Camera**: `camera.start_monitor` / `camera.stop_monitor` (WebSocket, `domain: lan`) and `/server/files/camera/monitor.jpg`, as Snapmaker Orca reads it.
- **Bed mesh** (`bedmesh.rs`): Klipper's `bed_mesh`, plus the U1's `progress` field. Measuring uses the U1's `AUTO_BED_MESH_CALIBRATE TEMP=` macro (another Klipper printer gets `BED_MESH_CALIBRATE`), and `/printer/bed_mesh/abort_probe_mesh` stops it.
- **Files and timelapses** (`printer_files.rs`): `/server/files/roots`, `list`, `metadata`, `directory`, `move`, `DELETE` and ranged `GET`, plus `/server/history/list`. The stock U1's timelapses are found in its `camera` root, and the `timelapse` root of moonraker-timelapse is supported too.
- **Maintenance** (`maintenance.rs`): read-only. It uses the U1's per-head `switch_count`, `last_maintenance_count`, tool-change errors and retries, and `/server/history/totals`. Nothing is written to the printer.

## 3. Where the parameters come from

- **Slicing profiles**: the Snapmaker vendor profiles shipped inside the bundled engine (`resources/profiles/Snapmaker`), with inheritance resolved by the app. An installed Snapmaker Orca also lends its user presets, and Snap Studio's own presets are kept in a separate folder (`presets.rs`). Two engine traps are handled there: `nozzle_diameter` has to be copied into the process config, or the engine dereferences a null pointer, and filaments are filtered by `compatible_printers`, never by name.
- **Setting labels, tooltips and translations**: generated from Snapmaker Orca's sources (`Tab.cpp`, `PrintConfig.cpp`, `.po` files) by `scripts/gen-orca-settings.py`. None of it is written by hand.
- **Speed slider** (50 to 120 %): speeds × f and accelerations × f². At 100 %, the G-code is exactly the profile's.
- **Color mixing**: the preview color uses Snapmaker Orca's own pigment mixer (`filament_mixer_model.h`, MIT), ported as is in `mixcolor.rs` so that the swatch matches the slicer.
- **Material bonding** (tower warnings, one tower per material, mixing): Snapmaker Orca's adhesiveness categories (2.4.1), in `ui/spoolcheck.js` and `presets.rs`, which also sends each filament's category to the engine when its profile has none. Two families bond when they share a category; for families without one (TPE…), known pairs come from Snapmaker's wiki and slicer guides, and **unknown pairs are never warned about**. The pillar sizes come from a feasibility slice documented in [plans/prime-tower-per-material.md](plans/prime-tower-per-material.md).
- **Spool check**: CIEDE2000 color distance with a tolerance of 10 between the file's colors and the loaded spools.
- **Maintenance intervals**: head contacts every 100,000 tool changes, following Snapmaker's figure. The other intervals are prudent defaults, and the app says so, since Snapmaker gives none.
- **Bed-mesh thresholds**: 0.5 / 1 mm by default, and manual leveling is only suggested above 2 mm, since the U1's mesh compensates below that.
- **Control limits**: Z never goes below 0.5 mm, temperatures never exceed each heater's `max_temp` as read from the printer (100 °C for the U1 bed), and moves or head changes are only allowed once homed.

## 4. Boundary conditions and error handling

- **Printer offline**: Control, Care, Bed Leveling and Files all show the same one-line state, "‹name› is not responding", with **Retry**. While offline, the printer page hides the camera, the model and the address. A printer that answers with an error (Klipper shut down, HTTP 503) shows that error instead. Error messages don't show the printer's address.
- **Locked during a print**: Control keeps only the emergency stop, the light and the camera, and anything that cannot run says why.
- **Before a print**: the printer must be online and idle, and every head used must have a spool, otherwise the print is refused with the head named. A start that times out is checked against the printer state before anything is retried, so a print is never started twice. A printer that refuses (busy, nozzle mismatch…) is not asked again another way.
- **Queue**: when a print ends, the next one is *offered* on the printer you pick. Nothing starts on its own.
- **Engine and updates**: the engine archive is SHA-256-checked and installed atomically. App updates go through Tauri's updater, with signature verification, so a tampered package is refused.
- **Sharing to a phone**: one file, read-only, at an unguessable local URL, for 15 minutes at most or until the sheet closes.
- **Privacy**: no telemetry. The app only talks to GitHub (updates, engine), your printers, the sites you open in Explore, and Anthropic if you use the AI.

## 5. Tests and CI

- **Rust**: `cargo test --lib` gives **269 passed, 0 failed, 25 ignored** (the ignored tests need a local Snapmaker Orca or the engine). Several tests run against a small fake Moonraker on `127.0.0.1`, for file listing, deletion permissions and sharing. Another test checks that the print-start request matches Snapmaker Orca's.
- **Interface logic**: **27 Node test scripts** (`scripts/test-*.js`, about 3,100 lines) cover Prepare, towers and pillars, virtual heads, the spool check, Prints, the camera, Control, bed mesh, printer files and their picking, files attached to an AI message, the 3D printer model, themes and more.
- **Translations**: `scripts/check-i18n.py` checks the 9 catalogs, with 2,269 keys each and 100 % coverage.
- **CI** (GitHub Actions): `test.yml` runs both jobs, "Rust unit tests" and "Interface logic and catalogs", on every pull request and every push to `main`. `build.yml` (started by hand) builds the release for macOS (universal), Windows x64 and Linux amd64/arm64, signs the update packages and publishes `latest.json` for the updater. `engine.yml` repackages each Snapmaker Orca version and runs a **real test slice** on every platform before publishing; if one platform fails, nothing is published. `pages.yml` deploys the website.

## 6. Documentation and languages

- README in [English](../README.md) and [French](../README.fr.md), one section and screenshot per feature.
- [`CHANGELOG.md`](../CHANGELOG.md), following Keep a Changelog, with every release since 0.1.1. There is also an in-app **What's new** and a website: https://kameka22.github.io/snap-studio/
- [`DEVELOPMENT.md`](DEVELOPMENT.md) (build, release, engine, code layout), `CONTRIBUTING.md` in English and French, and `SECURITY.md`.
- [`plans/`](plans/): one design plan per feature, including a list of what remains to check on a real printer. [`mockups/`](mockups/): the mockups validated before coding.
- The interface is available in **9 languages**: English, French, German, Spanish, Brazilian Portuguese, Italian, Japanese, Simplified Chinese and Korean. That covers the menus and Orca's settings, and dates and numbers follow the language.

## 7. First launch (unsigned builds)

The README's [Download](../README.md#download) section, in more detail. The packages are on the [latest release](https://github.com/kameka22/snap-studio/releases/latest).

| System | File |
|---|---|
| macOS (Intel and Apple Silicon) | `Snap-Studio_…_macos-universal.dmg` |
| Windows | `Snap-Studio_…_x64-setup.exe` |
| Linux | `Snap-Studio_…_amd64.AppImage` (or `.deb`) |
| Linux ARM (Raspberry Pi 4/5…) | `Snap-Studio_…_arm64.AppImage` (or `.deb`), without a slicing engine for ARM yet |

The packages are not signed by Apple or Microsoft yet:
- **macOS**: drag the app to Applications, then **right-click the app → Open → Open**. Or, in Terminal: `xattr -dr com.apple.quarantine "/Applications/Snap Studio.app"`
- **Windows**: if SmartScreen shows "Windows protected your PC", click **More info → Run anyway**.
- **Linux AppImage**: `chmod +x Snap-Studio_*.AppImage`, then run it.

A welcome assistant then sets up the language, the models folder, the U1 on your network (found automatically), the slicing engine and, optionally, the AI. After that, the app updates itself.

## 8. Validated on a physical U1

> **To be completed.** Each `[TODO: …]` below is a placeholder for evidence
> from a real U1 (photo, screenshot or log). Hide network addresses, host
> names, serial numbers or QR labels and e-mail addresses before adding one.
> What still has to be checked on the machine is listed in
> [plans/README.md](plans/README.md#to-validate-on-the-real-machine).

| What | Evidence |
|---|---|
| U1 found on the network and shown live in the app (state, 4 heads, spools) | [TODO: screenshot of the printer page with the U1] |
| Multicolor model: colors mapped to heads, sliced in the app, sent, printed | [TODO: photo of the print + Prints record (real vs estimated time)] |
| Spool check catching a wrong or empty head, and the one-print remap | [Spool check on the U1](evidence/spool-check.png): the slice's orange PLA against the spools loaded now, with a head picker for this print |
| Print queue: a job waiting behind the running print, then offered once the printer is free | [Queue on the U1](evidence/queue.png) · ["Start on U1?" with the bed-clear confirmation](evidence/start-bed-clear.png) |
| Color mixing (virtual head) print | [TODO: photo] |
| One tower per material, with materials that do not bond with each other on one plate | [TODO: photo of the pillars after printing + slice screenshot] |
| Camera and timelapse played from the printer's Files | [TODO: screenshot] |
| Control, bed-mesh measurement and history | [TODO: screenshot of a measured mesh] |
| U1 firmware version used | 2.0.0 |

## 9. Development log

Since 2026-10-28, the opening of the Snapmaker Innovation Fund Phase 2. Updated with each release; full details are in the [CHANGELOG](../CHANGELOG.md).

**0.18.0, 2026-10-31** ([#85](https://github.com/kameka22/snap-studio/pull/85))
- STL and 3MF models in AI conversations: attached when creating a conversation or during one (dropped, chosen or pasted), copied into the conversation's folder, with a conversation that can start from a single model ([#83](https://github.com/kameka22/snap-studio/pull/83)).
- An integrated title bar on Windows and Linux, as on macOS, with the system's title bar still available on Linux ([#27](https://github.com/kameka22/snap-studio/pull/27)).
- Printer › Files: Ctrl/Cmd-click and Shift-click to pick several files, and right-click → Delete deleting every picked file ([#84](https://github.com/kameka22/snap-studio/pull/84)).
- A review of the Rust backend: presets made with Snapmaker Orca 2.3 slice again, long file operations moved off the UI thread, preview threads that survive a failing file, errors that keep their cause and name the file, and `rustfmt` checked in CI ([#82](https://github.com/kameka22/snap-studio/pull/82)).

**0.17.1, 2026-10-28**
- Smooth mix for virtual heads (Snapmaker Orca's Subdivide Mix Layer, on by default), a warning for colors too far apart to mix, and a slice preview that draws each line as tall as its layer ([#81](https://github.com/kameka22/snap-studio/pull/81)).

**0.17.0, 2026-10-28** ([#77](https://github.com/kameka22/snap-studio/pull/77))
- 7 new interface languages: German, Spanish, Brazilian Portuguese, Italian, Japanese, Simplified Chinese and Korean ([#72](https://github.com/kameka22/snap-studio/pull/72), [#73](https://github.com/kameka22/snap-studio/pull/73)).
- A new Prints page: list and record, real vs. estimated time, result and notes, Reprint, and history retention settings ([#65](https://github.com/kameka22/snap-studio/pull/65)).
- One shared camera across the printer page, Prints and Control ([#65](https://github.com/kameka22/snap-studio/pull/65)).
- Explore: 8 model libraries ([#76](https://github.com/kameka22/snap-studio/pull/76)).
- Consistent offline states for an unreachable printer, with no addresses in errors ([#74](https://github.com/kameka22/snap-studio/pull/74)), and a fix for the AI setup's Python detection on macOS ([#69](https://github.com/kameka22/snap-studio/pull/69)).

**Next:** the calibration assistants ([#38](https://github.com/kameka22/snap-studio/pull/38)), being checked on the U1, and complete filament management with a filament library ([#79](https://github.com/kameka22/snap-studio/pull/79), scope being defined).
