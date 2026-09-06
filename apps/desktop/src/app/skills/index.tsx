import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'
import type * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import { ArchiveSkillConfirmDialog } from '@/app/learning/archive-skill-confirm-dialog'
import { CodeEditor } from '@/components/chat/code-editor'
import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import { DisclosureRow } from '@/components/ui/disclosure-row'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { CountSkeleton } from '@/components/ui/skeleton'
import { StatusPill } from '@/components/ui/status-pill'
import { TagChip } from '@/components/ui/tag-chip'
import {
  editLearningNode,
  getLearningNode,
  getSkills,
  getToolsets,
  getUsageAnalytics,
  setSkillEnabled,
  setToolsetEnabled
} from '@/hermes'
import { type Translations, useI18n } from '@/i18n'
import { isDesktopToolsetVisible } from '@/lib/desktop-toolsets'
import { compactNumber } from '@/lib/format'
import { queryClient, writeCache } from '@/lib/query-client'
import { skillCategoryIcon, skillCategoryKey, skillDisplayName } from '@/lib/skill-categories'
import { invalidateSlashCompletions } from '@/lib/slash-completion-cache'
import { normalize } from '@/lib/text'
import { useStoreSelector } from '@/lib/use-session-slice'
import { $gateway } from '@/store/gateway'
import { notify, notifyError } from '@/store/notifications'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import type { SkillInfo, ToolsetInfo } from '@/types/hermes'

import { requestComposerInsert } from '../chat/composer/focus'
import { useOnProfileSwitch } from '../hooks/use-on-profile-switch'
import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import { useRouteEnumParam } from '../hooks/use-route-enum-param'
import {
  CapRow,
  DetailColumn,
  DetailPane,
  ListColumn,
  ListStrip,
  ListStripMenu,
  type ListStripMenuToggle,
  MasterDetail,
  ToolChip
} from '../master-detail'
import { PanelEmpty } from '../overlays/panel'
import { PageSearchShell } from '../page-search-shell'
import { NEW_CHAT_ROUTE, SETTINGS_ROUTE } from '../routes'
import { ComputerUsePanel } from '../settings/computer-use-panel'
import { asText, includesQuery, prettyName, toolNames, toolsetDisplayLabel } from '../settings/helpers'
import { TerminalBackendPanel } from '../settings/terminal-backend-panel'
import { ToolsetConfigPanel } from '../settings/toolset-config-panel'
import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

import { SkillsHub } from './hub'
import { McpTab } from './mcp-tab'
import { type PublishMode, PublishSkillDialog } from './publish-dialog'
import { $skillsSortDesc, $toolsetsSortDesc } from './store'

const SKILLS_MODES = ['skills', 'toolsets', 'mcp', 'hub'] as const

// Skills + toolsets live in the RQ cache so switching tabs/pages paints the
// cached lists instantly (no reload flash) and mount only fires a deduped
// background refetch. A profile swap globally invalidates (see store/profile),
// so these plain keys refetch against the new backend automatically.
const SKILLS_QUERY_KEY = ['skills-list'] as const
const TOOLSETS_QUERY_KEY = ['toolsets-list'] as const

// Optimistic write-through: toggles/bulk/archive repaint instantly; the next
// background refetch reconciles with the backend.
const setSkills = writeCache<SkillInfo[]>(SKILLS_QUERY_KEY)
const setToolsets = writeCache<ToolsetInfo[]>(TOOLSETS_QUERY_KEY)

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

const usageOf = (skill: SkillInfo): number => (typeof skill.usage === 'number' ? skill.usage : 0)

const categoryFor = (skill: SkillInfo): string => asText(skill.category) || 'general'

// Localized group label: the hand-written table first, a prettied slug for a
// category the table doesn't know.
function categoryLabel(raw: string, t: Translations): string {
  return t.skills.category[skillCategoryKey(raw)] ?? prettyName(raw)
}

// Learned/hub origins earn a quiet pill beside the title; bundled is the
// resting state and stays unmarked.
function provenancePill(skill: SkillInfo, t: Translations): React.ReactNode {
  if (skill.provenance !== 'agent' && skill.provenance !== 'hub') {
    return null
  }

  return <StatusPill tone="muted">{t.skills.provenance[skill.provenance]}</StatusPill>
}

// The hand-written Vietnamese-first copy layer for a toolset: a job-focused
// label and description keyed by the toolset's internal name; the backend's
// English label/description stay the fallback for one we haven't written.
function toolsetCopy(toolset: ToolsetInfo, t: Translations): { description: string; label: string } {
  const copy = t.skills.toolsets[toolset.name]

  return {
    label: copy?.label || toolsetDisplayLabel(toolset),
    description: copy?.description || asText(toolset.description)
  }
}

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

const toolsetCalls = (toolset: ToolsetInfo, toolCalls: Record<string, number>): number =>
  toolNames(toolset).reduce((sum, name) => sum + (toolCalls[name] ?? 0), 0)

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

const visibleToolsetCount = (toolsets: ToolsetInfo[]) => toolsets.filter(ts => isDesktopToolsetVisible(ts.name)).length

interface SkillsViewProps extends React.ComponentProps<'section'> {
  setStatusbarItemGroup?: SetStatusbarItemGroup
}

export function SkillsView({ setStatusbarItemGroup: _setStatusbarItemGroup, ...props }: SkillsViewProps) {
  const { t } = useI18n()
  const [mode, setMode] = useRouteEnumParam('tab', SKILLS_MODES, 'skills')
  // $gateway only feeds the MCP tab — gate the subscription so Skills/Toolsets/Hub
  // tabs don't re-render on connect/disconnect/reconnect.
  const gateway = useStoreSelector($gateway, g => (mode === 'mcp' ? g : null))

  const [query, setQuery] = useState('')

  const {
    data: skills,
    isError: skillsFailed,
    error: skillsError
  } = useQuery({
    queryKey: SKILLS_QUERY_KEY,
    queryFn: getSkills,
    staleTime: 0
  })

  const { data: toolsets, isError: toolsetsFailed } = useQuery({
    queryKey: TOOLSETS_QUERY_KEY,
    queryFn: getToolsets,
    staleTime: 0
  })

  // tool name -> call count over the analytics window. null = still loading
  // (badges show skeletons); {} = loaded empty / unavailable backend.
  const [toolCalls, setToolCalls] = useState<Record<string, number> | null>(null)
  // Bumped on profile switch so a slow analytics load from profile A can't set
  // toolCalls after the user moved to B.
  const toolCallsEpoch = useRef(0)
  const skillsSortDesc = useStore($skillsSortDesc)
  const toolsetsSortDesc = useStore($toolsetsSortDesc)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null)
  const [selectedToolset, setSelectedToolset] = useState<string | null>(null)

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
  useOnProfileSwitch(() => {
    toolCallsEpoch.current += 1
    setToolCalls(null)
  })

  const visibleSkills = useMemo(
    () => (skills ? filteredSkills(skills, query, skillsSortDesc, t) : []),
    [query, skills, skillsSortDesc, t]
  )

  const visibleToolsets = useMemo(
    () => (toolsets ? filteredToolsets(toolsets, query, toolCalls ?? {}, toolsetsSortDesc, t) : []),
    [query, t, toolCalls, toolsets, toolsetsSortDesc]
  )

  // Browsing (no search) groups skills by category so 84 rows read as a dozen
  // named shelves; a search flattens back to one relevance list. Groups order
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
  const bulkSkills = skills ?? []
  const bulkToolsets = useMemo(() => (toolsets ?? []).filter(ts => isDesktopToolsetVisible(ts.name)), [toolsets])

  // Rotating placeholder nudges from the user's own data — teach that search
  // understands categories and tool names, not just titles.
  const searchHints = useMemo(() => {
    if (mode === 'skills' && skills?.length) {
      const counts = new Map<string, number>()

      for (const skill of skills) {
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
  }, [mode, skills, toolsets, t])

  // Keep a valid selection: fall back to the first visible row when the
  // current selection is filtered out (or nothing is selected yet).
  const activeSkill = useMemo(
    () => visibleSkills.find(s => s.name === selectedSkill) ?? visibleSkills[0] ?? null,
    [selectedSkill, visibleSkills]
  )

  const activeToolset = useMemo(
    () => visibleToolsets.find(ts => ts.name === selectedToolset) ?? visibleToolsets[0] ?? null,
    [selectedToolset, visibleToolsets]
  )

  // Single toggles are optimistic and silent on success (the row repaints
  // immediately — a toast per flip would spam rapid customization). Errors
  // revert and notify.
  async function handleToggleSkill(skill: SkillInfo, enabled: boolean) {
    setSkills(current => current?.map(row => (row.name === skill.name ? { ...row, enabled } : row)) ?? current)

    try {
      await setSkillEnabled(skill.name, enabled)
      // A disabled skill loses its `/name` command, so the composer's cached
      // `/` list has to be dropped along with the row repaint.
      invalidateSlashCompletions()
    } catch (err) {
      setSkills(
        current => current?.map(row => (row.name === skill.name ? { ...row, enabled: !enabled } : row)) ?? current
      )
      notifyError(err, t.skills.failedToUpdate(skill.name))
    }
  }

  async function handleToggleToolset(toolset: ToolsetInfo, enabled: boolean) {
    setToolsets(
      current =>
        current?.map(row => (row.name === toolset.name ? { ...row, enabled, available: enabled } : row)) ?? current
    )

    try {
      await setToolsetEnabled(toolset.name, enabled)
    } catch (err) {
      setToolsets(
        current =>
          current?.map(row => (row.name === toolset.name ? { ...row, enabled: !enabled, available: !enabled } : row)) ??
          current
      )
      notifyError(err, t.skills.failedToUpdate(toolsetDisplayLabel(toolset)))
    }
  }

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

  // "Sắp xếp" — a real 28px control opening the two orders, instead of the old
  // bare 11px arrow-text toggle.
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

  // Full-bleed empty state, matching the connections tab (spans both columns,
  // not a cramped note in the left rail). Query-aware; three beats and one
  // action that resolves it.
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
      // Display order only — ids keep the ?tab= deep links stable.
      tabs={[
        { id: 'skills', label: t.skills.tabSkills, meta: skills?.length ?? null },
        { id: 'toolsets', label: t.skills.tabToolsets, meta: toolsets ? visibleToolsetCount(toolsets) : null },
        { id: 'hub', label: t.skills.tabHub },
        { id: 'mcp', label: t.skills.tabMcp }
      ]}
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
          <MasterDetail pane={skillEditorPane} split="wide">
            <ListColumn
              header={
                <ListStrip
                  left={sortButton(skillsSortDesc, next => $skillsSortDesc.set(next))}
                  right={
                    <ListStripMenu
                      items={[
                        { disabled: bulkBusy, label: t.skills.disableUnused, onSelect: () => void disableUnused() }
                      ]}
                      label={t.skills.tabSkills}
                      toggle={bulkSwitch(allSkillsEnabled)}
                    />
                  }
                />
              }
            >
              {(groupedSkills ?? [{ key: 'all', label: '', rows: visibleSkills, usage: 0 }]).map(group => (
                <div key={group.key}>
                  {group.label && (
                    <div className="flex items-baseline gap-1.5 px-2.5 pb-1 pt-3 first:pt-1">
                      <span className="text-sm font-semibold text-(--ui-text-tertiary)">{group.label}</span>
                      <span className="text-xs tabular-nums text-(--ui-text-quaternary)">{group.rows.length}</span>
                    </div>
                  )}
                  {group.rows.map(skill => (
                    <CapRow
                      active={activeSkill?.name === skill.name}
                      busy={bulkBusy}
                      enabled={skill.enabled}
                      icon={<SkillCategoryGlyph category={categoryFor(skill)} />}
                      key={skill.name}
                      meta={usageOf(skill) > 0 ? t.skills.usageCount(compactNumber(usageOf(skill))) : undefined}
                      onSelect={() => setSelectedSkill(skill.name)}
                      onToggle={enabled => void handleToggleSkill(skill, enabled)}
                      pill={provenancePill(skill, t)}
                      subtitle={asText(skill.description) || categoryLabel(categoryFor(skill), t)}
                      title={skillDisplayName(skill.name)}
                      toggleLabel={skill.name}
                    />
                  ))}
                </div>
              ))}
            </ListColumn>
            <DetailColumn footer={t.skills.changesApplyNewSessions}>
              {activeSkill && (
                <SkillDetail
                  onArchive={() => setArchiveTarget(activeSkill.name)}
                  onEdit={() => void openSkillEditor(activeSkill.name)}
                  skill={activeSkill}
                />
              )}
            </DetailColumn>
          </MasterDetail>
        )
      ) : visibleToolsets.length === 0 ? (
        capabilityEmpty(t.skills.nounTools)
      ) : (
        <MasterDetail split="wide">
          <ListColumn
            header={
              <ListStrip
                left={sortButton(toolsetsSortDesc, next => $toolsetsSortDesc.set(next))}
                right={<ListStripMenu label={t.skills.tabToolsets} toggle={bulkSwitch(allToolsetsEnabled)} />}
              />
            }
          >
            {visibleToolsets.map(toolset => {
              const copy = toolsetCopy(toolset, t)
              const calls = toolCalls ? toolsetCalls(toolset, toolCalls) : null

              return (
                <CapRow
                  active={activeToolset?.name === toolset.name}
                  busy={bulkBusy}
                  enabled={toolset.enabled}
                  key={toolset.name}
                  meta={
                    calls === null ? (
                      <CountSkeleton />
                    ) : calls > 0 ? (
                      t.skills.usageCount(compactNumber(calls))
                    ) : (
                      t.skills.toolsetFunctions(toolNames(toolset).length)
                    )
                  }
                  onSelect={() => setSelectedToolset(toolset.name)}
                  onToggle={checked => void handleToggleToolset(toolset, checked)}
                  subtitle={copy.description}
                  title={copy.label}
                  toggleLabel={t.skills.toggleToolset(copy.label, !toolset.enabled)}
                />
              )
            })}
          </ListColumn>
          <DetailColumn footer={t.skills.changesApplyNewSessions}>
            {activeToolset && (
              <ToolsetDetail onConfiguredChange={refreshToolsets} toolCalls={toolCalls ?? {}} toolset={activeToolset} />
            )}
          </DetailColumn>
        </MasterDetail>
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

// The skill's category glyph, sized by CapRow's icon slot.
function SkillCategoryGlyph({ category }: { category: string }) {
  const Icon = skillCategoryIcon(category)

  return <Icon />
}

// Shared inspector header — mirrors Messaging's PlatformDetail so Skills and
// Tools share one title/description block and tab switches don't jump. A
// detail names itself at 18px over 14px reading copy.
function DetailHeader({
  description,
  pills,
  title
}: {
  description: React.ReactNode
  pills?: React.ReactNode
  title: string
}) {
  return (
    <header>
      <div className="flex min-h-6 flex-wrap items-center gap-2">
        <h3 className="min-w-0 truncate text-lg font-semibold tracking-tight">{title}</h3>
        {pills}
      </div>
      <p className="mt-1 max-w-prose text-base text-(--ui-text-tertiary)">{description}</p>
    </header>
  )
}

// The folded technical tail every detail carries: raw ids, provenance, mono
// chips — everything a curious admin needs and nobody else has to read.
function TechnicalDetails({ children }: { children: React.ReactNode }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)

  return (
    <div>
      <DisclosureRow onToggle={() => setOpen(value => !value)} open={open}>
        {t.skills.technicalDetails}
      </DisclosureRow>
      {open && <div className="mt-1.5 grid gap-2 pl-5">{children}</div>}
    </div>
  )
}

function TechnicalDetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
      <span className="text-(--ui-text-tertiary)">{label}</span>
      <span className="min-w-0 text-foreground/85">{value}</span>
    </div>
  )
}

function SkillDetail({ onArchive, onEdit, skill }: { onArchive: () => void; onEdit: () => void; skill: SkillInfo }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  // Only learned/local skills are the user's to rewrite or archive — bundled
  // and hub skills are managed by their sources. They are also the ones the
  // person may upload to the AgentX Skill Hub or share with a workspace.
  const editable = skill.provenance === 'agent'
  const [publish, setPublish] = useState<null | PublishMode>(null)

  // "Thử ngay": land on a fresh chat and pre-type the skill's slash command.
  // Both are existing actions — navigation to the new-chat route, then the
  // composer-insert bus (its dispatch defers a macrotask, so the main composer
  // is mounted by the time the event fires).
  const tryNow = () => {
    navigate(NEW_CHAT_ROUTE)
    requestComposerInsert(`/${skill.name} `, { mode: 'inline', target: 'main' })
  }

  return (
    <>
      <DetailHeader
        description={asText(skill.description) || t.skills.noDescription}
        pills={
          <>
            <TagChip>{categoryLabel(categoryFor(skill), t)}</TagChip>
            {skill.provenance && skill.provenance !== 'bundled' && (
              <StatusPill tone={skill.provenance === 'agent' ? 'good' : 'muted'}>
                {t.skills.provenance[skill.provenance]}
              </StatusPill>
            )}
          </>
        }
        title={skillDisplayName(skill.name)}
      />
      <div className="flex flex-wrap items-center gap-2">
        {skill.enabled && (
          <Button data-testid="skill-try-now" onClick={tryNow}>
            {t.skills.tryNow}
          </Button>
        )}
        {editable && (
          <>
            <Button onClick={onEdit} size="sm" variant="secondary">
              {t.skills.edit}
            </Button>
            <Button data-testid="skill-upload-hub" onClick={() => setPublish('upload')} size="sm" variant="secondary">
              {t.skills.publish.upload}
            </Button>
            <Button
              data-testid="skill-propose-workspace"
              onClick={() => setPublish('propose')}
              size="sm"
              variant="outline"
            >
              {t.skills.publish.propose}
            </Button>
            <Button className="text-destructive hover:text-destructive" onClick={onArchive} size="sm" variant="outline">
              {t.skills.archive}
            </Button>
          </>
        )}
      </div>
      <TechnicalDetails>
        <TechnicalDetailRow label={t.skills.originalName} value={<span className="font-mono">{skill.name}</span>} />
        <TechnicalDetailRow
          label={t.skills.sourceLabel}
          value={skill.provenance ? t.skills.provenance[skill.provenance] : t.skills.provenance.bundled}
        />
      </TechnicalDetails>
      {publish && (
        <PublishSkillDialog
          key={`${skill.name}-${publish}`}
          mode={publish}
          onClose={() => setPublish(null)}
          open
          skill={skill}
        />
      )}
    </>
  )
}

function ToolsetDetail({
  toolset,
  toolCalls,
  onConfiguredChange
}: {
  toolset: ToolsetInfo
  toolCalls: Record<string, number>
  onConfiguredChange: () => void
}) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const tools = toolNames(toolset)
  const copy = toolsetCopy(toolset, t)
  const configRef = useRef<HTMLDivElement | null>(null)

  return (
    <>
      {/* "Configured" as a resting state is noise — only the warn state earns a pill. */}
      <DetailHeader
        description={copy.description || t.skills.noDescription}
        pills={!toolset.configured && <StatusPill tone="warn">{t.skills.needsKeys}</StatusPill>}
        title={copy.label}
      />
      {!toolset.configured && (
        <div>
          <Button
            onClick={() => configRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            size="sm"
            variant="secondary"
          >
            {t.skills.setUp}
          </Button>
        </div>
      )}
      {toolset.name === 'vision' && (
        // Vision has no provider matrix — model resolution runs through the
        // auxiliary model config. Point at the actual home (Settings → Models,
        // aux "vision" row) via an internal deep link instead of leaving the
        // detail pane empty.
        <div className="grid gap-1.5">
          <p className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
            {t.skills.visionModelHint}
          </p>
          <div>
            <Button
              onClick={() => navigate(`${SETTINGS_ROUTE}?tab=config:model&aux=vision`)}
              size="sm"
              variant="textStrong"
            >
              {t.skills.visionModelLink}
            </Button>
          </div>
        </div>
      )}
      {toolset.name === 'computer_use' && <ComputerUsePanel onConfiguredChange={onConfiguredChange} />}
      {toolset.name === 'terminal' && <TerminalBackendPanel onConfiguredChange={onConfiguredChange} />}
      <div ref={configRef}>
        <ToolsetConfigPanel key={toolset.name} onConfiguredChange={onConfiguredChange} toolset={toolset.name} />
      </div>
      <TechnicalDetails>
        <TechnicalDetailRow label={t.skills.originalName} value={<span className="font-mono">{toolset.name}</span>} />
        {tools.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tools.map(name => (
              <ToolChip key={name}>
                {name}
                {(toolCalls[name] ?? 0) > 0 && (
                  <span className="ml-1 text-(--ui-text-quaternary)">×{compactNumber(toolCalls[name])}</span>
                )}
              </ToolChip>
            ))}
          </div>
        )}
      </TechnicalDetails>
    </>
  )
}
