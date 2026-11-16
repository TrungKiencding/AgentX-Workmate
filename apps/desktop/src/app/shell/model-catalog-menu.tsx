import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  dropdownMenuRow,
  DropdownMenuSearch,
  dropdownMenuSectionLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { HighlightMatches } from '@/components/ui/highlight-matches'
import { usePointerQuiet } from '@/components/ui/keyboard-first'
import { Skeleton } from '@/components/ui/skeleton'
import type { HermesGateway } from '@/hermes'
import { useI18n } from '@/i18n'
import { SlidersHorizontal, Zap } from '@/lib/icons'
import { modelCatalogQueryPolicy, modelOptionsQueryKey, requestModelOptions } from '@/lib/model-options'
import { displayModelName, modelDisplayParts } from '@/lib/model-status-label'
import { DEFAULT_REASONING_EFFORT, effectiveReasoningEffort } from '@/lib/reasoning-effort'
import { normalize } from '@/lib/text'
import { cn } from '@/lib/utils'
import {
  $knownModels,
  $visibleModels,
  collapseModelFamilies,
  DEFAULT_VISIBLE_PER_PROVIDER,
  effectiveVisibleKeys,
  type ModelFamily,
  modelVisibilityKey,
  setModelVisibilityOpen
} from '@/store/model-visibility'
import { $collapsedProviders, toggleCollapsedProvider } from '@/store/provider-collapse'
import { $defaultReasoningEffort } from '@/store/session'
import type { ModelOptionProvider, ModelOptionsResponse } from '@/types/hermes'

import { type FastControl, ModelOptionsSection, resolveFastControl } from './model-options-section'

// Lets the host dropdown (model-pill, a kanban field trigger, …) hand the panel
// a way to dismiss itself so clicking a model row commits + closes, while the
// options section under the list (thinking level, fast) stays open to play
// with (its items preventDefault on select).
export const ModelMenuCloseContext = createContext<() => void>(() => {})

/** One model choice, everything a caller needs to act on a selection.
 *  `effort` is '' for "inherit the default" and 'none' for thinking off. */
export interface ModelChoice {
  effort: string
  fast: boolean
  model: string
  provider: string
}

/**
 * What a surface DOES with the catalog. The menu renders and navigates; the
 * controller owns meaning — the composer writes through to a live session,
 * the kanban override just holds a value in dialog state.
 *
 * `presetFor` supplies the remembered settings shown on a non-active row.
 * Returning `{}` is fine — the row then shows AgentX' defaults.
 */
export interface ModelMenuController {
  /** Restore a model's remembered settings after it is selected. Separate from
   *  `setOptions` because it is one atomic "apply this model's preset" write,
   *  not a user editing one control — surfaces that write through to a session
   *  need to batch it. Values are already capability-gated by the menu. */
  applyPreset: (preset: { effort?: string; fast?: boolean }, row: { model: string; provider: string }) => void
  current: ModelChoice
  presetFor: (provider: string, model: string) => { effort?: string; fast?: boolean }
  /** Commit a model row. Return false to abort (a failed session switch). */
  select: (model: string, provider: string) => Promise<boolean | void> | void
  /** Edit ONE option of the current model. `isActive` is always true from the
   *  menu (the options section edits the selection, never another row); it
   *  stays in the shape so a controller can share one code path with callers
   *  that edit a remembered preset. */
  setOptions: (
    patch: { effort?: string; fast?: boolean },
    row: {
      /** Set when `fast` is carried by switching to the `…-fast` sibling id
       *  (the menu does that switch itself) rather than by the `speed=fast`
       *  request param — so the edit is a preference, not a session write. */
      fastViaVariant?: boolean
      isActive: boolean
      model: string
      provider: string
    }
  ) => void
  /** Which options this surface can carry. Omitted = both. An assistant's
   *  stored model has no thinking depth; a kanban worker spawn has no fast
   *  flag — the menu hides what the surface would silently drop. */
  options?: { effort?: boolean; fast?: boolean }
}

interface ModelCatalogMenuProps {
  controller: ModelMenuController
  gateway?: HermesGateway
  /** Render the virtual `moa` provider's presets as a selectable section.
   *  Off for override surfaces, where a MoA preset isn't a worker model. */
  includeMoa?: boolean
  profile?: string
  /** Session whose catalog to fetch. A live session's catalog can differ from
   *  the profile-global one, and the app invalidates the SESSION-scoped query
   *  key on model changes — a surface bound to a session must pass it or its
   *  menu goes stale. Detached surfaces (per-task overrides) omit it. */
  sessionId?: null | string
}

interface ProviderGroup {
  families: ModelFamily[]
  provider: ModelOptionProvider
}

/** Below this many choices the list is short enough to scan, so the search
 *  field would only push the models down — unless some are hidden, in which
 *  case search is how you reach them. */
const SEARCH_MIN_ROWS = 6

/**
 * THE model catalog menu: provider-grouped, `-fast` families collapsed to one
 * row, the current model's options (thinking level, fast) inline under the
 * list, full keyboard selection. Shared verbatim by the composer's model pill
 * and by plugin surfaces that pick a model without a session behind it — so
 * the two can never drift apart.
 *
 * It stays as quiet as the catalog allows: one provider means no provider
 * heading, a short fully-shown list means no search field.
 */
export function ModelCatalogMenu({
  controller,
  gateway,
  includeMoa = false,
  profile = 'default',
  sessionId = null
}: ModelCatalogMenuProps) {
  const { t } = useI18n()
  const copy = t.shell.modelMenu
  const optionsCopy = t.shell.modelOptions
  const effortShort = optionsCopy.effortShort
  const closeMenu = useContext(ModelMenuCloseContext)
  const [search, setSearch] = useState('')
  const collapsedProviders = useStoreCollapsed()
  const defaultEffort = useDefaultEffort()
  // Which models the user curated in Edit Models. Read HERE rather than taken
  // as a prop: it's one global preference, so every surface that shows a
  // catalog must show the same shortlist. A per-caller opt-in is how the board
  // and the composer would end up disagreeing about what "my models" means.
  const visibleModels = useStore($visibleModels)
  const knownModels = useStore($knownModels)

  const modelOptions = useQuery({
    ...modelCatalogQueryPolicy,
    queryKey: modelOptionsQueryKey(profile, sessionId),
    // Gateway-first even with no session: a connected (possibly remote)
    // gateway owns the model catalog, including virtual providers the local
    // REST fallback can't know about (#53817).
    queryFn: (): Promise<ModelOptionsResponse> => requestModelOptions({ gateway, profile, sessionId })
  })

  const loading = modelOptions.isPending && !modelOptions.data

  const error = modelOptions.error
    ? modelOptions.error instanceof Error
      ? modelOptions.error.message
      : String(modelOptions.error)
    : null

  const providers = modelOptions.data?.providers

  // The catalog carries MoA presets as a virtual `moa` provider row. Keep it
  // out of the main groups so presets never show up twice.
  const moaPresets = useMemo(
    () => (includeMoa ? (providers?.find(p => p.slug.toLowerCase() === 'moa')?.models ?? []) : []),
    [providers, includeMoa]
  )

  const pickerProviders = useMemo(
    () => providers?.filter(provider => provider.slug.toLowerCase() !== 'moa') ?? [],
    [providers]
  )

  const current = controller.current

  // Resolve visibility HERE, against the catalog we actually fetched: an empty
  // provider list would otherwise resolve to an empty key set that reads as
  // "user hid everything" and blanks the menu on first open.
  const shownKeys = useMemo(
    () => effectiveVisibleKeys(visibleModels, pickerProviders, knownModels),
    [visibleModels, pickerProviders, knownModels]
  )

  const groups = useMemo(
    () => groupModels(pickerProviders, search, { model: current.model, provider: current.provider }, shownKeys),
    [pickerProviders, search, current.model, current.provider, shownKeys]
  )

  // The menu's shape (search field? provider headings?) is decided from the
  // UNFILTERED view, so typing can never make the field you're typing in — or
  // the headings around the matches — disappear.
  const restingGroups = useMemo(
    () => groupModels(pickerProviders, '', { model: current.model, provider: current.provider }, shownKeys),
    [pickerProviders, current.model, current.provider, shownKeys]
  )

  const catalogSize = useMemo(
    () =>
      pickerProviders.reduce((sum, provider) => sum + collapseModelFamilies(provider.models ?? []).length, 0) +
      moaPresets.length,
    [pickerProviders, moaPresets]
  )

  const restingSize = restingGroups.reduce((sum, group) => sum + group.families.length, 0) + moaPresets.length
  const showSearch = catalogSize >= SEARCH_MIN_ROWS || catalogSize > restingSize
  // One provider needs no heading — and must not be collapsible either, or a
  // stored collapse would hide every model behind a heading that isn't there.
  const showHeadings = restingGroups.length > 1

  const q = normalize(search)

  // Presets are searchable rows like everything else — an unfiltered preset
  // sitting under zero model matches would otherwise become the "first match"
  // Enter commits.
  const shownMoaPresets = useMemo(
    () => (q ? moaPresets.filter(preset => `moa ${preset}`.toLowerCase().includes(q)) : moaPresets),
    [moaPresets, q]
  )

  const isCollapsed = (slug: string) => showHeadings && !search && collapsedProviders.includes(slug)

  // ── The current model's options ────────────────────────────────────────────
  // Resolved against the catalog so the dial matches what the model accepts.
  // A MoA preset is a pipeline, not a model: it has no single thinking depth.
  const allowEffort = controller.options?.effort !== false
  const allowFast = controller.options?.fast !== false

  const currentOptions = useMemo(() => {
    if (!modelOptions.data || !current.model.trim() || current.provider === 'moa') {
      return null
    }

    const provider = pickerProviders.find(p => p.slug === current.provider)

    // The family's BASE id keys capabilities and presets, even while the
    // session runs its `-fast` sibling.
    const familyId =
      collapseModelFamilies(provider?.models ?? []).find(
        family => family.id === current.model || family.fastId === current.model
      )?.id ?? current.model

    const caps = provider?.capabilities?.[familyId]

    return {
      familyId,
      fastControl: resolveFastControl(current.model, provider?.models ?? [], caps?.fast ?? false, current.fast),
      reasoning: caps?.reasoning ?? true
    }
  }, [modelOptions.data, pickerProviders, current.model, current.provider, current.fast])

  const optionsShown =
    currentOptions !== null &&
    ((allowEffort && currentOptions.reasoning) || (allowFast && currentOptions.fastControl.kind !== 'none'))

  const selectFamily = async (family: ModelFamily, provider: ModelOptionProvider) => {
    const caps = provider.capabilities?.[family.id]
    const preset = controller.presetFor(provider.slug, family.id)

    // Variant-fast models (no speed param) express "fast" as a separate `-fast`
    // id, so honor the remembered preset by selecting that sibling. Param-fast
    // is applied through setOptions below instead.
    const variantFast = allowFast && !(caps?.fast ?? false) && !!family.fastId
    const targetId = variantFast && preset.fast === true ? family.fastId! : family.id

    if ((await controller.select(targetId, provider.slug)) === false) {
      return
    }

    controller.applyPreset(
      {
        effort: allowEffort && (caps?.reasoning ?? true) ? (preset.effort ?? defaultEffort) : undefined,
        fast: allowFast && (caps?.fast ?? false) ? (preset.fast ?? false) : undefined
      },
      { model: family.id, provider: provider.slug }
    )
  }

  const selectMoaPreset = async (preset: string) => {
    if ((await controller.select(preset, 'moa')) === false) {
      return
    }

    closeMenu()
  }

  // ── Keyboard selection (cmdk semantics on a Radix menu) ───────────────────
  // While the search field is up it keeps DOM focus, so it drives a virtual
  // cursor over one flat list mirroring EXACTLY what's rendered (collapse,
  // filter, presets) — the selection can never sit on a hidden row. With no
  // search field, Radix's own roving focus is the cursor.
  type KbRow =
    | { family: ModelFamily; key: string; kind: 'family'; provider: ModelOptionProvider }
    | { key: string; kind: 'moa'; preset: string }

  const kbRows = useMemo<KbRow[]>(
    () => [
      ...groups.flatMap(group =>
        showHeadings && !search && collapsedProviders.includes(group.provider.slug)
          ? []
          : group.families.map((family): KbRow => ({
              family,
              key: `${group.provider.slug}:${family.id}`,
              kind: 'family',
              provider: group.provider
            }))
      ),
      ...shownMoaPresets.map((preset): KbRow => ({ key: `moa:${preset}`, kind: 'moa', preset }))
    ],
    [groups, collapsedProviders, search, shownMoaPresets, showHeadings]
  )

  const [kbOverride, setKbOverride] = useState<null | number>(null)
  // The virtual cursor stands down once ↓ hands focus to the options below.
  const [kbHandedOff, setKbHandedOff] = useState(false)
  // A parked cursor is not a cursor in use: until the mouse actually moves,
  // hover can't take rows out from under the keyboard.
  const pointerQuiet = usePointerQuiet()

  const currentKey = current.provider === 'moa' ? `moa:${current.model}` : `${current.provider}:${current.model}`

  const autoIndex = q
    ? kbRows.length > 0
      ? 0
      : -1
    : kbRows.findIndex(row => row.key === currentKey || (row.kind === 'family' && row.family.fastId === current.model))

  const kbIndex = kbOverride !== null && kbOverride < kbRows.length ? kbOverride : autoIndex
  const kbActiveKey = showSearch && !kbHandedOff && kbIndex >= 0 ? kbRows[kbIndex].key : null
  const optionsRef = useRef<HTMLDivElement>(null)

  const stepKb = (delta: -1 | 1) => {
    if (kbRows.length === 0) {
      return
    }

    // ↓ past the last row continues into the options (a menu blocks Tab, so
    // this is the keyboard's only way down to the thinking dial).
    if (delta === 1 && kbIndex === kbRows.length - 1) {
      const target = optionsRef.current?.querySelector<HTMLElement>(
        '[role="menuitemradio"][data-state="checked"], [role="menuitemcheckbox"]'
      )

      if (target) {
        setKbHandedOff(true)
        target.focus()

        return
      }
    }

    const from = kbIndex >= 0 ? kbIndex : delta === 1 ? -1 : 0

    setKbOverride((from + delta + kbRows.length) % kbRows.length)
  }

  const commitKbRow = () => {
    const row = kbIndex >= 0 ? kbRows[kbIndex] : undefined

    if (!row) {
      return
    }

    if (row.kind === 'moa') {
      void selectMoaPreset(row.preset)

      return
    }

    if (row.key !== currentKey && row.family.fastId !== current.model) {
      void selectFamily(row.family, row.provider)
    }

    closeMenu()
  }

  // Keep the selected row in view while arrowing through the scrollable list.
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.querySelector('[data-kb-active]')?.scrollIntoView({ block: 'nearest' })
  }, [kbActiveKey])

  const kbRowProps = (key: string) => {
    const active = kbActiveKey === key

    return {
      className: cn(dropdownMenuRow, active && 'bg-(--bg-hover)'),
      ...(active ? { 'data-kb-active': '' } : {})
    }
  }

  // Rows are hover-selectable, so they go inert with the pointer.
  const quietRows = pointerQuiet && 'pointer-events-none'
  const check = <Codicon className="ml-auto shrink-0 text-(--text-primary)" name="check" size="0.875rem" />

  return (
    // A column capped at the host surface's own max-height (inherited — Radix
    // publishes the available space on the popper), so when room runs short
    // only the model LIST shrinks and scrolls; the search, the options and the
    // footer stay put instead of the whole menu growing a second scrollbar.
    <div className="flex max-h-[inherit] flex-col" data-slot="model-catalog-menu">
      {showSearch ? (
        <DropdownMenuSearch
          aria-label={copy.search}
          onFocus={() => setKbHandedOff(false)}
          onKeyDown={event => {
            // Claim arrows and Enter from Radix so DOM focus stays in the input
            // and Enter commits the highlighted row without a DownArrow first.
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              event.stopPropagation()
              stepKb(event.key === 'ArrowDown' ? 1 : -1)
            } else if (event.key === 'Enter') {
              event.preventDefault()
              event.stopPropagation()
              commitKbRow()
            }
          }}
          onValueChange={value => {
            setSearch(value)
            setKbOverride(null)
            setKbHandedOff(false)
          }}
          placeholder={copy.search}
          value={search}
        />
      ) : null}

      {loading ? (
        <DropdownMenuGroup className="py-1">
          {Array.from({ length: 3 }, (_, index) => (
            <DropdownMenuItem
              className={dropdownMenuRow}
              disabled
              key={index}
              onSelect={event => event.preventDefault()}
            >
              <Skeleton className="h-4 w-full" />
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      ) : error && !modelOptions.data ? (
        <DropdownMenuItem className={cn(dropdownMenuRow, 'h-auto min-h-9 py-2 whitespace-normal')} disabled>
          {error}
        </DropdownMenuItem>
      ) : groups.length === 0 && shownMoaPresets.length === 0 ? (
        <DropdownMenuItem className={dropdownMenuRow} disabled>
          {copy.noModels}
        </DropdownMenuItem>
      ) : (
        <div className={cn('max-h-[40dvh] min-h-11 flex-1 overflow-y-auto py-1', quietRows)} ref={listRef}>
          {groups.map(group => {
            const slug = group.provider.slug
            const collapsed = isCollapsed(slug)

            return (
              <DropdownMenuGroup className={cn(showHeadings && 'pb-1')} key={slug}>
                {showHeadings ? (
                  <DropdownMenuItem
                    className={cn(
                      dropdownMenuSectionLabel,
                      'group/label flex h-auto w-full cursor-pointer items-center gap-1 rounded-none !bg-transparent focus:!bg-transparent'
                    )}
                    onSelect={event => {
                      event.preventDefault()
                      toggleCollapsedProvider(slug)
                    }}
                    textValue=""
                  >
                    <span className="truncate">
                      <HighlightMatches query={search} text={group.provider.name} />
                    </span>
                    <DisclosureCaret
                      className="shrink-0 text-(--text-tertiary) opacity-0 transition group-hover/label:opacity-100 group-focus/label:opacity-100"
                      open={!collapsed}
                      size="0.625rem"
                    />
                  </DropdownMenuItem>
                ) : null}
                {!collapsed &&
                  group.families.map(family => {
                    // The active id may be the base or its -fast sibling; either
                    // way this one family row represents both.
                    const isCurrent =
                      slug === current.provider && (current.model === family.id || current.model === family.fastId)

                    const { name, tag } = modelDisplayParts(family.id)
                    const caps = group.provider.capabilities?.[family.id]

                    // What this model comes back with when you switch to it —
                    // its remembered preset — but only where that differs from
                    // what every model gets anyway. The current row says
                    // nothing: the options section below IS its state.
                    const preset = isCurrent ? {} : controller.presetFor(slug, family.id)

                    const presetEffort =
                      allowEffort && preset.effort && (caps?.reasoning ?? true)
                        ? effectiveReasoningEffort(preset.effort, defaultEffort)
                        : null

                    const effortMeta =
                      presetEffort && presetEffort !== effectiveReasoningEffort('', defaultEffort)
                        ? effortShort[presetEffort]
                        : null

                    const fastMeta = allowFast && preset.fast === true && ((caps?.fast ?? false) || !!family.fastId)

                    return (
                      <DropdownMenuItem
                        key={`${slug}:${family.id}`}
                        onSelect={() => {
                          if (!isCurrent) {
                            void selectFamily(family, group.provider)
                          }

                          closeMenu()
                        }}
                        {...kbRowProps(`${slug}:${family.id}`)}
                      >
                        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
                          <span className="truncate">
                            <HighlightMatches query={search} text={name} />
                          </span>
                          {tag ? <span className="shrink-0 text-xs text-(--text-tertiary)">{tag}</span> : null}
                        </div>
                        {fastMeta || effortMeta ? (
                          <span className="flex shrink-0 items-center gap-1 text-xs text-(--text-tertiary)">
                            {fastMeta ? (
                              <Zap aria-label={optionsCopy.fastMode} className="size-3.5" role="img" />
                            ) : null}
                            {effortMeta}
                          </span>
                        ) : null}
                        {isCurrent ? check : null}
                      </DropdownMenuItem>
                    )
                  })}
              </DropdownMenuGroup>
            )
          })}
        </div>
      )}

      {shownMoaPresets.length > 0 ? (
        <div className={cn(quietRows)}>
          <DropdownMenuSeparator className="mx-0" />
          <DropdownMenuLabel className={dropdownMenuSectionLabel}>MoA presets</DropdownMenuLabel>
          {shownMoaPresets.map(preset => {
            const isCurrentMoa = current.provider === 'moa' && current.model === preset

            return (
              <DropdownMenuItem
                key={`moa:${preset}`}
                onSelect={event => {
                  event.preventDefault()
                  void selectMoaPreset(preset)
                }}
                {...kbRowProps(`moa:${preset}`)}
              >
                <span className="min-w-0 flex-1 truncate">
                  MoA: <HighlightMatches query={search} text={preset} />
                </span>
                {isCurrentMoa ? check : null}
              </DropdownMenuItem>
            )
          })}
        </div>
      ) : null}

      {optionsShown && currentOptions ? (
        <div ref={optionsRef}>
          <DropdownMenuSeparator className="mx-0" />
          <ModelOptionsSection
            defaultEffort={defaultEffort}
            effort={current.effort}
            fastControl={allowFast ? currentOptions.fastControl : NO_FAST}
            onSelectModel={nextModel => controller.select(nextModel, current.provider)}
            onSetOptions={patch =>
              controller.setOptions(patch, {
                fastViaVariant: currentOptions.fastControl.kind === 'variant',
                isActive: true,
                model: currentOptions.familyId,
                provider: current.provider
              })
            }
            reasoning={allowEffort && currentOptions.reasoning}
          />
        </div>
      ) : null}

      {/* Curation belongs to the catalog, not to one host: wherever you can
          pick a model you can say which models you want, and the shortlist is
          the same everywhere because it's one stored preference. (No "Refresh
          models" row: the composer refetches the catalog every time it opens.) */}
      <DropdownMenuSeparator className="mx-0" />
      {error && modelOptions.data && (
        <DropdownMenuItem className={cn(dropdownMenuRow, 'h-auto min-h-9 py-2 whitespace-normal')} disabled>
          {error}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        className={cn(dropdownMenuRow, 'h-10 text-sm text-(--text-secondary)')}
        onSelect={() => setModelVisibilityOpen(true)}
      >
        <SlidersHorizontal className="size-4" />
        {copy.editModels}
      </DropdownMenuItem>
    </div>
  )
}

const NO_FAST: FastControl = { kind: 'none' }

// Collapsed we show the user's chosen models (or the curated default); typing
// spans every available model so anything is reachable past the cut. A search
// is itself a narrowing action, so we do NOT cap per-provider matches.
function groupModels(
  providers: ModelOptionProvider[],
  search: string,
  current: { model: string; provider: string },
  visible: Set<string> | null
): ProviderGroup[] {
  const q = normalize(search)
  const groups: ProviderGroup[] = []

  for (const provider of providers) {
    const allFamilies = collapseModelFamilies(provider.models ?? [])

    if (allFamilies.length === 0) {
      continue
    }

    const matches = (family: ModelFamily) =>
      `${family.id} ${family.fastId ?? ''} ${provider.name} ${provider.slug} ${displayModelName(family.id)}`
        .toLowerCase()
        .includes(q)

    let shown: Set<string>

    if (q) {
      // Search spans every family, regardless of visibility.
      shown = new Set(allFamilies.filter(matches).map(family => family.id))
    } else if (visible) {
      // User has customized which models show — honor their selection exactly.
      shown = new Set(
        allFamilies.filter(family => visible.has(modelVisibilityKey(provider.slug, family.id))).map(family => family.id)
      )
    } else {
      shown = new Set(allFamilies.slice(0, DEFAULT_VISIBLE_PER_PROVIDER).map(family => family.id))
    }

    // Always include the active model — but keep every row in the provider's
    // stable curated order, so selecting a model can't shuffle the list. While
    // SEARCHING the pin is skipped: a query means "show me matches".
    const activeId =
      !q && provider.slug === current.provider && current.model
        ? allFamilies.find(family => family.id === current.model || family.fastId === current.model)?.id
        : undefined

    const families = allFamilies.filter(family => shown.has(family.id) || family.id === activeId)

    if (families.length > 0) {
      groups.push({ families, provider })
    }
  }

  // Stable, logical group order: alphabetical by provider name. (The backend
  // floats the current provider first, which would reshuffle on every switch.)
  groups.sort((a, b) => a.provider.name.localeCompare(b.provider.name))

  return groups
}

// Small hooks kept at the bottom so the component reads top-down.
function useStoreCollapsed(): string[] {
  return useStore($collapsedProviders)
}

function useDefaultEffort(): string {
  return useStore($defaultReasoningEffort) || DEFAULT_REASONING_EFFORT
}
