import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'
import type * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ArchiveSkillConfirmDialog } from '@/app/learning/archive-skill-confirm-dialog'
import { CodeEditor } from '@/components/chat/code-editor'
import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { StoreCardGrid } from '@/components/ui/store-card'
import { editLearningNode, getLearningNode, getUsageAnalytics, setSkillEnabled, setToolsetEnabled } from '@/hermes'
import { type Translations, useI18n } from '@/i18n'
import { isDesktopToolsetVisible } from '@/lib/desktop-toolsets'
import { queryClient } from '@/lib/query-client'
import { skillCategoryKey, skillDisplayName } from '@/lib/skill-categories'
import { invalidateSlashCompletions } from '@/lib/slash-completion-cache'
import { asText, normalize } from '@/lib/text'
import { useStoreSelector } from '@/lib/use-session-slice'
import { $gateway } from '@/store/gateway'
import { notify, notifyError } from '@/store/notifications'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import type { SkillInfo, ToolsetInfo } from '@/types/hermes'

import { useOnProfileSwitch } from '../hooks/use-on-profile-switch'
import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import { useRouteEnumParam } from '../hooks/use-route-enum-param'
import { DetailPane, ListStrip, ListStripMenu, type ListStripMenuToggle } from '../master-detail'
import { PanelEmpty } from '../overlays/panel'
import { PageSearchShell } from '../page-search-shell'
import { includesQuery, toolNames, toolsetDisplayLabel } from '../settings/helpers'
import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

import { SkillsHub } from './hub'
import { McpTab } from './mcp-tab'
import { type PublishMode, PublishSkillDialog } from './publish-dialog'
import { SkillCard } from './skill-card'
import { SkillDetailDialog } from './skill-detail-dialog'
import {
  categoryFor,
  categoryLabel,
  isHubSkill,
  setSkills,
  setToolsets,
  SKILLS_QUERY_KEY,
  skillsQueryOptions,
  toggleSkillEnabled,
  toggleToolsetEnabled,
  toolsetCalls,
  toolsetCopy,
  TOOLSETS_QUERY_KEY,
  toolsetsQueryOptions,
  usageOf
} from './skills-data'
import { $skillsSortDesc, $toolsetsSortDesc } from './store'
import { ToolsetCard } from './toolset-card'
import { ToolsetDetailDialog } from './toolset-detail-dialog'
import { useTrySkill } from './use-try-skill'

// Display order: the skills you have, the store that adds more, the tools, and
// the technical connections last. The ids are the `?tab=` deep links and stay.
const SKILLS_MODES = ['skills', 'hub', 'toolsets', 'mcp'] as const

// Per-tool call counts come from a 365-day message scan — heavy, and purely
// cosmetic (Toolsets usage badges). Cache the result module-wide with a TTL so
// bouncing between tabs/pages doesn't re-run the scan every time. Keyed by
// profile: analytics are profile-scoped, so a switch must not show the previous
// profile's counts. `useRefreshHotkey` still forces a fresh pull.
const TOOL_CALLS_TTL_MS = 10 * 60 * 1000
const toolCallsCache = new Map<string, { at: number; value: Record<string, number> }>()

async function loadToolCalls(force = false): Promise<Record<string, number>> {
  const key = normalizeProfileKey($activeGatewayProfile.get())
  const cached = toolCallsCache.get(key)

  if (!force && cached && Date.now() - cached.at < TOOL_CALLS_TTL_MS) {
    return cached.value
  }

  const analytics = await getUsageAnalytics(365)

  const value = Object.fromEntries((analytics.tools ?? []).map(e => [e.tool, e.count]))

  // Only cache if the active profile hasn't changed during the request — else a
  // switch mid-flight would file this result under the wrong profile's key.
  if (normalizeProfileKey($activeGatewayProfile.get()) === key) {
    toolCallsCache.set(key, { at: Date.now(), value })
  }

  return value
}

// Highlight the active order inside the sort menu.
const cnActive = (active: boolean) => (active ? 'font-medium text-foreground' : undefined)

function filteredSkills(skills: SkillInfo[], query: string, desc: boolean, t: Translations): SkillInfo[] {
  const q = normalize(query)
  const sign = desc ? 1 : -1

  return skills
    .filter(
      skill =>
        !q ||
        includesQuery(skill.name, q) ||
        includesQuery(skillDisplayName(skill.name), q) ||
        includesQuery(skill.description, q) ||
        includesQuery(skill.category, q) ||
        includesQuery(categoryLabel(categoryFor(skill), t), q)
    )
    .sort((a, b) => sign * (usageOf(b) - usageOf(a)) || asText(a.name).localeCompare(asText(b.name)))
}

function filteredToolsets(
  toolsets: ToolsetInfo[],
  query: string,
  toolCalls: Record<string, number>,
  desc: boolean,
  t: Translations
): ToolsetInfo[] {
  const q = normalize(query)
  const sign = desc ? 1 : -1

  return toolsets
    .filter(toolset => {
      if (!isDesktopToolsetVisible(toolset.name)) {
        return false
      }

      if (!q) {
        return true
      }

      const copy = toolsetCopy(toolset, t)

      return (
        includesQuery(toolset.name, q) ||
        includesQuery(toolsetDisplayLabel(toolset), q) ||
        includesQuery(copy.label, q) ||
        includesQuery(copy.description, q) ||
        includesQuery(toolset.description, q) ||
        toolNames(toolset).some(name => includesQuery(name, q))
      )
    })
    .sort(
      (a, b) =>
        sign * (toolsetCalls(b, toolCalls) - toolsetCalls(a, toolCalls)) ||
        toolsetCopy(a, t).label.localeCompare(toolsetCopy(b, t).label)
    )
}

interface SkillsViewProps extends React.ComponentProps<'section'> {
  setStatusbarItemGroup?: SetStatusbarItemGroup
}

export function SkillsView({ setStatusbarItemGroup: _setStatusbarItemGroup, ...props }: SkillsViewProps) {
  const { t } = useI18n()
  const [mode, setMode] = useRouteEnumParam('tab', SKILLS_MODES, 'skills')
  // $gateway only feeds the MCP tab — gate the subscription so Skills/Toolsets/Hub
  // tabs don't re-render on connect/disconnect/reconnect.
  const gateway = useStoreSelector($gateway, g => (mode === 'mcp' ? g : null))
  const trySkill = useTrySkill()

  const [query, setQuery] = useState('')

  const { data: skills, isError: skillsFailed, error: skillsError } = useQuery(skillsQueryOptions)
  const { data: toolsets, isError: toolsetsFailed } = useQuery(toolsetsQueryOptions)

  // "Kỹ năng sẵn có" is what came with AgentX or what it learned here; a skill
  // installed from the store belongs to the store tab, where its card carries
  // the switch — listing it twice would make one skill look like two.
  const ownSkills = useMemo(() => (skills ?? []).filter(skill => !isHubSkill(skill)), [skills])

  // tool name -> call count over the analytics window. null = still loading
  // (badges show skeletons); {} = loaded empty / unavailable backend.
  const [toolCalls, setToolCalls] = useState<Record<string, number> | null>(null)
  // Bumped on profile switch so a slow analytics load from profile A can't set
  // toolCalls after the user moved to B.
  const toolCallsEpoch = useRef(0)
  const skillsSortDesc = useStore($skillsSortDesc)
  const toolsetsSortDesc = useStore($toolsetsSortDesc)
  const [bulkBusy, setBulkBusy] = useState(false)
  // The open detail dialogs, by name — the live row is looked up on every
  // render so a toggle made inside the dialog repaints it too.
  const [detailSkillName, setDetailSkillName] = useState<string | null>(null)
  const [detailToolsetName, setDetailToolsetName] = useState<string | null>(null)
  const [publish, setPublish] = useState<null | { mode: PublishMode; skill: SkillInfo }>(null)

  const refreshCapabilities = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: TOOLSETS_QUERY_KEY })
    ])

    invalidateSlashCompletions()

    // An explicit refresh is the one time we bypass the analytics TTL — but
    // only if the badges are already on screen; otherwise let the lazy load
    // pick it up when Toolsets is first shown. Guard the async set against a
    // profile switch landing before it resolves.
    if (toolCallsCache.size > 0) {
      const epoch = toolCallsEpoch.current

      loadToolCalls(true)
        .then(value => toolCallsEpoch.current === epoch && setToolCalls(value))
        .catch(() => toolCallsEpoch.current === epoch && setToolCalls({}))
    }
  }, [])

  const refreshToolsets = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: TOOLSETS_QUERY_KEY })
  }, [])

  useRefreshHotkey(refreshCapabilities)

  // Per-tool call counts feed ONLY the Toolsets tab's usage badges/sort, and
  // the query behind them is a 365-day message scan — heavy. Fetch it lazily
  // the first time Toolsets is shown, never on Skills or MCP, so it can't
  // starve the MCP tab's config load. Absent → toolsets sort A–Z until it lands.
  useEffect(() => {
    if (mode !== 'toolsets' || toolCalls !== null) {
      return
    }

    let cancelled = false
    // Guard the setter by epoch too: when toolCalls is already null at switch
    // time, setToolCalls(null) is a no-op so this effect never re-runs to flip
    // `cancelled` — the epoch check catches that gap.
    const epoch = toolCallsEpoch.current
    const live = () => !cancelled && toolCallsEpoch.current === epoch

    loadToolCalls()
      .then(value => live() && setToolCalls(value))
      .catch(() => live() && setToolCalls({}))

    return () => void (cancelled = true)
  }, [mode, toolCalls])

  // On a profile switch the analytics cache is profile-keyed, but our local
  // toolCalls state isn't — leaving it non-null would keep the lazy effect from
  // ever re-running, so badges/sort would show the previous profile's counts.
  // Reset to null so the next Toolsets view reloads for the active profile.
  // The open dialogs describe profile A's rows, so they close too.
  useOnProfileSwitch(() => {
    toolCallsEpoch.current += 1
    setToolCalls(null)
    setDetailSkillName(null)
    setDetailToolsetName(null)
    setPublish(null)
  })

  const visibleSkills = useMemo(
    () => filteredSkills(ownSkills, query, skillsSortDesc, t),
    [ownSkills, query, skillsSortDesc, t]
  )

  const visibleToolsets = useMemo(
    () => (toolsets ? filteredToolsets(toolsets, query, toolCalls ?? {}, toolsetsSortDesc, t) : []),
    [query, t, toolCalls, toolsets, toolsetsSortDesc]
  )

  // Browsing (no search) groups skills by category so 80 cards read as a dozen
  // named shelves; a search flattens back to one relevance grid. Groups order
  // by how much the person actually uses them, so the busiest shelf leads.
  const groupedSkills = useMemo(() => {
    if (query.trim()) {
      return null
    }

    const byKey = new Map<string, { label: string; rows: SkillInfo[]; usage: number }>()

    for (const skill of visibleSkills) {
      const key = skillCategoryKey(categoryFor(skill))
      const group = byKey.get(key) ?? { label: categoryLabel(categoryFor(skill), t), rows: [], usage: 0 }
      group.rows.push(skill)
      group.usage += usageOf(skill)
      byKey.set(key, group)
    }

    return [...byKey.entries()]
      .map(([key, group]) => ({ key, ...group }))
      .sort((a, b) => b.usage - a.usage || a.label.localeCompare(b.label))
  }, [query, t, visibleSkills])

  // Bulk actions ("All" master switch, "Disable unused") and the master-switch
  // state target the WHOLE tab, never the search-filtered view — a tab-wide
  // control that silently scoped to the current query would be a lie.
  const bulkSkills = ownSkills
  const bulkToolsets = useMemo(() => (toolsets ?? []).filter(ts => isDesktopToolsetVisible(ts.name)), [toolsets])

  // Rotating placeholder nudges from the user's own data — teach that search
  // understands categories and tool names, not just titles.
  const searchHints = useMemo(() => {
    if (mode === 'skills' && ownSkills.length) {
      const counts = new Map<string, number>()

      for (const skill of ownSkills) {
        const key = categoryFor(skill)
        counts.set(key, (counts.get(key) || 0) + 1)
      }

      return [...counts.entries()]
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([category]) => t.common.tryHint(categoryLabel(category, t).toLowerCase()))
    }

    if (mode === 'toolsets' && toolsets?.length) {
      return toolsets
        .filter(ts => isDesktopToolsetVisible(ts.name) && toolNames(ts).length > 0)
        .slice(0, 5)
        .map(ts => t.common.tryHint(toolNames(ts)[0]))
    }

    return undefined
  }, [mode, ownSkills, toolsets, t])

  const detailSkill = useMemo(
    () => (detailSkillName ? (ownSkills.find(skill => skill.name === detailSkillName) ?? null) : null),
    [detailSkillName, ownSkills]
  )

  const detailToolset = useMemo(
    () => (detailToolsetName ? (bulkToolsets.find(ts => ts.name === detailToolsetName) ?? null) : null),
    [bulkToolsets, detailToolsetName]
  )

  const handleToggleSkill = (skill: SkillInfo, enabled: boolean) =>
    toggleSkillEnabled(skill, enabled, t.skills.failedToUpdate(skillDisplayName(skill.name)))

  const handleToggleToolset = (toolset: ToolsetInfo, enabled: boolean) =>
    toggleToolsetEnabled(toolset, enabled, t.skills.failedToUpdate(toolsetCopy(toolset, t).label))

  // Sequential on purpose: each toggle is a config read-modify-write on the
  // backend; parallel calls would race the disabled-list save.
  async function bulkApply(skillTargets: SkillInfo[], toolsetTargets: ToolsetInfo[], enabled: boolean) {
    if (bulkBusy || skillTargets.length + toolsetTargets.length === 0) {
      return
    }

    setBulkBusy(true)

    let done = 0

    try {
      for (const row of skillTargets) {
        await setSkillEnabled(row.name, enabled)
        setSkills(cur => cur?.map(r => (r.name === row.name ? { ...r, enabled } : r)) ?? cur)
        done += 1
      }

      for (const row of toolsetTargets) {
        await setToolsetEnabled(row.name, enabled)
        setToolsets(cur => cur?.map(r => (r.name === row.name ? { ...r, enabled, available: enabled } : r)) ?? cur)
        done += 1
      }

      notify({ kind: 'success', title: t.skills.bulkUpdated(done), message: '' })
    } catch (err) {
      notifyError(err, t.skills.failedToUpdate(mode === 'skills' ? t.skills.tabSkills : t.skills.tabToolsets))
    } finally {
      invalidateSlashCompletions()
      setBulkBusy(false)
    }
  }

  const bulkToggle = (enabled: boolean) =>
    mode === 'skills'
      ? bulkApply(
          bulkSkills.filter(row => row.enabled !== enabled),
          [],
          enabled
        )
      : bulkApply(
          [],
          bulkToolsets.filter(row => row.enabled !== enabled),
          enabled
        )

  // "Never used" = zero recorded activity. The pruning move for a 100+ skill
  // install: keep the workhorses, shed the noise.
  const disableUnused = () =>
    bulkApply(
      bulkSkills.filter(skill => skill.enabled && usageOf(skill) === 0),
      [],
      false
    )

  // One switch line covering enable-all/disable-all.
  const bulkSwitch = (allEnabled: boolean): ListStripMenuToggle => ({
    checked: allEnabled,
    disabled: bulkBusy,
    label: t.skills.all,
    onToggle: checked => void bulkToggle(checked)
  })

  const allSkillsEnabled = bulkSkills.length > 0 && bulkSkills.every(s => s.enabled)
  const allToolsetsEnabled = bulkToolsets.length > 0 && bulkToolsets.every(ts => ts.enabled)

  // "Sắp xếp" — a real 28px control opening the two orders.
  const sortButton = (desc: boolean, set: (next: boolean) => void) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost">
          {t.skills.sortLabel}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4}>
        <DropdownMenuItem className={cnActive(desc)} onSelect={() => set(true)}>
          {t.skills.sortMostUsedDesc}
        </DropdownMenuItem>
        <DropdownMenuItem className={cnActive(!desc)} onSelect={() => set(false)}>
          {t.skills.sortLeastUsedAsc}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  // The one-line strip above a card grid: sort on the left; on the right the
  // note that switches apply to new chats, then the tab-wide ⋯ menu.
  const gridStrip = (left: React.ReactNode, menu: React.ReactNode) => (
    <div className="shrink-0 px-4 pt-3">
      <ListStrip
        left={left}
        right={
          <>
            <span className="hidden text-xs text-(--ui-text-tertiary) sm:inline">
              {t.skills.changesApplyNewSessions}
            </span>
            {menu}
          </>
        }
      />
    </div>
  )

  // Full-bleed empty state, matching the connections tab. Query-aware; three
  // beats and one action that resolves it.
  const capabilityEmpty = (noun: string) => {
    const q = query.trim()

    return (
      <div className="flex h-full min-h-0 flex-1">
        <PanelEmpty
          action={
            q ? (
              <Button onClick={() => setQuery('')} size="sm" variant="secondary">
                {t.skills.clearSearch}
              </Button>
            ) : (
              <Button onClick={() => void refreshCapabilities()} size="sm" variant="secondary">
                {t.skills.refresh}
              </Button>
            )
          }
          description={q ? t.skills.emptyNothingMatches(q) : t.skills.emptyNoneAvailable(noun)}
          figure="box"
          title={t.skills.emptyNoneFound(noun)}
        />
      </div>
    )
  }

  // Learned/local skills are editable + archivable, mirroring the memory
  // graph (same /api/learning/node endpoints — delete archives, restorable
  // via `agentx curator restore`).
  const [skillEditor, setSkillEditor] = useState<null | { content: string; name: string }>(null)
  const [skillDraft, setSkillDraft] = useState('')
  const [skillSaving, setSkillSaving] = useState(false)
  const [archiveTarget, setArchiveTarget] = useState<null | string>(null)
  // Bumped on profile switch so an in-flight openSkillEditor fetch from profile
  // A can't reopen the editor with A's content after switching to B.
  const skillEditorEpoch = useRef(0)

  // A profile switch swaps the backend under the open editor/archive dialog —
  // their targets belong to profile A, so a save/archive would hit B. Drop them
  // so nothing edits or archives against the newly active profile.
  useOnProfileSwitch(() => {
    skillEditorEpoch.current += 1
    setSkillEditor(null)
    setSkillDraft('')
    setArchiveTarget(null)
  })

  const openSkillEditor = async (name: string) => {
    const epoch = skillEditorEpoch.current

    try {
      const node = await getLearningNode(name)

      if (skillEditorEpoch.current !== epoch) {
        return
      }

      setSkillEditor({ content: node.content, name })
      setSkillDraft(node.content)
    } catch (err) {
      notifyError(err, name)
    }
  }

  const saveSkillEdit = async () => {
    if (!skillEditor) {
      return
    }

    setSkillSaving(true)

    try {
      await editLearningNode(skillEditor.name, skillDraft)
      notify({
        kind: 'success',
        title: t.skills.skillUpdated,
        message: t.skills.appliesToNewSessions(skillEditor.name)
      })
      setSkillEditor(null)
      void refreshCapabilities()
    } catch (err) {
      notifyError(err, skillEditor.name)
    } finally {
      setSkillSaving(false)
    }
  }

  const skillEditorPane = skillEditor && (
    <DetailPane
      actions={
        <Button disabled={skillSaving} onClick={() => void saveSkillEdit()} size="sm">
          {skillSaving ? t.common.saving : t.common.save}
        </Button>
      }
      id="skill-editor"
      onClose={() => setSkillEditor(null)}
      title={<span className="text-xs font-normal text-muted-foreground/60">{skillEditor.name}/SKILL.md</span>}
    >
      <CodeEditor
        filePath="SKILL.md"
        initialValue={skillEditor.content}
        key={skillEditor.name}
        onCancel={() => setSkillEditor(null)}
        onChange={setSkillDraft}
        onSave={() => void saveSkillEdit()}
      />
    </DetailPane>
  )

  // Both dialogs hand off to another surface (the editor pane, the archive
  // confirm, the publish dialog, a new chat): close first so two modal layers
  // never stack.
  const tryNow = (skill: SkillInfo) => {
    setDetailSkillName(null)
    trySkill(skill.name)
  }

  const skillsGrid = (
    <div className="flex h-full min-h-0 flex-col">
      {gridStrip(
        sortButton(skillsSortDesc, next => $skillsSortDesc.set(next)),
        <ListStripMenu
          items={[{ disabled: bulkBusy, label: t.skills.disableUnused, onSelect: () => void disableUnused() }]}
          label={t.skills.tabSkills}
          toggle={bulkSwitch(allSkillsEnabled)}
        />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 [scrollbar-gutter:stable]">
        <div className="grid gap-5">
          {(groupedSkills ?? [{ key: 'all', label: '', rows: visibleSkills, usage: 0 }]).map(group => (
            <section key={group.key}>
              {group.label && (
                <div className="mb-2 flex items-baseline gap-1.5 px-0.5">
                  <h3 className="text-sm font-semibold text-(--ui-text-tertiary)">{group.label}</h3>
                  <span className="text-xs tabular-nums text-(--ui-text-quaternary)">{group.rows.length}</span>
                </div>
              )}
              <StoreCardGrid>
                {group.rows.map(skill => (
                  <SkillCard
                    busy={bulkBusy}
                    key={skill.name}
                    onDetails={() => setDetailSkillName(skill.name)}
                    onToggle={enabled => void handleToggleSkill(skill, enabled)}
                    onTryNow={() => tryNow(skill)}
                    skill={skill}
                  />
                ))}
              </StoreCardGrid>
            </section>
          ))}
        </div>
      </div>
      {skillEditorPane}
    </div>
  )

  const toolsetsGrid = (
    <div className="flex h-full min-h-0 flex-col">
      {gridStrip(
        sortButton(toolsetsSortDesc, next => $toolsetsSortDesc.set(next)),
        <ListStripMenu label={t.skills.tabToolsets} toggle={bulkSwitch(allToolsetsEnabled)} />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 [scrollbar-gutter:stable]">
        <StoreCardGrid>
          {visibleToolsets.map(toolset => (
            <ToolsetCard
              busy={bulkBusy}
              calls={toolCalls ? toolsetCalls(toolset, toolCalls) : null}
              key={toolset.name}
              onOpen={() => setDetailToolsetName(toolset.name)}
              onToggle={enabled => void handleToggleToolset(toolset, enabled)}
              toolset={toolset}
            />
          ))}
        </StoreCardGrid>
      </div>
    </div>
  )

  return (
    <PageSearchShell
      {...props}
      activeTab={mode}
      description={t.skills.pageDescription}
      onSearchChange={setQuery}
      onTabChange={id => setMode(id as (typeof SKILLS_MODES)[number])}
      // The connections tab manages a handful of entries with the editor right
      // there — searching it is noise.
      searchHidden={mode === 'mcp'}
      searchHints={searchHints}
      searchPlaceholder={
        mode === 'skills'
          ? t.skills.searchSkills
          : mode === 'hub'
            ? t.skills.hub.searchPlaceholder
            : t.skills.searchToolsets
      }
      searchValue={query}
      tabs={SKILLS_MODES.map(id =>
        id === 'skills'
          ? { id, label: t.skills.tabSkills, meta: skills ? ownSkills.length : null }
          : id === 'hub'
            ? { id, label: t.skills.tabHub }
            : id === 'toolsets'
              ? { id, label: t.skills.tabToolsets, meta: toolsets ? bulkToolsets.length : null }
              : { id, label: t.skills.tabMcp }
      )}
      title={t.skills.pageTitle}
    >
      {mode === 'hub' ? (
        <SkillsHub query={query} />
      ) : mode === 'mcp' ? (
        <McpTab gateway={gateway} />
      ) : (skillsFailed || toolsetsFailed) && (!skills || !toolsets) ? (
        <PanelEmpty
          action={
            <Button onClick={() => void refreshCapabilities()} size="sm">
              {t.skills.refresh}
            </Button>
          }
          description={skillsError instanceof Error ? skillsError.message : undefined}
          icon="error"
          title={t.skills.skillsLoadFailed}
        />
      ) : !skills || !toolsets ? (
        <PageLoader label={t.skills.loading} />
      ) : mode === 'skills' ? (
        visibleSkills.length === 0 ? (
          capabilityEmpty(t.skills.nounSkills)
        ) : (
          skillsGrid
        )
      ) : visibleToolsets.length === 0 ? (
        capabilityEmpty(t.skills.nounTools)
      ) : (
        toolsetsGrid
      )}
      <SkillDetailDialog
        busy={bulkBusy}
        onArchive={skill => {
          setDetailSkillName(null)
          setArchiveTarget(skill.name)
        }}
        onClose={() => setDetailSkillName(null)}
        onEdit={skill => {
          setDetailSkillName(null)
          void openSkillEditor(skill.name)
        }}
        onPublish={(skill, publishMode) => {
          setDetailSkillName(null)
          setPublish({ mode: publishMode, skill })
        }}
        onToggle={(skill, enabled) => void handleToggleSkill(skill, enabled)}
        onTryNow={tryNow}
        skill={detailSkill}
      />
      <ToolsetDetailDialog
        busy={bulkBusy}
        onClose={() => setDetailToolsetName(null)}
        onConfiguredChange={refreshToolsets}
        onToggle={(toolset, enabled) => void handleToggleToolset(toolset, enabled)}
        toolCalls={toolCalls ?? {}}
        toolset={detailToolset}
      />
      {publish && (
        <PublishSkillDialog
          key={`${publish.skill.name}-${publish.mode}`}
          mode={publish.mode}
          onClose={() => setPublish(null)}
          open
          skill={publish.skill}
        />
      )}
      {archiveTarget && (
        <ArchiveSkillConfirmDialog
          onApply={() => {
            const name = archiveTarget
            const snapshot = skills

            setSkills(current => current?.filter(skill => skill.name !== name) ?? current)
            invalidateSlashCompletions()

            if (skillEditor?.name === name) {
              setSkillEditor(null)
            }

            return () => setSkills(snapshot)
          }}
          onClose={() => setArchiveTarget(null)}
          onFailure={(err, name) => notifyError(err, name)}
          open
          skillId={archiveTarget}
          skillName={archiveTarget}
        />
      )}
    </PageSearchShell>
  )
}
