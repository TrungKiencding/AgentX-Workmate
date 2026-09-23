import { useEffect } from 'react'

import { PROMPT_SUBMIT_REQUEST_TIMEOUT_MS } from '@/hermes'
import { setSessionTileDelegate } from '@/store/session-states'

import type { usePromptActions } from '../../session/hooks/use-prompt-actions'
import type { useSessionRuntimeRecovery } from '../../session/hooks/use-session-runtime-recovery'
import type { useSessionStateCache } from '../../session/hooks/use-session-state-cache'
import type { GatewayRequester } from '../types'

type SessionStateCache = ReturnType<typeof useSessionStateCache>
type SessionRuntimeRecovery = ReturnType<typeof useSessionRuntimeRecovery>

interface SessionTileDelegateParams {
  archiveSession: (storedSessionId: string) => Promise<unknown>
  attachSessionRuntime: SessionRuntimeRecovery['attachSessionRuntime']
  branchStoredSession: (storedSessionId: string) => Promise<unknown>
  executeSlashCommand: ReturnType<typeof usePromptActions>['executeSlashCommand']
  recoverSessionRuntime: SessionRuntimeRecovery['recoverSessionRuntime']
  removeSession: (storedSessionId: string) => Promise<unknown>
  requestGateway: GatewayRequester
  updateSessionState: SessionStateCache['updateSessionState']
}

/**
 * Publishes the session-tile delegate: resume / submit / interrupt / slash for
 * tiled sessions WITHOUT touching the primary view ($activeSessionId /
 * $messages stay the main thread's). Resume attaches a live runtime to this
 * window's socket — re-attaching a cached one in place, or binding a fresh one
 * that carries the cached conversation over — and hydrates the cache, which
 * publishSessionState mirrors to the tile.
 */
export function useSessionTileDelegate({
  archiveSession,
  attachSessionRuntime,
  branchStoredSession,
  executeSlashCommand,
  recoverSessionRuntime,
  removeSession,
  requestGateway,
  updateSessionState
}: SessionTileDelegateParams): void {
  useEffect(() => {
    setSessionTileDelegate({
      archiveSession: async storedSessionId => {
        await archiveSession(storedSessionId)
      },
      branchSession: async storedSessionId => {
        await branchStoredSession(storedSessionId)
      },
      deleteSession: async storedSessionId => {
        await removeSession(storedSessionId)
      },
      executeSlash: async (rawCommand, sessionId) => {
        await executeSlashCommand(rawCommand, { sessionId })
      },
      interruptSession: async runtimeId => {
        await requestGateway('session.interrupt', { session_id: runtimeId })
      },
      recoverRuntime: (storedSessionId, staleRuntimeId) => recoverSessionRuntime(storedSessionId, staleRuntimeId),
      resumeTile: storedSessionId => attachSessionRuntime(storedSessionId),
      submitToSession: async (runtimeId, text) => {
        await requestGateway('prompt.submit', { session_id: runtimeId, text }, PROMPT_SUBMIT_REQUEST_TIMEOUT_MS)
      },
      updateSession: (runtimeId, updater) => updateSessionState(runtimeId, updater)
    })
  }, [
    archiveSession,
    attachSessionRuntime,
    branchStoredSession,
    executeSlashCommand,
    recoverSessionRuntime,
    removeSession,
    requestGateway,
    updateSessionState
  ])
}
