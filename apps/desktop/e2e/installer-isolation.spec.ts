import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildAppEnv, createSandbox } from './fixtures'
import { expect, test } from './test'

const repo = path.resolve(import.meta.dirname, '../../..')
const installer = path.join(repo, 'scripts/install.sh')

test.skip(process.platform === 'win32', 'Exercises the POSIX installer and shell launchers.')

for (const interrupted of [false, true]) {
  test(`installer leaves user commands usable after ${interrupted ? 'SIGKILL' : 'normal cleanup'}`, async () => {
    const sandbox = createSandbox("installer's home with spaces")
    // A separate fake user stands in for the host. The regression must never
    // damage the real host even when run against the broken fixture.
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-existing-user-'))
    const userBin = path.join(user, '.local/bin')
    const commands = ['agentx', 'agentx-agent', 'agentx-acp']
    const original = '#!/bin/sh\nprintf "existing-install\\n"\n'
    const shellConfig = '# existing shell configuration\n'
    fs.mkdirSync(userBin, { recursive: true })
    for (const name of commands) fs.writeFileSync(path.join(userBin, name), original, { mode: 0o755 })
    fs.writeFileSync(path.join(user, '.zshrc'), shellConfig)

    const active = path.join(sandbox.hermesHome, 'agentx-agent')
    fs.mkdirSync(path.join(active, 'venv/bin'), { recursive: true })
    // A real Python interpreter executes the installed entrypoints, without
    // downloading dependencies or calling a model/provider.
    const python = path.join(repo, '.venv/bin/python')
    const fallbackPython = path.join(repo, 'venv/bin/python')
    execFileSync(fs.existsSync(python) ? python : fallbackPython, ['-m', 'venv', '--without-pip', path.join(active, 'venv')])
    const entrypoint = 'import json, sys; print(json.dumps(sys.argv[1:]))\n'
    fs.writeFileSync(path.join(active, 'agentx'), entrypoint)
    fs.writeFileSync(path.join(active, 'run_agent.py'), entrypoint)

    const env = buildAppEnv(sandbox, {
      HOME: user,
      USERPROFILE: user,
      ZDOTDIR: user,
      XDG_CONFIG_HOME: path.join(user, '.config'),
      SHELL: '/bin/zsh',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin'
    })
    const args = [installer, '--stage', 'path', '--json', '--non-interactive', '--dir', active, '--agentx-home', sandbox.hermesHome]
    let child: ReturnType<typeof spawn> | undefined

    try {
      if (interrupted) {
        child = spawn('bash', ['-c', 'set -e; bash "$@"; echo INSTALLER_READY; exec /bin/sleep 300', 'installer', ...args], { env })
        const ready = new Promise<void>((resolve, reject) => {
          let output = ''
          child!.stdout!.on('data', data => {
            output += data.toString()
            if (output.includes('INSTALLER_READY')) resolve()
          })
          child!.on('error', reject)
          child!.on('exit', code => reject(new Error(`Installer exited before ready: ${code}\n${output}`)))
        })
        await ready
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      } else {
        execFileSync('bash', args, { env })
      }

      for (const name of commands) {
        expect(fs.readFileSync(path.join(userBin, name), 'utf8')).toBe(original)
      }
      expect(fs.readFileSync(path.join(user, '.zshrc'), 'utf8')).toBe(shellConfig)
      expect(env.HOME).toBe(user) // Native Electron/Keychain identity is preserved.
      const probe = path.join(sandbox.root, 'install-home-probe.sh')
      fs.writeFileSync(probe, 'printf "%s" "$HOME"\n')
      const installedHome = execFileSync('bash', [probe], { env, encoding: 'utf8' })
      expect(installedHome.startsWith(sandbox.root + path.sep)).toBe(true)
      const installedBin = path.join(installedHome, '.local/bin')
      for (const [name, expected] of [
        ['agentx', ['argument with spaces', '--flag']],
        ['agentx-agent', ['argument with spaces', '--flag']],
        ['agentx-acp', ['acp', 'argument with spaces', '--flag']]
      ] as const) {
        const output = execFileSync(path.join(installedBin, name), ['argument with spaces', '--flag'], {
          env: { ...env, PYTHONHOME: '/missing-python', PYTHONPATH: '/missing-modules' },
          encoding: 'utf8'
        })
        expect(JSON.parse(output)).toEqual(expected)
      }

      // No restore callback: removal of the test install cannot affect the user.
      sandbox.cleanup()
      for (const name of commands) {
        expect(execFileSync(path.join(userBin, name), { encoding: 'utf8' }).trim()).toBe('existing-install')
      }
    } finally {
      child?.kill('SIGKILL')
      sandbox.cleanup()
      fs.rmSync(user, { recursive: true, force: true })
    }
  })
}
