import { useEffect, useRef, useState } from 'react'

import { useI18n } from '@/i18n'
import { resetBrowseState } from '@/store/composer-input-history'

import { pickPlaceholder } from '../composer-utils'

interface UseComposerPlaceholderOptions {
  /** Inside a git repository the starter speaks the coding voice. */
  codingContext?: boolean
  disabled: boolean
  reconnecting: boolean
  sessionId: null | string | undefined
}

/** Which resting line to show — a starter or a follow-up, and where in its pool
 *  it landed. No text is stored: every render reads the pick out of the live
 *  pools, so a locale or folder change lands on the same slot in the new pool. */
interface RestingPick {
  draw: number
  starter: boolean
}

const rollRestingPick = (sessionId: null | string | undefined): RestingPick => ({
  draw: Math.random(),
  starter: !sessionId
})

/**
 * The composer's placeholder text. A resting starter (new session) / continuation
 * (existing session) is picked once and only re-rolled when we genuinely move to
 * a *different* conversation — the null→id persist of a freshly-started session
 * keeps its starter so the text doesn't flip mid-stream. The pick outlives its
 * words: when the locale changes (the boot-time default giving way to
 * `display.language`, or a switch in settings) the same line is read out of the
 * new language's pool. While the transport is down, it swaps to a reconnecting /
 * starting message instead.
 */
export function useComposerPlaceholder({
  codingContext = false,
  disabled,
  reconnecting,
  sessionId
}: UseComposerPlaceholderOptions): string {
  const { t } = useI18n()

  // The starter follows the folder — the same probe that decides the branch
  // strip and the model pill, so the three never disagree about what this is.
  const newSessionPlaceholders = codingContext
    ? t.composer.newSessionPlaceholdersRepo
    : t.composer.newSessionPlaceholders

  const followUpPlaceholders = t.composer.followUpPlaceholders

  const [restingPick, setRestingPick] = useState(() => rollRestingPick(sessionId))

  const prevSessionIdRef = useRef(sessionId)

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    const prev = prevSessionIdRef.current
    prevSessionIdRef.current = sessionId

    if (prev === sessionId) {
      return
    }

    // null → id: the new session we're already in just got persisted. Keep the
    // starter we showed instead of swapping to a follow-up under the user.
    if (prev == null && sessionId) {
      return
    }

    resetBrowseState(prev)
    setRestingPick(rollRestingPick(sessionId))
  }, [sessionId])

  const restingPlaceholder = pickPlaceholder(
    restingPick.starter ? newSessionPlaceholders : followUpPlaceholders,
    restingPick.draw
  )

  // When the transport is disabled it's because the gateway isn't open.
  // Distinguish a cold start ("Starting AgentX...") from a dropped connection
  // we're trying to restore. During reconnect, keep the textbox editable so a
  // flaky network doesn't block drafting; only submit/backend actions stay
  // disabled until the gateway is open again.
  return disabled
    ? reconnecting
      ? t.composer.placeholderReconnecting
      : t.composer.placeholderStarting
    : restingPlaceholder
}
