# Dev: printer simulator and full simulation mode

Plan only: nothing is implemented. Written against `main` at `26add37`
(0.18.0); line numbers are those of that commit. The numbered questions at
the end wait for kameka22's decisions, and the implementation waits for a go.

## Why

Every printer feature of Snap Studio (Printers, Prints and queue, printer
Files and timelapses, Control, Bed leveling, Maintenance, spool check,
camera) needs a real Snapmaker U1 on the network to be tried. That means:

- a feature can only be checked by whoever has the machine, when the
  machine is free (not printing, not in use for something else);
- states that are hard or costly to reach on a real U1 (a filament runout,
  a Klipper shutdown, an upload that fails halfway, four heads with four
  different spools, three printers at once) are almost never tried;
- the Rust tests that touch the network each build their own small fake
  (`printer_files.rs:1129` `fake_moonraker_with`, `watch.rs:295`
  `live_session_against_fake_moonraker`), and the end-to-end flows (send →
  print → end → next in queue) are not tested at all;
- every screenshot of a printer screen shows real names, addresses and
  serials that then have to be blurred.

The goal: in a development build, simulate one or several printers and use
the whole app against them, a **full simulation mode**.

## Goals

- In a **development build only**, start the app with one or several
  **simulated printers** (Snapmaker U1, optionally a plain Klipper machine),
  each with its own name, state, heads, spools, files, history and bed mesh.
- Use **every printer feature** of the app against them, through the very
  code paths used with a real U1: add a printer (network search or address),
  status and live feed, send and queue, pause / resume / cancel, end of print
  and "next in queue", printer Files (list, metadata, download, rename,
  delete, print, timelapses), Control, Bed leveling, Maintenance, spool check,
  camera.
- A simulated print **follows the G-code the app sliced**: duration, layers,
  tool changes and filament come from the file, with a **time acceleration**
  factor so a 2 h print can end in 2 min.
- **Fault injection**: disconnection, Klipper error, filament runout, upload
  failure, refused start, slow or late answers, camera failure.
- A **SIMULATED** badge wherever a simulated printer shows, and a full
  simulation mode that never mixes with the user's real printers or data.
- The same simulator **in the Rust tests and the CI**, for end-to-end tests
  of the printer flows.
- Screenshots of printer screens with **made-up names**, nothing to blur.

## Non-goals

- Shipping the simulator, or any switch for it, in release builds.
- Simulating the slicing engine: slicing stays real (local Snapmaker Orca).
- A physically exact machine: temperatures, timings and motion are plausible,
  not measured. The simulator does not replace the checks listed under
  *To validate on the real machine* in the [plans index](README.md).
- Simulating Snapmaker's cloud, the U1's touch screen, or its firmware
  update.
- Announcing simulated printers on the local network (mDNS): they stay on
  this computer (see *Discovery*).
- OctoPrint printers (the app only probes them, `printers.rs:769`).

## How the app talks to printers today (what we simulate)

All printer traffic goes through the Rust backend; the interface never
reaches a printer itself (the CSP `connect-src` only allows the app's own
schemes, `tauri.conf.json`; the camera and printer files come through the
`cam:` and `prn:` schemes, `lib.rs:1875-1894`). Every request is built from a
saved printer's **host and port** (`printers.rs:120` `authority`, `:138`
`base`, `:142` `ws_url`): there is no transport abstraction, but there is
**one address rule**, so a printer at `127.0.0.1:<port>` is reached like any
other.

| Area | Code | What goes over the wire |
|---|---|---|
| Saved printers | `printers.rs:14-43` | `printers.json` in the config folder: id, name, host, port, model, note. No pairing, no token: Moonraker on the U1 needs **no authentication**. |
| Discovery | `discover.rs` | mDNS `_snapmaker._tcp` (TXT: `sn`, `device_name`, `machine_type`, `version`, `ip`) and `_moonraker._tcp`, 20 s, results as `printer-found` events. |
| Add by address | `printers.rs:734` `probe` | `GET /printer/info`, then port 7125 ↔ 80, then `GET /api/version` (OctoPrint). |
| Status (polling) | `printers.rs:618` `status` | `GET /server/info`, `/printer/info`, `/printer/objects/query?print_task_config&print_stats&display_status&virtual_sdcard&extruder…extruder3&heater_bed&toolhead&gcode_move&fan`. |
| Live feed | `watch.rs` | WebSocket `/websocket`, JSON-RPC: `server.connection.identify`, `printer.objects.list`, `printer.info`, `printer.objects.subscribe`, then `notify_status_update`; reconnects with backoff (`watch.rs:73`). |
| Spools (RFID) | `printers.rs:1067` `apply_filaments` | U1-only Klipper object `print_task_config`: `filament_type`, `filament_sub_type`, `filament_vendor`, `filament_exist`, `filament_color_rgba` / `filament_color`, `extruders_used`, `filament_official`. |
| Send a print | `lib.rs:966` `print_send`, `printers.rs:461` `upload`, `:377` `start_print` | `POST /server/files/upload` (multipart, streamed); start through WebSocket `server.files.start_local_print` (Snapmaker's, with options and head map), or the legacy route: `printer.gcode.script` `SET_PRINT_PREFERENCES` then `POST /printer/print/start`. Head substitution: `SET_PRINT_USED_EXTRUDERS` and map scripts (`printers.rs:216-300`). |
| Print actions | `printers.rs:425` | `POST /printer/print/pause|resume|cancel`. |
| G-code scripts | `printers.rs:313-375` | `POST /printer/gcode/script`, or over the WebSocket reading `notify_gcode_response` to spot "Unknown command" (`:336` `unknown_commands`). |
| Queue, history, notifications | `jobs.rs` | Local `jobs/` store; a monitor polls each printer every 8 s (`jobs.rs:29`), closes finished jobs (90 s grace after a launch, `:32`), asks the UI to start the next one (`queue-next`), OS notification (`:700`). |
| Printer files, timelapses | `printer_files.rs` | `/server/files/roots`, `list?root=gcodes|camera`, `metadata`, `directory`, `/server/history/list`, `GET/DELETE /server/files/<root>/<path>` with Range, `POST /server/files/move`, WebSocket `camera.get_timelapse_instance` / `camera.delete_timelapse_instance`. |
| Camera | `printers.rs:592-616`, `lib.rs:1156` | WebSocket `camera.start_monitor` / `stop_monitor`, then `GET /server/files/camera/monitor.jpg` polled through `cam:`. |
| Control | `control.rs` | `printer/objects/query` with `machine_state_manager`, `toolhead`, `filament_feed`, `filament_motion_sensor`, `fan_generic cavity_fan`, `led cavity_led`, `purifier`, `configfile=settings`; `config/snapmaker/filament_parameters.json`; U1 macros (`T<n> A0`, `AUTO_FEEDING`, `CONTROL_EXTRUDE_ACTION`…); `emergency_stop`, `firmware_restart`. |
| Bed leveling | `bedmesh.rs` | `bed_mesh` (with the U1's `progress`: points, probe state, preheat countdown), `AUTO_BED_MESH_CALIBRATE TEMP=`, `bed_mesh/abort_probe_mesh`; mesh history stored locally (`bedmesh.rs:310`). |
| Maintenance | `maintenance.rs:86` | `extruder*` counters (`switch_count`, `last_maintenance_count`, `retry_count`, `error_count`), `purifier`, `/server/history/totals`; log stored locally (`:110`). |
| Share | `share.rs` | Fetches the file through the printer files code; the QR code serves it on the interface that reaches the printer (`share.rs:227` `local_ip`). |

**Dev mode today.** There is no dev mode as such: no flag, no setting, no
Cargo feature. The only switch is `cfg!(debug_assertions)`, i.e. a
`cargo tauri dev` build: the update check refuses to run there
(`update.rs:82`) and the Windows console stays (`main.rs:2`).

## Architecture options

### A. In-process fake transport behind a trait

Put a `PrinterTransport` trait between the features and the network
(`get_json`, `post_path`, `ws_session`, `upload`, the live feed…), with a
real implementation and a fake one.

- **Fidelity: low to medium.** The fake answers Rust calls, not Moonraker:
  URL building, JSON parsing, the WebSocket handshake, multipart streaming,
  Range requests, timeouts and reconnection, i.e. most of the real bugs, are
  bypassed.
- **Effort: high and invasive.** About 40 call sites in `printers.rs`,
  `watch.rs`, `printer_files.rs`, `control.rs`, `bedmesh.rs`,
  `maintenance.rs`, `lib.rs` (`cam:`/`prn:`), `share.rs` would move behind the
  trait, in code that works today.
- **Tests/CI:** reusable in Rust tests, but tests what the trait sees, not
  what goes over the wire.

### B. Fake Moonraker server (local HTTP + WebSocket)

A small server that speaks the U1's Moonraker API (the subset above) on
`127.0.0.1:<port>`, one per simulated printer, with a simulated machine
behind it (clock, heaters, heads, spools, files, print runner, mesh). The
app's printers are simply saved at `127.0.0.1:<port>`.

- **Fidelity: high.** The app's real code runs unchanged, wire included; the
  same fixtures can be checked against real U1 answers. Disconnecting,
  slowing down or failing is done at the socket, where it really happens.
- **Effort: medium.** The simulator is new code, but the app barely changes
  (data folder, discovery, badge, Developer panel).
- **Tests/CI:** the strongest: the existing `printers::status`,
  `watch::session_with`, `printer_files::overview`, `control::run`… are
  tested end to end against it; the two ad hoc fakes can go.
- Also works with other clients (Fluidd/Mainsail on the simulator, `curl`),
  handy to debug.

### C. Interface-level mocks

Answer `invoke("printer_status")` & co. with canned data in the JavaScript.

- **Fidelity: very low.** Nothing of the backend runs: no queue monitor, no
  live feed, no upload, no `cam:`/`prn:`.
- **Effort: low at first, then high**: ~45 printer commands and their events
  (`printer-status`, `prints-status`, `queue-next`, `send-progress`…) to
  imitate, and they drift from the backend.
- **Tests/CI:** only helps the `scripts/test-*.js` logic tests, which already
  test pure functions.

### Recommendation: B, run inside the dev app and as a standalone tool

| | A | B | C |
|---|---|---|---|
| Fidelity | medium | **high** | very low |
| Changes to working code | many | **few** | few (UI only) |
| End-to-end Rust tests / CI | partial | **yes** | no |
| Effort | high | medium | low → high |

B is the only option that exercises what breaks in practice (the wire, the
timing, the U1's own methods) without touching the printer code that works.
To make it as easy to use as A:

- **Inside the app**: in a dev build with the simulator compiled in (Cargo
  feature `sim`, decision 2), the app starts the simulated printers itself at
  launch, on random local ports, before the printer list is read. Nothing to
  run beside `cargo tauri dev`.
- **Standalone**: the same code as a small binary (`u1-sim`), for the tests,
  the CI, or to point another client at it.

The simulator lives in `src-tauri/src/sim/`, compiled only with the `sim`
feature, and reuses the app's own G-code reader (`gcode.rs` `SliceStats`) to
run prints. The HTTP side needs a small server: `axum` as an optional
dependency of the `sim` feature (decision 5); the WebSocket side reuses
`tokio-tungstenite`, already a dependency (`handshake` feature on).

## Full simulation mode

### Turning it on (dev builds only)

- Built with `cargo tauri dev --features sim` and started with
  `SNAP_SIM=<scenario>` (a name from `src-tauri/sim/scenarios/`, or a path
  to a scenario file). Without `SNAP_SIM`, a `sim` build behaves exactly
  like today.
- A release build cannot contain it: the release workflow does not pass the
  feature, and `sim/mod.rs` fails to compile with
  `#[cfg(all(feature = "sim", not(debug_assertions)))] compile_error!(…)`.
  The CI's release job also checks the binary carries no `SIMULATED` string.
- Later (phase 4): a **Developer** section in Settings, shown only when the
  backend reports the simulator (`sim_status` command present), to add or
  remove simulated printers, change the time factor and inject faults.

### Separate data

In full simulation mode the app works in its own data folder,
a `sim/` subfolder of the app's data folder (decision 4), for everything tied to a
printer: `printers.json` (`printers.rs:27`), `jobs/` (`jobs.rs:124`), the
bed mesh history (`bedmesh.rs:310`) and the maintenance log
(`maintenance.rs:110`). The user's real printers are not shown and their
queue, history and logs are never written. Settings, profiles, the engine,
the library and AI conversations stay shared (they do not depend on a
printer). This needs one helper, `util::app_dir()`, used by those four
places; outside simulation it returns the same folder as today.

At each launch the simulator writes the scenario's printers into the
simulation `printers.json` with **stable ids** and the ports of this run, so
the history, meshes and logs kept per printer id follow the same simulated
printer from one run to the next. `SNAP_SIM_RESET=1` (and a button in the
Developer section) empties the simulation folder.

### Discovery

In full simulation mode, `printer_discover_start` (`discover.rs:56`) does
not start mDNS: it emits the scenario's printers as `printer-found`
(`service: "snapmaker"`, `ip: 127.0.0.1`, their port, a fake serial), so the
"On the network" flow of the add sheet and the welcome assistant can be
tried. The simulator never announces itself on the local network: a
simulated U1 must not appear in a real Snapmaker Orca on the same Wi-Fi.
Adding by address (`127.0.0.1:<port>`) goes through the real `probe`.

### The SIMULATED badge

- Title bar: a **SIMULATION** pill next to the window controls for the whole
  session, and the window title ends with "— Simulation".
- Every printer card, the printer's title bar entry, the send sheet's
  printer picker and the queue: a small **SIMULATED** badge.
- The camera image itself carries the word (see *Camera*), so a screenshot
  cannot pass for a real machine.
- OS notifications from the queue monitor start with "[SIM]".

The backend tells the interface which printers are simulated
(`sim_status`: on/off, printer ids, time factor), the interface never guesses
from the address.

## What the simulation covers, feature by feature

Each simulated printer is a machine model behind the fake Moonraker: a
**simulated clock** (real time × factor), first-order **heaters** (four
nozzles, bed, chamber) that move toward their target, a **toolhead**
(position, homed axes, active head), **four heads** with their **spools**,
**virtual roots** `gcodes`, `camera`, `config` in its own folder, a
**history**, **counters** and a **bed mesh**.

| Feature | Covered | How |
|---|---|---|
| Status, live feed | yes | `server/info`, `printer/info`, `objects/query` and `objects/subscribe` with `notify_status_update` pushed on change (at most every 250 ms, like Moonraker). Only the objects the scenario's model has (a plain Klipper has no `print_task_config`). |
| Temperatures | yes | `M104`/`M109`/`M140`/`M190` (with `T<n>` and the U1's `A0`) set targets; heaters ramp at a plausible rate scaled by the clock. |
| Heads / tools | yes | `T<n> A0` and the G-code's tool changes switch `toolhead.extruder`, increment `switch_count`; a scenario can make a head fail to pick (`error_count`, `retry_count`). |
| Spools | yes | `print_task_config` from the scenario: type, sub-type, vendor, colour, present, official (RFID) or not; changed by `SET_PRINT_FILAMENT_CONFIG` (Control) and the Developer panel ("swap the spool on head 2") to trigger the spool check. |
| Send, start | yes | Multipart upload into `gcodes/`; `server.files.start_local_print` with options and head map, `SET_PRINT_USED_EXTRUDERS`, `extruder_map_table`; legacy route for a scenario "firmware without start_local_print". The start options (leveling, flow calibration, timelapse) show in `print_task_config`. |
| Print progress | yes | See *A simulated print* below: `print_stats` (state, filename, `print_duration`, `filament_used`, `info.current_layer/total_layer`), `display_status.progress`, `virtual_sdcard`. |
| Pause / resume / cancel | yes | Through `printer/print/*`; the clock stops while paused. |
| End of print, queue | yes | `complete` then back to `standby`; the app's monitor closes the job, notifies and offers the next one, untouched. |
| History | yes | `server/history/list` and `totals` filled by simulated prints (and seeded by the scenario). |
| Printer files | yes | `roots`, `list`, `metadata` (from `gcode.rs`: estimated time, layers, filament per tool, thumbnails read from the G-code), `directory` (disk usage from a scenario quota), download with Range, `move` (rename), `DELETE`, print a file. |
| Timelapses | yes | A print with the timelapse option leaves a small MP4 in `camera/` (one fixture video, like `printer_files.rs:1110` `fake_mp4`, plus its picture); `camera.get_timelapse_instance` / `delete_timelapse_instance`. |
| Camera | placeholder | `camera.start_monitor` / `stop_monitor` honoured (the image stops ~10 s after the last start, like the U1); `monitor.jpg` is a generated JPEG (the `image` crate, already a dependency): printer name, state, layer, progress bar, time, and **SIMULATED** across it. Rendering the current layer of the toolpath: later (decision 7). |
| Control | yes | A small interpreter for the commands `control.rs` sends: `G28`, `G90/G91`, `G0/G1` within the scenario's limits, `T<n> A0`, `M104/M140/M106/M107`, `AUTO_FEEDING`, `INNER_FILAMENT_UNLOAD`, `CONTROL_EXTRUDE_ACTION`/`RETRACT`, `ROUGHLY_CLEAN_NOZZLE`, `cavity_fan`, `cavity_led`, `SET_PURIFIER`, `M84`, `SET_PRINT_FILAMENT_CONFIG`. Anything else answers `!! Unknown command:"X"` on `notify_gcode_response`, exactly what `unknown_commands` reads. `configfile.settings` and `filament_parameters.json` come from fixtures shaped like the U1's. |
| Bed leveling | yes | `AUTO_BED_MESH_CALIBRATE TEMP=` runs the U1 sequence: `preheating` with its countdown (2 min, scaled), `prescanning`, `probing` point by point, then a new `bed_mesh` (a seeded surface: tilt, bowl, noise, so meshes differ between runs and printers); `abort_probe_mesh`, `emergency_stop`, `firmware_restart` honoured. |
| Maintenance | yes | Counters move with the simulated prints and tool changes; history totals. |
| Share | yes, with a note | Fetch works; the QR code: with a printer at `127.0.0.1`, `share.rs:227` would pick the loopback, which a phone cannot reach. In simulation it uses the default route's interface instead. |
| Firmware info | yes | `printer/info` (`software_version`, `hostname` from the scenario), discovery TXT `version`. |
| Errors | yes | See *Fault injection*. |

### A simulated print

The app always uploads G-code (sliced locally by the real engine, or a
printer file). When a print starts, the simulator reads the file with the
app's own reader (`gcode.rs`, `SliceStats`): total time
(`print_time_s`), elapsed time at the end of each layer (`layer_end_s`),
tools used, filament per tool, and the tool changes in order. Then:

- the simulated elapsed time drives `print_duration`, the current layer
  (from `layer_end_s`), `display_status.progress`, `filament_used`, and the
  active head and its temperature at each tool change;
- the first minutes follow the start options: leveling and flow
  calibration add their (scaled) time before layer 1, heaters warm up first;
- a G-code without times (another slicer) falls back to the
  `estimated_only` times `gcode.rs` already computes;
- a file too short or empty fails like the U1 does (error state with a
  message).

**Time factor**: ×1, ×10, ×60, ×600 (scenario, `SNAP_SIM_SPEED`, Developer
panel). The app's queue monitor works in real time (8 s polling, 90 s grace
after a launch, `jobs.rs:29-32`), so a simulated print is never shorter than
**2 min of real time**, whatever the factor: otherwise the monitor would not
see it end. The Prints page's real-time records (started, ended) then differ
from the printer's `print_duration` (simulated time): expected in
simulation, and visible thanks to the badge.

### Several printers

A scenario lists any number of printers, each with its own port, name,
model, state at launch, spools, files, history, mesh seed and faults. They
run independently (each its own clock and task). Example scenarios:

- `solo`: one U1, idle, four PLA spools of different colours.
- `farm`: three U1 (one idle, one printing at 40 %, one paused on a runout)
  and one plain Klipper machine.
- `trouble`: a U1 that drops the connection every few minutes, one whose
  uploads fail halfway, one with Klipper in shutdown.

### Fault injection

Set in the scenario (at launch or on a timer), from the Developer panel, or
with the standalone tool (`u1-sim fault <printer> <fault>`), through a
`/sim/…` control path on each simulated printer (not a Moonraker path, so no
real client uses it):

| Fault | Effect on the wire | What it exercises in the app |
|---|---|---|
| `disconnect` (for N s) | WebSocket closed, new connections refused | live feed backoff (`watch.rs:73`), offline cards, monitor |
| `unreachable` | port closed | probe errors, offline, send refused |
| `slow` (latency) | every answer delayed | timeouts (4 s HTTP), late start answer path (`printers.rs:396`) |
| `klippy_shutdown` / `klippy_error` | `printer/info` state `shutdown`/`error` with a message | error state, message, Control's firmware restart |
| `runout` (head n) | print paused, `print_stats.message`, `filament_motion_sensor` empty | paused job, message, resume after reload |
| `upload_fail` (at x %) | upload connection cut, or HTTP 507 with a Moonraker error body | send error message (`err.upload_refused`) |
| `start_refused` | `start_local_print` answers `state: error` with a message (busy, nozzle mismatch) | refused start, no legacy retry |
| `no_start_local_print` | method unknown | legacy route (`SET_PRINT_PREFERENCES` + `print/start`) |
| `camera_off` | `start_monitor` fails, no `monitor.jpg` | camera error |
| `head_pick_fail` | tool change error, `error_count`++ | maintenance counters, error state |
| `print_error` | print ends in `error` | failed job, notification |
| `disk_full` | `directory` reports little space, upload refused | printer files disk bar, send error |

## Data, fixtures and privacy

- Names like "Sim U1 Alpha", "Sim U1 Bravo", "Sim Klipper"; hostnames
  `sim-alpha`…; serials `SIM-0000-0001`…; addresses `127.0.0.1` only. No real
  name, address, serial, hostname or username in the fixtures, the
  scenarios, the tests or the generated images.
- Object shapes come from what the code already reads and the samples
  already in the tests (`printers.rs` `SAMPLE`, the `printer_files.rs`
  fake), and from Snapmaker's public sources (u1-klipper's `lava/` config,
  Snapmaker's Moonraker components). No capture of a real machine is
  committed (decision 9).
- Materials in fixtures are ordinary type names (they are data, not
  interface copy); the interface copy about the simulator stays generic.
- The simulator binds to `127.0.0.1` only, never to `0.0.0.0`.

## Impact on the code, file by file

| File | Change |
|---|---|
| `src-tauri/Cargo.toml` | Feature `sim = ["dep:axum"]` (and `tokio` `net`); `default-run = "snap-studio"`; `[[bin]] u1-sim` with `required-features = ["sim"]`. |
| `src-tauri/src/sim/` (new) | `mod.rs` (start/stop, `compile_error!` guard), `scenario.rs`, `server.rs` (HTTP routes + `/websocket` JSON-RPC + `/sim/` control), `machine.rs` (clock, heaters, toolhead, heads, spools), `print.rs` (runner from `SliceStats`), `script.rs` (G-code/macro interpreter), `files.rs` (virtual roots, metadata, Range, timelapses), `camera.rs` (generated JPEG), `mesh.rs` (seeded meshes, U1 probing sequence), `faults.rs`. |
| `src-tauri/src/bin/u1-sim.rs` (new) | Standalone: `u1-sim <scenario>` prints the ports; `u1-sim fault …`. |
| `src-tauri/sim/scenarios/*.json`, `src-tauri/sim/fixtures/` (new) | `solo`, `farm`, `trouble`; U1 `configfile.settings`, `filament_parameters.json`, a fixture MP4, sample G-code. |
| `src-tauri/src/util.rs` | `app_dir()`: the data folder, `sim/` under it in full simulation. |
| `printers.rs:27`, `jobs.rs:124`, `bedmesh.rs:310`, `maintenance.rs:110` | Use `app_dir()` (same folder as today outside simulation). |
| `src-tauri/src/lib.rs` | At setup, under `#[cfg(feature = "sim")]`: start the scenario, write the simulation `printers.json`; commands `sim_status`, `sim_fault`, `sim_speed`, `sim_reset`, `sim_spool` (registered only with the feature). |
| `src-tauri/src/discover.rs` | In simulation, emit the scenario's printers instead of starting mDNS. |
| `src-tauri/src/share.rs` | QR code: loopback target → default route interface (simulation only). |
| `src-tauri/src/jobs.rs` | "[SIM]" prefix on notifications in simulation. Nothing else. |
| `printers.rs`, `watch.rs`, `printer_files.rs`, `control.rs`, `bedmesh.rs`, `maintenance.rs` (network code) | **No change.** |
| `ui/index.html`, `ui/style.css`, `ui/app.js` | SIMULATION pill in the title bar, window title. |
| `ui/printers.js`, `ui/prints.js`, `ui/slice.js` (send sheet) | SIMULATED badge per printer from `sim_status`. |
| `ui/settings.js` | Developer section (phase 4), shown only when `sim_status` exists. |
| `ui/i18n/en.json`, `fr.json` | `sim.*` keys (the other languages fall back to English; decision 10). |
| `.github/workflows` (tests) | A `cargo test --lib --features sim` step; release job: guard that the binary has no simulator. |
| `docs/DEVELOPMENT.md` | "Simulated printers" section: how to run, scenarios, faults, screenshots. |
| `docs/technical-overview.md` | One paragraph on the simulator. |

No CHANGELOG line: nothing changes for users of the released app.

## Tests

- **Rust, end to end** (`cargo test --lib --features sim`): start a
  simulator on a random port with a virtual clock the test advances by hand
  (no sleeps, deterministic), then call the real functions:
  `printers::probe`/`status`, `watch::session_with` (feed, merge,
  reconnect after `disconnect`), `printers::upload` + `start_print` (both
  routes, `start_refused`, `upload_fail`), `jobs` monitor closing a job and
  offering the next one, `printer_files::overview`/`delete_video`/`rename`,
  `control::run` (accepted and refused actions, unknown command),
  `bedmesh` measurement and abort, `maintenance::usage`.
- The two ad hoc fakes (`printer_files.rs:1129`, `watch.rs:295`) move to the
  simulator once it covers them (decision 11).
- **Simulator's own tests**: heater ramps, print runner against a sample
  G-code (layers, tool changes, duration at ×1 and ×600), scenario loading,
  each fault.
- **CI**: the Tests workflow gets the `--features sim` step (Linux, already
  set up for the Rust tests); the default `cargo test --lib` still runs
  without the feature.
- **Interface**: the `scripts/test-*.js` logic tests are unchanged; the
  badge's pure logic (if any) gets a test. Screenshots for printer-related
  PRs are taken against the `farm` scenario.
- **Guard**: a test that a non-`sim` build exposes no `sim_*` command, and
  the release-binary string check.

## Risks

- **Drift from the real firmware.** The simulator may accept what a U1
  refuses (or answer differently after a firmware update). Mitigation:
  shapes taken from real samples and Snapmaker's sources, the simulator
  stays a development aid, and the *To validate on the real machine* list
  stays the rule before a release.
- **False confidence in timings.** Accelerated time hides real-time
  behaviours (the 90 s grace, the camera's 10 s auto-off, the 2 min
  preheat). Mitigation: ×1 by default, the 2 min floor, scenarios at ×1 for
  timing work.
- **Mixing simulated and real data.** Mitigated by the separate data folder
  and stable simulated ids; real printers are never listed in simulation.
- **Shipping it by accident.** Feature off by default, `compile_error!`
  guard, release workflow check.
- **Dependency weight.** `axum` only in `sim` builds; release builds and
  their size are unchanged.
- **Ports.** Random free ports each run; the stable ids keep the per-printer
  data.
- **Maintenance cost.** Every new printer feature will need its simulator
  side. Mitigation: the plan's checklist adds "simulator updated if the
  printer API used changes" to printer PRs (decision 12).

## Implementation plan

| Phase | Content | Rough effort |
|---|---|---|
| 1. Skeleton | `sim` feature and guard, `app_dir()`, scenario loader, fake Moonraker for status (`server/info`, `printer/info`, `objects/query`, WebSocket subscribe), idle U1 with spools, several printers, simulated discovery, SIMULATED badge and pill, `sim_status`. The app runs on the `solo` and `farm` scenarios (idle). | 2–3 days |
| 2. Printing | Files roots (list, metadata, upload, download with Range, move, delete), print runner from `SliceStats` with time factor, `start_local_print` and legacy route, pause / resume / cancel, history, queue end to end, notifications, tool changes and counters, spool changes and the spool check. | 3–4 days |
| 3. Machine | Script interpreter for Control, `configfile` and materials fixtures, bed mesh measurement with the U1 sequence, camera image, timelapses, share QR in simulation. | 2–3 days |
| 4. Faults and panel | Fault injection (scenario, `/sim/` control, `u1-sim` binary), Developer section in Settings (printers, time factor, faults, spools, reset). | 2 days |
| 5. Tests and docs | End-to-end Rust tests, CI step and release guard, migrate the two ad hoc fakes, `DEVELOPMENT.md` and technical overview. | 1–2 days |

About 10 to 14 days in all; each phase is usable on its own (phase 1 already
gives screenshots without a printer).

## Decisions for kameka22

1. **Architecture.** B (fake Moonraker on `127.0.0.1`, run inside the dev
   app and as a standalone tool), A (fake transport behind a trait) or C
   (interface mocks)? *Recommended: B.*
2. **How to turn it on.** Cargo feature `sim` plus `SNAP_SIM=<scenario>` in
   a dev build, or always compiled into dev builds with a Settings switch?
   *Recommended: feature + variable now, the Developer section in phase 4.*
3. **Full or mixed.** Simulated printers only (real ones hidden, separate
   data), or simulated next to real ones? *Recommended: full simulation
   only; mixed can come later if needed.*
4. **Simulation data.** Kept between runs in `sim/` (with a reset), or fresh
   at each launch? *Recommended: kept, with `SNAP_SIM_RESET=1` and a reset
   button.*
5. **HTTP server.** `axum` as an optional dependency of `sim`, or a
   hand-written HTTP server like the test fakes? *Recommended: `axum`
   (multipart, Range and WebSocket upgrade done right), only in `sim`
   builds.*
6. **Time factor.** Default and choices? *Recommended: ×1 by default; ×10,
   ×60, ×600 available; never under 2 min of real time per print.*
7. **Camera.** Generated placeholder image, or a render of the current layer
   of the toolpath? *Recommended: placeholder now (name, state, layer,
   SIMULATED), toolpath render later.*
8. **Plain Klipper machine.** Simulate a non-U1 Klipper printer too (no
   spools, standard commands)? *Recommended: yes, one profile; cheap and it
   covers the "other Klipper" branches.*
9. **Record and replay a real U1.** A tool to capture a real machine's
   answers into fixtures? *Recommended: not now (private data to scrub);
   fixtures written by hand from public sources and the existing samples.*
10. **Developer strings.** Translated in English and French only (the other
    languages fall back to English)? *Recommended: yes.*
11. **Existing test fakes.** Replace the ad hoc fakes of `printer_files.rs`
    and `watch.rs` with the simulator? *Recommended: yes, in phase 5, once
    it covers them.*
12. **Keeping it up to date.** Add "simulator updated if the printer API
    used changes" to the pull request template? *Recommended: yes, with
    phase 5.*
