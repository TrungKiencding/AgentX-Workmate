// Rewind/edit address a user turn by its ordinal in the MODEL history
// (prompt.submit's `truncate_before_user_ordinal`). After a context compaction
// the transcript shows more than the model keeps: the archived turns above the
// divider, and not the copies the compactor re-inserted. The latest divider
// carries how many model-history user turns it stands for, so ordinals restart
// there; turns above it are no longer in the model history and can't be
// rewound to.

export interface CompactionAnchor {
  /** Index of the latest compaction divider that carries an offset. */
  index: number
  offset: number
}

export function latestCompactionAnchor<T>(
  messages: readonly T[],
  offsetOf: (message: T) => number | undefined
): CompactionAnchor | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const offset = offsetOf(messages[index])

    if (offset !== undefined) {
      return { index, offset }
    }
  }

  return null
}

/** Ordinal of the user turn at `index`, or null when it sits above the latest
 *  divider (summarized away — not addressable). */
export function userOrdinalAt<T>(
  messages: readonly T[],
  index: number,
  isUserTurn: (message: T) => boolean,
  offsetOf: (message: T) => number | undefined
): null | number {
  const anchor = latestCompactionAnchor(messages, offsetOf)

  if (anchor && index < anchor.index) {
    return null
  }

  const start = anchor ? anchor.index + 1 : 0
  let ordinal = anchor?.offset ?? 0

  for (let i = start; i < index; i += 1) {
    if (isUserTurn(messages[i])) {
      ordinal += 1
    }
  }

  return ordinal
}

/** Index of the user turn with `ordinal`, or -1. */
export function userIndexAtOrdinal<T>(
  messages: readonly T[],
  ordinal: number,
  isUserTurn: (message: T) => boolean,
  offsetOf: (message: T) => number | undefined
): number {
  const anchor = latestCompactionAnchor(messages, offsetOf)
  let current = anchor?.offset ?? 0

  for (let index = anchor ? anchor.index + 1 : 0; index < messages.length; index += 1) {
    if (!isUserTurn(messages[index])) {
      continue
    }

    if (current === ordinal) {
      return index
    }

    current += 1
  }

  return -1
}
