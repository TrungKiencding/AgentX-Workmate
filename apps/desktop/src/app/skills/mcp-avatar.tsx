import {
  SiFigma,
  SiGithub,
  SiGitlab,
  SiLinear,
  SiNotion,
  SiPostgresql,
  SiSentry,
  SiStripe,
  SiSupabase,
  SiVercel
} from '@icons-pack/react-simple-icons'
import type { ComponentType, SVGProps } from 'react'

import { cn } from '@/lib/utils'

import type { ServerStatus } from './mcp-model'

// Status dots paint from the semantic tokens so they follow the skin.
const STATUS_DOT: Record<ServerStatus, string> = {
  ok: 'bg-(--ui-green)',
  error: 'bg-(--ui-red)',
  'missing-runtime': 'bg-(--ui-red)',
  'needs-auth': 'bg-(--ui-yellow)',
  probing: 'animate-pulse bg-foreground/40',
  off: 'bg-foreground/20',
  unknown: 'bg-foreground/20'
}

// Brand glyphs for well-known MCP providers, exactly the Messaging avatar
// treatment (simpleicons on a 16% brand tint). Unknown servers fall back to
// the same letter monogram Messaging uses. A brand whose mark is black or
// near-black (`color: null`) draws in the ink on the neutral tile instead —
// its own colour would vanish on the dark band.
const MCP_BRAND_ICONS: Record<string, { Icon: ComponentType<SVGProps<SVGSVGElement>>; color: null | string }> = {
  figma: { Icon: SiFigma, color: '#F24E1E' },
  github: { Icon: SiGithub, color: null },
  gitlab: { Icon: SiGitlab, color: '#FC6D26' },
  linear: { Icon: SiLinear, color: '#5E6AD2' },
  notion: { Icon: SiNotion, color: null },
  postgres: { Icon: SiPostgresql, color: '#4169E1' },
  postgresql: { Icon: SiPostgresql, color: '#4169E1' },
  sentry: { Icon: SiSentry, color: '#362D59' },
  stripe: { Icon: SiStripe, color: '#635BFF' },
  supabase: { Icon: SiSupabase, color: '#3FCF8E' },
  vercel: { Icon: SiVercel, color: null }
}

const brandFor = (name: string) => {
  const lower = name.toLowerCase()

  return MCP_BRAND_ICONS[lower] ?? Object.entries(MCP_BRAND_ICONS).find(([key]) => lower.includes(key))?.[1] ?? null
}

// PlatformAvatar (messaging), same radius, type scale and brand-tint
// treatment — plus a status dot overlay. `md` (32px) is the card's glyph tile,
// the same box `StoreCardGlyph` gives a skill or a tool; `lg` (40px) heads a
// connection's own dialog. Identity ladder: curated brand glyph → letter
// monogram. We deliberately do NOT fetch remote favicons: a configured MCP URL
// can be a private/internal host, and hitting Google's favicon service for it
// would leak that hostname off-box. No `status` → no dot (a catalog card for
// something not connected has no live state to show).
const MCP_AVATAR_SIZE = {
  md: { box: 'size-8 text-base', glyph: 'size-4' },
  lg: { box: 'size-10 text-md', glyph: 'size-5' }
} as const

export function McpAvatar({
  className,
  name,
  size = 'md',
  status
}: {
  className?: string
  name: string
  size?: keyof typeof MCP_AVATAR_SIZE
  status?: ServerStatus
}) {
  const brand = brandFor(name)
  const metrics = MCP_AVATAR_SIZE[size]

  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-grid shrink-0 place-items-center rounded-md font-medium',
        metrics.box,
        !brand?.color && 'bg-(--ui-bg-tertiary)',
        !brand ? 'text-(--ui-text-tertiary)' : !brand.color && 'text-foreground',
        className
      )}
      data-slot="mcp-avatar"
      style={brand?.color ? { backgroundColor: `color-mix(in srgb, ${brand.color} 16%, transparent)` } : undefined}
    >
      {brand ? (
        <brand.Icon aria-hidden className={metrics.glyph} style={brand.color ? { color: brand.color } : undefined} />
      ) : (
        name.charAt(0).toUpperCase()
      )}
      {status && (
        <span
          className={cn(
            'absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-(--ui-chat-surface-background)',
            STATUS_DOT[status]
          )}
          data-status={status}
        />
      )}
    </span>
  )
}
