"use strict";
/* What's new: the sidebar card and the page's viewer.

   The page lives on the site (site/whats-new/), so it can be corrected
   without a release. The card above Settings says a new version has one
   ("What's new in 0.14 — Explore and 3 more", from ui/whats-new.json, so
   it works offline) until it is opened; then it is a plain line. The page
   opens in a sheet over the app, in a frame: no header of the site
   (?embed=1), the app's language, on the installed version. It talks back
   by messages (whatsnew-logic.js): loaded, Esc, a link to open in the
   browser. Never opened by itself. */

const WN = {
  entry: null,     // ui/whats-new.json
  installed: "",   // the app's version
  timer: 0,        // gives up waiting for the page
};

function wnSeen() {
  try {
    return localStorage.getItem(WN_SEEN_KEY);
  } catch {
    return null;
  }
}

function wnRender() {
  const unseen = wnUnseen(WN.installed, WN.entry, wnSeen());
  $("wn-card").classList.toggle("hidden", !unseen);
  $("wn-line").classList.toggle("hidden", unseen);
  $("side-wn").classList.toggle("unseen", unseen);
  if (!unseen) return;
  const names = wnHighlights(WN.entry, LANG);
  $("wn-card-title").textContent = tr("whatsnew.card", { v: WN.entry.version });
  $("wn-card-sub").textContent = names.length > 1 ? tr("whatsnew.more", { first: names[0], n: names.length - 1 }) : names[0] || "";
}

/* ------------------------------------------------------------ the sheet */

function wnState(s) {
  $("wn-sheet").dataset.state = s;
  $("wn-loading").classList.toggle("hidden", s !== "loading");
  $("wn-error").classList.toggle("hidden", s !== "error");
}

/* A new frame each time, never the same one reloaded: WebKit (macOS) can
   leave a frame that was in a hidden sheet black once shown again. A new
   one also loads the same address again (Retry). */
function wnFrame(url) {
  const old = $("wn-frame");
  const frame = old.cloneNode(false);
  frame.removeAttribute("src");
  frame.addEventListener("load", wnFrameLoaded);
  if (url) frame.src = url;
  old.replaceWith(frame);
  return frame;
}

function wnLoad() {
  clearTimeout(WN.timer);
  if (!navigator.onLine) {
    wnFrame("");
    wnState("error");
    return;
  }
  wnState("loading");
  const url = wnUrl(LANG, WN.installed);
  $("wn-address").textContent = wnShownAddress(url);
  wnFrame(url);
  // The page says when it is shown; silence means no network, or a page
  // that could not load.
  WN.timer = setTimeout(() => {
    if ($("wn-sheet").dataset.state === "loading") wnState("error");
  }, 15000);
}

function wnOpen() {
  const minor = wnMinor(WN.installed);
  if (WN.entry && minor === WN.entry.version) {
    try {
      localStorage.setItem(WN_SEEN_KEY, minor);
    } catch {}
  }
  wnRender();
  openSheet($("wn-modal"));
  wnLoad();
}

function wnClose() {
  clearTimeout(WN.timer);
  closeSheet($("wn-modal"));
  // The page is let go: it takes memory, and comes back in the current
  // language next time.
  setTimeout(() => {
    if ($("wn-modal").classList.contains("hidden")) wnFrame("");
  }, 200);
}

const wnBrowser = (url) => invoke("plugin:opener|open_url", { url }).catch((e) => toast(String(e), true));

$("wn-card").addEventListener("click", wnOpen);
$("wn-line").addEventListener("click", wnOpen);
$("wn-close").addEventListener("click", wnClose);
$("wn-retry").addEventListener("click", wnLoad);
$("wn-browser").addEventListener("click", () => wnBrowser(wnUrl(LANG, WN.installed, false)));
$("wn-changelog").addEventListener("click", () => wnBrowser(WN_CHANGELOG));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("wn-modal").classList.contains("hidden")) {
    e.preventDefault();
    wnClose();
  }
});

window.addEventListener("message", (e) => {
  if (e.source !== $("wn-frame").contentWindow) return;
  const m = wnMessage(e.origin, e.data);
  if (!m) return;
  if (m.type === "ready") {
    clearTimeout(WN.timer);
    wnState("ready");
  } else if (m.type === "error") {
    clearTimeout(WN.timer);
    wnState("error");
  } else if (m.type === "close") {
    wnClose();
  } else if (m.type === "open") {
    wnBrowser(m.url);
  }
});
/* Loaded but silent: an error page (no network, a page that is gone).
   The page tells it is shown right after its own load, a little later. */
function wnFrameLoaded() {
  if ($("wn-sheet").dataset.state !== "loading" || !/^https:/.test($("wn-frame").src)) return;
  clearTimeout(WN.timer);
  WN.timer = setTimeout(() => {
    if ($("wn-sheet").dataset.state === "loading") wnState("error");
  }, 4000);
}
window.addEventListener("offline", () => {
  if ($("wn-sheet").dataset.state === "loading") wnState("error");
});

window.addEventListener("langchange", wnRender);

(async () => {
  const [installed, entry] = await Promise.all([
    invoke("app_version").catch(() => ""),
    fetch("whats-new.json")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);
  WN.installed = installed || "";
  WN.entry = entry;
  wnRender();
})();
