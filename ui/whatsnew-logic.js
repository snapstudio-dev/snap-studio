"use strict";
/* What's new: the pure part, tested by scripts/test-whatsnew.js.

   The page is on the site; the app shows a card in the sidebar until the
   installed version's page has been opened once, then a plain line. Seen
   is remembered per minor version (0.14), so a patch release (0.14.1)
   keeps it seen and the next version with a page (0.15) shows the card
   again. `entry` is ui/whats-new.json: the current version's highlights. */

const WN_PAGE = "https://kameka22.github.io/snap-studio/whats-new/";
const WN_CHANGELOG = "https://github.com/kameka22/snap-studio/blob/main/CHANGELOG.md";
const WN_SEEN_KEY = "snapstudio.whatsnew.seen";

/* "0.14.1" → "0.14"; null for anything else. */
function wnMinor(version) {
  const m = /^v?(\d+)\.(\d+)(?:\.|$|-)/.exec(String(version || "").trim());
  return m ? `${+m[1]}.${+m[2]}` : null;
}

/* The card shows while the installed version has a page and it was not
   opened yet. */
function wnUnseen(installed, entry, seen) {
  const minor = wnMinor(installed);
  return !!minor && !!entry && entry.version === minor && seen !== minor;
}

/* The highlights' short names in `lang`, English when one is missing. */
function wnHighlights(entry, lang) {
  const list = entry && Array.isArray(entry.highlights) ? entry.highlights : [];
  return list.map((h) => (h && (h[lang] || h.en)) || "").filter(Boolean);
}

/* The page as the viewer loads it: no site header, the app's language,
   on the installed version. `embed` false: for the browser. */
function wnUrl(lang, installed, embed = true) {
  const q = new URLSearchParams();
  if (embed) q.set("embed", "1");
  q.set("lang", lang === "fr" ? "fr" : "en");
  const minor = wnMinor(installed);
  return `${WN_PAGE}?${q}${minor ? `#v${minor}` : ""}`;
}

/* The page's address without its query, as the sheet's bar shows it. */
function wnShownAddress(url) {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return "";
  }
}

/* A message from the page in the viewer: { type: "ready" | "error" |
   "close" } or { type: "open", url } for a link to open in the browser.
   Only the page's own origin is heard, only web links are opened. */
function wnMessage(origin, data) {
  if (origin !== new URL(WN_PAGE).origin) return null;
  if (!data || typeof data !== "object" || data.source !== "snapstudio-whats-new") return null;
  if (["ready", "error", "close"].includes(data.type)) return { type: data.type };
  if (data.type === "open" && typeof data.url === "string") {
    try {
      const u = new URL(data.url);
      if (u.protocol === "https:" || u.protocol === "http:") return { type: "open", url: u.href };
    } catch {}
  }
  return null;
}

if (typeof module !== "undefined")
  module.exports = { WN_PAGE, WN_CHANGELOG, WN_SEEN_KEY, wnMinor, wnUnseen, wnHighlights, wnUrl, wnShownAddress, wnMessage };
