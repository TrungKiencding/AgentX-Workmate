/**
 * Unit tests for the `--pair-only` watchdog: a pairing bridge whose dashboard
 * died (desktop quit, crash) must not keep rotating QR codes forever.
 * Run: node scripts/whatsapp-bridge/bridge.pairwatchdog.test.mjs
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';

import { createPairOnlyWatchdog, isPidAlive } from './bridge_helpers.js';

function harness({ parentPid = 4242, maxMs = 600000 } = {}) {
  const state = { ppid: parentPid, parentAlive: true, clock: 0, exits: [], timers: [], cleared: [] };
  const watchdog = createPairOnlyWatchdog({
    parentPid,
    getParentPid: () => state.ppid,
    isParentAlive: () => state.parentAlive,
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

// Windows: ppid keeps naming the dead parent, so only probing the original
// parent pid notices it is gone.
{
  const { state, watchdog } = harness();
  state.parentAlive = false;
  assert.equal(watchdog.check(), 'parent_exited');
  assert.deepEqual(state.exits, ['parent_exited']);
  assert.equal(state.cleared.length, 1);
}

// Default probe: with no isParentAlive given, the watchdog probes the real
// parent pid, so a dead parent ends the run even when ppid never changes.
{
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const exits = [];
  const watchdog = createPairOnlyWatchdog({
    parentPid: dead,
    getParentPid: () => dead,
    maxMs: 600000,
    onExit: reason => exits.push(reason),
    setIntervalFn: () => null,
    clearIntervalFn: () => {},
  });
  assert.equal(watchdog.check(), 'parent_exited');
  assert.deepEqual(exits, ['parent_exited']);
}

// isPidAlive: ESRCH is dead, EPERM is alive (someone else's process).
{
  const err = code => () => {
    const e = new Error(code);
    e.code = code;
    throw e;
  };
  assert.equal(isPidAlive(1234, () => true), true);
  assert.equal(isPidAlive(1234, err('ESRCH')), false);
  assert.equal(isPidAlive(1234, err('EPERM')), true);
  assert.equal(isPidAlive(0, () => true), false);
  assert.equal(isPidAlive(undefined, () => true), false);
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(spawnSync(process.execPath, ['-e', '']).pid), false);
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
