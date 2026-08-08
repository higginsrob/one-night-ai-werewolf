import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { getSceneBackdrop, type SceneBackdropVariant } from './sceneBackdrop'

const FADE_MS = 900

/**
 * 0 = night sky, 1 = dusk/day sky.
 * Tracks the same variant fades as {@link NightBackdrop}.
 */
export function useBackdropDayMix(onMix: (mix: number) => void): void {
  const applied = useRef<SceneBackdropVariant | null>(null)
  const fadeRef = useRef<{
    from: SceneBackdropVariant
    to: SceneBackdropVariant
    startedAt: number
  } | null>(null)
  const mixRef = useRef(0)
  const onMixRef = useRef(onMix)
  onMixRef.current = onMix

  useFrame(() => {
    const target = getSceneBackdrop().variant
    const want = target === 'dusk' ? 1 : 0

    if (applied.current !== target && !fadeRef.current) {
      fadeRef.current = {
        from: applied.current ?? 'night',
        to: target,
        startedAt: performance.now(),
      }
    }

    const fade = fadeRef.current
    if (fade) {
      const t = Math.min(1, (performance.now() - fade.startedAt) / FADE_MS)
      const from = fade.from === 'dusk' ? 1 : 0
      const to = fade.to === 'dusk' ? 1 : 0
      mixRef.current = from + (to - from) * t
      if (t >= 1) {
        applied.current = fade.to
        fadeRef.current = null
        mixRef.current = want
      }
    } else {
      mixRef.current = want
      applied.current = target
    }

    onMixRef.current(mixRef.current)
  })
}
