# AI conversations: STL and 3MF files as source models

Implemented in [#83](https://github.com/kameka22/snap-studio/pull/83) (the
plan was written first; line numbers are those of `main` at `ced75c5`, before
the implementation).

## Why

A user tried to attach an STL to an AI conversation and nothing happened.
Two problems at once:

1. **Only images can be attached.** The composer and the creation sheet
   accept PNG, JPEG, GIF and WebP (`ui/index.html:856`, `:1412`), and
   anything else is skipped **without a word** (`ui/ia-chat.js:762`,
   `chatReadImages`: `if (!f.type.startsWith("image/")) continue;`).
2. **Dropping a file from the system never reaches the page, on every
   system.** `dragDropEnabled: true` (`src-tauri/tauri.conf.json:23`,
   `tauri.linux.conf.json:18`, `tauri.windows.conf.json:17`,
   `tauri.macos.conf.json:19`) makes Tauri take every file drop and report it
   as handled (tauri-runtime-wry 2.12.1, `lib.rs` ~4816 returns `true`), so
   WebView2 disables external drops (wry 0.57 `webview2/mod.rs:157-162`)
   and WebKitGTK / WKWebView skip their own drop
   (`webkitgtk/drag_drop.rs:105-116`, `wkwebview/drag_drop.rs:89-95`). The
   HTML5 `drop` handlers of the chat (`ui/ia-chat.js:863`) and of the
   creation sheet (`ui/ia.js:713`) never fire, and Tauri's own handler
   ignores images on purpose, believing the AI view handles them
   (`ui/app.js:1142-1146`). Not a regression: it has been so since the chat
   view (`f09ed5f`) and the sheet's drop (#62).

Also, pasting a file copied in a file manager gives a `text/uri-list`, not a
`File`, on Linux: only pasted screenshots work today
(`ui/ia-chat.js:833`, `ui/ia.js:720`).

## Goals

- Attach **STL and 3MF** files, in the creation sheet and in a conversation,
  as **source models** that Claude reads, modifies or builds on.
- One way in for every gesture: **drop** (fixed), **choose** (button),
  **paste** of copied files when the system gives paths.
- A **clear message** for any file that cannot be attached (type, size,
  unreadable model, too many).
- Works the same with the three engines: Claude Code's built-in sandbox,
  the container (yolobox, the only one on Windows) and this computer.
- The result goes back to the files exactly as today (**Save**, versions).

## Non-goals

- STEP, AMF, PLY (later, if asked: STEP needs a CAD kernel).
- **Later: OBJ** (decision 6, deferred). Nothing reads OBJ today; the
  approach kept for later is a small hand-written `src-tauri/src/obj.rs`
  like `stl.rs` (one part per `o`/`g`, n-gons fanned, negative indices,
  materials ignored, mm assumed, no axis change), `tobj` as the fallback.
  The full write-up is in this plan's history (commit `767ae50`).
- Listing STL files in the Library / Files screen, or "Edit with AI" on an
  STL from there (the Files screen only scans 3MF, `scan.rs` `kind_of`).
- Choosing one plate or one object of a multi-plate 3MF: everything is
  merged (decision 3).
- A preview thumbnail on the model chip (decision 4).
- Changing what a model dropped **outside** the AI view does (decision 5).
- Sending the mesh itself to the model as content: Claude works on files
  with its tools, as it already does with `source.3mf`.
- Changing the image pipeline (scaling, 5 per message).

## How the AI works with models today (what we reuse)

- **One folder per conversation** (`src-tauri/src/ia.rs:1-26`):
  `~/.config/snap-studio/ia/<uuid>/workspace/` holds `CLAUDE.md`,
  `.claude/skills/export-3mf/`, `tools/{mf,measure,export}.py`,
  `source.3mf` (edit only), `out/current.3mf`, `versions/vN.3mf`,
  `preview/*.png`, `chat.jsonl`, `attachments/`. It is the sandbox's only
  readable and writable place (`chat.rs:129-145`,
  `blockReadsOutsideWorkingDirectories`) and the folder mounted in the
  container: **anything Claude must read has to be copied into it**, and
  referred to by a **relative path** (the same inside the container, on
  Windows too).
- **Everything is 3MF in the app's layout.** "Edit with AI" (Files screen,
  `ui/ia.js:620` `iaStart` → `ia_create`, `lib.rs:1607` →
  `ia::create`, `ia.rs:590`) converts the original with `parts_of_3mf`
  (`ia.rs:490`, one part per head, painted colors kept) and writes it with
  `write_3mf` (`ia.rs:527`, centered on the U1 plate). STL already has a
  converter: `stl_to_3mf` (`ia.rs:517`). Claude reads parts with
  `mf.read(...)` (`ia_tools/mf.py`) and installs results with
  `tools/export.py`. **This is the mechanism to reuse.**
- **Tools available to Claude**: `trimesh`, `manifold3d`, `numpy` (the
  checks in `setup.rs:24` `MODULES`, the container's `DOCKERFILE`,
  `ia.rs:1647`). `trimesh.load("x.stl")` works with these alone, but
  **trimesh's 3MF loader needs `lxml` and `networkx`**, which are not
  installed (trimesh 5.2 `exchange/threemf.py:514-517`). So 3MF files must
  reach Claude in the app's layout, readable by `mf.read`.
- **How Claude is told**: `CLAUDE.md`, rewritten at each opening
  (`refresh_workspace`, `ia.rs:1775`) from `instructions` (`ia.rs:772`) or
  `instructions_creation` (`ia.rs:833`), plus the shared `COMMON`
  (`ia.rs:744`).
- **Attachments today**: images go as base64 content blocks in the
  stream-json user message (`chat.rs:255`), and a copy is saved in
  `attachments/` with a numbered name (`chat.rs:518` `attachment_name`,
  `:541` `save_attachments`); the log keeps
  `{"type":"attachment","name":…}` blocks, which the history shows through
  the `thumb` protocol (`ui/ia-chat.js:151`, `:508`; `lib.rs:1773`;
  `ia.rs:1753` `attachment`).
- **Creation sheet images** wait in `CHAT.firstImages` and leave with the
  first message (`ui/ia.js:799`, `ui/ia-chat.js:645-652`).
- **Limits today**: 5 images per message, longest side 1568 px
  (`ui/ia-chat.js:36-38`); mesh reading caps at 8 M triangles
  (`mesh.rs:362` `READ_CAP`); no file size limit.

## Design

### 1. One staging command for every gesture

New Tauri command `ia_attach_files(paths: Vec<String>) -> Vec<Staged>`
(`src-tauri/src/ia.rs` or a new `src-tauri/src/ia_attach.rs`, registered in
`lib.rs`'s `generate_handler!`). For each path:

| Kind | Check | Returns |
|---|---|---|
| `png jpg jpeg gif webp` | ≤ 30 MB | `{kind:"image", name, media_type, data}` (base64) — the view then runs it through `chatReadImage` (scaling) as a `Blob` |
| `stl` | ≤ 200 MB, parses (`stl::read`), ≥ 1 triangle | `{kind:"model", path, name, bytes, tris, parts:1, size_mm:[x,y,z]}` |
| `3mf` | ≤ 200 MB, parses (`parts_of_3mf`) | `{kind:"model", path, name, bytes, tris, parts:n, size_mm}` |
| anything else, folders | — | `{kind:"rejected", name, reason:"type"\|"size"\|"unreadable"}` |

Read only, never writes; parsing runs off the main thread
(`spawn_blocking`, like `ia_chat_send`, `lib.rs:1488`). Extension check is
case-insensitive; Windows paths (`C:\…`) are plain `Path`s. The model is
parsed once here for the chip's numbers; it is copied at send time.

### 2. Gestures

- **Drop (the fix)**: keep `dragDropEnabled: true` (the Library's folder drop
  needs it). In `ui/app.js:1142`, before the folder logic: if the AI
  creation sheet (`#iamodal`) is open, or the AI view is shown with a
  conversation open, **all** dropped paths go to that surface
  (`iaAddPaths` / `chatAddPaths`) and nothing opens in Files. Otherwise the
  current behavior stays (a model file opens its folder; decision 5). The routing is a
  pure function (`attachTarget({sheetOpen, iaVisible, convOpen})`) so it can
  be tested. `tauri://drag-enter` / `drag-leave` (`app.js:1140-1141`) also
  toggle the existing `.over` state of `#ia-drop` and a drop hint on the
  composer. The dead HTML5 file drop handlers (`ia-chat.js:860-868`,
  `ia.js:705-719`) go.
- **Choose**: the button opens the native dialog
  (`plugin:dialog|open`, `multiple: true`, filters "Images and 3D models"
  `png jpg jpeg gif webp stl 3mf`, then "Images", "3D models") instead of
  the hidden `<input type="file">` (`index.html:856`, `:1412`): we get
  paths, so the same `ia_attach_files` path. `dialog:default` already
  allows `open` (`capabilities/default.json`).
- **Paste**: image bitmaps keep today's path (`clipboardData.files`).
  `text/uri-list` (Linux file managers) → `file://` URIs decoded to paths →
  `ia_attach_files` (pure `pathsFromUriList(text)`, tested). A pasted
  non-image `File` without a path (some WebView2 / WKWebView cases) gets a
  toast "Drop or choose this file instead" rather than silence.

### 3. Composer and creation sheet

- `CHAT.attach` / `IA.attach` hold images **and** models; models are
  `{kind:"model", path, name, bytes, tris, parts, size_mm}`.
- A **chip** per model next to the image thumbnails (`chatRenderThumbs`,
  `ia-chat.js:788`): cube icon, name, `12.3 MB · 1 part · 40 × 20 × 10 mm`,
  ✕ to remove. No thumbnail (decision 4).
- Limits (decision 2): **5 images + 3 models per message**
  (`CHAT_MAX_MODELS = 3`), **200 MB per model**. Over a limit: a toast, the others are kept.
- Texts: the button title and the sheet's drop line say "images or 3D
  models (STL, 3MF)".
- **Messages** (toasts, all 9 languages):
  - `chat.unsupported_file`: "{name} can't be attached: only images (PNG,
    JPEG, GIF, WebP) and 3D models (STL, 3MF)"
  - `chat.file_too_big`: "{name} is too large (at most {max})"
  - `chat.model_unreadable`: "{name} could not be read as a 3D model"
  - `chat.too_many_models`: "At most {n} 3D models per message"
  - `chat.paste_choose`: "Drop or choose {name} instead of pasting it"
  - `chat.model_scale`: "{name} measures {size}: check its unit (mm expected)"

### 4. Sending: copy, convert, tell Claude

- `ia_chat_send` (`lib.rs:1488`) gets `models: Vec<String>` (paths);
  `chat::send` (`chat.rs:883`) stages them **before** the message is
  written to Claude:
  - each model becomes `sources/NNN-<clean name>.3mf` in the workspace,
    written with `write_3mf` from `parts_of_3mf` (3MF) or the `stl_to_3mf`
    path (STL: one part, head 1); `NNN` numbered like `attachment_name`
    (`chat.rs:518`, same cleaning, never a path). The original is not
    kept: the app-layout 3MF has everything Claude needs and `mf.read`
    reads it.
  - a failure (file gone, unreadable) stops the send with a clear error,
    nothing is half sent.
- The **user message** to Claude gets a text block after the user's text
  (`chat.rs:255` `user_message`):

  ```
  Attached source models (in the working folder, read them with mf.read):
  - sources/002-bracket.3mf — from bracket.stl, 1 part, 12 345 triangles, 40.0 × 20.0 × 10.0 mm
  ```
- The **log** (`save_attachments`, `chat.rs:541`) keeps
  `{"type":"model","name":"002-bracket.3mf","original":"bracket.stl","tris":…,"parts":…,"size_mm":[…]}`;
  the history (`ia-chat.js:508`, `chatUserBubble` `:155`) shows the same
  chip, without the path of the user's disk. The original path is not
  logged.
- `CLAUDE.md` (`instructions`, `instructions_creation`, `ia.rs:772/833`)
  gets a section, present in both:

  > `sources/` — 3D models the user attached (STL and 3MF, converted to
  > 3MF). Read them with `mf.read("sources/…")`. Never modify them. To
  > build on one, read its parts, change or combine them, and install the
  > result with `tools/export.py`, as usual. STL has no unit:
  > millimeters are assumed; if a size looks wrong (under 1 mm or over 1 m), ask.

### 5. At creation (the sheet)

- Models dropped in the sheet wait in `CHAT.firstModels` (next to
  `firstImages`, `ui/ia.js:799`) and leave with the first message, like
  images: the conversation is created as today (`ia_create_blank`), then
  the first `chatSend` copies them into `sources/`.
- **Decision 1**: with **exactly one** model in a "create" sheet, a switch
  "Start from this model", **on by default**, makes it an **edit**
  conversation instead: `ia_create` with that path, extended to STL
  (`ia::create`, `ia.rs:590`, converts with `stl_to_3mf` when the
  extension is `stl`), so it becomes `source.3mf` / `out/current.3mf` / v1
  and shows at once in the 3D pane. Save then goes next to the original
  (`save_to_files`, `ia.rs:1847`), or to the chosen folder if the original
  is gone. Off, or with several models: a creation conversation with the
  models as references in `sources/`.
- The request stays required (`ia.js:768-772`); a model alone is not a request.

### 6. Back to the files

Unchanged: Claude installs with `tools/export.py`, the app versions and
previews `out/current.3mf`, **Save** writes `<stem>-ai.3mf`
(`ia.rs:1847`). `duplicate` (`ia.rs:406`) copies `sources/` with the rest
of the folder (the chat log is not copied, so the new conversation starts
without the chips, as today with images).

## Edge cases

- **Multi-object / multi-plate 3MF** (decision 3): `load_mesh` takes every
  build item (`mesh.rs:332`), so all objects of all plates become parts of
  one object (as "Edit with AI" does today). The chip says the part count; the
  message says it too. Picking one plate is a non-goal.
- **Painted 3MF**: painted colors stay on the triangles, parts per head
  (`split_by_head`, `ia.rs:501`).
- **Position**: `write_3mf` centers on the U1 plate (`on_plate`,
  `ia.rs:536`): absolute positions of the original are not kept. Said in
  `CLAUDE.md`.
- **Units**: STL has none. Size under 1 mm or over 1000 mm on any axis →
  `chat.model_scale` toast on attach and a note in the message to Claude.
- **Huge meshes**: 200 MB cap; over `READ_CAP` triangles (8 M) the reader
  samples (`mesh.rs:362`) — refuse above it instead (`unreadable` with a
  "too many triangles" reason) so Claude never gets a decimated source.
- **Same file twice**: allowed, numbered `003-…`, `004-…`.
- **Names**: non-ASCII letters kept, everything else `-`
  (`attachment_name`); `..` and separators never pass.
- **A conversation locked** (mode not ready, `chatSetLocked`): the add
  button is disabled already; drops on it are refused with a toast.
- **Conversation answering**: attaching is allowed (it leaves with the next
  message), as for images.
- **Drop outside the AI view**: unchanged (opens the folder in Files).
- **macOS permissions**: reading a model in Downloads/Documents goes
  through `access::ensure_file` (`stl::read` and `model3mf::open` already
  call it).

## Files to change

- `ui/app.js:1140-1150` — route drops to the AI surface; drag hint.
- `ui/ia-chat.js` — `CHAT_MAX_MODELS`, `chatAddPaths`, model chips in
  `chatRenderThumbs` (`:788`) and in history (`:508`, `:155`), `chatSend`
  (`:666`) sends `models`, paste of `text/uri-list` (`:833`), dialog picker
  (`:855`), drop handlers removed (`:860-868`), `firstModels`.
- `ui/ia.js` — sheet picker (`:726`), paste (`:720`), drop removed
  (`:705-719`), "Start from this model" switch and `iaCreate` (`:760`).
- `ui/index.html:849, 856, 1406-1414` — inputs removed, texts, switch.
- New `ui/attach-logic.js` — pure `attachTarget`, `pathsFromUriList`,
  `kindOf(name)`, limits; tested by `scripts/test-attach.js`.
- `ui/style.css` — model chip, drop hint.
- `src-tauri/src/lib.rs` — `ia_attach_files`, `ia_chat_send(models)`
  (`:1488`), `ia_create` accepting STL (`:1607`).
- `src-tauri/src/chat.rs` — staging in `send` (`:883`),
  `user_message` text block (`:255`), `save_attachments` model blocks
  (`:541`).
- `src-tauri/src/ia.rs` — `create` for STL (`:590`), `sources/`
  section in `instructions` / `instructions_creation` (`:772`, `:833`), a
  `stage_model(ws, path) -> StagedModel` helper.
- `ui/i18n/*.json` (9 languages) and `src-tauri` catalogs if a Rust error
  text is added; `python3 scripts/check-i18n.py`.
- `CHANGELOG.md`, `docs/plans/README.md`, `docs/technical-overview.md`
  (AI section), README (AI section) once implemented.

## Tests

- **Rust** (`cargo test --lib`):
  - `ia_attach_files`: kinds by extension (case), size cap, unreadable STL /
    3MF, folder refused, Windows-style path kept as is.
  - `stage_model`: STL → `sources/001-x.3mf` readable by `parts_of_3mf`,
    one part head 1; 3MF with two heads → two parts; numbering after a
    deletion; name cleaning (`../../evil.stl`).
  - `user_message` with models: the text block lists relative paths, size,
    triangles; no absolute path anywhere in the message or the log.
  - `instructions*` mention `sources/`.
  - `create` from an STL: `source.3mf`, `out/current.3mf`, `v1.3mf`.
  - Python side: `mf.read` on a staged STL (existing `IA_REAL` style test,
    optional).
- **JS** (`scripts/test-attach.js`): `attachTarget` for each state,
  `pathsFromUriList` (spaces, `%20`, non-ASCII, comments `#`, CRLF),
  `kindOf` (`.Stl`, `.3MF` included), limit messages.
- **By hand**, on macOS, Ubuntu and Windows (ARM): drop, choose, paste an
  STL and a 3MF, in the sheet and in a conversation, with the sandbox and
  the container; Claude reads it and installs a modified version; Save.

## CHANGELOG (Unreleased)

- *Added*: **3D models in AI conversations**: attach STL and 3MF
  files, when creating or during a conversation, for Claude to modify or
  build on; with one model, a new conversation starts from it.
- *Fixed*: images and models dropped on the AI view or the creation sheet
  were ignored; a file that can't be attached now says why.

## Decisions (kameka22, 2026-10-31)

1. **Creation sheet with one model**: "Start from this model" is **on by
   default** (edit conversation, shown at once in the 3D pane); off, or with
   several models, the models are references in `sources/`.
2. **Limits**: **3 models per message, 200 MB per model** — approved.
3. **Multi-plate 3MF**: **merge everything**, as "Edit with AI" does today.
4. **Chip thumbnail**: **not in this PR**.
5. **A model dropped outside the AI view** keeps opening its folder in
   Files.
6. **OBJ deferred**: not in this PR (see Non-goals for the approach kept
   for later).
