import { describe, expect, it } from 'vitest'

import { ar } from '@/i18n/ar'
import { en } from '@/i18n/en'
import { ja } from '@/i18n/ja'
import type { Translations } from '@/i18n/types'
import { vi } from '@/i18n/vi'
import { zh } from '@/i18n/zh'
import { zhHant } from '@/i18n/zh-hant'

import { GUIDE_IMAGES, guideFigureIds, type GuideImageId } from './guide-figures'

const LOCALES: Record<string, Translations> = { ar, en, ja, vi, zh, 'zh-hant': zhHant }

describe('messaging guide figures', () => {
  it('maps each coach step to the screenshots that show where its value comes from', () => {
    expect(guideFigureIds('telegram', 'prepare')).toEqual(['telegram-botfather-search', 'telegram-botfather-token'])
    expect(guideFigureIds('telegram', 'TELEGRAM_ALLOWED_USERS')).toEqual(['telegram-userinfobot-id'])
    expect(guideFigureIds('discord', 'DISCORD_BOT_TOKEN')).toEqual([
      'discord-reset-token',
      'discord-reset-token-confirm'
    ])
    // "Send a test message" shows the pairing code and the in-app Allow.
    expect(guideFigureIds('telegram', 'test')).toEqual(['telegram-pairing-code', 'workmate-allow-request'])
    expect(guideFigureIds('slack', 'test')).toEqual(['workmate-allow-request'])
    // Steps and platforms without a capture render nothing.
    expect(guideFigureIds('telegram', 'TELEGRAM_PROXY')).toEqual([])
    expect(guideFigureIds('teams', 'prepare')).toEqual([])
    expect(guideFigureIds('telegram', null)).toEqual([])
  })

  it('ships every mapped screenshot', () => {
    for (const platform of ['telegram', 'discord']) {
      for (const step of ['prepare', 'test', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USERS', 'DISCORD_BOT_TOKEN']) {
        for (const id of guideFigureIds(platform, step)) {
          expect(GUIDE_IMAGES[id]).toMatch(/\.webp/)
        }
      }
    }
  })

  it('describes every screenshot in every shipped language', () => {
    for (const [locale, t] of Object.entries(LOCALES)) {
      for (const id of Object.keys(GUIDE_IMAGES) as GuideImageId[]) {
        const text = t.messaging.figures.items[id]

        expect(text?.alt, `${locale}:${id} alt`).toBeTruthy()
        expect(text?.caption, `${locale}:${id} caption`).toBeTruthy()
      }
    }
  })
})
