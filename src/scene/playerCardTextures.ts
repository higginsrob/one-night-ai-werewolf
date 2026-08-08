import * as THREE from 'three'

const TEX_W = 256
const TEX_H = 384
const CACHE_VER = 'v6-glass'

const cache = new Map<string, THREE.CanvasTexture>()

function parseHex(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '').trim()
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h.padEnd(6, '0').slice(0, 6)
  const n = Number.parseInt(full, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function rgba(r: number, g: number, b: number, a = 1): string {
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function finishTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.generateMipmaps = false
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.anisotropy = 4
  texture.needsUpdate = true
  return texture
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/**
 * Dark glass card face with a thin tint of the player's color on the rim.
 * Center is covered by video / photo / initial when present.
 */
export function getPlayerCardBodyTexture(colorHex: string): THREE.CanvasTexture {
  const key = `${CACHE_VER}:${colorHex.toLowerCase()}`
  const hit = cache.get(key)
  if (hit) return hit

  const { r, g, b } = parseHex(colorHex)
  const canvas = document.createElement('canvas')
  canvas.width = TEX_W
  canvas.height = TEX_H
  const ctx = canvas.getContext('2d')!

  // Rim tint so square texture corners match the colored border mesh.
  const rimColor = rgba(mix(r, 6, 0.4), mix(g, 6, 0.4), mix(b, 8, 0.4))
  ctx.fillStyle = rimColor
  ctx.fillRect(0, 0, TEX_W, TEX_H)

  const glass = ctx.createLinearGradient(0, 0, 0, TEX_H)
  glass.addColorStop(0, '#0c0c10')
  glass.addColorStop(1, '#050508')

  const rim = 10
  const radius = 22
  ctx.fillStyle = glass
  roundRectPath(ctx, rim, rim, TEX_W - rim * 2, TEX_H - rim * 2, radius - 6)
  ctx.fill()

  ctx.strokeStyle = rgba(mix(r, 16, 0.5), mix(g, 16, 0.5), mix(b, 20, 0.5), 0.55)
  ctx.lineWidth = 1.5
  roundRectPath(
    ctx,
    rim + 3,
    rim + 3,
    TEX_W - (rim + 3) * 2,
    TEX_H - (rim + 3) * 2,
    radius - 9,
  )
  ctx.stroke()

  const texture = finishTexture(canvas)
  cache.set(key, texture)
  return texture
}
