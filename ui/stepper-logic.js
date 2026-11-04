"use strict";
/* Number steppers (stepper.js): the value one step up or down. Pure, for
   scripts/test-stepper.js. */

/* Decimals a step carries: 0.1 → 1, 0.05 → 2, 10 → 0. */
function stDecimals(step) {
  const s = String(step ?? "");
  const e = /e-(\d+)$/i.exec(s);
  if (e) return +e[1];
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.length - i - 1;
}

/* The value after `dir` steps (±1), kept within min and max, rounded to the
   step's decimals (0.1 + 0.2 gives 0.3, not 0.30000000000000004). An empty
   or unreadable value starts from min, else 0. As a string, as an input
   holds it. */
function stStep(value, dir, { step = 1, min = null, max = null } = {}) {
  const st = +step > 0 ? +step : 1;
  const lo = min === "" || min == null || isNaN(+min) ? null : +min;
  const hi = max === "" || max == null || isNaN(+max) ? null : +max;
  const cur = String(value ?? "").trim() === "" || isNaN(+value) ? null : +value;
  let v = cur == null ? (lo ?? 0) : cur + dir * st;
  if (lo != null) v = Math.max(lo, v);
  if (hi != null) v = Math.min(hi, v);
  const d = Math.max(stDecimals(step), cur == null ? 0 : stDecimals(value));
  return String(+v.toFixed(Math.min(d, 10)));
}

/* Whether a step that way can move the value (the button is then live). */
function stCan(value, dir, opts = {}) {
  if (String(value ?? "").trim() === "" || isNaN(+value)) return true;
  return stStep(value, dir, opts) !== String(+value);
}

if (typeof module !== "undefined") module.exports = { stDecimals, stStep, stCan };
