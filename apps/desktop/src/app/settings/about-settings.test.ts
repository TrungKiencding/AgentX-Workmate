import { describe, expect, it } from 'vitest'

import type { AppUpdateState } from '@/global'
import { en } from '@/i18n/en'

import { appUpdateStatusLine } from './about-settings'

// About is where people look when they wonder whether they are current; its one
// line must say what is true, including why the last attempt failed.

const release = {
  version: '1.0.4',
  publishedAt: '2026-10-02T00:00:00.000Z',
  notes: { en: ['x'], vi: ['x'] },
  bytes: 100
}

function state(over: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    phase: 'idle',
    currentVersion: '1.0.3',
    checking: false,
    checkedAt: null,
    checkError: null,
    release: null,
    progress: null,
    downloadError: null,
    installError: null,
    blocked: null,
    downloadPageUrl: 'https://example.test/#download',
    updatedFrom: null,
    lastInstallFailed: null,
    agentUpdateFailed: null,
    ...over
  }
}

const line = (over: Partial<AppUpdateState> | null) => appUpdateStatusLine(over ? state(over) : null, en)

describe('appUpdateStatusLine', () => {
  it('follows a release from available to installing', () => {
    expect(line({ phase: 'available', release })).toEqual({
      line: 'AgentX Workmate 1.0.4 is available',
      tone: 'available'
    })
    expect(line({ phase: 'downloading', release, progress: { receivedBytes: 45, totalBytes: 100 } })).toEqual({
      line: 'Downloading the update · 45%',
      tone: 'available'
    })
    expect(line({ phase: 'ready', release }).line).toBe('1.0.4 is ready — restart to update')
    expect(line({ phase: 'installing', release }).tone).toBe('available')
  })

  it('says why a download or an install failed', () => {
    expect(line({ phase: 'available', release, downloadError: { kind: 'size', message: 'x' } })).toEqual({
      line: 'The downloaded file didn’t match the signed release, so AgentX discarded it. Try again.',
      tone: 'error'
    })
    expect(line({ phase: 'ready', release, installError: { kind: 'stage', message: 'x' } })).toEqual({
      line: 'The update couldn’t be installed, so you’re still on this version. Try again, or install it from the download page.',
      tone: 'error'
    })
    // An installer that changed on disk sends the person back to downloading.
    expect(line({ phase: 'available', release, installError: { kind: 'stage', message: 'x' } }).tone).toBe('error')
  })

  it('is quiet when current, and says when the server could not be reached', () => {
    expect(line({ phase: 'up-to-date' })).toEqual({ line: en.settings.about.onLatest, tone: 'idle' })
    expect(line({ checking: true })).toEqual({ line: en.appUpdate.checking, tone: 'idle' })
    expect(line({ checkError: 'offline' })).toEqual({ line: en.settings.about.cantReach, tone: 'error' })
    expect(line(null)).toEqual({ line: en.settings.about.tapCheck, tone: 'idle' })
  })
})
