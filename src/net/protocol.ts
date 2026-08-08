import type {
  WerewolfRole,
  WerewolfSnapshot,
} from '../game/werewolfTypes'
import type { SceneVisuals } from '../scene/sceneVisuals'
import type {
  ChatLine,
  ClientId,
  PlayerPublic,
  ReactionEvent,
  SeatId,
  SeatMap,
  SessionPhase,
} from '../session/types'

export type GameSnapshot = WerewolfSnapshot

export type { SceneVisuals }

export type SessionSnapshot = {
  v: 1
  sessionSeed: string
  hostGeneration: number
  hostPeerId: string
  /** Room code shown in QR / join UI (short). */
  roomCode: string
  /** Device that first hosted this room — only that device can reclaim. */
  originalHostDeviceId: string
  /** Live host client id (single entry). */
  succession: ClientId[]
  phase: SessionPhase
  /** Always 'werewolf' while playing; null in lobby. */
  gameId: 'werewolf' | null
  /** Unused; kept null for snapshot shape stability. */
  variantId: null
  /**
   * Lobby role deck for One Night AI Werewolf (host-configured).
   * Unique indices into ROLE_POOL (physical card slots). Length must equal
   * connected players + 3 before start; converted to roles when dealing.
   */
  werewolfDeck: number[] | null
  /** Unused in single-player; kept for snapshot shape stability. */
  anyoneCanGameAdmin: boolean
  /** Local scene visuals (skies, blur). */
  sceneVisuals: SceneVisuals
  players: PlayerPublic[]
  seats: SeatMap
  spectators: ClientId[]
  /** Devices the host booted — cannot resume this session. */
  bannedDeviceIds: string[]
  /** Clients currently granted a video slot, oldest first (FIFO). */
  videoQueue: ClientId[]
  reactions: ReactionEvent[]
  /** Shared day discussion transcript (host STT + AI replies). */
  chatLines: ChatLine[]
  /**
   * True while AI replies for the latest human line are still playing out.
   * Human chat.append is rejected until the host clears this.
   */
  chatLocked?: boolean
  /** NPC currently generating / speaking, when the floor is locked. */
  chatRespondingId?: ClientId | null
  game: GameSnapshot | null
  /**
   * True while one or more human players are disconnected mid-game.
   * Timers stay frozen until everyone reconnects (or host returns to lobby).
   */
  pausedForDisconnect?: boolean
  /**
   * AI-only spectator round: humans watch from the gallery while NPCs play
   * and keep day chat going. Cleared when returning to lobby.
   */
  watchMode?: boolean
}

export type ClientIntent =
  | {
      type: 'hello'
      name: string
      peerId: string
      deviceId: string
      photoDataUrl?: string | null
      emoticonPhotos?: Record<string, string> | null
      mediaFilter?: string | null
    }
  | { type: 'react'; emoji: string }
  /** Dismiss this player's active reaction mood (back to neutral face). */
  | { type: 'react.clear' }
  | { type: 'profile.setName'; name: string }
  | { type: 'profile.setPhoto'; photoDataUrl: string | null }
  | { type: 'profile.setMediaFilter'; mediaFilter: string }
  | { type: 'werewolf.claim'; cardId: string }
  | { type: 'werewolf.advanceNight' }
  | { type: 'werewolf.ack' }
  | { type: 'werewolf.werewolfPeek'; centerIndex: number }
  | { type: 'werewolf.seerPlayer'; targetId: string }
  | { type: 'werewolf.seerCenter'; a: number; b: number }
  | { type: 'werewolf.robber'; targetId: string }
  | { type: 'werewolf.troublemaker'; a: string; b: string }
  | { type: 'werewolf.drunk'; centerIndex: number }
  | { type: 'werewolf.vote'; targetId: string }
  | { type: 'werewolf.undoVote' }
  | { type: 'werewolf.dayTimeout' }
  | { type: 'werewolf.startNightAct'; actMs?: number }
  | { type: 'werewolf.extendNightAct'; extraMs?: number }
  | { type: 'werewolf.nightTimeout' }
  | { type: 'werewolf.skipNightStep' }
  | { type: 'werewolf.narratorAdvance' }
  | { type: 'werewolf.dawnDone' }
  | { type: 'werewolf.playbackNext' }
  | { type: 'werewolf.playbackDone' }
  | { type: 'werewolf.replayPlayback' }
  | { type: 'werewolf.pauseNight' }
  | { type: 'werewolf.resumeNight' }
  | {
      type: 'werewolf.setTimers'
      nightActMs: number
      dayDurationMs: number
    }
  | { type: 'werewolf.hunterKill'; targetId: string }
  | { type: 'host.assignSeat'; seatId: SeatId; clientId: ClientId | null }
  | { type: 'host.randomSeat'; seatId: SeatId }
  | { type: 'host.setWerewolfDeck'; poolIndices: number[] }
  | {
      type: 'host.setWerewolfTimers'
      nightActMs: number
      dayDurationMs: number
    }
  | { type: 'host.setAnyoneCanGameAdmin'; enabled: boolean }
  | { type: 'host.setSceneVisuals'; visuals: Partial<SceneVisuals> }
  | {
      type: 'host.start'
      roleDeck?: WerewolfRole[]
      nightActMs?: number
      dayDurationMs?: number
      simultaneousNight?: boolean
      /** Seat only connected AI players; human hosts spectate (full vision + night recap). */
      watchMode?: boolean
      /** DEV eval: fixed deal for reproducible benchmark runs. */
      evalDeal?: {
        layoutSeed: number
        cards: Array<{ id: string; role: WerewolfRole }>
      }
    }
  | { type: 'host.lobby' }
  | {
      type: 'host.rematch'
      roleDeck?: WerewolfRole[]
      nightActMs?: number
      dayDurationMs?: number
      simultaneousNight?: boolean
      watchMode?: boolean
    }
  | { type: 'host.boot'; clientId: ClientId }
  /**
   * Lobby: seat AI players by persona id.
   * Profiles are resolved on the host; payload carries display fields for guests.
   */
  | {
      type: 'host.setAiPlayers'
      players: {
        profileId: string
        name: string
        photoDataUrl: string
        emoticonPhotos?: Record<string, string>
      }[]
    }
  /**
   * Append a shared chat line (lobby or day).
   * Speakers may append as themselves; host/admin may append as others (AI).
   */
  | {
      type: 'chat.append'
      fromId: ClientId
      text: string
      via: 'stt' | 'agent' | 'system' | 'narrator'
      /** Optional stable id (host uses this for streaming agent lines). */
      id?: string
      streaming?: boolean
    }
  | {
      type: 'chat.patch'
      id: string
      text: string
      streaming?: boolean
    }
  | { type: 'chat.remove'; id: string }
  | { type: 'chat.clear' }
  /** Host: lock/unlock the human chat floor and announce who is responding. */
  | {
      type: 'chat.setTurn'
      locked: boolean
      respondingId?: ClientId | null
    }
