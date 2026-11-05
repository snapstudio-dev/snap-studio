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

// A setting applied over the remembered ones; unknown ones refused.
assert.deepStrictEqual(S.snappySimpleWith({ infill: 15, walls: 2 }, "infill", 40), { infill: 40, walls: 2 });
assert.throws(() => S.snappySimpleWith({}, "speed", 3));

console.log("snappy: ok");
