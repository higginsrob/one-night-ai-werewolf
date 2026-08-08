/**
 * Sentence-chunked API TTS: play first chunk ASAP, prefetch at most one ahead,
 * abort in-flight HTTP on stop.
 */

import { splitSentencesWithOffsets } from '../ai/agent/spokenText'
import { publishTtsHostError } from '../ai/hostErrors'
import {
  type BrowserTtsHandlers,
  setBrowserTtsExternalPlayback,
} from './browserTts'
import {
  hasVoiceDesignOverrides,
  mergeVoiceInstruct,
  prepareOmniVoiceSpeech,
  type SpeechPhase,
  type VoiceDesignOverrides,
} from './omniVoiceSpeech'
import {
  fetchSpeechAudio,
  friendlySpeechError,
  isSpeechFetchAborted,
} from './ttsApiClient'
import {
  getDesignVoiceInstruct,
  isOmniVoiceEndpoint,
  loadTtsStore,
} from './ttsStore'
import {
  clampApiMaxSentencesPerChunk,
  DEFAULT_MAX_SENTENCES_PER_CHUNK,
  MAX_CHUNK_CHARS,
  MIN_CHUNK_CHARS,
} from './ttsTypes'

export {
  clampApiMaxSentencesPerChunk,
  DEFAULT_MAX_SENTENCES_PER_CHUNK,
  MAX_CHUNK_CHARS,
  MIN_CHUNK_CHARS,
} from './ttsTypes'

export type ApiSpeakOpts = BrowserTtsHandlers & {
  apiVoiceId?: string | null
  speakerId?: string | null
  speechPhase?: SpeechPhase
  voiceDesign?: VoiceDesignOverrides
  presetInstruct?: string | null
}

type Chunk = { text: string; start: number; end: number }

type PrefetchEntry = {
  blob: Blob
  url: string
}

let sessionGen = 0
let abortController: AbortController | null = null
let audioEl: HTMLAudioElement | null = null
let playingUrl: string | null = null
/** Ready blob for at most one chunk index. */
let ready: { index: number; entry: PrefetchEntry } | null = null
/** Single in-flight fetch (at most one ahead). */
let inflight: { index: number; promise: Promise<PrefetchEntry | null> } | null =
  null

function revokeUrl(url: string | null) {
  if (url) URL.revokeObjectURL(url)
}

function reportApiTtsError(message: string): void {
  const trimmed = message.trim()
  if (!trimmed || trimmed === 'canceled') return
  publishTtsHostError(trimmed)
}

function clearReady() {
  if (ready) {
    revokeUrl(ready.entry.url)
    ready = null
  }
}

function stopAudioElement() {
  if (audioEl) {
    audioEl.onended = null
    audioEl.onerror = null
    audioEl.pause()
    audioEl.removeAttribute('src')
    audioEl = null
  }
  revokeUrl(playingUrl)
  playingUrl = null
}

export function stopApiTts(): void {
  sessionGen += 1
  abortController?.abort()
  abortController = null
  inflight = null
  stopAudioElement()
  clearReady()
  setBrowserTtsExternalPlayback(false, null)
}

/**
 * Merge consecutive sentences into API TTS chunks.
 * Packs up to `maxSentences` per chunk (0 = unlimited / whole utterance),
 * and never grows a chunk past `maxChars` once it already meets `minChars`
 * (OmniVoice voice-design crackles on long inputs).
 */
export function mergeSentenceChunks(
  sentences: { text: string; start: number; end: number }[],
  minChars = MIN_CHUNK_CHARS,
  maxSentences = DEFAULT_MAX_SENTENCES_PER_CHUNK,
  maxChars = MAX_CHUNK_CHARS,
): Chunk[] {
  if (sentences.length === 0) return []
  const sentenceCap =
    maxSentences <= 0 ? Number.POSITIVE_INFINITY : maxSentences
  const charCap = maxChars <= 0 ? Number.POSITIVE_INFINITY : maxChars
  const out: Chunk[] = []
  let buf = sentences[0]!
  let count = 1
  for (let i = 1; i < sentences.length; i++) {
    const next = sentences[i]!
    const mergedLen = buf.text.length + 1 + next.text.length
    const atSentenceCap = count >= sentenceCap
    const wouldExceedChars = mergedLen > charCap
    if (
      buf.text.length >= minChars &&
      (atSentenceCap || wouldExceedChars)
    ) {
      out.push(buf)
      buf = next
      count = 1
    } else {
      buf = {
        text: `${buf.text} ${next.text}`.trim(),
        start: buf.start,
        end: next.end,
      }
      count += 1
    }
  }
  out.push(buf)
  return out
}

function resolveInstruct(
  voice: string,
  opts: ApiSpeakOpts,
  omni: boolean,
): string | null {
  if (!omni) return null
  const design = opts.voiceDesign ?? {}
  const preset =
    opts.presetInstruct?.trim() ||
    getDesignVoiceInstruct(voice === 'auto' ? null : voice) ||
    null
  if (!hasVoiceDesignOverrides(design)) {
    // No client override — server uses built-in preset instruct.
    return null
  }
  return mergeVoiceInstruct(preset, design)
}

function startFetch(
  index: number,
  chunks: Chunk[],
  voice: string,
  signal: AbortSignal,
  gen: number,
  opts: ApiSpeakOpts,
  continuity: { current: { blob: Blob; text: string } | null },
): Promise<PrefetchEntry | null> {
  if (ready?.index === index) {
    return Promise.resolve(ready.entry)
  }
  if (inflight?.index === index) {
    return inflight.promise
  }

  const chunk = chunks[index]
  if (!chunk) return Promise.resolve(null)

  const promise = (async (): Promise<PrefetchEntry | null> => {
    try {
      const omni = isOmniVoiceEndpoint()
      const phase: SpeechPhase = opts.speechPhase ?? 'day'
      let text = chunk.text
      let speed: number | undefined
      let instruct: string | null = null
      let refAudio: Blob | null = null
      let refText: string | null = null
      if (omni) {
        const prepared = prepareOmniVoiceSpeech(chunk.text, phase)
        text = prepared.text
        speed = prepared.speed
        instruct = resolveInstruct(voice, opts, omni)
        // Lock design/auto timbre across chunks using the first clip as ref.
        if (index > 0 && continuity.current) {
          refAudio = continuity.current.blob
          refText = continuity.current.text
        }
      }
      const blob = await fetchSpeechAudio({
        text,
        voice,
        speed,
        instruct,
        refAudio,
        refText,
        signal,
      })
      if (gen !== sessionGen || signal.aborted) return null
      if (omni && index === 0 && !continuity.current) {
        continuity.current = { blob, text }
      }
      const url = URL.createObjectURL(blob)
      const entry = { blob, url }
      if (ready && ready.index !== index) {
        revokeUrl(ready.entry.url)
      }
      ready = { index, entry }
      return entry
    } finally {
      if (inflight?.index === index) inflight = null
    }
  })()

  inflight = { index, promise }
  return promise
}

function playEntry(
  entry: PrefetchEntry,
  gen: number,
): Promise<'ended' | 'error' | 'canceled'> {
  return new Promise((resolve) => {
    if (gen !== sessionGen) {
      resolve('canceled')
      return
    }
    stopAudioElement()
    if (ready?.entry.url === entry.url) {
      ready = null
    }
    playingUrl = entry.url
    const audio = new Audio(entry.url)
    audioEl = audio
    audio.onended = () => {
      resolve(gen !== sessionGen ? 'canceled' : 'ended')
    }
    audio.onerror = () => {
      resolve(gen !== sessionGen ? 'canceled' : 'error')
    }
    void audio.play().catch(() => {
      resolve(gen !== sessionGen ? 'canceled' : 'error')
    })
  })
}

/**
 * Speak via API TTS, sentence-chunked. Fire-and-forget; use stopApiTts to abort.
 */
export function speakApiTts(text: string, opts?: ApiSpeakOpts): void {
  const trimmed = text.trim()
  if (!trimmed) {
    opts?.onEnd?.()
    return
  }

  stopApiTts()
  const gen = ++sessionGen
  const controller = new AbortController()
  abortController = controller
  const signal = controller.signal

  const speakerId = opts?.speakerId ?? null
  const voice =
    (opts?.apiVoiceId !== undefined
      ? opts.apiVoiceId
      : loadTtsStore().narratorApiVoiceId) || 'auto'

  const sentences = splitSentencesWithOffsets(trimmed)
  const maxSentences = clampApiMaxSentencesPerChunk(
    loadTtsStore().apiMaxSentencesPerChunk,
  )
  const chunks =
    sentences.length > 0
      ? mergeSentenceChunks(
          sentences,
          MIN_CHUNK_CHARS,
          maxSentences,
          MAX_CHUNK_CHARS,
        )
      : [{ text: trimmed, start: 0, end: trimmed.length }]

  const speakOpts: ApiSpeakOpts = opts ?? {}
  /** First design-voice clip — reused as ref_audio for later chunks. */
  const continuity: { current: { blob: Blob; text: string } | null } = {
    current: null,
  }

  void (async () => {
    let started = false
    try {
      for (let i = 0; i < chunks.length; i++) {
        if (gen !== sessionGen || signal.aborted) {
          opts?.onError?.('canceled')
          return
        }

        const chunk = chunks[i]!
        // Highlight the upcoming chunk while audio is still in flight.
        setBrowserTtsExternalPlayback(true, speakerId, {
          text: trimmed,
          sentenceIndex: i,
          charIndex: chunk.start,
          charEnd: chunk.end,
          loading: true,
        })

        let entry: PrefetchEntry | null = null
        try {
          entry = await startFetch(
            i,
            chunks,
            voice,
            signal,
            gen,
            speakOpts,
            continuity,
          )
        } catch (e) {
          if (isSpeechFetchAborted(e) || gen !== sessionGen) {
            opts?.onError?.('canceled')
            return
          }
          const message = friendlySpeechError(e)
          stopApiTts()
          reportApiTtsError(message)
          opts?.onError?.(message)
          opts?.onEnd?.()
          return
        }

        if (!entry || gen !== sessionGen || signal.aborted) {
          opts?.onError?.('canceled')
          return
        }

        setBrowserTtsExternalPlayback(true, speakerId, {
          text: trimmed,
          sentenceIndex: i,
          charIndex: chunk.start,
          charEnd: chunk.end,
          loading: false,
        })

        if (!started) {
          started = true
          opts?.onStart?.()
        }

        // Prefetch at most one ahead while this chunk plays.
        if (i + 1 < chunks.length) {
          void startFetch(
            i + 1,
            chunks,
            voice,
            signal,
            gen,
            speakOpts,
            continuity,
          ).catch(() => {
            /* play path will surface errors when that index is reached */
          })
        }

        const result = await playEntry(entry, gen)
        if (result === 'canceled' || gen !== sessionGen) {
          opts?.onError?.('canceled')
          return
        }
        if (result === 'error') {
          stopApiTts()
          reportApiTtsError('TTS playback failed')
          opts?.onError?.('playback failed')
          opts?.onEnd?.()
          return
        }
      }

      if (gen !== sessionGen) {
        opts?.onError?.('canceled')
        return
      }
      stopAudioElement()
      clearReady()
      setBrowserTtsExternalPlayback(false, null)
      opts?.onEnd?.()
    } catch (e) {
      if (isSpeechFetchAborted(e) || gen !== sessionGen) {
        opts?.onError?.('canceled')
        return
      }
      const message = friendlySpeechError(e)
      stopApiTts()
      reportApiTtsError(message)
      opts?.onError?.(message)
      opts?.onEnd?.()
    }
  })()
}
