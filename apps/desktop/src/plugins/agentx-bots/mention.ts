/**
 * Composer middleware logic (pure, unit-tested):
 *  - "@writer draft the post" in ANY chat becomes a handoff instruction the
 *    active agent executes with one background terminal call into that
 *    teammate's "Bot Chat";
 *  - "/new" inside an assistant's main conversation becomes "/compact" —
 *    that conversation is meant to go on forever.
 */

import { HANDOFF_NOTE_MARKER } from '@agentx/plugin-sdk'

import { BOT_CHAT_TITLE, botHandle, profileForHandle } from './naming'

/** Single-quote for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

/** Escape for interpolation INSIDE a double-quoted shell string. */
export function shellDoubleQuote(value: string): string {
  return String(value).replace(/[\\"`$]/g, ch => `\\${ch}`)
}

/** Profiles mentioned in prose (code spans/blocks don't count), excluding
 *  the active one, in order of first mention. */
export function mentionedProfiles(text: string, names: readonly string[], active: string): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')
  const out: string[] = []

  for (const match of prose.matchAll(/(^|\s)@([a-z0-9][a-z0-9_-]*)/gi)) {
    const name = profileForHandle(match[2], names)

    if (name && name !== active && !out.includes(name)) {
      out.push(name)
    }
  }

  return out
}

/** The draft with the handoff instruction appended, or null when nothing to do. */
export function withHandoff(text: string, names: readonly string[], active: string, senderName: string): string | null {
  if (!/(^|\s)@[a-z0-9]/i.test(text)) {
    return null
  }

  const mentioned = mentionedProfiles(text, names, active)

  if (!mentioned.length) {
    return null
  }

  const sender = shellDoubleQuote(senderName)
  const handle = shellDoubleQuote(botHandle(active))

  const commands = mentioned.map(
    name =>
      `\`agentx -p ${shellQuote(name)} chat --in ~ -c "${BOT_CHAT_TITLE}" -Q -q "Message from 🤖 ${sender} (@${handle}): <your composed message>"\``
  )

  return (
    text +
    HANDOFF_NOTE_MARKER +
    'for each mentioned agent (' +
    mentioned.map(name => `@${botHandle(name)}`).join(', ') +
    `): COMPOSE a message from you (${senderName}) to that agent conveying what the user wants — do not forward this text verbatim (avoid double quotes in your composed message). ` +
    'Send it with exactly one terminal call, run with background=true AND notify_on_complete=true (the recipient may take minutes; the user must not be blocked):\n' +
    commands.join('\n') +
    '\nAfter dispatching, tell the user the message was sent and END YOUR TURN — do not wait or poll; when the background process completes, its notification carries the reply — relay it then, attributed to that agent.]'
  )
}

/** "/new" or "/reset" typed into the assistant's main conversation. */
export function isResetCommand(text: string): boolean {
  return /^\/(new|reset)\s*$/.test(text.trim())
}
