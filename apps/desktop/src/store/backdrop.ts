import { atom } from 'nanostores'

import { persistBoolean, storedBoolean } from '@/lib/storage'

const KEY = 'agentx.desktop.backdrop.v1'

/** Whether a click on an empty chat sends a ring of characters through the glyph field. */
export const $backdrop = atom(storedBoolean(KEY, true))

$backdrop.subscribe(on => persistBoolean(KEY, on))

export function setBackdrop(on: boolean) {
  $backdrop.set(on)
}
