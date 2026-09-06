import { useEffect, useRef } from 'react'

import { CountSkeleton } from '@/components/ui/skeleton'
import { compactNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * A row of pill tabs — the page-level tab control for people who read a tab
 * bar the way an app store draws one: a soft track, one raised pill on the
 * current tab, a count beside the label.
 *
 * The highlight is ONE element that slides to the active tab. It is placed by
 * a MutationObserver watching `data-active` (the same mechanism as
 * `CommandSelectionIndicator`), never by React state, so switching tabs moves
 * a transform and re-renders nothing else. `transform` is the only property
 * that animates; the pill's size snaps so no layout geometry is tweened.
 * Reduced motion collapses the slide to a jump through the global kill-switch.
 *
 * 32px track (`--control-h-md`), 13px medium labels, 12px tabular counts.
 */
export interface PillTab {
  id: string
  label: string
  /** Count badge. `null` = still loading (skeleton); `undefined` = no badge. */
  meta?: number | string | null
}

function pillMeta(meta: number | string | null) {
  return meta === null ? <CountSkeleton /> : typeof meta === 'number' ? compactNumber(meta) : meta
}

function PillTabsIndicator() {
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const node = ref.current
    const list = node?.parentElement

    if (!node || !list) {
      return
    }

    let frame = 0

    const place = () => {
      frame = 0

      const tab = list.querySelector<HTMLElement>('[data-slot="pill-tab"][data-active="true"]')

      if (!tab) {
        node.style.opacity = '0'

        return
      }

      const listBox = list.getBoundingClientRect()
      const tabBox = tab.getBoundingClientRect()

      node.style.height = `${tabBox.height}px`
      node.style.width = `${tabBox.width}px`
      node.style.transform = `translate3d(${tabBox.left - listBox.left}px, ${tabBox.top - listBox.top}px, 0)`
      node.style.opacity = '1'
    }

    const schedule = () => {
      frame ||= requestAnimationFrame(place)
    }

    place()

    const observer = new MutationObserver(schedule)
    observer.observe(list, { attributeFilter: ['data-active'], attributes: true, childList: true, subtree: true })

    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    resize?.observe(list)

    return () => {
      observer.disconnect()
      resize?.disconnect()

      if (frame) {
        cancelAnimationFrame(frame)
      }
    }
  }, [])

  return (
    <span
      aria-hidden
      className="pointer-events-none absolute left-0 top-0 rounded-full bg-background opacity-0 shadow-xs transition-[transform,opacity] duration-(--dur-short-exit) ease-out"
      data-slot="pill-tabs-indicator"
      ref={ref}
    />
  )
}

export function PillTabs({
  className,
  onChange,
  tabs,
  value,
  ...props
}: Omit<React.ComponentProps<'div'>, 'onChange'> & {
  onChange: (id: string) => void
  tabs: readonly PillTab[]
  value: string
}) {
  return (
    <div
      className={cn(
        // The indicator is the FIRST child, so the relative tabs after it paint on top in DOM order.
        'relative inline-flex h-(--control-h-md) w-fit max-w-full items-center gap-0.5 rounded-full bg-(--ui-bg-tertiary) p-0.5',
        className
      )}
      data-slot="pill-tabs"
      role="tablist"
      {...props}
    >
      <PillTabsIndicator />
      {tabs.map(tab => {
        const active = tab.id === value

        return (
          <button
            aria-selected={active}
            className={cn(
              'relative inline-flex h-full min-w-0 cursor-pointer items-center gap-1.5 rounded-full px-3 text-sm font-medium whitespace-nowrap transition-colors duration-(--dur-micro)',
              active ? 'text-foreground' : 'text-(--ui-text-secondary) hover:text-foreground'
            )}
            data-active={active}
            data-slot="pill-tab"
            key={tab.id}
            onClick={() => onChange(tab.id)}
            role="tab"
            type="button"
          >
            <span className="truncate">{tab.label}</span>
            {tab.meta !== undefined && (
              <span
                className={cn(
                  'text-xs tabular-nums',
                  active ? 'text-(--ui-text-secondary)' : 'text-(--ui-text-tertiary)'
                )}
              >
                {pillMeta(tab.meta)}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
