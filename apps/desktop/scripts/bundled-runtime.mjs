/** Native runtime payload shared by official and isolated preview installers. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'

export const PYTHON_VERSION = '3.11.15'
const RUNTIME_DIRS = new Set([
  'agent',
  'tools',
  'hermes_cli',
  'gateway',
  'tui_gateway',
  'cron',
  'acp_adapter',
  'plugins',
  'providers',
  'second_brain',
  'skills',
  'optional-skills',
  'optional-mcps',
  'scripts'
])
export function isRuntimeSource(relative) {
  const parts = relative.split('/')
  if (parts.some(part => ['tests', '__pycache__', 'node_modules'].includes(part) || part.startsWith('.env')))
    return false
  return parts.length === 1
    ? relative.endsWith('.py') ||
        ['pyproject.toml', 'uv.lock', 'LICENSE', 'README.md', 'config.example.yaml'].includes(relative)
    : RUNTIME_DIRS.has(parts[0])
}
export function copyRuntimeSource(repo, out, tracked) {
  const source = path.join(out, 'source')
  for (const relative of tracked.filter(isRuntimeSource)) {
    const original = path.join(repo, relative)
    if (!fs.existsSync(original) || !fs.statSync(original).isFile()) continue
    const dest = path.join(source, relative)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(original, dest)
  }
  return source
}
export function assertRuntimeManifest(manifest, { platform, arch, version, commit }) {
  if (
    manifest.schema !== 1 ||
    manifest.experimental !== false ||
    manifest.version !== version ||
    manifest.platform !== platform ||
    manifest.arch !== arch ||
    manifest.commit !== commit
  ) {
    throw new Error('Bundled runtime does not match this release, platform, architecture and install stamp.')
  }
}
export async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32' && command === 'npm'
    })
    child.on('error', reject)
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))))
  })
}
async function download(url, target, digest) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Download failed ${response.status}: ${url}`)
  const data = Buffer.from(await response.arrayBuffer())
  if (!digest || crypto.createHash('sha256').update(data).digest('hex') !== digest)
    throw new Error(`Checksum mismatch: ${url}`)
  fs.writeFileSync(target, data)
}
/** Builds only on the target OS/arch; a host Python must never enter another arch's installer. */
export async function prepareBundledRuntime({ desktop, platform = process.platform, arch = process.arch }) {
  if (platform !== process.platform || arch !== process.arch)
    throw new Error(`Build ${platform}-${arch} on a native runner; cross-packaging cannot ship the host Python.`)
  if (!['darwin-arm64', 'win32-x64'].includes(`${platform}-${arch}`))
    throw new Error(
      `Bundled releases currently support macOS ARM64 and Windows x64; no verified runtime for ${platform}-${arch}.`
    )
  const repo = path.resolve(desktop, '../..')
  const out = path.join(desktop, 'build/bundled-runtime')
  const stamp = JSON.parse(fs.readFileSync(path.join(desktop, 'build/install-stamp.json'), 'utf8'))
  const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'))
  const expected = { platform, arch, version: pkg.version, commit: stamp.commit }
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repo }).toString().split('\0').filter(Boolean)
  // Hash source as well as the lock: development packs must not silently reuse stale code.
  const hash = crypto.createHash('sha256').update(process.version).update(PYTHON_VERSION)
  for (const relative of tracked.filter(isRuntimeSource).sort()) {
    const file = path.join(repo, relative)
    if (fs.existsSync(file) && fs.statSync(file).isFile()) hash.update(relative).update(fs.readFileSync(file))
  }
  const sourceHash = hash.digest('hex')
  try {
    const prior = JSON.parse(fs.readFileSync(path.join(out, 'runtime.json'), 'utf8'))
    assertRuntimeManifest(prior, expected)
    if (
      prior.sourceHash === sourceHash &&
      prior.dirty === stamp.dirty &&
      fs.existsSync(path.join(out, platform === 'win32' ? 'python/python.exe' : 'python/bin/python3.11'))
    )
      return out
  } catch {
    /* Incomplete or stale payloads are rebuilt. */
  }
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true })
  await run('uv', ['python', 'install', PYTHON_VERSION], repo)
  const basePython = fs.realpathSync(
    execFileSync('uv', ['python', 'find', '--managed-python', PYTHON_VERSION], { encoding: 'utf8' }).trim()
  )
  fs.cpSync(
    platform === 'win32' ? path.dirname(basePython) : path.dirname(path.dirname(basePython)),
    path.join(out, 'python'),
    { recursive: true, verbatimSymlinks: true }
  )
  const python = path.join(out, platform === 'win32' ? 'python/python.exe' : 'python/bin/python3.11')
  const site = path.join(out, platform === 'win32' ? 'python/Lib/site-packages' : 'python/lib/python3.11/site-packages')
  fs.rmSync(site, { recursive: true, force: true })
  fs.mkdirSync(site, { recursive: true })
  const requirements = path.join(out, 'requirements.txt')
  await run(
    'uv',
    [
      'export',
      '--frozen',
      '--no-dev',
      '--extra',
      'anthropic',
      '--extra',
      'web',
      '--extra',
      'messaging',
      '--no-emit-project',
      '--quiet',
      '--output-file',
      requirements
    ],
    repo
  )
  await run(
    'uv',
    [
      '--no-config',
      'pip',
      'install',
      '--python',
      python,
      '--target',
      site,
      '--require-hashes',
      '--only-binary',
      ':all:',
      '-r',
      requirements
    ],
    repo
  )
  copyRuntimeSource(repo, out, tracked)
  fs.writeFileSync(path.join(out, 'source/.install_method'), 'bundled\n')
  fs.mkdirSync(path.join(out, 'bin'), { recursive: true })
  const uv =
    platform === 'win32'
      ? execFileSync('where.exe', ['uv.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
      : fs.realpathSync(execFileSync('/usr/bin/which', ['uv'], { encoding: 'utf8' }).trim())
  fs.copyFileSync(uv, path.join(out, 'bin', platform === 'win32' ? 'uv.exe' : 'uv'))
  const browser = `agent-browser-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`
  fs.copyFileSync(
    path.join(repo, 'node_modules/agent-browser/bin', browser),
    path.join(out, 'bin', platform === 'win32' ? 'agent-browser.exe' : 'agent-browser')
  )
  if (platform === 'win32') {
    fs.writeFileSync(
      path.join(out, 'bin/agentx.cmd'),
      '@echo off\r\nset "PYTHONHOME=%~dp0..\\python"\r\nset "PYTHONPATH=%~dp0..\\source"\r\nset "PYTHONNOUSERSITE=1"\r\nset "PYTHONDONTWRITEBYTECODE=1"\r\n"%~dp0..\\python\\python.exe" -m hermes_cli.main %*\r\n'
    )
  } else {
    fs.chmodSync(path.join(out, 'bin/uv'), 0o755)
    fs.chmodSync(path.join(out, 'bin/agent-browser'), 0o755)
    fs.writeFileSync(
      path.join(out, 'bin/agentx'),
      '#!/bin/sh\nTASK_RUNTIME_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexport PYTHONHOME="$TASK_RUNTIME_ROOT/python"\nexport PYTHONPATH="$TASK_RUNTIME_ROOT/source"\nexport PYTHONNOUSERSITE=1\nexport PYTHONDONTWRITEBYTECODE=1\nexec "$TASK_RUNTIME_ROOT/python/bin/python3.11" -m hermes_cli.main "$@"\n',
      { mode: 0o755 }
    )
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'workmate-runtime-'))
  try {
    const nodeVersion = process.version
    const archive = `node-${nodeVersion}-${platform === 'win32' ? 'win' : platform}-${arch}.${platform === 'win32' ? 'zip' : 'tar.gz'}`
    const base = `https://nodejs.org/dist/${nodeVersion}`
    const response = await fetch(`${base}/SHASUMS256.txt`)
    if (!response.ok) throw new Error('Node checksum download failed')
    const sums = await response.text()
    const digest = sums
      .split('\n')
      .find(line => line.endsWith(`  ${archive}`))
      ?.split(/\s+/)[0]
    await download(`${base}/${archive}`, path.join(temporary, archive), digest)
    await run(
      platform === 'win32' ? 'tar.exe' : '/usr/bin/tar',
      ['-xf', path.join(temporary, archive), '-C', temporary],
      repo
    )
    fs.renameSync(
      path.join(temporary, `node-${nodeVersion}-${platform === 'win32' ? 'win' : platform}-${arch}`),
      path.join(out, 'node')
    )
    if (platform === 'win32') {
      const gitVersion = '2.54.0'
      const asset = `PortableGit-${gitVersion}-64-bit.7z.exe`
      await download(
        `https://github.com/git-for-windows/git/releases/download/v${gitVersion}.windows.1/${asset}`,
        path.join(temporary, asset),
        'bea006a6cc69673f27b1647e84ab3a68e912fbc175ab6320c5987e012897f311'
      )
      await run('7z', ['x', path.join(temporary, asset), `-o${path.join(out, 'git')}`, '-y'], repo)
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
  // The marker is written last: a interrupted build can never look complete.
  fs.writeFileSync(
    path.join(out, 'runtime.json'),
    JSON.stringify(
      {
        schema: 1,
        ...expected,
        python: PYTHON_VERSION,
        node: process.version,
        sourceHash,
        dirty: stamp.dirty,
        experimental: false,
        builtAt: new Date().toISOString()
      },
      null,
      2
    )
  )
  return out
}
