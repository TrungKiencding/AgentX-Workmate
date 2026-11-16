import { useId } from 'react'

import { colorAlongSteps, DropdownMenuItem, DropdownMenuStepSlider } from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { Zap } from '@/lib/icons'
import { effectiveReasoningEffort, thinkingStops } from '@/lib/reasoning-effort'
import { cn } from '@/lib/utils'

/** How "fast" is achieved for a given model — two different mechanisms:
 *  - `param`: the Anthropic/OpenAI `speed=fast` request parameter.
 *  - `variant`: a separate `…-fast` sibling model selected via the model field.
 */
export type FastControl =
  { kind: 'none' } | { kind: 'param'; on: boolean } | { kind: 'variant'; baseId: string; fastId: string; on: boolean }

/** Resolve the fast mechanism for a model: prefer the speed=fast parameter
 *  when the backend supports it, else fall back to a `…-fast` sibling model. */
export function resolveFastControl(
  model: string,
  providerModels: readonly string[],
  paramSupported: boolean,
  currentFastMode: boolean
): FastControl {
  if (paramSupported) {
    return { kind: 'param', on: currentFastMode }
  }

  if (/-fast$/i.test(model)) {
    const baseId = model.replace(/-fast$/i, '')

    // Only a toggle if there's a base to switch back to; otherwise it's a
    // standalone fast model with no "off" state.
    return providerModels.includes(baseId) ? { kind: 'variant', baseId, fastId: model, on: true } : { kind: 'none' }
  }

  const fastId = `${model}-fast`

  if (providerModels.includes(fastId)) {
    return { kind: 'variant', baseId: model, fastId, on: false }
  }

  // Fast isn't natively offered here, but if the session still has the speed
  // param on (carried over from a previous model), expose the toggle so it can
  // be turned off rather than stranded.
  if (currentFastMode) {
    return { kind: 'param', on: true }
  }

  return { kind: 'none' }
}

// Quick reads cool, deep reads violet: the run warms through the platform's
// teal → blue → purple tints as the thinking gets deeper.
const THINKING_COLORS = ['var(--tint-teal)', 'var(--tint-blue)', 'var(--tint-purple)'] as const

interface ModelOptionsSectionProps {
  /** The profile's configured default effort — what an unset value inherits,
   *  and the level the dial marks as "Default". */
  defaultEffort: string
  /** The current model's effective effort ('' = inherit, 'none' = off). */
  effort: string
  /** How fast mode is offered for the current model; `none` hides the row. */
  fastControl: FastControl
  /** Switch to a specific model id (used to swap base ⇄ -fast variant). */
  onSelectModel: (model: string) => Promise<boolean | void> | void
  /** Report an option change. This section is PURE: it never writes to a
   *  session, a preset store, or the gateway — the owning surface's controller
   *  decides what an edit means. That's what lets the same menu drive a live
   *  chat session and a detached per-task override. */
  onSetOptions: (patch: { effort?: string; fast?: boolean }) => void
  /** Whether the current model takes a reasoning effort (shows the dial). */
  reasoning: boolean
}

/**
 * The current model's options, inline under the catalog — no hover submenu.
 * Thinking is ONE stepped slider from "answer right away" (the backend's
 * `none`, the bottom of the same ladder — not a separate switch) to "deepest",
 * with the chosen level named in the heading and one plain line saying what it
 * trades off. Fast mode, when the model has one, is a single switch row.
 */
export function ModelOptionsSection({
  defaultEffort,
  effort,
  fastControl,
  onSelectModel,
  onSetOptions,
  reasoning
}: ModelOptionsSectionProps) {
  const { t } = useI18n()
  const copy = t.shell.modelOptions
  const labelId = useId()

  if (!reasoning && fastControl.kind === 'none') {
    return null
  }

  const level = effectiveReasoningEffort(effort, defaultEffort)
  const isDefault = level === effectiveReasoningEffort('', defaultEffort)
  const stops = thinkingStops(level)
  const levelColor = colorAlongSteps(THINKING_COLORS, stops.indexOf(level) / Math.max(stops.length - 1, 1))
  // Re-keyed per level so the name and its hint arrive with a short fade-up
  // each time the thumb moves (no motion when the OS asks for none).
  const arrive = 'animate-in fade-in-0 slide-in-from-bottom-0.5 duration-(--dur-short) motion-reduce:animate-none'
  const fastOn = fastControl.kind !== 'none' && fastControl.on

  const setFast = (enabled: boolean) => {
    // Record the choice either way, so the controller can remember it against
    // the model; a variant also swaps to its sibling id.
    onSetOptions({ fast: enabled })

    if (fastControl.kind === 'variant') {
      void onSelectModel(enabled ? fastControl.fastId : fastControl.baseId)
    }
  }

  return (
    <div data-slot="model-options">
      {reasoning ? (
        <div className="px-3 pt-2.5 pb-3">
          <div className="mb-1.5 flex items-baseline justify-between gap-3">
            <span className="text-xs text-(--text-tertiary)" id={labelId}>
              {copy.thinkingLevel}
            </span>
            <span aria-live="polite" className={cn('flex min-w-0 items-center gap-1.5', arrive)} key={level}>
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full transition-colors duration-(--dur-short)"
                style={{ backgroundColor: levelColor }}
              />
              <span className="truncate text-sm font-medium text-(--text-primary)">{copy[level]}</span>
            </span>
          </div>
          <DropdownMenuStepSlider
            aria-labelledby={labelId}
            className="-mx-2.5"
            colors={THINKING_COLORS}
            onValueChange={value => {
              if (value !== level) {
                onSetOptions({ effort: value })
              }
            }}
            options={stops.map(stop => ({ label: copy[stop], value: stop }))}
            value={level}
          />
          <div className="mt-0.5 flex justify-between text-xs text-(--text-tertiary)">
            <span>{copy.scaleStart}</span>
            <span>{copy.scaleEnd}</span>
          </div>
          <p className={cn('mt-2 truncate text-xs text-(--text-secondary)', arrive)} key={level}>
            {copy.effortHint[level]}
            {isDefault ? <span className="text-(--text-tertiary)"> · {copy.defaultMark}</span> : null}
          </p>
        </div>
      ) : null}
      {fastControl.kind !== 'none' ? (
        <DropdownMenuItem
          aria-checked={fastOn}
          className="h-auto min-h-10 gap-2.5 rounded-none px-3 py-1.5"
          onSelect={event => {
            event.preventDefault()
            setFast(!fastOn)
          }}
          role="menuitemcheckbox"
        >
          <Zap className={cn('size-4', fastOn && 'text-(--accent)')} />
          {/* Fast costs more on every provider that offers it — say so where
              the switch is, not in a tooltip nobody hovers. */}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm">{copy.fastMode}</span>
            <span className="truncate text-xs text-(--text-tertiary)">{copy.fastHint}</span>
          </span>
          {/* The ROW is the control (a menuitemcheckbox); the switch only shows
              its state, so it must not take focus or a second click. */}
          <Switch aria-hidden checked={fastOn} className="pointer-events-none" size="xs" tabIndex={-1} />
        </DropdownMenuItem>
      ) : null}
    </div>
  )
}
