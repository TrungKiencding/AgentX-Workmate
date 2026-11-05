/** Shapes Bot Mode reads from the gateway and keeps in plugin storage. */

/** The `last_session` profiles.list reports for each profile. */
export interface BotLastSession {
  id: string
  title?: string
  preview?: string
  started_at?: number
  /** Unix seconds. */
  last_active?: number
  message_count?: number
}

/** One profiles.list row — a bot is an AgentX profile. */
export interface Bot {
  name: string
  path?: string
  is_default?: boolean
  model?: string | null
  provider?: string | null
  description?: string
  skill_count?: number
  last_session?: BotLastSession | null
  ui_meta?: Record<string, unknown>
  has_avatar?: boolean
}

export interface RosterResponse {
  profiles?: Bot[]
  /** The backend teaches the teammate protocol itself (never touch SOUL.md). */
  bot_mode_protocol?: boolean
}

/** Per-bot look + display fields. Synced to profile.yaml `ui_meta['agentx-bots']`
 *  (minus the image, which goes to the profile asset store). */
export interface BotMeta {
  shape?: string
  color?: string
  /** Avatar picture as a data URL (local cache of the server asset). */
  image?: string | null
  imageKind?: 'photo' | 'shape'
  /** Display name the user gave the bot ("Minh – Kế toán"). */
  title?: string
  /** Stored session id of the bot's ONE canonical chat. */
  chat?: string | null
  pinned?: boolean
  group?: string | null
  /** ms epoch — sorts a fresh bot to the top until another one gets a message. */
  created?: number
  /** The user picked shape/color themselves (beats the primary's fixed look). */
  custom?: boolean
}

export type BotMetaMap = Record<string, BotMeta>

/** cron.manage list row (the fields Bot Mode reads). */
export interface CronJob {
  job_id: string
  name?: string
  schedule?: string
  schedule_display?: string
  enabled?: boolean
  state?: string
  next_run_at?: string | null
  last_run_at?: string | null
  last_status?: string | null
  prompt?: string
  prompt_preview?: string
}

/** session.list row. */
export interface ProfileSession {
  id: string
  title?: string | null
  preview?: string | null
  source?: string | null
  started_at?: number
  last_active?: number
  message_count?: number
}

export interface GroupMember {
  name: string
  title: string
}

export interface GroupEntry {
  from: { kind: 'member' | 'user'; name: string }
  text: string
  /** ms epoch */
  at: number
}

export interface GroupRoom {
  log: GroupEntry[]
  /** member name → index into `log` of the first entry it has NOT seen. */
  watermarks: Record<string, number>
  /** member name → stored session id of its per-room session. */
  sessions: Record<string, string>
  /** Runtime only: bumps on every user send so an older drive loop bails. */
  epoch: number
  running: boolean
  /** Runtime only: the member whose turn is in flight, for "X is replying". */
  speaker?: string | null
}
