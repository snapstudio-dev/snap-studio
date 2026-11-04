# AI: Claude Code's built-in sandbox as the default sandbox

## Goal

Today the AI's "Sandbox" mode is yolobox plus a container engine (Docker,
OrbStack, Podman or Apple `container`) and an image built at the first
conversation. It is the heaviest part of the AI setup, and it is not offered
on Windows at all (`setup::check_sandbox` reports `runtime: unsupported`).

Claude Code now ships a sandbox of its own
([docs](https://code.claude.com/docs/en/sandboxing)): the operating system
confines the shell commands Claude runs (Seatbelt on macOS, bubblewrap and
socat on Linux and WSL2; nothing on native Windows). With it, the sandbox
mode needs only what "This computer" already needs: Claude Code and Python
with `trimesh`, `manifold3d` and `numpy`.

1. A new **built-in sandbox** backend: Claude runs on the host, started by
   Snap Studio with sandbox settings that confine it to the conversation's
   folder, read the home directory nowhere, and reach no network from its
   commands.
2. It becomes **the default sandbox on macOS and Linux**. yolobox stays
   available as an option for anyone ("Container (yolobox)").
3. **Nothing changes for people already using yolobox**, on any system: their
   saved choice and their conversations keep running in the container.

## Findings (Claude Code docs, checked 2026-10-26)

- The sandbox covers **shell commands only** (Bash, and the processes they
  start). Claude's file tools (Read, Edit, Write, Grep, Glob) follow
  permission rules; WebFetch and WebSearch too.
- Per-session settings: `claude --settings '<json>'` (a file path works as
  well). `--settings` ranks above user and project settings; a
  `sandbox.allowUnsandboxedCommands: false` given there makes the sandbox
  *admin-required*: a repository's `.claude/settings*.json` can no longer
  loosen it (no `excludedCommands`, `allowWrite`, `allowedDomains` from the
  workspace).
- Defaults while enabled: writes in the working directory and a per-user
  temp directory (`$TMPDIR` is pointed there); **reads almost everywhere**,
  `~/.ssh` and `~/.aws` included; no direct network, a local proxy that
  admits only `network.allowedDomains` (empty by default) and otherwise
  prompts.
- `permissions.blockReadsOutsideWorkingDirectories: true` (Claude Code
  ≥ 2.1.257): the file tools refuse reads outside the working directories in
  every mode, and sandboxed commands lose read access to the home directory
  and `/Users`, `/home`, `/root`, `/Volumes`, `/mnt`, `/media`, `/run/media`,
  `/srv`. Re-opened: the working directory, the session temp directory, the
  parts of `~/.claude` commands need, `~/.gitconfig`. `allowRead` entries from
  `--settings` still count (from a repository's settings they do not).
- `sandbox.failIfUnavailable: true`: Claude Code **exits at startup** when
  the sandbox cannot start (missing bubblewrap, unsupported platform).
  Without it, Claude Code silently runs commands *unsandboxed*. Required.
- `sandbox.allowUnsandboxedCommands: false`: the `dangerouslyDisableSandbox`
  retry is ignored; with no `excludedCommands`, every command Claude runs is
  sandboxed.
- `sandbox.network.strictAllowlist: true` (≥ 2.1.219): hosts outside the
  allowlist are refused instead of prompting.
- `sandbox.autoAllowBashIfSandboxed` (default `true`): sandboxed commands run
  without a prompt. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` would turn
  auto-allow off: **do not set it** here.
- Linux: `bubblewrap` and `socat` required; Ubuntu ≥ 24.04 restricts
  unprivileged user namespaces through AppArmor
  (`kernel.apparmor_restrict_unprivileged_userns = 1`) and bwrap then needs
  an AppArmor profile; the seccomp filter (`@anthropic-ai/sandbox-runtime`)
  is optional. Inside a container bwrap needs `enableWeakerNestedSandbox`:
  not for us.
- Every version above is older than our `setup::MIN_CLAUDE` (2.1.286), so the
  minimum does not move. To confirm on a real run (step 1).

## Decisions

### Names

- A conversation's `engine` (`ia::Conversation.engine`) gains a third value:
  `"sandbox"` = built-in sandbox. `"container"` keeps meaning yolobox and
  `"local"` this computer. **Existing conversations are not rewritten**: a
  `"container"` conversation keeps running through yolobox.
- The setup report gets a third mode: `Ready { container, local, sandbox }`,
  items with `modes` containing `"sandbox"`.
- `state.aiModes` keeps its values (`"container"` = the *Sandbox* side,
  `"local"`, `"both"`, `"off"`); a new saved setting, **`state.aiSandbox`**
  (`"builtin"` | `"yolobox"`), says which backend the Sandbox side uses.
  `aiWanted()` maps the Sandbox side to `"sandbox"` or `"container"`
  through it. Nothing already saved changes meaning.

### Migration (the user's requirement)

`aiSandbox` is decided once, then saved; a saved value always wins.
`aiSandboxDefault({ saved, aiModes, containerConversations, os })`, a pure
function in `ui/ai-setup.js`:

1. `saved` set → `saved`.
2. `aiModes` is `"container"` or `"both"` (a sandbox was chosen before this
   version) → `"yolobox"`.
3. At least one conversation with `engine: "container"` exists → `"yolobox"`.
4. `os === "windows"` → `"yolobox"` (the built-in sandbox does not exist
   there).
5. Otherwise → `"builtin"`.

It runs at startup once the conversation list is loaded (and before the
welcome step's AI questions), and the result is saved with `save()` (added
to the persisted keys in `ui/app.js`), so a later change of `aiModes` never
flips it. Readiness plays no part: an install with no saved choice and no
container conversation gets the built-in sandbox **even when yolobox and an
engine are ready** (it never used them for the AI). Someone who has yolobox therefore keeps yolobox, with the same
runtime detection, token and image as today; only a new install, or an
install that never chose a sandbox and never held a container
conversation, gets the built-in one.

A yolobox user is never switched silently. When `aiSandbox` is `"yolobox"`
on macOS or Linux and the built-in sandbox is ready, Settings → AI shows one
quiet line: "The built-in sandbox needs neither Docker nor yolobox — Use
it". Choosing it changes `aiSandbox` for **new** conversations only.

### Platforms

| | macOS | Linux | Windows |
|---|---|---|---|
| Default sandbox | built-in | built-in | yolobox (as today) |
| Built-in offered | ✓ | ✓ (bubblewrap, socat) | – (`unsupported`) |
| yolobox offered | ✓ | ✓ | as today (see the open question) |

### The built-in session

`chat::command_line` for `engine == "sandbox"`: Claude itself (no yolobox),
`CLI_ARGS`, `--session-id`/`--resume`, `--model`, then
`--settings <json>` and `--permission-mode acceptEdits`. The JSON comes from
a new pure function, `chat::sandbox_settings(ws: &Path, read: &[PathBuf]) ->
Value`, with absolute paths only (never `.` or `~`, whose meaning depends on
where settings live):

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "autoAllowBashIfSandboxed": true,
    "excludedCommands": [],
    "filesystem": { "allowRead": ["<Python paths under a blocked root, see below>"] },
    "network": { "allowedDomains": [], "strictAllowlist": true },
    "credentials": { "envVars": [
      { "name": "ANTHROPIC_API_KEY", "mode": "deny" },
      { "name": "ANTHROPIC_AUTH_TOKEN", "mode": "deny" }
    ] }
  },
  "permissions": {
    "blockReadsOutsideWorkingDirectories": true,
    "allow": ["Bash", "Edit(/<ws>/**)", "Read(/<ws>/**)"],
    "deny": ["Bash(dangerouslyDisableSandbox:true)"]
  }
}
```

(`<ws>` is the workspace's absolute path, so the rules read
`Edit(//Users/me/.config/…/workspace/**)`: in permission rules `//` starts
an absolute path and `/` a project-relative one. The implementer checks the
exact form on a real run.)

- **Shell commands**: sandboxed, auto-allowed, no network, writes only in
  the workspace and the sandbox temp directory, no read of the home.
  `Bash` in `allow` is safe only because no command can leave the sandbox
  (`allowUnsandboxedCommands: false`, no `excludedCommands`); a test keeps
  those three together.
- **File tools**: `blockReadsOutsideWorkingDirectories` refuses reads
  outside the workspace in every mode. Edits inside are accepted
  (`acceptEdits`). An edit **outside** the workspace would come as a
  `can_use_tool` request: in a `"sandbox"` conversation Snap Studio answers
  it **deny** at once, without a card (`chat::sandbox_answer(request, ws)
  -> Option<Value>`, called before the request reaches the view; paths
  canonicalized, `..` and symlinks resolved).
- **Questions and plans** (`AskUserQuestion`, `ExitPlanMode`) still come as
  cards, as in local mode.
- **WebFetch / WebSearch**: **asked each time**. No rule allows them, so
  each call comes as a permission card in the chat, as in local mode (the
  Claude process makes the request, outside the sandbox). `sandbox_answer`
  leaves them alone, and the card offers no "always" choice for these two
  tools in a `"sandbox"` conversation (no `updatedPermissions`).
- **Python paths**: the read block hides the home, so a Python or modules
  installed there (`pip install --user` → `~/Library/Python/3.x` on macOS,
  `~/.local/lib/python3.x` on Linux; pyenv, conda, a venv) would not import
  inside the sandbox. `setup::check_python`'s script also prints
  `sys.prefix`, `sys.base_prefix`, `site.getusersitepackages()` and the
  existing `sys.path` entries; those under a blocked root become
  `allowRead` entries (read only, never `allowWrite`). Homebrew
  (`/opt/homebrew`, `/usr/local`) and system Pythons need none.
- **Sign-in**: `auth::sandbox_env("sandbox")` is empty: the built-in
  sandbox uses this computer's sign-in, like local mode. No
  `CLAUDE_CODE_OAUTH_TOKEN`, no sandbox token.
- **Reduced environment**: Claude is started with a cleared environment
  (`env_clear()` in `chat::spawn` for `"sandbox"`) plus an allowlist, built
  by a pure `chat::sandbox_env_allowlist(vars) -> Vec<(String, String)>`.
  Sandboxed commands inherit Claude's environment, so this is what keeps a
  stray token (`GITHUB_TOKEN`, cloud keys…) away from them.
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is not an option: it turns auto-allow
  off. Kept, when set:
  - System: `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LC_*`,
    `TZ`; `PATH` is always set to `pty::child_path()`.
  - Claude Code's own settings: `CLAUDE_CONFIG_DIR` (the only `CLAUDE*`
    kept, as in `pty::inherited_markers`), `XDG_CONFIG_HOME`,
    `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_RUNTIME_DIR` (Linux).
  - Network to Anthropic: `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`,
    `ALL_PROXY` (and lower case), `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
    `SSL_CERT_DIR`.
  - API sign-in, for those who use it instead of a subscription:
    `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`.
    Claude needs them for its own calls, but its commands must not see
    them: each one is also listed in `sandbox.credentials.envVars` with
    `"mode": "deny"` in `sandbox_settings`, so it is unset before every
    sandboxed command. Bedrock and Vertex variables are not kept (not
    supported by the setup checks either).
  Everything else (`PYTHONPATH`, `VIRTUAL_ENV`, `DISPLAY`, tokens…) is
  dropped. Python is found through `PATH`, and its paths are re-opened as
  above.
- **Resume**: sessions live in `~/.claude/projects` as for local mode;
  `ia::has_session` unchanged.
- **Stop / close**: no container to stop; `chat::close` behaves as for local.

### Setup checks (`setup.rs`)

| Check | Built-in sandbox | Container (yolobox) | This computer |
|---|---|---|---|
| Claude Code ≥ 2.1.286, signed in | ✓ | ✓ | ✓ |
| Python 3 + `trimesh`, `manifold3d`, `numpy` | ✓ | – | ✓ |
| macOS: Seatbelt (`/usr/bin/sandbox-exec` present) | ✓ | – | – |
| Linux: `bwrap`, `socat` installed (`which`, nothing run) | ✓ | – | – |
| Windows | `unsupported` | as today | ✓ |
| yolobox, container engine, image | – | ✓ | – |

New item keys: `seatbelt`, `bwrap`, `socat`; the Python
and module items serve `["local", "sandbox"]`; `account` serves all three
modes (`check_accounts`: the sandbox token only ever helps `"container"`).
`readiness` computes `sandbox` like the others. yolobox and engine checks run
only when they matter (`aiSandbox == "yolobox"`, a container conversation
exists, or Settings → AI shows the yolobox option) so a built-in user does
not pay 8 s of `docker info` timeouts: `check()` gets a `CheckScope` argument
(command `ai_check { scope }`).

Install help (`ui/ai-setup.js`, en/fr): bubblewrap and socat per
distribution (`sudo apt-get install bubblewrap socat`,
`sudo dnf install bubblewrap socat`, `sudo pacman -S bubblewrap socat`);
Python and modules as for local mode. The checks only see whether bubblewrap
and socat are installed, not whether bwrap can run (no functional test). So
the Linux hint also says: "On Ubuntu 24.04 or later, AppArmor may stop
bubblewrap: add its profile" / « Sous Ubuntu 24.04 ou plus récent, AppArmor
peut bloquer bubblewrap : ajoutez-lui un profil », with a link to the Claude
Code docs section (not a pasted `sudo tee` command). If bwrap cannot run
anyway, Claude exits at startup (`failIfUnavailable`) and the chat shows
`err.sandbox_unavailable`, which points to Settings → AI and the same hint.

### UI and texts

- Welcome step and Settings → AI: the Sandbox choice says what it uses.
  Built-in: EN "In a sandbox — Claude Code's own sandbox: Claude only
  reaches the conversation's folder. Nothing else to install but Python." /
  FR « Dans un bac à sable — le bac à sable intégré à Claude Code : Claude
  n'accède qu'au dossier de la conversation. Rien d'autre à installer que
  Python. » A "Sandbox type" segmented control under it (Settings only):
  EN "Built-in" / "Container (yolobox)", FR « Intégré » / « Conteneur
  (yolobox) ».
- New-conversation sheet: still two choices (Sandbox, This computer); the
  Sandbox one creates a `"sandbox"` or `"container"` conversation according
  to `aiSandbox`.
- Conversation tag and list filter: `"sandbox"` and `"container"` both count
  as *Sandbox* (`ia-list.js` filter, `iaEngineName`); the details line says
  which: EN "sandbox" / "container", FR « bac à sable » / « conteneur ».
- An existing `"container"` conversation opened while yolobox is no longer
  ready keeps today's read-only lock with its reason.
- The Claude account window shows the sandbox token section only when
  yolobox is in use.
- Every new string in `ui/i18n/en.json` and `fr.json`;
  `python3 scripts/check-i18n.py` clean.

## Security

| | Container (yolobox) | Built-in sandbox |
|---|---|---|
| What is confined | The whole Claude process and everything it runs | Shell commands only; file tools by permission rules, enforced by Claude Code itself |
| Home directory | Never mounted: invisible | Readable by default: **`blockReadsOutsideWorkingDirectories` is required**; Python paths re-opened read-only |
| Writes | The mounted workspace (and `~/.claude` shared by `--claude-config`) | The workspace and a temp directory; `.claude/` settings, skills, hooks and `.git/hooks` stay write-denied |
| Network | The container's (open) | None for commands (strict, empty allowlist); Claude's own API calls outside; WebFetch / WebSearch asked each time |
| Credentials | Its own token (Keychain) or a copy of the login | The host login; Claude, and so its commands, start with a reduced environment (allowlist) |
| Failure mode | No container, no conversation | `failIfUnavailable`: Claude refuses to start, never runs unsandboxed |

Both protect against accidents and a misled model (a stray `rm`, a script
writing elsewhere), not against a deliberate kernel or sandbox escape.
`SECURITY.md` → Scope: "the AI sandbox" covers both backends, with
"Claude Code's sandbox (Seatbelt, bubblewrap)" next to yolobox in the
upstream list.

## Steps

Each step ends with tests and a short review.

1. **Spike on a real machine** (macOS, then Linux): a session started with
   `sandbox_settings` in stream-json mode. Confirm: `touch ~/probe` fails;
   `cat ~/.ssh/known_hosts` fails; `curl https://example.com` fails without
   a prompt; `python3 tools/export.py …` works with Homebrew's Python and
   with a `pip --user` install (allowRead); an Edit outside the workspace
   arrives as `can_use_tool`; `AskUserQuestion` still arrives; bwrap removed
   → Claude exits at startup with a readable error; with the reduced
   environment the Keychain / `~/.claude` sign-in still works and `env` in
   a command shows only the allowlist; a WebFetch arrives as a card. Record the exact
   permission-rule path syntax and the exit message (fixture).
2. **Rust**: `engine == "sandbox"` in `chat::command_line`,
   `chat::sandbox_settings`, `chat::sandbox_answer`, `auth::sandbox_env` /
   `auth::argv` / `auth::status` for `"sandbox"` (same as local),
   `setup.rs` new items, `Ready.sandbox`, `CheckScope`, Python paths. A
   start failure caused by the sandbox (missing dependency) becomes a clear
   chat error pointing to Settings → AI (`err.sandbox_unavailable`).
3. **UI**: `aiSandbox` and `aiSandboxDefault` (migration), `aiWanted`,
   welcome step, Settings → AI (type control, checklist groups per backend,
   the "Use it" line), new-conversation sheet, tag and filter, account
   window. i18n en/fr.
4. **Docs**: README and README.fr AI section and requirements table,
   SECURITY.md, this plan's results, `docs/plans/README.md`, CHANGELOG.
5. **Self-review**: the implementer reviews its full diff against `main`,
   fixes what it finds, and reports the review (what was found, what was
   fixed, what was left and why).

## Tests

- `chat.rs`:
  - `sandbox_command_line`: Claude first (no yolobox), `--settings` present
    and valid JSON, `--permission-mode acceptEdits`, no
    `--dangerously-skip-permissions`, no `--claude-config`.
  - `sandbox_settings_are_strict`: `enabled`, `failIfUnavailable`,
    `credentials.envVars` denying `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
    `allowUnsandboxedCommands: false`, empty `excludedCommands`,
    `strictAllowlist`, empty `allowedDomains`,
    `blockReadsOutsideWorkingDirectories`; no `~` or relative path anywhere;
    `Bash` allowed only together with the first three; extra read paths
    land in `allowRead` and never in `allowWrite`.
  - `sandbox_answer`: Edit/Write inside the workspace → none (normal flow);
    outside, via `..`, via a symlink → deny; other tools → none.
  - `sandbox_env_is_reduced`: from a sample environment holding `PATH`,
    `HOME`, `LANG`, `LC_ALL`, `HTTPS_PROXY`, `CLAUDE_CONFIG_DIR`,
    `CLAUDECODE`, `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`,
    `ANTHROPIC_API_KEY`, `PYTHONPATH`: only the allowlisted ones come out,
    `PATH` is `child_path()`; every kept `ANTHROPIC_*` variable is denied to
    commands in `sandbox_settings`.
  - `web_tools_ask_each_time`: a WebFetch / WebSearch request in a
    `"sandbox"` conversation is not auto-answered and its card has no
    "always".
  - `container_command_line` and `local_command_line` unchanged.
- `auth.rs`: `sandbox_env("sandbox")` empty; `argv("sandbox", …)` is Claude
  itself.
- `setup.rs`: `readiness` with the new mode (bwrap or socat missing → sandbox not
  ready, local still ready); Python output with paths parsed; home-path
  filter (only paths under a blocked root become `allowRead`); Windows →
  `sandbox` unsupported.
- `scripts/test-ai-sandbox.js` (new, node, like the other `scripts/test-*.js`):
  `aiSandboxDefault` for every migration case (saved wins; `container` and
  `both` → yolobox; a container conversation → yolobox; Windows → yolobox;
  fresh macOS/Linux → builtin, also with yolobox ready; `off`/`local` with
  no container conversation → builtin); `aiWanted` mapping; the filter counts both sandbox engines.
- Opt-in real test (`#[ignore]`, `IA_REAL=1`): `real_builtin_multicolor`, the
  `real_container_multicolor` scenario through the built-in sandbox, plus
  the escape probes of step 1.

## Docs to update

- README.md "Design with AI": sandbox = Claude Code's own sandbox by
  default; table columns **Sandbox (built-in)** · **Container (yolobox)** ·
  **This computer**, with rows: Claude Code 2.1.286+, signed in (✓ ✓ ✓);
  Python 3 with `trimesh`, `manifold3d`, `numpy` (✓ – ✓); Linux: bubblewrap
  and socat (✓ – –); yolobox (– ✓ –); a running container engine (– ✓ –);
  plus "Built-in sandbox: macOS and Linux; on Windows, use This computer".
- README.fr.md: same, columns **Bac à sable (intégré)** · **Conteneur
  (yolobox)** · **Cet ordinateur**; « Linux : bubblewrap et socat ».
- SECURITY.md: Scope as above.
- `docs/plans/ai-setup.md`: link to this plan from its checks table.
- CHANGELOG: the line under *Unreleased* (added with this plan).

## Open questions

1. **yolobox on Windows**: `check_sandbox` reports the container mode
   `unsupported` on Windows and the welcome step hides it
   (`wAiNoSandbox`), so no Windows install can be using yolobox today. The
   migration still maps Windows to yolobox (nothing changes there); offering
   yolobox on native Windows would be a separate change.
