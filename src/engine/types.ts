import type { ComponentType } from 'react'
import type { ClientIntent } from '../net/protocol'
import type { PlayerPublic, ReactionEvent, SeatMap } from '../session/types'

export type ControlsKind = 'orbit' | 'trackball' | 'walkFlyMap'

export type GameConfig = {
  controls: ControlsKind
  maxPlayers: number
  elements?: Array<{
    type: string
    id: string
    props?: Record<string, unknown>
  }>
  table?: {
    target?: [number, number, number]
    camera?: [number, number, number]
  }
}

export type GameSceneProps = {
  state: unknown
  seats: SeatMap
  localClientId: string | null
  isHost: boolean
  /** Connected players in the room (for owner badges, names, etc.). */
  players?: PlayerPublic[]
  /** Active reaction events (for seat player cards, etc.). */
  reactions?: ReactionEvent[]
  /** True when the local client may submit play intents. */
  interactive: boolean
  onIntent?: (intent: ClientIntent) => void
}

export type CreateStateOpts = {
  variantId?: string | null
  /** Connected player ids at deal time (party games that assign per-player state). */
  playerIds?: string[]
  /** Display names keyed by player id (frozen at deal). */
  playerNames?: Record<string, string>
  /** Host-selected role deck for One Night AI Werewolf (length = players + 3). */
  roleDeck?: string[]
  /** Night act window after each wake line (ms). */
  nightActMs?: number
  /** Day discussion/voting length (ms). */
  dayDurationMs?: number
  /** Narrator-off simultaneous night collect/resolve. */
  simultaneousNight?: boolean
  /** Watch-game spectator: animate night actions before day. */
  godMode?: boolean
  /** Eval: fixed layout seed. */
  layoutSeed?: number
  /** Eval: pre-shuffled cards. */
  cards?: Array<{ id: string; role: string }>
}

/**
 * versus — needs seats a+b filled with distinct connected players.
 * party — any connected player can act; seats optional.
 */
export type SeatMode = 'versus' | 'party'

export type GamePlugin<TState = unknown> = {
  id: string
  meta: { title: string; description: string }
  maxPlayers: number
  seatMode: SeatMode
  defaultControls: ControlsKind
  config: GameConfig
  Scene: ComponentType<GameSceneProps>
  createInitialState: (players: SeatMap, opts?: CreateStateOpts) => TState
  reduce: (
    state: TState | unknown,
    intent: { type: string; [key: string]: unknown },
    ctx: { from: string; seats: SeatMap },
  ) => TState
}
