#!/usr/bin/env python3
"""CHANGELOG.md for a release.

    scripts/changelog.py release 0.11.0 [--date 2026-10-21]
        The Unreleased section becomes "## [0.11.0] — <date>", a new empty
        Unreleased section opens above it, and the compare links at the
        bottom follow. Nothing to do when the version already has its
        section (a release run again after a failed build).
        Exit code 2 when Unreleased is empty.

    scripts/changelog.py notes 0.11.0 [--plain]
        The text of that version's section, for the release notes; --plain
        turns Markdown links into their text (the app's update sheet shows
        plain text). Exit code 1 when the version has no section.

Used by scripts/release.sh and the release workflow.
"""
import argparse
import datetime
import re
import sys
from pathlib import Path

PATH = Path(__file__).resolve().parent.parent / "CHANGELOG.md"
UNRELEASED = "## [Unreleased]"
HEAD_RE = re.compile(r"^## \[([^\]]+)\]", re.M)
REPO = "https://github.com/kameka22/snap-studio"


def sections(text):
    """(name, start of its heading, end of its body) for each "## [..]"."""
    heads = list(HEAD_RE.finditer(text))
    # The link references at the bottom end the last section.
    refs = re.search(r"^\[[^\]]+\]: ", text, re.M)
    end_all = refs.start() if refs else len(text)
    out = []
    for i, m in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else end_all
        out.append((m.group(1), m.start(), end))
    return out


def body(text, name):
    for n, start, end in sections(text):
        if n == name:
            return text[start:end].split("\n", 1)[1].strip() if "\n" in text[start:end] else ""
    return None


def release(text, version, date):
    """The changelog with Unreleased published as `version`; None when the
    version already has its section."""
    if body(text, version) is not None:
        return None
    pending = body(text, "Unreleased")
    if pending is None or not pending.strip():
        raise ValueError("empty")
    secs = {n: (s, e) for n, s, e in sections(text)}
    s, e = secs["Unreleased"]
    published = f"{UNRELEASED}\n\n## [{version}] — {date}\n\n{pending}\n\n"
    text = text[:s] + published + text[e:]
    # Compare links: Unreleased from the new tag, the new version from the
    # previous one.
    prev = re.search(r"^\[Unreleased\]: \S+/compare/(v[^.]+\.[^.]+\.[^.]+)\.\.\.HEAD$", text, re.M)
    if prev:
        old = prev.group(1)
        text = text.replace(
            prev.group(0),
            f"[Unreleased]: {REPO}/compare/v{version}...HEAD\n[{version}]: {REPO}/compare/{old}...v{version}",
        )
    return text


def plain(md):
    return re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", md)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("release")
    r.add_argument("version")
    r.add_argument("--date", default=datetime.date.today().isoformat())
    n = sub.add_parser("notes")
    n.add_argument("version")
    n.add_argument("--plain", action="store_true")
    a = ap.parse_args()
    text = PATH.read_text(encoding="utf-8")
    if a.cmd == "release":
        try:
            new = release(text, a.version, a.date)
        except ValueError:
            print("CHANGELOG.md: nothing under Unreleased", file=sys.stderr)
            return 2
        if new is None:
            print(f"CHANGELOG.md: {a.version} already has its section")
        else:
            PATH.write_text(new, encoding="utf-8")
            print(f"CHANGELOG.md: Unreleased published as {a.version}")
        return 0
    notes = body(text, a.version)
    if not notes:
        return 1
    print(plain(notes) if a.plain else notes)
    return 0


if __name__ == "__main__":
    sys.exit(main())
