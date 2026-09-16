/**
 * ResponseLoadingIndicator label — "thinking" by default, "starting the
 * assistant" while the gateway reports the session's deferred agent build is
 * still running with the user's message queued behind it (the keyed
 * `agent-build-slow` notice → `sessionAgentStarting` store).
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, describe, expect, it } from 'vitest'

import { type SessionView, SessionViewProvider } from '@/app/chat/session-view'
import { ResponseLoadingIndicator } from '@/components/assistant-ui/thread/status'
import { TRANSLATIONS } from '@/i18n/catalog'
import { getRuntimeI18nLocale } from '@/i18n/runtime'
import { clearAllAgentStarting, setSessionAgentStarting } from '@/store/agent-starting'

const SID = 'session-1'

function view(): SessionView {
  return {
    ...({} as SessionView),
    $runtimeId: atom<null | string>(SID),
    kind: 'primary'
  }
}

function mount() {
  return render(
    <SessionViewProvider value={view()}>
      <ResponseLoadingIndicator />
    </SessionViewProvider>
  )
}

const t = () => TRANSLATIONS[getRuntimeI18nLocale()].assistant.thread

afterEach(() => {
  cleanup()
  clearAllAgentStarting()
})

describe('ResponseLoadingIndicator label', () => {
  it('reads "thinking" while no agent build is reported', () => {
    mount()

    expect(screen.queryByText(t().thinking)).not.toBeNull()
    expect(screen.queryByText(t().startingAgent)).toBeNull()
  })

  it('names the agent build while it runs, and reverts when it clears', () => {
    setSessionAgentStarting(SID, true)
    mount()

    expect(screen.queryByText(t().startingAgent)).not.toBeNull()
    expect(screen.queryByText(t().thinking)).toBeNull()

    act(() => setSessionAgentStarting(SID, false))

    expect(screen.queryByText(t().thinking)).not.toBeNull()
    expect(screen.queryByText(t().startingAgent)).toBeNull()
  })
})
