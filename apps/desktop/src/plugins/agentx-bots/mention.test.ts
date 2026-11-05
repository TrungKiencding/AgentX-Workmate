import { HANDOFF_NOTE_MARKER } from '@agentx/plugin-sdk'
import { describe, expect, it } from 'vitest'

import { isResetCommand, mentionedProfiles, shellDoubleQuote, shellQuote, withHandoff } from './mention'

const names = ['default', 'writer', 'nghien-cuu']

describe('mentionedProfiles', () => {
  it('finds known handles in prose, once, excluding the active profile', () => {
    expect(mentionedProfiles('@writer và @nghien-cuu, @writer nữa', names, 'default')).toEqual(['writer', 'nghien-cuu'])
    expect(mentionedProfiles('@writer tự nói chuyện', names, 'writer')).toEqual([])
  })

  it('maps @agentx to the default profile', () => {
    expect(mentionedProfiles('hỏi @agentx giúp', names, 'writer')).toEqual(['default'])
  })

  it('ignores code, emails and strangers', () => {
    expect(mentionedProfiles('`@writer` ```\n@writer\n``` me@writer.com @ghost', names, 'default')).toEqual([])
  })
})

describe('withHandoff', () => {
  it('appends one delivery command per teammate, after the marker', () => {
    const text = withHandoff('@writer viết caption', names, 'default', 'AgentX')!

    expect(text.startsWith(`@writer viết caption${HANDOFF_NOTE_MARKER}`)).toBe(true)
    expect(text).toContain(`agentx -p 'writer' chat --in ~ -c "Bot Chat" -Q -q "Message from 🤖 AgentX (@agentx)`)
  })

  it('keeps sender names shell-literal', () => {
    const text = withHandoff('@writer hi', names, 'nghien-cuu', 'Bob "$(rm -rf ~)"')!

    expect(text).toContain('Message from 🤖 Bob \\"\\$(rm -rf ~)\\" (@nghien-cuu)')
  })

  it('returns null when nothing is handed off', () => {
    expect(withHandoff('no mentions here', names, 'default', 'AgentX')).toBeNull()
    expect(withHandoff('@ghost hello', names, 'default', 'AgentX')).toBeNull()
  })
})

describe('shell quoting', () => {
  it('single-quotes safely', () => {
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`)
  })

  it('escapes double-quote metacharacters', () => {
    expect(shellDoubleQuote('a"b`c$d\\e')).toBe('a\\"b\\`c\\$d\\\\e')
  })
})

describe('isResetCommand', () => {
  it('matches /new and /reset only', () => {
    expect(isResetCommand('/new')).toBe(true)
    expect(isResetCommand('  /reset  ')).toBe(true)
    expect(isResetCommand('/new topic')).toBe(false)
    expect(isResetCommand('/compact')).toBe(false)
  })
})
