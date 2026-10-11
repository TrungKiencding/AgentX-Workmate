import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { bundledPreviewBackend, readBundledRuntimePreview } from './bundled-runtime-preview'

const temporary: string[] = []
afterEach(() => {
  for (const dir of temporary.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function fixture() {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'workmate-runtime-'))
  temporary.push(resources)
  const root = path.join(resources, 'runtime-preview')
  fs.mkdirSync(path.join(root, 'python/bin'), { recursive: true })
  fs.mkdirSync(path.join(root, 'source/hermes_cli'), { recursive: true })
  fs.writeFileSync(path.join(root, process.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3.11'), '')
  fs.writeFileSync(path.join(root, 'source/hermes_cli/main.py'), '')
  fs.writeFileSync(
    path.join(root, 'runtime.json'),
    JSON.stringify({ schema: 1, version: '1.0.10', platform: process.platform, arch: process.arch })
  )

  return resources
}

describe('opt-in bundled runtime preview', () => {
  test('ordinary builds keep their existing resolver', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workmate-no-runtime-'))
    temporary.push(dir)
    expect(readBundledRuntimePreview(dir, '1.0.10')).toBeNull()
  })
  test('invalid or incomplete payload fails instead of downloading another backend', () => {
    const resources = fixture()
    expect(() => readBundledRuntimePreview(resources, '2.0.0')).toThrow(/does not match/)
    fs.unlinkSync(path.join(resources, 'runtime-preview', process.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3.11'))
    expect(() => readBundledRuntimePreview(resources, '1.0.10')).toThrow(/incomplete/)
  })
  test('paths follow a moved bundle, optional packages stay outside the app', () => {
    const resources = fixture()
    const moved = `${resources} moved`
    fs.renameSync(resources, moved)
    temporary.push(moved)
    const runtime = readBundledRuntimePreview(moved, '1.0.10')!
    const backend = bundledPreviewBackend(runtime, path.join(os.tmpdir(), 'preview-user-home'), ['serve'])
    expect(backend.command.startsWith(moved)).toBe(true)
    expect(backend.env.PYTHONHOME.startsWith(moved)).toBe(true)
    expect(backend.env.PYTHONPATH).toBe(runtime.source)
    expect(backend.env.AGENTX_LAZY_INSTALL_TARGET.startsWith(path.join(os.tmpdir(), 'preview-user-home') + path.sep)).toBe(true)
    expect(backend.bootstrap).toBe(false)
    expect(backend.args).toEqual(['-m', 'hermes_cli.main', 'serve'])
  })
})
