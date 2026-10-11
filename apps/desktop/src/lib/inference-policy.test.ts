import { describe, expect, it } from 'vitest'

import { gatewayModelOptions } from './inference-policy'

describe('desktop inference policy', () => {
  const rows = [
    { slug: 'anthropic', name: 'Anthropic', models: ['claude'] },
    { slug: 'custom:litellm', name: 'AgentX AI Gateway', models: ['gateway-model'] },
    { slug: 'custom:lab', name: 'Local', models: ['local-model'] }
  ]

  it('excludes configured third-party and custom providers on older backends', () => {
    expect(gatewayModelOptions({ providers: rows }).providers).toEqual([rows[1]])
  })
  it('honors the authoritative gateway identity, including renamed providers', () => {
    const own = { slug: 'custom:company-ai', name: 'Company', models: ['model'] }
    expect(gatewayModelOptions({ inference_provider: 'company-ai', providers: [...rows, own] }).providers).toEqual([
      own
    ])
  })
  it('returns an empty catalog rather than falling back when gateway is missing', () => {
    expect(gatewayModelOptions({ inference_provider: 'missing', providers: rows }).providers).toEqual([])
  })
})
