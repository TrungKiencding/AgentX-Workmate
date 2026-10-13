import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef } from 'react'

import type { ModelSelection } from '@/app/shell/model-menu-panel'
import { replacementModelSelection } from '@/lib/model-options'
import { $activeGatewayProfile } from '@/store/profile'
import type { ModelOptionsResponse } from '@/types/hermes'

import type { SessionView } from '../session-view'

interface ModelCatalogSyncOptions {
  data: ModelOptionsResponse | undefined
  ready: boolean
  busy: boolean
  profile: string
  view: SessionView
  select?: (selection: ModelSelection) => Promise<boolean> | void
}

/** Repair only a retired model, between turns, using the owning surface's
 * existing session switch. Never rebuild an agent or its cached prompt. */
export function useModelCatalogSync({ data, ready, busy, profile, view, select }: ModelCatalogSyncOptions) {
  const model = useStore(view.$model)
  const provider = useStore(view.$provider)
  const runtimeId = useStore(view.$runtimeId)
  const pending = useRef<{ scope: string; promise: Promise<boolean> } | null>(null)
  const attempt = useRef<{ key: string; catalog: ModelOptionsResponse } | null>(null)

  const synchronize = useCallback(
    async (catalog: ModelOptionsResponse | undefined, automatic = false): Promise<boolean> => {
      if ($activeGatewayProfile.get() !== profile) {
        return false
      }

      const sessionId = view.$runtimeId.get()
      const scope = JSON.stringify([profile, sessionId])

      while (pending.current?.scope === scope) {
        const succeeded = await pending.current.promise

        if (!succeeded || view.$runtimeId.get() !== sessionId || $activeGatewayProfile.get() !== profile) {
          return false
        }

        // The caller may hold a newer grant than the repair it joined. Check
        // that grant again after the older write, before allowing a send.
      }

      const replacement = replacementModelSelection(catalog, view.$provider.get(), view.$model.get())

      if (!replacement || !select) {
        return true
      }

      const key = JSON.stringify([scope, view.$provider.get(), view.$model.get()])

      if (automatic && catalog) {
        if (attempt.current?.key === key && attempt.current.catalog === catalog) {
          return false
        }

        attempt.current = { key, catalog }
      }

      const run = Promise.resolve(select({ ...replacement, sessionId, automatic: true })).then(
        result => result !== false && view.$runtimeId.get() === sessionId && $activeGatewayProfile.get() === profile
      )

      pending.current = { scope, promise: run }

      try {
        return await run
      } finally {
        if (pending.current?.promise === run) {
          pending.current = null
        }
      }
    },
    [profile, select, view]
  )

  useEffect(() => {
    if (!ready || busy || !data || !replacementModelSelection(data, provider, model)) {
      return
    }

    // A failed authoritative write is not a hot retry loop. A new catalog,
    // explicit retry, or next send can try again.
    void synchronize(data, true)
  }, [busy, data, model, profile, provider, ready, runtimeId, synchronize])

  return synchronize
}
