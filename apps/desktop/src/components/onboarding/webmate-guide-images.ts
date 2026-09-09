/**
 * The screenshot shown beside the three install steps: the browser's own
 * extensions page with Developer mode on and the drop zone visible, in the
 * app's language when we have it. Captured from real browsers by
 * scripts/webmate-guide-shots.mjs into src/assets/webmate/.
 *
 * Missing combinations fall back: language → English, browser → Chrome (every
 * Chromium fork's page looks alike). Null only when nothing is bundled.
 */

import type { Locale } from '@/i18n'

const IMAGES: Partial<Record<string, string>> = {}

export function webmateGuideImage(browserId: string, locale: Locale): string | null {
  const lang = locale === 'vi' ? 'vi' : 'en'
  const candidates = [`${browserId}-${lang}`, `${browserId}-en`, `chrome-${lang}`, 'chrome-en']

  for (const key of candidates) {
    const image = IMAGES[key]

    if (image) {
      return image
    }
  }

  return null
}
