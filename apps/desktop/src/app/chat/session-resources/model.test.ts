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

    // The attachment, the link and the delivery are one file; it is listed
    // once, as what the conversation made.
    expect(result.outputs.map(item => item.target)).toEqual(['/private/var/output/report.docx'])
    expect(result.sources).toEqual([])
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

    // Newest step first; two rows of one name say which folder.
    expect(result.outputs.map(item => [item.label, item.folder])).toEqual([
      ['image.png', undefined],
      ['image.png', 'host']
    ])
    expect(result.outputs[0].dataUrl).toBe(data)
    expect(result.outputs[1].target).toBe('/host/image.png')
    // The same picture the user sent is the conversation's output, listed once.
    expect(result.sources).toEqual([])
  })
  it('keeps the actual filename after a later assistant link uses a friendly label', () => {
    const result = collect([
      message('', { createdFiles: [{ name: 'report.pdf', path: '/work/report.pdf' }] }),
      message('[Read the report](/work/report.pdf)', { id: 'later' })
    ])

    expect(result.outputs).toHaveLength(1)
    expect(result.outputs[0].label).toBe('report.pdf')
  })

  it('leaves file-search listings out and deduplicates native Windows path aliases', () => {
    const result = collect([
      message('', {
        parts: [
          tool(
            'search_files',
            { path: '/work', pattern: 'TODO' },
            { files: ['input.md', { path: '/work/notes.txt' }], matches: [{ path: 'src/a.ts', line: 1 }] }
          )
        ],
        createdFiles: [{ name: 'a.pdf', path: 'C:\\Reports\\a.pdf' }]
      }),
      message('[PDF](file:///C:/Reports/a.pdf)', { id: 'link' })
    ])

    // A listing is not something the conversation read, and the folder it
    // searched is not a file.
    expect(result.sources).toEqual([])
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

  it('does not take a path that is only mentioned for something the conversation made', () => {
    const result = collect([
      message(
        'Không thấy `/Users/me/Desktop/missing.docx`. Python ở /usr/local/bin/python3.11, cấu hình ở /etc/nginx/nginx.conf, gọi /api/v1/users.json rồi xem /work/old-report.pdf.'
      ),
      message('', {
        id: 'tool',
        parts: [
          tool(
            'terminal',
            { command: 'find /work -name "*.md"' },
            { output: '/work/a.md\n/work/b/c.md', exit_code: 0 }
          ),
          tool(
            'terminal',
            { command: 'cat README.md' },
            { output: 'Saved /work/export.parquet2\n[docs](docs/guide.md)' }
          ),
          tool('execute_code', {}, { output: 'wrote /work/out.json and https://example.com/printed' })
        ]
      })
    ])

    expect(result).toEqual({ outputs: [], sources: [] })
  })

  it('takes a file a script wrote from the verified list of the turn', () => {
    const result = collect([
      message('Đã lưu vào `/work/Đầu ra/custom.blob`.', {
        createdFiles: [{ name: 'custom.blob', path: '/work/Đầu ra/custom.blob' }],
        parts: [
          tool('terminal', { command: 'python make.py' }, { output: 'Saved /work/Đầu ra/custom.blob', exit_code: 0 }),
          { type: 'text', text: 'Đã lưu vào `/work/Đầu ra/custom.blob`.' }
        ]
      })
    ])

    expect(result.outputs.map(item => item.target)).toEqual(['/work/Đầu ra/custom.blob'])
  })

  it('ignores a failed command, a failed read and a call that is still running', () => {
    const result = collect([
      message('', {
        parts: [
          tool('terminal', {}, { output: 'MEDIA: /work/never.mp3\ncat: /x/y.txt: No such file', exit_code: 1 }),
          tool('read_file', { path: '/work/gone.md' }, { error: 'File not found' }),
          tool('read_file', { path: '/work/reading.md' }),
          tool('write_file', { path: 'failed.pdf' }, { success: false, error: 'Failed: /work/failed.pdf' }, true)
        ]
      })
    ])

    expect(result).toEqual({ outputs: [], sources: [] })
  })

  it("does not resolve an arbitrary tool's relative path against the session folder", () => {
    const result = collect([
      message('', {
        parts: [
          tool(
            'skill_view',
            { name: 'docx' },
            { success: true, name: 'docx', path: 'productivity/docx/SKILL.md', skill_dir: '/home/skills/docx' }
          ),
          tool('custom_export', {}, { output_files: ['relative/out.bin', '/abs/out.bin'] }),
          tool('browser_navigate', { url: 'example.com' }, { success: true, url: 'https://example.com/' })
        ]
      })
    ])

    expect(result.outputs.map(item => item.target)).toEqual(['/abs/out.bin'])
    expect(result.sources.map(item => item.target)).toEqual(['https://example.com/'])
  })

  it('lists a file that was read and then edited once, as an output', () => {
    const result = collect([
      message('', {
        parts: [
          tool('read_file', { path: 'src/a.ts' }, { content: 'a' }),
          tool('read_file', { path: 'src/only-read.ts' }, { content: 'b' }),
          tool('patch', { path: 'src/a.ts', old_string: 'a', new_string: 'b' }, { success: true }),
          tool(
            'patch',
            { mode: 'patch', patch: '*** Begin Patch' },
            { success: true, files_modified: ['src/b.ts', 'src/old.ts -> src/new.ts'], files_created: ['src/c.ts'] }
          )
        ]
      })
    ])

    expect(result.outputs.map(item => item.target)).toEqual([
      '/work/src/b.ts',
      '/work/src/new.ts',
      '/work/src/c.ts',
      '/work/src/a.ts'
    ])
    expect(result.sources.map(item => item.target)).toEqual(['/work/src/only-read.ts'])
  })

  it('puts the newest turn first and moves a file written again back to the top', () => {
    const write = (id: string, path: string): ChatMessage =>
      message('', { id, parts: [tool('write_file', { path }, { success: true })] })

    const result = collect([write('1', 'first.md'), write('2', 'second.md'), write('3', 'first.md')])

    expect(result.outputs.map(item => item.label)).toEqual(['first.md', 'second.md'])
  })

  it('lists a file once whichever way its path is spelled', () => {
    const result = collect([
      // write_file reports the path it resolved; the reply links the one it was asked for.
      message('[Report](</var/out/Báo cáo.html>)', {
        id: 'write',
        parts: [
          tool(
            'write_file',
            { path: '/var/out/Báo cáo.html', content: '' },
            {
              bytes_written: 1,
              resolved_path: '/private/var/out/Báo cáo.html',
              files_modified: ['/private/var/out/Báo cáo.html']
            }
          ),
          { type: 'text', text: '[Report](</var/out/Báo cáo.html>)' }
        ]
      }),
      // No tool says so here: a script wrote it, the backend verified it.
      message('[slides](/tmp/deck.pptx)', {
        id: 'script',
        createdFiles: [{ name: 'deck.pptx', path: '/private/tmp/deck.pptx' }]
      })
    ])

    expect(result.outputs.map(item => [item.label, item.folder])).toEqual([
      ['deck.pptx', undefined],
      ['Báo cáo.html', undefined]
    ])
  })

  it('tells two files of one name apart by their folder', () => {
    const result = collect([
      message('', {
        parts: [
          tool('write_file', { path: '/work/a/README.md' }, { success: true }),
          tool('write_file', { path: '/work/b/README.md' }, { success: true }),
          tool('write_file', { path: '/work/b/notes.md' }, { success: true })
        ]
      })
    ])

    expect(result.outputs.map(item => [item.label, item.folder])).toEqual([
      ['notes.md', undefined],
      ['README.md', 'b'],
      ['README.md', 'a']
    ])
  })

  it('takes a file the user names for a source, inside markdown or not', () => {
    const plain = collect([message('Tóm tắt /work/brief.pdf giúp mình', { role: 'user' })])
    const rich = collect([message('Tóm tắt /work/brief.pdf và [trang này](https://example.com/x)', { role: 'user' })])

    expect(plain.sources.map(item => item.target)).toEqual(['/work/brief.pdf'])
    expect(rich.sources.map(item => item.target)).toEqual(['/work/brief.pdf', 'https://example.com/x'])
  })

  it('reads a long transcript in budgeted steps, newest first, and ends with the same lists', () => {
    const messages = Array.from({ length: 40 }, (_, i) =>
      message(`[Báo cáo ${i}](/work/report-${i}.pdf)`, { id: `m${i}` })
    )

    const whole = collect(messages)
    const collector = createSessionResourceCollector()
    const first = collector.step(messages, '/work', 0)

    // A spent budget still reads one message: the newest.
    expect(first.complete).toBe(false)
    expect(first.resources.outputs.map(item => item.label)).toEqual(['report-39.pdf'])

    let progress = first
    let steps = 1

    while (!progress.complete) {
      progress = collector.step(messages, '/work', 0)
      steps += 1
    }

    expect(steps).toBe(40)
    expect(progress.resources).toEqual(whole)
    // Everything is kept: the next pass reads nothing and keeps identity.
    expect(collector.step(messages, '/work', 0)).toEqual({ complete: true, resources: progress.resources })
    expect(collector(messages, '/work')).toBe(progress.resources)
  })

  it('collects links with spaces, parentheses, reference links and media hand-overs', () => {
    const result = collect([
      message(
        '[Report](</work/Báo cáo (final).pdf>)\n[Data][data]\n\n[data]: /work/data.csv\n\n[Media](#media:%2Fwork%2Fclip.mp4)\n\nMEDIA: `/work/voice note.mp3`\n\n[Web](https://example.com/wiki/A_(B))\n\nhttps://example.org/source'
      )
    ])

    expect(result.outputs.map(item => item.target)).toEqual(
      expect.arrayContaining(['/work/Báo cáo (final).pdf', '/work/data.csv', '/work/clip.mp4', '/work/voice note.mp3'])
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

  it('takes a MEDIA: tag a tool printed, and the file a read tool opened — not what the file says', () => {
    const result = collect([
      message('', {
        parts: [
          tool('terminal', {}, { stdout: 'MEDIA: /work/result.mp3\n[Report](/work/report.pdf)' }),
          tool('read_file', { path: '/work/README.md' }, { context: 'Reference: /work/input.pdf' })
        ]
      })
    ])

    expect(result.outputs.map(item => item.target)).toEqual(['/work/result.mp3'])
    expect(result.sources.map(item => item.target)).toEqual(['/work/README.md'])
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
    expect(result.outputs.map(item => item.target)).toEqual(['/work/latest.xlsx', '/work/old.pdf'])
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
