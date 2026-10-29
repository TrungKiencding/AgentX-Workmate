import { useEffect, useRef } from 'react'

import { CountSkeleton } from '@/components/ui/skeleton'
import { compactNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * Page tabs (Quiet Tool spec §5.18) — the page-level tab row: 13px text tabs
 * 20px apart, secondary ink, the current tab in primary ink over a 2px
 * underline, one --border-subtle divider under the whole row. No boxes, no
 * fills. A count sits beside a label as a tertiary caption.
 *
 * The underline is ONE element that slides to the active tab. It is placed by
 * a MutationObserver watching `data-active` (the same mechanism as
 * `CommandSelectionIndicator`), never by React state, so switching tabs moves
 * a transform and re-renders nothing else. `transform` is the only property
 * that animates; the bar's width snaps so no layout geometry is tweened.
 * Reduced motion collapses the slide to a jump through the global kill-switch.
 */
export interface PageTab {
  id: string
  label: string
  /** Count badge. `null` = still loading (skeleton); `undefined` = no badge. */
  meta?: number | string | null
}

function tabMeta(meta: number | string | null) {
  return meta === null ? <CountSkeleton /> : typeof meta === 'number' ? compactNumber(meta) : meta
}

function PageTabsIndicator() {
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

      const tab = list.querySelector<HTMLElement>('[data-slot="page-tab"][data-active="true"]')

      if (!tab) {
        node.style.opacity = '0'

        return
      }

      const listBox = list.getBoundingClientRect()
      const tabBox = tab.getBoundingClientRect()

      node.style.width = `${tabBox.width}px`
      node.style.transform = `translate3d(${tabBox.left - listBox.left}px, 0, 0)`
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
      className="pointer-events-none absolute bottom-[-1px] left-0 h-0.5 rounded-full bg-(--text-primary) opacity-0 transition-[transform,opacity] duration-(--dur-short) ease-(--ease-in-out)"
      data-slot="page-tabs-indicator"
      ref={ref}
    />
  )
}

export function PageTabs({
  className,
  onChange,
  tabs,
  value,
  ...props
}: Omit<React.ComponentProps<'div'>, 'onChange'> & {
  onChange: (id: string) => void
  tabs: readonly PageTab[]
  value: string
}) {
  return (
    <div
      className={cn(
        // The indicator is the FIRST child, so the relative tabs after it paint on top in DOM order.
        'relative inline-flex h-10 w-fit max-w-full items-stretch gap-5 border-b border-(--border-subtle)',
        className
      )}
      data-slot="page-tabs"
      role="tablist"
      {...props}
    >
      <PageTabsIndicator />
      {tabs.map(tab => {
        const active = tab.id === value

        return (
          <button
            aria-selected={active}
            className={cn(
              'relative inline-flex min-w-0 items-center gap-1.5 text-sm whitespace-nowrap transition-colors duration-(--dur-micro)',
              active ? 'text-(--text-primary)' : 'text-(--text-secondary) hover:text-(--text-primary)'
            )}
            data-active={active}
            data-slot="page-tab"
            key={tab.id}
            onClick={() => onChange(tab.id)}
            role="tab"
            type="button"
          >
            <span className="truncate">{tab.label}</span>
            {tab.meta !== undefined && (
              <span className={cn('text-xs tabular-nums', 'text-(--text-tertiary)')}>{tabMeta(tab.meta)}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
