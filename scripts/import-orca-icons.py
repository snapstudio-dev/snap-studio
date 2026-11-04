#!/usr/bin/env python3
"""Imports the slice settings' option icons and generates ui/slice-icons.js.

    python3 scripts/import-orca-icons.py [path/to/OrcaSlicer]

Snapmaker Orca shows `resources/images/param_<value>.svg` next to a list
option (src/slic3r/GUI/Field.cpp). The files `MAP` names are read from the
OrcaSlicer checkout (same default as gen-orca-settings.py), cleaned and
recoloured into ui/assets/slice-icons/orca/; the app's own drawings are in
ui/assets/slice-icons/own/, drawn with the same two colours. Both go,
inline, into ui/slice-icons.js: an <img> could not take the theme's colours.

Clean-up: width and height removed (the viewBox stays), aria-hidden and
focusable="false" added, ids nothing refers to removed, numbers rounded
to 2 decimals, round caps and joins set once on the root. Refused: a
reference (url(#…), href), <defs>, <image>, <script>, a colour other than
Orca's two. Recolouring, in the style attributes:
#009688 (the feature) → var(--vp-p, currentColor), #949494 (the frame) →
var(--vp-s, currentColor).
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ORCA = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "OrcaSlicer"
IMAGES = ORCA / "resources" / "images"
OUT_ORCA = ROOT / "ui" / "assets" / "slice-icons" / "orca"
OWN = ROOT / "ui" / "assets" / "slice-icons" / "own"
JS = ROOT / "ui" / "slice-icons.js"
BUDGET = 20 * 1024
# The infill and surface patterns: Orca has one icon per value, 49 KB raw.
JS_PATTERNS = ROOT / "ui" / "slice-icons-patterns.js"
BUDGET_PATTERNS = 40 * 1024

# (key, value) → icon: "orca:<file>" (resources/images/<file>.svg), "own:<file>"
# (ui/assets/slice-icons/own/<file>.svg), or ("support", base, badge): a
# support type, Orca's 18×18 category icon with our auto/manual badge.
MAP = {
    ("support_type", "normal(auto)"): ("support", "param_support", "badge-auto"),
    ("support_type", "tree(auto)"): ("support", "param_support_tree", "badge-auto"),
    ("support_type", "normal(manual)"): ("support", "param_support", "badge-manual"),
    ("support_type", "tree(manual)"): ("support", "param_support_tree", "badge-manual"),
    ("support_style", "default"): "own:support_style-default",
    ("support_style", "grid"): "orca:param_grid",
    ("support_style", "snug"): "own:support_style-snug",
    ("support_style", "organic"): "own:support_style-organic",
    ("support_style", "tree_slim"): "own:support_style-tree_slim",
    ("support_style", "tree_strong"): "own:support_style-tree_strong",
    ("support_style", "tree_hybrid"): "own:support_style-tree_hybrid",
    ("support_interface_pattern", "auto"): "own:pattern-default",
    ("support_interface_pattern", "rectilinear"): "orca:param_rectilinear",
    ("support_interface_pattern", "concentric"): "orca:param_concentric",
    ("support_interface_pattern", "rectilinear_interlaced"): "orca:param_rectilinear_interlaced",
    ("support_interface_pattern", "grid"): "orca:param_grid",
    ("support_base_pattern", "default"): "own:pattern-default",
    ("support_base_pattern", "rectilinear"): "orca:param_rectilinear",
    ("support_base_pattern", "rectilinear-grid"): "orca:param_rectilinear-grid",
    ("support_base_pattern", "honeycomb"): "orca:param_honeycomb",
    ("support_base_pattern", "lightning"): "orca:param_lightning",
    ("support_base_pattern", "hollow"): "orca:param_hollow",
    ("brim_type", "auto_brim"): "own:brim_type-auto_brim",
    ("brim_type", "brim_ears"): "own:brim_type-brim_ears",
    ("brim_type", "outer_only"): "own:brim_type-outer_only",
    ("brim_type", "inner_only"): "own:brim_type-inner_only",
    ("brim_type", "outer_and_inner"): "own:brim_type-outer_and_inner",
    ("seam_position", "nearest"): "own:seam_position-nearest",
    ("seam_position", "aligned"): "own:seam_position-aligned",
    ("seam_position", "aligned_back"): "own:seam_position-aligned_back",
    ("seam_position", "back"): "own:seam_position-back",
    ("seam_position", "random"): "own:seam_position-random",
}
UNKNOWN = "own:unknown"

# Pattern lists: every value has Orca's resources/images/param_<value>.svg.
SURFACE = ["monotonic", "monotonicline", "rectilinear", "alignedrectilinear", "concentric", "hilbertcurve", "archimedeanchords", "octagramspiral"]
PATTERNS = {
    "sparse_infill_pattern": [
        "rectilinear", "alignedrectilinear", "zigzag", "crosszag", "lockedzag", "line", "grid", "triangles", "tri-hexagon",
        "cubic", "adaptivecubic", "quartercubic", "supportcubic", "lightning", "honeycomb", "3dhoneycomb", "lateral-honeycomb",
        "lateral-lattice", "crosshatch", "tpmsd", "tpmsfk", "gyroid", "concentric", "hilbertcurve", "archimedeanchords", "octagramspiral",
    ],
    "top_surface_pattern": SURFACE,
    "bottom_surface_pattern": SURFACE,
    "internal_solid_infill_pattern": SURFACE,
    "ironing_pattern": ["rectilinear", "concentric"],
}

COLOURS = {"#009688": "var(--vp-p, currentColor)", "#949494": "var(--vp-s, currentColor)"}
VARS = set(COLOURS.values())
ROUND = "stroke-linecap:round;stroke-linejoin:round"


def fail(msg):
    sys.exit(f"import-orca-icons: {msg}")


def check(name, svg):
    for bad in ("url(#", "<defs", "<image", "<script", "href="):
        if bad in svg:
            fail(f"{name}: {bad} refused")


def round_numbers(s):
    return re.sub(r"-?\d*\.\d{3,}", lambda m: f"{float(m.group()):.2f}".rstrip("0").rstrip(".") or "0", s)


def clean(name, svg, orca):
    check(name, svg)
    # Export leftovers nothing points to (check refused url(#…) and href):
    # an id repeated in the page would be invalid.
    svg = re.sub(r'\s+id="[^"]*"', "", svg)
    svg = re.sub(r"^\s*<\?xml[^>]*\?>", "", svg).strip()
    m = re.match(r"<svg\b([^>]*)>(.*)</svg>$", svg, re.S)
    if not m:
        fail(f"{name}: not one <svg> element")
    attrs, body = m.groups()
    box = re.search(r'viewBox="([^"]+)"', attrs)
    if not box:
        fail(f"{name}: no viewBox")
    if orca:
        def recolour(st):
            out = st.group(1)
            for c in re.findall(r"#[0-9a-fA-F]{3,8}", out):
                if c.lower() not in COLOURS:
                    fail(f"{name}: colour {c} refused")
                out = out.replace(c, COLOURS[c.lower()])
            return f'style="{out}"'
        body = re.sub(r'style="([^"]*)"', recolour, body)
    else:
        for c in re.findall(r"#[0-9a-fA-F]{3,8}|rgba?\(", body):
            fail(f"{name}: hard-coded colour {c} refused (use --vp-p / --vp-s)")
    for v in re.findall(r"var\(--[^)]*\)", body):
        if v not in VARS:
            fail(f"{name}: {v} refused")
    body = body.replace(";" + ROUND, "").replace(ROUND + ";", "").replace(ROUND, "")
    body = round_numbers(re.sub(r">\s+<", "><", body))
    return box.group(1), group(body)


def group(body):
    """Consecutive elements with the same style share it on a <g>."""
    elems = re.findall(r"<\w+[^<>]*/>", body)
    if "".join(elems) != body:
        return body
    out, run, cur = [], [], None
    def flush():
        if len(run) > 1:
            out.append(f'<g style="{cur}">' + "".join(re.sub(r'\s*style="[^"]*"', "", e) for e in run) + "</g>")
        else:
            out.extend(run)
    for e in elems:
        st = re.search(r'style="([^"]*)"', e)
        st = st.group(1) if st else None
        if st != cur or st is None:
            flush()
            run, cur = [], st
        run.append(e)
    flush()
    return "".join(out)


def wrap(box, body):
    return f'<svg viewBox="{box}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">{body}</svg>'


def read_orca(name):
    p = IMAGES / f"{name}.svg"
    if not p.is_file():
        fail(f"missing {p}")
    box, body = clean(name, p.read_text(), True)
    (OUT_ORCA / f"{name}.svg").write_text(wrap(box, body) + "\n")
    return box, body


def read_own(name):
    p = OWN / f"{name}.svg"
    if not p.is_file():
        fail(f"missing {p}")
    return clean(name, p.read_text(), False)


def icon(spec):
    if isinstance(spec, tuple):
        _, base, badge = spec
        bbox, bbody = read_orca(base)
        if bbox != "0 0 18 18":
            fail(f"{base}: expected an 18×18 category icon")
        _, gbody = read_own(badge)
        # The base keeps its 18×18 drawing, top-left; the badge sits in the
        # free bottom-right corner of the 24×24 box.
        return wrap("0 0 24 24", f'<g transform="translate(0 1)">{bbody}</g>{gbody}')
    kind, name = spec.split(":")
    box, body = read_orca(name) if kind == "orca" else read_own(name)
    return wrap(box, body)


def js_string(s):
    """Single quotes: the SVGs are full of double ones."""
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"


def main():
    OUT_ORCA.mkdir(parents=True, exist_ok=True)
    for old in OUT_ORCA.glob("*.svg"):
        old.unlink()
    shared, index, icons = [], {}, {}
    def ref(svg):
        if svg not in index:
            index[svg] = len(shared)
            shared.append(svg)
        return index[svg]
    for (key, value), spec in MAP.items():
        icons.setdefault(key, {})[value] = ref(icon(spec))
    unknown = ref(icon(UNKNOWN))
    lines = [
        "// Generated by scripts/import-orca-icons.py: do not edit.",
        "// Option icons of the slice settings (Snapmaker Orca's param_*.svg, AGPL-3.0, and",
        "// the app's own drawings), recoloured with --vp-p (feature) and --vp-s (frame).",
        '"use strict";',
        "const SLICE_ICON_SVG = [",
        *(f"  {js_string(s)}," for s in shared),
        "];",
        "const SLICE_ICONS = {",
    ]
    for key, vals in icons.items():
        inner = ", ".join(f"{json.dumps(v)}: SLICE_ICON_SVG[{i}]" for v, i in vals.items())
        lines.append(f"  {key}: {{ {inner} }},")
    lines += ["};", f"const SLICE_ICON_UNKNOWN = SLICE_ICON_SVG[{unknown}];", "",
              'if (typeof module !== "undefined") module.exports = { SLICE_ICONS, SLICE_ICON_SVG, SLICE_ICON_UNKNOWN };', ""]
    write(JS, "\n".join(lines), BUDGET, len(shared))

    # The patterns, in their own file: an icon the first file holds is
    # taken from it, not repeated.
    own, own_index, pat = [], {}, {}
    def pref(svg):
        if svg in index:
            return f"base.SLICE_ICON_SVG[{index[svg]}]"
        if svg not in own_index:
            own_index[svg] = len(own)
            own.append(svg)
        return f"PATTERN_SVG[{own_index[svg]}]"
    for key, values in PATTERNS.items():
        for value in values:
            pat.setdefault(key, {})[value] = pref(icon(f"orca:param_{value}"))
    lines = [
        "// Generated by scripts/import-orca-icons.py: do not edit.",
        "// Pattern icons of the slice settings (Snapmaker Orca's param_*.svg, AGPL-3.0),",
        "// added to SLICE_ICONS (slice-icons.js, loaded first).",
        '"use strict";',
        "{",
        '  const base = typeof module !== "undefined" ? require("./slice-icons.js") : { SLICE_ICONS, SLICE_ICON_SVG };',
        "  const PATTERN_SVG = [",
        *(f"    {js_string(s)}," for s in own),
        "  ];",
        "  Object.assign(base.SLICE_ICONS, {",
    ]
    for key, vals in pat.items():
        inner = ", ".join(f"{json.dumps(v)}: {r}" for v, r in vals.items())
        lines.append(f"    {key}: {{ {inner} }},")
    lines += ["  });", "}", ""]
    write(JS_PATTERNS, "\n".join(lines), BUDGET_PATTERNS, len(own))


def write(path, text, budget, n):
    size = len(text.encode())
    print(f"{path.name}: {n} icons, {size} bytes (budget {budget})")
    if size > budget:
        fail(f"{path.name} is {size} bytes, over the {budget} budget")
    path.write_text(text)


if __name__ == "__main__":
    main()
