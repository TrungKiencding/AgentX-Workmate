/** Assistant actions shared by the list's context menu and the detail's "⋯"
 *  menu, so both always offer the same verbs in the same order. */

import { haptic, host } from '@agentx/plugin-sdk'

import { openCanonicalChat } from './canonical-chat'
import type { BotsText } from './i18n'
import { botHandle, displayName, isPrimary, uniqueName } from './naming'
import { $botMeta, duplicateBot, markSeen, saveBotMeta } from './state'
import type { Bot } from './types'

/** "Message": the main assistant IS the app's ordinary chat, so it gets a
 *  new chat; any other assistant opens its one ongoing conversation
 *  (created empty on first use — the user's own words start it). */
export async function openBot(bot: Bot, b: BotsText): Promise<void> {
  haptic('tap')
  markSeen(bot)

  if (isPrimary(bot.name)) {
    host.newChat(bot.name)

    return
  }

  try {
    await openCanonicalChat(bot.name)
  } catch (error) {
    host.notifyError(error, b.openFailed)
  }
}

export interface BotMenuItem {
  destructive?: boolean
  id: string
  label: string
  onSelect: () => void
  separatorBefore?: boolean
}

export interface BotMenuHandlers {
  onDelete: (bot: Bot) => void
  onDuplicated: (name: string) => void
  onEdit: (bot: Bot) => void
  onGroup: (bot: Bot) => void
}

export function botMenuItems(bot: Bot, roster: readonly Bot[], b: BotsText, handlers: BotMenuHandlers): BotMenuItem[] {
  const meta = $botMeta.get()[bot.name]
  const label = displayName(bot, meta, b.primaryName)

  const items: BotMenuItem[] = [
    { id: 'edit', label: b.edit, onSelect: () => handlers.onEdit(bot) },
    {
      id: 'pin',
      label: meta?.pinned ? b.unpin : b.pin,
      onSelect: () => void saveBotMeta(bot.name, { pinned: !meta?.pinned })
    },
    {
      id: 'group',
      label: meta?.group ? b.changeGroup(meta.group) : b.moveToGroup,
      onSelect: () => handlers.onGroup(bot)
    },
    {
      id: 'new-chat',
      label: b.newChatWith,
      separatorBefore: true,
      onSelect: () => {
        markSeen(bot)
        host.newChat(bot.name)
      }
    },
    {
      id: 'duplicate',
      label: b.duplicate,
      onSelect: () => {
        const name = uniqueName(
          botHandle(bot.name),
          roster.map(row => row.name)
        )

        if (!name) {
          host.notify({ kind: 'error', message: b.duplicateFailed })

          return
        }

        host.notify({ kind: 'info', message: b.duplicating(label) })
        duplicateBot(bot, name, b.copySuffix)
          .then(() => {
            host.notify({ kind: 'success', message: b.duplicated(`${label} ${b.copySuffix}`) })
            handlers.onDuplicated(name)
          })
          .catch(error => host.notifyError(error, b.duplicateFailed))
      }
    }
  ]

  if (!isPrimary(bot.name)) {
    items.push({
      id: 'delete',
      label: b.delete,
      destructive: true,
      separatorBefore: true,
      onSelect: () => handlers.onDelete(bot)
    })
  }

  return items
}
