import { useEffect, useRef, useState } from 'react'

import { useI18n } from '../i18n'

type Props = {
  command: string
  /** Small mono label above the rule — which platforms the line is for. */
  label: string
}

/**
 * A literal command, typographically framed: a mono label over a hairline, the
 * command itself, and a copy button. Deliberately NOT a drawn terminal window —
 * the visitor already has a terminal, and a fake title bar with traffic-light
 * dots is the tell that the page is imitating an OS it isn't.
 *
 * Success is quiet: the button relabels itself for two seconds. No toast.
 */
export function CopyCommand({ command, label }: Props) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  async function copy() {
    try {
      await navigator.clipboard.writeText(command)
    } catch {
      // Clipboard blocked (insecure context, denied permission). The command is
      // selectable text either way, so there is nothing to apologise for.
      return
    }

    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="cmd">
      <div className="cmd__head">
        <span className="cmd__label">{label}</span>
      </div>
      <div className="cmd__row">
        <code className="cmd__code">{command}</code>
        <button className="cmd__copy" data-copied={copied || undefined} onClick={copy} type="button">
          {copied ? t.hero.copied : t.hero.copy}
        </button>
      </div>
    </div>
  )
}
