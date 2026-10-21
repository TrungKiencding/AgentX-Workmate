import { describe, expect, it } from 'vitest'

import { preprocessMarkdown } from './markdown-preprocess'

describe('preprocessMarkdown — deliverable paths', () => {
  it('turns a bare document path in prose into a file link', () => {
    expect(preprocessMarkdown('Báo cáo đã lưu tại /Users/me/Documents/bao-cao.docx.')).toBe(
      'Báo cáo đã lưu tại [bao-cao.docx](#file:%2FUsers%2Fme%2FDocuments%2Fbao-cao.docx).'
    )
  })

  it('leaves paths inside inline and fenced code alone', () => {
    expect(preprocessMarkdown('Run `open /tmp/report.pdf` now')).toBe('Run `open /tmp/report.pdf` now')

    const fenced = '```bash\ncp /tmp/report.pdf ~/Desktop/report.pdf\n```'

    expect(preprocessMarkdown(fenced)).toBe(fenced)
  })

  it('does not touch source-code paths or url tails', () => {
    expect(preprocessMarkdown('Edited /Users/me/app/src/index.ts')).toBe('Edited /Users/me/app/src/index.ts')
    expect(preprocessMarkdown('See https://example.com/x/report.pdf')).toBe('See <https://example.com/x/report.pdf>')
  })

  it('keeps an already rendered MEDIA: link as it is', () => {
    const rendered = '[File: report.docx](#media:%2Ftmp%2Freport.docx)'

    expect(preprocessMarkdown(rendered)).toBe(rendered)
  })
})

// The file-chip and session-ref passes run after the autolinker and must not
// write inside a link, whatever comes before the "/" or "@" there.
describe('preprocessMarkdown — passes after the autolinker', () => {
  it('keeps a path-shaped URL tail inside the link', () => {
    for (const url of [
      'https://site.dev/files_(2024)/report.pdf',
      'https://site.dev/login?next=/files/report.pdf',
      'https://site.dev/#/files/report.pdf',
      'https://site.dev/a!/report.pdf',
      'https://site.dev/tài-liệu/đ/báo-cáo.pdf'
    ]) {
      expect(preprocessMarkdown(`Get ${url} now`)).toBe(`Get <${url}> now`)
    }
  })

  it('keeps a session ref inside the link', () => {
    expect(preprocessMarkdown('Open https://chat.dev/x_(y)@session:work/20260101_abc123 now')).toBe(
      'Open <https://chat.dev/x_(y)@session:work/20260101_abc123> now'
    )
  })

  it('leaves a link the text wrote in angle brackets whole', () => {
    const linked = 'See <https://site.dev/files_(2024)/report.pdf> now'

    expect(preprocessMarkdown(linked)).toBe(linked)
  })

  it('still chips a path and links a session ref next to a link', () => {
    expect(preprocessMarkdown('Đã lưu /tmp/out/báo-cáo.docx, xem https://site.dev/files_(2024)/report.pdf nhé.')).toBe(
      'Đã lưu [báo-cáo.docx](#file:%2Ftmp%2Fout%2Fb%C3%A1o-c%C3%A1o.docx), xem <https://site.dev/files_(2024)/report.pdf> nhé.'
    )
    expect(preprocessMarkdown('Context in @session:work/20260101_abc123, docs at https://acme.dev/a!/b.pdf.')).toBe(
      'Context in [20260101…](#session/work%2F20260101_abc123), docs at <https://acme.dev/a!/b.pdf>.'
    )
  })
})

// A raw URL becomes the `<…>` autolink. A trailing ")" goes inside only when
// it closes a "(" in the URL, as in a GFM autolink.
describe('preprocessMarkdown — URLs and parentheses', () => {
  const wiki = 'https://en.wikipedia.org/wiki/Mercury_(planet)'

  it('leaves the prose paren outside the link', () => {
    expect(preprocessMarkdown('(see https://acme.dev)')).toBe('(see <https://acme.dev>)')
    expect(preprocessMarkdown('Docs (https://acme.dev/guide) are short.')).toBe(
      'Docs (<https://acme.dev/guide>) are short.'
    )
    expect(preprocessMarkdown('Chi tiết (xem https://acme.dev/huong-dan).')).toBe(
      'Chi tiết (xem <https://acme.dev/huong-dan>).'
    )
  })

  it('keeps the period with the prose, before or after the paren', () => {
    expect(preprocessMarkdown('(see https://acme.dev).')).toBe('(see <https://acme.dev>).')
    expect(preprocessMarkdown('(see https://acme.dev/docs.)')).toBe('(see <https://acme.dev/docs>.)')
  })

  it('links a URL with its own parens whole', () => {
    expect(preprocessMarkdown(`Read ${wiki} now.`)).toBe(`Read <${wiki}> now.`)
    expect(preprocessMarkdown(`See ${wiki}.`)).toBe(`See <${wiki}>.`)
    expect(preprocessMarkdown(`(see ${wiki})`)).toBe(`(see <${wiki}>)`)
    expect(preprocessMarkdown(`(see ${wiki}).`)).toBe(`(see <${wiki}>).`)
  })

  it('counts nested parens', () => {
    expect(preprocessMarkdown('Docs: https://acme.dev/a_(b_(c)) end')).toBe('Docs: <https://acme.dev/a_(b_(c))> end')
    expect(preprocessMarkdown('(see https://acme.dev/a_(b_(c)))')).toBe('(see <https://acme.dev/a_(b_(c))>)')
    expect(preprocessMarkdown('((see https://acme.dev))')).toBe('((see <https://acme.dev>))')
  })

  it('only weighs a paren at the end of the URL', () => {
    expect(preprocessMarkdown('See https://acme.dev/a)b now')).toBe('See <https://acme.dev/a)b> now')
  })

  it('does not link a scheme with nothing but prose parens after it', () => {
    expect(preprocessMarkdown('(https://.)')).toBe('(https://.)')
  })

  it('leaves a link the text already made alone', () => {
    for (const linked of ['[docs](https://acme.dev)', `[Mercury](${wiki})`, '<https://acme.dev>', `(see <${wiki}>)`]) {
      expect(preprocessMarkdown(linked)).toBe(linked)
    }
  })
})

// A bare local URL is dropped from prose; the sentence around it stays whole.
describe('preprocessMarkdown — local URLs', () => {
  it('keeps the paren and the period after a dropped local URL', () => {
    expect(preprocessMarkdown('(see http://localhost:3000).')).toBe('(see ).')
    expect(preprocessMarkdown('App: http://localhost:3000.')).toBe('App: .')
    expect(preprocessMarkdown('(xem http://127.0.0.1:5173/app), rồi tải lại.')).toBe('(xem ), rồi tải lại.')
  })

  it("drops the URL's own parens with it", () => {
    expect(preprocessMarkdown('Mở http://localhost:3000/(marketing)/about.')).toBe('Mở .')
    expect(preprocessMarkdown('(see http://localhost:3000/x_(y))')).toBe('(see )')
  })

  it('still drops a local URL in running prose', () => {
    expect(preprocessMarkdown('Open http://localhost:3000 to see it')).toBe('Open  to see it')
  })
})

// A "]" ends the autolink unless it closes a "[" in the URL.
describe('preprocessMarkdown — URLs and brackets', () => {
  it('leaves the prose bracket outside the link', () => {
    expect(preprocessMarkdown('[see https://acme.dev]')).toBe('[see <https://acme.dev>]')
    expect(preprocessMarkdown('[see https://acme.dev.]')).toBe('[see <https://acme.dev>.]')
    expect(preprocessMarkdown('(xem [https://acme.dev/huong-dan])')).toBe('(xem [<https://acme.dev/huong-dan>])')
    expect(preprocessMarkdown('[x [y https://acme.dev]]')).toBe('[x [y <https://acme.dev>]]')
  })

  it("keeps the URL's own brackets", () => {
    for (const url of ['https://acme.dev/?a[]=1', 'https://acme.dev/?filter[name]=x', 'http://[2001:db8::1]:8080/x']) {
      expect(preprocessMarkdown(`Open ${url} now`)).toBe(`Open <${url}> now`)
    }

    expect(preprocessMarkdown('[see https://acme.dev/?q=[a]]')).toBe('[see <https://acme.dev/?q=[a]>]')
  })

  it("leaves a URL that is a link's text to the markdown parser", () => {
    for (const linked of [
      '[https://acme.dev](https://acme.dev)',
      '[see https://acme.dev](https://x.dev)',
      '![https://acme.dev/logo.png](https://acme.dev/logo.png)',
      'Nguồn: [https://vi.wikipedia.org/wiki/Sao_Thủy_(hành_tinh)](https://vi.wikipedia.org/wiki/Sao_Thủy_(hành_tinh)).'
    ]) {
      expect(preprocessMarkdown(linked)).toBe(linked)
    }
  })

  it('drops a bracketed local URL but not the bracket', () => {
    expect(preprocessMarkdown('[see http://localhost:3000]')).toBe('[see ]')
  })
})

// A Data Hub answer cites passages as [S1] (docs/data-hub/agents.md in the
// hub); the numeric web-citation scrub must leave those for the reader.
describe('preprocessMarkdown — Data Hub passage refs', () => {
  it('keeps [S1] and [S12] in the answer', () => {
    expect(preprocessMarkdown('Mức chi là 300.000 đồng [S1].')).toBe('Mức chi là 300.000 đồng [S1].')
    expect(preprocessMarkdown('Theo quy định[S12], áp dụng từ 2026 [S1][S2].')).toBe(
      'Theo quy định[S12], áp dụng từ 2026 [S1][S2].'
    )
  })

  it('still drops a numeric citation marker', () => {
    expect(preprocessMarkdown('Deploys go out on Fridays[1].')).toBe('Deploys go out on Fridays.')
  })
})
