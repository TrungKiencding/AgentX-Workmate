/**
 * The screenshot shown beside the three install steps: the browser's own
 * extensions page with Developer mode on and "Load unpacked" visible, in the
 * app's language when we have it. Captured from real browsers by
 * scripts/webmate-guide-shots.mjs (+ webmate-guide-shots-pack.py) into
 * src/assets/webmate/.
 *
 * Missing combinations fall back: language → English, browser → Chrome (every
 * Chromium fork's page looks alike; Edge has its own and ships its own shot).
 */

import chromeEn from '@/assets/webmate/chrome-en.webp'
import chromeVi from '@/assets/webmate/chrome-vi.webp'
import edgeEn from '@/assets/webmate/edge-en.webp'
import edgeVi from '@/assets/webmate/edge-vi.webp'
import type { Locale } from '@/i18n'

const IMAGES: Partial<Record<string, string>> = {
  'chrome-en': chromeEn,
  'chrome-vi': chromeVi,
  'edge-en': edgeEn,
  'edge-vi': edgeVi
}

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
