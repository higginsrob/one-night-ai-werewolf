import { downloadDayPhaseLog } from '../ai/agent/exportDayLog'
import type { ClientIntent, SessionSnapshot } from '../net/protocol'
import { WerewolfHud } from '../game/WerewolfHud'
import type { WerewolfSnapshot } from '../game/werewolfTypes'

type Props = {
  snapshot: SessionSnapshot
  localClientId: string | null
  interactive: boolean
  isHost?: boolean
  onIntent: (intent: ClientIntent) => void
  onRematch?: () => void
  onAbortGame?: () => void
}

export function GamePlayOverlay({
  snapshot,
  localClientId,
  interactive,
  isHost = false,
  onIntent,
  onRematch,
  onAbortGame,
}: Props) {
  const game = snapshot.game
  if (!game || snapshot.gameId !== 'werewolf') return null

  return (
    <div className="game-play-overlay">
      <div className="hud-panel game-play-panel">
        <WerewolfHud
          game={game as WerewolfSnapshot}
          localClientId={localClientId}
          interactive={interactive}
          isHost={isHost}
          players={snapshot.players}
          onIntent={onIntent}
          onRematch={onRematch}
          onDownloadDayLog={
            isHost ? () => downloadDayPhaseLog(snapshot) : undefined
          }
          onAbortGame={onAbortGame}
          reactions={snapshot.reactions}
        />
      </div>
    </div>
  )
}
