// Resolve electronDist at runtime (#38673, #47917): electron-builder 26.8.x can
// re-unpack a broken Electron.app; reusing the installed dist dodges that.
// npm workspace hoisting is non-deterministic — require.resolve finds electron
// wherever it landed. Dist present → -c.electronDist=<abs>/dist; absent → let
// electron-builder fetch via @electron/get (electronVersion + ELECTRON_MIRROR).
//
// The installed dist is for THIS machine, so the override only applies to a
// build for this machine. Handing a macOS Electron.app to a `--win` build makes
// electron-builder lay it into win-unpacked/ and then die renaming an
// electron.exe that was never there — which is how `npm run dist:win` on a Mac
// failed with a bare ENOENT that named a file nobody asked for. Cross-platform
// targets fall through to @electron/get, which fetches the right one.

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"

import { isMain } from "./utils.mjs"

const require = createRequire(import.meta.url)

function electronDistDir() {
  try {
    return path.join(path.dirname(require.resolve("electron/package.json")), "dist")
  } catch {
    return null
  }
}

function distBinary(dist) {
  if (process.platform === "darwin") {
    return path.join(dist, "Electron.app", "Contents", "MacOS", "Electron")
  }
  if (process.platform === "win32") {
    return path.join(dist, "electron.exe")
  }
  return path.join(dist, "electron")
}

function electronBuilderCli() {
  const pkgJson = require.resolve("electron-builder/package.json")
  const bin = require(pkgJson).bin
  const rel = typeof bin === "string" ? bin : bin["electron-builder"]
  return path.join(path.dirname(pkgJson), rel)
}

/** electron-builder's platform flags, mapped to process.platform values. */
const PLATFORM_FLAGS = {
  "--mac": "darwin",
  "--macos": "darwin",
  "-m": "darwin",
  "--win": "win32",
  "--windows": "win32",
  "-w": "win32",
  "--linux": "linux",
  "-l": "linux",
}

/**
 * True when this invocation builds for the machine it is running on.
 *
 * No platform flag at all means "the host", which is electron-builder's own
 * default. A flag for the host platform counts too, and so does a multi-target
 * build that includes the host — the dist is usable for that part and
 * electron-builder fetches the rest.
 */
export function targetsHostPlatform(argv, hostPlatform = process.platform) {
  const requested = argv.map(arg => PLATFORM_FLAGS[arg]).filter(Boolean)

  return requested.length === 0 || requested.includes(hostPlatform)
}

function main() {
  const argv = process.argv.slice(2)
  const dist = electronDistDir()
  const args = []

  if (!targetsHostPlatform(argv)) {
    console.log(
      "[run-electron-builder] cross-platform target; letting electron-builder fetch " +
        "its own Electron rather than forcing this machine's."
    )
  } else if (dist && fs.existsSync(distBinary(dist))) {
    args.push(`-c.electronDist=${dist}`)
  } else {
    console.warn(
      "[run-electron-builder] no local electron dist; electron-builder will fetch " +
        "via @electron/get (electronVersion + ELECTRON_MIRROR)."
    )
  }

  args.push(...argv)

  const result = spawnSync(process.execPath, [electronBuilderCli(), ...args], {
    stdio: "inherit",
  })

  if (result.error) {
    console.error(`[run-electron-builder] spawn failed: ${result.error.message}`)
    process.exit(1)
  }

  process.exit(result.status == null ? 1 : result.status)
}

if (isMain(import.meta.url)) {
  main()
}
