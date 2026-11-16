import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { notifyError } from '@/store/notifications'
import { $projectDialog, closeProjectDialog, renameProjectOrAdopt } from '@/store/projects'

// Rename a project. Mounted once in the sidebar and driven by $projectDialog,
// so a row's menu opens it without prop threading. Creating a project and
// adding a folder have no dialog: both go straight to the folder picker.
export function ProjectDialog() {
  const { t } = useI18n()
  const p = t.sidebar.projects
  const state = useStore($projectDialog)
  const open = state !== null
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (state) {
      setName(state.name)
      setSubmitting(false)
      window.setTimeout(() => nameRef.current?.select(), 0)
    }
  }, [state])

  const trimmed = name.trim()
  const unchanged = trimmed === state?.name.trim()

  const submit = async () => {
    if (!state || submitting || !trimmed) {
      return
    }

    // Saving the name it already has is a no-op, not a write.
    if (unchanged) {
      closeProjectDialog()

      return
    }

    setSubmitting(true)

    try {
      await renameProjectOrAdopt(state, trimmed)
      closeProjectDialog()
    } catch (err) {
      notifyError(err, p.renameFailed)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog onOpenChange={next => !next && closeProjectDialog()} open={open}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{p.renameTitle}</DialogTitle>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={event => {
            event.preventDefault()
            void submit()
          }}
        >
          <Input
            aria-label={p.renameTitle}
            autoFocus
            disabled={submitting}
            onChange={event => setName(event.target.value)}
            ref={nameRef}
            value={name}
          />
          <DialogFooter>
            <Button disabled={submitting} onClick={closeProjectDialog} type="button" variant="ghost">
              {t.common.cancel}
            </Button>
            <Button disabled={submitting || !trimmed} type="submit">
              {t.common.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
