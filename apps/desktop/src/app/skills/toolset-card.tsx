import { Button } from '@/components/ui/button'
import { CountSkeleton } from '@/components/ui/skeleton'
import { StatusPill } from '@/components/ui/status-pill'
import {
  StoreCard,
  StoreCardDescription,
  StoreCardFooter,
  StoreCardGlyph,
  StoreCardHeader,
  StoreCardMeta
} from '@/components/ui/store-card'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { compactNumber } from '@/lib/format'
import { toolsetIcon } from '@/lib/toolset-icons'
import { cn } from '@/lib/utils'
import type { ToolsetInfo } from '@/types/hermes'

import { toolNames } from '../settings/helpers'

import { toolsetCopy } from './skills-data'

// One tool as a store card: its glyph, the job it does in plain words, the
// switch, and — only when it matters — a "Cần thiết lập" pill with a boxed
// "Thiết lập" verb. A tool that is ready shows a quiet "Chi tiết" instead;
// providers, keys, models and the function list all live behind it.
// `calls` is the analytics count over the window: `null` while it loads.
export function ToolsetCard({
  busy = false,
  calls,
  onOpen,
  onToggle,
  toolset
}: {
  busy?: boolean
  calls: null | number
  onOpen: () => void
  onToggle: (enabled: boolean) => void
  toolset: ToolsetInfo
}) {
  const { t } = useI18n()
  const copy = toolsetCopy(toolset, t)
  const Icon = toolsetIcon(toolset.name)
  const functions = toolNames(toolset).length

  return (
    <StoreCard data-testid="toolset-card" data-toolset={toolset.name}>
      <StoreCardHeader
        control={
          <Switch
            aria-label={t.skills.toggleToolset(copy.label, !toolset.enabled)}
            checked={toolset.enabled}
            className={cn('cursor-pointer', !toolset.enabled && 'opacity-60')}
            disabled={busy}
            onCheckedChange={onToggle}
            size="md"
          />
        }
        dimmed={!toolset.enabled}
        glyph={
          <StoreCardGlyph>
            <Icon />
          </StoreCardGlyph>
        }
        // "Configured" as a resting state is noise — only the warn state earns a pill.
        meta={!toolset.configured && <StatusPill tone="warn">{t.skills.needsKeys}</StatusPill>}
        title={copy.label}
      />
      <StoreCardDescription>{copy.description || t.skills.noDescription}</StoreCardDescription>
      <StoreCardFooter
        // How much it has been used, else how many functions it brings — and
        // nothing when a tool exposes no functions of its own ("0 chức năng"
        // tells a person nothing).
        end={
          calls === null ? (
            <StoreCardMeta>
              <CountSkeleton />
            </StoreCardMeta>
          ) : calls > 0 ? (
            <StoreCardMeta>{t.skills.usageCount(compactNumber(calls))}</StoreCardMeta>
          ) : functions > 0 ? (
            <StoreCardMeta>{t.skills.toolsetFunctions(functions)}</StoreCardMeta>
          ) : null
        }
      >
        {toolset.configured ? (
          <Button data-testid="toolset-details" onClick={onOpen} size="sm" variant="text">
            {t.skills.details}
          </Button>
        ) : (
          <Button data-testid="toolset-set-up" onClick={onOpen} size="sm" variant="secondary">
            {t.skills.setUp}
          </Button>
        )}
      </StoreCardFooter>
    </StoreCard>
  )
}
