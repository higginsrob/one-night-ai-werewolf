/** Local scene visual preferences. */

import { publicAsset } from '../publicUrl'

export const NIGHT_HDRI_IDS = [
  'qwantani_night_puresky',
  'qwantani_night',
  'qwantani_moonrise',
] as const

export const DAY_HDRI_IDS = [
  'qwantani_dusk_1',
  'qwantani_sunrise',
  'qwantani_dawn',
] as const

export type NightHdriId = (typeof NIGHT_HDRI_IDS)[number]
export type DayHdriId = (typeof DAY_HDRI_IDS)[number]

export type SceneVisuals = {
  backgroundBlur: boolean
  /** Scales HDRI background blurriness when blur is on (0–1). */
  backgroundBlurAmount: number
  nightHdri: NightHdriId
  dayHdri: DayHdriId
}

export const DEFAULT_SCENE_VISUALS: SceneVisuals = {
  backgroundBlur: true,
  backgroundBlurAmount: 1,
  nightHdri: 'qwantani_moonrise',
  dayHdri: 'qwantani_dusk_1',
}

/** Clamp a 0–1 amount from settings / UI. */
export function clampSceneAmount(
  value: unknown,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(0, value))
}

export type HdriCatalogEntry = {
  id: NightHdriId | DayHdriId
  label: string
  /** Local equirect JPEG under /hdri/. */
  url: string
}

export const NIGHT_HDRI_OPTIONS: HdriCatalogEntry[] = [
  {
    id: 'qwantani_moonrise',
    label: 'Qwantani Moonrise',
    url: publicAsset('hdri/qwantani_moonrise_2k.jpg'),
  },
  {
    id: 'qwantani_night_puresky',
    label: 'Qwantani Night (Pure Sky)',
    url: publicAsset('hdri/qwantani_night_puresky_2k.jpg'),
  },
  {
    id: 'qwantani_night',
    label: 'Qwantani Night',
    url: publicAsset('hdri/qwantani_night_2k.jpg'),
  },
]

export const DAY_HDRI_OPTIONS: HdriCatalogEntry[] = [
  {
    id: 'qwantani_dusk_1',
    label: 'Qwantani Dusk',
    url: publicAsset('hdri/qwantani_dusk_1_2k.jpg'),
  },
  {
    id: 'qwantani_sunrise',
    label: 'Qwantani Sunrise',
    url: publicAsset('hdri/qwantani_sunrise_2k.jpg'),
  },
  {
    id: 'qwantani_dawn',
    label: 'Qwantani Dawn',
    url: publicAsset('hdri/qwantani_dawn_2k.jpg'),
  },
]

function isNightHdriId(value: unknown): value is NightHdriId {
  return (
    typeof value === 'string' &&
    (NIGHT_HDRI_IDS as readonly string[]).includes(value)
  )
}

function isDayHdriId(value: unknown): value is DayHdriId {
  return (
    typeof value === 'string' &&
    (DAY_HDRI_IDS as readonly string[]).includes(value)
  )
}

export function normalizeSceneVisuals(
  raw: Partial<SceneVisuals> | null | undefined,
): SceneVisuals {
  return {
    backgroundBlur:
      typeof raw?.backgroundBlur === 'boolean'
        ? raw.backgroundBlur
        : DEFAULT_SCENE_VISUALS.backgroundBlur,
    backgroundBlurAmount: clampSceneAmount(
      raw?.backgroundBlurAmount,
      DEFAULT_SCENE_VISUALS.backgroundBlurAmount,
    ),
    nightHdri: isNightHdriId(raw?.nightHdri)
      ? raw.nightHdri
      : DEFAULT_SCENE_VISUALS.nightHdri,
    dayHdri: isDayHdriId(raw?.dayHdri)
      ? raw.dayHdri
      : DEFAULT_SCENE_VISUALS.dayHdri,
  }
}

export function hdriUrlFor(
  phase: 'night' | 'day',
  visuals: SceneVisuals,
): string | null {
  const options = phase === 'night' ? NIGHT_HDRI_OPTIONS : DAY_HDRI_OPTIONS
  const id = phase === 'night' ? visuals.nightHdri : visuals.dayHdri
  return options.find((o) => o.id === id)?.url ?? null
}
