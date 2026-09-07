import { getSkills, getToolsets, setSkillEnabled, setToolsetEnabled } from '@/hermes'
import type { Translations } from '@/i18n'
import { writeCache } from '@/lib/query-client'
import { skillCategoryKey } from '@/lib/skill-categories'
import { invalidateSlashCompletions } from '@/lib/slash-completion-cache'
import { asText, prettyName } from '@/lib/text'
import { notifyError } from '@/store/notifications'
import type { SkillInfo, ToolsetInfo } from '@/types/hermes'

import { toolNames, toolsetDisplayLabel } from '../settings/helpers'

// The Tiện ích page's data layer, shared by the tabs that show the same
// skills: "Kỹ năng sẵn có" lists the bundled and learned ones, "Kho kỹ năng"
// flips the switch on the ones it installed. Both read one RQ cache entry and
// write through the same optimistic toggle, so a flip on either tab paints
// on both at once.
//
// Skills + toolsets live in the RQ cache so switching tabs/pages paints the
// cached lists instantly (no reload flash) and mount only fires a deduped
// background refetch. A profile swap globally invalidates (see store/profile),
// so these plain keys refetch against the new backend automatically.
export const SKILLS_QUERY_KEY = ['skills-list'] as const
export const TOOLSETS_QUERY_KEY = ['toolsets-list'] as const

export const skillsQueryOptions = { queryKey: SKILLS_QUERY_KEY, queryFn: getSkills, staleTime: 0 } as const
export const toolsetsQueryOptions = { queryKey: TOOLSETS_QUERY_KEY, queryFn: getToolsets, staleTime: 0 } as const

// Optimistic write-through: toggles/bulk/archive repaint instantly; the next
// background refetch reconciles with the backend.
export const setSkills = writeCache<SkillInfo[]>(SKILLS_QUERY_KEY)
export const setToolsets = writeCache<ToolsetInfo[]>(TOOLSETS_QUERY_KEY)

/** A skill installed from the AgentX Skill Hub — it belongs to the store tab, not the "sẵn có" one. */
export const isHubSkill = (skill: SkillInfo): boolean => skill.provenance === 'hub'

export const usageOf = (skill: SkillInfo): number => (typeof skill.usage === 'number' ? skill.usage : 0)

export const categoryFor = (skill: SkillInfo): string => asText(skill.category) || 'general'

// Localized group label: the hand-written table first, a prettied slug for a
// category the table doesn't know.
export function categoryLabel(raw: string, t: Translations): string {
  return t.skills.category[skillCategoryKey(raw)] ?? prettyName(raw)
}

// Single toggles are optimistic and silent on success (the card repaints
// immediately — a toast per flip would spam rapid customization). Errors
// revert and notify. A disabled skill loses its `/name` command, so the
// composer's cached `/` list is dropped along with the repaint.
export async function toggleSkillEnabled(skill: SkillInfo, enabled: boolean, failureTitle: string): Promise<void> {
  setSkills(current => current?.map(row => (row.name === skill.name ? { ...row, enabled } : row)) ?? current)

  try {
    await setSkillEnabled(skill.name, enabled)
    invalidateSlashCompletions()
  } catch (err) {
    setSkills(
      current => current?.map(row => (row.name === skill.name ? { ...row, enabled: !enabled } : row)) ?? current
    )
    notifyError(err, failureTitle)
  }
}

export async function toggleToolsetEnabled(
  toolset: ToolsetInfo,
  enabled: boolean,
  failureTitle: string
): Promise<void> {
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
    notifyError(err, failureTitle)
  }
}

// The hand-written Vietnamese-first copy layer for a toolset: a job-focused
// label and description keyed by the toolset's internal name; the backend's
// English label/description stay the fallback for one we haven't written.
export function toolsetCopy(toolset: ToolsetInfo, t: Translations): { description: string; label: string } {
  const copy = t.skills.toolsets[toolset.name]

  return {
    label: copy?.label || toolsetDisplayLabel(toolset),
    description: copy?.description || asText(toolset.description)
  }
}

// Tools whose real setup the backend cannot see. `_toolset_has_keys` answers
// exactly one question — "are the API keys this tool declared present?" — and
// each of these declares none, so it returns true and the tool reports itself
// configured while nothing works. What they actually need is a macOS
// permission plus a driver binary (computer_use), an OAuth login (spotify), or
// a model chosen over in Cài đặt → Model (vision).
//
// We cannot assert the opposite either — the client has no way to know a
// permission was granted or an account linked — so this does not raise a
// "Cần thiết lập" pill that would then never go away. It only picks the verb:
// the way in is called "Thiết lập", because there IS something to do in there,
// rather than "Chi tiết", which promises there is nothing.
//
// `bfl` and `video` have the same lying `configured` flag and are deliberately
// NOT here: they have no provider category, so their dialog renders empty
// (`toolset-config-panel.tsx` bails on `has_category: false`). Sending someone
// to an empty dialog is worse than saying nothing. Their fix is backend-side.
const SETUP_BEYOND_KEYS = new Set(['computer_use', 'spotify', 'vision'])

/** Whether a tool's card should lead with "Thiết lập" instead of "Chi tiết". */
export const toolsetSetupLed = (toolset: ToolsetInfo): boolean =>
  !toolset.configured || SETUP_BEYOND_KEYS.has(toolset.name)

/** Calls over the analytics window, summed across the toolset's functions. */
export const toolsetCalls = (toolset: ToolsetInfo, toolCalls: Record<string, number>): number =>
  toolNames(toolset).reduce((sum, name) => sum + (toolCalls[name] ?? 0), 0)

// A SKILL.md opens with a YAML frontmatter block (name, description, version,
// kind, visibility…). The preview dialog already says all of that in its
// title, tags and description, so the reading pane starts at the prose;
// rendered as markdown the block would come out as one run-on paragraph.
const FRONTMATTER_RE = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/

export const skillMarkdownBody = (skillMd: string): string => skillMd.replace(FRONTMATTER_RE, '').trim()
