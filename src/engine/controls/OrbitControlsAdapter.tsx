import { OrbitControls } from '@react-three/drei'

type Props = {
  enabled?: boolean
  enableRotate?: boolean
  enablePan?: boolean
  target?: [number, number, number]
  minDistance?: number
  maxDistance?: number
  minPolarAngle?: number
  maxPolarAngle?: number
  /** Horizontal swing from the default front view (radians). */
  minAzimuthAngle?: number
  maxAzimuthAngle?: number
}

export function OrbitControlsAdapter({
  enabled = true,
  enableRotate = true,
  enablePan = false,
  target = [0, 0.55, 0],
  minDistance = 2.2,
  maxDistance = 12,
  // Keep a playable top-down-ish view without flipping under the table.
  minPolarAngle = 0.35,
  maxPolarAngle = Math.PI / 2.15,
  // Front-of-table arc only — no spinning to the back of the scene.
  // Pass Infinity for full 360° (watch-mode auto camera).
  minAzimuthAngle = -Math.PI * 0.42,
  maxAzimuthAngle = Math.PI * 0.42,
}: Props) {
  return (
    <OrbitControls
      makeDefault
      enabled={enabled}
      enablePan={enablePan}
      enableRotate={enableRotate}
      target={target}
      minDistance={minDistance}
      maxDistance={maxDistance}
      minPolarAngle={minPolarAngle}
      maxPolarAngle={maxPolarAngle}
      minAzimuthAngle={minAzimuthAngle}
      maxAzimuthAngle={maxAzimuthAngle}
      rotateSpeed={0.7}
      zoomSpeed={0.28}
      touches={{ ONE: 0, TWO: 2 }}
    />
  )
}
