// node scripts/test-prints.js — the Prints page: filters, day groups, time per layer, pauses, timeline, timelapse.
const assert = require("assert");
const L = require("../ui/prints-logic.js");
const F = require("../ui/pfiles-logic.js");

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime() / 1000;
const job = (o) => ({ id: "x", name: "Benchy", printer_id: "a", state: "complete", created: 0, events: [], profile: {}, stats: {}, ...o });

// Failed: stopped, or said failed in its record.
assert.equal(L.pjlFailed(job({ state: "complete" })), false);
assert.equal(L.pjlFailed(job({ state: "error" })), true);
assert.equal(L.pjlFailed(job({ state: "cancelled" })), true);
assert.equal(L.pjlFailed(job({ state: "complete", result: { success: false } })), true);
assert.equal(L.pjlFailed(job({ state: "complete", result: { success: true } })), false);

// Search: name and files, accents and case ignored, every word.
const sup = job({ name: "Support écran", source: "/m/desk/support-ecran.3mf", remote: "Support écran-1a2b3c.gcode" });
assert.ok(L.pjlMatches(sup, ""));
assert.ok(L.pjlMatches(sup, "ECRAN"));
assert.ok(L.pjlMatches(sup, "3mf support"));
assert.ok(L.pjlMatches(sup, "1a2b3c"));
assert.ok(!L.pjlMatches(sup, "desk"), "the folder is not searched");
assert.ok(!L.pjlMatches(sup, "vase"));

// Materials: the heads used, once each.
const multi = job({ stats: { tools: [0, 2], filament_types: ["pla", "PETG", "PLA"] } });
assert.deepEqual(L.pjlMaterials(multi), ["PLA"]);
assert.deepEqual(L.pjlMaterials(job({ stats: { tools: [1, 0], filament_types: ["PLA", "PETG"] } })), ["PETG", "PLA"]);
assert.deepEqual(L.pjlMaterials(job({ stats: { filament_types: ["TPU"] } })), ["TPU"]);
assert.deepEqual(L.pjlMaterials(job({ stats: null })), []);

// Filters and chips.
const list = [
  job({ id: "q", state: "queued", printer_id: "a" }),
  job({ id: "p", state: "printing", printer_id: "b" }),
  job({ id: "ok", printer_id: "a", stats: { filament_types: ["PLA"] } }),
  job({ id: "ko", state: "error", printer_id: "b", stats: { filament_types: ["PETG"] } }),
  job({ id: "bad", printer_id: "a", result: { success: false }, stats: { filament_types: ["PETG"] } }),
];
const ids = (o) => list.filter((j) => L.pjlPasses(j, o)).map((j) => j.id);
assert.deepEqual(ids({}), ["q", "p", "ok", "ko", "bad"]);
assert.deepEqual(ids({ filter: "active" }), ["q", "p"]);
assert.deepEqual(ids({ filter: "finished" }), ["ok"]);
assert.deepEqual(ids({ filter: "failed" }), ["ko", "bad"]);
assert.deepEqual(ids({ printers: new Set(["b"]) }), ["p", "ko"]);
assert.deepEqual(ids({ materials: new Set(["PETG"]) }), ["ko", "bad"]);
assert.deepEqual(ids({ filter: "failed", printers: new Set(["a"]) }), ["bad"]);
assert.deepEqual(L.PJL_FILTERS, ["all", "active", "finished", "failed"]);

// Day groups: today, yesterday, then each day, newest first, grams summed.
const now = new Date(2026, 9, 27, 15, 0).getTime();
const days = L.pjlDays([
  job({ id: "a", finished: at(2026, 10, 27, 11, 42), stats: { filament_g: 86.4 } }),
  job({ id: "b", finished: at(2026, 10, 26, 21, 14), stats: { filament_g: 100 } }),
  job({ id: "c", finished: at(2026, 10, 27, 9, 5), stats: { filament_g: 21.8 } }),
  job({ id: "d", finished: at(2026, 10, 24, 18, 40), stats: {} }),
  job({ id: "e", finished: at(2026, 10, 26, 0, 10), stats: { filament_g: 1 } }),
], now);
assert.deepEqual(days.map((d) => [d.day, d.rel, d.jobs.map((j) => j.id)]), [
  ["2026-10-27", "today", ["a", "c"]],
  ["2026-10-26", "yesterday", ["b", "e"]],
  ["2026-10-24", null, ["d"]],
]);
assert.equal(days[0].grams.toFixed(1), "108.2");
assert.equal(days[2].grams, 0);
assert.deepEqual(L.pjlDays([], now), []);

// Time per layer: differences between layer ends, bars summing layers.
assert.deepEqual(L.pjlLayerTimes([10, 25, 45]), [10, 15, 20]);
assert.deepEqual(L.pjlLayerTimes(null), []);
assert.deepEqual(L.pjlLayerBars([10, 25, 45], 120), [{ from: 1, to: 1, s: 10 }, { from: 2, to: 2, s: 15 }, { from: 3, to: 3, s: 20 }]);
const ends = Array.from({ length: 302 }, (_, i) => (i + 1) * 30);
const bars = L.pjlLayerBars(ends, 120);
assert.ok(bars.length <= 120);
assert.equal(bars[0].from, 1);
assert.equal(bars[bars.length - 1].to, 302, "every layer in a bar");
assert.equal(bars[0].s, 30 * (bars[0].to - bars[0].from + 1));
assert.deepEqual(L.pjlLayerBars([], 120), []);

// Pauses and real duration: an open pause runs to the end.
const paused = job({ started: 1000, finished: 10000, events: [{ kind: "pause", at: 4000 }, { kind: "resume", at: 4360 }, { kind: "pause", at: 9000 }] });
assert.deepEqual(L.pjlPauses(paused), [{ from: 4000, to: 4360 }, { from: 9000, to: 10000 }]);
assert.deepEqual(L.pjlDuration(paused), { total: 9000, paused: 1360 });
assert.equal(L.pjlDuration(job({ started: 5 })), null, "not finished");
assert.deepEqual(L.pjlPauses(job({ events: [{ kind: "pause", at: 4 }] }), null), [{ from: 4, to: null }], "still paused");
assert.equal(L.pjlDelta(9120, 8640), 6);
assert.equal(L.pjlDelta(100, 0), null);
assert.equal(L.pjlDelta(null, 10), null);

// Timeline: in order, the end in its own word.
assert.deepEqual(L.pjlTimeline(job({ ...paused, created: 900, profile: { process: "0.20mm Standard" }, state: "cancelled" })).map((e) => e.kind), ["sliced", "started", "pause", "resume", "pause", "cancelled"]);
assert.deepEqual(L.pjlTimeline(job({ created: 1, state: "finished", started: 2, finished: 3 })).map((e) => e.kind), ["added", "started", "complete"]);
assert.deepEqual(L.pjlTimeline(job({ created: 1, state: "queued" })).map((e) => e.kind), ["added"]);

// Default record: the first running print, else the latest finished one.
const done = [job({ id: "old", finished: 10 }), job({ id: "new", finished: 20 }), job({ id: "q", state: "queued" })];
assert.equal(L.pjlDefaultKey(["live:a", "live:b"], done), "live:a");
assert.equal(L.pjlDefaultKey([], done), "job:new");
assert.equal(L.pjlDefaultKey([], [job({ id: "q", state: "queued" })]), "job:q");
assert.equal(L.pjlDefaultKey([], []), null);

// Timelapse: on the print's span, its name first, else the closest to its end.
const p = job({ name: "Cube", remote: "Cube-3f9a0c.gcode", started: at(2026, 10, 19, 13, 0), finished: at(2026, 10, 19, 15, 25) });
const vids = [
  { root: "timelapse", path: "timelapse_Other_20261019_1528.mp4", modified: 0 },
  { root: "timelapse", path: "timelapse_Cube-3f9a0c_20261019_1540.mp4", modified: 0 },
  { root: "camera", path: "20261019090000.mp4", modified: 0 },
];
const m = (v, j = p) => L.pjlMatchTimelapse(j, v, F.pflVideoDate, F.pflVideoTitle);
assert.equal(m(vids).path, "timelapse_Cube-3f9a0c_20261019_1540.mp4", "named after the print");
assert.equal(m([vids[0], vids[2]]).path, "timelapse_Other_20261019_1528.mp4", "a U1's unnamed video: the closest");
assert.equal(m([{ root: "camera", path: "20261019152600.mp4" }, { root: "camera", path: "20261019153500.mp4" }]).path, "20261019152600.mp4");
assert.equal(m([vids[2]]), null, "hours before: another print's");
assert.equal(m(vids, job({})), null, "no dates, no match");
assert.equal(m([]), null);

assert.equal(L.pjlQueueTime([job({ stats: { print_time_s: 60 } }), job({ stats: null }), job({ stats: { print_time_s: 30 } })]), 90);
assert.ok(L.PJL_REASONS.includes("other"));

// Automatic deletion: finished prints past the limit only (as jobs.rs prune).
const D = 86400, t0 = 400 * D;
const hist = [job({ id: "new", finished: t0 - 10 * D }), job({ id: "old", state: "error", finished: t0 - 40 * D }), job({ id: "q", state: "queued", created: 1, finished: null }), job({ id: "nod", created: t0 - 100 * D, finished: null })];
assert.deepEqual(L.pjlExpired(hist, 30, t0).map((j) => j.id), ["old", "nod"]);
assert.deepEqual(L.pjlExpired(hist, 90, t0).map((j) => j.id), ["nod"]);
assert.deepEqual(L.pjlExpired(hist, null, t0), [], "never");

console.log("prints: ok");
