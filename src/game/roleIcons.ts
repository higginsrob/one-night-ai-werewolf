import type { WerewolfRole } from './werewolfTypes'

export type RoleIconDef = {
  viewBox: string
  /** Filled silhouette paths in viewBox coordinates. */
  paths: string[]
}

/**
 * Flat role symbols — readable at token size, shared by DOM SVG + canvas textures.
 * All icons use viewBox 0 0 64 64. Use fillRule evenodd for eye pupils / cutouts.
 */
export const ROLE_ICONS: Record<WerewolfRole, RoleIconDef> = {
  werewolf: {
    viewBox: '0 0 64 64',
    paths: [
      'M20 10 L16 4 L22 12 L14 20 L10 34 L16 44 L22 50 L28 56 L36 56 L42 50 L48 44 L54 34 L50 20 L42 12 L48 4 L44 10 L40 14 L36 10 L32 6 L28 10 L24 14 Z M24 28 A3 3 0 1 0 24.1 28 Z M40 28 A3 3 0 1 0 40.1 28 Z M26 40 Q32 46 38 40 L36 42 Q32 48 28 42 Z',
    ],
  },
  minion: {
    viewBox: '0 0 64 64',
    paths: [
      'M32 4 C20 4 14 16 14 26 C14 34 18 40 22 44 L14 60 L50 60 L42 44 C46 40 50 34 50 26 C50 16 44 4 32 4 Z M26 24 C26 20 28 18 32 18 C36 18 38 20 38 24 C38 28 36 32 32 32 C28 32 26 28 26 24 Z',
    ],
  },
  seer: {
    viewBox: '0 0 64 64',
    paths: [
      'M2 32 C14 12 50 12 62 32 C50 52 14 52 2 32 Z M32 20 A12 12 0 1 0 32.1 20 Z M32 26 A6 6 0 1 1 31.9 26 Z',
    ],
  },
  robber: {
    viewBox: '0 0 64 64',
    paths: [
      'M24 14 L28 8 L36 8 L40 14 L44 18 L46 28 L44 54 C44 58 40 60 32 60 C24 60 20 58 20 54 L18 28 L20 18 Z',
      'M28 12 L32 18 L36 12 L32 6 Z',
    ],
  },
  troublemaker: {
    viewBox: '0 0 64 64',
    paths: [
      'M8 12 L14 8 L36 30 L42 24 L46 28 L36 38 L48 50 L44 54 L32 42 L22 52 L18 48 L28 36 L18 26 L14 30 L10 26 L20 16 Z',
      'M56 12 L50 8 L28 30 L22 24 L18 28 L28 38 L16 50 L20 54 L32 42 L42 52 L46 48 L36 36 L46 26 L50 30 L54 26 L44 16 Z',
    ],
  },
  villager: {
    viewBox: '0 0 64 64',
    paths: [
      'M32 4 L60 28 L52 28 L52 58 L12 58 L12 28 L4 28 Z M28 38 L36 38 L36 58 L28 58 Z',
    ],
  },
  insomniac: {
    viewBox: '0 0 64 64',
    paths: [
      'M42 8 C28 10 18 24 22 40 C26 52 40 58 52 54 C40 56 28 46 28 32 C28 18 38 10 42 8 Z',
      'M8 40 C16 30 32 30 40 40 C32 50 16 50 8 40 Z M24 36 A4 4 0 1 1 23.9 36 Z',
    ],
  },
  mason: {
    viewBox: '0 0 64 64',
    paths: [
      'M12 20 L32 8 L52 20 L52 24 L32 14 L12 24 Z',
      'M16 22 L16 52 L48 52 L48 22 L44 22 L44 48 L20 48 L20 22 Z',
      'M32 18 L18 50 L24 50 L32 30 L40 50 L46 50 Z',
    ],
  },
  drunk: {
    viewBox: '0 0 64 64',
    paths: [
      'M14 16 L42 16 L40 56 L16 56 Z',
      'M42 22 L52 22 C56 22 58 26 58 32 C58 38 56 42 52 42 L42 42 L42 36 L50 36 C52 36 52 34 52 32 C52 30 52 28 50 28 L42 28 Z',
      'M16 12 C18 6 24 6 28 10 C30 4 38 4 40 10 C42 8 44 12 42 16 L16 16 C14 14 14 14 16 12 Z',
    ],
  },
  hunter: {
    viewBox: '0 0 64 64',
    paths: [
      'M18 6 C8 20 8 44 18 58 L24 54 C16 42 16 22 24 10 Z',
      'M22 10 L22 54 L26 54 L26 10 Z',
      'M20 30 L56 30 L56 34 L20 34 Z M48 24 L60 32 L48 40 Z',
    ],
  },
  tanner: {
    viewBox: '0 0 64 64',
    paths: [
      'M12 18 C20 8 44 8 52 18 L56 28 C50 26 46 30 48 40 L52 52 C40 48 24 48 12 52 L16 40 C18 30 14 26 8 28 Z',
      'M22 28 L26 28 L26 36 L22 36 Z M30 26 L34 26 L34 38 L30 38 Z M38 28 L42 28 L42 36 L38 36 Z',
    ],
  },
}

function parseViewBox(vb: string): { minX: number; minY: number; w: number; h: number } {
  const [minX, minY, w, h] = vb.split(/\s+/).map(Number)
  return {
    minX: minX ?? 0,
    minY: minY ?? 0,
    w: w || 64,
    h: h || 64,
  }
}

/**
 * Draw a role icon centered at (cx, cy) into a square of `size` pixels.
 */
export function drawRoleIcon(
  ctx: CanvasRenderingContext2D,
  role: WerewolfRole,
  cx: number,
  cy: number,
  size: number,
  fill: string,
): void {
  const icon = ROLE_ICONS[role]
  if (!icon) return
  const { minX, minY, w, h } = parseViewBox(icon.viewBox)
  const scale = size / Math.max(w, h)
  const ox = cx - (w * scale) / 2
  const oy = cy - (h * scale) / 2

  ctx.save()
  ctx.translate(ox, oy)
  ctx.scale(scale, scale)
  ctx.translate(-minX, -minY)
  ctx.fillStyle = fill
  for (const d of icon.paths) {
    try {
      ctx.fill(new Path2D(d), 'evenodd')
    } catch {
      // Ignore malformed path in older browsers
    }
  }
  ctx.restore()
}
