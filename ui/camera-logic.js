"use strict";
/* The printer camera's pure parts (camera.js): where its box goes, how
   long to wait after a missed frame, where the picture is drawn in its
   full-size box. For scripts/test-camera.js. */

/* Where the camera shows. `on`: a stream runs for printer `id`; `home`:
   what the current screen asked for ({ id }), or null; `full` and `pinned`:
   the user's choices. "full" over the content area, "home" the screen's
   place (also when off: the box waits there, hidden), "pip" the small
   window over every screen, null nowhere (a stream then ends). */
function camHostOf({ on, full, pinned, id, home }) {
  if (!on) return home ? "home" : null;
  if (full) return "full";
  if (home && home.id === id) return "home";
  return pinned ? "pip" : null;
}

/* Delay before the next read, in ms: right after a frame; a moment after a
   miss; longer once the printer is held to be gone (three misses, or its
   status said so). */
function camRetryDelay(fails, offline = false) {
  if (!fails) return 200;
  return fails >= 3 || offline ? 3000 : 1000;
}

/* The rectangle an image of imgW × imgH takes in a box of boxW × boxH with
   object-fit: contain — centred, the bands left around it empty. No image
   size yet: the whole box. */
function camPictureRect(boxW, boxH, imgW, imgH) {
  if (!(imgW > 0 && imgH > 0 && boxW > 0 && boxH > 0)) return { x: 0, y: 0, w: Math.max(0, boxW || 0), h: Math.max(0, boxH || 0) };
  const s = Math.min(boxW / imgW, boxH / imgH);
  const w = imgW * s, h = imgH * s;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

/* Whether a point of the box is on the picture (its edge included). */
const camInside = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

if (typeof module !== "undefined") module.exports = { camHostOf, camRetryDelay, camPictureRect, camInside };
