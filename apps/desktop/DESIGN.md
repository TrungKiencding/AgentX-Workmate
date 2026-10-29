# Desktop Design System

Conventions for the Electron desktop app (`apps/desktop`). Read this before
adding a component, overlay, or style. The rule of thumb: **one source per
concern, tokens over literals, flat over boxed.** If you reach for a raw color,
a one-off shadow, a bespoke button, or a hardcoded `px-*` on a control — stop,
there's already a primitive for it.

This file owns the visual and interaction contract. Read
[`AGENTS.md`](./AGENTS.md) for architecture, state, resolver, transport, and
testing rules.

This doc contains two kinds of content, maintained differently:

- **Principles** (flatness, intent, feedback, motion, cancellation) are durable.
  They hold as components come and go.
- **Named contracts** (tokens, `Button` variants, primitive names) are the
  design system's current API. They are maintained *with* the code: if you
  change a primitive, token, or variant, update its entry here **in the same
  change** — a stale name in this file is a bug, exactly like a stale type.

When a rule and the code disagree, fix whichever is wrong rather than forking a
one-off at the call site.

## Quiet Tool — the spec this app follows

The desktop app follows **AgentX - Design Spec Quiet Tool** (v2.0, the "Quiet
Tool" style). The spec lives with the design docs, outside this repository;
code comments cite it as `spec §5.7`. Its one-line summary: the interface steps
back so content leads — warm neutral grays, colour only as a signal, regions
separated by whitespace and a 1px line, hierarchy by contrast rather than by
size. Its priority order settles every conflict in this file: **clarity >
speed of use > consistency > minimalism > aesthetics.**

Where the code departs from the spec on purpose, the departure is named here
with its reason. The focus ring paints the accent at full strength
(§ Affordances). The rest came out of the review round of 29/10, where the
app was read on real machines — on older, lower-density displays the spec's
sizes read small and its greys washed out, and the all-black, all-grey UI
read heavy in some places and too faded in others:

- **One size step up** (§ Typography, § Control & radius tokens) — every
  rung of the type ramp, the control ramp and the chrome rows moves up one
  step (body 15px, reading 16px, controls 30/36/44, rows 36), and the forced
  `antialiased` smoothing is dropped. Reason: legibility on older,
  lower-density displays.
- **Firmer greys** (§ Surfaces) — secondary, tertiary and disabled ink, both
  icon inks and all four hairlines sit one grey rung firmer than spec
  §3.3 / §3.4. Reason: the spec's greys read too faded on the same displays.
- **The sidebar surface** (§ Surfaces, § Navigation chrome) — the sidebar
  sits on its own `--sidebar-bg` (gray-50 / gray-1000) instead of the page
  colour, with its own row-fill rungs and a `--border-default` edge. Reason:
  on one flat page the navigation did not read as a place of its own.
- **Charcoal inverse** (§ Surfaces) — `--bg-inverse` is gray-700 in light
  (gray-200 in dark), not near-black. Reason: an all-black UI read heavy.
- **Accent switches and checkboxes** (§ Form controls) — on / checked paint
  `--accent` under a white thumb or glyph, as the platform's own controls
  do, instead of `--bg-inverse`. Reason: an all-black UI read heavy.
- **Tile colours** (§ Iconography & brand) — a `--tint-*` palette and
  `IconTile` colour the settings rail, store-card glyphs and the sidebar's
  destination glyphs. Reason: an all-grey UI read flat and heavy; colour
  here marks *which place*, never a state.

**Three token tiers** (`src/tokens.css`, imported at the top of `styles.css`):

| Tier | Examples | Read by |
| --- | --- | --- |
| Primitive | `--gray-0 … --gray-1000` (the warm-gray ladder), `--blue-300…600`, `--amber-*`, `--red-*`, `--green-*`, `--clay-*` | the semantic tier only |
| Semantic | `--bg-app / -subtle / -raised / -hover / -selected / -pressed / -inverse`, `--border-subtle / -default / -strong / -input`, `--text-primary / -secondary / -tertiary / -disabled / -inverse`, `--icon-default / -muted`, `--accent / -hover`, `--warning(-bg)`, `--danger(-bg)`, `--success`, `--brand`, `--selection`, `--scrim`, `--scrim-light`, `--focus-ring`, `--elevation-1 / -2 / -drawer`, `--tint-blue … -graphite` (tile colours only) | components |
| Component | `--ui-row-active-background`, `--composer-fill`, `--switch-md-*`, `--sidebar-nav-row-height`, `--sidebar-bg`, `--sidebar-row-hover / -selected`, … | the one component that owns it |

A component consumes the semantic tier (or a component token built on it) —
never a primitive, never a hex. Two paths feed the semantic tier:

- **The Quiet skin** pins it straight to the primitives, both modes, under
  `:root[data-agentx-theme='quiet']` (`applyTheme` stamps the skin name on
  `<html>`). The same block points the legacy `--ui-*` component tokens back
  at the semantic tier (`--ui-row-active-background: var(--bg-selected)`,
  `--ui-stroke-tertiary: var(--border-default)`, …), so every older surface
  paints spec values without a per-component rewrite. The block is unlayered
  on purpose — it beats the `@layer base` defaults in `styles.css` — and has
  no cycles: every `--ui-*` it sets resolves to a semantic token the same
  block pins to a primitive.
- **Every other skin** (Night Owl, Nous, Midnight, …) keeps its own palette
  pipeline (`--theme-*` seeds → `--ui-*` in `styles.css`), and the semantic
  tier reads *from* that (`--bg-app: var(--ui-bg-chrome)`, `--text-secondary:
  var(--ui-text-secondary)`, `--bg-inverse: var(--theme-foreground)`, …). A
  component written against the spec names therefore still paints correctly
  under a legacy skin.

Tailwind sees the semantic tier through `@theme inline` (spec §12.2):
`bg-app`, `bg-subtle`, `bg-raised`, `bg-hover`, `bg-selected`, `bg-pressed`,
`bg-inverse`, `text-fg`, `text-fg-muted`, `text-fg-subtle`, `text-fg-disabled`,
`text-fg-inverse`, `text-icon`, `text-icon-muted`, `border-line`,
`border-line-subtle`, `border-line-strong`, `border-line-input`, `*-signal` /
`*-signal-hover`, `*-warning`, `*-warning-bg`, `*-danger`, `*-danger-bg`,
`*-success`, `*-brand`. The signal blue is **`signal`**, not `accent` —
`accent` is already the shadcn soft-fill token. The arbitrary-var form
(`bg-(--bg-app)`, `text-(--text-secondary)`) resolves to the same token and is
what most primitives write; either is fine, a hex is not.

## Principles

1. **Flat, not boxed.** No card-in-card, no divider borders inside a panel.
   Group with whitespace and a single hairline, never nested rounded boxes.
   Cards and the composer carry a border, never a shadow.
2. **Elevation is a level, not a look.** Something that floats takes elevation
   level 1 (`shadow-md`) or level 2 (`shadow-nous`), and each level brings its
   own 1px edge. No per-surface shadows, no glows, no backdrop blur.
3. **One primitive per concern.** One `Button`, one set of control variants,
   one `menu-styles` recipe, one `SearchField`, one `Loader`, one
   `ErrorState`. Migrate onto them; don't fork.
4. **Tokens, not literals.** Reference the semantic tier (`--bg-*`,
   `--text-*`, `--border-*`, `--accent`, `--danger`…) or a component token,
   never raw hex / ad-hoc rgba in components.
5. **Style lives in the primitive.** Variants and sizes own padding, radius,
   color, chrome. Call sites pass a `variant`/`size`, not `className` overrides
   that re-specify those.
6. **Intent before automation.** Surface useful actions and previews, but do not
   open panes, move focus, or navigate because a tool happened to produce
   something.
7. **Immediate feedback.** Direct manipulation updates the view first. Network
   or disk persistence reconciles afterward and rolls back visibly on failure.
8. **Undo beats confirm.** A reversible action happens at once and offers
   "Hoàn tác"; only an irreversible one asks first (§ Feedback).

## Information architecture

- **Chat is the home surface.** The transcript and composer stay primary; tools,
  previews, files, review, and terminal complement the conversation.
- **Pages are durable destinations.** Chat, Skills, Messaging, and Artifacts
  remain in shell chrome. Do not hide a distinct product noun inside an
  unrelated page.
- **Route overlays are short tasks.** Settings, Command Center, Cron, Profiles,
  Agents, and Starmap render as `OverlayView` cards and return to the previous
  route on close. Model/session pickers and dialogs layer above the current
  surface; they are not navigation stacks.
- **Panes are working context.** Preview, files, review, and terminal remain
  attached to the current task. Their state survives temporary hiding and chat
  switches where the underlying tool is meant to persist.
- **One action, one home.** A command may have keyboard, palette, and visible
  affordances, but they invoke the same action and state. Do not fork behavior
  per entry point.
- **Projects own workspace cwd.** Use Sidebar → Projects for local folders and
  worktrees; do not reintroduce a per-session/right-sidebar folder-picker flow.

Navigation must preserve context. A background session finishing, a tool result
arriving, or a project refresh may update badges and cached data; it must not
replace the foreground transcript or steal focus.

## Surfaces & elevation

**Quiet is the default skin** (`DEFAULT_SKIN_NAME = 'quiet'`, `quietTheme` in
`themes/presets.ts`). Light is a white page, dark is `--gray-950`
(`#1c1c1b`). The titlebar over the main pane, the page and the editor are the
page colour — regions separate by whitespace and one 1px line. **The sidebar
is the one tinted column** (a deliberate deviation, see the top of this file):
it sits on `--sidebar-bg` — a warm off-white (gray-50) in light; in dark it
steps *down* from the page to gray-1000 (`#141413`), the macOS source-list
way — edged by `--sidebar-edge-border` (= `--border-default`; the subtle rung
vanishes against a tinted column). Every element marked `data-sidebar-surface`
(`ChatSidebar`, `OverlaySidebar`) re-points the row fills it reads —
`--bg-hover`, `--bg-selected`, `--ui-row-hover/-active-background`,
`--ui-control-hover/-active-background` — to `--sidebar-row-hover` /
`--sidebar-row-selected`, one rung stronger than the page's, so hover and
selection still land on the tinted surface (custom properties substitute
where they are declared, so every token a row reads is re-pointed, not only
the semantic pair). The titlebar band paints the column under it: a gradient
split at the tree-published `--workspace-left` / `--workspace-right`
(`contrib/controller.tsx`) lays the sidebar surface over the side rails and
the page over the main pane, so the sidebar reads as one column from the
traffic lights down. `chromeBackground()` in `themes/context.tsx` passes a
Quiet background through unmixed (pulling it toward the Paper/Graphite rungs
would tint the title bar and the boot paint blue).

| Semantic token | Light | Dark |
| --- | --- | --- |
| `--bg-app` — page, editor, cards, the composer | gray-0 `#ffffff` | gray-950 `#1c1c1b` |
| `--sidebar-bg` — the sidebar, overlay rails, the titlebar band over them | gray-50 | gray-1000 `#141413` |
| `--sidebar-row-hover / -selected` — row fills inside `[data-sidebar-surface]` | gray-150 / gray-200 | gray-900 / gray-800 |
| `--bg-subtle` — code block, segmented track, user bubble, kbd | gray-50 | gray-900 |
| `--bg-raised` — popover, menu, toast, dialog | gray-0 | gray-850 |
| `--bg-hover` | gray-100 | gray-850 |
| `--bg-selected` | gray-150 | gray-800 |
| `--bg-pressed` | gray-200 | gray-750 |
| `--bg-inverse` — primary button, the send circle, tooltip, skip link | gray-700 (charcoal) | gray-200 |
| `--border-subtle / -default / -strong / -input` | 200 / 300 / 400 / 500 | 800 / 750 / 700 / 600 |
| `--text-primary / -secondary / -tertiary / -disabled` | 950 / 700 / 600 / 500 | 100 / 300 / 400 / 600 |
| `--icon-default / -muted` | 800 / 600 | 200 / 400 |
| `--accent / -hover` | blue-500 / blue-600 | blue-400 / blue-300 |
| `--warning-bg / --danger-bg` | amber-50 / red-50 | amber-950 / red-950 |

**The greys sit one rung firmer than spec §3.3 / §3.4** (review: on older,
lower-density displays the spec's greys read too faded). On white, secondary
text measures 8.2:1 and tertiary 5.9:1 — every text tier now clears AA, so
tertiary may carry a caption a person reads — and the `--border-input` edge
measures 3.4:1, clearing the 3:1 boundary floor. **`--bg-inverse` is
charcoal, not black** (review: an all-black UI read heavy): white on gray-700
is 8.2:1. `--brand` (clay) is for the mascot and the logo only, never text
(3.1:1). `--scrim` is 32% black (56% in dark) behind a dialog;
`--scrim-light` (12% / 32%) is the palette's lighter dim. In dark, elevation is
`--bg-raised` (lighter than the page) plus the level's edge, not a shadow.

**The `quietTheme` seeds mirror these values** as flat hex (the pipeline
parses `#rrggbb` only) so the title bar, the boot paint and the contrast gate
see the same numbers as `tokens.css`. Change one, change both — the firmer
greys moved the seeds with them (`mutedForeground` gray-700 / gray-300,
`border` gray-300 / gray-750, `input` gray-500 / gray-600, the light
`composerRing` gray-400; the `WARM` ladder gained the 750 rung), and the
sidebar seeds carry its surface (`sidebarBackground` gray-50 / `#141413`,
light `sidebarBorder` gray-300). Two seeds are deliberate: the dark `primary`
fill is `#8db3f9` (a step past blue-400) so a dark label on it clears APCA Lc
60; and the danger *fill* keeps red-600 in dark so its white label still reads
(danger *text* in dark is `--ui-red`, the 400 rung). `primary` is the signal
blue; the primary *button* never reads it (§ Buttons).

**A fresh install follows the OS** (`normalizeMode` falls back to `'system'`,
spec §11). The first frame agrees before any module runs: `index.html` paints
white or `#1c1c1b` from `prefers-color-scheme`, `electron/main.ts` returns
`'system'` for a missing theme source and the matching native window
background, and `<meta name="theme-color">` carries one value per scheme.
**A one-shot migration** — `moveOldDefaultSkinToQuiet()`, marker
`agentx-desktop-quiet-default-v1` — moves an install still on Night Owl (the
previous shipped default, rarely a deliberate pick) to Quiet, the global slot
and every per-profile assignment. Anyone who switches back keeps Night Owl;
every other stored skin is left alone.

Nine presets ship built in — **Quiet** (the default), Night Owl (the previous
default: Sarah Drasner's palette with both halves authored), Nous (Paper light
/ Graphite dark), Nous Classic, Midnight, Ember, Mono, Cyberpunk, Slate. Each
preset's header comment in `themes/presets.ts` names its axes (band · display
· accent) and tuned values carry their OKLCH beside the hex. Both variants of
every preset — including the synthesised light side of dark-only presets
(`synthLightColors` in `themes/color.ts`, which deepens the primary until a
white label reads and `ensureContrast`s muted text and the ring) — must clear
the contrast gate `scripts/check-theme-contrast.mjs` in `npm run check`: text
pairs ≥ 4.5:1, primary/destructive labels also APCA |Lc| ≥ 60, focus ring
≥ 3:1 against the page, hairlines ≥ 1.2:1 (visible, still quiet — the 3:1
boundary rule belongs to the ring, not to dividers). The status trio as bare
text on page and card is a hard gate on Quiet, Night Owl and Nous and advisory
elsewhere. Status badges never fill with a tone, so the gate no longer measures
a pill tint.

**The Nous bands.** Nous keeps its own construction: two neutral bands on a
lightness ladder at hue 262, every rung carrying a trace of chroma, declared
as hex in `themes/presets.ts` (`PAPER` / `GRAPHITE`) and mirrored as the
`--theme-neutral-*` OKLCH fallbacks in `styles.css` — change one, change both.
In Graphite, elevation is lightness (+3% per rung). `--theme-mix-elevated` and
`--theme-mix-bubble` are 100% in both modes, and the knobs live twice —
`styles.css` and `mixesFor()` in `themes/context.tsx` — and must agree. None
of this reaches Quiet, which pins its surfaces outright. The royal-blue dark
that preceded Graphite lives on whole as **Nous Classic**.

**Accent picker.** Settings → Appearance can re-seed the Nous preset's accent —
`ACCENT_SKIN_NAME`, deliberately not `DEFAULT_SKIN_NAME`, since `nousWithAccent`
rebuilds the *Nous* palette around the hue
(`ACCENT_PRESETS` · `nousWithAccent` in `themes/presets.ts`): the neutral
bands, inks and semantic colors stay exactly Paper/Graphite — only what the
blue carried moves. Fills and strokes re-tint, the primary deepens until its
white label reads (`labelReadyFill`), stroke duty keeps its per-band contrast
lift. Stored per profile like skin and mode ('' = Nous blue); every other
preset keeps its own accent, and the contrast gate walks every curated accent
in both bands.

**Elevation levels** (spec §3.9). Flat by default. Everything that floats
takes one of two levels, and each level's shadow carries its own 1px
`--border-default` ring — so a floating surface needs no border of its own:

| Level | Token | Recipe | Surfaces |
| --- | --- | --- | --- |
| 0 | `shadow-xs` and `shadow-composer` = `none`; `shadow-sm` = the 1px ring alone | — | page, cards, the composer, the active segment |
| 1 | `shadow-md` = `--elevation-1` | `0 4px 16px rgb(0 0 0 / .08)` + ring | popover, menu, select, toast, the "Mới nhất" pill, composer drawers, the thread timeline popover |
| 2 | `shadow-nous` = `shadow-lg` = `--elevation-2` | `0 16px 48px rgb(0 0 0 / .16)` + ring | dialog, command palette, session switcher, route overlays |

`--elevation-drawer` is defined for a sidebar shown as an overlay drawer.
**`--stroke-nous` is transparent** — kept so call sites that still write
`border-(--stroke-nous)` compile to nothing; don't add new ones. Don't add
per-overlay `shadow-[…]`; if elevation needs to change, change the token.

**`menu-styles.ts`** (`components/ui/menu-styles.ts`) is the one look for every
floating list — dropdown, context menu, select, the popover shell and the cmdk
list (spec §5.11):

| Export | What it is |
| --- | --- |
| `MENU_SURFACE` | level 1: `--bg-raised` under `shadow-md`, 12px corners, 4px padding, 224px min width, `overscroll-contain`; each primitive adds its z-index and a 60vh max height |
| `MENU_ITEM` | a 36px row, 8px corners (the nesting rule: 12px outer − 4px padding), 10px inline padding, an 18px glyph in `--icon-muted` 10px from a 15px label; `--bg-hover` on hover and keyboard highlight; `data-variant=destructive` reads in `--danger` on `--danger-bg`. `dropdownMenuRow` (the compact searchable menus in `dropdown-menu.tsx`) is the same 36px pitch |
| `MENU_SUB_TRIGGER` | an item that keeps its fill while its sub-menu is open |
| `MENU_LABEL` | group heading: caption size, tertiary ink, never uppercase |
| `MENU_SEPARATOR` | a `--border-subtle` line |
| `MENU_SHORTCUT` | right-aligned keybind caption |
| `MENU_INDICATOR` | the ✓ of a selected item: right-aligned, no fill change |
| `MENU_MOTION` | 160ms fade + 4px rise from the anchor side in, 100ms fade out |

A menu is used at speed and gets no discount: its rows read at body size like
the rest of the chrome. A destructive item sits last, under a separator. These
are semantic surface classes, not licenses for call-site shadow or border
inventions.

## Stroke & color tokens

New code writes the semantic tier (table above). The legacy `--ui-*` names
still exist — every skin's pipeline produces them, and the Quiet block maps
them back to the semantic tier — so older surfaces keep working:

| Token | Use |
| --- | --- |
| `--border-default` | the default hairline: cards, the composer, table frames, docked composer cards, the sidebar edge (`--sidebar-edge-border`) |
| `--border-subtle` | dividers: tab rows, menu separators, the account row, the code card edge, the titlebar rule |
| `--sidebar-bg` · `--sidebar-row-hover / -selected` | the sidebar's own surface and its row fills (Quiet only; `[data-sidebar-surface]` re-points `--bg-hover` / `--bg-selected` and the legacy row/control fills to them) |
| `--tint-blue / -green / -orange / -red / -purple / -pink / -teal / -indigo / -yellow / -graphite` | tile colours for `IconTile` only (§ Iconography & brand) — never text, never a state; one set per mode, on every skin |
| `--border-strong` | the firmer edge: composer hover / focus-within, card hover, the dashed drop sheet, a switch's off track |
| `--border-input` | a form field's edge |
| `--ui-stroke-primary…quaternary` | legacy hairline ramp; on Quiet = strong / default / default / subtle |
| `--ui-text-primary / -secondary / -tertiary / -quaternary` | legacy text hierarchy; on Quiet = the four `--text-*` rungs |
| `--ui-row-hover-background` / `--ui-row-active-background` | legacy row fills; on Quiet = `--bg-hover` / `--bg-selected` |
| `--ui-widget-surface-background` | fill for inline chat widgets (`WIDGET_SHELL_CLASS`) |
| `--chrome-action-hover` | hover fill for legacy quiet controls (new code: `--bg-hover`) |
| `--theme-primary`, `--ui-accent` | the skin's accent seed; `--accent` reads `--ui-accent` on non-Quiet skins |
| `--ui-green / --ui-yellow / --ui-red` | success · warning · danger — `--success` / `--warning` / `--danger` read them on every skin |
| `--ui-*-foreground` (green/yellow/red) | text/glyph placed **on** that fill |
| `--ui-info` · `--ui-info-foreground` | the fourth status tone, "in progress" (connecting, syncing) — the accent itself, no new hue |
| `--ui-focus-ring`, `--ui-focus-ring-width/-offset` | the one focus outline (`--ui-focus-ring` = `--accent`) |
| `--focus-ring` | the two-layer box-shadow ring a text field paints on focus |
| `--ui-scrollbar-thumb*` | scrollbar thumb, per state (Quiet: gray-300/400, dark gray-700/600) |
| `--ui-selection-seed` | the selection amber, one seed at two strengths (Quiet: `--selection`, 18% of the accent) |
| `--ui-glyph-field-strength` | how bright the empty chat's glyph field prints when a click lights it, per mode |
| `--ui-brand-art-strength` | how loud the brand line art behind the sign-in plate is, per mode |

The semantic trio is the spec's signal set, stated once per mode in OKLCH in
`styles.css` so the gate can read it: light is the 600 rung — green-600
`oklch(52.85% 0.1061 154.6)` · amber-600 `oklch(54.27% 0.1228 61.8)` · red-600
`oklch(55.54% 0.1835 28.5)`, each ≥ 5.1:1 on white — and `.dark` lifts it to
the 400 rung (green-400 · amber-400 · red-400, ≥ 5.9:1 on gray-950). A
semantic colour can carry *text*, not only a dot — but a status still needs a
glyph or a word as well as a hue.

**`TagChip`** (`components/ui/tag-chip.tsx`) is the quiet metadata tag the
store surfaces share — a category on a skill detail, "Desktop / Trình duyệt"
on a store card, a transport on a catalog entry: a 13px (`text-xs`) full pill on
`--bg-subtle` in secondary ink, sentence case as written. It labels; it never
signals state — state belongs to `StatusPill`, which always brings its dot.

**`StatusPill`** (`components/ui/status-pill.tsx`) is the one status badge
(spec §5.14): a 6px dot in the signal colour and a word in `--text-secondary`
— **never a coloured fill**. The dot carries the hue, the word carries the
meaning, so a status never rests on colour alone. `tone` = `good | warn | bad
| info | muted` (dot from `--ui-green / -yellow / -red / -info`, tertiary ink
for a resting state), `size` = `sm` (24px, 13px text — beside a row title) or
`md` (30px, `--control-h-sm`, 14px — level with a `size="sm"` button). Never a raw Tailwind ramp
(`emerald-*`/`amber-*` are gone from the pages). `StatusDot`
(`components/status-dot.tsx`) is the bare dot for a row, on the same tones.

**`Badge`** (`components/ui/badge.tsx`) is the count / metadata badge: 20px
tall (the spec's 16px, one step up), caption at 500 weight with a 14px glyph
(12px at `xs`), tabular figures, full radius. `default` is
`--bg-selected` under secondary ink; `muted` `--bg-subtle`; `warn` and
`destructive` use the signal's soft background (`--warning-bg` /
`--danger-bg`) — never a solid fill; `outline` a `--border-default` ring.

**`Kbd`** (`components/ui/kbd.tsx`) is a 20px flat key cap (the spec's 18px,
one step up; `sm` and `md` share it): a single glyph is a square, a word gets
4px of padding each side; caption text in secondary ink on `--bg-subtle`
under a `--border-default` edge, 6px corners.

Never hardcode `border-gray-*`, `bg-white`, `text-black`, etc. The white tile in
`BrandMark` is the one sanctioned literal (the mark needs a fixed backdrop).
Light `--theme-*` seeds are stated in OKLCH (exact conversions of the shipped
hex) so palette tuning happens on perceptual axes.

## Typography

**No serif (one exception below), no all-caps, no widened tracking** (spec
§3.6). Hierarchy comes
from contrast, not size: the ramp is nearly flat through the chrome, and
metadata steps down by ink (secondary, tertiary) rather than by shrinking.
**Every rung sits one step above the spec's** (review: legibility on older,
lower-density displays) — the structure is the spec's, only the sizes moved.

Faces — themes override sans/mono through the existing pipeline:

- **The Quiet skin sets the platform's own UI face**: `-apple-system,
  BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Inter, system-ui` (`QUIET_SANS`
  in `presets.ts`). SF Pro on macOS and Segoe UI on Windows both carry full
  Vietnamese. Mono is `"SF Mono", ui-monospace, "JetBrains Mono", …`
  (`QUIET_MONO`), so bundled JetBrains Mono is the fallback where SF Mono is
  absent.
- **Geist** (`--dt-font-sans`, OFL-1.1, `DEFAULT_TYPOGRAPHY`) stays bundled in
  `src/fonts/` as the sans of the other skins — variable weight per script
  subset (latin, latin-ext, vietnamese). **JetBrains Mono** (`--dt-font-mono`)
  stays bundled as the code face. No CDN fetch at runtime.
- **One serif line: the home greeting.** Newsreader (OFL-1.1, a static opsz 72 /
  wght 400 headline cut, vendored per script subset in `src/fonts/` so
  Vietnamese diacritics never fall back to Georgia) is kept for exactly that
  slot, through the `font-serif-display` utility (`--font-serif-display` in
  `@theme`) — the deliberate exception to the spec's "no serif" (review: the
  greeting is the product's one human line and reads warmer in the face it
  always had). It is not part of the theme pipeline (no `fontSerifDisplay`
  field); the onboarding title stays in the sans at 26px and the connect
  screen carries no display type at all. Roman only — never italic.
- `--dt-font-kbd` keeps the native UI face. No pixel face survives in the app;
  `BrandMark` is a bitmap plate, not type.

`body` sets 15px (`text-base`, the spec's `text-body` one step up) and **no
forced font smoothing**: `-webkit-font-smoothing: antialiased` /
`-moz-osx-font-smoothing: grayscale` were dropped in review — on
lower-density displays they thin every stem and the UI reads washed out; the
platform's default rendering keeps strokes at their designed weight.

**Type ramp** (`--text-*` in `@theme inline`; these are the app's only font
sizes — no ad-hoc `text-[…]`. One sanctioned exception sizes in `em`, not on
the ramp: inline code at `0.92em` of its sentence, plus the onboarding glyph's
ASCII art, which is drawing, not text):

| Utility | Size / line-height | Spec rung (spec size) | Use |
| --- | --- | --- | --- |
| `text-xs` | 13 / 1.4 | caption (12) | timestamps, keybind hints, counts, captions |
| `text-2xs` | 13 / 1.4 | — | **alias of `text-xs`**, kept so old call sites compile; write `text-xs` |
| `text-sm` | 14 / 1.43 | meta (13) | group titles, tabs, inline controls, small buttons, store-shelf names |
| `text-base` | 15 / 1.47 | body (14) | **default chrome**: nav rows, lists, menus, buttons, inputs, the composer, dialog descriptions |
| `text-md` | 16 / 1.6 | reading (15) | chat prose, the user bubble, the palette's search input |
| `text-lg` | 17 / 1.47 | title (16) | dialog titles, page / overlay titles |
| `text-xl` | 21 / 1.38 | — (20) | a rare page title |
| `text-2xl` | 26 / 1.3 | section display (24) | onboarding title, sign-in title |
| `text-3xl` | 30 / 1.27 | display (28) | **the home greeting** — 600 weight, `tracking-display`; the sign-in headline |

The floor is **13px** (the spec's 12px caption, one step up) — nothing
renders below the caption. Every multi-line rung keeps line-height ≥ 1.4 so
Vietnamese stacked diacritics (ỗ, ữ, Ặ) never clip; only the single-line
title and display rungs run tighter (1.38 / 1.3 / 1.27). The ramp carries no
letter-spacing, with one exception: **`--tracking-display`** (−0.022em, the
`tracking-display` utility) draws display type slightly tighter, the way the
platform's own large titles are set. Nothing is ever tracked *wider*;
`--tracking-label` is gone (it was retired at `0`, and the token is now
deleted), `uppercase` is gone from every label, and a `tracking-[…]` literal
is a bug. Columnar numbers use `tabular-nums` —
every counter in the statusbar, every stat tile, every timestamp in a list,
every table. Headings get `text-balance`, paragraphs `text-pretty`.

**Group labels are sentences, not stamps.** The sidebar's `SidebarPanelLabel`
and `SidebarDateDivider` are 14px (`text-sm`) regular in `--text-secondary`,
their own casing. Menu, select and palette group headings are a caption
(`text-xs`) in `--text-tertiary`. `PanelSectionLabel` and Messaging's
section titles keep their caption-size (13px) semibold tertiary look; the small labels in
Command Center, the model picker and onboarding kept their caption size and
lost their uppercase and tracking.

**The transcript reads on its own scale.** A reply is read in paragraphs, so
the chat column has a second, narrower set of tokens layered on the ramp —
all in `rem`, so they ride `--dt-base-size` like everything else:

| Token | Value | Use |
| --- | --- | --- |
| `--conversation-text-font-size` | 16px | prose (the `text-md` reading rung) |
| `--conversation-caption-font-size` | 14px | scaffold labels |
| `--conversation-tool-font-size` | 14px | tool meta, step detail (`text-meta`) |
| `--conversation-code-font-size` · `-line-height` | 14px · 1.54 | every mono payload in the thread: fences, diffs, stdout, terminal tails (`text-code`) |
| `--conversation-prose-line-height` | 1.6 | prose only — chrome keeps `--dt-line-height` (1.5) |
| `--conversation-measure` | 72ch | the reading measure (see Chat) |
| `--conversation-h1…h4-font-size` | 17 / 16 / 16 / 15px | markdown headings inside a reply |

A heading in a reply is a section break in a message, not a page title: it
tops out at the 17px title rung — never above a dialog or page title — and
bottoms out at the 15px body size. It never reaches the display rungs — those
belong to the home greeting and onboarding.

## Control & radius tokens

- `--control-h-sm/md/lg/xl` (30/36/44/44px) — one height ramp for every
  control; an input and a button on the same row are the same height. The
  spec's 28/32/40 ramp, one step up with the type (review: legibility on
  older displays) — the same three rungs, so `xl` stays an alias of `lg`.
- `--sidebar-nav-row-height` (36px) · `--sidebar-row-height` (36px) ·
  `--statusbar-height` (26px) — the navigation
  band's own heights. Nav rows and conversation rows share one comfortable
  36px rung (the spec's 32px, one step up); the statusbar keeps its shorter
  band.
- `--cap-row-height` (48px) — the advanced-connections rows on the Tiện ích
  page: a 15px title over a 14px one-line status with an `md` switch (the
  skills and tools tabs are card grids, see `StoreCard` under § Layout).
  `--artifact-row-height` (52px) — the Artifact library's file/link rows,
  roomy enough for a 24px type icon plus two lines. Both deliberately sit
  above the sidebar's 36px: these rows carry controls, not just a title.
- `--switch-md-track-width/-height` (32×18px) · `--switch-md-thumb` (14px) —
  the Switch (spec §5.6's 28×16 / 12, one step up). `--status-pill-h-sm/-md`
  (24/30px; `md` rides `--control-h-sm`) — the `StatusPill`.
  `--intro-card-min-height` (56px) — the home surface's task card.
- **Radius rungs are fixed** (spec §3.8) — `--radius-scalar` is gone, and the
  `rounded-*` utilities no longer ride it:

  | Utility | Value | Use |
  | --- | --- | --- |
  | `rounded-sm` | 6px | badge, tooltip, kbd, checkbox, inline code, a segment |
  | `rounded-md` | 8px | nav row, button, input, menu item |
  | `rounded-lg` | 12px | card, popover, menu, code block, table frame, toast, banner |
  | `rounded-xl` | 16px | composer, dialog, route overlay, command palette |
  | `rounded-full` | 9999px | avatar, dot, switch, pill, the send button |

  `rounded-xs` (4px) and `rounded-2xl…4xl` (20/24/32px) exist but have no
  spec slot. The named tokens say the same thing: `--radius-control` (8px),
  `--radius-card` (12px), `--radius-overlay` (12px — popovers, menus),
  `--radius-dialog` (16px — dialogs, route overlays), `--radius-bubble` (16px
  — the user bubble). **Nesting rule:** inner radius = outer radius −
  padding, so a 12px menu with 4px padding holds 8px items. In the
  transcript: `rounded-lg` for the code card and table frame,
  `--radius-card` for `WIDGET_SHELL_CLASS`, `--radius-bubble` for the user
  bubble, `--radius-control` for what sits *inside* them (a choice row, a
  fence inside a bubble).

## Buttons — one component

`src/components/ui/button.tsx` is the single source (spec §5.5). Pick a
`variant` + `size`; do **not** pass `h-*`, `px-*`, `py-*`, or icon-size
overrides.

**Variants:**

| Variant | Look | Use |
| --- | --- | --- |
| `default` (primary) | `--bg-inverse` fill (charcoal on Quiet), `--text-inverse` label **on every skin** — never the brand, never the accent; hover opacity .88, pressed .80; disabled drops to `--bg-pressed` under `--text-disabled` | the **one** confirming action in a context, rightmost in its group |
| `destructive` | the danger fill, white label; hover .88 | the final confirm of an irreversible action only |
| `secondary` / `outline` | transparent, 1px `--border-default`, hover `--bg-hover`, pressed `--bg-pressed` — two names, one look | Cancel, the alternative path |
| `ghost` | no fill, no border, secondary ink → primary on hover over `--bg-hover` | icon buttons, quiet actions |
| `link` | `--accent` text, underline only on hover (`--accent-hover`) | navigation, "Có gì mới" |
| `text` | boxless secondary ink, underline on hover | inline "Huỷ", "Xoá bộ lọc" |
| `textStrong` | medium primary ink, underlined in `--border-strong` | the actionable word in a row ("Đổi", "Mở log") |
| `chip` | the spec's **inline control**: 14px (`text-sm`) secondary label + 18px glyph, a `--bg-hover` frame only on hover; pair with `size="chip"` | context-bar items, in-row pickers, "Thêm" |
| `card` | an **interactive card**: a flat `--bg-app` tile under `--border-default`; hover firms the edge to `--border-strong`, pressed `--bg-subtle` — never a lift, never a shadow; pair with `size="card"` | the home surface's ways in |

**Sizes** ride the `--control-h-*` ramp. Labels are 15px (`text-base`), 14px
at `sm`, weight 500 only at `lg`:

| Size | Box | Use |
| --- | --- | --- |
| `default` | 36px, 14px padding (12 beside a glyph) | the standard button |
| `sm` | 30px, 14px text, 10px padding | dense rows, secondary actions |
| `lg` | 44px, 15px/500, 18px glyph | prominent forms, the primary dialog action when it needs weight |
| `xl` | alias of `lg` (44px) | kept for call sites that predate the spec |
| `xs` | 24px, 13px text, 14px glyph | genuinely dense chrome (statusbar) |
| `inline` | flush, zero box | buttons inside a heading/sentence |
| `micro` | flush, 13px text, 14px glyph | status-stack headers, table footers, the toast stack's row |
| `chip` | 28px, 8px padding | the `chip` variant's size |
| `card` | padding-driven (12×16), 56px floor, left-aligned, 18px glyph | the `card` variant's size |
| `icon` / `icon-sm` / `icon-lg` | 36/30/44px square; 20/18/20px glyph | icon-only actions |
| `icon-xs` | 24px square, 14px glyph | inline icon actions and pane-header chrome (`ICON_BUTTON` in `master-detail.tsx` pairs with it) — the hit-target floor |
| `icon-titlebar` | 24px (`--titlebar-control-size` / `-height`) | the titlebar's own controls — off the ramp, never under the 24px floor |

**`loading`** swaps the label for a centred 16px spinner while keeping the
button's width (no layout shift) and disables it. Ignored with `asChild`.

Notes:
- Every boxed button carries `--radius-control` (8px), `icon-titlebar`
  included; boxless variants (text/link/inline/micro) have no box to round.
- **Width follows the label** — never a fixed width. Vietnamese labels run
  20–35% longer than English.
- Transitions name their properties (`background-color`, `border-color`,
  `color`, `opacity`) at `--dur-micro` — never `transition-all`. **Pressed is
  a fill** (`--bg-pressed`, or opacity .80 on an inverse/danger fill), not a
  transform; the old 1px `active:translate-y-px` settle is gone.
- **Buttons keep the default arrow cursor** (spec §7, the desktop
  convention); `pointer` belongs to links and nav rows (§ Affordances).
- **A call site never passes a positioning `translate-*` to a Button.** Every
  `translate-x/y-*` utility writes the same `translate` property; when the
  press was a transform, the overlay close X's `-translate-y-1/2` centring was
  cancelled on every click. The press is a fill now, but the rule stays so a
  future press treatment can never collide with a call site: wrap the button
  in a positioned element and let the wrapper hold the transform.
  `components/ui/__tests__/no-button-transform.test.ts` fails on any
  `<Button>` carrying one.
- SVGs inherit 18px (`size-4.5`; 14px at `xs` / `micro` / `icon-xs`, 20px at
  `icon` / `icon-lg`). Don't re-set icon size.
- Polymorph with `asChild` when the button must render as a link/Slot.

**Tooltips only when hover teaches something new.** `<Tip>` is for discovery,
not a tax on every icon. Ask: does hover reveal something the user cannot
already see or infer? If not, skip the tip; keep an `aria-label` for a11y.

Tip unlabeled chrome when the job (or a keybind / truncated path / host /
other detail) is not already on screen — toolbar / titlebar / statusbar icons,
`TipKeybindLabel` shortcuts, ownership chips, unlabeled icon grids.

Do **not** tip:

- Menu triggers (kebabs / ⋯ / `ActionsMenu` / `DropdownMenuTrigger`) — the
  affordance is "open menu"; verbs live in the menu. Never tip
  `"Actions for ${row title}"` / `"Project actions"` / `"Actions"`.
- Close / dismiss X buttons — the glyph is the label (`aria-label` only).
- Controls whose visible label already says what the tip would ("click to…",
  paraphrases of the same words, timer labels restating "Running").

**The tooltip itself** (`TooltipContent`, spec §5.13) is a `--bg-inverse`
(charcoal) chip with a `--text-inverse` 13/16 caption, 4×8 padding, 6px corners, no arrow, at
most 256px wide, never interactive (`pointer-events-none`). A keybind hint
trails the label at reduced opacity (`TipHintLabel`).

Never use native HTML `title=` on buttons — unstyled, ~500ms OS delay, clashes
with the themed `Tip`. `src/components/ui/__tests__/no-native-title.test.ts`
fails on any `<button>` / `<Button>` that still carries `title=`.

**Keybind hints in tooltips.** On a tipped button bound to a rebindable hotkey,
use `<TipKeybindLabel actionId="..." />` — it reads the i18n label and the
current combo from `$bindings`. Pass `text={...}` only when the label is
context-dependent (e.g. "Show" / "Hide"). Never hardcode combos; always use
`useKeybindHint` or `TipKeybindLabel`.

## Form controls

- **`controlVariants`** (`src/components/ui/control.ts`) is the shared shape for
  `Input` / `Textarea` / `SelectTrigger` (spec §5.6). New text-entry controls
  compose it. 36px (`sm` 30, `lg` 44, `xs` 24), 10px inline padding (12 at
  `lg`), 15px text (14 at `sm`, 13 at `xs`), placeholder in `--text-tertiary`, `--radius-control`.
  The chrome is `.desktop-input-chrome` in `styles.css`: a 1px `--border-input`
  edge on `--bg-app`, no inset shadow. On focus the edge turns `--accent` and
  the two-layer `--focus-ring` box-shadow (a 2px page-colour gap, then 2px of
  accent) paints in the same frame — never transitioned, and the 1px border
  never changes weight, so nothing shifts. `[data-state='open']` keeps a
  select trigger looking focused while its list holds focus.
  `aria-invalid` turns the edge `--danger`. `Textarea` swaps the fixed height
  for a min-height so it can grow. The select's chevron is a 14px muted ⌄; its
  list is the `menu-styles` surface.
- **`SearchField`** — the only search input. The default `inline` variant is
  borderless, auto-width, 14px text at `--control-h-sm` (30px), placeholder
  tertiary — the filter beside a page or overlay title. `variant="field"` is a
  list's standing finder, the chat sidebar's: it sits in the navigation band
  **as one of its rows** (spec §4.1 "⌕ Tìm kiếm") — the nav row's 36px height,
  12px padding and 20px glyph in `--icon-default`, `--bg-hover` on hover — and
  becomes a field when focused: `--bg-app` under an inset `--border-strong`
  edge. The whole well is a `<label>`. Don't build other boxed search bars;
  don't wrap either variant in a bordered tile. Escape clears a query, then
  lets go of focus. Empty lists hide their search field.
- **`SegmentedControl`** (spec §5.4) — the choice control for 2–4
  mutually-exclusive options (color mode, tool-call display, usage period);
  five or more belong in a dropdown. A `--bg-subtle` track at
  `--radius-control` with a 2px pad; the active segment is the page colour
  edged by `shadow-sm`'s 1px `--border-default` ring (dark: `--bg-selected`,
  no edge); inactive segments read in secondary ink. `sm` (default) is a 28px
  track of 24px segments, 14px labels; `size="md"` (32px track, 28px
  segments, 16px glyphs) is the one view switch *inside* a page tab — Kho tiện
  ích's "Kỹ năng · MCP" — so it reads as a switch at a glance without becoming
  a second page-tab row. It renders `role="group"`; pass an `aria-label` that
  names what is being switched.
- **`Switch`** (spec §5.6, one step up) — a 32×18 track with a 14px thumb:
  off is `--border-strong`; **on is `--accent`** under a white thumb with a
  1px drop shadow (`0 1px 2px rgb(0 0 0 / .2)`), the way the platform's own
  settings switch reads — a deliberate deviation from the spec's
  `--bg-inverse` (review: an all-black UI read heavy). The thumb is white in
  both modes and both states. Bare, with `aria-label`, no bordered text
  wrapper. **Only for settings that apply immediately**; a setting that waits
  for "Lưu" is a checkbox. `default` and `md` are the same size (`md` stays so
  page rows say what they mean); `xs` (24×14, 10px thumb) is for menus and
  dense rows. An invisible pad extends the hit target to ≥ 24px on every
  size.
- **`Checkbox`** — 18×18 (the spec's 16, one step up), 6px corners, a
  `--border-input` edge on `--bg-app`; checked and indeterminate fill
  **`--accent`** (edge and fill) with a 14px `--text-inverse` ✓ / –, like
  the platform's own checkbox — the same deviation and reason as the switch.
- **`PageTabs`** (`components/ui/page-tabs.tsx`, renamed from `PillTabs`;
  spec §5.18) — the page-level tab row: 14px text tabs 24px apart in
  secondary ink; the current tab reads in primary ink over a 2px
  `--text-primary` underline; one `--border-subtle` divider under the whole
  44px row; a count sits beside its label as a tertiary tabular caption (a
  `CountSkeleton` while it loads). No boxes, no fills. The underline is ONE
  element that slides to the active tab — a MutationObserver on `data-active`,
  like `CommandSelectionIndicator`, never React state; `transform` and
  `opacity` are the only animated properties and its width snaps.
  `ResponsiveTabs variant="page"` renders it on wide viewports and still folds
  into `TabDropdown` when the header is narrow.
- **`TextTab`** (`components/ui/text-tab.tsx`) — the in-pane tab (log sources,
  editor panes): the same voice at 36px — 14px secondary ink, the current tab
  in primary ink over a 2px inset underline that costs no layout. The host row
  draws the `--border-subtle` divider. Two to four views of the same data are
  a `SegmentedControl`, not tabs.

## Navigation chrome

The sidebar, statusbar, and pane tabs are the frame around the work. They must
read as structure at a glance — what is a group, what is selected, what is
running — while staying quieter than the content they frame.

- **Sidebar width** (spec §4.1 / §4.3): 288px by default
  (`SIDEBAR_DEFAULT_WIDTH`, `--sidebar-width: 18rem`), 256px when the window
  opens under 1280px wide (`defaultSidebarWidth()` → `SIDEBAR_COMPACT_WIDTH`),
  user-resizable within 240–400px (`SIDEBAR_MIN_WIDTH` / `SIDEBAR_MAX_WIDTH`)
  and persisted as the pane's width override (`store/layout.ts`). The
  sidebar sits on its own surface, `--sidebar-bg` (gray-50 light, gray-1000
  dark — see § Surfaces), marked `data-sidebar-surface` so its hover and
  selected fills use the sidebar's own `--sidebar-row-hover` /
  `--sidebar-row-selected` rungs; the titlebar band above it paints the same
  surface. Its content is inset 8px from the edge, separated from the main
  area by one `--sidebar-edge-border` line (`--border-default` on Quiet).
  `⌘\` collapses it (§ Keyboard).
- **Group labels** (`SidebarPanelLabel`, `SidebarDateDivider`) are one look:
  14px regular in `--text-secondary`, their own casing, no tracking (see
  § Typography). A date divider is a 36px heading with whitespace above it —
  no rule. `SidebarPanelLabel` draws a 6px round dot only when a
  `dotClassName` asks for one; the dither square is gone. Not brand-tinted —
  colour is for signals, not for labelling.
- **Group headers** (`SidebarSectionHeader` in `sessions-section.tsx`, spec
  §5.2): a 36px row whose whole width toggles the group (`aria-expanded`), the
  ▸ (`DisclosureCaret`, muted) on the **left** of the title, turning 90° at
  `--dur-collapse`; `--bg-hover` on hover; trailing actions sit outside the
  toggle. 24px of air separates the nav block from the first group; rows
  stand 2px apart (`SidebarRowStack`); nested rows indent 12px
  (`SidebarRowNest`).
- **"Trò chuyện mới" heads the nav rows, as one of them.** Same row, same
  type, same glyph treatment as the destinations under it (`NAV_ROW` /
  `navGlyphClass()` in the sidebar), led by Tabler's `CirclePlus` — the band
  reads as one list of ways to go, not a button stacked on a menu. The `⌘N`
  chip shows on hover / focus-within only — a hint for people who want one,
  not a label everyone reads. Right-click still opens "Mở ở khung chia đôi".
- **Nav rows** (spec §5.1, one step up) — Trò chuyện mới · Tiện ích · Kênh
  tin nhắn · Artifact, then the search row — are `--sidebar-nav-row-height`
  (36px): a 20px Tabler glyph, 10px from a 15px regular label in
  `--text-primary`, 12px padding, 8px corners, 2px apart, `--bg-hover` on
  hover, `cursor-pointer`. **Each destination's glyph carries its own tint**
  (`NAV_GLYPH_TINT`): Trò chuyện mới `--tint-blue`, Tiện ích `--tint-orange`,
  Kênh tin nhắn `--tint-green`, Artifact `--tint-purple` — the way the
  platform's sidebars colour their glyphs (review: an all-grey band read
  flat). The label stays primary ink; a contributed row, and the search row,
  keep `--icon-default` (`NAV_ROW_GLYPH`). **Selected is `--bg-selected` and
  nothing else** — no ink change, no leading bar.
- **Connected messaging channels stay under the Messaging destination.** Show
  only adapters whose live state is connected, one compact row per platform:
  platform avatar, platform name, and its public bot/channel identity when the
  adapter provides one. Selecting a row opens that platform's Messaging detail
  (never a duplicate configuration popover); selected is the standard
  `--bg-selected` fill.
- **Sidebar rows** own their height only on `SidebarRowShell`
  (`--sidebar-row-height`, 36px, `--radius-control`). The session title is
  `text-base` (15px) regular in `--text-primary`, 12px from the row's left
  edge; meta and timestamps `text-xs tabular-nums` in tertiary. Selected is
  `--bg-selected` alone. Hover-revealed row actions use `size="icon-xs"` (24px)
  — the hit-target floor. The pinned
  section's empty line invites ("Ghim những cuộc trò chuyện bạn hay quay
  lại.") — pin lives in the row's ⋯ menu, and Shift-click is a shortcut,
  never the only way. That menu's "Mở ở khung chia đôi" submenu speaks the
  catalog (`sidebar.row.split*`), never a literal. Every hover-revealed
  control in the sidebar — the projects tree's add / ⋯ / new-worktree buttons,
  "load more", the cron row's actions — is a 24px square (`size-6`) at
  `--radius-control`, whatever glyph it carries.
- **The account row** (`SidebarAccountRow`, `app/chat/sidebar/account-row.tsx`,
  spec §5.3) is pinned to the sidebar's foot under a `--border-subtle`
  divider, a 60px band (a 44px row with 8px above and below): a 28px round initials
  avatar on `--bg-selected` (13px/500, `accountInitials()` — two initials
  from the display name, else
  the email's first letter), the name in primary ink — no plan (review: the
  licence's plan name is account detail, shown in Settings → Account) — and
  a ⌄. The whole row opens the account menu upward (Tài khoản · Cài đặt ·
  Phím tắt, with their keybind hints). It renders nothing until someone is
  signed in — the sign-in gate owns that state. **It reads the sign-in
  through `useKeycloakAccount()`** (`hooks/use-keycloak-account.ts`), as the
  home greeting does: the main process only learns the realm once a backend
  is up, so a launch-time read can say "not configured"; the hook re-reads
  whenever the gateway opens while no one shows as signed in, so the name
  appears on its own instead of only after Settings → Account re-reads it.
- **The projects tree keeps Codicon only for data.** A project's icon is a
  Codicon name the user picked, and the tree's lead glyphs (home, branch,
  kanban, repo) share that column, so they stay Codicon as file-tree
  vocabulary. Everything the tree *does* — its buttons, dialogs, branch
  pickers and menus — is Tabler like the rest of the sidebar.
- **Titlebar:** Tabler at 16px in `--icon-default`, `--bg-hover` on hover
  (`titlebarButtonClass`), a `--border-subtle` rule under the bar. The right
  cluster is layout · ⋯ · settings · right-sidebar toggle; the ⋯
  (`titlebar.moreTools`) holds sound and the keyboard-shortcut panel. Both
  keep their shortcuts — the menu is only where their buttons live.
- **Statusbar:** `--statusbar-height`, `text-2xs` (13px, the ramp floor) with
  `tabular-nums` on every item — the bar is counters that tick in place. Warning
  and failure states use `--ui-yellow` / `destructive`, never a raw palette ramp,
  and always pair the colour with a glyph.
- **Pane tabs** (`PaneTab` / `PaneTabLabel`) ride the meta size (`text-sm`)
  like every other tab. Labels are proper names — a pane title, a filename — so
  they keep their own casing. Active = primary ink on the editor surface plus
  a 2px inset underline in `--pane-tab-active-accent` (default
  `--text-primary`); inactive = secondary ink on the gutter, `--bg-hover` on
  hover; a tab riding a multi-tab selection takes `--bg-selected`; tabs are
  split by `--border-subtle`.
- The profile rail is the one deliberately dense strip: identity squares, the
  create/import glyphs, and the scope pills all sit at 24px so the rail reads as
  one row. Its drag pitch is measured from the node, so the size is free to
  change; `RAIL_GAP` is not.

## Layout

- **Gutters:** `PAGE_INSET_X` (`src/app/layout-constants.ts`) for page side
  padding; `PAGE_INSET_NEG_X` to bleed a child to the edge. Don't hardcode
  `px-6`/`px-8` on pages.
- **Master/detail overlays:** `OverlaySplitLayout` + `OverlaySidebar` /
  `OverlayMain`. Cron, profiles, etc. ride this — don't rebuild a titlebar
  shell. **Route overlays** (`OverlayView`) are a level-2 card: `--bg-app`,
  16px corners, `shadow-nous`, over the `--scrim` (no blur — the page dims, it
  doesn't fog), fading in at `--dur-long`.
- **Page titles:** `OverlayPageHeader` (`overlays/overlay-split-layout.tsx`) is
  the one page-title block — `text-lg` (17px, the spec's `text-title`)
  semibold over a `text-sm` secondary line, actions right. Command Center,
  every `Panel` (`PanelHeader` composes it), **and the full pages** —
  `PageSearchShell` takes `title`/`description` and renders them through it,
  so Tiện ích, Tin nhắn and Artifact announce themselves the way an overlay
  pane does (the description is where a page explains itself: "Ảnh, tệp và
  liên kết AgentX đã tạo…"). No rule under it; the gap is the separation. A
  pane that must hide the title at a breakpoint targets
  `[data-slot=overlay-page-title]`, not a DOM position. **Settings is the
  deliberate exception** — its left rail already names the page, so it takes
  its hierarchy from `SectionHeading` over `ListRow` instead of repeating the
  rail.
- **Page tab rows are `PageTabs`.** `PageSearchShell` renders its tabs through
  `ResponsiveTabs variant="page"` — text tabs over one sliding underline and a
  divider, with tabular counts — centred between the search field and the
  trailing action. `TextTab` remains the in-pane tab (log sources, editor
  panes).
- **Library rows group by recency.** The Artifact list is Drive's "Recent":
  `dayGroup` (`lib/time.ts`) buckets rows into Hôm nay · Hôm qua · 7 ngày qua ·
  then months (plain calendar days — no 4 AM rollover here; that belongs to
  the session sidebar), with a sentence-case header per shelf and month names
  formatted in the app locale, not the OS locale (the shared `fmtMonth` /
  `fmtMonthYear` do that for every surface — see § i18n).
- **The overlay rail** (`OverlaySplitLayout`'s first column) is 15.5rem
  (248px) wide — widened from 13rem so the larger labels fit — and
  `OverlaySidebar` sits on the sidebar surface (`--sidebar-bg`,
  `data-sidebar-surface`), like the chat sidebar.
- **Overlay nav rows** (`OverlayNavItem`, settings `NavLink`) are nav rows
  (spec §5.1, one step up): `--control-h-md` (36px), the glyph 10px from a
  15px regular label in primary ink, 12px padding, `--radius-control`;
  `--bg-hover` on hover, `--bg-selected` when current — no border, no ink
  change. A top-level row whose `OverlayNavLink` carries a `tint` wears its
  glyph in a **solid `IconTile`** (`size="sm"`: a 24px tile, 6px corners, a
  14px white glyph) — the platform Settings look; an untinted row keeps an
  18px glyph in `--icon-default`. **The settings rail tints every pane**
  (`SETTINGS_TINTS` in `app/settings/index.tsx`), curated so related panes
  share a family and none is chosen by chance (by pane id: `config:model`
  purple, `config:chat` blue, `config:appearance` pink, `config:workspace`
  indigo, `config:safety` green, `config:memory` orange, `config:voice` red,
  `config:advanced` graphite, `notifications` red, `browser` teal, `billing`
  green, `gateway` indigo, `account` blue, `keybinds` graphite, `keys`
  yellow, `plugins` purple, `sessions` orange, `about` graphite). A
  nested `OverlayNavItem` is never tiled: it indents to 24px at 14px with a
  14px glyph.
- **Rows:** `ListRow` (settings `primitives.tsx`) for label/description/action
  rows — `min-h-11` (44px), title `text-base` (15px), description `text-sm` (14px) tertiary,
  mono hint `text-xs`. Flat, flush-left; no per-row indentation that fights
  flush headers.
- **Section rhythm:** `SectionHeading` is `text-md` semibold with an 18px icon,
  and its spacing is deliberately uneven — 24px above, 12px below — so a heading
  belongs to the rows under it instead of floating between two equal gaps.
- **In-page cards** (spec §5.10) carry `--radius-card` (12px), 12px padding
  for a list card or 16px for content, a `text-base` semibold title, the page
  colour, and **one** `--border-default` hairline — no shadow. An interactive
  card firms its edge to `--border-strong` on hover; it never lifts. No
  card-in-card. Figures use `tabular-nums`.
- **No dividers between rows** unless the list genuinely needs them; prefer
  spacing. When you do need one, it's a single `--border-subtle` line.
- **Account devices are installations.** Keep the current install first,
  other authorized installs below, and revoked records in collapsed history.
  A shared hostname does not establish a shared identity: keep each install's
  id and show registration details when names collide. Custom labels belong
  to the account and never overwrite the hostname. Enable rename only when
  both the service and preload advertise support. Current-install sign-out
  uses local sign-out; revocation of another install reports account access
  and model-key rotation separately, with a retry after partial failure.
  Preserve cached rows through an outage, disable mutations while offline,
  and discard pending results when the signed-in account changes.
- **The technical surface opens on demand.** In Kho tiện ích → MCP nothing
  technical is part of the page: a connection's "Chi tiết" is a dialog (what
  stands between it and working, with its way out; its tools as toggles; the
  hub's word on it; the launch line, the logs and a jump into mcp.json folded
  under `DisclosureRow`s), and the whole mcp.json and every server's logs are
  dialogs from the store bar's ⋯. mcp.json opens only once the config has
  loaded (a whole-map save of an empty map would remove every server), and a
  save writes the person's edits *over the config as it is then*
  (`mergeServers`: what they added, removed or changed wins; everything else —
  a sign-in, an install, a hub sync that landed while the editor was open —
  stays). Every write to the map is queued behind the one before it, so two
  quick switches both land. The dialog never closes on unsaved edits: Esc,
  the backdrop and "Huỷ" turn its footer into "Bỏ các thay đổi chưa lưu?" ·
  "Tiếp tục sửa" · "Bỏ thay đổi". Removing a connection always asks
  (`ConfirmDialog`). A dialog whose first focusable is a control with a
  tooltip opens with `onOpenAutoFocus={focusDialogContent}` — focus inside the
  dialog, on the content itself, with no ring and no tooltip.
- **Tiện ích is three tabs, and every tile is a `StoreCard`**
  (`components/ui/store-card.tsx`). Kỹ năng sẵn có · Công cụ are what AgentX
  has; **Kho tiện ích** is the one store for adding either kind, switched by a
  `size="md"` `SegmentedControl` (Kỹ năng · MCP; each kind keeps its old
  `?tab=` id, `hub` / `mcp`). Each "have" tab's strip leads with the doorway
  to its kind in the store ("＋ Thêm từ kho", "＋ Kết nối phần mềm khác"). Every
  surface lays the same card on the same `StoreCardGrid` (`auto-fill
  minmax(18rem,1fr)`, gap 12), grouped by `StoreCardShelf` — a 14px group
  title in secondary ink, a tabular caption count, at most one caption note
  line, an optional verb at the far end, and an `empty` line when the shelf
  must stay to say it is empty. A card is a flat content card (spec §5.10): the
  page colour under a `--border-default` hairline, 16px padding, and a hover
  that only firms the edge to `--border-strong`. It is glanceable, not
  exhaustive, and reads top to bottom in one order: `StoreCardHeader` (a 32px
  `StoreCardGlyph` tile or `McpAvatar` · 15px semibold name ·
  at most one pill — "Tự học", a version, "Cần thiết lập", "Đang tắt", "Cần
  đăng nhập", "Lỗi kết nối" · the `md` switch), a two-line
  `StoreCardDescription`, an optional `StoreCardTags` row (a newer version sits
  there with its inline "Cập nhật", so the footer never overflows), and a
  `StoreCardFooter` whose left is the way into the detail ("Chi tiết" · "Xem
  trước" · a boxed "Thiết lập") and whose right is a quiet `StoreCardMeta`
  figure or the card's one verb. A switched-off card dims its title to the
  tertiary ink. In the store, **yours come first**: "Đã thêm" / "Đã kết nối"
  hold what this machine runs, managed there; the catalogue shelves below keep
  every card where it stands once added and swap its verb for a "Đã thêm" /
  "Đã kết nối" pill — a card never jumps away from the pointer that pressed
  it. Tags speak the person's words ("Đăng nhập tài khoản", "Cần khoá API",
  "Chạy trên máy này"), never transport or auth jargon. Everything else — the
  raw slug, the source, provider keys and models, the function list,
  edit/share/archive for a learned skill — lives in the card's detail
  `Dialog`, never on the tile. The Công cụ tab offers only providers the
  person configures themselves (subscription-only rows are not rendered).
- **`StoreCardGlyph` takes a `tint`.** With one it renders a *soft*
  `IconTile` (32px, 8px corners, an 18px glyph in the tint on a wash of it —
  § Iconography & brand), so a grid reads each card's kind at a glance;
  without one it stays the neutral `--bg-subtle` tile in `--icon-default`. A
  skill card is tinted by its category (`skillCategoryTint()`), a tool card
  by `tintFor(toolset.name)`, the browser card in Settings blue.
- **`McpAvatar`** is a connection's glyph: the brand mark on a 16% brand tint
  (Messaging's treatment), a letter monogram otherwise, and the live status
  dot. A brand whose mark is black (GitHub, Notion, Vercel) draws in the ink
  on the neutral tile — its own colour disappears on the dark band. Remote
  favicons are never fetched (a private MCP host must not leak off-box).

## Dialogs

- **`DialogContent`** (`components/ui/dialog.tsx`, spec §5.17) is elevation
  level 2 — `--bg-raised` under `shadow-nous` — with 16px corners
  (`rounded-xl`), 24px padding, a 85vh cap with the content scrolling inside,
  over the `--scrim` (32% black, 56% in dark, no blur). Widths: **560px**
  (the default — a form), **440px** (`ConfirmDialog`), **720px** for a content
  dialog (pass it as the width), or `fitContent` to size to the content. It
  opens in 200ms (fade + `zoom-in-98`, `--ease-out`) and closes in 150ms. The
  close ✕ is a ghost `icon-sm` in `--icon-muted`, top-right, untipped.
- **A dialog names itself at `text-lg`** (17px, the spec's `text-title`)
  semibold in primary ink — a dialog is a task, not a page — optionally led by
  an 18px glyph in `--icon-default` (`DialogTitle icon=`). The description is
  `text-base` secondary. The footer is right-aligned with the primary action
  rightmost. The `banner` prop docks a notice flush to the bottom edge in the
  banner tones (`--danger-bg`, `--warning-bg`, `--bg-subtle`).
- Esc and the scrim close a dialog **unless it holds unsaved edits** (then it
  asks, like the mcp.json editor above). Focus stays inside and returns to the
  opener on close.
- **`ConfirmDialog`** (`components/ui/confirm-dialog.tsx`) is the one
  confirmation: 440px, Cancel **first in DOM order** so focus opens on the
  safe choice (Radix focuses the first tabbable), the confirm button rightmost
  (`destructive` for an irreversible act). Enter from the dialog background
  confirms; focused controls own their keys. It owns the pending → done →
  close beat and an inline error row (`--danger-bg`), so a caller passes only
  an async `onConfirm`; `dismissOnConfirm` closes as soon as it resolves. A
  delete confirm's title is a question naming the object ("Xoá “X”?"), its
  body states the consequence, and its button names the verb ("Xoá cuộc trò
  chuyện").
- **`requestConfirm()`** (`components/ui/confirm-request.tsx`) asks the same
  question from imperative code: it resolves `true` on the confirm button and
  `false` on Cancel / Esc / backdrop, rendered by the single
  `ConfirmRequestHost` mounted beside the toasts (`contrib/wiring.tsx`). A
  second request while one is open cancels the first. **Never
  `window.confirm()`** — the OS dialog is unthemed and untranslated.

## Feedback & empty/error/loading states

- **Loading:** `Loader` (`src/components/ui/loader.tsx`). `variant="ring"` —
  a plain 20px ring turning on `transform`, still under reduced motion — is
  what `PageLoader` and every in-page loading state show. The math curves
  (`type="…"`, `lemniscate-bloom` for long ops) stay in the transcript and the
  boot/onboarding surfaces, where thinking is the point. Never ship the
  literal text "Loading…".
- **Skeletons** (`Skeleton`, `CountSkeleton` in `components/ui/skeleton.tsx`)
  wear the `animate-skeleton` utility (spec §2.1 / §3.11): an opacity pulse
  1 ↔ 0.6 over 1.6s on `--ease-in-out` — never a shimmer sweep — that stays
  **invisible for its first 300ms**, so a load that finishes quickly never
  flashes one. The base opacity is 0 and the keyframes state both ends, so the
  element is hidden exactly until the delayed animation starts; reduced motion
  shows it at once, without the pulse. The fill is `--bg-hover`. Shape the
  skeleton like the content it stands in for. This replaced `useDelayedTrue`
  (deleted): a call site renders the skeleton whenever it is loading and the
  utility owns the delay. The spec's 400ms minimum display time is not
  enforced.
- **Errors:** `ErrorState` + the canonical `ErrorIcon` (no bg chip). One look
  for the React boundary, in-dialog errors, and the boot-failure banner. Pass
  nodes for title/description so Radix `DialogTitle`/`Description` can flow
  through for a11y. An error lives **near where it happened** — inline or in a
  banner — and a toast is never its only trace.
- **Logs:** `LogView` — no bg, hairline border, tight padding, small mono.
  Every place we surface raw logs uses it.
- **Empty:** `EmptyState` for plain page bodies; `PanelEmpty` for overlay
  master/detail empties. Don't hand-roll a third centered empty.
- **`DisclosureRow`** (`components/ui/disclosure-row.tsx`) — the page-chrome
  disclosure: one sentence-case 14px medium row with a Tabler caret that
  rotates in place ("Chi tiết kỹ thuật", "Nâng cao (3)", "Xem thêm 8 nền
  tảng"). It is how a page folds its technical tail behind one click; the
  content renders under it when open, indented `pl-5`. The transcript keeps
  its own `DisclosureCaret` (Codicon) — that one is tool-row vocabulary.
- **Banners** (`Alert`, `components/ui/alert.tsx`; `InlineNotice` in
  `components/notifications.tsx`; spec §5.16) — an in-flow notice tied to a
  region: connection lost, a quota running out, an update. Flat — no border,
  no shadow — 12px corners, 10×12 padding, 15px text. The fill is the signal's
  soft background (`destructive` → `--danger-bg`, `warning` → `--warning-bg`;
  `default` and `success` → `--bg-subtle`) and the 16px glyph carries the hue;
  the title is primary ink, the description secondary. One banner per region.
- **A waiting person is a banner, not a number.** A pairing request renders as
  `PairingBanner` (messaging): one card (`--radius-card`, quinary fill, one
  hairline), one sentence — «Tên» muốn nhắn với AgentX qua … — and one primary
  verb ("Cho phép"). It sits at the top of the platform's detail, compact
  copies surface above the list for other platforms, and the sidebar's
  "Tin nhắn" nav row carries the count as a red-tinted badge (fed by
  `store/pairing`, written by the page's own fetch — no extra polling).
- **`EmptyFigure`** (`components/ui/empty-figure.tsx`) — the only illustration
  an empty surface may carry: four 96px monoline figures (`chat` · `folder` ·
  `plug` · `box`), each the mark beside one object, `currentColor` at the
  quaternary ink, `aria-hidden`, no animation. `EmptyState` and `PanelEmpty`
  take it as `figure`; nothing else draws a picture (no stock characters,
  blobs, Lottie, generated art).
- **Three beats.** `EmptyState`, `PanelEmpty`, and `ErrorState` all say the same
  three things in the same order: the **name** of what is missing or broken
  (`text-base` medium — `text-xl` for `ErrorState`, which owns a whole surface),
  the **reason** (`text-base` secondary in `EmptyState`; `text-sm` tertiary in
  `PanelEmpty` and `ErrorState`), and **one action** that resolves it
  (`EmptyState`/`PanelEmpty` take an `action` node; `ErrorState` takes
  `children`). Buttons are concrete verbs — never "OK", never "Oops". Skip the
  action only when the surface already shows it inches away.

**Toasts** (`components/notifications.tsx` + `store/notifications.ts`, spec
§5.15):

- **One stack, 12px above the foreground composer and centred on it**
  (`TOAST_GAP_PX`), plus the safe-area inset — portaled to `<body>` on
  `--z-over-modal` so a toast clears an open dialog, at most 420px wide. The
  composer's height is a per-surface CSS var a body-level portal cannot read,
  so `useToastAnchor()` measures the docked composer itself — the lowest
  visible `[data-chat-surface] [data-slot="composer-dock"]`, i.e. the main
  chat — and follows it through a `ResizeObserver` and window resizes; it
  never covers the composer's top edge. Off a chat page there is no composer,
  and the stack sits 28px above the window's bottom edge, centred on the
  window. There is **no placement API** any more: the old top-centre stack,
  the bottom-right stack and `placement: 'bottom-right'` are gone.
- **Level-1 surface:** `--bg-raised` under `shadow-md`, 12px corners, 10×12
  padding, 15px text, rising 8px into place at `--dur-long`.
- **Structure:** a *filled* status glyph (`AlertCircleFilled` /
  `AlertTriangleFilled` / `CheckCircleFilled` in `--danger` / `--warning` /
  `--success`, `InfoFilled` muted) · the message (an optional title, meta line
  and a folded "Chi tiết" with copy) · **at most one action**, a link
  ("Hoàn tác", "Xem") · ✕.
- **At most two at once** (`VISIBLE_TOASTS`); the newest sits nearest the
  composer and pushes the older one up. Anything beyond waits behind an
  "N thông báo nữa" row beside "Xoá tất cả", so an unhandled error is never
  silently dropped.
  Chat-scoped notices are capped at four kept (`MAX_SESSION_NOTIFICATIONS`,
  the oldest drops); app-scoped notices (`scope: 'app'`) are never pushed out
  and survive a chat switch.
- **Timing:** 4s, **6s when the toast carries an action**; **errors and
  warnings never time out**. Every timer pauses while the stack is hovered or
  holds focus (`holdNotificationTimers` / `releaseNotificationTimers`) and
  resumes with the time each had left. Errors are `role="alert"`, the rest
  `role="status"`.
- **Silent success** still rules (§ Motion): a toast is for what the user
  *cannot* see, for an undo, and for failure — and a failure toast always
  carries what to do next.

**Undo before confirm** (spec §2.3 / §6.4). A reversible action happens
immediately and offers "Hoàn tác": **archiving a chat** removes the row at once
and toasts "Đã lưu trữ “X”" with an Undo that un-archives on the backend and
puts the row and its pin back. An irreversible action asks first: **deleting a
chat** opens `ConfirmDialog` from the row's menu, naming the chat and pointing
to Archive as the reversible way out. Deletes and resets elsewhere (env
credentials, toolset keys, cron jobs, the archived-chats list, Settings reset,
Command Center maintenance) ask through `requestConfirm()`.

## Command surfaces

The palette and the session switcher share `floating-hud.ts` — the spec's
command-palette geometry (§5.12):

- `HUD_POSITION` — centred horizontally, **20vh from the top**.
- `HUD_SURFACE` — elevation level 2: `--bg-raised` under `shadow-nous`
  (whose ring is the edge), 16px corners, `[-webkit-app-region:no-drag]` so a
  short window's titlebar drag band can't swallow clicks.
- `HUD_TEXT` — `text-base` (15px): a palette is read at speed under a moving
  selection and gets no discount.
- `HUD_ITEM` — a 36px **floor** (`min-h-9`) layered on `CommandItem`'s own
  40px row. `HUD_HEADING` — a caption in tertiary ink, own casing.

The command palette is **640px** wide (`min(40rem, 100vw − 2rem)`) over a
light scrim (`--scrim-light`). Its search row (`CommandInput`) is 52px with a
16px (`text-md`) input, borderless, with a `--border-subtle` divider below;
rows (`CommandItem`) are 40px with 10px inline padding and an 18px glyph in
`--icon-muted`, and the selected one sits on `--bg-selected`; a 36px caption footer names the three
keys the palette runs on — "↑↓ di chuyển · ↵ chọn · esc đóng"
(`commandCenter.paletteFooter`).

- **It opens in the frame it is asked for.** The palette has no entry animation
  at all. Its *close* (fade + `zoom-out-98` at `--dur-long-exit`) stays —
  `onAnimationEnd` is what retires the subtree.
- **One highlight, and it slides.** `CommandSelectionIndicator`
  (`components/ui/command.tsx`) is a single `--bg-selected` element that moves
  to the selected row; rows that use it opt out of their own selected fill. It
  runs on a MutationObserver, never React state, so arrowing through a hundred
  rows re-renders nothing — the selection is instant, only the paint follows.
  The global reduced-motion rule collapses the slide to a jump.

## Chat, tools & boot surfaces

- **The home surface is the empty transcript** (`components/chat/intro.tsx`):
  a greeting at the 30px display rung in the Newsreader serif
  (`font-serif-display text-3xl`, regular weight, `tracking-display`,
  `text-balance`), one muted
  16px line (`text-md`, the catalog's `bodyVariants`; `intro-copy.jsonl` only
  in English with a personality) capped at 38rem, then **at most four task
  cards** (`Button variant="card"` on the `.intro-cards` two-column grid,
  capped at 40rem): an 18px Tabler glyph before a 15px medium title over a
  14px one-line description. The composer stays the only CTA; the block leads
  the eye down to it. **The block centres with `justify-content: safe
  center`**: centred while it fits, and once a short window can't hold the
  greeting, the line and the cards it starts at the top and overflows *down*
  into the scroller — never split above the top edge and under the composer,
  which cut the first line and hid the last card. It fronts
  the fresh draft *and* a routed conversation that exists but has no messages
  yet (a new chat in a project) once it has resumed and nothing is running.
  - Every card is grounded in something the app already knows — the session you
    were last in, a project you already added — plus four fixed starters whose
    title, description *and* prompt live in the locale files. **The starters
    take the folder's side**: inside a git repository the coding pair leads
    (explain the code folder, plan a change), anywhere else the office pair
    leads (summarise a document, draft an email, then plan the week and
    explain "this folder"). The same `repoStatusForCwd` probe the composer's
    coding rail uses decides it, so cards, placeholder and branch strip never
    disagree. **Nothing here invents a suggestion**: no recent session, no
    resume card. The selection rule is the pure `introChipSources()` in
    `intro-chips.ts` and the wide slot is `introCardSpan()` (the resume card
    spans both columns and leads — the row is asymmetric on purpose), so both
    are testable without a renderer; `Intro` only renders. Clicking a card runs
    one *existing* action (`openSession`, `requestStartWorkSession`,
    `requestComposerInsert`) — the home surface owns no navigation of its own.
  - The greeting names the user only when the account store actually has a
    display name, and then in full, as the account spells it ("Chào buổi
    chiều, Lê Trung Kiên"). No name, no comma, no invented placeholder.
  - **One entrance, once per app launch** — not once per empty state. The
    greeting rises at `--dur-long`; the body and each card follow on a 40ms
    step at `--dur-short`, all settled by 400ms. `prefers-reduced-motion`
    collapses it to an instant crossfade — the app-wide reduced-motion
    kill-switch (0.01ms, top of `styles.css`) outranks the intro's own fade —
    with no stagger and no transform.
  - **The ground is the glyph field** (`components/glyph-field`, the model in
    `lib/glyph-field.ts`). At rest it is blank paper. A primary click anywhere
    on the chat surface — the greeting, a card, the composer — sends a ring of
    10px JetBrains Mono characters out from the pointer: each one flashes in
    the accent as the edge reaches it and settles into a grey trace, brightest
    where the ring crosses the strokes of a hidden drawing (one per app
    launch), never on open paper. Traces build up over a few clicks and fade
    back to white at one shared rate, so the painter draws only while a ring
    is flashing and hands the fade to the compositor; at rest it holds no
    bitmap and no animation frame. It grounds the empty chat only — characters
    behind a transcript compete with the text — and reduced motion gets blank
    paper. Off is Settings → Appearance → Nền cuộc trò chuyện.
  - The greeting and its line sit in a pool of clear paper (`.intro-head`: the
    surface colour, spread and blurred past the text block), and the cards are
    opaque flat tiles on the page colour, so the field runs right up to the
    words but never under them.
- The transcript and composer are built on `@assistant-ui/react`. Extend the
  existing components under `src/components/assistant-ui` and
  `src/app/chat/composer`; do not fork a second markdown, message, tool-call, or
  approval renderer for one feature.
- **The reading measure.** Paragraphs, list items, quotes and markdown headings
  stop at `--conversation-measure` (72ch); code, tables, diffs and embeds keep
  the full column and bleed past it. A figure may run wider than the measure, a
  sentence may not. The cap is one rule in `styles.css` — don't re-cap a block
  at its call site.
- **The user bubble is speech, not a panel.** It hugs its own text and parks
  against the right edge of the column — `USER_BUBBLE_RAIL_CLASS` (`ml-auto`,
  capped at `--user-bubble-max-width`, `min(85%, 34rem)`) — so a turn reads as
  a dialogue: mine on the right, the reply full width on the left, no bubble.
  Attachments, reactions and the checkpoint strip follow it right; the inline
  edit composer fills the same rail (a field you can't see the end of is worse
  than a slightly wider silhouette). `--radius-bubble` (16px), 14×10px
  padding, the reading size (`text-md` at the prose line-height), the
  `--dt-user-bubble` fill (`--bg-subtle` on Quiet), a `--dt-user-bubble-border`
  hairline (the fill colour itself on Quiet, so it vanishes), and
  `--dt-user-bubble-hover` on hover — at pill size the fill *is* the shape, so
  "click to edit" has to be a fill move, not a border move. **Nothing is
  reserved inside it**: stop and restore hang off the rail to its left, on
  hover, so a two-word prompt is a two-word pill. Its meta (process notices,
  checkpoints, timestamps) sits at the 13px caption — the ramp floor.
- **A long prompt clamps, and the fade is a promise.** `.sticky-human-clamp`
  cuts the body at four lines; the soft bottom mask paints *only* when
  something is genuinely hidden behind it, measured against that clamp's own
  resolved max-height rather than a line count re-derived in JS (the two drifted
  — a three-line prompt used to fade with nothing under it).
- **Inline widgets** — a tool result that renders as a panel the user reads or
  acts on (clarify, artifact card) wears `WIDGET_SHELL_CLASS`
  (`src/components/chat/widget-shell.ts`): `--radius-card`, the
  `--ui-widget-surface-background` fill under a `--border-default` hairline
  (the card voice — on the Quiet page the fill alone is invisible). Its actions sit *outside*
  the panel, below it, on the normal control ramp (a widget's primary action is
  a real 36px button, not statusbar-dense chrome). Don't give one widget its own
  radius or fill.
- **Fenced code** rides `CodeCard` (`src/components/chat/code-card.tsx`, spec
  §5.19): `--bg-subtle` under a `--border-subtle` hairline, 12px corners
  (`rounded-lg`), 14px mono at 1.54 (`--conversation-code-font-size`/`-line-height`),
  12×16 padding, scrolling sideways inside the block. `CodeCardHeader` is one
  36px row — the language on the left as a caption in the UI face, tertiary (a
  language is a proper name: its own casing), the copy control on the right at
  `size="icon-sm"`. No divider under it; the padding is the separation. Copy
  answers in place — the glyph becomes a check and the label becomes "Đã chép"
  for 2s (`COPIED_RESET_MS`). Never a toast, and never fake window chrome (no
  red/yellow/green dots).
- **Inline code** is `0.92em` of its sentence, mono, on `--bg-hover`
  (`--ui-inline-code-background`), 1×5px padding, 6px corners.
- **Tables in a reply** (`markdown-text.tsx`): a `--border-default` frame with
  12px corners that scrolls sideways inside itself; a `--bg-subtle` header row
  in 15px medium primary ink; 36px rows at 15px, split by `--border-subtle`,
  `tabular-nums`.
- **A fence that is still streaming gets exactly one motion primitive:** it
  rises into place at `--dur-short-exit`, and its body carries a soft bottom
  mask. No pulsing halo — a coloured glow around a card is banned on any
  surface, and a second loop would compete with the text actually arriving.
- **A reply carries no badge.** The assistant's prose starts on the column's
  left edge with nothing above it — no brand mark heading the turn, before,
  during or after the reply (review: a logo over every answer was noise).
  Who is speaking is already clear from the layout: the user's bubble on the
  right, the unbubbled reply full width.
- **A wait is three typing dots.** Before the first token the thinking row
  (`ResponseLoadingIndicator`) is `TypingDots` (`components/chat/typing-dots.tsx`:
  three 5px dots in tertiary ink, each rising 2px and brightening in turn —
  a message app's "typing" wave, transform and opacity only) beside
  "Đang suy nghĩ…" (`assistant.thread.thinking`, or the named wait when there
  is one) and the elapsed timer. The label shimmers on the same 1.4s lap
  (`--thinking-lap-ms`) — the stock `shimmer`, its band narrowed to 5ch so it
  passes through the phrase instead of dimming it. When the stream goes quiet
  mid-turn the same row returns at the tail (`StreamStallIndicator`). The
  motion runs only while it can be seen (`useAmbientMotion`: window focused
  and on screen, pane visible, no reduced motion); otherwise the dots rest
  even and half-bright and the label is plain, the timer still ticking.
- **Tool rows are scaffolding, not cards.** They stay transparent and faded
  (`data-conversation-scaffold`) so the prose column reads first. One voice
  for all of them: `SCAFFOLD_LABEL_CLASS` (14px regular at
  `--conversation-scaffold-text`, secondary ink on Quiet) for the name,
  `SCAFFOLD_META_CLASS` (`text-xs tabular-nums`) for counts, durations and
  diff stats. The name is the human one from the catalog's
  `assistant.tool.titles` ("Đã đọc tệp", "Đang tìm trên web"); the tool's real
  name rides the row's hover. Do not box a tool row into a widget shell.
- **An opened step hangs under its row** (spec §5.19): the detail is indented
  12px behind a 1px `--border-default` rule on its left — no box around the
  step, no rule under the row. Field labels above a payload ("stdout", "Search
  results") are a caption in tertiary ink, their own casing; raw payload dumps
  are caption-size (13px) mono.
- **Tool state is a glyph *and* a colour, from the semantic tokens.** Running
  is the breathing spinner, error `destructive`, recovered `--ui-yellow`,
  delegate-done `--ui-green`, diff counts `--ui-diff-add-foreground` /
  `--ui-diff-remove-foreground`. Never a raw Tailwind ramp (`amber-600`,
  `emerald-400`) — those don't move with the theme. The same trio (plus
  `--ui-info` and `--ui-purple`) colours the markdown alert embeds
  (note · tip · important · warning · caution), the status-stack rows, the
  review file tree, the console levels and the emoji picker's cell tints;
  the only fixed hues left in `src/` are the sixteen ANSI colours in
  `lib/ansi.ts`, which are a terminal's own palette, not a status.
- Bordered surfaces in the transcript (tables, fences, callouts, attachments)
  use the semantic hairlines — `--border-default` for a frame,
  `--border-subtle` for a divider or the code card's edge. Not `border-border`
  — that's the shadcn app-wide default.
- **"↓ Mới nhất"** (`scroll-to-bottom-button.tsx`, spec §6.5) appears when the
  reader has scrolled up while content keeps arriving: a 32px level-1 pill
  (`--bg-raised`, `shadow-md`, full radius) centred 12px above the composer,
  a 16px arrow and the word, in secondary ink. While an approval waits it
  names that instead, in `--accent`. Sending always scrolls to the bottom.
- **The composer is the focus of the chat screen** (spec §5.7) and needs no
  ring to say so: an **opaque** surface (`--composer-fill` = `--bg-app` in
  every state — the transcript never shows through, no backdrop blur) under a
  `--border-default` hairline, **16px corners** (`rounded-xl`), **no shadow**.
  Hover and `:focus-within` firm the edge to `--border-strong` — never the
  accent — at `--dur-micro`. The message field is 15px (`text-body`). The
  composer sits **16px above the window's bottom edge**
  (`--composer-shell-pad-block-end`). One input line is **50px** (the spec's
  48px min-height, scaled with the ramp): `--composer-surface-pad-y` (6px)
  around the 36px control row (`--composer-control-size`), inside the 1px
  border — still a single line; it grows only as the text
  wraps (to `--composer-input-max-height`). The cards docked to it (status stack, queue) share the opaque fill
  and a `--border-default` edge; the completion drawers and the `+` menu are
  the level-1 popover surface (`composerPanelCard`: `--bg-raised`,
  `shadow-md`, 12px corners, 14px type); the floating micro-action pills are
  28px, `--bg-app` under a hairline. The drag-to-dock target is the shared
  drop sheet (a 2px dashed `--border-strong` edge on `--bg-subtle`) firming as
  the composer nears it — no coloured glow.
- **External messaging transcripts are live, branded, and read-only.** Their
  sidebar conversation row carries the platform avatar; a visible header above
  the transcript pairs its title with a quiet, logo-bearing platform `TagChip`.
  The transcript continues to stream through the normal session runtime, but
  composer, prompt overlays, edit/restore, retry, reactions, branching,
  file/session drops, dragging the session onto the composer or a tile,
  rename, pin and project moves are absent (a pinned transcript still
  reorders within Pinned). The row's ⋮ and right-click menus, and the context
  menu of a tab showing the transcript, hold one destructive item, "Delete
  from Workmate" ("Xoá khỏi Workmate"): it removes Workmate's local copy — the
  row, its compression lineage and the on-disk transcript — never the
  messages on the platform. A row pinned before its platform became read-only
  also offers Unpin, so the pin is never stranded. These transcripts sit in
  their platform section (or Pinned), never in Home or a project group. A flat
  footer names the source and tells the user to reply in that platform. Copy
  and read-aloud remain available because they do not mutate the conversation.
- **The composer's voice follows the folder.** Inside a git repo it is a
  coding surface: the branch strip caps the card, the model pill carries
  the full label with its effort (`Qwen3.5 122B A10B FP8 · Med`) and the
  placeholder asks about the code (`newSessionPlaceholdersRepo`). Anywhere
  else — a documents folder, a detached chat — the strip is gone, the pill
  wears the model's short name alone (`conciseModelName`: family + version,
  no build words, no effort; the tooltip and the picker keep the full id) and
  the placeholder asks what you need today (`newSessionPlaceholders`). One
  probe, `repoStatusForCwd`, decides all three, so they never disagree.
- **The control row is three stops** — model pill · voice ⋯ · send. The send
  slot is one place that says one of three things: with something to send,
  a **32px round `--bg-inverse` button** (`--composer-control-primary-size`)
  with an up arrow
  (`PRIMARY_ICON_BTN` — the one filled control in the row, never the accent;
  disabled it is a bare muted glyph); with an empty box, a **ghost
  microphone** (start a voice conversation) — nothing to send yet, so nothing
  in the row is filled; while a turn runs, the same circle becomes Stop (■).
  Dictation, read-replies-aloud and the wake word sit
  behind the ⋯ (`composer.voiceMenu`) while voice is enabled — the resting row
  is never a strip of crossed-out icons — and a dictation in progress puts its
  stop control in that slot instead. Ghost controls are `--icon-muted` over
  `--bg-hover`. The `+` says what it does: "Đính kèm tệp, ảnh hoặc thư mục".
- A tool result may expose an inline action that opens a preview. It must not
  open the rail automatically.
- **A file the agent made is a card, not a path.** `FileCard`
  (`components/chat/file-card.tsx`) is the hand-over: one `WIDGET_SHELL_CLASS`
  row — the file-tree's `FileTypeIcon` in a 32px tile, the name at `text-sm`
  medium, "Tài liệu · 24 KB" under it in the tool size, the agent's caption
  if it gave one — that opens the preview rail on click, with the two everyday
  verbs as real `size="sm"` buttons under the panel ("Tải xuống" secondary,
  "Hiện trong Finder" ghost) and the rest (open with the OS app, Quick Look,
  copy path) on right-click through `DeliverableContextMenu`. It appears for
  a `deliver_file` tool result and for a `MEDIA:` tag naming a non-media file;
  images, audio and video keep rendering in place. A file that is no longer on
  disk says so on the card (`--ui-yellow` plus the warning glyph, actions
  hidden) instead of failing on click. A path the reply merely *mentions*
  ("đã lưu tại /…/bao-cao.docx") is `FileChip` — the same icon and name as an
  inline `.ref` in the sentence, the full path on hover, the same click and
  menu — so prose keeps its flow. The files a turn produced without handing
  over (a script's stdout named them) close the turn as `CreatedFilesCard`,
  the changed-files card's sibling: one row per file, open on click, save on
  the hover control, and it stays with its turn. All three share one action
  home, `store/deliverables.ts`; none of them opens the rail on arrival.
- **The rail shows documents, not bytes.** A file target's `previewKind`
  now routes `pdf` to Chromium's own viewer in the preview webview, `document`
  to `preview-document.tsx` (a .docx as sanitised HTML in a frame that can
  only paint, an .xlsx as one table per sheet with a sheet strip; anything
  else in the family offers Quick Look / the OS app / a saved copy), and
  `media` to the same seekable player the transcript uses. `binary` is what is
  left — an archive — and it offers the same ways out rather than "preview
  anyway".
- **The connect splash** (`components/gateway-connecting-overlay.tsx`,
  `data-slot="connecting-splash"`, `role="status"`) is the platform's way of
  saying "working": the AgentX mark (`BrandGlyph`, 44px, primary ink) and
  under it, 20px down, the `ActivityIndicator` (16px, tertiary ink) beside one
  plain 15px line in secondary ink — the catalog's `boot.connecting` `word` +
  `target` + "…" ("Connecting to AgentX server…" in English). Nothing
  scrambles: the old `DecodeText` decode is gone from this screen (the
  primitive lives on elsewhere). The group arrives after a 150ms beat (a fade
  with a 4px rise, `animate-in fade-in-0 slide-in-from-bottom-1`), so a warm
  connect shows nothing at all, and leaves with a fade and a slight scale to
  .98. Cold boot only: a post-boot socket drop reconnects behind the shell,
  never behind this overlay. The onboarding title sits at the 26px
  `text-2xl` rung, medium, sans, with no colour block behind it.
- **`ActivityIndicator`** (`components/ui/activity-indicator.tsx`) is the
  platform's indeterminate activity indicator: twelve rounded spokes in
  `currentColor` whose opacity falls off around the dial, the dial turning in
  twelve discrete steps per second (`activity-spin`, `steps(12)` — the system
  indicator's own rhythm, never a smooth spin). Reduced motion holds it still;
  the falloff alone still reads as "working". Pass `label` when it stands
  alone (it becomes `role="img"`); beside a sentence it is `aria-hidden`.
- **Inference belongs to AgentX AI Gateway.** Sign-in, onboarding, model
  pickers and Settings never offer another inference provider or endpoint.
  Gateway failure offers retry or Skip; Skip opens the shell without claiming
  AI is ready. Backend resolution enforces the same policy for account homes.
- **Model catalogs follow the account's grant.** Chat refreshes on opening,
  returning to the window, reconnecting, and once a minute while visible;
  opening a model picker also refreshes. An idle send checks again before
  creating or using its conversation. Preserve a model that is still granted;
  replace a retired one between turns through the existing session switch,
  without discarding history. Keep cached rows during connectivity failures
  and retain Refresh Models as recovery. Refreshing never rotates the account key.
- Install, onboarding, connecting, boot failure, and reauthentication are
  distinct states with shared visual primitives. Preserve their recovery
  semantics when unifying appearance.
- **The sign-in gate** (`components/sign-in-overlay.tsx`) is a split welcome
  surface: the product mark and a short introduction on the sidebar surface,
  with the account action on the card surface. Its scoped stylesheet collapses
  to a brand header and one form column below 768px; short windows scroll
  vertically. Use the bundled sans, theme colors, and `Button size="xl"`.
  Keep button labels short in every state; browser instructions and reconnect
  details belong in the polite live region below. Errors use an inline alert.
  The non-dismissable modal owns keyboard focus, and the subordinate gateway
  settings view keeps a way back. Authentication remains with the native bridge.
- **Boot surfaces speak the app's language, never the main process's.** The
  main process reports progress and failures as English log lines. The
  renderer translates by *phase* (`lib/boot-phase-label.ts`, with the dynamic
  part — a URL, a path — carried separately as `detail`) and by *failure kind*
  (`components/boot-failure-kind.ts`), never by parsing prose. A new phase or
  failure shape gets a catalog entry, not a string match in a component.
- **The boot-failure overlay explains, then acts.** An `ErrorState` title and
  one-sentence reason chosen by the failure kind, a numbered "what to do" list,
  the action that fixes *this* kind first (`size="lg"`), and everything
  technical — the verbatim error, recent logs, a copy that grabs both — folded
  under "Technical details". The raw message is for the support ticket; it is
  never the first thing a person reads.
- Respect `AppShell` overlay ownership. Persistent terminal/content layers,
  route overlays, dialogs, and boot surfaces must not compete through ad-hoc
  z-index literals. Pick a rung of the ladder in `styles.css` instead —
  `--z-modal-backdrop` / `--z-modal` / `--z-modal-popover`, `--z-over-modal`
  (toasts, tooltips, command surfaces) and `--z-over-modal-content`,
  `--z-switcher-backdrop` / `--z-switcher`, then the boot chain
  `--z-connecting` → `--z-onboarding` → `--z-setup` → `--z-crash`. Plain
  `z-10`/`z-20` are still right for stacking *within* one component.

## Iconography & brand

- **Tabler** is the page chrome's only icon set — sidebar nav and rows,
  titlebar, tabs, page buttons, empty states, the master/detail chrome. Import
  its curated aliases and `iconSize` scale from `src/lib/icons.ts`; do not
  import icon packages directly in feature code. Sidebar nav glyphs sit at
  20px (`size-5`), buttons, menu and palette rows at 18px (`size-4.5`), icon
  buttons at 20px — one step above the spec's 18/16/20 with the type.
- **One outline weight** (spec §3.10): `svg.tabler-icon { stroke-width: 1.5 }`
  in the base layer of `styles.css`, set once rather than per call site — a
  deliberate `stroke-[…]` utility (a 12px check that needs more weight) still
  wins. **Status glyphs are the filled set** (`AlertCircleFilled`,
  `AlertTriangleFilled`, `CheckCircleFilled`, `InfoFilled`), so a state never
  reads as an action.
- **`Codicon`** is the compact editor/tool/status vocabulary, and it is allowed
  only in the transcript, terminal, editor and file tree (plus an icon name a
  plugin contributes as data). Use `src/components/ui/codicon.tsx`, including
  `codiconIcon()` where a Tabler-shaped component is required. A Codicon in
  page chrome is a bug. **One sanctioned extension:** the Artifact library's
  file rows lead with `FileTypeIcon` — a file-type icon is the file-tree
  vocabulary, and a per-extension Tabler duplicate would fork the mapping.
- **Skill categories have one glyph table.** `lib/skill-categories.ts` maps a
  normalized category slug to a Tabler icon, a tile tint and an i18n label
  (`skills.category.*`); `skillDisplayName` turns a kebab slug into the
  human name (the raw slug stays under "Chi tiết kỹ thuật"). Unknown
  categories fall back to the "general" box + `prettyName`.
  `skillCategoryTint()` reads the curated `CATEGORY_TINTS` — chosen, not
  hashed, so a colour means something and neighbouring shelves never collide
  (email and social-media blue, note-taking yellow, smart-home green,
  productivity orange, research teal, media red, creative pink,
  autonomous-ai-agents purple, mlops and software-development indigo; apple,
  github and general graphite); an unknown category gets a stable hashed one.
- **Tile colours** (`components/ui/icon-tile.tsx`) — a deliberate deviation
  from the spec's colour-only-as-a-signal rule, from the review (an all-grey,
  all-black UI read flat and heavy). The `--tint-*` palette is the platform's
  system colours a shade quieter, one set per mode in `tokens.css`: `blue`,
  `green`, `orange`, `red`, `purple`, `pink`, `teal`, `indigo`, `yellow`,
  `graphite` (`TINTS`, type `Tint`). **Tints mark which place or which kind —
  never text, never a state** (state stays with `StatusPill` and the signal
  trio). `IconTile` puts a glyph in a rounded colour tile: `variant="solid"`
  is the Settings look — the full tint under a white glyph — kept to small,
  scannable rails (the overlay rail); `variant="soft"` (the default) is the
  quiet form for grids of cards — the glyph in the tint on a 13% wash of it
  over `--bg-app` (22% in dark) — so a page of forty cards reads calm. Sizes:
  `sm` 24px tile, 6px corners, 14px glyph; `md` 32px, 8px corners, 18px
  glyph. `tintFor(seed)` gives a stable tint for a name (FNV-1a over the
  lowercased string, so short similar names spread across the palette) and
  never returns `graphite`, which stays for "system" things chosen on
  purpose. Where colour appears: the overlay rail (solid, `OverlayNavLink.tint`),
  `StoreCardGlyph tint` (soft), and the sidebar's four destination glyphs
  (bare tinted glyphs, no tile — § Navigation chrome).
- Pick the vocabulary by semantic context and reuse the existing icon for an
  action. Do not introduce a third icon set or mix styles within one control
  group.
- **`BrandMark`** (`src/components/brand-mark.tsx`) is the brand plate — the
  AgentX mark (the geometric ring logo) on its own dark tile, softly rounded,
  identical in light/dark. It replaced scattered Sparkles glyphs in updates /
  onboarding / about. Use it for hero/brand moments; don't reintroduce
  decorative star/sparkle icons.
- **`BrandGlyph`** (`src/components/brand-glyph.tsx`) is the mark as a 20px
  (`size="md"`) or 14px (`size="sm"`) `currentColor` line-art glyph — the
  connect screen, the sign-in art and the `EmptyFigure`s — built from
  `lib/brand-mark-path.ts`, the one geometry every drawing of the mark
  shares: re-fit the numbers there and they all follow. It no longer heads
  replies or traces itself (the one-stroke route and its pen were removed).

## Motion

- **Tokens only** (spec §3.11). Durations: `--dur-micro` (120ms — hover,
  colour change), `--dur-short` (160ms — popover, menu), `--dur-long` (200ms —
  dialog, toast, overlay, entrance), `--dur-collapse` (180ms — a group or
  disclosure opening, its caret turning), `--dur-sidebar` (220ms — the sidebar
  sliding or resizing). **Exits run faster than entries**, and that is a
  token too: `--dur-micro-exit` (80ms, the tooltip's fade-out) ·
  `--dur-short-exit` (100ms) · `--dur-long-exit` (150ms). Curves: `--ease-out`
  `cubic-bezier(0.2, 0, 0, 1)` (enter, open), `--ease-in`
  `cubic-bezier(0.4, 0, 1, 1)` (exit, close), `--ease-in-out`
  `cubic-bezier(0.4, 0, 0.2, 1)` (move, resize, in-place morph). Focus rings
  appear instantly — never transitioned.
- **Enter/exit utilities come from `tw-animate-css`** — a direct dependency
  (`package.json`), imported in `styles.css` right after Tailwind:
  `animate-in` / `animate-out`, `fade-in-0`, `slide-in-from-*`, `zoom-in-*`,
  `fill-mode-*`. Every popper, dialog and toast entrance in this file rides
  them. Until the review round it was never imported, so every
  `animate-in/out` class in the app was silently inert — if an entrance stops
  playing, check the import first.
- **No bounce, no overshoot, no parallax.** `--spring-pop` and
  `--spring-reveal` survive as names so the physical call sites (reaction pop,
  particle burst, drag-reorder settle, the pet hatching) stay distinguishable,
  but both now equal the enter curve and settle without overshooting.
- **The Web Animations API can't read CSS vars,** so `src/lib/motion.ts` is the
  JavaScript mirror of these tokens (`EASE_OUT`, `SPRING_POP`, `DUR_SHORT_MS`,
  …). Those two files are the *only* places in `src/` where a literal
  `cubic-bezier()` may appear; change a curve in one and change it in the
  other. A WAAPI call or a drag library's easing string imports from there.

**Recipes** — the whole motion vocabulary, so nothing has to be invented:

| Interaction | What moves | Duration · curve |
| --- | --- | --- |
| Hover on a control | `background-color`, `border-color`, `color` | `--dur-micro` · `--ease-out` |
| Press | the fill (`--bg-pressed`, or opacity .80 on an inverse/danger fill) | `--dur-micro` |
| Menu / popover / select opening | `opacity` + a 4px rise from the anchor side (`MENU_MOTION`) | `--dur-short` · `--ease-out`; closes `--dur-short-exit` · `--ease-in` |
| Tooltip | `opacity` only, after the 500ms hover delay | `--dur-micro` in, `--dur-micro-exit` out |
| Dialog | `opacity` + scale .98 → 1 | `--dur-long` · `--ease-out`; closes `--dur-long-exit` · `--ease-in` |
| Toast arriving | `opacity` + an 8px rise | `--dur-long` · `--ease-out` |
| Disclosure caret / group open | `rotate` (90°) | `--dur-collapse` · `--ease-in-out` |
| Scaffolding lifting out of its fade | `opacity` | `--dur-micro` · `--ease-out` |
| Overlay / boot surface arriving | `opacity` (+ the surface's own stagger) | `--dur-long` · `--ease-out` |
| Connect splash group | `opacity` + a 4px rise in, after a 150ms beat; `opacity` + scale → .98 out | in: 500ms · `--ease-out`; out: `--dur-long` · `--ease-in` |
| `ActivityIndicator` | `transform` (rotate), twelve discrete steps | 1s per turn, `steps(12)`, infinite; reduced motion → still |
| Anything leaving | the property it entered on | the paired `--dur-*-exit` · `--ease-in` |
| Reaction / particle / reorder settle | `transform`, `opacity` | `--dur-long-exit` · `--spring-pop` (no overshoot) |
| Page-tab underline sliding (`PageTabs`) | `transform`, `opacity` (its width snaps) | `--dur-short` · `--ease-in-out`; reduced motion → a jump |
| Card hover (`Button variant="card"`, `StoreCard`) | `border-color` (`--border-default` → `--border-strong`) | `--dur-micro` · `--ease-out` — never translate, never scale, never a shadow |
| Skeleton (`animate-skeleton`) | `opacity` 1 ↔ 0.6 | 1.6s · `--ease-in-out`, starting after 300ms; reduced motion → shown, still |
| Glyph field ring (canvas, see § Chat) | each character's alpha and tint, every frame while a ring flashes; the trace's fade as the canvas's `opacity` | edge eases out over 2.4s; flash 420ms and trace 3.2s time constants (`lib/glyph-field.ts`); reduced motion → no ring |
| Thinking row (`TypingDots` + the label's `shimmer`) | each dot's `opacity` and `translateY` (2px), a beat apart; the shimmer band | 1.4s lap (`--thinking-lap-ms`), `--ease-in-out`, dots 15% apart; shimmer 1.8s with a 0.4s rest; unfocused, hidden or reduced motion → still dots, plain label |

- **The command palette opens in the frame it is asked for** — no entry
  animation at all; only its close animates. A command surface is used at
  speed and an entry animation is a tax on every use. Menus, popovers and
  dialogs take the spec's short entrance instead (above): a fade with a 4px
  rise or a .98 scale, never an overshoot.
- **Tooltips: 500ms on hover, 0ms on focus, then instant.** `TIP_DELAY_MS` is
  long enough that a cursor crossing a toolbar never lights one up in passing;
  Radix applies it to pointer opens only, so keyboard focus still shows the tip
  in the same frame. Once a tip is showing, the next trigger touched within
  300ms opens instantly (`skipDelayDuration = 300`, spec §5.13) — reading
  along a toolbar is one gesture, not a 500ms wait per button.
- **Silent success.** An action whose result is visible on screen says nothing:
  renaming a session repaints its row, pausing a cron job flips its state pill,
  copying fills the clipboard and the control answers in place. Toasts are for
  what the user *cannot* see (a background job started, a credential saved),
  for an undo, and for failure — and a failure toast always carries what to do
  next.
- Quick, functional transitions (~120ms on controls). Under
  `prefers-reduced-motion` the app-wide kill-switch drops every transform; at
  most a fade remains.
- Choreographed exits (e.g. onboarding's "matrix" fade-down) stagger per-element
  then settle the surface — the outer container's fade is *delayed* so it
  doesn't swallow the inner animation. Don't let a global fade race the detail.
- Motion follows state; it never delays state. Selection, drag targets, cancel,
  and pressed feedback paint in the current frame.
- Do not animate layout geometry with `transition-all` on a hot interaction.
  Name the properties, avoid backdrop-filter repaints during movement, and
  remove animation before masking a performance problem.

## Direct manipulation & performance

The app should feel instant under real load — long transcripts, several panes,
live streams. Design toward that:

- Direct manipulation paints first; persistence reconciles after and rolls back
  visibly on failure.
- Keep interaction feedback cheap: hot-path state stays local or narrowly
  derived, not wired into heavy trees; pointer work coalesces per frame.
- One drop region has one visual owner, and drop targets speak one affordance
  language across files, sessions, tabs, and panes: `DROP_SHEET_CLASS`
  (`components/ui/drop-affordance.tsx`, spec §6.6 / §7 "Drag-over") — a 2px
  dashed `--border-strong` edge on `--bg-subtle`, 16px corners, flat, no blur;
  the chat drop overlay says only "Thả để đính kèm". Overlapping targets
  resolve to the active one instead of stacking overlays.
- Forgiving geometry beats pixel-perfect triggers; edge actions live near their
  edge, not clustered in the center.
- Expensive stateful surfaces stay mounted when hidden. Visibility is not
  lifecycle.

Prove speed with realistic content. A fast empty-state demo says nothing about a
long transcript or a busy terminal.

## Keyboard & cancellation

- Keyboard ownership follows focus. The focused surface wins its keys; shell
  shortcuts must not steal a terminal's or editor's bindings.
- Register global shortcuts through the shared layer
  (`lib/keybinds/actions.ts`), not ad-hoc listeners. Every default is
  rebindable.
- **Defaults follow the spec** (§8.1): ⌘K the palette, ⌘N a new chat, **⌘\
  toggles the sidebar** (⌘B stays for muscle memory), **⌘⇧\ flips the panes**
  (moved off ⌘\ to make room), **⌘] / ⌘[ the next / previous chat** (beside
  ⌃Tab / ⌃⇧Tab), ⌘⇧F focuses chat search, ⌘, opens Settings. Don't override
  OS or browser chords (⌘W, ⌘T, ⌘L, ⌘R…); a single-key shortcut (`/`, `?`)
  works only when focus is not in a text field. Every shortcut is
  discoverable from a tooltip or a menu row.
- **Never act on Enter mid-composition.** `lib/ime.ts` is the one guard:
  `isImeComposing(event)` (`isComposing`, or Chromium's legacy 229 keyCode at
  composition boundaries) and `shouldSubmitOnEnter(event)`. An Enter while
  Vietnamese Telex/VNI, Japanese, Chinese or Korean input is composing
  confirms the conversion; it must never submit, and never steer a trigger
  menu with the arrows. The chat composer (which also tracks
  `compositionstart`/`end`), the inline edit composer, the clarify widget and
  the kanban board use it, and it is exported through the plugin SDK (`sdk/index.ts`) so plugins
  share it instead of forking one.
- One cancel gesture does one thing: cancel the active interaction, or close the
  topmost dismissable surface — never both, never the control underneath.
- Cancellation is synchronous in the UI even if cleanup is async: overlays,
  cursors, and pending gesture state clear at once.
- Flows that deliberately cannot be dismissed (install/onboarding, destructive
  confirmation) must make that explicit.

## i18n

- Every user-facing string goes through `useI18n()` (`src/i18n/context.tsx`).
  No literals in JSX.
- **Vietnamese is the source.** `vi.ts` is a full `Translations` (the
  compiler refuses a missing key) and the default locale; write a new string
  there first, in the product's own words (see the glossary in
  `UI-REDESIGN-PLAN-V2.md` §2.7 — "Trò chuyện mới", "Tiện ích", "Artifact"),
  then translate.
- **Update all locales together** — `vi`, `en`, `ja`, `zh`, `zh-hant`, `ar`. A
  string change that skips the others is a regression (drifted punctuation,
  stale labels). Keep trailing-punctuation and tone consistent across all six
  (`defineLocale` falls back to English for a missing key, but fallback is a
  safety net, not a translation).
- **One word for one thing, everywhere** (spec §9.2). A chat is always
  "cuộc trò chuyện" ("Trò chuyện" as a short label) — in the sidebar, the
  palette, Settings and Command Center alike, not only in the product's own
  pages. "Phiên" survives only where it means a sign-in or runtime session
  ("phiên đăng nhập", a gateway session) and in "phiên bản" (a version). The
  rest of the glossary still holds: never `gateway` ("AgentX" or "dịch vụ nền
  AgentX"), `toolset` ("công cụ"), `repo` ("thư mục mã nguồn"), `key` for an
  API key ("khoá API"), nor a `Shift` / `⌘` gesture inside a sentence — a
  shortcut is a hint in a keybind label, never the instruction. Proper nouns
  (a Twilio "Auth Token", a `agentx gateway` command) are not the banned words.
- **The system never says "tôi"** (spec §9.1). It addresses the person as
  "bạn" and names itself "AgentX" ("AgentX đọc tài liệu…", "AgentX đã trả lời
  xong"); "Chúng tôi đã mở…" is "Đã mở…". "Tôi" appears only where the words
  are the user's own (an example prompt, "Về bản đồ của tôi").
- **Sentence case, calm voice.** Capitalise the first word only; no all-caps
  emphasis ("ĐÃ THAY ĐỔI" → "đã thay đổi"), no exclamation marks, no emoji in
  system copy ("Đã sao chép!" → "Đã chép"). Buttons start with a verb and
  never say "OK" or "Có/Không". Don't blame the user.
- **Dates and ages follow the language.** `lib/time.ts` formatters
  (`fmtClock`, `fmtDayTime`, `fmtMonth`, `relativeTime`…) rebuild on
  `setTimeFormatLocale`, which `setRuntimeI18nLocale` calls with the
  BCP-47 tag (`localeToBcp47`) — so a Vietnamese app never labels a month
  "August" because the Mac is set to English, and unit tests (no locale set)
  keep the runtime's own.

## State (TypeScript)

The detailed state contract lives in the scoped
[`AGENTS.md`](./AGENTS.md). Visual code follows these essentials:

- Shared/cross-component state → small **nanostores**, not prop-drilling.
  Each feature owns its atoms; shared atoms live in `src/store`.
- Rendering components subscribe with `useStore`; non-render actions read with
  `$atom.get()`.
- Subscribe to derived coarse facts instead of high-frequency source atoms when
  the component does not render the full value.
- Colocated action modules over god hooks. A hook owns one narrow job.
- Keep persistence beside the atom that owns it. Route roots stay thin.
- Prefer `interface` for public props; extend React primitives
  (`React.ComponentProps<'button'>`, `Omit<…>`).

## Affordances

- **Cursor** (spec §7): `pointer` belongs to **links and navigation rows
  only** — `a[href]`, `[role=link]`, `[data-nav-row]` and the `row-hover`
  utility every clickable list row already wears (plus the sidebar's nav rows,
  group headers and account row, which set `cursor-pointer` themselves).
  Buttons, menu items, switches and tabs keep the platform's default arrow,
  the desktop convention. Don't hardcode `cursor-pointer` on a button.
- **One focus ring, app-wide.** `styles.css` kills the native outline and
  Tailwind's `ring-*` shadow, then gives *keyboard* focus a single tokenized
  outline: `--ui-focus-ring-width` (2px) of `--ui-focus-ring` (= `--accent`)
  at `--ui-focus-ring-offset` (2px). The offset is load-bearing — it paints the
  surface behind the control between fill and ring, so the ring stays legible
  on a filled button. Never transitioned; it must be there in the frame focus
  lands. Text-entry controls (`.desktop-input-chrome`, `contenteditable`) and
  menu/option rows (`[role=menuitem|menuitemcheckbox|menuitemradio|option]`)
  opt out: a field paints its own accent edge plus the two-layer
  `--focus-ring`, and a row carries focus in its highlight background.
  `data-focus-ring="none"` opts a one-off out.
  - **The ring is the accent at full strength — a deliberate deviation.** The
    spec states the ring at 60% of the accent; at that strength a 2px blue
    ring on white measures 2.6:1, under the WCAG 1.4.11 3:1 floor for a focus
    indicator. At full strength it is 5.2:1. Clarity outranks quiet (the
    spec's own priority order).
  - **"Keyboard focus" is the root gate, not `:focus-visible`.** Chromium
    latches into keyboard modality the moment anything moves focus with a key,
    and a Radix menu does that to itself — so after one menu, plain mouse
    clicks matched `:focus-visible` and drew rings that outlived the pointer.
    `lib/input-modality.ts` stamps the real device on `<html>` and the rule
    only fires under `html:not([data-input-modality='pointer'])` — the CSS
    twin of `suppressNonKeyboardFocusOpen` in `tooltip.tsx`. Phrase any new
    rule as `:not(…pointer)`, never `= keyboard`: an unstamped root must still
    get rings. `focus-ring.test.ts` matches real elements against the real
    selector; menu rows are the case that regresses.
- **High-contrast mode** (`@media (forced-colors: active)` in `tokens.css`,
  spec §10): the OS forces `box-shadow` to none, and every elevation level and
  the field focus ring are box-shadows — so menus, selects, popovers, dialogs,
  toasts, tooltips, the composer, the code card, store cards, switches and
  checkboxes get a real `1px CanvasText` border, and a focused field a 2px
  `Highlight` outline. Icons already paint with `currentColor`. A new floating
  or bordered primitive joins that selector list.
- **Skip link.** `SkipToContent` (`app/shell/skip-to-content.tsx`, mounted in
  `contrib/controller.tsx`) is the first focusable element in the window —
  "Bỏ qua đến nội dung", invisible until keyboard focus lands on it, an
  inverse chip top-left. It is a button, not an `href="#…"` link (the app
  routes on the hash), and focuses the open transcript, else the page's
  `main`, else the composer — adding `tabindex="-1"` for programmatic focus,
  never a tab stop.
- **A finished turn is announced, the stream is not.** The transcript is never
  a live region — reading every token aloud is noise. `TurnDoneAnnouncer`
  (`app/chat/turn-announcer.tsx`) is one polite `sr-only` status line on the
  primary chat that says "AgentX đã trả lời xong" once when the foreground turn
  ends, and clears when the next starts so the same words are announced again.
- Titlebar actions have no active-background state.
- `Esc` closes every dismissable overlay/dialog (install/onboarding excluded);
  close is an x-icon, not the word "Close".

## Before you add something — checklist

- [ ] Reuse a primitive (`Button`, `menu-styles`, `SearchField`,
      `SegmentedControl`, `PageTabs`, `StatusPill`, `ListRow`, `Loader`,
      `Skeleton`, `ErrorState`, `LogView`, `EmptyFigure`, `ConfirmDialog`)
      instead of forking one?
- [ ] Semantic tokens (`--bg-*`, `--text-*`, `--border-*`, `--accent`,
      `--danger`…) — zero raw colors / one-off shadows?
- [ ] No `className` overriding a primitive's padding / size / radius / chrome?
- [ ] One primary (`--bg-inverse`) action per context, rightmost, never the
      accent or the brand?
- [ ] Cards and the composer carry a border, not a shadow; a floating surface
      takes `shadow-md` (level 1) or `shadow-nous` (level 2) and nothing else?
- [ ] Hierarchy by ink, not by size — nothing under 13px, no uppercase, no
      tracking?
- [ ] Tips only where hover teaches something new (no kebab / menu-trigger
      tips; unlabeled chrome that needs discovery gets `<Tip>` + `aria-label`)?
- [ ] No native `title=` on buttons?
- [ ] Keybind hints on tipped buttons use `useKeybindHint` / `TipKeybindLabel`?
- [ ] Flat — no card-in-card, no gratuitous row dividers?
- [ ] Reversible action → immediate + "Hoàn tác"; irreversible → a confirm
      dialog (`ConfirmDialog` / `requestConfirm()`), never `window.confirm()`?
- [ ] Errors next to where they happened, not only in a toast?
- [ ] No automatic navigation, focus steal, or pane opening from background
      events?
- [ ] Direct manipulation paints immediately and rolls back cleanly on failure?
- [ ] Hot interactions avoid broad subscriptions, layout thrash, and
      `transition-all`?
- [ ] Enter handlers check `isImeComposing` / `shouldSubmitOnEnter`?
- [ ] Keyboard ownership and single-action `Esc` behavior are correct?
- [ ] All six locales updated for any new/changed string, Vietnamese first —
      "cuộc trò chuyện", never "tôi", sentence case?
- [ ] Cursor (pointer only for links and nav rows), focus ring,
      forced-colors edge and `Esc`-to-close behave?
- [ ] Touched a primitive, token, or variant? Its named-contract entry in this
      file is updated in the same change.
