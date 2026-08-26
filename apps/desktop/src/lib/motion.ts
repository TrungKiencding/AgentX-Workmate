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

/** Enter — things arriving on screen. */
export const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)'
/** Exit — things leaving. */
export const EASE_IN = 'cubic-bezier(0.7, 0, 0.84, 0)'
/** In-place morph — something changing shape without arriving or leaving. */
export const EASE_IN_OUT = 'cubic-bezier(0.65, 0, 0.35, 1)'

/** Physical overshoot: reaction pop, particle burst, a dragged row settling. */
export const SPRING_POP = 'cubic-bezier(0.34, 1.56, 0.64, 1)'
/** Physical overshoot, softer and longer: the pet hatching out of its egg. */
export const SPRING_REVEAL = 'cubic-bezier(0.22, 1.4, 0.4, 1)'

/** Press, toggle, colour. */
export const DUR_MICRO_MS = 100
/** Hover, menu, tooltip. */
export const DUR_SHORT_MS = 200
/** Overlay, entrance. */
export const DUR_LONG_MS = 320

/** Exits run ≈ 75% of the enter they answer. */
export const DUR_MICRO_EXIT_MS = 75
export const DUR_SHORT_EXIT_MS = 150
export const DUR_LONG_EXIT_MS = 240
