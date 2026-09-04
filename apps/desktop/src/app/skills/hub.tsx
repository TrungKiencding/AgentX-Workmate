import { useStore } from '@nanostores/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'

import { useDebounced } from '@/app/hooks/use-debounced'
import { DetailPane } from '@/app/master-detail'
import { LogTail } from '@/components/chat/log-tail'
import { PageLoader } from '@/components/page-loader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  getSkillHubCatalog,
  previewSkillHub,
  scanSkillHub,
  searchSkillsHub,
  type SkillHubResult,
  type SkillHubScanResult,
  tickSkillHub
} from '@/hermes'
import { useI18n } from '@/i18n'
import { stripAnsi } from '@/lib/ansi'
import { compactNumber } from '@/lib/format'
import { Loader2 } from '@/lib/icons'
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
  updateHubSkills
} from '@/store/hub-actions'
import { notify, notifyError } from '@/store/notifications'

import { HUB_CHANGES_KEY, HubStatus } from './hub-status'

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

function trustTone(level: string): string {
  switch (level) {
    case 'builtin':
      return 'bg-(--ui-bg-tertiary) text-(--ui-text-secondary)'

    case 'trusted':
      return 'bg-emerald-500/15 text-emerald-400'

    default:
      return 'bg-amber-500/15 text-amber-400'
  }
}

function verdictTone(policy: string): string {
  switch (policy) {
    case 'allow':
      return 'text-emerald-400'

    case 'block':
      return 'text-destructive'

    default:
      return 'text-amber-400'
  }
}

/** `fetched_at` (Unix seconds, 0 = never) as a clock time in the UI's locale. */
function syncedAt(seconds: number | undefined, locale: string): string {
  if (!seconds) {
    return ''
  }

  const date = new Date(seconds * 1000)

  if (Number.isNaN(date.getTime())) {
    return ''
  }

  try {
    return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return date.toLocaleTimeString()
  }
}

/** The hub as people know it — its host, not the scheme and path. */
function hubHost(url: string | undefined): string {
  if (!url) {
    return ''
  }

  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Everything a card matches on, lowercased once per skill. */
function haystack(skill: SkillHubResult): string {
  return normalize(`${skill.name} ${skill.description} ${skill.identifier} ${(skill.tags ?? []).join(' ')}`)
}

// One catalogue card — a self-contained tile that installs/uninstalls ITSELF
// and reads its own action status from the store, so parallel installs never
// desync. A card is metadata only: nothing reaches the skills tree until
// Install runs. `rawInstalled` is the sources/catalog truth; the store's
// optimistic override wins so the card flips the instant its action resolves.
function HubSkillCard({
  installedName,
  onPreview,
  rawInstalled,
  skill
}: {
  installedName: null | string
  onPreview: (skill: SkillHubResult) => void
  rawInstalled: boolean
  skill: SkillHubResult
}) {
  const { t } = useI18n()
  const h = t.skills.hub
  const action = useStore($hubActions)[skill.identifier]
  const override = useStore($hubInstalledOverride)[skill.identifier]
  const installed = override ?? rawInstalled
  const running = action?.running ?? false
  const extra = skill.extra ?? {}
  const visibility = extra.visibility === 'org' || extra.visibility === 'private' ? extra.visibility : null
  const kind = extra.kind === 'browser' || extra.kind === 'core' ? extra.kind : null
  const downloads = Number(extra.downloads ?? 0)

  const doInstall = () => {
    notify({ kind: 'success', title: h.installStarted(skill.name), message: h.actionLog })
    void installHubSkill(skill.identifier).catch(err => notifyError(err, h.actionFailed))
  }

  const doUninstall = () => {
    notify({ kind: 'success', title: h.uninstallStarted(skill.name), message: h.actionLog })
    void uninstallHubSkill(skill.identifier, installedName || skill.name).catch(err => notifyError(err, h.actionFailed))
  }

  return (
    <article
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) p-3.5 transition-colors hover:border-(--ui-stroke-secondary)"
      data-testid="hub-card"
    >
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{skill.name}</span>
        {extra.version && <span className="shrink-0 font-mono text-2xs text-(--ui-text-quaternary)">{extra.version}</span>}
      </div>

      <p className="line-clamp-3 text-xs text-muted-foreground/80">{skill.description || t.skills.noDescription}</p>

      <div className="flex flex-wrap items-center gap-1.5">
        {kind && (
          <span className="rounded bg-(--ui-bg-tertiary) px-1.5 py-0.5 text-2xs text-(--ui-text-secondary)">{h.kind[kind]}</span>
        )}
        <span className={cn('rounded px-1.5 py-0.5 text-2xs', trustTone(skill.trust_level))}>
          {h.trust[skill.trust_level] ?? skill.trust_level}
        </span>
        {visibility && (
          <span className="rounded bg-(--ui-bg-tertiary) px-1.5 py-0.5 text-2xs text-(--ui-text-secondary)">
            {t.skills.publish.visibilityOptions[visibility]}
          </span>
        )}
        {installed && <span className="text-2xs text-emerald-400">{h.installed}</span>}
        {downloads > 0 && (
          <span className="flex items-center gap-1 text-2xs text-(--ui-text-quaternary)">
            <Codicon name="cloud-download" size="0.7rem" />
            {compactNumber(downloads)}
          </span>
        )}
      </div>

      <div className="mt-auto flex items-center justify-end gap-1">
        <Button onClick={() => onPreview(skill)} size="xs" variant="text">
          {h.preview}
        </Button>
        {installed ? (
          <Button className="hover:text-destructive" disabled={running} onClick={doUninstall} size="xs" variant="text">
            {running && <Loader2 className="size-3 animate-spin" />}
            {running ? h.uninstalling : h.uninstall}
          </Button>
        ) : (
          <Button disabled={running} onClick={doInstall} size="xs" variant="textStrong">
            {running && <Loader2 className="size-3 animate-spin" />}
            {running ? h.installing : h.install}
          </Button>
        )}
      </div>
    </article>
  )
}

interface SkillsHubProps {
  query: string
}

export function SkillsHub({ query }: SkillsHubProps) {
  const { locale, t } = useI18n()
  const h = t.skills.hub
  const queryClient = useQueryClient()

  // The store front: the hub's catalog, synced on every open and every 30
  // minutes after that. No sign-in — the public catalogue answers anonymously,
  // and a bearer (when this machine has one) simply widens it to the person's
  // own and their organisation's skills.
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
  const syncNow = useCallback(() => {
    setSyncing(true)
    void tickSkillHub()
      .catch(() => null)
      .then(() => getSkillHubCatalog(true))
      .then(data => queryClient.setQueryData(HUB_CATALOG_KEY, data))
      .catch(err => notifyError(err, h.loadFailed))
      .finally(() => {
        setSyncing(false)
        void queryClient.invalidateQueries({ queryKey: HUB_CHANGES_KEY })
      })
  }, [h, queryClient])

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
  const [scan, setScan] = useState<null | SkillHubScanResult>(null)
  const [scanning, setScanning] = useState(false)

  const previewQuery = useQuery({
    queryKey: ['skill-hub-preview', detail?.identifier],
    queryFn: () => previewSkillHub(detail!.identifier),
    enabled: detail !== null,
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

  // Installed map: the catalogue seeds it, the search patches it (a term can
  // surface an install the cached catalogue didn't list); the optimistic
  // override wins so a just-(un)installed card reflects its own outcome
  // without the refetch race.
  const installed = { ...(catalogQuery.data?.installed ?? {}), ...(search.data?.installed ?? {}) }

  const isInstalled = (identifier: string) => overrides[identifier] ?? Boolean(installed[identifier])

  const anyFetching = term.length > 0 && search.isFetching
  const searched = term.length > 0 && !search.isFetching
  const showLanding = term.length === 0
  // Only block the whole pane when there is nothing to show yet; a search over
  // the cached catalogue answers instantly while the hub's own reply lands.
  const loading = showLanding ? catalogQuery.isLoading && catalog.length === 0 : anyFetching && listed.length === 0
  const hasInstalled = Object.keys(installed).length > 0
  const offline = Boolean(catalogQuery.data?.stale && catalogQuery.data.error)
  const hubUrl = catalogQuery.data?.hub_url
  const lastSync = catalogQuery.data?.fetched_at ? h.lastSync(syncedAt(catalogQuery.data.fetched_at, locale)) : h.neverSynced
  const updatingAll = actions[UPDATE_ALL_KEY]?.running ?? false

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The store front: which hub this is, whether it answers, what it
          holds and when it last synced. One hub — nothing else to list. */}
      <div className="shrink-0 px-4 pt-4 pb-3" data-testid="hub-catalog-bar">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">AgentX Hub</span>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-2xs font-medium',
                offline || (catalogQuery.data && !catalogQuery.data.fetched_at)
                  ? 'bg-amber-500/15 text-amber-400'
                  : catalogQuery.data
                    ? 'bg-emerald-500/15 text-emerald-400'
                    : 'bg-(--ui-bg-tertiary) text-(--ui-text-secondary)'
              )}
              data-testid="hub-store-state"
            >
              {offline || (catalogQuery.data && !catalogQuery.data.fetched_at)
                ? h.storeOffline
                : catalogQuery.data
                  ? h.storeOnline
                  : h.syncing}
            </span>
            {hubUrl && (
              <a
                className="flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                href={hubUrl}
                rel="noreferrer"
                target="_blank"
                title={h.openHub}
              >
                {hubHost(hubUrl)}
                <Codicon name="link-external" size="0.7rem" />
              </a>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {hasInstalled && (
              <Button disabled={updatingAll} onClick={updateAll} size="sm" variant="ghost">
                {updatingAll && <Loader2 className="size-3.5 animate-spin" />}
                {updatingAll ? h.updating : h.updateAll}
              </Button>
            )}
            <Button data-testid="hub-sync" disabled={syncing} onClick={syncNow} size="sm" variant="outline">
              {syncing ? <Loader2 className="size-3.5 animate-spin" /> : <Codicon name="sync" size="0.8rem" />}
              {syncing ? h.syncing : h.syncNow}
            </Button>
          </div>
        </div>

        <p className="mt-1.5 text-xs text-(--ui-text-secondary)">
          {term.length > 0 ? h.resultCount(listed.length, null) : h.catalogCount(listed.length)}
          <span className="text-(--ui-text-quaternary)"> · </span>
          {lastSync}
          {anyFetching && listed.length > 0 && <span className="ml-2 text-(--ui-text-quaternary)">{h.searching}</span>}
        </p>

        {offline && (
          <p className="mt-1 text-xs text-amber-400" data-testid="hub-catalog-offline">
            {h.catalogOffline}
          </p>
        )}
      </div>

      {/* Scrollable cards. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 [scrollbar-gutter:stable]">
        {/* What the hub asked this machine to do (installs from the web, yanks,
            org skills) — on the landing view, and only when there is something
            to say: browsing the store needs no account. */}
        {showLanding && <HubStatus hideWhenIdle />}
        {loading ? (
          <div className="grid min-h-40 place-items-center">
            <PageLoader label={h.searching} />
          </div>
        ) : listed.length === 0 ? (
          <div className="grid min-h-40 place-items-center px-6 text-center">
            <p className="max-w-md text-sm text-(--ui-text-secondary)">
              {searched ? h.noResults : h.catalogEmpty}
              {showLanding && <span className="mt-1.5 block text-xs text-(--ui-text-quaternary)">{h.landingHint}</span>}
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
            {listed.map(skill => (
              <HubSkillCard
                installedName={installed[skill.identifier]?.name ?? null}
                key={skill.identifier}
                onPreview={openDetail}
                rawInstalled={Boolean(installed[skill.identifier])}
                skill={skill}
              />
            ))}
          </div>
        )}
      </div>

      {/* Action log — same resizable, flush-width bottom pane + LogTail surface
          as the MCP logs. ANSI stripped so spawn output reads clean. Tails the
          latest-started action ($hubActiveLog). */}
      {activeLogKey && (
        <DetailPane
          defaultCollapsed
          defaultHeight={176}
          id="hub-action-log"
          onClose={closeHubLog}
          title={
            <span className="flex items-center gap-1.5 text-2xs font-normal text-muted-foreground/60">
              {h.actionLog}
              {activeLog?.running && <Codicon name="loading" size="0.75rem" spinning />}
            </span>
          }
        >
          <LogTail emptyLabel={h.searching} lines={activeLog?.lines.length ? activeLog.lines.map(stripAnsi) : null} />
        </DetailPane>
      )}

      <Dialog onOpenChange={open => !open && setDetail(null)} open={detail !== null}>
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-hidden">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <span className="truncate">{detail.name}</span>
                  <Badge className={trustTone(detail.trust_level)}>
                    {h.trust[detail.trust_level] ?? detail.trust_level}
                  </Badge>
                </DialogTitle>
                <DialogDescription className="truncate">{detail.identifier}</DialogDescription>
              </DialogHeader>

              <div className="min-h-0 space-y-3 overflow-y-auto">
                {scan && (
                  <div className="rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) p-3 text-xs">
                    <div className={cn('font-medium', verdictTone(scan.policy))}>
                      {scan.policy === 'allow' ? h.policyAllow : scan.policy === 'block' ? h.policyBlock : h.policyAsk}
                      {' · '}
                      {scan.verdict === 'safe'
                        ? h.verdictSafe
                        : scan.verdict === 'dangerous'
                          ? h.verdictDangerous
                          : h.verdictCaution}
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      {scan.findings.length === 0 ? h.noFindings : h.findings(scan.findings.length)}
                    </div>
                    {scan.findings.slice(0, 12).map((finding, index) => (
                      <div className="mt-1.5 font-mono text-2xs text-(--ui-text-tertiary)" key={index}>
                        [{finding.severity}] {finding.file}
                        {finding.line !== null ? `:${finding.line}` : ''} — {finding.description}
                      </div>
                    ))}
                  </div>
                )}

                {previewQuery.isLoading ? (
                  <PageLoader className="min-h-32" label={h.searching} />
                ) : previewQuery.data ? (
                  <>
                    <pre
                      className="max-h-72 overflow-auto whitespace-pre-wrap wrap-break-word rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) p-3 font-mono text-2xs leading-relaxed"
                      data-selectable-text="true"
                    >
                      {previewQuery.data.skill_md || h.noReadme}
                    </pre>
                    {previewQuery.data.files.length > 0 && (
                      <div className="text-xs text-muted-foreground">
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
                <Button
                  disabled={actions[detail.identifier]?.running || isInstalled(detail.identifier)}
                  onClick={() => install(detail.identifier, detail.name)}
                  size="sm"
                >
                  {isInstalled(detail.identifier) ? h.installed : h.install}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
