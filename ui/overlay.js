"use strict";
/* The floating navigation over a site's view (overlay.html): each button
   asks Rust to act on the tab shown. window.__NAV__ (library.rs): { lang,
   back, forward, reload, tone }. Rust calls setTone when the site under the
   pill turns light or dark, and setLabels when the language changes. This
   page has no other script. */
const NAV = window.__NAV__ || {};

/* The site's tone: "dark" makes the pill light; "light" or none, dark. */
function setTone(tone) {
  document.getElementById("pill").classList.toggle("on-dark", tone === "dark");
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

setLabels(NAV);
setTone(NAV.tone);
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-nav]");
  if (!b) return;
  window.__TAURI__.core.invoke("lib_nav", { what: b.dataset.nav }).catch(() => {});
});
