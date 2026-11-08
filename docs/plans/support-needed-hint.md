# Prepare: telling whether a print needs supports

Merged in [#89](https://github.com/kameka22/snap-studio/pull/89)
(2026-11-04), in 0.19.0 (A and B with the overhang view, see
[Implementation](#implementation)). The in-app slice check in
[Tests](#tests) is still open. The question: in Prepare, before slicing,
can Snap Studio tell that an object will need supports, the way Snapmaker
Orca warns "It seems object X has floating regions"? And must that come from
the engine, or can we compute it ourselves?

Short answer:

- **Orca's warning is produced during the slice**, not in Prepare. It runs
  only when supports are **off**, and the engine's command line already
  reports it. Snap Studio receives it today and drops it.
- **Before slicing, Orca itself only colors the overhangs** ("Show
  overhang", a shader on face angles). It gives no warning there.
- **We can compute a good hint ourselves** from the mesh, in Rust, in well
  under a second. It is not the same test as Orca's, so it is a hint
  ("probably needs supports"), not a verdict.

Decided: both, in this pull request. A badge on the 3D view and an
overhang button before the slice, the engine's warning after it (see
[Decisions](#decisions)).

## How Snapmaker Orca does it

Checked in the 2.4.0 sources (`orca-v240`, tag `v2.4.0`) and on Snapmaker
Orca's `main` (`0438642`): the code is the same in both.

### When

`PrintObject::generate_support_material()` (`src/libslic3r/PrintObject.cpp:631`),
step `posSupportMaterial`, after the model is cut into layers and the walls
are made:

```cpp
if (!has_support() && !m_print->get_no_check_flag()) {
    m_print->set_status(50, L("Checking support necessity"));
    SupportNecessaryType sntype = this->is_support_necessary();
    if (sntype != NoNeedSupp) {
        // "floating regions" | "floating cantilever" | "large overhangs"
        std::string warning_message = Slic3r::format(L("It seems object %s has %s. "
            "Please re-orient the object or enable support generation."), ...);
        this->active_step_add_warning(WarningLevel::NON_CRITICAL, warning_message,
                                      PrintStateBase::SlicingNeedSupportOn);
    }
}
```

So the check needs the layers (`lslices`), which only exist once slicing
has started. It is skipped when supports are on, and with `--no_check`,
which Snap Studio does not pass.

### The test

`PrintObject::is_support_necessary()` (`PrintObject.cpp:4558`) runs
`TreeSupport::detect_overhangs(true)` as if supports were "tree (auto)",
whatever the profile says (`Support/TreeSupport.cpp:641`, the loop at 765-875). For each layer,
it compares the layer's outline with the one below:

- **Floating region ("sharp tail"):** a part of a layer with nothing under
  it in the layer below (a pendant, the tip of a downward spike, an island
  starting in the air). Any such region wider than a tenth of a line fails
  the check.
- **Floating cantilever:** an overhang (what sticks out further than
  `layer_height / tan(support_threshold_angle)` past the layer below) whose
  farthest point is more than 3 mm from its base is a cantilever. The
  warning needs one longer than **6 mm** (`cantilevel_dist_thresh`).
- **Large overhangs:** in the list of reasons, but `is_support_necessary()`
  never returns it: plain overhangs alone never trigger the warning.

A plain bridge (an overhang held on both sides) does not trigger it either.

### What the command line gives back

Checked with the 2.4.0 engine on this machine (Linux build) and four test
STLs, supports off, `--debug 3` as Snap Studio slices:

| Test model | Engine's answer |
|---|---|
| A 20 × 20 × 20 mm cube | nothing |
| A "T": a 10 mm column with a 50 mm arm on top (20 mm on each side) | `found NON_CRITICAL slicing warnings: It seems object T.stl has floating cantilever. …` |
| A column with an arm and a block hanging under the arm's end | `… It seems object pendant.stl has floating regions. …` |
| A 30 mm bridge between two pillars | nothing |

The slice **still succeeds**: the warning is a `[warning]` line of the log,
on stderr, one per object:

```
[…] [warning] plate 1: found NON_CRITICAL slicing warnings: It seems object T.stl has floating cantilever. Please re-orient the object or enable support generation.
```

On Linux, the engine also writes it in `result.json` (`sliced_plates[].warning_message`,
the last warning of the plate only) and in the `--pipe` progress JSON
(`"warning"`). `result.json` is only written by Linux builds
(`record_exit_reson`, `src/Snapmaker_Orca.cpp`), so the log line is the
only source on all three systems. The text is always in English (the
command line does not translate), with the object's name from the 3MF.

### What Snap Studio does with it today

Nothing. `slice.rs` keeps every log line that is not `[info]` or `[debug]`
(`progress_only`) and reads them only to explain a failure
(`engine_error`). On success the `[warning]` lines are dropped. The pipe
reader (`parse_progress`, `slice.rs:1133`) takes `"warning"` as a
progress message, which never reaches the sheet.

### Before slicing, in Orca

The Prepare view's **Show overhang** button (`GLCanvas3D::show_overhang`,
`m_slope`) colors in red the faces that point down more than the profile's
angle, with a shader (`slope.normal_z`). It says nothing about floating
regions or cantilevers and shows no warning. The warning only comes with
the slice, which Orca runs in the background as soon as the plate changes.
That is why it feels "upfront" in Orca.

## Computing it ourselves, before slicing

Snap Studio already reads every mesh in Rust (`mesh.rs`, up to 8 million
triangles whole) and already measures overhangs: auto-orientation
(`orient.rs`, a port of Orca's `Orient.cpp`) adds up the area of the faces
pointing down more than `support_threshold_angle` (`slice::support_threshold`).
Three tests can run on the mesh, in the orientation and scale it has on the
plate:

1. **Overhang faces.** A face whose normal is within the profile's angle of
   straight down, and that is above the first layer. Its area, and the
   largest connected patch of such faces. Cheap: one pass on the triangles.
2. **Floating points (Orca's "floating regions").** A vertex, or a flat
   patch, lower than all its neighbours and above the bed: something starts
   in the air there. Also a piece of the object (a connected part) whose
   lowest point is above the bed. Needs the vertices welded together
   (a hash on the coordinates) to know the neighbours: one pass, then a
   look at each vertex.
3. **Long overhangs (Orca's "cantilevers").** The hard one without layers.
   Approximation: the horizontal reach of a downward patch past the faces
   that hold it, measured on its outline. Or cut the mesh into a few dozen
   layers ourselves and compare outlines as Orca does (needs a polygon
   library such as `i_overlay` or `clipper2`).

### Speed

In Rust, on a background thread: tests 1 and 2 are linear in the triangle
count. Around 10 to 50 ms for 100 000 triangles, and about a second for a
few million (the vertex welding costs the most). They run on the full mesh,
not the decimated display mesh, and are run again only when an object is
added, rotated or scaled (moving it on the bed changes nothing). The red
coloring can stay in the GPU (a shader on the display mesh), so it follows
a rotation live at no cost.

### How close to Orca

- **Floating points and floating pieces:** the same fact Orca finds, read on
  the mesh instead of the layers. Very reliable. Misses below one layer
  (a dip of 0.1 mm), which Orca also ignores, need a tolerance about one
  layer high and one line wide.
- **Overhang faces:** exact, but they are not what Orca warns about. A
  bridge, a horizontal hole or a chamfered underside all count, and Orca
  prints them fine without supports. Used alone, the hint would cry wolf.
- **Cantilevers:** the approximation from the outline gets the clear cases
  (a "T", a shelf, an outstretched arm). It hesitates on mixed shapes, an
  overhang that is partly a bridge, curved undersides. Cutting our own
  layers would get closer, for much more code.
- Also outside the hint: painted support enforcers/blockers, raft, "on build
  plate only", per-object settings in a 3MF, tree versus normal supports.
  None of these change Orca's own check (it always tests as tree auto), so
  the hint keeps to the same rule.

## Options

### A. Show the engine's warning after the slice

Read the `[warning] … found NON_CRITICAL slicing warnings:` lines in
`slice.rs`, pick out the object name and the reason (floating regions,
floating cantilever, large overhangs), pass them with the preview
(`Progress.warnings`). The slice sheet / preview shows a banner, in the
app's language: "**Cat.stl** probably needs supports: parts start in the
air. [Turn supports on and slice again]".

- Exactly Orca's answer, on all three systems, a few dozen lines.
- Only after a slice: the user has already waited for it.
- Depends on the engine's English wording; a test pins it, and an unknown
  reason falls back to the raw text.

### B. A hint in Prepare from the mesh (tests 1 and 2, and a simple 3)

A Rust command (`plate_support_hint`, next to `plate_orient`) returns per
object: floating points (count, positions), floating pieces, the largest
overhang patch (area, reach), and a verdict: `none`, `maybe`, `likely`.

- `likely`: a floating point or piece, or a reach over 6 mm.
- `maybe`: large overhang patches only (could be bridges).
- `none`: otherwise.

In Prepare: a badge in the **bottom-left corner of the 3D view**
("Supports probably needed", decision 2), naming the object(s) and the
reason, with one quick button, **Turn supports on**, which switches
supports on in the slice settings (decision 4). Shown only when supports
are off and an object is `likely`.

- Upfront, live after a rotation, no engine run.
- A hint: wrong now and then on cantilevers and bridges.

### C. Our own layer check, as Orca's

Cut the mesh into layers in Rust and port Orca's sharp-tail and cantilever
tests (outlines, offsets, differences).

- Closest to Orca before slicing.
- A polygon library and a few hundred lines to keep in step with Orca; a
  second slicer inside the app, for a hint.

### D. A quiet background slice

Slice the plate in the background whenever Prepare changes, as Orca's GUI
does, and show the warning in Prepare.

- Orca's exact answer, upfront.
- A full slice each time (seconds to minutes, CPU and fans), and G-code
  thrown away. Too costly for a hint.

### Overhang view (goes with B)

A **"Show overhangs" button** in Prepare's view tools, off by default and
never turned on by itself (decision 3): faces past the profile's
angle in red, like Orca's. Done in the display shader (world normal against
the angle), so it follows rotations live, and it explains the badge.

## Decisions

Taken by kameka22 on the draft PR (2026-11-04):

1. **A and B together, in this pull request.** The engine's warning after
   the slice (A) and the hint in Prepare (B), with the overhang view. B
   uses tests 1 and 2 (floating points and pieces, which agree with Orca)
   plus the simple reach test for cantilevers. Large overhangs alone stay a
   `maybe`, visible only in the overhang view, never as a badge, so bridges
   do not cry wolf. Worded "probably": the slice's warning (A) has the last
   word. C and D are not planned.
2. **The badge sits on the 3D view, in the bottom-left corner** of
   Prepare's viewport, not in the object list or the inspector. One badge
   for the plate: it names the object (or "{n} objects") and the reason;
   hovering it outlines the objects concerned.
3. **The overhang view is a button**, a toggle in Prepare's view tools. It
   is never switched on automatically.
4. **The quick fix only turns supports on**: no suggestion to auto-orient.
   In Prepare the badge's button turns supports on in the slice settings;
   after a slice, the banner's button turns them on and slices again.

Still open: the French wording (see [Texts](#texts-en--fr-to-review)).

## Impact on the code

- `src-tauri/src/slice.rs`: parse the warning lines from the kept log
  (`support_warnings(&logs) -> Vec<SupportWarning { object, reason }>`), a
  `warnings` field in the `preview` progress; tests on the real lines above.
- `ui/slice.js`: the banner in the preview, its button (turn `s-supports`
  on, slice again).
- `src-tauri/src/orient.rs` or a new `support_hint.rs`: tests 1 to 3 on the
  transformed mesh, with Rust tests on the four models above (cube, T,
  pendant, bridge) and a floating piece.
- `src-tauri/src/lib.rs`: `plate_support_hint`, like `plate_orient`.
- `ui/prepare.js` and `ui/index.html`: the badge in the bottom-left corner
  of the 3D view, the outline of the objects on hover, its button (supports
  on); the request after add / rotate / scale (debounced), only when
  supports are off.
- `ui/viewer.js` or Prepare's materials: the overhang shader, and its
  button in Prepare's view tools.
- `ui/i18n/*.json`: the banner, the three reasons, the badge, the tooltip,
  the button, the toggle, in the 9 languages.

## Texts (EN / FR), to review

| Key | EN | FR |
|---|---|---|
| Badge | Supports probably needed | Supports probablement nécessaires |
| Reason: floating | Parts start in the air | Des parties commencent dans le vide |
| Reason: cantilever | A long overhang sticks out | Un long porte-à-faux dépasse |
| Banner | {name} probably needs supports: {reason}. | {name} a probablement besoin de supports : {reason}. |
| Badge, several objects | {n} objects probably need supports | {n} objets ont probablement besoin de supports |
| Badge button | Turn supports on | Activer les supports |
| Banner button | Turn supports on and slice again | Activer les supports et redécouper |
| View toggle | Show overhangs | Afficher les surplombs |

## CHANGELOG (added under Unreleased)

Under *Unreleased*, *Added*:

- **Supports hint**: in Prepare, a badge in the corner of the 3D view says
  when an object probably needs supports (parts starting in the air, a
  long overhang), with a button to turn supports on, and a "Show overhangs"
  button colors its overhangs in red; after a slice without supports, the
  engine's warning that an object needs them is shown, with a button to
  turn supports on and slice again.

## Open questions

1. The French texts above: "porte-à-faux", "surplombs", "commencent dans
   le vide" — used as proposed, to be reviewed.

## Implementation

- **A** (`slice.rs`): `support_warnings` reads the `found NON_CRITICAL
  slicing warnings: It seems object … has …` lines of the kept log, once
  per object and reason (`floating`, `cantilever`, `overhangs`, `other`
  with the engine's sentence), into `Progress.warnings` of the `preview`
  phase. The preview panel shows them in a banner above the summary; its
  button goes back to the plate's Slice sheet, turns supports on and slices
  again (`sliceWithSupports`).
- **B** (`support_hint.rs`, `plate_support_hint`): the mesh as placed
  (scale and rotation, resting on the bed), read whole up to 3 million
  triangles, welded on exact coordinates.
  - Floating: vertices taken from the lowest up, each growing its region
    within a layer (0.2 mm) above it; a region that reaches lower ground is
    not a low point. A low point above the first layer is floating unless
    another shell of the object is right under it (nearest face below
    pointing down, or above pointing up: right where shells touch or
    overlap).
  - Cantilever: overhang faces (past the angle, above the first layer)
    grouped in patches by their edges. The corners of each patch's outline
    (where it turns, seen from above, as Orca's contour points) are measured
    to the nearest anchor holding them one layer down: a wall going down
    from the patch's edge, another shell under the patch, a lower part of
    the patch itself, or the bed. Over 6 mm: `cantilever`. A bridge is held
    at its corners; a gentle slope is held layer by layer.
  - Verdict `likely` (floating first, then cantilever), `maybe` (overhang
    area over 100 mm², not shown), `none`. About 45 ms for 160 000
    triangles.
  - Prepare asks for the objects on the plate whose key changed (mesh,
    tilt, scale, angle; a move or a turn around Z keeps the hint), 400 ms
    after the last change, only while supports are off. The angle is the
    advanced settings' `support_threshold_angle` if changed there, else the
    profile's.
- **Badge**: bottom-left of the 3D view, the object list shortened above
  it and the view's hint line hidden while it shows. Hovered, the objects
  it names get an orange box. "Turn supports on" sets them on in the
  machine's remembered adjustments (as switched by hand on the sheet).
- **Overhang view**: a toggle in the view tools (off at each launch). The
  camera never goes below the bed, where undersides would show: besides
  the red on visible faces, a second pass draws the hidden overhangs
  hatched, through what covers them (their outward side from the winding).

## Tests

- Rust: the warning parser on the real log lines (cantilever, floating
  regions, an unknown reason, two objects); the hint on the test models
  (cube none, T likely, pendant likely, bridge none or maybe, a piece in
  the air likely), and after a rotation.
- In the app: a slice of the T with supports off shows the banner, its
  button slices again with supports; the badge (bottom left of the 3D view)
  comes and goes with a rotation and with supports on, its button turns
  supports on; the overhang button colors and uncolors the overhangs.
