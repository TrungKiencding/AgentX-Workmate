# Brand assets

`mark-1024.png` is the source of truth: the AgentX Workmate mark, white on a
transparent background, trimmed to its own ink bounds. Every icon and favicon
in the tree is generated from it by `scripts/make_icons.py` — nothing is drawn
by hand, so the platforms cannot drift apart.

```bash
python3 scripts/make_icons.py            # rebuild every asset
python3 scripts/make_icons.py --check    # fail if they are stale
```

## Where the mark came from

`source-logo.jpg` is the original supplied artwork: 720×1280, white mark on a
black field, with the mark itself occupying only 283×312 px. That is well
under the 1024 px a macOS `.icns` needs, so the mark was not simply upscaled.
It was extracted by cropping to the measured ink bounds, resampling 6× with
Lanczos, hardening the edge with a contrast curve, and blurring by ~2 px to
restore anti-aliasing. Doing it in that order reconstructs a smooth boundary
instead of amplifying the JPEG ringing into a jagged one.

Replace `source-logo.jpg` with a vector original if one becomes available:
drop an SVG in, render it to `mark-1024.png`, and rerun the script. Nothing
downstream needs to change.

## Regenerated from the mark

| Asset | Size |
|---|---|
| `apps/desktop/assets/icon.png` | 1024 |
| `apps/desktop/assets/icon.icns` | 16–1024, via `iconutil` |
| `apps/desktop/assets/icon.ico` | 16–256 |
| `apps/desktop/public/apple-touch-icon.png` | 180 |
| `apps/desktop/public/brand-mark.png` | 512 |
| `apps/bootstrap-installer/src-tauri/icons/*` | 32, 128, 256, `.icns`, `.ico` |
| `web/public/favicon.ico` | 16–256 |
| `website/static/img/favicon*.{ico,png,svg}`, `logo.png`, `apple-touch-icon.png` | 16–1024 |

Icons below 32 px use a larger mark on a squarer plate. The mark is a thin
ring, and a plain downsample of the 1024 master turns it into a smudge in a
16 px title bar.

`assets/banner.png` is not generated here — it is the wordmark, rendered from
the 5×5 pixel font in `hermes_cli/banner.py`, not from this mark.
