#!/usr/bin/env python3
"""Adds or updates keys in the catalogs of ui/i18n/, keeping insertion order.

    python3 scripts/i18n_add.py entries.json

`entries.json` maps each key to `[english, french]`, or to an object by
language (`{"en": …, "fr": …, "de": …}`) to fill other catalogs too. A
value is a string or, for a plural, an object of plural forms
(`{"one": …, "other": …}`): `{"files.n": [{"one": …, "other": …},
{"one": …, "other": …}]}`. Existing keys are changed in place, new keys are
appended. A language left out keeps its value; where it has none, the app
shows English until a translator fills it.

The catalogs are edited as text: only the entries written change, every
other line keeps its formatting (a whole rewrite would reflow the plurals).
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "ui" / "i18n"
PLURAL = {"zero", "one", "two", "few", "many", "other"}


def fail(msg):
    sys.exit(f"i18n_add: {msg}")


def check_value(key, lang, value):
    if isinstance(value, str):
        return
    if isinstance(value, dict) and value and set(value) <= PLURAL and "other" in value and all(isinstance(v, str) for v in value.values()):
        return
    fail(f"{key} ({lang}): a string or a plural object with an 'other' form, not {value!r}")


def by_language(entries, langs):
    out = {}
    for key, values in entries.items():
        if isinstance(values, list):
            if len(values) != 2:
                fail(f"{key}: a list is [english, french]")
            values = dict(zip(["en", "fr"], values))
        elif isinstance(values, dict) and set(values) & PLURAL:
            # {"one": …, "other": …} alone says no language.
            fail(f"{key}: a plural goes per language: [{{one, other}}, {{one, other}}] or {{\"en\": {{…}}, …}}")
        elif not isinstance(values, dict):
            fail(f"{key}: [english, french] or an object by language")
        for lang, value in values.items():
            if lang not in langs:
                fail(f"{key}: unknown language {lang!r} (catalogs: {', '.join(sorted(langs))})")
            check_value(key, lang, value)
            out.setdefault(lang, {})[key] = value
    return out


def render(value):
    return json.dumps(value, ensure_ascii=False, separators=(", ", ": "))


def write(path, values):
    text = path.read_text()
    json.loads(text)
    dec = json.JSONDecoder()
    new = []
    for key, value in values.items():
        m = re.search(r'\n  %s: ' % re.escape(json.dumps(key, ensure_ascii=False)), text)
        if m:
            _, end = dec.raw_decode(text, m.end())
            text = text[: m.end()] + render(value) + text[end:]
        else:
            new.append(f"  {json.dumps(key, ensure_ascii=False)}: {render(value)}")
    if new:
        body = text.rstrip()
        if not body.endswith("}"):
            fail(f"{path.name}: not a JSON object")
        body = body[:-1].rstrip()
        sep = "," if not body.endswith("{") else ""
        text = body + sep + "\n" + ",\n".join(new) + "\n}\n"
    json.loads(text)
    path.write_text(text)


def main():
    if len(sys.argv) != 2:
        fail("usage: i18n_add.py entries.json")
    entries = json.loads(Path(sys.argv[1]).read_text())
    langs = {p.stem for p in ROOT.glob("*.json")}
    for lang, values in by_language(entries, langs).items():
        write(ROOT / f"{lang}.json", values)
    print(f"{len(entries)} keys written")


if __name__ == "__main__":
    main()
