import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { assertRuntimeManifest, copyRuntimeSource } from './bundled-runtime.mjs'
const dirs = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
test('runtime contains tracked backend resources but never tests, credentials or the desktop workspace', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-source-'))
  dirs.push(repo)
  const files = [
    'run_agent.py',
    'uv.lock',
    'hermes_cli/main.py',
    'plugins/example/plugin.yaml',
    'skills/example/SKILL.md',
    'config.example.yaml',
    'tests/test_agent.py',
    'plugins/example/tests/probe.py',
    'scripts/.env.local',
    'apps/desktop/package.json',
    '.env'
  ]
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    fs.writeFileSync(path.join(repo, file), file)
  }
  const out = path.join(repo, 'payload')
  const source = copyRuntimeSource(repo, out, files)
  for (const file of files.slice(0, 6)) expect(fs.readFileSync(path.join(source, file), 'utf8')).toBe(file)
  for (const file of files.slice(6)) expect(fs.existsSync(path.join(source, file))).toBe(false)
})
test('a runtime for another release, architecture, commit or preview cannot enter a production installer', () => {
  const expected = { version: '1.1.0', platform: 'darwin', arch: 'arm64', commit: 'a'.repeat(40) }
  const manifest = { schema: 1, experimental: false, ...expected }
  expect(() => assertRuntimeManifest(manifest, expected)).not.toThrow()
  for (const change of [
    { version: '1.0.10' },
    { arch: 'x64' },
    { platform: 'win32' },
    { commit: 'b'.repeat(40) },
    { experimental: true }
  ])
    expect(() => assertRuntimeManifest({ ...manifest, ...change }, expected)).toThrow(/does not match/)
})
