import * as THREE from 'three'

function isQuarterTurn(rotation: number): boolean {
  const r =
    ((rotation % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
  const q = Math.PI / 2
  return (
    Math.abs(r - q) < 1e-3 ||
    Math.abs(r - 3 * q) < 1e-3
  )
}

/**
 * object-fit: cover for a texture on a plane.
 * Crops the larger dimension so the image fills without squeezing.
 * `rotation` is applied around the texture center (radians).
 */
export function applyCoverMap(
  tex: THREE.Texture,
  imageWidth: number,
  imageHeight: number,
  planeAspect = 1,
  mirrorX = false,
  rotation = 0,
): void {
  if (!imageWidth || !imageHeight) return

  // ±90° swaps which image axis feeds U vs V for cover math.
  const imgW = isQuarterTurn(rotation) ? imageHeight : imageWidth
  const imgH = isQuarterTurn(rotation) ? imageWidth : imageHeight
  const imageAspect = imgW / imgH
  let repeatX = 1
  let repeatY = 1
  let offsetX = 0
  let offsetY = 0

  if (imageAspect > planeAspect) {
    // Wider than the plane — crop left/right
    repeatX = planeAspect / imageAspect
    offsetX = (1 - repeatX) / 2
  } else {
    // Taller than the plane — crop top/bottom
    repeatY = imageAspect / planeAspect
    offsetY = (1 - repeatY) / 2
  }

  tex.center.set(0.5, 0.5)
  tex.rotation = rotation

  if (mirrorX) {
    tex.repeat.set(-repeatX, repeatY)
    tex.offset.set(offsetX + repeatX, offsetY)
  } else {
    tex.repeat.set(repeatX, repeatY)
    tex.offset.set(offsetX, offsetY)
  }

  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.needsUpdate = true
}
