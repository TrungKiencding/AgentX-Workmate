import { useStore } from '@nanostores/react'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { ModelMenuCloseContext } from '@/app/shell/model-menu-panel'
import { composerUndersideControl } from '@/components/chat/composer-dock'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { releaseTypingFocus } from '@/components/ui/keyboard-first'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { ChevronDown, Zap } from '@/lib/icons'
import { refreshModelCatalogQueries } from '@/lib/model-options'
import { conciseModelName, displayModelName, modelBaseId } from '@/lib/model-status-label'
import { effectiveReasoningEffort } from '@/lib/reasoning-effort'
import { cn } from '@/lib/utils'
import { $activeGatewayProfile } from '@/store/profile'
import { $currentModelSource, $defaultReasoningEffort, setModelPickerOpen } from '@/store/session'

import { onComposerModelMenuRequest } from './focus'
import { useComposerScope } from './scope'
import type { ChatBarState } from './types'

// The resting trigger: a line of text in the strip under the composer, sized
// and inked like the folder control beside it so the two read as one context
// bar. It may shrink — the name truncates — so a long model name gives way in a
// narrow pane instead of wrapping the strip onto a second line.
const UNDERSIDE_TRIGGER = cn(composerUndersideControl, 'min-w-0 max-w-72 shrink')

// The floating (popped-out) composer keeps to one line, so there the model
// lives in the control row as a snug square holding just the chevron, sized
// to match the composer's other icon buttons.
const COMPACT_TRIGGER = cn(
  'size-(--composer-control-size) shrink-0 justify-center gap-0 p-0',
  'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground',
  'data-[state=open]:bg-(--chrome-action-hover) data-[state=open]:text-foreground'
)

/**
 * Composer model selector. Docked, it sits at the right end of the strip under
 * the composer — the model's name with its thinking level beside it in a
 * quieter ink (`MiniMax M3  Medium`), the way Claude's desktop app shows what
 * you are running at without opening anything. Popped out, it is the compact
 * chevron in the control row (`compact`).
 *
 * Reuses the live `model.options` dropdown (`modelMenuContent`) verbatim; falls
 * back to the full picker when the gateway is closed and no live menu exists.
 *
 * Display follows THIS surface's SessionView (primary or tile) — never the
 * primary-only globals — so side-by-side panes each show their own model.
 *
 * `concise` is the non-coding voice: outside a git repo the name is the short
 * one (`Qwen3.5`, not `Qwen3.5 122B A10B FP8`) and the level only shows once it
 * differs from the default — the everyday case reads as just the model.
 */
export function ModelPill({
  compact = false,
  concise = false,
  disabled,
  model
}: {
  compact?: boolean
  concise?: boolean
  disabled: boolean
  model: ChatBarState['model']
}) {
  const { t } = useI18n()
  const copy = t.shell.statusbar
  const optionCopy = t.shell.modelOptions
  const view = useSessionView()
  const queryClient = useQueryClient()
  // Prefer the chat-bar snapshot (already view-scoped by ChatView); fall back
  // to the live SessionView atoms so a mid-flight session.info still paints.
  const viewModel = useStore(view.$model)
  const viewProvider = useStore(view.$provider)
  const currentModel = model.model || viewModel
  const currentProvider = model.provider || viewProvider
  const fastMode = useStore(view.$fast)
  const reasoningEffort = useStore(view.$reasoningEffort)
  const modelSource = useStore($currentModelSource)
  const defaultEffort = useStore($defaultReasoningEffort)
  const runtimeId = useStore(view.$runtimeId)
  const [open, setOpen] = useState(false)
  const scope = useComposerScope()
  const hasLiveMenu = Boolean(model.modelMenuContent)

  const setMenuOpen = useCallback(
    (next: boolean) => {
      setOpen(next)

      if (next) {
        void refreshModelCatalogQueries(queryClient, $activeGatewayProfile.get(), view.$runtimeId.get())
      } else {
        // Radix returns focus to this toolbar button. Release its keyboard
        // claim so typing after a selection reaches the composer again.
        releaseTypingFocus()
      }
    },
    [queryClient, view]
  )

  // The `composer.modelPicker` hotkey, routed to exactly one surface (the pane
  // under the pointer, else the active composer — see requestModelMenuToggle).
  // Toggles the live dropdown; with no live menu (gateway closed) it opens the
  // full picker dialog, same as clicking the pill.
  useEffect(
    () =>
      onComposerModelMenuRequest(target => {
        if (target !== scope.target || disabled) {
          return
        }

        if (hasLiveMenu) {
          setMenuOpen(!open)
        } else {
          setModelPickerOpen(true)
        }
      }),
    [scope.target, disabled, hasLiveMenu, open, setMenuOpen]
  )

  // The composer pick is sticky: a manual selection is pinned and every NEW
  // chat uses it instead of the Settings → Model default — silently, which has
  // cost users real money on a forgotten paid-model pick (#62055). Surface the
  // pin whenever a draft (no live session) is running on a manual override. A
  // live session's footer reflects that session's model, so no badge there.
  // Tiles always have a runtime — pin badge is primary-draft only.
  const pinnedOverride =
    view.kind === 'primary' && !runtimeId && modelSource === 'manual' && Boolean(currentModel.trim())

  const level = effectiveReasoningEffort(reasoningEffort, defaultEffort)
  const showLevel = !concise || level !== effectiveReasoningEffort('', defaultEffort)
  // Fast is on via the speed param OR because the model IS a `…-fast` variant.
  const fastOn = fastMode || /-fast$/i.test(modelBaseId(currentModel))

  const label = compact ? (
    <ChevronDown className="size-3.5 shrink-0 opacity-70" />
  ) : currentModel.trim() ? (
    <>
      {/* Name in the primary ink, level in the tertiary: the two greys the
          strip would otherwise use (secondary/tertiary) sit too close to read
          as a hierarchy, and tertiary is already the lightest ink that keeps
          AA contrast. */}
      <span className="min-w-0 truncate text-(--text-primary)">{concise ? conciseModelName(currentModel) : displayModelName(currentModel)}</span>
      {fastOn || showLevel ? (
        <span
          className="flex shrink-0 items-center gap-1 text-(--text-tertiary) transition-colors duration-(--dur-micro)"
          data-testid="model-pill-level"
        >
          {fastOn ? <Zap aria-label={optionCopy.fastMode} className="size-3.5" role="img" /> : null}
          {showLevel ? optionCopy.effortShort[level] : null}
        </span>
      ) : null}
      {pinnedOverride && (
        <span
          aria-label={copy.modelPinned}
          className="size-1.5 shrink-0 rounded-full bg-(--ui-accent)"
          data-testid="model-pinned-dot"
          role="img"
        />
      )}
    </>
  ) : (
    // The model resolves a beat after the gateway/session comes up. Rather
    // than flash a literal "No model", show a quiet loader until it lands.
    <GlyphSpinner className="text-(--text-tertiary)" spinner="braille" />
  )

  const pillClass = compact ? COMPACT_TRIGGER : UNDERSIDE_TRIGGER

  const baseTitle = currentProvider
    ? copy.modelTitle(currentProvider, currentModel || copy.modelNone)
    : copy.switchModel

  const title = pinnedOverride ? `${baseTitle} — ${copy.modelPinned}` : baseTitle

  if (!model.modelMenuContent) {
    return (
      <Tip label={pinnedOverride ? `${copy.openModelPicker} — ${copy.modelPinned}` : copy.openModelPicker} side="top">
        <Button
          aria-label={copy.openModelPicker}
          className={pillClass}
          disabled={disabled}
          onClick={() => setModelPickerOpen(true)}
          type="button"
          variant="ghost"
        >
          {label}
        </Button>
      </Tip>
    )
  }

  return (
    <DropdownMenu onOpenChange={setMenuOpen} open={open}>
      <Tip label={title} side="top">
        <DropdownMenuTrigger asChild>
          <Button aria-label={title} className={pillClass} disabled={disabled} type="button" variant="ghost">
            {label}
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="w-80 p-0" side="top" sideOffset={8}>
        <ModelMenuCloseContext.Provider value={() => setMenuOpen(false)}>
          {model.modelMenuContent}
        </ModelMenuCloseContext.Provider>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
