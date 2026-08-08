import * as THREE from 'three'
import { forEachPlayerCardFocus } from './playerCardFocus'
import { TABLE_TOP } from './RoundTable'

/** Matches WerewolfGame seat billboard scale (PlayerCard is 0.86×1.32). */
export const SEAT_PLAYER_CARD_SCALE = 0.5
export const SEAT_CARD_HALF_W = (0.86 * SEAT_PLAYER_CARD_SCALE) / 2
export const SEAT_CARD_HALF_H = (1.32 * SEAT_PLAYER_CARD_SCALE) / 2

export type TablePadBounds = {
  centerX: number
  centerY: number
  centerZ: number
  /** World-space play-pad radius (felt). */
  radius: number
}

let tablePad: TablePadBounds | null = null

const scratchPoint = new THREE.Vector3()

export function publishTablePadBounds(bounds: TablePadBounds | null): void {
  tablePad = bounds
}

export function clearTablePadBounds(): void {
  tablePad = null
}

export function getTablePadBounds(): TablePadBounds | null {
  return tablePad
}

/**
 * World AABB covering the felt pad disc plus every published seat player card
 * (expanded by half card size).
 */
export function buildTableCardsBox3(out: THREE.Box3): THREE.Box3 {
  out.makeEmpty()

  const pad = tablePad
  if (pad) {
    const y0 = pad.centerY
    const y1 = Math.max(pad.centerY, TABLE_TOP + SEAT_CARD_HALF_H * 2)
    // Use the full pad radius so the wood/felt stays in frame; seat cards
    // expand the box further outward.
    const r = pad.radius
    out.expandByPoint(
      scratchPoint.set(pad.centerX - r, y0, pad.centerZ - r),
    )
    out.expandByPoint(
      scratchPoint.set(pad.centerX + r, y1, pad.centerZ + r),
    )
  }

  forEachPlayerCardFocus((_id, v) => {
    out.expandByPoint(
      scratchPoint.set(
        v.x - SEAT_CARD_HALF_W,
        v.y - SEAT_CARD_HALF_H,
        v.z - SEAT_CARD_HALF_W,
      ),
    )
    out.expandByPoint(
      scratchPoint.set(
        v.x + SEAT_CARD_HALF_W,
        v.y + SEAT_CARD_HALF_H,
        v.z + SEAT_CARD_HALF_W,
      ),
    )
  })

  return out
}

/**
 * Camera distance so a table-top AABB fills the view.
 * Uses XZ half-extents (not a bounding sphere) so flat boards aren't
 * pushed far away by corner diagonal inflation.
 */
export function fitDistanceForBox(
  box: THREE.Box3,
  fovDeg: number,
  aspect: number,
  padding = 1.04,
  /** Orbit polar from +Y; slight bump when the view is more oblique. */
  polar = 0.62,
): number {
  if (box.isEmpty()) return 6
  box.getSize(scratchPoint)
  const halfW = Math.max(0.4, scratchPoint.x * 0.5 * padding)
  const halfD = Math.max(0.4, scratchPoint.z * 0.5 * padding)
  const halfH = Math.max(0.2, scratchPoint.y * 0.5 * padding)

  const vFov = THREE.MathUtils.degToRad(fovDeg)
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.01, aspect))
  // Orbit radius to the look-at: cover the ground footprint, then lengthen a
  // little for tilt (camera is not straight above the plane).
  const tilt = 1 / Math.max(0.55, Math.cos(polar))
  const distW = (halfW / Math.tan(hFov / 2)) * tilt
  const distD = (halfD / Math.tan(vFov / 2)) * tilt
  const distH = halfH / Math.tan(vFov / 2)
  return Math.max(distW, distD, distH, 3.2)
}

export function boxCenter(box: THREE.Box3, out: THREE.Vector3): THREE.Vector3 {
  if (box.isEmpty()) {
    return out.set(0, TABLE_TOP, 0)
  }
  return box.getCenter(out)
}
