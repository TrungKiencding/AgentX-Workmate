import { useStore } from '@nanostores/react'
import { useRef, useState } from 'react'

import { ArchiveSkillConfirmDialog } from '@/app/learning/archive-skill-confirm-dialog'
import { memoryEntryErrorCode } from '@/app/settings/memory/memory-entries'
import { CodeEditor } from '@/components/chat/code-editor'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { deleteLearningNode, editLearningNode, getLearningNode } from '@/hermes'
import { type Translations, useI18n } from '@/i18n'
import { notifyError } from '@/store/notifications'
import { $starmapMemoryLocked, evictStarmapNode, mutateStarmap } from '@/store/starmap'

import { useOnProfileSwitch } from '../hooks/use-on-profile-switch'

export interface NodeMenuTarget {
  /** A memory node's exact text, when the graph carries it: edits and deletes
   *  go by it, so they can't land on whatever entry now holds the node's
   *  positional id. */
  entry?: string
  id: string
  kind: 'memory' | 'skill'
  label: string
  x: number
  y: number
}

interface NodeContextMenuProps {
  onClose: () => void
  onNodeRemoved: () => void
  target: NodeMenuTarget | null
}

interface EditState {
  content: string
  entry?: string
  id: string
  kind: NodeMenuTarget['kind']
  label: string
}

/** A memory edit/delete the backend refused, worded by its stable `code`. */
function memoryFailure(m: Translations['starmap']['nodeMenu'], error: unknown): unknown {
  switch (memoryEntryErrorCode(error)) {
    case 'missing':
      return new Error(m.memoryChanged)

    case 'too_long':
      return new Error(m.memoryTooLong)

    case 'blocked':
      return new Error(m.memoryBlocked)

    case 'drift':

    case 'unreadable':
      return new Error(m.memoryDrift)

    default:
      return error
  }
}

/** Right-click actions for a star-map node: edit (modal) or delete (confirm). */
export function NodeContextMenu({ onClose, onNodeRemoved, target }: NodeContextMenuProps) {
  const { t } = useI18n()
  const m = t.starmap.nodeMenu
  // Set from a map edit/delete until the graph reloads after it — memory ids
  // shift on a delete, so the menu holds memory actions until they're fresh.
  const memoryLocked = useStore($starmapMemoryLocked)
  const [editing, setEditing] = useState<EditState | null>(null)
  const [deleting, setDeleting] = useState<Omit<NodeMenuTarget, 'x' | 'y'> | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<null | string>(null)

  // Bumped on profile switch so an in-flight openEdit fetch from profile A can't
  // reopen the editor with A's node content after switching to B.
  const editEpoch = useRef(0)

  // A profile switch swaps the backend under an open edit/delete dialog — its
  // node id belongs to the previous profile, so a Save/Delete after the switch
  // would hit the newly active profile. Close everything on switch.
  useOnProfileSwitch(() => {
    editEpoch.current += 1
    setEditing(null)
    setDeleting(null)
    setError(null)
  })

  const memoryBusy = target?.kind === 'memory' && memoryLocked

  const openEdit = async () => {
    if (!target) {
      return
    }

    const epoch = editEpoch.current
    setLoading(true)
    setError(null)

    try {
      // A memory opens as the graph showed it; fetching by its positional id
      // could return a neighbour.
      const content = target.entry ?? (await getLearningNode(target.id)).content

      if (editEpoch.current !== epoch) {
        return
      }

      setEditing({ content, entry: target.entry, id: target.id, kind: target.kind, label: target.label })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const save = async () => {
    // The editor's Mod-S bypasses the disabled Save button; a second save by
    // the old entry text would only find it gone.
    if (!editing || saving) {
      return
    }

    setSaving(true)
    setError(null)

    await mutateStarmap(
      async () => {
        const res = await editLearningNode(editing.id, editing.content, editing.entry)

        if (!res.ok) {
          throw new Error(res.message)
        }

        setEditing(null)
      },
      e => {
        const failure = memoryFailure(m, e)
        setError(failure instanceof Error ? failure.message : String(failure))
      }
    )
    setSaving(false)
  }

  const menuOpen = target && !editing && !deleting

  return (
    <>
      {menuOpen ? (
        <>
          <div className="fixed inset-0 z-50" onClick={onClose} onContextMenu={e => e.preventDefault()} />
          {/* Styled to DropdownMenuContent/Item scale (rounded-lg card, p-1,
              text-xs rows) — the hand-rolled fixed positioning stays because
              the target is a canvas point, not a DOM anchor. */}
          <div
            className="fixed z-50 min-w-36 rounded-lg border border-(--ui-stroke-secondary) bg-[color-mix(in_srgb,var(--ui-bg-elevated)_96%,transparent)] p-1 shadow-md backdrop-blur-md"
            style={{ left: target.x, top: target.y }}
          >
            <div className="truncate px-2 py-1 text-2xs text-muted-foreground">{target.label}</div>
            <button
              className="block w-full cursor-pointer rounded-md px-2 py-1 text-left text-xs hover:bg-(--ui-control-active-background) hover:text-foreground disabled:opacity-50"
              disabled={loading || memoryBusy}
              onClick={() => void openEdit()}
              type="button"
            >
              {target.kind === 'skill' ? m.editSkill : m.editMemory}
            </button>
            <button
              className="block w-full cursor-pointer rounded-md px-2 py-1 text-left text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
              disabled={memoryBusy}
              onClick={() => {
                setDeleting({ entry: target.entry, id: target.id, kind: target.kind, label: target.label })
                onClose()
              }}
              type="button"
            >
              {target.kind === 'skill' ? m.archiveSkill : m.deleteMemory}
            </button>
          </div>
        </>
      ) : null}

      <Dialog onOpenChange={value => !value && !saving && setEditing(null)} open={Boolean(editing)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{m.editTitle(editing?.label ?? '')}</DialogTitle>
          </DialogHeader>
          <div className="h-80">
            {editing && (
              <CodeEditor
                filePath={editing.kind === 'skill' ? 'SKILL.md' : 'memory.md'}
                framed
                initialValue={editing.content}
                key={editing.id}
                onCancel={() => !saving && setEditing(null)}
                onChange={content => setEditing(prev => (prev ? { ...prev, content } : prev))}
                onSave={() => void save()}
              />
            )}
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button disabled={saving} onClick={() => setEditing(null)} type="button" variant="ghost">
              {t.common.cancel}
            </Button>
            <Button disabled={saving} onClick={() => void save()}>
              {saving ? t.common.saving : t.common.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {deleting?.kind === 'skill' ? (
        <ArchiveSkillConfirmDialog
          onApply={() => {
            onNodeRemoved()

            return evictStarmapNode(deleting.id)
          }}
          onClose={() => setDeleting(null)}
          onFailure={(err, name) => notifyError(err, name)}
          open
          skillId={deleting.id}
          skillName={deleting.label}
        />
      ) : (
        <ConfirmDialog
          confirmLabel={t.common.delete}
          description={m.deleteBody}
          destructive
          dismissOnConfirm
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            if (!deleting) {
              return
            }

            const { entry, id, label } = deleting
            const rollback = evictStarmapNode(id)
            onNodeRemoved()

            void mutateStarmap(
              async () => {
                const res = await deleteLearningNode(id, entry)

                if (!res.ok) {
                  throw new Error(res.message)
                }
              },
              err => {
                rollback()
                notifyError(memoryFailure(m, err), label)
              }
            )
          }}
          open={Boolean(deleting)}
          title={m.deleteTitle(deleting?.label ?? '')}
        />
      )}
    </>
  )
}
