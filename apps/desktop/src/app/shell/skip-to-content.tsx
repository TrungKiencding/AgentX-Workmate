import { useI18n } from '@/i18n'

// Where "skip to content" lands, in order of preference: the open transcript,
// then a page's own main landmark, then the composer.
const CONTENT_TARGETS = ['[data-slot="aui_thread-viewport"]', 'main', '[data-slot="composer-rich-input"]']

function focusContent() {
  for (const selector of CONTENT_TARGETS) {
    const target = document.querySelector<HTMLElement>(selector)

    if (target) {
      if (!target.hasAttribute('tabindex') && !target.isContentEditable) {
        // Programmatic focus only — never a tab stop of its own.
        target.setAttribute('tabindex', '-1')
      }

      target.focus({ preventScroll: true })

      return
    }
  }
}

/**
 * "Bỏ qua đến nội dung" (Quiet Tool spec §8.2): the first focusable element in
 * the window, invisible until keyboard focus lands on it, so a keyboard user
 * can jump past the sidebar's navigation straight to the work. A button, not
 * an `href="#…"` link — the app routes on the hash.
 */
export function SkipToContent() {
  const { t } = useI18n()

  return (
    <button
      className="sr-only z-(--z-over-modal-content) rounded-(--radius-control) bg-(--bg-inverse) px-3 py-1.5 text-base text-(--text-inverse) focus-visible:not-sr-only focus-visible:fixed focus-visible:left-3 focus-visible:top-3"
      data-slot="skip-to-content"
      onClick={focusContent}
      type="button"
    >
      {t.shell.skipToContent}
    </button>
  )
}
