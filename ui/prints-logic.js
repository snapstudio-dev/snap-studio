"use strict";
/* Prints page: the pure part (search and filters, day groups, time per
   layer, real duration and pauses, timeline, the timelapse of a print, the
   record shown by default), tested by scripts/test-prints.js. prints.js
   draws what these return. Times are in seconds unless named `ms`. */

const PJL_DONE = ["complete", "finished", "cancelled", "error"];
const PJL_FILTERS = ["all", "active", "finished", "failed"];
/* Why a print failed, as the record offers it (`prints.reason.<key>`). */
const PJL_REASONS = ["adhesion", "spaghetti", "layer_shift", "clog", "stringing", "warping", "other"];

const pjlIsDone = (job) => PJL_DONE.includes(job.state);

/* Failed: stopped by the printer or the user, or said failed in its record
   (a print can finish and still be a failure). */
const pjlFailed = (job) => ["cancelled", "error"].includes(job.state) || job.result?.success === false;

/* Case and accents ignored. */
const pjlFold = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const pjlBase = (p) => String(p || "").split(/[\\/]/).pop();

/* Search in the name and the files (model, file on the printer): every
   word must be found. */
function pjlMatches(job, q) {
  const words = pjlFold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = pjlFold([job.name, pjlBase(job.source), job.remote].join(" "));
  return words.every((w) => hay.includes(w));
}

/* Materials a job uses ("PLA", "PETG"), once each, in head order. */
function pjlMaterials(job) {
  const s = job.stats || {};
  const types = s.filament_types?.length ? s.filament_types : [];
  const tools = s.tools?.length ? s.tools : types.map((_, i) => i);
  const out = [];
  for (const t of tools) {
    const m = String(types[t] || types[0] || "").trim().toUpperCase();
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}

/* Does a job pass the list's segmented filter and chips? `printers` and
   `materials` are Sets; empty means no constraint. */
function pjlPasses(job, { filter = "all", printers = new Set(), materials = new Set(), q = "" } = {}) {
  const done = pjlIsDone(job);
  if (filter === "active" && done) return false;
  if (filter === "finished" && (!done || pjlFailed(job))) return false;
  if (filter === "failed" && (!done || !pjlFailed(job))) return false;
  if (printers.size && !printers.has(job.printer_id)) return false;
  if (materials.size && !pjlMaterials(job).some((m) => materials.has(m))) return false;
  return pjlMatches(job, q);
}

/* Local day of a time, "2026-10-27". */
function pjlDay(secs) {
  const d = new Date(secs * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* Finished prints by day, newest first: [{ day, rel, jobs, grams }], `rel`
   being "today", "yesterday" or null. */
function pjlDays(jobs, nowMs = Date.now()) {
  const today = pjlDay(nowMs / 1000);
  const y = new Date(nowMs);
  y.setDate(y.getDate() - 1);
  const yesterday = pjlDay(y.getTime() / 1000);
  const sorted = [...jobs].sort((a, b) => (b.finished || b.created || 0) - (a.finished || a.created || 0));
  const out = [];
  for (const j of sorted) {
    const day = pjlDay(j.finished || j.created || 0);
    let g = out[out.length - 1];
    if (!g || g.day !== day) out.push((g = { day, rel: day === today ? "today" : day === yesterday ? "yesterday" : null, jobs: [], grams: 0 }));
    g.jobs.push(j);
    g.grams += j.stats?.filament_g || 0;
  }
  return out;
}

/* Time of each layer from the slice's elapsed time at each layer's end. */
function pjlLayerTimes(layerEnd) {
  const ends = layerEnd || [];
  return ends.map((t, i) => Math.max(0, t - (i ? ends[i - 1] : 0)));
}

/* Bars for the time per layer chart: at most `max`, a bar summing the
   layers it covers. `from` and `to` are 1-based layer numbers. */
function pjlLayerBars(layerEnd, max = 120) {
  const times = pjlLayerTimes(layerEnd);
  const n = times.length;
  if (!n) return [];
  const per = Math.ceil(n / max);
  const bars = [];
  for (let i = 0; i < n; i += per) {
    const slice = times.slice(i, i + per);
    bars.push({ from: i + 1, to: i + slice.length, s: slice.reduce((a, b) => a + b, 0) });
  }
  return bars;
}

/* Pauses of a print: [{ from, to }], the last open until `end` when it was
   never resumed. */
function pjlPauses(job, end = job.finished) {
  const out = [];
  for (const e of job.events || []) {
    if (e.kind === "pause") out.push({ from: e.at, to: null });
    else if (e.kind === "resume" && out.length && out[out.length - 1].to == null) out[out.length - 1].to = e.at;
  }
  for (const p of out) if (p.to == null) p.to = end ?? null;
  return out;
}

/* Real duration of a finished print, start to end, and how long it was
   paused; null when a date is missing. */
function pjlDuration(job) {
  if (!job.started || !job.finished || job.finished < job.started) return null;
  const paused = pjlPauses(job).reduce((a, p) => a + Math.max(0, p.to - p.from), 0);
  return { total: job.finished - job.started, paused };
}

/* Real against estimated, in percent (rounded), or null. */
function pjlDelta(real, est) {
  if (!real || !est) return null;
  return Math.round(((real - est) / est) * 100);
}

/* What happened, in order: [{ kind, at }], kinds `sliced` (or `added` for
   a print not sliced by Snap Studio), `started`, `pause`, `resume`, then
   `complete`, `cancelled` or `error`. */
function pjlTimeline(job) {
  const out = [{ kind: job.profile?.process ? "sliced" : "added", at: job.created }];
  if (job.started) out.push({ kind: "started", at: job.started });
  for (const e of job.events || []) if (e.kind === "pause" || e.kind === "resume") out.push({ kind: e.kind, at: e.at });
  if (pjlIsDone(job) && job.finished) out.push({ kind: job.state === "finished" ? "complete" : job.state, at: job.finished });
  return out.filter((e) => e.at).sort((a, b) => a.at - b.at);
}

/* The record shown when nothing is chosen: the first running print, else
   the latest finished one, else the first queued; null when there is
   nothing. `running`: live keys, in the list's order. */
function pjlDefaultKey(running, jobs) {
  if (running.length) return running[0];
  const done = jobs.filter(pjlIsDone).sort((a, b) => (b.finished || 0) - (a.finished || 0));
  if (done.length) return "job:" + done[0].id;
  const q = jobs.find((j) => j.state === "queued");
  return q ? "job:" + q.id : null;
}

/* The printer's video of a finished print: recorded on its printer between
   a little before its start and half an hour after its end, the one whose
   title names the print first, then the closest to its end. `videoDate`
   and `videoTitle` read a video's name (pfiles-logic.js). */
function pjlMatchTimelapse(job, videos, videoDate, videoTitle) {
  if (!job.started || !job.finished) return null;
  const from = job.started - 300, to = job.finished + 1800;
  const name = pjlFold(job.name);
  const remote = pjlFold(String(job.remote || "").replace(/\.gcode$/i, ""));
  let best = null, bestScore = Infinity;
  for (const v of videos || []) {
    const t = videoDate(v);
    if (!(t >= from && t <= to)) continue;
    const title = pjlFold(videoTitle(v));
    const named = title && (title === name || (remote && pjlFold(v.path).includes(remote)));
    const score = (named ? 0 : 1e9) + Math.abs(t - job.finished);
    if (score < bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}

/* Finished prints an automatic deletion after `days` would take now (the
   Rust store applies the same rule). */
const pjlExpired = (jobs, days, nowSecs) =>
  days ? jobs.filter((j) => pjlIsDone(j) && (j.finished || j.created || 0) < nowSecs - days * 86400) : [];

/* Sum of the queue's estimated times. */
const pjlQueueTime = (queue) => queue.reduce((a, j) => a + (j.stats?.print_time_s || 0), 0);

if (typeof module !== "undefined")
  module.exports = { PJL_DONE, PJL_FILTERS, PJL_REASONS, pjlIsDone, pjlFailed, pjlFold, pjlMatches, pjlMaterials, pjlPasses, pjlDay, pjlDays, pjlLayerTimes, pjlLayerBars, pjlPauses, pjlDuration, pjlDelta, pjlTimeline, pjlDefaultKey, pjlMatchTimelapse, pjlExpired, pjlQueueTime };
