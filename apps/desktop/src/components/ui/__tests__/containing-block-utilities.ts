// Tailwind utilities that make an element the containing block of its
// `position: fixed` descendants (and so capture any popover portalled into it).
// Animation utilities (`animate-in`, `zoom-in-98`, `slide-in-from-*`) are not
// listed: they only set custom properties, and the keyframes set transform
// just while they play.
const CONTAINING_BLOCK_UTILITY =
  /^-?(?:translate|scale|rotate|skew|transform|perspective|filter|blur|brightness|contrast|drop-shadow|grayscale|hue-rotate|invert|saturate|sepia|backdrop|contain-(?!none)|will-change-(?:transform|filter|\[))/u

/** The containing-block utilities in a class string (variants stripped). */
export function containingBlockUtilities(classes: string): string[] {
  return classes
    .split(/\s+/u)
    .filter(Boolean)
    .filter(token => {
      // Drop variant prefixes (`data-[state=open]:`, `sm:`) — the base utility
      // is what follows the last colon outside brackets.
      let depth = 0
      let start = 0

      for (let index = 0; index < token.length; index += 1) {
        const char = token[index]

        if (char === '[' || char === '(') {
          depth += 1
        } else if (char === ']' || char === ')') {
          depth -= 1
        } else if (char === ':' && depth === 0) {
          start = index + 1
        }
      }

      return CONTAINING_BLOCK_UTILITY.test(token.slice(start).replace(/^!/u, ''))
    })
}
