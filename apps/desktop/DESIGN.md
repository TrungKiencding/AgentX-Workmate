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

## Principles

1. **Flat, not boxed.** No card-in-card, no divider borders inside a panel.
   Group with whitespace and a single hairline, never nested rounded boxes.
2. **Borderless elevation for floating panels.** Overlays float on
   `shadow-nous` + a `--stroke-nous` hairline, not thick framed boxes. In-panel
   structure may use token hairlines sparingly.
3. **One primitive per concern.** One `Button`, one set of control variants,
   one `SearchField`, one `Loader`, one `ErrorState`. Migrate onto them; don't
   fork.
4. **Tokens, not literals.** Reference CSS vars (`--ui-*`, `--shadow-nous`,
   `--theme-*`), never raw hex / ad-hoc rgba in components.
5. **Style lives in the primitive.** Variants and sizes own padding, radius,
   color, chrome. Call sites pass a `variant`/`size`, not `className` overrides
   that re-specify those.
6. **Intent before automation.** Surface useful actions and previews, but do not
   open panes, move focus, or navigate because a tool happened to produce
   something.
7. **Immediate feedback.** Direct manipulation updates the view first. Network
   or disk persistence reconciles afterward and rolls back visibly on failure.

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

Two neutral bands, one construction: a lightness ladder on hue 262, every rung
carrying a trace of chroma (a 0-chroma grey beside a tinted paper reads as a
dead patch). Declared as hex in `themes/presets.ts` (`PAPER` / `GRAPHITE` — the
theme pipeline in `themes/color.ts` parses `#rrggbb` only) and mirrored as the
`--theme-neutral-*` OKLCH fallbacks in `styles.css`. Change one, change both.

| Rung | Light — **Paper** | Dark — **Graphite** |
| --- | --- | --- |
| sidebar | `#f5f7fa` · L 97.5% | `#080b10` · L 15% |
| page / chrome | `#f9fafd` · L 98.5% | `#0d0f15` · L 17% |
| card / editor | `#fcfdfe` · L 99.4% | `#13161c` · L 20% |
| elevated (popover, menu, dialog) | `#fefeff` · L 99.7% | `#1a1d23` · L 23% |

**In dark, elevation is lightness** — +3% per rung, never a glow, never a
heavier shadow. In light the rungs are ~1% apart and elevation is carried by
`shadow-nous` + the hairline instead. `--theme-neutral-*` is the color each
surface mixes toward, pinned to that surface's own rung, so the default skin
paints its band exactly and a tinted skin is pulled toward the band rather than
toward near-black. `--theme-mix-elevated` is **100%** in both modes: the
elevated rung is the one surface that must stay a visible step above the card.
`--theme-mix-bubble` is **100%** too — the user bubble paints the skin's own
`userBubble`, because every preset already places it a visible step off its own
page, and pulling it back toward the neutral card is exactly what made a sent
prompt disappear into the paper. Both bands' knobs live twice — `styles.css`
and `mixesFor()` in `themes/context.tsx` — and must agree.

Graphite is the default dark band. The royal-blue dark that preceded it lives on
whole as the **Nous Classic** preset — no one loses the palette they picked.

Eight presets ship built in — **Night Owl** (the shipped default: Sarah
Drasner's palette with both halves authored, so the skin every install lands on
never runs through the synth pass), Nous (Paper light / Graphite dark, the
default before it), Nous Classic, Midnight, Ember, Mono, Cyberpunk, Slate. A
fresh install also starts in **dark** mode — `normalizeMode`'s fallback — since
the default skin is a dark one. Each preset's header comment in
`themes/presets.ts` names its axes (band · display · accent) and tuned values
carry their OKLCH beside the hex. Both variants of every preset —
including the synthesised light side of dark-only presets (`synthLightColors`
in `themes/color.ts`, which deepens the primary until a white label reads and
`ensureContrast`s muted text and the ring) — must clear the contrast gate
`scripts/check-theme-contrast.mjs` in `npm run check`: text pairs ≥ 4.5:1,
primary/destructive labels also APCA |Lc| ≥ 60, focus ring ≥ 3:1 against the
page, hairlines ≥ 1.2:1 (visible, still quiet — the 3:1 boundary rule belongs
to the ring, not to dividers).

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

Floating panels (base `Dialog`, route overlays, boot/install/update surfaces,
model-picker, onboarding, prompt overlays, notifications) use:

```
shadow-nous           /* downward-weighted, layered contact→ambient falloff */
border-(--stroke-nous) /* currentColor hairline, theme-adaptive */
```

Both are CSS vars in `src/styles.css` — tune in one place, everything inherits.
Don't add per-overlay `shadow-[…]` or `border-(--ui-stroke-secondary)`
one-offs; if elevation needs to change, change the token.

Menus and popovers use their own shared `shadow-md` +
`--ui-stroke-secondary` primitive treatment. Drag affordances may use tokenized
dashed targets and local blur. These are semantic surface classes, not licenses
for call-site shadow or border inventions.

## Stroke & color tokens

| Token | Use |
| --- | --- |
| `--ui-stroke-primary…quaternary` | hairlines, in descending strength |
| `--ui-stroke-tertiary` | the default in-panel divider / list hairline — and every bordered surface in the transcript |
| `--stroke-nous` | the overlay hairline (pairs with `shadow-nous`) |
| `--ui-text-primary / -secondary / -tertiary` | text hierarchy |
| `--ui-bg-quaternary` | soft control fill (secondary button) |
| `--ui-row-active-bar` · `-width` | the selected row's 2px leading accent bar |
| `--ui-widget-surface-background` | fill for inline chat widgets (`WIDGET_SHELL_CLASS`) |
| `--chrome-action-hover` | hover fill for quiet controls |
| `--theme-primary`, `--ui-accent` | brand/accent |
| `--ui-green / --ui-yellow / --ui-red` | success · warning · danger |
| `--ui-*-foreground` (green/yellow/red) | text/glyph placed **on** that fill |
| `--ui-focus-ring`, `--ui-focus-ring-width/-offset` | the one focus indicator |
| `--ui-scrollbar-thumb*` | scrollbar thumb, per state |
| `--ui-selection-seed` | the selection amber, one seed at two strengths |
| `--ui-watermark-strength` | how loud the chat backdrop's brand pattern is, per mode |

The semantic trio is one construction: fixed hue + chroma, lightness pitched per
mode. Light clears 4.5:1 on paper (`oklch(52% 0.14 155)` · `oklch(55% 0.12 80)`
· `oklch(56.59% 0.1967 12.3)`), `.dark` lifts all three onto graphite
(`64%` · `75%` · `68%`). That means a semantic color can carry *text*, not only
a dot — but a status still needs a glyph as well as a hue.

Never hardcode `border-gray-*`, `bg-white`, `text-black`, etc. The white tile in
`BrandMark` is the one sanctioned literal (the mark needs a fixed backdrop).
Light `--theme-*` seeds are stated in OKLCH (exact conversions of the shipped
hex) so palette tuning happens on perceptual axes.

## Typography

Three faces live in text, all bundled in `src/fonts/` (no CDN fetch at
runtime); themes may override sans/mono through the existing pipeline:

- **Geist** (`--dt-font-sans`, OFL-1.1) — the UI sans. Variable weight per
  script subset (latin, latin-ext, vietnamese); other scripts fall back to the
  system stack.
- **JetBrains Mono** (`--dt-font-mono`) — the code face everywhere: code, kbd,
  paths, terminal.
- **Newsreader** (`--dt-font-serif-display`, `font-serif-display`, OFL-1.1) —
  the display outlier, allowed in exactly three slots: the connect splash, the
  home greeting and the onboarding hero. A static opsz 72 / wght 400 instance,
  vendored per script subset (latin, latin-ext, vietnamese) so Vietnamese
  diacritics never drop to Georgia. Roman only — italic display headings are
  banned.

Neuebit remains the brand plate face (`BrandMark`/About); Collapse stays
retired from product surfaces. `--dt-font-kbd` keeps the native UI face.

**Type ramp** (`--text-*` in `@theme inline`; these are the app's only font
sizes — no ad-hoc `text-[…]`. Two sanctioned exceptions size in `em`, not on
the ramp: inline code at `0.9em` of its sentence — one proportion in every
renderer — and the onboarding glyph's ASCII art, which is drawing, not text):

| Utility | Size | Use |
| --- | --- | --- |
| `text-2xs` | 11px | statusbar, badges, timestamps |
| `text-xs` | 12px | caption, meta, keybind hints |
| `text-sm` | 13px | **default UI chrome**: buttons, menus, sidebar, tabs |
| `text-base` | 14px | row content: settings labels, secondary card titles |
| `text-md` | 15px | chat prose default (`--conversation-text-font-size`) |
| `text-lg` | 18px | in-page section titles |
| `text-xl` | 22px | overlay/page titles |
| `text-2xl` | 28px | home greeting, connect splash (serif slots) |
| `text-3xl` | 36px | onboarding/update hero |

Line-height rides the ramp (chrome 1.4 · content 1.5 · prose 1.6 · display
1.15–1.3); tracking tightens from 18px (`-0.01em`) and again from 28px
(`-0.02em`). Floor: nothing under 11px; reading content at 14px+. Columnar
numbers use `tabular-nums` — every counter in the statusbar, every stat tile,
every timestamp in a list.

`--tracking-label` (0.06em, utility `tracking-label`) is the app's **only**
widened tracking, and it belongs to exactly one species: the 11px uppercase
section label (sidebar sections, date dividers, palette group headings, panel
section labels, stat-tile captions). Nothing else tracks out.

**The transcript reads on its own scale.** A reply is read in paragraphs, so
the chat column has a second, narrower set of tokens layered on the ramp —
all in `rem`, so they ride `--dt-base-size` like everything else:

| Token | Value | Use |
| --- | --- | --- |
| `--conversation-text-font-size` | 15px | prose (the `text-md` rung) |
| `--conversation-caption-font-size` | 13px | scaffold labels, table cells |
| `--conversation-tool-font-size` | 12px | tool meta, card subtitles |
| `--conversation-code-font-size` · `-line-height` | 12.5px · 1.55 | every mono payload in the thread: fences, diffs, stdout, terminal tails |
| `--conversation-prose-line-height` | 1.6 | prose only — chrome keeps `--dt-line-height` (1.5) |
| `--conversation-measure` | 72ch | the reading measure (see Chat) |
| `--conversation-h1…h4-font-size` | 18 / 16 / 15 / 14px | markdown headings inside a reply |

A heading in a reply is a section break in a message, not a page title: it
tops out one rung above the prose and bottoms out at the 14px content floor.
It never reaches the page ramp's 18px+ display sizes by accident — those
belong to `OverlayPageHeader` and the home greeting.

## Control & radius tokens

- `--control-h-sm/md/lg/xl` (28/32/36/40px) — one height ramp for every
  control; an input and a button on the same row are the same height.
- `--sidebar-row-height` (32px) · `--statusbar-height` (26px) — the navigation
  band's own two heights. A sidebar row matches `--control-h-md`, so a row and
  a button on the same rail line up; the statusbar keeps its shorter band.
- `--radius-control` (6px) · `--radius-card` (10px) · `--radius-overlay`
  (12px) · `--radius-bubble` (14px) — the corner voice. Fixed values; they do
  not ride `--radius-scalar`. The composer keeps its own 16px shell. In the
  transcript that means: `--radius-card` for the code card and
  `WIDGET_SHELL_CLASS`, `--radius-bubble` for the user bubble alone (the one
  surface that is *spoken* rather than shown, so it rounds a rung past the
  panels it sits among); `--radius-control` for what sits *inside* them (an
  expanded tool shell, a choice row, a fence inside a bubble) so a nested
  surface reads one rung tighter than its host. `rounded-md`/`rounded-xl` are `--radius-scalar`-driven
  and land near 2–3px — they are the menu vocabulary, not the card one.

## Buttons — one component

`src/components/ui/button.tsx` is the single source. Pick a `variant` + `size`;
do **not** pass `h-*`, `px-*`, `py-*`, or icon-size overrides.

**Variants:** `default` (primary), `destructive`, `secondary` (soft fill —
the default non-primary look), `outline` (transparent + 1px inset ring, no
fill/shadow), `ghost`, `link`, `text` (boxless quiet inline — "Cancel",
"Clear"), `textStrong` (bold underlined inline affordance — "Change",
"Open logs"), `chip` (hairline pill for an *optional* way in — the home
surface's quick-start row; pair it with `size="chip"`).

**Sizes** ride the `--control-h-*` ramp at 13px text (`text-sm`):

| Size | Box | Use |
| --- | --- | --- |
| `default` | 32px | the standard button |
| `sm` | 28px | dense rows, secondary actions |
| `lg` | 36px, 14px text | prominent forms |
| `xl` | 40px, 14px text | hero CTAs (onboarding, primary dialog action) |
| `xs` | padding-driven, 12px text | genuinely dense chrome (statusbar) |
| `inline` | flush, zero box | buttons inside a heading/sentence |
| `micro` | flush, 12px text | status-stack headers, table footers |
| `chip` | 36px pill, 13px text, 16px icon | the `chip` variant's size |
| `icon` / `icon-sm` / `icon-lg` | 32/28/36px square | icon-only actions |
| `icon-xs` | 24px square | inline icon actions only |
| `icon-titlebar` | OS chrome | window controls — untouched by the ramp |

**`loading`** swaps the label for a centered spinner while keeping the
button's width (no layout shift). Ignored with `asChild`.

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

Never use native HTML `title=` on buttons — unstyled, ~500ms OS delay, clashes
with the themed `Tip`. `src/components/ui/__tests__/no-native-title.test.ts`
fails on any `<button>` / `<Button>` that still carries `title=`.

**Keybind hints in tooltips.** On a tipped button bound to a rebindable hotkey,
use `<TipKeybindLabel actionId="..." />` — it reads the i18n label and the
current combo from `$bindings`. Pass `text={...}` only when the label is
context-dependent (e.g. "Show" / "Hide"). Never hardcode combos; always use
`useKeybindHint` or `TipKeybindLabel`.

Notes:
- Every boxed button carries `--radius-control` (6px); boxless variants
  (text/link/inline/micro) have no box to round. `icon-titlebar` keeps its own
  4px OS-chrome radius.
- Transitions name their properties (`background-color`, `border-color`,
  `color`, `box-shadow`, `transform`) at `--dur-micro` — never
  `transition-all`. Press feedback is a 1px `active:translate-y-px` settle
  (suppressed on `icon-titlebar`).
- **The Button owns the only transform on itself.** A call site never passes a
  positioning `translate-*`: every `translate-x/y-*` utility writes the same
  `translate` property, so a `-translate-y-1/2` centering is *cancelled* the
  instant the press rule sets its own — the overlay close X used to drop half
  its height on every click. Wrap the button in a positioned element and let
  the wrapper hold the transform;
  `components/ui/__tests__/no-button-transform.test.ts` fails on any `<Button>`
  carrying one.
- SVGs inherit `size-3.5` (`size-3` at `xs`). Don't re-set icon size.
- Polymorph with `asChild` when the button must render as a link/Slot.

## Form controls

- **`controlVariants`** (`src/components/ui/control.ts`) is the shared shape for
  `Input` / `Textarea` / `SelectTrigger`. New text-entry controls compose it.
  Same `--control-h-*` ramp and `--radius-control` as buttons; the border is a
  fixed 1px in every state and focus arrives as a 2px accent outline
  (offset 1px, never animated) — no layout shift. `Textarea` swaps the fixed
  height for a min-height so it can grow.
- **`SearchField`** — borderless, underline-on-focus, auto-width, 13px text at
  `--control-h-sm`. The only search input. Don't build boxed search bars; don't
  wrap it in a bordered tile. Empty lists hide their search field.
- **`SegmentedControl`** — the choice control for small mutually-exclusive sets
  (color mode, tool-call display, usage period). Replaces radio piles and
  pill rows. 28px track (`--control-h-sm`), 12px labels.
- **`Switch`** (`size="xs"`) — bare, with `aria-label`. No bordered text
  wrapper. The visual track stays compact; an invisible pad extends the hit
  target to ≥ 24px.

## Navigation chrome

The sidebar, statusbar, and pane tabs are the frame around the work. They must
read as structure at a glance — what is a group, what is selected, what is
running — while staying quieter than the content they frame.

- **Section labels** (`SidebarPanelLabel`, `SidebarDateDivider`,
  `PanelSectionLabel`, cmdk group headings) are one look: `text-2xs`,
  `font-medium`, `uppercase`, `tracking-label`, `--ui-text-tertiary`. Visible
  enough to group the rows under them, never a headline. Not brand-tinted —
  accent is for state, not for labelling.
- **Sidebar rows** own their height only on `SidebarRowShell`
  (`--sidebar-row-height`). Session title `text-sm font-medium`; meta and
  timestamps `text-2xs tabular-nums` in tertiary. Hover-revealed row actions use
  `size="icon-xs"` (24px) — the hit-target floor.
- **Selected is fill *plus* bar.** A selected sidebar row paints
  `--ui-row-active-background` **and** a 2px `--ui-row-active-bar` on its
  leading edge, drawn as a `::before` inside the row's own padding so it costs
  no layout and never nudges the label. Tint alone does not survive these
  near-neighbour surfaces.
- **Statusbar:** `--statusbar-height`, `text-2xs` (the ramp floor) with
  `tabular-nums` on every item — the bar is counters that tick in place. Warning
  and failure states use `--ui-yellow` / `destructive`, never a raw palette ramp,
  and always pair the colour with a glyph.
- **Pane tabs** (`PaneTab` / `PaneTabLabel`) ride the chrome size (`text-sm`)
  like every other tab. Labels are proper names — a pane title, a filename — so
  they keep their own casing; no tracked-out uppercase. Active = the 2px
  `--pane-tab-active-accent` seam **and** `font-semibold`.
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
  shell.
- **Page titles:** `OverlayPageHeader` (`overlays/overlay-split-layout.tsx`) is
  the one page-title block — `text-xl` (22px) semibold over a `text-sm` muted
  line, actions right. Command Center and every `Panel` (`PanelHeader` composes
  it) announce themselves through it. No rule under it; the gap is the
  separation. A pane that must hide the title at a breakpoint targets
  `[data-slot=overlay-page-title]`, not a DOM position. **Settings is the
  deliberate exception** — its left rail already names the page, so it takes
  its hierarchy from `SectionHeading` over `ListRow` instead of repeating the
  rail at 22px.
- **Overlay nav rows** (`OverlayNavItem`, settings `NavLink`) are controls:
  `--control-h-md` at `text-sm`, `--radius-control`.
- **Rows:** `ListRow` (settings `primitives.tsx`) for label/description/action
  rows — `min-h-11` (44px), title `text-base`, description `text-sm` tertiary,
  mono hint `text-xs`. Flat, flush-left; no per-row indentation that fights
  flush headers.
- **Section rhythm:** `SectionHeading` is `text-md` semibold with an 18px icon,
  and its spacing is deliberately uneven — 24px above, 12px below — so a heading
  belongs to the rows under it instead of floating between two equal gaps.
- **In-page cards** carry `--radius-card`, 16–20px padding, a `text-base`
  semibold title, and **one** border level (`--ui-stroke-tertiary`). No
  card-in-card. Figures use `tabular-nums`.
- **Dialogs** name themselves at `text-lg` (18px) — a dialog is a task, not a
  page — over a `text-sm` tertiary description, and their primary action rides
  `size="lg"`/`"xl"` with its Cancel matched.
- **No dividers between rows** unless the list genuinely needs them; prefer
  spacing. When you do need one, it's a single `--ui-stroke-tertiary` hairline.

## Feedback & empty/error/loading states

- **Loading:** `Loader` (`src/components/ui/loader.tsx`) — animated math/ascii
  curves (`lemniscate-bloom` for long ops). Never ship the literal text
  "Loading…".
- **Errors:** `ErrorState` + the canonical `ErrorIcon` (no bg chip). One look
  for the React boundary, in-dialog errors, and the boot-failure banner. Pass
  nodes for title/description so Radix `DialogTitle`/`Description` can flow
  through for a11y.
- **Logs:** `LogView` — no bg, hairline border, tight padding, small mono.
  Every place we surface raw logs uses it.
- **Empty:** `EmptyState` for plain page bodies; `PanelEmpty` for overlay
  master/detail empties with a leading icon. Don't hand-roll a third centered
  empty.
- **Three beats.** `EmptyState`, `PanelEmpty`, and `ErrorState` all say the same
  three things in the same order: the **name** of what is missing or broken
  (`text-base` medium — `text-xl` for `ErrorState`, which owns a whole surface),
  the **reason** (`text-sm` tertiary), and **one action** that resolves it
  (`EmptyState`/`PanelEmpty` take an `action` node; `ErrorState` takes
  `children`). Buttons are concrete verbs — never "OK", never "Oops". Skip the
  action only when the surface already shows it inches away.

## Command surfaces

The palette and the session switcher share `floating-hud.ts` — `HUD_SURFACE`,
`HUD_POSITION`, `HUD_TEXT` (`text-sm`, the chrome size: a palette is read at
speed and gets no discount), `HUD_ITEM` (a 36px **floor**, not a fixed height,
so two-line rows still grow), `HUD_HEADING`.

- **It opens in the frame it is asked for.** The palette has no entry animation
  at all. Its *close* animation stays — `onAnimationEnd` is what retires the
  subtree.
- **One highlight, and it slides.** `CommandSelectionIndicator`
  (`components/ui/command.tsx`) is a single element that moves to the selected
  row; rows that use it opt out of `data-[selected=true]:bg-accent`. It runs on
  a MutationObserver, never React state, so arrowing through a hundred rows
  re-renders nothing — the selection is instant, only the paint follows. The
  global reduced-motion rule collapses the slide to a jump.

## Chat, tools & boot surfaces

- **The home surface is the empty transcript** (`components/chat/intro.tsx`):
  a serif greeting (`font-serif-display`, `text-2xl`, roman — outlier slot 2 of
  3), one muted 14px line from `intro-copy.jsonl`, then a **quick-start row** of
  at most four `chip` buttons. The composer stays the only CTA; the block leads
  the eye down to it.
  - Every chip is grounded in something the app already knows — the session you
    were last in, a project you already added — plus four fixed starters whose
    label *and* prompt live in the locale files. **The starters take the
    folder's side**: inside a git repository the coding pair leads (explain the
    repo, plan a change), anywhere else the office pair leads (summarise a
    document, draft an email), and the explain chip speaks of "this folder"
    rather than "this repo" off a repository. The same `repoStatusForCwd` probe
    the composer's coding rail uses decides it, so chips and branch strip never
    disagree. **Nothing here invents a suggestion**: no recent session, no
    resume chip. The selection rule is the pure `introChipSources()` in
    `intro-chips.ts`, so it is testable without a renderer; `Intro` only
    renders. Clicking a chip runs one *existing* action
    (`openSession`, `requestStartWorkSession`, `requestComposerInsert`) — the
    home surface owns no navigation of its own.
  - The greeting names the user only when the account store actually has a
    display name. No name, no comma, no invented placeholder.
  - **One entrance, once per app launch** — not once per empty state. The
    greeting rises at `--dur-long`; the body and each chip follow on a 40ms
    step at `--dur-short`, all settled by 400ms. `prefers-reduced-motion`
    collapses it to an instant crossfade — the app-wide reduced-motion
    kill-switch (0.01ms, top of `styles.css`) outranks the intro's own fade —
    with no stagger and no transform.
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
  capped at `--user-bubble-max-width`, about three quarters of the measure) —
  so a turn reads as a dialogue: mine on the right, the reply full width on the
  left. Attachments, reactions and the checkpoint strip follow it right; the
  inline edit composer fills the same rail (a field you can't see the end of is
  worse than a slightly wider silhouette). `--radius-bubble`, 14×10px padding,
  the `--dt-user-bubble` fill, a `--dt-user-bubble-border` hairline, and
  `--dt-user-bubble-hover` on hover — at pill size the fill *is* the shape, so
  "click to edit" has to be a fill move, not a border move. **Nothing is
  reserved inside it**: stop and restore hang off the rail to its left, on
  hover, so a two-word prompt is a two-word pill. Its meta (process notices,
  checkpoints, timestamps) sits at `text-2xs` — the ramp floor, never below it.
- **A long prompt clamps, and the fade is a promise.** `.sticky-human-clamp`
  cuts the body at four lines; the soft bottom mask paints *only* when
  something is genuinely hidden behind it, measured against that clamp's own
  resolved max-height rather than a line count re-derived in JS (the two drifted
  — a three-line prompt used to fade with nothing under it).
- **Inline widgets** — a tool result that renders as a panel the user reads or
  acts on (clarify, artifact card) wears `WIDGET_SHELL_CLASS`
  (`src/components/chat/widget-shell.ts`): `--radius-card`, the
  `--ui-widget-surface-background` fill, no border. Its actions sit *outside*
  the panel, below it, on the normal control ramp (a widget's primary action is
  a real 32px button, not statusbar-dense chrome). Don't give one widget its own
  radius or fill.
- **Fenced code** rides `CodeCard` (`src/components/chat/code-card.tsx`):
  `--radius-card` over `--ui-bg-editor`, no border, mono at
  `--conversation-code-font-size`/`-line-height`. `CodeCardHeader` is one 28px
  row — the language on the left at `text-2xs` mono tertiary (a language is a
  proper name: its own casing, no tracked-out uppercase), the copy control on
  the right at `size="icon-sm"`. No divider under it; the padding is the
  separation. Copy answers in place — the glyph becomes a check and the label
  becomes "Copied" for 2s (`COPIED_RESET_MS`). Never a toast, and never fake
  window chrome (no red/yellow/green dots).
- **A fence that is still streaming gets exactly one motion primitive:** it
  rises into place at `--dur-short-exit`, and its body carries a soft bottom
  mask. No pulsing halo — a coloured glow around a card is banned on any
  surface, and a second loop would compete with the text actually arriving.
- **Tool rows are scaffolding, not cards.** They stay transparent and faded
  (`data-conversation-scaffold`) so the prose column reads first. One voice
  for all of them: `SCAFFOLD_LABEL_CLASS` (13px medium at
  `--conversation-scaffold-text`) for the name, `SCAFFOLD_META_CLASS`
  (`text-2xs tabular-nums`) for counts, durations and diff stats. Do not box a
  tool row into a widget shell.
- **Tool state is a glyph *and* a colour, from the semantic tokens.** Running
  is the breathing spinner, error `destructive`, recovered `--ui-yellow`,
  delegate-done `--ui-green`, diff counts `--ui-diff-add-foreground` /
  `--ui-diff-remove-foreground`. Never a raw Tailwind ramp (`amber-600`,
  `emerald-400`) — those don't move with the theme.
- Bordered surfaces in the transcript (tables, fences, callouts, attachments)
  use `--ui-stroke-tertiary`. Not `border-border` — that's the app-wide
  default and reads too hot against the thread.
- **The composer is the focus of the chat screen** and carries the transcript's
  one elevation: at rest a `--ui-stroke-secondary` hairline plus
  `--shadow-composer`; on `:focus-within` the accent border
  (`--composer-ring-strength`, 1 light / 1.3 dark) and one step up the *same*
  shadow ladder to `--shadow-sm`. No new shadow, no colored glow — the border
  does the talking, and neither property is transitioned.
- **The composer's voice follows the folder.** Inside a git repo it is a
  coding surface: the branch strip caps the card and the model pill carries
  the full label with its effort (`Qwen3.5 122B A10B FP8 · Med`). Anywhere
  else — a documents folder, a detached chat — the strip is gone and the pill
  wears the model's short name alone (`conciseModelName`: family + version,
  no build words, no effort; the tooltip and the picker keep the full id). One
  probe, `repoStatusForCwd`, decides both, so strip and pill never disagree.
- A tool result may expose an inline action that opens a preview. It must not
  open the rail automatically.
- **The connect splash** (`components/gateway-connecting-overlay.tsx`) is one
  centred line — the catalog's `boot.connecting` ("Connecting to AgentX
  server" in English) in the display serif (`text-2xl`, outlier slot 1 of 3),
  its `word` legible from the first frame while the `target` decodes under it,
  then a fade that hands off to the home greeting in the same face. Cold boot only: a post-boot socket drop
  reconnects behind the shell, never behind this overlay.
- Install, onboarding, connecting, boot failure, and reauthentication are
  distinct states with shared visual primitives. Preserve their recovery
  semantics when unifying appearance.
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

- **Tabler** is the default component/chrome set. Import its curated aliases and
  `iconSize` scale from `src/lib/icons.ts`; do not import icon packages directly
  in feature code.
- **`Codicon`** is the compact editor/tool/status vocabulary. Use
  `src/components/ui/codicon.tsx`, including `codiconIcon()` where a
  Tabler-shaped component is required.
- Pick the vocabulary by semantic context and reuse the existing icon for an
  action. Do not introduce a third icon set or mix styles within one control
  group.
- **`BrandMark`** (`src/components/brand-mark.tsx`) is the brand glyph — the
  the 8-bit AgentX mascot on its own dark plate, softly rounded, identical in light/dark.
  It replaced scattered Sparkles glyphs in updates / onboarding / about. Use it
  for hero/brand moments; don't reintroduce decorative star/sparkle icons.

## Motion

- **Tokens only:** durations `--dur-micro` (100ms — press, toggle, color),
  `--dur-short` (200ms — hover, menu, tooltip), `--dur-long` (320ms — overlay,
  entrance); curves `--ease-out` (enter), `--ease-in` (exit), `--ease-in-out`
  (in-place morph). Exits run ≈ 75% of the paired enter, and that rule is a
  token too: `--dur-micro-exit` (75ms) · `--dur-short-exit` (150ms) ·
  `--dur-long-exit` (240ms). Focus rings appear instantly — never transitioned.
- **Two springs, both named, both physical.** `--spring-pop`
  (`cubic-bezier(.34,1.56,.64,1)` — reaction pop, particle burst, drag-reorder
  settle) and `--spring-reveal` (`cubic-bezier(.22,1.4,.4,1)` — the pet
  hatching). Overshoot on a UI *state* — a menu opening, a row selecting, a
  panel resizing — is a bug, not a flourish.
- **The Web Animations API can't read CSS vars,** so `src/lib/motion.ts` is the
  JavaScript mirror of these tokens (`EASE_OUT`, `SPRING_POP`, `DUR_SHORT_MS`,
  …). Those two files are the *only* places in `src/` where a literal
  `cubic-bezier()` may appear; change a curve in one and change it in the
  other. A WAAPI call or a drag library's easing string imports from there.

**Recipes** — the whole motion vocabulary, so nothing has to be invented:

| Interaction | What moves | Duration · curve |
| --- | --- | --- |
| Hover on a control | `background-color`, `border-color`, `color` | `--dur-short` · `--ease-out` |
| Press | `active:translate-y-px` | `--dur-micro` |
| Disclosure caret / row fade | `transform`, `opacity` | `--dur-short-exit` |
| Scaffolding lifting out of its fade | `opacity` | `--dur-micro` · `--ease-out` |
| Overlay / boot surface arriving | `opacity` (+ the surface's own stagger) | `--dur-long` · `--ease-out` |
| Anything leaving | the property it entered on | the paired `--dur-*-exit` · `--ease-in` |
| Reaction / particle / reorder settle | `transform`, `opacity` | `--dur-long-exit` · `--spring-pop` |

- **Menus, popovers, dialogs and the palette open in the frame they are asked
  for** — no entry animation at all. Only their *close* is animated, and only
  where the surface already owns one. This is deliberate: a command surface is
  used at speed and an entry animation is a tax on every use.
- **Tooltips: 500ms on hover, 0ms on focus.** `TIP_DELAY_MS` is long enough
  that a cursor crossing a toolbar never lights one up in passing; Radix applies
  it to pointer opens only, so keyboard focus still shows the tip in the same
  frame. `skipDelayDuration` is zeroed so each tip honours the delay
  independently instead of a sweep opening a trail of them.
- **Silent success.** An action whose result is visible on screen says nothing:
  renaming a session repaints its row, pausing a cron job flips its state pill,
  copying fills the clipboard and the control answers in place. Toasts are for
  what the user *cannot* see (a background job started, a credential saved) and
  for failure — and a failure toast always carries what to do next.
- Quick, functional transitions (~100ms on controls). Respect
  `prefers-reduced-motion` for anything beyond a fade.
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
  language across files, sessions, tabs, and panes. Overlapping targets resolve
  to the active one instead of stacking overlays.
- Forgiving geometry beats pixel-perfect triggers; edge actions live near their
  edge, not clustered in the center.
- Expensive stateful surfaces stay mounted when hidden. Visibility is not
  lifecycle.

Prove speed with realistic content. A fast empty-state demo says nothing about a
long transcript or a busy terminal.

## Keyboard & cancellation

- Keyboard ownership follows focus. The focused surface wins its keys; shell
  shortcuts must not steal a terminal's or editor's bindings.
- Register global shortcuts through the shared layer, not ad-hoc listeners.
- One cancel gesture does one thing: cancel the active interaction, or close the
  topmost dismissable surface — never both, never the control underneath.
- Cancellation is synchronous in the UI even if cleanup is async: overlays,
  cursors, and pending gesture state clear at once.
- Flows that deliberately cannot be dismissed (install/onboarding, destructive
  confirmation) must make that explicit.

## i18n

- Every user-facing string goes through `useI18n()` (`src/i18n/context.tsx`).
  No literals in JSX.
- **Update all locales together** — `en`, `ja`, `zh`, `zh-hant`, `ar`. A string
  change in `en.ts` that skips the others is a regression (drifted punctuation,
  stale labels). Keep trailing-punctuation and tone consistent across all five
  (`defineLocale` falls back to English for a missing key, but fallback is a
  safety net, not a translation).

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

- `cursor-pointer` at the primitive level (Button, dropdown/select) — don't
  hardcode it per call site.
- **One focus ring, app-wide.** `styles.css` kills the native outline and
  Tailwind's `ring-*` shadow, then gives *keyboard* focus a single tokenized
  outline: `--ui-focus-ring-width` (2px) accent at `--ui-focus-ring-offset`
  (2px). The offset is load-bearing — it paints the surface behind the control
  between fill and ring, so the ring stays legible on a primary button that is
  the same accent. Never transitioned; it must be there in the frame focus
  lands. Text-entry controls (`.desktop-input-chrome`, `contenteditable`) and
  menu/option rows (`[role=menuitem|menuitemcheckbox|menuitemradio|option]`)
  opt out: they already carry focus in their own border or selected-row
  background. `data-focus-ring="none"` opts a one-off out.
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
- Titlebar actions have no active-background state.
- `Esc` closes every dismissable overlay/dialog (install/onboarding excluded);
  close is an x-icon, not the word "Close".

## Before you add something — checklist

- [ ] Reuse a primitive (`Button`, `SearchField`, `SegmentedControl`,
      `ListRow`, `Loader`, `ErrorState`, `LogView`) instead of forking one?
- [ ] Tokens (`--ui-*`, `shadow-nous`, `--stroke-nous`) — zero raw colors /
      one-off shadows?
- [ ] No `className` overriding a primitive's padding / size / radius / chrome?
- [ ] Tips only where hover teaches something new (no kebab / menu-trigger
      tips; unlabeled chrome that needs discovery gets `<Tip>` + `aria-label`)?
- [ ] No native `title=` on buttons?
- [ ] Keybind hints on tipped buttons use `useKeybindHint` / `TipKeybindLabel`?
- [ ] Overlay uses `shadow-nous` + `border-(--stroke-nous)`, no hard border?
- [ ] Flat — no card-in-card, no gratuitous row dividers?
- [ ] No automatic navigation, focus steal, or pane opening from background
      events?
- [ ] Direct manipulation paints immediately and rolls back cleanly on failure?
- [ ] Hot interactions avoid broad subscriptions, layout thrash, and
      `transition-all`?
- [ ] Keyboard ownership and single-action `Esc` behavior are correct?
- [ ] All four locales updated for any new/changed string?
- [ ] `cursor-pointer`, focus ring, and `Esc`-to-close behave?
- [ ] Touched a primitive, token, or variant? Its named-contract entry in this
      file is updated in the same change.
