import { atom } from 'nanostores'

// Pending pairing requests, lifted for display: the Messaging page owns the
// fetch (its refreshPairing writes through here) and the sidebar's "Tin nhắn"
// nav row reads the count for its badge. Deliberately NO polling of its own —
// the page's change-event refresh and visits keep it honest, so a badge can
// be stale until the change watcher ticks or the page is opened. That trade
// was chosen over a second poller (plan Phase 4 §5).
export const $pendingPairingCount = atom(0)

export function setPendingPairingCount(count: number): void {
  if ($pendingPairingCount.get() !== count) {
    $pendingPairingCount.set(count)
  }
}
