import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import type { FC } from 'react'

import { WIDGET_SHELL_CLASS } from '@/components/chat/widget-shell'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { openExternalLink } from '@/lib/external-link'
import { ArrowUpRight } from '@/lib/icons'
import { cn } from '@/lib/utils'

import {
  dataHubFlagLabel,
  type DataHubPassage,
  type DataHubResult,
  formatDataHubLocation,
  formatDataHubVersion,
  parseDataHubResult,
  safeSourceUrl
} from './data-hub-sources-model'
import { ToolFallback } from './fallback'

const META_CLASS =
  'text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)'

function SourceCard({ passage }: { passage: DataHubPassage }) {
  const { t } = useI18n()
  const copy = t.assistant.tool.dataHub
  const url = safeSourceUrl(passage.openUrl)
  const title = passage.document.title || copy.untitled
  const version = formatDataHubVersion(passage.version)

  const meta = [passage.knowledgeBase.name, formatDataHubLocation(passage.location), version]
    .filter(Boolean)
    .join(' · ')

  return (
    <li className="flex min-w-0 items-start gap-2.5" data-slot="data-hub-source">
      {passage.ref && (
        <span className="mt-px shrink-0 rounded-(--radius-control) bg-muted/55 px-1.5 font-mono text-2xs leading-5 text-(--ui-text-secondary)">
          [{passage.ref}]
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground" title={passage.cite || title}>
          {title}
        </div>
        <div className={cn(META_CLASS, 'truncate')}>{meta}</div>
        {passage.flags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {passage.flags.map(flag => (
              <span
                className="rounded-full border border-(--ui-stroke-tertiary) px-1.5 text-2xs leading-4 text-(--ui-yellow)"
                data-flag={flag}
                key={flag}
              >
                {dataHubFlagLabel(flag)}
              </span>
            ))}
          </div>
        )}
      </div>
      {url && (
        <Button
          aria-label={copy.openSource(title)}
          className="shrink-0"
          onClick={() => openExternalLink(url)}
          size="xs"
          variant="ghost"
        >
          {copy.open}
          <ArrowUpRight aria-hidden />
        </Button>
      )}
    </li>
  )
}

/** The "Sources" panel under a Data Hub search: one card per passage. */
export function DataHubSources({ result }: { result: DataHubResult }) {
  const { t } = useI18n()
  const copy = t.assistant.tool.dataHub

  if (!result.passages.length) {
    return null
  }

  return (
    <section
      aria-label={copy.sources}
      className={cn(WIDGET_SHELL_CLASS, 'mt-1.5 w-full max-w-xl')}
      data-slot="data-hub-sources"
    >
      <div className="mb-2 text-2xs font-medium uppercase tracking-label text-(--ui-text-tertiary)">{copy.sources}</div>
      <ul className="grid gap-2.5">
        {result.passages.map((passage, index) => (
          <SourceCard key={passage.passageId || `${passage.ref}:${index}`} passage={passage} />
        ))}
      </ul>
    </section>
  )
}

/**
 * A `search_knowledge` / `read_passage_context` call of a Data Hub server: the
 * ordinary tool row, then its sources — or the one line saying nothing was
 * found, which is an answer, not a failure. A pending or failed call, or a
 * result without the contract's shape, is just the row: a failure keeps its
 * error.
 */
export const DataHubSourcesTool: FC<ToolCallMessagePartProps> = props => {
  const { t } = useI18n()
  const result = props.result === undefined || props.isError ? null : parseDataHubResult(props.result)

  if (!result || result.result === 'knowledge_bases') {
    return <ToolFallback {...props} />
  }

  return (
    <div className="grid min-w-0 max-w-full" data-slot="data-hub-tool">
      <ToolFallback {...props} />
      {result.passages.length ? (
        <DataHubSources result={result} />
      ) : (
        <p className={META_CLASS} data-slot="data-hub-no-evidence">
          {t.assistant.tool.dataHub.noEvidence}
        </p>
      )}
    </div>
  )
}
