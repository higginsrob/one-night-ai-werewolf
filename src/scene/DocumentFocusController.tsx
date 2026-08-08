import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { LobbyDocId } from '../game/onwArt'

const READ_DISTANCE = 1.55
const VIEW_FILL = 0.78
const LERP = 10

type Pose = {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  scale: number
}

export type DocFocusHandle = {
  id: LobbyDocId
  group: THREE.Group
  table: Pose
  /** Base sheet height in local units (before focus scale). */
  baseHeight: number
}

type Props = {
  focusedId: LobbyDocId | null
  handlesRef: React.MutableRefObject<Map<LobbyDocId, DocFocusHandle>>
  onDismiss: () => void
  /** World-space center of the reading pose — drives MapControls target. */
  onReadingTarget?: (target: [number, number, number] | null) => void
}

/**
 * Lifts the focused document to a fixed reading pose (does not chase the camera).
 * Escape dismisses; pan/zoom while reading is handled by MapControls in PeerScene.
 */
export function DocumentFocusController({
  focusedId,
  handlesRef,
  onDismiss,
  onReadingTarget,
}: Props) {
  const { camera } = useThree()
  const progress = useRef(0)
  const frozen = useRef<Pose | null>(null)
  const _forward = useRef(new THREE.Vector3())
  const _look = useRef(new THREE.Matrix4())
  const _up = useRef(new THREE.Vector3(0, 1, 0))
  /** lookAt aims local -Z at the camera; our sheet art faces +Z — flip 180°. */
  const _flipY = useRef(
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI),
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && focusedId) onDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusedId, onDismiss])

  // Capture a fixed reading pose once when focus begins (sheet stops following the camera).
  useEffect(() => {
    if (!focusedId) {
      frozen.current = null
      onReadingTarget?.(null)
      return
    }

    const handle = handlesRef.current.get(focusedId)
    if (!handle) return

    const forward = _forward.current
    camera.getWorldDirection(forward)
    const position = camera.position
      .clone()
      .addScaledVector(forward, READ_DISTANCE)

    _look.current.lookAt(position, camera.position, _up.current)
    const quaternion = new THREE.Quaternion()
      .setFromRotationMatrix(_look.current)
      .multiply(_flipY.current)

    const vFov = (camera as THREE.PerspectiveCamera).fov * (Math.PI / 180)
    const viewH = 2 * Math.tan(vFov / 2) * READ_DISTANCE
    const scale = (viewH * VIEW_FILL) / handle.baseHeight

    frozen.current = { position, quaternion, scale }
    onReadingTarget?.([position.x, position.y, position.z])
  }, [focusedId, camera, handlesRef, onReadingTarget])

  useFrame((_, dt) => {
    const target = focusedId && frozen.current ? 1 : 0
    const k = 1 - Math.exp(-LERP * dt)
    progress.current += (target - progress.current) * k

    const p = progress.current
    const reading = frozen.current

    for (const handle of handlesRef.current.values()) {
      const group = handle.group
      const isFocus = handle.id === focusedId && reading

      if (isFocus && p > 0.001 && reading) {
        group.position.lerpVectors(handle.table.position, reading.position, p)
        group.quaternion.slerpQuaternions(
          handle.table.quaternion,
          reading.quaternion,
          p,
        )
        const s = handle.table.scale + (reading.scale - handle.table.scale) * p
        group.scale.setScalar(s)
      } else {
        group.position.lerp(handle.table.position, Math.min(1, k * 1.2))
        group.quaternion.slerp(handle.table.quaternion, Math.min(1, k * 1.2))
        const cur = group.scale.x
        const next = cur + (handle.table.scale - cur) * Math.min(1, k * 1.2)
        group.scale.setScalar(next)
      }
    }
  })

  return null
}
