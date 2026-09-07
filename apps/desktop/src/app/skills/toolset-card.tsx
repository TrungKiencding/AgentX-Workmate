import { Button } from '@/components/ui/button'
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
import type { ToolsetInfo } from '@/types/hermes'

import { toolsetCopy, toolsetSetupLed } from './skills-data'

// One tool as a store card: its glyph, the job it does in plain words, the
// switch, and one verb. The verb is the card's only real decision — "Thiết
// lập" boxed when something still stands between this tool and working (a
// missing key, an OS permission, an account to log into, a model to choose),
// a quiet "Chi tiết" when nothing does. Providers, keys, models and the
// function list all live behind it.
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
  const setupLed = toolsetSetupLed(toolset)

  return (
    <StoreCard data-testid="toolset-card" data-toolset={toolset.name}>
      <StoreCardHeader
        control={
          <Switch
            aria-label={t.skills.toggleToolset(copy.label, !toolset.enabled)}
            checked={toolset.enabled}
            className="cursor-pointer"
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
        // Off says so in words, not in colour alone — and it takes the one pill
        // slot when it applies, because a tool that is off is not waiting on
        // keys, it is simply not running. "Configured" as a resting state stays
        // unmarked; the footer verb is what says there is setup to do.
        meta={
          !toolset.enabled ? (
            <StatusPill tone="muted">{t.skills.switchedOff}</StatusPill>
          ) : (
            !toolset.configured && <StatusPill tone="warn">{t.skills.needsKeys}</StatusPill>
          )
        }
        title={copy.label}
      />
      <StoreCardDescription>{copy.description || t.skills.noDescription}</StoreCardDescription>
      <StoreCardFooter
        // How much it has been used, and nothing else. The function count that
        // used to fill this slot ("1 chức năng") named a number no one can act
        // on; the function list itself is still under Chi tiết kỹ thuật. While
        // analytics load the slot stays empty rather than shimmering — a row of
        // twenty-three skeletons that mostly resolve to nothing is worse than
        // the nothing it resolves to.
        end={calls && calls > 0 ? <StoreCardMeta>{t.skills.usageCount(compactNumber(calls))}</StoreCardMeta> : null}
      >
        {setupLed ? (
          <Button data-testid="toolset-set-up" onClick={onOpen} size="sm" variant="secondary">
            {t.skills.setUp}
          </Button>
        ) : (
          <Button data-testid="toolset-details" onClick={onOpen} size="sm" variant="text">
            {t.skills.details}
          </Button>
        )}
      </StoreCardFooter>
    </StoreCard>
  )
}
