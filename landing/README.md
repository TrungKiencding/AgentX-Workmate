# AgentX Workmate — landing page

The marketing page for AgentX Workmate. Standalone Vite + React + TypeScript;
it deliberately sits **outside** the repo's npm workspaces (`apps/*`, `web`,
`ui-tui`, `tests-js`) so it installs, builds and deploys on its own.

```bash
npm install          # once — landing/package-lock.json pins the tree
npm run dev          # http://127.0.0.1:5180
npm run build        # → dist/
npm run preview      # serve the build on :5181
```

Install from **inside `landing/`**, not from the repo root: this package is not
a workspace member and keeps its own `node_modules` and lockfile. It is pinned
to **vite 7 + @vitejs/plugin-react 5**, not the vite 8 the monorepo root
carries — plugin-react 6 (the vite 8 pairing) requires `@rolldown/plugin-babel`
and `babel-plugin-react-compiler` as peers, which is a lot of machinery for one
static page.

`.claude/launch.json` at the repo root has a `landing` entry, so
`preview_start` can bring it up directly.

## What is where

| Path | What it holds |
|---|---|
| `tokens.css` | The whole design system — colour, type, space, motion, z-index. **Every** colour and font in the page comes through a `var()` from here. |
| `src/styles/base.css` | `@font-face`, reset, canvas, and the shared primitives (button, chip, command block, reveal). Carries the Hallmark stamp. |
| `src/styles/sections.css` | Per-section layout and the two breakpoints (40rem type, 60rem layout). |
| `src/i18n/` | `types.ts` is the contract; `vi.ts` is the source of truth; `en/zh-Hans/ja` follow it. |
| `src/lib/links.ts` | Every off-page URL and the two install one-liners. |
| `src/lib/brand-mark-path.ts` | The AgentX mark as geometry, copied from `apps/desktop/src/lib/`. |
| `public/fonts/` | Geist (latin / latin-ext / **vietnamese**) and JetBrains Mono, vendored from `apps/desktop/src/fonts/`. No font CDN at runtime. |

## Design system

The palette is **not** invented for this page — it is the shipped Night Owl
dark theme from `apps/desktop/src/themes/presets.ts`, converted hex → OKLCH so
tints stay perceptually even. Anchor hue 248 (the Night Owl navy/periwinkle
axis) tints every neutral, which is why the greys read cool.

Two accents, both from that theme: periwinkle `#8fb4ff` carries links, focus
and the primary fill; cyan `#7fdbca` appears only on the canvas bloom and the
learning-loop diagram.

Two families: **Geist** for display and body, **JetBrains Mono** as the outlier
in exactly two roles — literal commands, and the mono-cap labels that tag a
spec. CJK falls through to the platform face; neither vendored font ships those
glyphs.

Every text/background pair clears WCAG 4.5:1, and every control border clears
3:1 (`--color-control-edge` exists for exactly that reason). If you add a
colour, add it as a token first.

## Adding or changing a language

1. Add the code to `Locale`, `LOCALES`, `LOCALE_LABELS` and `LOCALE_HTML_LANG`
   in `src/i18n/types.ts`.
2. Copy `src/i18n/vi.ts` to `src/i18n/<code>.ts` and translate it.
3. Register it in `DICTIONARIES` in `src/i18n/index.tsx`, and add a detection
   branch in `detectLocale()` if the browser tag needs mapping.

`Dictionary` is exact, so a key added to `vi.ts` **breaks the build** until
every other locale carries it. That is deliberate — there is no runtime
fallback quietly papering over a missing string.

Resolution order at runtime: `?lang=` in the URL → the visitor's stored choice
→ `navigator.languages` → Vietnamese.

## Wiring up the real download links

The three platform buttons currently point at the GitHub **Releases page**,
because the current tag (`v2026.9.9`) has no binaries attached yet. Once
`npm run dist:mac|win|linux` output is uploaded, put the direct asset URLs in
`LINKS.download` in `src/lib/links.ts` — electron-builder names them
`AgentXWorkmate-<version>-<os>-<arch>.<ext>` (see
`apps/desktop/package.json` → `build.artifactName`). Nothing else changes.

## Deploying

The build is static. `base` in `vite.config.ts` is `'/'` because the vendored
fonts are public assets referenced from CSS as `/fonts/…`, which Vite does not
rewrite for a relative base. Serving the page from a sub-path means changing
`base` **and** the two preload `href`s in `index.html`.

- **Vercel / Netlify** — build `npm run build`, publish `dist`.
- **GitHub Pages with a custom domain** — same, at the domain root.

## House rules

- No colour or `font-family` outside `tokens.css`.
- No fake browser/terminal/phone chrome. Commands get a typographic frame
  (mono label, hairline, the command) — never a drawn window.
- No invented numbers. The four figures in the fact strip are countable in this
  repository: 18 = `locales/*.yaml`, 6 chat channels and 7 runtimes = the root
  `README.md`, MIT = `LICENSE`.
- One scroll-triggered moment on the page (the loop diagram drawing itself).
  Everything else is simply there when you reach it.
- Clickable text never wraps to two lines. Shorten the label instead.

`.hallmark/log.json` records the structural choices this page was built from,
so a later redesign can deliberately pick something different.
