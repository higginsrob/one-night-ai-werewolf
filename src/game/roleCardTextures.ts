import * as THREE from 'three'
import { CARD_BACK_URL, ROLE_CARD_FACE_URL, ROLE_TOKEN_URL } from './onwArt'
import { drawRoleIcon } from './roleIcons'
import { ROLE_INFO } from './roles'
import type { WerewolfRole } from './werewolfTypes'

const FACE_W = 880
const FACE_H = 1220

/** World size — kept compact so a full 7-player ring fits the picnic top. */
export const ROLE_CARD_WIDTH = 0.34
export const ROLE_CARD_HEIGHT = 0.51
export const ROLE_CARD_DEPTH = 0.014

export type TeamColors = { bg: string; accent: string; ink: string }

export const TEAM_COLORS: Record<string, TeamColors> = {
  village: { bg: '#e8e2d4', accent: '#2f5d3a', ink: '#1a2418' },
  werewolf: { bg: '#2a1c1c', accent: '#c45c4a', ink: '#f0e6e0' },
  neutral: { bg: '#d8d4e0', accent: '#5a5470', ink: '#1e1c28' },
}

export function teamColorsForRole(role: WerewolfRole): TeamColors {
  const team = ROLE_INFO[role].team
  return TEAM_COLORS[team] ?? TEAM_COLORS.village!
}

const faceCache = new Map<WerewolfRole, THREE.Texture>()
const tokenFaceCache = new Map<WerewolfRole, THREE.Texture>()
let backTexture: THREE.Texture | null = null

const TOKEN_FACE_PX = 256
const loader = new THREE.TextureLoader()
/**
 * Cards lie flat under a high / angled camera. Without mipmaps the scanned
 * print grain aliases into a shimmering grid; anisotropy only helps with mips.
 * Three clamps anisotropy to the GPU max at upload.
 */
const CARD_ANISOTROPY = 16

function configureMap(tex: THREE.Texture): THREE.Texture {
  tex.colorSpace = THREE.SRGBColorSpace
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.anisotropy = CARD_ANISOTROPY
  tex.needsUpdate = true
  return tex
}

function finishCanvas(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.generateMipmaps = true
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.anisotropy = CARD_ANISOTROPY
  texture.needsUpdate = true
  return texture
}

function loadUrlTexture(url: string): THREE.Texture {
  // Apply filters after decode only — marking needsUpdate on an empty
  // TextureLoader placeholder spam "no image data found" warnings.
  const tex = loader.load(url, (ready) => {
    configureMap(ready)
  })
  tex.colorSpace = THREE.SRGBColorSpace
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.anisotropy = CARD_ANISOTROPY
  return tex
}

function proceduralBack(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = FACE_W
  canvas.height = FACE_H
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(
    FACE_W * 0.35,
    FACE_H * 0.3,
    10,
    FACE_W * 0.5,
    FACE_H * 0.45,
    FACE_W * 0.7,
  )
  g.addColorStop(0, '#3a2a18')
  g.addColorStop(0.55, '#1a1420')
  g.addColorStop(1, '#0c0a12')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, FACE_W, FACE_H)
  ctx.strokeStyle = 'rgba(201, 162, 39, 0.55)'
  ctx.lineWidth = 8
  ctx.strokeRect(14, 14, FACE_W - 28, FACE_H - 28)
  ctx.beginPath()
  ctx.arc(FACE_W * 0.5, FACE_H * 0.42, 48, 0, Math.PI * 2)
  ctx.fillStyle = '#e8dcc0'
  ctx.fill()
  ctx.beginPath()
  ctx.arc(FACE_W * 0.58, FACE_H * 0.38, 40, 0, Math.PI * 2)
  ctx.fillStyle = '#1a1420'
  ctx.fill()
  ctx.fillStyle = 'rgba(232, 220, 192, 0.85)'
  ctx.font = 'bold 22px Georgia, serif'
  ctx.textAlign = 'center'
  ctx.fillText('ONE NIGHT', FACE_W / 2, FACE_H * 0.72)
  ctx.font = 'bold 26px Georgia, serif'
  ctx.fillText('WEREWOLF', FACE_W / 2, FACE_H * 0.8)
  return finishCanvas(canvas)
}

function proceduralFace(role: WerewolfRole): THREE.CanvasTexture {
  const info = ROLE_INFO[role]
  const colors = TEAM_COLORS[info.team] ?? TEAM_COLORS.village!
  const canvas = document.createElement('canvas')
  canvas.width = FACE_W
  canvas.height = FACE_H
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = colors.bg
  ctx.fillRect(0, 0, FACE_W, FACE_H)
  ctx.strokeStyle = colors.accent
  ctx.lineWidth = 10
  ctx.strokeRect(12, 12, FACE_W - 24, FACE_H - 24)

  const emblemCx = FACE_W / 2
  const emblemCy = FACE_H * 0.32
  const emblemR = 90
  ctx.fillStyle = colors.accent
  ctx.beginPath()
  ctx.arc(emblemCx, emblemCy, emblemR, 0, Math.PI * 2)
  ctx.fill()
  drawRoleIcon(ctx, role, emblemCx, emblemCy, emblemR * 1.35, colors.bg)

  ctx.fillStyle = colors.ink
  ctx.font = 'bold 42px Georgia, serif'
  ctx.textAlign = 'center'
  ctx.fillText(info.name, FACE_W / 2, FACE_H * 0.55)

  ctx.font = '24px Georgia, serif'
  ctx.fillStyle = colors.accent
  ctx.fillText(info.team.toUpperCase(), FACE_W / 2, FACE_H * 0.63)

  return finishCanvas(canvas)
}

function proceduralToken(role: WerewolfRole): THREE.CanvasTexture {
  const colors = teamColorsForRole(role)
  const canvas = document.createElement('canvas')
  canvas.width = TOKEN_FACE_PX
  canvas.height = TOKEN_FACE_PX
  const ctx = canvas.getContext('2d')!
  const cx = TOKEN_FACE_PX / 2
  const cy = TOKEN_FACE_PX / 2
  const r = TOKEN_FACE_PX / 2 - 2

  ctx.clearRect(0, 0, TOKEN_FACE_PX, TOKEN_FACE_PX)
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = colors.bg
  ctx.fill()
  ctx.lineWidth = 8
  ctx.strokeStyle = colors.accent
  ctx.stroke()
  drawRoleIcon(ctx, role, cx, cy, r * 1.25, colors.ink)
  return finishCanvas(canvas)
}

export function getRoleCardBackTexture(): THREE.Texture {
  if (backTexture) return backTexture
  try {
    backTexture = loadUrlTexture(CARD_BACK_URL)
  } catch {
    backTexture = proceduralBack()
  }
  return backTexture
}

export function getRoleCardFaceTexture(role: WerewolfRole): THREE.Texture {
  const cached = faceCache.get(role)
  if (cached) return cached

  const url = ROLE_CARD_FACE_URL[role]
  if (!url) {
    const tex = proceduralFace(role)
    faceCache.set(role, tex)
    return tex
  }

  const tex = loadUrlTexture(url)
  faceCache.set(role, tex)
  return tex
}

/** Circular disc texture for character tokens. */
export function getRoleTokenFaceTexture(role: WerewolfRole): THREE.Texture {
  const cached = tokenFaceCache.get(role)
  if (cached) return cached

  const url = ROLE_TOKEN_URL[role]
  if (!url) {
    const tex = proceduralToken(role)
    tokenFaceCache.set(role, tex)
    return tex
  }

  const tex = loadUrlTexture(url)
  tokenFaceCache.set(role, tex)
  return tex
}
