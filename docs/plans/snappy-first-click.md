# Snappy's icon sometimes needs a second click

Implemented in [#101](https://github.com/kameka22/snap-studio/pull/101)
(steps 1 and 2); the checks in the app (step 3) are left.

Clicking Snappy's icon (bottom of the sidebar, or beside the slice sheet)
sometimes does nothing; the second click opens the card.

## What the click goes through

- The icon is a `<button id="snappy-fab">` holding the animated avatar
  (`ui/snappy-avatar.js`). Its `click` opens or closes the card
  (`ui/snappy.js:62`, `snappyOpen` `:140`).
- A `pointerdown` listener (capture) closes the card on any press outside
  it; presses on the icon are excluded (`:76-83`).

## Likely cause: the avatar rewrites what is under the pointer

The avatar is redrawn on every animation frame (`snvFrame`,
`ui/snappy-avatar.js:348-389`):

- its eyes **follow the pointer** (`pointermove` → `snvPointerGaze`,
  `:337-338`, `:364`). When the pointer is on the icon, the gaze changes at
  each frame, so `a.eyes.innerHTML = html` (`:385-388`) **replaces the eye
  shapes**, which are under the pointer, many times per second (and at
  each blink).

Its body also turns in 3D at each frame (`:373-375`), but that alone does
not lose a click: an element that moves stays in the page, and the click
goes to the common ancestor, the button. Only the eyes being replaced
loses it.

A `click` is only sent when the press and the release land on the same
element, or on elements of the same tree. When the press lands on an eye
and the eyes are rewritten before the release, the element pressed no
longer exists: WebKit (the webview of Tauri on macOS and Linux) then sends
no `click`. The press is lost, the second one usually works. "Sometimes"
fits: it depends on where on the icon, and on whether the eyes moved
between press and release.

A second, smaller cause, kept and fixed in step 1 too: the edge of the
icon. `.snappy-fab:hover` scales the button to 1.06 and `:active` to 0.97
(`ui/style.css:5477-5478`, 160 ms transition). A press on its outer rim
(about 2 px) can be released outside the shrunk button, and the click then
goes to `.side-sep`. Rare, but it happens with every webview.

Other causes checked and set aside:

- The window not focused, whose first click only focuses it:
  `acceptFirstMouse` is already on for macOS (`tauri.macos.conf.json`);
  to check on Linux and Windows during step 3.
- The card opened but out of sight (a press that closes instead of
  opening): `SNAP.open` is only set by `snappyOpen` / `snappyClose`, and the
  icon is excluded from the outside-press listener.
- The native view over a site of Explore (`snappy-view.html`) keeping the
  focus: possible after clicking in a site, to check in step 3.

## Fix

1. **The avatar inside the icon does not take the pointer**:
   `.snappy-fab .snv { pointer-events: none; }` in `ui/style.css`. Press and
   release then always land on the button itself, whatever the avatar
   does. The eyes still follow the pointer (they use `pointermove` on the
   document, not on the avatar). No other clickable host of the avatar
   today (the intro badge, `.snappy-intro-badge`, is a plain `div`).
   The hover and press `scale` move from `.snappy-fab` to its avatar
   (`.snappy-fab:hover .snappy-av`), so the button's own box no longer
   shrinks under the pointer.
2. **Test**: a check in `scripts/test-snappy.js` (node) that the rule is in
   `style.css` for every clickable host of the avatar, so that it does not
   come back.
3. **Check in the app** (macOS and Linux): about twenty clicks on different
   spots of the icon, eyes moving, beside the sidebar and beside the slice
   sheet; then once after clicking in a site of Explore, and once with the
   window in the background. On Windows (WebView2, which sends the click
   to the common ancestor) the bug should not show before the fix: a
   check of the diagnosis. If one of the two last cases still needs two
   clicks, that is a second cause: a native-view focus fix then, in the
   same PR.

No Rust change, no new interface string. Changelog: Unreleased › Fixed.
