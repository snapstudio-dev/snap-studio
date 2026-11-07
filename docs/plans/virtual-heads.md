# Virtual heads (color mixing, "Full Spectrum")

## Goal

The U1 has four heads, so a plate has at most four colors. Snapmaker Orca
2.3.6+ adds **Full Spectrum**: a *mixed filament* made of two loaded
filaments that the engine alternates layer by layer, so that the eye sees a
third color (cyan + yellow → green). Our bundled engine, Snapmaker Orca
2.4.0, already contains it; Snap Studio only has to describe the mixes and
assign them.

Snap Studio gets **virtual heads**:

- created in **Heads and spools** from two loaded heads and one ratio, in a
  sheet that shows the two heads pointing to the new color;
- offered next to T0–T3 in every head picker of Prepare (both association
  modes) and in the slice sheet's read-only map;
- sent to the engine as Orca's mixed filaments, so the G-code alternates the
  two heads;
- **deleted automatically** when one of their two spools is unloaded: what
  used it becomes **« sans tête »** and the slice waits for a choice; the
  user is told once, at creation, with « Ne plus afficher ».

Prepare's head choice also changes: today every color row shows the four
head tokens; it will show **only the chosen head**, and a click opens the
head popover, virtual heads included.

The printed color is an **optical mix**: stacked thin layers, not melted
plastic. The swatch is a forecast, not a promise (see "Preview color").

## How Snapmaker Orca does it (source read at `v2.4.0`)

All in [Snapmaker/OrcaSlicer](https://github.com/Snapmaker/OrcaSlicer/tree/v2.4.0),
user guide on the [Snapmaker wiki](https://wiki.snapmaker.com/en/snapmaker_orca/snapmaker_orca_full_spectrum),
walkthrough on the [Snapmaker blog](https://blog.snapmaker.com/blog/getting-started-with-full-spectrum-slicing/).

- **Model** — `src/libslic3r/MixedFilament.hpp`, `struct MixedFilament`:
  `component_a` / `component_b` (1-based *physical* filament IDs),
  `mix_b_percent` (share of B, integer 0–100), `ratio_a` / `ratio_b` (layer
  cadence), `distribution_mode` (`LayerCycle` 0, `SameLayerPointillisme` 1,
  `Simple` 2, the default), plus manual patterns (`"112"`), 3+ color
  gradients, per-component XY bias, `enabled`, `deleted`, `custom`,
  `stable_id`.
- **Virtual IDs** — `MixedFilamentManager`: *"Virtual filament IDs are
  numbered starting at (num_physical + 1). For a 4-extruder printer the
  first mixed filament has ID 5"*. IDs enumerate the **enabled** rows in list
  order (`mixed_index_from_filament_id`); a volume, a part or a painted
  facet simply uses extruder 5, 6…. Total limit `MAXIMUM_FILAMENT_NUMBER` =
  64 (`libslic3r.h`).
- **Slicing** — `MixedFilamentManager::resolve(filament_id, num_physical,
  layer_index, …)` turns a virtual ID into a physical one per layer:
  `pos = layer_index % (ratio_a + ratio_b); pos < ratio_a ? A : B`. The
  G-code therefore only contains `T0`…`T3`, one tool change per alternation.
  `PrintApply.cpp` pre-creates the regions of both components
  (`append_mixed_component_extruders`).
- **Ratio** — for custom rows, `compute_gradient_ratios` (called from
  `apply_gradient_settings`) derives the cadence from `mix_b_percent`: the
  minority side gets **one layer**, the majority
  `round(major% / minor%)` layers, then the pair is reduced by its GCD. So
  50 → 1:1, 33 → 2:1, 25 → 3:1, 20 → 4:1; 60 % and 67 % both give 2:1. The
  real steps are whole cadences, not percents. (Height-weighted mode and
  "advanced dithering" change this; both are off by default and stay off.)
- **Settings** — one project/print string key, `mixed_filament_definitions`
  (`PrintConfig.cpp`), `;` between rows, `,` between fields, written by
  `MixedFilamentManager::serialize_custom_entries()`:
  `a,b,enabled,custom,mix_b_percent,pointillism,g<ids>,w<weights>,m<mode>,z<sublayers>,xa<off>,xb<off>,d<deleted>,o<origin_auto>,u<stable_id>[,cm<ui_mode>][,r1/<start>/<end>][,<pattern>]`.
  `Print::apply` (`PrintApply.cpp`) reads it from the full config, calls
  `auto_generate(colors)` then `load_custom_entries(defs, colors)`. Rows
  whose components are out of range or equal are skipped. Auto-generated
  50/50 pairs only exist when `MixedFilamentManager::set_auto_generate_enabled`
  is on (a GUI preference; off by default in libslic3r, so off in the CLI),
  and are appended *after* the serialized rows anyway.
- **3MF** — `bbs_3mf.cpp` `max_supported_filament_id_from_project_config`:
  when a project declares `filament_colour`, extruder IDs above the physical
  count are only accepted if `mixed_filament_definitions` declares them.
- **Removing a filament** — `MixedFilamentManager::remove_physical_filament`:
  *"Any mixed filament that contains the removed component is deleted."*
  The same rule as asked here.
- **Display color** — `compute_mixed_filament_display_color` →
  `blend_color` → `filament_mixer_lerp` (`filament_mixer.cpp`,
  `filament_mixer_model.h`): a pigment-like mixer, *"degree-4 polynomial
  regression trained to approximate Mixbox"*, **MIT** licensed (Justin
  Hayes). Blue + yellow gives green, not grey.
- **Advice** — same material for both (PLA with PLA; *"PLA and PETG or PLA
  and PVA … should not be used together"*), translucent filaments, layer
  height 0.1 mm or less (the bundled profile
  `0.10mm Color Mixing @Snapmaker U1 (0.4 nozzle)`), 0.4 nozzle or smaller.

What we take: two components, a ratio expressed as Orca's whole cadences,
layer alternation (`Simple`), the engine's string key, the same deletion
rule, the same mixer for the swatch. What we leave out (for now): manual
patterns, 3+ color gradients, pointillism, bias, Local-Z, auto-generated
pairs.

## What Snap Studio has today

- **Heads state** — `ui/heads.js`: `localStorage["snapstudio.heads"]`,
  per printer `{ filaments: [profile…], map: { file: { ext: head } } }`;
  `headsSlots(pid)` (spools read: `{ index, present, kind, color, … }`),
  `headsSetSlots`, `headsRefreshSlots`, `headsCount`, `headsResolve`,
  `headsProfile`, `headsPickProfile`; event `headschange`. The **Heads and
  spools** view is `hvRender()` (`#hv-grid`, one `.sl-headcard` per head).
- **Head pickers** — `ui/swatch-logic.js` `swHeads`, `swEntries`, `swEdge`,
  `swMove`; `ui/slice-ui.js` `headToken`, `swToken`, `openGrid`,
  `openSwatches` (the head popover, #58).
- **Prepare** (`ui/prepare.js`): `prHeads(o)`, `prSetHead(o, ext, h)`
  (by object); `prColourBanner`, `prSetColourHead(ext, h)`,
  `PR.colourHeads`, `prSetPick`, `prColourPalette` (by colour, #52, with
  `prAssocSwitch` / `#assocmodal` explained once with « Ne plus afficher »);
  `prSliceHeads(o)` (what the slice gets); `prShownHeads` + `prHeadColors`
  (the 3D view's shader, `uHeadCol[17]`). The object row
  (`prRenderInspector`, `headToken` loop near the `.p-toks` span) and the
  colour banner each draw **all n tokens**.
- **Prime tower** — `ui/prepare-tower.js` `prTowerHeads()` (heads the plate
  prints with), `prTowerState`; `ui/slice-adv.js` `advTowerHeads`,
  `advWarnHeads`, `advHeadChoices` (per-feature heads), `spTowerAdvice`
  (materials that do not bond, `ui/spoolcheck*.js`).
- **Slice sheet** — `ui/slice.js` `renderHeads` (`#s-heads`, 4 profile
  selects = the 4 physical filaments sent), `renderModelMap` (read-only map
  from Prepare), `slUsedHeads`, request building (`filaments`, `colors`,
  `scene[].extruder_map`).
- **Engine** — `src-tauri/src/slice.rs` `SliceRequest` (`extruder_map:
  Vec<u8>` = head 0–3 per model extruder, `overrides`), the CLI call
  (`--load-settings machine;process --load-filaments f0;f1;f2;f3`);
  `presets::prepare` merges `overrides` into the process JSON;
  `plate::write_scene` / `write3mf::write_multipart` write
  `extruder = head + 1` (clamped 1–16); `plate::save_scene` writes
  `Metadata/project_settings.config` for the tower.
- **Spool check** (`ui/spoolcheck.js`): compares the G-code's tools with the
  spools before sending, remaps through `SET_PRINT_EXTRUDER_MAP`.

## Data model

Per printer, next to `filaments` and `map` in `snapstudio.heads`:

```js
virtual: [{ uid: 3, a: 0, b: 2, pct: 33 }],  // a, b: physical heads 0–3; pct: share of b
nextUid: 4,
```

- **Value of a virtual head** in every head field (`o.heads[ext]`, `o.pick`,
  `PR.colourHeads[ext]`, `map[file][ext]`, picker values): **`100 + uid`**.
  A number like the physical ones, never confused with one (heads are < 16),
  stable when another virtual head is deleted. A value whose uid no longer
  exists is an **orphan**: it is kept as it is and means « sans tête »
  (see "Unloading"). Helpers in a new pure file
  `ui/virtual-logic.js`: `vhIs(h)`, `vhUid(h)`, `vhOf(pid, h)`,
  `vhComponents(h)` → `[a, b]`, `vhPhysical(set)` (expands a set of heads to
  the physical ones).
- **Display name**: `V1`, `V2`… by creation order among the printer's
  current virtual heads (recomputed, not stored). Subtitle: `T0 + T2 · 2:1`.
- **Limit** (decided): **8 virtual heads per printer** (Orca allows 60 on a U1; eight
  keeps the popover to three short rows, and `write3mf`'s 1–16 clamp holds).
  The "+" is disabled at 8 with a tooltip.
- **Per printer**, not per plate: like the heads' profiles. A plate only
  refers to them. Without a printer (`_none`) there are no virtual heads:
  their color needs the spools.

## The ratio and its slider

The slider has **7 notches** (decided: 4:1 to 1:4), the cadences Orca can
really print:

| Notch | Cadence A:B | `pct` (share of B) | Caption |
|---|---|---|---|
| 1 | 4:1 | 20 | « 4 couches de T0 pour 1 de T2 » |
| 2 | 3:1 | 25 | … |
| 3 | 2:1 | 33 | … |
| 4 | 1:1 | 50 | « 1 couche de chaque » (default) |
| 5 | 1:2 | 67 | … |
| 6 | 1:3 | 75 | … |
| 7 | 1:4 | 80 | … |

- One `<input type="range" min=1 max=7 step=1>` styled like our sliders
  (#28), with tick marks, the A head's color at the left end and B's at the
  right, a thumb in the current mix color. Dragging toward a side gives that
  side more layers ("increase the intensity of one side"). Arrows, Home/End
  work; the value is announced as the caption.
- Stored `pct` is exactly 20/25/33/50/67/75/80, so Orca's
  `compute_gradient_ratios` gives back the same cadence. 4:1 is the end: past
  it the minor color barely shows (and Orca's own presets stop around there).
- `vhNotch(pct)` / `vhPct(notch)` / `vhCadence(pct)` in `virtual-logic.js`,
  tested against Orca's formula (`round(major/minor)`, GCD).

## Preview color

- Computed by a Rust port of Orca's MIT mixer (`filament_mixer_model.h`) in a
  new `src-tauri/src/mixcolor.rs`, with its MIT notice kept in the file
  header (compatible with our GPL-3.0). Tauri command
  `mix_colors(a: "#rrggbb", b: "#rrggbb", shares: [f32]) -> Vec<String>`:
  the sheet asks the seven notches at once when the two heads are chosen,
  so dragging is instant. Same input as Orca (`t` = share of B), so our
  swatch matches Snapmaker Orca's.
- The UI falls back to linear-light RGB interpolation while the answer
  comes (and in the browser tests).
- Golden tests: blue `#002185` + yellow `#fcd300` at 0.5 → `#2f8d38` (the
  header's own example), plus a few pairs checked against Orca.
- **Caveat**, as a small line under the swatch: « Aperçu indicatif : le
  mélange se fait couche par couche et dépend des filaments, de la hauteur
  de couche et de la lumière. » Same idea as Snapmaker's warning. Top and
  bottom flat surfaces show a single layer, hence one of the two colors:
  said in the info popover (ⓘ), not in the sheet.

## Heads and spools: the section and the sheet

### Section

Under the four head cards (`hvRender`), a **"Virtual heads"** section:

- one card per virtual head, same size as `.sl-headcard`: a **split spool**
  (mix color in the middle, a ring half A half B), `V1`, `T0 + T2 · 2:1`,
  and two icon buttons: edit (opens the sheet filled in) and delete
  (confirms if a plate uses it; what used it becomes « sans tête », as on
  unloading);
- a dashed **"+ Virtual head"** card, disabled with a reason when fewer than
  two heads hold a spool whose color is read, when the printer is offline
  and its spools were never read, or at 8;
- a ⚠ on a card whose two materials no longer bond (a spool changed), same
  wording as the tower advice.

### Creation sheet

Mockup: [`docs/mockups/virtual-heads/index.html`](../mockups/virtual-heads/index.html)
(captures `mockup-light-en.png`, `mockup-dark-en.png`).

```
┌ New virtual head ──────────────────────────── ✕ ┐
│   ┌────────┐                       ┌────────┐   │
│   │ ◉ T0   │                       │ ◉ T2   │   │
│   │ PLA    │                       │ PLA    │   │
│   │ Cyan ▾ │                       │ Yellow▾│   │
│   └───┬────┘                       └────┬───┘   │
│        ╲_____________     _____________╱        │
│                      ╲   ╱                      │
│                     ┌─────┐                     │
│                     │  ◉  │  V1                 │
│                     └─────┘  Green · #6FB24A    │
│   T0 ●──┬──┬──┬──◆──┬──┬──● T2                  │
│        1 layer of each (50 % / 50 %)            │
│   Indicative preview: …                     ⓘ   │
│                          [Cancel] [Create]      │
└─────────────────────────────────────────────────┘
```

- **Two head cards** at the top, left (A) and right (B): the spool, `Tn`,
  material, color name. Each is a button opening the head popover
  (`openSwatches`) with only the loaded heads; the other card's head is
  **disabled** there (same head twice is not possible). Prefilled with the
  first two loaded heads.
- **Two lines** (inline SVG, 2 px, the theme's muted stroke, ending in a
  small arrow head) go from the bottom of each card to the **virtual swatch**
  below, in the middle: a 64 px spool in the mix color, `V<n>`, color name
  (`colorName`) and hex. The lines take each head's color at their start
  and fade to the mix's: the eye reads "these two make this one". They
  reflow with the sheet width; `prefers-reduced-motion` drops the color
  transition.
- **The slider** under the swatch, as above; caption under it.
- **Materials** (decided): both spools' families compared with
  `spTowerAdvice`'s bonding rule. Not bonding (PLA + PETG, PLA + PVA…): an
  inline warning and **Create disabled** — Snapmaker says not to mix them. Same family, a
  different finish (PLA + PLA Silk): allowed, a short hint.
- **Duplicate**: same pair and same notch as an existing one → Create
  disabled, « Identique à V2 ».
- Live: changing a head or the notch updates swatch, lines, caption at once.
- **Edit** opens the same sheet titled « Modifier V1 », button « Enregistrer »;
  changing a component of a used virtual head is allowed (it is still the
  same head for the plate).

### The explanatory sheet (« Ne plus afficher »)

On the first **Create** (not on edit), before creating, a small sheet built
like `#assocmodal`:

> **Une tête virtuelle dépend de ses deux bobines**
> V1 mélange T0 et T2. Si vous déchargez l'une des deux bobines, V1 est
> supprimée automatiquement : ce qui l'utilisait se retrouve sans tête, et
> la découpe attend que vous en choisissiez une.
> ☐ Ne plus afficher        [Compris]

EN: "A virtual head depends on its two spools … ☐ Don't show this again
[Got it]". Stored in `PRUI` (`vhExplained`), like `assocExplained`. Cancel
(✕, Esc) goes back to the creation sheet without creating.

## Head pickers: virtual heads everywhere a color gets a head

- `swatch-logic.js`: `swVirtual({ list, slots })` gives picker entries
  `{ value: String(100 + uid), h: null, v: { n, a, b, pct }, color, state:
  "ok" | "warn" }`; `swEntries` keeps a stored value no entry matches as
  "unavailable", as today, virtual values included.
- `openSwatches` gets an optional second section **« Têtes virtuelles »**
  under the physical heads, and an optional foot **« Créer une tête
  virtuelle… »** (opens the sheet; once created, the new head is picked for
  the row that opened it).
- `headToken` / `swToken`: a virtual token is `V1` with the split dot (mix
  color, A/B ring); tooltip `V1 · T0 + T2 · 2:1 · Green`.
- **Offered in**: Prepare's object rows and colour banner, the by-colour
  palette (`prColourPalette`, whole-object pick).
- **Not offered** in the per-feature fields (`advHeadChoices`: walls,
  infill, supports, `wipe_tower_filament`) nor for the tower: Orca resolves
  mixes for painted/assigned regions, and a tower or support in two
  alternating materials helps nobody.
- The slice sheet's model map (`renderModelMap`) shows the virtual token
  read-only, like the others.

## Prepare: only the chosen head

Today each color row (object rows in "by object" mode, the banner in "by
colour" mode) shows T0…T3 as tokens, the chosen one lit. It becomes:

- **one token**: the chosen head (physical or virtual), as a button with a
  small ▾. Click, Enter or Space opens the head popover under it, chosen
  head focused, physical heads then virtual heads then "Create…". Picking
  calls the existing `prSetHead` / `prSetColourHead`; Esc closes.
- An **unmapped** color (by colour), or one whose virtual head was deleted
  (either mode), shows a dashed « Choisir » token in the warning color
  instead of four unlit ones, with the `sans tête` tag.
- A deduced head (not the user's own choice) keeps today's look difference
  (`own` false → the token is outlined, not filled).
- The row is shorter, so the floating list (#28) shows more objects; the
  object row's `p-dots` stay.
- A single-head printer: the token is shown, not a button (no choice), as
  `plPalette`'s `single` today.
- Same in both modes; the mode switch and its migration
  (`plMigrateToColour`, `plMigrateToObject`) carry virtual values as they
  are.

## Slicing

- **Request** — `SliceRequest` gets `virtual_heads: Vec<VirtualHead { a: u8,
  b: u8, pct: u8 }>`: only the virtual heads the plate uses, in a stable
  order (by uid). The UI maps each virtual value to head index `4 + k`
  (`n + k` for an n-head machine) in `scene[].extruder_map` /
  `extruder_map`, so the 3MF writes `extruder = n + k + 1` = Orca's virtual
  ID. `extruder_map` stays `Vec<u8>`; `rewrite_centered`'s `.min(15)` and
  `write3mf`'s clamp allow 12 virtual IDs on a U1.
- **Definitions** — a new `slice::mixed_definitions(&[VirtualHead], n)`
  builds the string, one row per head:
  `{a+1},{b+1},1,1,{pct},0,g,w,m2,z0,xa0,xb0,d0,o0,u{k+1}`
  (custom = 1 so the cadence comes from `pct`; `Simple` mode; no bias).
  Golden test against Orca's `serialize_custom_entries` format
  (`tests/libslic3r/test_mixed_filament.cpp` round-trips rows; it also
  loads short rows such as `"1,2,1,1,50,1"`; zero offsets are written
  `xa0`). Put in the process overrides (`presets::prepare`), so it
  reaches `Print::apply`'s full config; **verify** on the real engine that
  the CLI keeps the key from the process JSON. If it does not, write it in
  the plate 3MF's `Metadata/project_settings.config` (with `filament_colour`,
  which the 3MF loader then needs to accept IDs above 4).
- `--load-filaments` stays the four physical profiles; no virtual profile.
- **Saved plate** (`plate::save_scene`): the same key plus
  `filament_colour` in `project_settings.config`, so the 3MF opens in
  Snapmaker Orca with its mixes.
- **Colors** — `head_colors` / `plate_mesh` (G-code images) and
  `prHeadColors` (3D view) give a virtual head its mix color.
- **Layer height hint** — when the plate uses a virtual head and the layer
  height is above 0.12 mm, Quality shows « Pour un mélange régulier,
  choisissez 0,10 mm ou moins » (Snapmaker's advice; no change made for the
  user).
- **G-code** — tools stay `T0`–`T3`. Real-engine test: a 10 mm cube on V
  (T0 + T2, 2:1) at 0.1 mm alternates `T0 T0 T2` by layer.

## Unloading: automatic deletion

- Where: `headsSetSlots(pid, slots)`, when a slot read from the printer
  goes from `present: true` to `present: false` and a virtual head uses it.
  Only a **read** that says "empty" counts: an offline printer, a failed
  read or no spool data never deletes anything. A spool swapped for another
  (still present) keeps the virtual head; its color is recomputed, and the
  materials ⚠ appears if they no longer bond.
- **What used it becomes « sans tête »** (decided), in both association
  modes and wherever it is stored (objects' `heads` and `pick`,
  `PR.colourHeads`, the per-file `map`). No head is guessed: the mix was a
  deliberate choice, and printing the remaining component alone would give
  a color the user did not pick.
  - The stored value is **kept as an orphan** (`100 + uid` of a deleted
    head) rather than erased: `vhOrphan(h)` is true, every reader treats it
    as "no head". In "by object" mode this is new: `prHeads` must **not**
    fall back to the deduced head (`headsResolve`) for an orphan, otherwise
    the row would silently get one.
  - Picking a head on the row replaces the orphan, as any choice does.
- **Blocking**, with what exists for "by colour" today:
  - `prBlockers()` gains `orphans: [{ o, ext }]` in **both** modes (today it
    only reports in "by colour" mode); `prStatus` counts them, so **Slice is
    disabled** and its tooltip says why (`prepare.tip.orphan`: « 2 couleurs
    n'ont plus de tête : choisissez-en une dans la liste »).
  - The row shows the dashed « Choisir » token and the `sans tête` tag; in
    "by object" mode the object row unfolds so the color is visible; the
    colour banner (by colour) lists it like an unmapped color.
  - The slice sheet, if open or opened from elsewhere (the printer view,
    Library), refuses the same way: its Slice button disabled and a line
    above it, « Des couleurs n'ont plus de tête : retournez dans Préparer
    pour en choisir une », with « Ouvrir Préparer ». `renderModelMap` shows
    the « Choisir » token read-only for those colors.
  - Switching association mode carries orphans as they are (they stay
    blocking).
- **Notice**: one toast per read, grouped: « T2 a été déchargée : V1
  (T0 + T2) a été supprimée. 3 couleurs n'ont plus de tête : choisissez-en
  une pour découper. » with « Voir dans Préparer » when Prepare is not open.
  Not undoable (the spool is gone); creating it again is two clicks.
- The same rule applies when the user **deletes** a virtual head by hand
  (after a confirmation: « 3 couleurs utilisent V1. Elles n'auront plus de
  tête jusqu'à ce que vous en choisissiez une. »), and when a plate refers to
  a uid that does not exist (an old plate, another printer).
- A printer with fewer heads than a component (`headsCount`) deletes it too.

## Decisions (from the review of the spec)

1. Unloading a component: what used the virtual head becomes « sans tête »
   and the slice is blocked until a head is chosen (no fallback to the
   remaining head).
2. Materials that do not bond: creation is blocked.
3. Limits: 8 virtual heads per printer; slider from 4:1 to 1:4.

## Interactions

- **Prime tower** (#36) — `prTowerHeads` and `advTowerHeads` expand virtual
  heads to their two components (`vhPhysical`): a plate printed with V1
  alone uses two heads, so the tower box appears and the slice sheet treats
  it as multi-head. When the tower is off and a virtual head is used, the
  tower row says « Une tête virtuelle change de tête à chaque couche : la
  tour d'amorçage est conseillée. » Nothing is turned on for the user.
- **Materials alert** (`spTowerAdvice`, `advWarnHeads`) — gets the expanded
  heads; a virtual head whose materials do not bond is flagged in pickers.
- **Spool check before sending** (`spoolcheck.js`) — the slice record keeps
  the virtual heads' composition; the check compares the physical tools of
  the G-code, as today. Its sheet lists a virtual head's colors under its
  two heads (« V1 → T0 + T2 »). Rerouting a component through the extruder
  map is allowed and changes the mix, which the sheet says.
- **Basic / Advanced** (#63) — nothing hidden in Basic: virtual heads are a
  head choice, not a setting.
- **Plates** — virtual values are saved with the plate like heads (`prSave`);
  multi-plate (#18) and by-object printing (#22) need nothing more.
- **AI tab, printer 3D view, Control** — show physical heads only.

## Texts (FR / EN)

`ui/i18n/en.json` and `fr.json`, keys under `heads.virtual.*` (names are
suggestions):

| Key | EN | FR |
|---|---|---|
| `heads.virtual.title` | Virtual heads | Têtes virtuelles |
| `heads.virtual.add` | Virtual head | Tête virtuelle |
| `heads.virtual.new` | New virtual head | Nouvelle tête virtuelle |
| `heads.virtual.edit` | Edit {name} | Modifier {name} |
| `heads.virtual.create` | Create | Créer |
| `heads.virtual.save` | Save | Enregistrer |
| `heads.virtual.cadence_even` | 1 layer of each | 1 couche de chaque |
| `heads.virtual.cadence` | {na} layers of {a} for 1 of {b} | {na} couches de {a} pour 1 de {b} |
| `heads.virtual.preview_note` | Indicative preview: the mix is made layer by layer and depends on the filaments, the layer height and the light. | Aperçu indicatif : le mélange se fait couche par couche et dépend des filaments, de la hauteur de couche et de la lumière. |
| `heads.virtual.same` | Same as {name} | Identique à {name} |
| `heads.virtual.no_bond` | {ka} and {kb} do not bond: choose two spools of the same material. | {ka} et {kb} n'adhèrent pas entre eux : choisissez deux bobines du même matériau. |
| `heads.virtual.need_two` | Load two spools to mix their colors. | Chargez deux bobines pour mélanger leurs couleurs. |
| `heads.virtual.max` | Up to {n} virtual heads. | {n} têtes virtuelles au maximum. |
| `heads.virtual.explain.title` | A virtual head depends on its two spools | Une tête virtuelle dépend de ses deux bobines |
| `heads.virtual.explain.body` | {name} mixes {a} and {b}. If you unload one of the two spools, {name} is deleted automatically: what used it is left without a head, and slicing waits until you choose one. | {name} mélange {a} et {b}. Si vous déchargez l'une des deux bobines, {name} est supprimée automatiquement : ce qui l'utilisait se retrouve sans tête, et la découpe attend que vous en choisissiez une. |
| `heads.virtual.explain.noshow` | Don't show this again | Ne plus afficher |
| `heads.virtual.explain.ok` | Got it | Compris |
| `heads.virtual.removed` | {h} was unloaded: {name} ({a} + {b}) was deleted. {n} colors have no head now: choose one to slice. | {h} a été déchargée : {name} ({a} + {b}) a été supprimée. {n} couleurs n'ont plus de tête : choisissez-en une pour découper. |
| `heads.virtual.delete_confirm` | {n} colors use {name}. They will have no head until you choose one. | {n} couleurs utilisent {name}. Elles n'auront plus de tête jusqu'à ce que vous en choisissiez une. |
| `prepare.tip.orphan` | {n} colors no longer have a head: choose one in the list | {n} couleurs n'ont plus de tête : choisissez-en une dans la liste |
| `slice.orphan` | Some colors no longer have a head: go back to Prepare to choose one. | Des couleurs n'ont plus de tête : retournez dans Préparer pour en choisir une. |
| `slice.open_prepare` | Open Prepare | Ouvrir Préparer |
| `swatch.virtual` | Virtual heads | Têtes virtuelles |
| `swatch.create_virtual` | Create a virtual head… | Créer une tête virtuelle… |
| `prepare.choose_head` | Choose | Choisir |
| `prepare.tower.virtual_hint` | A virtual head changes heads at every layer: the prime tower is recommended. | Une tête virtuelle change de tête à chaque couche : la tour d'amorçage est conseillée. |
| `slice.virtual.layer_hint` | For an even mix, choose 0.10 mm or less. | Pour un mélange régulier, choisissez 0,10 mm ou moins. |

Plurals with the existing `_one` / `_other` scheme where a count shows.
`python3 scripts/check-i18n.py` clean.

## Tests

- `scripts/test-virtual.js` (new, pure `ui/virtual-logic.js`): value ↔ uid,
  names V1…, notch ↔ pct ↔ cadence (Orca's formula, all 7 notches and the
  in-between percents), duplicate detection, limit, `vhPhysical`,
  `vhOrphan`, unloading (one component or both, by object and by colour,
  the per-file map: every user becomes an orphan, none gets a guessed
  head; an offline read deletes nothing), the engine mapping (`n + k`,
  stable order).
- `scripts/test-swatch.js`: virtual entries, the second section, keyboard
  moves across sections, the "unavailable" virtual value.
- `scripts/test-prepare.js`: single-token rows, popover values, migration
  between modes with virtual values and orphans; `prBlockers` reports
  orphans in both modes and Slice is disabled until each gets a head; an
  orphan in "by object" mode is not replaced by the deduced head.
- Slice sheet: Slice disabled with the « Ouvrir Préparer » line while an
  orphan remains.
- `scripts/test-tower.js`: a plate on V1 alone uses two heads.
- `cargo test --lib`: `mixcolor` golden values; `mixed_definitions` golden
  string; a scene with a virtual head writes `extruder` 5; saved plate's
  `project_settings.config` keys; with the engine present, the cube's G-code
  alternates `T0 T0 T2`.
- Screenshots (light/dark, FR/EN): Heads and spools section, creation sheet
  at 1:1 and 3:1, explanatory sheet, Prepare rows with one token, the open
  popover with virtual heads, the toast, a blocked plate with « Choisir »
  rows.

## Out of scope

Manual patterns (`"112"`), 3+ color gradients, same-layer pointillism,
per-component bias, Local-Z dithering, auto-generated pairs, color matching
from an image (Orca's "Match" tab), painting with virtual heads in a future
paint tool (the values will already work).

## For the implementer

Implement, then **review your whole diff against `main`** (logic, every
place a head value is read — `rg "\.heads\b|colourHeads|\.pick\b|extruder_map"`
— so that no reader turns an orphan into a head, the blocking paths, i18n,
themes, keyboard), fix what you find, and
report that review in the pull request.
