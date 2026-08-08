import { MapControls } from '@react-three/drei'

type Props = {
  enabled?: boolean
  target?: [number, number, number]
  minDistance?: number
  maxDistance?: number
}

/**
 * Document-reading controls: pan to look around, zoom to inspect detail,
 * right-drag (or two-finger) to tilt.
 */
export function MapControlsAdapter({
  enabled = true,
  target = [0, 1.5, 3],
  minDistance = 0.35,
  maxDistance = 6,
}: Props) {
  return (
    <MapControls
      makeDefault
      enabled={enabled}
      target={target}
      minDistance={minDistance}
      maxDistance={maxDistance}
      enableDamping
      dampingFactor={0.08}
      screenSpacePanning
      // Keep the sheet roughly facing the user — no flipping underneath.
      minPolarAngle={0.15}
      maxPolarAngle={Math.PI * 0.85}
      zoomSpeed={0.32}
      panSpeed={0.9}
      rotateSpeed={0.55}
    />
  )
}
