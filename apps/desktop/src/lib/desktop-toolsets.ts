// Curation for the desktop "Skills & Tools → Toolsets" list.
//
// `GET /api/tools/toolsets` returns the full CONFIGURABLE_TOOLSETS set with no
// desktop-specific filter — so it surfaces entries that don't belong in a flat
// per-user toggle list on the desktop: platform-coupled toolsets (which
// `agentx tools` already platform-restricts on the CLI) and internal plumbing
// that isn't a user-facing capability. Mirror the curation approach used for
// slash commands (`desktop-slash-commands.ts`): one documented block-list, one
// predicate. Hiding a toolset only removes its row — its enabled state and
// runtime gating are untouched.
const DESKTOP_HIDDEN_TOOLSETS = new Set([
  // Platform-coupled — only meaningful when that platform is the active
  // adapter; `agentx tools` restricts these off the CLI too.
  'discord',
  'discord_admin',
  'yuanbao',
  // Internal plumbing, not a user capability toggle.
  'context_engine',
  'moa'
  // NOT hidden, though it was tempting: `skills`. It ships
  // `skills_list`/`skill_view`/`skill_manage`, and `agent/system_prompt.py`
  // builds no skill index without them — so switching that one card off stops
  // AgentX choosing skills for itself, and the "Kỹ năng sẵn có" tab two clicks
  // away goes quiet while all its switches still read as on. Hiding the card
  // would not have fixed that: hiding removes the row, never the setting
  // (see above), so anyone who had already switched it off would lose their
  // only way back. It stays visible — on the "Cách trợ lý làm việc" shelf, with
  // copy that finally says what it does (`skills.toolsets.skills`).
])

export function isDesktopToolsetVisible(name: string): boolean {
  return !DESKTOP_HIDDEN_TOOLSETS.has(name)
}
