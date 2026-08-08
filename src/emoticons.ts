import type { PlayerPublic, ReactionEvent } from './session/types'

/** Auto-shown on the card while celebrating a win. */
export const WINNER_EMOJI = '🏆'

/** Auto-shown on the card while the other seat is celebrating. */
export const LOSER_EMOJI = '😢'

type FaceOpts = {
  winner?: boolean
  loser?: boolean
  reactions?: ReactionEvent[]
}

/**
 * Resolve which still should paint the card face when live video is off.
 */
export function facePhotoForPlayer(
  player: Pick<PlayerPublic, 'photoDataUrl'>,
  _opts: FaceOpts = {},
): string | null {
  return player.photoDataUrl
}

/** Badge emoji to overlay on the face while a win/lose pose is active. */
export function faceEmojiForPlayer(
  _player: Pick<PlayerPublic, 'photoDataUrl'>,
  opts: FaceOpts = {},
): string | null {
  if (opts.winner) return WINNER_EMOJI
  if (opts.loser) return LOSER_EMOJI
  return null
}
