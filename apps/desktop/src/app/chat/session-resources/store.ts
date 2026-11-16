import { atom } from 'nanostores'

import { persistBoolean, storedBoolean } from '@/lib/storage'

const PINNED_KEY = 'agentx.desktop.sessionResources.pinned'

/** Whether the docked card is shown. One choice for the whole app: someone
 *  who closes it is not asked again by every conversation they open. */
export const $sessionResourcesPinned = atom(storedBoolean(PINNED_KEY, true))

$sessionResourcesPinned.subscribe(pinned => persistBoolean(PINNED_KEY, pinned))

export const setSessionResourcesPinned = (pinned: boolean) => $sessionResourcesPinned.set(pinned)
