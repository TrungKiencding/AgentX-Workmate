import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useResizeObserver } from '@/hooks/use-resize-observer'
import { $backdrop } from '@/store/backdrop'

import { GlyphFieldPainter } from './painter'

interface GlyphFieldProps {
  /**
   * Whether the chat is empty. The sheet is the ground of the empty chat only:
   * it is armed with the greeting and fades away as the conversation starts,
   * because characters behind a transcript compete with the text in it.
   */
  active: boolean
}

/**
 * The chat backdrop: blank paper that a click lets ink into. A primary click
 * anywhere on the chat surface sends a ring of small monospaced characters out
 * from the pointer; each flashes in the accent and settles into a grey trace
 * that only holds on the strokes of a hidden drawing, then fades back to
 * white (lib/glyph-field.ts is the model, ./painter.ts the canvas). Ink and
 * accent come from the theme, the loudness from one token per mode — see
 * `.glyph-field` in styles.css. Off is a real setting (Settings -> Appearance
 * -> Chat Backdrop).
 *
 * It renders INSIDE the composer-bounds wrapper and behind it (`z-index: -1`):
 * that wrapper paints an opaque surface fill, so a backdrop mounted as its
 * sibling would be covered.
 */
export function GlyphField({ active }: GlyphFieldProps) {
  const on = useStore($backdrop)

  return on ? <GlyphFieldSheet active={active} /> : null
}

function GlyphFieldSheet({ active }: GlyphFieldProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [painter] = useState(() => new GlyphFieldPainter())

  const onResize = useCallback(
    (entries: readonly ResizeObserverEntry[]) => {
      const box = entries.at(-1)?.contentRect ?? hostRef.current?.getBoundingClientRect()

      if (box) {
        painter.resize(box.width, box.height)
      }
    },
    [painter]
  )

  useResizeObserver(onResize, hostRef)

  useEffect(() => {
    const host = hostRef.current
    const canvas = canvasRef.current

    return host && canvas ? painter.attach(host, canvas) : undefined
  }, [painter])

  useEffect(() => painter.setActive(active), [active, painter])

  return (
    <div aria-hidden className="glyph-field" data-slot="glyph-field" data-state={active ? 'on' : 'off'} ref={hostRef}>
      <canvas ref={canvasRef} />
    </div>
  )
}
