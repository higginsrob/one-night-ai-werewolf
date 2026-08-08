import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type DragEvent,
} from 'react'
import { faceEmojiForPlayer, facePhotoForPlayer } from '../emoticons'
import {
  getBrowserTtsSpeakerId,
  subscribeBrowserTtsSpeaker,
} from '../game/browserTts'
import { cssFilterFor } from '../mediaFilters'
import type { SessionSnapshot } from '../net/protocol'
import { findSeatOfPlayer } from '../session/seatAssign'
import { currentHostId } from '../session/sessionStore'
import type { ClientId, PlayerPublic, ReactionEvent, SeatId } from '../session/types'
import { reactionsFor } from '../scene/playerOverlay'
import {
  losingPlayerIdsFromGame,
  winningPlayerIdsFromGame,
} from '../scene/winningSeat'

type Props = {
  snapshot: SessionSnapshot
  localClientId: string | null
  seatingEnabled?: boolean
  onTogglePlayerSeat?: (clientId: ClientId) => void
  /** Host-only: prompt a seated AI to speak in table chat. */
  onSpeakNpc?: (clientId: ClientId) => void
  /** Disable Speak while the chat floor is locked / busy. */
  speakDisabled?: boolean
}

type CarouselEntry = {
  player: PlayerPublic
  label?: string
  winner: boolean
  loser: boolean
  seatId: SeatId | null
}

function FaceMedia({
  player,
  winner,
  loser,
  reactions,
}: {
  player: PlayerPublic
  winner: boolean
  loser: boolean
  reactions: ReactionEvent[]
}) {
  const moodOpts = { winner, loser, reactions }
  const filter = cssFilterFor(player.mediaFilter)
  const facePhoto = facePhotoForPlayer(player, moodOpts)
  const faceEmoji = faceEmojiForPlayer(player, moodOpts)

  return (
    <div className="player-carousel-face" style={{ filter }}>
      {facePhoto ? (
        <img
          className="player-carousel-photo"
          src={facePhoto}
          alt=""
          draggable={false}
        />
      ) : (
        <span className="player-carousel-initial" style={{ color: player.color }}>
          {player.name.slice(0, 1).toUpperCase()}
        </span>
      )}
      {faceEmoji && !winner && !loser ? (
        <span className="player-carousel-face-emoji" aria-hidden>
          {faceEmoji}
        </span>
      ) : null}
    </div>
  )
}

function CardReactions({ reactions }: { reactions: ReactionEvent[] }) {
  const active = reactions.slice(-3)
  if (!active.length) return null
  return (
    <div className="player-carousel-reactions" aria-hidden>
      {active.map((r) => (
        <span key={r.id} className="player-carousel-reaction">
          {r.emoji}
        </span>
      ))}
    </div>
  )
}

export function HtmlPlayerCard({
  player,
  label,
  winner = false,
  loser = false,
  isRoomHost = false,
  isLocal = false,
  seatingEnabled = false,
  selectable = false,
  selected = false,
  reactions = [],
  footer,
  onTogglePlayerSeat,
  onSpeakNpc,
  onSelect,
  speakDisabled = false,
}: {
  player: PlayerPublic
  label?: string
  winner?: boolean
  loser?: boolean
  isRoomHost?: boolean
  isLocal?: boolean
  seatingEnabled?: boolean
  selectable?: boolean
  selected?: boolean
  reactions?: ReactionEvent[]
  footer?: string
  onTogglePlayerSeat?: (clientId: ClientId) => void
  onSpeakNpc?: (clientId: ClientId) => void
  onSelect?: () => void
  speakDisabled?: boolean
}) {
  const displayLabel = winner ? 'Winner' : loser ? 'Loser' : label
  const canSpeak =
    Boolean(onSpeakNpc) &&
    Boolean(player.isNpc && player.aiProfileId && player.connected)
  const canTap = seatingEnabled || (selectable && Boolean(onSelect))

  const [ttsSpeakerId, setTtsSpeakerId] = useState(() =>
    getBrowserTtsSpeakerId(),
  )
  useEffect(() => subscribeBrowserTtsSpeaker(setTtsSpeakerId), [])
  const speaking = ttsSpeakerId === player.id

  const onDragStart = (e: DragEvent) => {
    if (!seatingEnabled) return
    e.dataTransfer.setData('text/player-id', player.id)
    e.dataTransfer.effectAllowed = 'move'
  }

  return (
    <article
      className={[
        'player-carousel-card',
        isLocal ? 'local' : '',
        winner ? 'winner' : '',
        loser ? 'loser' : '',
        speaking ? 'speaking' : '',
        seatingEnabled ? 'seatable' : '',
        selectable ? 'selectable' : '',
        selected ? 'selected' : '',
        label?.startsWith('Player') ? 'seated' : '',
        canSpeak ? 'has-speak' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ '--card-color': player.color } as CSSProperties}
      aria-label={`${player.name}${displayLabel ? `, ${displayLabel}` : ''}${speaking ? ', speaking' : ''}`}
      aria-current={speaking ? 'true' : undefined}
      draggable={seatingEnabled}
      onDragStart={onDragStart}
      onClick={() => {
        if (seatingEnabled) {
          onTogglePlayerSeat?.(player.id)
          return
        }
        if (selectable && onSelect) onSelect()
      }}
      role={canTap ? 'button' : undefined}
      tabIndex={canTap ? 0 : undefined}
      onKeyDown={
        canTap
          ? (e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              if (seatingEnabled) onTogglePlayerSeat?.(player.id)
              else if (selectable && onSelect) onSelect()
            }
          : undefined
      }
    >
      <FaceMedia
        player={player}
        winner={winner}
        loser={loser}
        reactions={reactions}
      />

      {displayLabel && (
        <span
          className={`player-carousel-badge ${winner ? 'win' : ''} ${loser ? 'lose' : ''}`}
        >
          {displayLabel}
        </span>
      )}

      <div className="player-carousel-meta">
        <strong className="player-carousel-name">{player.name}</strong>
        {isRoomHost && <span className="player-carousel-host">Host</span>}
        {footer ? (
          <span className="player-carousel-footer">{footer}</span>
        ) : null}
      </div>

      {canSpeak && (
        <button
          type="button"
          className="player-carousel-speak"
          disabled={speakDisabled}
          title={`Prompt ${player.name} to speak`}
          aria-label={`Prompt ${player.name} to speak`}
          onClick={(e) => {
            e.stopPropagation()
            if (speakDisabled) return
            onSpeakNpc?.(player.id)
          }}
        >
          Speak
        </button>
      )}

      <CardReactions reactions={reactions} />
    </article>
  )
}

function buildEntries(
  snapshot: SessionSnapshot,
  localClientId: string | null,
): CarouselEntry[] {
  const connected = snapshot.players.filter((p) => {
    if (!p.connected) return false
    if (localClientId && p.id === localClientId) {
      // Lobby chat dock: only NPC speak controls matter; you are already in the scene.
      if (snapshot.phase === 'lobby') return false
      // Spectating: hide your own card from the carousel (still show seated AIs).
      if (
        snapshot.phase === 'playing' &&
        snapshot.game &&
        !snapshot.game.playerIds.includes(localClientId)
      ) {
        return false
      }
    }
    return true
  })
  const hostId = currentHostId(snapshot)
  const inNightReplay =
    snapshot.phase === 'playing' &&
    snapshot.game?.phase === 'reveal' &&
    snapshot.game.revealStage === 'nightPlayback'
  const winningPlayerIds =
    snapshot.phase === 'playing' && !inNightReplay
      ? winningPlayerIdsFromGame(snapshot.gameId, snapshot.game)
      : []
  const losingPlayerIds =
    snapshot.phase === 'playing' && !inNightReplay
      ? losingPlayerIdsFromGame(snapshot.gameId, snapshot.game)
      : []
  const winningPlayerIdSet = new Set(winningPlayerIds)
  const losingPlayerIdSet = new Set(losingPlayerIds)

  const sorted = [...connected].sort((a, b) => {
    if (a.id === localClientId) return -1
    if (b.id === localClientId) return 1
    if (a.id === hostId) return -1
    if (b.id === hostId) return 1
    return a.joinedAt - b.joinedAt
  })

  return sorted.map((player) => ({
    player,
    winner: winningPlayerIdSet.has(player.id),
    loser: losingPlayerIdSet.has(player.id),
    seatId: findSeatOfPlayer(snapshot.seats, player.id),
  }))
}

export function PlayerCardCarousel({
  snapshot,
  localClientId,
  seatingEnabled = false,
  onTogglePlayerSeat,
  onSpeakNpc,
  speakDisabled = false,
}: Props) {
  const hostId = currentHostId(snapshot)
  const entries = useMemo(
    () => buildEntries(snapshot, localClientId),
    [snapshot, localClientId],
  )

  if (!entries.length) return null

  return (
    <section
      className="player-carousel"
      aria-label="Connected players"
    >
      <div className="player-carousel-track">
        {entries.map(({ player, label, winner, loser }) => {
          const isLocal = player.id === localClientId
          return (
            <HtmlPlayerCard
              key={player.id}
              player={player}
              label={label}
              winner={winner}
              loser={loser}
              isRoomHost={player.id === hostId}
              isLocal={isLocal}
              seatingEnabled={seatingEnabled}
              reactions={reactionsFor(snapshot.reactions, player.id)}
              onTogglePlayerSeat={onTogglePlayerSeat}
              onSpeakNpc={onSpeakNpc}
              speakDisabled={speakDisabled}
            />
          )
        })}
      </div>
    </section>
  )
}
