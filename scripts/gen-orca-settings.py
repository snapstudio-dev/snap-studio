#!/usr/bin/env python3
"""Generates ui/assets/orca-settings.<lang>.json from Snapmaker Orca's sources.

The profile details follow Orca's tabs, with nothing written by hand:

- src/slic3r/GUI/Tab.cpp          pages, groups and settings of each tab;
- src/libslic3r/PrintConfig.cpp   label, tooltip, unit, values of a list;
- localization/i18n/<lang>/*.po   translation of these texts.

Orca's source texts are English: the English file needs no translation, the
others take their texts from the matching .po file. One file is written per
language of the app (LANGS).

Run again when Orca changes:

    python3 scripts/gen-orca-settings.py [path/to/OrcaSlicer] [--untranslated]

A label Orca's .po leaves untranslated shows in English: `--untranslated`
lists them per language, to fill the worst gaps in FIXES.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
ORCA = Path(ARGS[0]) if ARGS else ROOT / "OrcaSlicer"
UNTRANSLATED = "--untranslated" in sys.argv
OUT = ROOT / "ui" / "assets"

# Languages of the app; English is Orca's source language.
LANGS = ["en", "fr", "de", "es", "pt-BR", "it", "ja", "zh-Hans", "ko"]

# Folder of Orca's translation, when its name differs from the app's code.
PO_DIRS = {"pt-BR": "pt_BR", "zh-Hans": "zh_CN"}

# Texts the .po file leaves untranslated (an empty msgstr), for the settings
# the app shows: without these the catalog would show English. French only
# so far; `--untranslated` lists what the other languages lack.
FIXES = {
    "fr": {
        "Aligned back": "Alignée à l'arrière",
    },
}

STR = r'"(?:[^"\\]|\\.)*"'


def unescape(s):
    return re.sub(r"\\(.)", lambda m: {"n": "\n", "t": "\t"}.get(m[1], m[1]), s)


def literals(text):
    """Joins the consecutive C strings of an expression."""
    return "".join(unescape(m[1:-1]) for m in re.findall(STR, text))


# ---------------------------------------------------------------- translation


def load_po(path):
    """msgid → msgstr. Entries marked `#, fuzzy` are kept on purpose: in
    Orca's catalogs they are tooltips whose English moved a little since
    they were translated, and their text still says the same thing (checked
    for v2.4.0: de 12, es 11, fr 10). Dropping them would show English."""
    tr, msgid, msgstr, cur = {}, None, None, None
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("msgid "):
            if msgid and msgstr:
                tr[msgid] = msgstr
            msgid, msgstr, cur = literals(line[6:]), None, "id"
        elif line.startswith("msgstr "):
            msgstr, cur = literals(line[7:]), "str"
        elif line.startswith('"'):
            if cur == "id":
                msgid += literals(line)
            elif cur == "str":
                msgstr += literals(line)
        else:
            cur = None if not line.startswith("#") else cur
    if msgid and msgstr:
        tr[msgid] = msgstr
    return tr


def translator(lang):
    """Text → its translation in `lang`; the text itself for English."""
    if lang == "en":
        return {}, lambda text: text
    po = next((ORCA / "localization" / "i18n" / PO_DIRS.get(lang, lang)).glob("*.po"))
    table = {**load_po(po)}
    for text, fixed in FIXES.get(lang, {}).items():
        table.setdefault(text, fixed)
    return table, lambda text: table.get(text, text) if text else text


# ---------------------------------------------------------------- definitions


def load_defs(path, tr):
    src = path.read_text(encoding="utf-8")
    keys = {}
    # `auto def_x = def = this->add("key", …)`: a definition another one
    # copies its list from (`def->enum_values = def_x->enum_values`).
    aliases = dict(re.findall(r'auto\s+(\w+)\s*=\s*def\s*=\s*this->add(?:_nullable)?\(\s*"([a-z0-9_]+)"', src))
    copies = {}
    starts = list(re.finditer(r'def\s*=\s*this->add(?:_nullable)?\(\s*"([a-z0-9_]+)"\s*,\s*co([A-Za-z]+)', src))
    for i, m in enumerate(starts):
        block = src[m.end(): starts[i + 1].start() if i + 1 < len(starts) else len(src)]
        info = {}
        for field, name in (("label", "label"), ("full_label", "full_label"), ("tooltip", "tooltip"), ("sidetext", "unit")):
            f = re.search(r"def->" + field + r"\s*=\s*(?:L\()?((?:\s*" + STR + r")+)", block)
            if f:
                info[name] = literals(f.group(1))
        values = [literals(v) for v in re.findall(r"def->enum_values\.(?:push|emplace)_back\(\s*(" + STR + r")\s*\)", block)]
        labels = [literals(v) for v in re.findall(r"def->enum_labels\.(?:push|emplace)_back\(\s*(?:L\()?\s*(" + STR + r")", block)]
        if values:
            info["enum"] = {v: tr(labels[j]) if j < len(labels) else v for j, v in enumerate(values)}
        copied = re.search(r"def->enum_values\s*=\s*(\w+)->enum_values", block)
        if copied and copied.group(1) in aliases:
            copies[m.group(1)] = aliases[copied.group(1)]
        label = info.get("full_label") or info.get("label")
        entry = {"label": tr(label) if label else m.group(1)}
        if info.get("label") and info.get("full_label") and info["label"] != info["full_label"]:
            entry["short"] = tr(info["label"])
        if info.get("tooltip"):
            entry["tooltip"] = tr(info["tooltip"])
        if info.get("unit"):
            entry["unit"] = tr(info["unit"])
        if info.get("enum"):
            entry["enum"] = info["enum"]
        # bool, enum, percent, string…: drives how values are formatted.
        entry["type"] = re.sub(r"s$", "", m.group(2).lower()).replace("floatsorpercent", "percent").replace("floatorpercent", "percent")
        # A repeated definition (variants) keeps the most complete one.
        if m.group(1) not in keys or len(entry) > len(keys[m.group(1)]):
            keys[m.group(1)] = entry
    for key, source in copies.items():
        if "enum" in keys.get(source, {}) and "enum" not in keys[key]:
            keys[key]["enum"] = dict(keys[source]["enum"])
    return keys


# ---------------------------------------------------------------- tabs


def body(src, signature):
    """Body of a `void Class::method(...)` function."""
    start = src.index(signature)
    i = src.index("{", start)
    depth = 0
    for j in range(i, len(src)):
        depth += {"{": 1, "}": -1}.get(src[j], 0)
        if depth == 0:
            return src[i: j + 1]
    raise ValueError(signature)


def pages_of(code, tr, default_page="Extruder"):
    """Pages > groups > settings. A setting placed in a composite line
    ("Textured PEI Plate": first layer, other layers) keeps that line's title
    in `lines`."""
    pages, page, group, row = [], None, None, None
    for raw in code.splitlines():
        line = raw.split("//", 1)[0]
        r = re.search(r"\bline\s*=\s*(?:Line\s*)?\{\s*L\(\s*(" + STR + r")", line, re.I)
        if r:
            row = tr(literals(r.group(1)))
        row_end = "append_line(" in line or "append_single_option_line(" in line
        p = re.search(r"add_options_page\(\s*(?:L\(\s*(" + STR + r")\s*\)|[a-z_]+)", line)
        if p:
            title = tr(literals(p.group(1)) if p.group(1) else default_page)
            page = next((x for x in pages if x["title"] == title), None)
            if not page:
                page = {"title": title, "groups": []}
                pages.append(page)
            group = None
            continue
        g = re.search(r"new_optgroup\(\s*L\(\s*(" + STR + r")", line)
        if g and page is not None:
            title = tr(literals(g.group(1)))
            group = next((x for x in page["groups"] if x["title"] == title), None)
            if not group:
                group = {"title": title, "keys": []}
                page["groups"].append(group)
            continue
        if group is None:
            continue
        for k in re.findall(r'(?:append_single_option_line|get_option)\(\s*"([a-z0-9_]+)(?:#\d+)?"', line):
            if k not in group["keys"]:
                group["keys"].append(k)
            if row and "append_option(" in line:
                group.setdefault("lines", {})[k] = row
        if row_end:
            row = None
    # Empty groups and pages: nothing to show.
    for p in pages:
        p["groups"] = [g for g in p["groups"] if g["keys"]]
    return [p for p in pages if p["groups"]]


def generate(lang):
    table, tr = translator(lang)
    tab = (ORCA / "src" / "slic3r" / "GUI" / "Tab.cpp").read_text(encoding="utf-8")
    layout = {
        "process": pages_of(body(tab, "void TabPrint::build()"), tr),
        "filament": pages_of(body(tab, "void TabFilament::build()"), tr),
        "machine": pages_of(
            body(tab, "void TabPrinter::build_fff()") + "\n" + body(tab, "void TabPrinter::build_unregular_pages("), tr
        ),
    }
    keys = load_defs(ORCA / "src" / "libslic3r" / "PrintConfig.cpp", tr)

    used = {k for kind in layout.values() for p in kind for g in p["groups"] for k in g["keys"]}
    missing = sorted(k for k in used if k not in keys)
    source = "Snapmaker Orca (Tab.cpp, PrintConfig.cpp" + (f", {lang}.po)" if lang != "en" else ")")
    out = {"source": source, **layout, "keys": keys}
    path = OUT / f"orca-settings.{lang}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    note = ""
    if table:
        translated = sum(1 for k in keys.values() if k["label"] in table.values())
        note = f" ({translated} labels translated)"
    print(
        f"{path.relative_to(ROOT)}: {len(keys)} settings{note}, "
        + ", ".join(f"{kind} {len(p)} pages" for kind, p in layout.items())
    )
    if missing:
        print("  without a definition:", ", ".join(missing))
    if table and UNTRANSLATED:
        left = sorted({k["label"] for k in keys.values() if k["label"] and k["label"] not in table.values()})
        print(f"  {len(left)} labels in English:", "; ".join(left))


for lang in LANGS:
    generate(lang)
