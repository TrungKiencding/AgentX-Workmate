import { useStore } from '@nanostores/react'
import { useId } from 'react'

import { BRAND_MARK_PATHS } from '@/lib/brand-mark-path'
import { $backdrop } from '@/store/backdrop'

// The mark's geometry lives in lib/brand-mark-path.ts, shared with the
// BrandGlyph at the head of a reply and the EmptyFigure illustrations.
const MARK_LINES = BRAND_MARK_PATHS

/**
 * Every mark leans the same few degrees. One shared lean reads as a texture;
 * a scatter of angles reads as stickers thrown at the wall.
 */
const MARK_LEAN = -6

/**
 * The wordmarks are set, not outlined. Hollow letterforms were the first cut,
 * and they are what makes a brand watermark look cheap: outlining a heavy face
 * doubles every contour into bubble lettering, the crossbar of a "t" becomes
 * a little cross, and tight tracking welds neighbouring outlines together.
 * Filled Geist at the light end of its axis has stems of 1–2px at these sizes,
 * so at partial ink the words land in the same register as the 1px marks
 * instead of shouting over them; a touch of tracking keeps the light face open.
 */
const WORD_WEIGHT = 200
const WORD_INK = 0.7
const WORD_TRACKING = 0.015

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
 * twins are what the eye locks onto and reads as a grid); and eight of the
 * twenty cells are left EMPTY, because the gaps are what make it a texture
 * rather than a sheet. Two kinds of item only — the mark and the two words.
 * Filler (dot clusters, sparkles) reads as lint at a whisper.
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

type TileItem = TilePlacement & ({ kind: 'mark'; size: number } | { kind: 'word'; size: number; text: string })

const TILE: readonly TileItem[] = [
  { cell: [0, 0], kind: 'mark', nudge: [-0.04, -0.04], size: 44 },
  { cell: [1, 0], kind: 'word', nudge: [0.14, 0.12], size: 38, text: 'AgentX' },
  { cell: [3, 0], kind: 'mark', nudge: [0.12, -0.16], size: 26 },
  { cell: [0, 1], kind: 'word', nudge: [0.06, -0.1], size: 26, text: 'Workmate' },
  { cell: [2, 1], kind: 'mark', nudge: [-0.08, 0.12], size: 68 },
  { cell: [4, 1], kind: 'mark', nudge: [-0.04, 0.06], size: 34 },
  { cell: [0, 2], kind: 'mark', nudge: [0.16, 0.14], size: 30 },
  { cell: [2, 2], kind: 'word', nudge: [0.02, 0.16], size: 24, text: 'AgentX' },
  { cell: [4, 2], kind: 'mark', nudge: [0.06, -0.14], size: 48 },
  { cell: [1, 3], kind: 'mark', nudge: [-0.06, -0.02], size: 36 },
  { cell: [3, 3], kind: 'word', nudge: [-0.04, -0.06], size: 34, text: 'Workmate' },
  { cell: [4, 3], kind: 'mark', nudge: [0.14, 0.16], size: 24 }
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
        transform={`translate(${cx - half} ${cy - half}) rotate(${MARK_LEAN} ${half} ${half}) scale(${item.size / 100})`}
      >
        {MARK_LINES.map(d => (
          <path d={d} key={d} vectorEffect="non-scaling-stroke" />
        ))}
      </g>
    )
  }

  return (
    <text
      fill="currentColor"
      fillOpacity={WORD_INK}
      fontSize={item.size}
      fontWeight={WORD_WEIGHT}
      letterSpacing={item.size * WORD_TRACKING}
      stroke="none"
      textAnchor="middle"
      x={cx}
      y={cy}
    >
      {item.text}
    </text>
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
