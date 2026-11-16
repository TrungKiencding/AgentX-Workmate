/**
 * Which listed files are gone from disk, so the card can stop listing them.
 *
 * The card is an inventory of what the conversation has: a report the person
 * deleted, or moved away in Finder, is not something it has any more. The
 * transcript keeps its own record (its file cards say "not found"); this list
 * drops the row instead of offering a click that can only fail.
 *
 * Checked when the list changes, when the person comes back to the window
 * (where a deletion in Finder happens), and every `PRESENCE_RECHECK_MS` while
 * the window is shown. A file that comes back (restored from the trash) is
 * listed again on the next check. A stat that gets no answer — an older shell,
 * a remote backend that is down — is not a "gone".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { statDesktopFile } from '@/lib/desktop-fs'

import type { SessionResource } from './model'

export const PRESENCE_RECHECK_MS = 15_000

const NOTHING_MISSING: ReadonlySet<string> = new Set()

/** Rows that point at a file on disk (not a page, an artifact or an inline image). */
export function isDiskFile(item: SessionResource): boolean {
  return item.kind === 'file' && !item.dataUrl && !item.artifact && Boolean(item.target)
}

/** The ids whose file a stat answered as not there. */
export async function findMissing(
  items: readonly SessionResource[],
  stat: typeof statDesktopFile = statDesktopFile
): Promise<Set<string>> {
  const files = items.filter(isDiskFile)
  const answers = await Promise.all(files.map(item => stat(item.target).catch(() => null)))
  const missing = new Set<string>()

  answers.forEach((answer, index) => {
    if (answer && !answer.exists) {
      missing.add(files[index].id)
    }
  })

  return missing
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every(id => b.has(id))

export interface FilePresence {
  /** Files known to be gone, by resource id. */
  missing: ReadonlySet<string>
  /** A row found its file gone on open: drop it now, not at the next check. */
  markMissing: (id: string) => void
}

export function useFilePresence(items: readonly SessionResource[], active: boolean): FilePresence {
  const [missing, setMissing] = useState<ReadonlySet<string>>(NOTHING_MISSING)
  const itemsRef = useRef(items)
  itemsRef.current = items

  // Only the files matter: a new web source does not warrant a disk check.
  const filesKey = useMemo(
    () =>
      items
        .filter(isDiskFile)
        .map(item => item.target)
        .join('\n'),
    [items]
  )

  useEffect(() => {
    if (!active || !filesKey) {
      setMissing(current => (current.size ? NOTHING_MISSING : current))

      return
    }

    let cancelled = false
    let running = false

    const check = async () => {
      if (running || document.visibilityState === 'hidden') {
        return
      }

      running = true

      try {
        const next = await findMissing(itemsRef.current)

        if (!cancelled) {
          setMissing(current => (sameSet(current, next) ? current : next))
        }
      } finally {
        running = false
      }
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void check()
      }
    }

    void check()
    const interval = setInterval(() => void check(), PRESENCE_RECHECK_MS)
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      clearInterval(interval)
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [active, filesKey])

  const markMissing = useCallback(
    (id: string) => setMissing(current => (current.has(id) ? current : new Set([...current, id]))),
    []
  )

  return { missing, markMissing }
}
