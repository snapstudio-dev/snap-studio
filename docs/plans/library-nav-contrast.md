# Explore: Back and Forward almost invisible on dark sites

In Explore, when a site is shown (Snapmaker Space, MakerWorld, Printables…),
the Back, Forward and Reload buttons at the top left of the page can hardly be
seen when the site has a dark background.

Merged in [#88](https://github.com/kameka22/snap-studio/pull/88)
(2026-11-04), including the Linux flicker fix
([Implementation](#implementation)). Checks on macOS and Windows remain as
written below. The
owner's choice is **[D. Adaptive pill](#d-adaptive-pill-owners-choice)**:
the floating pill stays, dark on a light site and light on a dark site.

## Where the buttons are

They are not part of the interface's HTML. A site is a native web view laid
over the app, so the buttons live in a second, small native view of ours laid
on top of it:

- `ui/overlay.html`: the page of that view, a "pill" with the three buttons
  and all its styling (`:11-40`). `ui/overlay.js` sends a click to Rust
  (`lib_nav`).
- `src-tauri/src/library.rs`: `NAV_SIZE` (112 × 40) and `nav_rect` (10 px from
  the site's top-left corner) at `:59-63`, `ensure_nav` (`:76-93`) which makes
  a fresh transparent view after each site's view so it stays on top
  (called at `:357`), the placement at `:592` and `:621`, and `nav_command` /
  `command` (`:189`, `:642`) which run `history.back()`, `history.forward()`
  or `location.reload()` in the tab shown.

## Why they vanish on a dark site

The pill was designed for light pages only:

1. **A dark pill.** Its background is a dark grey at 55 %
   (`rgba(28, 28, 30, 0.55)`, `:19`). On a white page it stands out; on a
   dark page it is the same color as what is behind it.
2. **Faded at rest.** The whole pill is at `opacity: 0.45` until the pointer
   is over it (`:23-26`). The dark background drops to about 25 % and the
   white icons to 45 %, which on a dark page is close to nothing.
3. **No edge.** The only outline is a 0.5 px inset line at 18 % white
   (`:20`), so about 8 % once faded: invisible. The shadow is black, which
   does not show on black.
4. **The blur does nothing.** `backdrop-filter` (`:21-22`) only blurs what is
   behind it *inside its own page*, and that page is transparent. The site is
   in another native view, so it is never blurred or dimmed under the pill.
   The frosted-glass look that would separate the pill from any background
   never happens.

Side notes: the tooltips "Back", "Forward" and "Reload" are hard-coded in
English (`:45-47`), and the pill covers the top-left corner of the site, which
is where most sites put their logo or menu.

## Options

### A. A solid pill that reads on any background (smallest change)

Only `ui/overlay.html` changes:

- A near-opaque background (`rgba(28, 28, 30, 0.85)`) with a visible light
  border (`1px solid rgba(255, 255, 255, 0.35)`), and a two-sided shadow: a
  dark one for light pages and a thin light ring for dark pages.
- No more fading at rest (or a light one, 0.85 → 1 on hover), since it is
  the fade that kills the contrast.
- Remove the `backdrop-filter`, which has no effect.

Works on white and black pages alike, no Rust change. The pill still covers
the site's corner and the tooltips stay in English (they could be passed in
the URL, `overlay.html?lang=fr`, as a small extra).

### B. Follow the app's theme

Same as A, but the pill takes the app's light or dark colors (the
`--control-bg` / `--text` / `--separator` of `ui/style.css`), with the
border and shadow of A. Rust tells the view the theme when it makes it and
when the theme changes (an event, or `?theme=` in the URL).

Looks more "part of the app", but the problem remains in half the cases: a
light pill on a light site, or a dark pill on a dark site, still needs the
border of A to be seen. More work (theme passed to a separate view) for the
same contrast as A.

### C. Move the buttons into the tab strip

In Explore, the tab strip already stands in for the toolbar, and while a site
is shown it already has buttons of ours on the right: Add to favorites and
Open in the browser (`#lib-actions` in `ui/index.html:709`, shown by
`ui/library.js:93`). Back, Forward and Reload go there too, to the left of
Home as in a browser, or next to the existing actions:

- `ui/index.html`: three `tb-btn` buttons with `data-i18n-title`
  (`common.back` and `library.reload` exist; one new key for Forward, in the
  9 languages). Shown only while a site is shown, like `#lib-actions`.
- `ui/library.js`: the buttons call the existing `lib_nav` command.
- `src-tauri/src/library.rs`: remove the floating view (`NAV_SIZE`,
  `nav_rect`, `ensure_nav`, the `lib-nav` cases in the placement code).
  `ui/overlay.html` and `ui/overlay.js` are deleted. The pinned camera view
  (`camview.html`) is not affected.

They are then drawn by the app itself, in its theme, on the app's own
background: they can no longer be lost on a site, they no longer cover the
site's logo or menu, and the tooltips are translated. It also removes one
native view made again at each tab switch (and its GTK handling on Linux). No
vertical space is lost: the strip is already there.

Downside: the buttons move from the page to the strip above it, so a user used
to the floating pill has to find them again (the arrow icons are the same).

### D. Adaptive pill (owner's choice)

The pill stays where it is, floating over the site, and takes the color that
contrasts with what is under it: **dark on a light site, light on a dark
site**. A's border and "no fade" are kept as the baseline, so that the pill
never disappears, even before the site's color is known, while it changes, or
when it cannot be read.

#### The difficulty: the site is in another view

The pill's page (`overlay.html`) cannot see the site: it is a separate native
view, and its own page is transparent. Only the site's view knows its colors.
So the site's view measures, Rust carries the answer, the pill applies it.

#### 1. Measure in the site's view (read-only script)

A script injected with `WebviewBuilder::initialization_script` in `open_tab`
(`src-tauri/src/library.rs:324`; already done for the camera view at `:153`).
It runs in the main frame only (not in ads' iframes), before the site's own
scripts, on every page load of the tab. It keeps one value up to date,
`"light"`, `"dark"` or nothing:

- **Where to look:** a few points under the pill, in the page's CSS pixels,
  which match the app's logical points at the site's default zoom. The pill
  covers x 10–122, y 10–50 from the view's corner (`nav_rect`, `NAV_SIZE`):
  for example (24, 30), (66, 30) and (108, 30).
- **What color is there:** for each point, `document.elementsFromPoint(x, y)`
  gives the stack of elements, top first. Walk it (and each element's
  ancestors) and blend the `getComputedStyle(…).backgroundColor` values until
  the color is opaque. Then compute its relative luminance (sRGB, as in
  WCAG).
- **When that fails:** a point is "unknown" when it lands on a
  `background-image` (gradient or picture), an `<img>`, `<video>`,
  `<canvas>` or `<iframe>`. The script cannot read their pixels (cross-origin
  images are locked, and reading would be heavy anyway). Then it falls back,
  in this order, to:
  1. the page's `<meta name="theme-color">` (the one whose `media` matches);
  2. the computed background of `<body>`, then of `<html>`;
  3. the page's `color-scheme` (`dark` → dark);
  4. otherwise nothing: the pill keeps its current color, dark at first, as
     today.
- **The decision:** the majority of the points. Two thresholds with a gap
  (dark below 0.4, light above 0.6) keep a mid-grey header from making the
  pill flicker.
- **When to measure again:** on load, `scroll` and `resize` (passive
  listeners), when the system's light/dark mode changes (`matchMedia`), and
  on DOM changes (`MutationObserver` on `childList`, `class` and `style`, for
  sites that change pages without loading, menus and sticky headers). All of
  it goes through one throttle: at most one measure every 250 ms, done in
  `requestAnimationFrame`.

The script only reads. It does not touch the page, make any request or store
anything, and its only output is that one word.

#### 2. Carry the answer to Rust, without giving the site our bridge

The sites must not get Tauri's IPC. Today they do not have it (`command`,
`:640`: "the remote view does not have our bridge"), and opening it to remote
origins through a capability (`remote.urls`) would let any script of those
pages, ads included, call the commands allowed. **That is not needed:**
Tauri 2.12, the version in `Cargo.lock`, has `Webview::eval_with_callback`,
which runs a line of JavaScript in a view and hands its result back to Rust
(macOS, Windows and Linux). So Rust **reads** the value; the page never
sends anything:

- While a tab is shown (`visible_tab`), Rust reads the value of the tab shown
  every 300 ms or so, plus right away on page load (`on_page_load`), on a
  title change, on a tab switch (`show_only`) and after Back, Forward or
  Reload. Reading means evaluating a tiny expression of the script's variable.
  No tab is shown → no reading. Hidden tabs are never read.
- The answer is checked strictly: only `"light"` or `"dark"` is kept;
  anything else (missing, a site that overwrote the value, an error, Windows
  ignoring exceptions) changes nothing.
- Only a change is passed on, to the pill's view, which is our own page:
  `wv.eval("setTone('dark')")` on the `lib-nav-*` view, or an event to that
  label. The current tone is also given to a new pill made by `ensure_nav`
  (`:76`, after each new tab), so it does not start dark on a dark site.

A push from the page (a fake navigation to a custom address caught in
`on_navigation`, or a title change) was also considered, and set aside. It
depends on each site's Content-Security-Policy, which can block it. It would
also show up in the site's history and title.

#### 3. The pill applies it (`ui/overlay.html`, `ui/overlay.js`)

- **Baseline, always:** opacity 1 at rest (no more 0.45), no
  `backdrop-filter` (it never worked here), and a double edge, a 1 px light
  ring inside a 1 px dark ring plus a soft shadow. One of the two rings
  always contrasts with the site, even when the tone is wrong or not known
  yet.
- `.pill.on-light` (light site): dark pill, `rgba(28, 28, 30, 0.88)`, white
  icons, as today but solid.
- `.pill.on-dark` (dark site): light pill, `rgba(245, 245, 247, 0.92)`, dark
  icons (`#1c1c1e`), hover and press shades in black instead of white.
- The change fades over 150 ms (`background-color` and `color`).
- `setTone(t)` in `overlay.js` swaps the class; nothing else changes there.

#### Feasibility

Possible with what the app already has. There is no new dependency, no
change to the capabilities, and no IPC for the sites.

- `eval_with_callback` is in tauri 2.12.2 (`Cargo.lock`). Its result comes
  back as JSON on a thread of its own, and Rust only compares a short
  string.
- `initialization_script` is already used for the camera view.
- The pill view is already ours, and Rust already finds it by its label.

The work: about 60 lines of injected script (a `const` in `library.rs`, or a
file read with `include_str!`), a reading loop of about 40 lines in
`library.rs`, and about 20 lines of CSS and JS in `overlay.*`. The detection
rules (blending, luminance, thresholds, majority) go in a pure function with
`scripts/test-*.js` tests on color samples.

#### Risks and limits

- **Pictures under the corner** (a banner, a model's cover photo): their
  pixels cannot be read, so the fallback chain decides (`theme-color`, page
  background). The pill may be the "page" color rather than the picture's.
  The double edge keeps it visible all the same.
- **Up to about half a second of delay** after a scroll or a page change. The
  baseline edge covers that moment.
- **The site can see the variable** (same JavaScript world as its scripts).
  It could tell that it is shown in Snap Studio, or overwrite it. The worst
  case is a pill of the wrong color, still outlined. To limit this, the
  variable is non-enumerable, under a name of its own.
- **Cost:** a measure at most every 250 ms, only when something changes, and
  a 300 ms read of the tab shown only. It is negligible, but to be checked on
  heavy pages (MakerWorld's endless lists) with the `MutationObserver`.
- **Zoom:** if the site's page is zoomed (Ctrl/Cmd +), the CSS pixels no
  longer match the pill's points exactly. The points can be scaled by
  `visualViewport.scale` / `devicePixelRatio`, to be checked at
  implementation.
- **Other sites:** it works on every site, including those opened by
  address ("Open a site"). Nothing is specific to one site.

#### 4. Translated tooltips (decided: in this PR)

The owner asked for the tooltips to be translated in the same PR. Today
`overlay.html` hard-codes "Back", "Forward" and "Reload" (`:45-47`), and its
view does not get the interface's catalog (only the main window does,
through `i18n::init_script`, `src-tauri/src/lib.rs:1932`).

**Keys**, reusing what exists:

| Button | Key | State |
|---|---|---|
| Back | `common.back` | exists in the 9 catalogs ("Retour", "Zurück", "戻る"…) |
| Reload | `library.reload` | exists in the 9 catalogs (the tab menu's "Reload") |
| Forward | `library.forward` | **new**, to add to the 9 catalogs |

Proposed values for `library.forward`: en "Forward", fr "Suivant", de
"Vorwärts", es "Adelante", it "Avanti", pt-BR "Avançar", ja "進む", zh-Hans
"前进", ko "앞으로". French is written by hand; the other languages follow
the review process of [languages.md](languages.md).

**Catalogs concerned:** `ui/i18n/en.json`, `fr.json`, `de.json`,
`es.json`, `it.json`, `pt-BR.json`, `ja.json`, `zh-Hans.json`, `ko.json`
(all the app's catalogs). Only `library.forward` is added; the two reused
keys are not touched.

**How the pill gets them:** as the camera view does (`ensure_cam`,
`src-tauri/src/library.rs:153`). `ensure_nav` adds an
`initialization_script` with `window.__NAV__ = { lang, back, forward,
reload }`, filled in Rust with `i18n::lang()` and `i18n::t(…)`.
`overlay.js` sets `document.documentElement.lang` and each button's `title`
from it, and `overlay.html` gets the CJK font rules of `camview.html`
(`:13-16`). On a language change (`language_set`,
`src-tauri/src/lib.rs:1848`), the pill is made again (`ensure_nav`) if a
site is shown, or gets the new labels through `eval`. Otherwise it would
keep the old language until the next tab is opened.

`python3 scripts/check-i18n.py` must be clean.

## Recommendation

**D**, the owner's choice (it keeps the floating pill). C was the first
recommendation and stays here for the record; A is D without the adaptive
color (its baseline).

## Checks at implementation

- Light and dark sites (Snapmaker Space, MakerWorld, Printables), app in
  light and dark mode, on macOS, Windows and Linux.
- Back, Forward and Reload act on the tab shown, after switching tabs and
  after reopening the app (restored tabs).
- D: the pill is dark on a light site (Printables) and light on a dark
  site (Snapmaker Space, MakerWorld's dark mode); it follows a scroll under
  a sticky header, a page change without loading, a tab switch, and Back /
  Forward between a light and a dark page; a new tab starts with the right
  tone; with the site's color unreadable (picture under the corner) it stays
  visible; no request or change of the page from the script (devtools); no
  `__TAURI__` in the sites' pages.
- Tooltips: in French and in one CJK language, then after switching the
  language in Settings with a site shown (no restart, no new tab).
- Pure detection rules tested in `scripts/test-*.js` (blending,
  luminance, thresholds, majority, fallbacks).
- Screenshots before and after on a dark site.

## Implementation

- **Baseline** (`ui/overlay.html`): solid, never faded, no
  `backdrop-filter`, a light ring inside a dark one and a soft shadow;
  `.on-dark` for the light pill; the colors change by repainting only.
- **Measure** (`ui/nav-tone.js`, injected by `open_tab`, main frame): as
  section D. Refinements found on real sites: a small picture (a logo, an
  icon: 64 px high and 320 px wide at most) is looked under, as on
  Snapmaker Space, where the logo covers all three points and the
  theme-color is a brand blue; a gradient background is read from its
  colors (they are in the computed style); a big picture whose element has
  an opaque background color takes that color (Thangs' dark hero under a
  transparent bar). The value kept is the tone and the color under the
  pill, `"dark #1d1d1e"`, under `Symbol.for("snapstudio.navTone")`.
- **Reading** (`library.rs`): `eval_with_callback` on the tab shown about
  every 300 ms and on page load, title change, tab switch and
  Back/Forward/Reload; only a "light" or "dark" word and a `#rrggbb` color
  are accepted (`parse_tone`); the pill is told once per change
  (`setTone`), and a new pill starts with them (`window.__NAV__`).
- **Tooltips**: `window.__NAV__` carries the language and the three labels;
  `language_set` relabels the pill shown (`nav_relabel`).
- **Linux flicker (the addendum)**: cause found in an Ubuntu 26.04 VM
  (GNOME on Wayland, WebKitGTK 2.52). Each time the pill repainted on its
  own (hovering it, a button, a tooltip), its whole view showed the
  desktop for a moment: WebKitGTK paints a transparent view by replacing
  what is under it rather than drawing over it, and the window is
  see-through (its rounded corners), so the view's transparent pixels let
  the desktop through. The old fade and blur only made it more frequent;
  the new style alone did not remove it. Neither clipping the view's
  drawing, shaping its window nor marking it see-through for GDK helped;
  an opaque view did. On Linux the pill's view is now opaque and the
  pill's own size, at the same place, its corners in the color measured
  under the pill (`.solid`, `nav_rect`). No hole in about 40 frames taken
  as the pointer entered and left the pill; the tone's 300 ms reading
  only repaints the pill when the tone or color changes.
- Tests: `scripts/test-navtone.js` (colors, blending, luminance,
  thresholds, pictures, gradients, fallbacks, majority, corner color);
  `library.rs` (`parse_tone`, the injected script stays read-only).

## CHANGELOG line (added at implementation, under *Unreleased › Fixed*)

```
- **Explore**: the Back, Forward and Reload buttons over a site stay
  visible on any site: the pill turns light on dark sites and dark on light
  ones, and no longer fades out. Their tooltips are translated, and the
  pill no longer flickers on Linux (#88).
```
