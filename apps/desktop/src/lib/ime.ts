export interface ImeKeyEvent {
  key: string
  nativeEvent: {
    isComposing?: boolean
    keyCode?: number
  }
}

/**
 * True while an input method is composing — Vietnamese Telex/VNI, Japanese,
 * Chinese, Korean. An Enter in that state confirms the conversion; it must
 * never act as a shortcut (Quiet Tool spec §5.7). Chromium can report the
 * legacy 229 keyCode around composition boundaries, so keep that fallback in
 * addition to the standard isComposing signal.
 */
export function isImeComposing(event: Pick<ImeKeyEvent, 'nativeEvent'>): boolean {
  return Boolean(event.nativeEvent.isComposing) || event.nativeEvent.keyCode === 229
}

/** Enter that should submit: a real Enter, not an IME confirming its text. */
export function shouldSubmitOnEnter(event: ImeKeyEvent): boolean {
  return event.key === 'Enter' && !isImeComposing(event)
}
