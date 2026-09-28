import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useI18n } from '@/i18n'
import { updateHubSkill } from '@/store/hub-actions'
import { notify, notifyError } from '@/store/notifications'

/** A hub skill edited on this machine, with the Hub version that would replace it. */
export interface ReplaceTarget {
  identifier: string
  /** The installed name — what `agentx skills update <name>` takes. */
  name: string
  version: string
}

// "Update all" keeps a hub skill edited on this machine; replacing one is its
// own decision, asked here. The backend copies the edit to
// skills/.hub/backups/ before the Hub version goes in (hub decision §8 #20).
export function ReplaceEditedSkillDialog({ onClose, target }: { onClose: () => void; target: null | ReplaceTarget }) {
  const { t } = useI18n()
  const h = t.skills.hub

  return (
    <ConfirmDialog
      confirmLabel={h.replaceConfirm}
      description={target ? h.replaceDescription(target.version) : undefined}
      dismissOnConfirm
      onClose={onClose}
      onConfirm={() => {
        if (!target) {
          return
        }

        notify({ kind: 'success', title: h.replaceStarted(target.name), message: h.actionLog })
        void updateHubSkill(target.identifier, target.name, { overwriteLocal: true }).catch(err =>
          notifyError(err, h.actionFailed)
        )
      }}
      open={target !== null}
      title={target ? h.replaceTitle(target.name) : ''}
    />
  )
}
