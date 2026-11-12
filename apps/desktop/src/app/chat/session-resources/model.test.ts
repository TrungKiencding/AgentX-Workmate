import { describe, expect, it } from 'vitest'

import { type ChatMessage, type ChatMessagePart, toChatMessages } from '@/lib/chat-messages'
import { DELIVERABLE_KINDS } from '@/lib/deliverables'

import { createSessionResourceCollector } from './model'

const message = (text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm',
  role: 'assistant',
  parts: [{ type: 'text', text }],
  ...extra
})

const tool = (toolName: string, args: unknown, result?: unknown, isError = false): ChatMessagePart => ({
  type: 'tool-call',
  toolCallId: 't',
  toolName,
  args: args as never,
  argsText: '',
  result,
  isError
})

const collect = (messages: ChatMessage[], cwd = '/work') => createSessionResourceCollector()(messages, cwd)

describe('session resource collection', () => {
  it('preserves literal hash and question-mark characters in native output filenames', () => {
    const path = '/work/Report #1 (final)?.pdf'
    expect(collect([message('', { createdFiles: [{ path, name: 'Report #1 (final)?.pdf' }] })]).outputs[0].label).toBe(
      'Report #1 (final)?.pdf'
    )
  })
  it('reconciles requested paths, attachments and links with authoritative symlink-resolved tool paths', () => {
    const result = collect([
      message('@file:/var/output/report.docx', { role: 'user' }),
      message('[Report](/var/output/report.docx)', {
        id: 'delivery',
        parts: [
          tool(
            'deliver_file',
            { path: '/var/output/report.docx' },
            { success: true, path: '/private/var/output/report.docx' }
          ),
          { type: 'text', text: '[Report](/var/output/report.docx)' }
        ]
      })
    ])

    expect(result.outputs.map(item => item.target)).toEqual(['/private/var/output/report.docx'])
    expect(result.sources.map(item => item.target)).toEqual(['/private/var/output/report.docx'])
  })
  it('uses the generated-image host path and keeps inline image outputs and attachments', () => {
    const data = `data:image/png;base64,${'A'.repeat(128)}`

    const result = collect([
      message('', {
        parts: [
          tool(
            'image_generate',
            {},
            { success: true, host_image: '/host/image.png', agent_visible_image: '/sandbox/image.png' }
          ),
          { type: 'image', image: data }
        ]
      }),
      message('', { id: 'user-image', role: 'user', parts: [{ type: 'image', image: data }] })
    ])

    expect(result.outputs.map(item => item.label)).toEqual(['image.png', 'image.png'])
    expect(result.outputs[0].target).toBe('/host/image.png')
    expect(result.outputs[1].dataUrl).toBe(data)
    expect(result.sources[0].dataUrl).toBe(data)
  })
  it('keeps the actual filename after a later assistant link uses a friendly label', () => {
    const result = collect([
      message('', { createdFiles: [{ name: 'report.pdf', path: '/work/report.pdf' }] }),
      message('[Read the report](/work/report.pdf)', { id: 'later' })
    ])

    expect(result.outputs).toHaveLength(1)
    expect(result.outputs[0].label).toBe('report.pdf')
  })

  it('treats file-search arrays as sources and deduplicates native Windows path aliases', () => {
    const result = collect([
      message('', {
        parts: [tool('search_files', {}, { files: ['input.md', { path: '/work/notes.txt' }] })],
        createdFiles: [{ name: 'a.pdf', path: 'C:\\Reports\\a.pdf' }]
      }),
      message('[PDF](file:///C:/Reports/a.pdf)', { id: 'link' })
    ])

    expect(result.sources.map(item => item.target)).toEqual(['/work/input.md', '/work/notes.txt'])
    expect(result.outputs).toHaveLength(1)
  })
  it.each(Object.entries(DELIVERABLE_KINDS).flatMap(([kind, extensions]) => extensions.map(ext => [kind, ext])))(
    'keeps %s output .%s without requiring a renderer for it',
    (_kind, ext) => {
      const path = `/work/Đầu ra/report.${ext}`
      const result = collect([message('', { createdFiles: [{ name: `report.${ext}`, path }] })])
      expect(result.outputs.map(item => item.target)).toEqual([path])
    }
  )

  it('retains unknown binaries, extensionless files, code, and more than the old four-preview cap', () => {
    const files = Array.from({ length: 70 }, (_, i) => ({ name: `file-${i}.custom`, path: `/work/file-${i}.custom` }))
    files.push({ name: 'LICENSE', path: '/work/LICENSE' }, { name: 'main.py', path: '/work/main.py' })
    expect(collect([message('', { createdFiles: files })]).outputs.map(item => item.target)).toEqual(
      files.map(file => file.path)
    )
  })

  it('lists unknown explicit file handoffs from terminal output and quoted code paths', () => {
    const result = collect([
      message('`/work/Đầu ra/custom.blob`'),
      message('', { id: 'tool', parts: [tool('terminal', {}, { stdout: 'Saved /work/export.parquet2\nDone.' })] })
    ])

    expect(result.outputs.map(item => item.target)).toEqual(['/work/Đầu ra/custom.blob', '/work/export.parquet2'])
  })

  it('collects links with spaces, parentheses, reference links, media and bare paths', () => {
    const result = collect([
      message(
        '[Report](</work/Báo cáo (final).pdf>)\n[Data][data]\n\n[data]: /work/data.csv\n\n[Media](#media:%2Fwork%2Fclip.mp4)\n\n`/work/readme.md`\n\n[Web](https://example.com/wiki/A_(B))\n\nhttps://example.org/source'
      )
    ])

    expect(result.outputs.map(item => item.target)).toEqual(
      expect.arrayContaining(['/work/Báo cáo (final).pdf', '/work/data.csv', '/work/clip.mp4', '/work/readme.md'])
    )
    expect(result.sources.map(item => item.target)).toEqual([
      'https://example.com/wiki/A_(B)',
      'https://example.org/source'
    ])
  })

  it('keeps complete input references, attached images, and links separate from outputs', () => {
    const result = collect([
      message('@file:`inputs/Báo cáo (mới).docx` and @url:"https://example.com/input"', {
        role: 'user',
        attachmentRefs: ['@image:"/work/my photo.png"'],
        parts: [
          { type: 'text', text: '@file:`inputs/Báo cáo (mới).docx` and @url:"https://example.com/input"' },
          { type: 'image', image: 'file:///work/attached.png' }
        ]
      })
    ])

    expect(result.outputs).toEqual([])
    expect(result.sources.map(item => item.target)).toEqual(
      expect.arrayContaining([
        '/work/inputs/Báo cáo (mới).docx',
        '/work/my photo.png',
        '/work/attached.png',
        'https://example.com/input'
      ])
    )
  })

  it('merges delivery and created-file metadata with markdown references to the same file', () => {
    const result = collect([
      message('[report](./out/../report.pdf) [again](file:///work/report.pdf)', {
        createdFiles: [{ name: 'report.pdf', path: '/work/report.pdf' }],
        parts: [
          tool('deliver_file', { path: '/work/report.pdf' }, { success: true, path: '/work/report.pdf' }),
          { type: 'text', text: '[report](./report.pdf)' }
        ]
      })
    ])

    expect(result.outputs).toHaveLength(1)
  })

  it('takes every structured search result and retains titles through JSON wrappers', () => {
    const results = Array.from({ length: 45 }, (_, i) => ({ title: `Source ${i}`, url: `https://example.com/${i}` }))

    const result = collect([
      message('', { parts: [tool('web_search', { query: 'research' }, JSON.stringify({ results }))] })
    ])

    expect(result.sources).toHaveLength(results.length)
    expect(result.sources.map(item => item.label)).toEqual(results.map(hit => hit.title))
  })

  it('handles nested plugin outputs and arrays without treating names/MIME types as paths', () => {
    const result = collect([
      message('', {
        parts: [
          tool(
            'custom_export',
            {},
            {
              result: JSON.stringify({
                output_files: [
                  { path: '/work/report.unknown', name: 'Report', mime_type: 'application/custom' },
                  '/work/archive.zip'
                ]
              })
            }
          )
        ]
      })
    ])

    expect(result.outputs.map(item => item.target)).toEqual(['/work/report.unknown', '/work/archive.zip'])
  })

  it('collects successful writes and source reads while keeping failed/running writes out of outputs', () => {
    const result = collect([
      message('', {
        parts: [
          tool('write_file', { path: 'output.py' }, { success: true }),
          tool('read_file', { path: 'source.py' }, { content: 'hello' }),
          tool('write_file', { path: 'failed.pdf' }, { success: false, error: 'Failed: /work/failed.pdf' }, true),
          tool('write_file', { path: 'running.pdf' })
        ]
      })
    ])

    expect(result.outputs.map(item => item.target)).toEqual(['/work/output.py'])
    expect(result.sources.map(item => item.target)).toContain('/work/source.py')
  })

  it('finds terminal handoffs but treats paths inside read-file content as sources', () => {
    const result = collect([
      message('', {
        parts: [
          tool('terminal', {}, { stdout: 'MEDIA: /work/result.mp3\n[Report](/work/report.pdf)' }),
          tool('read_file', { path: '/work/README.md' }, { context: 'Reference: /work/input.pdf' })
        ]
      })
    ])

    expect(result.outputs.map(item => item.target)).toEqual(
      expect.arrayContaining(['/work/result.mp3', '/work/report.pdf'])
    )
    expect(result.outputs.map(item => item.target)).not.toContain('/work/input.pdf')
    expect(result.sources.map(item => item.target)).toContain('/work/input.pdf')
  })

  it('derives artifacts from unmounted historical fences and keeps the latest revision', () => {
    const html = (body: string) =>
      `\`\`\`html\n<!doctype html><html><head><title>Report</title></head><body><h1>${body}</h1>${'a'.repeat(180)}</body></html>\n\`\`\``

    const result = collect([
      message(html('old')),
      message(html('new'), { id: 'new' }),
      message('```js\nconst url = "https://example.com/not-a-source"\n```')
    ])

    expect(result.outputs).toHaveLength(1)
    expect(result.outputs[0].artifact?.content).toContain('new')
    expect(result.sources).toEqual([])
  })

  it('includes oldest history after real transcript hydration of display metadata and tool results', () => {
    const messages = toChatMessages([
      { role: 'user', content: 'Read https://example.com/source' },
      {
        role: 'assistant',
        content: 'Created',
        display_metadata: { files_created: [{ path: '/work/old.pdf', name: 'old.pdf' }] }
      },
      ...Array.from({ length: 100 }, (_, i) => ({ role: 'user' as const, content: `Turn ${i}` })),
      { role: 'assistant', content: '[latest](/work/latest.xlsx)' }
    ])

    const result = collect(messages)
    expect(result.outputs.map(item => item.target)).toEqual(['/work/old.pdf', '/work/latest.xlsx'])
    expect(result.sources[0].target).toBe('https://example.com/source')
  })

  it('ignores hidden/system content, unsafe schemes, malformed links, and credentialed URLs', () => {
    const result = collect([
      message(
        '[a](javascript:alert) [b](#file:%ZZ) [c](data:text/html,hello) [d](https://user:pass@example.com/private)'
      ),
      message('[hidden](/work/hidden.pdf)', { hidden: true }),
      message('[system](/work/system.pdf)', { role: 'system' })
    ])

    expect(result).toEqual({ outputs: [], sources: [] })
  })

  it('keeps identity stable for streaming prose and does not leak between sessions or cwd changes', () => {
    const collector = createSessionResourceCollector()
    const first = collector([message('[report](report.pdf)')], '/one')
    expect(collector([message('[report](report.pdf) more words', { pending: true })], '/one')).toBe(first)
    expect(collector([message('[report](report.pdf)')], '/two').outputs[0].target).toBe('/two/report.pdf')
    expect(collector([message('Another session')], '/two')).toEqual({ outputs: [], sources: [] })
  })
})
