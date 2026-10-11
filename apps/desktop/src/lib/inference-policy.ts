import type { ModelOptionProvider, ModelOptionsResponse } from '@/types/hermes'

/** Every desktop model catalog is limited to the account's managed gateway.
 * Older backends omit inference_provider; their provisioned row carries the
 * gateway label (and the original default slug is litellm).
 */
export function gatewayModelOptions(options: ModelOptionsResponse): ModelOptionsResponse {
  const managed = options.inference_provider?.trim().toLowerCase()

  const isGateway = (row: ModelOptionProvider) => {
    const slug = row.slug.toLowerCase().replace(/^custom:/, '')

    return managed ? slug === managed.replace(/^custom:/, '') : slug === 'litellm' || row.name === 'AgentX AI Gateway'
  }

  return { ...options, providers: (options.providers ?? []).filter(isGateway) }
}
