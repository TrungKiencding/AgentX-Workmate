/**
 * Inline transcript widgets — the few tool results that render as a panel the
 * user reads or acts on (a clarify question, an artifact card) rather than as
 * a scaffold line.
 *
 * They share one shell so they cannot drift apart. They used to each pick their
 * own: clarify sat on a 2px radius over the chat backdrop's own color (a card
 * you could only see by its hairline), the artifact card on a hardcoded 10px
 * over nothing. One radius — `--radius-card`, the app's card rung — and the
 * card voice (spec §5.10): the widget fill under a --border-default hairline,
 * flat, so it reads as a surface on any skin, including the Quiet page.
 */
export const WIDGET_SHELL_CLASS =
  'rounded-(--radius-card) border border-(--border-default) bg-(--ui-widget-surface-background) px-3.5 py-3'
