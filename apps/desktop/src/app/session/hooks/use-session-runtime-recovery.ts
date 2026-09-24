import { type MutableRefObject, useCallback } from 'react'

import { getSessionMessages } from '@/hermes'
import { isMissingRpcMethod } from '@/lib/gateway-rpc'
import { $gateway } from '@/store/gateway'
import { replayPendingApproval } from '@/store/prompts'
import { $sessions, resolveComposerSessionKey } from '@/store/session'
import { publishSessionState } from '@/store/session-states'
import type { RpcEvent, SessionMessage, SessionResumeResponse } from '@/types/hermes'

import type { ClientSessionState } from '../../types'
import { replayPendingPrompts } from '../pending-prompts'

import { isSubmitInFlight } from './use-prompt-actions/utils'
import {
  applyRuntimeInfo,
  isSessionGoneError,
  reattachedSessionState,
  reattachedTranscript,
  resolveSessionProfile
} from './use-session-actions/utils'

type Request = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

interface SessionRuntimeRecoveryOptions {
  rehomeRuntime: (fromRuntimeId: string, toRuntimeId: string, storedSessionId: string) => ClientSessionState
  /** Feeds replayed events through the handler live gateway events take. */
  replayGatewayEvent: (event: RpcEvent) => void
  requestGateway: Request
  runtimeIdByStoredSessionIdRef: MutableRefObject<Map<string, string>>
  sessionStateByRuntimeIdRef: MutableRefObject<Map<string, ClientSessionState>>
  updateSessionState: (
    sessionId: string,
    updater: (state: ClientSessionState) => ClientSessionState,
    storedSessionId?: string | null
  ) => ClientSessionState
}

/** Does a cached slice keyed `cachedStoredSessionId` hold `storedSessionId`'s
 *  conversation? By lineage: auto-compression rotates the tip id, so a tile's
 *  (or route's) id and its runtime's current key can differ for one chat. An
 *  unkeyed slice is a draft the stored id never reached — ours as well. */
function holdsConversation(cachedStoredSessionId: null | string, storedSessionId: string): boolean {
  if (!cachedStoredSessionId || cachedStoredSessionId === storedSessionId) {
    return true
  }

  const sessions = $sessions.get()

  return (
    resolveComposerSessionKey(cachedStoredSessionId, sessions) === resolveComposerSessionKey(storedSessionId, sessions)
  )
}

/** The stored id the backend runs this runtime under — a resume follows the
 *  compression chain to its live tip, which the cache must be keyed by. */
function liveStoredSessionId(
  attached: Pick<SessionResumeResponse, 'resumed' | 'session_key'>,
  requestedStoredSessionId?: string
): string {
  return attached.session_key || attached.resumed || requestedStoredSessionId || ''
}

/** The stored transcript, or null when it can't be read or belongs to another
 *  conversation than the one the runtime reports (a compression tip moved). */
function matchingTranscript(
  persisted: null | { messages: SessionMessage[]; session_id?: string },
  attached: Pick<SessionResumeResponse, 'resumed' | 'session_key'>
): null | SessionMessage[] {
  const attachedStoredSessionId = attached.session_key || attached.resumed

  if (
    !persisted ||
    (persisted.session_id && attachedStoredSessionId && persisted.session_id !== attachedStoredSessionId)
  ) {
    return null
  }

  return persisted.messages
}

/**
 * Keeping a runtime binding alive across what the backend does to it.
 *
 * A window's runtime ids die in three ways the renderer does not see happen:
 * its socket drops (the backend parks the session on a drop transport, then
 * reaps it if idle), the backend reclaims it (idle TTL / LRU / orphan reap),
 * or the backend restarts. The primary chat re-attaches through its route
 * resume. These are the same guarantees for everything else holding a runtime
 * id: a tile re-binding after a reconnect, and a send / stop / correction that
 * finds its id already gone.
 */
export function useSessionRuntimeRecovery({
  rehomeRuntime,
  replayGatewayEvent,
  requestGateway,
  runtimeIdByStoredSessionIdRef,
  sessionStateByRuntimeIdRef,
  updateSessionState
}: SessionRuntimeRecoveryOptions) {
  // The runtime's facts (model, cwd, …) for its own state only — a tile or a
  // background send must never repaint the main pane's composer.
  const applyAttached = useCallback(
    (
      runtimeId: string,
      attached: SessionResumeResponse,
      persisted: null | SessionMessage[],
      requestedStoredSessionId: string
    ) => {
      const runtimeInfo = applyRuntimeInfo(attached.info, { foreground: false })
      const storedSessionId = liveStoredSessionId(attached)

      updateSessionState(
        runtimeId,
        state =>
          reattachedSessionState(state, attached, persisted, runtimeInfo, {
            sendInFlight: isSubmitInFlight(requestedStoredSessionId, storedSessionId, runtimeId)
          }),
        storedSessionId || undefined
      )
      replayPendingPrompts(runtimeId, attached.pending_prompts, replayGatewayEvent)

      if (attached.running) {
        // An approval raised while nobody was attached is parked server-side;
        // bring it back the same way a reconnect does for the main chat.
        void replayPendingApproval($gateway.get(), runtimeId).catch(() => undefined)
      }
    },
    [replayGatewayEvent, updateSessionState]
  )

  /**
   * A live runtime for a TILE's stored session, attached to this window's
   * socket. A cached runtime is re-attached in place (`session.activate`
   * rebinds its event transport) and reconciled with what it did while
   * nobody was listening; a gone one is replaced by a fresh resume that
   * carries the cached conversation over. Throws when the stored session
   * itself is gone ("session not found" from session.resume) or on a
   * transient failure — the caller decides whether to keep a stale binding.
   */
  const attachSessionRuntime = useCallback(
    async (storedSessionId: string): Promise<string> => {
      const cachedRuntimeId = runtimeIdByStoredSessionIdRef.current.get(storedSessionId)
      const cached = cachedRuntimeId ? sessionStateByRuntimeIdRef.current.get(cachedRuntimeId) : undefined
      // The reverse mapping is only trusted while the slice still names this
      // stored id (a recycled or cross-wired mapping must not be re-attached).
      const ownsCache = Boolean(cachedRuntimeId && cached?.storedSessionId === storedSessionId)

      // Resolve the owning profile before binding a runtime. A tile can open a
      // session from any profile, not just the active one; resuming (or
      // reading messages) without a profile lets the gateway fall back to the
      // launch-profile DB and fork the conversation into the wrong profile —
      // the same cross-profile bleed the recovery resumes had (#67603).
      const profile = await resolveSessionProfile(storedSessionId)
      const persistedPromise = getSessionMessages(storedSessionId, profile).catch(() => null)

      if (ownsCache && cachedRuntimeId) {
        let activated: null | SessionResumeResponse = null

        try {
          activated = await requestGateway<SessionResumeResponse>('session.activate', {
            session_id: cachedRuntimeId,
            cols: 96,
            omit_messages: true
          })
        } catch (error) {
          if (isMissingRpcMethod(error)) {
            // A backend without session.activate: the cached binding is all
            // there is (the pre-rebind behaviour).
            publishSessionState(cachedRuntimeId, cached!)

            return cachedRuntimeId
          }

          if (!isSessionGoneError(error)) {
            throw error
          }
        }

        // A key other than ours is a compression rotation the cache missed (or
        // a recycled id): session.resume below follows the chain to the live
        // tip — usually handing this very runtime back.
        if (activated && (!activated.session_key || activated.session_key === storedSessionId)) {
          applyAttached(
            cachedRuntimeId,
            { ...activated, session_key: activated.session_key || storedSessionId },
            matchingTranscript(await persistedPromise, activated),
            storedSessionId
          )

          return cachedRuntimeId
        }
      }

      const resumed = await requestGateway<SessionResumeResponse>('session.resume', {
        session_id: storedSessionId,
        cols: 96,
        omit_messages: true,
        ...(profile ? { profile } : {})
      })

      const runtimeId = resumed?.session_id

      if (!runtimeId) {
        throw new Error('resume returned no session id')
      }

      if (ownsCache && cachedRuntimeId) {
        // The dead runtime's conversation (and anything showing it) moves over.
        rehomeRuntime(cachedRuntimeId, runtimeId, liveStoredSessionId(resumed, storedSessionId))
      }

      applyAttached(
        runtimeId,
        { ...resumed, session_key: liveStoredSessionId(resumed, storedSessionId) },
        matchingTranscript(await persistedPromise, resumed),
        storedSessionId
      )

      return runtimeId
    },
    [applyAttached, rehomeRuntime, requestGateway, runtimeIdByStoredSessionIdRef, sessionStateByRuntimeIdRef]
  )

  /**
   * Rebind a conversation whose runtime id just failed "session not found" to
   * a live runtime, and carry what was on screen onto it: the transcript, the
   * turn the caller is starting (its optimistic prompt, busy flags), and every
   * surface that showed the dead id. The caller retries its call on the
   * returned id and owns the turn state — this never settles or re-arms it.
   * Null when the resume yields no runtime.
   */
  const recoverSessionRuntime = useCallback(
    async (storedSessionId: string, staleRuntimeId: null | string): Promise<null | string> => {
      const profile = await resolveSessionProfile(storedSessionId)

      const [resumed, persisted] = await Promise.all([
        requestGateway<SessionResumeResponse>('session.resume', {
          session_id: storedSessionId,
          source: 'desktop',
          omit_messages: true,
          ...(profile ? { profile } : {})
        }),
        getSessionMessages(storedSessionId, profile).catch(() => null)
      ])

      const runtimeId = resumed?.session_id

      if (!runtimeId) {
        return null
      }

      // Only a runtime that held THIS conversation is carried over — a stale
      // id cross-wired to another chat must not leak its transcript here.
      const stale = staleRuntimeId ? sessionStateByRuntimeIdRef.current.get(staleRuntimeId) : undefined

      const liveStoredId = liveStoredSessionId(resumed, storedSessionId)

      if (
        staleRuntimeId &&
        staleRuntimeId !== runtimeId &&
        stale &&
        holdsConversation(stale.storedSessionId, storedSessionId)
      ) {
        rehomeRuntime(staleRuntimeId, runtimeId, liveStoredId)
      }

      const runtimeInfo = applyRuntimeInfo(resumed.info, { foreground: false })
      const transcript = matchingTranscript(persisted, resumed)

      updateSessionState(
        runtimeId,
        state => ({
          ...state,
          ...(runtimeInfo ?? {}),
          // Turns that finished while this window held a dead id come back from
          // the stored transcript; the caller's pending turn is kept on top.
          messages: reattachedTranscript(state.messages, resumed, transcript)
        }),
        liveStoredId
      )
      replayPendingPrompts(runtimeId, resumed.pending_prompts, replayGatewayEvent)

      return runtimeId
    },
    [rehomeRuntime, replayGatewayEvent, requestGateway, sessionStateByRuntimeIdRef, updateSessionState]
  )

  return { attachSessionRuntime, recoverSessionRuntime }
}
