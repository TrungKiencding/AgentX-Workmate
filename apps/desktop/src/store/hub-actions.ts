import { matchQuery } from '@tanstack/react-query'
import { atom, map } from 'nanostores'

import {
  getActionStatus,
  installSkillFromHub,
  tickSkillHub,
  uninstallSkillFromHub,
  updateSkillsFromHub
} from '@/hermes'
import { queryClient } from '@/lib/query-client'
import { invalidateSlashCompletions } from '@/lib/slash-completion-cache'
import { upsertDesktopActionTask } from '@/store/activity'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'

const POLL_MS = 1200

// Shared with hub.tsx's catalogue useQuery so a finished action refreshes the
// installed map. The catalogue IS the store — the hub is the only source it
// reads — so this one key covers every card on the tab.
export const HUB_CATALOG_KEY = ['skill-hub-catalog'] as const
// The Capabilities Skills-list query key (see app/skills/index.tsx) — kept in
// sync here so a hub (un)install updates the Skills tab, not just the hub.
const SKILLS_LIST_KEY = ['skills-list'] as const
// Non-identifier key for the fleet-wide "Update installed" action.
export const UPDATE_ALL_KEY = '__update_all__'
// What the hub wants on this machine and what the engine did about it — the
// Hub tab's status panel polls it (hub-status.tsx), the publish dialog reads
// its workspaces. Here so a finished action can refresh it without a cycle.
export const HUB_CHANGES_KEY = ['skill-hub-changes'] as const

export type HubActionKind = 'install' | 'uninstall' | 'update'

export interface HubAction {
  kind: HubActionKind
  running: boolean
  lines: string[]
}

// Per-item action status, keyed by skill identifier (or UPDATE_ALL_KEY). Each
// row drives its own button off ITS entry — one install never touches another.
export const $hubActions = map<Record<string, HubAction | undefined>>({})

// Optimistic installed overrides so a card flips to its resolved state the instant
// its own action finishes, instead of waiting on (and racing) the catalogue
// refetch. install/update → true, uninstall → false. They only bridge that
// wait: the catalogue's next answer drops them (below), so a card then follows
// whatever else adds or removes the skill — the hub's sync engine, a terminal.
export const $hubInstalledOverride = map<Record<string, boolean | undefined>>({})

// The key whose log the bottom pane currently tails (the latest-started action).
export const $hubActiveLog = atom<null | string>(null)

// Hub action state is per-profile: a profile switch must drop every in-flight
// entry, optimistic override, and active log so profile A's install/uninstall
// state can never render (or be polled) in profile B. Cleared at the source so
// it holds regardless of whether the Hub view is mounted. The epoch bumps on
// every switch; a runHubAction() started before the switch captures it and bails
// before any store write once it no longer matches (so an A action finishing
// after the clear can't repopulate B).
let _hubProfile: null | string = null
let _hubEpoch = 0

$activeGatewayProfile.subscribe(value => {
  const key = normalizeProfileKey(value)

  if (_hubProfile !== null && _hubProfile !== key) {
    _hubEpoch += 1
    $hubActions.set({})
    $hubInstalledOverride.set({})
    $hubActiveLog.set(null)
  }

  _hubProfile = key
})

// The catalogue answered: the backend reads the installed map as it answers, so
// an answer landing after an action finished already counts it — hand every
// card back to the catalogue. Only a successful answer does: a failed refetch
// leaves the flips standing, and a request the action's own invalidation
// superseded never lands. Watched at the cache, so the query's fetches and the
// Sync button's direct write both count.
queryClient.getQueryCache().subscribe(event => {
  if (
    event.type === 'updated' &&
    event.action.type === 'success' &&
    matchQuery({ queryKey: HUB_CATALOG_KEY }, event.query) &&
    Object.keys($hubInstalledOverride.get()).length > 0
  ) {
    $hubInstalledOverride.set({})
  }
})

// One self-contained task: spawn → tail its own action log into the store →
// mark resolved. Concurrency-safe: state is per-key, so parallel installs never
// stomp each other, and the catalogue query is invalidated once at the end.
async function runHubAction(key: string, kind: HubActionKind, spawn: () => Promise<{ name: string }>): Promise<void> {
  const epoch = _hubEpoch
  const switched = () => _hubEpoch !== epoch

  $hubActions.setKey(key, { kind, running: true, lines: [] })
  $hubActiveLog.set(key)

  try {
    const started = await spawn()
    let exitCode: number | null = null

    for (;;) {
      const status = await getActionStatus(started.name, 200)

      // Profile switched mid-flight: the store was cleared for the new profile,
      // so drop this A-profile result instead of writing it back into B.
      if (switched()) {
        return
      }

      upsertDesktopActionTask(status)
      $hubActions.setKey(key, { kind, running: status.running, lines: status.lines })

      if (!status.running) {
        exitCode = status.exit_code

        break
      }

      await new Promise(resolve => setTimeout(resolve, POLL_MS))
    }

    // Only flip the row on a clean exit — a failed install/uninstall must not
    // render as installed/removed. The flip lasts until the catalogue answers
    // again — normally the refetch just below.
    if (key !== UPDATE_ALL_KEY && exitCode === 0) {
      $hubInstalledOverride.setKey(key, kind !== 'uninstall')
    }

    // Refresh the hub's installed map AND the Capabilities Skills list — a hub
    // (un)install adds/removes a skill, so its count/rows must update too.
    void queryClient.invalidateQueries({ queryKey: HUB_CATALOG_KEY })
    void queryClient.invalidateQueries({ queryKey: SKILLS_LIST_KEY })
    // The CLI changed the disk behind the sync engine's back: a tick now tells
    // the hub (an update stops being offered, here and on the web) instead of
    // at the next minute.
    void tickSkillHub()
      .catch(() => undefined)
      .finally(() => void queryClient.invalidateQueries({ queryKey: HUB_CHANGES_KEY }))
    // …and the composer's `/` list, which caches the command catalog for an
    // hour and would otherwise keep offering the skill we just removed.
    invalidateSlashCompletions()
  } catch (err) {
    // A profile switch points the next poll at the new backend, which 404s the
    // old action name — that's an abandonment, not a failure, so swallow it
    // instead of letting the caller toast a phantom error. Real (same-profile)
    // failures still propagate.
    if (switched()) {
      return
    }

    throw err
  } finally {
    // Skip the running=false write after a switch — it would re-add the key the
    // profile-switch clear just dropped.
    const current = $hubActions.get()[key]

    if (current && !switched()) {
      $hubActions.setKey(key, { ...current, running: false })
    }
  }
}

export function installHubSkill(identifier: string): Promise<void> {
  return runHubAction(identifier, 'install', () => installSkillFromHub(identifier))
}

export function uninstallHubSkill(identifier: string, name: string): Promise<void> {
  return runHubAction(identifier, 'uninstall', () => uninstallSkillFromHub(name))
}

export function updateHubSkills(): Promise<void> {
  return runHubAction(UPDATE_ALL_KEY, 'update', () => updateSkillsFromHub())
}

/** One skill's update, on its own row; `overwriteLocal` replaces a copy edited
 *  on this machine (the backend backs the edit up first). */
export function updateHubSkill(
  identifier: string,
  name: string,
  options: { overwriteLocal?: boolean } = {}
): Promise<void> {
  return runHubAction(identifier, 'update', () => updateSkillsFromHub({ name, overwriteLocal: options.overwriteLocal }))
}

export function closeHubLog(): void {
  $hubActiveLog.set(null)
}
