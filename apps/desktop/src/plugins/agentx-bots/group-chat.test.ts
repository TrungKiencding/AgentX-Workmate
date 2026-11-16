import { describe, expect, it } from 'vitest'

import {
  buildTurnPrompt,
  cleanReply,
  decorateMentions,
  handoffTargets,
  insertMention,
  isPassText,
  mentionOptions,
  mentionQuery,
  mentionSegments,
  parseMentions,
  pickReply,
  plainMentions,
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

  it('room notices never count as mentions', () => {
    const log = [user('Chào'), { from: { kind: 'notice' as const, name: 'room' }, text: '@thu-ky lỗi', at: 2 }]

    expect(resolveResponders(log, members)).toHaveLength(3)
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
  it('names the room, who is here, only the new lines, and asks for work now — not promises', () => {
    const prompt = buildTurnPrompt('Marketing', members, members[0], [
      user('Lên kế hoạch'),
      member('nghien-cuu', 'Đã xong'),
      { from: { kind: 'notice', name: 'room' }, text: 'Thư ký chưa trả lời được', at: 3 }
    ])

    expect(prompt).toContain('[Group chat "Marketing"] You are Nghiên cứu (@nghien-cuu)')
    expect(prompt).toContain('Biên tập nội dung (@bien-tap), @thu-ky, and the user')
    expect(prompt).toContain('User: Lên kế hoạch')
    expect(prompt).toContain('Nghiên cứu (@nghien-cuu) (you): Đã xong')
    expect(prompt).not.toContain('chưa trả lời được') // room notices are not conversation
    expect(prompt).toContain('Do the work NOW')
    expect(prompt).toContain('"(pass)"')
  })

  it('tells the member which shared files reached it, and how to open them', () => {
    const prompt = buildTurnPrompt('Marketing', members, members[0], [user('Xem giúp')], {
      files: [{ name: 'khach.txt', ref: '@file:uploads/khach.txt' }],
      images: ['hoadon.png'],
      missing: ['to.pdf']
    })

    expect(prompt).toContain('picture "hoadon.png" — attached to this message')
    expect(prompt).toContain('"khach.txt" → @file:uploads/khach.txt')
    expect(prompt).toContain('"to.pdf" — could not be delivered')
  })
})

describe('cleanReply', () => {
  const writer = members[1]

  it('drops echoed name prefixes, reasoning blocks and a trailing (pass)', () => {
    expect(cleanReply('@bien-tap (you): Bản nháp đây', writer)).toBe('Bản nháp đây')
    expect(cleanReply('**Biên tập nội dung**: Bản nháp đây', writer)).toBe('Bản nháp đây')
    expect(cleanReply('<think>hmm</think>\nBản nháp đây', writer)).toBe('Bản nháp đây')
    expect(cleanReply('Bản nháp đây\n\n(pass)', writer)).toBe('Bản nháp đây')
  })

  it('keeps a prefix that is someone else, and a colon inside a sentence', () => {
    expect(cleanReply('Nghiên cứu: số liệu ổn', writer)).toBe('Nghiên cứu: số liệu ổn')
    expect(cleanReply('Lưu ý: hạn là thứ Sáu', writer)).toBe('Lưu ý: hạn là thứ Sáu')
  })

  it('treats silence, "(pass) …" and "(empty)" as a pass', () => {
    expect(cleanReply('(pass)', writer)).toBeNull()
    expect(cleanReply('(pass) — không có gì thêm', writer)).toBeNull()
    expect(cleanReply('(empty)', writer)).toBeNull()
    expect(cleanReply('  ', writer)).toBeNull()
  })
})

describe('pickReply', () => {
  it('a trailing pass never hides an earlier real answer; tool rows are skipped', () => {
    expect(
      pickReply(
        [
          { role: 'assistant', content: 'Kết quả: 3 người' },
          { role: 'tool', content: '{"ok":true}' },
          { role: 'assistant', content: '(pass)' }
        ],
        members[2]
      )
    ).toBe('Kết quả: 3 người')
    expect(pickReply([{ role: 'assistant', content: [{ type: 'text', text: 'Xong' }] }], members[2])).toBe('Xong')
    expect(pickReply([{ role: 'assistant', content: '(pass)' }], members[2])).toBeNull()
  })
})

describe('handoffTargets', () => {
  it('a later round belongs only to who a teammate named — never the author', () => {
    const posted = [member('nghien-cuu', 'Số liệu đây, @bien-tap viết bài nhé. @nghien-cuu sẽ kiểm tra lại')]

    expect(handoffTargets(posted, members).map(row => row.name)).toEqual(['bien-tap'])
    expect(handoffTargets([member('thu-ky', 'Sẵn sàng hỗ trợ!')], members)).toEqual([])
    expect(handoffTargets([user('@thu-ky ghi lại')], members)).toEqual([])
  })
})

describe('mentions for display', () => {
  const labels = { everyone: 'Mọi người', members, user: 'bạn' }

  it('turns known handles into bold names, leaves code and strangers alone', () => {
    expect(decorateMentions('@bien-tap xem nhé, @user quyết giúp', labels)).toBe(
      '**@Biên tập nội dung** xem nhé, **@bạn** quyết giúp'
    )
    expect(decorateMentions('chạy `@bien-tap` và @ghost', labels)).toBe('chạy `@bien-tap` và @ghost')
    expect(decorateMentions('```\n@bien-tap\n```', labels)).toBe('```\n@bien-tap\n```')
    expect(decorateMentions('mail@bien-tap.vn', labels)).toBe('mail@bien-tap.vn')
  })

  it('splits plain text into words and mentions', () => {
    expect(mentionSegments('@thu-ky ghi lại, @everyone', labels)).toEqual([
      { mention: true, text: '@thu-ky' },
      { mention: false, text: ' ghi lại, ' },
      { mention: true, text: '@Mọi người' }
    ])
    expect(plainMentions('Hỏi @nghien-cuu nhé', labels)).toBe('Hỏi @Nghiên cứu nhé')
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
