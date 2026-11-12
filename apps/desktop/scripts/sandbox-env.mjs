import fs from 'node:fs'
import path from 'node:path'

/**
 * Isolate filesystem writes made by a sandboxed app's Bash installer children.
 * AGENTX_HOME alone isolates data, but install.sh publishes commands and edits
 * shell profiles under HOME. Never rely on restoring the host after a test:
 * a killed process cannot run its cleanup, and parallel tests race to restore.
 * Keep the native app's HOME intact: macOS safeStorage needs the login Keychain.
 * Bootstrap launches `bash` through PATH. A private shim applies the isolated
 * home to install.sh and cached install-*.sh, including older releases. Other
 * shells (especially the macOS update/relaunch script) keep HOME so a relaunched
 * Electron still has native Keychain access.
 * Windows installer tests still require a disposable account/VM for registry
 * changes; redirecting filesystem paths does not isolate the Windows registry.
 */
export function sandboxShellEnv(root, basePath = process.env.PATH || process.env.Path || '') {
  if (process.platform === 'win32') return {}

  const home = path.join(path.resolve(root), 'user-home')
  const env = {
    HOME: home,
    USERPROFILE: home,
    ZDOTDIR: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state')
  }

  for (const directory of Object.values(env)) fs.mkdirSync(directory, { recursive: true })

  const bin = path.join(path.resolve(root), 'installer-bin')
  fs.mkdirSync(bin, { recursive: true })
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  const exports = Object.entries(env).map(([name, value]) => `export ${name}=${quote(value)}\n`).join('')
  fs.writeFileSync(path.join(bin, 'bash'), `#!/bin/sh\ncase "\${1##*/}" in\ninstall.sh|install-*.sh)\n${exports};;\nesac\nunset BASH_ENV\nexec /bin/bash "$@"\n`, { mode: 0o755 })

  return { PATH: [bin, basePath].filter(Boolean).join(path.delimiter) }
}
