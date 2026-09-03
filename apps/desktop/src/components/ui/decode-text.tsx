import { type ComponentProps, useEffect, useState } from 'react'

import { cn } from '@/lib/utils'

/**
 * DecodeText — the "CONNECTING" scramble-decode effect as a reusable
 * primitive (extracted from gateway-connecting-overlay.tsx; same mechanics):
 *
 *  - Even-weight mono ascii charset so cycling glyphs never jump width
 *    (matches the nousnet-web download-button decode effect).
 *  - Decode resolves half a character per 45ms tick; when fully resolved it
 *    holds for 16 ticks, then (in loop mode) replays.
 *  - The first `prefix` characters NEVER scramble — split at render level so
 *    no timer logic (even a stale HMR one) can garble them.
 *  - Optional blinking dither-cursor square.
 *
 * Typography (mono, small, uppercase, wide tracking) is baked in but opt-out
 * via `mono={false}` — the connect splash decodes in the display serif. Color
 * comes from the caller via className/text color so the same primitive works
 * on the boot overlay (--theme-primary) and quiet surfaces
 * (--ui-text-quaternary).
 */

export const DECODE_SCRAMBLE_CHARS = '/\\|-_=+<>~:*'
const TICK_MS = 45
const HOLD_TICKS = 16

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
}

function scrambled(tail: string, resolvedCount: number): string {
  return Array.from(tail, (ch, i) =>
    ch === ' ' || i < resolvedCount ? ch : DECODE_SCRAMBLE_CHARS[(Math.random() * DECODE_SCRAMBLE_CHARS.length) | 0]
  ).join('')
}

export interface DecodeTextProps extends Omit<ComponentProps<'span'>, 'prefix'> {
  text: string
  /** Leading character count that stays legible at all times. */
  prefix?: number
  /** Run the decode. When false, renders the plain resolved text (used to
   *  freeze the word during exit choreography). */
  active?: boolean
  /** Replay after the hold, or resolve once and stop. */
  loop?: boolean
  /** Blinking dither-cursor square after the text. */
  cursor?: boolean
  /**
   * Baked-in mono typography (11px, semibold, uppercase, 0.4em tracking).
   * Set false to inherit the caller's face instead. A proportional face can't
   * rely on the even-width charset, so the run then reserves its resolved
   * width and the scramble rides on top — the line never shifts, and screen
   * readers get the stable text rather than the garble.
   */
  mono?: boolean
}

export function DecodeText({
  active = true,
  className,
  cursor = false,
  loop = true,
  mono = true,
  prefix = 0,
  text,
  ...props
}: DecodeTextProps) {
  const staticPrefix = text.slice(0, prefix)
  const tailText = text.slice(prefix)
  const [tail, setTail] = useState(tailText)

  useEffect(() => {
    if (!active) {
      setTail(tailText)

      return
    }

    // Under reduced motion, skip the scramble interval and render the fully
    // resolved text immediately. The cursor blink (CSS animation) is also
    // killed by the blanket reduced-motion CSS rule.
    if (prefersReducedMotion()) {
      setTail(tailText)

      return
    }

    let resolved = 0
    let hold = 0

    const id = window.setInterval(() => {
      if (resolved >= tailText.length) {
        hold += 1

        if (hold > HOLD_TICKS) {
          if (loop) {
            resolved = 0
            hold = 0
          } else {
            window.clearInterval(id)
          }
        }

        setTail(tailText)

        return
      }

      resolved += 0.5
      setTail(scrambled(tailText, Math.floor(resolved)))
    }, TICK_MS)

    return () => window.clearInterval(id)
  }, [active, loop, tailText])

  const run = (
    <>
      {staticPrefix}
      {tail}
    </>
  )

  return (
    <span
      className={cn(
        'inline-flex items-center',
        mono && 'font-mono text-2xs font-semibold uppercase tracking-[0.4em] tabular-nums',
        className
      )}
      {...props}
    >
      {cursor && <style>{'@keyframes decode-cursor { 0%, 49% { opacity: 1 } 50%, 100% { opacity: 0 } }'}</style>}
      {mono ? (
        run
      ) : (
        // Two stacked copies: the transparent one is the only thing in flow,
        // so the box locks to the resolved width (and the a11y tree keeps the
        // real word); the scramble paints over it, out of flow, where a run of
        // wide glyphs can't push the line around.
        <span className="relative whitespace-nowrap">
          <span className="opacity-0">{text}</span>
          <span aria-hidden="true" className="absolute top-0 left-0">
            {run}
          </span>
        </span>
      )}
      {cursor && (
        <span
          aria-hidden="true"
          className={cn(
            'dither ml-0.5 inline-block shrink-0 -translate-y-px rounded-[1px]',
            // Decoration, not text: at a display size it rides the em box.
            mono ? 'size-2' : 'ml-[0.3em] size-[0.4em]'
          )}
          style={{ animation: 'decode-cursor 1s step-end infinite' }}
        />
      )}
    </span>
  )
}
