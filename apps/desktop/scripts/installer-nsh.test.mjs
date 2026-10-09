/**
 * The NSIS uninstaller customisation is a text file compiled by makensis on a
 * Windows-only toolchain, so what can be checked here is its wiring and the
 * decisions inside it that are dangerous to get wrong:
 *
 *   - it must run on a real uninstall, so Programs and Features actually
 *     removes the agent and the `agentx` command instead of leaving them;
 *   - it must NOT run during an update, or every app update would delete the
 *     user's settings, sessions, and saved model key;
 *   - on a real uninstall it keeps that data unless the person ticks the box.
 *
 * A compile error is caught by `npm run dist:win:nsis`; this catches the
 * silent failures — an unwired include, or a guard someone removed.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, test } from 'vitest'

const DESKTOP_ROOT = path.resolve(import.meta.dirname, '..')
const NSH_PATH = path.join(DESKTOP_ROOT, 'build', 'installer.nsh')
const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP_ROOT, 'package.json'), 'utf8'))

describe('the NSIS uninstaller customisation', () => {
  test('package.json points at it and the file is there', () => {
    assert.equal(pkg.build.nsis.include, 'build/installer.nsh')
    assert.ok(fs.existsSync(NSH_PATH), 'build/installer.nsh is referenced but missing')
  })

  const nsh = fs.readFileSync(NSH_PATH, 'utf8')
  // NSIS comments start with `;`. The header of this file explains the purge
  // in prose, so position checks have to run against code only — otherwise
  // "the purge is inside the guard" is satisfied by a sentence about it.
  const code = nsh
    .split('\n')
    .filter(line => !line.trimStart().startsWith(';'))
    .join('\n')

  test('it hooks the uninstall, not just the install', () => {
    assert.match(nsh, /!macro\s+customUnInstall\b/)
    assert.match(nsh, /!macroend/)
  })

  test('it asks with a checkbox rather than silently deciding', () => {
    // The user is given the choice on the page they are already reading.
    assert.match(nsh, /!macro\s+customUnWelcomePage\b/)
    assert.match(nsh, /\$\{NSD_CreateCheckbox\}/)
  })

  test('keeping the data is the default; deleting it has to be asked for', () => {
    // People uninstall to reinstall — that is how "get the new version" is
    // done on Windows — and a box ticked for them wiped every conversation on
    // the way. Unticked, and a silent uninstall that never shows the page,
    // must both keep the data.
    assert.doesNotMatch(code, /\$\{NSD_Check\}/)

    const asked = code.indexOf('${If} $AgentXPurgeState == ${BST_CHECKED}')
    const full = code.indexOf('StrCpy $4 "full"')
    const otherwise = code.indexOf('${Else}', asked)
    const lite = code.indexOf('StrCpy $4 "lite"')

    assert.ok(asked >= 0, 'the purge must depend on the checkbox')
    assert.ok(asked < full && full < otherwise, 'only a ticked box may ask for --mode full')
    assert.ok(otherwise < lite, 'everything else keeps the data (--mode lite)')
  })

  test('an update never purges the agent or the data', () => {
    // electron-builder uninstalls the old version as part of installing a new
    // one. Purging there would delete the settings and model key of an install
    // that is not going away — the worst possible outcome of this whole change.
    assert.match(code, /\$\{ifNot\}\s+\$\{isUpdated\}/)

    const guardAt = code.indexOf('${ifNot} ${isUpdated}')
    const purgeAt = code.indexOf('nsExec::ExecToLog')

    assert.ok(guardAt >= 0, 'no isUpdated guard in the uninstall macro')
    assert.ok(purgeAt > guardAt, 'the purge must sit INSIDE the isUpdated guard')
  })

  test('it drives the agent uninstaller rather than deleting paths itself', () => {
    // Duplicating the removal logic in NSIS would mean two implementations of
    // "what is an AgentX install", drifting apart. hermes_cli.uninstall is the
    // one that knows, and it is the one under test in Python. Both choices go
    // through it: the agent and the agentx command are removed either way.
    assert.match(code, /-m hermes_cli\.uninstall --mode \$4/)
  })

  test('it finds AGENTX_HOME the way the installer set it', () => {
    // scripts/install.ps1 sets AGENTX_HOME and defaults it to
    // %LOCALAPPDATA%\agentx. Reading only one of those strands anybody whose
    // install used the other.
    assert.match(nsh, /ReadEnvStr \$0 "AGENTX_HOME"/)
    assert.match(nsh, /ReadEnvStr \$1 "LOCALAPPDATA"/)
    assert.match(nsh, /\$1\\agentx/)
  })

  test('it removes the shortcuts install.ps1 wrote, which NSIS does not own', () => {
    assert.match(nsh, /Delete "\$DESKTOP\\AgentX\.lnk"/)
    assert.match(nsh, /Delete "\$SMPROGRAMS\\AgentX\.lnk"/)
  })

  test('it does not reference MUI macros that are undefined at include time', () => {
    // electron-builder inserts this file before MUI2 is included, so a
    // MUI_HEADER_TEXT here fails the NSIS compile outright — which is exactly
    // how the first version of this file broke the Windows build.
    assert.doesNotMatch(nsh, /!insertmacro\s+MUI_HEADER_TEXT/)
  })
})
