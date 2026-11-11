import type { Translations } from '@/i18n'

/**
 * A theme's one-line description in the app's language.
 *
 * Built-in themes describe themselves in English in `presets.ts`; the catalog
 * carries the translations (`settings.appearance.themeDescriptions`, keyed by
 * theme name). Shown raw, a Chinese or Vietnamese Appearance page read
 * "Warm neutral grays — colour only as a signal" under every card (pilot
 * feedback 2026-11-10). A theme the catalog does not know — a user's own, one
 * installed from VS Code — keeps the description it came with.
 *
 * Theme *names* ("Night Owl", "Ember") are proper names and are not translated.
 */
export function themeDescription(
  theme: { description?: string; name: string },
  t: Pick<Translations, 'settings'>
): string {
  return t.settings.appearance.themeDescriptions[theme.name] ?? theme.description ?? ''
}
