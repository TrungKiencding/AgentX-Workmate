import { atom } from 'nanostores'

import { getStarmapGraph } from '@/hermes'
import type { StarmapGraph } from '@/types/hermes'

// On-demand cache for the star map. The graph scan touches the skills catalog +
// usage ledger + memory files, so we fetch it only when the panel opens (and on
// an explicit refresh), never on a turn boundary.
export const $starmapGraph = atom<StarmapGraph | null>(null)
export const $starmapLoading = atom(false)
export const $starmapError = atom<null | string>(null)

// Memory node ids are positional (`memory:<source>:<index>`): deleting an entry
// — or an edit that merges two — shifts every later id in that file until the
// graph reloads. The map's edits and memory deletes run through
// `mutateStarmap`, which reloads afterwards; memory actions stay locked until
// that reload lands.
export const $starmapMemoryLocked = atom(false)

let inflight: Promise<void> | null = null
let mutating = 0

export async function loadStarmapGraph(force = false): Promise<void> {
  // A forced reload must reflect writes made before it was asked for, which a
  // fetch already in flight may have read past: wait that one out first.
  if (inflight && force) {
    await inflight
  }

  if (inflight) {
    return inflight
  }

  if ($starmapGraph.get() && !force) {
    return
  }

  $starmapLoading.set(true)
  $starmapError.set(null)

  inflight = (async () => {
    try {
      $starmapGraph.set(await getStarmapGraph())
    } catch (err) {
      $starmapError.set(err instanceof Error ? err.message : String(err))
    } finally {
      $starmapLoading.set(false)
      inflight = null
    }
  })()

  return inflight
}

/** Run one edit/delete made from the map, then reload the graph. `onFailure`
 *  runs before the reload, so an optimistic rollback can't overwrite it. */
export async function mutateStarmap(mutation: () => Promise<void>, onFailure: (err: unknown) => void): Promise<void> {
  mutating += 1
  $starmapMemoryLocked.set(true)

  try {
    await mutation()
  } catch (err) {
    onFailure(err)
  } finally {
    await loadStarmapGraph(true)
    mutating -= 1
    $starmapMemoryLocked.set(mutating > 0)
  }
}

/** Drop one node from the cached graph immediately; return rollback. */
export function evictStarmapNode(id: string): () => void {
  const prev = $starmapGraph.get()

  if (!prev) {
    return () => {}
  }

  const next: StarmapGraph = {
    ...prev,
    nodes: prev.nodes.filter(node => node.id !== id),
    edges: prev.edges.filter(edge => edge.source !== id && edge.target !== id)
  }

  $starmapGraph.set(next)

  return () => $starmapGraph.set(prev)
}

/** Drop the cache so the next open refetches against the now-active profile. */
export function resetStarmapGraph(): void {
  inflight = null
  $starmapGraph.set(null)
  $starmapError.set(null)
}
