/**
 * Unified TTS facade: browser speechSynthesis or OpenAI-compatible speech API.
 */

import { speakApiTts, stopApiTts } from './apiTtsManager'
import {
  type BrowserTtsHandlers,
  speakBrowserTts,
  stopBrowserTts,
} from './browserTts'
import type {
  SpeechPhase,
  VoiceAccent,
  VoiceAge,
  VoiceDesignOverrides,
  VoiceGender,
} from './omniVoiceSpeech'
import { loadTtsStore } from './ttsStore'
import { loadWerewolfSettings } from './werewolfSettings'

export type SpeakTtsOpts = BrowserTtsHandlers & {
  /** Browser voiceURI when engine is browser. */
  browserVoiceURI?: string | null
  /** API / OmniVoice voice id when engine is api. */
  apiVoiceId?: string | null
  speakerId?: string | null
  /** Phase for OmniVoice speaking-rate tweaks. */
  speechPhase?: SpeechPhase
  /** OmniVoice design overrides (design/auto voices only). */
  voiceDesign?: VoiceDesignOverrides
  /** Preset instruct string when voice is a known design preset. */
  presetInstruct?: string | null
}

export function isTtsEnabled(): boolean {
  return loadTtsStore().ttsEnabled
}

export function getTtsEngine(): 'browser' | 'api' {
  return loadTtsStore().engine
}

export function stopTts(): void {
  stopApiTts()
  stopBrowserTts()
}

/**
 * Speak via the active TTS engine. Safe to call from click handlers.
 * API path sentence-chunks + aborts via stopTts(); mirrors browser onStart/onEnd/onError.
 */
export function speakTts(text: string, opts?: SpeakTtsOpts): void {
  if (!isTtsEnabled()) {
    opts?.onEnd?.()
    return
  }

  const store = loadTtsStore()
  if (store.engine === 'api') {
    stopBrowserTts()
    const narratorDesign =
      opts?.speechPhase === 'narrator' && !opts?.voiceDesign
        ? {
            voiceAge: store.narratorVoiceAge as VoiceAge,
            voiceGender: store.narratorVoiceGender as VoiceGender,
            voiceAccent: store.narratorVoiceAccent as VoiceAccent,
          }
        : undefined
    speakApiTts(text, {
      apiVoiceId: opts?.apiVoiceId,
      speakerId: opts?.speakerId,
      speechPhase: opts?.speechPhase,
      voiceDesign: opts?.voiceDesign ?? narratorDesign,
      presetInstruct: opts?.presetInstruct,
      onStart: opts?.onStart,
      onEnd: opts?.onEnd,
      onError: opts?.onError,
    })
    return
  }

  // Keep werewolf browserTtsEnabled in sync as the browser path gate.
  if (!loadWerewolfSettings().browserTtsEnabled) {
    opts?.onEnd?.()
    return
  }

  stopApiTts()
  speakBrowserTts(text, {
    voiceURI: opts?.browserVoiceURI,
    speakerId: opts?.speakerId,
    onStart: opts?.onStart,
    onEnd: opts?.onEnd,
    onError: opts?.onError,
  })
}
