# Contributing to Snap Studio

**English** · [Français](CONTRIBUTING.fr.md)

Thanks for your interest! Snap Studio grows from what its users report:
bugs, needs, printers that behave oddly. Every contribution helps, code or
not.

## Report a bug

From the app: **Settings → About → Report a Bug** (or **Help → Report a
Bug…**). The form opens on GitHub with the version and the system already
filled in. Otherwise: [new issue](https://github.com/kameka22/snap-studio/issues/new/choose).

Before that, have a look at the [open issues](https://github.com/kameka22/snap-studio/issues):
the problem may be known. A good report says:

- what you did, what happened, what you expected;
- the steps to reproduce it, if you can;
- the 3MF file when a model is involved (attach it, or a smaller one that
  shows the same problem);
- the printer and its firmware when printing is involved.

## Suggest an idea

**Settings → About → Suggest an Idea**, or [new issue](https://github.com/kameka22/snap-studio/issues/new?template=feature.yml).
Describe the need — what you are trying to do and what gets in the way —
rather than the solution: there is often a simpler one. For questions and
ideas to talk over, use the [Discussions](https://github.com/kameka22/snap-studio/discussions).

## Contribute code

1. **Build**: Rust (stable) and the Tauri CLI, then `cargo tauri dev`. The
   interface is plain HTML/CSS/JavaScript in `ui/`, without npm.
2. **Test**: `cd src-tauri && cargo test --lib`, and the interface logic with
   `for t in scripts/test-*.js; do node "$t"; done`. Some tests need the
   slicing engine or a real Claude Code and are opt-in (`--ignored`, see
   their comments).
3. **Write in English**: code, comments, commits and docs. Interface texts
   go in `ui/i18n/en.json` and `ui/i18n/fr.json` (never hard-coded);
   `python3 scripts/check-i18n.py` checks them.
4. **Follow the surrounding code**: its naming, its comment density, its
   idioms. The layout is described in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#layout).
5. **One subject per pull request**, with what it changes and how it was
   checked. For a larger change, open an issue or a discussion first; the
   work in progress lives in [`docs/plans/`](docs/plans/).
6. **Changelog**: a user-visible change adds a line under *Unreleased* in
   [CHANGELOG.md](CHANGELOG.md), with its pull request number.

## Translating Snap Studio

English is the reference; French, German, Spanish, Brazilian Portuguese,
Italian, Japanese, Simplified Chinese and Korean are translations. Each
language is one file, `ui/i18n/<lang>.json`, with the same keys as
`ui/i18n/en.json`; a missing key shows in English. Keep the
`{placeholders}`, the HTML tags and the plural forms (`one`, `other`…;
Japanese, Chinese and Korean have only `other`), and use the slicer
community's words (OrcaSlicer's own translations are a good guide). Before a pull request, run
`python3 scripts/check-i18n.py`: it checks every catalog and shows how
complete each one is. Review in [Weblate](https://weblate.org/) is planned;
until then, a pull request on the catalog is the way. Adding a language is
described in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#languages).

## Security

A security problem is reported privately, not in an issue: see
[SECURITY.md](SECURITY.md).

## Code of conduct

Everyone taking part — issues, discussions, pull requests — follows the
[code of conduct](CODE_OF_CONDUCT.md): be respectful, constructive and
welcoming.

## License

Snap Studio is free software under the [GNU GPL v3](LICENSE) or later. By
contributing, you agree that your contribution is distributed under the
same license.
