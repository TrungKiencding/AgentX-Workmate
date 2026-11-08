/** The group-room engine end to end against a fake gateway: who speaks,
 *  what reaches the room, files, permission requests, failures and Stop. */

import { host } from '@agentx/plugin-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { holdAttachment, resetAttachments } from './group-attachments'
import { pendingApproval, resetGroupRuntime, sendToGroup, stopGroup } from './group-chat'
import { $groupChats, resetBotState } from './state'
import type { GroupAttachment, GroupEntry, GroupMember } from './types'

const members: GroupMember[] = [
  { name: 'nghien-cuu', title: 'Nghiên cứu' },
  { name: 'bien-tap', title: 'Biên tập' }
]

const copy = {
  failed: (name: string) => `${name} failed`,
  gone: (name: string) => `${name} gone`,
  timedOut: (name: string) => `${name} timed out`
}

type Script = (member: string, prompt: string) => 'approval' | 'hang' | { error: string } | string

interface FakeSession {
  member: string
  messages: Array<{ content: string; role: string }>
  running: boolean
  inflight: { error?: string; status?: string } | null
  runtime: string
  stored: string
}

let sessions: FakeSession[]
let calls: Array<[string, Record<string, unknown>]>
let script: Script
let listeners: Map<string, Set<(event: { payload?: unknown; session_id?: string; type: string }) => void>>
let counter: number

const byId = (id: unknown) => sessions.find(row => row.stored === id || row.runtime === id)

function emit(type: string, session_id: string, payload: unknown = {}) {
  listeners.get(type)?.forEach(listener => listener({ type, session_id, payload }))
}

beforeEach(() => {
  vi.useFakeTimers()
  resetBotState()
  resetAttachments()
  resetGroupRuntime()
  sessions = []
  calls = []
  counter = 0
  listeners = new Map()
  script = () => '(pass)'

  vi.spyOn(host, 'onEvent').mockImplementation((type, listener) => {
    const set = listeners.get(type) ?? new Set()
    set.add(listener as never)
    listeners.set(type, set)

    return () => set.delete(listener as never)
  })

  vi.spyOn(host, 'request').mockRejectedValue(new Error('rooms must use the window backend'))

  vi.spyOn(host, 'requestPrimary').mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
    calls.push([method, params])

    switch (method) {
      case 'session.resume': {
        const row = sessions.find(
          s => (s.stored === params.session_id || s.runtime === params.session_id) && s.member === params.profile
        )

        if (!row) {
          throw new Error('session not found')
        }

        return {
          session_id: row.runtime,
          session_key: row.stored,
          message_count: row.messages.length,
          messages: params.omit_messages ? [] : row.messages,
          running: row.running,
          inflight: row.inflight
        } as never
      }

      case 'session.create': {
        if (params.profile === 'ghost') {
          throw Object.assign(new Error("profile 'ghost' not found"), { code: 4044 })
        }

        counter += 1

        const row: FakeSession = {
          member: String(params.profile),
          messages: [],
          running: false,
          inflight: null,
          runtime: `rt-${counter}`,
          stored: `st-${counter}`
        }

        sessions.push(row)

        return { session_id: row.runtime, stored_session_id: row.stored } as never
      }

      case 'prompt.submit': {
        const row = byId(params.session_id)!
        const prompt = String(params.text)
        row.messages.push({ role: 'user', content: prompt })
        row.running = true
        const outcome = script(row.member, prompt)

        if (outcome === 'hang') {
          return { status: 'streaming' } as never
        }

        if (outcome === 'approval') {
          setTimeout(() => emit('approval.request', row.runtime, { command: 'rm -rf build', request_id: 'ap-1' }), 10)

          return { status: 'streaming' } as never
        }

        setTimeout(() => {
          row.running = false

          if (typeof outcome === 'object') {
            row.inflight = { status: 'error', error: outcome.error }
          } else {
            row.messages.push({ role: 'assistant', content: outcome })
          }

          emit('message.complete', row.runtime)
        }, 50)

        return { status: 'streaming' } as never
      }

      case 'approval.respond': {
        const row = byId(params.session_id)!
        row.running = false
        row.messages.push({ role: 'assistant', content: params.choice === 'once' ? 'Đã dọn xong.' : 'Không dọn.' })

        return { resolved: true } as never
      }

      case 'image.attach_bytes':
        return { attached: true, path: '/tmp/x.png' } as never

      case 'file.attach':
        return { attached: true, ref_text: `@file:uploads/${String(params.name)}` } as never

      default:
        return { ok: true } as never
    }
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const room = () => $groupChats.get().Team
const log = () => room()?.log ?? []

const said = () =>
  log()
    .filter(entry => entry.from.kind !== 'user')
    .map(entry => `${entry.from.kind === 'notice' ? '!' : entry.from.name}: ${entry.text}`)

async function settle(limitMs = 60_000) {
  for (let waited = 0; waited < limitMs && room()?.running; waited += 500) {
    await vi.advanceTimersByTimeAsync(500)
  }
}

const prompts = (member: string) =>
  calls
    .filter(([method, params]) => method === 'prompt.submit' && byId(params.session_id)?.member === member)
    .map(([, params]) => String(params.text))

describe('group room engine', () => {
  it('everyone answers an unaddressed message in hidden bot-room sessions on the window backend', async () => {
    script = member => (member === 'nghien-cuu' ? 'Mình có số liệu rồi.' : '(pass)')

    sendToGroup('Team', members, 'Chào cả nhóm', copy)
    await settle()

    expect(said()).toEqual(['nghien-cuu: Mình có số liệu rồi.'])
    expect(room().running).toBe(false)
    expect(
      calls.filter(([method]) => method === 'session.create').map(([, params]) => [params.source, params.title])
    ).toEqual([
      ['bot-room', 'Group: Team'],
      ['bot-room', 'Group: Team']
    ])
  })

  it('after the first round only a teammate who was handed something speaks — no small talk', async () => {
    script = (member, prompt) => {
      if (member === 'nghien-cuu') {
        return prompts('nghien-cuu').length > 1 ? 'Sẵn sàng hỗ trợ!' : 'Số liệu đây, @bien-tap viết bài nhé.'
      }

      return prompt.includes('Số liệu đây') ? 'Bài viết đây.' : '(pass)'
    }

    sendToGroup('Team', members, '@nghien-cuu tìm số liệu', copy)
    await settle()

    expect(said()).toEqual(['nghien-cuu: Số liệu đây, @bien-tap viết bài nhé.', 'bien-tap: Bài viết đây.'])
    expect(prompts('nghien-cuu')).toHaveLength(1)
  })

  it('cleans what members post (echoed names) and asks a directly named member once more after a pass', async () => {
    script = (member, prompt) => {
      if (member !== 'bien-tap') {
        return '(pass)'
      }

      return prompt.startsWith('The user addressed you') ? '**Biên tập**: Đây là bản nháp.' : '(pass)'
    }

    sendToGroup('Team', members, '@bien-tap viết giúp đoạn mở đầu', copy)
    await settle()

    expect(said()).toEqual(['bien-tap: Đây là bản nháp.'])
    expect(prompts('bien-tap')).toHaveLength(2)
  })

  it('a failed turn is a visible notice, not a silent pass', async () => {
    script = member => (member === 'nghien-cuu' ? { error: 'rate limited' } : 'Mình làm phần này.')

    sendToGroup('Team', members, 'Ai làm?', copy)
    await settle()

    expect(said()).toEqual(['!: Nghiên cứu failed', 'bien-tap: Mình làm phần này.'])
  })

  it('a member whose assistant was deleted is reported once and skipped', async () => {
    sendToGroup('Team', [{ name: 'ghost', title: 'Ma' }, members[0]], 'Chào', copy)
    await settle()

    expect(said()).toEqual(['!: Ma gone'])
  })

  it('shared files reach each member: pictures as images, other files as @file refs', async () => {
    const image: GroupAttachment = { id: 'a1', name: 'hoadon.png', kind: 'image', size: 10 }
    const file: GroupAttachment = { id: 'a2', name: 'khach.txt', kind: 'file', size: 10 }
    holdAttachment(image, 'data:image/png;base64,AAA')
    holdAttachment(file, 'data:text/plain;base64,QQ==')
    script = member => (member === 'nghien-cuu' ? 'Có 3 khách.' : '(pass)')

    sendToGroup('Team', members, '@nghien-cuu đếm khách', copy, [image, file])
    await settle()

    const user = log()[0] as GroupEntry
    expect(user.attachments?.map(item => item.name)).toEqual(['hoadon.png', 'khach.txt'])
    expect(calls.find(([method]) => method === 'image.attach_bytes')?.[1]).toMatchObject({
      content_base64: 'data:image/png;base64,AAA',
      filename: 'hoadon.png'
    })
    expect(prompts('nghien-cuu')[0]).toContain('"khach.txt" → @file:uploads/khach.txt')
    expect(said()).toEqual(['nghien-cuu: Có 3 khách.'])
  })

  it('a permission request surfaces in the room and the answer goes back to that member', async () => {
    script = member => (member === 'nghien-cuu' ? 'approval' : '(pass)')

    sendToGroup('Team', members, '@nghien-cuu dọn thư mục build', copy)

    for (let i = 0; i < 20 && !pendingApproval('Team'); i++) {
      await vi.advanceTimersByTimeAsync(100)
    }

    expect(pendingApproval('Team')).toMatchObject({ command: 'rm -rf build', member: 'nghien-cuu' })

    const { answerApproval } = await import('./group-chat')
    await answerApproval('Team', 'once')
    await settle()

    expect(calls.find(([method]) => method === 'approval.respond')?.[1]).toMatchObject({
      choice: 'once',
      request_id: 'ap-1'
    })
    expect(said()).toEqual(['nghien-cuu: Đã dọn xong.'])
    expect(pendingApproval('Team')).toBeNull()
  })

  it('Stop interrupts the member answering now and nobody else speaks', async () => {
    script = () => 'hang'

    sendToGroup('Team', members, 'Viết một cuốn sách', copy)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(room().speaker).toBeTruthy()

    stopGroup('Team', 'Stopped')
    await vi.advanceTimersByTimeAsync(5_000)

    expect(room().running).toBe(false)
    expect(calls.some(([method]) => method === 'session.interrupt')).toBe(true)
    expect(said()).toEqual(['!: Stopped'])
    expect(calls.filter(([method]) => method === 'prompt.submit')).toHaveLength(1)
  })
})
