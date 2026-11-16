/**
 * Bot avatars: a friendly face on a coloured shape, or the user's picture.
 *
 * The face is a static SVG — the outline is computed once per shape and
 * cached — and every bit of life is CSS (bots.css): an occasional blink at
 * rest, a gentle sway with "typing" dots while the bot is working. No timers
 * or animation frames, and `prefers-reduced-motion` stills it entirely.
 */

import { cn, profileColor } from '@agentx/plugin-sdk'
import type { CSSProperties } from 'react'

import { isPrimary } from './naming'
import type { BotMeta } from './types'

export const AVATAR_SHAPES = ['circle', 'blob', 'squircle', 'pill', 'triangle', 'hexagon', 'cloud', 'drop'] as const

export type AvatarShape = (typeof AVATAR_SHAPES)[number]

/** Bright enough to read on paper and on graphite. */
export const AVATAR_COLORS = [
  '#8b5cf6', // violet
  '#3b82f6', // blue
  '#38bdf8', // sky
  '#14b8a6', // teal
  '#22c55e', // green
  '#f59e0b', // amber
  '#f97316', // orange
  '#ef4444', // red
  '#ec4899', // pink
  '#94a3b8' // slate
] as const

const PRIMARY_LOOK = { shape: 'squircle' as AvatarShape, color: '#8b5cf6' }

type Point = [number, number]

function hashName(name: string): number {
  let hash = 0

  for (const ch of name) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  }

  return hash
}

/** Older picks (platonic solids, sigils) map onto today's outlines. */
export function normalizeShape(shape: string | null | undefined, name = 'agent'): AvatarShape {
  const value = (shape || '').trim()

  if ((AVATAR_SHAPES as readonly string[]).includes(value)) {
    return value as AvatarShape
  }

  switch (value) {
    case 'tetrahedron':

    case 'wedge':
      return 'triangle'

    case 'cube':

    case 'octahedron':
      return 'squircle'

    case 'dodecahedron':

    case 'icosahedron':

    case 'hex':
      return 'hexagon'

    case 'teardrop':
      return 'drop'

    case 'pebble':
      return 'blob'

    default:
      return value ? 'circle' : AVATAR_SHAPES[hashName(name) % AVATAR_SHAPES.length]
  }
}

/** The look a bot renders with. The primary profile gets a fixed friendly
 *  violet squircle unless the user customized it. */
export function botAppearance(
  name: string,
  meta: BotMeta | null | undefined
): { color: string; image: string | null; shape: AvatarShape } {
  const image = meta?.image || null

  if (isPrimary(name) && !meta?.custom) {
    return { ...PRIMARY_LOOK, image }
  }

  return {
    shape: normalizeShape(meta?.shape, name),
    color: meta?.color || profileColor(name) || AVATAR_COLORS[hashName(name) % AVATAR_COLORS.length],
    image
  }
}

/** Perceptual luminance — eyes flip light on dark bodies. */
export function isDarkColor(hex: string): boolean {
  const n = Number.parseInt(hex.replace('#', '').slice(0, 6), 16)

  if (!Number.isFinite(n)) {
    return false
  }

  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255) < 110
}

// ── outlines (40×40 box) ─────────────────────────────────────────────────────

const CLOUD_PATH = 'M11 32 a7.5 7.5 0 0 1 -1 -14.9 A9.5 9.5 0 0 1 29 12.5 A7 7 0 0 1 30 32 Z'

function cubicAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t

  return [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
  ]
}

function dropRing(steps: number): Point[] {
  const n = Math.max(8, Math.floor(steps / 3))
  const pts: Point[] = []

  for (let i = 0; i < n; i++) {
    pts.push(cubicAt([20, 3], [20, 3], [6, 20], [6, 27], i / n))
  }

  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI
    pts.push([20 - 14 * Math.cos(t), 27 + 13.5 * Math.sin(t)])
  }

  for (let i = 1; i <= n; i++) {
    pts.push(cubicAt([34, 27], [34, 20], [20, 3], [20, 3], i / n))
  }

  return pts
}

function polarRing(shape: AvatarShape, steps: number): Point[] {
  const pts: Point[] = []

  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2 - Math.PI / 2
    const c = Math.cos(a)
    const s = Math.sin(a)
    let r = 16.2

    if (shape === 'blob') {
      r = 16 + 1.7 * Math.sin(3 * a) + 0.7 * Math.cos(5 * a)
    } else if (shape === 'squircle') {
      r = 16.2 / (Math.pow(Math.abs(c) ** 5 + Math.abs(s) ** 5, 1 / 5) || 1)
    } else if (shape === 'pill') {
      r = 16 / (Math.pow(Math.abs(c) ** 8 + Math.abs(s / 0.72) ** 8, 1 / 8) || 1)
    } else if (shape === 'triangle') {
      const u = (a + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2)
      const sector = (u / ((Math.PI * 2) / 3)) % 1
      r = 13.5 / Math.max(0.42, Math.cos((sector - 0.5) * 1.9))
    } else if (shape === 'hexagon') {
      const seg = Math.PI / 3
      r = 16.2 * (Math.cos(seg / 2) / Math.cos(a - seg * Math.round(a / seg)))
    }

    pts.push([20 + r * c, 20 + r * s])
  }

  return pts
}

function ringToPath(pts: Point[]): string {
  return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join('') + 'Z'
}

const outlineCache = new Map<AvatarShape, string>()

export function shapeOutline(shape: AvatarShape): string {
  const cached = outlineCache.get(shape)

  if (cached) {
    return cached
  }

  const path = shape === 'cloud' ? CLOUD_PATH : ringToPath(shape === 'drop' ? dropRing(52) : polarRing(shape, 52))
  outlineCache.set(shape, path)

  return path
}

// ── component ────────────────────────────────────────────────────────────────

export type FaceMood = 'idle' | 'work'

export interface BotFaceProps {
  className?: string
  color: string
  image?: string | null
  mood?: FaceMood
  /** Seeds the blink offset so a roster doesn't blink in unison. */
  name?: string
  shape: AvatarShape
  size?: number
}

export function BotFace({ className, color, image, mood = 'idle', name = 'agent', shape, size = 36 }: BotFaceProps) {
  if (image) {
    return (
      <img
        alt=""
        aria-hidden
        className={cn('block shrink-0 object-cover', className)}
        draggable={false}
        src={image}
        style={{ width: size, height: size, borderRadius: '24%' }}
      />
    )
  }

  const working = mood === 'work'
  const eye = isDarkColor(color) ? 'rgba(250,246,238,0.95)' : 'rgba(15,15,20,0.86)'
  const eyeY = shape === 'cloud' ? 22 : 17.4
  const style = { '--bots-blink-delay': `${-(hashName(name) % 4000) / 1000}s` } as CSSProperties

  return (
    <svg
      aria-hidden
      className={cn('agentx-bots-face block shrink-0 overflow-visible', className)}
      data-mood={working ? 'work' : 'idle'}
      height={size}
      style={style}
      viewBox="0 0 40 44"
      width={size}
    >
      <g className="agentx-bots-face-body">
        <path d={shapeOutline(shape)} fill={color} />
        <g className="agentx-bots-face-eyes" style={{ transformOrigin: `20px ${eyeY}px` }}>
          <ellipse cx={15.4} cy={eyeY} fill={eye} rx={2.2} ry={working ? 2.6 : 2.3} />
          <ellipse cx={24.6} cy={eyeY} fill={eye} rx={2.2} ry={working ? 2.6 : 2.3} />
          <circle cx={14.8} cy={eyeY - 0.7} fill="rgba(255,255,255,0.85)" r={0.65} />
          <circle cx={24} cy={eyeY - 0.7} fill="rgba(255,255,255,0.85)" r={0.65} />
        </g>
      </g>
      {working ? (
        <g className="agentx-bots-face-dots" fill={color}>
          <circle cx={16.4} cy={41.2} r={1.15} />
          <circle cx={20} cy={41.2} r={1.15} />
          <circle cx={23.6} cy={41.2} r={1.15} />
        </g>
      ) : null}
    </svg>
  )
}

/** A bot's face from its name + meta — the one call sites use. */
export function BotAvatar({
  className,
  meta,
  mood,
  name,
  size
}: {
  className?: string
  meta: BotMeta | null | undefined
  mood?: FaceMood
  name: string
  size?: number
}) {
  const look = botAppearance(name, meta)

  return (
    <BotFace
      className={className}
      color={look.color}
      image={look.image}
      mood={mood}
      name={name}
      shape={look.shape}
      size={size}
    />
  )
}
