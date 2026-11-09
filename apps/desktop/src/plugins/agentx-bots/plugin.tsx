/**
 * Bot Mode — "Trợ lý": named assistants, each an AgentX profile with its own
 * picture, memory, skills, scheduled tasks and ONE ongoing conversation.
 *
 * Surfaces (all from this plugin, no core view edits):
 *  - a Work / Assistants switch in the title bar → the `/bots` page;
 *  - a title-bar chip naming the assistant you're chatting with;
 *  - ⌘K commands to open the page or create an assistant;
 *  - composer middleware: "@writer …" in any chat hands the request to that
 *    assistant, and "/new" in an assistant's main conversation compacts it
 *    instead of forking it.
 *
 * How assistants message each other is taught by the backend inside each
 * main conversation (tools/bot_mode_protocol.py) — this plugin never edits a
 * profile's SOUL.md behind the user's back.
 */

import './bots.css'

import {
  COMPOSER_AREAS,
  type ComposerMiddleware,
  type HermesPlugin,
  host,
  PALETTE_AREA,
  type PaletteContribution,
  type RouteContribution,
  ROUTES_AREA,
  TITLEBAR_AREAS
} from '@agentx/plugin-sdk'

import { ChatIdentity } from './chat-identity'
import { BOTS_LOCALES, botsText } from './i18n'
import { isResetCommand, withHandoff } from './mention'
import { displayName } from './naming'
import { $createRequest, BotsPage } from './page'
import { $botMeta, bindStorage, PLUGIN_ID } from './state'
import type { Bot } from './types'
import { WorkspaceSwitcher } from './workspace-switcher'

export const BOTS_ROUTE = '/bots'

const plugin: HermesPlugin = {
  id: PLUGIN_ID,
  name: 'Bot Mode',
  register(ctx) {
    ctx.i18n.register(BOTS_LOCALES)
    bindStorage(ctx.storage)

    const b = () => botsText(ctx.i18n.t)

    const middleware: ComposerMiddleware = {
      handler: async draft => {
        const text = draft.text || ''
        const active = (host.state.profile.get() || 'default').trim() || 'default'

        // The assistant's main conversation goes on forever: /new would fork
        // it, so it becomes /compact (same fresh context, same conversation).
        if (isResetCommand(text)) {
          const pinned = $botMeta.get()[active]?.chat
          const current = host.state.storedSessionId.get()

          if (pinned && current && pinned === current) {
            host.notify({ kind: 'info', title: b().neverResetTitle, message: b().neverResetBody })

            return { ...draft, text: '/compact' }
          }

          return draft
        }

        if (!/(^|\s)@[a-z0-9]/i.test(text)) {
          return draft
        }

        let names: string[] = []

        try {
          const res = await host.requestPrimary<{ profiles?: Bot[] }>('profiles.list', { include_sessions: false })
          names = (res?.profiles ?? []).map(profile => profile.name)
        } catch {
          return draft
        }

        const sender = displayName({ name: active }, $botMeta.get()[active], b().primaryName)
        const rewritten = withHandoff(text, names, active, sender)

        return rewritten === null ? draft : { ...draft, text: rewritten }
      }
    }

    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: BOTS_ROUTE } satisfies RouteContribution,
        render: () => <BotsPage />
      },
      {
        id: 'workspace-switcher',
        area: TITLEBAR_AREAS.left,
        render: () => <WorkspaceSwitcher />
      },
      {
        id: 'chat-identity',
        area: TITLEBAR_AREAS.center,
        render: () => <ChatIdentity />
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: `${PLUGIN_ID}.open`,
          label: b().paletteOpen,
          keywords: ['bot', 'bots', 'assistant', 'agent', 'trợ lý', 'tro ly'],
          run: () => host.navigate(BOTS_ROUTE)
        } satisfies PaletteContribution
      },
      {
        id: 'new',
        area: PALETTE_AREA,
        data: {
          id: `${PLUGIN_ID}.new`,
          label: b().paletteNew,
          keywords: ['bot', 'assistant', 'agent', 'profile', 'create', 'new', 'tạo', 'trợ lý', 'tro ly'],
          run: () => {
            host.navigate(BOTS_ROUTE)
            $createRequest.set($createRequest.get() + 1)
          }
        } satisfies PaletteContribution
      },
      {
        id: 'mention-middleware',
        area: COMPOSER_AREAS.middleware,
        data: middleware
      }
    ])

    ctx.onDispose(() => bindStorage(null))
  }
}

export default plugin
