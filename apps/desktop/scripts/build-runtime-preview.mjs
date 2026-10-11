#!/usr/bin/env node
// A separate local macOS ARM64 experiment; never changes the production build config.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'

const desktop = path.resolve(import.meta.dirname, '..')
const repo = path.resolve(desktop, '../..')
const out = path.join(desktop, 'build/runtime-preview')
const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'))
const product = 'AgentX Workmate Runtime Preview'

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build this preview on macOS ARM64.')

async function run(command, args, cwd = repo) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)))
  })
}

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

// uv's CPython distribution is standalone; this is NOT a copied venv.
const pythonBase = fs.realpathSync(execFileSync('uv', ['python', 'find', '--managed-python', '3.11.15'], { encoding: 'utf8' }).trim())
const pythonRoot = path.dirname(path.dirname(pythonBase))
fs.cpSync(pythonRoot, path.join(out, 'python'), { recursive: true, verbatimSymlinks: true })
const python = path.join(out, 'python/bin/python3.11')
const sitePackages = path.join(out, 'python/lib/python3.11/site-packages')
// Remove any packages that may have been added to the developer's base interpreter.
fs.rmSync(sitePackages, { recursive: true, force: true })
fs.mkdirSync(sitePackages, { recursive: true })
const requirements = path.join(out, 'requirements.txt')
await run('uv', ['export', '--frozen', '--no-dev', '--extra', 'anthropic', '--extra', 'web', '--extra', 'messaging', '--no-emit-project', '--quiet', '--output-file', requirements])
await run('uv', ['--no-config', 'pip', 'install', '--python', python, '--target', sitePackages, '--require-hashes', '--only-binary', ':all:', '-r', requirements])

// Ship tracked runtime code/resources only, never local config, credentials or caches.
const dirs = new Set(['agent', 'tools', 'hermes_cli', 'gateway', 'tui_gateway', 'cron', 'acp_adapter', 'plugins', 'providers', 'second_brain', 'skills', 'optional-skills', 'optional-mcps', 'scripts'])
const source = path.join(out, 'source')
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repo }).toString().split('\0').filter(Boolean)
for (const relative of tracked) {
  const parts = relative.split('/')
  const allowed = parts.length === 1
    ? relative.endsWith('.py') || ['pyproject.toml', 'uv.lock', 'LICENSE', 'README.md', 'config.example.yaml'].includes(relative)
    : dirs.has(parts[0])
  if (!allowed || parts.some(part => part === 'tests' || part === '__pycache__' || part === 'node_modules' || part.startsWith('.env')) || !fs.existsSync(path.join(repo, relative))) continue
  const dest = path.join(source, relative)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(path.join(repo, relative), dest)
}

fs.mkdirSync(path.join(out, 'bin'), { recursive: true })
fs.copyFileSync(fs.realpathSync(execFileSync('/usr/bin/which', ['uv'], { encoding: 'utf8' }).trim()), path.join(out, 'bin/uv'))
fs.chmodSync(path.join(out, 'bin/uv'), 0o755)
fs.copyFileSync(path.join(repo, 'node_modules/agent-browser/bin/agent-browser-darwin-arm64'), path.join(out, 'bin/agent-browser'))
fs.chmodSync(path.join(out, 'bin/agent-browser'), 0o755)
fs.writeFileSync(path.join(out, 'bin/agentx'), '#!/bin/sh\nTASK_RUNTIME_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexport PYTHONHOME="$TASK_RUNTIME_ROOT/python"\nexport PYTHONPATH="$TASK_RUNTIME_ROOT/source"\nexport PYTHONNOUSERSITE=1\nexec "$TASK_RUNTIME_ROOT/python/bin/python3.11" -m hermes_cli.main "$@"\n', { mode: 0o755 })

// The official Node archive has no Homebrew library dependencies. Verify its published digest.
const nodeVersion = process.version
const archive = `node-${nodeVersion}-darwin-arm64.tar.gz`
const base = `https://nodejs.org/dist/${nodeVersion}`
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'workmate-node-'))
try {
  await run('/usr/bin/curl', ['--fail', '--location', '--retry', '3', '--output', path.join(downloads, archive), `${base}/${archive}`])
  await run('/usr/bin/curl', ['--fail', '--location', '--retry', '3', '--output', path.join(downloads, 'SHASUMS256.txt'), `${base}/SHASUMS256.txt`])
  const line = fs.readFileSync(path.join(downloads, 'SHASUMS256.txt'), 'utf8').split('\n').find(line => line.endsWith(`  ${archive}`))
  const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(downloads, archive))).digest('hex')
  if (!line || line.split(/\s+/)[0] !== digest) throw new Error('Node archive checksum mismatch')
  await run('/usr/bin/tar', ['-xzf', path.join(downloads, archive), '-C', downloads])
  fs.renameSync(path.join(downloads, `node-${nodeVersion}-darwin-arm64`), path.join(out, 'node'))
} finally {
  fs.rmSync(downloads, { recursive: true, force: true })
}

fs.writeFileSync(path.join(out, 'runtime.json'), JSON.stringify({ schema: 1, version: pkg.version, platform: 'darwin', arch: 'arm64', python: '3.11.15', node: nodeVersion, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), builtAt: new Date().toISOString(), experimental: true }, null, 2))

await run('npm', ['run', 'build'], desktop)
const config = {
  ...pkg.build,
  appId: 'com.agentx.workmate.runtime-preview',
  productName: product,
  executableName: product,
  artifactName: 'AgentXWorkmate-RuntimePreview-${version}-${os}-${arch}.${ext}',
  protocols: [],
  directories: { ...pkg.build.directories, output: 'release/runtime-preview' },
  extraResources: [...pkg.build.extraResources.filter(resource => resource.to !== 'bundled-runtime'), { from: 'build/runtime-preview', to: 'runtime-preview' }],
  mac: { ...pkg.build.mac, target: ['dmg'], identity: null, extendInfo: { ...pkg.build.mac.extendInfo, CFBundleDisplayName: product, CFBundleExecutable: product, CFBundleName: product } },
  dmg: { ...pkg.build.dmg, title: `Install ${product}` }
}
const configPath = path.join(desktop, 'build/runtime-preview-builder.json')
fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
await run('npm', ['run', 'builder', '--', '--config', configPath, '--mac', 'dmg', '--arm64', '--publish', 'never'], desktop)
