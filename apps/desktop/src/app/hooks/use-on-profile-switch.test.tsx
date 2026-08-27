import { render } from '@testing-library/react'
import { atom } from 'nanostores'
import { act, StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const $activeGatewayProfile = atom('default')

vi.mock('@/store/profile', () => ({ $activeGatewayProfile }))

const { useOnProfileSwitch } = await import('./use-on-profile-switch')

function Probe({ onSwitch }: { onSwitch: () => void }) {
  useOnProfileSwitch(onSwitch)

  return null
}

beforeEach(() => {
  $activeGatewayProfile.set('default')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useOnProfileSwitch', () => {
  it('does not fire on first mount', () => {
    const onSwitch = vi.fn()

    render(<Probe onSwitch={onSwitch} />)

    expect(onSwitch).not.toHaveBeenCalled()
  })

  // The regression this hook was rewritten for: StrictMode runs effects
  // setup → cleanup → setup on every mount. A "have I run before" flag survives
  // that cleanup, so the second setup used to read it as a real profile switch
  // and drop view state (settings drafts) nothing would restore.
  it('does not fire on StrictMode’s simulated remount', () => {
    const onSwitch = vi.fn()

    render(
      <StrictMode>
        <Probe onSwitch={onSwitch} />
      </StrictMode>
    )

    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('fires once when the profile actually changes', () => {
    const onSwitch = vi.fn()

    render(<Probe onSwitch={onSwitch} />)

    act(() => $activeGatewayProfile.set('work'))

    expect(onSwitch).toHaveBeenCalledTimes(1)
  })

  it('fires once per change under StrictMode too', () => {
    const onSwitch = vi.fn()

    render(
      <StrictMode>
        <Probe onSwitch={onSwitch} />
      </StrictMode>
    )

    act(() => $activeGatewayProfile.set('work'))
    expect(onSwitch).toHaveBeenCalledTimes(1)

    act(() => $activeGatewayProfile.set('default'))
    expect(onSwitch).toHaveBeenCalledTimes(2)
  })

  it('ignores a re-emit of the same profile value', () => {
    const onSwitch = vi.fn()

    render(<Probe onSwitch={onSwitch} />)

    act(() => $activeGatewayProfile.set('default'))

    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('mounting after a switch does not fire for the value it mounts with', () => {
    const onSwitch = vi.fn()

    act(() => $activeGatewayProfile.set('work'))
    render(<Probe onSwitch={onSwitch} />)

    expect(onSwitch).not.toHaveBeenCalled()
  })
})
