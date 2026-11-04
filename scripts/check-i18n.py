#!/usr/bin/env python3
"""Checks the translation catalogs against the code.

    python3 scripts/check-i18n.py

Reports, and exits non-zero on:
- keys used in the code (tr("…"), data-i18n…="…", t!("…")) but missing from
  ui/i18n/en.json;
- keys of en.json missing from fr.json (kept complete by hand), keys of
  another catalog unknown to en.json;
- placeholders ({name}), HTML tags or plural forms that differ from English
  (Japanese, Chinese and Korean have one form only, `other`);
- keys no code uses (keys built at run time are listed in DYNAMIC);
- French left in the UI code outside the catalogs.

The other languages may lag behind English (the missing keys show in
English): their completeness is printed with the missing keys as warnings,
and `--strict` makes a missing key an error for them too.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UI = ROOT / "ui"
SRC = ROOT / "src-tauri" / "src"

# Keys assembled at run time: any key starting with one of these is used.
DYNAMIC = (
    "ais.item.", "ais.mode.", "welcome.ai.chosen.", "color.", "engine.phase.", "feature.", "files.sort.", "pd.kind.", "printers.state.",
    "prints.state.", "prints.filter.", "prints.day.", "prints.tl.", "prints.reason.", "settings.history.short.", "slice.pstate.", "slice.stage.", "style.", "maint.t.", "maint.nozzle.", "maint.in.", "maint.late.", "bm.st.", "bm.done.", "bm.f.", "bm.level.", "bm.phase.", "bm.set.level_", "bm.side.", "ctl.st.", "ctl.lock.", "ctl.why.", "ctl.doing.", "ctl.confirm.", "ctl.help.",
    "snap.site.", "explore.desc.", "slice.vp.", "prepare.tower.why.", "slice.tower.place.", "window.",
)

# French that may legitimately stay in the code (names, data matching).
FRENCH_OK = re.compile(r"Français|générique")
FRENCH = re.compile(r"[éèêàçùôîâûÉÈÀÇ«»]")


def strip_comments(text):
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"(?m)^\s*//.*$", "", text)


def used_keys():
    keys = set()
    for f in UI.glob("*.js"):
        keys |= set(re.findall(r'\btr\(\s*"([\w.]+)"', f.read_text()))
        # Keys picked by a ternary, tr(x ? "a" : "b"), or passed around as literals.
        keys |= set(re.findall(r'"((?:[a-z_]+\.)+[a-z_0-9]+)"', strip_comments(f.read_text())))
    html = (UI / "index.html").read_text()
    keys |= set(re.findall(r'data-i18n(?:-[a-z]+)?="([\w.]+)"', html))
    for f in SRC.glob("*.rs"):
        text = f.read_text()
        keys |= set(re.findall(r'\bt!\(\s*"([\w.]+)"', text))
        # Keys passed around as literals (menu items, lookup tables).
        keys |= set(re.findall(r'"((?:[a-z_]+\.)+[a-z_0-9]+)"', strip_comments(text)))
    return keys


# Catalogs that must hold every key of en.json.
COMPLETE = {"en", "fr"}

# Languages without a singular (Intl.PluralRules gives `other` for every
# count): a `one` form there would never show. Read from LANGS in
# src-tauri/src/i18n.rs (`plural: Plural::Never`), the one list of languages.
OTHER_ONLY = set(re.findall(r'code:\s*"([\w-]+)"[^}]*plural:\s*Plural::Never', (SRC / "i18n.rs").read_text()))
assert OTHER_ONLY, "no Plural::Never language found in src-tauri/src/i18n.rs"

TAG = re.compile(r"</?([a-z][a-z0-9]*)\b", re.I)


def tags(v):
    vals = v.values() if isinstance(v, dict) else [v]
    return sorted(t.lower() for s in vals for t in TAG.findall(s))


def placeholders(v):
    vals = v.values() if isinstance(v, dict) else [v]
    return set(p for s in vals for p in re.findall(r"\{(\w+)\}", s))


def main():
    cats = {p.stem: json.loads(p.read_text()) for p in sorted((UI / "i18n").glob("*.json"))}
    en = cats["en"]
    problems = 0

    def report(title, items):
        nonlocal problems
        if items:
            problems += len(items)
            print(f"{title} ({len(items)}):")
            for i in sorted(items):
                print("  ", i)

    used = used_keys()
    files = (".json", ".jsonl", ".md", ".py", ".stl", ".3mf", ".png", ".js", ".rs")
    catalog_like = {k for k in used if k.split(".")[0] in {x.split(".")[0] for x in en} and not k.endswith(files)}
    report("used but missing from en.json", {k for k in catalog_like if k not in en and not k.startswith(DYNAMIC) and not k.endswith(".")})
    strict = "--strict" in sys.argv
    completeness = []
    for lang, cat in cats.items():
        if lang == "en":
            continue
        missing = set(en) - set(cat)
        if lang in COMPLETE or strict:
            report(f"missing from {lang}.json", missing)
        elif missing:
            # Not an error (English shows), but said: a key added in English
            # and French only must not go unnoticed.
            print(f"warning: {len(missing)} keys missing from {lang}.json, shown in English:")
            for k in sorted(missing)[:20]:
                print("  ", k)
            if len(missing) > 20:
                print(f"   … and {len(missing) - 20} more")
        completeness.append(f"{lang} {100 * (len(en) - len(missing)) / len(en):.1f}%")
        report(f"unknown to en.json, in {lang}.json", set(cat) - set(en))
        report(
            f"placeholders differ in {lang}.json",
            {k for k in en if k in cat and placeholders(en[k]) != placeholders(cat[k])},
        )
        report(f"HTML tags differ in {lang}.json", {k for k in en if k in cat and tags(en[k]) != tags(cat[k])})
        # A plural (which a language may need where English does not, as for
        # ordinals) always has its "other" form, the fallback.
        report(
            f"plural without an 'other' form in {lang}.json",
            {k for k, v in cat.items() if isinstance(v, dict) and "other" not in v},
        )
        if lang in OTHER_ONLY:
            report(
                f"plural with a form other than 'other' in {lang}.json",
                {k for k, v in cat.items() if isinstance(v, dict) and set(v) != {"other"}},
            )
    report("unused keys", {k for k in en if k not in used and not k.startswith(DYNAMIC)})

    residue = []
    for f in sorted(UI.glob("*.js")) + [UI / "index.html"]:
        for n, line in enumerate(strip_comments(f.read_text()).split("\n"), 1):
            if FRENCH.search(line) and not FRENCH_OK.search(line):
                residue.append(f"{f.name}: {line.strip()[:100]}")
    report("French left in the UI code", set(residue))

    if problems:
        sys.exit(1)
    print(f"ok: {len(en)} keys, {len(cats)} languages ({', '.join(completeness)})")


if __name__ == "__main__":
    main()
