"use strict";
/* Bed leveling: the pure part (deviation, status, scales, comparing two
   meshes, the measurement's estimate and phase), tested by
   scripts/test-bedmesh.js. bedmesh.js draws what these return.

   A mesh, as bedmesh.rs gives it: { at, min: [x, y], max: [x, y],
   points: rows from min y to max y, each from min x to max x (mm) }. */

/* Tolerances for a bed the printer's mesh compensates for: the Snapmaker U1
   asks for manual leveling only above 2 mm between its corners, and its
   knob assistant aims at 0.05 mm. Under 0.5 mm the mesh takes it all;
   above 1 mm it is worth turning the knobs. (Before v2, the limits were
   generic Klipper ones, 0.20 / 0.30 mm: too strict for the U1.) */
const BML_DEFAULTS = { good: 0.5, limit: 1, alert: true, keep: 20, remind: true, remindDays: 30, remindPrints: 50 };
const BML_KEEPS = [5, 10, 20, 50, 100];
const BML_REMIND_DAYS = [15, 30, 60, 90];
const BML_REMIND_PRINTS = [0, 25, 50, 100]; // 0: not by prints
/* Tolerance in three words; the values stay open in "Advanced". */
const BML_LEVELS = { tolerant: { good: 0.8, limit: 1.5 }, standard: { good: 0.5, limit: 1 }, strict: { good: 0.3, limit: 0.6 } };
/* The levels before v2: settings saved with one of them take the same
   level now. */
const BML_LEVELS_V1 = { tolerant: { good: 0.3, limit: 0.45 }, standard: { good: 0.2, limit: 0.3 }, strict: { good: 0.1, limit: 0.2 } };

const bmlRound = (x, n = 3) => Math.round(x * 10 ** n) / 10 ** n;

/* Settings read back: defaults, bounds, "good" never above the limit. */
function bmlSettings(raw) {
  let r = raw && typeof raw === "object" ? raw : {};
  if (r.v !== 2) {
    const old = Object.keys(BML_LEVELS_V1).find((k) => BML_LEVELS_V1[k].good === +r.good && BML_LEVELS_V1[k].limit === +r.limit);
    if (old) r = { ...r, ...BML_LEVELS[old] };
  }
  const num = (v, d, lo, hi) => (Number.isFinite(+v) && v !== null && v !== "" ? Math.min(hi, Math.max(lo, +v)) : d);
  const limit = bmlRound(num(r.limit, BML_DEFAULTS.limit, 0.05, 2), 2);
  const good = bmlRound(Math.min(limit, num(r.good, BML_DEFAULTS.good, 0.02, 2)), 2);
  const keep = BML_KEEPS.includes(+r.keep) ? +r.keep : BML_DEFAULTS.keep;
  return {
    v: 2,
    good,
    limit,
    alert: r.alert === undefined ? BML_DEFAULTS.alert : !!r.alert,
    keep,
    remind: r.remind === undefined ? BML_DEFAULTS.remind : !!r.remind,
    remindDays: BML_REMIND_DAYS.includes(+r.remindDays) ? +r.remindDays : BML_DEFAULTS.remindDays,
    remindPrints: BML_REMIND_PRINTS.includes(+r.remindPrints) ? +r.remindPrints : BML_DEFAULTS.remindPrints,
  };
}

/* The level the limits match, or "custom". */
function bmlLevelOf(s) {
  const { good, limit } = bmlSettings(s);
  return Object.keys(BML_LEVELS).find((k) => BML_LEVELS[k].good === good && BML_LEVELS[k].limit === limit) || "custom";
}

/* The change from one deviation to another, on the values shown (to the
   hundredth): 0.10 → 0.16 reads +0.06, never +0.05. */
const bmlDelta = (from, to) => bmlRound(bmlRound(to, 2) - bmlRound(from, 2), 2);

/* Min, max, mean, deviation (max − min), grid size, where the extremes are. */
function bmlStats(mesh) {
  const rows = mesh?.points || [];
  let min = Infinity, max = -Infinity, sum = 0, n = 0, minAt = null, maxAt = null;
  rows.forEach((r, j) =>
    r.forEach((v, i) => {
      if (v == null || !Number.isFinite(v)) return;
      sum += v;
      n++;
      if (v < min) (min = v), (minAt = [i, j]);
      if (v > max) (max = v), (maxAt = [i, j]);
    })
  );
  if (!n) return null;
  return { min, max, mean: sum / n, dev: max - min, nx: rows[0]?.length || 0, ny: rows.length, minAt, maxAt, count: n };
}

/* Good up to `good`, Watch up to `limit`, Out of tolerance above. */
function bmlStatus(dev, s) {
  const { good, limit } = bmlSettings(s);
  if (dev == null || !Number.isFinite(dev)) return null;
  // Compared at the hundredth shown, so 0.20 reads Good under a 0.20 limit.
  const d = bmlRound(dev, 2);
  return d <= good ? "good" : d <= limit ? "watch" : "out";
}

/* The newest stored mesh, when it is out of tolerance and the alert is on:
   { dev, at }; otherwise null. */
function bmlAlert(hist, s) {
  const st = bmlSettings(s);
  if (!st.alert || !hist?.length) return null;
  const last = [...hist].filter((m) => !m.partial).sort((a, b) => b.at - a.at)[0];
  const stats = last && bmlStats(last);
  return stats && bmlStatus(stats.dev, st) === "out" ? { dev: stats.dev, at: last.at } : null;
}

/* Grid coordinates (mm) of a point. */
function bmlXY(mesh, i, j) {
  const nx = mesh.points[0].length, ny = mesh.points.length;
  return [mesh.min[0] + ((mesh.max[0] - mesh.min[0]) * i) / (nx - 1), mesh.min[1] + ((mesh.max[1] - mesh.min[1]) * j) / (ny - 1)];
}

/* Height at (x, y) mm, bilinear between the probed points; null outside. */
function bmlSample(mesh, x, y) {
  const p = mesh.points, nx = p[0].length, ny = p.length;
  const fx = ((x - mesh.min[0]) / (mesh.max[0] - mesh.min[0])) * (nx - 1);
  const fy = ((y - mesh.min[1]) / (mesh.max[1] - mesh.min[1])) * (ny - 1);
  const eps = 1e-9;
  if (!(fx >= -eps && fy >= -eps && fx <= nx - 1 + eps && fy <= ny - 1 + eps)) return null;
  const i = Math.min(nx - 2, Math.max(0, Math.floor(fx))), j = Math.min(ny - 2, Math.max(0, Math.floor(fy)));
  const u = Math.min(1, Math.max(0, fx - i)), v = Math.min(1, Math.max(0, fy - j));
  const a = p[j][i], b = p[j][i + 1], c = p[j + 1][i], d = p[j + 1][i + 1];
  if ([a, b, c, d].some((z) => z == null)) return null;
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

/* A finer grid for the 3D surface: `f` cells per probed cell. */
function bmlUpsample(mesh, f) {
  const nx = mesh.points[0].length, ny = mesh.points.length;
  if (f <= 1) return mesh;
  const w = (nx - 1) * f + 1, h = (ny - 1) * f + 1;
  const points = [];
  for (let j = 0; j < h; j++) {
    const row = [];
    for (let i = 0; i < w; i++) {
      const x = mesh.min[0] + ((mesh.max[0] - mesh.min[0]) * i) / (w - 1);
      const y = mesh.min[1] + ((mesh.max[1] - mesh.min[1]) * j) / (h - 1);
      row.push(bmlSample(mesh, x, y));
    }
    points.push(row);
  }
  return { ...mesh, points };
}

/* After − before, on the after grid, each mesh taken from its own mean
   (Klipper's zero moves between measurements: the shapes are compared).
   Null when they share less than half of the after area. */
function bmlDiff(before, after) {
  const sb = bmlStats(before), sa = bmlStats(after);
  if (!sb || !sa) return null;
  let inside = 0, total = 0;
  const points = after.points.map((r, j) =>
    r.map((v, i) => {
      total++;
      const [x, y] = bmlXY(after, i, j);
      const b = bmlSample(before, x, y);
      if (b == null || v == null) return null;
      inside++;
      return v - sa.mean - (b - sb.mean);
    })
  );
  if (inside < total / 2) return null;
  return { ...after, at: after.at, points, diff: true };
}

/* Where a height sits on the colour scale, 0 (low) … 1 (high): around the
   mean, over at least ±0.1 mm so a flat bed stays mid-scale. A
   difference: around zero, over at least 0.02 mm. */
function bmlScale(stats, s, diff = false) {
  if (diff) {
    const span = Math.max(Math.abs(stats.min), Math.abs(stats.max), 0.02);
    return { center: 0, span };
  }
  // At least 0.1 mm: a flat bed stays mid-scale, and the shape still
  // shows on a bed the tolerance calls good.
  return { center: stats.mean, span: Math.max(stats.max - stats.mean, stats.mean - stats.min, 0.1) };
}
const bmlT = (v, sc) => Math.min(1, Math.max(0, 0.5 + (v - sc.center) / (2 * sc.span)));

/* Colour at t between three stops ([r, g, b] each), the hue turning the
   short way (green → yellow → red, not through brown). */
function bmlColor(t, stops) {
  const [a, b] = t <= 0.5 ? [stops[0], stops[1]] : [stops[1], stops[2]];
  const u = t <= 0.5 ? t * 2 : (t - 0.5) * 2;
  const A = bmlHsl(a), B = bmlHsl(b);
  // A grey stop has no hue: it takes the other's.
  if (A[1] < 1e-6) A[0] = B[0];
  if (B[1] < 1e-6) B[0] = A[0];
  let dh = B[0] - A[0];
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  return bmlRgb([(A[0] + dh * u + 360) % 360, A[1] + (B[1] - A[1]) * u, A[2] + (B[2] - A[2]) * u]);
}
function bmlHsl([r, g, b]) {
  (r /= 255), (g /= 255), (b /= 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}
function bmlRgb([h, s, l]) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map((v) => Math.round((v + m) * 255));
}

/* Black or white text, whichever reads better on rgb. */
function bmlInk(rgb) {
  const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  return (L + 0.05) / 0.05 >= 1.05 / (L + 0.05) ? "#000" : "#fff";
}

/* How long a measurement should take, in seconds: homing, heating from
   the bed's temperature, the macro's soak, the U1's preheat, the points.
   `perPoint`: the last measurement's own pace, when known. */
function bmlEstimate({ points = 169, samples = 3, preheat = 60, temp = 55, bed = 25, autoMacro = true, homed = "", perPoint = null }) {
  let s = /x/.test(homed) && /y/.test(homed) && /z/.test(homed) ? 0 : 40;
  if (temp > 0) {
    s += Math.max(0, temp - bed) / 0.5; // ~0.5 °C/s
    if (autoMacro) s += BML_SOAK + preheat; // AUTO_BED_MESH_CALIBRATE: 2 min, then the probe's preheat
  }
  if (autoMacro) s += 25; // the U1's check of its 4 corners
  s += points * (perPoint || 0.8 + 0.6 * samples);
  return Math.round(s);
}

/* AUTO_BED_MESH_CALIBRATE (Snapmaker U1): M140, M190, then G4 P120000 —
   the bed left 2 min to settle — then BED_MESH_CALIBRATE, which preheats
   the probe (`preheat_duration`, a countdown in bed_mesh.progress), checks
   the 4 corners (prescanning), then probes. */
const BML_SOAK = 120;

/* The steps of a measurement, in order. `u1`: the printer has
   AUTO_BED_MESH_CALIBRATE (soak, probe preheat, corner check). */
function bmlRunSteps({ temp, u1, preheat = 60, homedAtStart }) {
  return [
    ...(homedAtStart ? [] : ["home"]),
    ...(temp > 0 ? ["heat"] : []),
    ...(temp > 0 && u1 ? ["soak"] : []),
    ...(temp > 0 && u1 && preheat > 0 ? ["preheat"] : []),
    ...(u1 ? ["prescan"] : []),
    "probe",
  ];
}

/* Where a measurement stands: the step under way, what to say, how far
   (`pct` 0–1 or null). `run`: { temp, u1, homedAtStart, soakStart (ms),
   seen (the printer's own leveling began) }. The soak has no state on the
   printer: it starts when the bed reaches its temperature and lasts
   BML_SOAK. A state left from an earlier measurement (completed,
   aborted) counts only once this one's leveling began. */
function bmlRunPhase(live, run, now = Date.now()) {
  const p = live?.progress, bed = live?.bed, st = p?.state;
  if (st === "probing") return { cur: "probe", n: p.current, total: p.total, pct: p.total ? p.current / p.total : null };
  if (st === "prescanning") return { cur: "prescan", pct: null };
  if (st === "preheating") return { cur: "preheat", left: p.preheat_left, pct: p.preheat_total ? (p.preheat_total - p.preheat_left) / p.preheat_total : null };
  if (run.seen && (st === "aborting" || st === "aborted")) return { cur: "aborted", pct: null };
  if (run.seen && st === "completed") return { cur: "probe", n: p.total, total: p.total, pct: 1 };
  const h = live?.homed || "";
  if (!run.homedAtStart && !(/x/.test(h) && /y/.test(h) && /z/.test(h))) return { cur: "home", pct: null };
  if (run.temp > 0 && !run.soakStart && !(bed && bed.current >= run.temp - 1)) {
    return { cur: "heat", t: bed?.current ?? null, target: run.temp, pct: bed ? Math.min(1, bed.current / run.temp) : null };
  }
  if (run.temp > 0 && run.u1) {
    const start = run.soakStart || now;
    const left = Math.max(0, BML_SOAK - (now - start) / 1000);
    return { cur: "soak", left, soakStart: start, pct: 1 - left / BML_SOAK };
  }
  return { cur: run.u1 ? "prescan" : "probe", pct: null };
}

/* What the printer is doing during a measurement, from bed_mesh.progress
   and the bed: heating, soak, preheat, prescan, probing, done. */
function bmlPhase(live, temp) {
  const p = live?.progress, bed = live?.bed;
  if (p?.state === "probing") return { phase: "probing", current: p.current, total: p.total };
  if (p?.state === "preheating") return { phase: "preheat", left: p.preheat_left, total: p.preheat_total };
  if (p?.state === "prescanning") return { phase: "prescan" };
  if (p?.state === "aborting" || p?.state === "aborted") return { phase: "aborted" };
  if (temp > 0 && bed && bed.current < temp - 1) return { phase: "heating", current: bed.current, target: temp };
  return { phase: "soak" };
}

/* ------------------------------------------------------------ diagnosis */

/* What shape the bed has, as findings a person can act on, biggest first:
   - tilt: one side higher ({ side: "right" | "back-left" …, amount });
   - corner: one corner up or down ({ corner, high, amount });
   - bowl (edges up) or dome (centre up) ({ amount });
   - bump: one point apart from its surroundings ({ at: [i, j], high, amount }).
   Each with `zone`: the probed points [i, j] to show on the map. `amount`
   is the height (mm) that shape accounts for across the bed. Found by
   matching the shapes one after the other on what is left to explain;
   nothing under 0.03 mm, nor what explains too little of the bed. */
function bmlShape(mesh) {
  const st = bmlStats(mesh);
  if (!st || st.nx < 3 || st.ny < 3) return [];
  const nx = st.nx, ny = st.ny;
  const pts = [];
  mesh.points.forEach((r, j) => r.forEach((z, i) => z != null && Number.isFinite(z) && pts.push({ i, j, u: (2 * i) / (nx - 1) - 1, w: (2 * j) / (ny - 1) - 1, z })));
  const n = pts.length;
  const centred = (f) => {
    const v = pts.map(f), m = v.reduce((a, b) => a + b, 0) / n;
    return v.map((x) => x - m);
  };
  const dot = (a, b) => a.reduce((s, x, k) => s + x * b[k], 0);
  const span = (v) => Math.max(...v) - Math.min(...v);
  let e = centred((p) => p.z);
  const total = dot(e, e);
  if (total < 1e-12) return [];
  const U = centred((p) => p.u), W = centred((p) => p.w), Q = centred((p) => p.u * p.u + p.w * p.w);
  const corners = [[-1, -1, "front-left"], [1, -1, "front-right"], [-1, 1, "back-left"], [1, 1, "back-right"]].map(([su, sw, name]) => ({
    name, su, sw, v: centred((p) => Math.max(0, su * p.u) * Math.max(0, sw * p.w)),
  }));
  const findings = [];
  const used = new Set();
  for (let round = 0; round < 3; round++) {
    const cands = [];
    if (!used.has("tilt")) {
      const b = dot(e, U) / dot(U, U), c = dot(e, W) / dot(W, W);
      const fit = U.map((x, k) => b * x + c * W[k]);
      cands.push({ kind: "tilt", fit, gain: dot(fit, fit), b, c });
    }
    if (!used.has("q")) {
      const d = dot(e, Q) / dot(Q, Q), fit = Q.map((x) => d * x);
      cands.push({ kind: d > 0 ? "bowl" : "dome", key: "q", fit, gain: dot(fit, fit), d });
    }
    for (const cn of corners) {
      if (used.has("corner")) break;
      const k = dot(e, cn.v) / dot(cn.v, cn.v), fit = cn.v.map((x) => k * x);
      cands.push({ kind: "corner", key: "corner", fit, gain: dot(fit, fit), cn, k });
    }
    cands.sort((a, b) => b.gain - a.gain);
    const best = cands[0];
    const amount = span(best.fit);
    // Worth saying: a real height, and a real part of the bed's shape.
    if (!best || amount < 0.03 || best.gain < 0.2 * total) break;
    used.add(best.key || best.kind);
    e = e.map((x, k) => x - best.fit[k]);
    if (best.kind === "tilt") {
      const { b, c } = best;
      const x = Math.abs(b) > 0.4 * Math.abs(c) ? (b > 0 ? "right" : "left") : "";
      const y = Math.abs(c) > 0.4 * Math.abs(b) ? (c > 0 ? "back" : "front") : "";
      const side = [y, x].filter(Boolean).join("-");
      const zone = pts.filter((p) => b * p.u + c * p.w >= 0.6 * (Math.abs(b) + Math.abs(c))).map((p) => [p.i, p.j]);
      findings.push({ kind: "tilt", side, amount: bmlRound(amount, 3), zone });
    } else if (best.kind === "corner") {
      const { cn, k } = best;
      const zone = pts.filter((p) => Math.max(0, cn.su * p.u) * Math.max(0, cn.sw * p.w) >= 0.25).map((p) => [p.i, p.j]);
      findings.push({ kind: "corner", corner: cn.name, high: k > 0, amount: bmlRound(amount, 3), zone });
    } else {
      // Bowl: the edges are up; dome: the centre is.
      const r2 = (p) => p.u * p.u + p.w * p.w;
      const zone = pts.filter((p) => (best.kind === "dome" ? r2(p) <= 0.5 : r2(p) >= 1.2)).map((p) => [p.i, p.j]);
      findings.push({ kind: best.kind, amount: bmlRound(amount, 3), zone });
    }
  }
  // One point apart from the rest once the shapes are taken out.
  const abs = e.map(Math.abs).sort((a, b) => a - b);
  const mad = abs[Math.floor(abs.length / 2)] || 0;
  let worst = 0;
  e.forEach((x, k) => Math.abs(x) > Math.abs(e[worst]) && (worst = k));
  const out = e[worst];
  if (Math.abs(out) >= Math.max(0.04, 4 * 1.4826 * mad, 0.3 * st.dev)) {
    const p = pts[worst];
    findings.push({ kind: "bump", at: [p.i, p.j], high: out > 0, amount: bmlRound(Math.abs(out), 3), zone: [[p.i, p.j]] });
  }
  return findings.sort((a, b) => b.amount - a.amount);
}

/* ------------------------------------------------------------ state */

/* When to measure again: never measured, the last one too old (days) or
   too many prints since (`jobsAtLast`: the printer's job count when it was
   stored). Null when nothing is asked. */
function bmlReminder({ last = null, now = Date.now() / 1000, jobsNow = null, jobsAtLast = null } = {}, s) {
  const st = bmlSettings(s);
  if (!last) return { reason: "never" };
  if (!st.remind) return null;
  const days = Math.floor((now - last) / 86400);
  if (days >= st.remindDays) return { reason: "days", days };
  const prints = jobsNow != null && jobsAtLast != null ? jobsNow - jobsAtLast : null;
  if (st.remindPrints && prints != null && prints >= st.remindPrints) return { reason: "prints", prints };
  return null;
}

/* The page's state, for its card and its one action:
   none (never measured), out, watch (with how it moved since the previous
   one), stale (asks to measure again), good. */
function bmlState(hist, s, ctx = {}) {
  const st = bmlSettings(s);
  const list = [...(hist || [])].filter((m) => !m.partial).sort((a, b) => a.at - b.at);
  const last = list[list.length - 1];
  if (!last) return { kind: "none" };
  const dev = bmlStats(last).dev;
  const prev = list[list.length - 2];
  const change = prev ? { delta: bmlDelta(bmlStats(prev).dev, dev), at: prev.at } : null;
  const status = bmlStatus(dev, st);
  const remind = bmlReminder({ ...ctx, last: last.at }, st);
  const base = { dev, at: last.at, status, change, remind };
  if (status === "out") return { kind: "out", ...base };
  if (remind) return { kind: "stale", ...base };
  if (status === "watch") return { kind: "watch", ...base };
  return { kind: "good", ...base };
}

/* The bed temperature to propose: the last print's first layer, else the
   one used last time, else 60 °C; never above the bed's `max` (its
   max_temp, 100 °C on the U1). */
function bmlSuggestTemp(lastJob, stored, max = 100) {
  const t = lastJob?.bed_temp;
  if (Number.isFinite(t) && t > 0) return { temp: Math.min(max, Math.round(t)), from: "last", file: lastJob.filename || "" };
  if (Number.isFinite(+stored) && stored !== null && stored !== "") return { temp: Math.max(0, Math.min(max, Math.round(+stored))), from: "stored" };
  return { temp: Math.min(max, 60), from: "default" };
}

/* A measurement still under way on the printer: its leveling running, or
   the bed still heated by it (the script turns it off at the end). For
   following it when the app's request ended early (time out, network). */
const bmlStillMeasuring = (live, temp) =>
  ["preheating", "prescanning", "probing", "aborting"].includes(live?.progress?.state) || (temp > 0 && (live?.bed?.target || 0) > 0);

/* A print ended a short while ago: its part may still be on the bed.
   Minutes since, or null. */
function bmlRecentPrint(lastJob, now = Date.now() / 1000, within = 12 * 3600) {
  if (!lastJob || lastJob.status !== "completed" || !(lastJob.end > 0)) return null;
  const s = now - lastJob.end;
  return s >= 0 && s <= within ? Math.round(s / 60) : null;
}

/* The deviation over time: [{ at, dev }], oldest first. */
const bmlTrend = (hist) => [...(hist || [])].filter((m) => !m.partial).sort((a, b) => a.at - b.at).map((m) => ({ at: m.at, dev: bmlStats(m)?.dev ?? 0 }));

if (typeof module !== "undefined")
  module.exports = { BML_SOAK, bmlRunSteps, bmlRunPhase, BML_DEFAULTS, BML_KEEPS, BML_LEVELS, BML_REMIND_DAYS, BML_REMIND_PRINTS, bmlLevelOf, bmlDelta, bmlShape, bmlReminder, bmlState, bmlSuggestTemp, bmlStillMeasuring, bmlRecentPrint, bmlSettings, bmlStats, bmlStatus, bmlAlert, bmlXY, bmlSample, bmlUpsample, bmlDiff, bmlScale, bmlT, bmlColor, bmlInk, bmlEstimate, bmlPhase, bmlTrend };
