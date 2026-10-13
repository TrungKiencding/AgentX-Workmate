import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect } from 'react'

import type { SubmitTextOptions } from '@/app/session/hooks/use-prompt-actions/utils'
import type { ModelSelection } from '@/app/shell/model-menu-panel'
import type { HermesGateway } from '@/hermes'
import { modelCatalogQueryPolicy, modelOptionsQueryKey, requestModelOptions } from '@/lib/model-options'
import { $activeGatewayProfile } from '@/store/profile'
import type { ModelOptionsResponse } from '@/types/hermes'

import type { SessionView } from '../session-view'

import { useModelCatalogSync } from './use-model-catalog-sync'

interface ChatModelCatalogOptions {
  gateway: HermesGateway | null
  profile: string
  sessionId: string | null
  enabled: boolean
  busy: boolean
  view: SessionView
  onSelectModel?: (selection: ModelSelection) => Promise<boolean> | void
  onSubmit: (text: string, options?: SubmitTextOptions) => Promise<boolean> | boolean
}

/** Owns catalog freshness for a chat surface and validates idle sends against
 * the same catalog the picker displays. Active turns keep their model. */
export function useChatModelCatalog({
  gateway,
  profile,
  sessionId,
  enabled,
  busy,
  view,
  onSelectModel,
  onSubmit
}: ChatModelCatalogOptions) {
  const queryClient = useQueryClient()

  const modelOptionsQuery = useQuery<ModelOptionsResponse>({
    ...modelCatalogQueryPolicy,
    queryKey: modelOptionsQueryKey(profile, sessionId),
    queryFn: () => requestModelOptions({ gateway: gateway || undefined, profile, sessionId }),
    refetchInterval: enabled ? 60_000 : false,
    enabled
  })

  const refreshCatalog = modelOptionsQuery.refetch

  const refreshForAction = useCallback(async () => {
    // An earlier read may have captured the grant before this action. Finish
    // it first, then start a read after the action, rather than sending against
    // an old snapshot merely because the requests happened to overlap.
    if (queryClient.isFetching({ queryKey: modelOptionsQueryKey(profile, sessionId), exact: true })) {
      await refreshCatalog({ cancelRefetch: false })
    }

    return refreshCatalog({ cancelRefetch: false })
  }, [profile, queryClient, refreshCatalog, sessionId])

  useEffect(() => {
    if (!enabled) {
      return
    }

    // Electron focus can change without a visibilitychange event (the window
    // remained onscreen). React Query's browser focus listener misses it.
    const onFocus = () => {
      if (document.visibilityState === 'visible') {
        void refreshForAction()
      }
    }

    window.addEventListener('focus', onFocus)

    return () => window.removeEventListener('focus', onFocus)
  }, [enabled, refreshForAction])

  const synchronizeModel = useModelCatalogSync({
    data: modelOptionsQuery.data,
    ready: enabled && !modelOptionsQuery.isFetching && !modelOptionsQuery.isError,
    busy,
    profile,
    view,
    select: onSelectModel
  })

  const submitWithCurrentModel = useCallback(
    async (value: string, options?: SubmitTextOptions) => {
      // Queuing/steering an active turn keeps its existing semantics. Idle
      // sends join an ongoing refresh and validate before creating a session.
      if (view.$busy.get() || !onSelectModel) {
        return onSubmit(value, options)
      }

      const sessionId = view.$runtimeId.get()
      const storedId = view.$storedId.get()
      const fresh = await refreshForAction()

      if (
        view.$runtimeId.get() !== sessionId ||
        view.$storedId.get() !== storedId ||
        $activeGatewayProfile.get() !== profile
      ) {
        return false
      }

      if (view.$busy.get()) {
        return onSubmit(value, options)
      }

      // Offline discovery preserves the last working selection. The normal
      // send path still owns connectivity errors and leaves the draft intact.
      if (!fresh.isError && !(await synchronizeModel(fresh.data))) {
        return false
      }

      if (
        view.$runtimeId.get() !== sessionId ||
        view.$storedId.get() !== storedId ||
        $activeGatewayProfile.get() !== profile
      ) {
        return false
      }

      return onSubmit(value, options)
    },
    [profile, onSelectModel, onSubmit, refreshForAction, synchronizeModel, view]
  )

  return { modelOptionsQuery, submitWithCurrentModel }
}
