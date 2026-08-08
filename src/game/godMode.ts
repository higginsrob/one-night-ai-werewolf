/**
 * Spectator omniscience for Watch game.
 * Always on when the local client is a gallery spectator (not seated).
 */

import type { WerewolfSnapshot } from './werewolfTypes'

/** True when the local client is watching from the gallery (not at the table). */
export function isGodSpectatorVision(
  game: { playerIds: string[] } | null | undefined,
  localClientId: string | null | undefined,
): boolean {
  if (!game || !localClientId) return false
  return !game.playerIds.includes(localClientId)
}

/**
 * Watch: keep cards face-down through claiming + live night. Flip to dealt
 * faces only after the dawn replay's opening "Everyone, close your eyes."
 * beat finishes (`playbackBeatIndex > 0`).
 */
export function spectatorDealFacesRevealed(
  game: Pick<
    WerewolfSnapshot,
    'phase' | 'godMode' | 'playbackBeatIndex'
  > | null | undefined,
  godVision: boolean,
): boolean {
  if (!godVision || !game) return false
  if (game.phase === 'claiming' || game.phase === 'night') return false
  if (game.phase === 'dawn' && game.godMode) {
    const idx = game.playbackBeatIndex
    return typeof idx === 'number' && idx > 0
  }
  // Day / reveal / plain dawn — gallery vision stays on.
  return true
}
