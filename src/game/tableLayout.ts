import { TABLE_TOP } from '../scene/RoundTable'
import { ROLE_CARD_DEPTH, ROLE_CARD_HEIGHT, ROLE_CARD_WIDTH } from './roleCardTextures'

export type CardPose = {
  position: [number, number, number]
  /** Euler XYZ — cards lie flat on the felt, yaw faces inward. */
  rotation: [number, number, number]
}

export type WerewolfTableLayout = {
  center: CardPose[]
  players: CardPose[]
  padRadius: number
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function poseFacingCenter(
  x: number,
  z: number,
  y: number,
): CardPose {
  const angle = Math.atan2(z, x)
  const yaw = -angle + Math.PI
  return {
    position: [x, y, z],
    rotation: [-Math.PI / 2, 0, yaw],
  }
}

/** Card resting height on the shared picnic table top. */
function cardY(): number {
  return TABLE_TOP + ROLE_CARD_DEPTH * 0.5 + 0.01
}

/**
 * Classic ONW layout: 3 center cards + player seats.
 * Pose index 0 is always nearest the camera (+Z) so local-seat rotation can
 * put “your” card in front. 4 players use two offset pairs instead of a full
 * N/E/S/W ring that lines side seats up with the center row.
 */
export function layoutWerewolfTable(playerCount: number): WerewolfTableLayout {
  const n = Math.max(3, playerCount)
  const y = cardY()

  // Wider than card width so center cards do not overlap.
  const centerGap = 0.41
  const center: CardPose[] = [-1, 0, 1].map((slot) => ({
    position: [slot * centerGap, y, 0.04],
    rotation: [-Math.PI / 2, 0, slot * 0.04],
  }))

  if (n === 4) {
    // Clockwise from front-left (near camera): FL → FR → BR → BL.
    const xGap = 0.72
    const zAbove = -0.58
    const zBelow = 0.65
    const tilt = 0.22
    const players: CardPose[] = [
      {
        position: [-xGap, y, zBelow],
        rotation: [-Math.PI / 2, 0, tilt],
      },
      {
        position: [xGap, y, zBelow],
        rotation: [-Math.PI / 2, 0, -tilt],
      },
      {
        position: [xGap, y, zAbove],
        rotation: [-Math.PI / 2, 0, -tilt],
      },
      {
        position: [-xGap, y, zAbove],
        rotation: [-Math.PI / 2, 0, tilt],
      },
    ]
    return { center, players, padRadius: 1.1 }
  }

  // Compact ring — cards stay on the picnic tabletop at 7 players.
  const radius = Math.max(0.82, 0.38 + n * 0.1)
  const players: CardPose[] = Array.from({ length: n }, (_, i) => {
    // i=0 at +Z (front / nearest camera), then around the table.
    const angle = (i / n) * Math.PI * 2 + Math.PI / 2
    const x = Math.cos(angle) * radius
    const z = Math.sin(angle) * radius
    return poseFacingCenter(x, z, y)
  })

  return { center, players, padRadius: radius + 0.32 }
}

/**
 * Map a player’s deck index onto a table pose so `localIndex` always sits at
 * pose 0 (front / nearest the camera). Client-local only — peers keep their
 * own relative view.
 */
export function localSeatPoseIndex(
  playerIndex: number,
  localIndex: number,
  playerCount: number,
): number {
  const n = Math.max(1, playerCount)
  if (localIndex < 0) return ((playerIndex % n) + n) % n
  return (((playerIndex - localIndex) % n) + n) % n
}

/**
 * Non-overlapping scatter of n+3 cards for the claim phase.
 * Deterministic from layoutSeed so all peers match.
 */
export function layoutClaimScatter(
  cardCount: number,
  layoutSeed: number,
): CardPose[] {
  const rand = mulberry32(layoutSeed || 1)
  const y = cardY()
  const cols = Math.ceil(Math.sqrt(cardCount))
  const rows = Math.ceil(cardCount / cols)
  const gapX = ROLE_CARD_WIDTH + 0.15
  const gapZ = ROLE_CARD_HEIGHT + 0.12
  const originX = -((cols - 1) * gapX) / 2
  const originZ = -((rows - 1) * gapZ) / 2

  const poses: CardPose[] = []
  for (let i = 0; i < cardCount; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const jitterX = (rand() - 0.5) * 0.07
    const jitterZ = (rand() - 0.5) * 0.07
    const yawJitter = (rand() - 0.5) * 0.35
    poses.push({
      position: [
        originX + col * gapX + jitterX,
        y,
        originZ + row * gapZ + jitterZ,
      ],
      rotation: [-Math.PI / 2, 0, yawJitter],
    })
  }

  // Shuffle pose order so card index ≠ neat grid reading order.
  for (let i = poses.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[poses[i], poses[j]] = [poses[j]!, poses[i]!]
  }
  return poses
}
