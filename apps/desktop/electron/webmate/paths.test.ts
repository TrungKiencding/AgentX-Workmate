import assert from 'node:assert/strict'
import path from 'node:path'

import { describe, test } from 'vitest'

import {
  WEBMATE_EXTENSION_ID,
  WEBMATE_INSTALL_DIR_NAME,
  stripHomeScopingSegments,
  webmateBridgeUrl,
  webmatePaths
} from './paths'

describe('webmatePaths', () => {
  test('anchors at the install root above account and profile layers (POSIX)', () => {
    const p = path.posix

    for (const home of [
      '/Users/k/.agentx',
      '/Users/k/.agentx/accounts/kien',
      '/Users/k/.agentx/profiles/work',
      '/Users/k/.agentx/accounts/kien/profiles/work'
    ]) {
      assert.equal(stripHomeScopingSegments(home, p), '/Users/k/.agentx', home)
      assert.equal(webmatePaths(home, p).root, '/Users/k/.agentx/webmate', home)
    }
  })

  test('lays the folder out as the plan describes (POSIX)', () => {
    const paths = webmatePaths('/Users/k/.agentx', path.posix)

    assert.deepEqual(paths, {
      root: '/Users/k/.agentx/webmate',
      installDir: '/Users/k/.agentx/webmate/AgentX WebMate',
      workmateJson: '/Users/k/.agentx/webmate/AgentX WebMate/workmate.json',
      pairingFile: '/Users/k/.agentx/webmate/pairing.json',
      stateFile: '/Users/k/.agentx/webmate/state.json',
      commandsDir: '/Users/k/.agentx/webmate/commands',
      versionsDir: '/Users/k/.agentx/webmate/versions',
      prevDir: '/Users/k/.agentx/webmate/versions/prev',
      updateCheckFile: '/Users/k/.agentx/webmate/update-check.json',
      profileDir: '/Users/k/.agentx/webmate/profile'
    })
  })

  test('uses backslashes and the LOCALAPPDATA root on Windows', () => {
    const p = path.win32
    const paths = webmatePaths('C:\\Users\\k\\AppData\\Local\\agentx\\accounts\\kien', p)

    assert.equal(paths.root, 'C:\\Users\\k\\AppData\\Local\\agentx\\webmate')
    assert.equal(paths.installDir, 'C:\\Users\\k\\AppData\\Local\\agentx\\webmate\\AgentX WebMate')
    assert.equal(paths.workmateJson, 'C:\\Users\\k\\AppData\\Local\\agentx\\webmate\\AgentX WebMate\\workmate.json')
    assert.equal(paths.prevDir, 'C:\\Users\\k\\AppData\\Local\\agentx\\webmate\\versions\\prev')
  })

  test('a Docker-style root without the layers is used as-is', () => {
    assert.equal(webmatePaths('/opt/data', path.posix).root, '/opt/data/webmate')
  })

  test('constants match the WebMate brand contract', () => {
    assert.match(WEBMATE_EXTENSION_ID, /^[a-p]{32}$/)
    assert.equal(WEBMATE_EXTENSION_ID, 'pfadeibckkgklmmjghiikadphihbpape')
    assert.equal(WEBMATE_INSTALL_DIR_NAME, 'AgentX WebMate')
    assert.equal(webmateBridgeUrl(), 'ws://127.0.0.1:17374/extension')
    assert.equal(webmateBridgeUrl(17398), 'ws://127.0.0.1:17398/extension')
  })
})
