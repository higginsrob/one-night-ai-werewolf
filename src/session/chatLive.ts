import type { SessionPhase } from './types'
import type { WerewolfPhase } from '../game/werewolfTypes'

/** Phases where shared table chat may be composed and AI may reply. */
export function sessionChatLive(args: {
  phase: SessionPhase
  gamePhase?: WerewolfPhase | null
}): boolean {
  if (args.phase === 'lobby') return true
  if (args.phase !== 'playing') return false
  const g = args.gamePhase
  return g === 'day' || g === 'reveal'
}

/**
 * Host may prompt a seated AI to volunteer a line (Speak button).
 * Lobby, day discussion, and aftergame once the end-scene night recap finishes
 * (`revealStage === 'result'`).
 */
export function sessionNpcSpeakLive(args: {
  phase: SessionPhase
  gamePhase?: WerewolfPhase | null
  revealStage?: string | null
  /** @deprecated Ignored — aftergame waits for the result stage, not winners alone. */
  hasWinners?: boolean
}): boolean {
  if (args.phase === 'lobby') return true
  if (args.phase !== 'playing') return false
  if (args.gamePhase === 'day') return true
  if (args.gamePhase !== 'reveal') return false
  return args.revealStage === 'result'
}
