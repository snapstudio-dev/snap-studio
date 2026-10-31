# Changelog

What changes from one version of Snap Studio to the next. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (0.x: the app is still young, a
minor version may change how things work).

Each version is published on the [releases page](https://github.com/kameka22/snap-studio/releases),
with its packages for macOS, Windows and Linux. What comes next:
[Roadmap](README.md#roadmap).

## [Unreleased]

### Added
- **Settings from Snapmaker Orca 2.4.1 in the slice sheet**: top and bottom
  paint penetration layers (Surfaces), the minimum support contact area
  (Supports), internal ribs for the prime tower (Multi-material), and the
  first layer's travel acceleration and jerk (Quality) (#86).

### Changed
- **Slicing engine updated to Snapmaker Orca 2.4.1** (#86):
  - the prime tower now gives each kind of material its own block inside
    the tower, by default. With materials that don't bond to each other, its
    outer wall is printed in one of them, so they never meet: the warning
    above Slice becomes an information line, with the other walls, no tower
    and one tower per material. Prepare's tower estimate follows its new
    size and place, and which materials bond with each other follows the
    engine's own material categories;
  - bridges follow Snapmaker's new defaults: in the U1's 0.20 mm Standard
    profile, full bridge flow and density, and with supports on, bridges of
    any length get supports (bridges up to 10 mm used to be left free);
  - a few filament profiles come with new bed temperatures, from
    Snapmaker's profiles;
  - the support threshold angle starts at 1°: the engine refuses 0.

## [0.18.0] — 2026-10-31

### Added
- **Integrated title bar on Windows and Linux**: the window draws its own
  minimize, maximize and close buttons in the same top band as macOS's
  traffic lights, with no system title bar above the app. Windows 11 style
  at the top right on Windows; on Linux, GNOME style, on the side the
  desktop's button layout puts them, with rounded corners, and Settings →
  Display → "Use the system title bar" to get the desktop's own back. macOS
  is unchanged (#27).
- **Picking several files on a printer with the mouse**: in Printer ›
  Files, Ctrl-click (Cmd-click on macOS) adds or removes a file and
  Shift-click picks a range, as in the Files view, without entering Select
  mode first. The selection bar and the right-click menu act on the files
  picked (#84).
- **3D models in AI conversations**: attach STL and 3MF files, when creating
  a conversation or during one, for Claude to modify or build on — dropped
  on the window, chosen with the paperclip or pasted from the file manager
  (up to 3 per message, 200 MB each). With a single model in the creation
  sheet, "Start from this model" (on by default) makes the conversation
  start from it, as "Edit with AI" does; otherwise Claude gets the models as
  references next to its work. The message shows each model's name, parts
  and size (#83).

### Fixed
- **AI versions sometimes missing**: the versions (v1, v2…) at the bottom
  left of an AI conversation could stay hidden until switching to Terminal
  and back; they now show as soon as they are read (#83).
- **Files dropped on the AI view or its creation sheet were ignored**: they
  are now attached; a file that can't be (wrong type, too large, unreadable,
  too many) says why instead of being skipped silently (#83).
- **Presets made with Snapmaker Orca 2.3**: a custom print profile based on
  a system profile that Orca 2.4 renamed (e.g. "0.08 Extra Fine" → "0.08mm
  Standard") slices again instead of failing with "unresolvable
  inheritance". When a parent really is missing, the message now names it
  (#82).
- **No more freezes during long file operations**: saving a slice or an AI
  model, reverting a version, moving files to the trash, sharing a copy,
  starting an AI conversation from a big model and clearing the cache now
  run in the background instead of blocking the window (#82).
- **Previews and thumbnails no longer stop loading for good** after an
  error in one file: the faulty file answers with an error and the others
  keep loading (#82).
- **Clearer error messages**: an error now keeps its cause instead of only
  its first line, and a failed file operation (sharing, copying a print
  job, saving a preset, installing the engine, a download or an upload)
  names the file it was working on (#82).
- **Deleting several files on a printer**: with files picked in Select mode,
  right-click → Delete now deletes every picked file ("Delete {n} files"),
  instead of only the one clicked, and the other picks are kept (#84).

## [0.17.1] — 2026-10-28

### Added
- **Smooth mix for virtual heads**: each layer of a mixed color is split
  between its two heads (Snapmaker Orca's Subdivide Mix Layer), on by
  default in the Multi-material settings, for a more even color; and a
  warning when the two colors are too far apart to mix well.

### Fixed
- Slice preview: each line is drawn as tall as its layer (or sub-layer),
  as Snapmaker Orca draws it, instead of as tall as it is wide. A virtual
  head's alternating layers now show as thin clean bands, not a noisy
  checkerboard; the print itself was never affected.

## [0.17.0] — 2026-10-28

### Added
- **Four more languages**: German, Spanish, Brazilian Portuguese and
  Italian, for the whole interface, the menus and Orca's settings; a fresh
  account starts in the system's language. Dates and numbers follow the
  chosen language, and a text not yet translated shows in English (#72).
- **Japanese, Simplified Chinese and Korean**, with the system's Chinese,
  Japanese or Korean fonts; Traditional Chinese systems start in English
  for now (#73).

### Changed
- **A new Prints page**: the prints on the left (search, filters, printer
  and material chips; in progress, queue, then day by day), the record on
  the right: camera, progress and time per layer while it prints; timelapse,
  result (success or failure, a reason, a note) and real against estimated
  duration once done, with Reprint and Open in Prepare; a Times card (per
  layer or per type) and a Details card (slice, profile, files and dates),
  folded to one line, on every record. The history and its G-code are kept
  forever, unless Settings → Prints deletes them after 30 days, 90 days or
  a year (#65).
- **One camera for the app**: the printer page, the record of a running
  print and Control's card show the same camera, with the same controls
  everywhere (pin, enlarge where there is room, full size, Esc). Going from
  one screen to another of the same printer keeps the stream, nothing is
  read while the window is hidden, and the pinned window follows as before
  (#65).
- **Settings → About** and the credits also name three.js and the U1 3D
  model of the printer view, made by kameka22 (#75).
- **Explore: eight model libraries, no Store products**: MyMiniFactory,
  Thangs, Yeggi and GrabCAD join MakerWorld, Printables, Thingiverse and
  Cults3D, two rows of four. The block of Store products, read from the
  shop's catalogue, is gone: the Store stays one click away in the
  Snapmaker cards, and Explore reads nothing from the sites but their icon
  (#76).

### Fixed
- AI setup on macOS: launched from its icon, the app found macOS's own
  Python 3.9 before the one installed with Homebrew (and so did Claude). The
  folders users install to now come before the system's. A module that is
  installed but does not import now says why, under the modules' line (#69).
- A printer that does not answer: Care & Tuning (Control, Care, Bed
  Leveling) and the printer's Files page say so the same way, in one short
  line with its name and Retry, in place of a long error with the address it
  tried or a large card. The printer page no longer shows the camera, model and
  address while the printer is offline, and its Details leave the address out.
  The printer's Files page's errors (list, download, delete, rename, share)
  no longer carry an address. A printer that
  answers with an error (Klipper shut down, HTTP 503) says that error rather
  than "does not answer"; a pinned camera stays on its printer's page (#74).

## [0.16.0] — 2026-10-26

### Added
- **Basic and Advanced slice settings**: the slice sheet opens in Basic,
  with the settings it had before 0.15; Advanced, chosen in its title bar or
  in Settings → Prepare, shows them all. Hidden settings keep their values
  and still apply, and Basic says how many advanced ones are changed. Anyone
  who already changed one of the new settings starts in Advanced.
- **Virtual heads (color mixing)**: in Heads and spools, mix two loaded
  spools into a new color with one slider, as Snapmaker Orca's Full
  Spectrum does (the heads alternate layer by layer). Virtual heads appear
  in Prepare's head pickers, where each color now shows only its head; one
  is deleted when one of its spools is unloaded, and what used it waits for
  a new head before slicing.
- **One prime tower per material**: on a plate whose materials do not
  bond with each other, Prepare's prime tower can be « Per material »: small
  pillars, one per group of materials that bond, with one ring per head,
  instead of one shared tower that would come off. They are placed in a
  free spot, can be moved one by one or split into one pillar per head, and
  are generated at every slice (never saved in the project). Also offered
  on the slice sheet's tower warning; the single tower stays the default.
- **Images when starting an AI conversation**: the new conversation sheet
  takes images (sketches, photos), dropped, pasted or chosen, as the
  conversation does; they leave with the first request and are kept with
  the conversation's other images.

### Changed
- **A lighter AI sandbox**: on macOS and Linux the AI's sandbox is now
  Claude Code's own (Seatbelt, or bubblewrap and socat on Linux): no Docker,
  no yolobox, no image to build, just Python and its three modules. Claude
  only reaches the conversation's folder, reads nothing in your home folder
  and its commands have no network. Already using yolobox? Nothing changes:
  your setting and your conversations stay in the container, and "Container
  (yolobox)" remains a choice in Settings → AI.
- AI setup on macOS: the modules' help also gives `brew install tbb`, for
  a Python newer than manifold3d's packages (3.15), where pip builds it and
  stops on "tbb was not found".

### Fixed
- Settings → AI: "Check Again" no longer stays on "Checking…" once the
  check is done.
- Dropping an image on the window no longer adds it to the recent folders
  as if it were one.

## [0.15.0] — 2026-10-25

### Added
- **The prime tower in Prepare**: a "Prime tower" switch under the object
  list, the same setting as the slice sheet's, off on every new plate
  whatever the profile says. With two heads or more, a grey box shows where
  the tower will be printed: placed in a free corner, moved and turned like
  a part (drag, ⌥ drag, arrows, its own X, Y and rotation sliders), its
  size estimated before slicing and the real one after. A prime volume
  slider makes it smaller (or larger): the slice sheet's setting. Auto-arrange works
  around it; a tower on a part or off the plate is flagged, with a "Move to
  a Free Spot" fix, and a saved 3MF keeps it where Orca does.
- **Prime tower and materials that do not bond**: the slice sheet warns,
  above the Slice button, when the prime tower would mix materials that do
  not stick to each other among the heads the plate prints with — the tower may come off or collapse —
  with one-click fixes: no tower, or the tower's outer wall in one of the
  materials. The prime tower gets its own switch on the slice sheet (its
  Multi-material row, now above Seam); the Multi-material panel gains the
  tower's wall head and ooze prevention (temperature drop of idle heads,
  preheat time, idle temperature).
- **More slice settings**: the slice sheet gets the quality and strength
  settings that only came from the profile. A ⚙ next to Quality opens the
  first layer, line widths, precision (elephant foot, X-Y compensations,
  resolution, arcs) and overhangs and bridges; one on the Infill tile the
  infill pattern (from pictures), direction, overlap and anchors; one on
  the Walls tile the wall generator, order and direction and the thin and
  single walls. Two new rows: Surfaces (top and bottom shells, surface
  patterns from pictures, ironing) and Other (print sequence, spiral vase,
  fuzzy skin, skirt, travel). Settings that detail another (ironing, fuzzy
  skin, overhang speeds, skirt) show only with it.
- **Camera close button**: the printer camera has a ✕ in its top-right
  corner, in the style of its other buttons, at every size (on the printer
  page, enlarged, over the 3D view, full size; the pinned window keeps its
  own), which turns it off. In full size, a click beside the picture, in
  the margin or the dark bands around it, gives it back to where it came
  from, as Esc does. The double-click that enlarged the camera is gone:
  its buttons do it.

### Changed
- **Head pickers show the spools**: in the slice sheet's advanced settings
  and in Prepare's "Colour…" palette, each head is shown with its spool's
  colour and material instead of a text list; Prepare's printer picker and
  the filament sheet's material use chips. Spool dots get an edge that shows
  on the dark theme too, white and black spools included.
- **Pills instead of short lists**: the language (with flags, in Settings
  and on the welcome screen), the scroll wheel action, the preview source,
  the colour → head mode and the timelapse speed are chosen with segmented
  controls; the AI mode with cards that say what each one means. The AI
  list's filters move into a Filters popover (with the number active), and
  its sort into a menu, as in Files.
- **Visual slice styles**: in the slice sheet's Advanced panels, support
  type and style, support base and interface patterns, brim type and seam
  position are chosen from pictures with a short explanation instead of
  plain lists. Support styles only offer those that suit the support type
  (normal or tree), and going back to the other type resets an unsuited
  style to Default, as Orca does; a value from a project that the list does
  not offer is shown as it is rather than as the first choice.
- **Number steppers**: the number fields of the slice sheet's advanced and
  speed panels and the AI's size limit show ‹ value › instead of the small
  native arrows: a click steps (held, it repeats), the arrow keys too, and a
  double-click or Enter on the value lets you type one (Esc puts the old one
  back). Percentages step by one.

## [0.14.2] — 2026-10-24

### Added
- **What's new**: a page on the site presents each version's highlights
  (screenshots, smaller improvements, previous versions), in English and
  French; 0.13 has its own full section below 0.14, folded until opened. A card above Settings in the sidebar announces it after an
  update ("What's new in 0.14 — Explore and 3 more") until it is opened,
  then stays as a plain line; it opens the page in a sheet over the app,
  with "Open in the Browser" and a message to try again when offline.
- **Printer camera, full size and pinned**: besides its enlarged size, the
  camera can fill the whole content area (Esc to leave), or be pinned: a
  small window that stays on every screen (over Explore's sites too), moved by its title bar to any
  corner (remembered), back to the printer's page with a click on the
  image, unpinned or closed from its own buttons, hidden on that printer's
  page where the camera already shows. One stream throughout; when the
  printer stops answering, it says so instead of a frozen image.

### Fixed
- **Slice progress bar**: it now follows the slicing from 0 to 100 %, stage
  by stage (walls, surfaces, infill, G-code…), never going back, and
  reaches 100 % right before the preview. On macOS the engine never
  reported its progress the way the app read it, so the bar stayed near
  its start; the progress now comes from the engine's own log, read live.

## [0.14.1] — 2026-10-24

### Fixed
- **App icon in the macOS Dock and Finder**: on macOS 26 the system no longer
  frames it in a light tile — the icon is rebuilt from the original artwork on
  Apple's icon grid and also shipped in Apple's new format (Icon Composer);
  sharper on every platform, as it is no longer upscaled from a small crop.

## [0.14.0] — 2026-10-23

### Changed
- **App icon**: rainbow tubular **S** on a graphite squircle, sized for the macOS
  Dock; applied to the app bundle, in-app chrome, and the site favicon
  ([#23](https://github.com/kameka22/snap-studio/pull/23)).
- **Explore screenshot** on the README and the site: the Explore home (Space,
  Store, Wiki, Forum, Account, libraries and Store picks).

### Added
- **Explore** ([#23](https://github.com/kameka22/snap-studio/pull/23)):
  the Library becomes Explore, with the Snapmaker ecosystem beside the
  model libraries. Its home shows Snapmaker Space, Store, Wiki, Forum and
  Account as cards with the sites' own icons, a few products featured
  from the Store, then the libraries; each opens in a tab. The sidebar
  entry always lands on the home; "Snapmaker Space" and "Favorites" sit
  under it. A "+" in the tab strip opens the same cards in a sheet. A
  model (.3mf, .stl) downloaded from any tab goes straight to the plate
  in Prepare.

- **Prepare › colour modes** ([#52](https://github.com/kameka22/snap-studio/pull/52)):
  heads are assigned "by object" (each object chooses, under its row, as
  before) or "by colour" (the plate's colours, as the 3MF names them, are
  assigned once for every object in a banner above the list, as Snapmaker
  Orca does). The switch sits in the object list's header; Settings ›
  Prepare chooses the mode Prepare starts with. The first switch explains
  the two modes once. Switching keeps the associations that agree: a
  colour every object sends to the same head keeps it, one the objects
  disagree on waits for a choice, and the slice waits with it. An object
  the file gives no colour shows a warning in "by colour" mode until a
  head is picked for it (a palette on the warning, then a chip to change
  it). "Colour…" joins the object's menu, on the plate and on its row in
  the list: the palette in "by colour" mode ("Change Colour…" once it has
  one), the object's colour/heads frame in "by object" mode. The header
  now reads "Objects (n)" with the total only.
- **Prepare › object list** ([#51](https://github.com/kameka22/snap-studio/pull/51)):
  the colour and heads frame only shows for objects on the plate (heads
  do not apply off it); each on-plate object has a "−" to take it off,
  mirroring the "+" of an off-plate one; "Add All" and "Take All Off"
  follow the selection, becoming "Add 2 Objects" or "Take 1 Object Off"
  when part of a side is selected, each side counting its own objects.

### Changed
- **Create**: the AI entry of the sidebar, and its view, now read
  Create; Settings › AI keeps its name.
- **Explore's tabs**: no toolbar and no address bar any more; the tab
  strip takes the top of the view. Back, Forward and Reload float over
  the page at its top-left, discreet until the pointer comes. The star
  and "open in the browser" sit at the right of the tab strip; download
  notices show in it.

### Fixed
- **Camera**: a camera that failed to start on the Prints record is
  switched off again instead of retrying every second; two quick toggles
  no longer leave two keep-alives running.
- **Printer form**: the connection test checks the port first, shows its
  error, and a slow answer for a host typed before no longer fills in
  the fields; a model file dropped on the window opens its folder rather
  than leaving a dead entry in the recent folders; a model exported
  again is read again when added to the plate.
- **Prepare**: a mesh that could not be read is tried again rather than
  staying invisible; what Arrange cannot fit is parked in a free spot;
  the face tool says when an object's hull could not be read.
- **Printer files**: a print file's delete is retried when the printer
  did not answer; a timelapse's removal is given five seconds to show;
  sending a large G-code no longer holds it in memory twice.
- **Engine**: on macOS the engine's executable is the one its bundle
  names; without a downloaded engine only Snapmaker Orca is used, never
  another slicer; a binary STL with a few trailing bytes opens.
- **AI**: the terminal view no longer obeys escape sequences printed by
  the model or a tool; a conversation being answered is redrawn on
  language change; the checks of what the AI needs run at most every
  30 s; the sign-in terminal reopened quickly is no longer closed by the
  previous one; attachments keep distinct numbers after a deletion.
- **Library**: logging out of a site no longer deletes the cookies of a
  longer domain that ends the same.
- **Slicing**: Stop works during the preparation too (it used to wait for
  the engine); a saved G-code never overwrites an existing one, it is
  numbered; a failed or stopped slice leaves no work folder behind, and
  at most eight previews are kept; a 3MF is read once rather than once
  per object when Prepare opens; two quick machine changes in the slice
  sheet no longer mix their process lists; an error raised before the
  slice sheet knew its job is shown instead of leaving it on "Preparing".
- **Printers**: a print refused by the printer, or one that timed out,
  is reported as such instead of being started a second way; an error
  message cleared on the printer goes away from the Printers tab, and a
  stopped Klipper stays shown as stopped; searching again ignores the
  previous search's late answers; a host typed with a scheme or a
  trailing slash gets the same address for status, files and the live
  feed (`https://` keeps TLS).
- **Files**: sharing a file then another one before the first was
  fetched no longer shares the first under the second one's name;
  renaming refuses a source outside the print files.
- **AI**: opening a conversation that is answering no longer doubles
  its last messages; the "session lost" hint stays on its conversation;
  switching the AI off in Settings locks the open conversation; a send
  that fails after leaving the conversation marks it as failed; an idle
  conversation's Claude (and its sandbox) is stopped when the
  conversation is left, and resumed by the next message; when Claude
  stops by itself, what it wrote on its error output is shown; the
  sign-in check no longer mounts the whole home folder into the sandbox;
  an engine download that stalls fails after 30 s and can be cancelled
  at any moment.
- **Windows**: file names are cut at the backslash in the slice sheet,
  the plate save and the saved toasts.

### Changed
- Tests run on every pull request (Rust unit tests, interface logic
  scripts, translation catalogs).

## [0.13.0] — 2026-10-22

### Added
- **Care & Tuning › Control** ([#17](https://github.com/kameka22/snap-studio/pull/17)):
  the printer's basic actions without G-code — home, a jog pad (X, Y, Z,
  0.1 to 50 mm), one card per head in its spool's colour (temperature
  gauge and target, activate, load, unload, extrude, retract), the bed's
  temperature, part and chamber fans, purifier, chamber light, a camera
  view, all heaters off, motors off, firmware restart and the emergency
  stop. Locked during a print (emergency stop, light and camera stay);
  each move once its axis is homed (as Klipper; a U1 homes X and Y
  together, Z after them, and picks a head or loads after homing X and Y
  itself), Z never under 0.5 mm, temperatures
  within each heater's maximum, one action at a time. Load and unload run
  the U1 feeder's own procedures, as its screen does (homing X and Y when
  needed, the filament's own temperature), and follow the head's filament
  sensor: Load once the filament is in the feed port of an empty head,
  Unload when the head holds filament. **Material & colour** declares a
  head's spool as the printer's screen does, from the list the printer
  itself holds (material, brand, type) and a colour; loading a spool
  without an RFID tag asks it first, so the printer heats to the right
  temperature (a tagged spool declares itself). Also opened from the
  printer's page (**Control**).
- **3D printer view** ([#34](https://github.com/kameka22/snap-studio/pull/34)):
  the printer's page shows the U1 in 3D (three.js, bundled with the app),
  over the whole page. Hover a part to highlight it; click a spool, a head,
  the bed or the chamber light to open its quick controls in a panel over
  the view (Control's compact components: temperature, load, unload,
  light), with **All controls** leading to Care & Tuning › Control on that
  head. Selecting a head turns the view to its spool's side, the bed or
  the light to the front; clicking the background deselects and turns
  back to the front.
  The Heads and spools card (top left) has one row per head (spool and
  its details, temperature, active, unloaded) plus the bed; a row selects
  its head. The print's status sits top centre. Left / Front / Right / Back, drag or ← → to turn,
  1–4 for a head, Esc to close. A quick bar for the light and the camera
  (shown in a corner of the view), the printer's details bottom right, and
  the emergency stop in the toolbar beside Control. Without WebGL the page
  keeps its 2D picture.

### Fixed
- The send sheet's options (timelapse camera, automatic bed leveling, flow
  calibration) now reach the U1: the print starts with them, as Snapmaker
  Orca does (`server.files.start_local_print`), instead of a command the
  firmware does not know. If the printer does not apply one, a dialog says
  so once the print has started
  ([#39](https://github.com/kameka22/snap-studio/pull/39)).
- Prepare's keyboard shortcuts no longer act on the plate while the slice
  preview covers it: Backspace there no longer removes the objects just
  sliced, and A, Q or R no longer arrange, orient or rotate them. Clear,
  Remove and undo now free the GPU memory of the meshes no object uses,
  instead of keeping every mesh loaded for the whole session
  ([#44](https://github.com/kameka22/snap-studio/pull/44)).
- Sheets opened while a Library site is shown (the queue's next print, an
  update, sign-in, share, rename, the welcome assistant) no longer sit
  invisible under the site, the app blocked behind their backdrop. In the
  printer form, Enter on a button (Cancel, Test, a found printer) is that
  button's click instead of a save, and the message after an edit says
  "updated" rather than "added". A corrupt stored setting no longer stops
  the app at launch ([#45](https://github.com/kameka22/snap-studio/pull/45)).
- Sites opened in the Library's tabs can no longer read local files
  through the app's own protocols (`gcode://`, `thumb://`, `mesh://`,
  `prn://`, `cam://`): only the app's window gets an answer. A malformed
  colour (a non-ASCII character in a preset, a file or the printer's
  report) no longer crashes slicing, file reading or the jobs monitor
  ([#46](https://github.com/kameka22/snap-studio/pull/46)).
- Mirrored objects are no longer sent to the slicer with scrambled
  triangles: a `-0.0` coordinate shifted every later triangle of the
  object in the 3MF. A preset whose parent is missing (a user preset from
  another Orca version) is now reported by name when slicing, instead of
  a partial configuration the engine failed on ([#47](https://github.com/kameka22/snap-studio/pull/47)).
- The QR share server caps request and header lines at 8 KiB and serves
  at most eight connections at once: a host on the network can no longer
  grow the app's memory with a line that never ends. Closing a Claude
  conversation now really ends its input, so Claude stops promptly, and a
  container conversation's container gets time to stop before the kill
  ([#48](https://github.com/kameka22/snap-studio/pull/48)).

## [0.12.0] — 2026-10-21

### Added
- **Prepare, reworked** ([#28](https://github.com/kameka22/snap-studio/pull/28)):
  - placement, rotation and scale as sliders (live 3D, one undo step per
    drag, 15° notches), each field can switch to typing; scale per axis
    X/Y/Z;
  - objects on or off the plate: only objects fully on it are sliced
    ("Slice 3 Objects"); off-plate objects are greyed, listed apart, and
    come back with + or Add All; Take All Off; an object sticking out can
    be recentered or excluded; drag and drop between the list and the bed;
  - off-plate objects are parked in rows beside the bed, no wider than it;
  - the object list floats over the bed, the inspector shows for one
    selected object;
  - range selection (Shift-click) and rubber band (⌘/Ctrl + drag);
  - the toolbar only shows buttons that can act;
  - a loading indicator while a large file is read and its objects load;
    messages show at the top of the view.
- **Display settings** ([#24](https://github.com/kameka22/snap-studio/pull/24)):
  - light, dark or system appearance; a forced mode also sets the window's
    own (title bar);
  - ten themes, each light and dark, with live previews: Snap Studio,
    Snapmaker Space, High contrast, Graphite, Deep Night, Paper, Nord,
    Solarized, Filament (the app takes the color of the spool on T0) and
    macOS (Tahoe-style glass layout);
  - accent color: the theme's, the system's, eight presets or a custom one;
  - color-blind safe colors, over any theme;
  - the 3D views and terminals follow the theme.

- **Care & Tuning**: Maintenance becomes a view with tabs, Care and **Bed
  Leveling** ([#21](https://github.com/kameka22/snap-studio/pull/21)):
  - the bed's mesh read from the printer and kept over time: 3D view and
    map, history, trend, comparing two measurements;
  - one card with the bed's state and the one thing to do; limits suited
    to the U1 (0.5 / 1 mm by default, three levels), a good bed said to be
    compensated by the mesh;
  - measuring with an assistant: the bed confirmed clear, a temperature
    proposed from the last print (never above the bed's maximum), each of
    the U1's steps with a countdown for the 2 min settle, a clean stop and
    an emergency stop, the result against the previous measurement; the
    bed is turned off if it fails, and a lost connection does not lose the
    measurement;
  - the bed's shape named and shown on the map, with what to do (the knobs
    under a U1's bed), and "I've fixed it: measure again";
  - reminders after 30 days or 50 prints; "Measure first" in the send
    sheet; the tabs of a printer's Files and of an AI conversation sit on
    the left.

### Fixed
- The app's window comes to the front at launch on macOS
  ([#28](https://github.com/kameka22/snap-studio/pull/28)).
- Dense models (from about 400,000 triangles, as some MakerWorld files) no
  longer show full of holes in Prepare, the 3D viewer and the thumbnails:
  they are simplified for display instead of keeping one triangle in so
  many. Slicing still uses the whole mesh
  ([#31](https://github.com/kameka22/snap-studio/pull/31)).

## [0.11.0] — 2026-10-20

### Added
- **A printer's files** — a *Files* entry under each printer, read live from
  the printer ([#20](https://github.com/kameka22/snap-studio/pull/20)):
  - print files as a list or a grid: thumbnail, duration, filament per head,
    size, last print result; search and sort;
  - Print (same sheet as after a slice: start there, queue it, or print it on
    another printer), Download, Rename, Delete; select several at once;
  - a bottom bar with the actions of the file selected;
  - timelapses with a player (streamed from the printer, speed 0.5×–4×,
    full screen, previous/next), download and delete — on a U1, through its
    camera service, never by guessing which video;
  - the heads a file uses are read from the G-code when the printer's
    metadata does not say, so a multicolor file is prepared as such.
- **Share** a print file or a timelapse: the macOS share menu (AirDrop,
  Messages, Mail…), a QR code to download it on a phone on the same Wi-Fi
  (local link, 15 minutes), the file on the clipboard, Save As.
- **Speed** in the slice sheet: one slider, 50–120 % of the profile, with
  marks (very safe, safe, profile, fast) and a ⚙ panel showing each speed
  and acceleration, profile → computed; rows can be set by hand; first layer
  and travel moves only on request; nothing is sent at 100 %
  ([#29](https://github.com/kameka22/snap-studio/pull/29)).

### Changed
- The slice sheet is laid out in three areas: printer, plate and quality on
  the left, adjustments on the right, heads and model colors below; heads as
  compact cards, two per row ([#29](https://github.com/kameka22/snap-studio/pull/29)).

### Fixed
- After a print sent with a head substitution, the printer's extruder map
  goes back to identity when the print ends (a print started from the
  printer's screen no longer inherits it).
- AI conversations: the details bar under the preview is read again at the
  end of each answer; a line of Claude's output that is not valid UTF-8 no
  longer makes the app start a second sandbox; Claude's exit code is shown
  when it stops.

## [0.10.0] — 2026-10-20

### Added
- **Spool check before sending** — before a print starts (send, or start from
  the queue), each color of the model is compared with the spool loaded on its
  head: material and color ([#15](https://github.com/kameka22/snap-studio/pull/15)).
  - When they differ, a sheet shows the print and one row per color: the
    expected color and the heads to print it with (✓ when the spool fits).
    Taking a head another color uses swaps the two.
  - **Send** routes each color to the head chosen, for this print only,
    through the printer's extruder map (the G-code is not rewritten).
  - **Edit in Prepare** brings the plate back to Prepare with the slice
    sheet open on the spools loaded now; from the queue, the queued print is
    replaced once the new slice is sent.
  - Colors compared with CIEDE2000; an unreachable printer stops the send;
    a printer that reports no spools is not checked.
- **AI conversations, reworked** ([#25](https://github.com/kameka22/snap-studio/pull/25)):
  - list with search, filters, sort, groups by date, pins, inline rename,
    duplicate, context menu and keyboard;
  - **Delete Conversation** also removes Claude's session files (never
    another session's, never `history.jsonl`);
  - preview and chat side by side, adjustable; details bar under the preview
    (versions, measurements, Save, Slice); Save tells whether the version
    shown is already saved; a Bed switch in the preview;
  - **Stop Claude** inside the message field, and Esc;
  - the **Terminal** tab shows the chat's own Claude session, live and read
    only, instead of starting a second one;
  - a new creation sheet: large description field, ideas, the file's
    thumbnail, destination folder, where it runs, and the **Claude model**.
- Queued print: "Print on" with one chip per printer and its state; the
  start options as switches.
- A landing page for the project ([#14](https://github.com/kameka22/snap-studio/pull/14)).

### Changed
- Every on/off setting uses a real switch, announced as such to screen
  readers; the printer camera is turned on and off with a switch
  ([#26](https://github.com/kameka22/snap-studio/pull/26)).
- AI in the sidebar always leads to the list of conversations.

## [0.9.0] — 2026-10-18

### Added
- **Maintenance** view per printer: usage, head counters (tool changes,
  errors, hotend), tasks by urgency with Snapmaker's guide and video, a log
  of what was done ([#12](https://github.com/kameka22/snap-studio/pull/12)).
- Choose the Claude model of an AI conversation.

### Fixed
- Small fixes: back from a print record, AI object placement, trackpad pan
  (⇧ + two fingers), update badge, camera controls ([#13](https://github.com/kameka22/snap-studio/pull/13)).
- The Slice button fits its label.

## [0.8.2] — 2026-10-18

### Added
- Linux ARM (arm64) packages ([#10](https://github.com/kameka22/snap-studio/pull/10)).

### Fixed
- Library on Linux: its pages show over the interface ([#10](https://github.com/kameka22/snap-studio/pull/10)).
- Heads chosen for supports, walls or infill are forgotten with the plate,
  and shown in the summary ([#11](https://github.com/kameka22/snap-studio/pull/11)).

## [0.8.1] — 2026-10-17

### Added
- The print's picture on the printer's screen (thumbnails in the G-code).
- Split an object into its parts in Prepare ([#9](https://github.com/kameka22/snap-studio/pull/9)).

### Fixed
- Prepare uses the right printer and its four heads ([#8](https://github.com/kameka22/snap-studio/pull/8)).

## [0.8.0] — 2026-10-17

### Added
- **Colors per object**: painted 3MF files keep their colors, and each color
  of each object goes to the head you pick ([#7](https://github.com/kameka22/snap-studio/pull/7)).

## [0.7.3] — 2026-10-17

### Fixed
- Printer discovery no longer freezes on busy networks ([#6](https://github.com/kameka22/snap-studio/pull/6)).

## [0.7.2] — 2026-10-16

### Fixed
- The Library no longer freezes on macOS.

## [0.7.1] — 2026-10-16

### Fixed
- Windows: no freeze when the Library opens; thumbnails shown through
  WebView2's protocol addresses ([#5](https://github.com/kameka22/snap-studio/pull/5)).

## [0.7.0] — 2026-10-16

### Added
- **Heads and spools** screen per printer, and the spools' live colors in
  Prepare ([#4](https://github.com/kameka22/snap-studio/pull/4)).
- Orca-style advanced slice settings and custom profiles ([#3](https://github.com/kameka22/snap-studio/pull/3)).
- Prepare asks to clear or keep a plate that is not empty ([#2](https://github.com/kameka22/snap-studio/pull/2)).

### Changed
- An offline printer shows a single "not connected" card ([#1](https://github.com/kameka22/snap-studio/pull/1)).

## [0.6.0] — 2026-10-14

### Added
- AI setup per mode (sandbox or this computer), checked in the welcome
  assistant and in Settings; Settings with a side menu; About.
- Library: several tabs per site; favorites as saved links.
- Project page: README, screenshots, contributing guide, code of conduct,
  security policy, GPL-3.0 license.

### Changed
- Clearer buttons; files no longer open in an external slicer.

## [0.5.0] — 2026-10-14

### Added
- AI chat view, Claude sign-in window, multicolor 3MF results.
- AI: create an object from scratch.
- The interface in English, with a French translation.

## [0.4.0] — 2026-10-13

### Added
- Built-in slicing engine (Snapmaker Orca 2.4.0): downloaded once, kept up
  to date by the app.
- G-code preview: material mode, paths as shaded ribbons.

## [0.3.0] — 2026-10-12

### Added
- Prints and queue, plate type choice, profile details.

### Changed
- Slice sheet redesigned: two columns, visual pickers.

## [0.2.0] — 2026-10-12

### Added
- Welcome assistant; printers found on the network.

## [0.1.1] — 2026-10-12

### Added
- First public version: a 3MF browser with thumbnails, Prepare, built-in
  slicing, packages for macOS, Windows and Linux, automatic updates.

[Unreleased]: https://github.com/kameka22/snap-studio/compare/v0.18.0...HEAD
[0.18.0]: https://github.com/kameka22/snap-studio/compare/v0.17.1...v0.18.0
[0.17.1]: https://github.com/kameka22/snap-studio/compare/v0.17.0...v0.17.1
[0.17.0]: https://github.com/kameka22/snap-studio/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/kameka22/snap-studio/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/kameka22/snap-studio/compare/v0.14.2...v0.15.0
[0.14.2]: https://github.com/kameka22/snap-studio/compare/v0.14.1...v0.14.2
[0.14.1]: https://github.com/kameka22/snap-studio/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/kameka22/snap-studio/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/kameka22/snap-studio/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/kameka22/snap-studio/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/kameka22/snap-studio/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/kameka22/snap-studio/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/kameka22/snap-studio/compare/v0.8.2...v0.9.0
[0.8.2]: https://github.com/kameka22/snap-studio/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/kameka22/snap-studio/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/kameka22/snap-studio/compare/v0.7.3...v0.8.0
[0.7.3]: https://github.com/kameka22/snap-studio/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/kameka22/snap-studio/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/kameka22/snap-studio/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/kameka22/snap-studio/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/kameka22/snap-studio/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/kameka22/snap-studio/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/kameka22/snap-studio/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/kameka22/snap-studio/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/kameka22/snap-studio/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/kameka22/snap-studio/releases/tag/v0.1.1
