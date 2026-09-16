import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test } from 'vitest'

import {
  discardStaleCheckout,
  restoreStaleCheckout,
  setAsideStaleCheckout,
  stalePathFor,
  sweepStaleCheckouts
} from './stale-checkout'

const scratch: string[] = []

function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-stale-'))

  scratch.push(dir)

  return dir
}

function checkout(dir: string, name = 'agentx-agent'): string {
  const root = path.join(dir, name)

  fs.mkdirSync(path.join(root, 'hermes_cli'), { recursive: true })
  fs.writeFileSync(path.join(root, 'hermes_cli', 'main.py'), 'old', 'utf8')

  return root
}

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('setAsideStaleCheckout renames the checkout next to itself and leaves user data alone', () => {
  const dir = home()
  const root = checkout(dir)

  fs.writeFileSync(path.join(dir, 'config.yaml'), 'model: {}\n', 'utf8')
  fs.writeFileSync(path.join(dir, '.env'), 'LITELLM_API_KEY=sk-keep\n', 'utf8')

  const aside = setAsideStaleCheckout(root, fs, 1700000000000)

  assert.deepEqual(aside, { activeRoot: root, asidePath: stalePathFor(root, 1700000000000) })
  assert.equal(fs.existsSync(root), false)
  assert.equal(fs.readFileSync(path.join(aside!.asidePath, 'hermes_cli', 'main.py'), 'utf8'), 'old')
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'LITELLM_API_KEY=sk-keep\n')
})

test('setAsideStaleCheckout reports nothing to move, and a refused rename, as null', () => {
  const dir = home()

  assert.equal(setAsideStaleCheckout(path.join(dir, 'missing'), fs), null)

  const root = checkout(dir)

  const refusing = {
    ...fs,
    renameSync: () => {
      throw Object.assign(new Error('EPERM: file in use'), { code: 'EPERM' })
    }
  }

  // The Windows case: python.exe still open inside the tree. The caller then
  // brings the checkout forward in place instead of replacing it.
  assert.equal(setAsideStaleCheckout(root, refusing), null)
  assert.equal(fs.existsSync(root), true)
})

test('restoreStaleCheckout removes a partial clone and puts the old checkout back', () => {
  const dir = home()
  const root = checkout(dir)
  const aside = setAsideStaleCheckout(root, fs, 1)!

  // A bootstrap that died mid-clone left something at the active root.
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  fs.writeFileSync(path.join(root, 'partial'), 'x', 'utf8')

  assert.equal(restoreStaleCheckout(aside, fs), true)
  assert.equal(fs.existsSync(aside.asidePath), false)
  assert.equal(fs.readFileSync(path.join(root, 'hermes_cli', 'main.py'), 'utf8'), 'old')
  assert.equal(fs.existsSync(path.join(root, 'partial')), false)
})

test('restoreStaleCheckout says so when the old checkout cannot come back', () => {
  const dir = home()
  const root = checkout(dir)
  const aside = setAsideStaleCheckout(root, fs, 2)!

  const refusing = {
    ...fs,
    renameSync: () => {
      throw new Error('EPERM')
    }
  }

  assert.equal(restoreStaleCheckout(aside, refusing), false)
})

test('discardStaleCheckout deletes the old checkout after a successful bootstrap', () => {
  const dir = home()
  const root = checkout(dir)
  const aside = setAsideStaleCheckout(root, fs, 3)!

  assert.equal(discardStaleCheckout(aside, fs), true)
  assert.equal(fs.existsSync(aside.asidePath), false)

  const held = {
    ...fs,
    rmSync: () => {
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
    }
  }

  assert.equal(discardStaleCheckout(aside, held), false)
})

test('sweepStaleCheckouts removes only leftovers of earlier replacements', () => {
  const dir = home()
  const root = checkout(dir)

  checkout(dir, 'agentx-agent.stale-100')
  checkout(dir, 'agentx-agent.stale-200')
  checkout(dir, 'agentx-agent-notes') // a sibling that merely shares the prefix
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'model: {}\n', 'utf8')

  const swept = sweepStaleCheckouts(root, fs)

  assert.deepEqual(swept.removed.map(p => path.basename(p)).sort(), [
    'agentx-agent.stale-100',
    'agentx-agent.stale-200'
  ])
  assert.deepEqual(swept.kept, [])
  assert.equal(fs.existsSync(root), true)
  assert.equal(fs.existsSync(path.join(dir, 'agentx-agent-notes')), true)
  assert.equal(fs.existsSync(path.join(dir, 'config.yaml')), true)
})

test('sweepStaleCheckouts is a no-op without a home directory', () => {
  assert.deepEqual(sweepStaleCheckouts(path.join(os.tmpdir(), 'nope-' + Date.now(), 'agentx-agent'), fs), {
    removed: [],
    kept: []
  })
})
