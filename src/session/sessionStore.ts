import { REACTION_TTL_MS } from '../config'
import { werewolfGame } from '../game'
import {
  buildRoleDeck,
  isValidLobbyPoolDeck,
  rolesFromPoolIndices,
  validateWerewolfDeck,
} from '../game/roles'
import type { WerewolfRole, WerewolfSnapshot } from '../game/werewolfTypes'
import { NO_VOTE_TARGET } from '../game/werewolfTypes'
import { scriptedWerewolfIntent } from '../net/npcAutoPlay'
import type { ClientIntent, GameSnapshot, SessionSnapshot } from '../net/protocol'
import { normalizeMediaFilter } from '../mediaFilters'
import { isNpcPortraitPath } from '../publicUrl'
import {
  DEFAULT_SCENE_VISUALS,
  normalizeSceneVisuals,
} from '../scene/sceneVisuals'
import { nextColor } from './colorPalette'
import { setAiPlayers } from './npcPlayers'
import type { AiPlayerProfile } from '../ai/aiPlayers'
import { sessionChatLive } from './chatLive'
import {
  emptySeats,
  NARRATOR_CLIENT_ID,
  SEAT_IDS,
  type ClientId,
  type PlayerPublic,
  type SeatId,
} from './types'

function isGameIntent(type: string): boolean {
  return type.startsWith('werewolf.')
}

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

function hasConnectedAi(state: SessionSnapshot): boolean {
  return state.players.some((p) => p.connected && p.isNpc && p.aiProfileId)
}

/** First-person line shown in shared chat when a day vote is cast. */
function voteAnnouncementText(
  game: GameSnapshot,
  targetId: string,
): string {
  if (targetId === NO_VOTE_TARGET) return "I'm casting a no vote."
  const targetName = game.playerNames[targetId] ?? 'someone'
  return `I vote for ${targetName}.`
}

/** Stamp day-clock remaining onto a chat line when discussion is live. */
function dayMsLeftAtSend(state: SessionSnapshot): number | undefined {
  const game = state.game
  if (!game || game.phase !== 'day' || game.dayEndsAt == null) return undefined
  return Math.max(0, game.dayEndsAt - Date.now())
}

function appendSystemChatLine(
  state: SessionSnapshot,
  fromId: ClientId,
  text: string,
  opts?: { lockFloor?: boolean },
): SessionSnapshot {
  const speaker = playerById(state, fromId)
  if (!speaker) return state
  const trimmed = text.trim().slice(0, 500)
  if (!trimmed) return state
  const dayMsLeft = dayMsLeftAtSend(state)
  const line = {
    id: uid('chat'),
    at: Date.now(),
    fromId,
    name: speaker.name,
    text: trimmed,
    via: 'system' as const,
    ...(dayMsLeft != null ? { dayMsLeft } : {}),
  }
  const chatLines = [...(state.chatLines ?? []), line].slice(-120)
  if (opts?.lockFloor && hasConnectedAi(state)) {
    return {
      ...state,
      chatLines,
      chatLocked: true,
      chatRespondingId: null,
    }
  }
  return { ...state, chatLines }
}

export function createInitialSnapshot(args: {
  sessionSeed: string
  hostGeneration: number
  hostPeerId: string
  roomCode: string
  host: {
    id: ClientId
    name: string
    peerId: string
    color: string
    deviceId: string
    photoDataUrl?: string | null
    emoticonPhotos?: Record<string, string> | null
    mediaFilter?: string | null
  }
}): SessionSnapshot {
  const hostPlayer: PlayerPublic = {
    id: args.host.id,
    name: args.host.name,
    color: args.host.color,
    connected: true,
    cameraOn: false,
    peerId: args.host.peerId,
    deviceId: args.host.deviceId,
    photoDataUrl: args.host.photoDataUrl ?? null,
    emoticonPhotos: {},
    mediaFilter: normalizeMediaFilter(args.host.mediaFilter),
    joinedAt: Date.now(),
  }
  return {
    v: 1,
    sessionSeed: args.sessionSeed,
    hostGeneration: args.hostGeneration,
    hostPeerId: args.hostPeerId,
    roomCode: args.roomCode,
    originalHostDeviceId: args.host.deviceId,
    succession: [hostPlayer.id],
    phase: 'lobby',
    gameId: null,
    variantId: null,
    werewolfDeck: null,
    anyoneCanGameAdmin: false,
    sceneVisuals: { ...DEFAULT_SCENE_VISUALS },
    players: [hostPlayer],
    seats: emptySeats(),
    spectators: [hostPlayer.id],
    bannedDeviceIds: [],
    videoQueue: [],
    reactions: [],
    chatLines: [],
    chatLocked: false,
    chatRespondingId: null,
    game: null,
    pausedForDisconnect: false,
    watchMode: false,
  }
}

function usedColors(players: PlayerPublic[]): Set<string> {
  return new Set(players.map((p) => p.color))
}

function recomputeSpectators(snapshot: SessionSnapshot): ClientId[] {
  const seated = new Set(
    SEAT_IDS.map((s) => snapshot.seats[s]).filter(Boolean) as ClientId[],
  )
  return snapshot.players
    .filter((p) => p.connected && !seated.has(p.id))
    .map((p) => p.id)
}

function pruneReactions(snapshot: SessionSnapshot, now = Date.now()): SessionSnapshot {
  return {
    ...snapshot,
    reactions: snapshot.reactions.filter((r) => now - r.at < REACTION_TTL_MS),
  }
}

function playerById(
  snapshot: SessionSnapshot,
  id: ClientId,
): PlayerPublic | undefined {
  return snapshot.players.find((p) => p.id === id)
}

/**
 * Single-host succession: prefer succession[0] when that player is a connected
 * human; otherwise fall back to any connected human.
 */
export function currentHostId(snapshot: SessionSnapshot): ClientId | null {
  const preferred = snapshot.succession[0]
  if (preferred) {
    const p = snapshot.players.find((x) => x.id === preferred)
    if (p?.connected && !p.isNpc) return preferred
  }
  const human = snapshot.players.find((p) => p.connected && !p.isNpc)
  return human?.id ?? null
}

function isHostPlayer(snapshot: SessionSnapshot, clientId: ClientId): boolean {
  return currentHostId(snapshot) === clientId
}

/** Host, or any player when the host opened game-admin to everyone. */
function canGameAdmin(snapshot: SessionSnapshot, clientId: ClientId): boolean {
  return isHostPlayer(snapshot, clientId) || Boolean(snapshot.anyoneCanGameAdmin)
}

function withoutVideo(snapshot: SessionSnapshot, clientId: ClientId): SessionSnapshot {
  const videoQueue = (snapshot.videoQueue ?? []).filter((id) => id !== clientId)
  return {
    ...snapshot,
    videoQueue,
    players: snapshot.players.map((p) =>
      p.id === clientId ? { ...p, cameraOn: false } : p,
    ),
  }
}

function shiftWerewolfTimers(
  game: GameSnapshot | null,
  deltaMs: number,
): GameSnapshot | null {
  if (!game || game.gameId !== 'werewolf' || deltaMs <= 0) return game
  const g = game
  return {
    ...g,
    nightStepEndsAt:
      g.nightStepEndsAt != null ? g.nightStepEndsAt + deltaMs : null,
    dayEndsAt: g.dayEndsAt != null ? g.dayEndsAt + deltaMs : null,
    playbackStartedAt:
      g.playbackStartedAt != null ? g.playbackStartedAt + deltaMs : null,
  }
}

/** Freeze wall-clock werewolf timers while waiting for reconnects. */
function pauseWerewolfForFreeze(game: GameSnapshot | null): GameSnapshot | null {
  if (!game || game.gameId !== 'werewolf') return game
  const g = game
  const now = Date.now()
  if (g.phase === 'night' && !g.nightPaused) {
    const remaining =
      g.nightStepEndsAt != null ? Math.max(0, g.nightStepEndsAt - now) : null
    return {
      ...g,
      nightPaused: true,
      nightPauseRemainingMs: remaining,
      nightStepEndsAt: null,
    }
  }
  if (g.phase === 'day' && g.dayEndsAt != null) {
    return g
  }
  return g
}

function unpauseWerewolfAfterResume(game: GameSnapshot | null): GameSnapshot | null {
  if (!game || game.gameId !== 'werewolf') return game
  const g = game
  const now = Date.now()
  if (g.phase === 'night' && g.nightPaused) {
    const remaining = g.nightPauseRemainingMs
    return {
      ...g,
      nightPaused: false,
      nightPauseRemainingMs: null,
      nightStepEndsAt:
        remaining != null ? now + remaining : g.nightStepEndsAt,
      nightResumeAt: now,
    }
  }
  // Disconnect-pause time can burn the day clock; ensure a short floor remains.
  if (g.phase === 'day' && g.dayEndsAt != null && g.dayEndsAt < now + 15_000) {
    return { ...g, dayEndsAt: now + 60_000 }
  }
  return g
}

/**
 * Keep pausedForDisconnect in sync with human connectivity during play.
 * Clears the flag outside of an active game.
 */
function syncDisconnectPause(snapshot: SessionSnapshot): SessionSnapshot {
  if (snapshot.phase !== 'playing' || !snapshot.game) {
    if (!snapshot.pausedForDisconnect) return snapshot
    return { ...snapshot, pausedForDisconnect: false }
  }

  const anyDisconnectedHuman = snapshot.players.some(
    (p) => !p.connected && !p.isNpc,
  )
  if (anyDisconnectedHuman) {
    return {
      ...snapshot,
      pausedForDisconnect: true,
      game: pauseWerewolfForFreeze(snapshot.game),
    }
  }
  return {
    ...snapshot,
    pausedForDisconnect: false,
    game: unpauseWerewolfAfterResume(snapshot.game),
  }
}

function scrubGameForRemovedPlayers(
  game: GameSnapshot | null,
  keepIds: Set<ClientId>,
): GameSnapshot | null {
  if (!game) return null
  if (game.gameId !== 'werewolf') return game
  const g = game
  const filterRecord = <T,>(rec: Record<string, T>): Record<string, T> => {
    const out: Record<string, T> = {}
    for (const [k, v] of Object.entries(rec)) {
      if (keepIds.has(k)) out[k] = v
    }
    return out
  }
  const actions = g.nightActions
  return {
    ...g,
    playerIds: g.playerIds.filter((id) => keepIds.has(id)),
    playerNames: filterRecord(g.playerNames),
    roles: filterRecord(g.roles),
    dealtRoles: filterRecord(g.dealtRoles),
    votes: filterRecord(g.votes),
    killedIds: g.killedIds.filter((id) => keepIds.has(id)),
    hunterKillId:
      g.hunterKillId && keepIds.has(g.hunterKillId) ? g.hunterKillId : null,
    cards: g.cards.map((c) =>
      c.claimBy && !keepIds.has(c.claimBy) ? { ...c, claimBy: null } : c,
    ),
    nightActions: {
      ...actions,
      acknowledged: actions.acknowledged.filter((id) => keepIds.has(id)),
      werewolfPeek:
        actions.werewolfPeek && keepIds.has(actions.werewolfPeek.playerId)
          ? actions.werewolfPeek
          : undefined,
      seer:
        actions.seer && keepIds.has(actions.seer.playerId)
          ? actions.seer
          : undefined,
      robber:
        actions.robber &&
        keepIds.has(actions.robber.playerId) &&
        keepIds.has(actions.robber.targetId)
          ? actions.robber
          : undefined,
      troublemaker:
        actions.troublemaker &&
        keepIds.has(actions.troublemaker.playerId) &&
        keepIds.has(actions.troublemaker.a) &&
        keepIds.has(actions.troublemaker.b)
          ? actions.troublemaker
          : undefined,
      drunk:
        actions.drunk && keepIds.has(actions.drunk.playerId)
          ? actions.drunk
          : undefined,
    },
  }
}

export type AddPlayerResult =
  | { ok: true; snapshot: SessionSnapshot; clientId: ClientId }
  | { ok: false; reason: 'booted' | 'midGame' }

/**
 * Join or resume by deviceId. Seat assignments are preserved across disconnects.
 * New devices may only join in the lobby (not while paused mid-game).
 */
export function addPlayer(
  snapshot: SessionSnapshot,
  player: {
    name: string
    peerId: string
    deviceId: string
    photoDataUrl?: string | null
    emoticonPhotos?: Record<string, string> | null
    mediaFilter?: string | null
    /** Suggested id for brand-new players. */
    preferredId?: ClientId
  },
): AddPlayerResult {
  const deviceId = player.deviceId.trim()
  if (!deviceId) {
    return addPlayer(snapshot, {
      ...player,
      deviceId: uid('d'),
    })
  }

  if (snapshot.bannedDeviceIds.includes(deviceId)) {
    return { ok: false, reason: 'booted' }
  }

  const photo =
    player.photoDataUrl === undefined
      ? undefined
      : player.photoDataUrl || null
  const mediaFilter =
    player.mediaFilter === undefined
      ? undefined
      : normalizeMediaFilter(player.mediaFilter)

  const existing = snapshot.players.find((p) => p.deviceId === deviceId)
  if (existing) {
    let next: SessionSnapshot = {
      ...snapshot,
      players: snapshot.players.map((p) =>
        p.id === existing.id
          ? {
              ...p,
              connected: true,
              name: player.name.trim().slice(0, 24) || p.name,
              peerId: player.peerId,
              cameraOn: false,
              photoDataUrl: photo === undefined ? p.photoDataUrl : photo,
              emoticonPhotos: p.emoticonPhotos ?? {},
              mediaFilter:
                mediaFilter === undefined
                  ? normalizeMediaFilter(p.mediaFilter)
                  : mediaFilter,
            }
          : p,
      ),
    }
    next = withoutVideo(next, existing.id)
    next.spectators = recomputeSpectators(next)
    next = syncDisconnectPause(next)
    return { ok: true, snapshot: next, clientId: existing.id }
  }

  // New device: only allowed in an open lobby.
  if (snapshot.phase !== 'lobby' || snapshot.pausedForDisconnect) {
    return { ok: false, reason: 'midGame' }
  }

  const id = player.preferredId || uid('c')
  const color = nextColor(usedColors(snapshot.players))
  const next: SessionSnapshot = {
    ...snapshot,
    players: [
      ...snapshot.players,
      {
        id,
        name: player.name.trim().slice(0, 40) || 'Player',
        color,
        connected: true,
        cameraOn: false,
        peerId: player.peerId,
        deviceId,
        photoDataUrl: photo ?? null,
        emoticonPhotos: {},
        mediaFilter: mediaFilter ?? 'none',
        joinedAt: Date.now(),
      },
    ],
    // Succession stays host-only; do not append joiners.
    succession: snapshot.succession,
  }
  next.spectators = recomputeSpectators(next)
  return { ok: true, snapshot: next, clientId: id }
}

/** Soft disconnect — leave the scene but keep profile + seats for resume. */
export function markDisconnected(
  snapshot: SessionSnapshot,
  clientId: ClientId,
): SessionSnapshot {
  if (!snapshot.players.some((p) => p.id === clientId)) return snapshot
  let next = withoutVideo(snapshot, clientId)
  next = {
    ...next,
    players: next.players.map((p) =>
      p.id === clientId ? { ...p, connected: false, cameraOn: false } : p,
    ),
  }
  next.spectators = recomputeSpectators(next)
  return syncDisconnectPause(next)
}

/**
 * Host boot — remove profile, clear seats, ban device for this session.
 * Mid-game boot abandons the round and returns everyone to lobby.
 */
export function bootPlayer(
  snapshot: SessionSnapshot,
  clientId: ClientId,
): SessionSnapshot {
  const player = playerById(snapshot, clientId)
  if (!player) return snapshot

  const hostId = snapshot.succession[0]
  // Never boot the designated host out of succession via this path.
  if (hostId && clientId === hostId) return snapshot

  const bannedDeviceIds = player.deviceId
    ? Array.from(new Set([...snapshot.bannedDeviceIds, player.deviceId]))
    : snapshot.bannedDeviceIds

  const players = snapshot.players.filter((p) => p.id !== clientId)
  const keepIds = new Set(players.map((p) => p.id))
  // Succession is host-only; filter carefully but never drop the host entry.
  const succession = snapshot.succession.filter(
    (id) => id === hostId || keepIds.has(id),
  )

  if (snapshot.phase === 'playing') {
    const next: SessionSnapshot = {
      ...snapshot,
      bannedDeviceIds,
      players,
      succession,
      videoQueue: snapshot.videoQueue.filter((id) => id !== clientId),
      phase: 'lobby',
      gameId: null,
      variantId: null,
      game: null,
      pausedForDisconnect: false,
      seats: emptySeats(),
    }
    next.spectators = recomputeSpectators(next)
    return next
  }

  const seats = { ...snapshot.seats }
  for (const seat of SEAT_IDS) {
    if (seats[seat] === clientId) seats[seat] = null
  }

  const next: SessionSnapshot = {
    ...snapshot,
    bannedDeviceIds,
    players,
    succession,
    videoQueue: snapshot.videoQueue.filter((id) => id !== clientId),
    seats,
    game: scrubGameForRemovedPlayers(snapshot.game, keepIds),
  }
  next.spectators = recomputeSpectators(next)
  return next
}

/**
 * Rebuild a host session from a trusted frozen snapshot after reclaim.
 * Marks non-host humans disconnected; keeps NPCs; pauses via pausedForDisconnect.
 */
export function hydrateFrozenSnapshot(args: {
  frozen: SessionSnapshot
  frozenAt: number
  hostPeerId: string
  hostDeviceId: string
  hostName: string
  hostPhotoDataUrl?: string | null
  hostEmoticonPhotos?: Record<string, string> | null
  hostMediaFilter?: string | null
}): { snapshot: SessionSnapshot; hostClientId: ClientId } {
  const now = Date.now()
  const deltaMs = Math.max(0, now - args.frozenAt)
  const existingHost = args.frozen.players.find(
    (p) => p.deviceId === args.hostDeviceId && !p.isNpc,
  )
  const hostClientId = existingHost?.id ?? uid('c')

  let players: PlayerPublic[] = args.frozen.players.map((p) => {
    if (p.isNpc) return { ...p, connected: true, cameraOn: false }
    if (p.deviceId === args.hostDeviceId || p.id === hostClientId) {
      return {
        ...p,
        id: hostClientId,
        name: args.hostName.trim().slice(0, 24) || p.name,
        peerId: args.hostPeerId,
        deviceId: args.hostDeviceId,
        connected: true,
        cameraOn: false,
        photoDataUrl:
          args.hostPhotoDataUrl === undefined
            ? p.photoDataUrl
            : args.hostPhotoDataUrl,
        emoticonPhotos: p.emoticonPhotos ?? {},
        mediaFilter:
          args.hostMediaFilter === undefined
            ? normalizeMediaFilter(p.mediaFilter)
            : normalizeMediaFilter(args.hostMediaFilter),
      }
    }
    return { ...p, connected: false, cameraOn: false }
  })

  if (!players.some((p) => p.id === hostClientId)) {
    players.unshift({
      id: hostClientId,
      name: args.hostName.trim().slice(0, 24) || 'Host',
      color: nextColor(usedColors(players)),
      connected: true,
      cameraOn: false,
      peerId: args.hostPeerId,
      deviceId: args.hostDeviceId,
      photoDataUrl: args.hostPhotoDataUrl ?? null,
      emoticonPhotos: {},
      mediaFilter: normalizeMediaFilter(args.hostMediaFilter),
      joinedAt: now,
    })
  }

  // Lobby reclaim should not keep ghost humans from a prior pause.
  if (args.frozen.phase !== 'playing') {
    players = players.filter((p) => p.connected || p.isNpc)
  }

  const keepIds = new Set(players.map((p) => p.id))
  const seats = { ...args.frozen.seats }
  for (const seat of SEAT_IDS) {
    const id = seats[seat]
    if (id && !keepIds.has(id)) seats[seat] = null
  }

  let snapshot: SessionSnapshot = {
    ...args.frozen,
    hostGeneration: (args.frozen.hostGeneration || 0) + 1,
    hostPeerId: args.hostPeerId,
    originalHostDeviceId: args.hostDeviceId,
    succession: [hostClientId],
    players,
    seats,
    sceneVisuals: normalizeSceneVisuals(args.frozen.sceneVisuals),
    videoQueue: [],
    reactions: [],
    chatLines: args.frozen.chatLines ?? [],
    chatLocked: false,
    chatRespondingId: null,
    game:
      args.frozen.phase === 'playing'
        ? pauseWerewolfForFreeze(
            shiftWerewolfTimers(args.frozen.game, deltaMs),
          )
        : null,
    pausedForDisconnect: false,
  }
  snapshot.spectators = recomputeSpectators(snapshot)
  snapshot = syncDisconnectPause(snapshot)
  return { snapshot, hostClientId }
}

function startWerewolfGame(
  state: SessionSnapshot,
  intent: {
    roleDeck?: WerewolfRole[]
    nightActMs?: number
    dayDurationMs?: number
    simultaneousNight?: boolean
    watchMode?: boolean
    evalDeal?: {
      layoutSeed: number
      cards: Array<{ id: string; role: WerewolfRole }>
    }
  },
): SessionSnapshot {
  if (state.pausedForDisconnect) return state

  // Rematch keeps the prior watch/play mode unless the intent overrides it.
  const watchMode =
    typeof intent.watchMode === 'boolean'
      ? intent.watchMode
      : Boolean(state.watchMode)

  const connectedPlayers = watchMode
    ? state.players.filter((p) => p.connected && p.isNpc)
    : state.players.filter((p) => p.connected)
  if (connectedPlayers.length < 3 || connectedPlayers.length > 10) return state

  const playerIds = connectedPlayers.map((p) => p.id)
  const playerNames: Record<string, string> = {}
  for (const p of connectedPlayers) playerNames[p.id] = p.name

  const fromIntent = intent.roleDeck
  let candidateRoles =
    fromIntent && Array.isArray(fromIntent)
      ? fromIntent
      : state.werewolfDeck
        ? rolesFromPoolIndices(state.werewolfDeck)
        : null
  // Watch mode often starts from a lobby deck sized for human+AI — rebuild.
  if (
    watchMode &&
    (!candidateRoles ||
      !validateWerewolfDeck(candidateRoles, playerIds.length))
  ) {
    candidateRoles = buildRoleDeck(playerIds.length)
  }
  if (
    !candidateRoles ||
    !validateWerewolfDeck(candidateRoles, playerIds.length)
  ) {
    return state
  }

  const nightActMs =
    typeof intent.nightActMs === 'number' ? intent.nightActMs : undefined
  const dayDurationMs =
    typeof intent.dayDurationMs === 'number' ? intent.dayDurationMs : undefined
  const simultaneousNight = Boolean(intent.simultaneousNight)
  // Watch-game spectators get full table vision + dawn night-action replay.
  const godMode = watchMode

  const seats = emptySeats()
  const evalDeal = intent.evalDeal
  const next: SessionSnapshot = {
    ...state,
    gameId: 'werewolf',
    variantId: null,
    werewolfDeck: state.werewolfDeck,
    seats,
    phase: 'playing',
    pausedForDisconnect: false,
    watchMode,
    chatLines: [],
    chatLocked: false,
    chatRespondingId: null,
    game: werewolfGame.createInitialState(seats, {
      playerIds,
      playerNames,
      roleDeck: candidateRoles,
      nightActMs,
      dayDurationMs,
      simultaneousNight,
      godMode,
      ...(evalDeal
        ? {
            layoutSeed: evalDeal.layoutSeed,
            cards: evalDeal.cards,
          }
        : {}),
    }) as GameSnapshot,
  }
  next.spectators = recomputeSpectators(next)
  return next
}

export function reduceIntent(
  snapshot: SessionSnapshot,
  from: ClientId,
  intent: ClientIntent,
): SessionSnapshot {
  let state = pruneReactions(snapshot)
  // Back-compat for snapshots from before videoQueue existed.
  if (!state.videoQueue) state = { ...state, videoQueue: [] }
  // Back-compat for players from before mediaFilter / emoticonPhotos existed.
  state = {
    ...state,
    players: state.players.map((p) => ({
      ...p,
      mediaFilter: normalizeMediaFilter(p.mediaFilter),
      emoticonPhotos: p.emoticonPhotos ?? {},
    })),
  }

  switch (intent.type) {
    case 'hello': {
      const result = addPlayer(state, {
        name: intent.name,
        peerId: intent.peerId,
        deviceId: intent.deviceId,
        photoDataUrl: intent.photoDataUrl,
        emoticonPhotos: intent.emoticonPhotos,
        mediaFilter: intent.mediaFilter,
        preferredId: from,
      })
      return result.ok ? result.snapshot : state
    }
    case 'react': {
      const p = playerById(state, from)
      if (!p?.connected) return state
      const emoji = intent.emoji.trim().slice(0, 8)
      if (!emoji) return state
      return {
        ...state,
        reactions: [
          ...state.reactions,
          {
            id: uid('rx'),
            from,
            name: p.name,
            color: p.color,
            emoji,
            at: Date.now(),
          },
        ].slice(-30),
      }
    }
    case 'react.clear': {
      const p = playerById(state, from)
      if (!p?.connected) return state
      return {
        ...state,
        reactions: state.reactions.filter((r) => r.from !== from),
      }
    }
    case 'profile.setName': {
      const p = playerById(state, from)
      if (!p?.connected) return state
      const name =
        typeof intent.name === 'string'
          ? intent.name.trim().slice(0, 40)
          : ''
      if (!name) return state
      return {
        ...state,
        players: state.players.map((player) =>
          player.id === from ? { ...player, name } : player,
        ),
      }
    }
    case 'profile.setPhoto': {
      const p = playerById(state, from)
      if (!p?.connected) return state
      const raw =
        typeof intent.photoDataUrl === 'string' ? intent.photoDataUrl.trim() : ''
      const photo =
        raw.startsWith('data:image/') || isNpcPortraitPath(raw)
          ? raw
          : null
      // Capturing a still freezes the local preview so the card shows the photo
      // (live video was covering the still and often painted black).
      let next: SessionSnapshot = {
        ...state,
        players: state.players.map((player) =>
          player.id === from
            ? {
                ...player,
                photoDataUrl: photo,
                ...(photo ? { cameraOn: false } : {}),
              }
            : player,
        ),
      }
      if (photo) {
        next = {
          ...next,
          videoQueue: (next.videoQueue ?? []).filter((id) => id !== from),
        }
      }
      next.spectators = recomputeSpectators(next)
      return next
    }
    case 'profile.setMediaFilter': {
      const p = playerById(state, from)
      if (!p?.connected) return state
      const mediaFilter = normalizeMediaFilter(intent.mediaFilter)
      return {
        ...state,
        players: state.players.map((player) =>
          player.id === from ? { ...player, mediaFilter } : player,
        ),
      }
    }
    case 'host.assignSeat': {
      if (!canGameAdmin(state, from)) return state
      if (state.phase === 'playing') return state
      if (
        intent.clientId &&
        !state.players.some((p) => p.id === intent.clientId && p.connected)
      ) {
        return state
      }
      const seats = { ...state.seats }
      if (intent.clientId) {
        for (const s of SEAT_IDS) {
          if (seats[s] === intent.clientId) seats[s] = null
        }
      }
      seats[intent.seatId] = intent.clientId
      const next = { ...state, seats }
      next.spectators = recomputeSpectators(next)
      return next
    }
    case 'host.randomSeat': {
      if (!canGameAdmin(state, from)) return state
      if (state.phase === 'playing') return state
      const taken = new Set(
        SEAT_IDS.map((s) => state.seats[s]).filter(Boolean) as ClientId[],
      )
      const pool = state.players
        .filter((p) => p.connected && !taken.has(p.id))
        .map((p) => p.id)
      const seatTaken = state.seats[intent.seatId]
      const candidates =
        pool.length > 0
          ? pool
          : state.players.filter((p) => p.connected).map((p) => p.id)
      if (candidates.length === 0) return state
      const pick =
        candidates[Math.floor(Math.random() * candidates.length)] ?? null
      if (!pick || pick === seatTaken) {
        const others = candidates.filter((id) => id !== seatTaken)
        const alt = others[Math.floor(Math.random() * others.length)] ?? pick
        return reduceIntent(state, from, {
          type: 'host.assignSeat',
          seatId: intent.seatId,
          clientId: alt,
        })
      }
      return reduceIntent(state, from, {
        type: 'host.assignSeat',
        seatId: intent.seatId,
        clientId: pick,
      })
    }
    case 'host.setWerewolfDeck': {
      if (!canGameAdmin(state, from)) return state
      const poolIndices = intent.poolIndices
      // Allow incomplete decks while the host is building (0–pool size).
      if (!isValidLobbyPoolDeck(poolIndices)) return state
      return {
        ...state,
        werewolfDeck: [...poolIndices].sort((a, b) => a - b),
      }
    }
    case 'host.setWerewolfTimers': {
      if (!canGameAdmin(state, from)) return state
      const nightActMs =
        typeof intent.nightActMs === 'number' ? intent.nightActMs : null
      const dayDurationMs =
        typeof intent.dayDurationMs === 'number' ? intent.dayDurationMs : null
      if (nightActMs == null || dayDurationMs == null) return state
      if (state.phase === 'playing' && state.gameId === 'werewolf' && state.game) {
        const nextGame = werewolfGame.reduce(
          state.game,
          {
            type: 'werewolf.setTimers',
            nightActMs,
            dayDurationMs,
          },
          { from, seats: state.seats },
        )
        return { ...state, game: nextGame as GameSnapshot }
      }
      return state
    }
    case 'host.setAnyoneCanGameAdmin': {
      if (!isHostPlayer(state, from)) return state
      return { ...state, anyoneCanGameAdmin: Boolean(intent.enabled) }
    }
    case 'host.setSceneVisuals': {
      if (!isHostPlayer(state, from)) return state
      return {
        ...state,
        sceneVisuals: normalizeSceneVisuals({
          ...state.sceneVisuals,
          ...intent.visuals,
        }),
      }
    }
    case 'host.start': {
      if (!canGameAdmin(state, from)) return state
      return startWerewolfGame(state, intent)
    }
    case 'host.lobby': {
      if (!canGameAdmin(state, from)) return state
      // Drop humans who never returned — End game / return-to-lobby is final.
      const players = state.players.filter((p) => p.connected || p.isNpc)
      const seats = emptySeats()
      return {
        ...state,
        phase: 'lobby',
        gameId: null,
        variantId: null,
        game: null,
        chatLines: [],
        chatLocked: false,
        chatRespondingId: null,
        pausedForDisconnect: false,
        watchMode: false,
        players,
        seats,
        videoQueue: state.videoQueue.filter((id) =>
          players.some((p) => p.id === id),
        ),
        spectators: recomputeSpectators({
          ...state,
          players,
          seats,
        }),
      }
    }
    case 'host.rematch': {
      if (!canGameAdmin(state, from)) return state
      return startWerewolfGame(state, intent)
    }
    case 'host.boot': {
      if (!isHostPlayer(state, from)) return state
      if (intent.clientId === from) return state
      return bootPlayer(state, intent.clientId)
    }
    case 'chat.append': {
      if (!canGameAdmin(state, from) && from !== intent.fromId) return state
      const streaming = Boolean(intent.streaming)
      const text =
        typeof intent.text === 'string' ? intent.text.trim().slice(0, 500) : ''
      // Host narrator may log during night / dawn (outside day table talk).
      if (intent.via === 'narrator') {
        if (!canGameAdmin(state, from)) return state
        if (!text) return state
        const line = {
          id: uid('chat'),
          at: Date.now(),
          fromId: NARRATOR_CLIENT_ID,
          name: 'Narrator',
          text,
          via: 'narrator' as const,
        }
        return {
          ...state,
          chatLines: [...(state.chatLines ?? []), line].slice(-120),
        }
      }
      const chatOk = sessionChatLive({
        phase: state.phase,
        gamePhase: state.game?.phase,
      })
      if (!chatOk) return state
      const speaker = playerById(state, intent.fromId)
      if (!speaker) return state
      // Streaming agent lines may start empty; everyone else needs text.
      if (!text && !streaming) return state
      const via: 'stt' | 'agent' | 'system' =
        intent.via === 'agent'
          ? 'agent'
          : intent.via === 'system'
            ? 'system'
            : 'stt'
      // Watch-game: humans are gallery spectators — only AI/system lines land.
      if (via === 'stt' && state.watchMode && state.phase === 'playing') {
        return state
      }
      // One human utterance at a time until AI replies finish.
      // System events (votes) may still land while the floor is locked.
      if (via === 'stt' && state.chatLocked) return state
      const requestedId =
        typeof intent.id === 'string' ? intent.id.trim().slice(0, 48) : ''
      const dayMsLeft = dayMsLeftAtSend(state)
      const line = {
        id: requestedId || uid('chat'),
        at: Date.now(),
        fromId: intent.fromId,
        name: speaker.name,
        text,
        via,
        ...(streaming ? { streaming: true as const } : {}),
        ...(dayMsLeft != null ? { dayMsLeft } : {}),
      }
      const chatLines = [...(state.chatLines ?? []), line].slice(-120)
      // Lock the floor as soon as a human/system line lands so overlapping sends race-lose.
      // Skip when there are no AI seats — humans can talk freely.
      if (via !== 'agent') {
        if (hasConnectedAi(state)) {
          return {
            ...state,
            chatLines,
            chatLocked: true,
            chatRespondingId: null,
          }
        }
      }
      return { ...state, chatLines }
    }
    case 'chat.patch': {
      const id = typeof intent.id === 'string' ? intent.id : ''
      if (!id) return state
      const existing = (state.chatLines ?? []).find((line) => line.id === id)
      if (!existing) return state
      // Host/admin, or the original speaker (AI streaming via injectIntent).
      if (!canGameAdmin(state, from) && from !== existing.fromId) return state
      const text =
        typeof intent.text === 'string' ? intent.text.trim().slice(0, 500) : ''
      const streaming = Boolean(intent.streaming)
      const chatLines = (state.chatLines ?? []).map((line) => {
        if (line.id !== id) return line
        const next = { ...line, text }
        if (streaming) next.streaming = true
        else delete next.streaming
        return next
      })
      return { ...state, chatLines }
    }
    case 'chat.remove': {
      const id = typeof intent.id === 'string' ? intent.id : ''
      if (!id) return state
      const existing = (state.chatLines ?? []).find((line) => line.id === id)
      if (!existing) return state
      if (!canGameAdmin(state, from) && from !== existing.fromId) return state
      return {
        ...state,
        chatLines: (state.chatLines ?? []).filter((line) => line.id !== id),
      }
    }
    case 'chat.clear': {
      if (!canGameAdmin(state, from)) return state
      // Lobby only — day table talk cannot be wiped mid-game.
      if (state.phase !== 'lobby') return state
      return {
        ...state,
        chatLines: [],
        chatLocked: false,
        chatRespondingId: null,
      }
    }
    case 'chat.setTurn': {
      if (!canGameAdmin(state, from)) return state
      const locked = Boolean(intent.locked)
      if (!locked) {
        return { ...state, chatLocked: false, chatRespondingId: null }
      }
      const respondingId =
        typeof intent.respondingId === 'string' ? intent.respondingId : null
      return {
        ...state,
        chatLocked: true,
        chatRespondingId: respondingId,
      }
    }
    case 'host.setAiPlayers': {
      if (!canGameAdmin(state, from)) return state
      if (state.phase !== 'lobby' || state.pausedForDisconnect) return state
      const raw = Array.isArray(intent.players) ? intent.players : []
      const profiles: AiPlayerProfile[] = raw.slice(0, 6).map((p, i) => {
        const tableName = String(p.name || 'AI').slice(0, 40)
        return {
          id: String(p.profileId || `ai_${i + 1}`),
          name: tableName,
          nickname: tableName,
          persona: '',
          voiceURI: '',
          apiVoiceId: '',
          voiceAge: '',
          voiceGender: '',
          voiceAccent: '',
          portraitIndex: i % 6,
        }
      })
      let next = setAiPlayers(state, profiles)
      for (const p of raw) {
        const profileId = String(p.profileId || '')
        if (!profileId) continue
        next = {
          ...next,
          players: next.players.map((player) =>
            player.aiProfileId === profileId
              ? {
                  ...player,
                  name: String(p.name || player.name).slice(0, 40),
                  photoDataUrl: p.photoDataUrl || player.photoDataUrl,
                  emoticonPhotos: p.emoticonPhotos ?? player.emoticonPhotos,
                }
              : player,
          ),
        }
      }
      return next
    }
    default: {
      if (state.pausedForDisconnect) return state
      if (
        state.phase === 'playing' &&
        state.game &&
        state.gameId === 'werewolf' &&
        isGameIntent(intent.type)
      ) {
        const actor = playerById(state, from)
        if (!actor?.connected) return state

        // Day timer: fill any still-silent NPC votes before resolving so the
        // table does not end on a lone human vote / no-kill while AIs stall.
        let gameBase = state.game as WerewolfSnapshot
        if (intent.type === 'werewolf.dayTimeout' && gameBase.phase === 'day') {
          for (const p of state.players) {
            if (!p.connected || !p.isNpc) continue
            if (!gameBase.playerIds.includes(p.id)) continue
            if (gameBase.votes[p.id]) continue
            const fill = scriptedWerewolfIntent(gameBase, p.id, {
              allowDayVote: true,
            })
            if (fill?.type === 'werewolf.vote') {
              gameBase = werewolfGame.reduce(gameBase, fill, {
                from: p.id,
                seats: state.seats,
              }) as WerewolfSnapshot
            }
          }
        }

        const prevVote =
          intent.type === 'werewolf.vote' ? gameBase.votes[from] : undefined
        const game = werewolfGame.reduce(gameBase, intent, {
          from,
          seats: state.seats,
        }) as GameSnapshot
        let next: SessionSnapshot = { ...state, game }

        // Announce cast day votes in shared chat so AI seats can react.
        if (intent.type === 'werewolf.vote') {
          const castTarget = game.votes[from]
          if (castTarget && castTarget !== prevVote) {
            const stillDay = game.phase === 'day'
            next = appendSystemChatLine(
              next,
              from,
              voteAnnouncementText(game, castTarget),
              { lockFloor: stillDay },
            )
          }
        }
        return next
      }
      return state
    }
  }
}

export function seatLabel(seat: SeatId): string {
  return seat === 'a' ? 'Player 1' : 'Player 2'
}
