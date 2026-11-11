import assert from 'node:assert/strict'

import { test } from 'vitest'

import { closeDecisionFor, mergeActiveWork, normalizeActiveWork, quitPromptFor } from './quit-guard'

test('normalizeActiveWork drops junk and keeps the count at least the title count', () => {
  assert.deepEqual(normalizeActiveWork(null), { count: 0, titles: [] })
  assert.deepEqual(normalizeActiveWork({ count: 'many', titles: 'nope' }), { count: 0, titles: [] })
  assert.deepEqual(normalizeActiveWork({ count: -3, titles: ['  Fix login  ', '', 7] }), {
    count: 1,
    titles: ['Fix login']
  })
})

test('normalizeActiveWork keeps untitled sessions in the count', () => {
  assert.deepEqual(normalizeActiveWork({ count: 3, titles: ['Fix login'] }), { count: 3, titles: ['Fix login'] })
})

test('mergeActiveWork de-dupes a session two windows both report', () => {
  const merged = mergeActiveWork([
    { count: 2, titles: ['Fix login', 'Ship docs'] },
    { count: 1, titles: ['Fix login'] }
  ])

  assert.deepEqual(merged, { count: 2, titles: ['Fix login', 'Ship docs'] })
})

test('quitPromptFor stays out of the way when nothing is running', () => {
  assert.equal(quitPromptFor({ count: 0, titles: [] }, false), null)
})

test('quitPromptFor stays out of the way during an update handoff', () => {
  assert.equal(quitPromptFor({ count: 2, titles: ['Fix login'] }, true), null)
})

test('quitPromptFor names the running chats', () => {
  const prompt = quitPromptFor({ count: 2, titles: ['Fix login', 'Ship docs'] }, false)

  assert.ok(prompt)
  assert.equal(prompt.message, 'AgentX is still working on 2 chats.')
  assert.ok(prompt.detail.includes('• Fix login'))
  assert.ok(prompt.detail.includes('• Ship docs'))
})

test('quitPromptFor summarizes past the list cap and counts untitled work', () => {
  const prompt = quitPromptFor({ count: 9, titles: ['a', 'b', 'c', 'd', 'e', 'f'] }, false)

  assert.ok(prompt)
  assert.equal(prompt.message, 'AgentX is still working on 9 chats.')
  assert.ok(prompt.detail.includes('• d'))
  assert.ok(!prompt.detail.includes('• e'))
  assert.ok(prompt.detail.includes('• 5 more'))
})

test('quitPromptFor speaks singular for one chat', () => {
  const prompt = quitPromptFor({ count: 1, titles: [] }, false)

  assert.ok(prompt)
  assert.equal(prompt.message, 'AgentX is still working on 1 chat.')
  assert.ok(prompt.detail.includes('mid-turn'))
})

// ── the confirmation in the app's language ─────────────────────────────────

const VI = {
  detail: 'Thoát bây giờ sẽ dừng công việc giữa chừng. Phần chưa ghi xong sẽ mất.',
  messageMany: 'Workmate đang làm dở {count} cuộc trò chuyện.',
  messageOne: 'Workmate đang làm dở 1 cuộc trò chuyện.',
  more: 'và {count} cuộc trò chuyện khác',
  quit: 'Vẫn thoát',
  stay: 'Tiếp tục chạy'
}

test('quitPromptFor uses the words the renderer sent', () => {
  const prompt = quitPromptFor({ copy: VI, count: 6, titles: ['a', 'b', 'c', 'd', 'e'] }, false)

  assert.ok(prompt)
  assert.equal(prompt.message, 'Workmate đang làm dở 6 cuộc trò chuyện.')
  assert.deepEqual(prompt.buttons, ['Tiếp tục chạy', 'Vẫn thoát'])
  assert.ok(prompt.detail.includes('• và 2 cuộc trò chuyện khác'))
  assert.ok(prompt.detail.endsWith(VI.detail))
})

test('quitPromptFor falls back to English buttons with no words from the renderer', () => {
  const prompt = quitPromptFor({ count: 1, titles: ['Fix login'] }, false)

  assert.ok(prompt)
  assert.deepEqual(prompt.buttons, ['Keep Running', 'Quit Anyway'])
})

test('quitPromptFor lists nothing rather than a dangling "1 more" for untitled work', () => {
  const prompt = quitPromptFor({ count: 1, titles: [] }, false)

  assert.ok(prompt)
  assert.ok(!prompt.detail.includes('•'))
})

test('normalizeActiveWork keeps complete copy and rejects half of one', () => {
  assert.deepEqual(normalizeActiveWork({ copy: VI, count: 1, titles: [] }).copy, VI)
  assert.equal(normalizeActiveWork({ copy: { ...VI, quit: '' }, count: 1, titles: [] }).copy, undefined)
  assert.equal(normalizeActiveWork({ copy: { stay: 'x' }, count: 1, titles: [] }).copy, undefined)
  assert.equal(normalizeActiveWork({ copy: { ...VI, detail: 'x'.repeat(301) }, count: 1, titles: [] }).copy, undefined)
  assert.equal(normalizeActiveWork({ copy: 'Vẫn thoát', count: 1, titles: [] }).copy, undefined)
})

test('mergeActiveWork takes the words from a window that is running something', () => {
  const EN = { ...VI, stay: 'Keep Running' }

  assert.equal(
    mergeActiveWork([
      { copy: EN, count: 0, titles: [] },
      { copy: VI, count: 1, titles: ['a'] }
    ]).copy,
    VI
  )
  assert.equal(mergeActiveWork([{ count: 1, titles: ['a'] }]).copy, undefined)
})

// ── closing a window on running work ───────────────────────────────────────
//
// Pilot 2026-11: "nothing warns you when you close Workmate in the middle of a
// task". The confirmation only ran in before-quit; the close button on Windows
// destroys the window (and its report of running work) before any quit.

const BUSY = { count: 1, titles: ['Fix login'] }
const IDLE = { count: 0, titles: [] }

test('closing the last window on Windows or Linux asks first', () => {
  for (const platform of ['win32', 'linux'] as const) {
    assert.equal(closeDecisionFor({ lastChatWindow: true, platform, quitting: false, work: BUSY }), 'confirm')
  }
})

test('closing a window while another chat window stays open just closes it', () => {
  assert.equal(closeDecisionFor({ lastChatWindow: false, platform: 'win32', quitting: false, work: BUSY }), 'close')
})

test('macOS keeps the window hidden so the turn and the quit guard both survive', () => {
  assert.equal(closeDecisionFor({ lastChatWindow: true, platform: 'darwin', quitting: false, work: BUSY }), 'hide')
  assert.equal(closeDecisionFor({ lastChatWindow: false, platform: 'darwin', quitting: false, work: BUSY }), 'hide')
})

test('nothing is held when no turn is running', () => {
  for (const platform of ['win32', 'linux', 'darwin'] as const) {
    assert.equal(closeDecisionFor({ lastChatWindow: true, platform, quitting: false, work: IDLE }), 'close')
  }
})

test('nothing is held once the app is quitting or handing off to an updater', () => {
  for (const platform of ['win32', 'linux', 'darwin'] as const) {
    assert.equal(closeDecisionFor({ lastChatWindow: true, platform, quitting: true, work: BUSY }), 'close')
  }
})
