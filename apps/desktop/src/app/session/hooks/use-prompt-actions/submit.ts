import { type MutableRefObject, useCallback } from 'react'

import { PROMPT_SUBMIT_REQUEST_TIMEOUT_MS } from '@/hermes'
import type { Translations } from '@/i18n'
import { type ChatMessage, textPart } from '@/lib/chat-messages'
import { optimisticAttachmentRef } from '@/lib/chat-runtime'
import { sanitizeComposerInput } from '@/lib/composer-input-sanitize'
import { setMutableRef } from '@/lib/mutable-ref'
import {
  isVoicePlaybackActive,
  markVoicePlaybackInterrupted,
  stopVoicePlayback,
  takeVoicePlaybackInterrupted
} from '@/lib/voice-playback'
import {
  $composerAttachments,
  clearComposerAttachments,
  type ComposerAttachment,
  terminalContextBlocksFromDraft
} from '@/store/composer'
import { clearNotifications, notify, notifyError } from '@/store/notifications'
import { requestDesktopOnboarding } from '@/store/onboarding'
import {
  $sessions,
  resolveComposerSessionKey,
  setActiveSessionId,
  setAwaitingResponse,
  setBusy,
  setMessages,
  setTurnStartedAt,
  touchSessionActivity
} from '@/store/session'
import { $sessionStates } from '@/store/session-states'

import type { ClientSessionState } from '../../../types'
import { sessionContextDrift } from '../session-context-drift'

import { finalizeInterruptedMessages } from './rewind'
import {
  _submitInFlight,
  type GatewayRequest,
  inlineErrorMessage,
  isGatewayTimeoutError,
  isProviderSetupError,
  isSessionBusyError,
  isSessionNotFoundError,
  isTargetSessionBusy,
  type SubmitTextOptions,
  withSessionBusyRetry
} from './utils'

interface SubmitPromptDeps {
  activeSessionIdRef: MutableRefObject<string | null>
  busyRef: MutableRefObject<boolean>
  copy: Translations['desktop']
  createBackendSessionForSend: (preview?: string | null) => Promise<string | null>
  getRoutedStoredSessionId: () => null | string
  getRuntimeIdForStoredSession: (storedSessionId: string) => null | string
  getRouteToken: () => string
  /** Rebind a stored conversation to a live runtime after its runtime id died
   *  ("session not found"), carrying what was on screen — transcript, the turn
   *  being started, every surface showing the dead id — onto it. */
  recoverSessionRuntime: (storedSessionId: string, staleRuntimeId: null | string) => Promise<null | string>
  requestGateway: GatewayRequest
  resumeStoredSession: (storedSessionId: string) => Promise<void> | void
  selectedStoredSessionIdRef: MutableRefObject<string | null>
  syncAttachmentsForSubmit: (
    sessionId: string,
    attachments: ComposerAttachment[],
    options?: { updateComposerAttachments?: boolean }
  ) => Promise<ComposerAttachment[]>
  updateSessionState: (
    sessionId: string,
    updater: (state: ClientSessionState) => ClientSessionState,
    storedSessionId?: string | null
  ) => ClientSessionState
  /** Composer-scope seams: the main chat runs on the module-level globals
   *  (defaults); a session tile injects its own so a tile submit never writes
   *  the primary view's $busy/$messages or clears the main attachment chips. */
  scope?: {
    /** Point this surface at a runtime the submit had to (re)bind. */
    bindRuntime: (runtimeId: string) => void
    clearAttachments: () => void
    readAttachments: () => ComposerAttachment[]
    setAwaitingResponse: (awaiting: boolean) => void
    setBusy: (busy: boolean) => void
    setMessages: (updater: (current: ChatMessage[]) => ChatMessage[]) => void
    setTurnStartedAt: (at: null | number) => void
  }
}

// Stable identity — a fresh default object per render would churn the
// useCallback below on every render.
const MAIN_SUBMIT_SCOPE: NonNullable<SubmitPromptDeps['scope']> = {
  bindRuntime: setActiveSessionId,
  clearAttachments: clearComposerAttachments,
  readAttachments: () => $composerAttachments.get(),
  setAwaitingResponse,
  setBusy,
  setMessages,
  setTurnStartedAt
}

/** The prompt submit pipeline, extracted from usePromptActions. */
export function useSubmitPrompt(deps: SubmitPromptDeps) {
  const {
    activeSessionIdRef,
    busyRef,
    copy,
    createBackendSessionForSend,
    getRoutedStoredSessionId,
    getRuntimeIdForStoredSession,
    getRouteToken,
    recoverSessionRuntime,
    requestGateway,
    resumeStoredSession,
    selectedStoredSessionIdRef,
    syncAttachmentsForSubmit,
    updateSessionState,
    scope = MAIN_SUBMIT_SCOPE
  } = deps

  return useCallback(
    async (rawText: string, options?: SubmitTextOptions) => {
      const visibleText = sanitizeComposerInput(rawText).trim()
      const usingComposerAttachments = !options?.attachments

      // Drop undefined/null holes a session switch or draft restore can leave in
      // the attachments array (same bug class as AttachmentList #49624). Without
      // this, the sibling iterations below (a.kind / a.label / a.refText, and the
      // sync step) throw "Cannot read properties of undefined (reading 'refText')"
      // and break the chat surface.
      const attachments = (options?.attachments ?? scope.readAttachments()).filter((a): a is ComposerAttachment =>
        Boolean(a)
      )

      const terminalContextBlocks = terminalContextBlocksFromDraft(rawText).join('\n\n')
      const hasImage = attachments.some(a => a.kind === 'image')

      // Refs are recomputed after sync (file.attach rewrites @file: refs to
      // workspace-relative paths the remote gateway can resolve). Seed the
      // optimistic message with the pre-sync refs, then rewrite once synced.
      // Images use their base64 preview so the thumbnail renders inline without
      // a (remote-mode 403-prone) /api/media fetch — see optimisticAttachmentRef.
      let attachmentRefs = attachments.map(optimisticAttachmentRef).filter((r): r is string => Boolean(r))

      const buildContextText = (atts: ComposerAttachment[]): string => {
        // atts may be the post-sync array, which can reintroduce holes; filter
        // before touching a.refText / a.kind.
        const present = atts.filter((a): a is ComposerAttachment => Boolean(a))

        const contextRefs = present
          .map(a => a.refText)
          .filter(Boolean)
          .join('\n')

        return (
          [contextRefs, terminalContextBlocks, visibleText].filter(Boolean).join('\n\n') ||
          (present.some(a => a.kind === 'image') ? 'What do you see in this image?' : '')
        )
      }

      // Queue drains fire on the busy→false settle edge, where busyRef (synced
      // from $busy by a separate effect) may still read true — honoring it would
      // bounce the drained send. The drain lock serializes them; the user path
      // keeps the guard so a stray Enter mid-turn can't double-submit.
      //
      // The guard reads the TARGET session's busy state (isTargetSessionBusy),
      // not the foreground flag: an explicit target (tile, queue drain) is
      // frequently not the session on screen, so the foreground flag would gate
      // one session's send on another session's turn.
      const hasSendable = Boolean(visibleText || terminalContextBlocks || attachments.length || hasImage)

      const guardSessionId = options?.sessionId ?? activeSessionIdRef.current

      if (
        !hasSendable ||
        (!options?.fromQueue && isTargetSessionBusy($sessionStates.get(), guardSessionId, busyRef.current))
      ) {
        return false
      }

      // Typing barge-in: a new send silences any in-flight spoken reply.
      if (isVoicePlaybackActive()) {
        markVoicePlaybackInterrupted()
        stopVoicePlayback()
      }

      // Barged mid-speech (here or via the voice loop's VAD)? Flag the submit
      // so the backend notes the interruption to the model.
      const interrupted = takeVoicePlaybackInterrupted()

      // Queue drains carry their source session explicitly. A background drain
      // must never inherit the currently selected session after the user moves
      // to another chat.
      const targetStoredSessionId = options?.storedSessionId ?? selectedStoredSessionIdRef.current

      const targetStartedInCurrentView =
        !targetStoredSessionId || targetStoredSessionId === selectedStoredSessionIdRef.current

      // A queued/background drain whose runtime binding was reaped must NOT
      // inherit the foreground runtime id when its storedSessionId targets a
      // different session — that would land the queued prompt in whichever
      // session the user happens to be viewing (cross-session leak). When the
      // drain is for the current view (no storedSessionId, or it matches the
      // foreground), the foreground runtime is correct and must be kept.
      const isBackgroundQueueDrain = Boolean(
        options?.fromQueue && options?.storedSessionId && options.storedSessionId !== selectedStoredSessionIdRef.current
      )

      let sessionId: null | string = options?.sessionId ?? (isBackgroundQueueDrain ? null : activeSessionIdRef.current)

      // A QUEUED runtime id is authoritative ONLY while it still belongs to its
      // stored session. On a session switch the composer's queue key flips with
      // the route while the foreground runtime id lags a resume behind, so a
      // drain can fire with storedSessionId=B but sessionId=A-runtime — and the
      // prompt.submit below would land B's queued prompt (and its whole answer
      // turn) inside A. Verify the pair against the central binding and drop a
      // stale queued id: the targetStoredSessionId resume path below then
      // rebinds the right runtime, exactly as a background drain with an
      // unknown binding does.
      //
      // Scoped to fromQueue on purpose. Only a drain pairs identifiers from two
      // different clocks; every other explicit-target caller resolves both ids
      // in the same tick and is authoritative by construction. A slash skill
      // dispatch into a fresh ⌘T tab (slash.ts) passes exactly this shape —
      // sessionId=tab-runtime, storedSessionId=tab-stored, no central binding
      // recorded yet — so an unscoped check would null the target and silently
      // drop the kickoff.
      //
      // The identity pair (storedSessionId === sessionId) is the fresh-chat
      // fallback — an unpersisted conversation's queue key IS its runtime id,
      // so it has no central binding to check against and is left untouched.
      if (
        options?.fromQueue &&
        options.sessionId &&
        options.storedSessionId &&
        options.storedSessionId !== options.sessionId
      ) {
        const boundRuntimeId = getRuntimeIdForStoredSession(options.storedSessionId)

        if (boundRuntimeId !== options.sessionId) {
          sessionId = boundRuntimeId
        }
      }

      // Pin the foreground session context for the whole async submit pipeline.
      // Without this, a fast session switch during session.resume / file.attach
      // can redirect the user's text into a different chat (#54527). Mutable —
      // not const — because a new-chat submit legitimately re-homes to the
      // session it creates (see the re-pin after createBackendSessionForSend).
      const startingActiveSessionId = activeSessionIdRef.current
      const selectedStoredSessionId = selectedStoredSessionIdRef.current
      const routedStoredSessionId = getRoutedStoredSessionId()

      const routedRuntimeId = routedStoredSessionId ? getRuntimeIdForStoredSession(routedStoredSessionId) : null

      const routedSessionNeedsResume = Boolean(
        routedStoredSessionId &&
        (selectedStoredSessionId !== routedStoredSessionId ||
          !startingActiveSessionId ||
          startingActiveSessionId !== routedRuntimeId)
      )

      let startingStoredSessionId = routedSessionNeedsResume
        ? routedStoredSessionId
        : (selectedStoredSessionId ?? routedStoredSessionId)

      let startingRouteToken = getRouteToken()

      // Reason string (or null) for why the session context genuinely drifted
      // under this in-flight submit. sessionContextDrift ignores the churn a
      // busy gateway produces (selection null-resets on a gateway/profile
      // switch, search/hash-only route changes, background active-ref
      // retargets) so a second-session send doesn't silently abort — it fires
      // only on a real move to a DIFFERENT chat. Reads the live refs/route each
      // call and measures against the (mutable) baseline, which is re-pinned to
      // the created chat after createBackendSessionForSend. submitTargetStoredId
      // is the stored session this submit targets, so a move ONTO it (the
      // pipeline's own re-home) is never counted as drift.
      const sessionDriftReason = (): string | null =>
        targetStartedInCurrentView
          ? sessionContextDrift({
              startRouteToken: startingRouteToken,
              nowRouteToken: getRouteToken(),
              startSelectedStoredId: startingStoredSessionId,
              nowSelectedStoredId: selectedStoredSessionIdRef.current,
              submitTargetStoredId: startingStoredSessionId,
              composerScope: options?.composerScope,
              // The composer keys drafts/attachments on the durable lineage
              // root (survives auto-compression tip rotation), while
              // startingStoredSessionId is the live tip — resolve the target
              // into the same lineage-root domain before comparing, or every
              // submit into a session that has ever compressed would
              // false-positive-abort.
              submitTargetComposerScope: resolveComposerSessionKey(startingStoredSessionId, $sessions.get())
            })
          : null

      const targetIsCurrentView = (): boolean => targetStartedInCurrentView && !sessionDriftReason()

      // One submit in flight per session — drop any concurrent re-fire so a
      // stalled turn can't stack the same prompt into multiple real turns. The
      // foreground ChatBar and background drainers can briefly overlap during a
      // session switch; this per-session lock makes that safe.
      const submitLockKey = targetStoredSessionId || sessionId || startingActiveSessionId || '__pending_new__'

      if (_submitInFlight.has(submitLockKey)) {
        return false
      }

      _submitInFlight.add(submitLockKey)
      let submitLockReleased = false

      const releaseSubmitLock = () => {
        if (!submitLockReleased) {
          submitLockReleased = true
          _submitInFlight.delete(submitLockKey)
        }
      }

      const optimisticId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      // The turn's timer origin is the SEND, not the backend's message.start:
      // the transcript's waiting indicator starts counting here, and the
      // message.start handler keeps this stamp (see gateway-event.ts) so the
      // timer doesn't reset to 0 when the turn actually starts — a deferred
      // agent build can hold that gap open for tens of seconds.
      const submitStartedAt = Date.now()

      // What the bubble shows. A `/skill` send carries the whole expanded
      // skill body as its text — model-facing scaffolding — so the dispatcher
      // hands us the invocation to render instead. Everything else shows what
      // was typed.
      const bubbleText = options?.displayText ?? visibleText

      const buildUserMessage = (): ChatMessage => ({
        id: optimisticId,
        role: 'user',
        parts: [textPart(bubbleText || (attachmentRefs.length ? '' : attachments.map(a => a.label).join(', ')))],
        attachmentRefs
      })

      const releaseBusy = () => {
        releaseSubmitLock()

        if (targetIsCurrentView()) {
          setMutableRef(busyRef, false)
          scope.setBusy(false)
          scope.setAwaitingResponse(false)
        }
      }

      // Idempotent optimistic insert — re-running with the resolved sessionId
      // after createBackendSessionForSend just overwrites with the same id.
      const seedOptimistic = (sid: string) => {
        // Recents jump on send — not stream start, not turn resolve.
        const activity = bubbleText.trim() ? { preview: bubbleText.trim() } : undefined
        touchSessionActivity(sid, activity)

        if (targetStoredSessionId && targetStoredSessionId !== sid) {
          touchSessionActivity(targetStoredSessionId, activity)
        }

        updateSessionState(
          sid,
          state => ({
            ...state,
            // A fresh user message may never land after a still-pending
            // assistant bubble — settle any leftover (drop it when empty)
            // before appending, or a stale spinner gets stranded
            // mid-transcript above this message forever.
            messages: state.messages.some(m => m.id === optimisticId)
              ? state.messages
              : [...finalizeInterruptedMessages(state.messages, state.streamId), buildUserMessage()],
            busy: true,
            awaitingResponse: true,
            turnStartedAt: submitStartedAt,
            pendingBranchGroup: null,
            sawAssistantPayload: false,
            streamId: null,
            // Fresh submit = new turn — clear any leftover interrupt flag, else
            // mutateStream/completeAssistantMessage drop every delta of this turn
            // (what made drained-after-interrupt sends go silent).
            interrupted: false
          }),
          targetStoredSessionId
        )
      }

      // After sync rewrites refs, refresh the optimistic message in place so the
      // transcript shows the resolved @file: ref rather than the local path.
      const rewriteOptimistic = (sid: string) =>
        updateSessionState(
          sid,
          state => ({
            ...state,
            messages: state.messages.map(message => (message.id === optimisticId ? buildUserMessage() : message))
          }),
          targetStoredSessionId
        )

      const dropOptimistic = (sid: null | string) => {
        if (!sid) {
          if (targetIsCurrentView()) {
            scope.setMessages(current => current.filter(m => m.id !== optimisticId))
          }

          return
        }

        updateSessionState(
          sid,
          state => ({
            ...state,
            messages: state.messages.filter(m => m.id !== optimisticId),
            busy: false,
            awaitingResponse: false,
            pendingBranchGroup: null
          }),
          targetStoredSessionId
        )
      }

      const abortForSessionSwitch = (optimisticSessionId: null | string): false => {
        dropOptimistic(optimisticSessionId)
        releaseBusy()

        return false
      }

      // Foreground-only state: a background queue drain must never write the
      // selected view's busy/awaiting flags or clear its notifications.
      if (targetIsCurrentView()) {
        setMutableRef(busyRef, true)
        scope.setBusy(true)
        scope.setAwaitingResponse(true)
        scope.setTurnStartedAt(submitStartedAt)
        clearNotifications()
      }

      // A route whose selected/runtime binding is incomplete or cross-wired
      // outranks a stale render-time runtime id (often from the previous
      // profile): force the full routed resume path below. An explicit queued
      // runtime id (background drain) is authoritative and is left untouched.
      if (!options?.sessionId && routedSessionNeedsResume) {
        sessionId = null
      }

      if (sessionId) {
        seedOptimistic(sessionId)
      } else if (targetIsCurrentView()) {
        scope.setMessages(current => [...current, buildUserMessage()])
      }

      if (!sessionId && routedStoredSessionId && routedSessionNeedsResume) {
        // The URL still names a durable conversation, but a profile
        // swap/reconnect left its volatile session binding incomplete or
        // cross-wired. Run the full profile-aware resume path. Creating here
        // would fork a contextless chat against whichever profile is active.
        try {
          await resumeStoredSession(routedStoredSessionId)
        } catch {
          return abortForSessionSwitch(null)
        }

        const routedResumeDrift = sessionDriftReason()

        if (routedResumeDrift) {
          console.warn('[submit-drift-abort]', routedResumeDrift, { phase: 'post-routed-resume' })

          return abortForSessionSwitch(null)
        }

        const recoveredRuntimeId = activeSessionIdRef.current
        const validatedRuntimeId = getRuntimeIdForStoredSession(routedStoredSessionId)

        // Recovery only succeeded when both sides of the cache agree that the
        // live runtime belongs to the durable routed session. A failed profile
        // swap may leave the previous profile's runtime active, while a recycled
        // runtime id may leave a cross-wired stored-session mapping.
        if (
          !recoveredRuntimeId ||
          recoveredRuntimeId !== validatedRuntimeId ||
          selectedStoredSessionIdRef.current !== routedStoredSessionId
        ) {
          return abortForSessionSwitch(null)
        }

        sessionId = recoveredRuntimeId
        seedOptimistic(sessionId)
      }

      if (!sessionId && targetStoredSessionId) {
        // A target stored session exists but its runtime binding is gone (the
        // live session was orphan-reaped, a timeout/reconnect cleared it, or a
        // background queue drain only has the durable id). Continue that target
        // conversation; only a genuine new-chat draft may create a new session.
        // Whatever runtime the surface still shows for it is carried over.
        const staleRuntimeId = targetIsCurrentView()
          ? activeSessionIdRef.current
          : getRuntimeIdForStoredSession(targetStoredSessionId)

        try {
          sessionId = await recoverSessionRuntime(targetStoredSessionId, staleRuntimeId)
        } catch {
          // A target stored conversation is not a new-chat draft. If its
          // runtime cannot be rebound, stop here rather than silently replacing
          // it with a contextless session (#55578). For a background/queued
          // drain this abort is a no-op on foreground state (both helpers are
          // targetIsCurrentView-guarded) and simply drops the queued send.
          return abortForSessionSwitch(null)
        }

        const resumeDrift = sessionDriftReason()

        if (resumeDrift) {
          console.warn('[submit-drift-abort]', resumeDrift, { phase: 'post-resume' })

          return abortForSessionSwitch(sessionId)
        }

        if (!sessionId) {
          return abortForSessionSwitch(null)
        }

        // The surface must render the runtime the prompt and its reply land
        // in — pinning only the hot ref left the pane painting a dead slice.
        if (targetIsCurrentView() && activeSessionIdRef.current !== sessionId) {
          activeSessionIdRef.current = sessionId
          scope.bindRuntime(sessionId)
        }

        seedOptimistic(sessionId)
      }

      if (!sessionId) {
        try {
          sessionId = await createBackendSessionForSend(bubbleText)
        } catch (err) {
          dropOptimistic(null)
          releaseBusy()

          if (targetIsCurrentView()) {
            notifyError(err, copy.sessionUnavailable)
          }

          return false
        }

        if (!sessionId) {
          // createBackendSessionForSend returns null when the user switched
          // sessions mid-create (it closes the orphaned session itself) —
          // abort silently. Anything else is a real failure worth a toast.
          const createNullDrift = sessionDriftReason()

          if (createNullDrift) {
            console.warn('[submit-drift-abort]', createNullDrift, { phase: 'post-create-null' })

            return abortForSessionSwitch(null)
          }

          dropOptimistic(null)
          releaseBusy()

          if (targetIsCurrentView()) {
            notify({ kind: 'error', title: copy.sessionUnavailable, message: copy.createSessionFailed })
          }

          return false
        }

        // A successful create re-homes selection + route to the chat it just
        // minted, so the pre-create baseline can't tell our own re-home from
        // a user switch (judging it drift aborted EVERY first send of a new
        // chat: no prompt.submit, no DB row, a stranded route that 404s
        // "Session not found"). The drift signal for this window is the
        // active ref instead: every switch path re-nulls or retargets it
        // synchronously, so it only still equals the id create returned when
        // nobody re-homed since.
        if (activeSessionIdRef.current !== sessionId) {
          return abortForSessionSwitch(sessionId)
        }

        // Re-pin the baseline to the created chat for the rest of the
        // pipeline; the closures (seedOptimistic et al) see the new value.
        startingStoredSessionId = selectedStoredSessionIdRef.current
        startingRouteToken = getRouteToken()

        seedOptimistic(sessionId)
      }

      // Past this point `sessionId` is a runtime id, possibly one the backend
      // has since dropped (sleep/wake, a reconnect's orphan reap, a restart).
      const submitParams = (targetId: string, text: string) => ({
        session_id: targetId,
        text,
        ...(interrupted && { interrupted }),
        // A queue drain is a "run after" message, never a live-turn
        // correction. The flag tells the gateway's busy path to hold it for
        // the next turn untouched — without it, losing the settle race
        // (client saw idle, server still unwinding) redirects or interrupts
        // the live turn with text the user explicitly queued.
        ...(options?.fromQueue && { queued: true })
      })

      // What the last attempt staged against which runtime, so a retry on the
      // SAME runtime (a timed-out submit) never attaches an image twice.
      let staged: { attachments: ComposerAttachment[]; runtimeId: string } | null = null
      let submitting = false

      // Stage the attachments on `targetId`, then submit. Staging is part of
      // the send: image/file attach is a session-scoped RPC too, and a dead
      // runtime fails it with "session not found" before prompt.submit is
      // ever reached — recovery has to cover both.
      const sendTo = async (targetId: string, pending: ComposerAttachment[]): Promise<boolean> => {
        submitting = false

        const syncedAttachments = await syncAttachmentsForSubmit(targetId, pending, {
          updateComposerAttachments: usingComposerAttachments
        })

        staged = { attachments: syncedAttachments, runtimeId: targetId }

        const attachmentsDrift = sessionDriftReason()

        if (attachmentsDrift) {
          console.warn('[submit-drift-abort]', attachmentsDrift, { phase: 'post-attachments' })

          return false
        }

        // Rewrite the optimistic message + prompt text with the synced refs so
        // the gateway receives @file: paths that resolve in its workspace.
        // (Images keep their inline base64 preview — see optimisticAttachmentRef.)
        attachmentRefs = syncedAttachments.map(optimisticAttachmentRef).filter((r): r is string => Boolean(r))
        rewriteOptimistic(targetId)
        const text = buildContextText(syncedAttachments)

        submitting = true
        await withSessionBusyRetry(() =>
          requestGateway('prompt.submit', submitParams(targetId, text), PROMPT_SUBMIT_REQUEST_TIMEOUT_MS)
        )

        return true
      }

      try {
        let sent: boolean

        try {
          sent = await sendTo(sessionId, attachments)
        } catch (firstErr) {
          // On sleep/wake or after a reconnect the gateway may no longer hold
          // the runtime this window still names. Rebind the stored
          // conversation to a live runtime — carrying the transcript, this
          // turn's optimistic prompt and every surface showing the dead id —
          // then stage and submit again, once. Timeouts recover the same way,
          // but only at the submit itself: a starved backend loop (#55578
          // symptom d) rejects the submit even though the stored session is
          // fine, whereas a slow upload is not a dead session.
          const recoverStoredSessionId = targetStoredSessionId ?? selectedStoredSessionIdRef.current
          const recoverable = isSessionNotFoundError(firstErr) || (submitting && isGatewayTimeoutError(firstErr))

          if (!recoverable || !recoverStoredSessionId) {
            throw firstErr
          }

          const staleRuntimeId = sessionId
          const recoveredId = await recoverSessionRuntime(recoverStoredSessionId, staleRuntimeId)
          const resumeRetryDrift = sessionDriftReason()

          if (resumeRetryDrift) {
            console.warn('[submit-drift-abort]', resumeRetryDrift, { phase: 'post-resume-retry' })

            return abortForSessionSwitch(recoveredId ?? staleRuntimeId)
          }

          if (!recoveredId) {
            throw firstErr
          }

          sessionId = recoveredId

          if (targetIsCurrentView() && activeSessionIdRef.current !== recoveredId) {
            activeSessionIdRef.current = recoveredId
            scope.bindRuntime(recoveredId)
          }

          // Idempotent: re-asserts the prompt row and the turn's busy state on
          // the live runtime, whatever reached it from the dead one.
          seedOptimistic(recoveredId)

          const lastStaged = staged as { attachments: ComposerAttachment[]; runtimeId: string } | null

          // Same runtime (a timed-out submit): what it staged is already there.
          // A new runtime holds none of it — stage the latest copies again.
          const retryAttachments =
            lastStaged && lastStaged.runtimeId === recoveredId
              ? lastStaged.attachments
              : usingComposerAttachments
                ? attachments.map(original => scope.readAttachments().find(a => a?.id === original.id) ?? original)
                : attachments

          sent = await sendTo(recoveredId, retryAttachments)
        }

        if (!sent) {
          return abortForSessionSwitch(sessionId)
        }

        if (usingComposerAttachments) {
          scope.clearAttachments()
        }

        // Submit landed — the turn now runs (busy stays true), but the submit
        // window is closed, so release the lock for the next (sequential) send.
        releaseSubmitLock()

        return true
      } catch (err) {
        releaseBusy()

        // A queued drain that raced a not-yet-settled turn gets a transient
        // "session busy" (4009). Don't surface an error bubble/toast — the entry
        // stays queued and the composer's bounded auto-drain retries when idle.
        if (options?.fromQueue && isSessionBusyError(err)) {
          return false
        }

        const message = inlineErrorMessage(err, copy.promptFailed)

        updateSessionState(
          sessionId,
          state => ({
            ...state,
            messages: [
              ...state.messages,
              {
                id: `assistant-error-${Date.now()}`,
                role: 'assistant',
                parts: [],
                error: message || copy.promptFailed,
                branchGroupId: state.pendingBranchGroup ?? undefined
              }
            ],
            busy: false,
            awaitingResponse: false,
            pendingBranchGroup: null,
            sawAssistantPayload: true
          }),
          targetStoredSessionId
        )

        if (targetIsCurrentView() && isProviderSetupError(err)) {
          requestDesktopOnboarding(copy.providerCredentialRequired)

          return false
        }

        if (targetIsCurrentView()) {
          notifyError(err, copy.promptFailed)
        }

        return false
      }
    },
    [
      activeSessionIdRef,
      busyRef,
      copy,
      createBackendSessionForSend,
      getRoutedStoredSessionId,
      getRuntimeIdForStoredSession,
      getRouteToken,
      recoverSessionRuntime,
      requestGateway,
      resumeStoredSession,
      scope,
      selectedStoredSessionIdRef,
      syncAttachmentsForSubmit,
      updateSessionState
    ]
  )
}
