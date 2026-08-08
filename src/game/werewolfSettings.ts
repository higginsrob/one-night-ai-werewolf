/** Host-local One Night AI Werewolf preferences (TTS + timers). */

const STORAGE_KEY = 'onw:werewolf-settings'

const settingsListeners = new Set<() => void>()

/** Notify when host werewolf settings are saved (same-tab). */
export function subscribeWerewolfSettings(fn: () => void): () => void {
  settingsListeners.add(fn)
  return () => {
    settingsListeners.delete(fn)
  }
}

function notifyWerewolfSettings(): void {
  // Defer so save() during a setState updater never setStates another tree mid-render.
  queueMicrotask(() => {
    for (const fn of settingsListeners) fn()
  })
}

export const DEFAULT_NIGHT_ACT_SEC = 10
export const DEFAULT_DAY_DURATION_SEC = 4 * 60

export const MIN_NIGHT_ACT_SEC = 5
export const MAX_NIGHT_ACT_SEC = 60
export const MIN_DAY_DURATION_SEC = 60
export const MAX_DAY_DURATION_SEC = 15 * 60

export type WerewolfHostSettings = {
  /** speechSynthesisVoice.voiceURI, or null for auto (prefers Rishi). */
  voiceURI: string | null
  /**
   * When false, browser TTS is muted globally (narrator + AI players).
   * Night still advances; script text still shows.
   */
  browserTtsEnabled: boolean
  /**
   * Quiet outdoor ambience (crickets + rare owl) in the lobby and night phase.
   */
  environmentSoundsEnabled: boolean
  /** Seconds each night role gets after the wake line finishes. */
  nightActSec: number
  /** Seconds of day discussion/voting. */
  dayDurationSec: number
}

export const DEFAULT_WEREWOLF_SETTINGS: WerewolfHostSettings = {
  /** null until voices load; seedDefaultNarratorVoiceIfNeeded picks Rishi. */
  voiceURI: null,
  browserTtsEnabled: true,
  environmentSoundsEnabled: true,
  nightActSec: DEFAULT_NIGHT_ACT_SEC,
  dayDurationSec: DEFAULT_DAY_DURATION_SEC,
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

type LegacyWerewolfSettings = Partial<WerewolfHostSettings> & {
  /** @deprecated Renamed to browserTtsEnabled. */
  narratorEnabled?: boolean
}

export function normalizeWerewolfSettings(
  raw: LegacyWerewolfSettings | null | undefined,
): WerewolfHostSettings {
  let browserTtsEnabled = DEFAULT_WEREWOLF_SETTINGS.browserTtsEnabled
  if (typeof raw?.browserTtsEnabled === 'boolean') {
    browserTtsEnabled = raw.browserTtsEnabled
  } else if (typeof raw?.narratorEnabled === 'boolean') {
    browserTtsEnabled = raw.narratorEnabled
  }

  return {
    voiceURI:
      typeof raw?.voiceURI === 'string' && raw.voiceURI.trim()
        ? raw.voiceURI.trim().slice(0, 200)
        : null,
    browserTtsEnabled,
    environmentSoundsEnabled:
      typeof raw?.environmentSoundsEnabled === 'boolean'
        ? raw.environmentSoundsEnabled
        : DEFAULT_WEREWOLF_SETTINGS.environmentSoundsEnabled,
    nightActSec: clampInt(
      raw?.nightActSec,
      MIN_NIGHT_ACT_SEC,
      MAX_NIGHT_ACT_SEC,
      DEFAULT_NIGHT_ACT_SEC,
    ),
    dayDurationSec: clampInt(
      raw?.dayDurationSec,
      MIN_DAY_DURATION_SEC,
      MAX_DAY_DURATION_SEC,
      DEFAULT_DAY_DURATION_SEC,
    ),
  }
}

export function loadWerewolfSettings(): WerewolfHostSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_WEREWOLF_SETTINGS }
    return normalizeWerewolfSettings(
      JSON.parse(raw) as LegacyWerewolfSettings,
    )
  } catch {
    return { ...DEFAULT_WEREWOLF_SETTINGS }
  }
}

export function saveWerewolfSettings(settings: WerewolfHostSettings): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(normalizeWerewolfSettings(settings)),
    )
  } catch {
    // Quota / private mode — ignore
  }
  notifyWerewolfSettings()
}

/** Restore timers / ambience / browser narrator voice to defaults. */
export function resetWerewolfSettings(): void {
  saveWerewolfSettings({ ...DEFAULT_WEREWOLF_SETTINGS })
}

/** True when the host has never saved werewolf settings in this browser. */
export function hasSavedWerewolfSettings(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null
  } catch {
    return false
  }
}

export function nightActMsFromSettings(settings: WerewolfHostSettings): number {
  return normalizeWerewolfSettings(settings).nightActSec * 1000
}

export function dayDurationMsFromSettings(
  settings: WerewolfHostSettings,
): number {
  return normalizeWerewolfSettings(settings).dayDurationSec * 1000
}

/** Sample line for the settings Test button. */
export const TTS_TEST_LINE =
  'Everyone, close your eyes. This is the One Night AI Werewolf narrator.'
