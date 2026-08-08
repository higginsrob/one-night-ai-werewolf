export type ClientId = string

export type SeatId = 'a' | 'b'

export type SessionPhase = 'lobby' | 'playing' | 'migrating'

export type PlayerPublic = {
  id: ClientId
  name: string
  color: string
  connected: boolean
  cameraOn: boolean
  /** PeerJS peer id for this client (used for media + succession). */
  peerId: string
  /** Stable browser id — reconnects resume this profile. */
  deviceId: string
  /** Still photo shown on the player card. */
  photoDataUrl: string | null
  /** Optional stills keyed by emoticon (shown with that reaction / win-lose). */
  emoticonPhotos: Record<string, string>
  /** CSS filter preset id applied to card photo. */
  mediaFilter: string
  joinedAt: number
  /** Host-seeded AI / bot player (never hosts). */
  isNpc?: boolean
  /** Stable AI persona id when this seat is an AI player. */
  aiProfileId?: string
}

export type ReactionEvent = {
  id: string
  from: ClientId
  name: string
  color: string
  emoji: string
  at: number
}

/** Synthetic speaker id for host narrator lines in shared chat. */
export const NARRATOR_CLIENT_ID = 'narrator' as ClientId

/** Shared day-phase discussion line (visible to all clients). */
export type ChatLine = {
  id: string
  at: number
  fromId: ClientId
  name: string
  text: string
  /**
   * `system` = table event (e.g. a cast vote), not spoken dialogue.
   * `narrator` = host night / dawn / result announcer line.
   */
  via: 'stt' | 'agent' | 'system' | 'narrator'
  /** True while an AI reply is still streaming tokens. */
  streaming?: boolean
  /**
   * Day discussion ms remaining when this line was appended (day phase only).
   * Agents use this for pacing; not shown in the chat UI.
   */
  dayMsLeft?: number
}

export type SeatMap = Record<SeatId, ClientId | null>

export const SEAT_IDS: SeatId[] = ['a', 'b']

export function emptySeats(): SeatMap {
  return { a: null, b: null }
}
