import { afterEach, describe, expect, it } from 'vitest'

import { setRuntimeI18nLocale, TRANSLATIONS } from '@/i18n'

import { isCardTool, splitRunItems, technicalTrace } from './fallback'

describe('isCardTool', () => {
  it('keeps what the user has to look at out of a summary', () => {
    // A diff is the deliverable, a clarify is a question waiting on an answer,
    // an image is the thing that was asked for, a delivered file is the card
    // the user opens. None of them survives being folded into "used 3 tools".
    for (const toolName of ['clarify', 'image_generate', 'deliver_file', 'edit_file', 'patch', 'write_file']) {
      expect(isCardTool(toolName)).toBe(true)
    }
  })

  it('treats reads, searches and commands as ephemeral activity', () => {
    for (const toolName of ['read_file', 'search_files', 'terminal', 'execute_code', 'web_search']) {
      expect(isCardTool(toolName)).toBe(false)
    }
  })
})

describe('splitRunItems', () => {
  it('collapses a stretch of activity into one run', () => {
    expect(splitRunItems(['read_file', 'search_files', 'terminal'])).toEqual([{ end: 2, kind: 'run', start: 0 }])
  })

  it('keeps a card at the point in the turn where it happened', () => {
    // Read, edit, read has to stay in that order — a summary, the diff, then a
    // second summary — rather than sorting the diffs to one end.
    expect(splitRunItems(['read_file', 'patch', 'read_file', 'terminal'])).toEqual([
      { end: 0, kind: 'run', start: 0 },
      { index: 1, kind: 'card' },
      { end: 3, kind: 'run', start: 2 }
    ])
  })

  it('does not let adjacent cards merge into a run', () => {
    expect(splitRunItems(['patch', 'write_file'])).toEqual([
      { index: 0, kind: 'card' },
      { index: 1, kind: 'card' }
    ])
  })

  it('passes a part that is not a tool call through as its own card', () => {
    expect(splitRunItems(['read_file', '', 'read_file'])).toEqual([
      { end: 0, kind: 'run', start: 0 },
      { index: 1, kind: 'card' },
      { end: 2, kind: 'run', start: 2 }
    ])
  })

  it('has nothing to split when the range is empty', () => {
    expect(splitRunItems([])).toEqual([])
  })
})

describe('technicalTrace', () => {
  it('indents object payloads and persisted JSON strings', () => {
    expect(technicalTrace({ offset: 2, path: '/tmp/demo.txt' }, '{"success":true,"lines":["a","b"]}')).toBe(
      'Arguments:\n{\n  "offset": 2,\n  "path": "/tmp/demo.txt"\n}\n\nResult:\n{\n  "success": true,\n  "lines": [\n    "a",\n    "b"\n  ]\n}'
    )
  })

  it('leaves scalar strings untouched', () => {
    expect(technicalTrace(undefined, 'plain text')).toBe('Result:\nplain text')
    expect(technicalTrace(undefined, '"already quoted"')).toBe('Result:\n"already quoted"')
  })

  describe('in the display language', () => {
    afterEach(() => {
      setRuntimeI18nLocale('en')
    })

    it.each([
      ['vi', 'Tham số', 'Kết quả'],
      ['ja', '引数', '結果'],
      ['zh', '参数', '结果'],
      ['zh-hant', '引數', '結果'],
      ['ar', 'الوسائط', 'النتيجة']
    ] as const)('labels the payload in %s', (locale, argumentsLabel, resultLabel) => {
      setRuntimeI18nLocale(locale)

      expect(technicalTrace({ path: '/tmp/demo.txt' }, 'plain text')).toBe(
        `${argumentsLabel}:\n{\n  "path": "/tmp/demo.txt"\n}\n\n${resultLabel}:\nplain text`
      )
    })

    // ja, zh-hant and ar fall back to English key by key; the disclosure's own
    // toggle only renders in technical mode, so check its words here too.
    it('has its own words for the payload disclosure in every locale', () => {
      const english = TRANSLATIONS.en.assistant.tool.payload

      for (const locale of ['vi', 'ja', 'zh', 'zh-hant', 'ar'] as const) {
        const copy = TRANSLATIONS[locale].assistant.tool.payload

        for (const key of Object.keys(english) as (keyof typeof english)[]) {
          expect(copy[key], `${locale} ${key}`).not.toBe(english[key])
        }
      }
    })
  })
})
