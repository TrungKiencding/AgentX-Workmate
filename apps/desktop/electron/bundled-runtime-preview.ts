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
}

/** Opt-in payload: ordinary releases have no marker and keep their resolver. */
export function readBundledRuntimePreview(resources: string, version: string): BundledRuntimePreview | null {
  const root = path.join(resources, 'runtime-preview')
  const marker = path.join(root, 'runtime.json')

  if (!fs.existsSync(marker)) {
    return null
  }

  const manifest = JSON.parse(fs.readFileSync(marker, 'utf8'))

  if (
    manifest.schema !== 1 ||
    manifest.version !== version ||
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch
  ) {
    throw new Error('The bundled preview runtime does not match this app. Reinstall the preview installer.')
  }

  const runtime = {
    root,
    source: path.join(root, 'source'),
    pythonRoot: path.join(root, 'python'),
    python: process.platform === 'win32' ? path.join(root, 'python', 'python.exe') : path.join(root, 'python', 'bin', 'python3.11'),
    bin: path.join(root, 'bin'),
    nodeBin: process.platform === 'win32' ? path.join(root, 'node') : path.join(root, 'node', 'bin')
  }

  for (const file of [runtime.python, path.join(runtime.source, 'hermes_cli', 'main.py')]) {
    if (!fs.existsSync(file)) {
      throw new Error(`The bundled preview runtime is incomplete: ${file}`)
    }
  }

  return runtime
}

export function bundledPreviewBackend(runtime: BundledRuntimePreview, home: string, args: string[]) {
  const base = buildDesktopBackendEnv({
    hermesHome: home,
    pythonPathEntries: [runtime.source],
    venvRoot: runtime.pythonRoot
  })

  return {
    kind: 'python',
    label: `bundled ${process.platform} ${process.arch} runtime preview`,
    command: runtime.python,
    args: ['-m', 'hermes_cli.main', ...args],
    root: runtime.source,
    bootstrap: false,
    shell: false,
    env: {
      ...base,
      [pathEnvKey()]: [runtime.bin, runtime.nodeBin, path.dirname(runtime.python), ...(process.platform === 'win32' ? [path.join(runtime.root, 'git', 'cmd'), path.join(runtime.root, 'git', 'bin')] : []), base[pathEnvKey()]].join(path.delimiter),
      PYTHONPATH: runtime.source,
      PYTHONNOUSERSITE: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONHOME: runtime.pythonRoot,
      // Existing immutable-runtime support; optional installs cannot rewrite the bundle.
      AGENTX_LAZY_INSTALL_TARGET: path.join(home, 'runtime-preview-packages', `python3.11-${process.platform}-${process.arch}`),
      AGENTX_BUNDLED_SKILLS: path.join(runtime.source, 'skills'),
      AGENTX_OPTIONAL_SKILLS: path.join(runtime.source, 'optional-skills'),
      AGENTX_OPTIONAL_MCPS: path.join(runtime.source, 'optional-mcps')
    }
  }
}
