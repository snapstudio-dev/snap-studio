# STL files in the Files library

Implemented in [#105](https://github.com/kameka22/snap-studio/pull/105). Checks in the app left (see Tests).

## The problem

The Files library lists only 3MF and G-code files. An STL in the opened
folder doesn't show, so it can't be previewed, put on the plate or printed
from there. The rest of the app already handles STL:

- Prepare's **Add** dialog accepts `.3mf` and `.stl` (`ui/prepare.js:2702`),
  and a dropped STL goes on the plate;
- `plate.rs` loads an STL as a single object (`load_whole`, `is_stl`);
- `slice.rs` slices it like a 3MF (`rewrite_centered`, `is_stl`);
- the 3D viewer's protocol reads STL already (`lib.rs`, "STL and 3MF go
  through the same protocol");
- AI conversations take STL as a source model (`ia_attach.rs`).

So the gap is the library itself: the scan, the thumbnail, the details and
the analysis.

## Where STL is filtered out today

| Place | What happens to an STL |
|---|---|
| `src-tauri/src/scan.rs` `kind_of` | Only `3mf` and the G-code extensions have a kind: an STL is skipped by `scan_dir`, so it never reaches the list |
| `src-tauri/src/thumbs.rs` `generate` | Opens every non-G-code file as a zip (`model3mf::open`): an STL would fail and be remembered as "no preview" |
| `src-tauri/src/lib.rs` `meta_of` | Tries G-code, then 3MF: an STL would get empty metadata |
| `src-tauri/src/lib.rs` `analyze` | Opens a 3MF only: **Analyze Geometry** would fail |
| `ui/app.js` `makeCard` / `makeRow` | Strip `.3mf` from the name only: an STL would show `benchy.stl` |

## Proposal

### 1. List STL files (Rust)

- `scan::kind_of`: `"stl" => Some("stl")`. `ScannedFile.kind` documents the
  third family. Hidden files stay excluded as today.
- A test in `scan.rs`: `.stl`, `.STL` and `.Stl` have the kind `stl`, and a
  folder with a 3MF, an STL and a G-code lists all three.

### 2. Thumbnail

- `thumbs::generate`: for `stl`, read the mesh with `stl::read`, sample it
  to `TRI_BUDGET` (`mesh::downsample`) and render it with `render::render`,
  in the app's neutral model colour (no filament colour: an STL has none).
- The source is `ThumbSource::Rendered`, so the card shows the existing
  **3D render** badge, as for a 3MF without an embedded image.
- The thumbnail preference (embedded / render) has no effect on an STL:
  there is never an embedded image.
- A broken STL is remembered as "no preview", like a broken 3MF today.

### 3. Details panel

`meta_of` for an STL:

- no title, designer, licence, time, weight or filaments: an STL carries
  none of them;
- `objects` empty, `plates` 1, `has_embedded_thumb` false;
- a new `size_mm`, the mesh's size, for the unit hint (section 7).

The UI adds a **Format** row, "STL (mesh only)".

The panel then shows the name, size and date, and the **Prepare**,
**Edit with AI**, **Show in folder** and **Move to Trash** actions, as for a
3MF. `act-analyze` stays available.

### 4. Analyze Geometry

`analyze` reads an STL with `stl::read` and returns the same `AnalyzeDto`
(size, triangles, approximated). The whole file is read, so the count is
never approximated. Same code path afterwards.

### 5. Names and actions in the UI

- `makeCard` / `makeRow` strip `.stl` as well as `.3mf` (one regex,
  `/\.(3mf|stl)$/i`).
- A small **STL** badge on the card, in the style of the **G-code** badge,
  so a 3MF and an STL with the same name can be told apart. It takes the
  place of the "3D render" badge: an STL is always a render.
- Double-click and ⏎ already send any non-G-code file to Prepare
  (`openFile`), and **Prepare** with several picked files mixes 3MF and STL
  without change (`prepareFiles`).
- **View in 3D** opens the STL in the viewer (`openViewer`), which reads it
  through the existing protocol.

### 6. Printing

Nothing new to build: an STL put on the plate from the library follows the
same path as a 3MF (Prepare → slice → send or print). The plan checks it
end to end (see Tests).

### 7. Units

An STL has no unit. A model exported in inches shows 25.4 times too small,
one in metres 1 000 times too small, and one in micrometres 1 000 times too
big. Nothing is rescaled automatically: the details' subtitle warns, in the
warning colour, when the longest side is under 1 mm or over 1 m. Same rule
and wording as for AI conversations (`attachOddScale`, `chat.model_dims`).

## Texts

New strings, in the 9 languages (`ui/i18n/*.json`):

- `files.stl_badge`: the badge's title, "Mesh only: no colours, settings
  or plates"
- `files.unit_hint`: "Measures {size}: check its unit (millimeters
  expected)"
- `files.info.format` and `files.info.format.stl`: "Format", "STL (mesh
  only)"

## Tests

- Rust: `scan.rs` (kinds and listing), `thumbs.rs` (a rendered STL
  thumbnail is a non-empty PNG, a broken STL gives no preview), `analyze`
  on an STL (size of a 20 mm cube), `meta_of` on an STL.
- JS: the name without `.stl` and the badge, if the card code gets a test
  hook (`scripts/test-*.js`).
- By hand, on a folder with 3MF, STL (binary and text) and G-code files:
  list and grid, thumbnails, details, Analyze, View in 3D, Prepare from a
  double-click and from a multiple pick, slice, then print on the U1.

## Decisions (2026-11-12)

1. **Large folders**: no special handling. STL thumbnails are rendered,
   serialized by `RenderGuard` and cached like any other render.
2. **Format line**: yes. The details show a **Format** row, "STL (mesh
   only)", and the card an **STL** badge (in place of the "3D render" one,
   which an STL always is).
3. **Unit hint**: yes, now. `meta_of` reads the STL's size (`size_mm`), and
   the details' subtitle warns when its longest side is under 1 mm or over
   1 m, with the same rule and wording as AI conversations
   (`attachOddScale`, `chat.model_dims`).
4. **Other mesh formats** (OBJ, STEP): out of scope.

## CHANGELOG

At implementation, under *Unreleased › Added*: "**Files**: STL files are
listed with a rendered preview, and can be analyzed, viewed in 3D, prepared
and printed like 3MF files."
