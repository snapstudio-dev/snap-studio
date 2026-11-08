"use strict";
/* The floating navigation over a site's view (overlay.html): each button
   asks Rust to act on the tab shown. window.__NAV__ (library.rs): { lang,
   back, forward, reload, tone, under, solid }. Rust calls setTone when the
   site under the pill turns light or dark (or its color changes), and
   setLabels when the language changes. This page has no other script. */
const NAV = window.__NAV__ || {};

/* The site's tone: "dark" makes the pill light; "light" or none, dark.
   `under`, "#rrggbb": the color around the pill where its view is opaque
   (Linux). */
function setTone(tone, under) {
  document.getElementById("pill").classList.toggle("on-dark", tone === "dark");
  if (under) document.documentElement.style.setProperty("--under", under);
}

/* Tooltips in the interface's language, and its fonts (overlay.html). */
function setLabels(l) {
  if (l.lang) document.documentElement.lang = l.lang;
  for (const what of ["back", "forward", "reload"]) {
    const b = document.querySelector(`[data-nav="${what}"]`);
    if (l[what]) {
      b.title = l[what];
      b.setAttribute("aria-label", l[what]);
    }
  }
}

// Linux: an opaque view, the pill's size (overlay.html).
if (NAV.solid) document.documentElement.classList.add("solid");
setLabels(NAV);
setTone(NAV.tone, NAV.under);
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-nav]");
  if (!b) return;
  window.__TAURI__.core.invoke("lib_nav", { what: b.dataset.nav }).catch(() => {});
});
