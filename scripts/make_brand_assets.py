#!/usr/bin/env python3
"""Render the AgentX Workmate brand artwork from the CLI's 8-bit source.

The product's visual identity is defined once, as ASCII, in
``hermes_cli/banner.py``: ``WORKMATE_MASCOT`` (a 13x14 robot sprite) and
``WORKMATE_LOGO`` (a 91x5 wordmark in a 5x5 pixel font), both coloured with
the cyan-to-violet ramp ``#7DF9FF -> #38BDF8 -> #4F7BF7 -> #6366F1 ->
#8B5CF6``.  This script is the single place that turns those two strings
into binary assets, so the terminal banner and the app icon can never drift.

Outputs::

    apps/desktop/assets/icon.png           1024x1024  electron-builder source
    apps/desktop/assets/icon.icns                     macOS bundle icon
    apps/desktop/assets/icon.ico                      Windows exe + NSIS icon
    apps/desktop/public/apple-touch-icon.png          renderer favicon
    apps/desktop/public/brand-mark.png      512x512   in-app brand badge
    assets/banner.png                                 README wordmark

Run from the repo root::

    python3 scripts/make_brand_assets.py

Requires Pillow.  ``iconutil`` (macOS) is used for the .icns; on other
platforms that one output is skipped with a warning and the existing file is
left alone.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

REPO_ROOT = Path(__file__).resolve().parent.parent

# Plate colours.  Deliberately dark: the sprite is drawn in the brand ramp,
# whose lightest stop (#7DF9FF) needs a dark field to hold contrast at the
# 20px sizes the icon is actually rendered at in a dock or a favicon.
PLATE_TOP = (15, 22, 41)
PLATE_BOTTOM = (27, 33, 64)
BANNER_BG = (13, 17, 33)


def _parse_sprite(block: str, stride: int) -> tuple[list[str], list[tuple[int, int, int]]]:
    """Split a banner.py art block into rows of cells and a colour per row.

    Each source row is ``[#RRGGBB]<art>[/]``.  ``stride`` is how many source
    characters make one logical pixel, and it differs between the two blocks:
    the mascot draws every pixel as ``██`` so it comes out square in a
    terminal cell (stride 2), while the wordmark is a 5x5 pixel FONT with one
    character per pixel (stride 1).  Reading the wordmark at stride 2 drops
    every other column and the letters dissolve into noise.
    """
    rows: list[str] = []
    colours: list[tuple[int, int, int]] = []
    for line in block.splitlines():
        m = re.match(r"\[(?:bold )?#([0-9A-Fa-f]{6})\](.*)\[/\]$", line)
        if not m:
            raise ValueError(f"unparsable art row: {line!r}")
        hex_rgb, art = m.groups()
        colours.append(tuple(int(hex_rgb[i : i + 2], 16) for i in (0, 2, 4)))  # type: ignore[arg-type]
        rows.append("".join(art[i] for i in range(0, len(art), stride)))
    width = max(len(r) for r in rows)
    return [r.ljust(width) for r in rows], colours


def _load_art() -> tuple[tuple[list[str], list], tuple[list[str], list]]:
    """Read the two art blocks out of banner.py without importing it.

    banner.py pulls in the whole CLI package on import; the artwork is a pair
    of module-level string literals, so parsing the source keeps this script
    dependency-free and runnable in a bare checkout.
    """
    src = (REPO_ROOT / "hermes_cli" / "banner.py").read_text(encoding="utf-8")
    blocks = {}
    for name, stride in (("WORKMATE_MASCOT", 2), ("WORKMATE_LOGO", 1)):
        m = re.search(rf'^{name} = """(.*?)"""', src, re.S | re.M)
        if not m:
            raise SystemExit(f"{name} not found in hermes_cli/banner.py")
        blocks[name] = _parse_sprite(m.group(1), stride)
    return blocks["WORKMATE_MASCOT"], blocks["WORKMATE_LOGO"]


def _vertical_gradient(size: tuple[int, int], top, bottom) -> Image.Image:
    w, h = size
    grad = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / max(h - 1, 1)
        grad.putpixel((0, y), tuple(round(a + (b - a) * t) for a in (0,) for b in (0,)) if False else
                      (round(top[0] + (bottom[0] - top[0]) * t),
                       round(top[1] + (bottom[1] - top[1]) * t),
                       round(top[2] + (bottom[2] - top[2]) * t)))
    return grad.resize((w, h), Image.NEAREST)


def _draw_sprite(draw: ImageDraw.ImageDraw, rows, colours, x0: int, y0: int, px: int) -> None:
    for ry, row in enumerate(rows):
        colour = colours[ry]
        for rx, cell in enumerate(row):
            if cell != " ":
                x = x0 + rx * px
                y = y0 + ry * px
                draw.rectangle([x, y, x + px - 1, y + px - 1], fill=colour)


def render_icon(rows, colours, size: int = 1024, *, plate_ratio: float = 0.805) -> Image.Image:
    """The app icon: the mascot on a rounded plate, transparent around it.

    ``plate_ratio`` leaves the margin macOS expects around a bundle icon; the
    same image is reused for Windows and the favicon, where the margin simply
    reads as padding.
    """
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    plate = round(size * plate_ratio)
    inset = (size - plate) // 2
    radius = round(plate * 0.225)

    mask = Image.new("L", (plate, plate), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, plate - 1, plate - 1], radius=radius, fill=255)
    canvas.paste(_vertical_gradient((plate, plate), PLATE_TOP, PLATE_BOTTOM), (inset, inset), mask)

    sprite_h, sprite_w = len(rows), len(rows[0])
    px = min(round(plate * 0.70) // sprite_h, round(plate * 0.78) // sprite_w)
    art_w, art_h = sprite_w * px, sprite_h * px

    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    _draw_sprite(ImageDraw.Draw(layer), rows, colours,
                 (size - art_w) // 2, (size - art_h) // 2, px)
    return Image.alpha_composite(canvas, layer)


def render_banner(rows, colours, *, px: int = 12, pad_x: int = 44, pad_y: int = 54) -> Image.Image:
    w = len(rows[0]) * px + pad_x * 2
    h = len(rows) * px + pad_y * 2
    img = Image.new("RGB", (w, h), BANNER_BG)
    _draw_sprite(ImageDraw.Draw(img), rows, colours, pad_x, pad_y, px)
    return img


def write_ico(icon: Image.Image, path: Path) -> None:
    sizes = [(s, s) for s in (16, 24, 32, 48, 64, 128, 256)]
    icon.save(path, format="ICO", sizes=sizes)


def write_icns(icon: Image.Image, path: Path) -> None:
    if not shutil.which("iconutil"):
        print(f"! iconutil not available — leaving {path.name} untouched", file=sys.stderr)
        return
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for base in (16, 32, 128, 256, 512):
            icon.resize((base, base), Image.LANCZOS).save(iconset / f"icon_{base}x{base}.png")
            icon.resize((base * 2, base * 2), Image.LANCZOS).save(
                iconset / f"icon_{base}x{base}@2x.png"
            )
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(path)],
            check=True,
            capture_output=True,
        )


def main() -> int:
    (mascot_rows, mascot_colours), (logo_rows, logo_colours) = _load_art()

    icon = render_icon(mascot_rows, mascot_colours)
    desktop = REPO_ROOT / "apps" / "desktop"

    icon.save(desktop / "assets" / "icon.png")
    write_ico(icon, desktop / "assets" / "icon.ico")
    write_icns(icon, desktop / "assets" / "icon.icns")
    icon.save(desktop / "public" / "apple-touch-icon.png")

    # The in-app badge sits on its own rounded tile, so it ships plate-to-edge
    # rather than with the bundle-icon margin.
    render_icon(mascot_rows, mascot_colours, size=512, plate_ratio=1.0).save(
        desktop / "public" / "brand-mark.png"
    )

    render_banner(logo_rows, logo_colours).save(REPO_ROOT / "assets" / "banner.png")

    for rel in (
        "apps/desktop/assets/icon.png",
        "apps/desktop/assets/icon.ico",
        "apps/desktop/assets/icon.icns",
        "apps/desktop/public/apple-touch-icon.png",
        "apps/desktop/public/brand-mark.png",
        "assets/banner.png",
    ):
        p = REPO_ROOT / rel
        print(f"  {rel:44} {p.stat().st_size:>9,} bytes" if p.exists() else f"  {rel} MISSING")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
