/**
 * The motion tokens, in JavaScript.
 *
 * CSS gets its curves and durations from custom properties in `styles.css`
 * (`--ease-*`, `--dur-*`, `--spring-*`). The Web Animations API cannot read
 * those — `element.animate({ easing: 'var(--ease-out)' })` is invalid — so
 * every WAAPI call and every easing string handed to a drag library resolves
 * it here instead of inlining its own `cubic-bezier(…)`.
 *
 * This file and the token block in `styles.css` are two halves of ONE set:
 * change a curve in one, change it in the other. They are the only two places
 * in `src/` where a raw `cubic-bezier()` is allowed to appear.
 */

/** Enter — things arriving on screen (spec §3.11). */
export const EASE_OUT = 'cubic-bezier(0.2, 0, 0, 1)'
/** Exit — things leaving. */
export const EASE_IN = 'cubic-bezier(0.4, 0, 1, 1)'
/** Move / resize — something changing shape or place without arriving or leaving. */
export const EASE_IN_OUT = 'cubic-bezier(0.4, 0, 0.2, 1)'

/**
 * Physical settle: reaction pop, particle burst, a dragged row landing. The
 * spec bans bounce and spring overshoot, so both "springs" are the enter curve
 * — kept as named tokens so the physical call sites stay distinguishable.
 */
export const SPRING_POP = EASE_OUT
/** Physical settle, the pet hatching out of its egg. */
export const SPRING_REVEAL = EASE_OUT

/** Hover, colour change. */
export const DUR_MICRO_MS = 120
/** Popover, menu. */
export const DUR_SHORT_MS = 160
/** Dialog, toast. */
export const DUR_LONG_MS = 200

/** Exits run faster than the enter they answer. */
export const DUR_MICRO_EXIT_MS = 80
export const DUR_SHORT_EXIT_MS = 100
export const DUR_LONG_EXIT_MS = 150
