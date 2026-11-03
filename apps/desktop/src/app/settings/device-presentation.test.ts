import { describe, expect, it } from 'vitest'

import type { DesktopDevice } from '@/global'
import { en } from '@/i18n/en'

import { deviceDisplayName, devicePlatform, groupDevices } from './device-presentation'

function row(id: string, overrides: Partial<DesktopDevice> = {}): DesktopDevice {
  return {
    id,
    name: 'Same machine',
    current: false,
    revoked: false,
    revoked_at: null,
    platform: 'darwin',
    app_version: '',
    created_at: '',
    last_seen_at: '',
    ...overrides
  }
}

describe('device presentation', () => {
  it('folds reinstalls of one machine into a single row, newest first', () => {
    const devices = [
      row('old', { last_seen_at: '2026-10-01' }),
      row('current'),
      row('recent', { current: true, last_seen_at: '2026-10-10' }),
      row('windows', { last_seen_at: '2026-10-05', name: 'Desk', platform: 'win32' }),
      row('revoked-old', { revoked: true, revoked_at: '2026-10-02', last_seen_at: '2026-10-11' }),
      row('revoked-recent', { revoked: true, revoked_at: '2026-10-09' })
    ]

    const groups = groupDevices(devices, 'current')

    // This install leads and never shares its row: it cannot be revoked from
    // the list, and the reinstalls beside it must stay revocable.
    expect(groups.active.map(group => group.devices.map(device => device.id))).toEqual([
      ['current'],
      ['recent', 'old'],
      ['windows']
    ])
    expect(groups.active.map(group => group.current)).toEqual([true, false, false])
    // `current` is the caller's, never a stale flag on the row.
    expect(groups.active[1]!.devices.every(device => !device.current)).toBe(true)
    expect(groups.revoked.map(group => group.devices.map(device => device.id))).toEqual([
      ['revoked-recent', 'revoked-old']
    ])

    const all = [...groups.active, ...groups.revoked].flatMap(group => group.devices)

    expect(new Set(all.map(device => device.id)).size).toBe(devices.length)
  })

  it('keeps machines apart when a label, platform or app tells them apart', () => {
    const groups = groupDevices(
      [
        row('a'),
        row('b', { display_name: 'Work laptop' }),
        row('c', { platform: 'win32' }),
        row('d', { client_name: 'AgentX WebMate' })
      ],
      ''
    )

    expect(groups.active).toHaveLength(4)
  })

  it('uses labels only for display, preserving install and machine identity', () => {
    const device = row('install', { display_name: 'Work laptop' })
    expect(deviceDisplayName(device, en.settings.account)).toBe('Work laptop')
    expect(device.id).toBe('install')
    expect(device.name).toBe('Same machine')
    expect(devicePlatform(device.platform, en.settings.account)).toBe('macOS')
    expect(devicePlatform('', en.settings.account)).toBe(en.settings.account.deviceUnknown)
  })
})
