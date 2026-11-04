#!/usr/bin/env python3
"""Build every app icon from the original artwork.

    python3 scripts/build-icons.py      (needs Pillow and numpy)

Source: src-tauri/icons/source/snap-s-original.png, the 1024 px original
(rainbow S on a graphite squircle, on Apple's icon grid: an 824 px squircle
100 px from each edge, opaque black outside). Nothing else is upscaled or
re-processed: each output is derived from it once.

Writes:
- src-tauri/icons/source/icon-grid.png: the art with the black outside made
  transparent, on Apple's grid (the macOS .icns and the in-app icon).
- src-tauri/icons/source/icon-full.png: the same squircle filling the canvas
  (Windows and Linux icons, `tauri icon`).
- src-tauri/icons/macos/AppIcon.icon/Assets/snap-s.png: the Icon Composer
  layer for macOS 26 — the squircle's content filling the canvas, edge to
  edge (macOS applies its own squircle mask; any transparent corner would
  show the fill as a frame).
Then the platform icons with `cargo tauri icon` (the Windows and Linux ones
from icon-full.png, the macOS .icns from icon-grid.png) and, on a Mac with
Xcode 26+, Assets.car (scripts/build-macos-icon.sh).
"""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "src-tauri" / "icons"
SRC = ICONS / "source" / "snap-s-original.png"


def squircle(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """The squircle's colours and coverage (0–1). Inside, the original's
    pixels; its 1 px antialiased edge (art blended with the black outside)
    becomes partial coverage of the inner colour, so no dark fringe."""
    lum = rgb.max(axis=-1).astype(np.float32)
    inside = lum > 9
    # The core: inside pixels whose 8 neighbours are inside too.
    core = inside.copy()
    for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)):
        core &= np.roll(np.roll(inside, dy, 0), dx, 1)
    color = bleed(rgb.astype(np.float32), core)
    inner = color.max(axis=-1)
    # Partial coverage only on the ring around the core: the black outside
    # carries a little noise (1–2), not art.
    ring = np.zeros_like(core)
    for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)):
        ring |= np.roll(np.roll(core, dy, 0), dx, 1)
    ring &= ~core
    edge = np.where(ring, np.clip(lum / np.maximum(inner, 1.0), 0.0, 1.0), 0.0)
    alpha = np.where(core, 1.0, edge)
    return color, alpha.astype(np.float32)


def bleed(rgb: np.ndarray, known: np.ndarray) -> np.ndarray:
    """Colours carried outward from the known pixels to the whole canvas
    (averaging the known neighbours, ring by ring)."""
    out = rgb.copy()
    known = known.copy()
    while not known.all():
        acc = np.zeros_like(out)
        cnt = np.zeros(known.shape, np.float32)
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)):
            k = np.roll(np.roll(known, dy, 0), dx, 1)
            acc += np.roll(np.roll(out, dy, 0), dx, 1) * k[..., None]
            cnt += k
        grow = ~known & (cnt > 0)
        out[grow] = acc[grow] / cnt[grow][:, None]
        known |= grow
    return out


def save(arr: np.ndarray, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.clip(arr + 0.5, 0, 255).astype(np.uint8)).save(path, optimize=True)
    print("wrote", path.relative_to(ROOT))


def main() -> None:
    rgb = np.asarray(Image.open(SRC).convert("RGB"))
    color, alpha = squircle(rgb)
    ys, xs = np.where(alpha > 0.5)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1

    # Apple's grid, transparent outside: the art as it is.
    grid = np.dstack([color, alpha * 255])
    save(grid, ICONS / "source" / "icon-grid.png")

    # The squircle filling the canvas (2 % margin), for Windows and Linux.
    crop = Image.fromarray(np.clip(grid + 0.5, 0, 255).astype(np.uint8)).crop((x0, y0, x1, y1))
    side = round(1024 * 0.96)
    full = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    full.alpha_composite(crop.resize((side, side), Image.LANCZOS), ((1024 - side) // 2, (1024 - side) // 2))
    save(np.asarray(full).astype(np.float32), ICONS / "source" / "icon-full.png")

    # Icon Composer layer: opaque edge to edge (macOS masks it).
    layer = Image.fromarray(np.clip(color + 0.5, 0, 255).astype(np.uint8)).crop((x0, y0, x1, y1))
    layer = layer.resize((1024, 1024), Image.LANCZOS).convert("RGBA")
    save(np.asarray(layer).astype(np.float32), ICONS / "macos" / "AppIcon.icon" / "Assets" / "snap-s.png")

    tauri_icons()
    if sys.platform == "darwin":
        subprocess.run(["sh", str(ROOT / "scripts" / "build-macos-icon.sh")], check=True)


def tauri_icons() -> None:
    """The platform icons the bundle lists, from the two derived images."""
    with tempfile.TemporaryDirectory() as tmp:
        for name in ("full", "grid"):
            subprocess.run(["cargo", "tauri", "icon", str(ICONS / "source" / f"icon-{name}.png"), "-o", f"{tmp}/{name}"],
                           check=True, stdout=subprocess.DEVNULL)
        for f in ICONS.iterdir():
            if f.suffix in (".png", ".ico"):
                shutil.copy(Path(tmp) / "full" / f.name, f)
        shutil.copy(Path(tmp) / "grid" / "icon.icns", ICONS / "icon.icns")
    print("wrote the Tauri icons (src-tauri/icons)")


if __name__ == "__main__":
    main()
