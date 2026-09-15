import { type KeyboardEvent, type ReactNode, type RefObject, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Loader2, Search, X } from '@/lib/icons'
import { cn } from '@/lib/utils'

interface SearchFieldProps {
  placeholder: string
  value: string
  onChange: (value: string) => void
  /**
   * Data-driven placeholder suggestions ("Try “creative”") — one is picked at
   * random per mount, the nudge that search understands more than names.
   * Falls back to `placeholder` when absent/empty.
   */
  hints?: string[]
  /**
   * `inline` (default) — the borderless filter beside a page or overlay title,
   * receding until someone reaches for it. `field` — a list's standing finder
   * (the chat sidebar's), which has to read as a place to type before anyone
   * reaches for it: a full-width well in the shared input chrome, legible at
   * rest, the whole box a click target.
   */
  variant?: 'field' | 'inline'
  containerClassName?: string
  inputClassName?: string
  loading?: boolean
  onClear?: () => void
  inputRef?: RefObject<HTMLInputElement | null>
  trailingAction?: ReactNode
  'aria-label'?: string
}

/**
 * Shared search field used everywhere (sessions sidebar, pages, overlays,
 * command center, cron). `inline` has no box — borderless until focus, then an
 * underline — and rests at low opacity until focused or filled; `field` is the
 * boxed well (see `variant`). Width/placement come from `containerClassName`.
 * Escape backs out one step: it clears a query, then lets go of focus.
 */
export function SearchField({
  placeholder,
  value,
  onChange,
  hints,
  variant = 'inline',
  containerClassName,
  inputClassName,
  loading = false,
  onClear,
  inputRef,
  trailingAction,
  'aria-label': ariaLabel
}: SearchFieldProps) {
  const { t } = useI18n()
  const ownInputRef = useRef<HTMLInputElement>(null)
  const input = inputRef ?? ownInputRef
  const field = variant === 'field'

  // One hint per mount, picked at random — fresh nudge every visit, no
  // mid-page carousel.
  const [hintIndex] = useState(() => Math.floor(Math.random() * 4096))
  const hintCount = hints?.length ?? 0
  const effectivePlaceholder = hintCount > 0 ? hints![hintIndex % hintCount] : placeholder

  const clear = () => {
    if (onClear) {
      onClear()
    } else {
      onChange('')
    }

    // The clear button unmounts with the query; keep the caret in the field so
    // the next keystroke starts a new search instead of going nowhere.
    input.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // An IME spends Escape on cancelling its own composition — leave it be.
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) {
      return
    }

    if (value) {
      clear()
    } else {
      event.currentTarget.blur()
    }
  }

  const inputElement = (
    <input
      aria-label={ariaLabel ?? placeholder}
      className={cn(
        field
          ? 'h-full min-w-0 flex-1 bg-transparent text-base text-(--ui-text-primary) placeholder:text-(--ui-text-tertiary) focus:outline-none'
          : // `field-sizing: content` grows the input to fit the placeholder/typed
            // text; min-w-0 lets it shrink back below content size when the
            // context is narrower — long queries scroll inside the field.
            // text-sm + --control-h-sm match the form controls (Input/Select via
            // controlVariants) while the field keeps its borderless language.
            'h-(--control-h-sm) min-w-0 max-w-full bg-transparent text-sm text-foreground [field-sizing:content] placeholder:text-muted-foreground focus:outline-none',
        inputClassName
      )}
      onChange={event => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      placeholder={effectivePlaceholder}
      ref={input}
      spellCheck={false}
      type="text"
      value={value}
    />
  )

  const trailing = (
    <>
      {trailingAction}
      {loading ? (
        <Loader2
          className={cn(
            'pointer-events-none shrink-0 animate-spin text-muted-foreground/70',
            field ? 'mr-1 size-4' : 'size-3.5'
          )}
        />
      ) : value ? (
        <Tip label={t.ui.search.clear}>
          <Button
            aria-label={t.ui.search.clear}
            className="shrink-0 text-muted-foreground/85 hover:bg-accent/60 hover:text-foreground"
            onClick={clear}
            size="icon-xs"
            variant="ghost"
          >
            {/* The sidebar's chrome is Tabler; the inline field keeps the
                Codicon it shares with the pages and overlays it sits in. */}
            {field ? <X className="size-3.5" /> : <Codicon name="close" size="0.875rem" />}
          </Button>
        </Tip>
      ) : null}
    </>
  )

  if (field) {
    // A <label>, so the whole well is the target: a click on the glyph or the
    // padding lands in the input, while the clear button — interactive
    // content — keeps its own click. Border, recess, hover and the focus
    // outline come from the shared `desktop-input-chrome`, so the well wears
    // the look of every other text field in the app; the one addition is the
    // dark-mode fill in styles.css (`[data-slot='search-field']`).
    return (
      <label
        className={cn(
          'desktop-input-chrome group/search flex h-(--control-h-lg) w-full min-w-0 cursor-text items-center gap-2.5 rounded-(--radius-control) border pl-2.5 pr-1.5',
          containerClassName
        )}
        data-slot="search-field"
        data-variant="field"
      >
        <Search className="pointer-events-none size-4 shrink-0 text-(--ui-text-tertiary) group-focus-within/search:text-(--ui-text-secondary)" />
        {inputElement}
        {trailing}
      </label>
    )
  }

  return (
    <div
      className={cn(
        // min-w-0 is load-bearing: without it the content-sized input sets the
        // container's flex min-width and the field bulldozes its siblings
        // instead of shrinking to fit its context.
        'inline-flex min-w-0 max-w-full items-center gap-1.5 border-b border-transparent px-0.5 transition-[color,border-color,opacity]',
        // Recede until the user reaches for it.
        !value && 'opacity-30 focus-within:opacity-100',
        containerClassName
      )}
      data-slot="search-field"
      data-variant="inline"
    >
      <Search className="pointer-events-none size-3.5 shrink-0 text-muted-foreground/70" />
      {inputElement}
      {trailing}
    </div>
  )
}
