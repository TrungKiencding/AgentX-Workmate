#!/usr/bin/env python3
"""Build the desktop app icons from the brand mark.

Source of truth is ``assets/brand/mark-1024.png`` — the AgentX Workmate mark
as white-on-transparent at 1024px. Everything electron-builder ships is
derived from it here, so the icon set can never drift between platforms:

    apps/desktop/assets/icon.png    1024px, Linux and the electron-builder base
    apps/desktop/assets/icon.icns   macOS, built with the system iconutil
    apps/desktop/assets/icon.ico    Windows, multi-resolution 16-256

Layout follows Apple's Big Sur icon grid: a 1024 canvas with an 824 rounded
square centred in it, so macOS lines the app up with the rest of the Dock
instead of floating it. The same artwork is reused on Windows and Linux,
where a rounded square with transparent corners is also conventional.

Usage::

    python3 scripts/make_icons.py            # rebuild every icon
    python3 scripts/make_icons.py --check    # verify they match the mark

Requires Pillow. ``iconutil`` is macOS-only; on other platforms the .icns
step is skipped and the existing file is left alone.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

REPO_ROOT = Path(__file__).resolve().parent.parent
MARK = REPO_ROOT / "assets" / "brand" / "mark-1024.png"
OUT = REPO_ROOT / "apps" / "desktop" / "assets"

# Every square brand asset in the tree, and the size each consumer asks for.
# Three of the Tauri entries shipped as 1024px files under 32x32/128x128 names
# — Tauri reads the declared size from tauri.conf.json, so the mismatch went
# unnoticed until everything was regenerated from one place.
PNG_TARGETS = {
    "apps/desktop/public/apple-touch-icon.png": 180,   # index.html declares 180x180
    "apps/desktop/public/brand-mark.png": 512,         # in-app badge (BrandMark)
    "apps/bootstrap-installer/src-tauri/icons/32x32.png": 32,
    "apps/bootstrap-installer/src-tauri/icons/128x128.png": 128,
    "apps/bootstrap-installer/src-tauri/icons/128x128@2x.png": 256,
    "website/static/img/favicon-16x16.png": 16,
    "website/static/img/favicon-32x32.png": 32,
    "website/static/img/apple-touch-icon.png": 180,
    "website/static/img/logo.png": 1024,
}

ICO_TARGETS = [
    "apps/bootstrap-installer/src-tauri/icons/icon.ico",
    "web/public/favicon.ico",
    "website/static/img/favicon.ico",
]

ICNS_TARGETS = ["apps/bootstrap-installer/src-tauri/icons/icon.icns"]

CANVAS = 1024
PLATE = 824  # Big Sur grid: the rounded square inside the canvas
RADIUS = 185
PLATE_COLOR = (10, 10, 12, 255)  # near-black, matching the brand presentation
MARK_FRACTION = 0.62  # mark height as a fraction of the plate

# Optical sizing. The mark is a thin ring, and simply downsampling the 1024
# master turns it into a smudge in a 16px title bar. Small entries get a
# larger mark on a squarer plate so the triangle still reads; the crossover
# sits at 48px, above which the plain master is already legible.
SMALL_MARK_FRACTION = 0.82
SMALL_RADIUS_RATIO = 0.16  # of PLATE, vs 185/824 = 0.225 at full size
SMALL_MAX = 32

# Windows .ico carries every size the shell asks for; below 32px the mark's
# ring collapses, so the small entries come from the same art downsampled with
# LANCZOS rather than from a separate simplified drawing.
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# .icns needs both the 1x and 2x entry for each slot or iconutil rejects it.
ICNS_SLOTS = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]


def compose(mark_fraction: float = MARK_FRACTION, radius: int = RADIUS) -> Image.Image:
    """Return a 1024px icon: mark centred on a rounded plate."""
    mark = Image.open(MARK).convert("RGBA")

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    plate = Image.new("RGBA", (PLATE, PLATE), (0, 0, 0, 0))
    ImageDraw.Draw(plate).rounded_rectangle(
        (0, 0, PLATE - 1, PLATE - 1), radius=radius, fill=PLATE_COLOR
    )
    offset = (CANVAS - PLATE) // 2
    canvas.alpha_composite(plate, (offset, offset))

    # Scale by the mark's own ink bounds, not its canvas, so padding in the
    # source file cannot shift the optical size.
    ink = mark.crop(mark.getbbox())
    target_h = int(PLATE * mark_fraction)
    scale = target_h / ink.height
    ink = ink.resize((max(1, round(ink.width * scale)), target_h), Image.LANCZOS)

    canvas.alpha_composite(
        ink, ((CANVAS - ink.width) // 2, (CANVAS - ink.height) // 2)
    )
    return canvas


def render(size: int, master: Image.Image, small: Image.Image) -> Image.Image:
    """Downsample the master, or the optically-adjusted art below SMALL_MAX."""
    source = small if size <= SMALL_MAX else master
    return source.resize((size, size), Image.LANCZOS)


def write_png(master: Image.Image) -> Path:
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / "icon.png"
    master.save(path)
    return path


def write_derived(master: Image.Image, small: Image.Image) -> list[Path]:
    """Regenerate every other brand asset from the same master."""
    written = []
    for rel, size in PNG_TARGETS.items():
        path = REPO_ROOT / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        render(size, master, small).save(path)
        written.append(path)
    for rel in ICO_TARGETS:
        path = REPO_ROOT / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        frames = [render(s, master, small) for s in ICO_SIZES]
        frames[-1].save(path, format="ICO", append_images=frames[:-1],
                        sizes=[(s, s) for s in ICO_SIZES])
        written.append(path)
    return written


def write_ico(master: Image.Image, small: Image.Image) -> Path:
    path = OUT / "icon.ico"
    frames = [render(s, master, small) for s in ICO_SIZES]
    frames[-1].save(path, format="ICO", append_images=frames[:-1],
                    sizes=[(s, s) for s in ICO_SIZES])
    return path


def write_icns(master: Image.Image, small: Image.Image,
               path: Path | None = None) -> Path | None:
    if sys.platform != "darwin" or not shutil.which("iconutil"):
        print("  .icns  skipped (needs macOS iconutil)")
        return None
    path = path or (OUT / "icon.icns")
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for name, size in ICNS_SLOTS:
            render(size, master, small).save(iconset / name)
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(path)], check=True
        )
    return path


def main() -> int:
    ap = argparse.ArgumentParser(prog="make_icons.py", description=__doc__)
    ap.add_argument("--check", action="store_true", help="verify without writing")
    args = ap.parse_args()

    if not MARK.is_file():
        print(f"missing brand mark: {MARK.relative_to(REPO_ROOT)}", file=sys.stderr)
        return 1

    master = compose()
    small = compose(SMALL_MARK_FRACTION, int(PLATE * SMALL_RADIUS_RATIO))

    if args.check:
        current = OUT / "icon.png"
        if not current.is_file():
            print("icon.png missing — run without --check")
            return 1
        same = Image.open(current).convert("RGBA").tobytes() == master.tobytes()
        print("icons match the mark" if same else "icons are STALE — rerun")
        return 0 if same else 1

    paths = [write_png(master), write_ico(master, small), write_icns(master, small)]
    paths += write_derived(master, small)
    for rel in ICNS_TARGETS:
        icns = write_icns(master, small, REPO_ROOT / rel)
        if icns:
            paths.append(icns)
    for path in paths:
        if path:
            print(f"  {path.relative_to(REPO_ROOT)}  {path.stat().st_size:,} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
