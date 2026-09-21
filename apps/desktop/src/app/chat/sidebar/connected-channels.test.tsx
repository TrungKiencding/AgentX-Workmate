import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MessagingPlatformInfo } from '@/types/hermes'

import { ConnectedChannels, connectedMessagingPlatforms } from './connected-channels'

afterEach(cleanup)

const platform = (patch: Partial<MessagingPlatformInfo>): MessagingPlatformInfo => ({
  configured: true,
  description: '',
  docs_url: '',
  enabled: true,
  env_vars: [],
  gateway_running: true,
  id: 'telegram',
  name: 'Telegram',
  state: 'connected',
  ...patch
})

describe('ConnectedChannels', () => {
  it('shows only live connected platforms and opens the selected detail', () => {
    const onOpen = vi.fn()

    const platforms = [
      platform({ destination: { label: '@agentx_bot', url: 'https://t.me/agentx_bot' } }),
      platform({ id: 'slack', name: 'Slack', state: 'disconnected' }),
      platform({ enabled: false, id: 'discord', name: 'Discord' })
    ]

    render(
      <ConnectedChannels activePlatformId="telegram" label="Connected channels" onOpen={onOpen} platforms={platforms} />
    )

    expect(screen.getByText('@agentx_bot')).toBeTruthy()
    expect(screen.queryByText('Slack')).toBeNull()
    expect(screen.getByRole('button', { name: /Telegram/ }).getAttribute('aria-current')).toBe('page')

    fireEvent.click(screen.getByRole('button', { name: /Telegram/ }))
    expect(onOpen).toHaveBeenCalledWith('telegram')
    expect(connectedMessagingPlatforms(platforms)).toHaveLength(1)
  })
})
