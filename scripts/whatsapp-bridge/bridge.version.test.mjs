/**
 * Unit tests for the announced WhatsApp Web version. A stale version makes
 * WhatsApp refuse new device links ("Check your connection and try again"),
 * so the live web.whatsapp.com version must win over the Baileys list.
 * Run: node scripts/whatsapp-bridge/bridge.version.test.mjs
 */

import { strict as assert } from 'node:assert';

import { createCurrentVersionFetcher } from './bridge_helpers.js';

const LIVE = { version: [2, 3000, 1054726448], isLatest: true };
const LIST = { version: [2, 3000, 1043857760], isLatest: true };

// The live client version is preferred; the Baileys list is not even asked.
{
  let listCalls = 0;
  const fetch = createCurrentVersionFetcher(async () => LIVE, async () => { listCalls += 1; return LIST; }, { log: () => {} });
  assert.deepEqual(await fetch(), LIVE);
  assert.equal(listCalls, 0);
}

// fetchLatestWaWebVersion signals failure with isLatest:false (it does not
// throw): fall back to the list.
{
  const logs = [];
  const fetch = createCurrentVersionFetcher(
    async () => ({ version: [2, 3000, 1], isLatest: false, error: new Error('403') }),
    async () => LIST,
    { log: line => logs.push(line) },
  );
  assert.deepEqual(await fetch(), LIST);
  assert.match(logs[0], /403/);
}

// A throwing or hanging lookup falls back too, within its own bound.
{
  const fetch = createCurrentVersionFetcher(async () => { throw new Error('offline'); }, async () => LIST, { log: () => {} });
  assert.deepEqual(await fetch(), LIST);
}
{
  const started = Date.now();
  const fetch = createCurrentVersionFetcher(() => new Promise(() => {}), async () => LIST, { webTimeoutMs: 20, log: () => {} });
  assert.deepEqual(await fetch(), LIST);
  assert.ok(Date.now() - started < 1000);
}

console.log('bridge.version.test.mjs: all assertions passed');
