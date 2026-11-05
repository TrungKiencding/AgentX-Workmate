/** Test helpers: a translator backed by the real locale bundles. */

import type { PluginTranslate } from '@agentx/plugin-sdk'

import { BOTS_LOCALES, botsText, type BotsText } from './i18n'
import type { Bot } from './types'

export function translatorFor(locale: 'en' | 'vi'): PluginTranslate {
  return (key, ...args) => {
    const value = key
      .split('.')
      .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], BOTS_LOCALES[locale])

    return typeof value === 'function' ? (value as (...a: unknown[]) => string)(...args) : String(value ?? key)
  }
}

export const textFor = (locale: 'en' | 'vi'): BotsText => botsText(translatorFor(locale))

export function bot(name: string, patch: Partial<Bot> = {}): Bot {
  return { name, is_default: name === 'default', ...patch }
}
