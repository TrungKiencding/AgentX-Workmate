import { type ReactNode, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { ArrowLeft, ArrowRight, ExternalLink } from '@/lib/icons'
import { readKey, writeKey } from '@/lib/storage'
import type { MessagingEnvVarInfo } from '@/types/hermes'

const DOCS_URL = 'https://agentx-landingpage.astralx.com.vn/docs/kenh-tin-nhan/'

export function messagingGuideUrl(platformId: string): string {
  const anchor = ['telegram', 'whatsapp', 'email', 'slack', 'discord', 'sms'].includes(platformId)
    ? platformId
    : 'kenh-khac'

  return `${DOCS_URL}#${anchor}`
}

export interface GuideStep {
  id: string
  kind: 'prepare' | 'field' | 'connect' | 'test'
  field?: MessagingEnvVarInfo
}

/** Learning a form is a device-wide presentation preference, independent of
 * credentials/profiles. Only a seen marker is stored; never field values. */
export function useSetupGuide(platformId: string, fields: MessagingEnvVarInfo[]) {
  const storageKey = `agentx-desktop:global:messaging-guide:v1:${platformId}`
  const [activeId, setActiveId] = useState<string | null>(() => (readKey(storageKey) === 'seen' ? null : 'prepare'))

  const steps: GuideStep[] = [
    { id: 'prepare', kind: 'prepare' },
    ...fields.map(field => ({ id: field.key, kind: 'field' as const, field })),
    { id: 'connect', kind: 'connect' },
    { id: 'test', kind: 'test' }
  ]

  const index = Math.max(
    0,
    steps.findIndex(step => step.id === activeId)
  )

  useEffect(() => {
    if (activeId !== null) {
      writeKey(storageKey, 'seen')
    }
  }, [activeId, storageKey])

  return {
    step: activeId === null ? null : steps[index],
    index,
    total: steps.length,
    open: (id = 'prepare') => setActiveId(id),
    close: () => setActiveId(null),
    back: () => setActiveId(steps[Math.max(0, index - 1)].id),
    next: () => setActiveId(steps[index + 1]?.id ?? null)
  }
}

interface SetupGuideProps {
  children: ReactNode
  title: string
  body: string
  guide: ReturnType<typeof useSetupGuide>
  onDocs: () => void
}

/** An in-flow coach, so the real form remains usable without a blocking tour
 * overlay, scroll tracking, timers, or a second copy of any credential. */
export function SetupGuide({ children, title, body, guide, onDocs }: SetupGuideProps) {
  const { t } = useI18n()
  const g = t.messaging.guide
  const regionRef = useRef<HTMLElement>(null)

  function move(action: () => void) {
    // Focus stays at the coach when its form field unmounts between steps.
    regionRef.current?.focus({ preventScroll: true })
    action()
  }

  return (
    <section
      aria-label={g.title}
      className="min-w-0 border-s-2 border-(--accent) ps-4"
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          guide.close()
        }
      }}
      ref={regionRef}
      tabIndex={-1}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p aria-live="polite" className="text-xs text-(--text-secondary)">
          {g.progress(guide.index + 1, guide.total)}
        </p>
        <Button onClick={guide.close} size="sm" variant="ghost">
          {g.skip}
        </Button>
      </div>
      <div
        className="grid min-w-0 gap-4 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-(--dur-short) motion-safe:[animation-timing-function:var(--ease-out)]"
        key={guide.step?.id}
      >
        <div className="grid gap-2">
          <h4 className="text-md font-semibold text-(--text-primary)">{title}</h4>
          <p className="whitespace-pre-line text-sm leading-relaxed text-(--text-secondary)">{body}</p>
        </div>
        {children}
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <Button onClick={onDocs} size="inline" variant="textStrong">
          {g.docs}
          <ExternalLink aria-hidden className="size-3.5" />
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Button disabled={guide.index === 0} onClick={() => move(guide.back)} size="sm" variant="ghost">
            <ArrowLeft aria-hidden className="rtl:rotate-180" />
            {t.common.back}
          </Button>
          <Button onClick={() => move(guide.next)} size="sm">
            {guide.index === guide.total - 1 ? g.finish : t.common.continue}
            <ArrowRight aria-hidden className="rtl:rotate-180" />
          </Button>
        </div>
      </div>
    </section>
  )
}
