## What it changes

<!-- What the pull request does and why. Link the issue: "Fixes #123". -->

## How it was checked

<!-- Tests run, what was tried in the app (system, printer if relevant). -->

## Checklist

- [ ] One subject per pull request
- [ ] `cd src-tauri && cargo fmt --check && cargo test --lib` and `scripts/test-*.js` pass
- [ ] Interface texts in `ui/i18n/en.json` and `fr.json`; `python3 scripts/check-i18n.py` is clean
- [ ] Code, comments and commits in English, in the style of the surrounding code
- [ ] Screenshots for a visible change (printer screens: against the simulator's `farm` scenario)
- [ ] Simulator updated if the printer API used changes (`src-tauri/src/sim/`)
- [ ] A line under *Unreleased* in `CHANGELOG.md` for a user-visible change
