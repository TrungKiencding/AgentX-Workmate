import { useStore } from '@nanostores/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type * as React from 'react'
import { useCallback, useMemo, useState } from 'react'

import { useDebounced } from '@/app/hooks/use-debounced'
import { DetailPane } from '@/app/master-detail'
import { PanelEmpty } from '@/app/overlays/panel'
import { CompactMarkdown } from '@/components/chat/compact-markdown'
import { LogTail } from '@/components/chat/log-tail'
import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ErrorBanner } from '@/components/ui/error-state'
import { StatusPill, type StatusPillTone } from '@/components/ui/status-pill'
import {
  StoreCard,
  StoreCardDescription,
  StoreCardFooter,
  StoreCardHeader,
  StoreCardMeta,
  StoreCardShelf,
  StoreCardTags
} from '@/components/ui/store-card'
import { Switch } from '@/components/ui/switch'
import { TagChip } from '@/components/ui/tag-chip'
import { Tip } from '@/components/ui/tooltip'
import {
  getSkillHubCatalog,
  previewSkillHub,
  scanSkillHub,
  searchSkillsHub,
  type SkillHubResult,
  type SkillHubScanResult
} from '@/hermes'
import { useI18n } from '@/i18n'
import { stripAnsi } from '@/lib/ansi'
import { compactNumber } from '@/lib/format'
import { CloudDownload, Loader2, MoreVertical, RefreshCw } from '@/lib/icons'
import { compareSemver } from '@/lib/semver'
import { skillDisplayName } from '@/lib/skill-categories'
import { normalize } from '@/lib/text'
import { cn } from '@/lib/utils'
import {
  $hubActions,
  $hubActiveLog,
  $hubInstalledOverride,
  closeHubLog,
  HUB_CATALOG_KEY,
  installHubSkill,
  uninstallHubSkill,
  UPDATE_ALL_KEY,
  updateHubSkill,
  updateHubSkills
} from '@/store/hub-actions'
import { notify, notifyError, readableError } from '@/store/notifications'
import type { HubStateView, SkillHubInstalledEntry, SkillInfo } from '@/types/hermes'

import { HubStateNote } from './hub-state-note'
import { HUB_CHANGES_KEY, HubStatus, type HubSync } from './hub-status'
import { ReplaceEditedSkillDialog, type ReplaceTarget } from './replace-edited-dialog'
import { skillMarkdownBody, skillsQueryOptions, toggleSkillEnabled } from './skills-data'
import { StoreBar, StoreNotice, StoreSource, syncedAt } from './store-tab'
import { useTrySkill } from './use-try-skill'

// The only source the store reads. The backend defaults to the same one, so
// this is belt and braces: a machine that has opted extra sources back in for
// the CLI still browses a store that is purely the hub.
const HUB_SOURCE_ID = 'agentx-hub'

// The store is the AgentX Skill Hub and nothing else — one registry, signed
// bundles, one trust story. The catalogue it opens on is synced from the hub
// without anyone signing in (public skills always; the person's own once a
// bearer exists). The backend answers from a 30-minute disk cache, so asking on
// every open is cheap and a real network sync happens at most that often; the
// interval keeps a tab left open honest.
export const HUB_CATALOG_REFRESH_MS = 30 * 60_000

// Stable empty arrays — a fresh `[]` per render would re-run every memo below.
const NO_SKILLS: SkillHubResult[] = []
const NO_HUB_STATES: Record<string, HubStateView> = {}
// An AgentX Hub skill's identifier is this and its slug.
const HUB_PREFIX = `${HUB_SOURCE_ID}/`

// Trust and scan verdicts paint from the semantic tokens through StatusPill,
// so the pill follows the skin on both bands instead of a fixed Tailwind ramp.
function trustTone(level: string): StatusPillTone {
  switch (level) {
    case 'builtin':
      return 'muted'

    case 'agentx-hub-verified':

    case 'trusted':

    case 'verified':
      return 'good'

    default:
      return 'warn'
  }
}

function verdictTone(policy: string): string {
  switch (policy) {
    case 'allow':
      return 'text-(--ui-green)'

    case 'block':
      return 'text-destructive'

    default:
      return 'text-(--ui-yellow)'
  }
}

/** Everything a card matches on, lowercased once per skill. */
function haystack(skill: SkillHubResult): string {
  return normalize(`${skill.name} ${skill.description} ${skill.identifier} ${(skill.tags ?? []).join(' ')}`)
}

/** An AgentX Hub install is locked at the version it resolved to (`agentx-hub/x@1.2.0`); the catalogue speaks `agentx-hub/x`. */
const unpinned = (identifier: string): string =>
  identifier.startsWith('agentx-hub/') ? identifier.split('@', 1)[0] : identifier

/** The Hub version newer than the one installed here, or null (a withdrawn
 *  newer version the machine still runs is not an "update"). */
function hubUpdateFor(skill: SkillHubResult, entry: null | SkillHubInstalledEntry | undefined): null | string {
  const latest = typeof skill.extra?.version === 'string' ? skill.extra.version : ''

  return entry?.version && latest && compareSemver(latest, entry.version) > 0 ? latest : null
}

/** The trust pill, kind and reach tags every hub card carries. */
function HubSkillTags({ children, skill }: { children?: React.ReactNode; skill: SkillHubResult }) {
  const { t } = useI18n()
  const h = t.skills.hub
  const extra = skill.extra ?? {}
  const visibility = extra.visibility === 'workspace' || extra.visibility === 'private' ? extra.visibility : null
  const kind = extra.kind === 'browser' || extra.kind === 'core' ? extra.kind : null
  const downloads = Number(extra.downloads ?? 0)

  return (
    <StoreCardTags>
      {kind && <TagChip>{h.kind[kind]}</TagChip>}
      <StatusPill tone={trustTone(skill.trust_level)}>{h.trust[skill.trust_level] ?? skill.trust_level}</StatusPill>
      {visibility && <TagChip>{t.skills.publish.visibilityOptions[visibility]}</TagChip>}
      {downloads > 0 && (
        <StoreCardMeta className="flex items-center gap-1">
          <CloudDownload className="size-3.5" />
          {compactNumber(downloads)}
        </StoreCardMeta>
      )}
      {children}
    </StoreCardTags>
  )
}

// One catalogue card — a self-contained tile that installs ITSELF and reads
// its own action status from the store, so parallel installs never desync. A
// card is metadata only: nothing reaches the skills tree until "Thêm kỹ năng
// này" runs. Once added it says so and stays where it is — the skill itself
// is managed from its card on the "Đã thêm" shelf above, so the catalogue
// never jumps under the pointer that just pressed Add.
function HubCatalogCard({
  installed,
  onPreview,
  skill
}: {
  installed: boolean
  onPreview: (skill: SkillHubResult) => void
  skill: SkillHubResult
}) {
  const { t } = useI18n()
  const h = t.skills.hub
  const action = useStore($hubActions)[skill.identifier]
  const running = action?.running ?? false
  const version = typeof skill.extra?.version === 'string' ? skill.extra.version : ''

  const doInstall = () => {
    notify({ kind: 'success', title: h.installStarted(skill.name), message: h.actionLog })
    void installHubSkill(skill.identifier).catch(err => notifyError(err, h.actionFailed))
  }

  return (
    <StoreCard data-identifier={skill.identifier} data-testid="hub-card">
      <StoreCardHeader
        meta={
          version && (
            <span className="shrink-0 font-mono text-xs text-(--ui-text-tertiary)" data-testid="hub-card-version">
              {version}
            </span>
          )
        }
        title={skillDisplayName(skill.name)}
      />
      <StoreCardDescription>{skill.description || t.skills.noDescription}</StoreCardDescription>
      <HubSkillTags skill={skill} />
      <StoreCardFooter
        end={
          installed ? (
            <StatusPill data-testid="hub-card-installed" size="md" tone="good">
              {h.installed}
            </StatusPill>
          ) : (
            <Button disabled={running} loading={running} onClick={doInstall} size="sm">
              {h.install}
            </Button>
          )
        }
      >
        <Button
          aria-label={h.previewFor(skillDisplayName(skill.name))}
          onClick={() => onPreview(skill)}
          size="sm"
          variant="text"
        >
          {h.preview}
        </Button>
      </StoreCardFooter>
    </StoreCard>
  )
}

// One skill this machine runs from the hub, managed where it is listed: the
// same switch and "Thử ngay" a skill you already had carries, the version it
// runs, the newer one waiting (or, for a copy edited here, the replacement
// that has to be confirmed — hub decision §8 #20), and removal behind ⋯.
// `localSkill` is the backend's row for it (enabled state), once the skills
// list has it; until then the card is metadata with its verbs.
function HubInstalledCard({
  hubState,
  installedEntry,
  localSkill,
  onInstall,
  onPreview,
  onReplace,
  onToggle,
  onTryNow,
  skill,
  successorInstalled
}: {
  /** What AgentX Hub last said of it (hub decision §8 #22): kept off by the hub, no longer published, no longer yours to see. */
  hubState: HubStateView | null
  installedEntry: null | SkillHubInstalledEntry
  localSkill: null | SkillInfo
  onInstall: (identifier: string, name: string) => void
  onPreview: (skill: SkillHubResult) => void
  onReplace: (target: ReplaceTarget) => void
  onToggle: (skill: SkillInfo, enabled: boolean) => void
  onTryNow: (skillName: string) => void
  skill: SkillHubResult
  successorInstalled: boolean
}) {
  const { t } = useI18n()
  const h = t.skills.hub
  const action = useStore($hubActions)[skill.identifier]
  const running = action?.running ?? false
  const installedName = installedEntry?.name ?? null
  const updateTo = hubUpdateFor(skill, installedEntry)
  const edited = Boolean(installedEntry?.modified)
  const shownVersion = installedEntry?.version || (typeof skill.extra?.version === 'string' ? skill.extra.version : '')
  const off = localSkill ? !localSkill.enabled : false
  // The hub keeps it off: the switch is the hub's until it turns it back on (the backend refuses too).
  const held = hubState?.desired_state === 'disabled'
  const successor = hubState?.status === 'archived' ? hubState.successor : null
  const successorName = successor ? successor.name || successor.slug : ''

  const doUpdate = () => {
    notify({ kind: 'success', title: h.updateOneStarted(skill.name), message: h.actionLog })
    void updateHubSkill(skill.identifier, installedName || skill.name).catch(err => notifyError(err, h.actionFailed))
  }

  const doUninstall = () => {
    notify({ kind: 'success', title: h.uninstallStarted(skill.name), message: h.actionLog })
    void uninstallHubSkill(skill.identifier, installedName || skill.name).catch(err => notifyError(err, h.actionFailed))
  }

  return (
    <StoreCard data-identifier={skill.identifier} data-testid="hub-installed-card">
      <StoreCardHeader
        control={
          localSkill &&
          (held ? (
            <Tip label={h.state.switchLocked}>
              <span data-testid="hub-card-switch-locked">
                <Switch
                  aria-label={t.skills.toggleSkill(skillDisplayName(skill.name), true)}
                  checked={false}
                  data-testid="hub-card-switch"
                  disabled
                  size="md"
                />
              </span>
            </Tip>
          ) : (
            <Switch
              aria-label={t.skills.toggleSkill(skillDisplayName(skill.name), !localSkill.enabled)}
              checked={localSkill.enabled}
              className="cursor-pointer"
              data-testid="hub-card-switch"
              disabled={running}
              onCheckedChange={enabled => onToggle(localSkill, enabled)}
              size="md"
            />
          ))
        }
        dimmed={off || held}
        // One pill: the hub's switch-off outranks off, which outranks the version, as on "Kỹ năng sẵn có".
        meta={
          held ? (
            <StatusPill data-testid="hub-card-held" tone="bad">
              {h.state.heldPill}
            </StatusPill>
          ) : off ? (
            <StatusPill tone="muted">{t.skills.switchedOff}</StatusPill>
          ) : (
            shownVersion && (
              <span className="shrink-0 font-mono text-xs text-(--ui-text-tertiary)" data-testid="hub-card-version">
                {shownVersion}
              </span>
            )
          )
        }
        title={skillDisplayName(skill.name)}
      />
      <StoreCardDescription>
        {skill.description || localSkill?.description || t.skills.noDescription}
      </StoreCardDescription>
      {hubState && <HubStateNote hubState={hubState} />}
      {(hubState?.status === 'archived' || hubState?.visible === false) && (
        <StoreCardTags>
          {hubState.status === 'archived' && (
            <StatusPill data-testid="hub-card-archived" tone="warn">
              {h.state.archivedPill}
            </StatusPill>
          )}
          {hubState.visible === false && (
            <StatusPill data-testid="hub-card-hidden" tone="muted">
              {h.state.hiddenPill}
            </StatusPill>
          )}
          {successor &&
            (successorInstalled ? (
              <span className="text-xs text-(--ui-text-tertiary)" data-testid="hub-card-successor-installed">
                {h.state.successorInstalled(successorName)}
              </span>
            ) : (
              <Button
                data-testid="hub-card-install-successor"
                onClick={() => onInstall(`agentx-hub/${successor.slug}`, successorName)}
                size="sm"
                variant="textStrong"
              >
                {h.state.installSuccessor(successorName)}
              </Button>
            ))}
        </StoreCardTags>
      )}
      {(updateTo || edited) && (
        // The newer version and what to do about it sit together, beside the
        // pill that says so — the footer keeps "Thử ngay" and ⋯ on one line
        // at the narrowest column.
        <StoreCardTags>
          {updateTo && (
            <StatusPill data-testid="hub-card-update-available" tone="warn">
              {h.updateTo(updateTo)}
            </StatusPill>
          )}
          {edited && (
            <StatusPill data-testid="hub-card-edited" tone="muted">
              {h.editedHere}
            </StatusPill>
          )}
          {updateTo &&
            (edited ? (
              <Button
                data-testid="hub-card-replace"
                disabled={running}
                onClick={() =>
                  onReplace({ identifier: skill.identifier, name: installedName || skill.name, version: updateTo })
                }
                size="sm"
                variant="textStrong"
              >
                {h.replaceWithHub}
              </Button>
            ) : (
              <Button
                data-testid="hub-card-update"
                disabled={running}
                loading={running && action?.kind === 'update'}
                onClick={doUpdate}
                size="sm"
                variant="textStrong"
              >
                {h.updateThis}
              </Button>
            ))}
        </StoreCardTags>
      )}
      <StoreCardFooter
        end={
          <>
            {localSkill?.enabled && (
              <Button
                data-testid="hub-card-try-now"
                onClick={() => onTryNow(localSkill.name)}
                size="sm"
                variant="secondary"
              >
                {t.skills.tryNow}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button aria-label={h.actions} size="icon-sm" variant="ghost">
                  <MoreVertical />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={4}>
                <DropdownMenuItem disabled={running} onSelect={doUninstall} variant="destructive">
                  {running ? h.uninstalling : h.uninstall}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      >
        <Button
          aria-label={h.previewFor(skillDisplayName(skill.name))}
          onClick={() => onPreview(skill)}
          size="sm"
          variant="text"
        >
          {h.preview}
        </Button>
      </StoreCardFooter>
    </StoreCard>
  )
}

interface SkillsHubProps {
  query: string
  /** The store's kind switch, rendered first in the bar (see `StoreTab`). */
  switcher: React.ReactNode
  /** The store's hub sync (`useHubSync`), owned by `StoreTab`. */
  sync: HubSync
}

export function SkillsHub({ query, switcher, sync }: SkillsHubProps) {
  const { locale, t } = useI18n()
  const h = t.skills.hub
  const queryClient = useQueryClient()
  const trySkill = useTrySkill()

  // The backend's own rows for the skills on this machine (the same cache the
  // "Kỹ năng sẵn có" tab reads): an installed card finds its enabled state
  // here by the local name the catalogue's `installed` map gives it.
  const { data: localSkills } = useQuery(skillsQueryOptions)

  const localByName = useMemo(() => new Map((localSkills ?? []).map(skill => [skill.name, skill])), [localSkills])

  const toggleLocal = useCallback(
    (skill: SkillInfo, enabled: boolean) =>
      void toggleSkillEnabled(skill, enabled, t.skills.failedToUpdate(skill.name)),
    [t]
  )

  // The store front: the hub's catalog, synced on every open and every 30
  // minutes after that. No sign-in — the public catalogue answers anonymously,
  // and a bearer (when this machine has one) simply widens it to the person's
  // own skills, their workspaces' and their organisation's public ones.
  const catalogQuery = useQuery({
    queryKey: HUB_CATALOG_KEY,
    queryFn: () => getSkillHubCatalog(),
    refetchInterval: HUB_CATALOG_REFRESH_MS,
    refetchOnWindowFocus: false,
    staleTime: 0
  })

  const [syncing, setSyncing] = useState(false)

  // The Sync button: force a real catalogue sync (bypassing the backend's
  // 30-minute cache) and, when this machine is signed in, reconcile what the
  // hub asked it to install in the same press.
  const { tick } = sync

  const syncNow = useCallback(() => {
    setSyncing(true)
    void tick(false)
      .then(() => getSkillHubCatalog(true))
      .then(data => queryClient.setQueryData(HUB_CATALOG_KEY, data))
      .catch(err => notifyError(err, h.loadFailed))
      .finally(() => {
        setSyncing(false)
        void queryClient.invalidateQueries({ queryKey: HUB_CHANGES_KEY })
      })
  }, [h, queryClient, tick])

  // Debounced hub search, keyed on the settled query so RQ dedupes/caches per
  // term and abandons stale terms for us (no hand-rolled sequence guard).
  const term = useDebounced(query.trim(), 350)

  // One search, against the hub. The cached catalogue is filtered on the spot
  // (below); this reaches the hub itself for what the cache doesn't hold — a
  // catalogue past its page cap, or a skill published since the last sync.
  const search = useQuery({
    queryKey: ['skill-hub-search', term],
    queryFn: () => searchSkillsHub(term, HUB_SOURCE_ID),
    enabled: term.length > 0,
    staleTime: 60_000
  })

  // Per-item action lifecycle + log live in the store (store/hub-actions): each
  // card reads ITS own entry, so concurrent installs never desync each other,
  // and an optimistic installed-override flips a card the instant its action
  // resolves rather than racing the catalogue refetch.
  const actions = useStore($hubActions)
  const overrides = useStore($hubInstalledOverride)
  const activeLogKey = useStore($hubActiveLog)
  const activeLog = activeLogKey ? actions[activeLogKey] : undefined

  // Preview/scan dialog. Preview is cache-worthy (keyed by identifier); scan is
  // an explicit, on-demand security pass so it stays imperative.
  const [detail, setDetail] = useState<null | SkillHubResult>(null)
  const [replace, setReplace] = useState<null | ReplaceTarget>(null)
  const [scan, setScan] = useState<null | SkillHubScanResult>(null)
  const [scanning, setScanning] = useState(false)

  // One quick retry, then the dialog says what went wrong: a skill the hub
  // refuses to hand over (404 / 403) will not turn up on the third attempt,
  // and a spinner that ends in a blank pane is the worst of both.
  const previewQuery = useQuery({
    queryKey: ['skill-hub-preview', detail?.identifier],
    queryFn: () => previewSkillHub(detail!.identifier),
    enabled: detail !== null,
    retry: 1,
    staleTime: 5 * 60_000
  })

  const install = useCallback(
    (identifier: string, name: string) => {
      setDetail(null)
      notify({ kind: 'success', title: h.installStarted(name), message: h.actionLog })
      void installHubSkill(identifier).catch(err => notifyError(err, h.actionFailed))
    },
    [h]
  )

  const updateAll = useCallback(() => {
    notify({ kind: 'success', title: h.updateStarted, message: h.actionLog })
    void updateHubSkills().catch(err => notifyError(err, h.actionFailed))
  }, [h])

  const runScan = useCallback(
    (identifier: string) => {
      setScanning(true)
      scanSkillHub(identifier)
        .then(setScan)
        .catch(err => notifyError(err, h.scanFailed))
        .finally(() => setScanning(false))
    },
    [h]
  )

  const openDetail = useCallback((skill: SkillHubResult) => {
    setDetail(skill)
    setScan(null)
  }, [])

  const results = search.data?.results ?? NO_SKILLS
  const catalog = catalogQuery.data?.skills ?? NO_SKILLS

  // Searching filters the synced catalogue on the spot — no round trip for the
  // skills we already hold.
  const catalogMatches = useMemo(() => {
    if (term.length === 0) {
      return catalog
    }

    const needle = normalize(term)

    return catalog.filter(skill => haystack(skill).includes(needle))
  }, [catalog, term])

  // Landing: the whole catalogue. Searching: the catalogue's own hits first,
  // then anything the hub returns that the cached catalogue didn't hold.
  const listed = useMemo(() => {
    if (term.length === 0) {
      return catalog
    }

    const merged = new Map(catalogMatches.map(skill => [skill.identifier, skill]))

    for (const result of results) {
      if (!merged.has(result.identifier)) {
        merged.set(result.identifier, result)
      }
    }

    return [...merged.values()]
  }, [catalog, catalogMatches, results, term])

  // Installed map: the catalogue and the search each carry all of it, read as
  // the backend answered, so the newer answer is the truth — a search can show
  // an install made since the catalogue answered, and an older search must not
  // bring back a skill removed since. The optimistic override wins until the
  // catalogue answers again, so a just-(un)installed card reflects its own
  // outcome without the refetch race.
  const installed = useMemo(
    () =>
      (search.data && search.dataUpdatedAt > catalogQuery.dataUpdatedAt
        ? search.data.installed
        : catalogQuery.data?.installed) ?? {},
    [catalogQuery.data?.installed, catalogQuery.dataUpdatedAt, search.data, search.dataUpdatedAt]
  )

  const isInstalled = (identifier: string) => overrides[identifier] ?? Boolean(installed[identifier])

  // What the hub last said of each skill here, by slug (the sync keeps it across restarts).
  const hubStates = sync.changes.data?.hub_state?.skills ?? NO_HUB_STATES

  // "Đã thêm": every skill this machine runs from the hub, one card each — the
  // installed map is keyed by identifier, and a pinned `agentx-hub/x@1.2.0` is
  // also filed under its unpinned alias, so rows fold by the local name. A
  // skill the catalogue no longer lists (withdrawn, private to a workspace
  // left since, past the page cap) still gets its card from the local row:
  // installed skills are managed nowhere else, so none may go missing here.
  // A just-added skill joins from its override; a just-removed one leaves.
  const installedCards = useMemo(() => {
    const byIdentifier = new Map<string, SkillHubResult>()

    for (const skill of [...catalog, ...results]) {
      byIdentifier.set(skill.identifier, skill)
    }

    const rows = new Map<string, { entry: null | SkillHubInstalledEntry; identifier: string }>()

    for (const [identifier, entry] of Object.entries(installed)) {
      const key = entry.name ?? identifier

      if (!rows.has(key)) {
        rows.set(key, { entry, identifier: unpinned(identifier) })
      }
    }

    for (const [identifier, added] of Object.entries(overrides)) {
      const skill = byIdentifier.get(identifier)

      if (added && skill && ![...rows.values()].some(row => row.identifier === identifier)) {
        rows.set(skill.name, { entry: null, identifier })
      }
    }

    const catalogOrder = new Map(catalog.map((skill, index) => [skill.identifier, index]))

    return [...rows.entries()]
      .filter(([, row]) => overrides[row.identifier] !== false)
      .map(([localName, row]) => {
        const local = localByName.get(localName) ?? null

        const skill: SkillHubResult = byIdentifier.get(row.identifier) ?? {
          description: local?.description ?? '',
          extra: row.entry?.version ? { version: row.entry.version } : {},
          identifier: row.identifier,
          name: localName,
          repo: null,
          source: row.identifier.split('/')[0] ?? '',
          tags: [],
          trust_level: row.entry?.trust_level ?? 'community'
        }

        return { entry: row.entry, local, localName, skill }
      })
      .sort(
        (a, b) =>
          (catalogOrder.get(a.skill.identifier) ?? Number.MAX_SAFE_INTEGER) -
            (catalogOrder.get(b.skill.identifier) ?? Number.MAX_SAFE_INTEGER) ||
          a.skill.name.localeCompare(b.skill.name)
      )
  }, [catalog, installed, localByName, overrides, results])

  // A search narrows "Đã thêm" like every shelf; what the machine runs (and so
  // whether "Cập nhật tất cả" is offered) does not depend on it.
  const shownInstalled = useMemo(() => {
    const needle = normalize(term)

    return needle.length === 0 ? installedCards : installedCards.filter(({ skill }) => haystack(skill).includes(needle))
  }, [installedCards, term])

  const anyFetching = term.length > 0 && search.isFetching
  const searched = term.length > 0 && !search.isFetching
  const showLanding = term.length === 0
  // Only block the whole pane when there is nothing to show yet; a search over
  // the cached catalogue answers instantly while the hub's own reply lands.
  const loading = showLanding ? catalogQuery.isLoading && catalog.length === 0 : anyFetching && listed.length === 0
  const hasInstalled = installedCards.length > 0
  const offline = Boolean(catalogQuery.data?.stale && catalogQuery.data.error)
  const neverSynced = Boolean(catalogQuery.data && !catalogQuery.data.fetched_at)

  const lastSync = catalogQuery.data?.fetched_at
    ? h.lastSync(syncedAt(catalogQuery.data.fetched_at, locale))
    : h.neverSynced

  const updatingAll = actions[UPDATE_ALL_KEY]?.running ?? false
  // Newer Hub versions of what this machine runs: "Update all" takes the ones
  // left as installed and keeps the ones edited here (they are replaced one by
  // one, after a confirmation).
  const withUpdate = catalog.filter(skill => hubUpdateFor(skill, installed[skill.identifier]) !== null)
  const editedWithUpdate = withUpdate.filter(skill => installed[skill.identifier]?.modified).length
  const plainWithUpdate = withUpdate.length - editedWithUpdate

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StoreBar
        actions={
          <>
            {hasInstalled && (
              <Button
                data-testid="hub-update-all"
                disabled={updatingAll}
                onClick={updateAll}
                size="sm"
                variant={plainWithUpdate > 0 ? 'secondary' : 'ghost'}
              >
                {updatingAll && <Loader2 className="size-3.5 animate-spin" />}
                {updatingAll ? h.updating : plainWithUpdate > 0 ? h.updateAllCount(plainWithUpdate) : h.updateAll}
              </Button>
            )}
            <Button data-testid="hub-sync" disabled={syncing} onClick={syncNow} size="sm" variant="outline">
              {syncing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw />}
              {syncing ? h.syncing : h.syncNow}
            </Button>
          </>
        }
        line={
          <span data-testid="hub-catalog-line">
            {term.length > 0 ? h.resultCount(listed.length, null) : h.catalogCount(catalog.length)}
            <span className="text-(--ui-text-quaternary)"> · </span>
            {lastSync}
            {anyFetching && listed.length > 0 && (
              <span className="ml-2 text-(--ui-text-quaternary)">{h.searching}</span>
            )}
          </span>
        }
        source={
          <StoreSource
            label={offline || neverSynced ? h.storeOffline : catalogQuery.data ? h.storeOnline : h.syncing}
            testId="hub-store-state"
            tone={offline || neverSynced ? 'warn' : catalogQuery.data ? 'good' : 'info'}
            url={catalogQuery.data?.hub_url}
          />
        }
        switcher={switcher}
      >
        {offline && (
          <StoreNotice data-testid="hub-catalog-offline" tone="warn">
            {h.catalogOffline}
          </StoreNotice>
        )}
        {editedWithUpdate > 0 && (
          <StoreNotice data-testid="hub-edited-note">{h.keptOnUpdateAll(editedWithUpdate)}</StoreNotice>
        )}
      </StoreBar>

      {/* Scrollable shelves. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 [scrollbar-gutter:stable]">
        {/* What the hub asked this machine to do (installs from the web, yanks,
            workspace skills) — on the landing view, and only when there is something
            to say: browsing the store needs no account. */}
        {showLanding && <HubStatus hideWhenIdle sync={sync} />}
        <div className="grid gap-6">
          {shownInstalled.length > 0 && (
            <StoreCardShelf count={shownInstalled.length} data-testid="hub-shelf-installed" label={h.shelfInstalled}>
              {shownInstalled.map(({ entry, local, localName, skill }) => {
                const hubState = skill.identifier.startsWith(HUB_PREFIX)
                  ? (hubStates[skill.identifier.slice(HUB_PREFIX.length)] ?? null)
                  : null

                const successor = hubState?.status === 'archived' ? hubState.successor : null

                return (
                  <HubInstalledCard
                    hubState={hubState}
                    installedEntry={entry}
                    key={localName}
                    localSkill={local}
                    onInstall={install}
                    onPreview={openDetail}
                    onReplace={setReplace}
                    onToggle={toggleLocal}
                    onTryNow={trySkill}
                    skill={skill}
                    successorInstalled={successor ? isInstalled(`${HUB_PREFIX}${successor.slug}`) : false}
                  />
                )
              })}
            </StoreCardShelf>
          )}
          {loading ? (
            <div className="grid min-h-40 place-items-center">
              <PageLoader label={h.searching} />
            </div>
          ) : listed.length === 0 ? (
            <PanelEmpty
              action={
                searched ? null : (
                  <Button disabled={syncing} onClick={syncNow} size="sm" variant="secondary">
                    {h.syncNow}
                  </Button>
                )
              }
              description={searched ? h.searchEmptyDesc : h.catalogEmptyDesc}
              figure="box"
              title={searched ? h.noResults : h.catalogEmpty}
            />
          ) : (
            <StoreCardShelf count={listed.length} data-testid="hub-shelf-catalog" label={h.shelfCatalog}>
              {listed.map(skill => (
                <HubCatalogCard
                  installed={isInstalled(skill.identifier)}
                  key={skill.identifier}
                  onPreview={openDetail}
                  skill={skill}
                />
              ))}
            </StoreCardShelf>
          )}
        </div>
      </div>

      {/* Action log — same resizable, flush-width bottom pane + LogTail surface
          the MCP logs use. ANSI stripped so spawn output reads clean. Tails the
          latest-started action ($hubActiveLog). */}
      {activeLogKey && (
        <DetailPane
          defaultCollapsed
          defaultHeight={176}
          id="hub-action-log"
          onClose={closeHubLog}
          title={
            <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground/60">
              {h.actionLog}
              {activeLog?.running && <Loader2 className="size-3 animate-spin" />}
            </span>
          }
        >
          <LogTail emptyLabel={h.searching} lines={activeLog?.lines.length ? activeLog.lines.map(stripAnsi) : null} />
        </DetailPane>
      )}

      <ReplaceEditedSkillDialog onClose={() => setReplace(null)} target={replace} />

      <Dialog onOpenChange={open => !open && setDetail(null)} open={detail !== null}>
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-hidden">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <span className="truncate">{detail.name}</span>
                  <StatusPill tone={trustTone(detail.trust_level)}>
                    {h.trust[detail.trust_level] ?? detail.trust_level}
                  </StatusPill>
                </DialogTitle>
                <DialogDescription className="truncate">{detail.identifier}</DialogDescription>
              </DialogHeader>

              <div className="min-h-0 space-y-3 overflow-y-auto">
                {scan && (
                  <div className="rounded-(--radius-card) bg-(--ui-bg-quinary) p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill
                        tone={scan.verdict === 'safe' ? 'good' : scan.verdict === 'dangerous' ? 'bad' : 'warn'}
                      >
                        {scan.verdict === 'safe'
                          ? h.verdictSafe
                          : scan.verdict === 'dangerous'
                            ? h.verdictDangerous
                            : h.verdictCaution}
                      </StatusPill>
                      <span className={cn('font-medium', verdictTone(scan.policy))}>
                        {scan.policy === 'allow'
                          ? h.policyAllow
                          : scan.policy === 'block'
                            ? h.policyBlock
                            : h.policyAsk}
                      </span>
                    </div>
                    <div className="mt-1.5 text-(--ui-text-tertiary)">
                      {scan.findings.length === 0 ? h.noFindings : h.findings(scan.findings.length)}
                    </div>
                    {scan.findings.slice(0, 12).map((finding, index) => (
                      <div className="mt-1.5 font-mono text-xs text-(--ui-text-tertiary)" key={index}>
                        [{finding.severity}] {finding.file}
                        {finding.line !== null ? `:${finding.line}` : ''} — {finding.description}
                      </div>
                    ))}
                  </div>
                )}

                {previewQuery.isLoading ? (
                  <PageLoader className="min-h-32" label={h.searching} />
                ) : previewQuery.isError ? (
                  <ErrorBanner data-testid="hub-preview-error">
                    <span className="flex flex-col gap-1.5">
                      <span className="font-medium">{h.previewFailed}</span>
                      <span className="text-foreground/80">
                        {readableError(previewQuery.error, h.previewFailed).message}
                      </span>
                      <Button
                        className="self-start"
                        disabled={previewQuery.isFetching}
                        onClick={() => void previewQuery.refetch()}
                        size="sm"
                        variant="text"
                      >
                        {t.common.retry}
                      </Button>
                    </span>
                  </ErrorBanner>
                ) : previewQuery.data ? (
                  <>
                    {skillMarkdownBody(previewQuery.data.skill_md) ? (
                      <div className="max-h-72 overflow-auto rounded-(--radius-card) bg-(--ui-bg-quinary) p-3">
                        <CompactMarkdown className="text-sm" text={skillMarkdownBody(previewQuery.data.skill_md)} />
                      </div>
                    ) : (
                      <p className="text-sm text-(--ui-text-tertiary)">{h.noReadme}</p>
                    )}
                    {previewQuery.data.files.length > 0 && (
                      <div className="text-sm text-(--ui-text-tertiary)">
                        <span className="font-medium">{h.files}:</span> {previewQuery.data.files.join(', ')}
                      </div>
                    )}
                  </>
                ) : null}
              </div>

              <DialogFooter>
                <Button disabled={scanning} onClick={() => runScan(detail.identifier)} size="sm" variant="text">
                  {scanning ? h.scanning : h.scan}
                </Button>
                {isInstalled(detail.identifier) ? (
                  <StatusPill size="md" tone="good">
                    {h.installed}
                  </StatusPill>
                ) : (
                  <Button
                    disabled={actions[detail.identifier]?.running}
                    onClick={() => install(detail.identifier, detail.name)}
                  >
                    {h.install}
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
