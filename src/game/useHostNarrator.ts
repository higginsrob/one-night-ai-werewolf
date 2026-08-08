import { useEffect, useRef, useState } from 'react'
import {
  getBrowserTtsVoiceURI,
  isBrowserTtsReady,
  isBrowserTtsSpeaking,
  listBrowserTtsVoices,
  markBrowserTtsUnlocked,
  seedDefaultNarratorVoiceIfNeeded,
  setBrowserTtsVoiceURI,
  subscribeBrowserTtsReady,
  warmBrowserTtsVoices,
} from './browserTts'
import { isTtsEnabled, speakTts, stopTts } from './tts'
import { narrationForHumanNight, narrationForStep } from './roles'
import { dawnPlaybackBeats, revealPlaybackBeats } from './nightPlayback'
import { playerHasNightPhase } from './werewolfLogic'
import {
  loadWerewolfSettings,
  type WerewolfHostSettings,
} from './werewolfSettings'
import type { NightStep, WerewolfRole, WerewolfSnapshot } from './werewolfTypes'
import type { ClientIntent } from '../net/protocol'
import { NARRATOR_CLIENT_ID } from '../session/types'

type OnIntent = (intent: ClientIntent) => void

/** Mirror spoken narrator lines into the shared chat log. */
function postNarratorChat(
  onIntent: OnIntent | undefined,
  text: string,
): void {
  const speak = text.trim()
  if (!speak || !onIntent) return
  onIntent({
    type: 'chat.append',
    fromId: NARRATOR_CLIENT_ID,
    text: speak,
    via: 'narrator',
  })
}

export type NarratorSpeakError =
  | 'unsupported'
  | 'not-allowed'
  | 'interrupted'
  | 'failed'
  | 'timeout'

/** Roles present in this round’s deck (hand), not post-swap seats. */
export function presentRolesInHand(game: WerewolfSnapshot): Set<WerewolfRole> {
  if (game.roleDeck.length > 0) return new Set(game.roleDeck)
  return new Set([
    ...Object.values(game.dealtRoles),
    ...game.dealtCenter,
  ])
}

// Re-export voice helpers under the old names used by settings UI.
export const setNarratorVoiceURI = setBrowserTtsVoiceURI
export const getNarratorVoiceURI = getBrowserTtsVoiceURI
export const listNarratorVoices = listBrowserTtsVoices
export const isHostNarratorReady = isBrowserTtsReady
export const subscribeNarratorReady = subscribeBrowserTtsReady

export function useSpeechVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() =>
    listBrowserTtsVoices(),
  )
  useEffect(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return
    const refresh = () => setVoices(listBrowserTtsVoices())
    refresh()
    warmBrowserTtsVoices()
    window.speechSynthesis.addEventListener('voiceschanged', refresh)
    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', refresh)
    }
  }, [])
  return voices
}

/** Click-armed intro when starting a watch-mode game. */
export const WATCH_GAME_WELCOME = 'Welcome to One Night AI Werewolf.'

/** Unlock + speak from a click (Test / Start / Enable). */
export function unlockHostNarrator(opts?: {
  speak?: string
  onStart?: () => void
  onEnd?: () => void
  onError?: (code: NarratorSpeakError) => void
}): void {
  const line = opts?.speak?.trim()
  if (!line) {
    markBrowserTtsUnlocked()
    return
  }
  speakTts(line, {
    speechPhase: 'narrator',
    onStart: opts?.onStart,
    onEnd: opts?.onEnd,
    onError: (error) => {
      const code: NarratorSpeakError =
        error === 'not-allowed'
          ? 'not-allowed'
          : error === 'interrupted' || error === 'canceled'
            ? 'interrupted'
            : error === 'unsupported'
              ? 'unsupported'
              : 'failed'
      opts?.onError?.(code)
    },
  })
}

export function testHostNarration(
  text: string,
  voiceURI?: string | null,
  opts?: {
    onStart?: () => void
    onEnd?: () => void
    onError?: (code: NarratorSpeakError) => void
  },
): void {
  if (voiceURI !== undefined) setBrowserTtsVoiceURI(voiceURI)
  unlockHostNarrator({
    speak: text,
    onStart: opts?.onStart,
    onEnd: opts?.onEnd,
    onError: opts?.onError,
  })
}

export function speakHostNarration(text: string, onEnd?: () => void): void {
  speakTts(text, { speechPhase: 'narrator', onEnd })
}

export function cancelHostNarration(): void {
  stopTts()
}

export function narrationLineForGame(
  game: WerewolfSnapshot,
  step: NightStep = game.nightStep,
  humanClientId?: string | null,
) {
  const present = presentRolesInHand(game)
  const opts = { dayDurationMs: game.dayDurationMs }
  if (step === 'simultaneous') {
    const humanRole = humanClientId
      ? game.dealtRoles[humanClientId]
      : undefined
    return narrationForHumanNight(humanRole, present, opts)
  }
  return narrationForStep(step, present, opts)
}

function isRoleNightStep(step: NightStep): boolean {
  return step !== 'intro' && step !== 'outro' && step !== 'simultaneous'
}

/** Human has nothing to do tonight (gallery spectator or no-wake seat). */
function humanSkipsNightPhase(
  game: WerewolfSnapshot,
  humanClientId?: string | null,
): boolean {
  return (
    !humanClientId ||
    !game.playerIds.includes(humanClientId) ||
    !playerHasNightPhase(game, humanClientId)
  )
}

/**
 * Rush the AI act window (short timer) when the local human is not acting
 * (gallery spectator, or a no-wake seat such as villager).
 */
function shouldRushNightAct(
  game: WerewolfSnapshot,
  humanClientId?: string | null,
): boolean {
  return humanSkipsNightPhase(game, humanClientId)
}

/**
 * Mute live night wake/close lines when the human is not acting.
 * Watch / god-mode skips the player night theater entirely — the detailed
 * action replay at dawn is the spectator narration.
 */
function shouldSkipNightNarration(
  game: WerewolfSnapshot,
  humanClientId?: string | null,
): boolean {
  return humanSkipsNightPhase(game, humanClientId) || game.godMode
}

/** Brief AI collection window when the human has nothing to do at night. */
const SKIP_NIGHT_ACT_MS = 3_500

/**
 * Safety net when speech onEnd never fires. Must cover API synthesize latency
 * plus full playback — a short fixed cap advances early and stopTts()-cuts
 * the line (e.g. dawn "Everyone, wake up…").
 */
function narratorSpeechBackupMs(text: string): number {
  const len = text.trim().length
  return Math.min(90_000, Math.max(25_000, len * 200 + 15_000))
}

/**
 * Host-only TTS announcer for single-player night:
 * intro → simultaneous (human role wake) → outro.
 * No-wake seated roles and Watch / god-mode skip wake lines and rush the act
 * window; god-mode then plays the detailed action replay at dawn.
 */
export function useHostNarrator(
  game: WerewolfSnapshot | null,
  isHost: boolean,
  onIntent?: OnIntent,
  humanClientId?: string | null,
): void {
  const lastWakeKey = useRef<string>('')
  const narrateGen = useRef(0)
  const closeSentForEndsAt = useRef<number | null>(null)
  const nightTimeoutSent = useRef(false)
  const onIntentRef = useRef(onIntent)
  onIntentRef.current = onIntent

  useEffect(() => {
    const s: WerewolfHostSettings = loadWerewolfSettings()
    setBrowserTtsVoiceURI(s.voiceURI)
  }, [game?.phase])

  useEffect(() => {
    warmBrowserTtsVoices()
    if (typeof window === 'undefined' || !window.speechSynthesis) return
    const warm = () => {
      warmBrowserTtsVoices()
      seedDefaultNarratorVoiceIfNeeded(listBrowserTtsVoices())
    }
    warm()
    window.speechSynthesis.addEventListener('voiceschanged', warm)
    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', warm)
    }
  }, [])

  const prevNarratePhaseRef = useRef<WerewolfSnapshot['phase'] | null>(null)

  useEffect(() => {
    const phase = game?.phase ?? null
    const leftNight = prevNarratePhaseRef.current === 'night' && phase !== 'night'
    prevNarratePhaseRef.current = phase

    if (!game || !isHost) {
      narrateGen.current += 1
      stopTts()
      return
    }

    if (game.phase !== 'night') {
      lastWakeKey.current = ''
      closeSentForEndsAt.current = null
      nightTimeoutSent.current = false
      // Only cut speech when leaving a spoken night. Watch / no-wake rushes
      // silently — stopping here would cut the click-armed welcome.
      if (
        leftNight &&
        !shouldSkipNightNarration(game, humanClientId)
      ) {
        narrateGen.current += 1
        stopTts()
      }
      return
    }

    if (game.nightPaused) {
      narrateGen.current += 1
      stopTts()
      return
    }

    const rushAct = shouldRushNightAct(game, humanClientId)
    const skipNarration = shouldSkipNightNarration(game, humanClientId)

    // After resume mid-wake (no act timer), allow the same step to re-speak.
    const present = presentRolesInHand(game)
    const humanRole = humanClientId
      ? game.dealtRoles[humanClientId]
      : undefined
    const key = `${game.nightStep}:${humanRole ?? ''}:${[...present].sort().join(',')}:${game.nightResumeAt}:${game.godMode ? 'g' : ''}`
    if (key === lastWakeKey.current) return
    // Skip re-speaking wake when resuming an already-running act window.
    if (
      game.nightStepEndsAt != null &&
      lastWakeKey.current.startsWith(
        `${game.nightStep}:${humanRole ?? ''}:${[...present].sort().join(',')}:`,
      )
    ) {
      lastWakeKey.current = key
      return
    }
    lastWakeKey.current = key
    closeSentForEndsAt.current = null
    nightTimeoutSent.current = false
    narrateGen.current += 1
    const gen = narrateGen.current

    const line = narrationLineForGame(game, game.nightStep, humanClientId)
    const roleStep = isRoleNightStep(game.nightStep)
    const simultaneousStep = game.nightStep === 'simultaneous'
    const introOrOutro =
      game.nightStep === 'intro' || game.nightStep === 'outro'

    // Watch / no-wake skips speech — do not stopTts or we cut the click-armed
    // welcome that is still playing through claiming → silent night rush.
    if (!(skipNarration && (introOrOutro || simultaneousStep))) {
      stopTts()
    }
    const speakTimer = window.setTimeout(() => {
      if (narrateGen.current !== gen) return
      const advanceAfterWake = () => {
        if (narrateGen.current !== gen) return
        if (roleStep || simultaneousStep) {
          onIntentRef.current?.({
            type: 'werewolf.startNightAct',
            ...(rushAct ? { actMs: SKIP_NIGHT_ACT_MS } : {}),
          })
          return
        }
        onIntentRef.current?.({ type: 'werewolf.narratorAdvance' })
      }
      // No-wake / watch: skip night theater — advance without wake TTS.
      if (skipNarration && (introOrOutro || simultaneousStep)) {
        advanceAfterWake()
        return
      }
      const wake = line.wakeSpeak.trim()
      if (!wake) {
        advanceAfterWake()
        return
      }
      postNarratorChat(onIntentRef.current, wake)
      speakTts(wake, {
        speechPhase: 'narrator',
        onEnd: advanceAfterWake,
      })
    }, 80)
    return () => window.clearTimeout(speakTimer)
  }, [
    game,
    game?.nightStep,
    game?.phase,
    game?.roleDeck,
    game?.nightPaused,
    game?.nightResumeAt,
    game?.nightStepEndsAt,
    game?.godMode,
    humanClientId,
    isHost,
  ])

  useEffect(() => {
    if (!game || !isHost || game.phase !== 'night' || game.nightPaused) return
    if (game.nightStep !== 'intro' && game.nightStep !== 'outro') return
    const skipNarration = shouldSkipNightNarration(game, humanClientId)
    // TTS-off / skip-night: advance quickly; TTS-on: safety net if speech never ends.
    const wake = narrationLineForGame(game, game.nightStep, humanClientId)
      .wakeSpeak
    const waitMs =
      skipNarration || !isTtsEnabled() ? 80 : narratorSpeechBackupMs(wake)
    const t = window.setTimeout(() => {
      onIntentRef.current?.({ type: 'werewolf.narratorAdvance' })
    }, waitMs)
    return () => window.clearTimeout(t)
  }, [
    game,
    game?.phase,
    game?.nightStep,
    game?.nightPaused,
    game?.nightResumeAt,
    game?.godMode,
    game?.dayDurationMs,
    humanClientId,
    isHost,
  ])

  // Simultaneous: safety start act if wake had no speak / TTS muted and never fired.
  useEffect(() => {
    if (!game || !isHost || game.phase !== 'night' || game.nightPaused) return
    if (game.nightStep !== 'simultaneous') return
    if (game.nightStepEndsAt != null) return
    const rushAct = shouldRushNightAct(game, humanClientId)
    const skipNarration = shouldSkipNightNarration(game, humanClientId)
    const wake = narrationLineForGame(game, game.nightStep, humanClientId)
      .wakeSpeak
    const waitMs =
      skipNarration || !isTtsEnabled() ? 80 : narratorSpeechBackupMs(wake)
    const t = window.setTimeout(() => {
      onIntentRef.current?.({
        type: 'werewolf.startNightAct',
        ...(rushAct ? { actMs: SKIP_NIGHT_ACT_MS } : {}),
      })
    }, waitMs)
    return () => window.clearTimeout(t)
  }, [
    game,
    game?.phase,
    game?.nightStep,
    game?.nightStepEndsAt,
    game?.nightPaused,
    game?.nightResumeAt,
    game?.godMode,
    humanClientId,
    isHost,
  ])

  // Spectator / no-wake: hard-cap the night wait so AI extend cannot re-inflate
  // the short rush window — resolve into day instead of sitting paused.
  const rushNightActArmed =
    Boolean(game) &&
    game!.phase === 'night' &&
    !game!.nightPaused &&
    game!.nightStep === 'simultaneous' &&
    game!.nightStepEndsAt != null &&
    shouldRushNightAct(game!, humanClientId)
  useEffect(() => {
    if (!isHost || !rushNightActArmed) return
    const t = window.setTimeout(() => {
      onIntentRef.current?.({ type: 'werewolf.skipNightStep' })
    }, SKIP_NIGHT_ACT_MS + 500)
    return () => window.clearTimeout(t)
    // Re-arm only when a new act window opens — not when extend bumps endsAt.
  }, [
    isHost,
    rushNightActArmed,
    game?.nightStep,
    game?.nightResumeAt,
  ])

  useEffect(() => {
    if (!game || !isHost || game.phase !== 'night' || game.nightPaused) return
    if (game.nightStep !== 'simultaneous' && !isRoleNightStep(game.nightStep)) {
      return
    }
    if (game.nightStepEndsAt == null) return

    // Reset so grace / extendNightAct can schedule a fresh timeout.
    nightTimeoutSent.current = false
    const endsAt = game.nightStepEndsAt
    const step = game.nightStep
    const skipNarration = shouldSkipNightNarration(game, humanClientId)
    let backupTimer: number | null = null
    const tick = () => {
      if (Date.now() < endsAt) return
      if (closeSentForEndsAt.current === endsAt) return
      closeSentForEndsAt.current = endsAt
      narrateGen.current += 1
      const gen = narrateGen.current

      const line = narrationLineForGame(game, step, humanClientId)
      const close = skipNarration ? '' : line.closeSpeak
      const sendTimeout = () => {
        if (narrateGen.current !== gen) return
        if (nightTimeoutSent.current) return
        nightTimeoutSent.current = true
        onIntentRef.current?.({ type: 'werewolf.nightTimeout' })
      }
      if (!close) {
        sendTimeout()
        return
      }

      // TTS onEnd can be canceled when Skip bumps narrateGen — still advance
      // (and force-record night actions) after a hard cap so AI roles keep
      // private info. Cap must cover API synthesize + full playback.
      const backupMs = narratorSpeechBackupMs(close)
      backupTimer = window.setTimeout(sendTimeout, backupMs)
      postNarratorChat(onIntentRef.current, close)
      speakTts(close, {
        speechPhase: 'narrator',
        onEnd: () => {
          if (backupTimer != null) window.clearTimeout(backupTimer)
          backupTimer = null
          sendTimeout()
        },
        onError: () => {
          if (backupTimer != null) window.clearTimeout(backupTimer)
          backupTimer = null
          sendTimeout()
        },
      })
    }

    tick()
    const id = window.setInterval(tick, 200)
    return () => {
      window.clearInterval(id)
      if (backupTimer != null) window.clearTimeout(backupTimer)
    }
  }, [
    game,
    game?.phase,
    game?.nightStep,
    game?.nightStepEndsAt,
    game?.nightPaused,
    game?.godMode,
    humanClientId,
    isHost,
  ])

  // Post-vote night replay and god-mode dawn: speak each beat, then advance.
  const playbackLineKey = useRef<string>('')
  const speechPlaybackActive = useRef(false)
  const spokenWinMessage = useRef<string>('')
  useEffect(() => {
    if (!game || !isHost) {
      playbackLineKey.current = ''
      if (speechPlaybackActive.current) {
        speechPlaybackActive.current = false
        narrateGen.current += 1
        stopTts()
      }
      return
    }

    if (game.phase !== 'reveal') {
      spokenWinMessage.current = ''
    }

    const isRevealReplay =
      game.phase === 'reveal' &&
      game.revealStage === 'nightPlayback' &&
      game.playbackBeatIndex != null
    const isGodDawn = game.phase === 'dawn' && game.godMode
    const isSpeechPlayback = isRevealReplay || isGodDawn

    if (!isSpeechPlayback) {
      playbackLineKey.current = ''
      if (speechPlaybackActive.current) {
        speechPlaybackActive.current = false
        narrateGen.current += 1
        stopTts()
      }

      // Hunter path (or skipped recap): announce the outcome once the result
      // screen lands if the closing night-recap beat did not already say it.
      if (
        game.phase === 'reveal' &&
        game.revealStage === 'result' &&
        game.winMessage
      ) {
        const win = game.winMessage.trim()
        if (win && win !== spokenWinMessage.current) {
          spokenWinMessage.current = win
          postNarratorChat(onIntentRef.current, win)
          speakTts(win, { speechPhase: 'narrator' })
        }
      }
      return
    }

    speechPlaybackActive.current = true
    const beats = isGodDawn
      ? dawnPlaybackBeats(game)
      : revealPlaybackBeats(game)
    const idx = game.playbackBeatIndex
    if (idx == null || idx < 0 || idx >= beats.length) {
      return
    }

    const key = `${game.phase}:${game.revealStage}:${game.playbackStartedAt}:${idx}`
    if (key === playbackLineKey.current) return
    playbackLineKey.current = key
    narrateGen.current += 1
    const gen = narrateGen.current
    const beat = beats[idx]!
    const holdMs = game.playbackBeatMs ?? 1200

    const advance = () => {
      if (narrateGen.current !== gen) return
      onIntentRef.current?.({ type: 'werewolf.playbackNext' })
    }

    const speak =
      'speak' in beat && typeof beat.speak === 'string'
        ? beat.speak.trim()
        : ''

    if (speak) {
      if (
        game.phase === 'reveal' &&
        game.revealStage === 'nightPlayback' &&
        beat.kind === 'announce' &&
        beat.nightStep === 'outro' &&
        game.winMessage?.trim() === speak
      ) {
        spokenWinMessage.current = speak
      }
      const ttsOff = !isTtsEnabled()
      if (ttsOff) {
        postNarratorChat(onIntentRef.current, speak)
        const t = window.setTimeout(advance, 700)
        return () => window.clearTimeout(t)
      }
      let backup: number | null = null
      let afterSpeak: number | null = null
      let waitPrior: number | null = null
      let speakTimer: number | null = null
      let posted = false
      const beginSpeak = () => {
        if (narrateGen.current !== gen) return
        // Let the watch-game welcome finish before dawn narration cuts in.
        if (isGodDawn && isBrowserTtsSpeaking()) {
          waitPrior = window.setTimeout(beginSpeak, 120)
          return
        }
        if (!posted) {
          posted = true
          postNarratorChat(onIntentRef.current, speak)
        }
        stopTts()
        speakTimer = window.setTimeout(() => {
          if (narrateGen.current !== gen) return
          // Safety net only — must cover API synthesize latency + full playback.
          const backupMs = narratorSpeechBackupMs(speak)
          backup = window.setTimeout(advance, backupMs)
          speakTts(speak, {
            speechPhase: 'narrator',
            onEnd: () => {
              if (narrateGen.current !== gen) return
              if (backup != null) window.clearTimeout(backup)
              backup = null
              // Brief beat so the label / FX land, then continue.
              afterSpeak = window.setTimeout(advance, 180)
            },
            onError: (reason) => {
              // Aborted because we moved on — do not skip ahead again.
              if (reason === 'canceled' || narrateGen.current !== gen) return
              if (backup != null) window.clearTimeout(backup)
              backup = null
              advance()
            },
          })
        }, 40)
      }
      beginSpeak()
      return () => {
        if (waitPrior != null) window.clearTimeout(waitPrior)
        if (speakTimer != null) window.clearTimeout(speakTimer)
        if (backup != null) window.clearTimeout(backup)
        if (afterSpeak != null) window.clearTimeout(afterSpeak)
      }
    }

    // Silent action / atmosphere follow-ups: hold the FX, then continue.
    const t = window.setTimeout(advance, holdMs)
    return () => window.clearTimeout(t)
  }, [
    // Intentionally omit bare `game` — identity churn mid-beat was clearing
    // speak timers / afterSpeak and racing OmniVoice playback.
    game?.phase,
    game?.revealStage,
    game?.playbackStartedAt,
    game?.playbackBeatIndex,
    game?.playbackBeatMs,
    game?.godMode,
    game?.winMessage,
    isHost,
  ])

  // Invalidate pending onEnd advances on unmount. Do not stopTts — React
  // StrictMode remount (and HUD mount right after Watch) would cut the
  // click-armed welcome. End game / rematch / stop handlers cancel speech.
  useEffect(() => {
    return () => {
      narrateGen.current += 1
    }
  }, [])
}
