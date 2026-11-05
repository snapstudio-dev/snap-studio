# Snappy — in-app workshop assistant

Status: UX and technical approach decided (2026-11-05). Implemented in draft PR #95 (see [Implementation notes](#implementation-notes)).

## What it is

Snappy is a single, persistent workshop assistant inside Snap Studio: one shared conversation with durable memory. It uses the LLM already configured in the app, and will later drive MCP-style actions over app features (local files, printer files, slice settings, etc.).

It is distinct from the existing object-specific AI chats in Create (`data-view="ia"`).

## Placement

- A small, nameless icon at the bottom-right of the left sidebar: it sits on the main content, just to the right of the sidebar, at the bottom.
- The icon appears when the user hovers the content.
- No dark plate or circular chrome behind it: only the white rounded-square avatar with its rainbow outline, transparent around it ([asset](snappy/snappy-squircle-clear.png)).
- No name ("Snappy" or other) is written next to the icon.
- Click: the icon fades out and disappears, and a conversation drawer opens over the current view (e.g. Prepare), so the user stays on that page.
- Closing the drawer brings the icon back (when the content is hovered).

| Idle (content hovered) | Drawer open |
| --- | --- |
| ![Icon on hover](snappy/mockup-float-hover.png) | ![Drawer open](snappy/mockup-float-open.png) |

## Avatar

Rounded square with a pronounced corner radius, white fill, two tilted oval eyes, and a linear rainbow outline using the What's new colors (`#FFCC00`, `#FF3B30`, `#AF52DE`, `#0A84FF`, `#30D158`). No toolhead strokes.

![Avatar](snappy/snappy-squircle-clear.png)

## Copy

French UI copy uses formal « vous » (not « tu »).

## Privacy and safety

- Never send printer serials, filesystem paths, IPs, hostnames, or similar identifiers to the LLM.
- Irreversible actions require user confirmation.

## Shared Claude launch engine (Create and Snappy)

One engine serves every AI surface: Create's object conversations and Snappy. It follows the same idea as workspaces-manager's `claude_pty::run_claude_via_pty`.

### Never `claude -p`

Snap Studio stops using `claude -p`, for Create as well as for Snappy:

1. It bills against API credits instead of the subscription.
2. It skips the folder trust prompt.
3. It silently ignores an invalid settings file.
4. Launched from a piloted session, it inherits neither that session's permissions, nor its hooks, nor its branch safeguards.

Create today launches `claude -p --input-format stream-json …` from `src-tauri/src/chat.rs`. That launch loop is replaced by the shared engine; `-p` is not kept alongside. Create's workshop around the object stays as it is: workspaces, `CLAUDE.md`, the 3MF tools in `src-tauri/src/ia_tools/`, `chat.jsonl`, the sandbox `--settings`, yolobox, and the conversation UI in `ui/ia-chat.js`.

### Principle

Claude's stdout is never read. Claude runs in its normal interactive mode inside a PTY. Two hooks drop sentinel files, and the reply is read from Claude's JSONL transcript, polled in a loop.

Transcript blocks (`text`, `thinking`, `tool_use`, `tool_result`) are re-emitted as stream-json lines, so the existing chat view keeps its format. A shared `seq` counter keeps chronological order. Token usage also comes from the transcript.

The `-p` / stdout loop of `chat.rs` is not reused. From `pty.rs` (today only used for `claude auth login`, streaming the screen to the UI) we keep the `portable_pty` primitives: open, write, close. The conversation's source of truth is the files, not the terminal screen.

### Launch

- Interactive `claude` in a PTY, with the prompt as a positional `execve` argument, submitted automatically.
- Flags: `--permission-mode`, then as needed `--resume` or `--session-id`, `--model`, `--append-system-prompt`.
- The prompt is capped at 128 KiB (Linux limit on one `execve` argument). Over `MAX_PROMPT_ARG_BYTES`, the app refuses before launching.
- PID: a wrapper `echo $$ > /tmp/claude-turn-<run>.pid ; exec claude …` records it. That pid is also the process group, so a single `kill -TERM -<pid>` stops Claude, its agents and its background shells.
- A new turn imposes its id (`--session-id`), so its transcript `<id>.jsonl` can be named before the SessionStart hook answers. The app never picks "the most recent transcript": doing so mixed neighbouring conversations.
- Engines are the app's existing ones:
  - local: the host binary;
  - built-in sandbox: host Claude with the existing sandbox `--settings`, the hooks merged into those settings (not replacing them);
  - container: yolobox.

### Hooks

Set through `--settings`:

| Hook | File written | What it gives |
| --- | --- | --- |
| SessionStart | start sentinel | official `session_id` and exact `transcript_path` |
| Stop | `/tmp/claude-done-<run>.json` | "the message is complete", with `last_assistant_message` |

### Reading the transcript

- Cadence: every 400 ms during a turn, every 1.5 s while the CLI stays open at rest.
- Local and built-in sandbox: the files are read directly on the host.
- Container: one `docker exec` per pass brings back the three contents (start sentinel, transcript, Stop sentinel), separated by markers `---SS-{START,TRANSCRIPT,SENTINEL}-<run>-<nonce>---`, with a random nonce per turn. A marker only counts when it starts a line. Agent-written content is always inside JSON, which never starts a line with `---SS-`, so an agent quoting the markers cannot split the read.
- workspaces-manager runs `docker exec` in a long-lived workspace container. yolobox may not be that kind of container: container-mode collection follows however yolobox exposes the filesystem.
- Resume: with `--resume` the transcript holds the whole conversation. The app counts its lines before launching (`baseline_lines`) and only reads what comes after.
- Incremental read: if (path, size, mtime) has not changed, nothing is transferred. Otherwise reading resumes at the last byte offset, after checking the SHA-256 of the preceding 4 KiB. When in doubt, it rereads from the start point.

### End of turn

A turn is delivered once, and only with one of two proofs:

1. the Stop hook file, validated as real JSON from that hook;
2. failing that, the transcript's `turn_duration` record, when the sentinel is missing.

An agent team still running keeps the turn open; it then closes as a success.

### CLI kept open between messages

The CLI stays at its prompt from one reply to the next. The next message is typed into the PTY (`inject_prompt`) without relaunching Claude. Before writing, `inject_prompt` increments a pending counter and deletes the Stop sentinel, so the already-answered message cannot close the new turn.

### App close

First cut: no host "keeper" process and no `state/detached-turns/`. Closing the app stops the turn in flight; the next launch resumes the conversation with `--resume`. Keeping Claude alive across an app close (as workspaces-manager does) is deferred.

## Create: migration notes

- Unchanged: object workspace, `CLAUDE.md`, 3MF tools, `chat.jsonl`, sandbox settings, yolobox, conversation UI. Only the launch changes.
- The first user request stays the positional prompt; the workspace `CLAUDE.md` stays the object instructions.
- Permission cards: today they go through stdout (`--permission-prompt-tool stdio`), which is tied to `-p`. The switch needs an equivalent for the permission requests Claude still raises, above all Bash in "This computer" mode. In the built-in sandbox and in the container they are already auto-allowed or skipped (yolobox adds `--dangerously-skip-permissions`).
- Trust prompt: interactive mode asks to trust each new folder. Object folders (and Snappy's folder) are created by the app, so the app pre-trusts those, and only those — never the user's home.
- Images: today sent as base64 JSON content blocks on stdin. The interactive prompt is one text argument (128 KiB cap), so an attachment is written under `attachments/` and mentioned in the prompt.
- Terminal view: shows the same PTY instead of starting a second process. The screen is a view, not the source of truth for the conversation.

## Snappy: tools, approval, memory

Taken from workspaces-manager's bots, simplified to one assistant.

### Identity

Each turn carries Snappy's identity: role, instructions, approval rule, memory, and a sanitized snapshot of the app context (current view, selected printer by display name, Prepare / slice summary). The prompt says who Snappy is, never the list of what it can do: actions are described only by the tools.

`--append-system-prompt` applies at launch only. Since the CLI stays open, updated memory and context travel with each injected user message, and Snappy can re-read `MEMORY.md` through a tool. Otherwise only the first turn would be fresh.

### Local MCP server

- An MCP server inside the app process, authenticated by a token.
- The MCP config is written to a `0600` file, never passed on the command line (where `ps` would show it).
- Five methods: `initialize`, `tools/list`, `tools/call`, plus two service methods.
- Tools are known at compile time: a static Rust table (declaration + handler) replaces publishing tools from the UI. `rmcp` is optional.
- Tool contract: name, description, JSON schema of the parameters, approval required or not; execution in Rust.
- Long operations (slice, send to printer): the tool answers at once with a task id, which Snappy follows or cancels.
- Dynamic tool publishing can come later with the plugin system; it is not needed now.

### Approval

Approval is a server-side barrier, not Claude's permission prompt (which the container skips). A call to a tool marked "approval required" is suspended and a confirmation card appears at the bottom of the drawer. Anything that is not an explicit yes is a no: refuse clicked, drawer closed, or timeout (15 minutes at most). This is what guards starting a print or deleting a file. Each tool has a simple boolean, no autonomy levels.

### Security boundary

Snappy does not get Create's object-workspace file and Bash tools. Bash, Write and Edit are disabled or confined to Snappy's folder, without network. Snappy talks to the workshop only through MCP.

### Privacy filter

Everything sent to the model — tool results, injected context, memory — is filtered: no printer serials, filesystem paths, IPs or hostnames.

### Memory and storage

- Snappy's folder: `~/.config/snap-studio/snappy/` (alongside Create's `~/.config/snap-studio/ia/`), holding `chat.jsonl`, `MEMORY.md` and its instructions.
- `MEMORY.md` is a single file written by Snappy itself, capped at about 200 lines / 24 KB, and never holds serials, paths, IPs or hostnames.
- One conversation. `ia::Conversation` is not reused: it is object-centric (source 3MF, versions, `dest_dir`).
- Snappy is a thin wrapper around the shared PTY engine; it does not copy the JSON protocol.
- Snappy runs only while the app is open.

### First wave of tools

Intended first wave, to be refined:

- Reads, no approval: printers and their status (without IP or serial), local files and printer files by display name, slice summary, print queue.
- Actions, approval required: apply a slice setting, start or send a print, delete a file.

### Not included

Browser, rooms, delegation between bots, routines, per-conversation tokens, bots / threads / routines collections, `open-bot-avatar` (the avatar is chosen), git-style autonomy levels, a dedicated bots container.

## Implementation notes

Where the code settles what the plan left open:

- **Engine** (`src-tauri/src/claude_pty.rs`): hook files live in one folder per run, in the system's temporary folder for local and built-in sandbox runs (`snapstudio-claude-<run>/start.json`, `done.json`; pid in `claude-turn-<run>.pid`), and in the mounted workspace (`.snapstudio-run/`) for the container, whose `/tmp` is its own. An interrupt (Esc) fires no Stop hook: Claude's `[Request interrupted by user` record ends the turn as stopped (or a 4-second grace after Stop). An API error record ends it as failed.
- **One turn, one end**: each end proof is tied to its prompt — the transcript's `promptId`, the Stop hook's `prompt_id` — and taken once, so a late proof of the previous message cannot end the next one. A message starting with `/`, `!` or `#` gets a leading space, so the CLI sends it as text instead of running a command. A Claude being closed no longer counts as open; a new start waits for its end, in a hook folder of its own per run.
- **Container collection**: yolobox bind-mounts the workspace and `~/.claude/projects` at their host paths, so the transcript and the hook files are read directly on the host; the `docker exec` pass with `---SS-` markers is not needed and was not built.
- **Permission cards and questions**: a `PermissionRequest` hook (allow/deny, "always" as Claude's suggested rules) and a `PreToolUse` hook on `AskUserQuestion` (answered by its refusal's reason) hand the request to the app through request/answer files; unanswered after 15 minutes, refused. Checked against Claude Code 2.1.286.
- **Trust**: pre-trusting writes `hasTrustDialogAccepted` in Claude's `.claude.json` (an already trusted ancestor counts); if the prompt still shows (a container's own settings), the engine answers it, since every folder it launches in is the app's.
- **The sign-in check** (`auth_verify`) runs through the engine too: nothing in the app runs `claude -p` any more.
- **Snappy's Claude** is the host's, whatever the AI mode (it needs no sandbox: `--tools ""`, Bash/Write/Edit/Read/Web denied, `--strict-mcp-config`); hidden when the AI is off. Its first message waits for Claude's `tools/list`, since MCP servers connect after the CLI starts.
- **First wave of tools**: `printers`, `printer_files`, `local_files` (the Files view), `slice_summary`, `print_queue`, `memory_read`, `memory_write`, `task_status`, `task_cancel`, `apply_slice_setting` (infill, walls, supports, brim), `start_queued_print`, `print_printer_file`, `delete_printer_file`, `delete_local_file` (to the Trash; a file of the Files view, kept apart from printer files), `send_slice` (the slice made in Prepare, started now or queued: every choice — printer, now or queue, bed leveling, flow calibration, timelapse — is a required parameter Snappy must ask the user for; the app's send sheet then sends it as by hand, spool check and progress included). Starting prints answers with a task id.
- **Every tool call is confirmed** (owner's decision, 2026-11-05): reads included, each call waits for a yes on its card, with the same default-deny rule. The MCP annotations still tell reads from actions.
- **Snappy's model** is set in Settings › AI (the account's default, or one of the chat's models); a running Snappy closes so its next message resumes with it.
