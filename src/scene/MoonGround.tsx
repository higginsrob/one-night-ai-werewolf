import { useLayoutEffect, useMemo } from 'react'
import { useTexture } from '@react-three/drei'
import * as THREE from 'three'
import grassUrl from '../assets/grass.jpg'
import { isCoarseMobile } from './deviceProfile'

/** Base tile density across the floor disk UVs. */
const GRASS_REPEAT = isCoarseMobile ? 5 : 7

/**
 * Breaks obvious tiling by blending two differently scaled/rotated
 * samples of the same grass map with cheap noise weights.
 */
function attachGrassDeTile(
  material: THREE.MeshStandardMaterial,
  repeat: number,
): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGrassRepeat = { value: repeat }
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        uniform float uGrassRepeat;

        float grassHash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }

        float grassNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          float a = grassHash(i);
          float b = grassHash(i + vec2(1.0, 0.0));
          float c = grassHash(i + vec2(0.0, 1.0));
          float d = grassHash(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
        }
        `,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        #ifdef USE_MAP
          vec2 baseUv = vMapUv;
          vec2 uvA = baseUv * uGrassRepeat;

          // Second sample: different scale + rotation so seams don't line up
          float ang = 0.7;
          float ca = cos(ang);
          float sa = sin(ang);
          vec2 uvB = baseUv * uGrassRepeat * 1.67;
          uvB = mat2(ca, -sa, sa, ca) * (uvB - 0.5) + 0.5 + vec2(0.37, 0.19);

          float w = smoothstep(0.28, 0.72, grassNoise(baseUv * 3.4));
          vec4 texA = texture2D(map, uvA);
          vec4 texB = texture2D(map, uvB);
          vec4 sampledDiffuseColor = mix(texA, texB, w);

          // Soft macro tint so large areas don't read as a grid
          float macro = 0.88 + 0.22 * grassNoise(baseUv * 1.15 + 2.7);
          sampledDiffuseColor.rgb *= macro;

          #ifdef DECODE_VIDEO_TEXTURE
            sampledDiffuseColor = sRGBTransferEOTF(sampledDiffuseColor);
          #endif

          diffuseColor *= sampledDiffuseColor;
        #endif
        `,
      )
  }
  material.customProgramCacheKey = () => `grass-detile-${repeat}`
}

/**
 * Grass floor disk — shared by lobby, night, and day.
 */
export function MoonGround({ visible = true }: { visible?: boolean }) {
  const map = useTexture(grassUrl)
  const material = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({
      color: '#6a8f4e',
      emissive: '#2a3e1c',
      emissiveIntensity: 0.04,
      roughness: 0.88,
      metalness: 0,
      envMapIntensity: 0,
    })
    attachGrassDeTile(mat, GRASS_REPEAT)
    return mat
  }, [])

  useLayoutEffect(() => {
    map.colorSpace = THREE.SRGBColorSpace
    map.wrapS = THREE.RepeatWrapping
    map.wrapT = THREE.RepeatWrapping
    // UV repeat handled in the shader (dual-scale blend).
    map.repeat.set(1, 1)
    map.anisotropy = isCoarseMobile ? 2 : 4
    map.generateMipmaps = true
    map.minFilter = THREE.LinearMipmapLinearFilter
    map.magFilter = THREE.LinearFilter
    map.needsUpdate = true
    material.map = map
    material.needsUpdate = true
  }, [map, material])

  useLayoutEffect(() => {
    return () => {
      material.dispose()
    }
  }, [material])

  if (!visible) return null

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0.005, 0]}
      receiveShadow={!isCoarseMobile}
      material={material}
    >
      <circleGeometry args={[28, 64]} />
    </mesh>
  )
}
