import { normalize } from '@/lib/text'

const SOURCE_LABELS: Record<string, string> = {
  a2a: 'A2A',
  api_server: 'API',
  bluebubbles: 'iMessage',
  cli: 'CLI',
  codex: 'Codex',
  desktop: 'Desktop',
  dingtalk: 'DingTalk',
  discord: 'Discord',
  email: 'Email',
  gateway: 'Gateway',
  google_chat: 'Google Chat',
  homeassistant: 'Home Assistant',
  irc: 'IRC',
  kanban: 'Kanban',
  line: 'LINE',
  local: 'Local',
  matrix: 'Matrix',
  mattermost: 'Mattermost',
  msgraph_webhook: 'Microsoft Graph',
  ntfy: 'ntfy',
  photon: 'Photon',
  qqbot: 'QQ',
  signal: 'Signal',
  simplex: 'SimpleX',
  slack: 'Slack',
  sms: 'SMS',
  teams: 'Microsoft Teams',
  telegram: 'Telegram',
  tui: 'TUI',
  webhook: 'Webhook',
  wecom: 'WeCom',
  wecom_callback: 'WeCom (app)',
  weixin: 'WeChat',
  whatsapp: 'WhatsApp',
  whatsapp_cloud: 'WhatsApp Cloud',
  yuanbao: 'Yuanbao'
}

const SOURCE_ALIASES: Record<string, string[]> = {
  bluebubbles: ['apple messages', 'imessage'],
  photon: ['imessage', 'messages'],
  cli: ['terminal'],
  desktop: ['app', 'gui'],
  local: ['machine'],
  qqbot: ['qq'],
  telegram: ['tg'],
  tui: ['terminal'],
  weixin: ['wechat'],
  whatsapp: ['wa']
}

// Sources that run on the local machine rather than an external messaging
// platform. A handoff *from* one of these isn't a platform origin worth a badge.
// Exported so the recents fetch can keep these in the main list while the
// messaging fetch excludes them.
export const LOCAL_SESSION_SOURCE_IDS = ['cli', 'codex', 'desktop', 'gateway', 'kanban', 'local', 'tui']
const LOCAL_SOURCE_IDS = new Set(LOCAL_SESSION_SOURCE_IDS)

// External messaging platforms that each get their own self-managed sidebar
// section (fetched separately from local recents) and a read-only transcript.
// Must match MESSAGING_SESSION_SOURCE_VALUES in gateway/config.py (every
// gateway Platform except local, plus every bundled plugin platform);
// tests/gateway/test_messaging_session_sources.py parses this array, so keep it
// one single-quoted id per line. New ids also want a SOURCE_LABELS entry above
// and, when a glyph exists, a PLATFORM_ICONS entry in
// app/messaging/platform-icon.tsx (without one the avatar is a letter).
export const MESSAGING_SESSION_SOURCE_IDS = [
  'telegram',
  'discord',
  'slack',
  'mattermost',
  'matrix',
  'signal',
  'whatsapp',
  'bluebubbles',
  'photon',
  'homeassistant',
  'email',
  'sms',
  'webhook',
  'api_server',
  'weixin',
  'wecom',
  'qqbot',
  'yuanbao',
  'dingtalk',
  'feishu',
  'whatsapp_cloud',
  'msgraph_webhook',
  'wecom_callback',
  'relay',
  'a2a',
  'buzz',
  'google_chat',
  'irc',
  'line',
  'ntfy',
  'raft',
  'simplex',
  'teams'
]
const MESSAGING_SOURCE_IDS = new Set(MESSAGING_SESSION_SOURCE_IDS)

/** True when a source id is an external messaging platform (gets its own
 *  sidebar section) rather than a local/CLI/desktop session. */
export function isMessagingSource(source: null | string | undefined): boolean {
  const id = normalizeSessionSource(source)

  return id != null && MESSAGING_SOURCE_IDS.has(id)
}

export function normalizeSessionSource(source: null | string | undefined): string | null {
  return normalize(source) || null
}

/**
 * Resolve the origin messaging platform for a handed-off session. Returns the
 * normalized platform id (e.g. 'telegram') when the session completed a handoff
 * from a real messaging platform, otherwise null. After a handoff the live
 * source is local, so this is what drives the row's origin-platform badge.
 */
export function handoffOriginSource(
  handoffState: null | string | undefined,
  handoffPlatform: null | string | undefined
): string | null {
  if (handoffState !== 'completed') {
    return null
  }

  const id = normalizeSessionSource(handoffPlatform)

  if (!id || LOCAL_SOURCE_IDS.has(id)) {
    return null
  }

  return id
}

export function sessionSourceLabel(source: null | string | undefined): string | null {
  const id = normalizeSessionSource(source)

  if (!id) {
    return null
  }

  return SOURCE_LABELS[id] || id.replace(/[_-]+/g, ' ').replace(/\b\w/g, char => char.toUpperCase())
}

export function sessionSourceSearchTerms(source: null | string | undefined): string[] {
  const id = normalizeSessionSource(source)
  const label = sessionSourceLabel(id)

  if (!id) {
    return []
  }

  return [id, label ?? '', ...(SOURCE_ALIASES[id] ?? [])].filter(Boolean)
}
