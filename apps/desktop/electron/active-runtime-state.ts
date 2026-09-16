import type { CheckoutPinRelation } from './checkout-pin'

export interface BootstrapMarkerLike {
  pinnedCommit?: unknown
  schemaVersion?: unknown
}

export interface ActiveRuntimeState {
  hasValidMarker: boolean
  shouldUseActiveRuntime: boolean
  /**
   * 'stale' is a runtime that would launch fine but sits BEHIND the commit
   * this desktop build was stamped with; the caller routes it through the
   * bootstrap to bring it forward instead of launching it as is.
   */
  usabilityReason: 'usable' | 'unusable' | 'stale'
  pinRelation: CheckoutPinRelation
}

export function hasValidBootstrapMarker(
  marker: BootstrapMarkerLike | null | undefined,
  schemaVersion: number
): boolean {
  if (!marker || typeof marker !== 'object') {
    return false
  }

  if (marker.schemaVersion !== schemaVersion) {
    return false
  }

  if (typeof marker.pinnedCommit !== 'string' || marker.pinnedCommit.length < 7) {
    return false
  }

  return true
}

// The active install at ~/.agentx/agentx-agent can be real and runnable even if
// Desktop never wrote its first-run bootstrap marker (for example when AgentX
// was installed by the CLI first, or when a past desktop build forgot the
// marker). Runtime usability is authoritative for "can we launch local AgentX
// right now?"; the marker is only provenance about how that install was
// created. A missing/stale marker must never force a healthy local install into
// the first-run bootstrap UI.
//
// `pinRelation` (see checkout-pin.ts) is the one thing that can hold a usable
// runtime back: a checkout BEHIND the packaged install stamp is 'stale', so
// that installing a newer build over an older agent brings the agent forward
// instead of quietly launching it. 'at-pin', 'ahead', 'unknown' and 'unpinned'
// all launch — a newer checkout (in-app update, `agentx update`, a developer
// branch) is never rewound, and a checkout git cannot describe is left alone.
export function classifyActiveRuntime(
  marker: BootstrapMarkerLike | null | undefined,
  schemaVersion: number,
  runtimeUsable: boolean,
  pinRelation: CheckoutPinRelation = 'unknown'
): ActiveRuntimeState {
  const hasValidMarker = hasValidBootstrapMarker(marker, schemaVersion)

  if (!runtimeUsable) {
    return {
      hasValidMarker,
      shouldUseActiveRuntime: false,
      usabilityReason: 'unusable',
      pinRelation
    }
  }

  if (pinRelation === 'behind') {
    return {
      hasValidMarker,
      shouldUseActiveRuntime: false,
      usabilityReason: 'stale',
      pinRelation
    }
  }

  return {
    hasValidMarker,
    shouldUseActiveRuntime: true,
    usabilityReason: 'usable',
    pinRelation
  }
}
