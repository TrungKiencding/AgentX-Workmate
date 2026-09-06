import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * The store card — one tile in the Tiện ích grids: a skill you have, a skill
 * in the store, a tool, a curated connection. One treatment for all four so
 * "turn a tool on", "add a skill" and "install a connection" read as the same
 * kind of thing: `--radius-card`, the quinary fill, 16px padding, and the
 * §Motion card-hover recipe (background, border and shadow move together at
 * `--dur-short` — never a translate, never a scale).
 *
 * A card is glanceable, not exhaustive. Compose it top to bottom as
 * `StoreCardHeader` (glyph · name · one pill · the switch), a two-line
 * `StoreCardDescription`, an optional `StoreCardTags` row, and a
 * `StoreCardFooter` whose left side opens the detail and whose right side
 * carries the one verb (Thử ngay · Thêm kỹ năng này · Cài). Everything an
 * administrator might want lives behind the detail, never on the tile.
 */
export function StoreCard({ className, ...props }: React.ComponentProps<'article'>) {
  return (
    <article
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-(--radius-card) border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) p-4 shadow-xs transition-[background-color,border-color,box-shadow] duration-(--dur-short) ease-out hover:border-(--ui-stroke-secondary) hover:bg-(--ui-bg-quaternary) hover:shadow-sm',
        className
      )}
      data-slot="store-card"
      {...props}
    />
  )
}

/** The grid every store surface lays its cards on: as many 18rem+ columns as fit. */
export function StoreCardGrid({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-3', className)}
      data-slot="store-card-grid"
      {...props}
    />
  )
}

/**
 * The 32px tile a card's Tabler glyph sits in — the same box `McpAvatar`
 * gives a letter monogram, so a skill's category glyph, a tool's glyph and a
 * connection's brand mark line up across the tabs.
 */
export function StoreCardGlyph({ children, className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-grid size-8 shrink-0 place-items-center rounded-md bg-(--ui-bg-tertiary) text-(--ui-text-tertiary) [&>svg]:size-4.5',
        className
      )}
      data-slot="store-card-glyph"
      {...props}
    >
      {children}
    </span>
  )
}

/**
 * Title row. `meta` is the one thing allowed beside the name (a version, a
 * provenance or "needs setup" pill); `control` is the trailing switch. `dimmed`
 * is the switched-off look — the name drops to the tertiary ink and medium
 * weight, exactly as the list rows used to dim, so on/off reads from the
 * title as well as the switch.
 */
export function StoreCardHeader({
  control,
  dimmed = false,
  glyph,
  meta,
  title
}: {
  control?: React.ReactNode
  dimmed?: boolean
  glyph?: React.ReactNode
  meta?: React.ReactNode
  title: string
}) {
  return (
    <div className="flex items-center gap-2.5" data-slot="store-card-header">
      {glyph}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span
          className={cn(
            'min-w-0 truncate text-base',
            dimmed ? 'font-medium text-(--ui-text-tertiary)' : 'font-semibold text-foreground'
          )}
        >
          {title}
        </span>
        {meta}
      </div>
      {control}
    </div>
  )
}

/** The two-line description under the title — what this does, in the person's language. */
export function StoreCardDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      className={cn('line-clamp-2 text-sm text-(--ui-text-tertiary)', className)}
      data-slot="store-card-description"
      {...props}
    />
  )
}

/** A wrapping row of `TagChip` / `StatusPill` metadata. */
export function StoreCardTags({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-wrap items-center gap-1.5', className)} data-slot="store-card-tags" {...props} />
}

/**
 * The bottom row, pinned to the card's floor so a grid of cards keeps its
 * verbs on one line: `children` sit left (the way into the detail), `end` sits
 * right (a quiet meta figure and the card's one primary verb).
 */
export function StoreCardFooter({
  children,
  className,
  end
}: {
  children?: React.ReactNode
  className?: string
  end?: React.ReactNode
}) {
  return (
    <div
      className={cn('mt-auto flex items-center justify-between gap-2 pt-1', className)}
      data-slot="store-card-footer"
    >
      <div className="flex min-w-0 items-center gap-1">{children}</div>
      <div className="flex shrink-0 items-center gap-2">{end}</div>
    </div>
  )
}

/** The 12px tabular figure a footer carries ("Dùng 20 lần", "5 chức năng"). */
export function StoreCardMeta({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn('text-xs tabular-nums text-(--ui-text-tertiary)', className)}
      data-slot="store-card-meta"
      {...props}
    />
  )
}
