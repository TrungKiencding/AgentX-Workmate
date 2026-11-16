/**
 * Real screenshots for the messaging setup coach, captured from the live
 * platforms (Telegram Web, Discord Developer Portal) with a throwaway
 * "AgentX Test" bot. Tokens, IDs, names and avatars are masked or replaced
 * with sample values before they land in src/assets/messaging-guide/.
 *
 * Each coach step (`prepare`, a field key, …) maps to the shots that show
 * where that value comes from; steps without one render no figure.
 */
import { useState } from 'react'

import discordBotPermissions from '@/assets/messaging-guide/discord-bot-permissions.webp'
import discordDeveloperMode from '@/assets/messaging-guide/discord-developer-mode.webp'
import discordInviteUrl from '@/assets/messaging-guide/discord-invite-url.webp'
import discordMessageContentIntent from '@/assets/messaging-guide/discord-message-content-intent.webp'
import discordNewApplication from '@/assets/messaging-guide/discord-new-application.webp'
import discordResetTokenConfirm from '@/assets/messaging-guide/discord-reset-token-confirm.webp'
import discordResetToken from '@/assets/messaging-guide/discord-reset-token.webp'
import telegramBotfatherSearch from '@/assets/messaging-guide/telegram-botfather-search.webp'
import telegramBotfatherToken from '@/assets/messaging-guide/telegram-botfather-token.webp'
import telegramPairingCode from '@/assets/messaging-guide/telegram-pairing-code.webp'
import telegramUserinfobotId from '@/assets/messaging-guide/telegram-userinfobot-id.webp'
import workmateAllowRequest from '@/assets/messaging-guide/workmate-allow-request.webp'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { ChevronLeft, ChevronRight } from '@/lib/icons'

export const GUIDE_IMAGES = {
  'discord-bot-permissions': discordBotPermissions,
  'discord-developer-mode': discordDeveloperMode,
  'discord-invite-url': discordInviteUrl,
  'discord-message-content-intent': discordMessageContentIntent,
  'discord-new-application': discordNewApplication,
  'discord-reset-token': discordResetToken,
  'discord-reset-token-confirm': discordResetTokenConfirm,
  'telegram-botfather-search': telegramBotfatherSearch,
  'telegram-botfather-token': telegramBotfatherToken,
  'telegram-pairing-code': telegramPairingCode,
  'telegram-userinfobot-id': telegramUserinfobotId,
  'workmate-allow-request': workmateAllowRequest
} as const

export type GuideImageId = keyof typeof GUIDE_IMAGES

// platform → coach step id → shots, in the order a person meets them.
const STEP_FIGURES: Record<string, Record<string, GuideImageId[]>> = {
  discord: {
    prepare: [
      'discord-new-application',
      'discord-message-content-intent',
      'discord-bot-permissions',
      'discord-invite-url'
    ],
    DISCORD_BOT_TOKEN: ['discord-reset-token', 'discord-reset-token-confirm'],
    DISCORD_ALLOWED_USERS: ['discord-developer-mode'],
    test: ['workmate-allow-request']
  },
  slack: {
    test: ['workmate-allow-request']
  },
  telegram: {
    prepare: ['telegram-botfather-search', 'telegram-botfather-token'],
    TELEGRAM_BOT_TOKEN: ['telegram-botfather-token'],
    TELEGRAM_ALLOWED_USERS: ['telegram-userinfobot-id'],
    test: ['telegram-pairing-code', 'workmate-allow-request']
  }
}

export function guideFigureIds(platformId: string, stepId: null | string | undefined): GuideImageId[] {
  return (stepId && STEP_FIGURES[platformId]?.[stepId]) || []
}

/** One shot at a time with its caption; more than one gets back/next. */
export function GuideFigures({ ids }: { ids: GuideImageId[] }) {
  const { t } = useI18n()
  const copy = t.messaging.figures
  const [index, setIndex] = useState(0)
  const [enlarged, setEnlarged] = useState(false)

  if (ids.length === 0) {
    return null
  }

  const current = Math.min(index, ids.length - 1)
  const id = ids[current]
  const text = copy.items[id]

  return (
    <figure className="grid max-w-xl gap-2">
      {/* Shots are captured at 1x and up to 800px wide: shown no wider than
          the coach column, with a click-through to the natural size so small
          labels stay readable. */}
      <button
        aria-label={copy.enlarge}
        className="block w-fit max-w-full cursor-zoom-in rounded-(--radius-card)"
        onClick={() => setEnlarged(true)}
        type="button"
      >
        <img
          alt={text.alt}
          className="max-h-96 w-auto max-w-full rounded-(--radius-card) border border-(--ui-stroke-tertiary) bg-white object-contain"
          decoding="async"
          loading="lazy"
          src={GUIDE_IMAGES[id]}
        />
      </button>
      <Dialog onOpenChange={setEnlarged} open={enlarged}>
        <DialogContent className="p-3 pt-12" fitContent>
          <DialogTitle className="sr-only">{text.alt}</DialogTitle>
          {/* The shot sets the dialog's width and leaves room under it for
              the caption inside the dialog's 85vh cap (pt-12 + p-3 + up to
              three caption lines), so the caption never scrolls out of view. */}
          <img
            alt={text.alt}
            className="max-h-[min(78vh,calc(85vh-9rem))] max-w-full rounded-(--radius-card) bg-white object-contain"
            src={GUIDE_IMAGES[id]}
          />
          {/* w-0 + min-w-full: the caption wraps to the shot's width instead
              of widening the fit-content dialog past it. */}
          <p className="w-0 min-w-full px-1 pt-2 text-sm text-(--ui-text-secondary)">{text.caption}</p>
        </DialogContent>
      </Dialog>
      <figcaption className="flex flex-wrap items-start justify-between gap-2">
        <span className="min-w-0 flex-1 text-sm leading-relaxed text-(--ui-text-secondary)">{text.caption}</span>
        {ids.length > 1 && (
          <span className="flex shrink-0 items-center gap-1">
            <Button
              aria-label={copy.previous}
              disabled={current === 0}
              onClick={() => setIndex(current - 1)}
              size="icon-xs"
              variant="ghost"
            >
              <ChevronLeft aria-hidden className="rtl:rotate-180" />
            </Button>
            <span aria-live="polite" className="text-xs tabular-nums text-(--ui-text-tertiary)">
              {copy.position(current + 1, ids.length)}
            </span>
            <Button
              aria-label={copy.next}
              disabled={current === ids.length - 1}
              onClick={() => setIndex(current + 1)}
              size="icon-xs"
              variant="ghost"
            >
              <ChevronRight aria-hidden className="rtl:rotate-180" />
            </Button>
          </span>
        )}
      </figcaption>
    </figure>
  )
}
