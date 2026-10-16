import { afterEach, describe, expect, it, vi } from 'vitest'

import { $connection } from '@/store/session'
import type { SessionInfo, SessionMessage } from '@/types/hermes'

import { artifactImageSrc, collectArtifactsForSession } from './artifact-utils'

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    ended_at: null,
    id: 'session-1',
    input_tokens: 0,
    is_active: false,
    last_active: 1000,
    message_count: 1,
    model: null,
    output_tokens: 0,
    preview: null,
    source: null,
    started_at: 1000,
    title: 'Session',
    tool_call_count: 0,
    ...overrides
  }
}

describe('collectArtifactsForSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    $connection.set(null)
  })

  it('ignores links and paths that are only mentioned — in replies or tool output', () => {
    // The user's polluted page: cited links, a regex literal, `ls -la` output.
    const messages: SessionMessage[] = [
      {
        content:
          'See https://github.com/mariozechner and [npm](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent). ' +
          'The regex `/\\.0$/` strips the suffix; config lives in `~/.config/opencode/opencode.jsonc` and /etc/hosts.conf.',
        role: 'assistant',
        timestamp: 2000
      },
      {
        content: JSON.stringify({
          exit_code: 0,
          output:
            '/c/Users/Le Duy Thai/.omp:\ntotal 9985\ndrwxr-xr-x 1 Le Duy Thai 197121 0 Oct 12 15:19 .\n=== models.yml ===',
          source_url: 'https://example.com/changelog/latest'
        }),
        role: 'tool',
        timestamp: 2001,
        tool_name: 'terminal'
      },
      {
        content: 'value.replace(/\\.0$/, "") and http://127.0.0.1:8080\nPress',
        role: 'tool',
        timestamp: 2002,
        tool_name: 'read_file'
      }
    ]

    expect(collectArtifactsForSession(makeSession(), messages)).toEqual([])
  })

  it('indexes a file the agent delivered', () => {
    const artifacts = collectArtifactsForSession(makeSession(), [
      {
        content: JSON.stringify({ name: 'report.pdf', path: '/Users/me/report.pdf', success: true }),
        role: 'tool',
        timestamp: 3000,
        tool_name: 'deliver_file'
      }
    ])

    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({
      href: 'file:///Users/me/report.pdf',
      kind: 'file',
      label: 'report.pdf',
      timestamp: 3_000_000,
      value: '/Users/me/report.pdf'
    })
  })

  it('skips a delivery that failed', () => {
    const artifacts = collectArtifactsForSession(makeSession(), [
      {
        content: JSON.stringify({ error: 'not found', path: '/Users/me/missing.pdf', success: false }),
        role: 'tool',
        tool_name: 'deliver_file'
      }
    ])

    expect(artifacts).toEqual([])
  })

  it("names a stored tool row from its assistant call when the row doesn't say", () => {
    const artifacts = collectArtifactsForSession(makeSession(), [
      {
        content: '',
        role: 'assistant',
        tool_calls: [{ function: { arguments: '{}', name: 'deliver_file' }, id: 'call_1', type: 'function' }]
      },
      {
        content: JSON.stringify({ path: '/Users/me/slides.pptx', success: true }),
        role: 'tool',
        tool_call_id: 'call_1'
      }
    ])

    expect(artifacts.map(artifact => artifact.label)).toEqual(['slides.pptx'])
  })

  it('indexes the files a turn created, Windows paths included', () => {
    const artifacts = collectArtifactsForSession(makeSession(), [
      {
        content: 'Done — the report and its chart are ready.',
        display_metadata: JSON.stringify({
          files_created: [
            { name: 'bao-cao.docx', path: 'C:\\Users\\Le Duy Thai\\Documents\\bao-cao.docx' },
            { path: '/tmp/out/chart.png' }
          ]
        }),
        role: 'assistant',
        timestamp: 4000
      }
    ])

    expect(artifacts.map(({ kind, label }) => ({ kind, label }))).toEqual([
      { kind: 'file', label: 'bao-cao.docx' },
      { kind: 'image', label: 'chart.png' }
    ])
  })

  it('indexes media the reply hands over with a MEDIA tag', () => {
    const artifacts = collectArtifactsForSession(makeSession(), [
      { content: 'Here is the voice note.\nMEDIA:/tmp/agentx/voice-note.ogg', role: 'assistant' }
    ])

    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({ kind: 'file', label: 'voice-note.ogg', value: '/tmp/agentx/voice-note.ogg' })
  })

  it("indexes a speech tool's tagged output", () => {
    const artifacts = collectArtifactsForSession(makeSession(), [
      {
        content: JSON.stringify({ file_path: '/tmp/a.mp3', media_tag: 'MEDIA:/tmp/a.mp3', success: true }),
        role: 'tool',
        tool_name: 'text_to_speech'
      }
    ])

    expect(artifacts.map(artifact => artifact.value)).toEqual(['/tmp/a.mp3'])
  })

  it('indexes a generated image, even from an extensionless URL', () => {
    const artifacts = collectArtifactsForSession(makeSession(), [
      {
        content: JSON.stringify({ image: 'https://fal.media/files/abc123', success: true }),
        role: 'tool',
        tool_name: 'image_generate'
      }
    ])

    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({ href: 'https://fal.media/files/abc123', kind: 'image' })
  })

  it("indexes local images the reply shows, not someone else's remote ones", () => {
    const artifacts = collectArtifactsForSession(makeSession(), [
      {
        content: 'Chart: ![revenue](/tmp/out/revenue.png)\nLogo: ![logo](https://example.com/logo.png)',
        role: 'assistant'
      }
    ])

    expect(artifacts.map(({ kind, value }) => ({ kind, value }))).toEqual([
      { kind: 'image', value: '/tmp/out/revenue.png' }
    ])
  })

  it('lists one artifact once per chat however often it is handed over', () => {
    const delivered = JSON.stringify({ path: '/Users/me/report.pdf', success: true })

    const artifacts = collectArtifactsForSession(makeSession(), [
      { content: delivered, role: 'tool', tool_name: 'deliver_file' },
      { content: delivered, role: 'tool', tool_name: 'deliver_file' },
      {
        content: 'Updated.',
        display_metadata: { files_created: [{ path: '/Users/me/report.pdf' }] },
        role: 'assistant'
      }
    ])

    expect(artifacts).toHaveLength(1)
  })

  it('resolves remote image artifact thumbnails through the desktop fs bridge', async () => {
    const api = vi.fn(async ({ path }: { path: string }) => {
      if (path.startsWith('/api/fs/read-data-url?')) {
        return { dataUrl: 'data:image/jpeg;base64,cmVtb3Rl' }
      }

      throw new Error(`unexpected path ${path}`)
    })

    vi.stubGlobal('window', { agentxDesktop: { api } })
    $connection.set({ baseUrl: 'https://gw', mode: 'remote', token: 'secret' } as never)

    const path = '/Users/me/.agentx/skills/work-esab/references/images/manual-step03.jpeg'
    const downloadHref = `https://gw/api/files/download?path=${encodeURIComponent(path)}&token=secret`

    await expect(artifactImageSrc(path, downloadHref)).resolves.toBe('data:image/jpeg;base64,cmVtb3Rl')

    expect(api).toHaveBeenCalledWith({
      path: '/api/fs/read-data-url?path=%2FUsers%2Fme%2F.agentx%2Fskills%2Fwork-esab%2Freferences%2Fimages%2Fmanual-step03.jpeg'
    })
  })
})
