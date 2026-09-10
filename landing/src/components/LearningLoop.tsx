import { useEffect, useRef, useState } from 'react'

import { BRAND_MARK_PATHS } from '../lib/brand-mark-path'

const CENTRE = 180
const RADIUS = 118
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** Where each numbered node sits, clockwise from the top. */
const NODES = [-90, 0, 90, 180].map((deg, index) => {
  const rad = (deg * Math.PI) / 180

  return {
    n: String(index + 1),
    x: CENTRE + RADIUS * Math.cos(rad),
    y: CENTRE + RADIUS * Math.sin(rad)
  }
})

/** Chevrons sit between the nodes and point the way round. */
const ARROWS = [-45, 45, 135, 225].map(deg => {
  const rad = (deg * Math.PI) / 180

  return {
    deg,
    x: CENTRE + RADIUS * Math.cos(rad),
    y: CENTRE + RADIUS * Math.sin(rad)
  }
})

/**
 * The learning loop, hand-drawn in SVG.
 *
 * This is the page's one scroll-triggered moment: the ring draws itself once,
 * clockwise, when the diagram comes into view, then stops. Nothing else on the
 * page animates on scroll — a page where every section fades up never settles.
 * Under `prefers-reduced-motion` the ring is simply already drawn.
 */
export function LearningLoop({ title }: { title: string }) {
  const ref = useRef<SVGSVGElement>(null)
  const [drawn, setDrawn] = useState(false)

  useEffect(() => {
    const node = ref.current

    if (!node) {
      return
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDrawn(true)

      return
    }

    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setDrawn(true)
          observer.disconnect()
        }
      },
      { rootMargin: '0px 0px -20% 0px' }
    )

    observer.observe(node)

    return () => observer.disconnect()
  }, [])

  return (
    <figure className="loopfig">
      <svg
        aria-label={title}
        className="loopfig__svg"
        data-drawn={drawn || undefined}
        ref={ref}
        role="img"
        viewBox="0 0 360 360"
      >
        {/* The track the loop runs on — always visible, so the shape reads
            even before the bright arc arrives. */}
        <circle
          className="loopfig__track"
          cx={CENTRE}
          cy={CENTRE}
          fill="none"
          r={RADIUS}
          stroke="currentColor"
          strokeWidth="1"
        />

        <circle
          className="loopfig__ink"
          cx={CENTRE}
          cy={CENTRE}
          fill="none"
          r={RADIUS}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE}
          strokeLinecap="round"
          strokeWidth="2"
          transform={`rotate(-90 ${CENTRE} ${CENTRE})`}
        />

        <g className="loopfig__mark" transform={`translate(${CENTRE - 34} ${CENTRE - 34}) scale(0.68)`}>
          {BRAND_MARK_PATHS.map(d => (
            <path d={d} fill="none" key={d} stroke="currentColor" strokeLinejoin="round" strokeWidth="3" />
          ))}
        </g>

        {ARROWS.map(arrow => (
          <path
            className="loopfig__arrow"
            d="M-6 -6 L0 0 L-6 6"
            fill="none"
            key={arrow.deg}
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            transform={`translate(${arrow.x.toFixed(2)} ${arrow.y.toFixed(2)}) rotate(${arrow.deg + 90})`}
          />
        ))}

        {NODES.map((node, index) => (
          <g className="loopfig__node" key={node.n} style={{ '--i': index } as React.CSSProperties}>
            <circle cx={node.x.toFixed(2)} cy={node.y.toFixed(2)} r="30" />
            <text dy="0.36em" x={node.x.toFixed(2)} y={node.y.toFixed(2)}>
              {node.n}
            </text>
          </g>
        ))}
      </svg>
    </figure>
  )
}
