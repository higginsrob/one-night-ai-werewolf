import { useState } from 'react'
import { GameEngine } from '../engine/GameEngine'
import type { ClientIntent, SessionSnapshot } from '../net/protocol'
import type { ClientId } from '../session/types'
import { DayChatPanel } from '../ui/DayChatPanel'
import { GamePlayOverlay } from '../ui/GamePlayOverlay'

type Props = {
  snapshot: SessionSnapshot
  localClientId: ClientId
  sendIntent: (intent: ClientIntent) => void
  /** Suite status line shown above the spectator stage. */
  statusMessage?: string
  workerLabel?: string | null
}

/**
 * Compact spectator document for an in-progress benchmark watch game:
 * 3D table + HUD/narrator + live day chat.
 */
export function BenchmarkLiveWatch({
  snapshot,
  localClientId,
  sendIntent,
  statusMessage,
  workerLabel,
}: Props) {
  const [sceneReady, setSceneReady] = useState(false)
  const playing = snapshot.phase === 'playing'
  const phase = snapshot.game?.phase ?? snapshot.phase

  return (
    <div className="bench-live-watch">
      <header className="bench-live-watch-header">
        <h2>
          {workerLabel ? `${workerLabel} · ` : ''}
          Watch game
        </h2>
        <p className="muted">
          {statusMessage ||
            (playing ? `Live · ${phase}` : 'Starting watch game…')}
        </p>
      </header>

      <div className="bench-live-watch-body">
        <div className="bench-live-scene scene-stage">
          <GameEngine
            snapshot={snapshot}
            localClientId={localClientId}
            isHost
            selectedModeId={null}
            onSelectMode={() => {}}
            onReady={() => setSceneReady(true)}
            onGameIntent={sendIntent}
            seatingEnabled={false}
            orbitEnabled={sceneReady}
            showSceneCards
          />
          {playing && (
            <div className="hud">
              <GamePlayOverlay
                snapshot={snapshot}
                localClientId={localClientId}
                interactive={false}
                isHost
                onIntent={sendIntent}
              />
            </div>
          )}
        </div>

        <aside className="bench-live-chat" aria-label="Watch mode table talk">
          <DayChatPanel
            snapshot={snapshot}
            localClientId={localClientId}
          />
        </aside>
      </div>
    </div>
  )
}

/** Keeps host narrator mounted when the live document is not visible. */
export function BenchmarkNarratorHost({
  snapshot,
  localClientId,
  sendIntent,
}: {
  snapshot: SessionSnapshot
  localClientId: ClientId
  sendIntent: (intent: ClientIntent) => void
}) {
  if (snapshot.phase !== 'playing' || !snapshot.game) return null
  return (
    <div className="bench-narrator-host" aria-hidden>
      <GamePlayOverlay
        snapshot={snapshot}
        localClientId={localClientId}
        interactive={false}
        isHost
        onIntent={sendIntent}
      />
    </div>
  )
}
