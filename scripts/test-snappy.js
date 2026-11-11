// Snappy's drawer (ui/snappy-logic.js): events to items, summaries for Snappy.
// node scripts/test-snappy.js
const assert = require("assert");
const S = require("../ui/snappy-logic.js");

assert.strictEqual(S.snappyToolName("mcp__snap-studio__printers"), "printers");
assert.strictEqual(S.snappyToolName("other"), "other");

// A turn: the user's text, a tool and its result, the answer, the end.
const items = [
  { type: "user", message: { content: [{ type: "text", text: "Which printers?" }] } },
  { type: "assistant", message: { content: [{ type: "thinking" }, { type: "tool_use", id: "t1", name: "mcp__snap-studio__printers", input: {} }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "[]" }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "You have **one** printer." }] } },
  { type: "result", subtype: "success", is_error: false },
].flatMap(S.snappyItems);
assert.deepStrictEqual(
  items.map((i) => i.kind),
  ["user", "tool", "tool_done", "assistant", "end"]
);
assert.strictEqual(items[1].name, "printers");
assert.strictEqual(items[4].stopped, false);
assert.strictEqual(items[4].error, null);

// A message with images; the app's own notes.
const withImages = S.snappyItems({ type: "user", message: { content: [{ type: "attachment", name: "001-a.jpg" }, { type: "text", text: "Why?" }] } });
assert.deepStrictEqual(withImages, [{ kind: "user", text: "Why?", images: ["001-a.jpg"] }]);
assert.deepStrictEqual(S.snappyItems({ type: "note", kind: "forgotten" }), [{ kind: "note", key: "snappy.forgotten" }]);

// Stopped, failed, ended, signed out.
assert.strictEqual(S.snappyItems({ type: "result", subtype: "error_during_execution", is_error: true })[0].stopped, true);
assert.strictEqual(S.snappyItems({ type: "result", subtype: "error", is_error: true, result: "API Error" })[0].error, "API Error");
assert.strictEqual(S.snappyItems({ type: "exited" })[0].kind, "exited");
assert.strictEqual(S.snappyItems({ type: "auth_failed" })[0].kind, "auth");
assert.deepStrictEqual(S.snappyItems({ type: "system" }), []);
assert.deepStrictEqual(S.snappyItems(null), []);

// Prepare's summary: names and settings, the last slice rounded, no paths.
const sum = S.snappySliceSummary({
  printer: "Workshop U1",
  machine: "Snapmaker U1 (0.4 nozzle)",
  process: "0.20mm Standard @Snapmaker U1",
  simple: { infill: 15, walls: 2, supports: false, brim: true },
  layer: "0.20 mm",
  stats: { print_time_s: 3725, filament_g: 12.345, layers: 120 },
  objects: [{ name: "benchy.3mf", path: "/Users/someone/benchy.3mf" }],
});
assert.strictEqual(sum.infill_percent, 15);
assert.deepStrictEqual(sum.last_slice, { print_time_min: 62, filament_g: 12.3, layers: 120 });
assert.deepStrictEqual(sum.objects, ["benchy.3mf"]);
assert.ok(!JSON.stringify(sum).includes("/Users/"), "no path");
assert.strictEqual(S.snappySliceSummary({}).last_slice, undefined);

// The Files view, by name only, capped.
const files = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.stl`, path: `/x/f${i}.stl` }));
assert.deepStrictEqual(S.snappyLocalFiles(files, 3), { files: ["f0.stl", "f1.stl", "f2.stl"], total: 5 });

// A local file by name: its path for the app, an error when unknown or ambiguous.
assert.deepStrictEqual(S.snappyLocalFile(files, "f1.stl"), { name: "f1.stl", path: "/x/f1.stl" });
assert.ok(S.snappyLocalFile(files, "nope.stl").error);
assert.ok(S.snappyLocalFile([...files, { name: "f1.stl", path: "/y/f1.stl" }], "f1.stl").error.includes("several"));

// Changes to the slice sheet: checked against what it offers, profiles
// first, one line each for the card; already set values left out.
const opts = {
  machine: { value: "U1 0.4", options: [{ value: "U1 0.4", label: "U1 0.4" }, { value: "U1 0.6", label: "U1 0.6" }] },
  process: { value: "0.20mm Standard", options: [{ value: "0.20mm Standard", label: "0.20mm Standard" }, { value: "0.16mm Fine", label: "0.16mm Fine" }] },
  bed: { value: "pei", options: [{ value: "pei", label: "Textured PEI" }] },
  quick: { infill: { value: 15 }, walls: { value: 2 }, speed: { value: 100 }, supports: { value: false }, brim: { value: true } },
  advanced: [
    { key: "sparse_infill_pattern", label: "Pattern", type: "enum", value: "grid", options: [{ value: "grid", label: "Grid" }, { value: "gyroid", label: "Gyroid" }] },
    { key: "ironing_type", label: "Ironing", type: "enum", value: "no ironing", options: [{ value: "no ironing", label: "None" }, { value: "top", label: "Top surfaces" }] },
    { key: "thick_bridges", label: "Thick bridges", type: "bool", value: "0" },
    { key: "top_shell_layers", label: "Top layers", type: "int", value: "4", min: 0, max: 100 },
  ],
};
const words = { machine: "Nozzle", process: "Quality", bed: "Plate", infill: "Infill", walls: "Walls", speed: "Speed", supports: "Supports", brim: "Brim", yes: "Yes", no: "No" };
const c = S.snappySliceCheck({ infill: "30%", sparse_infill_pattern: "Gyroid", process: "0.16mm Fine", supports: true, thick_bridges: 1, brim: true, top_shell_layers: 6 }, opts, words);
assert.ok(!c.error, c.error);
assert.deepStrictEqual(c.changes.map((x) => x.key), ["process", "infill", "sparse_infill_pattern", "supports", "thick_bridges", "top_shell_layers"]);
assert.deepStrictEqual(c.changes.find((x) => x.key === "sparse_infill_pattern").value, "gyroid");
assert.strictEqual(c.changes.find((x) => x.key === "thick_bridges").value, "1");
assert.strictEqual(c.lines[0], "Quality: 0.20mm Standard → 0.16mm Fine");
assert.ok(c.lines.includes("Infill: 15 % → 30 %"));
assert.ok(c.lines.includes("Supports: No → Yes"));
assert.ok(c.lines.includes("Pattern: Grid → Gyroid"));
assert.ok(S.snappySliceCheck({ infill: 300 }, opts, words).error);
assert.ok(S.snappySliceCheck({ walls: 0 }, opts, words).error);
assert.ok(S.snappySliceCheck({ machine: "U2" }, opts, words).error);
assert.ok(S.snappySliceCheck({ nope: 1 }, opts, words).error);
assert.ok(S.snappySliceCheck({ ironing_type: "everything" }, opts, words).error);
assert.ok(S.snappySliceCheck({ top_shell_layers: 500 }, opts, words).error);
assert.ok(S.snappySliceCheck({ brim: true }, opts, words).error, "nothing to change");
assert.ok(S.snappySliceCheck({}, opts, words).error);

// The avatar (ui/snappy-avatar.js): open-bot-avatar's pose model.
const A = require("../ui/snappy-avatar.js");
const pose = (mood, extra = {}) => A.snvMoodPose({ seed: 7, t: 3, mood, gaze: null, reduced: false, ...extra });
// The eyes face you: centered, upright pills, side by side.
const still = pose("idle", { reduced: true });
const eyes = A.snvEyesSvg(still);
const xs = [...eyes.matchAll(/x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/g)].map((m) => +m[1] + +m[2] / 2);
assert.strictEqual(xs.length, 2);
assert.ok(Math.abs((xs[0] + xs[1]) / 2 - 50) < 1e-6, "centered: " + xs);
assert.ok(!eyes.includes("rotate"), "upright");
// Thinking: a full turn about the vertical axis, then a pause; the pointer does not turn it.
assert.strictEqual(A.snvSpin(0), 0);
assert.ok(Math.abs(A.snvSpin(0.75) - Math.PI) < 1e-9, "half way");
assert.ok(Math.abs(A.snvSpin(2.5) - 2 * Math.PI) < 1e-9, "a whole turn, then still");
const thinking = pose("thinking", { t: 0.75 });
const pointed = pose("thinking", { t: 0.75, gaze: { x: 1, y: 0, weight: 1 } });
assert.strictEqual(thinking.yaw, pointed.yaw, "the pointer does not turn a thinking avatar");
assert.ok(thinking.gazeY < 0, "eyes up");
// Idle follows the pointer with the whole body.
assert.ok(pose("idle", { gaze: { x: 1, y: 0, weight: 1 } }).yaw > pose("idle").yaw);
// Happy: hops, eyes as arcs.
assert.ok(A.snvEyesSvg(pose("happy")).includes("<path"));
// Leaving a turn takes the short way round.
const b = A.snvBlend({ ...still, yaw: 2 * Math.PI - 0.1 }, { ...still, yaw: 0.1 }, 0.5);
assert.ok(Math.abs(Math.sin(b.yaw)) < 1e-9 && Math.cos(b.yaw) > 0, "through 0, not back through π");
// Reduced motion: no turn, no lift.
const r = pose("thinking", { reduced: true });
assert.ok(Math.abs(r.yaw) < 0.2 && r.lift === 0);
// Idle gestures: now and then, at random moments, of every kind; none
// under reduced motion.
const seen = new Set(), starts = [];
let was = null;
for (let t = 0; t < 600; t += 0.05) {
  const g = A.snvGesture(7, t);
  if (g.kind && !was) starts.push(t);
  if (g.kind) seen.add(g.kind);
  was = g.kind;
}
assert.deepStrictEqual([...seen].sort(), ["hop", "look", "sway", "tilt", "wiggle"]);
const gaps = starts.slice(1).map((s, i) => s - starts[i]);
assert.ok(Math.min(...gaps) > 0.5 && new Set(gaps.map((g) => g.toFixed(1))).size > 10, "irregular: " + gaps.slice(0, 8));
assert.ok(starts.length > 60 && starts.length < 130, "every 4 to 9 s or so: " + starts.length);
// A sway goes one way, then the other.
let sway = null;
for (let t = 0; t < 600 && !sway; t += 0.05) if (A.snvGesture(7, t).kind === "sway") sway = t;
const rolls = [];
for (let t = sway; A.snvGesture(7, t).kind === "sway"; t += 0.05) rolls.push(A.snvGesture(7, t).roll);
assert.ok(Math.max(...rolls) > 3 && Math.min(...rolls) < -3, "left and right");
assert.strictEqual(A.snvMoodPose({ seed: 7, t: sway + 0.5, mood: "idle", reduced: true }).roll, 0, "still under reduced motion");

// The pointer is looked at softly, from the eyes.
const g = A.snvPointerGaze({ x: 1000, y: 0 }, { left: 0, top: 0, width: 42, height: 42 });
assert.ok(g.x > 0.99 && g.x <= 1);

// The card's own words follow a language change while they show: each is
// bound to its key (data-i18n, re-applied on langchange), never written once
// with tr() as plain text (the empty card's description stayed French).
const card = require("fs").readFileSync(require("path").join(__dirname, "..", "ui", "snappy-card.js"), "utf8");
for (const key of ["snappy.empty", "snappy.approve.title", "snappy.approve.allow", "snappy.approve.refuse", "snappy.question.other", "snappy.question.skip"]) {
  assert.ok(card.includes(`"${key}"`), key);
  assert.ok(!new RegExp(`(textContent|placeholder)\\s*=\\s*tr\\("${key.replace(/\./g, "\\.")}"`).test(card), `${key} written once as text`);
  assert.ok(!new RegExp(`snappyDiv\\([^)]*tr\\("${key.replace(/\./g, "\\.")}"`).test(card), `${key} written once as text`);
}
assert.ok(/langchange[^\n]*applyI18n\(\$\("snappy"\)\)/.test(card), "the card re-applies its words on langchange");

// The icon's avatar never takes the pointer: its eyes are redrawn as they
// follow it, and a press on an eye replaced before the release lost the
// click in WebKit (the icon opened on the second click). The scale is the
// avatar's, so the button's box does not shrink under the pointer.
const css = require("fs").readFileSync(require("path").join(__dirname, "..", "ui", "style.css"), "utf8");
assert.ok(/\.snappy-fab \.snappy-av \{[^}]*pointer-events:\s*none/.test(css), "the icon's avatar takes no pointer");
assert.ok(!/\.snv[^{,]*\{[^}]*pointer-events:\s*(auto|all)/.test(css), "no part of the avatar takes the pointer back");
assert.ok(!/\.snappy-fab:(hover|active)\s*\{[^}]*transform/.test(css), "the button itself does not scale");
const html = require("fs").readFileSync(require("path").join(__dirname, "..", "ui", "index.html"), "utf8");
assert.ok(/<button id="snappy-fab"[^>]*>\s*<span class="snappy-av"/.test(html), "the avatar sits in .snappy-av inside the button");

console.log("snappy: ok");
