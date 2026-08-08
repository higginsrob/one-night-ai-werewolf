import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react'
import type { ThreeEvent } from '@react-three/fiber'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import {
  getRoleCardBackTexture,
  getRoleCardFaceTexture,
  ROLE_CARD_DEPTH,
  ROLE_CARD_HEIGHT,
  ROLE_CARD_WIDTH,
} from './roleCardTextures'
import type { WerewolfRole } from './werewolfTypes'
import { clearOrbitFocus } from '../scene/playerCardFocus'

/** Cool teal for the waking role — distinct from target gold. */
export const NIGHT_FOCUS_COLOR = '#3ec6d8'
const NIGHT_FOCUS_EDGE = '#2a9aab'
const NIGHT_FOCUS_EMISSIVE = '#0d3d48'
const NIGHT_FOCUS_FACE = '#e8fbff'

/** Gold for cards that are peeked / selected this beat. */
export const NIGHT_TARGET_COLOR = '#c9a227'
const NIGHT_TARGET_EDGE = '#a8841c'
const NIGHT_TARGET_EMISSIVE = '#6a5a20'
const NIGHT_TARGET_FACE = '#fff6e6'

/** Night-action ring: waking actor (teal) vs seen/selected target (gold). */
export type NightHighlight = false | 'actor' | 'target'

type Props = {
  role?: WerewolfRole | null
  faceDown?: boolean
  selected?: boolean
  selectable?: boolean
  /** Claimed by another player — dimmed and not pickable. */
  dimmed?: boolean
  /** Night-action focus ring. `true` = actor (teal). */
  highlighted?: boolean | NightHighlight
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
  onClick?: () => void
  onPointerDown?: (e: ThreeEvent<PointerEvent>) => void
  onPointerUp?: (e: ThreeEvent<PointerEvent>) => void
  /** e.g. mini player-card owner badge on the card. */
  children?: ReactNode
}

function resolveNightHighlight(
  highlighted: boolean | NightHighlight,
): NightHighlight {
  if (highlighted === true) return 'actor'
  if (highlighted === false) return false
  return highlighted
}

export function RoleCardMesh({
  role = null,
  faceDown = true,
  selected = false,
  selectable = false,
  dimmed = false,
  highlighted = false,
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1,
  onClick,
  onPointerDown,
  onPointerUp,
  children,
}: Props) {
  const { gl } = useThree()
  const backMap = useMemo(() => getRoleCardBackTexture(), [])
  const faceMap = useMemo(
    () => (role ? getRoleCardFaceTexture(role) : backMap),
    [role, backMap],
  )
  const nightHighlight = resolveNightHighlight(highlighted)

  useLayoutEffect(() => {
    const max = gl.capabilities.getMaxAnisotropy()
    for (const map of [backMap, faceMap]) {
      if (map.anisotropy !== max) {
        map.anisotropy = max
        map.needsUpdate = true
      }
    }
  }, [gl, backMap, faceMap])

  const materials = useMemo(() => {
    const edgeColor = selected
      ? '#c9a227'
      : nightHighlight === 'target'
        ? NIGHT_TARGET_EDGE
        : nightHighlight === 'actor'
          ? NIGHT_FOCUS_EDGE
          : '#c8c0b0'
    const edge = new THREE.MeshStandardMaterial({
      color: edgeColor,
      roughness: 0.55,
      metalness: 0.12,
      emissive: selected
        ? '#6a5a20'
        : nightHighlight === 'target'
          ? NIGHT_TARGET_EMISSIVE
          : nightHighlight === 'actor'
            ? NIGHT_FOCUS_EMISSIVE
            : '#000000',
      emissiveIntensity: selected || nightHighlight ? 0.35 : 0,
      transparent: dimmed,
      opacity: dimmed ? 0.38 : 1,
    })
    // Unlit print faces — PBR + tone-mapping was washing/softening the artwork
    // vs the same JPG viewed as a 2D asset. Face/back map is swapped mid-flip
    // in useFrame (do not key this material on `faceDown`).
    const face = new THREE.MeshBasicMaterial({
      map: backMap,
      toneMapped: false,
      transparent: dimmed,
      opacity: dimmed ? 0.38 : 1,
      color:
        selectable && !selected
          ? '#fff6e6'
          : nightHighlight === 'target'
            ? NIGHT_TARGET_FACE
            : nightHighlight === 'actor'
              ? NIGHT_FOCUS_FACE
              : '#ffffff',
    })
    const back = new THREE.MeshBasicMaterial({
      map: backMap,
      toneMapped: false,
      transparent: dimmed,
      opacity: dimmed ? 0.38 : 1,
    })
    return [edge, edge.clone(), edge.clone(), edge.clone(), face, back] as [
      THREE.MeshStandardMaterial,
      THREE.MeshStandardMaterial,
      THREE.MeshStandardMaterial,
      THREE.MeshStandardMaterial,
      THREE.MeshBasicMaterial,
      THREE.MeshBasicMaterial,
    ]
  }, [backMap, selected, selectable, dimmed, nightHighlight])

  const meshRef = useRef<THREE.Mesh>(null)
  /** 0 = face-up, 1 = face-down — lerped for a Y-axis flip. */
  const flipT = useRef(faceDown ? 1 : 0)
  const showingBack = useRef(true)

  useLayoutEffect(() => {
    // Sync texture when materials rebuild (role change, highlight, etc.).
    const faceMat = materials[4]
    const wantBack = flipT.current > 0.5
    showingBack.current = wantBack
    faceMat.map = wantBack ? backMap : faceMap
    faceMat.needsUpdate = true
    const mesh = meshRef.current
    if (mesh) mesh.rotation.y = flipT.current * Math.PI
  }, [materials, backMap, faceMap])

  useEffect(() => {
    return () => {
      for (const mat of materials) mat.dispose()
    }
  }, [materials])

  useFrame((_, dt) => {
    const mesh = meshRef.current
    if (!mesh) return
    const target = faceDown ? 1 : 0
    const speed = 5.5
    const next =
      Math.abs(flipT.current - target) < 0.001
        ? target
        : flipT.current +
          Math.sign(target - flipT.current) *
            Math.min(Math.abs(target - flipT.current), dt * speed)
    flipT.current = next
    mesh.rotation.y = next * Math.PI
    const wantBack = next > 0.5
    if (wantBack !== showingBack.current) {
      showingBack.current = wantBack
      const faceMat = materials[4]
      faceMat.map = wantBack ? backMap : faceMap
      faceMat.needsUpdate = true
    }
  })

  // Dimmed is visual only — callers gate picks via `selectable`.
  const clickable = Boolean(
    (onClick || onPointerDown || onPointerUp) && selectable,
  )

  return (
    <group position={position} rotation={rotation} scale={scale * (dimmed ? 0.96 : 1)}>
      <mesh
        ref={meshRef}
        castShadow
        receiveShadow
        material={materials}
        onClick={(e) => {
          e.stopPropagation()
          clearOrbitFocus()
          if (clickable && onClick) onClick()
        }}
        onPointerDown={
          clickable && onPointerDown
            ? (e) => {
                e.stopPropagation()
                onPointerDown(e)
              }
            : undefined
        }
        onPointerUp={
          clickable && onPointerUp
            ? (e) => {
                e.stopPropagation()
                onPointerUp(e)
              }
            : undefined
        }
        onPointerOver={
          clickable
            ? (e) => {
                e.stopPropagation()
                document.body.style.cursor = 'pointer'
              }
            : undefined
        }
        onPointerOut={
          clickable
            ? () => {
                document.body.style.cursor = 'auto'
              }
            : undefined
        }
      >
        <boxGeometry
          args={[ROLE_CARD_WIDTH, ROLE_CARD_HEIGHT, ROLE_CARD_DEPTH]}
        />
      </mesh>
      {/* Ring lies in the card face plane (table), sized around the card. */}
      {selected && (
        <mesh position={[0, 0, -ROLE_CARD_DEPTH * 0.5 - 0.002]}>
          <ringGeometry
            args={[ROLE_CARD_WIDTH * 0.83, ROLE_CARD_WIDTH * 1.02, 48]}
          />
          <meshBasicMaterial
            color="#c9a227"
            transparent
            opacity={0.85}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
      {nightHighlight && !selected && (
        <mesh position={[0, 0, -ROLE_CARD_DEPTH * 0.5 - 0.002]}>
          <ringGeometry
            args={[ROLE_CARD_WIDTH * 0.83, ROLE_CARD_WIDTH * 1.02, 48]}
          />
          <meshBasicMaterial
            color={
              nightHighlight === 'target'
                ? NIGHT_TARGET_COLOR
                : NIGHT_FOCUS_COLOR
            }
            transparent
            opacity={0.9}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
      {children}
    </group>
  )
}
