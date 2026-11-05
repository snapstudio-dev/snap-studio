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
    case "user":
      for (const b of ev.message?.content || []) {
        if (b.type === "text" && b.text?.trim()) out.push({ kind: "user", text: b.text });
        else if (b.type === "tool_result") out.push({ kind: "tool_done", id: b.tool_use_id, error: !!b.is_error });
      }
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

/* A quick setting applied as the slice sheet would keep it: the machine's
   remembered adjustments, with the setting touched by hand. */
function snappySimpleWith(simple, setting, value) {
  if (!["infill", "walls", "supports", "brim"].includes(setting)) throw new Error("unknown setting: " + setting);
  return { ...(simple || {}), [setting]: value };
}

if (typeof module !== "undefined") module.exports = { snappyToolName, snappyItems, snappySliceSummary, snappyLocalFiles, snappySimpleWith };
