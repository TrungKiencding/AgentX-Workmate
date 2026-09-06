import { useStore } from '@nanostores/react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tip, TipKeybindLabel } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import {
  ArrowUp,
  Ear,
  EarOff,
  iconSize,
  Layers3,
  Loader2,
  Mic,
  MicOff,
  MoreHorizontal,
  Square,
  SteeringWheel,
  Volume2,
  VolumeX
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $wakeWord, toggleWakeWord } from '@/store/wake-word'

import type { ConversationStatus } from './hooks/use-voice-conversation'
import { ModelPill } from './model-pill'
import type { ChatBarState, VoiceStatus } from './types'

export const ICON_BTN = 'size-(--composer-control-size) shrink-0'
export const GHOST_ICON_BTN = cn(
  ICON_BTN,
  'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
)
// Send/voice-conversation primary: the ONE accent-filled control in the row.
// primary/primary-foreground (the contrast-gated pair every skin ships) rather
// than raw foreground-on-background, so the CTA carries the theme's accent —
// the same thread as the focus ring, the composer ring, and the voice pill's
// End button, which already wore bg-primary. Disabled drops to the quiet
// secondary fill instead of a ghost of the accent: grey reads "not ready",
// faded blue reads "broken".
export const PRIMARY_ICON_BTN = cn(
  'size-(--composer-control-primary-size,var(--composer-control-size)) shrink-0 rounded-full p-0',
  'bg-primary text-primary-foreground hover:bg-primary/90',
  'disabled:bg-(--ui-bg-quaternary) disabled:text-(--ui-text-tertiary) disabled:opacity-100'
)

interface ConversationProps {
  active: boolean
  level: number
  muted: boolean
  status: ConversationStatus
  onEnd: () => void
  onStart: () => void
  onStopTurn: () => void
  onToggleMute: () => void
}

/**
 * The control row reads as three stops — model · voice · send — and the send
 * slot says one of two things: an up arrow when there is something to send,
 * a microphone when the box is empty ("or just talk"). The voice toggles
 * (dictation, read replies aloud, the wake word) sit behind one ⋯ menu while
 * voice is enabled, so the resting row is never a strip of crossed-out icons;
 * a dictation in progress surfaces its stop control in that slot instead.
 */
export function ComposerControls({
  autoSpeak,
  busy,
  busyAction,
  canSubmit,
  compactModelPill = false,
  conciseModelPill = false,
  conversation,
  disabled,
  hasComposerPayload,
  state,
  voiceStatus,
  onDictate,
  onQueue,
  onToggleAutoSpeak
}: {
  autoSpeak: boolean
  busy: boolean
  busyAction: 'steer' | 'queue' | 'stop'
  canSubmit: boolean
  compactModelPill?: boolean
  /** Outside a coding context the pill wears the model's short name only. */
  conciseModelPill?: boolean
  conversation: ConversationProps
  disabled: boolean
  hasComposerPayload: boolean
  state: ChatBarState
  voiceStatus: VoiceStatus
  onDictate: () => void
  onQueue: () => void
  onToggleAutoSpeak: () => void
}) {
  const { t } = useI18n()
  const c = t.composer

  if (conversation.active) {
    return <ConversationPill {...conversation} disabled={disabled} />
  }

  const showVoicePrimary = !busy && !hasComposerPayload
  const busyLabel = busyAction === 'queue' ? c.queueMessage : busyAction === 'steer' ? c.steer : c.stop
  const dictating = state.voice.active || voiceStatus !== 'idle'

  return (
    <div className="ml-auto flex shrink-0 items-center gap-(--composer-control-gap)">
      <ModelPill compact={compactModelPill} concise={conciseModelPill} disabled={disabled} model={state.model} />
      {state.voice.enabled &&
        (dictating ? (
          <DictationButton disabled={disabled} onToggle={onDictate} state={state.voice} status={voiceStatus} />
        ) : (
          <VoiceMenu
            autoSpeak={autoSpeak}
            disabled={disabled}
            onDictate={onDictate}
            onToggleAutoSpeak={onToggleAutoSpeak}
          />
        ))}
      {busyAction === 'steer' ? (
        <Tip label={<TipKeybindLabel actionId="composer.queue" text={c.queueMessage} />}>
          <Button
            aria-label={c.queueMessage}
            className={GHOST_ICON_BTN}
            disabled={disabled}
            onClick={onQueue}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Layers3 className={iconSize.sm} />
          </Button>
        </Tip>
      ) : null}
      {showVoicePrimary ? (
        <Tip label={c.startVoice}>
          <Button
            aria-label={c.startVoice}
            className={PRIMARY_ICON_BTN}
            disabled={disabled}
            onClick={() => {
              triggerHaptic('open')
              conversation.onStart()
            }}
            size="icon"
            type="button"
          >
            <Mic className={iconSize.md} />
          </Button>
        </Tip>
      ) : (
        <Tip
          label={
            busy ? (
              <TipKeybindLabel
                actionId={
                  busyAction === 'steer'
                    ? 'composer.steer'
                    : busyAction === 'queue'
                      ? 'composer.queue'
                      : 'composer.send'
                }
                text={busyLabel}
              />
            ) : (
              <TipKeybindLabel actionId="composer.send" text={c.send} />
            )
          }
        >
          <Button
            aria-label={busy ? busyLabel : c.send}
            className={PRIMARY_ICON_BTN}
            disabled={disabled || !canSubmit}
            type="submit"
          >
            {busy ? (
              busyAction === 'queue' ? (
                <Layers3 className={iconSize.md} />
              ) : busyAction === 'steer' ? (
                <SteeringWheel className={iconSize.md} />
              ) : (
                <span className="block size-3 rounded-[0.1875rem] bg-current" />
              )
            ) : (
              <ArrowUp className={iconSize.md} />
            )}
          </Button>
        </Tip>
      )}
    </div>
  )
}

/**
 * One ⋯ for the voice toggles. Dictation is an action (it starts and the row
 * swaps to its stop control); reading replies aloud and the wake word are
 * checkboxes that show their state. Toggling keeps the menu open so the check
 * is seen landing; dictation closes it.
 */
function VoiceMenu({
  autoSpeak,
  disabled,
  onDictate,
  onToggleAutoSpeak
}: {
  autoSpeak: boolean
  disabled: boolean
  onDictate: () => void
  onToggleAutoSpeak: () => void
}) {
  const { t } = useI18n()
  const c = t.composer
  const wake = useStore($wakeWord)
  const phrase = wake.phrase || 'hey agentx'
  const wakeLabel = wake.listening ? c.wakeWordListening(phrase) : c.wakeWordOff(phrase)
  // Something is on: the trigger wears the accent so the state is not hidden
  // behind the menu.
  const anyOn = autoSpeak || wake.listening

  return (
    <DropdownMenu>
      <Tip label={c.voiceMenu}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={c.voiceMenu}
            className={cn(
              GHOST_ICON_BTN,
              'p-0 data-[state=open]:bg-(--chrome-action-hover) data-[state=open]:text-foreground',
              anyOn && 'text-primary hover:text-primary'
            )}
            disabled={disabled}
            size="icon"
            type="button"
            variant="ghost"
          >
            <MoreHorizontal className={iconSize.md} />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="w-72" side="top" sideOffset={6}>
        <DropdownMenuItem
          onSelect={() => {
            triggerHaptic('open')
            onDictate()
          }}
        >
          <Mic />
          <span className="min-w-0 flex-1 truncate">{c.voiceDictation}</span>
        </DropdownMenuItem>
        <DropdownMenuCheckboxItem
          checked={autoSpeak}
          onSelect={event => {
            event.preventDefault()
            triggerHaptic(autoSpeak ? 'close' : 'open')
            onToggleAutoSpeak()
          }}
        >
          {autoSpeak ? <Volume2 /> : <VolumeX />}
          <span className="min-w-0 flex-1 truncate">{c.speakReplies}</span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={wake.listening}
          disabled={wake.pending}
          onSelect={event => {
            event.preventDefault()
            triggerHaptic(wake.listening ? 'close' : 'open')
            void toggleWakeWord()
          }}
        >
          {wake.listening ? <Ear /> : <EarOff />}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate">{wakeLabel}</span>
            {wake.notice && <span className="truncate text-2xs text-(--ui-text-tertiary)">{wake.notice}</span>}
          </span>
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ConversationPill({
  disabled,
  level,
  muted,
  onEnd,
  onStopTurn,
  onToggleMute,
  status
}: ConversationProps & { disabled: boolean }) {
  const { t } = useI18n()
  const c = t.composer
  const speaking = status === 'speaking'
  const listening = status === 'listening' && !muted

  const label =
    status === 'speaking'
      ? c.speaking
      : status === 'transcribing'
        ? c.transcribing
        : status === 'thinking'
          ? c.thinking
          : muted
            ? c.muted
            : c.listening

  return (
    <div className="ml-auto flex shrink-0 items-center gap-(--composer-control-gap)">
      {/* Keep the ear visible during voice chat — shown paused, since the
          conversation holds the mic (the one time wake must not listen). */}
      <WakeWordButton disabled={disabled} pausedForVoice />
      <Tip label={muted ? c.unmuteMic : c.muteMic}>
        <Button
          aria-label={muted ? c.unmuteMic : c.muteMic}
          aria-pressed={muted}
          className={cn(GHOST_ICON_BTN, 'p-0', muted && 'bg-muted text-muted-foreground')}
          disabled={disabled}
          onClick={() => {
            triggerHaptic('selection')
            onToggleMute()
          }}
          size="icon"
          type="button"
          variant="ghost"
        >
          {muted ? <MicOff className={iconSize.md} /> : <Mic className={iconSize.md} />}
        </Button>
      </Tip>
      {listening && (
        <Button
          aria-label={c.stopListening}
          className="h-(--composer-control-size) shrink-0 gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          disabled={disabled}
          onClick={() => {
            triggerHaptic('submit')
            onStopTurn()
          }}
          type="button"
          variant="ghost"
        >
          <Square className={cn('fill-current', iconSize.xs)} />
          <span>{c.stopShort}</span>
        </Button>
      )}
      <Button
        aria-label={c.endConversation}
        className="h-(--composer-control-size) gap-1.5 rounded-full bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        disabled={disabled}
        onClick={() => {
          triggerHaptic('close')
          onEnd()
        }}
        type="button"
      >
        <ConversationIndicator level={level} listening={listening} speaking={speaking} />
        <span>{c.endShort}</span>
      </Button>
      <span className="sr-only" role="status">
        {label}
      </span>
    </div>
  )
}

function ConversationIndicator({
  level,
  listening,
  speaking
}: {
  level: number
  listening: boolean
  speaking: boolean
}) {
  if (speaking) {
    return <Loader2 className={cn('animate-spin', iconSize.xs)} />
  }

  const bars = [0.55, 0.85, 1, 0.85, 0.55]
  const normalized = Math.max(0, Math.min(level, 1))

  return (
    <span aria-hidden="true" className="flex h-3 items-center gap-0.5">
      {bars.map((weight, index) => {
        const height = listening ? 0.3 + Math.min(0.7, normalized * weight) : 0.3

        return <span className="w-0.5 rounded-full bg-current" key={index} style={{ height: `${height * 100}%` }} />
      })}
    </span>
  )
}

// "Hey AgentX" wake-word toggle, as a standalone button. At rest it lives in
// the voice ⋯ menu; here it stays visible during a voice conversation — shown
// paused, since the conversation holds the mic (the one time wake genuinely
// must not listen). Backend refusals ({started:false, reason}) keep the toggle
// off and put the reason/hint in the tooltip.
function WakeWordButton({ disabled, pausedForVoice = false }: { disabled: boolean; pausedForVoice?: boolean }) {
  const { t } = useI18n()
  const c = t.composer
  const wake = useStore($wakeWord)

  const phrase = wake.phrase || 'hey agentx'

  const label = pausedForVoice
    ? c.wakeWordPausedVoice(phrase)
    : wake.listening
      ? c.wakeWordListening(phrase)
      : c.wakeWordOff(phrase)

  const tooltip = !pausedForVoice && wake.notice ? `${label} — ${wake.notice}` : label

  return (
    <Tip label={tooltip}>
      <Button
        aria-label={label}
        aria-pressed={wake.listening && !pausedForVoice}
        className={cn(
          GHOST_ICON_BTN,
          'p-0',
          wake.listening && !pausedForVoice && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary'
        )}
        disabled={disabled || pausedForVoice || wake.pending}
        onClick={() => {
          triggerHaptic(wake.listening ? 'close' : 'open')
          void toggleWakeWord()
        }}
        size="icon"
        type="button"
        variant="ghost"
      >
        {wake.listening && !pausedForVoice ? <Ear className={iconSize.sm} /> : <EarOff className={iconSize.sm} />}
      </Button>
    </Tip>
  )
}

// The dictation control while a dictation is in flight: a stop square while
// recording, a spinner while the audio is being transcribed. At rest dictation
// is started from the voice ⋯ menu instead.
function DictationButton({
  disabled,
  state,
  status,
  onToggle
}: {
  disabled: boolean
  state: ChatBarState['voice']
  status: VoiceStatus
  onToggle: () => void
}) {
  const { t } = useI18n()
  const c = t.composer
  const active = state.active || status !== 'idle'

  const aria =
    status === 'recording' ? c.stopDictation : status === 'transcribing' ? c.transcribingDictation : c.voiceDictation

  return (
    <Tip label={aria}>
      <Button
        aria-label={aria}
        aria-pressed={active}
        className={cn(
          GHOST_ICON_BTN,
          'p-0',
          'data-[active=true]:bg-accent data-[active=true]:text-foreground',
          status === 'recording' && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary',
          status === 'transcribing' && 'bg-primary/10 text-primary'
        )}
        data-active={active}
        disabled={disabled || !state.enabled || status === 'transcribing'}
        onClick={() => {
          triggerHaptic(active ? 'close' : 'open')
          onToggle()
        }}
        size="icon"
        type="button"
        variant="ghost"
      >
        {status === 'recording' ? (
          <Square className={cn('fill-current', iconSize.xs)} />
        ) : status === 'transcribing' ? (
          <Loader2 className={cn('animate-spin', iconSize.sm)} />
        ) : (
          <Mic className={iconSize.sm} />
        )}
      </Button>
    </Tip>
  )
}
