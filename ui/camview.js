"use strict";
/* The pinned camera over a site (camview.html): the interface's camera
   (printers.js CAM) while a site's native view covers the interface — the
   interface stops its own frames meanwhile. window.__CAM__ (library.rs):
   { id, name, texts: { unpin, close, offline, open } }. The buttons go back
   to the interface, which owns the camera. */
const CV = window.__CAM__ || { id: "", name: "", texts: {} };
const $ = (id) => document.getElementById(id);
const act = (what) => window.__TAURI__.core.invoke("cam_view_action", { what }).catch(() => {});

// The interface's language: its fonts and line breaking (camview.html).
if (CV.lang) document.documentElement.lang = CV.lang;
$("name").textContent = CV.name || "";
for (const [id, key] of [["unpin", "unpin"], ["close", "close"]]) {
  $(id).title = CV.texts[key] || "";
  $(id).setAttribute("aria-label", CV.texts[key] || "");
}
$("body").title = CV.texts.open || "";
$("off-t").textContent = CV.texts.offline || "";
$("img").alt = CV.name || "";

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (b) act(b.dataset.act);
});

/* The frames, one after the other (as printers.js camNext); a few misses
   in a row: the printer does not answer, said instead of a frozen image. */
let n = 0, fails = 0;
function next() {
  $("img").src = schemeUrl("cam", `/f?id=${encodeURIComponent(CV.id)}&n=${++n}`);
}
$("img").addEventListener("load", () => {
  fails = 0;
  $("off").classList.add("hidden");
  $("img").classList.remove("hidden");
  setTimeout(next, 200);
});
$("img").addEventListener("error", () => {
  if (++fails >= 3) {
    $("off").classList.remove("hidden");
    $("img").classList.add("hidden");
  }
  setTimeout(next, fails >= 3 ? 3000 : 1000);
});
if (CV.id) next();
