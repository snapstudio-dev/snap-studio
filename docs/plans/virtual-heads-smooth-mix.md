# Virtual heads: smooth mix (subdivided layers) and a contrast warning

Follow-up of [virtual-heads.md](virtual-heads.md) (#64).

## Why

A user printed a virtual head of white (T0) and black (T1) at 1:1, expecting
gray. The part came out black, with white showing only in the open infill.
Their real G-code (U1, `layer_height = 0.08`, prime tower on,
`mixed_filament_definitions = 1,2,1,1,50,…,m2,z0,…`, no per-feature head,
`flush_into_infill = 0`, every `dithering_local_z_*` at `0`) confirms what the
engine does today: **one head per whole layer, walls and infill included**,
the two heads alternating layer after layer. Layer height and the prime tower
are not the cause.

What Snap Studio does not send is the setting Snapmaker's own guide asks for
when a **whole object** uses a mixed color: **Subdivide Mix Layer**, with
**Full domain** and **Apply Subdivision to Infill**
([Snapmaker wiki, Full Spectrum](https://wiki.snapmaker.com/en/snapmaker_orca/snapmaker_orca_full_spectrum),
§1.4.2 and §5). With it, every layer of a mixed region is split into
sub-layers, one per head, so the colors alternate twice as often and the
infill follows the walls.

Second, black with white is the worst pair for an optical mix: an opaque dark
layer hides the light one under it, so the print is darker and more striped
than the swatch (the pigment mixer of `mixcolor.rs`). The wiki recommends
translucent filaments and warns against unbalanced pairs; Snap Studio says
nothing today.

## How Snapmaker Orca does it (source read at `v2.4.0`)

- Keys, all `coBool`, default `false`, process (print) settings, category
  "Color Mixing (Experimental)" in the Multimaterial page:
  - `dithering_local_z_mode` "Subdivide Mix Layer" — `src/libslic3r/PrintConfig.cpp:4435`
  - `dithering_local_z_whole_objects` "Full domain" — `PrintConfig.cpp:4442`
  - `dithering_local_z_infill` "Apply subdivision to infill" — `PrintConfig.cpp:4450`
- GUI: `src/slic3r/GUI/Tab.cpp:2878` adds the group; `Tab.cpp:1766-1784`:
  turning Subdivide Mix Layer on also turns infill subdivision on; turning it
  off clears Full domain, infill subdivision and
  `dithering_local_z_direct_multicolor`.
- Sub-layer heights are bounded by `mixed_filament_height_lower_bound`
  (default 0.04 mm) and `mixed_filament_height_upper_bound` (0.16 mm)
  (`PrintConfig.cpp`, "Local-Z lower/upper height bound").
- Cycle mode (manual patterns) ignores subdivision (wiki §2.2). Snap Studio
  only writes ratio rows (no pattern), so this does not apply.
- Orca warns when **variable layer height** and Subdivide Mix Layer are both
  on (`Plater::notify_vhl_dithering_conflict`, `Plater.cpp` ~16880): both
  change layer heights. Snap Studio has no variable layer height today; a
  project carrying a `layer_height_profile` would be the conflict case.
- Snap Studio already lists the three keys in its Orca settings catalog
  (`ui/assets/orca-settings.*.json`, Multimaterial / Color Mixing
  (Experimental)).

## Measurements (bundled engine 2.4.0, 30 × 30 × 20 mm box, 1:1 virtual head T0 + T2, 15 % infill, engine tower off)

| Profile | Subdivision | Each layer | Tool changes | Estimated time |
|---|---|---|---|---|
| 0.20 mm | off (today) | one head for walls and infill: T0, T2, T0… | 102 | — |
| 0.20 mm | on (3 keys) | 0.10 mm of T0 then 0.10 mm of T2 | 204 | — |
| 0.10 mm Color Mixing | off | 0.10 mm per head | 202 | — |
| 0.10 mm Color Mixing | on | 0.05 mm per head | 402 | — |
| 0.08 mm | off | 0.08 mm per head | 251 | 1 h 08 min |
| 0.08 mm | on | 0.04 mm per head (the lower bound) | 501 | 2 h 32 min |

Every layer had a single head per feature with subdivision off, and both
heads on walls and infill with it on.

## What changes

### 1. Smooth mix (subdivided layers)

- When the plate uses at least one virtual head **and** smooth mix is on,
  the slice request sends, next to `mixed_filament_definitions`:
  `dithering_local_z_mode = 1`, `dithering_local_z_whole_objects = 1`,
  `dithering_local_z_infill = 1`.
- No virtual head, or smooth mix off: **nothing new is sent** (the request is
  byte-for-byte what it is today).
- `mixed_filament_height_lower_bound` / `upper_bound` are not sent: the engine
  defaults (0.04 / 0.16 mm) apply. A value the user set in the Advanced
  settings for any of these five keys wins over ours.
- Where: `src-tauri/src/slice.rs` — `Request` (~`:264-284`) gets
  `smooth_mix: bool` (serde default `false`, so an old caller sends nothing);
  the overrides block (~`:750-760`) inserts the three keys only when
  `!virtual_heads.is_empty() && smooth_mix`, **before** `PILLAR_OVERRIDES`
  (`:291`), which keep the last word on their own three keys (no overlap).
  A constant `SMOOTH_MIX_OVERRIDES` next to `PILLAR_OVERRIDES`.
- UI toggle **"Smooth mix (subdivide layers)"**, **on by default**:
  - in the slice sheet's Multi-material panel (`ui/slice-adv.js`, the `mm`
    category), shown only when the plate uses a virtual head
    (`prTowerVirtualUsed()` / `slMapValues()` + `vhFind`, as `s-vlayer` does
    in `ui/slice.js:500-504`), with the hint: about twice the tool changes and
    a longer print;
  - in the virtual head sheet (`ui/virtual.js`, `#vhmodal` in
    `ui/index.html:1898`) as a read-only line saying the mix is smoothed by
    default and where to change it (the setting is per plate, not per head,
    because the engine keys are per print).
- Persisted with the plate: `PR.smoothMix` in `snapstudio.plate`
  (`ui/prepare.js` `prSave`, `:72-74`, and its restore), missing = on; and in
  a saved project as the three keys in `Metadata/project_settings.config`
  (`plate.rs` `save_scene`, `:352`) when on, so Snapmaker Orca opens it the
  same way.
- The slice summary (`ui/slice.js` summary parts) says "Smooth mix" when it
  applies.

### 2. Contrast warning in the virtual head sheet

- When the two spools' colors are far apart in relative luminance (WCAG
  formula on the sRGB colors, `|L(a) − L(b)| ≥ VH_CONTRAST_WARN`, proposed
  `0.5`; black/white is 1.0), the sheet shows a warning under the swatch:
  the print will look darker and more striped than the preview if the
  filaments are opaque; closer colors or translucent filaments mix better.
- Pure function in `ui/virtual-logic.js` (`vhContrast(a, b)` → number,
  `vhContrastWarn(a, b)` → bool), used by `vsRender()` in `ui/virtual.js`.
- No filament or material names in the copy.

## Texts (FR / EN; the 7 other catalogs translated)

`ui/i18n/*.json` (en, fr, de, es, it, pt-BR, ja, zh-Hans, ko):

| Key | EN | FR |
|---|---|---|
| `slice.mix.smooth` | Smooth mix (subdivide layers) | Mélange lissé (couches subdivisées) |
| `slice.mix.smooth_hint` | Each layer of a virtual head is split between its two heads: a smoother color, about twice the tool changes and a longer print. | Chaque couche d'une tête virtuelle est partagée entre ses deux têtes : une couleur plus homogène, environ deux fois plus de changements de tête et une impression plus longue. |
| `slice.sum.smooth` | Smooth mix | Mélange lissé |
| `heads.virtual.smooth_note` | The mix is smoothed by default (layers split between the two heads). Change it in the slice settings, Multi-material. | Le mélange est lissé par défaut (couches partagées entre les deux têtes). Modifiable dans les réglages de découpe, Multi-matériaux. |
| `heads.virtual.contrast_warn` | These two colors are very different: with opaque filaments, the print will look darker and more striped than this preview. Closer colors or translucent filaments mix better. | Ces deux couleurs sont très différentes : avec des filaments opaques, l'impression sera plus sombre et plus striée que cet aperçu. Des couleurs proches ou des filaments translucides se mélangent mieux. |

`python3 scripts/check-i18n.py --strict` clean.

## Acceptance criteria

1. A plate with a virtual head, smooth mix on (default): the engine's G-code
   header has `dithering_local_z_mode = 1`, `dithering_local_z_whole_objects = 1`,
   `dithering_local_z_infill = 1`; on every layer of the mixed object, walls
   and infill are printed by both component heads, each on a sub-layer
   (`;HEIGHT:` half of the layer height at 0.20 and 0.08 mm), never below
   0.04 mm.
2. Smooth mix off, or no virtual head: none of the three keys is sent; the
   G-code is the same as today (one head per layer).
3. With per-material pillars (`PILLAR_OVERRIDES`): both sets apply, the
   pillar keys unchanged.
4. A value set by hand in Advanced for one of the keys wins.
5. The toggle shows only when the plate uses a virtual head, is on by
   default, survives a restart (plate state) and a saved project.
6. The contrast warning shows for white + black and not for two close
   colors; it never blocks creation.
7. `cargo test --lib`, `scripts/test-*.js`, `check-i18n.py --strict` pass.

## Tests

- `slice.rs`: `engine_virtual_head_alternates` (ignored, needs
  `SNAPSTUDIO_ENGINE`) gains a smooth-mix variant (or a new
  `engine_virtual_head_smooth_mix`): a 30 × 30 × 20 mm box at 0.20 mm,
  1:1 → every layer's walls and infill use both T0 and T2, sub-layers of
  0.10 mm, about twice the tool changes; with it off, the existing
  `T0, T0, T2` assertions are unchanged. A unit test that the overrides
  contain the three keys only when `smooth_mix && !virtual_heads.is_empty()`,
  and that `PILLAR_OVERRIDES` still apply.
- `scripts/test-virtual.js`: `vhContrast` / `vhContrastWarn` (black/white,
  white/light gray, equal colors, invalid color → no warning).
- `scripts/test-adv.js` (or `test-prepare.js`): toggle visibility with and
  without a virtual head, default on, `PR.smoothMix` saved and restored, the
  request's `smooth_mix`.
- Screenshots (light/dark, EN/FR): the Multi-material panel with the toggle,
  the virtual head sheet with the warning.

## Risks

- About **2× tool changes** and longer prints (0.08 mm box: 251 → 501 changes,
  1 h 08 → 2 h 32 estimated). The hint says so; the toggle turns it off.
- Experimental in Orca ("Color Mixing (Experimental)"); infill subdivision
  "may add toolchanges and affect infill behavior".
- Conflict with variable layer height (Orca warns). No such feature in Snap
  Studio; if one comes, or a project with a `layer_height_profile` is
  sliced, show the same warning.
- The keys are per print: one plate cannot smooth one virtual head and not
  another.
- The result still depends on the filaments: the contrast warning sets
  expectations; it does not fix opaque pairs.

## Out of scope

Cycle / gradient / match modes, the Local-Z bounds as user settings,
`dithering_local_z_direct_multicolor`, `dithering_z_step_size`, color
calibration (#70).
