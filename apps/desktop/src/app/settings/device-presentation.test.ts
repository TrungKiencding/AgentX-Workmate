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
  it('partitions by install ID and keeps every duplicate independently accessible', () => {
    const devices = [
      row('old', { last_seen_at: '2026-10-01' }),
      row('current'),
      row('recent', { current: true, last_seen_at: '2026-10-10' }),
      row('revoked-old', { revoked: true, revoked_at: '2026-10-02', last_seen_at: '2026-10-11' }),
      row('revoked-recent', { revoked: true, revoked_at: '2026-10-09' })
    ]

    const groups = groupDevices(devices, 'current')
    expect(groups.current.map(device => device.id)).toEqual(['current'])
    expect(groups.other.map(device => device.id)).toEqual(['recent', 'old'])
    expect(groups.other.every(device => !device.current)).toBe(true)
    expect(groups.revoked.map(device => device.id)).toEqual(['revoked-recent', 'revoked-old'])
    const all = [...groups.current, ...groups.other, ...groups.revoked]
    expect(new Set(all.map(device => device.id)).size).toBe(devices.length)
    expect(groups.duplicateNames.has('Same machine')).toBe(true)
    expect(devices[2].current).toBe(true)
  })

  it('does not count historical records as multiple authorized installs with the same name', () => {
    expect(groupDevices([row('live'), row('old', { revoked: true })], 'live').duplicateNames.size).toBe(0)
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

it('removes duplicate-name noise after distinct account labels are assigned', () => {
  const devices = [row('current'), row('other', { display_name: 'Work laptop' })]
  expect(groupDevices(devices, 'current').duplicateNames.size).toBe(0)
  const groups = groupDevices([row('unnamed-a', { name: '' }), row('unnamed-b', { name: '' })], 'unnamed-a')
  expect(groups.duplicateNames.has('')).toBe(true)
})
