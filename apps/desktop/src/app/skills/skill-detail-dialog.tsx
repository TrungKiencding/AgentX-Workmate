import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { StatusPill } from '@/components/ui/status-pill'
import { Switch } from '@/components/ui/switch'
import { TagChip } from '@/components/ui/tag-chip'
import { useI18n } from '@/i18n'
import { skillDisplayName } from '@/lib/skill-categories'
import { asText } from '@/lib/text'
import type { SkillInfo } from '@/types/hermes'

import type { PublishMode } from './publish-dialog'
import { categoryFor, categoryLabel } from './skills-data'
import { TechnicalDetailRow, TechnicalDetails } from './technical-details'

// Everything about one skill that the card leaves out: the whole description,
// its group and source, the switch and "Thử ngay" again so the decision can
// be made right here, and — for a skill AgentX learned on this machine — the
// tools to rewrite, share or archive it. Bundled and hub skills are managed
// by their sources, so they get no editing row.
export function SkillDetailDialog({
  busy = false,
  onArchive,
  onClose,
  onEdit,
  onPublish,
  onToggle,
  onTryNow,
  skill
}: {
  busy?: boolean
  onArchive: (skill: SkillInfo) => void
  onClose: () => void
  onEdit: (skill: SkillInfo) => void
  onPublish: (skill: SkillInfo, mode: PublishMode) => void
  onToggle: (skill: SkillInfo, enabled: boolean) => void
  onTryNow: (skill: SkillInfo) => void
  skill: SkillInfo | null
}) {
  const { t } = useI18n()
  const editable = skill?.provenance === 'agent'

  return (
    <Dialog onOpenChange={open => !open && onClose()} open={skill !== null}>
      <DialogContent className="max-w-xl" data-testid="skill-detail">
        {skill && (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 truncate">{skillDisplayName(skill.name)}</span>
                <TagChip>{categoryLabel(categoryFor(skill), t)}</TagChip>
                {skill.provenance && skill.provenance !== 'bundled' && (
                  <StatusPill tone={skill.provenance === 'agent' ? 'good' : 'muted'}>
                    {t.skills.provenance[skill.provenance]}
                  </StatusPill>
                )}
              </DialogTitle>
              <DialogDescription className="text-base">
                {asText(skill.description) || t.skills.noDescription}
              </DialogDescription>
            </DialogHeader>

            {editable && (
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => onEdit(skill)} size="sm" variant="secondary">
                  {t.skills.edit}
                </Button>
                <Button
                  data-testid="skill-upload-hub"
                  onClick={() => onPublish(skill, 'upload')}
                  size="sm"
                  variant="secondary"
                >
                  {t.skills.publish.upload}
                </Button>
                <Button
                  data-testid="skill-propose-workspace"
                  onClick={() => onPublish(skill, 'propose')}
                  size="sm"
                  variant="outline"
                >
                  {t.skills.publish.propose}
                </Button>
                <Button
                  className="text-destructive hover:text-destructive"
                  onClick={() => onArchive(skill)}
                  size="sm"
                  variant="outline"
                >
                  {t.skills.archive}
                </Button>
              </div>
            )}

            <TechnicalDetails>
              <TechnicalDetailRow
                label={t.skills.originalName}
                value={<span className="font-mono">{skill.name}</span>}
              />
              <TechnicalDetailRow
                label={t.skills.sourceLabel}
                value={skill.provenance ? t.skills.provenance[skill.provenance] : t.skills.provenance.bundled}
              />
            </TechnicalDetails>

            <DialogFooter className="items-center sm:justify-between">
              <label className="flex items-center gap-2 text-sm text-(--ui-text-secondary)">
                <Switch
                  aria-label={t.skills.toggleSkill(skillDisplayName(skill.name), !skill.enabled)}
                  checked={skill.enabled}
                  className="cursor-pointer"
                  disabled={busy}
                  onCheckedChange={enabled => onToggle(skill, enabled)}
                  size="md"
                />
                {skill.enabled ? t.skills.skillEnabled : t.skills.skillDisabled}
              </label>
              {skill.enabled && (
                <Button data-testid="skill-detail-try-now" onClick={() => onTryNow(skill)}>
                  {t.skills.tryNow}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
