"use strict";
/* The printer camera, one for the app (CAM): one stream at a time and one
   element (#cam-box, with its controls), shown where the current screen
   asks for it — its home: the printer page (the Camera section or the 3D
   view's corner), the record of a running print (Prints), Control's card;
   or, pinned, in a small window over every screen; or at full size over
   the content area. Pinning is a preference, kept.

   As in Snapmaker Orca: the camera is woken by `camera.start_monitor` and
   publishes a continuously renewed JPEG, read again in a loop; it switches
   itself off unless restarted, hence the restart every 10 s. One read in
   flight at a time, the next one starts on load; nothing is read while
   the window is hidden, or while a site's native view shows the camera
   instead (camview.js). Moving from one screen to another of the same
   printer keeps the stream: no stop and start between them.

   A screen calls camHome(el, printerId, opts) when it shows a printer and
   camLeave() when it leaves; a `cam-change` event on document tells the
   screens to repaint their switches. The pure parts (where the box goes,
   the delays, the picture's rectangle) are in camera-logic.js. */

const CAM = {
  id: null,
  on: false,
  /* Two quick starts: only the last one goes on. */
  gen: 0,
  /* Frames: the counter in the URL, the timer to the next read, whether
     one is in flight, misses in a row, the printer held to be gone. */
  n: 0,
  timer: 0,
  busy: false,
  fails: 0,
  offline: false,
  /* The restart every 10 s. */
  keep: 0,
  full: false,
  pinned: localStorage.getItem("snapstudio.cam.pinned") === "1",
  /* A site's native view shows the camera meanwhile. */
  overlay: false,
  overlayKey: "",
  /* Where the screen wants the camera: { el, id, opts }, or null. */
  home: null,
  /* The printer whose camera would not start: not tried again by itself
     (a record redrawn every few seconds would), only by a switch. */
  failed: null,
  placing: 0,
};

/* The box and its parts, held once: the box moves into hosts that their
   screens rebuild (innerHTML), which detaches it; a reference survives
   that, an id lookup would not. Nowhere to show, it waits in #cam-park. */
const CAM_EL = (() => {
  const box = $("cam-box");
  const q = (sel) => box.querySelector(sel);
  return { box, img: q("#cam-img"), note: q("#cam-note"), off: q("#cam-off"), tag: q("#cam-tag"), size: q("#cam-size"), close: q("#cam-close"), pin: q("#cam-pin"), fullBtn: q("#cam-full-btn"), park: $("cam-park"), full: $("cam-full"), pip: $("cam-pip"), pipBody: $("cam-pip-body"), pipName: $("cam-pip-name") };
})();
const camBox = () => CAM_EL.box;
const camImg = () => CAM_EL.img;
const camNote = (text) => (CAM_EL.note.textContent = text || "");
const camChanged = () => document.dispatchEvent(new CustomEvent("cam-change"));

/* ------------------------------------------------------------ screens */

/* A screen shows a printer: the camera's place there. `opts`: `auto`
   starts it by itself (unless it failed on that printer, or a pinned
   stream shows another one); `tag` "live" or "paused" shows a badge;
   `enlarge` offers the Enlarge button; `close: false` hides the ✕ (the
   screen has its own switch there). */
function camHome(el, id, opts = {}) {
  const h = CAM.home;
  // The same place, printer and choices as before (a record redrawn every
  // few seconds): nothing to do, unless the box, due there, was detached
  // meanwhile (the screen rebuilt its place).
  const same = h && el && h.el === el && h.id === id && ["auto", "tag", "enlarge", "close"].every((k) => h.opts[k] === opts[k]);
  if (same && (camHostOf(CAM) !== "home" || el.contains(CAM_EL.box))) return;
  CAM.home = el && id ? { el, id, opts } : null;
  // Another printer than the stream's: the stream ends, unless pinned (it
  // goes on in its window).
  if (CAM.on && CAM.home && CAM.home.id !== CAM.id && !CAM.pinned) camStop();
  camPlace();
  if (CAM.home && opts.auto && !CAM.on && CAM.failed !== id) camStart(id, true);
}

/* Leaving a screen: nothing shows the camera there any more. The box is
   placed again a moment later, so that the next screen, drawn right away,
   keeps a stream of the same printer without a stop and a start. */
function camLeave() {
  CAM.full = false;
  CAM.home = null;
  if (!CAM.placing) CAM.placing = setTimeout(() => {
    CAM.placing = 0;
    camPlace();
  }, 0);
}

/* The screens' status of a printer: gone, said over its camera wherever
   it shows (the frames say when it is back). */
function camPrinterStatus(id, online) {
  if (id === CAM.id && CAM.on && !online) camOffline(true);
}

/* ------------------------------------------------------------ stream */

/* `quiet`: started by a screen, not a switch — a failure is not told, only
   remembered. */
async function camStart(id = CAM.home?.id, quiet = false) {
  if (!id || (CAM.on && CAM.id === id)) return;
  camStop();
  const gen = ++CAM.gen;
  Object.assign(CAM, { id, on: true, fails: 0, failed: null });
  camNote(tr("printers.cam.starting"));
  camPlace();
  try {
    await invoke("camera_start", { printerId: id });
  } catch (e) {
    if (gen !== CAM.gen) return;
    camStop();
    CAM.failed = id;
    if (!quiet) toast(String(e), true);
    return;
  }
  if (gen !== CAM.gen || !CAM.on) return;
  CAM.keep = setInterval(() => invoke("camera_start", { printerId: id }).catch(() => {}), 10000);
  camNext();
}

function camStop() {
  clearTimeout(CAM.timer);
  clearInterval(CAM.keep);
  if (CAM.on && CAM.id) invoke("camera_stop", { printerId: CAM.id }).catch(() => {});
  Object.assign(CAM, { id: null, on: false, timer: 0, keep: 0, busy: false, fails: 0, full: false });
  camImg().removeAttribute("src");
  camNote("");
  camOffline(false);
  camPlace();
}

/* The next frame, unless one is in flight or nothing would show it. */
function camNext() {
  clearTimeout(CAM.timer);
  CAM.timer = 0;
  if (!CAM.on || CAM.busy || document.hidden || CAM.overlay) return;
  CAM.busy = true;
  camImg().src = schemeUrl("cam", `/f?id=${encodeURIComponent(CAM.id)}&n=${++CAM.n}`);
}

/* The window shown again, the site's view gone: the frames go on. */
function camResume() {
  if (CAM.on) camNext();
}

camImg().addEventListener("load", () => {
  CAM.busy = false;
  if (!CAM.on) return;
  camNote("");
  CAM.fails = 0;
  if (CAM.offline) camOffline(false);
  CAM.timer = setTimeout(camNext, camRetryDelay(0));
});
camImg().addEventListener("error", () => {
  CAM.busy = false;
  if (!CAM.on) return;
  camNote(tr("printers.cam.retry"));
  // A few misses in a row: the printer is gone. Tried again, less often.
  if (++CAM.fails >= 3) camOffline(true);
  CAM.timer = setTimeout(camNext, camRetryDelay(CAM.fails, CAM.offline));
});
document.addEventListener("visibilitychange", camResume);

/* The printer does not answer: said plainly over the camera, never its
   last image frozen. */
function camOffline(on) {
  CAM.offline = on;
  CAM_EL.off.classList.toggle("hidden", !on);
  CAM_EL.img.classList.toggle("hidden", on);
}

/* ------------------------------------------------------------ place */

/* Puts the box where it shows (camera-logic.js camHostOf) and paints its
   controls. A stream with nowhere to show ends. */
function camPlace() {
  const { box, full, pip, pipBody, park } = CAM_EL;
  const where = camHostOf(CAM);
  if (CAM.on && !where) return camStop();
  const host = where === "full" ? full : where === "pip" ? pipBody : where === "home" ? CAM.home.el : park;
  if (box.parentElement !== host) host.appendChild(box);
  box.classList.toggle("hidden", !CAM.on);
  box.classList.toggle("full", where === "full");
  full.classList.toggle("hidden", where !== "full");
  pip.classList.toggle("hidden", where !== "pip");
  // The screen's choices apply to its own printer's stream.
  const o = CAM.home && (!CAM.on || CAM.home.id === CAM.id) ? CAM.home.opts : {};
  CAM_EL.size.classList.toggle("hidden", !o.enlarge);
  CAM_EL.close.classList.toggle("hidden", o.close === false);
  CAM_EL.tag.classList.toggle("hidden", !o.tag);
  CAM_EL.tag.classList.toggle("paused", o.tag === "paused");
  const name = camPrinterName();
  CAM_EL.pipName.textContent = name;
  CAM_EL.pin.classList.toggle("on", CAM.pinned);
  const label = (el, key) => {
    el.title = tr(key);
    el.setAttribute("aria-label", tr(key));
  };
  label(CAM_EL.pin, CAM.pinned ? "printers.cam.unpin" : "printers.cam.pin");
  label(CAM_EL.fullBtn, CAM.full ? "printers.cam.full_exit" : "printers.cam.full");
  camOverlay(name);
  camChanged();
}

/* The stream's printer, as named in Printers (printers.js, loaded after:
   called only once the app runs). */
const camPrinterName = () => printerName(CAM.id);

function camPin(on) {
  CAM.pinned = on;
  localStorage.setItem("snapstudio.cam.pinned", on ? "1" : "0");
  // Unpinned away from its screen: nothing shows it any more (camPlace).
  camPlace();
}

function camFull(on) {
  CAM.full = on && CAM.on;
  camPlace();
}

/* Enlarge, where the screen allows it: its button (shown on hover). */
function camToggleSize() {
  const big = CAM_EL.box.classList.toggle("big");
  CAM_EL.size.title = tr(big ? "printers.cam.shrink" : "printers.cam.enlarge");
}

/* ------------------------------------------------------------ overlay */

/* A site of Explore is a native view over the interface, which covers the
   pinned window: Rust lays a small view of ours over it at the same place
   (library.rs, camview.html), shown while a site is. Told where the pinned
   window is, or that there is none. */
function camOverlay(name = camPrinterName()) {
  const pip = CAM_EL.pip;
  const on = CAM.on && !pip.classList.contains("hidden");
  const setup = on
    ? JSON.stringify({
        id: CAM.id,
        name,
        lang: LANG,
        texts: { unpin: tr("printers.cam.unpin"), close: tr("printers.cam.close"), offline: tr("printers.cam.offline"), open: tr("printers.cam.open") },
      })
    : "";
  const r = on ? pip.getBoundingClientRect() : null;
  const key = on ? `${setup}|${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}` : "";
  if (key === CAM.overlayKey) return;
  CAM.overlayKey = key;
  invoke("cam_view_set", { rect: on ? { x: r.left, y: r.top, w: r.width, h: r.height } : null, setup }).catch(() => {});
}
window.addEventListener("resize", () => CAM.on && camOverlay());

// Shown over a site or not: the interface's frames pause meanwhile.
listen("cam-view", (e) => {
  const shown = !!e.payload?.shown;
  if (shown === CAM.overlay) return;
  CAM.overlay = shown;
  if (!shown) camResume();
});
// Its buttons: the camera is the interface's.
listen("cam-view-action", (e) => {
  if (e.payload === "open") camOpenPrinter();
  else if (e.payload === "unpin") camPin(false);
  else if (e.payload === "close") camStop();
});

/* ------------------------------------------------------------ controls */

CAM_EL.close.addEventListener("click", camStop);
CAM_EL.size.addEventListener("click", camToggleSize);
CAM_EL.fullBtn.addEventListener("click", () => camFull(!CAM.full));
CAM_EL.pin.addEventListener("click", () => camPin(!CAM.pinned));
$("cam-pip-unpin").addEventListener("click", () => camPin(false));
$("cam-pip-close").addEventListener("click", camStop);
// Full size: a click beside the picture — the margin, or the bands left
// around the image drawn to fit — gives it back, as Esc does. No frame yet
// or offline: the whole box is the camera, only the margin does.
$("cam-full").addEventListener("click", (e) => {
  if (!CAM.full || e.target.closest(".cam-bar")) return;
  if (e.target === CAM_EL.full) return camFull(false);
  const img = camImg();
  if (CAM.offline || img.classList.contains("hidden") || !img.naturalWidth) return;
  const r = img.getBoundingClientRect();
  const pic = camPictureRect(r.width, r.height, img.naturalWidth, img.naturalHeight);
  if (!camInside(pic, e.clientX - r.left, e.clientY - r.top)) camFull(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && CAM.full && !document.querySelector(".modal:not(.hidden)")) {
    e.stopPropagation();
    camFull(false);
  }
}, true);
// The pinned window's image leads back to its printer's page (printers.js).
$("cam-pip-body").addEventListener("click", (e) => {
  if (!e.target.closest(".cam-bar")) camOpenPrinter();
});

/* The pinned window moves with its title bar and settles in the nearest
   corner of the window, remembered. */
function camCorner(c) {
  const pip = $("cam-pip");
  ["tl", "tr", "bl", "br"].forEach((k) => pip.classList.toggle("at-" + k, k === c));
  pip.style.left = pip.style.top = "";
}
camCorner(localStorage.getItem("snapstudio.cam.corner") || "br");
$("cam-pip-head").addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || e.target.closest("button")) return;
  const pip = $("cam-pip"), r = pip.getBoundingClientRect();
  const dx = e.clientX - r.left, dy = e.clientY - r.top;
  pip.setPointerCapture(e.pointerId);
  pip.classList.add("dragging");
  const move = (ev) => {
    pip.style.left = `${Math.max(0, Math.min(innerWidth - r.width, ev.clientX - dx))}px`;
    pip.style.top = `${Math.max(0, Math.min(innerHeight - r.height, ev.clientY - dy))}px`;
  };
  const up = (ev) => {
    pip.removeEventListener("pointermove", move);
    pip.removeEventListener("pointerup", up);
    // Measured while still dragged (its corner's anchors would stretch it).
    const q = pip.getBoundingClientRect();
    pip.classList.remove("dragging");
    const c = (q.top + q.height / 2 < innerHeight / 2 ? "t" : "b") + (q.left + q.width / 2 < innerWidth / 2 ? "l" : "r");
    localStorage.setItem("snapstudio.cam.corner", c);
    camCorner(c);
    camOverlay();
  };
  pip.addEventListener("pointermove", move);
  pip.addEventListener("pointerup", up);
});

window.addEventListener("langchange", () => {
  if (CAM.on) camPlace();
});
