import './styles.css'

import { useStore } from '@nanostores/react'
import { type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

import { usePaneVisible } from '@/components/pane-shell/pane-visibility'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { DiffCount } from '@/components/ui/diff-count'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { deliverableKind, fileExtension } from '@/lib/deliverables'
import { statDesktopFile } from '@/lib/desktop-fs'
import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { openArtifact, upsertArtifact } from '@/store/artifacts'
import { registerRepoStatusCwd, repoStatusForCwd } from '@/store/coding-status'
import { openPreview } from '@/store/preview'
import { $activeGatewayProfile } from '@/store/profile'
import { revealReview } from '@/store/review'

import { requestComposerInsert } from '../composer/focus'
import { useComposerScope } from '../composer/scope'
import { useSessionView } from '../session-view'

import {
  createSessionResourceCollector,
  type SessionResource,
  type SessionResourceCollector,
  type SessionResourceProgress
} from './model'
import { useFilePresence } from './presence'
import { $sessionResourcesPinned, setSessionResourcesPinned } from './store'

/** The chat is wide enough to give the card its own column at this width.
 *  Narrower, the card can only float over the conversation — so it is shown
 *  on request, never by default. */
const DOCK_MIN_WIDTH = 1040

/** How long one reading pass may hold the main thread. A long history is read
 *  over several passes, newest messages first. */
const READ_BUDGET_MS = 8

/** While a reply streams, reread its growing row at most this often. */
const STREAM_REREAD_MS = 200

interface SessionWorkspaceProps {
  children: ReactNode
  enabled: boolean
  /** This surface has a composer to write into (not a read-only conversation). */
  canCompose?: boolean
  sessionKey?: string
  onAddSource?: () => void
}

interface ResourcesContentProps {
  progress: SessionResourceProgress
  cwd: string
  sessionId: string
  onMissing: (id: string) => void
  onCreateOutput?: () => void
  onAddSource?: () => void
}

interface ResourceRowProps {
  cwd: string
  sessionId: string
  item: SessionResource
  onMissing: (id: string) => void
  output: boolean
}

/**
 * The conversation with its resources card. Wide: the card is docked beside
 * the transcript and follows one remembered choice. Narrow: it floats over
 * the transcript only while asked for, and steps aside when the conversation
 * is touched again.
 */
export function SessionWorkspace({
  children,
  enabled,
  canCompose = true,
  sessionKey,
  onAddSource
}: SessionWorkspaceProps) {
  const { t } = useI18n()
  const view = useSessionView()
  const storedId = useStore(view.$storedId)
  const runtimeId = useStore(view.$runtimeId)
  const messagesEmpty = useStore(view.$messagesEmpty)
  const cwd = useStore(view.$cwd)
  const profile = useStore($activeGatewayProfile)
  const pinned = useStore($sessionResourcesPinned)
  const scope = useComposerScope()
  const rootRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const docked = useDockedLayout(rootRef)
  const panelId = useId()
  const countId = useId()
  const resourcesEnabled = enabled && Boolean(storedId || runtimeId) && !messagesEmpty
  const key = `${profile}:${sessionKey || storedId || runtimeId || 'draft'}`
  const sessionId = storedId || runtimeId || ''

  // The floating card is asked for, in one conversation, while the chat is
  // narrow. Leaving either puts it away, so coming back never finds it open.
  const [floating, setFloating] = useState({ key, open: false })

  if (floating.open && (docked || floating.key !== key)) {
    setFloating({ key, open: false })
  }

  const expanded = docked ? pinned : floating.open && floating.key === key

  // Kept across collapses: reopening the card rereads nothing it already read.
  // A new conversation or folder starts clean: key and cwd are its identity.
  const collector = useMemo(createSessionResourceCollector, [key, cwd])
  // Read while the card is closed too: the closed launcher says how many
  // results there are, so a narrow window still shows that a file was made.
  const read = useResources(collector, cwd, resourcesEnabled ? sessionId : '')
  // Files deleted or moved away since leave the list (the transcript keeps
  // its record of them).
  const listed = useMemo(() => [...read.resources.outputs, ...read.resources.sources], [read.resources])
  const paneVisible = usePaneVisible()
  const presence = useFilePresence(listed, resourcesEnabled && paneVisible)

  const progress = useMemo(() => {
    if (!presence.missing.size) {
      return read
    }

    const present = (item: SessionResource) => !presence.missing.has(item.id)

    return {
      ...read,
      resources: { outputs: read.resources.outputs.filter(present), sources: read.resources.sources.filter(present) }
    }
  }, [presence.missing, read])

  const outputCount = progress.resources.outputs.length

  const setExpanded = (next: boolean) => {
    if (docked) {
      setSessionResourcesPinned(next)
    } else {
      setFloating({ key, open: next })
    }
  }

  const collapse = () => {
    setExpanded(false)
    toggleRef.current?.focus()
  }

  const floatingOpen = resourcesEnabled && expanded && !docked

  useEffect(() => {
    const root = rootRef.current

    if (!floatingOpen || !root) {
      return
    }

    // Touching the conversation it covers puts the floating card away. The
    // viewer beside the chat is outside this element, so opening one file
    // after another keeps the list in reach.
    const dismiss = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null

      if (!target?.closest('.session-resources-card, .session-resources-launcher')) {
        setFloating(current => ({ ...current, open: false }))
      }
    }

    root.addEventListener('pointerdown', dismiss, true)

    return () => root.removeEventListener('pointerdown', dismiss, true)
  }, [floatingOpen])

  return (
    <div
      className="session-workspace"
      data-layout={docked ? 'docked' : 'floating'}
      data-resources={resourcesEnabled}
      data-resources-expanded={expanded}
      ref={rootRef}
    >
      <div className="session-conversation">{children}</div>
      {resourcesEnabled && (
        <>
          <div className="session-resources-launcher">
            <Tip label={expanded ? t.common.collapse : t.sessionResources.title}>
              <Button
                aria-controls={panelId}
                aria-describedby={!expanded && outputCount > 0 ? countId : undefined}
                aria-expanded={expanded}
                aria-label={t.sessionResources.title}
                data-active={expanded}
                onClick={() => setExpanded(!expanded)}
                onKeyDown={event => {
                  if (event.key === 'Escape' && expanded) {
                    event.stopPropagation()
                    collapse()
                  }
                }}
                ref={toggleRef}
                size="icon-sm"
                variant="ghost"
              >
                <svg
                  aria-hidden="true"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeWidth="1.5"
                  viewBox="0 0 20 20"
                >
                  <circle cx="4" cy="5" r="1.5" />
                  <circle cx="4" cy="15" r="1.5" />
                  <path d="M10 5h7M10 10h7M10 15h7M2.5 10h3" />
                </svg>
                {!expanded && outputCount > 0 && (
                  <>
                    <span aria-hidden="true" className="session-resources-count" data-testid="session-resources-count">
                      {outputCount > 99 ? '99+' : outputCount}
                    </span>
                    <span className="sr-only" id={countId}>
                      {`${t.sessionResources.outputs}: ${outputCount}`}
                    </span>
                  </>
                )}
              </Button>
            </Tip>
          </div>
          {expanded && (
            <div
              aria-label={t.sessionResources.title}
              className="session-resources-card shadow-md"
              data-testid="session-resources"
              id={panelId}
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  collapse()
                }
              }}
              role="complementary"
            >
              <ResourcesContent
                cwd={cwd}
                key={`${key}:${cwd}`}
                onAddSource={onAddSource}
                onCreateOutput={
                  canCompose
                    ? () =>
                        requestComposerInsert(t.sessionResources.createOutputPrompt, {
                          mode: 'block',
                          once: true,
                          target: scope.target
                        })
                    : undefined
                }
                onMissing={presence.markMissing}
                progress={progress}
                sessionId={sessionId}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Whether the chat is wide enough to dock the card. The one place that
 *  decides it: the stylesheet lays out from the attribute this drives. */
function useDockedLayout(ref: RefObject<HTMLElement | null>): boolean {
  const [docked, setDocked] = useState(true)

  useLayoutEffect(() => {
    const element = ref.current

    if (!element) {
      return
    }

    // An unmeasured box (hidden, or no layout engine) counts as wide: the
    // docked card covers nothing, so it is the safe reading.
    const measure = () => element.clientWidth === 0 || element.clientWidth >= DOCK_MIN_WIDTH
    let current = measure()

    setDocked(current)

    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(() => {
      const next = measure()

      if (next !== current) {
        current = next
        // Before this frame paints: a viewer opening beside the chat must not
        // show one frame of a docked card squeezing a narrow transcript.
        flushSync(() => setDocked(next))
      }
    })

    observer.observe(element)

    return () => observer.disconnect()
  }, [ref])

  return docked
}

const NOTHING_READ: SessionResourceProgress = { complete: false, resources: { outputs: [], sources: [] } }
const NOTHING: SessionResourceProgress = { complete: true, resources: { outputs: [], sources: [] } }

function useResources(collector: SessionResourceCollector, cwd: string, sessionId: string): SessionResourceProgress {
  const view = useSessionView()
  const visible = usePaneVisible()
  // Tied to the collector it came from: a new conversation or folder starts
  // from nothing read, never from the last one's list.
  const [state, setState] = useState({ collector, progress: NOTHING_READ })
  const progress = state.collector === collector ? state.progress : NOTHING_READ

  // Layout effect: the first pass lands before the card's first paint, so a
  // conversation that fits the budget never flashes an empty card.
  useLayoutEffect(() => {
    if (!visible || !sessionId) {
      return
    }

    let nextPass: ReturnType<typeof setTimeout> | undefined
    let reread: ReturnType<typeof setTimeout> | undefined
    let started = false

    const read = () => {
      clearTimeout(nextPass)
      nextPass = undefined

      const next = collector.step(view.$messages.get(), cwd, READ_BUDGET_MS)

      setState(current =>
        current.collector === collector &&
        current.progress.resources === next.resources &&
        current.progress.complete === next.complete
          ? current
          : { collector, progress: next }
      )

      if (!next.complete) {
        // Yield, then carry on with the older messages.
        nextPass = setTimeout(read, 0)
      }
    }

    const unsubscribe = view.$messages.subscribe(messages => {
      if (!started || !messages.some(message => message.pending)) {
        started = true
        clearTimeout(reread)
        reread = undefined
        read()
      } else if (!reread) {
        reread = setTimeout(() => {
          reread = undefined
          read()
        }, STREAM_REREAD_MS)
      }
    })

    return () => {
      unsubscribe()
      clearTimeout(nextPass)
      clearTimeout(reread)
    }
  }, [collector, cwd, sessionId, view.$messages, visible])

  // A draft may inherit a folder, but never the outgoing conversation's data.
  // Guard in render too: the view atoms can clear on different transition edges.
  return sessionId ? progress : NOTHING
}

function ResourcesContent({ progress, cwd, sessionId, onCreateOutput, onAddSource, onMissing }: ResourcesContentProps) {
  const { t } = useI18n()
  const copy = t.sessionResources
  const { complete, resources } = progress
  const status = useStore(repoStatusForCwd(sessionId ? cwd : null))
  const visible = usePaneVisible()
  useEffect(() => (visible && sessionId ? registerRepoStatusCwd(cwd) : undefined), [cwd, sessionId, visible])

  const add = { outputs: onCreateOutput, sources: onAddSource }
  const addLabel = { outputs: copy.createOutput, sources: copy.addSource }

  return (
    <div className="session-resources-content">
      {/* A clean folder has nothing to review, so it has no row. */}
      {status && status.changed > 0 && (
        <div className="session-resources-changes">
          <div className="session-resources-project">{cwd.split(/[\\/]/).filter(Boolean).pop()}</div>
          <Tip label={copy.changesHint}>
            <button className="session-resource-row" onClick={() => revealReview(cwd)} type="button">
              <Codicon name="diff-added" />
              <span className="session-resource-label">{copy.changes}</span>
              <DiffCount added={status.added} removed={status.removed} />
            </button>
          </Tip>
        </div>
      )}
      <div className="session-resources-scroll">
        {(['outputs', 'sources'] as const).map(section => (
          <section aria-label={copy[section]} className="session-resources-section" key={section}>
            <div className="session-resources-section-heading">
              <h3>{copy[section]}</h3>
              {add[section] && (
                <Tip label={addLabel[section]}>
                  <Button aria-label={addLabel[section]} onClick={add[section]} size="icon-xs" variant="ghost">
                    <Codicon name="add" />
                  </Button>
                </Tip>
              )}
            </div>
            {resources[section].length ? (
              <ul>
                {resources[section].map(item => (
                  <ResourceRow
                    cwd={cwd}
                    item={item}
                    key={item.id}
                    onMissing={onMissing}
                    output={section === 'outputs'}
                    sessionId={sessionId}
                  />
                ))}
              </ul>
            ) : section === 'outputs' && onCreateOutput && complete ? (
              // Only once the whole history is read: "nothing yet" must be true.
              <button className="session-resources-empty-action" onClick={onCreateOutput} type="button">
                {copy.createOutput}
              </button>
            ) : null}
          </section>
        ))}
      </div>
    </div>
  )
}

function ResourceRow({ item, cwd, sessionId, output, onMissing }: ResourceRowProps) {
  const { t } = useI18n()
  const view = useSessionView()
  const [opening, setOpening] = useState(false)
  const [failed, setFailed] = useState(false)
  const alive = useRef(true)
  // Lifecycle flag only; session/profile identity is read from its owning atoms.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    alive.current = true

    return () => {
      alive.current = false
    }
  }, [])

  const open = async () => {
    if (opening) {
      return
    }

    setOpening(true)
    setFailed(false)
    const runtimeId = view.$runtimeId.get()
    const storedId = view.$storedId.get()
    const profile = $activeGatewayProfile.get()

    // A file probe may finish after a session/profile switch or a row's removal.
    const stale = () =>
      !alive.current ||
      view.$runtimeId.get() !== runtimeId ||
      view.$storedId.get() !== storedId ||
      $activeGatewayProfile.get() !== profile ||
      view.$cwd.get() !== cwd

    try {
      if (item.dataUrl) {
        openPreview(
          {
            kind: 'file',
            label: item.label,
            source: item.id,
            url: item.id,
            previewKind: 'image',
            dataUrl: item.dataUrl
          },
          'explicit-link'
        )
      } else if (item.artifact) {
        const record = upsertArtifact(sessionId, item.artifact.detection, item.artifact.content)

        if (!record) {
          throw new Error('Missing artifact')
        }

        openArtifact(record.artifactId)
      } else {
        const target = await normalizeOrLocalPreviewTarget(item.target, cwd)

        if (stale()) {
          return
        }

        if (!target) {
          throw new Error('Missing target')
        }

        if (target.kind === 'file' && target.path) {
          // Say so here, in the row: a viewer tab opened on a file that is
          // gone only has a raw read error to show. No answer (an older shell)
          // is not a "no".
          const stat = await statDesktopFile(target.path).catch(() => null)

          if (stale()) {
            return
          }

          if (stat && !(stat.exists && stat.isFile)) {
            if (stat.exists) {
              setFailed(true)
            } else {
              // Gone: the row leaves the list rather than offer a dead click.
              onMissing(item.id)
            }

            return
          }
        }

        openPreview(target, 'explicit-link')
      }
    } catch {
      if (alive.current) {
        setFailed(true)
      }
    } finally {
      if (alive.current) {
        setOpening(false)
      }
    }
  }

  const icon = item.kind === 'url' ? 'link' : deliverableKind(item.label) === 'image' ? 'file-media' : 'files'
  // The extension itself, not a word for it: short, and the same in every language.
  const extension = item.kind === 'file' ? fileExtension(item.label) : ''
  const typeLabel = extension.length <= 4 ? extension.toUpperCase() : ''

  return (
    <li>
      <Tip label={item.kind === 'artifact' || item.dataUrl ? item.label : item.target}>
        <button
          aria-busy={opening}
          className="session-resource-row"
          data-output={output}
          disabled={opening}
          onClick={() => void open()}
          type="button"
        >
          <Codicon name={opening ? 'loading' : icon} spinning={opening} />
          <span className="session-resource-label">{item.label}</span>
          {item.folder && <span className="session-resource-folder">{item.folder}</span>}
          {output && typeLabel && (
            <span aria-hidden="true" className="session-resource-type">
              {typeLabel}
            </span>
          )}
        </button>
      </Tip>
      {failed && (
        <p className="session-resource-error" role="alert">
          {t.sessionResources.openFailed}
        </p>
      )}
    </li>
  )
}
