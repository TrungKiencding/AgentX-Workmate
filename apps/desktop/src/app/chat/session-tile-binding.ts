import { useStore } from '@nanostores/react'
import { useEffect, useRef } from 'react'

import { $gatewayState } from '@/store/session'
import {
  $sessionTiles,
  $tileBindingGeneration,
  discardSessionTile,
  patchSessionTile,
  type SessionTile,
  sessionTileDelegate
} from '@/store/session-states'

/**
 * Keeps a tile bound to a live runtime that streams to THIS window's socket.
 *
 * Binds an unbound tile (boot restore, a new tab, a runtime the backend
 * reclaimed), and re-attaches one bound on an earlier connection in place:
 * after a reconnect the backend discards everything the old runtime emits
 * until a client re-attaches it, so the transcript stays up while the
 * delegate re-points it at this socket — or rebinds a fresh runtime when it
 * is gone. Returns the tile's current record.
 */
export function useTileRuntimeBinding(storedSessionId: string): SessionTile | undefined {
  const tile = useStore($sessionTiles).find(t => t.storedSessionId === storedSessionId)
  const runtimeId = tile?.runtimeId ?? null
  const gatewayOpen = useStore($gatewayState) === 'open'
  const bindingGeneration = useStore($tileBindingGeneration)
  // Bound on an earlier connection: that socket is gone.
  const staleBinding = Boolean(runtimeId) && tile?.boundGeneration !== bindingGeneration
  const resumingRef = useRef(false)

  // Same gating as the primary's route resume (use-route-resume): never fire
  // session.resume before the gateway is OPEN. Persisted tiles mount at boot
  // while it's still connecting — an ungated resume rejected there and
  // latched every restored tile into the error card.
  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    if (!gatewayOpen || tile?.error || resumingRef.current || (runtimeId && !staleBinding)) {
      return
    }

    const delegate = sessionTileDelegate()

    if (!delegate) {
      return
    }

    // Stamp the generation this attach started in: a reconnect while it is in
    // flight leaves the tile stale, so the effect re-attaches once more.
    const generation = $tileBindingGeneration.get()
    resumingRef.current = true

    delegate.resumeTile(storedSessionId).then(
      id => {
        resumingRef.current = false
        patchSessionTile(storedSessionId, { boundGeneration: generation, error: undefined, runtimeId: id })
      },
      (err: unknown) => {
        resumingRef.current = false

        const message = err instanceof Error ? err.message : String(err)
        const boundRuntimeId = $sessionTiles.get().find(t => t.storedSessionId === storedSessionId)?.runtimeId

        // A gone session (404 / "Session not found") is terminal — a stale or
        // cross-profile persisted tile. Discard it instead of latching an error
        // that re-retries on every reconnect (the "Session not found" spam).
        if (/session not found|\b404\b/i.test(message)) {
          discardSessionTile(storedSessionId)
        } else if (boundRuntimeId) {
          // Re-attaching a bound runtime failed transiently (a wedged backend,
          // the socket dropping again): keep the conversation on screen. The
          // next reconnect re-attaches it, and a send re-binds it anyway.
          patchSessionTile(storedSessionId, { boundGeneration: generation, runtimeId: boundRuntimeId })
        } else {
          patchSessionTile(storedSessionId, { error: message })
        }
      }
    )
  }, [bindingGeneration, gatewayOpen, runtimeId, staleBinding, storedSessionId, tile?.boundGeneration, tile?.error])

  // The gateway (re)opening invalidates any latched error — it likely came
  // from a not-yet-open gateway or the previous connection. Clearing it
  // retriggers the resume effect: one bounded auto-retry per (re)connect,
  // mirroring the primary path's became-open resync.
  useEffect(() => {
    if (gatewayOpen && tile?.error) {
      patchSessionTile(storedSessionId, { error: undefined })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gatewayOpen, storedSessionId])

  return tile
}
