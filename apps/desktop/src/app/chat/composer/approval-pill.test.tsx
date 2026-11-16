import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { $approvalModes } from '@/store/approval-mode'
import { $activeGatewayProfile } from '@/store/profile'
import { $gatewayState } from '@/store/session'

import { ApprovalPill } from './approval-pill'

const requestGateway = vi.fn()

vi.mock('@/app/gateway/hooks/use-gateway-request', () => ({
  useGatewayRequest: () => ({ requestGateway })
}))

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      disconnect() {}
      observe() {}
      unobserve() {}
    }
  )
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.setPointerCapture ??= () => undefined
  Element.prototype.releasePointerCapture ??= () => undefined
  HTMLElement.prototype.scrollIntoView ??= () => undefined
})

beforeEach(() => {
  $approvalModes.set({})
  $activeGatewayProfile.set('default')
  $gatewayState.set('open')
  requestGateway.mockReset()
  requestGateway.mockImplementation(async (method: string, params?: Record<string, unknown>) =>
    method === 'config.get' ? { value: 'smart' } : { value: params?.value }
  )
})

afterEach(() => {
  cleanup()
})

// No provider: the suite's pinned locale (English) is what `useI18n` reads. A
// provider would load the config and move to its language mid-test.
const renderPill = () => render(<ApprovalPill />)

const openMenu = async () => {
  fireEvent.pointerDown(screen.getByRole('button', { name: /approval mode/i }), { button: 0 })

  return screen.findByRole('menuitemradio', { name: /manual/i })
}

// Pilot 2026-11-10: "add automatic vs manual approval so I don't have to keep
// pressing Accept". The modes existed; the control for them was a status-bar
// item in a status bar that is off by default.
describe('approval pill under the composer', () => {
  it('shows the mode the backend is in', async () => {
    requestGateway.mockImplementation(async () => ({ value: 'manual' }))
    renderPill()

    await waitFor(() => expect(screen.getByRole('button', { name: /approval mode: manual/i })).toBeTruthy())
    expect(requestGateway).toHaveBeenCalledWith('config.get', { key: 'approvals.mode' })
  })

  it('offers the three modes and saves the one picked', async () => {
    renderPill()
    fireEvent.click(await openMenu())

    await waitFor(() =>
      expect(requestGateway).toHaveBeenCalledWith('config.set', { key: 'approvals.mode', value: 'manual' })
    )
    expect($approvalModes.get().default).toBe('manual')
  })

  it('asks before switching approvals off, and only then saves it', async () => {
    renderPill()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: /off/i }))

    const dialog = await screen.findByRole('dialog')

    expect(dialog.textContent).toContain('without asking')
    expect(requestGateway).not.toHaveBeenCalledWith('config.set', expect.anything())
    expect($approvalModes.get().default ?? 'smart').toBe('smart')

    fireEvent.click(screen.getByRole('button', { name: 'Run without asking' }))

    await waitFor(() =>
      expect(requestGateway).toHaveBeenCalledWith('config.set', { key: 'approvals.mode', value: 'off' })
    )
    expect($approvalModes.get().default).toBe('off')
  })

  it('leaves the mode alone when the confirmation is cancelled', async () => {
    renderPill()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: /off/i }))
    await screen.findByRole('dialog')

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(requestGateway).not.toHaveBeenCalledWith('config.set', expect.anything())
  })

  it('is disabled until the gateway is connected', () => {
    $gatewayState.set('connecting')
    renderPill()

    expect((screen.getByRole('button', { name: /approval mode/i }) as HTMLButtonElement).disabled).toBe(true)
    expect(requestGateway).not.toHaveBeenCalled()
  })
})

describe('approval mode copy', () => {
  it('reads in Vietnamese as plain words, not manual / smart / off', async () => {
    const { TRANSLATIONS } = await import('@/i18n')
    const copy = TRANSLATIONS.vi.shell.approvalMode

    expect([copy.manual, copy.smart, copy.off]).toEqual(['Hỏi mỗi lần', 'Tự động khi an toàn', 'Tự động tất cả'])
    expect(copy.ariaLabel(copy.smart)).toBe('Phê duyệt tác vụ: Tự động khi an toàn')
  })
})
