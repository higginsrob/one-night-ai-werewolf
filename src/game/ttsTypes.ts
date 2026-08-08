export type TtsEngine = 'browser' | 'api'

/** Merge tiny sentence fragments so we don't pay a round-trip for "Hi." */
export const MIN_CHUNK_CHARS = 40
/**
 * Soft cap on characters per API request.
 * OmniVoice voice-design crackles on longer inputs (see k2-fsa/OmniVoice#144).
 */
export const MAX_CHUNK_CHARS = 120
/**
 * Default sentences per API request. Keep short to avoid crackle; timbre is
 * locked across chunks by feeding the first WAV back as ref_audio.
 */
export const DEFAULT_MAX_SENTENCES_PER_CHUNK = 1
/** Hard ceiling for the TTS settings control. */
export const MAX_SENTENCES_PER_CHUNK_CAP = 8

export function clampApiMaxSentencesPerChunk(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_MAX_SENTENCES_PER_CHUNK
  }
  const n = Math.floor(value)
  if (n <= 0) return 0
  return Math.min(MAX_SENTENCES_PER_CHUNK_CAP, n)
}

export type TtsStorePersisted = {
  version: 3
  /** Master mute for narrator + AI TTS (both engines). */
  ttsEnabled: boolean
  engine: TtsEngine
  /** API voice id for narrator when engine is api (null = auto). */
  narratorApiVoiceId: string | null
  /** OmniVoice design override for narrator (design/auto voices only). */
  narratorVoiceAge: string
  /** OmniVoice design override for narrator (design/auto voices only). */
  narratorVoiceGender: string
  /** OmniVoice design override for narrator (design/auto voices only). */
  narratorVoiceAccent: string
  /**
   * Max spoken sentences per API TTS request.
   * 0 = entire utterance in one request (can crackle on OmniVoice design).
   * Default 1; later chunks reuse the first clip as a voice lock.
   */
  apiMaxSentencesPerChunk: number
}

export type ApiVoice = {
  id: string
  name: string
  createdBy: string
  createdAt: string
  kind?: 'design'
  /** Present for design presets — OmniVoice instruct string. */
  instruct?: string
}

export type ApiVoiceCatalog = {
  presets: ApiVoice[]
}

/** Runtime capability probe for the active speech API (not persisted). */
export type TtsApiCapabilities = {
  omnivoice: boolean
  checkedAt: number
}

export { DEFAULT_OMNIVOICE_BASE } from '../ai/defaults'
