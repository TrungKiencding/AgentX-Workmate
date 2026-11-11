/**
 * Mirror of "which chats are mid-turn" to the main process.
 *
 * The renderer is the only side that knows a turn is in flight, and the main
 * process is the only side that can intercept a quit. This module bridges the
 * two: it publishes a small summary on every membership change, and
 * `electron/quit-guard.ts` turns that into the confirmation dialog.
 *
 * Imported for its side effect from `main.tsx`, alongside `store/translucency`.
 */

import { computed } from 'nanostores'

import type { HermesActiveWork } from '@/global'
import { translationsNow } from '@/i18n'
import { $runtimeLocale } from '@/i18n/runtime'
import { $sessions } from '@/store/session'
import { $workingSessionIds } from '@/store/session-states'

// `$runtimeLocale` is a dependency so a language change while a turn runs
// re-sends the confirmation's words in the new language.
const $activeWork = computed(
  [$workingSessionIds, $sessions, $runtimeLocale],
  (workingIds, sessions): HermesActiveWork => {
    const titleById = new Map(sessions.map(session => [session.id, session.title?.trim() ?? '']))

    const work: HermesActiveWork = {
      count: workingIds.length,
      titles: workingIds.map(id => titleById.get(id) ?? '').filter(Boolean)
    }

    // The main process shows the "still working — quit anyway?" dialog but has
    // no translations: hand it the words while there is something to ask about.
    return work.count > 0 ? { ...work, copy: { ...translationsNow().quitGuard } } : work
  }
)

if (typeof window !== 'undefined') {
  // `$sessions` republishes on unrelated churn (previews, heartbeats), so only
  // send when the summary itself moved — this crosses a process boundary.
  let lastSent = ''

  $activeWork.subscribe(work => {
    const next = JSON.stringify(work)

    if (next === lastSent) {
      return
    }

    lastSent = next
    window.agentxDesktop?.setActiveWork?.(work)
  })
}
