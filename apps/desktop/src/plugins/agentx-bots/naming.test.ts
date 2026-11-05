import { describe, expect, it } from 'vitest'

import {
  botHandle,
  cleanPreview,
  displayName,
  filterBots,
  groupRoster,
  isActiveNow,
  knownGroups,
  NAME_RE,
  previewSender,
  profileForHandle,
  sessionLabel,
  showsHandle,
  slugify,
  sortRoster,
  uniqueName
} from './naming'
import { bot } from './test-utils'

describe('slugify', () => {
  it('strips Vietnamese diacritics instead of dropping the letters', () => {
    expect(slugify('Trợ lý Kế toán')).toBe('tro-ly-ke-toan')
    expect(slugify('Đặng – Biên tập')).toBe('dang-bien-tap')
  })

  it('yields valid profile ids', () => {
    for (const input of ['  Hello, World!  ', '__x__', 'Ảnh & Video 2026', 'a'.repeat(90)]) {
      const slug = slugify(input)

      expect(slug === '' || NAME_RE.test(slug)).toBe(true)
      expect(slug.length).toBeLessThanOrEqual(64)
    }
  })

  it('is empty for text with no latin letters or digits', () => {
    expect(slugify('日本語')).toBe('')
  })
})

describe('uniqueName', () => {
  it('suffixes the first free slot, truncating the base not the suffix', () => {
    expect(uniqueName('Writer', [])).toBe('writer')
    expect(uniqueName('writer', ['writer', 'writer-2'])).toBe('writer-3')

    const long = 'x'.repeat(64)
    const second = uniqueName(long, [long])

    expect(second).toBe(`${'x'.repeat(62)}-2`)
  })

  it('falls back to a readable id for names that slugify to nothing', () => {
    expect(uniqueName('日本語', [])).toBe('tro-ly')
  })
})

describe('identity', () => {
  it('names the primary AgentX and never shows "default"', () => {
    expect(displayName(bot('default'))).toBe('AgentX')
    expect(botHandle('default')).toBe('agentx')
    expect(displayName(bot('default'), { title: 'Sếp' })).toBe('Sếp')
  })

  it('prettifies profile names and prefers the title', () => {
    expect(displayName(bot('inbox-triage'))).toBe('Inbox Triage')
    expect(displayName(bot('writer'), { title: '  Minh – Kế toán ' })).toBe('Minh – Kế toán')
  })

  it('shows the handle only when it adds information', () => {
    expect(showsHandle(bot('writer'), null)).toBe(false)
    expect(showsHandle(bot('writer'), { title: 'Biên tập' })).toBe(true)
  })

  it('resolves @agentx to the default profile unless a real agentx exists', () => {
    expect(profileForHandle('@agentx', ['default', 'writer'])).toBe('default')
    expect(profileForHandle('agentx', ['default', 'agentx'])).toBe('agentx')
    expect(profileForHandle('@ghost', ['default'])).toBeNull()
  })
})

describe('roster order and filters', () => {
  const roster = [
    bot('a', { last_session: { id: '1', last_active: 100 } }),
    bot('b', { last_session: { id: '2', last_active: 300 } }),
    bot('c', { last_session: { id: '3', last_active: 200 } })
  ]

  it('sorts pinned first, then by recency', () => {
    expect(sortRoster(roster, {}).map(row => row.name)).toEqual(['b', 'c', 'a'])
    expect(sortRoster(roster, { a: { pinned: true } }).map(row => row.name)).toEqual(['a', 'b', 'c'])
  })

  it('a freshly created bot tops the list', () => {
    expect(sortRoster(roster, { a: { created: 999_000 } })[0].name).toBe('a')
  })

  it('filters by title, handle or description, ignoring diacritics', () => {
    const meta = { a: { title: 'Kế toán' } }
    const rows = [bot('a'), bot('b', { description: 'Viết nội dung' })]

    expect(filterBots(rows, meta, 'ke toan').map(row => row.name)).toEqual(['a'])
    expect(filterBots(rows, meta, '@b').map(row => row.name)).toEqual(['b'])
    expect(filterBots(rows, meta, 'noi dung').map(row => row.name)).toEqual(['b'])
    expect(filterBots(rows, meta, '  ')).toHaveLength(2)
  })

  it('groups: ungrouped first, then groups alphabetically', () => {
    const meta = { a: { group: 'Zeta' }, c: { group: 'alpha' } }
    const sections = groupRoster(roster, meta)

    expect(sections.map(section => [section.group, section.bots.map(row => row.name)])).toEqual([
      [null, ['b']],
      ['alpha', ['c']],
      ['Zeta', ['a']]
    ])
    expect(knownGroups(meta)).toEqual(['alpha', 'Zeta'])
  })
})

describe('previews', () => {
  it('reads the sender handle from the current delivery prefix', () => {
    expect(previewSender('Message from 🤖 Nghiên cứu (@nghien-cuu): đây là kết quả')).toBe('nghien-cuu')
  })

  it('still reads the older prefixes', () => {
    expect(previewSender('Message from 🤖 writer (@writer): hi')).toBe('writer')
    expect(previewSender("Message from agent 'Writer': hi")).toBe('writer')
    expect(previewSender('just a normal message')).toBeNull()
  })

  it('strips the delivery prefix for display', () => {
    expect(cleanPreview('Message from 🤖 Nghiên cứu (@nghien-cuu): Xong rồi')).toBe('Xong rồi')
  })

  it('labels generic sessions by their latest message', () => {
    expect(sessionLabel({ title: 'Kế hoạch quý', preview: 'x' }, 'Untitled')).toBe('Kế hoạch quý')
    expect(sessionLabel({ title: 'Bot Chat', preview: 'Lên dàn ý bài viết về AI cho tuần sau' }, 'Untitled')).toBe(
      'Lên dàn ý bài viết về'
    )
    expect(sessionLabel({ title: '', preview: '' }, 'Untitled')).toBe('Untitled')
  })
})

describe('isActiveNow', () => {
  it('is true for the busy profile or a very recent message', () => {
    const now = 1_000_000_000

    expect(isActiveNow(bot('a'), 'a', now)).toBe(true)
    expect(isActiveNow(bot('a', { last_session: { id: 'x', last_active: now / 1000 - 30 } }), null, now)).toBe(true)
    expect(isActiveNow(bot('a', { last_session: { id: 'x', last_active: now / 1000 - 600 } }), null, now)).toBe(false)
  })
})
