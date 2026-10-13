import type { QueryClient } from '@tanstack/react-query'

import { getGlobalModelOptions, type HermesGateway, type ModelOptionsResponse } from '@/hermes'
import { $connection } from '@/store/session'
import type { ModelOptionProvider } from '@/types/hermes'

import { gatewayModelOptions } from './inference-policy'

/** Catalog reads must reach the authority, including when a warm picker opens.
 * React Query coalesces observers sharing a profile/session key. */
export const modelCatalogQueryPolicy = {
  staleTime: 30_000,
  refetchOnMount: 'always',
  refetchOnWindowFocus: 'always',
  refetchOnReconnect: 'always'
} as const

const accountRefreshes = new Map<string, Promise<unknown>>()

async function refreshLocalAccountModels(profile?: string) {
  const connection = $connection.get()
  const bridge = window.agentxDesktop?.account

  // This bridge owns the primary local account, never a remote or another
  // profile's authority. Provisioning reuses the key; it does not rotate it.
  if (
    !bridge ||
    connection?.mode !== 'local' ||
    (connection.profile && connection.profile !== 'default') ||
    (profile && profile !== 'default')
  ) {
    return
  }

  const key = connection.baseUrl
  let pending = accountRefreshes.get(key)

  if (!pending) {
    pending = bridge.provision({ rotate: false }).catch(() => undefined)
    accountRefreshes.set(key, pending)
    void pending.finally(() => accountRefreshes.delete(key))
  }

  await pending
}

/** Only a populated account catalog can retire a selection. Prefer the
 * configured default if it is still granted, otherwise the first granted row.
 * Unknown/empty catalogs and valid manual selections stay untouched. */
export function replacementModelSelection(options: ModelOptionsResponse | undefined, provider: string, model: string) {
  if (!options || !manualPickRemoved(options.providers, provider, model)) {
    return null
  }

  const row = options.providers?.find(entry => entry.models?.length)

  if (!row) {
    return null
  }

  const next = row.models!.includes(options.model ?? '') ? options.model! : row.models![0]!

  return { provider: row.slug, model: next }
}

/** Reset removed model picks and legacy provider pins once the managed gateway
 * catalog is available. Empty/unavailable catalogs preserve the saved pick. */
export function manualPickRemoved(
  providers: ModelOptionProvider[] | undefined,
  provider: string,
  model: string
): boolean {
  if (!providers?.length || !provider || !model) {
    return false
  }

  const slug = provider.toLowerCase().replace(/^custom:/, '')

  const row = providers.find(
    p =>
      p.slug.toLowerCase().replace(/^custom:/, '') === slug ||
      p.name === provider ||
      (slug === 'custom' && p.name === 'AgentX AI Gateway')
  )

  if (!row) {
    // A managed gateway catalog is authoritative: a manual pin to a retired
    // provider must not keep routing new chats outside the account gateway.
    return providers.some(entry => entry.name === 'AgentX AI Gateway' && (entry.models?.length ?? 0) > 0)
  }

  const models = row.models ?? []

  // Empty list means the provider is present but unconfigured / awaiting
  // re-auth, not that the model was dropped — leave the pick alone.
  if (models.length === 0) {
    return false
  }

  return !models.includes(model)
}

interface ModelOptionsRequest {
  /** When false, include ambient/unconfigured providers (onboarding/setup
   *  surfaces). Chat pickers default to true so only explicitly configured
   *  providers are listed (#56974). */
  explicitOnly?: boolean
  gateway?: HermesGateway
  /** Owning query profile, including while the connection descriptor is switching. */
  profile?: string
  refresh?: boolean
  sessionId?: null | string
}

export function modelOptionsQueryKey(profile: null | string | undefined, sessionId?: null | string) {
  const profileKey = (profile ?? '').trim() || 'default'

  return ['model-options', profileKey, sessionId || 'global'] as const
}

/** Start a read after this action even if an older snapshot is still in flight.
 * Used by picker opens, whose content may remain mounted during its exit. */
export async function refreshModelCatalogQueries(queryClient: QueryClient, profile: string, sessionId?: null | string) {
  const filters = { queryKey: modelOptionsQueryKey(profile, sessionId), exact: true, type: 'active' as const }

  if (queryClient.isFetching(filters)) {
    await queryClient.refetchQueries(filters, { cancelRefetch: false })
  }

  await queryClient.refetchQueries(filters, { cancelRefetch: false })
}

export async function requestModelOptions({
  explicitOnly = true,
  gateway,
  profile,
  refresh = true,
  sessionId
}: ModelOptionsRequest): Promise<ModelOptionsResponse> {
  if (refresh) {
    await refreshLocalAccountModels(profile)
  }

  if (gateway) {
    const params: Record<string, unknown> = {}

    if (sessionId) {
      params.session_id = sessionId
    }

    if (refresh) {
      params.refresh = true
    }

    if (explicitOnly) {
      params.explicit_only = true
    }

    return gatewayModelOptions(await gateway.request<ModelOptionsResponse>('model.options', params))
  }

  return getGlobalModelOptions({ explicitOnly, ...(refresh ? { refresh: true } : {}) })
}
