import { describe, expect, it } from 'vitest'

import type { AppUpdateState } from '@/global'
import { en } from '@/i18n/en'

import { resolveAppVersionStatus, resolveBackendVersionStatus } from './version-status'

const statusbar = en.shell.statusbar

const appCopy = {
  clientLabel: statusbar.clientLabel,
  restart: statusbar.restart,
  update: statusbar.update,
  current: en.appUpdate.statusCurrent,
  available: en.appUpdate.statusAvailable,
  downloading: en.appUpdate.statusDownloading,
  ready: en.appUpdate.statusReady,
  installing: en.appUpdate.statusInstalling
}

function state(over: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    phase: 'up-to-date',
    currentVersion: '1.0.3',
    checking: false,
    checkedAt: 1,
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

const release = {
  version: '1.0.4',
  publishedAt: '2026-10-02T00:00:00.000Z',
  notes: { en: ['x'], vi: ['x'] },
  bytes: 100
}

const app = (over: Partial<Parameters<typeof resolveAppVersionStatus>[0]> = {}) =>
  resolveAppVersionStatus({ copy: appCopy, remote: false, state: state(), ...over })

describe('resolveAppVersionStatus', () => {
  it('names a current app by its version', () => {
    expect(app()).toEqual({
      hasUpdate: false,
      label: 'v1.0.3',
      tooltip: 'AgentX Workmate 1.0.3',
      unknown: false
    })
  })

  it('flags an available release and names it in the tooltip', () => {
    const status = app({ state: state({ phase: 'available', release }) })

    expect(status).toMatchObject({
      hasUpdate: true,
      label: 'v1.0.3 (update)',
      tooltip: 'AgentX Workmate 1.0.4 is available'
    })
  })

  it('shows download progress, then asks for a restart once ready', () => {
    const downloading = app({
      state: state({ phase: 'downloading', release, progress: { receivedBytes: 45, totalBytes: 100 } })
    })

    expect(downloading).toMatchObject({
      hasUpdate: false,
      label: 'v1.0.3 · 45%',
      tooltip: 'Downloading the update · 45%'
    })

    const ready = app({ state: state({ phase: 'ready', release }) })

    expect(ready).toMatchObject({
      hasUpdate: true,
      label: 'v1.0.3 · restart',
      tooltip: '1.0.4 is ready — restart to update'
    })
    expect(app({ state: state({ phase: 'installing', release }) }).label).toBe('v1.0.3 · update')
  })

  it('names the app as one of two versions in remote mode', () => {
    expect(app({ remote: true }).label).toBe('client v1.0.3')
  })

  it('falls back to the version from main before the update state arrives, else hides', () => {
    expect(app({ state: null, version: '1.0.3' }).label).toBe('v1.0.3')
    expect(app({ state: null }).unknown).toBe(true)
  })
})

const backend = (over: Partial<Parameters<typeof resolveBackendVersionStatus>[0]> = {}) =>
  resolveBackendVersionStatus({ applying: false, copy: statusbar, restarting: false, version: '0.4.2', ...over })

describe('resolveBackendVersionStatus', () => {
  it('labels the backend distinctly', () => {
    expect(backend()).toEqual({ hasUpdate: false, label: 'backend v0.4.2', tooltip: 'Backend v0.4.2', unknown: false })
  })

  it('prefers the exact commit diff and falls back to (update) when it cannot count', () => {
    expect(backend({ behind: 4, updateAvailable: true }).label).toBe('backend v0.4.2 (+4)')
    expect(backend({ behind: 4 }).tooltip).toBe('4 commits behind main · Backend v0.4.2')
    expect(backend({ updateAvailable: true })).toMatchObject({ hasUpdate: true, label: 'backend v0.4.2 (update)' })
  })

  it('leads with the update while it runs', () => {
    const applying = backend({ applying: true, applyMessage: 'Pulling…', behind: 3 })

    expect(applying).toMatchObject({ hasUpdate: false, label: 'backend v0.4.2 · update' })
    expect(applying.tooltip).toBe('Pulling… · Backend v0.4.2')
    expect(backend({ applying: true, restarting: true }).label).toBe('backend v0.4.2 · restart')
  })

  it('hides a backend with no version', () => {
    expect(backend({ version: null }).unknown).toBe(true)
  })
})
