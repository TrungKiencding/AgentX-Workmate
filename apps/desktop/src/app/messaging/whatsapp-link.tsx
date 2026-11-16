import * as QRCode from 'qrcode'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ErrorBanner } from '@/components/ui/error-state'
import { Tip } from '@/components/ui/tooltip'
import {
  applyWhatsAppLink,
  cancelWhatsAppLink,
  getWhatsAppLink,
  type MessagingPlatformInfo,
  startWhatsAppLink,
  type WhatsAppLinkMode,
  type WhatsAppOnboardingSession
} from '@/hermes'
import { type Translations, useI18n } from '@/i18n'
import { CheckCircle2, Loader2 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { notify, readableError } from '@/store/notifications'
import { runGatewayRestart } from '@/store/system-actions'

const POLL_MS = 2000

type Copy = Translations['messaging']['whatsapp']

type LinkPhase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'pairing'; session: WhatsAppOnboardingSession }
  | { kind: 'saving' }
  | { kind: 'failed'; message: string; detail?: string }

/** HTTP status the desktop API bridge folds into an error ("410: {...}"). */
export function httpStatusOf(error: unknown): number | null {
  const text = error instanceof Error ? error.message : String(error ?? '')
  const match = text.match(/(?:^|Error: |\s)(\d{3}): /)

  return match ? Number(match[1]) : null
}

/** The backend's English failure, as a sentence a non-technical owner can act on. */
export function friendlyLinkError(raw: string, copy: Copy): { message: string; detail?: string } {
  const text = raw.trim()

  if (/node\.?js was not found|npm was not found/i.test(text)) {
    return { message: copy.errors.noNode, detail: text }
  }

  if (/npm install failed|dependencies timed out|install whatsapp bridge dependencies/i.test(text)) {
    return { message: copy.errors.install, detail: text }
  }

  if (/logged_out/i.test(text)) {
    return { message: copy.errors.loggedOut }
  }

  if (/expired/i.test(text)) {
    return { message: copy.errors.expired }
  }

  return { message: copy.errors.generic, detail: text || undefined }
}

export function formatWhatsAppAccount(phone?: null | string, name?: null | string): null | string {
  const number = phone ? `+${phone.replace(/^\+/, '')}` : ''

  if (number && name) {
    return `${number} · ${name}`
  }

  return number || name || null
}

/**
 * The QR-linking state machine for one platform detail. It lives above the
 * view so moving between the setup coach and the full form keeps a QR the
 * phone is about to scan; leaving the platform (unmount) ends the run.
 */
export function useWhatsAppLink(platform: MessagingPlatformInfo, onChanged: () => void) {
  const { t } = useI18n()
  const copy = t.messaging.whatsapp
  const setup = platform.whatsapp_setup

  const savedMode: WhatsAppLinkMode = setup?.mode === 'bot' ? 'bot' : 'self-chat'
  const [mode, setMode] = useState<WhatsAppLinkMode>(savedMode)
  const [phase, setPhase] = useState<LinkPhase>({ kind: 'idle' })
  const [qrImage, setQrImage] = useState<null | string>(null)

  // The platform snapshot can arrive (or change) after mount; the saved mode
  // is what a re-link must keep unless the person picks another one.
  useEffect(() => {
    setMode(savedMode)
  }, [savedMode])

  // The pairing run is a live child process on the backend; leaving the
  // platform must end it.
  const pairingIdRef = useRef<null | string>(null)
  const pollRef = useRef<number | null>(null)
  const appliedRef = useRef(false)
  const aliveRef = useRef(true)

  const stopPolling = () => {
    if (pollRef.current !== null) {
      window.clearTimeout(pollRef.current)
      pollRef.current = null
    }
  }

  const releasePairing = useCallback(() => {
    stopPolling()
    const id = pairingIdRef.current
    pairingIdRef.current = null

    if (id) {
      void cancelWhatsAppLink(id).catch(() => undefined)
    }
  }, [])

  // A mount flag, not a mirrored value: StrictMode re-runs this effect after
  // its cleanup, so the flag must be raised here rather than in useRef(true).
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    aliveRef.current = true

    return () => {
      aliveRef.current = false
      releasePairing()
    }
  }, [releasePairing])

  const fail = useCallback(
    (raw: string) => {
      releasePairing()
      setQrImage(null)
      setPhase({ kind: 'failed', ...friendlyLinkError(raw, copy) })
    },
    [copy, releasePairing]
  )

  const apply = useCallback(
    async (session: WhatsAppOnboardingSession) => {
      if (appliedRef.current) {
        return
      }

      appliedRef.current = true
      stopPolling()
      setPhase({ kind: 'saving' })

      try {
        const result = await applyWhatsAppLink(session.pairing_id, session.mode)
        // Apply consumed the run on the backend; nothing left to cancel.
        pairingIdRef.current = null
        const who = formatWhatsAppAccount(session.account_phone, session.account_name)

        notify({
          kind: 'success',
          title: copy.linkedToast,
          message: result.needs_restart ? copy.linkedToastRestart : copy.linkedToastBody,
          detail: who ?? undefined,
          action: result.needs_restart
            ? { label: t.messaging.restartNow, onClick: () => void runGatewayRestart() }
            : undefined
        })
      } catch (error) {
        const readable = readableError(error, copy.linkFailed)

        if (aliveRef.current) {
          appliedRef.current = false
          setPhase({ kind: 'failed', message: copy.linkFailed, detail: readable.detail ?? readable.message })
        }

        return
      }

      if (aliveRef.current) {
        setQrImage(null)
        setPhase({ kind: 'idle' })
      }

      onChanged()
    },
    [copy, onChanged, t.messaging.restartNow]
  )

  const track = useCallback(
    (session: WhatsAppOnboardingSession) => {
      if (!aliveRef.current || pairingIdRef.current !== session.pairing_id) {
        return
      }

      if (session.status === 'connected') {
        void apply(session)

        return
      }

      if (session.status === 'error' || session.status === 'expired' || session.status === 'cancelled') {
        fail(session.error || session.status)

        return
      }

      setPhase({ kind: 'pairing', session })

      pollRef.current = window.setTimeout(async () => {
        const id = pairingIdRef.current

        if (!id) {
          return
        }

        try {
          track(await getWhatsAppLink(id))
        } catch (error) {
          const status = httpStatusOf(error)

          // 404/410: the run timed out or the backend restarted under it.
          if (status === 404 || status === 410) {
            fail('expired')
          } else if (aliveRef.current && pairingIdRef.current === id) {
            // A transient hiccup must not throw away a QR the phone is
            // about to scan; keep polling.
            track(session)
          }
        }
      }, POLL_MS)
    },
    [apply, fail]
  )

  const start = useCallback(
    async (relink = false) => {
      releasePairing()
      appliedRef.current = false
      setQrImage(null)
      setPhase({ kind: 'starting' })

      try {
        const session = await startWhatsAppLink({ mode, relink })
        pairingIdRef.current = session.pairing_id

        if (!aliveRef.current) {
          releasePairing()

          return
        }

        track(session)
      } catch (error) {
        if (httpStatusOf(error) === 409) {
          setPhase({ kind: 'failed', message: copy.relinkConnected })
        } else {
          fail(readableError(error, copy.errors.generic).message)
        }
      }
    },
    [copy, fail, mode, releasePairing, track]
  )

  const qrPayload = phase.kind === 'pairing' ? phase.session.qr_payload : null

  useEffect(() => {
    if (!qrPayload) {
      setQrImage(null)

      return
    }

    let current = true

    // WhatsApp rotates the code every ~20s; each new payload re-renders here.
    QRCode.toDataURL(qrPayload, {
      color: { dark: '#111111', light: '#ffffff' },
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 480
    })
      .then(url => current && setQrImage(url))
      .catch(() => current && setQrImage(null))

    return () => {
      current = false
    }
  }, [qrPayload])

  const cancel = useCallback(() => {
    releasePairing()
    setQrImage(null)
    setPhase({ kind: 'idle' })
  }, [releasePairing])

  return { cancel, mode, phase, qrImage, setMode, start }
}

export type WhatsAppLinkController = ReturnType<typeof useWhatsAppLink>

/**
 * Links WhatsApp from inside Workmate: pick how you will chat, show the QR the
 * bundled bridge produces, and save + enable the moment the phone scans it —
 * the terminal-only `agentx whatsapp` step a non-technical owner could not do.
 */
export function WhatsAppLink({ link, platform }: { link: WhatsAppLinkController; platform: MessagingPlatformInfo }) {
  const { t } = useI18n()
  const copy = t.messaging.whatsapp
  const setup = platform.whatsapp_setup
  const linked = Boolean(setup?.linked)
  const { cancel, mode, phase, qrImage, setMode, start } = link
  const [confirmRelink, setConfirmRelink] = useState(false)

  const busy = phase.kind === 'starting' || phase.kind === 'saving'
  const pairing = phase.kind === 'pairing' ? phase.session : null
  const preparing = phase.kind === 'starting' || (pairing !== null && !pairing.qr_payload)

  if (linked && phase.kind === 'idle') {
    const who = formatWhatsAppAccount(setup?.account_phone, setup?.account_name)
    const connected = platform.enabled && platform.state === 'connected'
    const linkedMode = setup?.mode === 'bot' ? 'bot' : 'self-chat'

    return (
      <div className="grid gap-3">
        <div className="flex items-start gap-2">
          <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-(--success)" />
          <div className="grid gap-1">
            <p className="text-sm font-medium text-(--ui-text-primary)">
              {who ? copy.linkedTo(who) : copy.linkedUnknown}
            </p>
            <p className="max-w-prose text-sm text-(--ui-text-tertiary)">
              {linkedMode === 'bot' ? copy.tryBot : copy.trySelf}
            </p>
          </div>
        </div>
        <div>
          {connected ? (
            <Tip label={copy.relinkConnected}>
              {/* A disabled button swallows hover; the span carries the tip. */}
              <span className="inline-flex" tabIndex={0}>
                <Button disabled size="sm" variant="outline">
                  {copy.relink}
                </Button>
              </span>
            </Tip>
          ) : (
            <Button onClick={() => setConfirmRelink(true)} size="sm" variant="outline">
              {copy.relink}
            </Button>
          )}
        </div>
        <ConfirmDialog
          cancelLabel={t.common.cancel}
          confirmLabel={copy.relink}
          description={copy.relinkBody}
          dismissOnConfirm
          onClose={() => setConfirmRelink(false)}
          onConfirm={() => void start(true)}
          open={confirmRelink}
          title={copy.relinkTitle}
        />
      </div>
    )
  }

  return (
    <div className="grid gap-4">
      {!pairing && phase.kind !== 'saving' && (
        <fieldset className="grid gap-2" disabled={busy}>
          <legend className="mb-2 text-sm font-medium text-(--ui-text-primary)">{copy.modeLabel}</legend>
          <ModeOption
            checked={mode === 'self-chat'}
            hint={copy.modeSelfHint}
            label={copy.modeSelf}
            onSelect={() => setMode('self-chat')}
          />
          <ModeOption
            checked={mode === 'bot'}
            hint={copy.modeBotHint}
            label={copy.modeBot}
            onSelect={() => setMode('bot')}
          />
        </fieldset>
      )}

      {phase.kind === 'failed' && (
        <ErrorBanner>
          <span className="grid gap-1">
            <span>{phase.message}</span>
            {phase.detail && <span className="text-xs opacity-80">{phase.detail}</span>}
          </span>
        </ErrorBanner>
      )}

      {pairing || phase.kind === 'starting' ? (
        <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
          <div
            aria-busy={preparing}
            className="grid size-60 place-items-center rounded-(--radius-card) border border-(--ui-stroke-tertiary) bg-white p-3"
          >
            {qrImage && !preparing ? (
              <img alt={copy.qrAlt} className="size-full [image-rendering:pixelated]" src={qrImage} />
            ) : (
              <span className="grid justify-items-center gap-2 px-4 text-center text-xs text-neutral-600">
                <Loader2 aria-hidden className="size-5 animate-spin motion-reduce:animate-none" />
                {copy.preparing}
              </span>
            )}
          </div>
          <div className="grid gap-3">
            <p className="text-sm font-medium text-(--ui-text-primary)">{copy.scanTitle}</p>
            <ol className="grid list-decimal gap-1.5 ps-5 text-sm leading-relaxed text-(--ui-text-secondary)">
              {copy.scanSteps.map(step => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p aria-live="polite" className="text-xs text-(--ui-text-tertiary)">
              {preparing ? copy.preparingHint : copy.qrRefresh}
            </p>
            <div>
              <Button onClick={cancel} size="sm" variant="ghost">
                {t.common.cancel}
              </Button>
            </div>
          </div>
        </div>
      ) : phase.kind === 'saving' ? (
        <p aria-live="polite" className="flex items-center gap-2 text-sm text-(--ui-text-secondary)">
          <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
          {copy.saving}
        </p>
      ) : (
        <div>
          <Button onClick={() => void start(false)} size="sm">
            {phase.kind === 'failed' ? copy.retry : copy.showQr}
          </Button>
        </div>
      )}
    </div>
  )
}

function ModeOption({
  checked,
  hint,
  label,
  onSelect
}: {
  checked: boolean
  hint: string
  label: string
  onSelect: () => void
}) {
  return (
    <label
      className={cn(
        'flex max-w-xl cursor-pointer items-start gap-3 rounded-(--radius-card) border px-3 py-2.5 transition-colors',
        checked
          ? 'border-(--ui-stroke-secondary) bg-(--bg-selected)'
          : 'border-(--ui-stroke-tertiary) hover:bg-(--bg-hover)'
      )}
    >
      <input
        checked={checked}
        className="mt-1 accent-(--accent)"
        name="whatsapp-mode"
        onChange={onSelect}
        type="radio"
      />
      <span className="grid gap-0.5">
        <span className="text-sm font-medium text-(--ui-text-primary)">{label}</span>
        <span className="text-sm text-(--ui-text-tertiary)">{hint}</span>
      </span>
    </label>
  )
}
