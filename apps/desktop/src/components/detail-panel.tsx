import { CopyButton } from '@/components/ui/copy-button'
import { cn } from '@/lib/utils'

/**
 * The raw text behind a plain-words error, for whoever has to diagnose it:
 * selectable, scrolls when long, with a copy button. Sits inside a disclosure
 * (a toast's "Details", a failed turn's "Error details").
 */
export function DetailPanel({
  className,
  copyFailedLabel,
  copyLabel,
  detail,
  id
}: {
  className?: string
  copyFailedLabel: string
  copyLabel: string
  detail: string
  id?: string
}) {
  return (
    <div className={cn('mt-1 rounded-md bg-(--bg-subtle) p-2', className)} id={id}>
      <pre
        className="max-h-32 overflow-auto whitespace-pre-wrap wrap-break-word font-mono text-xs leading-relaxed"
        data-selectable-text="true"
      >
        {detail}
      </pre>
      <CopyButton
        appearance="inline"
        className="mt-1 rounded-sm px-1.5 py-0.5 text-xs"
        errorMessage={copyFailedLabel}
        iconClassName="size-3"
        label={copyLabel}
        text={detail}
      >
        {copyLabel}
      </CopyButton>
    </div>
  )
}
