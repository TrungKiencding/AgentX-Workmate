import { useStore } from '@nanostores/react'
import { useId } from 'react'

import { $backdrop } from '@/store/backdrop'

/**
 * The mark as LINE ART: the medial axis of the shipped ring logo, traced once
 * from `assets/brand/mark-1024.png` (the raster every icon is generated from)
 * and normalised to a 100x100 box — the closed triangle-and-tail loop, plus the
 * short stroke that closes the tail. The ring itself is far too heavy to tile
 * at a whisper; its centreline draws the same glyph as a single hairline.
 * Nothing regenerates these automatically, so retrace if the artwork changes.
 */
const MARK_LINES = [
  'M86.48 52.24C86.69 53.79 87.45 58.76 87.70 61.59C87.96 64.41 87.30 66.51 88.01 69.21C88.72 71.90 91.14 75.46 91.97 77.74C92.80 80.03 93.00 81.18 92.99 82.93C92.97 84.67 92.24 87.01 91.87 88.21C91.50 89.41 91.26 89.53 90.75 90.14C90.24 90.75 89.43 91.43 88.82 91.87C88.21 92.31 87.82 92.53 87.09 92.78C86.37 93.04 85.47 93.22 84.45 93.39C83.43 93.56 82.49 93.90 81.00 93.80C79.51 93.70 77.69 93.55 75.51 92.78C73.32 92.02 71.31 89.84 67.89 89.23C64.46 88.62 57.13 89.14 54.98 89.13',
  'M74.80 42.68C74.46 41.34 74.07 40.02 73.58 38.72C73.09 37.42 73.73 38.86 71.85 34.86C69.97 30.86 64.40 18.95 62.30 14.74C60.20 10.52 60.08 10.70 59.25 9.55C58.42 8.40 57.94 8.27 57.32 7.83C56.69 7.38 56.69 7.22 55.49 6.91C54.29 6.61 51.95 6.00 50.10 6.00C48.26 6.00 45.73 6.55 44.41 6.91C43.09 7.27 42.84 7.66 42.17 8.13C41.51 8.60 41.21 8.69 40.45 9.76C39.68 10.82 42.97 3.39 37.60 14.53C32.23 25.68 13.26 65.74 8.23 76.63C3.20 87.52 7.64 78.69 7.42 79.88C7.20 81.06 6.83 82.38 6.91 83.74C7.00 85.09 7.64 87.04 7.93 88.01C8.21 88.97 8.10 88.87 8.64 89.53C9.18 90.19 10.38 91.40 11.18 91.97C11.97 92.55 12.26 92.68 13.41 92.99C14.57 93.29 16.38 93.80 18.09 93.80C19.80 93.80 16.99 95.80 23.68 92.99C30.37 90.18 51.66 80.06 58.23 76.93C64.80 73.80 61.64 75.17 63.11 74.19C64.58 73.20 65.94 72.09 67.07 71.04C68.21 69.99 69.05 68.99 69.92 67.89C70.78 66.79 71.53 65.75 72.26 64.43C72.98 63.11 73.78 61.37 74.29 59.96C74.80 58.55 75.03 57.49 75.30 56.00C75.58 54.51 75.86 52.56 75.91 51.02C75.97 49.47 75.80 48.14 75.61 46.75C75.42 45.36 75.14 44.02 74.80 42.68Z'
] as const

/**
 * One repeat of the pattern, in user units. Items sit on a 5x4 grid of cells
 * and are nudged off their cell centre (in cell fractions), which is what keeps
 * an even scatter from reading as a grid: the cells guarantee the spacing, the
 * nudges and the wide spread of sizes hide the rhythm. Anything crossing an
 * edge is wrapped by WRAP_OFFSETS below, so the seam never cuts a word in half.
 *
 * Three rules earn their keep here, and a tiled brand pattern looks like cheap
 * wallpaper without them: the tile is wide enough that a normal window shows
 * barely more than one of it; no two wordmarks repeat at the same size (equal
 * twins are what the eye locks onto and reads as a grid); and a few cells are
 * left EMPTY, because the gaps are what make it a texture rather than a sheet.
 */
const TILE_WIDTH = 720
const TILE_HEIGHT = 520
const TILE_COLUMNS = 5
const TILE_ROWS = 4

type TilePlacement = {
  /** Grid slot: [column, row]. */
  cell: readonly [number, number]
  /** Offset from the cell centre, in fractions of a cell. */
  nudge: readonly [number, number]
}

type TileItem = TilePlacement &
  (
    | { kind: 'mark'; size: number; angle: number }
    | { kind: 'word'; size: number; text: string }
    | { kind: 'dots'; count: number; gap: number; radius: number }
  )

const TILE: readonly TileItem[] = [
  { angle: -11, cell: [0, 0], kind: 'mark', nudge: [-0.04, -0.04], size: 44 },
  { cell: [1, 0], kind: 'word', nudge: [0.14, 0.12], size: 38, text: 'AgentX' },
  { angle: 21, cell: [3, 0], kind: 'mark', nudge: [0.12, -0.16], size: 26 },
  { cell: [4, 0], count: 3, gap: 11, kind: 'dots', nudge: [-0.06, 0.2], radius: 2.2 },
  { cell: [0, 1], kind: 'word', nudge: [0.06, -0.1], size: 26, text: 'Workmate' },
  { angle: -4, cell: [2, 1], kind: 'mark', nudge: [-0.08, 0.12], size: 68 },
  { cell: [3, 1], count: 2, gap: 10, kind: 'dots', nudge: [0.16, -0.14], radius: 2 },
  { angle: 24, cell: [4, 1], kind: 'mark', nudge: [-0.04, 0.06], size: 34 },
  { angle: -19, cell: [0, 2], kind: 'mark', nudge: [0.16, 0.14], size: 30 },
  { cell: [1, 2], count: 3, gap: 9, kind: 'dots', nudge: [-0.12, -0.08], radius: 1.9 },
  { cell: [2, 2], kind: 'word', nudge: [0.02, 0.16], size: 24, text: 'AgentX' },
  { angle: 8, cell: [4, 2], kind: 'mark', nudge: [0.06, -0.14], size: 48 },
  { cell: [0, 3], count: 2, gap: 10, kind: 'dots', nudge: [0.1, 0.12], radius: 2 },
  { angle: 14, cell: [1, 3], kind: 'mark', nudge: [-0.06, -0.02], size: 36 },
  { cell: [3, 3], kind: 'word', nudge: [-0.04, -0.06], size: 34, text: 'Workmate' },
  { angle: -8, cell: [4, 3], kind: 'mark', nudge: [0.14, 0.16], size: 24 }
]

/** The tile is stamped nine times so items straddling a seam continue across it. */
const WRAP_OFFSETS = [-1, 0, 1].flatMap(x => [-1, 0, 1].map(y => [x * TILE_WIDTH, y * TILE_HEIGHT] as const))

function cellCentre({ cell, nudge }: TilePlacement): readonly [number, number] {
  return [
    ((cell[0] + 0.5 + nudge[0]) * TILE_WIDTH) / TILE_COLUMNS,
    ((cell[1] + 0.5 + nudge[1]) * TILE_HEIGHT) / TILE_ROWS
  ]
}

/**
 * One item of the tile. Every stroke is `non-scaling-stroke` so the mark's own
 * `scale()` (and any future pattern transform) never thickens the hairline —
 * a watermark that changes weight with size stops reading as one texture.
 */
function TileArt({ item }: { item: TileItem }) {
  const [cx, cy] = cellCentre(item)

  if (item.kind === 'mark') {
    const half = item.size / 2

    return (
      <g
        transform={`translate(${cx - half} ${cy - half}) rotate(${item.angle} ${half} ${half}) scale(${item.size / 100})`}
      >
        {MARK_LINES.map(d => (
          <path d={d} key={d} vectorEffect="non-scaling-stroke" />
        ))}
      </g>
    )
  }

  if (item.kind === 'word') {
    // Hollow letterforms: the wordmark reads as drawn, not typed, and stays a
    // hairline like everything else in the tile.
    return (
      <text
        fontSize={item.size}
        fontWeight={800}
        letterSpacing={-item.size * 0.03}
        textAnchor="middle"
        vectorEffect="non-scaling-stroke"
        x={cx}
        y={cy}
      >
        {item.text}
      </text>
    )
  }

  return (
    <>
      {Array.from({ length: item.count }, (_, index) => (
        <circle
          cx={cx + (index - (item.count - 1) / 2) * item.gap}
          cy={cy + (index % 2 ? -4 : 0)}
          key={index}
          r={item.radius}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </>
  )
}

/**
 * The chat backdrop: the AgentX Workmate identity, tiled as hairline line art
 * behind the transcript. It paints from the accent token, so it follows the
 * skin (and the accent picker) instead of shipping its own blue, and one
 * strength knob per mode holds it at a whisper — see `.chat-watermark` in
 * styles.css. Off is a real setting (Settings -> Appearance -> Chat Backdrop).
 *
 * It renders INSIDE the composer-bounds wrapper and behind it (`z-index: -1`):
 * that wrapper paints an opaque surface fill, so a backdrop mounted as its
 * sibling would be covered. The old statue image dodged that by floating ON TOP
 * of the transcript at 2.5% with `mix-blend-difference`; brand art has to sit
 * behind the text instead, or it tints every glyph it crosses.
 */
export function ChatWatermark() {
  const on = useStore($backdrop)
  // One pattern per surface — tiles mount several ChatViews at once, and two
  // live SVG defs cannot share an id. `useId` is punctuated, `url(#…)` is not.
  const scope = useId().replace(/[^a-zA-Z0-9]/g, '')

  if (!on) {
    return null
  }

  const artId = `watermark-art-${scope}`
  const tileId = `watermark-tile-${scope}`

  return (
    <div aria-hidden className="chat-watermark" data-slot="chat-watermark">
      <svg>
        <defs>
          <g fill="none" id={artId} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1}>
            {TILE.map(item => (
              <TileArt item={item} key={`${item.kind}:${item.cell.join()}`} />
            ))}
          </g>
          <pattern height={TILE_HEIGHT} id={tileId} patternUnits="userSpaceOnUse" width={TILE_WIDTH}>
            {WRAP_OFFSETS.map(([x, y]) => (
              <use href={`#${artId}`} key={`${x},${y}`} x={x} y={y} />
            ))}
          </pattern>
        </defs>
        <rect fill={`url(#${tileId})`} height="100%" width="100%" />
      </svg>
    </div>
  )
}
