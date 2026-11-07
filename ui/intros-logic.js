"use strict";
/* Feature introductions (intros.js), the parts without a page: which ones
   to show, and where a move in the welcome assistant lands. Pure, for
   scripts/test-intros.js. An introduction here only needs `available()`
   and `seen()`. */

/* The introductions to show: in the welcome assistant ("welcome"), every
   one available; in the first-launch notice ("notice"), the available
   ones not seen yet. The development preview shows them all. */
function introsFor(where, list, { preview = false } = {}) {
  if (preview) return list;
  return list.filter((i) => i.available() && (where === "welcome" || !i.seen()));
}

/* The step a move to `target` lands on, from `from`, among steps 0 to
   `last`: a step `skipped(n)` says to pass is passed in the direction of
   the move. */
function introsLand(target, from, last, skipped) {
  const dir = target >= from ? 1 : -1;
  let n = Math.max(0, Math.min(last, target));
  while (n > 0 && n < last && skipped(n)) n += dir;
  return n;
}

if (typeof module !== "undefined") module.exports = { introsFor, introsLand };
