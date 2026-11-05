# Robust 3MF loading (audit and hardening)

Plan only (draft PR). Read-only audit of the code on `main` (after #90)
and a defensive checklist; no code is changed here. No attack details:
only what is checked, what is refused, and the tests that prove it.

Asked on 2026-11-05, from the day's watch: PrusaSlicer 2.9.7 is a
security release that fixes, among others, a memory error when loading a
crafted 3MF (Filament Feed, 2026-11-04). OrcaSlicer 2.3.2 had also fixed a
path traversal in 3MF import (#12860). Snap Studio opens 3MF files that
users download from model sites (Explore), receive or find in their
folders, so it should read them robustly.

Sources:
- [Filament Feed, 2026-11-04](https://filamentfeed.com/article/prusaslicer-3-0-alpha13-plugin-marketplace-print-goals-november-2026)
  (PrusaSlicer 2.9.7 section) and the PrusaSlicer 2.9.7 release notes on
  GitHub.
- [OrcaSlicer releases](https://github.com/OrcaSlicer/OrcaSlicer/releases)
  (2.3.2: "Security fix: path traversal in 3MF import").

## Where Snap Studio reads 3MF files (today)

All in Rust, with the `zip` 8.6 and `quick-xml` 0.42 crates
(`src-tauri/Cargo.toml`):

- `src-tauri/src/model3mf.rs`: opens the archive (`open`), reads one
  entry by name (`read_entry`), lists names, picks the embedded thumbnail,
  reads the model header, `slice_info.config`, `model_settings.config`,
  project filaments.
- `src-tauri/src/mesh.rs`: parses `3D/3dmodel.model` and the `.model`
  files its components point to (`parse_part`, `Ctx::collect`), then emits
  triangles (`emit`).
- `src-tauri/src/plate.rs`: project settings (JSON, `serde_json`) and
  per-object data.
- Callers: thumbnails of the library folders (`thumbs.rs`, generated in
  the background for every 3MF found, before the user opens it), Prepare
  (`plate.rs`, `lib.rs`), slicing (`slice.rs`), AI source models
  (`ia.rs`, `ia_attach.rs`).
- The embedded thumbnail is decoded with the `image` crate
  (`image::load_from_memory`, `thumbs.rs`).
- In the AI sandbox, `src-tauri/src/ia_tools/mf.py` reads 3MF files with
  Python's `zipfile` and `xml.etree.ElementTree`; it only reads files the
  app wrote there (sources are re-emitted by `ia_attach.rs`) or the AI's
  own results.

## Protections already in place

- **The engine never loads a user's 3MF.** Before slicing, the geometry is
  read by Snap Studio and re-emitted into a new 3MF by its own writer
  (`rewrite_centered` / `write_scene`, `slice.rs`, `write3mf.rs`). The
  bundled Snapmaker Orca only sees files Snap Studio wrote. This also keeps
  engine-side 3MF bugs (as fixed in PrusaSlicer 2.9.7 and OrcaSlicer 2.3.2)
  away from downloaded files. (Formats other than 3MF and STL still go to
  the engine as they are.)
- **Nothing is extracted to disk.** Entries are read into memory by name;
  no entry name becomes a file path, so archive path tricks cannot write
  anywhere. Component `path` attributes are only looked up inside the
  archive.
- **Memory-safe parsers** (Rust): an out-of-range triangle index is
  skipped (`emit`), not a crash; colors are cut without panicking
  (`parse_color` with `get`).
- **XML**: `quick-xml` does not fetch external entities or DTDs, so
  external-entity tricks do not apply to the Rust side.
- **Recursion and counts**: component depth is capped at 12 and resolved
  instances at 100 000 (`Ctx::collect`); above 8 M triangles a mesh is
  sampled and marked truncated, and slicing refuses it (`READ_CAP`).
- **AI attachments**: at most 200 MB per model file and 8 M triangles
  (`ia_attach.rs`).

## Gaps found (to harden)

1. **Decompressed size is not bounded.** `read_entry` reads an entry to
   its end (`read_to_end`); only the initial allocation is capped (64 MB).
   Snap Studio sets no limit of its own on what an entry expands to
   (whether the `zip` crate stops at the size the archive declares is to
   confirm at implementation; a declared size can be wrong anyway). A
   small archive can expand to far more than its size (decompression
   bomb), and the thumbnail scan reads files in the background.
2. **No limit on entry count or total size** of the archive's central
   directory.
3. **Vertices and triangles are pushed without a limit** while parsing
   (`parse_part`) — the 8 M triangle cap applies after parsing, not during.
   The AI paths call `load_mesh` with `usize::MAX`, so no cap at all there
   (only the 200 MB file limit for attachments).
4. **Malformed numbers** become 0 (`unwrap_or(0.)`) and non-finite values
   (`NaN`, `inf`) are accepted in vertices and transforms; they can make
   bounding boxes and the plate placement meaningless.
5. **Embedded images**: decoded with the `image` crate's default limits;
   no explicit cap on width × height before decoding.
6. **`mf.py`** (AI sandbox) uses the standard library XML parser; fine for
   files the app wrote, but it should not be pointed at arbitrary
   downloads.
7. **Engine 3MF reader**: whether Snapmaker Orca 2.4.0 / 2.4.1 (#86)
   includes OrcaSlicer's 2.3.2 path traversal fix is not known here. Low
   impact while the engine only reads Snap Studio's files; to check with
   the engine upgrade.

## Proposed hardening (defensive checklist)

One small module of limits used by every reader (`model3mf.rs`):

- **Per-entry decompressed cap** (for example 512 MB for `.model`, 16 MB
  for config / XML / JSON, 32 MB for images), enforced while reading
  (`take(limit + 1)` and refuse if exceeded), not from the declared size
  alone.
- **Whole-archive budget**: total decompressed bytes read per file, and a
  maximum entry count (for example 10 000).
- **Compression ratio check**: refuse an entry whose ratio is absurd
  (for example > 1000:1) before reading it fully.
- **Entry names**: only look up the names the 3MF spec and the known
  slicer layouts use (`3D/…`, `Metadata/…`, `_rels/…`, thumbnails);
  normalize a component path (strip a leading `/`, refuse `..`, absolute
  or drive paths, backslashes and NUL) before lookup. Unknown entries are
  ignored, never executed or extracted.
- **Parsing limits**: stop parsing a part above the vertex / triangle cap
  and mark it truncated (as today after parsing); give the AI paths a real
  cap instead of `usize::MAX`.
- **Numbers**: refuse non-finite coordinates and transforms (the object is
  skipped with a clear message), keep the index check.
- **XML**: keep external entities off (assert it in a test); bound
  element nesting depth and attribute size.
- **Images**: check dimensions from the header and cap them (for example
  8192 × 8192) before decoding; on failure, fall back to the mesh render.
- **Errors, not crashes**: every limit gives a translated "this file could
  not be read safely" message (`err.*` keys) and a log line without the
  file's path (privacy rule: paths may contain the user's name).
- **`mf.py`**: documented as for app-written files only; optionally use a
  hardened XML parser if it ever reads foreign files.
- **Engine**: with #86, check the engine's release notes for the 3MF fix
  and note it in `src-tauri/engine.json`'s upgrade notes.

## Decisions / open questions for the owner

1. The limits' values (per entry, per archive, ratio, image size): the
   numbers above are proposals; real files from model sites (large painted
   projects) must still open.
2. When a limit is hit while building a **thumbnail** in the background:
   show the placeholder silently, or flag the file in the library?
3. Should the fix be one PR (limits + tests) or split (limits first,
   number checks later)?
4. Report through `SECURITY.md`'s advisory flow if a real problem is
   confirmed at implementation (rather than a public issue)?

## Out of scope

- Proof-of-concept files or reproduction steps: tests build only
  oversized or malformed-but-harmless inputs in memory, checking that the
  reader refuses them cleanly.
- Changes to the engine itself.
- Other formats (STL reader, G-code parser): a similar audit could follow.

## Files likely touched

- `src-tauri/src/model3mf.rs` (limits, bounded `read_entry`, name checks),
  `src-tauri/src/mesh.rs` (parse caps, finite numbers, path
  normalization), `src-tauri/src/thumbs.rs` (image dimension check),
  `src-tauri/src/ia.rs` (caps for AI paths).
- `ui/i18n/*.json` (one or two `err.*` messages, 9 catalogs).
- `src-tauri/src/ia_tools/SKILL.md` / `mf.py` docstring (scope note).

## Testing (secure behavior, built in the test code)

- An entry larger than its cap → refused with the error, memory stays
  bounded (stream test, not a file in the repo).
- An archive with more entries than the maximum → refused.
- Component paths with `..`, absolute, drive or backslash forms → ignored,
  the rest of the model loads.
- `NaN` / `inf` coordinates or transforms → object skipped, no panic.
- A DOCTYPE with an entity declaration in `3dmodel.model` → entity not
  expanded, parsing goes on or stops cleanly.
- An image with oversized declared dimensions → not decoded, render
  fallback.
- Existing real-file tests (`real_dense`, `real_painted_file`, the
  fixtures) still pass: no regression on large legitimate files.
- `cargo fmt --check && cargo test --lib`.

## Docs and CHANGELOG

- No CHANGELOG line in this PR (spec only). At implementation, under
  *Unreleased › Fixed* (a fix, kept short), for example: "**3MF files**:
  oversized or malformed files are refused cleanly instead of using too
  much memory."
- `SECURITY.md` scope already names "what a model file … could make the
  app do"; no change needed.
