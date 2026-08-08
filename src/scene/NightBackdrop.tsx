import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useFrame, useLoader, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import duskUrl from '../assets/dusk.json?url'
import nightUrl from '../assets/night.json?url'
import { isCoarseMobile } from './deviceProfile'
import { getSceneBackdrop, type SceneBackdropVariant } from './sceneBackdrop'
import {
  DAY_HDRI_OPTIONS,
  DEFAULT_SCENE_VISUALS,
  NIGHT_HDRI_OPTIONS,
  type SceneVisuals,
} from './sceneVisuals'

type EditorExport = {
  scene: Record<string, unknown>
  project?: {
    shadows?: boolean
    shadowType?: number
    toneMapping?: number
    toneMappingExposure?: number
  }
}

const SHADOW_MAP_SIZE = isCoarseMobile ? 512 : 1024
/** Cap sky GPU upload; assets ship at 2048, but re-imports may be larger. */
const SKY_MAX_DIM = isCoarseMobile ? 1024 : 2048

const NIGHT_INTENSITY_FALLBACK = 0.06
const NIGHT_BLUR_FALLBACK = 0.18
const DUSK_INTENSITY_FALLBACK = 0.42
const DUSK_BLUR_FALLBACK = 0.14

function disposeMaterial(material: THREE.Material) {
  const mat = material as THREE.MeshStandardMaterial & Record<string, unknown>
  for (const value of Object.values(mat)) {
    if (value instanceof THREE.Texture) value.dispose()
  }
  material.dispose()
}

/**
 * Downscale an equirect sky before GPU upload. Prevents iOS Safari OOM when
 * editor exports sneak back in at 4K/8K.
 */
function clampSkyTexture(tex: THREE.Texture, maxDim: number): THREE.Texture {
  const img = tex.image as
    | HTMLImageElement
    | ImageBitmap
    | HTMLCanvasElement
    | OffscreenCanvas
    | undefined
  if (!img || !('width' in img) || !img.width || !img.height) return tex
  const w = img.width
  const h = img.height
  if (Math.max(w, h) <= maxDim) return tex

  const scale = maxDim / Math.max(w, h)
  const nw = Math.max(2, Math.round(w * scale) & ~1)
  const nh = Math.max(2, Math.round(h * scale) & ~1)
  const canvas = document.createElement('canvas')
  canvas.width = nw
  canvas.height = nh
  const ctx = canvas.getContext('2d')
  if (!ctx) return tex
  ctx.drawImage(img as CanvasImageSource, 0, 0, nw, nh)

  const smaller = new THREE.CanvasTexture(canvas)
  smaller.mapping = tex.mapping
  smaller.colorSpace = tex.colorSpace
  smaller.needsUpdate = true
  tex.dispose()
  return smaller
}

function disposeObjectTree(root: THREE.Object3D) {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    if (mesh.material) {
      const materials = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material]
      for (const material of materials) disposeMaterial(material)
    }
    if (child instanceof THREE.SpotLight || child instanceof THREE.DirectionalLight) {
      const map = child.shadow.map
      if (map) {
        map.dispose()
        child.shadow.map = null
      }
    }
  })
}

function skyDefaults(raw: EditorExport, intensityFallback: number, blurFallback: number) {
  const exportObject = (raw.scene as { object?: Record<string, number> }).object
  return {
    intensity: exportObject?.backgroundIntensity ?? intensityFallback,
    blurriness: exportObject?.backgroundBlurriness ?? blurFallback,
  }
}

type Props = {
  visuals?: SceneVisuals
}

/**
 * Load only the equirect JPEGs currently selected. Failures are ignored so a
 * missing/404 HDRI cannot take down the whole Suspense tree (classic sky stays).
 */
function useSelectedPolyHdriTextures(visuals: SceneVisuals): Map<string, THREE.Texture> {
  const [polyByUrl, setPolyByUrl] = useState(() => new Map<string, THREE.Texture>())

  useEffect(() => {
    const nightUrl =
      NIGHT_HDRI_OPTIONS.find((o) => o.id === visuals.nightHdri)?.url ?? null
    const dayUrl =
      DAY_HDRI_OPTIONS.find((o) => o.id === visuals.dayHdri)?.url ?? null
    const wanted = [nightUrl, dayUrl].filter((u): u is string => Boolean(u))
    if (wanted.length === 0) {
      setPolyByUrl(new Map())
      return
    }

    let cancelled = false
    const loader = new THREE.TextureLoader()
    const owned: THREE.Texture[] = []

    void Promise.all(
      wanted.map(
        (url) =>
          new Promise<[string, THREE.Texture | null]>((resolve) => {
            loader.load(
              url,
              (tex) => resolve([url, tex]),
              undefined,
              () => resolve([url, null]),
            )
          }),
      ),
    ).then((results) => {
      if (cancelled) {
        for (const [, tex] of results) tex?.dispose()
        return
      }
      const next = new Map<string, THREE.Texture>()
      for (const [url, tex] of results) {
        if (!tex) continue
        owned.push(tex)
        next.set(url, tex)
      }
      setPolyByUrl(next)
    })

    return () => {
      cancelled = true
      for (const tex of owned) tex.dispose()
    }
  }, [visuals.nightHdri, visuals.dayHdri])

  return polyByUrl
}

/**
 * Night/dusk sky + night lighting rig.
 * Variant / intensity driven by `setSceneBackdrop` (werewolf day/night playback).
 * HDRI picks + blur come from host-synced {@link SceneVisuals}.
 *
 * Classic editor skies load via Suspense; Poly Haven JPEGs load async so the
 * lobby (and live camera cards) are not blocked on multi-MB downloads.
 */
export function NightBackdrop({
  visuals = DEFAULT_SCENE_VISUALS,
}: Props) {
  const { scene, gl } = useThree()
  const [nightRaw, duskRaw] = useLoader(
    THREE.FileLoader,
    [nightUrl, duskUrl],
    (loader) => {
      loader.setResponseType('json')
    },
  ) as unknown as [EditorExport, EditorExport]

  const polySourceByUrl = useSelectedPolyHdriTextures(visuals)
  const [classicEpoch, setClassicEpoch] = useState(0)

  const visualsRef = useRef(visuals)
  visualsRef.current = visuals

  const skiesRef = useRef<{
    classicNight: THREE.Texture | THREE.Color | null
    classicDusk: THREE.Texture | THREE.Color | null
    polyByUrl: Map<string, THREE.Texture>
    nightDefaults: { intensity: number; blurriness: number }
    duskDefaults: { intensity: number; blurriness: number }
  } | null>(null)
  const appliedVariant = useRef<SceneBackdropVariant | null>(null)
  const appliedHdriKey = useRef<string | null>(null)
  const fadeRef = useRef<{
    from: SceneBackdropVariant
    to: SceneBackdropVariant
    startedAt: number
    durationMs: number
  } | null>(null)
  const maxDimRef = useRef(SKY_MAX_DIM)

  useLayoutEffect(() => {
    const objectLoader = new THREE.ObjectLoader()
    const nightParsed = objectLoader.parse(nightRaw.scene) as THREE.Scene
    const duskParsed = objectLoader.parse(duskRaw.scene) as THREE.Scene

    const prev = {
      background: scene.background,
      environment: scene.environment,
      backgroundBlurriness: scene.backgroundBlurriness,
      backgroundIntensity: scene.backgroundIntensity,
      toneMapping: gl.toneMapping,
      exposure: gl.toneMappingExposure,
    }

    const ownedTextures: THREE.Texture[] = []

    const maxDim = Math.min(
      SKY_MAX_DIM,
      gl.capabilities.maxTextureSize || SKY_MAX_DIM,
    )
    maxDimRef.current = maxDim

    const prepareEnvMap = (tex: THREE.Texture, clone: boolean) => {
      const source = clone ? tex.clone() : tex
      if (clone) source.needsUpdate = true
      const clamped = clampSkyTexture(source, maxDim)
      clamped.mapping = THREE.EquirectangularReflectionMapping
      clamped.colorSpace = THREE.SRGBColorSpace
      clamped.needsUpdate = true
      ownedTextures.push(clamped)
      return clamped
    }

    const takeSky = (parsed: THREE.Scene) => {
      const sky = parsed.background
      if (sky instanceof THREE.Texture) return prepareEnvMap(sky, false)
      return sky ?? null
    }

    const nightSky = takeSky(nightParsed)
    const duskSky = takeSky(duskParsed)
    const nightDefaults = skyDefaults(
      nightRaw,
      NIGHT_INTENSITY_FALLBACK,
      NIGHT_BLUR_FALLBACK,
    )
    const duskDefaults = skyDefaults(
      duskRaw,
      DUSK_INTENSITY_FALLBACK,
      DUSK_BLUR_FALLBACK,
    )
    skiesRef.current = {
      classicNight: nightSky,
      classicDusk: duskSky,
      polyByUrl: new Map(),
      nightDefaults,
      duskDefaults,
    }

    if (nightSky) scene.background = nightSky
    scene.backgroundBlurriness = nightDefaults.blurriness
    scene.backgroundIntensity = nightDefaults.intensity
    appliedVariant.current = 'night'
    appliedHdriKey.current = null

    // Reuse the same texture for env — cloning doubled GPU memory and OOM'd iPads.
    if (nightSky instanceof THREE.Texture) {
      scene.environment = nightSky
    }

    if (nightRaw.project?.toneMapping != null) {
      gl.toneMapping = nightRaw.project.toneMapping as THREE.ToneMapping
    }
    if (nightRaw.project?.toneMappingExposure != null) {
      gl.toneMappingExposure = nightRaw.project.toneMappingExposure
    }

    const project = nightRaw.project
    const wantShadows = Boolean(project?.shadows) && !isCoarseMobile
    if (wantShadows) {
      gl.shadowMap.enabled = true
      // PCFSoftShadowMap is deprecated in recent three.js (aliases to PCF).
      gl.shadowMap.type = THREE.PCFShadowMap
    } else {
      gl.shadowMap.enabled = false
    }

    const root = new THREE.Group()
    root.name = 'NightWorld'

    for (const child of [...nightParsed.children]) {
      if (child.name === 'Product Grid') continue

      // Floor comes from <MoonGround /> (grass); skip the dark editor disk.
      if (child.name === 'Ground') continue


      if ((child as THREE.Light).isLight) {
        const light = child as THREE.SpotLight
        const isKey = light.name === 'FrontRightSpotLight'
        light.castShadow = wantShadows && isKey
        if (light.castShadow) {
          light.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE)
          light.shadow.bias = -0.0002
          light.shadow.normalBias = 0.01
          light.shadow.radius = 2
          light.shadow.camera.near = 10
          light.shadow.camera.far = 32
          light.shadow.camera.updateProjectionMatrix()
        }
        root.add(light)
        light.target.position.set(0, 1.2, 0)
        root.add(light.target)
      }
    }

    scene.add(root)
    setClassicEpoch((n) => n + 1)

    return () => {
      scene.remove(root)
      disposeObjectTree(root)
      disposeObjectTree(nightParsed)
      disposeObjectTree(duskParsed)
      for (const tex of ownedTextures) tex.dispose()
      skiesRef.current = null
      appliedVariant.current = null
      appliedHdriKey.current = null
      fadeRef.current = null
      scene.background = prev.background
      scene.environment = prev.environment
      scene.backgroundBlurriness = prev.backgroundBlurriness
      scene.backgroundIntensity = prev.backgroundIntensity
      gl.toneMapping = prev.toneMapping
      gl.toneMappingExposure = prev.exposure
    }
  }, [nightRaw, duskRaw, scene, gl])

  // Swap in poly HDRIs when async loads finish (or the host changes selection).
  useLayoutEffect(() => {
    const skies = skiesRef.current
    if (!skies) return

    const maxDim = maxDimRef.current
    const nextPrepared = new Map<string, THREE.Texture>()
    for (const [url, tex] of polySourceByUrl) {
      // Skip sources that were disposed by a superseded load.
      if (!tex.image) continue
      const source = tex.clone()
      source.needsUpdate = true
      const clamped = clampSkyTexture(source, maxDim)
      clamped.mapping = THREE.EquirectangularReflectionMapping
      clamped.colorSpace = THREE.SRGBColorSpace
      clamped.needsUpdate = true
      nextPrepared.set(url, clamped)
    }
    skies.polyByUrl = nextPrepared
    // Force sky re-bind on next frame.
    appliedHdriKey.current = null

    return () => {
      for (const tex of nextPrepared.values()) tex.dispose()
      if (skiesRef.current?.polyByUrl === nextPrepared) {
        skiesRef.current.polyByUrl = new Map()
      }
    }
  }, [polySourceByUrl, classicEpoch])

  useFrame(() => {
    const skies = skiesRef.current
    if (!skies) return

    const v = visualsRef.current
    const nightUrl =
      NIGHT_HDRI_OPTIONS.find((o) => o.id === v.nightHdri)?.url ?? null
    const dayUrl =
      DAY_HDRI_OPTIONS.find((o) => o.id === v.dayHdri)?.url ?? null
    const nightSky =
      (nightUrl ? skies.polyByUrl.get(nightUrl) : null) ?? skies.classicNight
    const duskSky =
      (dayUrl ? skies.polyByUrl.get(dayUrl) : null) ?? skies.classicDusk
    const hdriKey = `${v.nightHdri}|${v.dayHdri}`

    const cfg = getSceneBackdrop()
    const targetVariant = cfg.variant
    const defaults =
      targetVariant === 'dusk' ? skies.duskDefaults : skies.nightDefaults

    if (appliedVariant.current !== targetVariant && !fadeRef.current) {
      fadeRef.current = {
        from: appliedVariant.current ?? 'night',
        to: targetVariant,
        startedAt: performance.now(),
        durationMs: 900,
      }
    }

    let intensity =
      cfg.intensity != null ? cfg.intensity : defaults.intensity
    let blurriness =
      cfg.blurriness != null ? cfg.blurriness : defaults.blurriness

    const fade = fadeRef.current
    if (fade) {
      const t = Math.min(1, (performance.now() - fade.startedAt) / fade.durationMs)
      const fromDefaults =
        fade.from === 'dusk' ? skies.duskDefaults : skies.nightDefaults
      const toDefaults =
        fade.to === 'dusk' ? skies.duskDefaults : skies.nightDefaults
      const baseFrom = cfg.intensity != null ? cfg.intensity : fromDefaults.intensity
      const baseTo = cfg.intensity != null ? cfg.intensity : toDefaults.intensity
      // Dip through near-black at the midpoint, then swap sky texture.
      if (t < 0.5) {
        const u = t / 0.5
        intensity = baseFrom * (1 - u)
        if (appliedVariant.current !== fade.from) {
          const sky = fade.from === 'dusk' ? duskSky : nightSky
          if (sky) scene.background = sky
          appliedVariant.current = fade.from
        }
      } else {
        const u = (t - 0.5) / 0.5
        intensity = baseTo * u
        if (appliedVariant.current !== fade.to) {
          const sky = fade.to === 'dusk' ? duskSky : nightSky
          if (sky) scene.background = sky
          appliedVariant.current = fade.to
        }
      }
      blurriness =
        fromDefaults.blurriness * (1 - t) + toDefaults.blurriness * t
      if (cfg.blurriness != null) blurriness = cfg.blurriness
      if (t >= 1) {
        fadeRef.current = null
        appliedHdriKey.current = hdriKey
      }
    } else if (
      appliedVariant.current !== targetVariant ||
      appliedHdriKey.current !== hdriKey
    ) {
      const sky = targetVariant === 'dusk' ? duskSky : nightSky
      if (sky) scene.background = sky
      if (sky instanceof THREE.Texture) scene.environment = sky
      appliedVariant.current = targetVariant
      appliedHdriKey.current = hdriKey
    }

    if (!v.backgroundBlur) blurriness = 0
    else blurriness *= v.backgroundBlurAmount

    scene.backgroundIntensity = intensity
    scene.backgroundBlurriness = blurriness
  })

  return null
}
