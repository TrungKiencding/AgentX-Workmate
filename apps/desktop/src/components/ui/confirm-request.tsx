import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import type { ReactNode } from 'react'

import { ConfirmDialog } from '@/components/ui/confirm-dialog'

interface ConfirmRequest {
  title: ReactNode
  description?: ReactNode
  confirmLabel?: string
  destructive?: boolean
  resolve: (confirmed: boolean) => void
}

const $confirmRequest = atom<ConfirmRequest | null>(null)

/**
 * Ask before an irreversible action (Quiet Tool spec §5.17 / §6.4) from
 * imperative code, with the app's own dialog instead of the OS `confirm()`:
 * resolves `true` on the confirm button, `false` on Cancel / Esc / backdrop.
 * Focus opens on Cancel. A second request while one is open cancels the first.
 */
export function requestConfirm(request: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  $confirmRequest.get()?.resolve(false)

  return new Promise(resolve => {
    $confirmRequest.set({ ...request, resolve })
  })
}

/** Renders the pending `requestConfirm`. Mounted once, beside the toasts. */
export function ConfirmRequestHost() {
  const request = useStore($confirmRequest)

  const settle = (confirmed: boolean) => {
    request?.resolve(confirmed)
    $confirmRequest.set(null)
  }

  return (
    <ConfirmDialog
      confirmLabel={request?.confirmLabel}
      description={request?.description}
      destructive={request?.destructive}
      dismissOnConfirm
      onClose={() => settle(false)}
      onConfirm={() => settle(true)}
      open={request !== null}
      title={request?.title ?? ''}
    />
  )
}
