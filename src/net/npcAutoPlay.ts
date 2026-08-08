import {
  actorsForStep,
  isNightActor,
} from '../game/werewolfLogic'
import type { WerewolfSnapshot } from '../game/werewolfTypes'
import { connectedNpcs } from '../session/npcPlayers'
import type { ClientId } from '../session/types'
import type { ClientIntent, SessionSnapshot } from './protocol'

export type NpcAction = { npcId: ClientId; intent: ClientIntent }

/** AI seats start casting (and may revise) once this much day time remains. */
export const AI_DAY_VOTE_WINDOW_MS = 60_000

function pick<T>(items: T[]): T | null {
  if (items.length === 0) return null
  return items[Math.floor(Math.random() * items.length)]!
}

/** Milliseconds until day ends, or null when not in a timed day phase. */
export function dayMsRemaining(
  game: WerewolfSnapshot | null | undefined,
  now = Date.now(),
): number | null {
  if (!game || game.phase !== 'day' || game.dayEndsAt == null) return null
  return Math.max(0, game.dayEndsAt - now)
}

/**
 * AI day voting opens in the final minute (or for the whole day when the
 * configured day length is ≤ 1 minute). In watch mode, opens for the last
 * half of the day so AIs can bluff-vote and revise while chat continues.
 */
export function aiDayVoteWindowOpen(
  game: WerewolfSnapshot | null | undefined,
  now = Date.now(),
  opts?: { watchMode?: boolean },
): boolean {
  const left = dayMsRemaining(game, now)
  if (left == null || !game) return false
  if (opts?.watchMode) {
    const half = Math.max(
      AI_DAY_VOTE_WINDOW_MS,
      Math.floor((game.dayDurationMs || AI_DAY_VOTE_WINDOW_MS * 2) / 2),
    )
    return left <= half
  }
  return left <= AI_DAY_VOTE_WINDOW_MS
}

/** True when every connected human in the game has cast a day vote. */
export function allHumansHaveVoted(
  snapshot: SessionSnapshot,
  game: WerewolfSnapshot,
): boolean {
  const humans = snapshot.players.filter(
    (p) =>
      p.connected &&
      !p.isNpc &&
      game.playerIds.includes(p.id),
  )
  if (humans.length === 0) return true
  return humans.every((p) => Boolean(game.votes[p.id]))
}

/** Scripted fallback intent for one NPC (no LLM). */
export function scriptedWerewolfIntent(
  state: WerewolfSnapshot,
  npcId: ClientId,
  opts?: { allowDayVote?: boolean },
): ClientIntent | null {
  if (!state.playerIds.includes(npcId)) return null

  if (state.phase === 'claiming') {
    if (state.cards.some((c) => c.claimBy === npcId)) return null
    const open = state.cards.filter((c) => !c.claimBy)
    const card = pick(open)
    return card ? { type: 'werewolf.claim', cardId: card.id } : null
  }

  if (state.phase === 'day') {
    if (!opts?.allowDayVote) return null
    // Scripted path only casts once; LLM reconsider handles mid-window changes.
    if (state.votes[npcId]) return null
    const targets = state.playerIds.filter((id) => id !== npcId)
    const targetId = pick(targets)
    return targetId ? { type: 'werewolf.vote', targetId } : null
  }

  if (state.phase === 'reveal') {
    if (state.winners || state.revealStage === 'nightPlayback') return null
    if (
      state.revealStage === 'hunter' &&
      state.killedIds.includes(npcId) &&
      state.roles[npcId] === 'hunter' &&
      !state.hunterKillId
    ) {
      const targets = state.playerIds.filter((id) => id !== npcId)
      const targetId = pick(targets)
      return targetId ? { type: 'werewolf.hunterKill', targetId } : null
    }
    return null
  }

  if (state.phase === 'dawn') return null

  if (state.phase !== 'night') return null
  if (!isNightActor(state, npcId)) return null
  if (state.nightActions.acknowledged.includes(npcId)) return null

  const step = state.nightStep
  const simultaneous = step === 'simultaneous' || state.simultaneousNight

  if (step === 'intro' || step === 'outro') {
    return null
  }

  const actWerewolves = simultaneous || step === 'werewolves'
  const actSeer = simultaneous || step === 'seer'
  const actRobber = simultaneous || step === 'robber'
  const actTm = simultaneous || step === 'troublemaker'
  const actDrunk = simultaneous || step === 'drunk'

  if (actWerewolves && state.dealtRoles[npcId] === 'werewolf') {
    const wolves = actorsForStep(state, 'werewolves')
    if (wolves.length === 1 && !state.nightActions.werewolfPeek) {
      return {
        type: 'werewolf.werewolfPeek',
        centerIndex: Math.floor(Math.random() * 3),
      }
    }
    return simultaneous ? null : { type: 'werewolf.ack' }
  }

  if (actSeer && state.dealtRoles[npcId] === 'seer') {
    if (!state.nightActions.seer) {
      if (Math.random() < 0.5) {
        const targets = state.playerIds.filter((id) => id !== npcId)
        const targetId = pick(targets)
        if (targetId) return { type: 'werewolf.seerPlayer', targetId }
      }
      const a = Math.floor(Math.random() * 3)
      let b = Math.floor(Math.random() * 3)
      if (b === a) b = (a + 1) % 3
      return { type: 'werewolf.seerCenter', a, b }
    }
    return simultaneous ? null : { type: 'werewolf.ack' }
  }

  if (actRobber && state.dealtRoles[npcId] === 'robber') {
    if (!state.nightActions.robber) {
      const targets = state.playerIds.filter((id) => id !== npcId)
      const targetId = pick(targets)
      return targetId ? { type: 'werewolf.robber', targetId } : null
    }
    return simultaneous ? null : { type: 'werewolf.ack' }
  }

  if (actTm && state.dealtRoles[npcId] === 'troublemaker') {
    if (!state.nightActions.troublemaker) {
      const others = state.playerIds.filter((id) => id !== npcId)
      const a = pick(others)
      const b = pick(others.filter((id) => id !== a))
      if (!a || !b) return null
      return { type: 'werewolf.troublemaker', a, b }
    }
    return simultaneous ? null : { type: 'werewolf.ack' }
  }

  if (actDrunk && state.dealtRoles[npcId] === 'drunk') {
    if (!state.nightActions.drunk) {
      return {
        type: 'werewolf.drunk',
        centerIndex: Math.floor(Math.random() * 3),
      }
    }
    return simultaneous ? null : { type: 'werewolf.ack' }
  }

  return simultaneous ? null : { type: 'werewolf.ack' }
}

/** NPCs auto-play Werewolf claims, night acts, votes, and hunter kills. */
export function pickNextNpcAction(
  snapshot: SessionSnapshot,
): NpcAction | null {
  if (
    snapshot.phase !== 'playing' ||
    !snapshot.game ||
    snapshot.gameId !== 'werewolf' ||
    snapshot.pausedForDisconnect
  ) {
    return null
  }

  const npcs = connectedNpcs(snapshot)
  if (npcs.length === 0) return null

  const ww = snapshot.game
  // Final-minute vote window (not "humans finished") — matches LLM driver.
  // Watch mode opens earlier so AIs can bluff-vote mid-discussion.
  const allowDayVote =
    ww.phase !== 'day' ||
    aiDayVoteWindowOpen(ww, Date.now(), {
      watchMode: Boolean(snapshot.watchMode),
    })

  const shuffled = [...npcs].sort(() => Math.random() - 0.5)
  for (const p of shuffled) {
    const intent = scriptedWerewolfIntent(ww, p.id, { allowDayVote })
    if (intent) return { npcId: p.id, intent }
  }
  return null
}
