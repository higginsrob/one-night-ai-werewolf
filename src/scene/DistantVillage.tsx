import { Clone, useGLTF } from '@react-three/drei'
import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { publicAsset } from '../publicUrl'
import { isCoarseMobile } from './deviceProfile'
import { useBackdropDayMix } from './useBackdropDayMix'

const TREE_URL = publicAsset('models/web/jacaranda_tree.glb')
const GRASS_URL = publicAsset('models/web/grass_medium_02.glb')

type Kind = 'tree' | 'grass'

type Placement = {
  angle: number
  radius: number
  kind: Kind
  /** Grass variant name. */
  module?: string
  scale: number
  yaw: number
}

/** Deterministic pseudo-random in [0, 1). */
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453
  return x - Math.floor(x)
}

const GRASS_VARIANTS = [
  'grass_medium_02_a',
  'grass_medium_02_b',
  'grass_medium_02_c',
  'grass_medium_02_d',
  'grass_medium_02_e',
] as const

function pushTree(
  out: Placement[],
  seed: number,
  angle: number,
  radius: number,
  scaleBase = 0.22,
) {
  out.push({
    angle,
    radius,
    kind: 'tree',
    scale: scaleBase + rand(seed * 1.4) * 0.16,
    yaw: rand(seed * 8.1) * Math.PI * 2,
  })
}

/**
 * Radial depth for trees: near rim stays ~where it is now; most samples
 * push back so the line doesn't read as a uniform ring.
 * `near` ≈ closest trunk distance; `depth` = how far others can go.
 */
function treeRadius(seed: number, near: number, depth: number): number {
  // Soft bias toward the back (sqrt) with a minority staying near the rim.
  const t = Math.pow(rand(seed * 9.3), 0.55)
  const wobble = (rand(seed * 2.2) - 0.5) * 1.1
  return near + t * depth + wobble
}

function buildLayout(): Placement[] {
  const out: Placement[] = []

  // Horizon arc (−Z): clusters past orbit maxDistance (~12) so zoom-out
  // never clips into canopy. Near rim ≈ former r0; depth stretches outward.
  const clusters = isCoarseMobile
    ? [
        { center: Math.PI - 0.95, spread: 0.48, count: 3, near: 19.2, depth: 8.5 },
        { center: Math.PI - 0.35, spread: 0.34, count: 4, near: 18.8, depth: 10.5 },
        { center: Math.PI + 0.15, spread: 0.55, count: 3, near: 19.0, depth: 9.0 },
        { center: Math.PI + 0.72, spread: 0.4, count: 4, near: 19.4, depth: 11.0 },
      ]
    : [
        { center: Math.PI - 1.15, spread: 0.42, count: 4, near: 18.6, depth: 9.5 },
        { center: Math.PI - 0.68, spread: 0.6, count: 5, near: 18.4, depth: 12.0 },
        { center: Math.PI - 0.22, spread: 0.38, count: 3, near: 17.8, depth: 8.0 },
        { center: Math.PI + 0.18, spread: 0.52, count: 6, near: 18.2, depth: 11.5 },
        { center: Math.PI + 0.62, spread: 0.45, count: 4, near: 18.8, depth: 10.0 },
        { center: Math.PI + 1.05, spread: 0.5, count: 5, near: 18.5, depth: 12.5 },
      ]

  let treeSeed = 1
  for (let c = 0; c < clusters.length; c++) {
    const { center, spread, count, near, depth } = clusters[c]!
    for (let i = 0; i < count; i++) {
      const s = treeSeed++
      // Bias toward cluster center with occasional outliers.
      const u = rand(s * 3.7)
      const offset = (u * 2 - 1) * spread * (0.35 + rand(s * 5.1) * 0.9)
      const angle = center + offset
      pushTree(
        out,
        s,
        angle,
        treeRadius(s, near, depth),
        0.28 + rand(s * 0.7) * 0.08,
      )
    }
  }

  // Loners fill arc gaps — mix of near rim and deep backdrop.
  const lonerCount = isCoarseMobile ? 3 : 7
  for (let i = 0; i < lonerCount; i++) {
    const s = treeSeed++
    const t = rand(s * 13.1)
    const angle = Math.PI + (t - 0.5) * Math.PI * 1.05
    pushTree(
      out,
      s,
      angle,
      treeRadius(s, 17.8, 11.5),
      0.26 + rand(s * 1.1) * 0.1,
    )
  }

  // Flank groves — closest trunks hold the near rim; siblings fall back.
  const groveSpecs = isCoarseMobile
    ? [
        { a0: Math.PI - 0.55, aSpan: 0.55, count: 3, near: 17.6, depth: 7.5 },
        { a0: -0.15 * Math.PI, aSpan: -0.55 * Math.PI, count: 4, near: 17.8, depth: 8.5 },
      ]
    : [
        { a0: Math.PI - 0.25, aSpan: 0.7, count: 5, near: 17.4, depth: 9.0 },
        { a0: Math.PI - 0.9, aSpan: 0.45, count: 3, near: 17.8, depth: 10.5 },
        { a0: -0.02 * Math.PI, aSpan: -0.55 * Math.PI, count: 6, near: 17.6, depth: 9.5 },
        { a0: -0.35 * Math.PI, aSpan: -0.35 * Math.PI, count: 4, near: 18.2, depth: 11.0 },
      ]

  for (let g = 0; g < groveSpecs.length; g++) {
    const { a0, aSpan, count, near, depth } = groveSpecs[g]!
    for (let i = 0; i < count; i++) {
      const s = treeSeed++
      // Non-uniform along the arc (cubic bias + jitter).
      const u = rand(s * 11.3)
      const skewed = u * u * (3 - 2 * u) // smoothstep-ish clustering
      const angle = a0 + skewed * aSpan + (rand(s * 2.9) - 0.5) * 0.18
      pushTree(out, s, angle, treeRadius(s, near, depth), 0.26)
    }
  }

  // 3D tuft patch around the table (+ a bit beyond the seats).
  // Outer disk stays procedural via <MoonGround />.
  // Smaller tufts + higher count so the floor reads as a field, not props.
  const grassCount = isCoarseMobile ? 280 : 640
  const rInner = 3.35 // just outside the scaled picnic table
  const rOuter = 7.2
  for (let i = 0; i < grassCount; i++) {
    const a = rand(i * 17.3) * Math.PI * 2
    // Mild inward bias so coverage still hugs the table.
    const u = rand(i * 5.7)
    const uBias = Math.pow(u, 1.35)
    const radius = Math.sqrt(
      rInner * rInner + uBias * (rOuter * rOuter - rInner * rInner),
    )
    out.push({
      angle: a,
      radius,
      kind: 'grass',
      module: GRASS_VARIANTS[i % GRASS_VARIANTS.length],
      scale: 0.75 + rand(i * 3.2) * 0.55,
      yaw: rand(i * 2.1) * Math.PI * 2,
    })
  }

  return out
}

/**
 * Clone a named child and re-anchor so its bbox rests on y=0 at the origin.
 */
function anchorModule(
  scene: THREE.Object3D,
  name: string,
): THREE.Object3D | null {
  const src = scene.getObjectByName(name)
  if (!src) return null

  const clone = src.clone(true)
  clone.position.set(0, 0, 0)
  clone.rotation.set(0, 0, 0)
  clone.scale.set(1, 1, 1)
  clone.updateMatrixWorld(true)

  const box = new THREE.Box3().setFromObject(clone)
  if (!box.isEmpty()) {
    const center = box.getCenter(new THREE.Vector3())
    clone.position.set(-center.x, -box.min.y, -center.z)
  }

  const wrapper = new THREE.Group()
  wrapper.add(clone)
  wrapper.name = name
  return wrapper
}

function tuneMaterials(
  root: THREE.Object3D,
  opts: { grass?: boolean } = {},
) {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh) return
    // Grass never casts — dozens of tufts would thrash the shadow map.
    mesh.castShadow = opts.grass ? false : !isCoarseMobile
    mesh.receiveShadow = !isCoarseMobile
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const m of mats) {
      const mat = m as THREE.MeshStandardMaterial
      if (!mat || !('color' in mat)) continue
      mat.envMapIntensity = opts.grass ? 0.15 : 0.25
      if (!mat.emissive || mat.emissive.getHex() === 0) {
        mat.emissive = new THREE.Color(opts.grass ? '#1e3a18' : '#2a241c')
        mat.emissiveIntensity = opts.grass ? 0.14 : 0.06
      }
      // Alpha-cut blades/leaves (BLEND sorts poorly under night lighting).
      if (mat.transparent || mat.alphaTest > 0) {
        mat.alphaTest = opts.grass ? 0.22 : 0.35
        mat.transparent = false
        mat.depthWrite = true
      }
      mat.needsUpdate = true
    }
  })
}

function buildTemplateMap(
  scene: THREE.Object3D,
  names: readonly string[],
  opts: { grass?: boolean } = {},
): Map<string, THREE.Object3D> {
  const map = new Map<string, THREE.Object3D>()
  for (const name of names) {
    const anchored = anchorModule(scene, name)
    if (anchored) {
      tuneMaterials(anchored, opts)
      map.set(name, anchored)
    }
  }
  return map
}

/**
 * Distant rim — jacaranda trees and grass tufts around the table.
 * Soft fill light ramps up with the dusk/day sky.
 */
export function DistantVillage() {
  const fill = useRef<THREE.HemisphereLight>(null)
  const layout = useMemo(() => buildLayout(), [])

  const { scene: treeScene } = useGLTF(TREE_URL)
  const { scene: grassScene } = useGLTF(GRASS_URL)

  useLayoutEffect(() => {
    tuneMaterials(treeScene)
    tuneMaterials(grassScene, { grass: true })
  }, [treeScene, grassScene])

  const grassTemplates = useMemo(
    () => buildTemplateMap(grassScene, GRASS_VARIANTS, { grass: true }),
    [grassScene],
  )

  const visible = useMemo(() => layout, [layout])

  useBackdropDayMix((mix) => {
    if (fill.current) {
      fill.current.intensity = 0.12 + 0.45 * mix
      fill.current.color.set(mix > 0.5 ? '#c8b89a' : '#6a7a9a')
      fill.current.groundColor.set(mix > 0.5 ? '#3a5a28' : '#1a2418')
    }
  })

  return (
    <>
      <hemisphereLight ref={fill} args={['#6a7a9a', '#1a2418', 0.12]} />
      <group>
        {visible.map((b, i) => {
          const x = Math.cos(b.angle) * b.radius
          const z = Math.sin(b.angle) * b.radius
          const template =
            b.kind === 'tree'
              ? treeScene
              : grassTemplates.get(b.module ?? '')
          if (!template) return null
          return (
            <group
              key={`${b.kind}-${i}`}
              position={[x, 0, z]}
              rotation={[0, b.yaw, 0]}
              scale={b.scale}
            >
              <Clone
                object={template}
                castShadow={b.kind !== 'grass' && !isCoarseMobile}
                receiveShadow={!isCoarseMobile}
              />
            </group>
          )
        })}
      </group>
    </>
  )
}

useGLTF.preload(TREE_URL)
useGLTF.preload(GRASS_URL)
