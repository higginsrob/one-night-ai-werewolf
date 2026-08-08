import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'

export const VOTE_ARROW_HOLD_MS = 3_200

export type VoteFlight = {
  id: string
  from: [number, number, number]
  to: [number, number, number]
  createdAt: number
  until: number
}

const GROW_MS = 480
const FADE_MS = 750
const COLOR = '#e8a045'
const TUBE_RADIUS = 0.016
const HEAD_LEN = 0.14
const HEAD_RADIUS = 0.055

function VoteArrow({ flight }: { flight: VoteFlight }) {
  const shaftMat = useRef<THREE.MeshBasicMaterial>(null)
  const headMat = useRef<THREE.MeshBasicMaterial>(null)
  const head = useRef<THREE.Mesh>(null)

  const { curve, tubeGeo } = useMemo(() => {
    const start = new THREE.Vector3(...flight.from)
    const end = new THREE.Vector3(...flight.to)
    const mid = start.clone().lerp(end, 0.5)
    const dist = start.distanceTo(end)
    mid.y += Math.min(0.85, 0.35 + dist * 0.18)
    const c = new THREE.QuadraticBezierCurve3(start, mid, end)
    const geo = new THREE.TubeGeometry(c, 28, TUBE_RADIUS, 7, false)
    return { curve: c, tubeGeo: geo }
  }, [flight.from, flight.to])

  useEffect(() => {
    return () => {
      tubeGeo.dispose()
    }
  }, [tubeGeo])

  useFrame(() => {
    const now = performance.now()
    const age = now - flight.createdAt
    const left = flight.until - now
    const grow = Math.min(1, Math.max(0, age / GROW_MS))
    const eased = grow * grow * (3 - 2 * grow)

    let opacity = 0.92
    if (left < FADE_MS) opacity = Math.max(0, (left / FADE_MS) * 0.92)

    if (shaftMat.current) shaftMat.current.opacity = opacity * eased
    if (headMat.current) {
      headMat.current.opacity = opacity * Math.min(1, eased * 1.15)
    }

    if (head.current) {
      const t = Math.min(0.998, Math.max(0.02, eased))
      const p = curve.getPoint(t)
      const tan = curve.getTangent(t).normalize()
      head.current.position.copy(p)
      head.current.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        tan,
      )
      head.current.visible = eased > 0.08
    }

    const count = tubeGeo.index
      ? tubeGeo.index.count
      : tubeGeo.attributes.position.count
    tubeGeo.setDrawRange(0, Math.max(3, Math.floor(count * eased)))
  })

  return (
    <group>
      <mesh geometry={tubeGeo} frustumCulled={false}>
        <meshBasicMaterial
          ref={shaftMat}
          color={COLOR}
          transparent
          opacity={0}
          depthWrite={false}
        />
      </mesh>
      <mesh ref={head} frustumCulled={false} visible={false}>
        <coneGeometry args={[HEAD_RADIUS, HEAD_LEN, 10]} />
        <meshBasicMaterial
          ref={headMat}
          color={COLOR}
          transparent
          opacity={0}
          depthWrite={false}
        />
      </mesh>
    </group>
  )
}

type Props = {
  flights: VoteFlight[]
}

/** Arcing arrows from voter character cards to their vote targets. */
export function VoteArrowFx({ flights }: Props) {
  if (flights.length === 0) return null
  return (
    <group>
      {flights.map((f) => (
        <VoteArrow key={f.id} flight={f} />
      ))}
    </group>
  )
}
