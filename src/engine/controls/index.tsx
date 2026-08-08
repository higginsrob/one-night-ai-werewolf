import type { ControlsKind } from '../types'
import { MapControlsAdapter } from './MapControlsAdapter'
import { OrbitControlsAdapter } from './OrbitControlsAdapter'
import { TrackballControlsAdapter } from './TrackballControlsAdapter'
import { WalkFlyMapControlsAdapter } from './WalkFlyMapControlsAdapter'

type Props = {
  kind: ControlsKind
  enabled?: boolean
  enableRotate?: boolean
  enablePan?: boolean
  /** When set, use MapControls aimed at this point (document reading). */
  readingTarget?: [number, number, number] | null
  target?: [number, number, number]
  minDistance?: number
  maxDistance?: number
  minPolarAngle?: number
  maxPolarAngle?: number
  minAzimuthAngle?: number
  maxAzimuthAngle?: number
}

export function SceneControls({
  kind,
  enabled = true,
  enableRotate = true,
  enablePan = false,
  readingTarget = null,
  target,
  minDistance,
  maxDistance,
  minPolarAngle,
  maxPolarAngle,
  minAzimuthAngle,
  maxAzimuthAngle,
}: Props) {
  if (readingTarget) {
    return (
      <MapControlsAdapter
        enabled={enabled}
        target={readingTarget}
        minDistance={minDistance ?? 0.35}
        maxDistance={maxDistance ?? 6}
      />
    )
  }

  switch (kind) {
    case 'trackball':
      return <TrackballControlsAdapter enabled={enabled} target={target} />
    case 'walkFlyMap':
      return <WalkFlyMapControlsAdapter enabled={enabled} />
    case 'orbit':
    default:
      return (
        <OrbitControlsAdapter
          enabled={enabled}
          enableRotate={enableRotate}
          enablePan={enablePan}
          target={target}
          minDistance={minDistance}
          maxDistance={maxDistance}
          minPolarAngle={minPolarAngle}
          maxPolarAngle={maxPolarAngle}
          minAzimuthAngle={minAzimuthAngle}
          maxAzimuthAngle={maxAzimuthAngle}
        />
      )
  }
}
