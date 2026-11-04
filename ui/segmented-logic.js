"use strict";
/* Segmented controls over hidden <select>s (segmented.js): the segments
   from the options, the language flags, the filters' count. Pure, for
   scripts/test-segmented.js. */

/* The segments of a select's options ({ value, text|label, disabled }):
   the chosen one on; the first when none matches (a select shows its
   first option then). */
function segItems(options, value) {
  const items = [...(options || [])].map((o) => ({ value: String(o.value), label: String(o.label ?? o.text ?? o.value).trim(), disabled: !!o.disabled }));
  const v = value == null ? null : String(value);
  const at = Math.max(0, items.findIndex((it) => it.value === v));
  return items.map((it, i) => ({ ...it, on: items.length > 0 && i === at }));
}

/* Flags drawn inline: emoji flags are letters on Windows. 3:2, rounded by
   the CSS. A language without its flag shows its code. */
const SEG_FLAGS = {
  fr: '<svg viewBox="0 0 3 2" aria-hidden="true"><path fill="#002654" d="M0 0h1v2H0z"/><path fill="#fff" d="M1 0h1v2H1z"/><path fill="#ce1126" d="M2 0h1v2H2z"/></svg>',
  en: '<svg viewBox="0 0 60 40" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><path fill="#012169" d="M0 0h60v40H0z"/><path stroke="#fff" stroke-width="8" d="M0 0l60 40M60 0L0 40"/><path stroke="#c8102e" stroke-width="3" d="M0 0l60 40M60 0L0 40"/><path stroke="#fff" stroke-width="12" d="M30 0v40M0 20h60"/><path stroke="#c8102e" stroke-width="7" d="M30 0v40M0 20h60"/></svg>',
  de: '<svg viewBox="0 0 5 3" aria-hidden="true"><path fill="#000" d="M0 0h5v1H0z"/><path fill="#dd0000" d="M0 1h5v1H0z"/><path fill="#ffce00" d="M0 2h5v1H0z"/></svg>',
  es: '<svg viewBox="0 0 3 2" aria-hidden="true"><path fill="#aa151b" d="M0 0h3v2H0z"/><path fill="#f1bf00" d="M0 .5h3v1H0z"/></svg>',
  "pt-br": '<svg viewBox="0 0 20 14" aria-hidden="true"><path fill="#009b3a" d="M0 0h20v14H0z"/><path fill="#fedf00" d="M10 1.7 18.3 7 10 12.3 1.7 7z"/><circle cx="10" cy="7" r="3.5" fill="#002776"/></svg>',
  it: '<svg viewBox="0 0 3 2" aria-hidden="true"><path fill="#009246" d="M0 0h1v2H0z"/><path fill="#fff" d="M1 0h1v2H1z"/><path fill="#ce2b37" d="M2 0h1v2H2z"/></svg>',
  ja: '<svg viewBox="0 0 3 2" aria-hidden="true"><path fill="#fff" d="M0 0h3v2H0z"/><circle cx="1.5" cy="1" r=".6" fill="#bc002d"/></svg>',
  "zh-hans": '<svg viewBox="0 0 30 20" aria-hidden="true"><path fill="#ee1c25" d="M0 0h30v20H0z"/><path fill="#ffff00" d="M5 2 5.67 4.07 7.85 4.07 6.09 5.35 6.76 7.43 5 6.15 3.24 7.43 3.91 5.35 2.15 4.07 4.33 4.07zM9.14 2.51 9.62 1.97 9.25 1.34 9.91 1.63 10.39 1.08 10.33 1.8 11 2.09 10.29 2.25 10.22 2.97 9.85 2.35zM11.01 4.14 11.66 3.82 11.56 3.1 12.07 3.62 12.72 3.3 12.38 3.95 12.88 4.47 12.17 4.34 11.83 4.99 11.73 4.27zM11.04 6.73 11.76 6.7 11.96 6 12.21 6.68 12.94 6.66 12.37 7.1 12.62 7.79 12.01 7.38 11.44 7.83 11.64 7.13zM9.22 8.38 9.9 8.63 10.35 8.06 10.32 8.79 11 9.05 10.3 9.24 10.26 9.96 9.87 9.36 9.16 9.55 9.62 8.98z"/></svg>',
  ko: '<svg viewBox="-36 -24 72 48" aria-hidden="true"><path fill="#fff" d="M-36-24h72v48h-72z"/><g transform="rotate(-56.31)"><path stroke="#000" stroke-width="2" d="M-6-25H6M-6-22H6M-6-19H6M-6 19H6M-6 22H6M-6 25H6"/><path stroke="#fff" d="M0 17v10"/><circle r="12" fill="#cd2e3a"/><path fill="#0047a0" d="M0-12A6 6 0 0 0 0 0A6 6 0 0 1 0 12A12 12 0 0 1 0-12z"/></g><g transform="rotate(-123.69)"><path stroke="#000" stroke-width="2" d="M-6-25H6M-6-22H6M-6-19H6M-6 19H6M-6 22H6M-6 25H6"/><path stroke="#fff" d="M0-23.5v3M0 17v3.5M0 23.5v3"/></g></svg>',
};
function segFlag(code) {
  const c = String(code || "").toLowerCase();
  return SEG_FLAGS[c] || `<span class="seg-flag-code" aria-hidden="true">${c.slice(0, 2).toUpperCase().replace(/[^A-Z]/g, "")}</span>`;
}

/* Up to this many languages side by side; more open a list. */
const SEG_FLAG_MAX = 4;
const segFlagMode = (n) => (n > SEG_FLAG_MAX ? "popover" : "pills");

/* Filters that narrow a list: those not on their "all" value. */
const segActive = (filters, all = "all") => Object.values(filters || {}).filter((v) => v != null && v !== all).length;

if (typeof module !== "undefined") module.exports = { segItems, segFlag, SEG_FLAGS, SEG_FLAG_MAX, segFlagMode, segActive };
