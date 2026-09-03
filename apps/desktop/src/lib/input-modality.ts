/** Which input device drove the most recent interaction.
 *
 *  Chromium's `:focus-visible` is not enough to tell a mouse pick from a Tab.
 *  Radix menus autofocus their content on open and keyboard-navigate their
 *  items, so by the time a mouse click closes the menu and restores focus to
 *  the trigger, Chromium has decided the page is in keyboard modality and
 *  matches `:focus-visible` on that restore (verified in Chrome — the model
 *  pill's tooltip popped open after every mouse pick). Track the device
 *  ourselves and use it to qualify `:focus-visible`.
 */

export type InputModality = 'keyboard' | 'pointer'

/** Mirrored onto the document root so CSS can apply the same gate the tooltip
 *  applies in JS — see the focus-ring rule in `styles.css`. */
export const MODALITY_ATTR = 'data-input-modality'

let modality: InputModality = 'keyboard'

const apply = (next: InputModality) => {
  modality = next
  document.documentElement.setAttribute(MODALITY_ATTR, next)
}

/** Capture-phase so a `stopPropagation` deeper in the tree can't blind us, and
 *  so the root attribute is already updated when the browser runs the event's
 *  default focus action — the ring is decided in the same frame as the click. */
if (typeof document !== 'undefined') {
  apply(modality)
  document.addEventListener('pointerdown', () => apply('pointer'), { capture: true, passive: true })
  document.addEventListener('keydown', () => apply('keyboard'), { capture: true, passive: true })
}

/** The device behind the last pointerdown/keydown. Defaults to `keyboard` so a
 *  surface that has seen no input yet keeps the accessible behavior. */
export function lastInputModality(): InputModality {
  return modality
}
