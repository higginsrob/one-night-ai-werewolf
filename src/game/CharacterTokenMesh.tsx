import { useMemo } from 'react'
import type { ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import {
  getRoleTokenFaceTexture,
  teamColorsForRole,
} from './roleCardTextures'
import type { WerewolfRole } from './werewolfTypes'

export const TOKEN_RADIUS = 0.07
export const TOKEN_HEIGHT = 0.022

type Props = {
  role: WerewolfRole
  position: [number, number, number]
  selected?: boolean
  locked?: boolean
  /**
   * `up` — flat on the table (default).
   * `camera` — face toward the viewer (player-card overlays).
   */
  facing?: 'up' | 'camera'
  onClick?: () => void
}

/**
 * Flat disc (cylinder axis = +Y). Face/icon point along +Y, or +Z when
 * `facing="camera"` (parent may still billboard).
 */
export function CharacterTokenMesh({
  role,
  position,
  selected = false,
  locked = false,
  facing = 'up',
  onClick,
}: Props) {
  const colors = teamColorsForRole(role)
  const faceMap = useMemo(() => getRoleTokenFaceTexture(role), [role])

  const handle = onClick
    ? (e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation()
        onClick()
      }
    : undefined

  return (
    <group
      position={position}
      rotation={facing === 'camera' ? [Math.PI / 2, 0, 0] : [0, 0, 0]}
    >
      {/* Thin disc: default cylinder is Y-up — do not tilt it onto its edge. */}
      <mesh
        castShadow
        receiveShadow
        onClick={handle}
        onPointerDown={
          handle
            ? (e) => {
                e.stopPropagation()
              }
            : undefined
        }
        onPointerOver={
          handle
            ? (e) => {
                e.stopPropagation()
                document.body.style.cursor = 'pointer'
              }
            : undefined
        }
        onPointerOut={
          handle
            ? () => {
                document.body.style.cursor = 'auto'
              }
            : undefined
        }
      >
        <cylinderGeometry args={[TOKEN_RADIUS, TOKEN_RADIUS, TOKEN_HEIGHT, 28]} />
        <meshStandardMaterial
          color={colors.bg}
          emissive={selected ? '#6a5a20' : colors.accent}
          emissiveIntensity={selected ? 0.35 : locked ? 0.22 : 0.08}
          roughness={0.55}
          metalness={0.12}
        />
      </mesh>
      {/* Icon face on top */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, TOKEN_HEIGHT / 2 + 0.0015, 0]}
        onClick={handle}
        onPointerDown={
          handle
            ? (e) => {
                e.stopPropagation()
              }
            : undefined
        }
      >
        <circleGeometry args={[TOKEN_RADIUS * 0.88, 28]} />
        <meshStandardMaterial
          map={faceMap}
          transparent
          roughness={0.7}
          metalness={0.05}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Rim around icon face */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, TOKEN_HEIGHT / 2 + 0.0025, 0]}
      >
        <ringGeometry
          args={[TOKEN_RADIUS * 0.88, TOKEN_RADIUS * 0.98, 28]}
        />
        <meshBasicMaterial
          color={selected ? '#c9a227' : colors.accent}
          transparent
          opacity={selected ? 0.95 : 0.85}
        />
      </mesh>
      {locked && (
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, TOKEN_HEIGHT / 2 + 0.0005, 0]}
        >
          <ringGeometry args={[TOKEN_RADIUS * 1.02, TOKEN_RADIUS * 1.12, 28]} />
          <meshBasicMaterial color="#c9a227" transparent opacity={0.55} />
        </mesh>
      )}
    </group>
  )
}
