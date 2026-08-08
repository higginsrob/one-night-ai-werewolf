import type { PlayerPublic, ReactionEvent } from '../session/types'
import { PlayerCard } from './PlayerCard'
import { reactionsFor } from './playerOverlay'
import { behindBoardSeatPosition } from './seatLayout'

export type GalleryLayout = 'ring' | 'behind'

/** Fixed gallery for spectators (or all players in party mode). */
export function GallerySeats({
  spectators,
  playersById,
  localClientId = null,
  hostId = null,
  reactions = [],
  layout = 'ring',
  /** When composing with seated cards, start index into the shared arc. */
  indexOffset = 0,
  /** Total cards in the shared behind-board layout (defaults to this gallery). */
  layoutTotal,
  winningPlayerIds = [],
  losingPlayerIds = [],
  /**
   * Card badge. `false` = no label (party players).
   * Omitted/`undefined` defaults to Spectating (versus gallery).
   */
  label,
}: {
  spectators: string[]
  playersById: Map<string, PlayerPublic>
  localClientId?: string | null
  hostId?: string | null
  reactions?: ReactionEvent[]
  layout?: GalleryLayout
  indexOffset?: number
  layoutTotal?: number
  winningPlayerIds?: readonly string[]
  losingPlayerIds?: readonly string[]
  label?: string | false
}) {
  const cardLabel = label === false ? undefined : (label ?? 'Spectating')
  const present = spectators.filter((id) => playersById.get(id)?.connected)
  const radius = 4.2
  const ringY = 2.05
  const behindTotal = layoutTotal ?? present.length + indexOffset
  const winners = new Set(winningPlayerIds)
  const losers = new Set(losingPlayerIds)

  return (
    <group>
      {present.map((id, i) => {
        const player = playersById.get(id)
        if (!player?.connected) return null
        let position: [number, number, number]
        if (layout === 'behind') {
          position = behindBoardSeatPosition(indexOffset + i, behindTotal)
        } else {
          const t = present.length === 1 ? 0 : i / present.length
          const angle = -Math.PI / 2 + t * Math.PI * 1.6 - Math.PI * 0.8
          position = [
            Math.cos(angle) * radius,
            ringY,
            Math.sin(angle) * radius,
          ]
        }
        const isLocal = player.id === localClientId
        const winner = winners.has(player.id)
        const loser = losers.has(player.id)
        return (
          <PlayerCard
            key={id}
            player={player}
            position={position}
            highlight={isLocal}
            winner={winner}
            loser={loser}
            label={cardLabel}
            isRoomHost={player.id === hostId}
            reactions={reactionsFor(reactions, player.id)}
          />
        )
      })}
    </group>
  )
}
