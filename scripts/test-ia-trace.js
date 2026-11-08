// Terminal view of a conversation (ui/ia-trace.js): chat events as terminal text.
// node scripts/test-ia-trace.js
const assert = require("assert");
const T = require("../ui/ia-trace.js");

const t = (k, p = {}) => k + (Object.keys(p).length ? JSON.stringify(p) : "");
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const run = (events) => {
  const st = {};
  return plain(events.map((ev) => T.traceEvent(ev, st, t)).join(""));
};

// A turn: the request, a tool and its result, the answer, the end.
const out = run([
  { type: "user", message: { content: [{ type: "text", text: "Make it 2 mm thicker" }, { type: "attachment", name: "a.png" }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "python3 tools/mf.py\n  --thicken 2" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok\nsaved v2.3mf\n" }] }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "Done: the walls\nare 2 mm thicker." }] } },
  { type: "version", n: 2 },
  { type: "result", subtype: "success", is_error: false, duration_ms: 41800 },
]);
assert.ok(out.includes("❯ Make it 2 mm thicker trace.images{\"n\":1}"), out);

// STL/3MF attached: counted beside the text, and a message of models only
// is still shown.
const models = run([
  { type: "user", message: { content: [{ type: "model", name: "1-bracket.stl" }, { type: "model", name: "2-lid.3mf" }, { type: "text", text: "Join them" }] } },
  { type: "user", message: { content: [{ type: "model", name: "3-base.stl" }] } },
]);
assert.ok(models.includes('❯ Join them trace.models{"n":2}'), models);
assert.ok(models.includes('❯  trace.models{"n":1}'), models);
assert.ok(out.includes("● Bash(python3 tools/mf.py --thicken 2)"), "command on one line");
assert.ok(out.includes("  ⎿ ok\r\n    saved v2.3mf\r\n"), "result lines, trailing empty line dropped");
assert.ok(out.includes("Done: the walls\r\nare 2 mm thicker."), "newlines as terminal line ends");
assert.ok(out.includes('trace.version{"n":2}'));
assert.ok(out.includes('trace.done_in{"s":42}'));
assert.ok(!out.includes("\n") || !/[^\r]\n/.test(out), "every newline is \\r\\n");

// Streamed text is written as it comes, and not again with the message.
const streamed = run([
  { type: "stream_event", event: { type: "message_start" } },
  { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } },
  { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } },
  { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
]);
assert.equal(streamed, "\r\nHello\r\n");

// Long results are cut, errors and stops said.
const long = run([{ type: "user", message: { content: [{ type: "tool_result", content: Array.from({ length: 20 }, (_, i) => "l" + i).join("\n"), is_error: true }] } }]);
assert.ok(long.includes("l7") && !long.includes("l8\r\n") && long.includes('trace.more{"n":12}'));
assert.ok(run([{ type: "result", subtype: "error_during_execution", is_error: true }]).includes("trace.stopped"));
assert.ok(run([{ type: "result", is_error: true, result: "Overloaded" }]).includes("✗ Overloaded"));
assert.ok(run([{ type: "control_request", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "rm -rf build" } } }]).includes('? trace.permission{"tool":"Bash"} rm -rf build'));
assert.ok(run([{ type: "permission_answer", allow: false }]).includes("→ trace.denied"));
assert.ok(run([{ type: "exited", code: 137 }]).includes('trace.exited (trace.code{"code":137})'));
assert.equal(run([{ type: "exited" }]), "trace.exited\r\n");
// The interruption marker and events of no interest show nothing.
assert.equal(run([{ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }, { type: "seen" }, { type: "system", subtype: "init" }]), "");

// Summaries: the useful field, otherwise compact JSON, cut when long.
assert.equal(T.traceToolSummary("Read", { file_path: "/w/model.3mf" }), "/w/model.3mf");
assert.equal(T.traceToolSummary("X", { a: 1 }), '{"a":1}');
assert.equal(T.traceToolSummary("Bash", { command: "x".repeat(300) }).length, 160);

console.log("ia-trace: ok");
