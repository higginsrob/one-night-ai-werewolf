import type { ClientId, SeatId, SeatMap } from './types'
import { SEAT_IDS } from './types'

/** Active seat ids for a versus game (protocol currently supports a/b). */
export function seatIdsForPlayerCount(maxPlayers: number): SeatId[] {
  return SEAT_IDS.slice(0, Math.max(0, Math.min(SEAT_IDS.length, maxPlayers)))
}

export function seatLabelForId(seatId: SeatId): string {
  return seatId === 'a' ? 'Player 1' : 'Player 2'
}

export function findSeatOfPlayer(
  seats: SeatMap,
  clientId: ClientId,
): SeatId | null {
  for (const id of SEAT_IDS) {
    if (seats[id] === clientId) return id
  }
  return null
}

export function versusSeatsReady(
  seats: SeatMap,
  maxPlayers: number,
): boolean {
  const active = seatIdsForPlayerCount(maxPlayers)
  if (active.length === 0) return false
  const filled = active.map((s) => seats[s])
  if (filled.some((id) => !id)) return false
  return new Set(filled).size === filled.length
}

/**
 * Next click-to-seat action for a player card.
 * Unseated → first empty seat; seated → next seat or clear.
 * Returns null when all seats are full and the player is not seated.
 */
export function nextSeatAssignment(
  seats: SeatMap,
  clientId: ClientId,
  maxPlayers: number,
): { seatId: SeatId; clientId: ClientId | null } | null {
  const active = seatIdsForPlayerCount(maxPlayers)
  if (active.length === 0) return null

  const current = findSeatOfPlayer(seats, clientId)
  if (current == null) {
    const empty = active.find((s) => seats[s] == null)
    if (!empty) return null
    return { seatId: empty, clientId }
  }

  const idx = active.indexOf(current)
  if (idx >= 0 && idx < active.length - 1) {
    return { seatId: active[idx + 1]!, clientId }
  }
  return { seatId: current, clientId: null }
}
