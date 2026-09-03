# UI Changelog — the 2026-08 uplift

Ten phases, one direction: a quieter ground, larger type where reading happens,
one clear voice per screen. Everything below is shipped and measured — no
before/after number here is invented. The full plan and its acceptance gates
live in [`UI-REDESIGN-PLAN.md`](./UI-REDESIGN-PLAN.md); the resulting system is
documented in [`design.md`](./design.md).

Acceptance screenshots are captured per release (6 surfaces × 1280×800,
1512×982 and 900×700 × light + dark, plus the 8-theme grid) and deliberately
kept out of the repository — regenerate them with the dev app
(`VITE_PERF_PROBE=1 npm run dev`) and the `__PERF_DRIVE__` state hooks.

## Foundations — type, color, shape (Phases 0–2)

**Before.** The whole app ran at 11–13px: chat prose 13px, tool text 11px,
~480 uses of 12px chrome and no display sizes above 14px. System fonts only.
Hairlines at 3–10% alpha and tertiary text at 54% were near-invisible on real
screens. Default dark was a saturated royal blue.

**After.**
- Three bundled faces: **Geist** (UI sans), **JetBrains Mono** (all code),
  **Instrument Serif** in exactly two display slots. No CDN fetch at runtime.
- A real type ramp, 11 → 36px (`--text-2xs` … `--text-3xl`); chat prose reads
  at **15px/1.6** on a 72ch measure.
- **Paper / Graphite** neutral bands on hue 262 — light elevates by shadow +
  hairline, dark elevates by lightness (+3% per rung, no glows). The old royal
  blue lives on, whole, as the **Nous Classic** preset.
- Visibility knobs raised (tertiary text 54→60%, hairline mix 5→8%) so quiet
  stays *visible*.

## Controls & composer (Phase 1)

**Before.** Default buttons were ~28px tall with 12px labels and 2.5px corners;
the send button — the most important control in the app — was 24px.

**After.** One control ramp (`--control-h-*`: 28/32/36/40px) shared by buttons
and inputs, 13px labels, 6px corners, eight real states including `loading`.
The send button is a 32px primary. Focus is a 2px accent ring that appears in
the same frame, never animated.

## The home surface (Phase 3)

**Before.** An empty transcript showed a pixel wordmark and one grey line.

**After.** A serif greeting with your name (when the account has one), one
personality line, and up to four quick-start chips built only from real data —
your last session, a project you added, two fixed starters. One entrance per
app launch, settled in 400ms; reduced motion collapses it to a crossfade. The
composer stays the only CTA.

## Navigation chrome (Phase 4)

Sidebar rows at 32px with 13px titles and tabular-numeral meta; section labels
in 11px tracked uppercase; the selected row paints a fill **plus** a 2px
leading accent bar. Statusbar counters tick in place with `tabular-nums`.
Pane tabs mark active with a 2px seam and semibold, not color alone.

## Overlays & pages (Phase 5)

Every page announces itself through one header block — 22px semibold title
over a 13px muted line (`OverlayPageHeader`); Settings deliberately keeps its
rail-led hierarchy instead. Rows are ≥44px, cards carry one border level and
10px corners, dialogs name themselves at 18px. The command palette opens with
no entry animation and a selection highlight that slides.

## The transcript (Phase 6)

Prose at 15px/1.6 capped at 72ch; code, tables and diffs bleed to the full
column. Fenced code rides one `CodeCard` (12.5px mono, copy answers in place —
never a toast). Tool rows are scaffolding, not cards: one label voice, state
always a glyph *and* a semantic color. The user bubble is a quiet card; the
composer carries the transcript's single elevation.

## Motion (Phase 7)

Every duration and curve is a token (`--dur-micro/short/long` + paired exits,
`--ease-*`, two physical springs). `transition-all` count in `src/`: **0**.
Menus and the palette open in the frame they're asked for; only closes animate.
Tooltips: 500ms on hover, 0ms on focus. Success stays silent when the result
is visible on screen.

## Themes 2.0 (Phase 8)

Seven presets — Nous (Paper/Graphite), Nous Classic, Midnight, Ember, Mono,
Cyberpunk, Slate — each documented by its axes (band · display · accent) with
OKLCH beside every tuned hex. A contrast gate now runs in `npm run check`
(`scripts/check-theme-contrast.mjs`): 154 measured pairs across both variants
of every preset — body text ≥ 4.5:1, filled primary/destructive labels also
APCA |Lc| ≥ 60, focus ring ≥ 3:1, hairlines that must actually exist. Fixed by
the gate: Cyberpunk's muted text (4.53→6.45:1) and destructive label, Slate's
destructive pair, Midnight's muted text, four vanished sidebar hairlines, and
the synthesized light variants of dark-only themes (readable muted text, a
focus ring that clears 3:1, primaries deepened until a white label reads).
VS Code imports, CLI skins and user themes inherit the bundled faces
untouched.

## QA pass (Phase 9)

The §5 slop-checklist ran across Home, streaming chat, full sidebar, Settings,
the palette and onboarding at three window sizes in both modes. Message action
buttons were raised to the 24px hit-target floor (they measured 14×14).
Reduced-motion verified: the strongest thing left moving is a 0.01ms fade.

## Debt sweep — after the ten phases

Everything the phases had logged as "known debt" is paid:

- **Accent picker** (Settings → Appearance, Nous theme only): six curated
  seeds — Nous Blue, Violet, Magenta, Green, Amber, Teal — recolor everything
  the blue carried: buttons, focus ring, selection, tints. The neutral bands
  and inks stay Paper/Graphite, the primary deepens until its white label
  reads, and the contrast gate now walks every accent in both bands
  (264 measured pairs). Stored per profile; the default is the shipped blue.
- **Native tooltips, gone for real.** The guard that bans `title=` on buttons
  couldn't see past arrow-function props and only scanned `components/` — the
  hardened scan found 20 hidden violations (duplicate `title`s beside
  `aria-label`s, plus a few real hints now on the themed `Tip`).
- **306 orphan font sizes onto the ramp.** Every `text-[0.6…rem]`-style
  literal in the renderer now rides `--text-*`; nothing user-facing sits under
  the 11px floor any more. Inline code keeps one proportional size (`0.9em` of
  its sentence) in every renderer, and the fenced block in a user bubble rides
  the conversation code tokens.
- **Custom Endpoints speaks every language.** The last hardcoded-English
  settings page moved onto `useI18n()` across all five locales (`ar` included
  — the roster grew since the plan was written).
- Imported skins and VS Code themes pick their label color by measured
  contrast (`bestTextOn`), so a mid-tone accent no longer coin-flips to
  white-on-grey.
- **The display serif speaks Vietnamese.** Instrument Serif ships no
  Vietnamese subset, so in the default locale every stacked diacritic of the
  home greeting (ổ, ề, ố …) dropped to Georgia mid-word. The three display
  slots now set **Newsreader** (a static opsz 72 / wght 400 instance, vendored
  per script subset like Geist); the serif-display token and its default in
  `presets.ts` moved with it.
- **The home sub-line reads the catalog.** The line under the greeting came
  from `intro-copy.jsonl`, English in every locale. Neutral copy now lives in
  `assistant.intro.bodyVariants` (five locales); the personality-flavoured
  jsonl is consulted only when the app runs in English.

## Composer voice & project naming (2026-09-03)

**Before.** Outside a git repo the composer's branch strip already stayed
hidden, but the model pill still read `Qwen3.5 122B A10B FP8 · Med` to someone
who never chose a quantisation. A new project needed a typed name even when it
was one folder with an obvious one.

**After.**
- **A voice that follows the folder.** Inside a git repo: the branch strip and
  the full model label with its effort. Anywhere else the strip is gone and the
  pill wears the model's short name (`conciseModelName`: `Qwen3.5`). One probe
  (`repoStatusForCwd`) decides both. The composer keeps its size and layout.
- **A single-folder project names itself** after the folder (`pathLeaf`), with
  the field pre-filled and editable and a hint saying so; several folders ask
  for a name before Create lights. The ⌘O "open folder as project" path uses
  the same helper, so both ways in agree on the name.
