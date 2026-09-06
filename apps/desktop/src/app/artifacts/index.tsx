import type * as React from 'react'
import { Fragment, memo, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'

import { ZoomableImage } from '@/components/chat/zoomable-image'
import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { FileTypeIcon } from '@/components/ui/file-type-icon'
import {
  Pagination,
  PaginationButton,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationNext,
  PaginationPrevious
} from '@/components/ui/pagination'
import { RowButton } from '@/components/ui/row-button'
import { Tip } from '@/components/ui/tooltip'
import { getSessionMessages, listAllProfileSessions } from '@/hermes'
import { type Translations, useI18n } from '@/i18n'
import { resolveBrandIcon } from '@/lib/brand-icon'
import { ExternalLink, hostPathLabel, shortHostLabel, urlSlugTitleLabel, useLinkTitle } from '@/lib/external-link'
import { Link2, Loader2, MoreVertical, RefreshCw } from '@/lib/icons'
import { downloadGatewayMediaFile, isRemoteGateway } from '@/lib/media'
import { normalize } from '@/lib/text'
import { type DayGroup, dayGroup, fmtClock, fmtDayTime, fmtMonth, fmtMonthYear } from '@/lib/time'
import { cn } from '@/lib/utils'
import { notifyError } from '@/store/notifications'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import { useRouteEnumParam } from '../hooks/use-route-enum-param'
import { openSession } from '../open-session'
import { PageSearchShell } from '../page-search-shell'
import { NEW_CHAT_ROUTE } from '../routes'
import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

import {
  ARTIFACT_FILTERS,
  type ArtifactFilter,
  artifactImageSrc,
  type ArtifactRecord,
  collectArtifactsForSession
} from './artifact-utils'

// A row inside a day group shows the clock alone; the group header carries the
// date, so repeating "6 Sep" on every line would be noise.
function rowTime(timestamp: number, group: DayGroup): string {
  return group.kind === 'today' || group.kind === 'yesterday'
    ? fmtClock.format(new Date(timestamp))
    : fmtDayTime.format(new Date(timestamp))
}

function pageRangeLabel(total: number, page: number, pageSize: number, a: Translations['artifacts']): string {
  if (total === 0) {
    return a.zero
  }

  const start = (page - 1) * pageSize + 1
  const end = Math.min(total, page * pageSize)

  return a.rangeOf(start, end, total)
}

function paginationItems(page: number, pageCount: number): Array<number | 'ellipsis'> {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, index) => index + 1)
  }

  const pages: Array<number | 'ellipsis'> = [1]
  const start = Math.max(2, page - 1)
  const end = Math.min(pageCount - 1, page + 1)

  if (start > 2) {
    pages.push('ellipsis')
  }

  for (let nextPage = start; nextPage <= end; nextPage += 1) {
    pages.push(nextPage)
  }

  if (end < pageCount - 1) {
    pages.push('ellipsis')
  }

  pages.push(pageCount)

  return pages
}

type CellCtx = {
  onOpen: (href: string) => void | Promise<void>
  onOpenChat: (sessionId: string) => void
}

const itemsLabel = (f: ArtifactFilter, a: Translations['artifacts']) =>
  f === 'link' ? a.itemsLink : f === 'file' ? a.itemsFile : a.itemsGeneric

interface ArtifactsViewProps extends React.ComponentProps<'section'> {
  setStatusbarItemGroup?: SetStatusbarItemGroup
}

export function ArtifactsView({ setStatusbarItemGroup: _setStatusbarItemGroup, ...props }: ArtifactsViewProps) {
  const { locale, t } = useI18n()
  const a = t.artifacts
  const navigate = useNavigate()
  const [artifacts, setArtifacts] = useState<ArtifactRecord[] | null>(null)
  const [query, setQuery] = useState('')

  const [kindFilter, setKindFilter] = useRouteEnumParam('tab', ARTIFACT_FILTERS, 'all')

  const [failedImageIds, setFailedImageIds] = useState<Set<string>>(() => new Set())
  const [imagePage, setImagePage] = useState(1)
  const [filePage, setFilePage] = useState(1)

  const [refreshing, setRefreshing] = useState(false)

  const refreshArtifacts = useCallback(async () => {
    setRefreshing(true)

    try {
      const sessions = (await listAllProfileSessions(30, 1)).sessions
      const results = await Promise.allSettled(sessions.map(session => getSessionMessages(session.id, session.profile)))
      const nextArtifacts: ArtifactRecord[] = []

      results.forEach((result, index) => {
        if (result.status !== 'fulfilled') {
          return
        }

        const session = sessions[index]
        nextArtifacts.push(...collectArtifactsForSession(session, result.value.messages))
      })

      setArtifacts(nextArtifacts.sort((left, right) => right.timestamp - left.timestamp))
    } catch (err) {
      notifyError(err, a.failedLoad)
      setArtifacts([])
    } finally {
      setRefreshing(false)
    }
  }, [a])

  useRefreshHotkey(refreshArtifacts)

  useEffect(() => {
    void refreshArtifacts()
  }, [refreshArtifacts])

  useEffect(() => {
    setImagePage(1)
    setFilePage(1)
  }, [artifacts, kindFilter, query])

  const visibleArtifacts = useMemo(() => {
    if (!artifacts) {
      return []
    }

    const q = normalize(query)

    return artifacts.filter(artifact => {
      if (kindFilter !== 'all' && artifact.kind !== kindFilter) {
        return false
      }

      if (!q) {
        return true
      }

      return (
        artifact.label.toLowerCase().includes(q) ||
        artifact.value.toLowerCase().includes(q) ||
        artifact.sessionTitle.toLowerCase().includes(q)
      )
    })
  }, [artifacts, kindFilter, query])

  const visibleImageArtifacts = useMemo(
    () => visibleArtifacts.filter(artifact => artifact.kind === 'image'),
    [visibleArtifacts]
  )

  const visibleFileArtifacts = useMemo(
    () => visibleArtifacts.filter(artifact => artifact.kind !== 'image'),
    [visibleArtifacts]
  )

  const imagePageCount = Math.max(1, Math.ceil(visibleImageArtifacts.length / 24))
  const filePageCount = Math.max(1, Math.ceil(visibleFileArtifacts.length / 100))
  const currentImagePage = Math.min(imagePage, imagePageCount)
  const currentFilePage = Math.min(filePage, filePageCount)

  const pagedImageArtifacts = useMemo(
    () => visibleImageArtifacts.slice((currentImagePage - 1) * 24, currentImagePage * 24),
    [currentImagePage, visibleImageArtifacts]
  )

  const pagedFileArtifacts = useMemo(
    () => visibleFileArtifacts.slice((currentFilePage - 1) * 100, currentFilePage * 100),
    [currentFilePage, visibleFileArtifacts]
  )

  // Drive-style recency shelves: rows stay in newest-first order; a header is
  // emitted whenever the day group changes. The shared formatters follow the
  // app locale; `locale` stays in the deps so the labels re-render when it
  // changes.
  const fileGroups = useMemo(() => {
    const label = (group: DayGroup) => {
      switch (group.kind) {
        case 'today':
          return a.groupToday

        case 'yesterday':
          return a.groupYesterday

        case 'last7days':
          return a.groupLast7Days

        case 'month':
          return fmtMonth.format(group.at)

        case 'monthYear':
          return fmtMonthYear.format(group.at)
      }
    }

    const groups: { group: DayGroup; label: string; rows: ArtifactRecord[] }[] = []

    for (const artifact of pagedFileArtifacts) {
      const group = dayGroup(artifact.timestamp)
      const last = groups[groups.length - 1]

      if (last && last.group.key === group.key) {
        last.rows.push(artifact)
      } else {
        groups.push({ group, label: label(group), rows: [artifact] })
      }
    }

    return groups
    // `locale` is read by the shared formatters, not here — it stays in the
    // list so the month shelves re-label when the language changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, locale, pagedFileArtifacts])

  // Rotating placeholder nudges from real data — search matches file paths and
  // session titles, not just labels; show it.
  const searchHints = useMemo(() => {
    if (!artifacts?.length) {
      return undefined
    }

    const extensions = [
      ...new Set(artifacts.map(artifact => /\.(\w{2,4})$/.exec(artifact.value)?.[1]?.toLowerCase()).filter(Boolean))
    ].slice(0, 3) as string[]

    const titles = [...new Set(artifacts.map(artifact => artifact.sessionTitle).filter(Boolean))].slice(0, 2)

    const hints = [
      ...extensions.map(ext => t.common.tryHint(`.${ext}`)),
      ...titles.map(title => t.common.tryHint(title))
    ]

    return hints.length > 0 ? hints : undefined
  }, [artifacts, t])

  const counts = useMemo(() => {
    const all = artifacts || []

    return {
      all: all.length,
      image: all.filter(artifact => artifact.kind === 'image').length,
      file: all.filter(artifact => artifact.kind === 'file').length,
      link: all.filter(artifact => artifact.kind === 'link').length
    }
  }, [artifacts])

  const openArtifact = useCallback(
    async (href: string) => {
      try {
        // A gateway-local file resolves to file:// in remote mode (the file
        // lives on the gateway, not this disk). Opening that locally fails —
        // and an OAuth remote connection has no query token to build a download
        // URL. Fetch the bytes over the authenticated fs bridge instead.
        if (isRemoteGateway() && /^file:/i.test(href)) {
          await downloadGatewayMediaFile(href)

          return
        }

        if (window.agentxDesktop?.openExternal) {
          await window.agentxDesktop.openExternal(href)
        } else {
          window.open(href, '_blank', 'noopener,noreferrer')
        }
      } catch (err) {
        notifyError(err, a.openFailed)
      }
    },
    [a]
  )

  const markImageFailed = useCallback((id: string) => {
    setFailedImageIds(current => {
      if (current.has(id)) {
        return current
      }

      return new Set(current).add(id)
    })
  }, [])

  // Stable ctx: recreating it (or its onOpenChat closure) every render made
  // every artifact cell re-render whenever the page did — and a link cell's
  // async title fetch re-rendered the page repeatedly. openArtifact is already
  // a useCallback; navigate is stable, so onOpenChat can be too.
  const openChat = useCallback((sessionId: string) => openSession(sessionId, navigate), [navigate])
  const cellCtx: CellCtx = useMemo(() => ({ onOpen: openArtifact, onOpenChat: openChat }), [openArtifact, openChat])

  // The tab row only exists once there is something to filter — four zeros in
  // a row is not information.
  const hasAny = (artifacts?.length ?? 0) > 0

  return (
    <PageSearchShell
      {...props}
      activeTab={kindFilter}
      description={a.pageDescription}
      onSearchChange={setQuery}
      onTabChange={id => setKindFilter(id as typeof kindFilter)}
      searchHidden={counts.all === 0}
      searchHints={searchHints}
      searchPlaceholder={a.search}
      searchTrailingAction={
        <Tip label={refreshing ? a.refreshing : a.refresh}>
          <Button
            aria-label={refreshing ? a.refreshing : a.refresh}
            className="text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground"
            disabled={refreshing}
            onClick={() => void refreshArtifacts()}
            size="icon-sm"
            variant="ghost"
          >
            {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
        </Tip>
      }
      searchValue={query}
      tabs={
        hasAny
          ? [
              { id: 'all', label: a.tabAll, meta: counts.all },
              { id: 'image', label: a.tabImages, meta: counts.image },
              { id: 'file', label: a.tabFiles, meta: counts.file },
              { id: 'link', label: a.tabLinks, meta: counts.link }
            ]
          : undefined
      }
      title={a.pageTitle}
    >
      {!artifacts ? (
        <PageLoader label={a.indexing} />
      ) : counts.all === 0 ? (
        <EmptyState
          action={<Button onClick={() => navigate(NEW_CHAT_ROUTE)}>{a.emptyAction}</Button>}
          className="h-full"
          description={a.emptyDesc}
          figure="box"
          title={a.emptyTitle}
        />
      ) : visibleArtifacts.length === 0 ? (
        <EmptyState
          action={
            query.trim() ? (
              <Button onClick={() => setQuery('')} size="sm" variant="secondary">
                {a.clearSearch}
              </Button>
            ) : (
              <Button onClick={() => setKindFilter('all')} size="sm" variant="secondary">
                {a.showAll}
              </Button>
            )
          }
          className="h-full"
          description={a.noResultsDesc}
          figure="box"
          title={a.noResultsTitle}
        />
      ) : (
        <div className="h-full overflow-y-auto [scrollbar-gutter:stable]">
          <div className="flex flex-col gap-3 px-3 pb-3">
            {visibleImageArtifacts.length > 0 && (
              <section className="flex flex-col">
                <div className="sticky top-0 z-10 -mx-3 flex h-7 items-center gap-3 overflow-x-auto bg-background px-3">
                  <ArtifactsPagination
                    className="ml-auto justify-end px-0"
                    itemLabel={a.itemsImage}
                    onPageChange={setImagePage}
                    page={currentImagePage}
                    pageSize={24}
                    total={visibleImageArtifacts.length}
                  />
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] items-start gap-3 pt-1.5">
                  {pagedImageArtifacts.map(artifact => (
                    <ArtifactImageCard
                      artifact={artifact}
                      ctx={cellCtx}
                      failedImage={failedImageIds.has(artifact.id)}
                      key={artifact.id}
                      onImageError={markImageFailed}
                    />
                  ))}
                </div>
              </section>
            )}

            {visibleFileArtifacts.length > 0 && (
              <section className="flex flex-col">
                <div className="sticky top-0 z-10 -mx-3 flex h-7 items-center gap-3 overflow-x-auto bg-background px-3">
                  <ArtifactsPagination
                    className="ml-auto justify-end px-0"
                    itemLabel={itemsLabel(kindFilter, a)}
                    onPageChange={setFilePage}
                    page={currentFilePage}
                    pageSize={100}
                    total={visibleFileArtifacts.length}
                  />
                </div>
                {fileGroups.map(({ group, label, rows }) => (
                  <Fragment key={group.key}>
                    <div className="px-2 pb-1 pt-3 text-xs font-semibold text-(--ui-text-tertiary) first:pt-1.5">
                      {label}
                    </div>
                    {rows.map(artifact => (
                      <ArtifactListRow artifact={artifact} ctx={cellCtx} group={group} key={artifact.id} />
                    ))}
                  </Fragment>
                ))}
              </section>
            )}
          </div>
        </div>
      )}
    </PageSearchShell>
  )
}

interface ArtifactsPaginationProps {
  className?: string
  itemLabel: string
  onPageChange: (page: number) => void
  page: number
  pageSize: number
  total: number
}

function ArtifactsPagination({ className, itemLabel, onPageChange, page, pageSize, total }: ArtifactsPaginationProps) {
  const { t } = useI18n()
  const a = t.artifacts
  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className={cn('flex h-6 items-center justify-between gap-2 px-1', className)}>
      <div className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {pageRangeLabel(total, page, pageSize, a)} {itemLabel}
      </div>
      {pageCount > 1 && (
        <Pagination className="mx-0 w-auto min-w-0 justify-end">
          <PaginationContent className="gap-0.5">
            <PaginationItem>
              <PaginationPrevious disabled={page <= 1} onClick={() => onPageChange(Math.max(1, page - 1))} />
            </PaginationItem>
            {paginationItems(page, pageCount).map((item, index) => (
              <PaginationItem key={`${item}-${index}`}>
                {item === 'ellipsis' ? (
                  <PaginationEllipsis />
                ) : (
                  <PaginationButton
                    aria-label={a.goToPage(itemLabel, item)}
                    isActive={page === item}
                    onClick={() => onPageChange(item)}
                  >
                    {item}
                  </PaginationButton>
                )}
              </PaginationItem>
            ))}
            <PaginationItem>
              <PaginationNext
                disabled={page >= pageCount}
                onClick={() => onPageChange(Math.min(pageCount, page + 1))}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      )}
    </div>
  )
}

interface ArtifactImageCardProps {
  artifact: ArtifactRecord
  ctx: CellCtx
  failedImage: boolean
  onImageError: (id: string) => void
}

function ArtifactImageCard({ artifact, ctx, failedImage, onImageError }: ArtifactImageCardProps) {
  const { t } = useI18n()
  const a = t.artifacts
  const [src, setSrc] = useState('')

  useEffect(() => {
    let active = true

    setSrc('')
    void artifactImageSrc(artifact.value, artifact.href)
      .then(nextSrc => {
        if (active) {
          setSrc(nextSrc)
        }
      })
      .catch(() => {
        if (active) {
          onImageError(artifact.id)
        }
      })

    return () => {
      active = false
    }
  }, [artifact.href, artifact.id, artifact.value, onImageError])

  return (
    <article className="group/artifact overflow-hidden rounded-(--radius-card) border border-(--ui-stroke-tertiary) bg-(--ui-chat-bubble-background)">
      <div className={cn('relative h-40 w-full overflow-hidden bg-(--ui-bg-quinary)', failedImage && 'cursor-default')}>
        {!failedImage && src && (
          <ZoomableImage
            alt={artifact.label}
            className="h-40 w-full cursor-zoom-in object-cover"
            containerClassName="h-full w-full"
            decoding="async"
            loading="lazy"
            onError={() => onImageError(artifact.id)}
            slot="artifact-media"
            src={src}
          />
        )}
      </div>

      <div className="space-y-1 p-2.5">
        <div className="truncate text-base font-medium text-foreground">{artifact.label}</div>
        <div className="truncate text-xs text-(--ui-text-tertiary)">
          «{artifact.sessionTitle}» · {fmtDayTime.format(new Date(artifact.timestamp))}
        </div>
        <div className="flex flex-wrap gap-1.5 pt-1 opacity-0 transition-opacity duration-(--dur-short) focus-within:opacity-100 group-hover/artifact:opacity-100">
          <Button onClick={() => void ctx.onOpen(artifact.href)} size="sm" variant="secondary">
            {a.open}
          </Button>
          <Button onClick={() => ctx.onOpenChat(artifact.sessionId)} size="sm" variant="text">
            {a.viewChat}
          </Button>
        </div>
      </div>
    </article>
  )
}

// One library row: type icon · name over its place · which chat made it, when,
// and the quiet actions. Memoized because link rows fetch their titles
// asynchronously and must not re-render the whole page as results land.
const ArtifactListRow = memo(function ArtifactListRow({
  artifact,
  ctx,
  group
}: {
  artifact: ArtifactRecord
  ctx: CellCtx
  group: DayGroup
}) {
  const { t } = useI18n()
  const a = t.artifacts
  const isLink = artifact.kind === 'link'
  const Brand = isLink ? resolveBrandIcon(shortHostLabel(artifact.href)) : null
  const fetchedTitle = useLinkTitle(isLink ? artifact.href : null)
  const label = isLink ? fetchedTitle || urlSlugTitleLabel(artifact.href) : artifact.label
  const place = isLink ? hostPathLabel(artifact.value) : artifact.value
  const copyLabel = isLink ? a.copyUrl : a.copyPath

  const copyValue = () => {
    if (window.agentxDesktop?.writeClipboard) {
      void window.agentxDesktop.writeClipboard(artifact.value)
    } else {
      void navigator.clipboard?.writeText(artifact.value)
    }
  }

  const body = (
    <>
      <span className="grid size-6 shrink-0 place-items-center rounded-(--radius-control) bg-(--ui-bg-tertiary) text-(--ui-text-tertiary)">
        {isLink ? (
          Brand ? (
            <Brand className="size-3.5" />
          ) : (
            <Link2 className="size-3.5" />
          )
        ) : (
          <FileTypeIcon path={artifact.value} size="0.875rem" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base font-medium text-foreground/90">{label}</span>
        <Tip label={artifact.value}>
          <span className={cn('block truncate text-xs text-(--ui-text-tertiary)', !isLink && 'font-mono')}>
            {place}
          </span>
        </Tip>
      </span>
    </>
  )

  return (
    <div className="group/row row-hover flex h-(--artifact-row-height) w-full items-center gap-3 rounded-(--radius-control) px-2 text-(--ui-text-secondary) hover:text-foreground">
      {isLink ? (
        <ExternalLink
          className="flex h-full min-w-0 flex-1 items-center gap-3 text-left no-underline"
          href={artifact.href}
          showExternalIcon={false}
          title={label}
        >
          {body}
        </ExternalLink>
      ) : (
        <RowButton
          className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
          onClick={() => void ctx.onOpen(artifact.href)}
        >
          {body}
        </RowButton>
      )}
      <span className="flex shrink-0 items-center gap-2">
        <button
          className="max-w-40 cursor-pointer truncate text-xs text-(--ui-text-tertiary) hover:text-foreground hover:underline"
          onClick={() => ctx.onOpenChat(artifact.sessionId)}
          type="button"
        >
          {artifact.sessionTitle}
        </button>
        <span className="text-xs tabular-nums text-(--ui-text-tertiary)">{rowTime(artifact.timestamp, group)}</span>
        <span className="flex items-center gap-1 opacity-0 transition-opacity duration-(--dur-short) focus-within:opacity-100 group-hover/row:opacity-100">
          <Button onClick={() => void ctx.onOpen(artifact.href)} size="sm" variant="secondary">
            {a.open}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button aria-label={a.rowActions} size="icon-sm" variant="ghost">
                <MoreVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={4}>
              <DropdownMenuItem onSelect={copyValue}>{copyLabel}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => ctx.onOpenChat(artifact.sessionId)}>{a.viewChat}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </span>
    </div>
  )
})
