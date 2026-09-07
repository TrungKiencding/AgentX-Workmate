// The Tiện ích → Công cụ shelves. Twenty-four switches in one alphabetical
// grid asks a person to hold twenty-four unrelated decisions at once; the
// skills tab already answers this by shelving cards under their category, so
// tools shelve the same way — by the job they do, in the order a person cares
// about them.
//
// The last shelf is the important one: `agent` holds the machinery that makes
// the assistant work at all (its notes, its to-do list, its ability to read
// the skills you enabled next door). Those are not capabilities a person picks
// — they are on by default and turning one off breaks something quietly
// somewhere else. Grouping them under one heading with its own warning is the
// difference between "24 things you must decide" and "17 choices plus a box
// you can leave shut".
//
// Keyed by the toolset's internal name, the same key `skills.toolsets` and
// `toolset-icons.ts` use, so a tool's shelf, glyph, name and sentence all come
// from one row. A toolset no table knows (a plugin's) lands in `other`.
// Declaration order is display order: the shelves a person came for first, the
// plumbing shelf last. A plugin's toolset ("Khác") is still a capability, so it
// sits with the capabilities rather than below the machinery.
export const TOOLSET_GROUP_IDS = ['web', 'computer', 'media', 'apps', 'other', 'agent'] as const

export type ToolsetGroupId = (typeof TOOLSET_GROUP_IDS)[number]

const TOOLSET_GROUPS: Record<string, ToolsetGroupId> = {
  // Reads the outside world.
  browser: 'web',
  web: 'web',
  x_search: 'web',

  // Acts on this machine.
  code_execution: 'computer',
  computer_use: 'computer',
  file: 'computer',
  terminal: 'computer',

  // Sees, hears, draws, speaks.
  bfl: 'media',
  image_gen: 'media',
  stt: 'media',
  tts: 'media',
  video: 'media',
  video_gen: 'media',
  vision: 'media',

  // Someone else's account or device.
  homeassistant: 'apps',
  spotify: 'apps',

  // How the assistant works. Not capabilities — plumbing.
  a2a: 'agent',
  clarify: 'agent',
  cronjob: 'agent',
  delegation: 'agent',
  memory: 'agent',
  session_search: 'agent',
  skills: 'agent',
  todo: 'agent'
}

/** The shelf a tool belongs on; a toolset outside the table goes to "Khác". */
export const toolsetGroup = (name: string): ToolsetGroupId => TOOLSET_GROUPS[name] ?? 'other'
