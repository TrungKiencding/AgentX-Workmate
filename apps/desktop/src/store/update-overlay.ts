/**
 * Which update the updates dialog is showing, and whether it is open.
 *
 * Two things can be updated: this desktop app ('client', store/app-update.ts) and,
 * in remote mode, the AgentX backend it is connected to ('backend',
 * store/updates.ts). Both stores open the dialog through here; the dialog itself
 * decides what to check when it opens (app/updates-overlay.tsx).
 */

import { atom } from 'nanostores'

export type UpdateTarget = 'backend' | 'client'

export const $updateOverlayOpen = atom<boolean>(false)
export const $updateOverlayTarget = atom<UpdateTarget>('client')

export function openUpdateOverlay(target: UpdateTarget): void {
  $updateOverlayTarget.set(target)
  $updateOverlayOpen.set(true)
}

export function closeUpdateOverlay(): void {
  $updateOverlayOpen.set(false)
}
