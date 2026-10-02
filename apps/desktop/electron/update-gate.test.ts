/**
 * Tests for electron/update-gate.ts — the gate that parks local backend
 * spawns while an update (`agentx update`, or a staged recovery updater) holds
 * the on-disk update marker.
 */

import assert from 'node:assert/strict'

import { test } from 'vitest'

import { updateGateReason, waitForUpdateClearance } from './update-gate'

function deps(marker: boolean) {
  return { hasLiveMarker: () => marker }
}

// ---------------------------------------------------------------------------
// updateGateReason
// ---------------------------------------------------------------------------

test('gate open when no live marker exists', () => {
  assert.equal(updateGateReason(deps(false)), null)
})

test('a live marker closes the gate', () => {
  assert.equal(updateGateReason(deps(true)), 'marker')
})

// ---------------------------------------------------------------------------
// waitForUpdateClearance
// ---------------------------------------------------------------------------

test('returns clear immediately without sleeping when the gate is open', async () => {
  let slept = 0

  const outcome = await waitForUpdateClearance(deps(false), {
    pollMs: 10,
    sleep: async () => {
      slept += 1
    },
    timeoutMs: 1000
  })

  assert.equal(outcome, 'clear')
  assert.equal(slept, 0)
})

test('parks while the marker is live and finishes when it goes away', async () => {
  let marker = true
  let ticks = 0

  const outcome = await waitForUpdateClearance(
    { hasLiveMarker: () => marker },
    {
      onWaitTick: reason => {
        ticks += 1
        assert.equal(reason, 'marker')

        if (ticks >= 3) {
          marker = false
        }
      },
      pollMs: 1,
      sleep: async () => {},
      timeoutMs: 10_000
    }
  )

  assert.equal(outcome, 'finished')
  assert.equal(ticks, 3)
})

test('returns timeout when the gate never opens', async () => {
  let clock = 0

  const outcome = await waitForUpdateClearance(deps(true), {
    now: () => clock,
    pollMs: 10,
    sleep: async ms => {
      clock += ms
    },
    timeoutMs: 50
  })

  assert.equal(outcome, 'timeout')
})
