import type { Translations } from '@/i18n/types'

/** The slice of boot progress the label needs — `$desktopBoot` satisfies it. */
export interface BootPhaseInput {
  phase: string
  message: string
  detail?: null | string
}

type PhaseKey = keyof Translations['boot']['phases']

// Main-process phases (electron/main.ts `advanceBootProgress` /
// `updateBootProgress`) → catalog keys. The main process speaks English and
// knows nothing about the locale, so the *phase* is what gets translated, never
// the message. Renderer phases (`renderer.*`) already carry a localized message
// and fall through untouched.
const PHASE_KEYS: Readonly<Record<string, PhaseKey>> = {
  idle: 'idle',
  'bootstrap.choice': 'bootstrapChoice',
  'backend.update-wait': 'updateWait',
  'backend.resolve': 'resolve',
  'backend.restart': 'restarting',
  'backend.remote': 'remote',
  'backend.runtime': 'runtime',
  'runtime.external': 'runtimeExternal',
  'runtime.ready': 'runtimeReady',
  'backend.spawn': 'spawn',
  'backend.port': 'port',
  'backend.wait': 'wait',
  'backend.warmup': 'warmup',
  'backend.ready': 'ready',
  'backend.remote-ready': 'remoteReady'
}

/** Every main-process phase the renderer can name. Exported for the test that keeps this map in step with main.ts. */
export const KNOWN_BOOT_PHASES: readonly string[] = Object.keys(PHASE_KEYS)

/**
 * The line under the boot progress bar, in the app's language.
 *
 * A phase the catalog knows is rendered from the catalog, with the dynamic part
 * the main process attached (`detail`: a gateway URL, a runtime path) appended
 * after a middle dot. An unknown phase keeps the raw message rather than
 * showing nothing — a main process newer than this renderer must still say
 * *something*.
 */
export function bootPhaseLabel(t: Pick<Translations, 'boot'>, boot: BootPhaseInput): string {
  const key = PHASE_KEYS[boot.phase]

  if (!key) {
    return boot.message
  }

  const label = t.boot.phases[key]
  const detail = boot.detail?.trim()

  return detail ? `${label} · ${detail}` : label
}
