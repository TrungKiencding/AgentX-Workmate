import type * as React from 'react'

import { BRAND_MARK_PATHS } from '@/lib/brand-mark-path'
import { cn } from '@/lib/utils'

/**
 * The only illustrations the app draws for an empty surface: four monoline
 * figures, 96×96, each the AgentX mark beside ONE object that names what is
 * missing — a speech bubble, a folder, a plug, an open box. `currentColor` at
 * the quaternary ink, a 1.5px stroke, `aria-hidden`, and no animation: the
 * three beats of text under it (name · reason · one action) do the talking.
 * Nothing else is allowed here — no stock characters, no blobs, no Lottie.
 */
export type EmptyFigureKind = 'box' | 'chat' | 'folder' | 'plug'

/** The object beside the mark, drawn in the lower-right of the 96px box. */
const OBJECT: Record<EmptyFigureKind, React.ReactNode> = {
  // A speech bubble whose tail points back at the mark.
  chat: <path d="M44 48h34a6 6 0 0 1 6 6v18a6 6 0 0 1-6 6H58l-9 8v-8h-5a6 6 0 0 1-6-6V54a6 6 0 0 1 6-6Z" />,
  // A folder with its tab on the left.
  folder: (
    <>
      <path d="M40 50a5 5 0 0 1 5-5h11l5 5h18a5 5 0 0 1 5 5v22a5 5 0 0 1-5 5H45a5 5 0 0 1-5-5V50Z" />
      <path d="M40 60h44" />
    </>
  ),
  // A plug: two prongs, the body, and a cord that trails off.
  plug: (
    <>
      <path d="M57 44v9M69 44v9" />
      <path d="M50 53h26v7a13 13 0 0 1-13 13 13 13 0 0 1-13-13v-7Z" />
      <path d="M63 73v6c0 4 3 5 6 5h3" />
    </>
  ),
  // An open box: the front face, the lid folded back, and one open flap.
  box: (
    <>
      <path d="M42 56h40v24H42z" />
      <path d="M42 56l8-9h24l8 9" />
      <path d="M50 47l8 9M74 47l-8 9M62 56v24" />
    </>
  )
}

export function EmptyFigure({
  className,
  figure,
  ...props
}: Omit<React.ComponentProps<'svg'>, 'children'> & { figure: EmptyFigureKind }) {
  return (
    <svg
      aria-hidden="true"
      className={cn('size-24 shrink-0 text-(--ui-text-quaternary)', className)}
      data-figure={figure}
      data-slot="empty-figure"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
      viewBox="0 0 96 96"
      {...props}
    >
      {/* The mark, upper-left, at 40px — the same geometry as the watermark. */}
      <g transform="translate(10 12) scale(0.4)">
        {BRAND_MARK_PATHS.map(d => (
          <path d={d} key={d} vectorEffect="non-scaling-stroke" />
        ))}
      </g>
      {OBJECT[figure]}
    </svg>
  )
}
