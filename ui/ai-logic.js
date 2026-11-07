"use strict";
/* AI modes: which sandbox the "Sandbox" side uses, and what a choice
   allows. Pure, for scripts/test-ai-sandbox.js.

   Three engines run a conversation: "sandbox" (Claude Code's built-in
   sandbox), "container" (yolobox) and "local" (this computer). The user's
   choice (`state.aiModes`) keeps its values — "container" is the Sandbox
   side, "local", "both" or "off" — and `state.aiSandbox` ("builtin" or
   "yolobox") says which engine that side is. */

const AI_SANDBOXES = ["builtin", "yolobox"];

/* The sandbox of someone who never had one saved, decided once: yolobox
   for whoever already chose a sandbox (`aiModes` "container" or "both") or
   holds a container conversation, and on Windows (no built-in sandbox
   there); the built-in one otherwise — even with yolobox and an engine
   ready, never used for the AI. A saved value always wins. */
function aiSandboxDefault({ saved = null, aiModes = null, containerConversations = 0, os = "" } = {}) {
  if (AI_SANDBOXES.includes(saved)) return saved;
  if (aiModes === "container" || aiModes === "both") return "yolobox";
  if (containerConversations > 0) return "yolobox";
  if (os === "windows") return "yolobox";
  return "builtin";
}

/* The engine of the Sandbox side. */
const aiSandboxEngine = (sandbox) => (sandbox === "yolobox" ? "container" : "sandbox");

/* The engines a choice allows, the Sandbox side through `sandbox`. */
function aiWantedFor(choice, sandbox) {
  if (choice === "off") return [];
  const sb = aiSandboxEngine(sandbox);
  if (choice === "both") return [sb, "local"];
  return choice === "local" ? ["local"] : [sb];
}

/* A conversation's side, as the user chose them: both sandboxes are the
   Sandbox side ("container", as `aiModes` names it). */
const aiSide = (engine) => (engine === "local" ? "local" : "container");

if (typeof module !== "undefined") module.exports = { AI_SANDBOXES, aiSandboxDefault, aiSandboxEngine, aiWantedFor, aiSide };
