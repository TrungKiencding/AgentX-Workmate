import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'

import { readWinBuild, winBuildManifest, winBuildManifestName } from './write-win-build-manifest.mjs'

let dir

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentx-win-build-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const STAMP = {
  schemaVersion: 1,
  commit: 'a'.repeat(40),
  branch: 'desktop-v1.0.9',
  builtAt: '2026-10-09T00:00:00.000Z',
  dirty: false,
  source: 'ci'
}

function write(name, content) {
  mkdirSync(dirname(join(dir, name)), { recursive: true })
  writeFileSync(join(dir, name), content)
}

function unpacked(name, stamp = STAMP) {
  write(join(name, 'resources', 'install-stamp.json'), `${JSON.stringify(stamp, null, 2)}\n`)
}

const sha256 = text => createHash('sha256').update(text).digest('hex')

test('records the stamp the unpacked builds carry and every installer of this version', async () => {
  unpacked('win-unpacked')
  unpacked('win-arm64-unpacked')
  write('AgentXWorkmate-1.0.9-win-x64.exe', 'x64 installer')
  write('AgentXWorkmate-1.0.9-win-arm64.exe', 'arm64 installer')
  write('AgentXWorkmate-1.0.9-win.exe', 'both architectures')
  // Not installers of this build: a blockmap, an older build, electron-builder's scratch.
  write('AgentXWorkmate-1.0.9-win-x64.exe.blockmap', 'blockmap')
  write('AgentXWorkmate-1.0.8-win-x64.exe', 'older installer')
  write('__uninstaller-nsis-agentx-workmate.exe', 'uninstaller')

  const build = await readWinBuild(dir, '1.0.9')

  assert.deepEqual(build.stamp, STAMP)
  assert.deepEqual(build.installers, {
    'AgentXWorkmate-1.0.9-win-arm64.exe': { sha256: sha256('arm64 installer'), bytes: 15 },
    'AgentXWorkmate-1.0.9-win-x64.exe': { sha256: sha256('x64 installer'), bytes: 13 },
    'AgentXWorkmate-1.0.9-win.exe': { sha256: sha256('both architectures'), bytes: 18 }
  })
})

test('refuses unpacked builds that pin different commits, or no unpacked build at all', async () => {
  write('AgentXWorkmate-1.0.9-win-x64.exe', 'x64 installer')

  await assert.rejects(readWinBuild(dir, '1.0.9'), /no win\*-unpacked build/)

  unpacked('win-unpacked')
  unpacked('win-arm64-unpacked', { ...STAMP, commit: 'b'.repeat(40) })

  await assert.rejects(readWinBuild(dir, '1.0.9'), /carry different install stamps/)
})

test('refuses a release folder with no installer for this version', async () => {
  unpacked('win-unpacked')
  write('AgentXWorkmate-1.0.8-win-x64.exe', 'older installer')

  await assert.rejects(readWinBuild(dir, '1.0.9'), /no AgentXWorkmate-1\.0\.9-win\*\.exe/)
})

test('names the CI run that wrote it, and the asset release-feed.ts looks for', () => {
  const env = {
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'TrungKiencding/AgentX-Workmate',
    GITHUB_RUN_ID: '42',
    GITHUB_RUN_ATTEMPT: '2'
  }

  assert.deepEqual(winBuildManifest({ version: '1.0.9', stamp: STAMP, installers: {}, env }), {
    schema: 1,
    product: 'agentx-workmate',
    version: '1.0.9',
    stamp: STAMP,
    installers: {},
    run: 'https://github.com/TrungKiencding/AgentX-Workmate/actions/runs/42/attempts/2'
  })
  assert.equal(winBuildManifest({ version: '1.0.9', stamp: STAMP, installers: {}, env: {} }).run, null)
  assert.equal(winBuildManifestName('1.0.9'), 'AgentXWorkmate-1.0.9-win-build.json')
})
