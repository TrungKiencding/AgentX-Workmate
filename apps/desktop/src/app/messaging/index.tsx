import { useStore } from '@nanostores/react'
import type * as React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { StatusDot, type StatusTone } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { DisclosureRow } from '@/components/ui/disclosure-row'
import { ErrorBanner } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { StatusPill, type StatusPillTone } from '@/components/ui/status-pill'
import { Switch } from '@/components/ui/switch'
import { Tip } from '@/components/ui/tooltip'
import {
  approvePairing,
  getMessagingPlatforms,
  getPairing,
  type MessagingEnvVarInfo,
  type MessagingPlatformInfo,
  type PairingUser,
  revokePairing,
  updateMessagingPlatform
} from '@/hermes'
import { type Translations, useI18n } from '@/i18n'
import { openExternalLink } from '@/lib/external-link'
import { Check, ExternalLink, Save, Trash2 } from '@/lib/icons'
import { normalize } from '@/lib/text'
import { cn } from '@/lib/utils'
import { $changeEventsAvailable, $pairingChangeTick, $platformsChangeTick } from '@/store/live-sync'
import { notify, notifyError } from '@/store/notifications'
import { setPendingPairingCount } from '@/store/pairing'
import { runGatewayRestart } from '@/store/system-actions'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import { useRouteEnumParam } from '../hooks/use-route-enum-param'
import { DetailColumn, ListColumn, MasterDetail } from '../master-detail'
import { PageSearchShell } from '../page-search-shell'
import { ListRow } from '../settings/primitives'
import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

import { PlatformAvatar } from './platform-icon'

interface MessagingViewProps extends React.ComponentProps<'section'> {
  setStatusbarItemGroup?: SetStatusbarItemGroup
}

type EditMap = Record<string, Record<string, string>>

// The six platforms an office leads with — a UI ordering constant only. The
// rest stay one disclosure away; nothing is removed.
const POPULAR_PLATFORMS = ['telegram', 'whatsapp', 'email', 'slack', 'discord', 'sms']

// "Xem thêm" remembers its answer for the session (not persisted — a fresh
// launch folds the long tail again).
let showAllPlatformsThisSession = false

const stateLabel = (state: null | string | undefined, m: Translations['messaging']) =>
  state ? m.states[state] || state.replace(/_/g, ' ') : m.unknown

function stateTone({ enabled, state }: MessagingPlatformInfo): StatusTone {
  if (!enabled) {
    return 'muted'
  }

  if (state === 'connected') {
    return 'good'
  }

  if (state === 'fatal' || state === 'startup_failed') {
    return 'bad'
  }

  return 'warn'
}

// ONE summary pill per platform, by priority: error › restart needed ›
// connecting › connected › needs setup › off. Everything else the old three
// pills said becomes a quiet line under the name.
function summaryOf(
  platform: MessagingPlatformInfo,
  m: Translations['messaging']
): { label: string; tone: StatusPillTone } {
  const state = platform.state ?? ''

  if (platform.enabled && (state === 'fatal' || state === 'startup_failed')) {
    return { label: stateLabel(state, m), tone: 'bad' }
  }

  if (platform.enabled && state === 'pending_restart') {
    return { label: stateLabel(state, m), tone: 'warn' }
  }

  if (platform.enabled && (state === 'connecting' || state === 'retrying')) {
    return { label: stateLabel(state, m), tone: 'info' }
  }

  if (platform.enabled && state === 'connected') {
    return { label: stateLabel(state, m), tone: 'good' }
  }

  if (!platform.configured) {
    return { label: m.needsSetup, tone: 'muted' }
  }

  if (!platform.enabled) {
    return { label: m.states.disabled, tone: 'muted' }
  }

  return { label: stateLabel(state, m), tone: 'warn' }
}

const trimEdits = (edits: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(edits)
      .map(([k, v]) => [k, v.trim()])
      .filter(([, v]) => v)
  )

/** Stable row identity: a user id is only unique within its platform. */
const pairingKey = (user: PairingUser) => `${user.platform}:${user.user_id}`

const pairingLabel = (user: PairingUser) => user.user_name || user.user_id

/** Group pairing rows by platform id so a detail pane can slice its own. */
function byPlatform(rows: PairingUser[]): Record<string, PairingUser[]> {
  const grouped: Record<string, PairingUser[]> = {}

  for (const row of rows) {
    ;(grouped[row.platform] ||= []).push(row)
  }

  return grouped
}

const FIELD_COPY: Record<string, { advanced?: boolean }> = {
  TELEGRAM_PROXY: { advanced: true },
  DISCORD_REPLY_TO_MODE: { advanced: true },
  DISCORD_ALLOW_ALL_USERS: { advanced: true },
  DISCORD_HOME_CHANNEL: { advanced: true },
  DISCORD_HOME_CHANNEL_NAME: { advanced: true },
  BLUEBUBBLES_ALLOW_ALL_USERS: { advanced: true },
  MATTERMOST_ALLOW_ALL_USERS: { advanced: true },
  MATTERMOST_HOME_CHANNEL: { advanced: true },
  QQ_ALLOW_ALL_USERS: { advanced: true },
  QQBOT_HOME_CHANNEL: { advanced: true },
  QQBOT_HOME_CHANNEL_NAME: { advanced: true },
  WHATSAPP_ENABLED: { advanced: true },
  WHATSAPP_MODE: { advanced: true }
}

function fieldCopy(field: MessagingEnvVarInfo, m: Translations['messaging']) {
  const copy = FIELD_COPY[field.key] || {}
  const localized = m.fieldCopy[field.key] || {}

  return {
    label: localized.label || field.prompt || field.key,
    help: localized.help || field.description,
    placeholder: localized.placeholder || field.prompt,
    advanced: Boolean(copy.advanced || field.advanced)
  }
}

// The header line under a platform's name: the hand-written tagline first,
// the backend's English description as fallback.
const taglineOf = (platform: MessagingPlatformInfo, m: Translations['messaging']) =>
  m.platformTagline[platform.id] || platform.description

export function MessagingView({ setStatusbarItemGroup: _setStatusbarItemGroup, ...props }: MessagingViewProps) {
  const { t } = useI18n()
  const m = t.messaging
  // Both save/toggle toasts offer the same one-click restart.
  const restartGatewayAction = { label: m.restartNow, onClick: () => void runGatewayRestart() }
  const [platforms, setPlatforms] = useState<MessagingPlatformInfo[] | null>(null)

  const [pairing, setPairing] = useState<{ approved: PairingUser[]; pending: PairingUser[] }>({
    approved: [],
    pending: []
  })

  const [approving, setApproving] = useState<null | string>(null)
  const [pendingRevoke, setPendingRevoke] = useState<null | PairingUser>(null)
  const [edits, setEdits] = useState<EditMap>({})
  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState<string | null>(null)
  const [showAllPlatforms, setShowAllPlatforms] = useState(showAllPlatformsThisSession)
  const platformIds = useMemo(() => platforms?.map(p => p.id) ?? [], [platforms])
  const [selectedId, setSelectedId] = useRouteEnumParam('platform', platformIds, platformIds[0] ?? '')

  const toggleShowAll = () => {
    showAllPlatformsThisSession = !showAllPlatforms
    setShowAllPlatforms(showAllPlatformsThisSession)
  }

  const refreshPlatforms = useCallback(
    async (silent = false) => {
      if (!silent) {
        setRefreshing(true)
      }

      try {
        const result = await getMessagingPlatforms()
        setPlatforms(result.platforms)
      } catch (err) {
        if (!silent) {
          notifyError(err, m.loadFailed)
        }
      } finally {
        if (!silent) {
          setRefreshing(false)
        }
      }
    },
    [m]
  )

  // Pairing has its own signal. platforms.changed tracks connect/disconnect
  // health via gateway_state.json, which a new pairing request never moves —
  // riding it would leave a pending row invisible until something unrelated
  // reconnected. Failures stay silent: an older backend without the endpoint
  // should show no rows, not an error banner over a working page.
  const refreshPairing = useCallback(async () => {
    try {
      const result = await getPairing()
      setPairing({ approved: result.approved ?? [], pending: result.pending ?? [] })
      // Lift the count for the sidebar's "Tin nhắn" badge — the page owns the
      // fetch; the store is display-only (see store/pairing).
      setPendingPairingCount(result.pending?.length ?? 0)
    } catch {
      // Leave the last known rows in place rather than blanking them.
    }
  }, [])

  const refreshAll = useCallback(
    async (silent = false) => {
      await Promise.all([refreshPlatforms(silent), refreshPairing()])
    },
    [refreshPairing, refreshPlatforms]
  )

  useRefreshHotkey(() => void refreshAll())

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  const changeEventsAvailable = useStore($changeEventsAvailable)
  const platformsChangeTick = useStore($platformsChangeTick)
  const pairingChangeTick = useStore($pairingChangeTick)

  // A new pending request (or a grant from another surface) moves the pairing
  // store on disk; the change watcher turns that into pairing.changed.
  useEffect(() => {
    if (!changeEventsAvailable || pairingChangeTick === 0 || document.hidden) {
      return
    }

    void refreshPairing()
  }, [changeEventsAvailable, pairingChangeTick, refreshPairing])

  // Connection status updates without a manual "check" click. platforms.changed
  // (the gateway persisting connect/disconnect/health to gateway_state.json)
  // drives the refresh on event-capable backends — no timer; older backends
  // keep the legacy visible-tab poll.
  useEffect(() => {
    if (!changeEventsAvailable || platformsChangeTick === 0 || document.hidden) {
      return
    }

    void refreshPlatforms(true)
  }, [changeEventsAvailable, platformsChangeTick, refreshPlatforms])

  useEffect(() => {
    if (changeEventsAvailable) {
      return
    }

    let cancelled = false

    function tick() {
      if (cancelled || document.hidden) {
        return
      }

      void refreshAll(true)
    }

    const id = window.setInterval(tick, 6000)

    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [changeEventsAvailable, refreshAll])

  const selected = useMemo(() => {
    if (!platforms) {
      return null
    }

    return platforms.find(platform => platform.id === selectedId) || platforms[0] || null
  }, [platforms, selectedId])

  const pendingByPlatform = useMemo(() => byPlatform(pairing.pending), [pairing.pending])
  const approvedByPlatform = useMemo(() => byPlatform(pairing.approved), [pairing.approved])

  const visiblePlatforms = useMemo(() => {
    if (!platforms) {
      return []
    }

    const q = normalize(query)

    if (!q) {
      return platforms
    }

    return platforms.filter(platform =>
      [platform.id, platform.name, platform.description, platform.state]
        .filter(Boolean)
        .some(value => String(value).toLowerCase().includes(q))
    )
  }, [platforms, query])

  // Two shelves: what this install already uses, and what it could connect.
  // The long tail of "could connect" folds behind "Xem thêm" — searching, or
  // a selection inside the fold, opens it.
  const groups = useMemo(() => {
    const inUse = visiblePlatforms.filter(platform => platform.enabled || platform.configured)
    const rest = visiblePlatforms.filter(platform => !platform.enabled && !platform.configured)

    const popularity = (platform: MessagingPlatformInfo) => {
      const index = POPULAR_PLATFORMS.indexOf(platform.id)

      return index === -1 ? POPULAR_PLATFORMS.length : index
    }

    const available = [...rest].sort((a, b) => popularity(a) - popularity(b))
    const lead = available.filter(platform => POPULAR_PLATFORMS.includes(platform.id))
    const tail = lead.length > 0 ? available.filter(platform => !POPULAR_PLATFORMS.includes(platform.id)) : []

    return { inUse, lead: lead.length > 0 ? lead : available, tail }
  }, [visiblePlatforms])

  const tailOpen =
    showAllPlatforms || Boolean(query.trim()) || groups.tail.some(platform => platform.id === selected?.id)

  async function handleToggle(platform: MessagingPlatformInfo, enabled: boolean) {
    setSaving(`enabled:${platform.id}`)

    try {
      await updateMessagingPlatform(platform.id, { enabled })
      setPlatforms(
        current =>
          current?.map(row =>
            row.id === platform.id
              ? {
                  ...row,
                  enabled,
                  state: enabled ? (row.configured ? 'pending_restart' : 'not_configured') : 'disabled'
                }
              : row
          ) ?? current
      )
      notify({
        kind: 'success',
        title: enabled ? m.platformEnabled(platform.name) : m.platformDisabled(platform.name),
        message: m.restartToApply,
        action: restartGatewayAction
      })
    } catch (err) {
      notifyError(err, m.failedUpdate(platform.name))
    } finally {
      setSaving(null)
    }
  }

  async function handleSave(platform: MessagingPlatformInfo) {
    const env = trimEdits(edits[platform.id] || {})

    if (Object.keys(env).length === 0) {
      return
    }

    setSaving(`env:${platform.id}`)

    try {
      await updateMessagingPlatform(platform.id, { env })
      setEdits(current => ({ ...current, [platform.id]: {} }))
      await refreshPlatforms()
      notify({
        kind: 'success',
        title: m.setupSaved(platform.name),
        message: m.restartToReconnect,
        action: restartGatewayAction
      })
    } catch (err) {
      notifyError(err, m.failedSave(platform.name))
    } finally {
      setSaving(null)
    }
  }

  async function handleClear(platform: MessagingPlatformInfo, key: string) {
    setSaving(`clear:${key}`)

    try {
      await updateMessagingPlatform(platform.id, { clear_env: [key] })
      setEdits(current => ({
        ...current,
        [platform.id]: {
          ...(current[platform.id] || {}),
          [key]: ''
        }
      }))
      await refreshPlatforms()
      notify({ kind: 'success', title: m.keyCleared(key), message: m.setupUpdated(platform.name) })
    } catch (err) {
      notifyError(err, m.failedClear(key))
    } finally {
      setSaving(null)
    }
  }

  // Approve/revoke paint from a snapshot immediately, then let the
  // authoritative refresh have the last word. A failed write restores the
  // snapshot so the row never silently disappears on an error.
  async function handleApprove(user: PairingUser) {
    if (!user.request_id) {
      return
    }

    const key = pairingKey(user)
    const snapshot = pairing
    setApproving(key)
    setPairing(current => ({
      approved: current.approved,
      pending: current.pending.filter(row => pairingKey(row) !== key)
    }))

    try {
      await approvePairing(user.platform, user.request_id)
      notify({ kind: 'success', title: m.approvedUser(pairingLabel(user)), message: m.approvedHint })
      await refreshPairing()
    } catch (err) {
      setPairing(snapshot)
      // 429 is the code path's brute-force lockout — a distinct condition the
      // operator can only wait out, so it gets its own message.
      const lockedOut = err instanceof Error && err.message.includes('429')
      notifyError(err, lockedOut ? m.pairingLockedOut : m.failedApprove(pairingLabel(user)))
    } finally {
      setApproving(null)
    }
  }

  // ConfirmDialog owns the pending → done → close beat and shows an inline
  // error when onConfirm throws, so this rethrows instead of swallowing.
  async function handleRevoke(user: PairingUser) {
    const key = pairingKey(user)
    const snapshot = pairing
    setPairing(current => ({
      approved: current.approved.filter(row => pairingKey(row) !== key),
      pending: current.pending
    }))

    try {
      await revokePairing(user.platform, user.user_id)
      notify({ kind: 'success', title: m.revokedUser(pairingLabel(user)), message: user.platform })
      await refreshPairing()
    } catch (err) {
      setPairing(snapshot)
      throw err
    }
  }

  const platformNameOf = (id: string) => platforms?.find(platform => platform.id === id)?.name ?? id

  // Requests waiting on platforms OTHER than the open one surface above the
  // list, so nobody is invisible behind a selection.
  const otherPending = pairing.pending.filter(user => user.platform !== selected?.id)

  const renderRow = (platform: MessagingPlatformInfo, withStatus: boolean) => (
    <li key={platform.id}>
      <PlatformRow
        active={selected?.id === platform.id}
        onSelect={() => setSelectedId(platform.id)}
        pendingCount={pendingByPlatform[platform.id]?.length ?? 0}
        platform={platform}
        withStatus={withStatus}
      />
    </li>
  )

  return (
    <PageSearchShell
      {...props}
      description={m.pageDescription}
      onSearchChange={setQuery}
      searchHidden={(platforms?.length ?? 0) === 0}
      searchHints={platforms?.slice(0, 5).map(platform => t.common.tryHint(platform.name.toLowerCase()))}
      searchPlaceholder={m.search}
      searchValue={query}
      title={m.pageTitle}
    >
      {!platforms ? (
        <PageLoader label={m.loading} />
      ) : (
        <MasterDetail>
          <ListColumn>
            {otherPending.length > 0 && (
              <div className="mb-2 grid gap-1.5">
                {otherPending.map(user => (
                  <PairingBanner
                    busy={approving === pairingKey(user)}
                    compact
                    key={pairingKey(user)}
                    onApprove={() => void handleApprove(user)}
                    platformName={platformNameOf(user.platform)}
                    user={user}
                  />
                ))}
              </div>
            )}
            {groups.inUse.length > 0 && (
              <section className="mb-3">
                <SectionTitle className="px-2 pb-1">{m.groupInUse}</SectionTitle>
                <ul className="space-y-0.5">{groups.inUse.map(platform => renderRow(platform, true))}</ul>
              </section>
            )}
            <section>
              <SectionTitle className="px-2 pb-1">{m.groupAvailable}</SectionTitle>
              <ul className="space-y-0.5">{groups.lead.map(platform => renderRow(platform, false))}</ul>
              {groups.tail.length > 0 && (
                <>
                  {!tailOpen ? (
                    <DisclosureRow className="px-2 pt-1" onToggle={toggleShowAll} open={false}>
                      {m.showMorePlatforms(groups.tail.length)}
                    </DisclosureRow>
                  ) : (
                    <ul className="mt-0.5 space-y-0.5">{groups.tail.map(platform => renderRow(platform, false))}</ul>
                  )}
                </>
              )}
            </section>
          </ListColumn>

          <DetailColumn
            actionBar={
              selected && (
                <PlatformActionBar
                  hasEdits={Object.keys(trimEdits(edits[selected.id] || {})).length > 0}
                  onSave={() => void handleSave(selected)}
                  platform={selected}
                  saving={saving}
                />
              )
            }
          >
            {selected && (
              <PlatformDetail
                approved={approvedByPlatform[selected.id] ?? []}
                approving={approving}
                edits={edits[selected.id] || {}}
                onApprove={user => void handleApprove(user)}
                onClear={key => void handleClear(selected, key)}
                onEdit={(key, value) =>
                  setEdits(current => ({
                    ...current,
                    [selected.id]: {
                      ...(current[selected.id] || {}),
                      [key]: value
                    }
                  }))
                }
                onRevoke={setPendingRevoke}
                onToggle={enabled => void handleToggle(selected, enabled)}
                pending={pendingByPlatform[selected.id] ?? []}
                platform={selected}
                saving={saving}
              />
            )}
          </DetailColumn>
        </MasterDetail>
      )}

      <ConfirmDialog
        busyLabel={m.revoking}
        cancelLabel={t.common.cancel}
        confirmLabel={m.revoke}
        description={pendingRevoke ? m.revokeDesc(pairingLabel(pendingRevoke)) : null}
        destructive
        onClose={() => setPendingRevoke(null)}
        onConfirm={() => (pendingRevoke ? handleRevoke(pendingRevoke) : undefined)}
        open={Boolean(pendingRevoke)}
        title={m.revokeTitle}
      />
    </PageSearchShell>
  )
}

function PlatformRow({
  active,
  onSelect,
  pendingCount,
  platform,
  withStatus
}: {
  active: boolean
  onSelect: () => void
  pendingCount: number
  platform: MessagingPlatformInfo
  withStatus: boolean
}) {
  const { t } = useI18n()
  const m = t.messaging
  const summary = summaryOf(platform, m)

  return (
    <button
      className={cn(
        'row-hover flex min-h-11 w-full items-center gap-2.5 rounded-(--radius-control) px-2 py-1.5 text-left hover:text-foreground',
        active ? 'bg-(--ui-row-active-background) text-foreground' : 'text-(--ui-text-secondary)'
      )}
      onClick={onSelect}
      type="button"
    >
      <PlatformAvatar platformId={platform.id} platformName={platform.name} size="md" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base font-medium">{platform.name}</span>
        {withStatus && (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-(--ui-text-tertiary)">
            <StatusDot tone={stateTone(platform)} />
            <span className="truncate">{summary.label}</span>
          </span>
        )}
      </span>
      {/* Someone is waiting to be let in — the only way this list tells you
          so before you open the platform. A count in the danger tone. */}
      {pendingCount > 0 && (
        <span
          aria-label={m.pendingAria(pendingCount)}
          className="inline-flex min-w-4.5 shrink-0 items-center justify-center rounded-full px-1.5 text-xs font-medium tabular-nums text-[color-mix(in_srgb,var(--ui-red)_var(--status-pill-ink),var(--dt-foreground))] [background:color-mix(in_srgb,var(--ui-red)_var(--status-pill-tint),transparent)]"
        >
          {pendingCount}
        </span>
      )}
    </button>
  )
}

// One waiting person, one sentence, one primary verb. `compact` is the
// list-column variant shown when the request belongs to another platform.
function PairingBanner({
  busy,
  compact = false,
  onApprove,
  platformName,
  user
}: {
  busy: boolean
  compact?: boolean
  onApprove: () => void
  platformName: string
  user: PairingUser
}) {
  const { t } = useI18n()
  const m = t.messaging
  const waited = typeof user.age_minutes === 'number' ? m.waitingSince(user.age_minutes) : null

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-(--radius-card) border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) p-3',
        compact && 'flex-wrap gap-2 p-2.5'
      )}
    >
      <span className="min-w-0 flex-1">
        <span className={cn('block text-base text-foreground', compact && 'text-sm')}>
          {m.wantsToMessage(pairingLabel(user), platformName)}
        </span>
        {!compact && (waited || user.user_name) && (
          <span className="mt-0.5 block truncate text-xs text-(--ui-text-tertiary)">
            {[user.user_name ? user.user_id : null, waited].filter(Boolean).join(' · ')}
          </span>
        )}
      </span>
      <Button disabled={busy || !user.request_id} onClick={onApprove} size="sm">
        {busy ? m.approving : m.allow}
      </Button>
    </div>
  )
}

// One numbered step of the connect walkthrough: a 24px circle that turns into
// a check when the step is done, a 15px title, the content under it.
function Step({
  children,
  done,
  index,
  title
}: {
  children: React.ReactNode
  done: boolean
  index: number
  title: string
}) {
  const { t } = useI18n()

  return (
    <section className="flex gap-3">
      <span
        aria-label={done ? t.messaging.stepDone : undefined}
        className={cn(
          'mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold tabular-nums',
          done ? 'bg-(--ui-green) text-(--ui-green-foreground)' : 'bg-(--ui-bg-tertiary) text-(--ui-text-secondary)'
        )}
      >
        {done ? <Check aria-hidden className="size-3.5" /> : index}
      </span>
      <div className="min-w-0 flex-1">
        <h4 className="text-md font-semibold text-foreground">{title}</h4>
        <div className="mt-2 grid gap-3">{children}</div>
      </div>
    </section>
  )
}

function PlatformDetail({
  approved,
  approving,
  edits,
  onApprove,
  onClear,
  onEdit,
  onRevoke,
  onToggle,
  pending,
  platform,
  saving
}: {
  approved: PairingUser[]
  approving: null | string
  edits: Record<string, string>
  onApprove: (user: PairingUser) => void
  onClear: (key: string) => void
  onEdit: (key: string, value: string) => void
  onRevoke: (user: PairingUser) => void
  onToggle: (enabled: boolean) => void
  pending: PairingUser[]
  platform: MessagingPlatformInfo
  saving: string | null
}) {
  const { t } = useI18n()
  const m = t.messaging
  const [showRecommended, setShowRecommended] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const requiredFields = platform.env_vars.filter(field => field.required)
  const optionalFields = platform.env_vars.filter(field => !field.required && !fieldCopy(field, m).advanced)
  const advancedFields = platform.env_vars.filter(field => !field.required && fieldCopy(field, m).advanced)
  const summary = summaryOf(platform, m)

  const fieldRows = (fields: MessagingEnvVarInfo[]) =>
    fields.map(field => (
      <MessagingField edits={edits} field={field} key={field.key} onClear={onClear} onEdit={onEdit} saving={saving} />
    ))

  return (
    <>
      <header className="flex items-start gap-3">
        <PlatformAvatar platformId={platform.id} platformName={platform.name} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 truncate text-lg font-semibold tracking-tight">{platform.name}</h3>
            <StatusPill size="md" tone={summary.tone}>
              {summary.label}
            </StatusPill>
          </div>
          <p className="mt-1 text-sm text-(--ui-text-tertiary)">{taglineOf(platform, m)}</p>
          <PlatformHint platform={platform} />
        </div>
      </header>

      {platform.error_message && <ErrorBanner>{platform.error_message}</ErrorBanner>}

      {/* Pending pairing requests. Rendered only when someone is actually
          waiting — an empty-state card here would be permanent chrome on a
          page that is usually about setup, not approvals. */}
      {pending.length > 0 && (
        <div className="grid gap-1.5">
          {pending.map(user => (
            <PairingBanner
              busy={approving === pairingKey(user)}
              key={pairingKey(user)}
              onApprove={() => onApprove(user)}
              platformName={platform.name}
              user={user}
            />
          ))}
        </div>
      )}

      <div className="grid gap-6">
        <Step done={platform.configured} index={1} title={m.step1Title}>
          <p className="max-w-prose text-sm leading-relaxed text-(--ui-text-secondary)">{introCopy(platform, m)}</p>
          {platform.docs_url && (
            <div>
              <Button asChild size="sm" variant="textStrong">
                <a
                  href={platform.docs_url}
                  onClick={event => {
                    // Route through the validated external opener instead of
                    // letting Electron resolve the anchor. A packaged build's
                    // empty/relative href resolves to the app's own
                    // index.html file path, which shell.openPath then fails to
                    // open ("file not found"). Plugin platforms (Teams, etc.)
                    // ship no docs_url, so this guard + handler keeps the
                    // button from ever pointing at a local bundle path.
                    event.preventDefault()
                    openExternalLink(platform.docs_url)
                  }}
                  rel="noreferrer"
                  target="_blank"
                >
                  {m.openSetupGuide}
                  <ExternalLink className="size-3.5" />
                </a>
              </Button>
            </div>
          )}
        </Step>

        <Step done={platform.configured} index={2} title={m.step2Title}>
          {requiredFields.length > 0 ? (
            <div className="grid gap-4">{fieldRows(requiredFields)}</div>
          ) : (
            <p className="max-w-prose text-sm text-(--ui-text-tertiary)">{m.noTokenNeeded}</p>
          )}
          {optionalFields.length > 0 && (
            <div>
              <DisclosureRow onToggle={() => setShowRecommended(value => !value)} open={showRecommended}>
                {m.recommendedCount(optionalFields.length)}
              </DisclosureRow>
              {showRecommended && <div className="mt-2 grid gap-4 pl-5">{fieldRows(optionalFields)}</div>}
            </div>
          )}
          {advancedFields.length > 0 && (
            <div>
              <DisclosureRow onToggle={() => setShowAdvanced(value => !value)} open={showAdvanced}>
                {m.advanced(advancedFields.length)}
              </DisclosureRow>
              {showAdvanced && <div className="mt-2 grid gap-4 pl-5">{fieldRows(advancedFields)}</div>}
            </div>
          )}
        </Step>

        <Step done={platform.enabled} index={3} title={m.step3Title}>
          <div className="flex items-center gap-3">
            <Switch
              aria-label={platform.enabled ? m.disableAria(platform.name) : m.enableAria(platform.name)}
              checked={platform.enabled}
              className={cn('cursor-pointer', !platform.enabled && 'opacity-60')}
              disabled={saving === `enabled:${platform.id}`}
              onCheckedChange={onToggle}
              size="md"
            />
            <p className="text-sm text-(--ui-text-secondary)">{m.step3Enable(platform.name)}</p>
          </div>
          {platform.state === 'pending_restart' && (
            <div>
              <Button onClick={() => void runGatewayRestart()}>{m.restartNow}</Button>
            </div>
          )}
        </Step>
      </div>

      {approved.length > 0 && (
        <section>
          <SectionTitle>{m.approvedUsers(approved.length)}</SectionTitle>
          <div className="mt-1 grid gap-1">
            {approved.map(user => (
              <ListRow
                action={
                  <Button
                    aria-label={m.revokeAria(pairingLabel(user))}
                    onClick={() => onRevoke(user)}
                    size="sm"
                    variant="ghost"
                  >
                    {m.revoke}
                  </Button>
                }
                description={user.user_name ? user.user_id : undefined}
                key={pairingKey(user)}
                title={pairingLabel(user)}
              />
            ))}
          </div>
        </section>
      )}
    </>
  )
}

function PlatformActionBar({
  hasEdits,
  onSave,
  platform,
  saving
}: {
  hasEdits: boolean
  onSave: () => void
  platform: MessagingPlatformInfo
  saving: string | null
}) {
  const { t } = useI18n()
  const m = t.messaging
  const isSavingEnv = saving === `env:${platform.id}`

  // The enable switch lives in step 3 of the walkthrough — one action, one
  // home. The bar keeps the one thing that must survive scrolling: Save.
  return (
    <div className="ml-auto flex items-center gap-2">
      {hasEdits && <span className="text-xs text-muted-foreground">{m.unsavedChanges}</span>}
      <Button disabled={!hasEdits || isSavingEnv} onClick={onSave} size="sm">
        <Save />
        {isSavingEnv ? m.saving : m.saveChanges}
      </Button>
    </div>
  )
}

const PLATFORM_INTRO: Record<string, string> = {
  telegram:
    'In Telegram, talk to @BotFather, run /newbot, and copy the token it gives you. Then grab your numeric user ID from @userinfobot.',
  discord:
    'Open the Discord Developer Portal, create an application, add a Bot, then copy its token. Invite the bot to your server with the right scopes.',
  slack:
    'Create a Slack app, enable Socket Mode, install it to your workspace, then copy the bot token and app-level token.',
  mattermost:
    'On your Mattermost server, create a bot account or personal access token, then paste the server URL and token here.',
  matrix: 'Sign in to your homeserver with the bot account, then copy the access token, user ID, and homeserver URL.',
  signal:
    'Run a signal-cli REST bridge somewhere reachable, then point AgentX at the URL and the registered phone number.',
  whatsapp:
    'Start the WhatsApp bridge that ships with AgentX, scan the QR code on first run, then enable the platform.',
  bluebubbles:
    'Run BlueBubbles Server on a Mac with iMessage, expose its API, then point AgentX at the URL with the server password.',
  homeassistant:
    'In Home Assistant, open your profile and create a long-lived access token. Paste it here along with your HA URL.',
  email:
    'Use a dedicated mailbox. For Gmail/Workspace, create an app password and use imap.gmail.com / smtp.gmail.com.',
  sms: 'Get your Twilio Account SID and Auth Token from the Twilio console, plus a phone number that can send SMS.',
  dingtalk: 'Create a DingTalk app in the developer console, then copy the Client ID (App key) and Client Secret here.',
  feishu:
    'Create a Feishu / Lark app, configure the bot capability, and copy the App ID, App secret, and event encryption keys.',
  wecom:
    'Add a group robot in WeCom and copy its webhook key as WECOM_BOT_ID. Send-only — use the WeCom (app) option for two-way.',
  wecom_callback:
    'Set up a WeCom self-built app, expose its callback URL, and provide the corp ID, secret, agent ID, and AES key.',
  weixin:
    "Run `agentx gateway setup`, select Weixin, then scan and confirm the QR code with a personal WeChat account. AgentX connects through Tencent's iLink Bot API and saves the credentials.",
  qqbot: 'Register an app on the QQ Open Platform (q.qq.com) and copy the App ID and Client Secret.',
  api_server:
    'Expose AgentX as an OpenAI-compatible API. Set an auth key, then point Open WebUI / LobeChat / etc. at the host:port.',
  webhook:
    'Run an HTTP server that other tools (GitHub, GitLab, custom apps) can POST to. Use the secret to verify signatures.'
}

const introCopy = (platform: MessagingPlatformInfo, m: Translations['messaging']) =>
  m.platformIntro[platform.id] || PLATFORM_INTRO[platform.id] || platform.description

// One field of the paste-your-keys step: a 14px label (with its "Đã lưu" pill
// once the backend holds a value), a 13px help line, and a 36px input — a form
// a person fills top to bottom, not a settings grid.
function MessagingField({
  edits,
  field,
  onClear,
  onEdit,
  saving
}: {
  edits: Record<string, string>
  field: MessagingEnvVarInfo
  onClear: (key: string) => void
  onEdit: (key: string, value: string) => void
  saving: string | null
}) {
  const { t } = useI18n()
  const m = t.messaging
  const copy = fieldCopy(field, m)
  const fieldId = `messaging-field-${field.key}`

  return (
    <div className="grid gap-1">
      <label className="flex flex-wrap items-center gap-2 text-base font-medium text-foreground" htmlFor={fieldId}>
        {copy.label}
        {field.is_set && <StatusPill tone="good">{m.saved}</StatusPill>}
      </label>
      {copy.help && <p className="max-w-prose text-sm text-(--ui-text-tertiary)">{copy.help}</p>}
      <div className="mt-1 flex items-center gap-2">
        <Input
          className="max-w-md"
          id={fieldId}
          onChange={event => onEdit(field.key, event.target.value)}
          placeholder={field.is_set ? field.redacted_value || m.replaceValue : copy.placeholder}
          size="lg"
          type={field.is_password ? 'password' : 'text'}
          value={edits[field.key] || ''}
        />
        {field.url && (
          <Tip label={m.openDocs}>
            <Button asChild size="icon" variant="ghost">
              <a href={field.url} rel="noreferrer" target="_blank">
                <ExternalLink className="size-3.5" />
              </a>
            </Button>
          </Tip>
        )}
        {field.is_set && (
          <Tip label={m.clearField(field.key)}>
            <Button
              disabled={saving === `clear:${field.key}`}
              onClick={() => onClear(field.key)}
              size="icon"
              variant="ghost"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </Tip>
        )}
      </div>
    </div>
  )
}

// A section title is a sentence, not a stamp — 12px semibold, its own casing,
// no tracking (the same voice as PanelSectionLabel).
function SectionTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return <h4 className={cn('text-xs font-semibold text-(--ui-text-tertiary)', className)}>{children}</h4>
}

function PlatformHint({ platform }: { platform: MessagingPlatformInfo }) {
  const { t } = useI18n()

  if (!platform.enabled || platform.state === 'connected') {
    return null
  }

  const hint =
    platform.state === 'pending_restart'
      ? t.messaging.hintPendingRestart
      : platform.gateway_running
        ? null
        : t.messaging.hintGatewayStopped

  return hint ? <p className="mt-2 text-sm leading-5 text-(--ui-text-tertiary)">{hint}</p> : null
}
