import { type MutableRefObject, useCallback } from 'react'

import { $currentCwd, setCurrentBranch } from '@/store/session'

interface CwdActionsOptions {
  activeSessionIdRef: MutableRefObject<string | null>
  requestGateway: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>
}

// Pointing a new chat at a folder lives in the store (`setDraftWorkspace`), so
// the composer's folder picker can reach it without threading props; this hook
// only keeps the draft's branch label in step with a folder set elsewhere.
export function useCwdActions({ activeSessionIdRef, requestGateway }: CwdActionsOptions) {
  const refreshProjectBranch = useCallback(
    async (cwd: string) => {
      const target = cwd.trim()

      if (!target || activeSessionIdRef.current) {
        return
      }

      try {
        const info = await requestGateway<{ branch?: string; cwd?: string }>('config.get', {
          key: 'project',
          cwd: target
        })

        if (!activeSessionIdRef.current && ($currentCwd.get() || target) === (info.cwd || target)) {
          setCurrentBranch(info.branch || '')
        }
      } catch {
        setCurrentBranch('')
      }
    },
    [activeSessionIdRef, requestGateway]
  )

  return { refreshProjectBranch }
}
