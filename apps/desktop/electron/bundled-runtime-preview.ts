import fs from 'node:fs'
import path from 'node:path'

import { buildDesktopBackendEnv, pathEnvKey } from './backend-env'

export interface BundledRuntimePreview {
  root: string
  source: string
  pythonRoot: string
  python: string
  bin: string
  nodeBin: string
  experimental: boolean
}

/** Prefer the official payload; isolated previews remain compatible. */
export function readBundledRuntime(resources: string, version: string): BundledRuntimePreview | null {
  const production = path.join(resources, 'bundled-runtime')
  const root = fs.existsSync(production) ? production : path.join(resources, 'runtime-preview')
  const experimental = root !== production
  const marker = path.join(root, 'runtime.json')

  if (!fs.existsSync(marker)) {
    if (!experimental) throw new Error('The bundled runtime is incomplete. Reinstall AgentX Workmate.')
    return null
  }

  const manifest = JSON.parse(fs.readFileSync(marker, 'utf8'))

  if (
    manifest.schema !== 1 ||
    manifest.version !== version ||
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch ||
    (!experimental && (manifest.experimental !== false || !/^[0-9a-f]{40}$/i.test(manifest.commit || '')))
  ) {
    throw new Error('The bundled runtime does not match this app. Reinstall the preview installer.')
  }

  const runtime = {
    root,
    experimental,
    source: path.join(root, 'source'),
    pythonRoot: path.join(root, 'python'),
    python:
      process.platform === 'win32'
        ? path.join(root, 'python', 'python.exe')
        : path.join(root, 'python', 'bin', 'python3.11'),
    bin: path.join(root, 'bin'),
    nodeBin: process.platform === 'win32' ? path.join(root, 'node') : path.join(root, 'node', 'bin')
  }

  for (const file of [runtime.python, path.join(runtime.source, 'hermes_cli', 'main.py')]) {
    if (!fs.existsSync(file)) {
      throw new Error(`The bundled runtime is incomplete: ${file}`)
    }
  }

  return runtime
}

export function bundledBackend(runtime: BundledRuntimePreview, home: string, args: string[]) {
  const base = buildDesktopBackendEnv({
    hermesHome: home,
    pythonPathEntries: [runtime.source],
    venvRoot: runtime.pythonRoot
  })

  return {
    kind: 'python',
    label: `bundled ${process.platform} ${process.arch} runtime${runtime.experimental ? ' preview' : ''}`,
    command: runtime.python,
    args: ['-m', 'hermes_cli.main', ...args],
    root: runtime.source,
    bootstrap: false,
    shell: false,
    env: {
      ...base,
      AGENTX_HOME: home,
      [pathEnvKey()]: [
        runtime.bin,
        runtime.nodeBin,
        path.dirname(runtime.python),
        ...(process.platform === 'win32'
          ? [path.join(runtime.root, 'git', 'cmd'), path.join(runtime.root, 'git', 'bin')]
          : []),
        base[pathEnvKey()]
      ].join(path.delimiter),
      PYTHONPATH: runtime.source,
      PYTHONNOUSERSITE: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONHOME: runtime.pythonRoot,
      // Existing immutable-runtime support; optional installs cannot rewrite the bundle.
      AGENTX_LAZY_INSTALL_TARGET: path.join(
        home,
        runtime.experimental ? 'runtime-preview-packages' : 'runtime-packages',
        `python3.11-${process.platform}-${process.arch}`
      ),
      AGENTX_BUNDLED_SKILLS: path.join(runtime.source, 'skills'),
      AGENTX_OPTIONAL_SKILLS: path.join(runtime.source, 'optional-skills'),
      AGENTX_OPTIONAL_MCPS: path.join(runtime.source, 'optional-mcps')
    }
  }
}

// Compatibility for the experimental build tooling.
export const readBundledRuntimePreview = readBundledRuntime
export const bundledPreviewBackend = bundledBackend
