/**
 * The frame every view of the updates dialog sits in: a header, a body that
 * scrolls, and a footer that stays on screen.
 *
 * The dialog is capped at 85% of the window. Release notes are as long as the
 * release, so on a short window they used to push the Download and Restart
 * buttons below the cap, where nothing could scroll to them. Here only the
 * body gives up height: the header and the actions keep theirs, and the whole
 * dialog scrolls only on a window too short to hold even those.
 *
 * Pair it with UPDATE_DIALOG_CONTENT_CLASS on the DialogContent, which makes
 * the dialog a column this frame can fill.
 *
 * A short window (the 620pt minimum at a 125–150% UI scale is 410–500px) also
 * tightens the spacing and the header's mark (UPDATE_DIALOG_MARK_CLASS), so the
 * notes keep a few lines instead of a sliver.
 */
export const UPDATE_DIALOG_CONTENT_CLASS = 'flex max-w-[min(24rem,calc(100vw-2rem))] flex-col gap-0 overflow-y-auto p-0'

// The short-window variant is spelled out in full in each class string below:
// Tailwind finds classes by scanning source text, so one built from a template
// would never be generated.

/** The header's brand mark: smaller on a short window. */
export const UPDATE_DIALOG_MARK_CLASS = 'size-16 [@media(max-height:34rem)]:size-10'

export function UpdateDialogLayout({
  body,
  bodyLabel,
  footer,
  header
}: {
  body?: React.ReactNode
  /** Names the scrolling body for screen readers and keyboard users. */
  bodyLabel?: string
  /** The actions: always on screen. */
  footer: React.ReactNode
  header: React.ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-slot="update-dialog">
      <div className="shrink-0 px-6 pr-8 pt-7 [@media(max-height:34rem)]:pt-5">{header}</div>

      {body ? (
        // Focusable so the notes can be scrolled from the keyboard too. The
        // app's keyboard ring is drawn outside the element, where the dialog's
        // edges would clip it, so this one is drawn inside.
        <div
          aria-label={bodyLabel}
          className="mt-5 min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pr-8 [@media(max-height:34rem)]:mt-3"
          data-slot="update-dialog-body"
          role="region"
          style={{ outlineOffset: '-2px' }}
          tabIndex={0}
        >
          {body}
        </div>
      ) : null}

      <div
        className="shrink-0 px-6 pb-6 pr-8 pt-5 [@media(max-height:34rem)]:pb-5 [@media(max-height:34rem)]:pt-3"
        data-slot="update-dialog-footer"
      >
        {footer}
      </div>
    </div>
  )
}
