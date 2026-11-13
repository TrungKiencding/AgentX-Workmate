import { atom } from 'nanostores'

import type { DesktopBootProgress } from '@/global'
import { translateNow } from '@/i18n'

export interface DesktopBootState extends DesktopBootProgress {
  visible: boolean
}

const INITIAL_BOOT_STATE: DesktopBootState = {
  detail: null,
  error: null,
  fakeMode: false,
  message: translateNow('boot.steps.startingAgentxDesktop'),
  phase: 'renderer.init',
  progress: 2,
  running: true,
  timestamp: Date.now(),
  visible: true
}

export const $desktopBoot = atom<DesktopBootState>(INITIAL_BOOT_STATE)

// The phase main.ts announces when it tears the backend down to boot it again
// (`resetBootProgressForReconnect`): Retry, a completed sign-in, a re-home.
// Keep the two in step.
export const BOOT_RESTART_PHASE = 'backend.restart'

function clampProgress(value: number) {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.max(0, Math.min(100, Math.round(value)))
}

export function applyDesktopBootProgress(progress: DesktopBootProgress) {
  const current = $desktopBoot.get()
  const nextProgress = clampProgress(progress.progress)
  const mergedProgress = progress.running ? Math.max(current.progress, nextProgress) : nextProgress

  // Don't let a late progress event (error: null) clobber a previously-set
  // boot failure — failDesktopBoot is terminal for this boot cycle. A restart
  // is the one event that opens a NEW cycle, and the old cycle's error must
  // not ride into it: "running" plus a stale error is a state no surface owns
  // (the failure and sign-in screens wait for !running, the loading screen
  // for !error), so the window showed the bare chat shell until the reload.
  const startsNewCycle = progress.running && progress.phase === BOOT_RESTART_PHASE
  const error = progress.error ?? (current.running || startsNewCycle ? null : current.error)

  $desktopBoot.set({
    ...current,
    ...progress,
    error,
    progress: mergedProgress,
    visible: progress.running || mergedProgress < 100 || Boolean(error)
  })
}

export function setDesktopBootStep(step: {
  phase: string
  message: string
  progress: number
  running?: boolean
  fakeMode?: boolean
  error?: string | null
}) {
  const current = $desktopBoot.get()
  applyDesktopBootProgress({
    detail: null,
    error: step.error ?? null,
    fakeMode: step.fakeMode ?? current.fakeMode,
    message: step.message,
    phase: step.phase,
    progress: step.progress,
    running: step.running ?? true,
    timestamp: Date.now()
  })
}

export function completeDesktopBoot(message = translateNow('boot.ready')) {
  const current = $desktopBoot.get()
  $desktopBoot.set({
    ...current,
    detail: null,
    error: null,
    message,
    phase: 'renderer.ready',
    progress: 100,
    running: false,
    timestamp: Date.now(),
    visible: false
  })
}

export function failDesktopBoot(message: string) {
  const current = $desktopBoot.get()
  $desktopBoot.set({
    ...current,
    error: message,
    message: translateNow('boot.desktopBootFailedWithMessage', message),
    phase: 'renderer.error',
    progress: clampProgress(current.progress),
    running: false,
    timestamp: Date.now(),
    visible: true
  })
}
