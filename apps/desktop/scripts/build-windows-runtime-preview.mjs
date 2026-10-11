#!/usr/bin/env node
// Native x64 Windows experiment, isolated from the production installer.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'

if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Build on native Windows x64')
const desktop = path.resolve(import.meta.dirname, '..')
const repo = path.resolve(desktop, '../..')
const out = path.join(desktop, 'build/runtime-preview')
const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'))
const product = 'AgentX Workmate Runtime Preview'
const version = process.argv.find(value => value.startsWith('--version='))?.slice(10) || pkg.version
const updateOnly = process.argv.includes('--update-only')
const pythonVersion = '3.11.15'
const gitVersion = '2.54.0'
async function run(command, args, cwd = repo) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: command === 'npm' })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(Error(`${command} exited ${code}`)))
  })
}
async function download(url, target, digest) {
  const response = await fetch(url)
  if (!response.ok) throw Error(`Download failed ${response.status}: ${url}`)
  const data = Buffer.from(await response.arrayBuffer())
  const sha256 = crypto.createHash('sha256').update(data).digest('hex')
  if (digest && sha256 !== digest) throw Error(`Checksum mismatch: ${url}`)
  fs.writeFileSync(target, data)
  return sha256
}
if (!updateOnly) {
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
await run('uv', ['python', 'install', pythonVersion])
const basePython = fs.realpathSync(execFileSync('uv', ['python', 'find', '--managed-python', pythonVersion], { encoding: 'utf8' }).trim())
fs.cpSync(path.dirname(basePython), path.join(out, 'python'), { recursive: true })
const python = path.join(out, 'python/python.exe')
const site = path.join(out, 'python/Lib/site-packages')
fs.rmSync(site, { recursive: true, force: true })
fs.mkdirSync(site, { recursive: true })
const requirements = path.join(out, 'requirements.txt')
await run('uv', ['export', '--frozen', '--no-dev', '--extra', 'anthropic', '--extra', 'web', '--extra', 'messaging', '--no-emit-project', '--quiet', '--output-file', requirements])
await run('uv', ['--no-config', 'pip', 'install', '--python', python, '--target', site, '--require-hashes', '--only-binary', ':all:', '-r', requirements])
const dirs = new Set(['agent', 'tools', 'hermes_cli', 'gateway', 'tui_gateway', 'cron', 'acp_adapter', 'plugins', 'providers', 'second_brain', 'skills', 'optional-skills', 'optional-mcps', 'scripts'])
const source = path.join(out, 'source')
for (const relative of execFileSync('git', ['ls-files', '-z'], { cwd: repo }).toString().split('\0').filter(Boolean)) {
  const parts = relative.split('/')
  const allowed = parts.length === 1 ? relative.endsWith('.py') || ['pyproject.toml', 'uv.lock', 'LICENSE', 'README.md', 'config.example.yaml'].includes(relative) : dirs.has(parts[0])
  if (!allowed || parts.some(part => ['tests','__pycache__','node_modules'].includes(part) || part.startsWith('.env')) || !fs.existsSync(path.join(repo, relative))) continue
  const dest = path.join(source, relative)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(path.join(repo, relative), dest)
}
fs.mkdirSync(path.join(out, 'bin'))
const uv = execFileSync('where.exe', ['uv.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
fs.copyFileSync(uv, path.join(out, 'bin/uv.exe'))
fs.copyFileSync(path.join(repo, 'node_modules/agent-browser/bin/agent-browser-win32-x64.exe'), path.join(out, 'bin/agent-browser.exe'))
fs.writeFileSync(path.join(out, 'bin/agentx.cmd'), '@echo off\r\nset "PYTHONHOME=%~dp0..\\python"\r\nset "PYTHONPATH=%~dp0..\\source"\r\nset "PYTHONNOUSERSITE=1"\r\nset "PYTHONDONTWRITEBYTECODE=1"\r\n"%~dp0..\\python\\python.exe" -m hermes_cli.main %*\r\n')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'workmate-win-payload-'))
const nodeVersion = process.version
let nodeDigest
try {
  const archive = `node-${nodeVersion}-win-x64.zip`
  const base = `https://nodejs.org/dist/${nodeVersion}`
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text()
  const expected = sums.split('\n').find(line => line.endsWith(`  ${archive}`))?.split(/\s+/)[0]
  if (!expected) throw Error('Node checksum unavailable')
  nodeDigest = await download(`${base}/${archive}`, path.join(temporary, archive), expected)
  await run('tar.exe', ['-xf', path.join(temporary, archive), '-C', temporary])
  fs.cpSync(path.join(temporary, `node-${nodeVersion}-win-x64`), path.join(out, 'node'), { recursive: true })
  const asset = `PortableGit-${gitVersion}-64-bit.7z.exe`
  await download(`https://github.com/git-for-windows/git/releases/download/v${gitVersion}.windows.1/${asset}`, path.join(temporary, asset), 'bea006a6cc69673f27b1647e84ab3a68e912fbc175ab6320c5987e012897f311')
  await run('7z', ['x', path.join(temporary, asset), `-o${path.join(out, 'git')}`, '-y'])
} finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}
fs.writeFileSync(path.join(out, 'runtime.json'), JSON.stringify({ schema: 1, version, platform: 'win32', arch: 'x64', python: pythonVersion, node: process.version, git: gitVersion, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), experimental: true, builtAt: new Date().toISOString() }, null, 2))
if (!updateOnly) await run('npm', ['run', 'build'], desktop)
// The production NSIS hook purges the managed install on uninstall. An isolated
// preview must never touch that install or its shortcuts.
const previewInclude = path.join(desktop, 'build/windows-runtime-preview-installer.nsh')
fs.writeFileSync(previewInclude, '; Isolated preview: standard NSIS app-only uninstall, keep user data.\n')
const config = { ...pkg.build, extraMetadata: { version }, appId: 'com.agentx.workmate.runtime-preview', productName: product, executableName: product, artifactName: 'AgentXWorkmate-RuntimePreview-${version}-${os}-${arch}.${ext}', protocols: [], directories: { ...pkg.build.directories, output: 'release/windows-runtime-preview' }, extraResources: [...pkg.build.extraResources.filter(resource => resource.to !== 'bundled-runtime'), { from: 'build/runtime-preview', to: 'runtime-preview' }], nsis: { ...pkg.build.nsis, include: previewInclude, shortcutName: product, uninstallDisplayName: product } }
const configPath = path.join(desktop, 'build/windows-runtime-preview-builder.json')
fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
await run('npm', ['run', 'builder', '--', '--config', configPath, '--win', 'nsis', '--x64', '--publish', 'never'], desktop)
