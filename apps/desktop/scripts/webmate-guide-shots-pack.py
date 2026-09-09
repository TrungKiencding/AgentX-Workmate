#!/usr/bin/env python3
"""Turn the raw extensions-page screenshots into the WebP files the panel bundles.

`webmate-guide-shots.mjs` leaves 1280×720 @2x PNGs in src/assets/webmate/. The
onboarding step shows the picture in a 16 rem column, so only the top of the
page matters: the toolbar with the Developer-mode toggle and the "Load
unpacked" button, plus the first card as an anchor. Crop that band, scale to
880 px wide, save as WebP, drop the PNG.

    python3 scripts/webmate-guide-shots-pack.py
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    sys.exit("Pillow is required: python3 -m pip install pillow")

ASSETS = Path(__file__).resolve().parent.parent / "src" / "assets" / "webmate"
# CSS pixels of the source viewport (the PNGs are @2x). Chrome and Brave put
# the Developer-mode toggle in the toolbar, so the top band is enough; Edge
# keeps it at the bottom of the left column, so its whole page is kept.
CROP_HEIGHT_CSS = {"chrome": 400, "brave": 400, "edge": 720}
TARGET_WIDTH = 880


def pack(png: Path) -> Path:
    image = Image.open(png).convert("RGB")
    scale = image.width / 1280
    browser = png.stem.split("-")[0]
    band = image.crop((0, 0, image.width, int(CROP_HEIGHT_CSS.get(browser, 400) * scale)))
    ratio = TARGET_WIDTH / band.width
    small = band.resize((TARGET_WIDTH, max(1, round(band.height * ratio))), Image.LANCZOS)
    out = png.with_suffix(".webp")
    small.save(out, "WEBP", quality=82, method=6)
    png.unlink()
    return out


def main() -> int:
    pngs = sorted(ASSETS.glob("*.png"))
    if not pngs:
        print(f"no PNGs in {ASSETS}; run scripts/webmate-guide-shots.mjs first")
        return 1
    for png in pngs:
        out = pack(png)
        print(f"- {out.name}: {out.stat().st_size // 1024} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
