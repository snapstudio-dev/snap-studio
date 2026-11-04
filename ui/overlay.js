"use strict";
/* The floating navigation over a site's view (overlay.html): each button
   asks Rust to act on the tab shown. window.__NAV__ (library.rs): { tone }.
   Rust calls setTone when the site under the pill turns light or dark.
   This page has no other script. */
const NAV = window.__NAV__ || {};

/* The site's tone: "dark" makes the pill light; "light" or none, dark. */
function setTone(tone) {
  document.getElementById("pill").classList.toggle("on-dark", tone === "dark");
}

setTone(NAV.tone);
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-nav]");
  if (!b) return;
  window.__TAURI__.core.invoke("lib_nav", { what: b.dataset.nav }).catch(() => {});
});
