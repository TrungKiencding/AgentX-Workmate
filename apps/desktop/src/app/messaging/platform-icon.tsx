import {
  SiApple,
  SiBilibili,
  SiDiscord,
  SiGmail,
  SiGooglechat,
  SiHomeassistant,
  SiLine,
  SiMatrix,
  SiMattermost,
  SiNtfy,
  SiQq,
  SiSignal,
  SiSimplex,
  SiTelegram,
  SiWechat,
  SiWhatsapp
} from '@icons-pack/react-simple-icons'
import type { ComponentPropsWithoutRef, ComponentType, SVGProps } from 'react'
import { forwardRef, memo } from 'react'

import { ArrowsExchange, Globe, Hash, Link as LinkIcon, MessageSquareText, Plug } from '@/lib/icons'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Photon brand icon — three diagonal rounded bars (the Photon logo mark).
// Rendered at ~14 px inside the PlatformAvatar so the bars are kept thick
// enough to stay legible. At small sizes the bars blend into a distinctive
// silhouette; the wide triangular spacing preserves the logo's identity.
// ---------------------------------------------------------------------------
function PhotonIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg fill="currentColor" viewBox="0 0 24 24" {...props}>
      <rect height="10" rx="1.25" transform="rotate(15 14 7.5)" width="2.5" x="12.75" y="2.5" />
      <rect height="10" rx="1.25" transform="rotate(15 8 13)" width="2.5" x="6.75" y="8" />
      <rect height="10" rx="1.25" transform="rotate(15 16 18)" width="2.5" x="14.75" y="13" />
    </svg>
  )
}

// We render simpleicons.org brand glyphs for platforms whose owners publish a
// usable mark (telegram, discord, matrix, ...). Slack and Microsoft Teams are
// not in Simple Icons (Slack was removed at the brand owner's request), so they
// get a colored letter monogram. Protocol-style sources (webhooks, relays, IRC)
// get a generic glyph; an id with no entry at all (Dingtalk, Feishu, WeCom,
// Buzz, Raft) renders a neutral first-letter avatar.
//
// `iconColor` is the brand's hex from simpleicons.org so we can paint each
// glyph in its native color on top of a soft tint. The fallback monogram uses
// the same hex to keep visual consistency.
type IconKind = 'brand' | 'generic'

interface PlatformIconSpec {
  Icon?: ComponentType<SVGProps<SVGSVGElement>>
  color: string
  kind: IconKind
  monogram?: string
}

const PLATFORM_ICONS: Record<string, PlatformIconSpec> = {
  telegram: { Icon: SiTelegram, color: '#26A5E4', kind: 'brand' },
  discord: { Icon: SiDiscord, color: '#5865F2', kind: 'brand' },
  // Slack removed from Simple Icons by Salesforce request — letter monogram.
  slack: { color: '#4A154B', kind: 'brand', monogram: 'S' },
  // Microsoft Teams isn't in Simple Icons either — letter monogram.
  teams: { color: '#6264A7', kind: 'brand', monogram: 'T' },
  mattermost: { Icon: SiMattermost, color: '#0058CC', kind: 'brand' },
  matrix: { Icon: SiMatrix, color: '#000000', kind: 'brand' },
  signal: { Icon: SiSignal, color: '#3A76F0', kind: 'brand' },
  whatsapp: { Icon: SiWhatsapp, color: '#25D366', kind: 'brand' },
  whatsapp_cloud: { Icon: SiWhatsapp, color: '#25D366', kind: 'brand' },
  bluebubbles: { Icon: SiApple, color: '#0BD318', kind: 'brand' },
  photon: { Icon: PhotonIcon, color: '#6366F1', kind: 'brand' },
  homeassistant: { Icon: SiHomeassistant, color: '#18BCF2', kind: 'brand' },
  email: { Icon: SiGmail, color: '#EA4335', kind: 'brand' },
  sms: { Icon: MessageSquareText, color: '#F43F5E', kind: 'generic' },
  webhook: { Icon: LinkIcon, color: '#71717A', kind: 'generic' },
  msgraph_webhook: { Icon: LinkIcon, color: '#0078D4', kind: 'generic' },
  api_server: { Icon: Globe, color: '#64748B', kind: 'generic' },
  weixin: { Icon: SiWechat, color: '#07C160', kind: 'brand' },
  wecom_callback: { Icon: LinkIcon, color: '#2B7CE9', kind: 'generic' },
  qqbot: { Icon: SiQq, color: '#EB1923', kind: 'brand' },
  yuanbao: { Icon: SiBilibili, color: '#FB7299', kind: 'brand' },
  relay: { Icon: Plug, color: '#78716C', kind: 'generic' },
  a2a: { Icon: ArrowsExchange, color: '#0EA5E9', kind: 'generic' },
  google_chat: { Icon: SiGooglechat, color: '#34A853', kind: 'brand' },
  irc: { Icon: Hash, color: '#6B7280', kind: 'generic' },
  line: { Icon: SiLine, color: '#00C300', kind: 'brand' },
  ntfy: { Icon: SiNtfy, color: '#317F6F', kind: 'brand' },
  simplex: { Icon: SiSimplex, color: '#000000', kind: 'brand' }
}

// The avatar's three jobs: `sm` (24px) rides sidebar rows and MCP references,
// `md` (28px) the Messaging list rows, `lg` (40px) heads a platform's own page.
const AVATAR_SIZE = {
  sm: { box: 'size-6 text-[length:var(--conversation-caption-font-size)]', glyph: 'size-3.5' },
  md: { box: 'size-7 text-sm', glyph: 'size-4' },
  lg: { box: 'size-10 text-md', glyph: 'size-5' }
} as const

interface PlatformAvatarProps extends Omit<ComponentPropsWithoutRef<'span'>, 'children'> {
  platformId: string
  platformName: string
  size?: keyof typeof AVATAR_SIZE
}

// forwardRef + spreading ...rest is required so a wrapping <Tip> (Radix
// Tooltip's `asChild`) can actually attach its trigger: asChild clones this
// component and injects a ref plus pointer/focus/aria handlers onto it. A
// plain function component with no ref/rest forwarding drops all of that
// silently — the tooltip renders but never opens (#67500).
export const PlatformAvatar = memo(
  forwardRef<HTMLSpanElement, PlatformAvatarProps>(function PlatformAvatar(
    { className, platformId, platformName, size = 'sm', style, ...rest },
    ref
  ) {
    const spec = PLATFORM_ICONS[platformId]
    const metrics = AVATAR_SIZE[size]

    const baseClass = cn('inline-grid shrink-0 place-items-center rounded-md font-medium', metrics.box, className)

    if (!spec) {
      return (
        <span
          aria-hidden="true"
          className={cn(baseClass, 'bg-(--ui-bg-tertiary) text-(--ui-text-tertiary)')}
          ref={ref}
          style={style}
          {...rest}
        >
          {platformName.charAt(0).toUpperCase()}
        </span>
      )
    }

    const { Icon, color } = spec

    return (
      <span
        aria-hidden="true"
        className={baseClass}
        ref={ref}
        style={{
          // 16% tint of the brand color so the glyph reads against any surface
          // without the avatar dominating the row.
          backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)`,
          color,
          ...style
        }}
        {...rest}
      >
        {Icon ? <Icon className={metrics.glyph} /> : spec.monogram || platformName.charAt(0).toUpperCase()}
      </span>
    )
  })
)
