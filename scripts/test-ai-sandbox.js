// node scripts/test-ai-sandbox.js — the AI's sandbox: the built-in one or
// yolobox, decided once without switching anyone who used yolobox.
const assert = require("assert");
const A = require("../ui/ai-logic.js");
const L = require("../ui/ia-list.js");

const d = (o) => A.aiSandboxDefault(o);
// A saved value always wins, whatever else is true.
assert.strictEqual(d({ saved: "builtin", aiModes: "container", containerConversations: 3, os: "windows" }), "builtin");
assert.strictEqual(d({ saved: "yolobox", aiModes: "local", os: "macos" }), "yolobox");
// A sandbox chosen before this version: yolobox, as it was.
assert.strictEqual(d({ aiModes: "container", os: "macos" }), "yolobox");
assert.strictEqual(d({ aiModes: "both", os: "linux" }), "yolobox");
// A container conversation: yolobox, even if the choice says otherwise.
assert.strictEqual(d({ aiModes: "local", containerConversations: 1, os: "macos" }), "yolobox");
assert.strictEqual(d({ containerConversations: 2, os: "linux" }), "yolobox");
// Windows: nothing changes there (no built-in sandbox).
assert.strictEqual(d({ os: "windows" }), "yolobox");
assert.strictEqual(d({ aiModes: "local", os: "windows" }), "yolobox");
// Fresh macOS / Linux: the built-in sandbox — readiness plays no part
// (yolobox ready but never used for the AI).
assert.strictEqual(d({ os: "macos" }), "builtin");
assert.strictEqual(d({ os: "linux" }), "builtin");
assert.strictEqual(d({}), "builtin", "nothing known");
assert.strictEqual(d({ aiModes: "off", os: "macos" }), "builtin");
assert.strictEqual(d({ aiModes: "local", containerConversations: 0, os: "linux" }), "builtin");
// A corrupt saved value is not a choice.
assert.strictEqual(d({ saved: "docker", os: "macos" }), "builtin");

// The choice's engines, the Sandbox side through the sandbox.
assert.deepStrictEqual(A.aiWantedFor("container", "builtin"), ["sandbox"]);
assert.deepStrictEqual(A.aiWantedFor("container", "yolobox"), ["container"]);
assert.deepStrictEqual(A.aiWantedFor("both", "builtin"), ["sandbox", "local"]);
assert.deepStrictEqual(A.aiWantedFor("both", "yolobox"), ["container", "local"]);
assert.deepStrictEqual(A.aiWantedFor("local", "builtin"), ["local"]);
assert.deepStrictEqual(A.aiWantedFor("off", "builtin"), []);
assert.strictEqual(A.aiSandboxEngine("builtin"), "sandbox");
assert.strictEqual(A.aiSandboxEngine("yolobox"), "container");
// Both sandboxes are the Sandbox side.
assert.deepStrictEqual(["sandbox", "container", "local"].map(A.aiSide), ["container", "container", "local"]);

// The list filter counts both sandbox engines as Sandbox.
const conv = (engine) => ({ id: engine, engine, title: engine, kind: "edit", updated_at: 1, created_at: 1, version: 1, source_name: "a.3mf" });
const list = [conv("sandbox"), conv("container"), conv("local")];
const pass = (engine) => list.filter((c) => L.iaMatches(c, "", { engine })).map((c) => c.engine);
assert.deepStrictEqual(pass("container"), ["sandbox", "container"]);
assert.deepStrictEqual(pass("local"), ["local"]);
assert.deepStrictEqual(pass("all"), ["sandbox", "container", "local"]);

console.log("ai-sandbox: ok");
