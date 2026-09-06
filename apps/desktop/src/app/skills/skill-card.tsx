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
import { skillCategoryIcon, skillDisplayName } from '@/lib/skill-categories'
import { asText } from '@/lib/text'
import { cn } from '@/lib/utils'
import type { SkillInfo } from '@/types/hermes'

import { categoryFor, usageOf } from './skills-data'

// One skill you already have, as a store card. What a person needs at a
// glance and nothing more: the group's glyph, the name, whether AgentX
// learned it itself, one sentence on what it does, the switch, how often it
// has been used, and the one verb — "Thử ngay" as a soft-fill button, so
// eighty cards read as a calm grid rather than eighty primary calls to
// action (the store keeps the primary for "Thêm kỹ năng này"). The raw slug,
// the source and the editing tools live behind "Chi tiết".
export function SkillCard({
  busy = false,
  onDetails,
  onToggle,
  onTryNow,
  skill
}: {
  busy?: boolean
  onDetails: () => void
  onToggle: (enabled: boolean) => void
  onTryNow: () => void
  skill: SkillInfo
}) {
  const { t } = useI18n()
  const name = skillDisplayName(skill.name)
  const Icon = skillCategoryIcon(categoryFor(skill))
  const usage = usageOf(skill)

  return (
    <StoreCard data-skill={skill.name} data-testid="skill-card">
      <StoreCardHeader
        control={
          <Switch
            aria-label={t.skills.toggleSkill(name, !skill.enabled)}
            checked={skill.enabled}
            className={cn('cursor-pointer', !skill.enabled && 'opacity-60')}
            disabled={busy}
            onCheckedChange={onToggle}
            size="md"
          />
        }
        dimmed={!skill.enabled}
        glyph={
          <StoreCardGlyph>
            <Icon />
          </StoreCardGlyph>
        }
        // Learned skills earn a quiet pill beside the name; bundled is the
        // resting state and stays unmarked.
        meta={skill.provenance === 'agent' && <StatusPill tone="muted">{t.skills.provenance.agent}</StatusPill>}
        title={name}
      />
      <StoreCardDescription>{asText(skill.description) || t.skills.noDescription}</StoreCardDescription>
      <StoreCardFooter
        end={
          <>
            {usage > 0 && <StoreCardMeta>{t.skills.usageCount(compactNumber(usage))}</StoreCardMeta>}
            {skill.enabled && (
              <Button data-testid="skill-try-now" onClick={onTryNow} size="sm" variant="secondary">
                {t.skills.tryNow}
              </Button>
            )}
          </>
        }
      >
        <Button onClick={onDetails} size="sm" variant="text">
          {t.skills.details}
        </Button>
      </StoreCardFooter>
    </StoreCard>
  )
}
