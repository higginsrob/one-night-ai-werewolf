import { Clone, useGLTF } from '@react-three/drei'
import { useLayoutEffect } from 'react'
import * as THREE from 'three'
import { publicAsset } from '../publicUrl'
import { isCoarseMobile } from './deviceProfile'
import { clearOrbitFocus } from './playerCardFocus'

const TABLE_URL = publicAsset('models/web/wooden_picnic_table.glb')

/** Native mesh is ~2.2×3.0m including benches — too tight for the lobby deck. */
const BASE_SCALE = 1.9
/** Native tabletop Y before BASE_SCALE. */
const NATIVE_TABLE_TOP = 0.746

/**
 * World-space tabletop height after BASE_SCALE.
 * Kept as a constant so cards / docs do not wait on GLTF load.
 */
export const TABLE_TOP = NATIVE_TABLE_TOP * BASE_SCALE
/** Reference play radius at scale=1 (after BASE_SCALE). */
export const TABLE_FELT_RADIUS = 1.55 * BASE_SCALE

type Props = {
  /**
   * Extra XZ scale when larger player counts need a wider pad.
   * Height stays at BASE_SCALE so TABLE_TOP remains valid.
   */
  scale?: number
}

/**
 * Poly Haven wooden picnic table — shared by the lobby and in-game board.
 * https://polyhaven.com/a/wooden_picnic_table
 */
export function RoundTable({ scale = 1 }: Props) {
  const { scene } = useGLTF(TABLE_URL)
  const xz = BASE_SCALE * scale

  useLayoutEffect(() => {
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = !isCoarseMobile
      mesh.receiveShadow = true
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) {
        const mat = m as THREE.MeshStandardMaterial
        if (!mat || !('color' in mat)) continue
        mat.envMapIntensity = 0.35
        if (!mat.emissive || mat.emissive.getHex() === 0) {
          mat.emissive = new THREE.Color('#2a241c')
          mat.emissiveIntensity = 0.05
        }
        mat.needsUpdate = true
      }
    })
  }, [scene])

  return (
    <group
      scale={[xz, BASE_SCALE, xz]}
      onClick={(e) => {
        e.stopPropagation()
        clearOrbitFocus()
      }}
    >
      <Clone object={scene} castShadow={!isCoarseMobile} receiveShadow />
    </group>
  )
}

useGLTF.preload(TABLE_URL)
