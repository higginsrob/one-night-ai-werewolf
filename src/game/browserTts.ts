/**
 * Host narrator via Web Speech.
 *
 * Chrome will wedge the entire speechSynthesis service (needs browser restart)
 * if a Google/network voice hangs. We only use local voices when available,
 * and reset the engine before each speak when it looks stuck.
 */

import { splitSentencesWithOffsets } from '../ai/agent/spokenText'
import {
  hasSavedWerewolfSettings,
  loadWerewolfSettings,
  normalizeWerewolfSettings,
  saveWerewolfSettings,
  type WerewolfHostSettings,
} from './werewolfSettings'

export type BrowserTtsHandlers = {
  onStart?: () => void
  onEnd?: () => void
  onError?: (error: string) => void
}

export type BrowserTtsProgress = {
  /** Full trimmed text for the in-flight speak session (null when idle). */
  text: string | null
  /** Player id delivering the line (null for narrator / anonymous). */
  speakerId: string | null
  /** Index of the sentence currently speaking (or next up after seek). */
  sentenceIndex: number
  /** Char offset of the active sentence/chunk start into `text`. */
  charIndex: number
  /** Exclusive end offset of the active sentence/chunk into `text`. */
  charEnd: number
  speaking: boolean
  /**
   * True while API TTS has requested audio for the active chunk but playback
   * has not started yet (fetch / decode). Browser TTS always false.
   */
  loading: boolean
}

type SpeakSession = {
  text: string
  sentences: { text: string; start: number; end: number }[]
  sentenceIndex: number
  voice: SpeechSynthesisVoice | null
  handlers: BrowserTtsHandlers
  speakerId: string | null
  gen: number
  started: boolean
}

let preferredVoiceURI: string | null = null
let unlocked = false
let keepAliveTimer: number | null = null
let speakTimer: number | null = null
/** Handlers for the in-flight or scheduled utterance (for stop before speak starts). */
let pendingHandlers: BrowserTtsHandlers | null = null
const readyListeners = new Set<(ready: boolean) => void>()
/** True while an utterance is scheduled or actively speaking. */
let speaking = false
const speakingListeners = new Set<(speaking: boolean) => void>()
/** Player id whose line is currently speaking (null for narrator / anonymous). */
let speakerId: string | null = null
const speakerListeners = new Set<(id: string | null) => void>()
/** Bumped on cancel/reset so stale utterance callbacks ignore the new turn. */
let speakGen = 0
/** Gens canceled for seek — their interrupted callbacks must not notify waiters. */
const silentCancelGens = new Set<number>()
let activeSession: SpeakSession | null = null
let progress: BrowserTtsProgress = {
  text: null,
  speakerId: null,
  sentenceIndex: 0,
  charIndex: 0,
  charEnd: 0,
  speaking: false,
  loading: false,
}
const progressListeners = new Set<(p: BrowserTtsProgress) => void>()

function setSpeaking(next: boolean): void {
  if (speaking === next) return
  speaking = next
  for (const fn of speakingListeners) fn(speaking)
  publishProgress({ speaking: next })
}

function setSpeakerId(next: string | null): void {
  const id = typeof next === 'string' && next.trim() ? next.trim() : null
  if (speakerId === id) return
  speakerId = id
  for (const fn of speakerListeners) fn(speakerId)
  publishProgress({ speakerId: id })
}

function publishProgress(patch: Partial<BrowserTtsProgress>): void {
  progress = { ...progress, ...patch }
  for (const fn of progressListeners) fn(progress)
}

function clearProgress(): void {
  publishProgress({
    text: null,
    speakerId: null,
    sentenceIndex: 0,
    charIndex: 0,
    charEnd: 0,
    speaking: false,
    loading: false,
  })
}

function syncProgressFromSession(session: SpeakSession | null): void {
  if (!session) {
    clearProgress()
    return
  }
  const sentence = session.sentences[session.sentenceIndex]
  publishProgress({
    text: session.text,
    speakerId: session.speakerId,
    sentenceIndex: session.sentenceIndex,
    charIndex: sentence?.start ?? 0,
    charEnd: sentence?.end ?? 0,
    speaking: true,
    loading: false,
  })
}

/**
 * Drive speaking / speaker UI from non-browser backends (API TTS).
 * Does not start speechSynthesis.
 */
export function setBrowserTtsExternalPlayback(
  nextSpeaking: boolean,
  nextSpeakerId: string | null,
  progressPatch?: Partial<BrowserTtsProgress>,
): void {
  setSpeaking(nextSpeaking)
  setSpeakerId(nextSpeakerId)
  if (progressPatch) {
    publishProgress({
      ...progress,
      speaking: nextSpeaking,
      speakerId: nextSpeakerId,
      ...progressPatch,
    })
  } else if (!nextSpeaking) {
    clearProgress()
  }
}

export function isBrowserTtsSpeaking(): boolean {
  return speaking
}

export function getBrowserTtsSpeakerId(): string | null {
  return speakerId
}

export function getBrowserTtsProgress(): BrowserTtsProgress {
  return progress
}

export function subscribeBrowserTtsSpeaking(
  fn: (speaking: boolean) => void,
): () => void {
  speakingListeners.add(fn)
  fn(speaking)
  return () => {
    speakingListeners.delete(fn)
  }
}

export function subscribeBrowserTtsSpeaker(
  fn: (id: string | null) => void,
): () => void {
  speakerListeners.add(fn)
  fn(speakerId)
  return () => {
    speakerListeners.delete(fn)
  }
}

export function subscribeBrowserTtsProgress(
  fn: (p: BrowserTtsProgress) => void,
): () => void {
  progressListeners.add(fn)
  fn(progress)
  return () => {
    progressListeners.delete(fn)
  }
}

// Hydrate before first speak (settings modal / night may load later).
if (typeof window !== 'undefined') {
  preferredVoiceURI = loadWerewolfSettings().voiceURI
}

export function isBrowserTtsReady(): boolean {
  return unlocked
}

export function setBrowserTtsVoiceURI(voiceURI: string | null): void {
  preferredVoiceURI =
    typeof voiceURI === 'string' && voiceURI.trim() ? voiceURI.trim() : null
}

export function getBrowserTtsVoiceURI(): string | null {
  return preferredVoiceURI
}

export function listBrowserTtsVoices(): SpeechSynthesisVoice[] {
  if (typeof window === 'undefined' || !window.speechSynthesis) return []
  return window.speechSynthesis.getVoices()
}

export function subscribeBrowserTtsReady(
  fn: (ready: boolean) => void,
): () => void {
  readyListeners.add(fn)
  fn(unlocked)
  return () => {
    readyListeners.delete(fn)
  }
}

function markReady(): void {
  if (unlocked) return
  unlocked = true
  for (const fn of readyListeners) fn(true)
}

export function markBrowserTtsUnlocked(): void {
  markReady()
}

export function warmBrowserTtsVoices(): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) return
  void window.speechSynthesis.getVoices()
}

export function isNetworkVoice(voice: SpeechSynthesisVoice): boolean {
  return !voice.localService || /^google\b/i.test(voice.name)
}

/** Chrome’s bundled Google TTS voices (name prefix “Google …”). */
export function isGoogleVoice(voice: SpeechSynthesisVoice): boolean {
  return /^google\b/i.test(voice.name)
}

/** Preferred stock narrator when no voiceURI is saved (macOS / some browsers). */
export const DEFAULT_NARRATOR_VOICE_NAME = 'Rishi'

export function findBrowserTtsVoiceByName(
  name: string,
  voices: SpeechSynthesisVoice[] = listBrowserTtsVoices(),
): SpeechSynthesisVoice | null {
  const needle = name.trim().toLowerCase()
  if (!needle) return null
  return (
    voices.find((v) => v.name.trim().toLowerCase() === needle) ??
    voices.find((v) => v.name.trim().toLowerCase().startsWith(needle)) ??
    null
  )
}

/**
 * All browser voices for pickers (Chrome’s full Google set is multi-language).
 * Sort: Google voices first, then English, then by name.
 * Auto still prefers Rishi / local English in pickBrowserTtsVoice.
 */
export function listUsableBrowserTtsVoices(
  voices: SpeechSynthesisVoice[] = listBrowserTtsVoices(),
): SpeechSynthesisVoice[] {
  return [...voices].sort((a, b) => {
    const aGoogle = isGoogleVoice(a) ? 0 : 1
    const bGoogle = isGoogleVoice(b) ? 0 : 1
    if (aGoogle !== bGoogle) return aGoogle - bGoogle
    const aEn = /^en(-|_)/i.test(a.lang) ? 0 : 1
    const bEn = /^en(-|_)/i.test(b.lang) ? 0 : 1
    if (aEn !== bEn) return aEn - bEn
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

/**
 * Resolve a voice. Explicit voiceURI (including Google/network) is honored.
 * Auto / missing URI prefers Rishi, then local English so Chrome doesn’t
 * default to a flaky network voice.
 */
export function pickBrowserTtsVoice(
  voiceURI: string | null = preferredVoiceURI,
): SpeechSynthesisVoice | null {
  const voices = listBrowserTtsVoices()
  if (voices.length === 0) return null

  const locals = voices.filter((v) => !isNetworkVoice(v))
  const localEn = locals.filter((v) => /^en(-|_)/i.test(v.lang))

  if (voiceURI) {
    const match = voices.find((v) => v.voiceURI === voiceURI)
    if (match) return match
  }

  return (
    findBrowserTtsVoiceByName(DEFAULT_NARRATOR_VOICE_NAME, voices) ??
    localEn[0] ??
    locals[0] ??
    voices.find((v) => /^en(-|_)/i.test(v.lang) && !isNetworkVoice(v)) ??
    voices.find((v) => /^en(-|_)/i.test(v.lang)) ??
    voices[0] ??
    null
  )
}

/**
 * On first launch (no saved settings), pin the narrator to Rishi when the
 * browser exposes that voice. No-op once the user has any saved prefs.
 */
export function seedDefaultNarratorVoiceIfNeeded(
  voices: SpeechSynthesisVoice[] = listBrowserTtsVoices(),
): WerewolfHostSettings {
  const settings = loadWerewolfSettings()
  if (hasSavedWerewolfSettings()) return settings
  if (voices.length === 0) return settings
  const rishi = findBrowserTtsVoiceByName(DEFAULT_NARRATOR_VOICE_NAME, voices)
  if (!rishi) return settings
  const next = normalizeWerewolfSettings({
    ...settings,
    voiceURI: rishi.voiceURI,
  })
  saveWerewolfSettings(next)
  setBrowserTtsVoiceURI(next.voiceURI)
  preferredVoiceURI = next.voiceURI
  return next
}

function stopKeepAlive(): void {
  if (keepAliveTimer != null) {
    window.clearInterval(keepAliveTimer)
    keepAliveTimer = null
  }
}

function clearSpeakTimer(): void {
  if (speakTimer != null) {
    window.clearTimeout(speakTimer)
    speakTimer = null
  }
}

function startKeepAlive(synth: SpeechSynthesis): void {
  stopKeepAlive()
  keepAliveTimer = window.setInterval(() => {
    try {
      if (!synth.speaking) {
        stopKeepAlive()
        return
      }
      synth.pause()
      synth.resume()
    } catch {
      stopKeepAlive()
    }
  }, 12_000)
}

/**
 * Unstick Chrome's speechSynthesis after a hung utterance.
 * Call from a user click, then speak on the next tick (not same turn as cancel).
 */
export function resetBrowserTts(): void {
  speakGen += 1
  stopKeepAlive()
  clearSpeakTimer()
  activeSession = null
  pendingHandlers = null
  setSpeaking(false)
  setSpeakerId(null)
  clearProgress()
  if (typeof window === 'undefined' || !window.speechSynthesis) return
  const synth = window.speechSynthesis
  try {
    synth.cancel()
  } catch {
    // ignore
  }
  try {
    synth.resume()
  } catch {
    // ignore
  }
}

/** Cancel the current utterance without ending the speak session (for seek). */
function softCancelUtterance(): void {
  const synth =
    typeof window !== 'undefined' ? window.speechSynthesis : undefined
  // Only silence interrupted callbacks when an utterance is actually running.
  if (synth?.speaking) silentCancelGens.add(speakGen)
  speakGen += 1
  stopKeepAlive()
  clearSpeakTimer()
  if (!synth) return
  try {
    synth.cancel()
  } catch {
    // ignore
  }
  try {
    synth.resume()
  } catch {
    // ignore
  }
}

function makeUtterance(
  text: string,
  voice: SpeechSynthesisVoice | null,
): SpeechSynthesisUtterance {
  const u = new SpeechSynthesisUtterance(text)
  u.rate = 0.95
  u.pitch = 1
  u.volume = 1
  if (voice) {
    u.voice = voice
    u.lang = voice.lang || 'en-US'
  } else {
    u.lang = 'en-US'
  }
  return u
}

function clearPendingHandlers(): BrowserTtsHandlers | null {
  const handlers = pendingHandlers
  pendingHandlers = null
  return handlers
}

function finishSession(
  session: SpeakSession,
  how: 'end' | 'error',
  error?: string,
): void {
  if (activeSession !== session) return
  activeSession = null
  stopKeepAlive()
  clearSpeakTimer()
  setSpeaking(false)
  setSpeakerId(null)
  clearProgress()
  if (pendingHandlers === session.handlers) clearPendingHandlers()
  if (how === 'error' && error) {
    session.handlers.onError?.(error)
    if (error === 'interrupted' || error === 'canceled') return
  }
  session.handlers.onEnd?.()
}

function speakSessionSentence(session: SpeakSession): void {
  if (activeSession !== session) return
  if (session.sentenceIndex >= session.sentences.length) {
    finishSession(session, 'end')
    return
  }

  const piece = session.sentences[session.sentenceIndex]!
  syncProgressFromSession(session)
  const gen = speakGen
  session.gen = gen
  const synth = window.speechSynthesis
  const u = makeUtterance(piece.text, session.voice)
  const stillCurrent = () => gen === speakGen && activeSession === session

  u.onstart = () => {
    if (!stillCurrent()) return
    markReady()
    setSpeaking(true)
    startKeepAlive(synth)
    if (!session.started) {
      session.started = true
      session.handlers.onStart?.()
    }
    try {
      if (synth.paused) synth.resume()
    } catch {
      // ignore
    }
  }
  u.onend = () => {
    if (!stillCurrent()) return
    stopKeepAlive()
    session.sentenceIndex += 1
    if (session.sentenceIndex >= session.sentences.length) {
      finishSession(session, 'end')
      return
    }
    // Gap helps Chrome recover between short utterances.
    const advanceGen = speakGen
    speakTimer = window.setTimeout(() => {
      speakTimer = null
      if (activeSession !== session || speakGen !== advanceGen) return
      speakSessionSentence(session)
    }, 40)
  }
  u.onerror = (ev) => {
    const code =
      typeof SpeechSynthesisErrorEvent !== 'undefined' &&
      ev instanceof SpeechSynthesisErrorEvent
        ? ev.error
        : 'failed'
    if (!stillCurrent()) {
      if (silentCancelGens.has(gen)) {
        silentCancelGens.delete(gen)
        return
      }
      // Superseded by a newer speak/reset — notify waiters only.
      if (code === 'interrupted' || code === 'canceled') {
        session.handlers.onError?.(code)
      }
      return
    }
    stopKeepAlive()
    clearSpeakTimer()
    if (code === 'interrupted' || code === 'canceled') {
      finishSession(session, 'error', code)
      return
    }
    finishSession(session, 'error', code)
  }

  try {
    if (synth.paused) synth.resume()
    synth.speak(u)
    window.setTimeout(() => {
      try {
        if (synth.paused) synth.resume()
      } catch {
        // ignore
      }
    }, 50)
  } catch (e) {
    if (!stillCurrent()) return
    finishSession(
      session,
      'error',
      e instanceof Error ? e.message : 'failed',
    )
  }
}

function sentenceIndexForChar(
  sentences: { start: number; end: number }[],
  charIndex: number,
): number {
  if (sentences.length === 0) return 0
  const clamped = Math.max(0, charIndex)
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i]!
    if (clamped < s.end) return i
  }
  return sentences.length - 1
}

/**
 * Rewind the in-flight speak session to a character offset (snapped to a
 * sentence). Returns false when nothing is speaking.
 */
export function seekBrowserTts(charIndex: number): boolean {
  const session = activeSession
  if (!session || session.sentences.length === 0) return false
  const nextIndex = sentenceIndexForChar(session.sentences, charIndex)
  softCancelUtterance()
  session.sentenceIndex = nextIndex
  session.gen = speakGen
  setSpeaking(true)
  setSpeakerId(session.speakerId)
  syncProgressFromSession(session)
  pendingHandlers = session.handlers
  speakTimer = window.setTimeout(() => {
    speakTimer = null
    if (activeSession !== session) return
    speakSessionSentence(session)
  }, 80)
  return true
}

/**
 * Speak text from a click handler.
 * Resets a stuck engine first (and before Google/network voices), then speaks
 * on the next tick. Long lines are spoken sentence-by-sentence so the
 * transcript can highlight / seek.
 */
export function speakBrowserTts(
  text: string,
  opts?: BrowserTtsHandlers & {
    voiceURI?: string | null
    /** Seat/player currently delivering this line (highlights their card). */
    speakerId?: string | null
  },
): void {
  const trimmed = text.trim()
  if (!trimmed) {
    opts?.onEnd?.()
    return
  }
  // Master mute lives on the TTS store; browserTtsEnabled stays synced for legacy.
  if (!loadWerewolfSettings().browserTtsEnabled) {
    opts?.onEnd?.()
    return
  }
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    opts?.onError?.('unsupported')
    opts?.onEnd?.()
    return
  }

  void window.speechSynthesis.getVoices()
  const voice = pickBrowserTtsVoice(
    opts?.voiceURI !== undefined ? opts.voiceURI : preferredVoiceURI,
  )

  // Always cancel + gap before speak. Chrome wedges if speak lands in the same
  // turn as cancel (skip role, pause/resume, network voices, stuck engine).
  // If a prior speak was only scheduled (not started), notify it — cancel()
  // alone will not fire utterance onerror.
  const replacedPending = speakTimer != null
  const previous = pendingHandlers
  // Timer / not-yet-started sessions never get utterance onerror from cancel().
  const needsManualCancel =
    replacedPending || (activeSession != null && !activeSession.started)
  resetBrowserTts()
  if (needsManualCancel) {
    previous?.onError?.('canceled')
  }

  const handlers: BrowserTtsHandlers = {
    onStart: opts?.onStart,
    onEnd: opts?.onEnd,
    onError: opts?.onError,
  }
  pendingHandlers = handlers
  const sentences = splitSentencesWithOffsets(trimmed)
  const session: SpeakSession = {
    text: trimmed,
    sentences: sentences.length > 0 ? sentences : [{ text: trimmed, start: 0, end: trimmed.length }],
    sentenceIndex: 0,
    voice,
    handlers,
    speakerId: opts?.speakerId ?? null,
    gen: speakGen,
    started: false,
  }
  activeSession = session
  setSpeakerId(session.speakerId)
  setSpeaking(true)
  syncProgressFromSession(session)
  const gen = speakGen
  speakTimer = window.setTimeout(() => {
    speakTimer = null
    if (gen !== speakGen || activeSession !== session) return
    speakSessionSentence(session)
  }, 80)
}

/**
 * Cancel current/scheduled speech. Resolves pending speak waiters via onError
 * when the utterance never started (timer still pending).
 */
export function stopBrowserTts(): void {
  const hadPendingTimer = speakTimer != null
  const session = activeSession
  const handlers = pendingHandlers
  const needsManualCancel =
    hadPendingTimer || (session != null && !session.started)
  resetBrowserTts()
  if (needsManualCancel) {
    handlers?.onError?.('canceled')
  }
  // Active started utterance: cancel() triggers onerror → handlers.
}
