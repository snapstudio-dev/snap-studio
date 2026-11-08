# AI setup: dependency checks, welcome step, Settings with a side menu

## Goal

The AI tab depends on tools the app does not ship. Today only the presence
of `claude`, `yolobox` and `docker` is checked; nothing checks Claude Code's
version, the sign-in, Podman / OrbStack / Apple `container`, nor Python and
its modules for the local mode (on the author's Mac `python3` has no
`trimesh`: a local conversation fails at its first export).

1. Ask the user how they want to use the AI, check only what that choice
   needs, and say how to install what is missing. **Nothing is installed by
   the app** (for now).
2. Same component in the welcome assistant (a new step) and in Settings.
3. Settings get a side menu; the content slides vertically, following the
   menu order.

## Decisions

- Three choices: **sandbox** (container), **this Mac** (local), **both**;
  plus "not now". "Both" checks everything.
- **The AI unlocks only when every check of a mode is green, and only that
  mode is offered.** Allowed modes = chosen modes ∩ ready modes. Choosing
  "both" with only the sandbox ready offers the sandbox alone.
- Minimum Claude Code version: **2.1.286** (the version tested with the
  chat view's protocol).
- Settings: menu on the left, content sliding **vertically**, in the menu's
  order (down when the category is lower), ~250 ms, off with "Reduce
  motion".

## What is checked, per mode

(The built-in sandbox, now the default Sandbox on macOS and Linux, adds its
own checks: see [ai-builtin-sandbox.md](ai-builtin-sandbox.md).)

| Check | Sandbox | This Mac | How (fast, bounded) |
|---|---|---|---|
| Claude Code present | ✓ | ✓ | `which claude` |
| Claude Code ≥ 2.1.286 | ✓ | ✓ | `claude --version` |
| Claude account signed in | ✓ | ✓ | `claude auth status --json` (≈1 s; says "signed out" reliably, cannot prove a token works — the account window's Check does) |
| yolobox | ✓ | – | `which yolobox` |
| Container engine installed **and running**: Docker (incl. OrbStack, which provides `docker`), Podman, Apple `container` | ✓ | – | `docker info` / `podman info` / `container system status`, 2.5 s each, in parallel |
| Sandbox image | info | – | not checked: "built at the first conversation, 1–3 min, network needed" |
| Python 3 | – | ✓ | `python3 --version` |
| `trimesh`, `manifold3d`, `numpy` | – | ✓ | `python3 -c "import …"`, one per module |

Sandbox account: green when the sandbox has its own token, or when the Mac
is signed in (yolobox copies its login).

The first container engine that runs is passed explicitly to yolobox
(`--runtime docker|podman|container`) in the chat, the terminal and the
account checks — today yolobox picks alone and the app only looks for
Docker.

Each missing item says how to install it (command to copy and/or link):
Claude Code (official install page), `claude auth login` (or the Claude
account window), yolobox (its GitHub page), Docker Desktop / OrbStack /
Podman (download pages; "start it" when installed but stopped), Python
(python.org or `brew install python`), modules
(`python3 -m pip install trimesh manifold3d numpy`). The exact commands are
checked during step 1 — Homebrew's Python refuses `pip install` outside a
virtual environment (PEP 668): the text must account for it.

## Steps

Each step ends with tests and a short review.

1. **Rust checks** — new `src-tauri/src/setup.rs`: `ai_check()` runs the
   checks in parallel threads with deadlines and returns, per item, its
   state (ok / missing / stopped / too old / signed out), the version found
   and the mode(s) it serves; runtime detection (`ready_runtime()`); version
   comparison. Command `ai_check`. Units: version parsing and comparison,
   `auth status` / `--version` outputs, runtime choice. Opt-in real run.
2. **Runtime passed to yolobox** — `--runtime` in `chat.rs`, `pty.rs`,
   `auth.rs` from `ready_runtime()`; `ia_engine` replaced by `ai_check`.
3. **Shared UI component** — `ui/ai-setup.js`: the two questions, the
   checklist (✓ ready, ! to fix, ✕ blocking, · info), install details with
   Copy buttons and links, "Check again"; the choice kept in the app state
   (`aiModes`: off / container / local / both); `aiAllowed()` gives the
   allowed modes. i18n (en/fr).
4. **Welcome step** — a sixth step "Design with AI" between the slicing
   engine and "All set!": questions, then the checklist; Continue, or
   "Continue without AI" while something is red; never blocking. The
   summary gets an AI line.
5. **Locking the AI** — from `aiAllowed()`: AI tab (empty state and "New
   Object" say what is missing, with a link to Settings → AI), Files "Edit
   with AI", the new-conversation sheet only offers allowed modes; an
   existing conversation in a mode no longer allowed opens read-only with
   the reason; checked again when the AI tab opens (Docker starts and stops
   without notice).
6. **Settings with a side menu** — categories: Application, 3D navigation,
   Files, AI, Slicing engine, Thumbnail cache. Menu on the left with icons
   and a dot on a category needing action (AI not ready); content in panes
   that slide vertically in the menu order; last category remembered; the
   AI category holds the mode choice, the checklist and the Claude account.
7. **Docs and review** — README (requirements per AI mode), plan updated;
   browser harness screenshots of the step and of Settings in both
   languages; check on the Mac.

## Done

- Steps 1–7 implemented. `setup.rs` checks everything in parallel (≈0.4 s
  on the author's Mac: sandbox ready with Docker, local mode missing the
  three modules); Homebrew's Python is recognized as externally managed and
  the install command gets `--user --break-system-packages` (checked with a
  dry run). The running engine is passed to yolobox (`--runtime`, accepted
  after `run`/`claude`, checked).
- UI checked in a browser harness fed with the real report (French and
  English): welcome step (questions, results ready / blocked, summary), AI
  tab banner, a read-only conversation, Settings panes and the slide's
  state after quick changes.
- Found on the way: the chat test with a fake Claude was flaky (an
  interrupt answered before the exit); it now waits for the exit itself.

## To check on the Mac

- The welcome step and Settings → AI in the app; the slide's feel.
- Docker stopped, then started and "Check again"; Podman / OrbStack if at
  hand.
- A conversation in a mode no longer allowed (read-only), then allowed again.

## Out of scope for now

- Installing anything from the app (a Snap Studio Python environment, a
  managed yolobox).
- Windows container mode (yolobox does not run there): the sandbox choice
  is not offered on Windows.
