import type { AiPlayerProfile } from '../ai/aiPlayers'
import { aiTableName, portraitForAiProfile } from '../ai/aiPlayers'
import type { SessionSnapshot } from '../net/protocol'
import { addPlayer } from './sessionStore'
import type { ClientId } from './types'

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

/** Werewolf lobby soft cap (host + humans + AI). */
export const MAX_LOBBY_PLAYERS = 10

function markNpc(
  snapshot: SessionSnapshot,
  clientId: ClientId,
  aiProfileId: string,
): SessionSnapshot {
  return {
    ...snapshot,
    players: snapshot.players.map((p) =>
      p.id === clientId
        ? { ...p, isNpc: true, cameraOn: false, aiProfileId }
        : p,
    ),
    succession: snapshot.succession.filter((id) => id !== clientId),
  }
}

/** Add or update a single AI seat from a persona profile. */
function upsertAiPlayer(
  snapshot: SessionSnapshot,
  profile: AiPlayerProfile,
): SessionSnapshot {
  const existing = snapshot.players.find(
    (p) => p.isNpc && p.aiProfileId === profile.id,
  )
  const portrait = portraitForAiProfile(profile)

  if (existing) {
    return {
      ...snapshot,
      players: snapshot.players.map((p) =>
        p.id === existing.id
          ? {
              ...p,
              name: aiTableName(profile),
              photoDataUrl: portrait.photoDataUrl,
              emoticonPhotos: {},
              connected: true,
              isNpc: true,
              cameraOn: false,
              aiProfileId: profile.id,
            }
          : p,
      ),
    }
  }

  const connected = snapshot.players.filter((p) => p.connected).length
  if (connected >= MAX_LOBBY_PLAYERS) return snapshot

  const preferredId = uid('npc')
  const result = addPlayer(snapshot, {
    name: aiTableName(profile),
    peerId: `npc_peer_${preferredId}`,
    deviceId: `npc_dev_${profile.id}`,
    photoDataUrl: portrait.photoDataUrl,
    emoticonPhotos: {},
    mediaFilter: 'none',
    preferredId,
  })
  if (!result.ok) return snapshot
  return markNpc(result.snapshot, result.clientId, profile.id)
}

/**
 * Lobby-only: set AI seats to exactly the given profiles (order preserved).
 * Removes AI players whose profile is no longer selected.
 */
export function setAiPlayers(
  snapshot: SessionSnapshot,
  profiles: AiPlayerProfile[],
): SessionSnapshot {
  if (snapshot.phase !== 'lobby') return snapshot

  const wanted = new Set(profiles.map((p) => p.id))
  let next: SessionSnapshot = {
    ...snapshot,
    players: snapshot.players.filter(
      (p) => !(p.isNpc && p.aiProfileId && !wanted.has(p.aiProfileId)),
    ),
  }
  // Drop orphan NPCs without aiProfileId (legacy scripted bots).
  next = {
    ...next,
    players: next.players.filter((p) => !(p.isNpc && !p.aiProfileId)),
  }
  next.succession = next.succession.filter((id) =>
    next.players.some((p) => p.id === id && !p.isNpc),
  )

  for (const profile of profiles) {
    next = upsertAiPlayer(next, profile)
  }

  const seated = new Set(
    (['a', 'b'] as const)
      .map((s) => next.seats[s])
      .filter(Boolean) as ClientId[],
  )
  next = {
    ...next,
    spectators: next.players
      .filter((p) => p.connected && !seated.has(p.id))
      .map((p) => p.id),
  }
  return next
}

export function connectedNpcs(snapshot: SessionSnapshot) {
  return snapshot.players.filter((p) => p.connected && p.isNpc)
}
