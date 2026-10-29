import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * The tile palette — the platform's system colours, a shade quieter. Tokens
 * live in tokens.css (`--tint-*`, per mode); this list is only their names.
 */
export const TINTS = [
  'blue',
  'green',
  'orange',
  'red',
  'purple',
  'pink',
  'teal',
  'indigo',
  'yellow',
  'graphite'
] as const

export type Tint = (typeof TINTS)[number]

/** A stable tint for a name (a skill category, a tool) — same name, same colour. */
export function tintFor(seed: string): Tint {
  // FNV-1a: spreads short, similar names ("media", "email") across the
  // palette instead of bunching them.
  let hash = 0x811c9dc5

  for (const char of seed.toLowerCase()) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193)
  }

  // Graphite stays for "system" things chosen on purpose, not by chance.
  return TINTS[(hash >>> 0) % (TINTS.length - 1)]!
}

const SIZES = {
  sm: 'size-6 rounded-[0.375rem] [&>svg]:size-3.5',
  md: 'size-8 rounded-md [&>svg]:size-4.5'
} as const

/**
 * A glyph in a rounded colour tile — the way the platform's Settings marks
 * each pane. `solid` is the Settings look (a full-colour tile, white glyph),
 * kept to small, scannable rails; `soft` is the quiet form for grids of
 * cards (a pale wash of the colour with the glyph in it), so a page of forty
 * cards reads calm rather than loud.
 */
export function IconTile({
  children,
  className,
  size = 'md',
  style,
  tint,
  variant = 'soft',
  ...props
}: React.ComponentProps<'span'> & { size?: keyof typeof SIZES; tint: Tint; variant?: 'soft' | 'solid' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-grid shrink-0 place-items-center',
        SIZES[size],
        variant === 'solid'
          ? 'bg-(--tile-tint) text-white'
          : 'bg-[color-mix(in_srgb,var(--tile-tint)_13%,var(--bg-app))] text-(--tile-tint) dark:bg-[color-mix(in_srgb,var(--tile-tint)_22%,var(--bg-app))]',
        className
      )}
      data-slot="icon-tile"
      data-tint={tint}
      style={{ '--tile-tint': `var(--tint-${tint})`, ...style } as React.CSSProperties}
      {...props}
    >
      {children}
    </span>
  )
}
