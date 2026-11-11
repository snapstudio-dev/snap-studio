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

/* The frames, one after the other (as camera.js camNext: read and decoded
   aside, so a missed or cut frame never shows WebKit's broken-image
   question mark; the last good one stays); a few misses in a row: the
   printer does not answer, said instead of a frozen image.
   Hidden (no site shown: the interface reads its own frames then), it
   reads nothing; shown again, it goes on. */
let n = 0, fails = 0, timer = 0, busy = false;
function next() {
  clearTimeout(timer);
  timer = 0;
  if (busy || document.hidden || !CV.id) return;
  busy = true;
  const img = new Image();
  img.src = schemeUrl("cam", `/f?id=${encodeURIComponent(CV.id)}&n=${++n}`);
  // A decode that never ends counts as a miss (as camera.js camNext).
  let done = false;
  const once = (f) => () => {
    if (done) return;
    done = true;
    clearTimeout(guard);
    f();
  };
  const miss = () => {
    if (++fails >= 3) {
      $("off").classList.remove("hidden");
      $("img").classList.add("hidden");
    }
    busy = false;
    timer = setTimeout(next, fails >= 3 ? 3000 : 1000);
  };
  const guard = setTimeout(once(miss), 6000);
  img.decode().then(
    once(() => {
      const shown = $("img");
      for (const a of shown.attributes) if (a.name !== "src") img.setAttribute(a.name, a.value);
      img.classList.remove("hidden");
      shown.replaceWith(img);
      fails = 0;
      $("off").classList.add("hidden");
      busy = false;
      timer = setTimeout(next, 200);
    }),
    once(miss),
  );
}
document.addEventListener("visibilitychange", next);
next();
