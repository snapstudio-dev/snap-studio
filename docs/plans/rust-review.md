# Rust review of `src-tauri/`: findings and fixes

A review of the Rust side (0.17.1) against the Rust API Guidelines, Effective
Rust, Microsoft's Pragmatic Rust Guidelines and the Google Rust Style Guide.
The crate is an application, so it was held to the simplicity rules
(`anyhow`, concrete types) rather than the strict public-API rules.

State at review time (macOS, stable toolchain):

- `cargo test --lib`: 252 passed, **6 failed**, 24 ignored.
- `cargo clippy --all-targets -- -W clippy::pedantic`: 1,821 warnings,
  ~1,000 of them `unreadable_literal` (noise). Default clippy: ~30, all minor.
- `cargo fmt --check`: 948 hunks differ, no `rustfmt.toml`.

## Must fix

### 1. Orca 2.4 renamed system presets; `renamed_from` is ignored (`presets.rs:214`)

Snapmaker Orca 2.4.0 renamed `0.08 Extra Fine @Snapmaker U1 (0.4 nozzle)` to
`0.08mm Standard @Snapmaker U1 (0.4 nozzle)` and records the old names in
`"renamed_from"` (several, separated by `;`). A user preset made with 2.3.x
(`… - Support`, `… - Full support`) still `inherits` the old name, so
`flatten_inner` finds no parent and slicing fails with "unresolvable
inheritance". This is what the 6 failing `presets::*` / `slice::*` tests hit
on a machine with such user presets — and a real user would hit it too.

`flatten` also returns an `Option` that merges three causes (missing parent,
cycle, depth), and the message names the child, not the missing parent.

Fix:

- While building the index, map every `renamed_from` alias to the current
  system name; `flatten_inner` looks the alias up when a name is missing.
- `flatten` returns `Result`, with an error naming the missing parent.
- A test with a fixture user preset that inherits a renamed name.

### 2. A panic kills a protocol pool thread for good (`lib.rs:1470`)

`gcode://`, `mesh://` and `thumb://` run on a pool of 2–8 threads. A job that
panics kills its thread and nothing replaces it; once all are gone,
`pool().send()` still succeeds (the receiver lives) but nothing answers, and
previews and thumbnails hang without an error.

A likely trigger: `fail()` (`lib.rs:1500`, `:1806`) puts `e.to_string()` in
an `X-Error` header and `unwrap()`s the builder; `http` refuses control
characters, so an error message with a newline panics.

Fix:

- Run each job under `catch_unwind` in the pool (isolation of last resort,
  not control flow).
- Strip control characters from the `X-Error` value.

### 3. Synchronous Tauri commands doing I/O on the UI thread (`lib.rs`)

In Tauri 2, a command without `async` runs on the main thread. 90 commands
are synchronous; most are cheap, but these block the window while they run:
`ia_stats` (reads the whole current mesh, `:1542`), `share_save` (copies a
G-code, `:934`), `trash_files` (`:276`), `cache_info` / `clear_cache` (walk
the cache, `:1445`), `ia_duplicate` (copies a workspace, `:1787`), `ia_save`,
`ia_revert`, `slice_save`.

Fix: `#[tauri::command(async)]` on those, bodies unchanged.

## Should fix

### 4. No error context anywhere

There is no `.context()` / `with_context` in the crate, and 124
`map_err(|e| e.to_string())`. `share::save` (`share.rs:79`) reports "No such
file or directory (os error 2)" without the file; `to_string()` on an
`anyhow::Error` keeps only the top message and drops the cause chain.

Fix: `with_context` on file and network operations whose error reaches the
user (paths in the message), and one helper for commands that formats with
`{e:#}` (the whole chain) in place of `e.to_string()`.

### 5. Tests that depend on the local install (`presets.rs:681`, `slice.rs`)

The `presets::*` and `slice::*` tests read `/Applications/Snapmaker Orca.app`
and the presets selected in the user's `Snapmaker_Orca.conf`. They pass in
CI (no Orca, `None`) and fail on a developer's Mac depending on its presets.

Fix: build the `Index` from fixtures under `src-tauri/tests/fixtures/` and
keep one `#[ignore]` test against the real Orca.

Done differently: under test, `Index::build` reads the system profiles only
(the user's presets and Orca's selection are what varied between machines),
and the ignored `the_users_presets_all_resolve` checks the user's presets.
Copying the U1's whole inheritance chain into fixtures was not worth it: the
in-memory `Index` tests already cover the logic on its own.

### 6. One `unsafe` without `// SAFETY:` (`auth.rs:261`)

The other four `unsafe` blocks have one. The `child.id() as i32` casts there
and in `chat.rs:1009` may wrap (`cast_possible_wrap`): use `i32::try_from`.

### 7. `rustfmt` never applied

Add a `rustfmt.toml` matching the current style (`max_width = 140`), run
`cargo fmt` in a commit of its own, and check `cargo fmt --check` in CI.

## Consider

- **~100 `lock().unwrap()`** (`library.rs`, `slice.rs`, `chat.rs`…): the
  accepted idiom (a poisoned lock is a bug), but one panic under a lock
  breaks every later command using it. `parking_lot::Mutex` (no poisoning)
  would remove them.
- **`slice.rs:26`** holds the global `INDEX` lock during `Index::build`
  (disk I/O). Deliberate (no double build); two slices on different engines
  wait for each other.
- **`bool` parameters**: `control::read_with(host, port, config, materials)`
  reads as `read_with(h, p, true, false)` at the call site (C-CUSTOM-TYPE).
- **`lib.rs` is 2,281 lines** with 145 commands: a `commands/` module split by
  domain (ia, jobs, share…) would be easier to navigate.
- **Default clippy**: ~30 trivial fixes (`clone` on a `Copy` type at
  `lib.rs:869`, collapsible `if`s, `slice::from_ref`, `is_multiple_of`),
  applied by `cargo clippy --fix`.
- **Lints**: no `[lints]` table in `Cargo.toml`. A small set
  (`undocumented_unsafe_blocks`, `cast_possible_wrap`,
  `allow_attributes_without_reason`) would have caught #6 and the 24
  `#[allow]` without a reason.

## Already good

- The 3MF parser does not trust the file: triangle indices are bounds-checked
  (`mesh.rs:444`), numbers parse with defaults, preset inheritance has a
  depth limit and cycle detection.
- Little `unsafe`, almost all documented, with a `MainThreadMarker` checked
  before AppKit calls.
- Custom protocols are hardened: `own_webview()` refuses other webviews,
  `prn://` and `cam://` take a printer id and never an address,
  `served_root` limits what is served.
- Good test coverage of the pure logic (G-code, mesh, printer files, chat),
  with local HTTP servers for the network tests.

## State

Items 1 to 7 are implemented in draft PR #82, one commit each. *Consider*
is left for a later decision.

## Order of work

One commit per item, in this order: 1 (fixes the 6 tests), 2, 3, 6, 4, 5,
then 7 (formatting) last so it does not conflict with the others. Items
under *Consider* are left for a later decision.
