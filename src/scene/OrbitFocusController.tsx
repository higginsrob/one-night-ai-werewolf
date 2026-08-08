import { useEffect, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import {
  getOrbitFocusPlayerId,
  readPlayerCardFocus,
  subscribeOrbitFocusPlayerId,
} from './playerCardFocus'

const LERP = 3.2

type Props = {
  /** Default orbit look-at when framing the table. */
  tableTarget: [number, number, number]
  enabled?: boolean
}

type OrbitLike = {
  target: THREE.Vector3
  update: () => void
}

/**
 * Softly animates the default OrbitControls target onto a click-selected
 * player card, or back to the table when focus is cleared.
 */
export function OrbitFocusController({
  tableTarget,
  enabled = true,
}: Props) {
  const { controls } = useThree()
  const desired = useRef(new THREE.Vector3(...tableTarget))
  const scratch = useRef(new THREE.Vector3())
  const [focusPlayerId, setFocusPlayerId] = useState(() =>
    getOrbitFocusPlayerId(),
  )

  useEffect(() => subscribeOrbitFocusPlayerId(setFocusPlayerId), [])

  useFrame((_, dt) => {
    if (!enabled) return
    const orbit = controls as OrbitLike | null
    if (!orbit?.target || typeof orbit.update !== 'function') return

    if (focusPlayerId) {
      if (readPlayerCardFocus(focusPlayerId, scratch.current)) {
        desired.current.copy(scratch.current)
      }
    } else {
      desired.current.set(tableTarget[0], tableTarget[1], tableTarget[2])
    }

    const k = 1 - Math.exp(-LERP * dt)
    orbit.target.lerp(desired.current, k)
    orbit.update()
  })

  return null
}
