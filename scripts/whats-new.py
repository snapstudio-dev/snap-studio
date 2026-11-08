#!/usr/bin/env python3
"""The app's copy of the current version's "What's new" highlights.

    python3 scripts/whats-new.py          writes ui/whats-new.json
    python3 scripts/whats-new.py --check  exit code 1 when it is out of date

The page itself lives on the site (site/whats-new/, from versions.json). The
app only needs the current version and the short name of each highlight, for
the sidebar card ("What's new in 0.14 — Explore and 3 more"), and must have
them offline: they are copied from versions.json into the app's bundle.
Run it after editing versions.json; scripts/test-whatsnew.js checks it.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "site" / "whats-new" / "versions.json"
TARGET = ROOT / "ui" / "whats-new.json"


def bundled():
    data = json.loads(SOURCE.read_text())
    cur = next(v for v in data["versions"] if v["version"] == data["current"])
    return {
        "version": cur["version"],
        "highlights": [{"id": f["id"], **f["chip"]} for f in cur["features"]],
    }


def main():
    text = json.dumps(bundled(), ensure_ascii=False, indent=2) + "\n"
    if "--check" in sys.argv[1:]:
        if not TARGET.exists() or TARGET.read_text() != text:
            print("ui/whats-new.json is out of date: run python3 scripts/whats-new.py")
            sys.exit(1)
        print("ok: ui/whats-new.json")
        return
    TARGET.write_text(text)
    print(f"wrote {TARGET.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
