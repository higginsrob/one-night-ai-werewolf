import { useEffect, useRef, useState } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { cssFilterFor, type MediaFilterId } from '../mediaFilters'

/** Match the card face plane (~portrait playing-card). */
const TEX_W = 320
const TEX_H = 504

/**
 * Survive React StrictMode remounts: effect cleanups must not dispose the
 * texture currently shown on a card (setState during fake-unmount is ignored,
 * which previously left a disposed map in state → solid black faces).
 */
const stillCache = new Map<string, THREE.CanvasTexture>()

/** Draw `source` with object-fit: cover. Never stretches. */
function drawCover(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  filterCss: string,
): boolean {
  if (!srcW || !srcH) return false
  const scale = Math.max(TEX_W / srcW, TEX_H / srcH)
  const dw = srcW * scale
  const dh = srcH * scale
  const dx = (TEX_W - dw) / 2
  const dy = (TEX_H - dh) / 2

  ctx.save()
  ctx.clearRect(0, 0, TEX_W, TEX_H)
  const applyFilter = Boolean(filterCss && filterCss !== 'none')
  try {
    ctx.filter = applyFilter ? filterCss : 'none'
    ctx.drawImage(source, dx, dy, dw, dh)
  } catch {
    ctx.restore()
    ctx.save()
    ctx.clearRect(0, 0, TEX_W, TEX_H)
    ctx.filter = 'none'
    try {
      ctx.drawImage(source, dx, dy, dw, dh)
    } catch {
      ctx.restore()
      return false
    }
  }
  ctx.restore()
  return true
}

function cacheKey(url: string, filterCss: string): string {
  return `${url}\n${filterCss}`
}

function loadStillTexture(
  url: string,
  filterCss: string,
): Promise<THREE.CanvasTexture> {
  const key = cacheKey(url, filterCss)
  const hit = stillCache.get(key)
  if (hit) return Promise.resolve(hit)

  return new Promise((resolve, reject) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      const existing = stillCache.get(key)
      if (existing) {
        resolve(existing)
        return
      }
      if (!img.naturalWidth) {
        reject(new Error('empty image'))
        return
      }
      const canvas = document.createElement('canvas')
      canvas.width = TEX_W
      canvas.height = TEX_H
      const ctx = canvas.getContext('2d')
      if (
        !ctx ||
        !drawCover(ctx, img, img.naturalWidth, img.naturalHeight, filterCss)
      ) {
        reject(new Error('draw failed'))
        return
      }
      const texture = new THREE.CanvasTexture(canvas)
      texture.colorSpace = THREE.SRGBColorSpace
      texture.minFilter = THREE.LinearFilter
      texture.magFilter = THREE.LinearFilter
      texture.generateMipmaps = false
      texture.needsUpdate = true
      stillCache.set(key, texture)
      resolve(texture)
    }
    img.onerror = () => reject(new Error('image load failed'))
    img.src = url
  })
}

type Args = {
  photoDataUrl?: string | null
  mediaFilter: MediaFilterId | string | null | undefined
}

/**
 * Face map for player cards. Stills are cached by URL+filter and never
 * disposed on effect cleanup (see stillCache).
 */
export function useFilteredFaceTexture({
  photoDataUrl,
  mediaFilter,
}: Args): THREE.Texture | null {
  const filterCss = cssFilterFor(mediaFilter)
  const invalidate = useThree((s) => s.invalidate)
  const invalidateRef = useRef(invalidate)
  invalidateRef.current = invalidate

  const photoUrl =
    typeof photoDataUrl === 'string' && photoDataUrl.trim()
      ? photoDataUrl.trim()
      : null

  const [still, setStill] = useState<THREE.CanvasTexture | null>(() =>
    photoUrl ? (stillCache.get(cacheKey(photoUrl, filterCss)) ?? null) : null,
  )

  useEffect(() => {
    if (!photoUrl) {
      setStill(null)
      return
    }

    const key = cacheKey(photoUrl, filterCss)
    const cached = stillCache.get(key)
    if (cached) {
      setStill(cached)
      invalidateRef.current()
      return
    }

    let alive = true
    void loadStillTexture(photoUrl, filterCss)
      .then((tex) => {
        if (!alive) return
        setStill(tex)
        invalidateRef.current()
      })
      .catch(() => {
        if (alive) setStill(null)
      })

    return () => {
      alive = false
    }
  }, [photoUrl, filterCss])

  return still
}
