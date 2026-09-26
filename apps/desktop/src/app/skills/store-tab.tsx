import type * as React from 'react'

import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import { StatusPill, type StatusPillTone } from '@/components/ui/status-pill'
import type { HermesGateway } from '@/hermes'
import { useI18n } from '@/i18n'
import { ExternalLink, NotebookTabs, Plug } from '@/lib/icons'

import { SkillsHub } from './hub'
import { useHubSync } from './hub-status'
import { McpStore } from './mcp-store'

// Kho tiện ích — the one store behind the page: what AgentX can add, by kind.
// Its segments are the `?tab=` ids the two stores always had (`hub` for
// skills, `mcp` for connections), so every deep link into either keeps
// landing where it pointed. A third kind (data sources) is one more entry in
// STORE_SEGMENTS and one more branch below.
export const STORE_SEGMENTS = ['hub', 'mcp'] as const

export type StoreSegmentId = (typeof STORE_SEGMENTS)[number]

export const isStoreSegment = (value: string): value is StoreSegmentId =>
  (STORE_SEGMENTS as readonly string[]).includes(value)

export function StoreTab({
  gateway,
  onSegmentChange,
  query,
  segment
}: {
  gateway: HermesGateway | null
  onSegmentChange: (segment: StoreSegmentId) => void
  query: string
  segment: StoreSegmentId
}) {
  const { t } = useI18n()

  // One hub, one sync loop, whichever kind is on screen: the tick hands the
  // backend this session's bearer and reconciles what the hub wants here —
  // skills and MCP servers alike — so it runs for the whole store, not for
  // the skills segment alone.
  const sync = useHubSync()

  const options: readonly SegmentedControlOption<StoreSegmentId>[] = [
    { id: 'hub', icon: NotebookTabs, label: t.skills.storeSegment.hub },
    { id: 'mcp', icon: Plug, label: t.skills.storeSegment.mcp }
  ]

  const switcher = (
    <SegmentedControl
      aria-label={t.skills.tabStore}
      data-testid="store-segments"
      onChange={onSegmentChange}
      options={options}
      size="md"
      value={segment}
    />
  )

  return segment === 'hub' ? (
    <SkillsHub query={query} switcher={switcher} sync={sync} />
  ) : (
    <McpStore gateway={gateway} query={query} switcher={switcher} sync={sync} />
  )
}

/**
 * The bar that opens either store segment: the kind switch and where the
 * store comes from on the left, the segment's actions on the right, one line
 * of counts under it, then any notice worth a line of its own. Both segments
 * render it with the same switch in the same place, so changing kind reads
 * as one bar whose content changed — not as a second page.
 */
export function StoreBar({
  actions,
  children,
  line,
  source,
  switcher
}: {
  actions?: React.ReactNode
  children?: React.ReactNode
  line?: React.ReactNode
  source?: React.ReactNode
  switcher: React.ReactNode
}) {
  return (
    <div className="shrink-0 px-4 pt-3 pb-3" data-testid="store-bar">
      {/* Top-aligned so the actions stay on the switch's line when the left
          side wraps (the source drops under the switch on a narrow pane);
          the actions row is the switch's height, so their centres match. */}
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          {switcher}
          {source}
        </div>
        {actions && <div className="flex h-(--control-h-md) shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      {line && <p className="mt-2 text-sm text-(--ui-text-secondary)">{line}</p>}
      {children}
    </div>
  )
}

/** A notice line under the store bar — one sentence, in the tone it needs. */
export function StoreNotice({
  children,
  tone = 'muted',
  ...props
}: React.ComponentProps<'p'> & { tone?: 'bad' | 'muted' | 'warn' }) {
  const color =
    tone === 'bad' ? 'text-(--ui-red)' : tone === 'warn' ? 'text-(--ui-yellow)' : 'text-(--ui-text-tertiary)'

  return (
    <p className={`mt-1 text-sm ${color}`} {...props}>
      {children}
    </p>
  )
}

/** The hub as people know it — its host, not the scheme and path. */
export function hubHost(url: string | undefined): string {
  if (!url) {
    return ''
  }

  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** `fetched_at` (Unix seconds, 0/null = never) as a clock time in the UI's locale. */
export function syncedAt(seconds: null | number | undefined, locale: string): string {
  if (!seconds) {
    return ''
  }

  const date = new Date(seconds * 1000)

  if (Number.isNaN(date.getTime())) {
    return ''
  }

  try {
    return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return date.toLocaleTimeString()
  }
}

/**
 * Where the store comes from: whether the hub answers, and its host, which
 * opens the hub in the browser. The same pill and link on both segments.
 */
export function StoreSource({
  label,
  testId,
  tone,
  url
}: {
  label: string
  testId?: string
  tone: StatusPillTone
  url?: string
}) {
  const { t } = useI18n()

  return (
    <span className="flex min-w-0 items-center gap-2">
      <StatusPill data-testid={testId} tone={tone}>
        {label}
      </StatusPill>
      {url && (
        <a
          className="flex min-h-6 min-w-0 items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          href={url}
          rel="noreferrer"
          target="_blank"
          title={t.skills.hub.openHub}
        >
          <span className="truncate">{hubHost(url)}</span>
          <ExternalLink className="size-3 shrink-0" />
        </a>
      )}
    </span>
  )
}
