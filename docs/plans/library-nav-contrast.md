# Explore: Back and Forward almost invisible on dark sites

In Explore, when a site is shown (Snapmaker Space, MakerWorld, Printables…),
the Back, Forward and Reload buttons at the top left of the page can hardly be
seen when the site has a dark background.

Plan only: nothing is implemented until the owner picks an option.

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

### C. Move the buttons into the tab strip (recommended)

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

## Recommendation

**C**: it removes the cause instead of tuning colors, and follows the
toolbar the app already has in this view. If the owner prefers to keep the
floating pill, **A** is the fix (one CSS block).

## Checks at implementation

- Light and dark sites (Snapmaker Space, MakerWorld, Printables), app in
  light and dark mode, on macOS, Windows and Linux.
- Back, Forward and Reload act on the tab shown, after switching tabs and
  after reopening the app (restored tabs).
- C only: nothing is left floating over the site; the pinned camera still
  shows over a site; `python3 scripts/check-i18n.py` is clean.
- Screenshots before and after on a dark site.

## CHANGELOG line (added at implementation, under *Unreleased › Fixed*)

C:

```
- **Explore**: Back, Forward and Reload are in the tab strip, in the app's
  colors, instead of floating over the site, where they could hardly be seen
  on dark sites.
```

A:

```
- **Explore**: the Back, Forward and Reload buttons over a site stay visible
  on dark sites.
```
