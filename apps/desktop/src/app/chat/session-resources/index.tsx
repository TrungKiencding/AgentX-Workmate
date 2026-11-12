import './styles.css'

import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'

import { usePaneVisible } from '@/components/pane-shell/pane-visibility'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { DiffCount } from '@/components/ui/diff-count'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { deliverableKind, fileExtension } from '@/lib/deliverables'
import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { openArtifact, upsertArtifact } from '@/store/artifacts'
import { registerRepoStatusCwd, repoStatusForCwd } from '@/store/coding-status'
import { openPreview } from '@/store/preview'
import { $activeGatewayProfile } from '@/store/profile'
import { revealReview } from '@/store/review'

import { requestComposerInsert } from '../composer/focus'
import { useComposerScope } from '../composer/scope'
import { useSessionView } from '../session-view'

import { createSessionResourceCollector, type SessionResource, type SessionResources } from './model'

interface SessionWorkspaceProps {
  children: ReactNode
  enabled: boolean
  sessionKey?: string
  onAddSource?: () => void
}

interface ResourcesContentProps {
  cwd: string
  sessionId: string
  onCreateOutput: () => void
  onAddSource?: () => void
}

interface ResourceRowProps {
  cwd: string
  sessionId: string
  item: SessionResource
  output: boolean
}

/** A single floating card and a single toggle, independent of viewer width. */
export function SessionWorkspace({ children, enabled, sessionKey, onAddSource }: SessionWorkspaceProps) {
  const { t } = useI18n()
  const view = useSessionView()
  const storedId = useStore(view.$storedId)
  const runtimeId = useStore(view.$runtimeId)
  const messagesEmpty = useStore(view.$messagesEmpty)
  const cwd = useStore(view.$cwd)
  const profile = useStore($activeGatewayProfile)
  const scope = useComposerScope()
  const resourcesEnabled = enabled && Boolean(storedId || runtimeId) && !messagesEmpty
  const key = `${profile}:${sessionKey || storedId || runtimeId || 'draft'}`
  const [visibility, setVisibility] = useState({ key, expanded: true })

  if (visibility.key !== key) {
    setVisibility({ key, expanded: true })
  }

  const expanded = visibility.key !== key || visibility.expanded
  const panelId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)

  const collapse = () => {
    setVisibility({ key, expanded: false })
    toggleRef.current?.focus()
  }

  return (
    <div className="session-workspace" data-resources={resourcesEnabled} data-resources-expanded={expanded}>
      <div className="session-conversation">{children}</div>
      {resourcesEnabled && (
        <>
          <div className="session-resources-launcher">
            <Tip label={expanded ? t.common.collapse : t.sessionResources.title}>
              <Button
                aria-controls={panelId}
                aria-expanded={expanded}
                aria-label={t.sessionResources.title}
                data-active={expanded}
                onClick={() => setVisibility({ key, expanded: !expanded })}
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
                onCreateOutput={() =>
                  requestComposerInsert(t.sessionResources.createOutput, { mode: 'inline', target: scope.target })
                }
                sessionId={storedId || runtimeId || ''}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}

const EMPTY_RESOURCES: SessionResources = { outputs: [], sources: [] }

function useResources(cwd: string, sessionId: string): SessionResources {
  const view = useSessionView()
  const visible = usePaneVisible()
  const collect = useMemo(createSessionResourceCollector, [])
  const [resources, setResources] = useState(() => (sessionId ? collect(view.$messages.get(), cwd) : EMPTY_RESOURCES))
  useEffect(() => {
    if (!visible || !sessionId) {
      return
    }

    let timer: ReturnType<typeof setTimeout> | undefined

    const publish = () => {
      timer = undefined
      setResources(collect(view.$messages.get(), cwd))
    }

    const unsubscribe = view.$messages.subscribe(messages => {
      if (!messages.some(message => message.pending)) {
        clearTimeout(timer)
        publish()
      } else if (!timer) {
        timer = setTimeout(publish, 200)
      }
    })

    return () => {
      unsubscribe()
      clearTimeout(timer)
    }
  }, [collect, cwd, sessionId, view.$messages, visible])

  // A draft may inherit a folder, but never the outgoing conversation's data.
  // Guard in render too: the view atoms can clear on different transition edges.
  return sessionId ? resources : EMPTY_RESOURCES
}

function ResourcesContent({ cwd, sessionId, onCreateOutput, onAddSource }: ResourcesContentProps) {
  const { t } = useI18n()
  const copy = t.sessionResources
  const resources = useResources(cwd, sessionId)
  const status = useStore(repoStatusForCwd(sessionId ? cwd : null))
  const visible = usePaneVisible()
  useEffect(() => (visible && sessionId ? registerRepoStatusCwd(cwd) : undefined), [cwd, sessionId, visible])

  return (
    <div className="session-resources-content">
      {status && (
        <div className="session-resources-changes">
          <div className="session-resources-project">{cwd.split(/[\\/]/).filter(Boolean).pop()}</div>
          <button className="session-resource-row" onClick={() => revealReview(cwd)} type="button">
            <Codicon name="diff-added" />
            <span className="session-resource-label">{copy.changes}</span>
            <DiffCount added={status.added} removed={status.removed} />
          </button>
        </div>
      )}
      <div className="session-resources-scroll">
        {(['outputs', 'sources'] as const).map(section => (
          <section aria-label={copy[section]} className="session-resources-section" key={section}>
            <div className="session-resources-section-heading">
              <h3>{copy[section]}</h3>
              <Tip label={section === 'outputs' ? copy.createOutput : copy.addSource}>
                <Button
                  aria-label={section === 'outputs' ? copy.createOutput : copy.addSource}
                  disabled={section === 'sources' && !onAddSource}
                  onClick={section === 'outputs' ? onCreateOutput : onAddSource}
                  size="icon-xs"
                  variant="ghost"
                >
                  <Codicon name="add" />
                </Button>
              </Tip>
            </div>
            {resources[section].length ? (
              <ul>
                {resources[section].map(item => (
                  <ResourceRow
                    cwd={cwd}
                    item={item}
                    key={item.id}
                    output={section === 'outputs'}
                    sessionId={sessionId}
                  />
                ))}
              </ul>
            ) : section === 'outputs' ? (
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

function ResourceRow({ item, cwd, sessionId, output }: ResourceRowProps) {
  const { t } = useI18n()
  const view = useSessionView()
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState(false)
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
    setError(false)
    const runtimeId = view.$runtimeId.get()
    const storedId = view.$storedId.get()
    const profile = $activeGatewayProfile.get()

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

        // A file probe may finish after a session/profile switch or a row's removal.
        if (
          !alive.current ||
          view.$runtimeId.get() !== runtimeId ||
          view.$storedId.get() !== storedId ||
          $activeGatewayProfile.get() !== profile ||
          view.$cwd.get() !== cwd
        ) {
          return
        }

        if (!target) {
          throw new Error('Missing target')
        }

        openPreview(target, 'explicit-link')
      }
    } catch {
      if (alive.current) {
        setError(true)
      }
    } finally {
      if (alive.current) {
        setOpening(false)
      }
    }
  }

  const kind = deliverableKind(item.label)
  const icon = item.kind === 'url' ? 'link' : kind === 'image' ? 'file-media' : 'files'
  const extension = fileExtension(item.label)

  const typeLabel =
    kind === 'document'
      ? 'Doc'
      : kind === 'spreadsheet'
        ? 'Sheet'
        : kind === 'presentation'
          ? 'Slides'
          : extension.length <= 4
            ? extension.toUpperCase()
            : ''

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
          {output && typeLabel && (
            <span aria-hidden="true" className="session-resource-type">
              {typeLabel}
            </span>
          )}
        </button>
      </Tip>
      {error && (
        <p className="session-resource-error" role="alert">
          {t.sessionResources.openFailed}
        </p>
      )}
    </li>
  )
}
