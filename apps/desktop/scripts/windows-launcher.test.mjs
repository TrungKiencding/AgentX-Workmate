import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

// The real Windows installer's path stage writes HKCU\Environment. Run only
// on disposable CI accounts, and restore the two values even on test failure.
test.skipIf(process.platform !== 'win32' || process.env.CI !== 'true')(
  'native Windows launchers survive restarts and detect a removed Python runtime',
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentx launcher's Kiên home "))
    const active = path.join(root, 'installed AgentX')
    const home = path.join(root, 'user data')
    const venv = path.join(active, 'venv')
    const scripts = path.join(venv, 'Scripts')
    const installer = path.resolve(import.meta.dirname, '../../../scripts/install.ps1')
    const ps = 'powershell.exe'
    const shell = (code, env = process.env) => execFileSync(ps, [
      '-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); ' +
      '$OutputEncoding = [Console]::OutputEncoding; ' + code
    ], { env, encoding: 'utf8', timeout: 30_000 })
    const readUserEnv = () => JSON.parse(shell(
      '@{ Path = [Environment]::GetEnvironmentVariable("Path", "User"); ' +
      'AGENTX_HOME = [Environment]::GetEnvironmentVariable("AGENTX_HOME", "User") } | ConvertTo-Json -Compress'
    ))
    const original = readUserEnv()
    fs.writeFileSync(path.join(root, 'environment.json'), JSON.stringify(original))
    const restore = path.join(root, 'restore.ps1')
    fs.writeFileSync(restore,
      'param([string]$Snapshot)\n' +
      '$saved = Get-Content -LiteralPath $Snapshot -Raw | ConvertFrom-Json\n' +
      'foreach ($name in @("Path", "AGENTX_HOME")) {\n' +
      '  [Environment]::SetEnvironmentVariable($name, $saved.$name, "User")\n}\n'
    )

    try {
      fs.mkdirSync(home, { recursive: true })
      const config = path.join(home, 'config.yaml')
      fs.writeFileSync(config, '# existing user settings must survive\n')
      execFileSync('python', ['-m', 'venv', venv], { timeout: 90_000 })
      const python = path.join(scripts, 'python.exe')
      // Generate the same real distlib .exe entrypoint used by pip, without
      // downloading the agent or contacting a provider.
      execFileSync(python, ['-c', [
        'import pathlib, sys, sysconfig',
        'from pip._vendor.distlib.scripts import ScriptMaker',
        'module = pathlib.Path(sysconfig.get_path("purelib")) / "launcher_fixture.py"',
        'module.write_text("import json, os, sys\\ndef main():\\n    print(json.dumps({\\\"args\\\": sys.argv[1:], \\\"home\\\": os.environ.get(\\\"AGENTX_HOME\\\")}))\\n")',
        'maker = ScriptMaker(None, str(pathlib.Path(sys.executable).parent))',
        'maker.executable = sys.executable',
        'maker.variants = {""}',
        'maker.make("agentx = launcher_fixture:main")'
      ].join('\n')], { encoding: 'utf8', timeout: 30_000 })

      for (let install = 0; install < 2; install++) {
        execFileSync(ps, [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installer,
          '-Stage', 'path', '-Json', '-NonInteractive', '-InstallDir', active, '-AgentXHome', home
        ], { encoding: 'utf8', timeout: 30_000 })
      }
      const installed = readUserEnv()
      assert.equal(installed.AGENTX_HOME, home)
      assert.equal(installed.Path.split(';').filter(entry => entry.toLowerCase() === scripts.toLowerCase()).length, 1)

      // A fresh process starts with the persisted values, as a new Windows
      // terminal does after the environment change has been picked up.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'))
      env.Path = installed.Path + ';' + (process.env.Path || process.env.PATH || '')
      env.AGENTX_HOME = installed.AGENTX_HOME
      for (let restart = 0; restart < 3; restart++) {
        const result = JSON.parse(shell('& agentx.exe --probe "argument with spaces"', env))
        assert.deepEqual(result, { args: ['--probe', 'argument with spaces'], home })
      }
      assert.equal(fs.readFileSync(config, 'utf8'), '# existing user settings must survive\n')

      // Prove this test catches the screenshot's Windows equivalent: the
      // pip launcher exists but its baked-in Python path no longer exists.
      const moved = path.join(active, 'removed runtime')
      fs.renameSync(venv, moved)
      try {
        const broken = spawnSync(path.join(moved, 'Scripts', 'agentx.exe'), ['--probe'], {
          env, encoding: 'utf8', timeout: 30_000
        })
        assert.equal(broken.error, undefined, 'the launcher itself must still execute')
        assert.notEqual(broken.status, 0, 'a launcher with a missing interpreter must fail')
      } finally {
        fs.renameSync(moved, venv)
      }
      assert.equal(JSON.parse(shell('& agentx.exe --probe "argument with spaces"', env)).home, home)
    } finally {
      try {
        execFileSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', restore,
          '-Snapshot', path.join(root, 'environment.json')], { timeout: 30_000 })
        assert.deepEqual(readUserEnv(), original, 'the test must restore the CI account environment')
      } finally {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 })
      }
    }
  },
  180_000
)
