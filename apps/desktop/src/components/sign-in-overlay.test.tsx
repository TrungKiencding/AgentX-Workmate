import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FALLBACK_LOCALE, setRuntimeI18nLocale, TRANSLATIONS } from '@/i18n'
import { $desktopBoot } from '@/store/boot'
import { $desktopOnboarding } from '@/store/onboarding'

import { SignInOverlay } from './sign-in-overlay'

// The sign-in gate is a separate surface from BootFailureOverlay on purpose:
// nothing has failed, the backend is simply refusing to serve an unidentified
// user. These tests pin that it reads as a sign-in prompt rather than a crash
// console, and that a completed sign-in actually gets the user into the app.

const SIGN_IN_ERROR = 'AgentX sign-in required. Sign in with your AgentX account to start using AgentX Workmate.'

function setBootError(error: string) {
  $desktopBoot.set({
    error,
    fakeMode: false,
    message: 'boot failed',
    phase: 'renderer.error',
    progress: 40,
    running: false,
    timestamp: Date.now(),
    visible: true
  })
}

function stubDesktop(value: Record<string, unknown>) {
  const original = window.agentxDesktop

  Object.defineProperty(window, 'agentxDesktop', { configurable: true, value })

  return () => Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: original })
}

beforeEach(() => {
  $desktopOnboarding.set({
    configured: true,
    flow: { status: 'idle' },
    reason: null,
    requested: false,
    firstRunSkipped: false,
    manual: false
  })
  setBootError(SIGN_IN_ERROR)
})

afterEach(() => {
  cleanup()
  setRuntimeI18nLocale(FALLBACK_LOCALE)
})

describe('SignInOverlay', () => {
  describe('visibility', () => {
    it('shows for the AgentX sign-in gate', () => {
      render(<SignInOverlay />)

      expect(screen.getByRole('button', { name: /sign in with agentx/i })).toBeTruthy()
    })

    it('stays out of the way for an ordinary boot failure', () => {
      setBootError('Could not connect to AgentX gateway')

      const { container } = render(<SignInOverlay />)

      expect(container.firstChild).toBeNull()
    })
  })

  describe('voice', () => {
    it.each(Object.keys(TRANSLATIONS) as (keyof typeof TRANSLATIONS)[])(
      'names the dialog and its action in %s',
      locale => {
        setRuntimeI18nLocale(locale)
        render(<SignInOverlay />)
        const copy = TRANSLATIONS[locale].boot.failure
        const dialog = screen.getByRole('dialog', { name: copy.keycloakTitle })

        expect(dialog.getAttribute('aria-modal')).toBe('true')
        expect(window.document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toBe(
          copy.keycloakDescription
        )
        expect(screen.getByRole('button', { name: copy.signInWithAgentX })).toBeTruthy()
      }
    )

    // The whole point of splitting this out: the recovery console's Retry /
    // Repair / Open logs / log dump belong to a crash, not to a sign-in.
    it('offers exactly one primary action and no recovery chrome', () => {
      render(<SignInOverlay />)

      expect(screen.getByRole('button', { name: /sign in with agentx/i })).toBeTruthy()
      expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
      expect(screen.queryByRole('button', { name: /repair/i })).toBeNull()
      expect(screen.queryByRole('button', { name: /open logs/i })).toBeNull()
      expect(screen.queryByRole('button', { name: /recent logs/i })).toBeNull()
    })

    it('never echoes the raw boot error at the user', () => {
      render(<SignInOverlay />)

      expect(screen.queryByText(/AgentX sign-in required\./)).toBeNull()
    })

    it('keeps a quiet way out to gateway settings', () => {
      render(<SignInOverlay />)

      expect(screen.getByRole('button', { name: /gateway settings/i })).toBeTruthy()
    })
  })

  describe('signing in', () => {
    it('clears the latched boot failure on success', async () => {
      // Without this the reload replays the same failure and the sign-in looks
      // like it did nothing.
      const order: string[] = []

      const restore = stubDesktop({
        keycloak: {
          signIn: async () => {
            order.push('signIn')

            return { ok: true, outcome: 'signed-in' }
          }
        },
        resetBootstrap: async () => {
          order.push('resetBootstrap')
        }
      })

      try {
        render(<SignInOverlay />)
        fireEvent.click(screen.getByRole('button', { name: /sign in with agentx/i }))
        await waitFor(() => expect(order).toEqual(['signIn', 'resetBootstrap']))
      } finally {
        restore()
      }
    })

    it('surfaces a failure inline instead of a toast the reload would discard', async () => {
      const restore = stubDesktop({
        keycloak: { signIn: async () => ({ ok: false, error: 'Ports 47821-47823 are all in use.' }) },
        resetBootstrap: async () => undefined
      })

      try {
        render(<SignInOverlay />)
        fireEvent.click(screen.getByRole('button', { name: /sign in with agentx/i }))
        expect(await screen.findByText(/ports 47821-47823 are all in use/i)).toBeTruthy()
        expect(screen.getByRole('alert').textContent).toContain('Ports 47821-47823')
        expect(screen.getByRole('button', { name: /sign in with agentx/i }).hasAttribute('disabled')).toBe(false)
      } finally {
        restore()
      }
    })

    it('does not clear the latch when sign-in did not succeed', async () => {
      const order: string[] = []

      const restore = stubDesktop({
        keycloak: {
          signIn: async () => {
            order.push('signIn')

            return { ok: false, error: 'cancelled' }
          }
        },
        resetBootstrap: async () => {
          order.push('resetBootstrap')
        }
      })

      try {
        render(<SignInOverlay />)
        fireEvent.click(screen.getByRole('button', { name: /sign in with agentx/i }))
        await waitFor(() => expect(order).toEqual(['signIn']))
      } finally {
        restore()
      }
    })

    it('disables the button while the browser round trip is outstanding', async () => {
      // signIn() resolves only after the loopback callback lands, so it can be
      // outstanding for as long as the user takes. A second click would burn
      // the first flow's listener.
      let release: (v: unknown) => void = () => undefined

      const restore = stubDesktop({
        keycloak: { signIn: () => new Promise(resolve => (release = resolve)) },
        resetBootstrap: async () => undefined
      })

      try {
        render(<SignInOverlay />)
        const button = screen.getByRole('button', { name: /sign in with agentx/i })
        fireEvent.click(button)

        await waitFor(() => expect(screen.getByRole('button', { name: /waiting for your browser/i })).toBeTruthy())
        expect(screen.getByRole('button', { name: /waiting for your browser/i }).hasAttribute('disabled')).toBe(true)
        expect(screen.getByRole('button', { name: /gateway settings/i }).hasAttribute('disabled')).toBe(true)
        expect(screen.getByText(/complete sign-in in your browser/i).closest('[aria-live]')).toBeTruthy()

        await act(async () => release({ ok: false, error: 'cancelled' }))
      } finally {
        restore()
      }
    })

    it('clears the previous error when the user tries again', async () => {
      let attempts = 0
      let release: (v: unknown) => void = () => undefined

      const restore = stubDesktop({
        keycloak: {
          signIn: () =>
            ++attempts === 1
              ? Promise.resolve({ ok: false, error: 'Please try again' })
              : new Promise(resolve => (release = resolve))
        }
      })

      try {
        render(<SignInOverlay />)
        fireEvent.click(screen.getByRole('button', { name: /sign in with agentx/i }))
        await screen.findByRole('alert')
        fireEvent.click(screen.getByRole('button', { name: /sign in with agentx/i }))
        expect(screen.queryByRole('alert')).toBeNull()
        expect(attempts).toBe(2)
        await act(async () => release({ ok: false, error: 'cancelled' }))
      } finally {
        restore()
      }
    })

    it('keeps a short success label and both actions disabled while the backend resets', async () => {
      let release: () => void = () => undefined

      const restore = stubDesktop({
        keycloak: { signIn: async () => ({ ok: true }) },
        resetBootstrap: () => new Promise<void>(resolve => (release = resolve))
      })

      try {
        render(<SignInOverlay />)
        fireEvent.click(screen.getByRole('button', { name: /sign in with agentx/i }))
        const button = await screen.findByRole('button', { name: 'Signed in' })

        expect(button.hasAttribute('disabled')).toBe(true)
        expect(screen.getByRole('button', { name: /gateway settings/i }).hasAttribute('disabled')).toBe(true)
        expect(screen.getByText(/starting agentx workmate/i).closest('[aria-live]')).toBeTruthy()
        await act(async () => release())
      } finally {
        restore()
      }
    })

    it('reports a thrown bridge error rather than hanging', async () => {
      const restore = stubDesktop({
        keycloak: {
          signIn: async () => {
            throw new Error('bridge exploded')
          }
        },
        resetBootstrap: async () => undefined
      })

      try {
        render(<SignInOverlay />)
        fireEvent.click(screen.getByRole('button', { name: /sign in with agentx/i }))
        expect(await screen.findByText(/bridge exploded/i)).toBeTruthy()
      } finally {
        restore()
      }
    })
  })
})
