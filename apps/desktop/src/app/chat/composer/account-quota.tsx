/* Hallmark · component: quota · genre: modern-minimal · theme: existing Quiet Tool
 * Pre-emit critique: P5 H4 E4 S5 R5 V4. Uses the app's controls, motion and focus states.
 */
import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { composerUndersideControl } from '@/components/chat/composer-dock'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { RefreshCw } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $keycloakAccount } from '@/store/account'
import { $accountQuota, refreshAccountQuota } from '@/store/account-quota'

export function ComposerAccountQuota() {
  const account = useStore($keycloakAccount)
  const state = useStore($accountQuota)
  const { t, locale } = useI18n()
  const copy = t.composer.quota
  const [open, setOpen] = useState(false)

  if (!account.signedIn || !window.agentxDesktop?.account?.quota) {
    return null
  }

  const quota = state.quota

  const remainingFraction =
    quota?.limit != null ? (quota.limit > 0 ? Math.max(0, Math.min(1, (quota.remaining ?? 0) / quota.limit)) : 0) : null

  const exhausted = remainingFraction === 0
  const warning = remainingFraction !== null && remainingFraction <= 0.2
  const stale = state.status !== 'ok'
  const tone = exhausted ? 'text-(--danger)' : warning ? 'text-(--warning)' : 'text-(--accent)'

  const formatPercent = (value: number) =>
    new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(value)

  const percent = remainingFraction === null ? null : formatPercent(remainingFraction)

  const summary = quota
    ? percent === null
      ? copy.unlimited
      : `${percent} · ${copy.remaining.toLocaleLowerCase(locale)}`
    : state.loaded
      ? '—'
      : copy.loading

  const date = (value: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(value))

  const reset = quota?.reset_at ? new Date(quota.reset_at).getTime() : null
  const delta = reset === null ? null : reset - Date.now()

  const resetRelative =
    delta !== null && delta > 0
      ? new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
          Math.ceil(delta / (delta >= 86_400_000 ? 86_400_000 : delta >= 3_600_000 ? 3_600_000 : 60_000)),
          delta >= 86_400_000 ? 'day' : delta >= 3_600_000 ? 'hour' : 'minute'
        )
      : null

  const unavailable = ['unsupported', 'forbidden', 'unavailable'].includes(state.status)
    ? copy.unsupported
    : copy.offline

  return (
    <div className="shrink-0" data-slot="composer-account-quota">
      <Popover
        onOpenChange={next => {
          setOpen(next)

          if (next) {
            void refreshAccountQuota()
          }
        }}
        open={open}
      >
        <Tip label={`${stale && quota ? copy.stale : copy.title} · ${summary}`} side="top">
          <PopoverTrigger asChild>
            <Button
              aria-label={`${copy.view}: ${summary}`}
              className={cn(composerUndersideControl, 'shrink-0')}
              type="button"
              variant="ghost"
            >
              <svg
                aria-hidden="true"
                className={cn('size-4 shrink-0', quota && !stale ? tone : 'text-(--text-tertiary)')}
                viewBox="0 0 32 32"
              >
                <circle
                  className="text-(--border-default)"
                  cx="16"
                  cy="16"
                  fill="none"
                  r="12"
                  stroke="currentColor"
                  strokeWidth="3"
                />
                {quota && (
                  <circle
                    cx="16"
                    cy="16"
                    fill="none"
                    pathLength="100"
                    r="12"
                    stroke="currentColor"
                    strokeDasharray={`${(remainingFraction ?? 1) * 100} 100`}
                    strokeLinecap="round"
                    strokeWidth="3"
                    transform="rotate(-90 16 16)"
                  />
                )}
              </svg>
              <span className={cn('tabular-nums', quota && !stale && warning && tone)}>
                {quota ? (percent ?? '∞') : '—'}
              </span>
            </Button>
          </PopoverTrigger>
        </Tip>
        <PopoverContent align="end" aria-label={copy.title} className="w-80 max-w-[calc(100vw-1rem)] p-4" side="top">
          <div aria-busy={state.refreshing} className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-medium">{copy.title}</h2>
              <Button
                aria-label={t.common.refresh}
                disabled={state.refreshing}
                loading={state.refreshing}
                onClick={() => void refreshAccountQuota()}
                size="icon-sm"
                variant="ghost"
              >
                <RefreshCw />
              </Button>
            </div>
            {!quota ? (
              <p className="text-sm text-(--text-secondary)" role="status">
                {state.loaded ? unavailable : copy.loading}
              </p>
            ) : (
              <>
                <div>
                  <p className="text-xs text-(--text-secondary)">{copy.remaining}</p>
                  <p className="mt-1 text-3xl font-medium tracking-tight tabular-nums">{percent ?? '—'}</p>
                  {quota.limit === null && <p className="mt-1 text-sm text-(--text-secondary)">{copy.unlimited}</p>}
                </div>
                {remainingFraction !== null && (
                  <div>
                    <div
                      aria-label={copy.used}
                      aria-valuemax={100}
                      aria-valuemin={0}
                      aria-valuenow={Math.round((1 - remainingFraction) * 100)}
                      className="h-1.5 overflow-hidden rounded-full bg-(--bg-selected)"
                      role="progressbar"
                    >
                      <div
                        className={cn(
                          'h-full origin-left rounded-full bg-current transition-transform duration-(--dur-long) ease-(--ease-out) motion-reduce:transition-none rtl:origin-right',
                          tone
                        )}
                        style={{ transform: `scaleX(${1 - remainingFraction})` }}
                      />
                    </div>
                    {warning && <p className={cn('mt-2 text-xs', tone)}>{exhausted ? copy.exhausted : copy.warning}</p>}
                  </div>
                )}
                {remainingFraction !== null && (
                  <dl className="flex items-center justify-between gap-3 text-sm">
                    <dt className="text-(--text-secondary)">{copy.used}</dt>
                    <dd className="tabular-nums">{formatPercent(1 - remainingFraction)}</dd>
                  </dl>
                )}
                <div className="text-sm">
                  <p className="text-xs text-(--text-secondary)">{copy.resets}</p>
                  <p className="mt-1">
                    {reset !== null
                      ? delta! <= 0
                        ? copy.pendingReset
                        : resetRelative
                      : quota.renews
                        ? copy.unknownReset
                        : copy.noReset}
                  </p>
                  {quota.reset_at && (
                    <time className="mt-1 block text-xs text-(--text-secondary)" dateTime={quota.reset_at}>
                      {date(quota.reset_at)}
                    </time>
                  )}
                </div>
                {stale && (
                  <p className="text-xs text-(--warning)" role="status">
                    {unavailable}
                  </p>
                )}
              </>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
