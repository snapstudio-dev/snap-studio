"use strict";
/* Window buttons on Windows and Linux (src-tauri/src/titlebar.rs). The
   window has no system decorations: its buttons are drawn here, in the 52 px
   band where macOS puts its traffic lights. Windows: top right, its own
   style. Linux: the three buttons on the side of the desktop's layout, GNOME
   style; the system title bar can be put back from Settings › Display. The
   bars at the top (sidebar, toolbar, Library tabs, 3D viewer) keep them clear
   through --wc-left / --wc-right. */

const WC_WINDOW = window.__TAURI__.window.getCurrentWindow();

/* 10 × 10 glyphs, drawn with a line (style.css sets its width per system). */
const WC_GLYPHS = {
  minimize: '<path d="M0 5.5h10"/>',
  maximize: '<rect x=".5" y=".5" width="9" height="9"/>',
  restore: '<path d="M2.5 2.5V.5h7v7h-2"/><rect x=".5" y="2.5" width="7" height="7"/>',
  close: '<path d="m.5.5 9 9m0-9-9 9"/>',
};

const WC_ACTIONS = {
  minimize: () => WC_WINDOW.minimize(),
  maximize: () => WC_WINDOW.toggleMaximize(),
  close: () => WC_WINDOW.close(),
};

function wcButton(name) {
  const b = document.createElement("button");
  b.type = "button";
  // Like the system's buttons: never in the keyboard's path.
  b.tabIndex = -1;
  b.className = `wc-btn wc-${name}`;
  b.dataset.wc = name;
  b.addEventListener("click", () => WC_ACTIONS[name]().catch(() => {}));
  return b;
}

/* Glyph and label of each button; maximize turns into restore. */
function wcLabel(maximized) {
  for (const b of document.querySelectorAll(".wc-btn")) {
    const name = b.dataset.wc === "maximize" && maximized ? "restore" : b.dataset.wc;
    b.innerHTML = `<svg viewBox="0 0 10 10" aria-hidden="true">${WC_GLYPHS[name]}</svg>`;
    b.setAttribute("aria-label", tr(`window.${name}`));
    // Windows names its buttons on hover; GNOME does not.
    if (document.documentElement.dataset.wcOs === "windows") b.title = tr(`window.${name}`);
  }
}

async function wcSync() {
  wcLabel(await WC_WINDOW.isMaximized().catch(() => false));
}

/* Draws the buttons the title bar info asks for (none: macOS, or the system
   title bar on Linux) and reserves their room. */
function wcRender(info) {
  const root = document.documentElement;
  document.querySelectorAll(".wc").forEach((e) => e.remove());
  root.dataset.wcOs = info.os;
  for (const side of ["left", "right"]) {
    const names = info.custom ? info[side] : [];
    root.classList.toggle(`wc-${side}`, names.length > 0);
    root.style.setProperty(`--wc-${side}`, "0px");
    if (!names.length) continue;
    const box = document.createElement("div");
    // The gaps between the buttons still move the window.
    box.className = `wc wc-side-${side}`;
    box.setAttribute("data-tauri-drag-region", "");
    box.append(...names.map(wcButton));
    document.body.append(box);
    root.style.setProperty(`--wc-${side}`, `${box.offsetWidth}px`);
  }
  wcSync();
}

/* Settings › Display: system title bar (Linux). */
function wcSwitch(info) {
  $("disp-sysbar-row").classList.toggle("hidden", !info.switchable);
  $("disp-sysbar").checked = !info.custom;
}

$("disp-sysbar").addEventListener("change", (e) => {
  invoke("titlebar_system_set", { on: e.target.checked })
    .then((info) => {
      wcRender(info);
      wcSwitch(info);
    })
    .catch(() => {
      e.target.checked = !e.target.checked;
    });
});

invoke("titlebar_info")
  .then((info) => {
    wcRender(info);
    wcSwitch(info);
  })
  .catch(() => {});

/* Linux: the bar moves the window and a double click on it toggles
   maximize. Tauri starts the move on the press, and the window manager then
   holds the pointer: the second click of a double click never reaches the
   page. As GTK's own title bars do, the move starts here once the pointer
   moves, button down, and two presses close in time and place maximize.
   Same elements as Tauri's (the drag region itself, not its children);
   caught first (capture), so Tauri's handler stays out. */
let wcPress = null;
window.addEventListener(
  "mousedown",
  (e) => {
    if (document.documentElement.dataset.wcOs !== "linux" || e.button !== 0) return;
    const attr = e.target.getAttribute?.("data-tauri-drag-region");
    if (attr !== "" && attr !== "true") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const prev = wcPress;
    // `held` until the button is released: only then can a move start.
    wcPress = { t: e.timeStamp, x: e.screenX, y: e.screenY, held: true, moving: false };
    if (prev && !prev.moving && e.timeStamp - prev.t < 500 && Math.hypot(e.screenX - prev.x, e.screenY - prev.y) < 6) {
      wcPress = null;
      WC_WINDOW.toggleMaximize().catch(() => {});
    }
  },
  true,
);
window.addEventListener(
  "mousemove",
  (e) => {
    const p = wcPress;
    if (!p || !p.held || p.moving || !(e.buttons & 1)) return;
    if (Math.hypot(e.screenX - p.x, e.screenY - p.y) < 4) return;
    p.moving = true;
    WC_WINDOW.startDragging().catch(() => {});
  },
  true,
);

window.addEventListener(
  "mouseup",
  () => {
    if (wcPress) wcPress.held = false;
  },
  true,
);

WC_WINDOW.onResized(() => {
  if (document.querySelector(".wc")) wcSync();
});

window.addEventListener("langchange", () => {
  if (document.querySelector(".wc")) wcSync();
});
