import { useStore } from '@nanostores/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Tip } from '@/components/ui/tooltip'
import { deleteMemoryEntry, getMemoryEntries, updateMemoryEntry } from '@/hermes'
import { type Translations, useI18n } from '@/i18n'
import { localeToBcp47 } from '@/i18n/languages'
import { triggerHaptic } from '@/lib/haptics'
import { Brain, Pencil, RefreshCw, Trash2 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { notify, notifyError } from '@/store/notifications'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import type { MemoryEntriesResponse, MemoryStoreContents, MemoryTarget } from '@/types/hermes'

import { Pill, SectionHeading } from '../primitives'

/**
 * Settings → Memory: what the built-in memory actually holds, entry by entry.
 *
 * The section used to offer only switches and character caps, while the chat
 * said "Saved to memory · 1 entry" — the user had no way to see, correct or
 * drop what was saved. Entries are addressed by their exact text (the backend
 * re-reads the file under its lock), so an edit made by the agent in the
 * meantime surfaces as "changed elsewhere" instead of hitting the wrong row.
 */

const MEMORY_ENTRIES_KEY = 'memory-entries'

/** The stable `code` a failed edit carries (see the /api/memory/entries
 *  handlers); the bridge hands errors over as `"<status>: <json body>"`. */
export function memoryEntryErrorCode(error: unknown): null | string {
  const message = error instanceof Error ? error.message : String(error ?? '')

  return /"code"\s*:\s*"([a-z_]+)"/.exec(message)?.[1] ?? null
}

function errorMessage(m: Translations['settings']['memoryEntries'], code: null | string, limit: string): null | string {
  switch (code) {
    case 'missing':
      return m.errorMissing

    case 'too_long':
      return m.errorTooLong(limit)

    case 'blocked':
      return m.errorBlocked

    case 'drift':

    case 'unreadable':
      return m.errorDrift

    case 'empty':
      return m.errorEmpty

    default:
      return null
  }
}

export function MemoryEntriesPanel() {
  const { locale, t } = useI18n()
  const m = t.settings.memoryEntries
  const queryClient = useQueryClient()
  // Per profile: each profile has its own memories/ folder.
  const profileKey = normalizeProfileKey(useStore($activeGatewayProfile))
  const queryKey = [MEMORY_ENTRIES_KEY, profileKey]

  const query = useQuery({
    queryKey,
    queryFn: getMemoryEntries,
    // The agent writes memory mid-chat; reopening Settings must show it.
    staleTime: 0
  })

  const numbers = new Intl.NumberFormat(localeToBcp47(locale))
  const reload = () => queryClient.invalidateQueries({ queryKey })

  return (
    <section aria-label={m.title} className="mb-6">
      <SectionHeading
        aside={
          <Tip label={t.common.refresh}>
            <Button
              aria-label={t.common.refresh}
              className="text-(--ui-text-tertiary) hover:text-foreground"
              disabled={query.isFetching}
              onClick={() => void reload()}
              size="icon-sm"
              variant="ghost"
            >
              <RefreshCw className={cn(query.isFetching && 'animate-spin')} />
            </Button>
          </Tip>
        }
        icon={Brain}
        title={m.title}
      />
      <p className="-mt-1 mb-3 text-sm text-(--ui-text-tertiary)">{m.description}</p>

      {query.isPending ? (
        <div className="grid gap-2" data-testid="memory-entries-loading">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-2/3" />
        </div>
      ) : query.isError ? (
        <div className="flex items-center gap-3 rounded-lg border border-(--ui-stroke-tertiary) px-3 py-2.5 text-sm">
          <span className="min-w-0 flex-1 text-(--ui-text-secondary)">{m.loadFailed}</span>
          <Button onClick={() => void query.refetch()} size="sm" variant="secondary">
            {t.common.retry}
          </Button>
        </div>
      ) : (
        <div className="grid gap-4">
          {(['user', 'memory'] as const).map(target => (
            <MemoryStoreBlock data={query.data} key={target} numbers={numbers} onChanged={reload} target={target} />
          ))}
        </div>
      )}
    </section>
  )
}

function MemoryStoreBlock({
  data,
  numbers,
  onChanged,
  target
}: {
  data: MemoryEntriesResponse
  numbers: Intl.NumberFormat
  onChanged: () => Promise<void>
  target: MemoryTarget
}) {
  const { t } = useI18n()
  const m = t.settings.memoryEntries
  const store: MemoryStoreContents = data[target]
  const [editing, setEditing] = useState<null | string>(null)
  const [confirmDelete, setConfirmDelete] = useState<null | string>(null)
  const limit = numbers.format(store.limit)

  const explain = async (error: unknown, fallback: string): Promise<string> => {
    const code = memoryEntryErrorCode(error)

    // The row moved under us (the agent edited memory meanwhile): show the
    // file as it is now so the next click acts on what's really there.
    if (code === 'missing' || code === 'drift') {
      await onChanged()
    }

    return errorMessage(m, code, limit) ?? fallback
  }

  const save = async (entry: string, content: string) => {
    if (content.trim() === entry) {
      setEditing(null)

      return
    }

    try {
      await updateMemoryEntry(target, entry, content)
      triggerHaptic('success')
      notify({ durationMs: 2_000, kind: 'success', message: m.saved })
      setEditing(null)
      await onChanged()
    } catch (error) {
      const message = await explain(error, m.saveFailed)

      if (memoryEntryErrorCode(error) === 'missing') {
        setEditing(null)
      }

      notifyError(new Error(message), m.saveFailed)
    }
  }

  const remove = async (entry: string) => {
    try {
      await deleteMemoryEntry(target, entry)
    } catch (error) {
      // Thrown back into ConfirmDialog, which shows it inline and stays open.
      throw new Error(await explain(error, m.deleteFailed))
    }

    triggerHaptic('success')
    notify({ durationMs: 2_000, kind: 'success', message: m.deleted })
    await onChanged()
  }

  return (
    <div className="grid gap-1.5" data-memory-target={target}>
      <div className="flex items-center gap-2">
        <span className="text-base font-medium text-foreground">{target === 'user' ? m.userTitle : m.memoryTitle}</span>
        <Pill>{m.usage(numbers.format(store.chars), limit)}</Pill>
        {!store.enabled && <Pill tone="warn">{t.common.off}</Pill>}
      </div>
      {!store.enabled && <p className="text-sm text-(--ui-text-tertiary)">{m.offHint}</p>}

      {!store.readable ? (
        <p className="text-sm text-destructive">{m.unreadable}</p>
      ) : store.entries.length === 0 ? (
        <p className="text-sm text-(--ui-text-quaternary)">{target === 'user' ? m.emptyUser : m.emptyMemory}</p>
      ) : (
        <ul className="grid gap-1">
          {store.entries.map(entry =>
            editing === entry ? (
              <MemoryEntryEditor
                entry={entry}
                key={entry}
                onCancel={() => setEditing(null)}
                onSave={content => save(entry, content)}
              />
            ) : (
              <li
                className="group/entry flex items-start gap-2 rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) px-3 py-2"
                key={entry}
              >
                <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-foreground/90">{entry}</p>
                <span className="-my-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-(--dur-short) focus-within:opacity-100 group-hover/entry:opacity-100">
                  <Tip label={m.edit}>
                    <Button aria-label={m.edit} onClick={() => setEditing(entry)} size="icon-sm" variant="ghost">
                      <Pencil />
                    </Button>
                  </Tip>
                  <Tip label={t.common.delete}>
                    <Button
                      aria-label={t.common.delete}
                      className="hover:text-destructive"
                      onClick={() => setConfirmDelete(entry)}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <Trash2 />
                    </Button>
                  </Tip>
                </span>
              </li>
            )
          )}
        </ul>
      )}

      <ConfirmDialog
        confirmLabel={t.common.delete}
        description={
          <>
            <span className="mb-2 block whitespace-pre-wrap break-words rounded-md bg-(--ui-bg-tertiary) px-2.5 py-1.5 text-foreground/90">
              {confirmDelete}
            </span>
            {m.deleteBody}
          </>
        }
        destructive
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => (confirmDelete === null ? undefined : remove(confirmDelete))}
        open={confirmDelete !== null}
        title={m.deleteTitle}
      />
    </div>
  )
}

function MemoryEntryEditor({
  entry,
  onCancel,
  onSave
}: {
  entry: string
  onCancel: () => void
  onSave: (content: string) => Promise<void>
}) {
  const { t } = useI18n()
  const m = t.settings.memoryEntries
  const [draft, setDraft] = useState(entry)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (saving) {
      return
    }

    setSaving(true)

    try {
      await onSave(draft)
    } finally {
      setSaving(false)
    }
  }

  return (
    <li className="grid gap-2 rounded-lg border border-(--ui-stroke-secondary) px-3 py-2">
      <Textarea
        aria-label={m.editLabel}
        autoFocus
        className="min-h-20 text-sm"
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onCancel()
          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void submit()
          }
        }}
        spellCheck
        value={draft}
      />
      <div className="flex justify-end gap-2">
        <Button disabled={saving} onClick={onCancel} size="sm" variant="ghost">
          {t.common.cancel}
        </Button>
        <Button disabled={saving || !draft.trim()} onClick={() => void submit()} size="sm">
          {saving ? t.common.saving : t.common.save}
        </Button>
      </div>
    </li>
  )
}
