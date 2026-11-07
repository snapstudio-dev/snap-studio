"use strict";
/* A printer's files: the pure part (search, sort, names, dates, selection,
   what can be deleted), tested by scripts/test-pfiles.js. printer-files.js
   draws what these return. */

const PFL_SORTS = ["date", "name", "duration", "size"];
const PFL_SPEEDS = [0.5, 1, 1.5, 2, 4];

/* Case and accents ignored. */
const pflFold = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const pflKey = (f) => `${f.root}/${f.path}`;
const pflBase = (path) => String(path || "").split("/").pop();

/* Name shown: no folder, no extension, and without the "-a1b2c3" Snap
   Studio adds to make each sent file unique (six hex digits, one digit at
   least: "-facade" stays). */
function pflName(path) {
  const base = pflBase(path).replace(/\.(gcode|gco|g|3mf|mp4|m4v|mov|webm)$/i, "");
  const m = /^(.+)-([0-9a-f]{6})$/.exec(base);
  return m && /\d/.test(m[2]) ? m[1] : base;
}

/* When a video was recorded: a date in its name ("20260107114733",
   "timelapse_x_20260107_1147"), otherwise its file date. Seconds. */
function pflVideoDate(f) {
  const n = pflBase(f.path);
  let m = /(20\d{2})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})?/.exec(n);
  if (m) {
    const [y, mo, d, h, mi, s] = m.slice(1).map((x) => +(x || 0));
    const t = new Date(y, mo - 1, d, h, mi, s).getTime();
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h < 24 && mi < 60 && !Number.isNaN(t)) return t / 1000;
  }
  return f.modified || 0;
}

/* Title of a video: the print it shows for moonraker-timelapse's
   "timelapse_<file>_<date>.mp4", otherwise its name. */
function pflVideoTitle(f) {
  const n = pflBase(f.path).replace(/\.[^.]+$/, "");
  const m = /^timelapse_(.+?)_(20\d{6}[_-]?\d{4,6})$/.exec(n);
  return m ? pflName(m[1]) : pflName(n);
}

const pflDuration = (f, durations) => (f.meta ? f.meta.estimated_time : durations && durations.get(pflKey(f))) ?? null;
const pflDate = (f) => (f.meta || f.root === "gcodes" ? f.modified || 0 : pflVideoDate(f));
const pflTitle = (f) => (f.root === "gcodes" ? pflName(f.path) : pflVideoTitle(f));

function pflMatches(f, q) {
  const words = pflFold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = pflFold([pflTitle(f), f.path, f.meta?.filament_types?.join(" "), f.meta?.filament_name].join(" "));
  return words.every((w) => hay.includes(w));
}

/* Sorted copy. Unknown values (a duration not read yet) go last. */
function pflSort(list, key = "date", desc = true, durations = null) {
  const val = {
    date: pflDate,
    name: (f) => pflFold(pflTitle(f)),
    size: (f) => f.size || 0,
    duration: (f) => pflDuration(f, durations),
  }[key] || pflDate;
  return [...list].sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    const c = typeof x === "string" ? x.localeCompare(y) : x - y;
    return (desc ? -c : c) || pflFold(pflTitle(a)).localeCompare(pflFold(pflTitle(b)));
  });
}

/* "12 files · 340 MB", with the printer's free space when known. */
function pflSummary(list, disk) {
  const bytes = list.reduce((s, f) => s + (f.size || 0), 0);
  return { count: list.length, bytes, free: disk ? disk.free : null, total: disk ? disk.total : null };
}

/* The colors a print uses: one dot per tool, with its material and grams. */
function pflFilaments(meta) {
  if (!meta) return [];
  const tools = meta.tools?.length ? meta.tools : [0];
  return tools.map((t) => ({
    tool: t,
    color: meta.filament_colors?.[t] || null,
    type: meta.filament_types?.[t] || meta.filament_types?.[0] || "",
    grams: meta.filament_weights?.[t] ?? (tools.length === 1 ? meta.filament_weight_total ?? null : null),
  }));
}

/* What the spool check and the send sheet need, from the file's header. */
function pflSendStats(meta) {
  const m = meta || {};
  return {
    tools: m.tools?.length ? m.tools : [0],
    filament_types: m.filament_types || [],
    filament_colors: m.filament_colors || [],
    print_time_s: m.estimated_time || null,
    filament_g: m.filament_weight_total || null,
  };
}

/* Whether a file can be deleted (or renamed): not while it prints. A root
   Moonraker lists read-only is no reason: a U1's timelapses are deleted
   through its camera service, and the printer says so if it refuses.
   → { ok, reason } */
function pflCanChange(f, printing) {
  if (f.root === "gcodes" && printing && printing.replace(/^\//, "") === f.path.replace(/^\//, "")) return { ok: false, reason: "printing" };
  return { ok: true, reason: null };
}

/* Query of a prn: address. encodeURIComponent, not URLSearchParams: its "+"
   for a space is not decoded on the Rust side, and a name with a space
   would not load. */
const pflPrnQuery = (id, root, path) => `/f?id=${encodeURIComponent(id)}&root=${encodeURIComponent(root)}&p=${encodeURIComponent(path)}`;

/* The neighbour of `i` in a list of `n`, or -1 past either end. */
const pflNeighbor = (i, n, delta) => (i + delta >= 0 && i + delta < n ? i + delta : -1);

/* The next playback speed, round. */
function pflNextSpeed(cur) {
  const i = PFL_SPEEDS.indexOf(cur);
  return PFL_SPEEDS[(i + 1) % PFL_SPEEDS.length];
}

/* "1:05" / "1:02:05". */
function pflClock(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/* Selection: a key toggled in or out; a new Set. */
function pflToggle(set, key, on = !set.has(key)) {
  const s = new Set(set);
  if (on) s.add(key);
  else s.delete(key);
  return s;
}

/* What to delete, one batch per root in the order the roots first appear:
   the videos tab can mix a `timelapse` and a `camera` root, and a path is
   only found under its own. A video's picture follows it. */
function pflDeleteBatches(files) {
  const out = [];
  for (const f of files) {
    let b = out.find((x) => x.root === f.root);
    if (!b) out.push((b = { root: f.root, paths: [] }));
    b.paths.push(f.path);
    if (f.thumb) b.paths.push(f.thumb);
  }
  return out;
}

/* What a right-click acts on. In Select mode, a picked file stands for
   every picked one (in list order); a file that is not picked, and any file
   outside Select mode, for itself alone. `picked` is not changed. */
function pflMenuTargets(selMode, picked, key, order) {
  if (!selMode || !picked.has(key)) return [key];
  return order.filter((k) => picked.has(k));
}

/* Shift-click: the keys from the anchor to the clicked one, both included,
   in the displayed order. Without an anchor still listed, only the clicked
   one. */
function pflRangeKeys(order, anchor, key) {
  const a = order.indexOf(anchor), b = order.indexOf(key);
  if (b < 0) return [];
  if (a < 0) return [key];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/* Ctrl/Cmd-click (`toggle`) or Shift-click (`range`) outside Select mode, as
   in the app's Files view: the next `{ picked, sel, anchor }`. The single
   selection `sel` starts the picks; fewer than two picks fall back to it,
   so one file keeps its own panel and bar. `order` is the tab's displayed
   keys: a range never leaves them. */
function pflPickClick({ picked, sel, anchor }, key, order, { toggle = false, range = false } = {}) {
  let next;
  if (range) {
    anchor = anchor ?? sel;
    next = new Set(pflRangeKeys(order, anchor, key));
  } else if (toggle) {
    // The selected file starts the picks only if it is shown (a search may
    // hide it): a pick never includes a file the user cannot see.
    next = pflToggle(picked.size ? picked : new Set(order.includes(sel) ? [sel] : []), key);
    anchor = key;
  } else {
    return { picked: new Set(), sel: key, anchor: key };
  }
  if (next.size > 1) return { picked: next, sel: null, anchor };
  return { picked: new Set(), sel: [...next][0] ?? null, anchor };
}

if (typeof module !== "undefined")
  module.exports = { pflPrnQuery, PFL_SORTS, PFL_SPEEDS, pflFold, pflKey, pflName, pflVideoDate, pflVideoTitle, pflDuration, pflDate, pflTitle, pflMatches, pflSort, pflSummary, pflFilaments, pflSendStats, pflCanChange, pflNeighbor, pflNextSpeed, pflClock, pflToggle, pflDeleteBatches, pflMenuTargets, pflRangeKeys, pflPickClick };
