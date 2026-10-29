import { Dialog as DialogPrimitive } from 'radix-ui'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { DialogPortalContainerContext } from '@/components/ui/dialog-portal-context'
import { useI18n } from '@/i18n'
import { X } from '@/lib/icons'
import { cn } from '@/lib/utils'

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        'fixed inset-0 z-(--z-modal-backdrop) pointer-events-auto bg-(--scrim) duration-(--dur-long) data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-(--dur-long-exit) data-[state=open]:animate-in data-[state=open]:fade-in-0',
        className
      )}
      data-slot="dialog-overlay"
      {...props}
    />
  )
}

type DialogBannerTone = 'error' | 'warn' | 'info'

// Tinted, edge-to-edge bottom banner per tone. Error/warn keep their semantic
// destructive/primary tokens; info derives from the dialog's own bubble
// background so it reads as part of the themed dialog — lifted 30% toward white
// in light mode, deepened 20% toward black in dark mode.
const DIALOG_BANNER_TONES: Record<DialogBannerTone, string> = {
  error: 'bg-(--danger-bg) text-(--danger)',
  warn: 'bg-(--warning-bg) text-(--warning)',
  info: 'bg-(--bg-subtle) text-(--text-secondary)'
}

// Radix focuses the first focusable element inside Dialog.Content on open. In
// most dialogs that's a real input and the default autofocus is exactly what
// we want, so it's opt-in rather than a shared default here. In dialogs with
// no input (e.g. the updates overlay's idle/error views), the first focusable
// element ends up being the close button, and since Tip shows on focus as well
// as hover, that autofocus makes the "Close" tip appear immediately with no
// pointer ever near the button. Dialogs like that should pass this in
// explicitly as `onOpenAutoFocus={preventCloseButtonAutoFocus}`.
export function preventCloseButtonAutoFocus(event: Event) {
  event.preventDefault()
}

// The other answer to the same problem, for a dialog whose first focusable is
// a control with a tooltip (a row of chips, a switch): keep focus INSIDE the
// dialog — on the content itself, which Radix makes focusable with
// tabIndex -1, so no focus ring paints — instead of leaving it on the trigger
// behind the overlay. The first Tab then lands on the first control, as a
// keyboard person expects. Pass as `onOpenAutoFocus={focusDialogContent}`.
export function focusDialogContent(event: Event) {
  event.preventDefault()
  ;(event.currentTarget as HTMLElement | null)?.focus({ preventScroll: true })
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  fitContent = false,
  banner,
  bannerTone = 'error',
  onOpenAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  // Size the dialog to its content (capped at the viewport) instead of the
  // default fixed `max-w-lg`. For content that has no intrinsic width (grids,
  // full-width inputs) pair it with a `min-w-*` in `className`.
  fitContent?: boolean
  // A dialog-level notice rendered as a banner flush to the bottom edge (tinted,
  // inherited bottom radius) so it reads as part of the dialog, not a floating
  // alert. Falsy → no banner. Tone picks the colour.
  banner?: React.ReactNode
  bannerTone?: DialogBannerTone
}) {
  const { t } = useI18n()

  // Spec §5.17 widths: 440 confirm · 560 form (the default) · 720 content.
  const widthClass = fitContent ? 'w-auto max-w-[92vw]' : 'w-full max-w-[min(35rem,calc(100vw-2rem))]'

  // Publish the dialog's content node so popovers (Select / Popover /
  // DropdownMenu) opened inside it portal INTO the dialog instead of
  // document.body. That keeps them as DOM descendants — focus never leaves the
  // dialog, so dismissing a dropdown (or clicking another field) no longer
  // trips the Dialog's outside-interaction/focus-out close. See
  // dialog-portal-context.ts. State (not just a ref) so consumers re-render once
  // the node mounts.
  const [contentNode, setContentNode] = React.useState<HTMLElement | null>(null)

  // No default here — Radix's normal autofocus (first focusable element, often
  // an input) is what most dialogs want. Dialogs with no input should pass
  // `onOpenAutoFocus={preventCloseButtonAutoFocus}` explicitly instead.

  // No tip on the X — the glyph is the label. Keep aria-label / sr-only for a11y.
  const closeButton = showCloseButton ? (
    <DialogPrimitive.Close asChild data-slot="dialog-close-button">
      <Button
        aria-label={t.common.close}
        className="absolute right-4 top-4 z-20 text-(--icon-muted) hover:text-(--text-primary)"
        size="icon-sm"
        variant="ghost"
      >
        <X className="size-4" />
        <span className="sr-only">{t.common.close}</span>
      </Button>
    </DialogPrimitive.Close>
  ) : null

  // With a banner, the border can't live on the scroll/clip box (it would draw a
  // line around the banner too). The white body keeps its own bottom radius and
  // sits over the tinted footer; the outer shell only clips the banner to the
  // dialog's rounded bottom edge.
  if (banner) {
    return (
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-(--z-modal) pointer-events-auto flex max-h-[85vh] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl bg-(--bg-raised) text-base text-(--text-primary) shadow-nous duration-(--dur-long) data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-98 data-[state=closed]:duration-(--dur-long-exit) data-[state=closed]:ease-(--ease-in) data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-98 data-[state=open]:ease-(--ease-out)',
            widthClass,
            className,
            // Callers often pass `gap-*` for the no-banner grid layout — suppress
            // it here so the banner can tuck under the body's rounded bottom edge.
            'gap-0'
          )}
          data-slot="dialog-content"
          onOpenAutoFocus={onOpenAutoFocus}
          ref={setContentNode}
          {...props}
        >
          <DialogPortalContainerContext.Provider value={contentNode}>
            {/* Scroll lives on an inner box so this shell keeps a painted bottom radius. */}
            <div className="relative z-10 overflow-hidden bg-(--bg-raised)">
              <div className="grid max-h-[calc(85vh-5rem)] min-h-0 gap-4 overflow-y-auto overscroll-contain p-6">{children}</div>
            </div>
            <div
              className={cn(
                // Overlap by one corner radius so the white bottom lobes read clearly
                // over the tint instead of meeting it on a straight seam.
                'relative z-0 px-6 py-2.5 text-sm text-pretty',
                DIALOG_BANNER_TONES[bannerTone]
              )}
              data-slot="dialog-banner"
              role={bannerTone === 'error' ? 'alert' : 'status'}
            >
              {banner}
            </div>
            {closeButton}
          </DialogPortalContainerContext.Provider>
        </DialogPrimitive.Content>
      </DialogPortal>
    )
  }

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          // Cap height at 85vh and let long content scroll inside the dialog
          // instead of overflowing off-screen (long cron titles, tool detail
          // dumps, etc.). Individual dialogs can still override via className.
          'fixed left-1/2 top-1/2 z-(--z-modal) pointer-events-auto grid max-h-[85vh] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto overscroll-contain rounded-xl bg-(--bg-raised) p-6 text-base text-(--text-primary) shadow-nous duration-(--dur-long) data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-98 data-[state=closed]:duration-(--dur-long-exit) data-[state=closed]:ease-(--ease-in) data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-98 data-[state=open]:ease-(--ease-out)',
          widthClass,
          className
        )}
        data-slot="dialog-content"
        onOpenAutoFocus={onOpenAutoFocus}
        ref={setContentNode}
        {...props}
      >
        <DialogPortalContainerContext.Provider value={contentNode}>
          {children}
          {closeButton}
        </DialogPortalContainerContext.Provider>
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex flex-col gap-1.5 pr-8 text-left', className)}
      data-slot="dialog-header"
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end', className)}
      data-slot="dialog-footer"
      {...props}
    />
  )
}

function DialogTitle({
  className,
  icon: Icon,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title> & {
  // Pass an icon (from `@/lib/icons`) to get the canonical dialog-header glyph: a plain
  // primary-tinted icon inline with the title (no bg chip / ring). This is the
  // single source of truth for dialog header icons — don't hand-roll wrappers.
  icon?: React.ComponentType<{ className?: string }>
}) {
  return (
    <DialogPrimitive.Title
      className={cn(
        // A dialog names itself at the ramp's section-title rung (18px), one
        // step under a full page title — a dialog is a task, not a page.
        'text-lg font-semibold text-balance text-(--text-primary)',
        Icon && 'flex items-center gap-2',
        className
      )}
      data-slot="dialog-title"
      {...props}
    >
      {Icon ? <Icon className="size-4.5 shrink-0 text-(--icon-default)" /> : null}
      {children}
    </DialogPrimitive.Title>
  )
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn('text-base text-pretty text-(--text-secondary)', className)}
      data-slot="dialog-description"
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger
}
