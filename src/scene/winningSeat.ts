import { playerWon } from '../game/werewolfLogic'
import type { WerewolfSnapshot } from '../game/werewolfTypes'
import type { ClientId, SeatId } from '../session/types'

function werewolfSnapshot(
  gameId: string | null | undefined,
  game: unknown,
): WerewolfSnapshot | null {
  if (gameId !== 'werewolf' || !game || typeof game !== 'object') return null
  const g = game as WerewolfSnapshot
  if (g.gameId !== 'werewolf') return null
  return g
}

/** Versus seats unused for Werewolf party mode. */
export function winningSeatFromGame(
  _gameId: string | null | undefined,
  _game: unknown,
): SeatId | null {
  return null
}

export function losingSeatFromGame(
  _gameId: string | null | undefined,
  _game: unknown,
): SeatId | null {
  return null
}

export function winningPlayerIdsFromGame(
  gameId: string | null | undefined,
  game: unknown,
): ClientId[] {
  const ww = werewolfSnapshot(gameId, game)
  if (!ww || !ww.winners) return []
  return ww.playerIds.filter((id) => playerWon(ww, id) === true)
}

export function losingPlayerIdsFromGame(
  gameId: string | null | undefined,
  game: unknown,
): ClientId[] {
  const ww = werewolfSnapshot(gameId, game)
  if (!ww || !ww.winners) return []
  return ww.playerIds.filter((id) => playerWon(ww, id) === false)
}

export function winningPlayerIdFromGame(
  gameId: string | null | undefined,
  game: unknown,
): ClientId | null {
  return winningPlayerIdsFromGame(gameId, game)[0] ?? null
}

export function losingPlayerIdFromGame(
  gameId: string | null | undefined,
  game: unknown,
): ClientId | null {
  return losingPlayerIdsFromGame(gameId, game)[0] ?? null
}
