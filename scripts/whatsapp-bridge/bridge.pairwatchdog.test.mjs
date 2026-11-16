/**
 * Unit tests for the `--pair-only` watchdog: a pairing bridge whose dashboard
 * died (desktop quit, crash) must not keep rotating QR codes forever.
 * Run: node scripts/whatsapp-bridge/bridge.pairwatchdog.test.mjs
 */

import { strict as assert } from 'node:assert';

import { createPairOnlyWatchdog } from './bridge_helpers.js';

function harness({ parentPid = 4242, maxMs = 600000 } = {}) {
  const state = { ppid: parentPid, clock: 0, exits: [], timers: [], cleared: [] };
  const watchdog = createPairOnlyWatchdog({
    parentPid,
    getParentPid: () => state.ppid,
    maxMs,
    onExit: reason => state.exits.push(reason),
    now: () => state.clock,
    setIntervalFn: (fn, ms) => {
      const timer = { fn, ms };
      state.timers.push(timer);
      return timer;
    },
    clearIntervalFn: timer => state.cleared.push(timer),
  });
  return { state, watchdog };
}

// While the parent lives and time remains, nothing happens.
{
  const { state, watchdog } = harness();
  assert.equal(state.timers.length, 1);
  assert.equal(state.timers[0].ms, 2000);
  state.clock = 599999;
  assert.equal(watchdog.check(), null);
  assert.deepEqual(state.exits, []);
}

// The parent dying (re-parented to launchd/init) ends the run once.
{
  const { state, watchdog } = harness();
  state.ppid = 1;
  assert.equal(watchdog.check(), 'parent_exited');
  assert.deepEqual(state.exits, ['parent_exited']);
  assert.equal(state.cleared.length, 1);
}

// The setup window running out ends the run, matching the backend's TTL.
{
  const { state, watchdog } = harness({ maxMs: 600000 });
  state.clock = 600000;
  assert.equal(watchdog.check(), 'expired');
  assert.deepEqual(state.exits, ['expired']);
}

// stop() (pairing finished) clears the timer and never fires.
{
  const { state, watchdog } = harness();
  watchdog.stop();
  assert.equal(state.cleared.length, 1);
}

console.log('bridge.pairwatchdog.test.mjs: all assertions passed');
