import { useEffect, useRef, useState, type PointerEvent } from 'react'
import {
  extractClaimFromText,
  extractSpokenNightStoryFromText,
  formatSpokenNightStoryClaim,
} from '../ai/agent/claimLedger'
import { extractSpokenReply } from '../ai/agent/dayReply'
import { splitSentencesWithOffsets } from '../ai/agent/spokenText'
import { resolveContextLimit, formatTokenCount, contextUsageRatio } from '../ai/contextWindow'
import { setContextLimitOnly } from '../ai/contextUsageStore'
import { checkAiLobbySetup } from '../ai/readiness'
import { useAiStore } from '../ai/useAiStore'
import { useContextUsage } from '../ai/useContextUsage'
import {
  getBrowserTtsProgress,
  isBrowserTtsSpeaking,
  seekBrowserTts,
  subscribeBrowserTtsProgress,
  subscribeBrowserTtsSpeaking,
  type BrowserTtsProgress,
} from '../game/browserTts'
import {
  scoreNightStoryTruthfulness,
  scoreRoleClaimTruthfulness,
  truthfulnessLabel,
  truthfulnessScoreClass,
} from '../game/claimTruthfulness'
import type { SessionSnapshot } from '../net/protocol'
import { sessionChatLive } from '../session/chatLive'
import type { ClientId } from '../session/types'

/** Press longer than this on Send to start hold-to-talk instead of submit. */
const SEND_HOLD_MS = 220

type SpeechRecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null
  onerror: ((ev: { error?: string }) => void) | null
  onend: (() => void) | null
}

type SpeechRecognitionEventLike = {
  results: { [i: number]: { [j: number]: { transcript: string }; isFinal: boolean }; length: number }
}

type Props = {
  snapshot: SessionSnapshot
  localClientId: ClientId | null
  /** Submit a finished utterance (typed or STT draft). Any human player. */
  onTranscript?: (text: string) => void
  /** Host-only, lobby only: wipe shared lobby chat. */
  onClearChat?: () => void
  /** Host-only: abort the AI reply chain and release the chat floor. */
  onStopTts?: () => void
  /** Host-only: silence current TTS without aborting the reply chain. */
  onSilenceTts?: () => void
  /** Lobby: open Settings so the host can wire providers / model configs. */
  onOpenAiSetup?: (section: 'aiProviders' | 'aiModels') => void
  disabled?: boolean
}

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike
    webkitSpeechRecognition?: new () => SpeechRecognitionLike
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

function displayChatText(text: string, streaming?: boolean): string {
  if (streaming && !text.trim()) return ''
  if (streaming) return text.trim()
  return extractSpokenReply(text) || text
}

function normalizeSpoken(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function lineMatchesTts(
  lineText: string,
  fromId: string | undefined,
  via: string | undefined,
  progress: BrowserTtsProgress,
): boolean {
  if (!progress.speaking || !progress.text) return false
  if (progress.speakerId && fromId && progress.speakerId !== fromId) return false
  // Narrator TTS has no speakerId — only match narrator bubbles.
  if (!progress.speakerId && via !== 'narrator') return false
  const spoken = normalizeSpoken(displayChatText(lineText))
  const tts = normalizeSpoken(progress.text)
  return spoken === tts || spoken.startsWith(tts) || tts.startsWith(spoken)
}

function joinUtterance(existing: string, spoken: string): string {
  const base = existing.trimEnd()
  const next = spoken.trim()
  if (!next) return existing
  if (!base) return next
  return `${base} ${next}`
}

export function DayChatPanel({
  snapshot,
  localClientId,
  onTranscript,
  onClearChat,
  onStopTts,
  onSilenceTts,
  onOpenAiSetup,
  disabled,
}: Props) {
  const lines = snapshot.chatLines ?? []
  const aiStore = useAiStore()
  const contextUsage = useContextUsage()
  const lobbySetup = checkAiLobbySetup(aiStore)
  const workConfig = aiStore.activeWorkConfigId
    ? aiStore.modelConfigs.find((c) => c.id === aiStore.activeWorkConfigId)
    : null
  const workProvider = workConfig
    ? aiStore.providers.find((p) => p.id === workConfig.providerId)
    : null
  const workModel = workConfig?.modelId.trim() || ''
  const workLabel = workConfig?.label.trim() || ''
  const chatModelLabel = workModel
    ? workLabel && workLabel.toLowerCase() !== workModel.toLowerCase()
      ? `${workLabel} · ${workModel}`
      : workModel
    : workLabel || null

  useEffect(() => {
    if (!workConfig || !workProvider || !workConfig.modelId.trim()) return
    let cancelled = false
    void resolveContextLimit(workProvider, workConfig).then((limit) => {
      if (cancelled) return
      setContextLimitOnly({
        limit,
        modelId: workConfig.modelId.trim(),
        configId: workConfig.id,
      })
    })
    return () => {
      cancelled = true
    }
  }, [
    workConfig?.id,
    workConfig?.modelId,
    workConfig?.numCtx,
    workConfig?.providerId,
    workProvider?.id,
    workProvider?.transport,
    workProvider?.baseUrl,
  ])

  const usageForWork =
    contextUsage &&
    workConfig &&
    contextUsage.configId === workConfig.id
      ? contextUsage
      : null
  const usagePct = usageForWork
    ? Math.round(contextUsageRatio(usageForWork.used, usageForWork.limit) * 100)
    : null
  const listRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const stickToBottomRef = useRef(true)
  const [listening, setListening] = useState(false)
  const [ttsSpeaking, setTtsSpeaking] = useState(() => isBrowserTtsSpeaking())
  const [ttsProgress, setTtsProgress] = useState<BrowserTtsProgress>(() =>
    getBrowserTtsProgress(),
  )
  const [interim, setInterim] = useState('')
  const [draft, setDraft] = useState('')
  const [queuedText, setQueuedText] = useState<string | null>(null)
  const [composeFocused, setComposeFocused] = useState(false)
  const [sttError, setSttError] = useState<string | null>(null)
  const recRef = useRef<SpeechRecognitionLike | null>(null)
  const finalRef = useRef('')
  const interimRef = useRef('')
  const holdTimerRef = useRef<number | null>(null)
  const holdArmedRef = useRef(false)
  const flushQueuedRef = useRef(false)
  const queuedTextRef = useRef<string | null>(null)
  queuedTextRef.current = queuedText

  const resizeTextarea = () => {
    const el = textareaRef.current
    if (!el) return
    // Idle: keep a single line; expand height only while focused.
    if (!composeFocused) {
      el.style.height = ''
      return
    }
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }

  useEffect(() => {
    const el = listRef.current
    if (!el || !stickToBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [
    lines.length,
    interim,
    queuedText,
    ttsProgress.sentenceIndex,
    ttsProgress.loading,
  ])

  useEffect(() => {
    resizeTextarea()
  }, [draft, composeFocused])

  const stopPtt = () => {
    try {
      recRef.current?.stop()
    } catch {
      // ignore
    }
  }

  const clearHoldTimer = () => {
    if (holdTimerRef.current == null) return
    window.clearTimeout(holdTimerRef.current)
    holdTimerRef.current = null
  }

  useEffect(() => {
    return subscribeBrowserTtsSpeaking(setTtsSpeaking)
  }, [])

  useEffect(() => {
    return subscribeBrowserTtsProgress(setTtsProgress)
  }, [])

  useEffect(() => {
    return () => {
      clearHoldTimer()
      try {
        recRef.current?.stop()
      } catch {
        // ignore
      }
    }
  }, [])

  const floorLocked = Boolean(snapshot.chatLocked)
  /** Typing stays available while AI holds the floor; only hard-disable for props/mic. */
  const composeInputBlocked = Boolean(disabled) || listening
  const canInterrupt =
    floorLocked && Boolean(onStopTts || onSilenceTts)
  const interruptAction: 'abort' | 'stopSpeaking' | null = !canInterrupt
    ? null
    : ttsSpeaking
      ? 'stopSpeaking'
      : 'abort'
  const primaryAction: 'send' | 'queue' | 'listening' = listening
    ? 'listening'
    : floorLocked
      ? 'queue'
      : 'send'

  const runInterrupt = () => {
    if (interruptAction === 'stopSpeaking') {
      ;(onSilenceTts ?? onStopTts)?.()
      return
    }
    if (interruptAction === 'abort') {
      onStopTts?.()
    }
  }

  // Drop hold-to-talk if the floor locks (Send → Queue) or compose hard-disables.
  useEffect(() => {
    if ((!floorLocked && !composeInputBlocked) || !listening) return
    clearHoldTimer()
    holdArmedRef.current = false
    stopPtt()
  }, [floorLocked, composeInputBlocked, listening])

  const queueDraft = () => {
    if (!floorLocked || listening || !onTranscript || Boolean(disabled)) return
    const text = draft.trim()
    if (!text) return
    setQueuedText(text)
    setDraft('')
    requestAnimationFrame(resizeTextarea)
  }

  const submitDraft = () => {
    if (floorLocked || listening || !onTranscript || Boolean(disabled)) return
    const text = draft.trim()
    if (!text) return
    onTranscript(text)
    setDraft('')
    requestAnimationFrame(resizeTextarea)
  }

  const runPrimaryAction = () => {
    if (primaryAction === 'listening') return
    if (primaryAction === 'queue') {
      queueDraft()
      return
    }
    submitDraft()
  }

  // When the AI floor unlocks, submit the local queued message once.
  useEffect(() => {
    if (floorLocked) {
      flushQueuedRef.current = false
      return
    }
    const pending = queuedTextRef.current
    if (!pending || !onTranscript || flushQueuedRef.current) return
    flushQueuedRef.current = true
    setQueuedText(null)
    onTranscript(pending)
  }, [floorLocked, onTranscript, queuedText])

  const onSendPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (primaryAction !== 'send' || !onTranscript || Boolean(disabled)) return
    e.preventDefault()
    holdArmedRef.current = false
    clearHoldTimer()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // ignore
    }
    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null
      holdArmedRef.current = true
      startPtt()
    }, SEND_HOLD_MS)
  }

  const onSendPointerEnd = () => {
    if (primaryAction !== 'send') return
    const wasHold = holdArmedRef.current || listening
    const holdPending = holdTimerRef.current != null
    clearHoldTimer()
    if (wasHold) {
      holdArmedRef.current = false
      stopPtt()
      return
    }
    holdArmedRef.current = false
    // Short press (timer never fired) → send typed draft.
    if (holdPending) submitDraft()
  }

  const startPtt = () => {
    if (floorLocked || Boolean(disabled) || !onTranscript) return
    const Ctor = getSpeechRecognition()
    if (!Ctor) {
      setSttError('Speech recognition not supported in this browser.')
      return
    }
    setSttError(null)
    finalRef.current = ''
    interimRef.current = ''
    setInterim('')
    const rec = new Ctor()
    rec.lang = 'en-US'
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = (ev) => {
      // Rebuild from the full result list — continuous sessions re-emit priors.
      let finalText = ''
      let interimText = ''
      for (let i = 0; i < ev.results.length; i++) {
        const r = ev.results[i]!
        const t = r[0]?.transcript ?? ''
        if (r.isFinal) finalText += t
        else interimText += t
      }
      finalRef.current = finalText
      interimRef.current = interimText
      setInterim(`${finalText} ${interimText}`.replace(/\s+/g, ' ').trim())
    }
    rec.onerror = (ev) => {
      setSttError(ev.error ?? 'STT error')
      setListening(false)
    }
    rec.onend = () => {
      setListening(false)
      const spoken = `${finalRef.current} ${interimRef.current}`.replace(/\s+/g, ' ').trim()
      interimRef.current = ''
      setInterim('')
      if (!spoken) return
      setDraft((prev) => joinUtterance(prev, spoken))
      requestAnimationFrame(() => {
        resizeTextarea()
        textareaRef.current?.focus()
      })
    }
    recRef.current = rec
    try {
      rec.start()
      setListening(true)
    } catch {
      setSttError('Could not start microphone.')
    }
  }

  const inLobby = snapshot.phase === 'lobby'
  const gamePhase = snapshot.game?.phase
  const chatLive = sessionChatLive({
    phase: snapshot.phase,
    gamePhase,
  })
  // Watch-game spectators observe only — no typed / mic table talk mid-round.
  const spectatorWatching =
    Boolean(snapshot.watchMode) && snapshot.phase === 'playing'
  const canCompose = chatLive && !!onTranscript && !spectatorWatching
  const awaitingDay =
    !chatLive &&
    (gamePhase === 'claiming' ||
      gamePhase === 'night' ||
      gamePhase === 'dawn')
  const localName =
    (localClientId
      ? snapshot.players.find((p) => p.id === localClientId)?.name
      : null) || 'You'
  const respondingName = snapshot.chatRespondingId
    ? snapshot.players.find((p) => p.id === snapshot.chatRespondingId)?.name
    : null
  const turnStatus = floorLocked
    ? respondingName
      ? `${respondingName} is responding…`
      : 'Waiting for replies…'
    : null
  const needsAiSetup = inLobby && !lobbySetup.ready
  const showClear = canCompose && inLobby && Boolean(onClearChat)

  let liveTtsLineId: string | null = null
  if (ttsProgress.speaking && ttsProgress.text) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!
      if (line.streaming) continue
      if (lineMatchesTts(line.text, line.fromId, line.via, ttsProgress)) {
        liveTtsLineId = line.id
        break
      }
    }
  }

  return (
    <div className="day-chat-panel">
      {showClear && onClearChat && (
        <div className="day-chat-header">
          <div className="day-chat-header-actions">
            <button
              type="button"
              className="btn tiny"
              disabled={
                Boolean(disabled) ||
                listening ||
                (lines.length === 0 && !draft.trim() && !queuedText)
              }
              onClick={() => {
                onClearChat()
                setDraft('')
                setQueuedText(null)
                requestAnimationFrame(resizeTextarea)
              }}
            >
              Clear
            </button>
          </div>
        </div>
      )}
      {turnStatus && (
        <p className="day-chat-turn-status" role="status" aria-live="polite">
          {turnStatus}
        </p>
      )}
      {awaitingDay && (
        <p className="day-chat-turn-status" role="status">
          Table talk opens at daybreak.
        </p>
      )}
      <div
        ref={listRef}
        className="day-chat-lines"
        onScroll={() => {
          const el = listRef.current
          if (!el) return
          stickToBottomRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 56
        }}
      >
        {needsAiSetup && (
          <div className="day-chat-line system" role="status">
            <span className="day-chat-name">Setup required</span>
            <span className="day-chat-text">
              {!lobbySetup.hasProviders
                ? "This game won't work without an AI model. Connect a local provider (like Ollama) or a remote API under Settings → AI providers, add a model config, then seat AI players at your table under Settings → AI players."
                : 'Assign a chat model and a classifier model under Settings → AI model configs (Use for chat / Use as classifier, with a model id on each), then seat AI players under Settings → AI players.'}
            </span>
            {onOpenAiSetup && (
              <button
                type="button"
                className="btn tiny day-chat-setup-btn"
                onClick={() =>
                  onOpenAiSetup(
                    lobbySetup.hasProviders ? 'aiModels' : 'aiProviders',
                  )
                }
              >
                {lobbySetup.hasProviders
                  ? 'Open AI model configs'
                  : 'Open AI providers'}
              </button>
            )}
          </div>
        )}
        {lines.map((l) => {
          const thinking = Boolean(l.streaming) && !l.text.trim()
          const spoken = displayChatText(l.text, l.streaming)
          const liveTts = liveTtsLineId === l.id
          const sentences =
            liveTts && ttsProgress.text
              ? splitSentencesWithOffsets(ttsProgress.text)
              : null
          const finishedTalk =
            l.via !== 'system' && l.via !== 'narrator' && !l.streaming
          const statedClaim = finishedTalk
            ? extractClaimFromText(l.text)
            : null
          const nightStory =
            finishedTalk && spectatorWatching
              ? extractSpokenNightStoryFromText(
                  l.text,
                  snapshot.players,
                  l.fromId,
                  l.name,
                )
              : null
          const roleTruth =
            spectatorWatching && statedClaim && snapshot.game
              ? scoreRoleClaimTruthfulness(
                  statedClaim,
                  l.fromId,
                  snapshot.game,
                )
              : null
          const storyTruth =
            nightStory && snapshot.game
              ? scoreNightStoryTruthfulness(
                  nightStory,
                  snapshot.game.nightActions,
                )
              : null
          return (
            <div
              key={l.id}
              className={`day-chat-line${l.fromId === localClientId ? ' mine' : ''}${l.via === 'agent' ? ' agent' : ''}${l.via === 'system' ? ' system' : ''}${l.via === 'narrator' ? ' narrator' : ''}${l.streaming ? ' streaming' : ''}${thinking ? ' thinking' : ''}${liveTts ? ' tts-live' : ''}`}
            >
              <span className="day-chat-name">{l.name}</span>
              <span className="day-chat-text">
                {thinking ? (
                  <span
                    className="day-chat-thinking"
                    aria-label={`${l.name} is thinking`}
                  >
                    <span className="day-chat-thinking-dot" />
                    <span className="day-chat-thinking-dot" />
                    <span className="day-chat-thinking-dot" />
                  </span>
                ) : sentences && sentences.length > 0 ? (
                  sentences.map((s, i) => {
                    const charEnd =
                      ttsProgress.charEnd > ttsProgress.charIndex
                        ? ttsProgress.charEnd
                        : Number.POSITIVE_INFINITY
                    const active =
                      s.start < charEnd && s.end > ttsProgress.charIndex
                    const loading = active && ttsProgress.loading
                    const speaking = active && !ttsProgress.loading
                    return (
                      <button
                        key={`${l.id}-s${i}`}
                        type="button"
                        className={`day-chat-sentence${speaking ? ' speaking' : ''}${loading ? ' loading' : ''}`}
                        aria-current={active ? 'true' : undefined}
                        aria-busy={loading ? true : undefined}
                        title={
                          loading
                            ? 'Loading speech for this sentence'
                            : speaking
                              ? 'Speaking this sentence'
                              : 'Play from this sentence'
                        }
                        onClick={() => {
                          seekBrowserTts(s.start)
                        }}
                      >
                        {s.text}
                      </button>
                    )
                  })
                ) : (
                  spoken
                )}
              </span>
              {statedClaim ? (
                <span className="day-chat-claim">
                  {l.name} claimed {statedClaim}
                  {roleTruth != null ? (
                    <>
                      {' · '}
                      <span
                        className={`day-chat-claim-truth ${truthfulnessScoreClass(roleTruth)}`}
                      >
                        {truthfulnessLabel(roleTruth)}
                      </span>
                    </>
                  ) : null}
                </span>
              ) : null}
              {nightStory && storyTruth != null ? (
                <span className="day-chat-claim">
                  {l.name} claimed: {formatSpokenNightStoryClaim(nightStory)}
                  {' · '}
                  <span
                    className={`day-chat-claim-truth ${truthfulnessScoreClass(storyTruth)}`}
                  >
                    {truthfulnessLabel(storyTruth)}
                  </span>
                </span>
              ) : null}
            </div>
          )
        })}
        {interim && (
          <div className="day-chat-line interim">
            <span className="day-chat-name">…</span>
            <span className="day-chat-text">{interim}</span>
          </div>
        )}
        {queuedText && (
          <div className="day-chat-line mine queued" role="status">
            <div className="day-chat-queued-head">
              <span className="day-chat-name">
                {localName} · queued
              </span>
              <button
                type="button"
                className="day-chat-queued-dismiss"
                aria-label="Remove queued message"
                title="Remove queued message"
                onClick={() => setQueuedText(null)}
              >
                ×
              </button>
            </div>
            <span className="day-chat-text">{queuedText}</span>
          </div>
        )}
      </div>
      {sttError && <p className="hint">{sttError}</p>}
      {(canCompose || (spectatorWatching && chatLive)) && (
        <div className="day-chat-compose">
          {canCompose && (
            <div className="day-chat-compose-row">
              <textarea
                ref={textareaRef}
                className="day-chat-input"
                rows={1}
                value={draft}
                disabled={composeInputBlocked}
                placeholder={
                  floorLocked
                    ? 'Type to queue a message…'
                    : 'Type a message, or hold Send to talk…'
                }
                aria-label="Message to AI players"
                onChange={(e) => setDraft(e.target.value)}
                onFocus={() => setComposeFocused(true)}
                onBlur={() => setComposeFocused(false)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.shiftKey) return
                  e.preventDefault()
                  runPrimaryAction()
                }}
              />
              <div className="day-chat-compose-actions">
                <button
                  type="button"
                  className={`btn tiny${
                    primaryAction === 'listening' ? '' : ' primary'
                  }`}
                  disabled={
                    primaryAction === 'listening'
                      ? false
                      : Boolean(disabled) ||
                        !onTranscript ||
                        (primaryAction === 'queue' && !draft.trim())
                  }
                  title={
                    primaryAction === 'listening'
                      ? 'Release to finish talking'
                      : primaryAction === 'queue'
                        ? 'Queue message until AI finishes'
                        : 'Click to send · hold to talk'
                  }
                  onPointerDown={onSendPointerDown}
                  onPointerUp={onSendPointerEnd}
                  onPointerCancel={() => {
                    clearHoldTimer()
                    holdArmedRef.current = false
                    if (listening) stopPtt()
                  }}
                  onClick={(e) => {
                    if (primaryAction === 'send') {
                      // Pointer gestures already handled Send; keyboard activates with detail 0.
                      if (e.detail !== 0) return
                    }
                    runPrimaryAction()
                  }}
                >
                  {primaryAction === 'listening'
                    ? 'Listening…'
                    : primaryAction === 'queue'
                      ? 'Queue'
                      : 'Send'}
                </button>
                {interruptAction && (
                  <button
                    type="button"
                    className="btn tiny danger"
                    disabled={
                      interruptAction === 'stopSpeaking'
                        ? !onSilenceTts && !onStopTts
                        : !onStopTts
                    }
                    title={
                      interruptAction === 'abort'
                        ? 'Abort AI reply (Esc)'
                        : 'Stop AI voice (→)'
                    }
                    onClick={runInterrupt}
                  >
                    {interruptAction === 'abort'
                      ? 'Abort'
                      : 'Stop speaking'}
                  </button>
                )}
              </div>
            </div>
          )}
          {(chatModelLabel || usageForWork) && (
            <p className="hint day-chat-compose-hint">
              <span className="day-chat-model-row">
                {chatModelLabel ? (
                  <span className="day-chat-model">{chatModelLabel}</span>
                ) : null}
                {usageForWork ? (
                  <span
                    className={`day-chat-ctx${usagePct != null && usagePct >= 85 ? ' hot' : ''}${usageForWork.estimated ? ' estimated' : ''}`}
                    title={
                      usageForWork.estimated
                        ? 'Estimated from prompt size (provider did not return token usage)'
                        : 'Prompt tokens vs model context window'
                    }
                  >
                    <span className="day-chat-ctx-bar" aria-hidden>
                      <span
                        className="day-chat-ctx-fill"
                        style={{ width: `${usagePct ?? 0}%` }}
                      />
                    </span>
                    <span className="day-chat-ctx-label">
                      {formatTokenCount(usageForWork.used)}/
                      {formatTokenCount(usageForWork.limit)}
                      {usageForWork.estimated ? ' ≈' : ''}
                    </span>
                  </span>
                ) : null}
              </span>
            </p>
          )}
        </div>
      )}
    </div>
  )
}
