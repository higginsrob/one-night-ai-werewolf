import type { SessionSnapshot } from '../net/protocol'
import { findSeatOfPlayer, seatLabelForId } from '../session/seatAssign'
import { currentHostId } from '../session/sessionStore'
import type { ClientId, PlayerPublic } from '../session/types'
import { LobbyGameProps } from './LobbyGameProps'
import { PlayerCard } from './PlayerCard'
import { reactionsFor } from './playerOverlay'
import { RoundTable } from './RoundTable'
import { behindBoardSeatPosition } from './seatLayout'

type Props = {
  snapshot: SessionSnapshot
  playersById: Map<string, PlayerPublic>
  localClientId: string | null
  selectedModeId: string | null
  onSelectMode: (id: string) => void
  onDismissDoc?: () => void
  onReadingTarget?: (target: [number, number, number] | null) => void
  deck: number[]
  canEditDeck: boolean
  onToggleRole: (poolIndex: number) => void
  deckNeed: number
  seatingEnabled?: boolean
  onTogglePlayerSeat?: (clientId: ClientId) => void
  showSceneCards?: boolean
}

export function LobbyTable({
  snapshot,
  playersById,
  localClientId,
  selectedModeId,
  onSelectMode,
  onDismissDoc,
  onReadingTarget,
  deck,
  canEditDeck,
  onToggleRole,
  deckNeed,
  seatingEnabled = false,
  onTogglePlayerSeat,
  showSceneCards = true,
}: Props) {
  /** Lobby scene cards are AI opponents only — no local human portrait. */
  const scenePlayers = snapshot.players.filter(
    (p) => p.connected && p.id !== localClientId,
  )
  const hostId = currentHostId(snapshot)

  return (
    <group>
      <RoundTable />

      <LobbyGameProps
        selectedId={selectedModeId}
        onSelect={onSelectMode}
        onDismissDoc={onDismissDoc}
        onReadingTarget={onReadingTarget}
        deck={deck}
        canEditDeck={canEditDeck}
        onToggleRole={onToggleRole}
        deckNeed={deckNeed}
      />

      {showSceneCards &&
        scenePlayers.map((player, i) => {
          const seat = findSeatOfPlayer(snapshot.seats, player.id)
          const label = seat
            ? seatLabelForId(seat)
            : seatingEnabled
              ? 'Tap to seat'
              : undefined
          return (
            <PlayerCard
              key={player.id}
              player={playersById.get(player.id) ?? player}
              position={behindBoardSeatPosition(i, scenePlayers.length)}
              highlight={Boolean(seat)}
              label={label}
              isRoomHost={player.id === hostId}
              selectable={seatingEnabled}
              onSelect={
                seatingEnabled
                  ? () => onTogglePlayerSeat?.(player.id)
                  : undefined
              }
              reactions={reactionsFor(snapshot.reactions, player.id)}
            />
          )
        })}
    </group>
  )
}
