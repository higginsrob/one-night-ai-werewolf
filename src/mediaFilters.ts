/** CSS filter presets for player card photo / live video. */

export type MediaFilterId =
  | 'none'
  | 'grayscale'
  | 'sepia'
  | 'contrast'
  | 'bright'
  | 'warm'
  | 'cool'
  | 'vivid'
  | 'noir'
  | 'invert'

export type MediaFilterPreset = {
  id: MediaFilterId
  label: string
  /** CSS `filter` value applied to video / image. */
  css: string
}

export const MEDIA_FILTERS: MediaFilterPreset[] = [
  { id: 'none', label: 'None', css: 'none' },
  { id: 'grayscale', label: 'Grayscale', css: 'grayscale(1)' },
  { id: 'sepia', label: 'Sepia', css: 'sepia(0.9)' },
  { id: 'contrast', label: 'Contrast', css: 'contrast(1.4) saturate(1.1)' },
  { id: 'bright', label: 'Bright', css: 'brightness(1.25) contrast(1.05)' },
  {
    id: 'warm',
    label: 'Warm',
    css: 'sepia(0.4) saturate(1.45) hue-rotate(-12deg)',
  },
  {
    id: 'cool',
    label: 'Cool',
    css: 'saturate(1.2) hue-rotate(190deg) brightness(1.05)',
  },
  { id: 'vivid', label: 'Vivid', css: 'saturate(1.85) contrast(1.12)' },
  {
    id: 'noir',
    label: 'Noir',
    css: 'grayscale(1) contrast(1.45) brightness(0.92)',
  },
  { id: 'invert', label: 'Invert', css: 'invert(1) hue-rotate(180deg)' },
]

const FILTER_IDS = new Set<string>(MEDIA_FILTERS.map((f) => f.id))

export function normalizeMediaFilter(value: unknown): MediaFilterId {
  if (typeof value === 'string' && FILTER_IDS.has(value)) {
    return value as MediaFilterId
  }
  return 'none'
}

export function cssFilterFor(id: MediaFilterId | string | null | undefined): string {
  const normalized = normalizeMediaFilter(id)
  return MEDIA_FILTERS.find((f) => f.id === normalized)?.css ?? 'none'
}
