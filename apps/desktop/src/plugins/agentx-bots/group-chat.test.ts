import { describe, expect, it } from 'vitest'

import {
  buildTurnPrompt,
  insertMention,
  isPassText,
  mentionOptions,
  mentionQuery,
  parseMentions,
  resolveResponders,
  rotateSpeakers,
  trimRoom
} from './group-chat'
import { emptyRoom } from './state'
import type { GroupEntry, GroupMember } from './types'

const members: GroupMember[] = [
  { name: 'nghien-cuu', title: 'Nghiên cứu' },
  { name: 'bien-tap', title: 'Biên tập nội dung' },
  { name: 'thu-ky', title: '' }
]

const user = (text: string): GroupEntry => ({ from: { kind: 'user', name: 'user' }, text, at: 1 })
const member = (name: string, text: string): GroupEntry => ({ from: { kind: 'member', name }, text, at: 2 })

describe('isPassText', () => {
  it.each(['', '  ', '(pass)', 'pass', 'Pass.', '( pass )'])('%j is silence', text => {
    expect(isPassText(text)).toBe(true)
  })

  it('a real reply is not a pass', () => {
    expect(isPassText('Mình sẽ lo phần này')).toBe(false)
  })
})

describe('parseMentions', () => {
  it('resolves handles, titles (diacritics-insensitive) and first words', () => {
    expect([...parseMentions('@nghien-cuu xem giúp', members).mentioned]).toEqual(['nghien-cuu'])
    expect([...parseMentions('@Biên-tập-nội-dung sửa câu này', members).mentioned]).toEqual(['bien-tap'])
    expect([...parseMentions('@nghiên ơi', members).mentioned]).toEqual(['nghien-cuu'])
  })

  it('resolves the main assistant by its public handle', () => {
    expect([...parseMentions('@agentx tóm tắt', [{ name: 'default', title: '' }]).mentioned]).toEqual(['default'])
  })

  it('knows @everyone / @mọingười and ignores @user and strangers', () => {
    expect(parseMentions('@everyone', members).everyone).toBe(true)
    expect(parseMentions('@mọingười', members).everyone).toBe(true)
    expect(parseMentions('@user @ghost', members).mentioned.size).toBe(0)
  })
})

describe('resolveResponders', () => {
  it('everyone answers when nobody is mentioned since the last user message', () => {
    expect(resolveResponders([user('Chào cả nhóm')], members)).toHaveLength(3)
  })

  it('only the mentioned answer, including those a member pulls in', () => {
    const log = [user('@thu-ky ghi lại giúp'), member('thu-ky', 'Ok, @nghien-cuu kiểm tra số liệu nhé')]

    expect(resolveResponders(log, members).map(row => row.name)).toEqual(['nghien-cuu', 'thu-ky'])
  })
})

describe('rotateSpeakers', () => {
  it('a different member leads each round', () => {
    expect(rotateSpeakers(['a', 'b', 'c'], 1)).toEqual(['b', 'c', 'a'])
    expect(rotateSpeakers(['a'], 5)).toEqual(['a'])
  })
})

describe('trimRoom', () => {
  it('keeps the window and shifts watermarks with it', () => {
    const room = {
      ...emptyRoom(),
      log: Array.from({ length: 10 }, (_, i) => user(String(i))),
      watermarks: { a: 8, b: 2 }
    }

    const trimmed = trimRoom(room, 6)

    expect(trimmed.log.map(entry => entry.text)).toEqual(['4', '5', '6', '7', '8', '9'])
    expect(trimmed.watermarks).toEqual({ a: 4, b: 0 })
  })
})

describe('buildTurnPrompt', () => {
  it('names the room, the peers and only the new lines', () => {
    const prompt = buildTurnPrompt('Marketing', members, members[0], [
      user('Lên kế hoạch'),
      member('nghien-cuu', 'Đã xong')
    ])

    expect(prompt).toContain('[Group chat: "Marketing"] You are @nghien-cuu')
    expect(prompt).toContain('Biên tập nội dung (@bien-tap), @thu-ky')
    expect(prompt).toContain('User: Lên kế hoạch')
    expect(prompt).toContain('@nghien-cuu (you): Đã xong')
    expect(prompt).toContain('"(pass)"')
  })
})

describe('mention autocomplete', () => {
  it('only a fresh @word at the caret is a mention', () => {
    expect(mentionQuery('Hi @ngh', 7)).toEqual({ query: 'ngh', start: 3 })
    expect(mentionQuery('@', 1)).toEqual({ query: '', start: 0 })
    expect(mentionQuery('mail@host', 9)).toBeNull()
    expect(mentionQuery('@ngh done', 9)).toBeNull()
  })

  it('matches handles and title words without diacritics, then offers everyone', () => {
    expect(mentionOptions(members, 'bien').map(option => option.handle)).toEqual(['bien-tap'])
    expect(mentionOptions(members, 'noi').map(option => option.handle)).toEqual(['bien-tap'])
    expect(mentionOptions(members, '').map(option => option.handle)).toEqual([
      'nghien-cuu',
      'bien-tap',
      'thu-ky',
      'everyone'
    ])
    expect(mentionOptions(members, 'moi').map(option => option.handle)).toEqual(['everyone'])
    expect(mentionOptions(members, 'zzz')).toEqual([])
  })

  it('replaces the typed word and lands the caret after the inserted handle', () => {
    expect(insertMention('Hi @ngh', 3, 7, 'nghien-cuu')).toEqual({ caret: 15, text: 'Hi @nghien-cuu ' })
    expect(insertMention('@ng xem nhé', 0, 3, 'nghien-cuu')).toEqual({ caret: 12, text: '@nghien-cuu xem nhé' })
  })
})
