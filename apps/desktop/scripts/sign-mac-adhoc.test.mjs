import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, test } from 'vitest'

import { codesignArgs, hasRealSignature, signAppAdHoc, signingPlan } from './sign-mac-adhoc.mjs'

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENTITLEMENTS = path.join(DESKTOP_ROOT, 'electron', 'entitlements.mac.plist')
const INHERIT = path.join(DESKTOP_ROOT, 'electron', 'entitlements.mac.inherit.plist')

let dir

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-sign-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function touch(file, content = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

/** The shape electron-builder leaves: the app, its framework, helper apps, native modules. */
function fakeApp() {
  const app = path.join(dir, 'AgentX Workmate.app')
  const contents = path.join(app, 'Contents')

  touch(path.join(contents, 'MacOS', 'AgentX Workmate'))
  touch(
    path.join(contents, 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Libraries', 'libffmpeg.dylib')
  )
  touch(
    path.join(
      contents,
      'Frameworks',
      'Electron Framework.framework',
      'Versions',
      'A',
      'Helpers',
      'chrome_crashpad_handler'
    )
  )
  touch(path.join(contents, 'Frameworks', 'AgentX Workmate Helper.app', 'Contents', 'MacOS', 'AgentX Workmate Helper'))
  touch(path.join(contents, 'Frameworks', 'AgentX Workmate Helper.app', 'Contents', 'Frameworks', 'inner.dylib'))
  touch(path.join(contents, 'Frameworks', 'AgentX Workmate Helper (GPU).app', 'Contents', 'MacOS', 'GPU'))
  touch(
    path.join(contents, 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty', 'build', 'Release', 'pty.node')
  )
  touch(
    path.join(
      contents,
      'Resources',
      'app.asar.unpacked',
      'node_modules',
      'node-pty',
      'build',
      'Release',
      'spawn-helper'
    )
  )
  touch(path.join(contents, 'Resources', 'app.asar'))

  return app
}

describe('signingPlan', () => {
  test('signs standalone code, then nested bundles, then the app — deepest first', () => {
    const app = fakeApp()
    const ids = {
      [app]: 'com.agentx.workmate',
      [path.join(app, 'Contents', 'Frameworks', 'AgentX Workmate Helper.app')]: 'com.agentx.workmate.helper'
    }

    const plan = signingPlan(app, {
      entitlements: ENTITLEMENTS,
      inheritEntitlements: INHERIT,
      bundleId: bundle => ids[bundle] ?? null
    })

    const names = plan.map(step => path.relative(app, step.path))

    assert.deepEqual(names, [
      'Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node',
      'Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper',
      'Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler',
      'Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib',
      'Contents/Frameworks/AgentX Workmate Helper (GPU).app',
      'Contents/Frameworks/AgentX Workmate Helper.app',
      'Contents/Frameworks/Electron Framework.framework',
      ''
    ])

    // Standalone code is signed without the runtime or a pinned requirement.
    assert.deepEqual(plan[0], { path: plan[0].path, runtime: false, entitlements: null, identifier: null })
    // Helper apps run with the inherited entitlements; the app with its own.
    assert.equal(plan[4].entitlements, INHERIT)
    assert.equal(plan[5].identifier, 'com.agentx.workmate.helper')
    assert.equal(plan[6].entitlements, null)
    assert.deepEqual(plan.at(-1), {
      path: app,
      runtime: true,
      entitlements: ENTITLEMENTS,
      identifier: 'com.agentx.workmate'
    })
    // What sits inside a helper app is signed with it, not on its own.
    assert.equal(
      names.some(name => name.endsWith('inner.dylib')),
      false
    )
  })
})

describe('codesignArgs', () => {
  test('pins an identifier requirement on ad-hoc bundles', () => {
    assert.deepEqual(
      codesignArgs({ path: '/A.app', runtime: true, entitlements: '/e.plist', identifier: 'com.agentx.workmate' }),
      [
        '--force',
        '--sign',
        '-',
        '--timestamp=none',
        '--options',
        'runtime',
        '--entitlements',
        '/e.plist',
        '--requirements',
        '=designated => identifier "com.agentx.workmate"',
        '/A.app'
      ]
    )
    assert.deepEqual(codesignArgs({ path: '/x.node', runtime: false, entitlements: null, identifier: null }), [
      '--force',
      '--sign',
      '-',
      '--timestamp=none',
      '/x.node'
    ])
  })
})

describe('hasRealSignature', () => {
  const reports =
    (report, { verifies = true } = {}) =>
    async (_file, args) => {
      if (args[0] === '-dv') {
        return { stdout: '', stderr: report }
      }

      if (!verifies) {
        throw new Error('invalid signature')
      }

      return { stdout: '', stderr: '' }
    }

  test('is true only for an intact Team ID signature', async () => {
    assert.equal(await hasRealSignature('/A.app', reports('Signature=adhoc\nTeamIdentifier=not set')), false)
    assert.equal(await hasRealSignature('/A.app', reports('TeamIdentifier=ABCDE12345')), true)
    assert.equal(await hasRealSignature('/A.app', reports('TeamIdentifier=ABCDE12345', { verifies: false })), false)
    assert.equal(
      await hasRealSignature('/A.app', async () => {
        throw new Error('code object is not signed at all')
      }),
      false
    )
  })
})

// Sign a small but real bundle with the real codesign: the designated requirement
// must come out identifier-based, and the bundle must verify strictly.
const describeMac = process.platform === 'darwin' ? describe : describe.skip

describeMac('signAppAdHoc on a real bundle', () => {
  function plist(id, executable) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleExecutable</key><string>${executable}</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`
  }

  test('pins identifier requirements and verifies strictly', async () => {
    const app = path.join(dir, 'Sample.app')
    const helper = path.join(app, 'Contents', 'Frameworks', 'Sample Helper.app')

    touch(path.join(app, 'Contents', 'Info.plist'), plist('com.example.sample', 'Sample'))
    touch(path.join(helper, 'Contents', 'Info.plist'), plist('com.example.sample.helper', 'Sample Helper'))

    for (const target of [
      path.join(app, 'Contents', 'MacOS', 'Sample'),
      path.join(helper, 'Contents', 'MacOS', 'Sample Helper'),
      path.join(app, 'Contents', 'Resources', 'native', 'addon.node')
    ]) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync('/usr/bin/true', target)
    }

    const steps = await signAppAdHoc(app, { entitlements: ENTITLEMENTS, inheritEntitlements: INHERIT })

    assert.equal(steps, 3)

    const requirement = execFileSync('/usr/bin/codesign', ['-dr', '-', app], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })

    assert.match(requirement, /designated => identifier "com\.example\.sample"/)
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
  })

  test('refuses to sign without the entitlements the hardened runtime needs', async () => {
    await assert.rejects(
      signAppAdHoc(path.join(dir, 'None.app'), {
        entitlements: path.join(dir, 'missing.plist'),
        inheritEntitlements: INHERIT
      }),
      /missing entitlements/
    )
  })
})
