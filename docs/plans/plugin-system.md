# Plugin system

Plan only (draft PR). No plugin runtime is implemented, and no
architecture below is chosen yet: the options are laid out for the owner.

Asked on 2026-11-05, from the day's watch: OrcaSlicer and PrusaSlicer both
open their slicers to plugins; Snap Studio should too.

Sources:
- [OrcaSlicer releases](https://github.com/OrcaSlicer/OrcaSlicer/releases)
  (2.5.0-rc): Python plugins, a hub (Orca Cloud), "a plugin always asks
  your permission before it goes online, starts other programs or reaches
  outside OrcaSlicer's data folder"; plugins add one-click tools, change
  how layers and G-code come out, or add panels.
- [Filament Feed, 2026-11-04](https://filamentfeed.com/article/prusaslicer-3-0-alpha13-plugin-marketplace-print-goals-november-2026)
  on PrusaSlicer 3.0.0-alpha13: a Marketplace (empty at launch) where
  bundles are **cryptographically signed and verified before loading**,
  publishing needs an account and a basic review; the API is experimental
  (two interfaces); Prusa's own **Print Goals** (vase mode, soluble or
  breakaway supports) are Lua plugins that apply setting overrides only
  while the goal is active.

## Today in Snap Studio

- Tauri 2 app: Rust back end (`src-tauri/src/`), web UI in `ui/` (plain
  scripts, no bundler). The web view's CSP is strict
  (`script-src 'self'`, `src-tauri/tauri.conf.json`); the capability file
  grants only core window, dialog and opener permissions
  (`src-tauri/capabilities/default.json`).
- No plugin or extension mechanism. The closest things:
  - the **AI** (Claude Code) runs in a sandbox with Python tools the app
    writes (`src-tauri/src/ia_tools/`, `trimesh`), in the conversation's
    folder only;
  - **slice settings** are overrides sent to the engine (Basic / Advanced
    levels, Speed) — the same shape as Prusa's Print Goals;
  - signed downloads already exist: app updates (Tauri updater signature)
    and the engine archive (SHA-256 pinned in `src-tauri/engine.json`).
- Python is not bundled with the app (only available inside the AI
  sandbox when the user set it up).

## What plugins could extend (extension points)

Ordered from the safest to the most powerful; a first version would pick
one or two.

1. **Print recipes / goals**: a named set of slice setting overrides with
   conditions ("vase", "miniature", "functional part"), shown in the slice
   sheet. Pure data, applied only while chosen (Prusa's model).
2. **G-code post-processing**: a step after the engine, reading and
   rewriting the G-code (timelapse moves, custom start code, comments).
3. **Prepare tools**: one-click actions on the plate's meshes (add a
   label, split, hollow…), returning new meshes.
4. **Panels**: a plugin's own view in the sidebar (calculators, a
   filament database, a printer farm view).
5. **Printer actions**: macros in Control, using the actions Snap Studio
   already validates (`src-tauri/src/control.rs`).

## Runtime options (to choose)

| Option | Fits | Isolation | Cost |
|---|---|---|---|
| A. **Data only** (JSON recipes, no code) | point 1 | nothing runs | small |
| B. **JavaScript in a sandboxed iframe / worker**, talking to the app through a message API | 3, 4 (UI) | web sandbox, separate origin, no Tauri IPC | medium |
| C. **WebAssembly** run by the Rust side (e.g. wasmtime), host functions per permission | 2, 3 | strong, capability based | medium to large |
| D. **Python** (as Orca) | 2, 3 | none by itself; needs an OS sandbox | bundling a Python runtime on 3 systems |
| E. **External programs** (a command or an MCP server) | anything | none: native code | small to build, hard to make safe |

Notes:
- A covers Prusa's Print Goals and is a good first step whatever comes
  next.
- B and C can share one **action API** (read the plate, apply overrides,
  replace a mesh, read printer status) described once, versioned
  (`api: 1`), with each call behind a permission.
- D and E would run code with the user's rights; if chosen, they need the
  system sandboxes the AI already uses (`docs/plans/ai-builtin-sandbox.md`),
  which do not cover every system the app runs on.

## Trust, signing and supply chain (required whatever the runtime)

- **Signed bundles**: a plugin is one archive with a manifest
  (`id`, `version`, `api`, `permissions`, `entry`, author key). Snap Studio
  verifies the signature (Ed25519 / minisign, as the updater) **before
  reading anything else** from it, and refuses unsigned or altered
  bundles. Optional "developer mode" to load a local unsigned folder,
  clearly marked, off by default.
- **Where plugins come from**: an index (a signed JSON file, for example
  on GitHub Pages next to the site) listing plugins, versions, hashes and
  publisher keys. Open questions below on who reviews and who signs.
- **Revocation**: the index carries a block list; a revoked plugin is
  disabled at next start with a notice.
- **No silent code execution**: installing does not run anything. A plugin
  runs only after the user has seen its permissions and enabled it;
  updates that ask for new permissions ask again; nothing auto-installs.
- **Permissions** (shown in plain words at install): read the plate,
  change slice settings, rewrite G-code, read printer status, send printer
  actions, network (with the hosts), files (a folder the user picks). No
  permission gives printer addresses, serials, account data, AI prompts
  or the user's paths by default.
- **Archive safety**: bundles are unpacked with the same rules as
  `docs/plans/3mf-load-hardening.md` (no path outside the plugin folder,
  size and entry limits).
- **Safe mode**: start with every plugin off (a menu item and a startup
  flag), so a broken plugin never locks the user out.
- **Analytics**: plugins never send through Snap Studio's Aptabase
  (`docs/plans/usage-analytics.md`); their own network use is a
  permission.

## Install UX (draft)

- **Settings › Plugins**: installed plugins (on/off, version, permissions,
  remove), "Browse" (the index), "Install from file" (signed bundle).
- Install sheet: name, author, what it adds, the permission list, source
  link, **Install** / **Cancel**. French copy uses « vous », e.g.
  « Ce module pourra modifier vos réglages de découpe. Vous pourrez le
  désactiver à tout moment dans Réglages › Modules. »

## Decisions / open questions for the owner

1. First version: A only (data recipes), or A + one code runtime (B or C)?
2. Runtime for code: JavaScript sandbox, WebAssembly, Python (as Orca), or
   none for now?
3. Who signs: only the project's key (curated list), or publishers' own
   keys listed in a project-signed index?
4. Where the index lives (GitHub repo / Pages) and who reviews plugins.
5. Is a developer mode for unsigned local plugins acceptable?
6. Name in the UI: "Plugins" / « Modules » or « Extensions »?
7. Should the in-app assistant idea (one action API for "do it for me")
   share the plugins' action API? Raised in chat on 2026-11-05, not
   decided.

## Out of scope

- Any runtime, API, loader, index or UI code (this PR is the plan).
- A hosted marketplace with accounts and payments.
- Plugins inside the slicing engine itself (Snapmaker Orca's own code).

## Files likely touched (at implementation, depending on the choice)

- New `src-tauri/src/plugins.rs` (manifest, signature, install, enable),
  `ui/plugins.js` and a Settings section, `ui/i18n/*.json`.
- `ui/slice.js` / `ui/slice-adv.js` for recipes; `src-tauri/src/slice.rs`
  for a post-processing step.
- `src-tauri/capabilities/` and the CSP only if a sandboxed plugin origin
  is added.
- `docs/` page for plugin authors; `SECURITY.md` scope.

## Testing

- Signature: valid, altered byte, wrong key, revoked, unsigned → only the
  first loads.
- Install never runs plugin code; enabling asks for the permissions;
  an update with a new permission asks again.
- Permissions enforced: a call without its permission is refused and
  logged.
- Safe mode starts with all plugins off.
- Archive rules shared with the 3MF hardening tests.

## Docs and CHANGELOG

- No CHANGELOG line in this PR (spec only). At implementation, under
  *Unreleased › Added*, for example: "**Plugins**: add print recipes (and
  tools) from signed plugins, with the permissions shown before you enable
  them (Settings › Plugins)."
- README, `docs/privacy.md` (what plugins can and cannot reach),
  `SECURITY.md` (plugins in scope) and an authors' guide at
  implementation.
