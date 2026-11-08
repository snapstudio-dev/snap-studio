"use strict";
/* Files attached to an AI message (ia-chat.js, ia.js): which files may be,
   how many, where a drop on the window goes, the paths of a paste. Pure,
   for scripts/test-attach.js. The app checks each file again
   (ia_attach.rs). */

const ATTACH_IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp"];
const ATTACH_MODEL_EXT = ["stl", "3mf"];
const ATTACH_MAX_IMAGES = 5;
const ATTACH_MAX_MODELS = 3;

/* "image", "model" or null, from the extension of a name or a path (a
   name made of an extension only, ".stl", has none). */
function attachKind(name) {
  const base = String(name || "").split(/[\\/]/).pop();
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  if (ATTACH_IMAGE_EXT.includes(ext)) return "image";
  if (ATTACH_MODEL_EXT.includes(ext)) return "model";
  return null;
}

/* Where files dropped on the window go: the creation sheet when it is open,
   the conversation the AI view shows, otherwise nowhere — app.js then keeps
   its own behavior (a model's folder opens in Files). */
function attachTarget({ sheetOpen, iaVisible, convOpen } = {}) {
  if (sheetOpen) return "sheet";
  if (iaVisible && convOpen) return "chat";
  return null;
}

/* The local paths of a text/uri-list (files copied in a file manager):
   comments and other schemes skipped, `file://host/…` of another machine
   too; percent-decoded; `/C:/x` of Windows back to `C:/x`. */
function pathsFromUriList(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^file:\/\/([^/]*)(\/.*)$/i.exec(line);
    if (!m || (m[1] && m[1].toLowerCase() !== "localhost")) continue;
    let p = m[2];
    try {
      p = decodeURIComponent(p);
    } catch {
      continue;
    }
    if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
    out.push(p);
  }
  return out;
}

/* How many more images (or models) a message may take. */
function attachRoom(list, kind) {
  const n = (list || []).filter((a) => (a.kind === "model") === (kind === "model")).length;
  return (kind === "model" ? ATTACH_MAX_MODELS : ATTACH_MAX_IMAGES) - n;
}

/* The message for a file the app refused ({ name, reason, max }): its key
   and parameters. `max` stays raw: bytes for "size", a count for "tris". */
function attachRejectMessage(r) {
  const name = r?.name || "?";
  switch (r?.reason) {
    case "type":
      return ["chat.unsupported_file", { name }];
    case "size":
      return ["chat.file_too_big", { name, max: r.max }];
    case "tris":
      return ["chat.model_tris", { name, max: r.max }];
    default:
      return [attachKind(name) === "image" ? "chat.bad_image" : "chat.model_unreadable", { name }];
  }
}

/* A size that suggests another unit than the millimeter (STL has none). */
function attachOddScale(size) {
  const longest = Math.max(0, ...(size || []).map(Number).filter(Number.isFinite));
  return longest < 1 || longest > 1000;
}

/* Dimensions for the chip: to a tenth of a millimeter, two significant
   digits under 1 mm (a model in meters must not read "0 × 0 × 0"). */
const attachDims = (size) =>
  (size || [0, 0, 0]).slice(0, 3).map((v) => {
    const n = Number(v) || 0;
    return Math.abs(n) >= 1 ? Math.round(n * 10) / 10 : Number(n.toPrecision(2));
  });

if (typeof module !== "undefined") {
  module.exports = {
    ATTACH_IMAGE_EXT,
    ATTACH_MODEL_EXT,
    ATTACH_MAX_IMAGES,
    ATTACH_MAX_MODELS,
    attachKind,
    attachTarget,
    pathsFromUriList,
    attachRoom,
    attachRejectMessage,
    attachOddScale,
    attachDims,
  };
}
