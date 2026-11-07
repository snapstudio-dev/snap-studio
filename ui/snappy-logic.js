"use strict";
/* Snappy's drawer, the parts without a page: what each event of its
   conversation shows, and the summaries the app gives Snappy (its context
   with each message, Prepare's state, the Files view). Loaded by the page
   and by scripts/test-snappy.js. */

/* The app's MCP server, as Claude prefixes its tools. */
const SNAPPY_SERVER = "mcp__snap-studio__";

/* A tool's name without its server. */
const snappyToolName = (name) => String(name || "").replace(SNAPPY_SERVER, "");

/* What an event of the conversation shows, as a list of items:
   { kind: "user" | "assistant", text }, { kind: "tool", id, name },
   { kind: "tool_done", id, error }, { kind: "end", stopped, error },
   { kind: "exited" }, { kind: "auth" }. */
function snappyItems(ev) {
  const out = [];
  switch (ev?.type) {
    case "user": {
      const images = [];
      let text = "";
      for (const b of ev.message?.content || []) {
        if (b.type === "text" && b.text?.trim()) text += b.text;
        else if (b.type === "attachment" && b.name) images.push(b.name);
        else if (b.type === "tool_result") out.push({ kind: "tool_done", id: b.tool_use_id, error: !!b.is_error });
      }
      if (text || images.length) out.push({ kind: "user", text, images });
      break;
    }
    case "note":
      // Said by the app: the conversation's Claude session was gone.
      if (ev.kind === "forgotten") out.push({ kind: "note", key: "snappy.forgotten" });
      break;
    case "assistant":
      for (const b of ev.message?.content || []) {
        if (b.type === "text" && b.text?.trim()) out.push({ kind: "assistant", text: b.text });
        else if (b.type === "tool_use") out.push({ kind: "tool", id: b.id, name: snappyToolName(b.name) });
      }
      break;
    case "result":
      out.push({ kind: "end", stopped: ev.subtype === "error_during_execution", error: ev.is_error && ev.subtype !== "error_during_execution" ? ev.result || "" : null });
      break;
    case "exited":
      out.push({ kind: "exited" });
      break;
    case "auth_failed":
      out.push({ kind: "auth" });
      break;
  }
  return out;
}

/* Prepare's state for Snappy: presets by name, the quick settings, the
   last slice's estimates. Nothing else (no paths). */
function snappySliceSummary({ printer, machine, process, simple, layer, stats, objects }) {
  const s = simple || {};
  const out = {
    printer: printer || null,
    machine_preset: machine || null,
    process_preset: process || null,
    layer_height: layer || null,
    infill_percent: s.infill ?? null,
    walls: s.walls ?? null,
    supports: s.supports ?? null,
    brim: s.brim ?? null,
    objects: (objects || []).map((o) => o.name).filter(Boolean),
  };
  if (stats) {
    out.last_slice = {
      print_time_min: stats.print_time_s != null ? Math.round(stats.print_time_s / 60) : null,
      filament_g: stats.filament_g != null ? Math.round(stats.filament_g * 10) / 10 : null,
      layers: stats.layers ?? null,
    };
  }
  return out;
}

/* The Files view's files, by name, at most `max`. */
function snappyLocalFiles(files, max = 200) {
  const names = (files || []).map((f) => f.name).filter(Boolean);
  return { files: names.slice(0, max), total: names.length };
}

/* A file of the Files view by its name, for the app only (its path never
   goes to Snappy): none or several of that name, an error. */
function snappyLocalFile(files, name) {
  const found = (files || []).filter((f) => f.name === name);
  if (found.length === 1) return { name, path: found[0].path };
  return { error: found.length ? `several files are named “${name}” in the Files view` : `no file named “${name}” in the Files view` };
}

/* The slice sheet's quick settings: what a change may be. */
const SNAPPY_QUICK = {
  infill: { min: 0, max: 100, unit: "%" },
  walls: { min: 1, max: 6 },
  speed: { min: 50, max: 120, unit: "%" },
  supports: { bool: true },
  brim: { bool: true },
};
/* The profiles, in the order they apply: a nozzle profile reloads the
   quality profiles, a quality profile reloads the quick settings. */
const SNAPPY_PROFILES = ["machine", "process", "bed"];

const snappyBool = (v) => (v === true || v === 1 || v === "1" || v === "true" ? true : v === false || v === 0 || v === "0" || v === "false" ? false : null);

/* Snappy's changes to the slice sheet, checked against what the sheet
   offers (`o`, as slice_options gives it): every key known, every value
   allowed. Gives them in the order they apply (profiles first, then the
   rest), each as { key, kind: "profile" | "quick" | "adv", value }, with
   one line each, "label: before → after", for the confirmation card.
   `words`: the sheet's labels (machine, process, bed, the quick settings,
   yes, no). */
function snappySliceCheck(changes, o, words) {
  const entries = Object.entries(changes && typeof changes === "object" ? changes : {});
  if (!entries.length) return { error: "No change given." };
  const yn = (b) => (b ? words.yes : words.no);
  const out = [];
  for (const [key, raw] of entries) {
    if (SNAPPY_PROFILES.includes(key)) {
      const p = o[key] || { options: [] };
      const opt = p.options.find((x) => x.value === raw) || p.options.find((x) => x.label === raw);
      if (!opt) return { error: `${key}: “${raw}” is not one of the choices slice_options gives.` };
      if (opt.value === p.value) continue;
      const before = p.options.find((x) => x.value === p.value)?.label ?? p.value ?? "-";
      out.push({ key, kind: "profile", value: opt.value, line: `${words[key]}: ${before} → ${opt.label}` });
    } else if (key in SNAPPY_QUICK) {
      const q = SNAPPY_QUICK[key];
      const cur = o.quick?.[key]?.value;
      if (q.bool) {
        const v = snappyBool(raw);
        if (v == null) return { error: `${key} is true or false.` };
        if (v === cur) continue;
        out.push({ key, kind: "quick", value: v, line: `${words[key]}: ${yn(cur)} → ${yn(v)}` });
      } else {
        const n = Number(String(raw).replace("%", "").trim());
        if (!Number.isFinite(n) || n < q.min || n > q.max) return { error: `${key} goes from ${q.min} to ${q.max}.` };
        const v = Math.round(n);
        if (v === cur) continue;
        const u = q.unit ? " " + q.unit : "";
        out.push({ key, kind: "quick", value: v, line: `${words[key]}: ${cur}${u} → ${v}${u}` });
      }
    } else {
      const a = (o.advanced || []).find((x) => x.key === key);
      if (!a) return { error: `${key} is not a setting of this sheet, or does not apply now.` };
      let v = null;
      if (a.type === "bool") {
        const b = snappyBool(raw);
        v = b == null ? null : b ? "1" : "0";
      } else if (a.options?.length) {
        v = (a.options.find((x) => x.value === String(raw)) || a.options.find((x) => x.label === raw))?.value ?? null;
      } else if (/^-?\d+(\.\d+)?%?$/.test(String(raw).trim())) {
        const s = String(raw).trim();
        const n = parseFloat(s);
        v = s.endsWith("%") || ((a.min == null || n >= a.min) && (a.max == null || n <= a.max)) ? s : null;
      }
      if (v == null) return { error: `${key}: “${raw}” is not allowed${a.options?.length ? "; choose among its options" : ""}.` };
      if (String(v) === String(a.value)) continue;
      const label = (x) =>
        a.type === "bool" ? yn(x === "1" || x === true) : a.options?.find((y) => y.value === String(x))?.label ?? `${x ?? "-"}${a.unit ? " " + a.unit : ""}`;
      out.push({ key, kind: "adv", value: v, line: `${a.label}: ${label(a.value)} → ${label(v)}` });
    }
  }
  if (!out.length) return { error: "The sheet already has these values." };
  const rank = (c) => (c.kind === "profile" ? SNAPPY_PROFILES.indexOf(c.key) : 9);
  out.sort((x, y) => rank(x) - rank(y));
  return { changes: out.map(({ line, ...c }) => c), lines: out.map((c) => c.line) };
}

if (typeof module !== "undefined") module.exports = { snappyToolName, snappyItems, snappySliceSummary, snappyLocalFiles, snappyLocalFile, snappySliceCheck };
