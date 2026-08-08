import { REACTION_TTL_MS } from '../config'
import type { ClientId, ReactionEvent } from '../session/types'

/** Active (in-TTL) reaction events from this player. */
export function reactionsFor(
  reactions: ReactionEvent[],
  playerId: ClientId,
  now = Date.now(),
): ReactionEvent[] {
  return reactions.filter(
    (r) => r.from === playerId && now - r.at < REACTION_TTL_MS,
  )
}
