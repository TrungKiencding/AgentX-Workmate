import { beforeEach, describe, expect, it } from 'vitest'

import type { DesktopBootProgress } from '@/global'

import { $desktopBoot, applyDesktopBootProgress, BOOT_RESTART_PHASE, failDesktopBoot } from './boot'

const SIGN_IN_REQUIRED = 'AgentX sign-in required. Sign in with your AgentX account to start using AgentX Workmate.'

function progress(overrides: Partial<DesktopBootProgress>): DesktopBootProgress {
  return {
    detail: null,
    error: null,
    fakeMode: false,
    message: '',
    phase: 'backend.wait',
    progress: 50,
    running: true,
    timestamp: Date.now(),
    ...overrides
  }
}

// The full-screen surfaces split the boot state between them: the failure and
// sign-in screens take `error && !running`, the loading screen takes
// `running && !error`. `running && error` belongs to none of them, and the
// window then shows the bare chat shell.
const ownedBySomeSurface = () => {
  const { error, running } = $desktopBoot.get()

  return Boolean(error) !== running
}

describe('applyDesktopBootProgress', () => {
  beforeEach(() => {
    $desktopBoot.set({
      ...progress({ phase: 'renderer.init', progress: 2 }),
      visible: true
    })
  })

  it('keeps a failure through a late progress event of the same cycle', () => {
    failDesktopBoot('Could not connect to AgentX gateway')

    applyDesktopBootProgress(progress({ phase: 'backend.wait', running: false }))

    expect($desktopBoot.get().error).toBe('Could not connect to AgentX gateway')
  })

  it('drops the old error when main restarts the backend for a new cycle', () => {
    // The sign-in gate's successful sign-in (and Retry) calls resetBootstrap,
    // whose teardown announces the restart before the window reloads.
    failDesktopBoot(SIGN_IN_REQUIRED)

    applyDesktopBootProgress(progress({ phase: BOOT_RESTART_PHASE, progress: 4 }))

    const boot = $desktopBoot.get()

    expect(boot.running).toBe(true)
    expect(boot.error).toBeNull()
    expect(boot.visible).toBe(true)
    expect(ownedBySomeSurface()).toBe(true)
  })

  it('keeps an error a restart itself reports', () => {
    failDesktopBoot(SIGN_IN_REQUIRED)

    applyDesktopBootProgress(progress({ error: 'spawn ENOENT', phase: BOOT_RESTART_PHASE, running: false }))

    expect($desktopBoot.get().error).toBe('spawn ENOENT')
  })

  it('takes a new failure after the restart', () => {
    failDesktopBoot(SIGN_IN_REQUIRED)
    applyDesktopBootProgress(progress({ phase: BOOT_RESTART_PHASE, progress: 4 }))
    applyDesktopBootProgress(progress({ error: 'boom', phase: 'backend.error', running: false }))

    expect($desktopBoot.get().error).toBe('boom')
    expect(ownedBySomeSurface()).toBe(true)
  })
})
