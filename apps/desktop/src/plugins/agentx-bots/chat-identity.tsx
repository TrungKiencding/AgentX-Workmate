/**
 * "Who am I talking to?" — a small chip centred in the title bar while the
 * chat belongs to an assistant: its face and name, plus "Main conversation"
 * in its ongoing chat. Click → that assistant on the Trợ lý page.
 *
 * Silent for the main AgentX's ordinary chats, so someone who never creates
 * an assistant sees no change at all.
 */

import { cn, host, useValue } from '@agentx/plugin-sdk'
import { useSyncExternalStore } from 'react'

import { BotAvatar } from './face'
import { useBots } from './i18n'
import { displayName, isPrimary } from './naming'
import { $selection } from './page'
import { $botMeta } from './state'

const subscribeHash = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange)

  return () => window.removeEventListener('hashchange', onChange)
}

const readHash = () => window.location.hash

/** True on the chat surface: a fresh draft (`#/`) or a stored session route. */
export function isChatRoute(hash: string, storedSessionId: string | null): boolean {
  const path = hash.replace(/^#/, '').split('?')[0] || '/'

  return path === '/' || Boolean(storedSessionId && path === `/${storedSessionId}`)
}

export function ChatIdentity() {
  const b = useBots()
  const hash = useSyncExternalStore(subscribeHash, readHash, () => '')
  const profile = (useValue(host.state.profile) || 'default').trim() || 'default'
  const stored = useValue(host.state.storedSessionId)
  const meta = useValue($botMeta)[profile]
  const main = Boolean(stored && meta?.chat === stored)

  if (!isChatRoute(hash, stored) || (isPrimary(profile) && !main)) {
    return null
  }

  return (
    <button
      className={cn(
        'flex h-6 max-w-[22rem] items-center gap-1.5 rounded-full px-2 text-xs text-(--text-secondary)',
        'transition-colors duration-(--dur-micro) hover:bg-(--bg-hover) hover:text-(--text-primary)'
      )}
      onClick={() => {
        $selection.set({ kind: 'bot', name: profile })
        host.navigate('/bots')
      }}
      type="button"
    >
      <BotAvatar meta={meta} name={profile} size={16} />
      <span className="truncate font-medium text-(--text-primary)">
        {displayName({ name: profile }, meta, b.primaryName)}
      </span>
      {main ? <span className="shrink-0 text-(--text-tertiary)">· {b.mainChat}</span> : null}
    </button>
  )
}
