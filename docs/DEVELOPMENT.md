# Development

The technical side of Snap Studio: building, publishing, the engine, the
languages and the code layout. To report a bug or propose a change, see
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Build

```sh
cargo tauri dev                    # development
scripts/dev.sh                     # the same, from the repository's root
scripts/dev.sh --engine 2.4.1      # with another Snapmaker Orca (downloaded once on macOS)
cargo tauri build --bundles app    # local build
python3 scripts/build-icons.py     # icons (Pillow, numpy; Xcode 26+ for macOS)
```

The app icon is built from one image, the original artwork
`src-tauri/icons/source/snap-s-original.png` (1024 px, on Apple's icon grid):
`scripts/build-icons.py` derives the macOS `.icns` (Apple's grid, transparent
outside), the Windows and Linux icons (the squircle filling the canvas), the
macOS 26 Icon Composer layer (`src-tauri/icons/macos/AppIcon.icon`) and its
compiled `Assets.car` (`scripts/build-macos-icon.sh`). macOS 26 frames in a
light tile any `.icns` whose shape is off Apple's grid, so the artwork is used
as it is, never rescaled or recropped.

## Publishing a version

`scripts/release.sh` (needs the `gh` CLI), on a
clean, up-to-date `main`. It shows the current version and the one to
publish, asks for confirmation, bumps the version (`tauri.conf.json`,
`Cargo.toml`), commits "Version x.y.z", pushes, then starts
`.github/workflows/build.yml`, which builds macOS, Windows and Linux, signs
the packages and publishes the `vx.y.z` release with its `latest.json`.
`--minor` / `--major` to change level, `--version 1.2.3` for an exact version
(newer than the latest); a version not yet published (failed build) is reused
without a bump.

The release notes come from [CHANGELOG.md](../CHANGELOG.md): before the
version commit, `scripts/changelog.py release x.y.z` turns the *Unreleased*
section into `## [x.y.z] — date` (compare links included) and the commit
carries it; the workflow publishes that section (`changelog.py notes`), and
its plain-text form for the app's update sheet. With nothing under
*Unreleased*, the script warns and the notes list the commits, as before.

For a minor version, also write its **What's new** page: the version's
highlights in `site/whats-new/versions.json` (EN and FR, from the CHANGELOG;
the previous version moves to the timeline with three to five highlights),
then `python3 scripts/whats-new.py`, which copies the highlights' names to
`ui/whats-new.json` for the sidebar card. The page is published with the
site; a patch version has no entry of its own.

## Changing the engine version

`scripts/engine.sh 2.5.0` starts the
"Engine" workflow (`.github/workflows/engine.yml`): official package →
allow list (`engine/keep.txt`) → test slice → `engine-orca-2.5.0` release,
then updates `src-tauri/engine.json`. The next Snap Studio release embeds it;
`release.sh` refuses a referenced engine that cannot be found.

## Update signing

Update signing uses the key from the GitHub secrets
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; its
public key is in `tauri.conf.json`.

## Plans

Work plans in progress and ideas for later: [`docs/plans/`](plans/).

## Languages

English is the reference language; French is a complete translation, and
German, Spanish, Brazilian Portuguese, Italian, Japanese, Simplified Chinese
and Korean follow. Texts live in `ui/i18n/<lang>.json`, shared by the
interface and Rust (menus, messages). A key missing from a catalog falls back
to English. The window starts with the
English catalog and the current one; another language's catalog is fetched
when it is chosen in Settings. To add a language:

1. copy `ui/i18n/en.json` to `ui/i18n/<code>.json` and translate it (keep the
   `{placeholders}`, the HTML tags and the plural forms);
2. add one entry to `LANGS` in `src-tauri/src/i18n.rs` (code, name in its own
   language and in English, BCP 47 locale for dates and numbers, plural rule:
   `One`, `ZeroOne` or `Never`, catalog): the only list to keep; the interface reads
   it, `from_locale` maps the system language to it, the AI is told to reply
   in that language;
3. add it to `LANGS` in `scripts/gen-orca-settings.py` and run the script
   again (Orca's tabs, from OrcaSlicer's `.po` files; `PO_DIRS` when Orca's
   folder has another name, like `zh_CN`), then to
   `CFBundleLocalizations` in `src-tauri/Info.plist` with a
   `src-tauri/locales/<code>.lproj` listed in `tauri.conf.json`;
4. `python3 scripts/check-i18n.py` reports missing or unused keys, broken
   placeholders or tags, each catalog's completeness and text left
   hard-coded; a key missing from a language other than English and French
   is a warning (`--strict`: an error).

To add or change keys, `scripts/i18n_add.py` edits the catalogs in place
(see its header): only the entries written change.

## Layout

```
ui/               HTML/CSS/JS interface, one file per view (no build step)
  i18n/           interface texts, one file per language (en, fr, de, es, pt-BR, it, ja, zh-Hans, ko)
  speed.js spoolcheck.js pfiles-logic.js ia-list.js ia-trace.js scheme.js
                  pure logic (Speed adjustment, spool check, printer files,
                  AI list, terminal view, protocol URLs), tested by
                  scripts/test-*.js
  prepare-tower.js tower-logic.js   Prepare's prime tower: switch, box,
                  placement, size estimate (tower-logic.js, tested by
                  scripts/test-tower.js)
  virtual.js virtual-logic.js   virtual heads (two spools mixed layer by
                  layer): Heads and spools section, creation sheet, the rules
                  (virtual-logic.js, tested by scripts/test-virtual.js)
  attach-logic.js   files attached to an AI message: kinds, limits, where a
                  drop goes, paths of a paste (tested by scripts/test-attach.js)
  i18n.js         translation, number and date formats, language switching
  window-controls.js   window buttons on Windows and Linux (minimize,
                  maximize/restore, close) in the 52 px title band
  whatsnew.js whatsnew-logic.js   What's new: sidebar card, the site's page
                  in a sheet; whats-new.json, its highlights (scripts/whats-new.py)
  assets/orca-settings.<lang>.json   Orca's tabs and labels
                  (generated by scripts/gen-orca-settings.py)
  assets/bed/     U1 plate and logo (Snapmaker Orca profiles, AGPL-3.0)
src-tauri/src/
  lib.rs          Tauri commands, mesh:// gcode:// thumb:// cam:// prn:// protocols
  plate.rs        plate, scene to slice        orient.rs     auto-orientation
  slice.rs        background slicing           presets.rs    Orca presets
  mixcolor.rs     virtual heads' preview color (Orca's MIT pigment mixer)
  printers.rs     Moonraker: status, sending   watch.rs      live WebSocket
  model3mf.rs     3MF reading                  write3mf.rs   3MF writing
  mesh.rs stl.rs  geometry                     gcode.rs      G-code parsing
  paint.rs        painted 3MF (per-triangle colors)
  gcode_thumbs.rs the print's pictures for the printer's screen, in the G-code
  render.rs       software 3D thumbnails       thumbs.rs     thumbnail cache
  library.rs      Explore: sites, tabs (native views), floating navigation, favicons
  favorites.rs    favorites
  ia.rs pty.rs    AI conversations, terminal   slicers.rs    installed slicers
  ia_tools/       what Claude gets in each workspace: mf.py (3MF), export.py,
                  measure.py, the export-3mf skill
  chat.rs         AI chat view: Claude Code in stream-json mode, log, attachments
  ia_attach.rs    files attached to an AI message: checks (type, size, mesh),
                  STL/3MF models copied into the workspace's sources/ as 3MF
  auth.rs         Claude sign-in: sandbox token (Keychain), checks, sign-in terminal
  setup.rs        what the AI needs, per mode (Claude Code, engines, Python)
  menu.rs         native menus                 migrate.rs    3MF Studio carry-over
  update.rs       updates (GitHub, signature, installation)
  discover.rs     printer discovery on the network (mDNS)
  jobs.rs         prints: queue, history, background tracking (and the
                  extruder map back to identity after a substituted print)
  printer_files.rs a printer's print files and timelapses (Moonraker), video
                  pieces for prn://, deletion through the U1 camera service
  share.rs        sharing a printer's file: share menu (macOS), clipboard,
                  QR code served on the local network, Save As
  maintenance.rs  printer counters (heads, hours) and maintenance log
  engine.rs       bundled slicing engine: download, verification
  access.rs       first access to macOS protected folders (one prompt)
  i18n.rs         interface language, catalogs shared with ui/i18n
  titlebar.rs     undecorated window on Windows and Linux: button layout
                  (GTK), edge resizing, rounded corners, system title bar
                  switch (tauri.windows.conf.json, tauri.linux.conf.json)
  scan.rs util.rs folder scanning, small shared helpers
```

Snap Studio used to be called 3MF Studio: its data (settings, printers,
favorites, conversations) is carried over on first launch.

## Tests

```sh
cd src-tauri && cargo fmt --check && cargo test --lib   # formatting: rustfmt.toml
for t in scripts/test-*.js; do node "$t"; done   # interface logic
python3 scripts/check-i18n.py                    # missing or unused texts
```

`cargo test --lib presets -- --ignored` also checks that every preset of
your own Snapmaker Orca still resolves (a parent renamed by an Orca update
shows there). Some tests are opt-in (`--ignored`) because they need real tools: the
slicing engine, Claude Code (`CHAT_REAL=1`, `AUTH_REAL=1`, `IA_REAL=1`), a
Python with trimesh (`SS_PYTHON=…`), a 3MF of your own (`IA_3MF=…`). Each
says how to run it in its comment.
