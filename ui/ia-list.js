"use strict";
/* AI tab: what the conversation list shows, and in which order.

   Pure functions only — no DOM, no Tauri — so that node can test them
   (scripts/test-ia-list.js). ia.js draws what they return. */

/* Sort orders, the first being the default. */
const IA_SORTS = ["activity", "created", "title"];
/* Filters: kind of work, state of the object, where Claude runs. */
const IA_FILTERS = {
  kind: ["all", "create", "edit"],
  state: ["all", "saved", "pending"],
  engine: ["all", "local", "container"],
};

/* Folds case and accents: "Pièce" is found by "piece". */
const iaFold = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const iaBase = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || "";

/* True if conversation `c` passes the search and the filters. Every word of
   the search must appear in the title, the request, the source file or the
   destination folder. */
function iaMatches(c, query, filters = {}) {
  const f = { kind: "all", state: "all", engine: "all", ...filters };
  if (f.kind === "create" && c.kind !== "create") return false;
  if (f.kind === "edit" && c.kind === "create") return false;
  if (f.state === "saved" && !c.saved) return false;
  if (f.state === "pending" && c.saved) return false;
  // Both sandboxes (built-in, yolobox) count as the Sandbox side.
  if (f.engine !== "all" && (c.engine === "local" ? "local" : "container") !== f.engine) return false;
  const words = iaFold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = iaFold([c.title, c.prompt, c.source_name, iaBase(c.dest_dir)].join("\n"));
  return words.every((w) => hay.includes(w));
}

/* A new sorted copy. Ties keep the most recent first, then the id, so the
   order never jumps between two renders. */
function iaSortList(list, sort = "activity", compare = (a, b) => a.localeCompare(b)) {
  const recent = (a, b) => (b.updated_at || 0) - (a.updated_at || 0) || String(a.id).localeCompare(String(b.id));
  const by = {
    activity: recent,
    created: (a, b) => (b.created_at || 0) - (a.created_at || 0) || recent(a, b),
    title: (a, b) => compare(a.title || "", b.title || "") || recent(a, b),
  }[sort] || recent;
  return [...list].sort(by);
}

/* Group of a moment (seconds), seen from `now` (milliseconds), by local
   calendar days: "today", "yesterday", "week" (the 7 days before
   yesterday), "earlier". */
function iaGroupOf(secs, now = Date.now()) {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const t = secs * 1000;
  if (t >= day.getTime()) return "today";
  const yesterday = new Date(day);
  yesterday.setDate(day.getDate() - 1);
  if (t >= yesterday.getTime()) return "yesterday";
  const week = new Date(day);
  week.setDate(day.getDate() - 7);
  if (t >= week.getTime()) return "week";
  return "earlier";
}

/* Filters, sorts and groups. Date orders group by the date they sort on; the
   title order is one group (key null). Empty groups are left out. */
function iaGroupList(list, { query = "", filters = {}, sort = "activity", now = Date.now(), compare } = {}) {
  const items = iaSortList(list.filter((c) => iaMatches(c, query, filters)), sort, compare);
  if (sort === "title") return items.length ? [{ key: null, items }] : [];
  const field = sort === "created" ? "created_at" : "updated_at";
  const groups = [];
  for (const c of items) {
    const key = iaGroupOf(c[field] || 0, now);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(c);
    else groups.push({ key, items: [c] });
  }
  return groups;
}

/* One badge per conversation, the most pressing first: Claude answering,
   last turn failed, created object not exported yet, saved, to save. */
function iaStatusOf(c, { running = false, failed = false } = {}) {
  if (running) return "running";
  if (failed) return "error";
  if (c.kind === "create" && !c.version) return "draft";
  return c.saved ? "saved" : "pending";
}

/* Keyboard move in a list of `n` cards: index after `key`, or -1 if the key
   does not move. Starts at the first (or last) card when none is selected. */
function iaMove(i, n, key) {
  if (!n) return -1;
  switch (key) {
    case "ArrowDown":
      return i < 0 ? 0 : Math.min(n - 1, i + 1);
    case "ArrowUp":
      return i < 0 ? n - 1 : Math.max(0, i - 1);
    case "Home":
      return 0;
    case "End":
      return n - 1;
    default:
      return -1;
  }
}

/* A typed title, cleaned: spaces collapsed, 120 characters at most (the
   same rule as ia::rename). Empty means "keep the old one". */
const iaCleanTitle = (s) => [...String(s || "").split(/\s+/).filter(Boolean).join(" ")].slice(0, 120).join("");

/* The file Save wrote for the version shown, or null: Save is per
   version, and going back to a saved one finds its file again. */
const iaSavedPath = (c) => (c && c.saved_versions && c.saved_versions[c.version]) || null;

if (typeof module !== "undefined")
  module.exports = { IA_SORTS, IA_FILTERS, iaFold, iaMatches, iaSortList, iaGroupOf, iaGroupList, iaStatusOf, iaMove, iaCleanTitle, iaSavedPath };
