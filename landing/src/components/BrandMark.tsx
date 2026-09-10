import { BRAND_MARK_PATHS, BRAND_MARK_VIEWBOX } from '../lib/brand-mark-path'

type Props = {
  /** Rendered size in px. The stroke stays optically even across sizes. */
  size?: number
  /** Stroke width in the 100×100 user space, before scaling. */
  weight?: number
  className?: string
  title?: string
}

/**
 * The AgentX mark, stroked. Inherits `currentColor`, so the mark takes the
 * colour of whatever it sits inside rather than shipping a blue of its own.
 * Decorative by default — pass `title` only where the mark is the sole label.
 */
export function BrandMark({ size = 24, weight = 7, className, title }: Props) {
  return (
    <svg
      aria-hidden={title ? undefined : true}
      className={className}
      fill="none"
      focusable="false"
      height={size}
      role={title ? 'img' : undefined}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={weight}
      viewBox={BRAND_MARK_VIEWBOX}
      width={size}
    >
      {title ? <title>{title}</title> : null}
      {BRAND_MARK_PATHS.map(d => (
        <path d={d} key={d} />
      ))}
    </svg>
  )
}
