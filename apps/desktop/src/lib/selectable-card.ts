import { cn } from '@/lib/utils'

export interface SelectableCardState {
  /** Currently selected / active — the strongest emphasis. */
  active?: boolean
  /**
   * Configured / installed / "you have this" — solid surface + border. When
   * false the card renders muted (transparent, dimmed) until hovered, so the
   * eye lands on what you already have. Ignored when `active` is set.
   */
  prominent?: boolean
}

/**
 * Shared emphasis for selectable list cards across settings surfaces (theme
 * picker, pet picker, Marketplace results, provider rows…). Three tiers:
 * active > prominent > muted. Keeps the "installed = solid, not-installed =
 * quiet" pattern consistent everywhere instead of each picker rolling its own.
 *
 * Callers own layout (padding, flex, width); this owns only border + surface.
 */
export function selectableCardClass({ active, prominent }: SelectableCardState): string {
  return cn(
    // The in-page card voice (spec §5.10): --radius-card, the page colour,
    // ONE border level that firms on hover. The chosen card is the one place
    // the accent appears — its edge, never a fill.
    'rounded-(--radius-card) border bg-(--bg-app) transition-[border-color] duration-(--dur-micro)',
    active
      ? 'border-(--accent)'
      : prominent
        ? 'border-(--border-default) hover:border-(--border-strong)'
        : 'border-transparent text-(--text-secondary) hover:border-(--border-default)'
  )
}
