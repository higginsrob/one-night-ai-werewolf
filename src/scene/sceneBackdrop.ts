export type SceneBackdropVariant = 'night' | 'dusk'

export type SceneBackdropConfig = {
  variant: SceneBackdropVariant
  /** Override scene.backgroundIntensity (null = use sky export default). */
  intensity: number | null
  /** Override scene.backgroundBlurriness (null = use sky export default). */
  blurriness: number | null
}

const DEFAULT: SceneBackdropConfig = {
  variant: 'night',
  intensity: null,
  blurriness: null,
}

let config: SceneBackdropConfig = { ...DEFAULT }

export function getSceneBackdrop(): SceneBackdropConfig {
  return config
}

export function setSceneBackdrop(next: Partial<SceneBackdropConfig>): void {
  config = {
    variant: next.variant ?? config.variant,
    intensity:
      next.intensity !== undefined ? next.intensity : config.intensity,
    blurriness:
      next.blurriness !== undefined ? next.blurriness : config.blurriness,
  }
}

export function resetSceneBackdrop(): void {
  config = { ...DEFAULT }
}
