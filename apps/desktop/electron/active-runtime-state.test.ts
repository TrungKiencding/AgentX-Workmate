import assert from 'node:assert/strict'

import { test } from 'vitest'

import { classifyActiveRuntime, hasValidBootstrapMarker } from './active-runtime-state'

const VALID_MARKER = {
  pinnedCommit: '1234567890abcdef1234567890abcdef12345678',
  schemaVersion: 1
}

test('hasValidBootstrapMarker accepts the current schema with a real-looking commit', () => {
  assert.equal(hasValidBootstrapMarker(VALID_MARKER, 1), true)
})

test('hasValidBootstrapMarker rejects missing, wrong-schema, and too-short markers', () => {
  assert.equal(hasValidBootstrapMarker(null, 1), false)
  assert.equal(hasValidBootstrapMarker({ schemaVersion: 2, pinnedCommit: VALID_MARKER.pinnedCommit }, 1), false)
  assert.equal(hasValidBootstrapMarker({ schemaVersion: 1, pinnedCommit: 'abc123' }, 1), false)
})

test('classifyActiveRuntime uses a healthy active runtime even when the bootstrap marker is missing', () => {
  assert.deepEqual(classifyActiveRuntime(null, 1, true), {
    hasValidMarker: false,
    shouldUseActiveRuntime: true,
    usabilityReason: 'usable',
    pinRelation: 'unknown'
  })
})

test('classifyActiveRuntime uses a healthy active runtime even when the marker is stale or malformed', () => {
  assert.deepEqual(classifyActiveRuntime({ schemaVersion: 999, pinnedCommit: 'abc1234' }, 1, true), {
    hasValidMarker: false,
    shouldUseActiveRuntime: true,
    usabilityReason: 'usable',
    pinRelation: 'unknown'
  })
})

test('classifyActiveRuntime refuses an unusable runtime even if a valid marker exists', () => {
  assert.deepEqual(classifyActiveRuntime(VALID_MARKER, 1, false), {
    hasValidMarker: true,
    shouldUseActiveRuntime: false,
    usabilityReason: 'unusable',
    pinRelation: 'unknown'
  })
})

test('a usable checkout BEHIND the packaged install stamp is stale, not launched as is', () => {
  // The reported fault: a new installer over a machine whose agent checkout
  // dated from a month earlier kept running the old agent, because usability
  // alone decided the launch. The install must be brought forward first.
  assert.deepEqual(classifyActiveRuntime(VALID_MARKER, 1, true, 'behind'), {
    hasValidMarker: true,
    shouldUseActiveRuntime: false,
    usabilityReason: 'stale',
    pinRelation: 'behind'
  })
})

test('a checkout at or ahead of the stamp, or one git cannot describe, launches untouched', () => {
  for (const relation of ['at-pin', 'ahead', 'unknown', 'unpinned'] as const) {
    const state = classifyActiveRuntime(VALID_MARKER, 1, true, relation)

    assert.equal(state.shouldUseActiveRuntime, true, `${relation} must launch`)
    assert.equal(state.usabilityReason, 'usable', `${relation} is not stale`)
    assert.equal(state.pinRelation, relation)
  }
})

test('an unusable runtime stays unusable regardless of where its checkout stands', () => {
  assert.equal(classifyActiveRuntime(VALID_MARKER, 1, false, 'behind').usabilityReason, 'unusable')
  assert.equal(classifyActiveRuntime(VALID_MARKER, 1, false, 'ahead').usabilityReason, 'unusable')
})

test('a CLI-installed runtime with no marker launches instead of re-running bootstrap', () => {
  // The reported symptom (#60721): install.sh / install.ps1 produced a healthy
  // repo+venv, no desktop-managed marker was ever written, and every launch
  // dropped the user back into the first-run installer.
  const state = classifyActiveRuntime(null, 1, true)

  assert.equal(state.shouldUseActiveRuntime, true, 'a usable runtime must launch')
  assert.equal(state.hasValidMarker, false, 'marker provenance stays honest')
})

test('a repair that deleted the marker does not strand a healthy install', () => {
  // #72166: the repair handler clears the marker unconditionally. Runtime
  // usability, not marker presence, must decide the next boot.
  assert.equal(classifyActiveRuntime(null, 1, true).shouldUseActiveRuntime, true)
})
