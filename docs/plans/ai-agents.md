# AI agents: OpenCode next to Claude Code, one active at a time

## Goal

The AI tab drives one agent, Claude Code, which needs a Claude account.
OpenCode reaches almost every provider (OpenAI, Google, Mistral, DeepSeek,
OpenRouter, GitHub Copilot, local models through Ollama or LM Studio) and
ships free models usable without any account.

1. Add OpenCode as a second agent, in the sandbox and on this computer.
2. **One agent active at a time**, chosen in Settings → AI (and in the
   welcome step). Conversations keep the agent they were made with.
3. Nothing changes for Claude Code users.

## Findings (checked on 2026-10-16, yolobox 0.19.7, OpenCode 1.18.33)

- **yolobox ships OpenCode** (`yolobox opencode`, `--opencode-config`),
  but its image's install is broken: the npm postinstall step did not run,
  so `/usr/bin/opencode` only prints "postinstall script was not run". The
  native binary is there
  (`/usr/lib/node_modules/opencode-ai/node_modules/opencode-linux-<arch>/bin/opencode`),
  and running `node postinstall.mjs` as root fixes the shim. Our Dockerfile
  fragment already runs as root: one more `RUN` line.
- **OpenCode speaks ACP** (Agent Client Protocol, `opencode acp`):
  JSON-RPC 2.0, one object per line on stdin/stdout — the same shape as our
  Claude pipe, so `chat.rs`'s process handling carries over. Tried in the
  sandbox:
  - `initialize` → `loadSession`, `resume`, `fork`, `close`; prompts
    accept images; auth method "run `opencode auth login`";
  - `session/new` → a session id (`ses_…`, not ours), the models offered
    (`configOptions` "model"), the modes `build` / `plan`;
  - `session/prompt` with the free default model: a shell tool call
    (`tool_call` then `tool_call_update` pending → in_progress →
    completed), the text as `agent_message_chunk`, then the result
    `stopReason: end_turn` with token usage. 22 s, no account, the file
    written.
  - No permission request with the defaults: OpenCode allows edits and
    commands unless configured otherwise.
- **Free models without an account**: `opencode/big-pickle` (default) and
  `opencode/*-free` (DeepSeek, GLM, Nemotron, MiMo…). Their names and
  quotas change; the list is always read from `session/new`, never
  hard-coded.
- The other transports are worse fits: `opencode serve` is HTTP inside the
  container (a port to publish, which yolobox has no flag for);
  `opencode run --format json` is one process per message, with no
  permission answers and no interrupt.
- With yolobox's `claude_config` on, OpenCode also loaded the host's Claude
  skills (OpenCode reads `~/.claude/skills`). Conversations must not see
  them: to settle in step 2 (OpenCode's Claude compatibility switch, or not
  syncing the Claude config for OpenCode).
- Free models are weaker at 3D geometry than Claude; few see images, so
  the preview renders and attached sketches are lost on them. The UI says
  "experimental" next to OpenCode.

## Decisions

- **Agent setting** `state.aiAgent`: `claude` (default, and for every
  existing install) or `opencode`. The mode setting (sandbox / this
  computer / both) stays and applies to the active agent.
- **Allowed = active agent ∩ chosen modes ∩ ready modes.** A conversation
  of the other agent opens read-only with the reason and a link to
  Settings → AI, reusing the "mode no longer allowed" path.
- **Model** (OpenCode only): chosen in Settings → AI from the list the
  agent reports, a free model by default; kept as `state.aiModel`, applied
  to each new session (`session/set_config_option`). Claude keeps its
  account's default.
- **Sign-in** (OpenCode): free models need none; for a provider,
  `opencode auth login` in the existing sign-in terminal, in the sandbox or
  locally. Its credentials stay in OpenCode's own store (the sandbox's
  persistent home); we never handle API keys.
- **One view format**: the events the chat view understands today (what
  `for_view` produces) become the documented contract between Rust and
  `ia-chat.js`. Claude's events are slimmed into it as today; OpenCode's
  ACP events are translated into it. The view does not change.
- **Instructions** written once, saved under the names each agent reads:
  `CLAUDE.md` and `AGENTS.md`; the export skill stays in `.claude/skills/`
  and is also listed in `AGENTS.md` for OpenCode.
- **History**: our `chat.jsonl` log is the source for both agents;
  `from_transcript` stays as Claude's fallback only.
- Minimum OpenCode version: 1.18.33 (the one tested).

## Settings → AI

```
Agent             [ Claude Code ▾ ]   Claude Code · OpenCode (experimental)
Where             [ In a sandbox ▾ ]  sandbox · this computer · both · off
Model             [ Big Pickle (free) ▾ ]   OpenCode only, ↻ refresh
Components        checklist of the active agent and the chosen modes
Account           Claude account… | OpenCode: provider sign-in…
```

- Switching the agent re-runs the checks; open conversations of the other
  agent are stopped and become read-only.
- Texts that say "Claude" for the AI in general ("Where should Claude
  work?") say "the AI"; i18n keys updated in en and fr.

## What is checked, per agent

| Check | Claude Code | OpenCode |
|---|---|---|
| Agent present, version | `claude --version` ≥ 2.1.286 | sandbox: the binary in the image; local: `opencode --version` ≥ 1.18.33 |
| Account | `claude auth status` | none for a free model; `opencode auth list` for a provider model |
| yolobox, container engine | sandbox | sandbox |
| Python 3, trimesh, manifold3d, numpy | local | local |

## Steps

Each step ends with tests and a short review.

1. **View contract** — document the view events; move Claude specifics
   (command line, message encoding, interrupt, permission answers, event
   slimming, auth failure) behind an `Agent` trait in a new
   `src-tauri/src/agent/` (`claude.rs` from `chat.rs`). Claude only:
   behavior unchanged, existing chat tests pass as they are.
2. **Sandbox image** — Dockerfile fragment: fix OpenCode's shim (root
   `node postinstall.mjs`), checked with `yolobox run opencode --version`.
   Settle the host-skills question.
3. **ACP client** — `agent/opencode.rs`: initialize, `session/new` or
   `session/load`, prompt (text + images when the model takes them),
   `session/cancel`, `session/request_permission` ↔ permission cards,
   modes `build` / `plan`, model option; ACP updates → view events
   (message chunks, thoughts, tool calls with their updates, usage,
   result). `Conversation` gains `agent` (default `claude`) and
   `agent_session` (OpenCode's id). Tests against a fake ACP agent (a
   script replaying recorded lines); opt-in `OPENCODE_REAL=1` test in the
   sandbox with the free model.
4. **Checks** — `setup.rs` per agent (table above); `ai_check` reports the
   active agent's items; the model list read once and cached, refreshed on
   demand.
5. **Settings and welcome** — agent and model selects, OpenCode sign-in
   terminal (reusing the Claude one), "experimental" tag; the welcome AI
   step asks for the agent first. `aiAllowed()` includes the agent;
   read-only conversations of the other agent; i18n en/fr.
6. **Terminal view** — `pty.rs`: `yolobox opencode` / `opencode` for
   OpenCode conversations.
7. **Docs and review** — README (AI section: both agents, free models),
   DEVELOPMENT (agents), this plan updated; harness screenshots of
   Settings → AI in both languages; a real modification and a creation
   with a free model on the Mac, in the sandbox and locally.

## Out of scope for now

- Claude through ACP (`claude-agent-acp`, shipped by yolobox), which would
  leave a single protocol: worth it only once ACP covers what the Claude
  pipe gives today (partial messages, permission modes).
- Other agents yolobox ships (Codex, Gemini CLI, Copilot…): with the
  `Agent` trait and the ACP client, each one that speaks ACP is mostly a
  command line and its checks.
- Entering API keys in Snap Studio.
