import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from 'react'

import { $terminalTakeover, setTerminalTakeover } from '@/app/right-sidebar/store'
import { writeAgentTerminalChunk } from '@/app/right-sidebar/terminal/agent-terminal-stream'
import {
  $activeTerminalId,
  $terminals,
  createTerminal,
  ensureAgentTerminal,
  selectTerminal,
  type TerminalEntry
} from '@/app/right-sidebar/terminal/terminals'
import type { ClientSessionState } from '@/app/types'
import { createClientSessionState } from '@/lib/chat-runtime'
import { $keycloakAccount } from '@/store/account'
import { $repoStatusByCwd } from '@/store/coding-status'
import { $gateway } from '@/store/gateway'
import { $desktopOnboarding } from '@/store/onboarding'
import { $projectTree } from '@/store/projects'
import {
  $currentCwd,
  $freshDraftReady,
  $messages,
  $selectedStoredSessionId,
  $sessions,
  setBusy,
  setCurrentCwdTransient,
  setMessages
} from '@/store/session'
import { clearAllSessionStates, publishSessionState } from '@/store/session-states'
import type { SessionInfo } from '@/types/hermes'

type Sample = {
  id: string
  phase: string
  actualDuration: number
  baseDuration: number
  startTime: number
  commitTime: number
}

type SyntheticDriverHandle = { stop: () => void }

declare global {
  interface Window {
    __PERF_PROBE__?: {
      samples: Sample[]
      enabled: boolean
      clear: () => void
      summary: () => Record<string, { count: number; total: number; max: number; p50: number; p95: number }>
    }
    __PERF_DRIVE__?: {
      /** Inject an assistant message and grow it by `chunk` every `intervalMs`. Returns a stop handle. */
      stream: (opts?: { chunk?: string; intervalMs?: number; totalTokens?: number }) => SyntheticDriverHandle
      /**
       * Replace the transcript with `turns` synthetic user/assistant pairs of
       * realistic mixed markdown, then resolve with the ms elapsed from the
       * `setMessages` commit to the second animation frame (a mount+paint
       * proxy). Used by the `transcript` perf scenario. `reset()` restores.
       */
      loadTranscript: (turns?: number) => Promise<number>
      /**
       * Whether the active gateway socket is open. The perf harness waits on
       * this before measuring so background reconnect churn (a booting/absent
       * backend) doesn't contaminate frame-pacing numbers.
       */
      connected: () => boolean
      /** Mount files + multiple xterms for the synthetic right-pane scenario. */
      rightPaneSetup: (opts: { cwd: string; terminals?: number }) => { procId: string; terminalIds: string[] }
      rightPaneGit: (path: string, kind?: 'added' | 'conflicted' | 'modified') => void
      rightPaneReset: () => void
      rightPaneSelect: (id: string) => void
      rightPaneWrite: (procId: string, chunk: string) => void
      /**
       * Seed the empty-chat home surface so its states can be inspected with no
       * live backend: the fresh-draft latch, a recents list, a project, an
       * account display name. `introReset()` puts all of them back.
       */
      introSetup: (opts?: { displayName?: string; projects?: number; sessions?: number }) => void
      introReset: () => void
      /**
       * Put the synthetic sidebar rows seeded by `introSetup` into their real
       * states — selected, running, waiting on the user — by writing the atoms
       * the rows actually read. Lets the navigation chrome be inspected with no
       * live backend. `sidebarReset()` clears the published states.
       */
      sidebarSetup: (opts?: { attentionIndex?: number; selectedIndex?: number; workingIndex?: number }) => void
      sidebarReset: () => void
      reset: () => void
      snapshotMsgs: () => number
    }
  }
}

if (typeof window !== 'undefined' && !window.__PERF_PROBE__) {
  const samples: Sample[] = []
  window.__PERF_PROBE__ = {
    samples,
    enabled: false,
    clear: () => {
      samples.length = 0
    },
    summary: () => {
      const byId = new Map<string, number[]>()

      for (const s of samples) {
        const k = `${s.id}:${s.phase}`
        const arr = byId.get(k) ?? []
        arr.push(s.actualDuration)
        byId.set(k, arr)
      }

      const out: Record<string, { count: number; total: number; max: number; p50: number; p95: number }> = {}

      for (const [k, arr] of byId) {
        arr.sort((a, b) => a - b)
        const total = arr.reduce((a, b) => a + b, 0)
        out[k] = {
          count: arr.length,
          total: Math.round(total * 100) / 100,
          max: Math.round(arr[arr.length - 1] * 100) / 100,
          p50: Math.round(arr[Math.floor(arr.length * 0.5)] * 100) / 100,
          p95: Math.round(arr[Math.floor(arr.length * 0.95)] * 100) / 100
        }
      }

      return out
    }
  }
}

const onRender: ProfilerOnRenderCallback = (id, phase, actualDuration, baseDuration, startTime, commitTime) => {
  const probe = typeof window !== 'undefined' ? window.__PERF_PROBE__ : undefined

  if (!probe || !probe.enabled) {
    return
  }

  probe.samples.push({ id, phase, actualDuration, baseDuration, startTime, commitTime })

  if (probe.samples.length > 5000) {
    probe.samples.splice(0, probe.samples.length - 5000)
  }
}

if (typeof window !== 'undefined' && !window.__PERF_DRIVE__) {
  // Synthetic stream driver — pushes tokens through the live $messages atom so the
  // assistant-ui runtime + react tree sees them exactly as a real LLM stream would.
  // Driven by the perf harness (scripts/perf/) when no live LLM credit is available.
  let baseline: ReturnType<typeof $messages.get> | null = null
  let activeHandle: SyntheticDriverHandle | null = null

  let rightPaneBaseline: null | {
    activeTerminalId: null | string
    cwd: string
    repoStatusByCwd: ReturnType<typeof $repoStatusByCwd.get>
    takeover: boolean
    terminals: readonly TerminalEntry[]
  } = null

  const stop = () => {
    activeHandle = null
    setBusy(false)
  }

  const resetRightPane = () => {
    if (!rightPaneBaseline) {
      return
    }

    setTerminalTakeover(rightPaneBaseline.takeover)
    $terminals.set(rightPaneBaseline.terminals)
    $activeTerminalId.set(rightPaneBaseline.activeTerminalId)
    $repoStatusByCwd.set(rightPaneBaseline.repoStatusByCwd)
    setCurrentCwdTransient(rightPaneBaseline.cwd)
    rightPaneBaseline = null
  }

  // One synthetic turn's worth of mixed markdown — prose, a list, a fenced
  // code block, inline code, a link, and a short table — so a loaded transcript
  // exercises the same render cost (Streamdown blocks, code cards) a real one
  // would. Kept deterministic (seeded by index) so runs are comparable.
  const syntheticTurn = (i: number): ReturnType<typeof $messages.get> => {
    const user = {
      id: `perf-u-${i}`,
      role: 'user' as const,
      parts: [
        { type: 'text' as const, text: `Question ${i}: how does the widget in module ${i} handle back-pressure?` }
      ],
      timestamp: Date.now()
    }

    const assistant = {
      id: `perf-a-${i}`,
      role: 'assistant' as const,
      parts: [
        {
          type: 'text' as const,
          text: [
            `## Answer ${i}`,
            '',
            `The widget buffers writes and applies a bounded queue. Key points for module \`${i}\`:`,
            '',
            '- It coalesces bursts into a single flush.',
            '- Back-pressure propagates via a `Promise` that resolves on drain.',
            '- See [the design note](https://example.com/design) for the state machine.',
            '',
            '```ts',
            `function flush${i}(items: number[]) {`,
            '  return items.reduce((a, b) => a + b, 0)',
            '}',
            '```',
            '',
            '| stage | cost |',
            '|---|---|',
            '| enqueue | O(1) |',
            '| flush | O(n) |',
            ''
          ].join('\n')
        }
      ],
      timestamp: Date.now(),
      pending: false
    }

    return [user, assistant]
  }

  // Home-surface driver. Everything it touches is an ordinary store atom set to
  // a synthetic value — the same trick `rightPaneSetup` uses — so the intro's
  // states can be captured with the gateway closed.
  const introBaseline = {
    account: $keycloakAccount.get(),
    fresh: $freshDraftReady.get(),
    onboarding: $desktopOnboarding.get(),
    projects: $projectTree.get(),
    sessions: $sessions.get()
  }

  const syntheticSessions = (count: number): SessionInfo[] =>
    Array.from({ length: count }, (_, i) => ({
      ended_at: null,
      id: `perf-session-${i}`,
      is_active: false,
      last_active: Math.floor(Date.now() / 1000) - i * 3600,
      message_count: 8,
      model: null,
      preview: null,
      source: null,
      started_at: Math.floor(Date.now() / 1000) - i * 7200,
      title: i === 0 ? 'Wire the settings search field' : `Synthetic session ${i}`
    })) as unknown as SessionInfo[]

  window.__PERF_DRIVE__ = {
    introReset: () => {
      $desktopOnboarding.set(introBaseline.onboarding)
      $freshDraftReady.set(introBaseline.fresh)
      $keycloakAccount.set(introBaseline.account)
      $projectTree.set(introBaseline.projects)
      $sessions.set(introBaseline.sessions)
    },
    sidebarReset: () => {
      clearAllSessionStates()
      $selectedStoredSessionId.set(null)
    },
    sidebarSetup: ({ attentionIndex, selectedIndex, workingIndex } = {}) => {
      if (selectedIndex !== undefined) {
        $selectedStoredSessionId.set(`perf-session-${selectedIndex}`)
      }

      const mark = (index: number | undefined, patch: Partial<ClientSessionState>) => {
        if (index === undefined) {
          return
        }

        const storedSessionId = `perf-session-${index}`
        publishSessionState(`perf-runtime-${index}`, {
          ...createClientSessionState(storedSessionId),
          ...patch
        })
      }

      mark(workingIndex, { busy: true })
      mark(attentionIndex, { needsInput: true })
    },
    introSetup: ({ displayName = '', projects = 0, sessions = 0 } = {}) => {
      $desktopOnboarding.set({ ...$desktopOnboarding.get(), configured: true, manual: false })
      $freshDraftReady.set(true)
      $keycloakAccount.set({ ...$keycloakAccount.get(), displayName, loaded: true })
      $sessions.set(syntheticSessions(sessions))
      $projectTree.set(
        Array.from({ length: projects }, (_, i) => ({
          id: `perf-project-${i}`,
          label: i === 0 ? 'agentx-workmate' : `project-${i}`,
          lastActive: Math.floor(Date.now() / 1000) - i * 3600,
          path: `/perf/project-${i}`,
          repos: [],
          sessionCount: 3
        }))
      )
    },
    snapshotMsgs: () => $messages.get().length,
    connected: () => {
      try {
        return $gateway.get()?.connectionState === 'open'
      } catch {
        return false
      }
    },
    rightPaneGit: (path, kind = 'modified') => {
      const file = {
        conflicted: kind === 'conflicted',
        path,
        staged: false,
        unstaged: kind === 'modified',
        untracked: kind === 'added'
      }

      const cwd = $currentCwd.get().trim()
      $repoStatusByCwd.set({
        ...$repoStatusByCwd.get(),
        [cwd]: {
          added: 0,
          ahead: 0,
          behind: 0,
          branch: 'perf',
          changed: 1,
          conflicted: kind === 'conflicted' ? 1 : 0,
          defaultBranch: 'main',
          detached: false,
          files: [file],
          removed: 0,
          staged: 0,
          unstaged: kind === 'modified' ? 1 : 0,
          untracked: kind === 'added' ? 1 : 0
        }
      })
    },
    rightPaneReset: resetRightPane,
    rightPaneSelect: selectTerminal,
    rightPaneSetup: ({ cwd, terminals = 3 }) => {
      resetRightPane()
      rightPaneBaseline = {
        activeTerminalId: $activeTerminalId.get(),
        cwd: $currentCwd.get(),
        repoStatusByCwd: $repoStatusByCwd.get(),
        takeover: $terminalTakeover.get(),
        terminals: $terminals.get()
      }

      setCurrentCwdTransient(cwd)
      const terminalIds = [createTerminal(cwd)]
      let procId = ''

      for (let index = 1; index < Math.max(1, terminals); index += 1) {
        procId = `right-pane-perf-${Date.now()}-${index}`
        const id = ensureAgentTerminal(procId, `perf output ${index}`)

        if (id) {
          terminalIds.push(id)
        }
      }

      if (procId) {
        selectTerminal(terminalIds.at(-1) ?? terminalIds[0])
      }

      setTerminalTakeover(true)

      return { procId, terminalIds }
    },
    rightPaneWrite: (procId, chunk) => writeAgentTerminalChunk(procId, chunk),
    loadTranscript: (turns = 200) => {
      if (!baseline) {
        baseline = $messages.get()
      }

      const next: ReturnType<typeof $messages.get> = []

      for (let i = 0; i < turns; i += 1) {
        next.push(...syntheticTurn(i))
      }

      const t0 = performance.now()
      setMessages(next)

      return new Promise<number>(resolve => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve(performance.now() - t0)
          })
        })
      })
    },
    reset: () => {
      activeHandle?.stop()
      resetRightPane()

      if (baseline) {
        setMessages(baseline)
      }

      baseline = null
      setBusy(false)
    },
    stream: ({
      chunk = 'word ',
      intervalMs = 16,
      totalTokens = 400,
      // Mimic `use-message-stream.scheduleDeltaFlush` — batch token deltas
      // into at-most one $messages update every `flushMinMs` ms, exactly as
      // the real gateway path does. With this on, the synthetic harness's
      // numbers actually reflect what a real LLM stream of the same token
      // rate would feel like. Set to 0 to bypass and apply every token
      // immediately (worst-case).
      flushMinMs = 0
    }: { chunk?: string; intervalMs?: number; totalTokens?: number; flushMinMs?: number } = {}) => {
      activeHandle?.stop()
      const current = $messages.get()

      if (!baseline) {
        baseline = current
      }

      const msgId = `synthetic-${Date.now()}`
      // Seed an empty assistant message — assistant-ui will see it grow.
      setMessages([
        ...current,
        {
          id: msgId,
          role: 'assistant',
          parts: [{ type: 'text', text: '' }],
          timestamp: Date.now(),
          pending: true
        }
      ])
      setBusy(true)

      let pushed = 0
      let pendingDelta = ''
      let lastFlushAt = 0
      let timer: ReturnType<typeof setTimeout> | null = null
      let flushHandle: number | null = null

      const applyDelta = (delta: string) => {
        if (!delta) {
          return
        }

        setMessages(prev =>
          prev.map(m => {
            if (m.id !== msgId) {
              return m
            }

            const head = m.parts.slice(0, -1)
            const last = m.parts.at(-1)
            const lastText = last && last.type === 'text' ? last.text : ''

            return {
              ...m,
              parts: [...head, { type: 'text', text: lastText + delta }]
            }
          })
        )
      }

      const flushNow = () => {
        flushHandle = null
        lastFlushAt = performance.now()
        const delta = pendingDelta
        pendingDelta = ''
        applyDelta(delta)
      }

      const scheduleFlush = () => {
        if (flushHandle !== null) {
          return
        }

        if (flushMinMs <= 0) {
          flushNow()

          return
        }

        const since = performance.now() - lastFlushAt
        const wait = Math.max(0, flushMinMs - since)
        flushHandle =
          wait <= 0 && typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame(flushNow)
            : (setTimeout(flushNow, wait) as unknown as number)
      }

      const handle: SyntheticDriverHandle = {
        stop: () => {
          if (timer) {
            clearTimeout(timer)
          }

          timer = null

          if (flushHandle !== null) {
            clearTimeout(flushHandle)
            cancelAnimationFrame?.(flushHandle)
          }

          flushHandle = null

          if (pendingDelta) {
            applyDelta(pendingDelta)
            pendingDelta = ''
          }

          activeHandle = null
          // Mark message finalized.
          setMessages(prev => prev.map(m => (m.id === msgId ? { ...m, pending: false } : m)))
          setBusy(false)
        }
      }

      activeHandle = handle

      const tick = () => {
        if (activeHandle !== handle) {
          return
        }

        if (pushed >= totalTokens) {
          if (pendingDelta) {
            flushNow()
          }

          handle.stop()

          return
        }

        pushed += 1

        if (flushMinMs > 0) {
          pendingDelta += chunk
          scheduleFlush()
        } else {
          applyDelta(chunk)
        }

        timer = setTimeout(tick, intervalMs)
      }

      timer = setTimeout(tick, intervalMs)

      return handle
    }
  }

  // Suppress dead-import warning.
  void stop
}

export function PerfProbe({ id, children }: { id: string; children: ReactNode }) {
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  )
}
