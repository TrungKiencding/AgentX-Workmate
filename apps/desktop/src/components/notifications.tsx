import { useStore } from '@nanostores/react'
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { CopyButton } from '@/components/ui/copy-button'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import {
  AlertCircleFilled,
  AlertTriangleFilled,
  CheckCircleFilled,
  type IconComponent,
  InfoFilled,
  X
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  $notifications,
  type AppNotification,
  closeAllNotifications,
  closeNotification,
  holdNotificationTimers,
  type NotificationKind,
  releaseNotificationTimers
} from '@/store/notifications'

type ToneVariant = 'default' | 'destructive' | 'warning' | 'success'

// Status glyphs are the FILLED set (spec §3.10) so a state never reads as an
// action; the hue is the signal token, never the accent.
const tone: Record<NotificationKind, { icon: IconComponent; iconClass: string; variant: ToneVariant }> = {
  error: { icon: AlertCircleFilled, iconClass: 'text-(--danger)', variant: 'destructive' },
  warning: { icon: AlertTriangleFilled, iconClass: 'text-(--warning)', variant: 'warning' },
  info: { icon: InfoFilled, iconClass: 'text-(--icon-muted)', variant: 'default' },
  success: { icon: CheckCircleFilled, iconClass: 'text-(--success)', variant: 'success' }
}

// Level-1 surface (spec §5.15): --bg-raised under shadow-md, 12px corners,
// 10×12 padding, 420px at most.
const TOAST_SURFACE = 'pointer-events-auto w-full rounded-lg bg-(--bg-raised) px-3 py-2.5 text-base shadow-md'

// At most two toasts at once (spec §5.15); the newest sits nearest the
// composer and pushes the older one up. Anything beyond waits behind a
// "+N" row so an unhandled error is never silently dropped.
const VISIBLE_TOASTS = 2

export function NotificationStack() {
  const notifications = useStore($notifications)
  const { t } = useI18n()
  const lastNotificationIdRef = useRef<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const copy = t.notifications

  useEffect(() => {
    if (notifications.length <= VISIBLE_TOASTS) {
      setExpanded(false)
    }
  }, [notifications.length])

  // The stack can vanish under a resting pointer; never leave timers held.
  useEffect(() => {
    if (notifications.length === 0) {
      releaseNotificationTimers()
    }
  }, [notifications.length])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    const latest = notifications[0]

    if (!latest || latest.id === lastNotificationIdRef.current) {
      return
    }

    lastNotificationIdRef.current = latest.id

    if (latest.kind === 'success') {
      triggerHaptic('success')
    } else if (latest.kind === 'error') {
      triggerHaptic('error')
    } else if (latest.kind === 'warning') {
      triggerHaptic('warning')
    }
  }, [notifications])

  if (notifications.length === 0) {
    return null
  }

  const visible = expanded ? notifications : notifications.slice(0, VISIBLE_TOASTS)
  const hiddenCount = notifications.length - visible.length

  // Portaled to <body> on the over-modal rung so a toast clears an open dialog
  // (inside the React root, any body-level dialog portal paints over it).
  // Bottom-centre, just above the composer: the measured dock height plus a
  // 12px gap, and the safe-area inset where a device has one.
  return createPortal(
    <div
      aria-label={copy.region}
      className="pointer-events-none fixed bottom-[calc(var(--composer-measured-height)+0.75rem+env(safe-area-inset-bottom))] left-1/2 z-(--z-over-modal) flex w-[min(26.25rem,calc(100%-2rem))] -translate-x-1/2 flex-col-reverse gap-2"
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          releaseNotificationTimers()
        }
      }}
      onFocus={holdNotificationTimers}
      onPointerEnter={holdNotificationTimers}
      onPointerLeave={releaseNotificationTimers}
      role="region"
    >
      {visible.map(n => (
        <NotificationItem key={n.id} notification={n} />
      ))}
      {notifications.length > 1 && (
        <div className="pointer-events-auto flex items-center justify-between px-1 text-sm">
          {notifications.length > VISIBLE_TOASTS ? (
            <Button onClick={() => setExpanded(v => !v)} size="micro" type="button" variant="text">
              {expanded ? copy.hide : copy.more(hiddenCount)}
            </Button>
          ) : (
            <span />
          )}
          <Button onClick={closeAllNotifications} size="micro" type="button" variant="text">
            {copy.clearAll}
          </Button>
        </div>
      )}
    </div>,
    document.body
  )
}

// Emphasize only the leading money figure ("$16.00" — the amount used) with the
// accent color (semibold), leaving the rest of the line in its default muted
// tone. No accent, or no figure in the message → render the text untouched.
function renderMessage(message: string, accent?: string): ReactNode {
  const match = accent ? /\$\d+(?:\.\d{2})?/.exec(message) : null

  if (!match) {
    return message
  }

  const start = match.index
  const end = start + match[0].length

  return (
    <>
      {message.slice(0, start)}
      <span className="font-semibold" style={{ color: accent }}>
        {match[0]}
      </span>
      {message.slice(end)}
    </>
  )
}

function NotificationItem({ notification }: { notification: AppNotification }) {
  const styles = tone[notification.kind]
  const Icon = styles.icon
  const hasDetail = Boolean(notification.detail && notification.detail !== notification.message)
  const { t } = useI18n()
  const copy = t.notifications

  // `accentColor` (when set) tints the icon + message as a severity ramp,
  // overriding the kind's default colour.
  const accent = notification.accentColor
  const iconStyle: CSSProperties | undefined = accent ? { color: accent } : undefined

  return (
    <div
      aria-live={notification.kind === 'error' ? 'assertive' : 'polite'}
      className={cn(
        TOAST_SURFACE,
        'grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 animate-in fade-in-0 slide-in-from-bottom-2 duration-(--dur-long) ease-(--ease-out)'
      )}
      data-slot="toast"
      role={notification.kind === 'error' ? 'alert' : 'status'}
    >
      {notification.icon ? (
        <Codicon className={cn('mt-0.5', styles.iconClass)} name={notification.icon} size="1rem" style={iconStyle} />
      ) : (
        <Icon className={cn('mt-0.5 size-4', styles.iconClass)} style={iconStyle} />
      )}
      <div className="min-w-0 text-pretty">
        {notification.title && <p className="m-0 font-medium text-(--text-primary)">{notification.title}</p>}
        <p className={cn('m-0', notification.title ? 'text-(--text-secondary)' : 'text-(--text-primary)')}>
          {renderMessage(notification.message, accent)}
        </p>
        {notification.meta && <p className="m-0 text-sm text-(--text-tertiary) tabular-nums">{notification.meta}</p>}
        {hasDetail && <NotificationDetail detail={notification.detail || ''} />}
        {notification.action && (
          <Button
            className="mt-1"
            onClick={() => {
              notification.action?.onClick()
              closeNotification(notification.id)
            }}
            size="inline"
            type="button"
            variant="link"
          >
            {notification.action.label}
          </Button>
        )}
      </div>
      <Button
        aria-label={copy.dismiss}
        className="-mr-1 -mt-0.5"
        onClick={() => closeNotification(notification.id)}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <X className="size-3.5" />
      </Button>
    </div>
  )
}

function NotificationDetail({ detail }: { detail: string }) {
  const { t } = useI18n()
  const copy = t.notifications

  return (
    <details className="mt-1.5 text-sm text-(--text-secondary)">
      <summary className="select-none text-(--text-secondary) hover:text-(--text-primary)">{copy.details}</summary>
      <div className="mt-1 rounded-md bg-(--bg-subtle) p-2">
        <pre
          className="max-h-32 overflow-auto whitespace-pre-wrap wrap-break-word font-mono text-xs leading-relaxed"
          data-selectable-text="true"
        >
          {detail}
        </pre>
        <CopyButton
          appearance="inline"
          className="mt-1 rounded-sm px-1.5 py-0.5 text-xs"
          errorMessage={copy.copyDetailFailed}
          iconClassName="size-3"
          label={copy.copyDetail}
          text={detail}
        >
          {copy.copyDetail}
        </CopyButton>
      </div>
    </details>
  )
}

export function InlineNotice({
  kind = 'info',
  title,
  children,
  className
}: {
  kind?: NotificationKind
  title?: string
  children: ReactNode
  className?: string
}) {
  const styles = tone[kind]
  const Icon = styles.icon

  return (
    <Alert className={cn('min-w-0', className)} role={kind === 'error' ? 'alert' : 'status'} variant={styles.variant}>
      <Icon />
      {title && <AlertTitle>{title}</AlertTitle>}
      <AlertDescription className={cn(!title && 'row-start-1')}>{children}</AlertDescription>
    </Alert>
  )
}
