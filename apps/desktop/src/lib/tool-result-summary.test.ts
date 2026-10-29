import { afterEach, describe, expect, it } from 'vitest'

import { setRuntimeI18nLocale, TRANSLATIONS } from '@/i18n'
import { capitalize } from '@/lib/text'

import { extractToolErrorMessage, formatToolResultSummary } from './tool-result-summary'

describe('formatToolResultSummary', () => {
  // The browser tool's failure as the user saw it: uv's coloured download
  // chatter first, the error that explains the failure last.
  const failingStderr = [
    '\u001b[36m\u001b[1mDownloading\u001b[0m\u001b[39m anthropic \u001b[2m(2.0MiB)\u001b[0m',
    '\u001b[36m\u001b[1mDownloaded\u001b[0m\u001b[39m anthropic',
    '\u001b[2mInstalled \u001b[1m107 packages\u001b[0m \u001b[2min 386ms\u001b[0m',
    'Traceback (most recent call last):',
    ...Array.from({ length: 12 }, (_, i) => `  File "browser_harness/helpers.py", line ${60 + i}, in cdp`),
    "RuntimeError: {'code': -32000, 'message': 'Not supported'}"
  ].join('\n')

  const stderrLine = (summary: string) => summary.split('\n').find(line => line.startsWith('- Stderr:')) ?? ''

  it("shows the END of a failing command's stderr, where the error is", () => {
    const line = stderrLine(
      formatToolResultSummary({ exit_code: 1, output: '', stderr: failingStderr, success: false, workspace: '/ws' })
    )

    expect(line.startsWith('- Stderr: …')).toBe(true)
    expect(line.endsWith("RuntimeError: {'code': -32000, 'message': 'Not supported'}")).toBe(true)
    expect(line).not.toContain('Downloading')
    expect(line).not.toContain('\u001b')
    expect(line).not.toMatch(/\[\d+m/)
  })

  it('keeps a short stderr whole, without its colour codes', () => {
    const line = stderrLine(
      formatToolResultSummary({ exit_code: 2, stderr: '\u001b[31mboom\u001b[0m', success: false })
    )

    expect(line).toBe('- Stderr: boom')
  })

  it('strips colour codes from any text it summarizes', () => {
    expect(formatToolResultSummary({ message: '\u001b[1;31mfailed\u001b[0m to start' })).toBe('failed to start')
    expect(formatToolResultSummary({ path: '/tmp/a', status: '\u001b[32mok\u001b[0m' })).toContain('- Status: ok')
  })

  it('unwraps wrapper payloads into structured key-value lines', () => {
    const summary = formatToolResultSummary({
      success: true,
      result: {
        data: {
          path: '/tmp/demo.txt',
          status: 'ok',
          lines_written: 12,
          checksum: 'abc123'
        }
      }
    })

    expect(summary).toContain('- Path: /tmp/demo.txt')
    expect(summary).toContain('- Status: ok')
    expect(summary).toContain('- Lines Written: 12')
    expect(summary).not.toContain('"path"')
  })

  it('summarizes object arrays as readable list items', () => {
    const summary = formatToolResultSummary([
      { title: 'First result', snippet: 'alpha preview text' },
      { title: 'Second result', status: 'cached' },
      { title: 'Third result', summary: 'more details' },
      { title: 'Fourth result', summary: 'line 4' },
      { title: 'Fifth result', summary: 'line 5' },
      { title: 'Sixth result', summary: 'line 6' },
      { title: 'Seventh result', summary: 'line 7' }
    ])

    expect(summary).toContain('- First result - alpha preview text')
    expect(summary).toContain('- Second result (cached)')
    expect(summary).toContain('- … 1 more item')
  })

  it('truncates long field values for compact display', () => {
    const summary = formatToolResultSummary({
      message: 'ok',
      details: `prefix ${'x'.repeat(500)}`
    })

    const detailsLine = summary.split('\n').find(line => line.startsWith('- Details:'))

    expect(detailsLine).toBeTruthy()
    expect(detailsLine?.length).toBeLessThan(230)
    expect(detailsLine).toContain('…')
  })

  it('formats stringified json payloads without raw dumps', () => {
    const summary = formatToolResultSummary(
      JSON.stringify({
        data: {
          title: 'Build report',
          completed: true
        }
      })
    )

    expect(summary).toContain('- Title: Build report')
    expect(summary).toContain('- Completed: true')
  })
})

describe('formatToolResultSummary in the display language', () => {
  afterEach(() => {
    setRuntimeI18nLocale('en')
  })

  // A read_file that missed, as file_tools returns it, and the bare envelope
  // `tool_error(..., success=False)` returns.
  const readFileMiss = {
    content: '',
    total_lines: 0,
    file_size: 0,
    truncated: false,
    is_binary: false,
    is_image: false,
    error: 'File not found: /repo/notes.md',
    similar_files: ['/repo/docs/notes.md']
  }

  const toolError = { error: 'File not found: /repo/notes.md', success: false }

  // A known key and an unknown one, a boolean, a scalar list, a nested object
  // and a list of records.
  const mixed = {
    name: 'deploy',
    enabled: true,
    lines_written: 12,
    tags: ['prod', 'web'],
    nested: { a: { b: 1 } },
    list: ['One', 'Two', 'Three', 'Four', 'Five'].map(title => ({ title }))
  }

  const longList = [1, 2, 3, 4, 5, 6, 7, 8, 9]
  const wideRecord = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10 }
  const inline = [{ count: 3, ok: false }, { x: { y: { z: { w: 1 } } } }]
  const lastLine = (value: unknown) => formatToolResultSummary(value).split('\n').pop()

  it('keeps the English summary as it was', () => {
    expect(formatToolResultSummary(readFileMiss)).toBe(
      [
        '- Total Lines: 0',
        '- File Size: 0',
        '- Truncated: false',
        '- Is Binary: false',
        '- Is Image: false',
        '- Error: File not found: /repo/notes.md',
        '- Similar Files: /repo/docs/notes.md',
        '- … 1 more field'
      ].join('\n')
    )
    expect(formatToolResultSummary(toolError)).toBe('- Error: File not found: /repo/notes.md\n- Success: false')
    expect(formatToolResultSummary(mixed)).toBe(
      [
        '- Name: deploy',
        '- Enabled: true',
        '- Lines Written: 12',
        '- Tags: prod, web',
        '- Nested: 1 field',
        '- List: 5 items (1 field)'
      ].join('\n')
    )
    expect(lastLine(longList)).toBe('- … 3 more items')
    expect(lastLine(wideRecord)).toBe('- … 2 more fields')
    expect(formatToolResultSummary(inline)).toBe('- Count: 3 · Ok: false\n- 1 field')
    expect(formatToolResultSummary(true)).toBe('true')
  })

  it('reads a failed read_file in Vietnamese, the default language', () => {
    setRuntimeI18nLocale('vi')

    expect(formatToolResultSummary(toolError)).toBe('- Lỗi: File not found: /repo/notes.md\n- Thành công: không')
    expect(formatToolResultSummary(readFileMiss)).toBe(
      [
        '- Tổng số dòng: 0',
        '- Kích thước tệp: 0',
        '- Đã cắt bớt: không',
        '- Tệp nhị phân: không',
        '- Tệp ảnh: không',
        '- Lỗi: File not found: /repo/notes.md',
        '- Tệp tương tự: /repo/docs/notes.md',
        '- … còn 1 trường nữa'
      ].join('\n')
    )
  })

  it('reads the rest of the summary in Vietnamese', () => {
    setRuntimeI18nLocale('vi')

    // `lines_written` and `nested` have no words of their own: still title-cased.
    expect(formatToolResultSummary(mixed)).toBe(
      [
        '- Tên: deploy',
        '- Đã bật: có',
        '- Lines Written: 12',
        '- Thẻ: prod, web',
        '- Nested: 1 trường',
        '- List: 5 mục (1 trường)'
      ].join('\n')
    )
    expect(lastLine(longList)).toBe('- … còn 3 mục nữa')
    expect(lastLine(wideRecord)).toBe('- … còn 2 trường nữa')
    expect(formatToolResultSummary(inline)).toBe('- Số lượng: 3 · Thành công: không\n- 1 trường')
    expect(formatToolResultSummary(true)).toBe('có')
  })

  it.each([
    [
      'ja',
      '- エラー: File not found: /repo/notes.md\n- 成功: いいえ',
      '- … ほか 3 件',
      '- … ほか 2 個のフィールド',
      '- 名前: deploy\n- 有効: はい'
    ],
    [
      'zh',
      '- 错误: File not found: /repo/notes.md\n- 成功: 否',
      '- … 还有 3 项',
      '- … 还有 2 个字段',
      '- 名称: deploy\n- 已启用: 是'
    ],
    [
      'zh-hant',
      '- 錯誤: File not found: /repo/notes.md\n- 成功: 否',
      '- … 還有 3 項',
      '- … 還有 2 個欄位',
      '- 名稱: deploy\n- 已啟用: 是'
    ],
    // Arabic counts 1 and 2 in words: two more fields is the dual.
    [
      'ar',
      '- الخطأ: File not found: /repo/notes.md\n- النجاح: لا',
      '- … بقي 3 عناصر',
      '- … بقي حقلان',
      '- الاسم: deploy\n- مفعّل: نعم'
    ]
  ] as const)('reads in %s', (locale, error, moreItems, moreFields, flags) => {
    setRuntimeI18nLocale(locale)

    expect(formatToolResultSummary(toolError)).toBe(error)
    expect(lastLine(longList)).toBe(moreItems)
    expect(lastLine(wideRecord)).toBe(moreFields)
    expect(formatToolResultSummary({ name: 'deploy', enabled: true })).toBe(flags)
  })

  // The desktop stamps `duration_s` on every live result. Title-cased, it read
  // "Duration S: 1.234" everywhere but web_search, which patched the English
  // line after the fact.
  it('prints duration_s the way the row header does', () => {
    expect(formatToolResultSummary({ name: 'deploy', duration_s: 1.234 })).toBe('- Name: deploy\n- Duration: 1.2s')
    expect(formatToolResultSummary([{ duration_s: 0.25, status_code: 200 }])).toBe(
      '- Duration: 250ms · Status Code: 200'
    )
    // Not a duration it can format: the plain value, under the same label.
    expect(formatToolResultSummary({ name: 'deploy', duration_s: -1 })).toBe('- Name: deploy\n- Duration: -1')

    setRuntimeI18nLocale('vi')
    expect(formatToolResultSummary({ name: 'deploy', duration_s: 1.234 })).toBe('- Tên: deploy\n- Thời gian chạy: 1.2s')
  })

  it('title-cases a key it has no words for, never one inherited from Object', () => {
    setRuntimeI18nLocale('vi')

    expect(formatToolResultSummary({ lines_written: 12, constructor: 'x', toString: 'y' })).toBe(
      '- Lines Written: 12\n- Constructor: x\n- ToString: y'
    )
  })

  it('labels every key in English the way the summary always printed it', () => {
    const { fields } = TRANSLATIONS.en.assistant.tool.resultSummary

    for (const [key, label] of Object.entries(fields)) {
      if (key !== 'duration_s') {
        expect(label, key).toBe(key.split('_').map(capitalize).join(' '))
      }
    }
  })

  // ja, zh-hant and ar fall back to English key by key, so a missing entry
  // would type-check and still print English.
  it('has its own words for every label and count in every locale', () => {
    const english = TRANSLATIONS.en.assistant.tool.resultSummary

    for (const locale of ['vi', 'ja', 'zh', 'zh-hant', 'ar'] as const) {
      const copy = TRANSLATIONS[locale].assistant.tool.resultSummary

      for (const [key, label] of Object.entries(english.fields)) {
        expect(copy.fields[key as keyof typeof english.fields], `${locale} ${key}`).not.toBe(label)
      }

      expect(copy.booleans.true, `${locale} true`).not.toBe(english.booleans.true)
      expect(copy.booleans.false, `${locale} false`).not.toBe(english.booleans.false)

      for (const n of [1, 2, 5, 11, 100]) {
        expect(copy.fieldCount(n), `${locale} fieldCount ×${n}`).not.toBe(english.fieldCount(n))
        expect(copy.moreItems(n), `${locale} moreItems ×${n}`).not.toBe(english.moreItems(n))
        expect(copy.moreFields(n), `${locale} moreFields ×${n}`).not.toBe(english.moreFields(n))
      }
    }
  })
})

describe('extractToolErrorMessage', () => {
  it('requires a failure envelope before interpreting returned data as an error', () => {
    const payload = { output: { error: { message: 'Connection refused' } } }

    for (const result of [payload, { meta: payload }, { success: true, result: payload }]) {
      expect(extractToolErrorMessage(result)).toBe('')
    }

    expect(extractToolErrorMessage({ success: false, result: payload })).toBe('Connection refused')
  })

  it('finds nested error messages through wrappers', () => {
    const error = extractToolErrorMessage({
      success: false,
      result: {
        output: {
          error: {
            message: 'Permission denied writing /tmp/demo.txt'
          }
        }
      }
    })

    expect(error).toBe('Permission denied writing /tmp/demo.txt')
  })

  it('does not treat successful payload messages as errors', () => {
    const error = extractToolErrorMessage({
      success: true,
      message: 'Completed successfully',
      data: { count: 3 }
    })

    expect(error).toBe('')
  })

  it('ignores placeholder error fields in successful payloads', () => {
    const error = extractToolErrorMessage({
      success: true,
      data: {
        error: 'none',
        status: 'ok'
      }
    })

    expect(error).toBe('')
  })
})
