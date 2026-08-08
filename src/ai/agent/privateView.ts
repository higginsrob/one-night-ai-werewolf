import { roleName } from '../../game/roles'
import {
  actorsForStep,
  isNightActor,
  myDealtRole,
  myKnownNowRole,
  playersWithDealtRole,
} from '../../game/werewolfLogic'
import type { WerewolfSnapshot } from '../../game/werewolfTypes'
import type { ClientId, PlayerPublic } from '../../session/types'
import { formatRoleDeckHand } from './claimLedger'

function nameOf(
  players: PlayerPublic[],
  id: ClientId,
): string {
  return players.find((p) => p.id === id)?.name ?? id
}

/** Information this AI seat is allowed to know (no wire cheating). */
export function buildPrivateObservation(
  game: WerewolfSnapshot,
  players: PlayerPublic[],
  selfId: ClientId,
): string {
  const dealt = myDealtRole(game, selfId)
  const knownNow = myKnownNowRole(game, selfId)
  const lines: string[] = [
    `Your dealt role: ${dealt ? roleName(dealt) : 'unknown'}`,
  ]
  if (knownNow && knownNow !== dealt) {
    lines.push(`Your known current role: ${roleName(knownNow)}`)
  }

  const table = players
    .filter((p) => game.playerIds.includes(p.id))
    .map((p) => `${p.name}${p.id === selfId ? ' (you)' : ''}${p.isNpc ? ' [AI]' : ''}`)
  lines.push(`Players at the table: ${table.join(', ')}`)
  lines.push(
    `Cards in this hand (public, with counts): ${formatRoleDeckHand(game)}. Use these counts for role accounting — do not assume a typical ONUW deck.`,
  )

  if (!dealt) return lines.join('\n')

  // Knowledge ceiling — stop models inventing peeks they never had.
  if (
    dealt === 'villager' ||
    dealt === 'hunter' ||
    dealt === 'tanner'
  ) {
    lines.push(
      'Night info: none. You did not look at any cards and did not swap anyone. Never invent a peek, rob, swap, or "I picked up a ___ card" story. If someone says they swapped your card, you still do not know your final role — do not invent one.',
    )
  }

  if (dealt === 'werewolf') {
    const pack = playersWithDealtRole(game, 'werewolf').filter((id) => id !== selfId)
    lines.push(
      pack.length
        ? `Fellow werewolves: ${pack.map((id) => nameOf(players, id)).join(', ')}`
        : 'You are the lone werewolf.',
    )
    lines.push(
      'Night note: you do not see the Minion. The Minion (if in play) sees who the werewolves are.',
    )
    const peek = game.nightActions.werewolfPeek
    if (peek?.playerId === selfId) {
      lines.push(
        `Lone wolf peek — center ${peek.centerIndex + 1}: ${roleName(peek.role)}`,
      )
    }
  }

  if (dealt === 'minion') {
    const wolves = playersWithDealtRole(game, 'werewolf')
    lines.push(
      wolves.length
        ? `Night info (Minion): you saw the werewolves — ${wolves.map((id) => nameOf(players, id)).join(', ')}. You did not look at other players' cards; you only learned who the wolves are.`
        : 'Night info (Minion): no werewolves among the players (both may be in the center).',
    )
  }

  if (dealt === 'mason') {
    const masons = playersWithDealtRole(game, 'mason').filter((id) => id !== selfId)
    lines.push(
      masons.length
        ? `Fellow mason: ${masons.map((id) => nameOf(players, id)).join(', ')}`
        : 'You are the lone mason.',
    )
  }

  if (dealt === 'seer') {
    const seer = game.nightActions.seer
    if (seer?.playerId === selfId) {
      if (seer.view.kind === 'player') {
        lines.push(
          `Seer saw ${nameOf(players, seer.view.targetId)}: ${roleName(seer.view.role)}`,
        )
      } else {
        const [i0, i1] = seer.view.indexes
        const [r0, r1] = seer.view.roles
        lines.push(
          `Seer saw center ${i0 + 1}: ${roleName(r0)}, center ${i1 + 1}: ${roleName(r1)}`,
        )
      }
    } else if (
      game.phase === 'dawn' ||
      game.phase === 'day' ||
      game.phase === 'reveal'
    ) {
      lines.push(
        'Night info: no Seer peek is recorded for you. Do NOT invent a player or center peek.',
      )
    }
  }

  if (dealt === 'robber') {
    const robbed = game.nightActions.robber
    if (robbed?.playerId === selfId) {
      const target = nameOf(players, robbed.targetId)
      const stolen = roleName(robbed.stolenRole)
      lines.push(
        `You robbed ${target} and became ${stolen}. That is your WHOLE night story — you only know the stolen role card. Do NOT invent a further peek of ${target}'s "face," claim their card "looked funny/weird," or describe a Seer-style look at anyone. Saying you robbed ${target} and became ${stolen} is enough (and normal ONUW).`,
      )
    } else if (
      game.phase === 'dawn' ||
      game.phase === 'day' ||
      game.phase === 'reveal'
    ) {
      lines.push(
        'Night info: no Robber swap is recorded for you. Do NOT invent a rob target or stolen role.',
      )
    }
  }

  if (dealt === 'troublemaker') {
    const tm = game.nightActions.troublemaker
    if (tm?.playerId === selfId) {
      const a = nameOf(players, tm.a)
      const b = nameOf(players, tm.b)
      lines.push(
        `You swapped ${a} and ${b} (roles unknown to you). You know WHICH players you swapped — when asked, name ${a} and ${b}. You did not look at those cards.`,
      )
    } else if (
      game.phase === 'dawn' ||
      game.phase === 'day' ||
      game.phase === 'reveal'
    ) {
      lines.push(
        'Night info: no Troublemaker swap is recorded for you. Do NOT invent swap targets or claim you swapped anyone.',
      )
    }
  }

  if (dealt === 'drunk') {
    const drunk = game.nightActions.drunk
    if (drunk?.playerId === selfId) {
      lines.push(
        `You swapped with center ${drunk.centerIndex + 1} (role unknown).`,
      )
    } else if (
      game.phase === 'dawn' ||
      game.phase === 'day' ||
      game.phase === 'reveal'
    ) {
      lines.push(
        'Night info: no Drunk center swap is recorded for you. Do NOT invent a center swap.',
      )
    }
  }

  if (dealt === 'insomniac') {
    const known = myKnownNowRole(game, selfId)
    if (known) {
      lines.push(
        known === dealt
          ? `Insomniac check: your card is still ${roleName(known)}. That is your whole night story — you did not peek anyone else.`
          : `Insomniac check: your card is now ${roleName(known)} (it changed overnight). That is your WHOLE night story — you only looked at your own card. You did NOT rob, steal, or swap with anyone. Do NOT invent a Robber night ("I swapped with X" / "I stole X's card"). Saying you woke Insomniac and your card is now ${roleName(known)} is enough.`,
      )
    }
  }

  if (game.phase === 'night') {
    const step = game.nightStep
    const actors = actorsForStep(game, step)
    lines.push(`Night step: ${step}. You are ${actors.includes(selfId) ? '' : 'not '}an actor.`)
  } else {
    lines.push(`Phase: ${game.phase}`)
  }

  return lines.join('\n')
}

/** Named Troublemaker swap targets from private night actions, if any. */
export function troublemakerSwapPair(
  game: WerewolfSnapshot,
  players: PlayerPublic[],
  selfId: ClientId,
): { aName: string; bName: string } | null {
  if (myDealtRole(game, selfId) !== 'troublemaker') return null
  const tm = game.nightActions.troublemaker
  if (!tm || tm.playerId !== selfId) return null
  return {
    aName: nameOf(players, tm.a),
    bName: nameOf(players, tm.b),
  }
}

/** Named Seer peek from private night actions, if any. */
export function seerNightPeek(
  game: WerewolfSnapshot,
  players: PlayerPublic[],
  selfId: ClientId,
):
  | { kind: 'player'; targetName: string; roleLabel: string }
  | { kind: 'center'; label: string }
  | null {
  if (myDealtRole(game, selfId) !== 'seer') return null
  const seer = game.nightActions.seer
  if (!seer || seer.playerId !== selfId) return null
  if (seer.view.kind === 'player') {
    return {
      kind: 'player',
      targetName: nameOf(players, seer.view.targetId),
      roleLabel: roleName(seer.view.role),
    }
  }
  const [i0, i1] = seer.view.indexes
  const [r0, r1] = seer.view.roles
  return {
    kind: 'center',
    label: `center ${i0 + 1} ${roleName(r0)} and center ${i1 + 1} ${roleName(r1)}`,
  }
}

/** Robber rob target + stolen role from private night actions, if any. */
export function robberNightResult(
  game: WerewolfSnapshot,
  players: PlayerPublic[],
  selfId: ClientId,
): { targetName: string; stolenLabel: string } | null {
  if (myDealtRole(game, selfId) !== 'robber') return null
  const robbed = game.nightActions.robber
  if (!robbed || robbed.playerId !== selfId) return null
  return {
    targetName: nameOf(players, robbed.targetId),
    stolenLabel: roleName(robbed.stolenRole),
  }
}

/** Short hard-fact lines agents must not contradict in speech or votes. */
export function buildHardFacts(
  game: WerewolfSnapshot,
  players: PlayerPublic[],
  selfId: ClientId,
): string[] {
  const dealt = myDealtRole(game, selfId)
  const facts: string[] = []
  if (dealt === 'troublemaker') {
    const pair = troublemakerSwapPair(game, players, selfId)
    if (pair) {
      facts.push(
        `You swapped ${pair.aName} and ${pair.bName}. Claim Troublemaker and name both early (when you claim or when asked) — never hide behind Villager or say you don't know which players.`,
      )
    } else if (
      game.phase === 'dawn' ||
      game.phase === 'day' ||
      game.phase === 'reveal'
    ) {
      facts.push(
        'No Troublemaker swap is recorded — do not claim you swapped anyone.',
      )
    }
  }
  if (dealt === 'seer') {
    const seer = game.nightActions.seer
    if (seer?.playerId === selfId && seer.view.kind === 'player') {
      facts.push(
        `Seer peek: ${nameOf(players, seer.view.targetId)} was ${roleName(seer.view.role)}. When claiming Seer, name this peek at least once.`,
      )
    } else if (
      seer?.playerId === selfId &&
      seer.view.kind === 'center'
    ) {
      const [i0, i1] = seer.view.indexes
      const [r0, r1] = seer.view.roles
      facts.push(
        `Seer peek: center ${i0 + 1} was ${roleName(r0)}, center ${i1 + 1} was ${roleName(r1)}. When claiming Seer, name these centers at least once.`,
      )
    } else if (
      game.phase === 'dawn' ||
      game.phase === 'day' ||
      game.phase === 'reveal'
    ) {
      facts.push('No Seer peek is recorded — do not claim you saw anyone or any center cards.')
    }
  }
  if (dealt === 'robber') {
    const rob = robberNightResult(game, players, selfId)
    if (rob) {
      facts.push(
        `Robber result: robbed ${rob.targetName} → became ${rob.stolenLabel}. That is the whole night story — do not invent further peeks.`,
      )
    }
  }
  if (dealt === 'minion') {
    const wolves = playersWithDealtRole(game, 'werewolf')
    facts.push(
      wolves.length
        ? `Minion night: the werewolves are ${wolves.map((id) => nameOf(players, id)).join(', ')}. NEVER accuse, suspect, or vote them — protect them and misdirect onto other seats.`
        : 'Minion night: no werewolves among the players. Prefer a vote spread so nobody dies.',
    )
  }
  if (dealt === 'insomniac') {
    const known = myKnownNowRole(game, selfId)
    if (known) {
      facts.push(
        known === dealt
          ? `Insomniac check: your card is still ${roleName(known)} — you have no other night peeks to share.`
          : `Insomniac check: your card is now ${roleName(known)}. Do NOT invent that you robbed or swapped with anyone — you only checked your own card.`,
      )
    }
  }
  return facts
}

export type LegalAction =
  | { type: 'werewolf.claim'; cardId: string }
  | { type: 'werewolf.ack' }
  | { type: 'werewolf.werewolfPeek'; centerIndex: number }
  | { type: 'werewolf.seerPlayer'; targetId: string }
  | { type: 'werewolf.seerCenter'; a: number; b: number }
  | { type: 'werewolf.robber'; targetId: string }
  | { type: 'werewolf.troublemaker'; a: string; b: string }
  | { type: 'werewolf.drunk'; centerIndex: number }
  | { type: 'werewolf.vote'; targetId: string }
  | { type: 'werewolf.undoVote' }
  | { type: 'werewolf.hunterKill'; targetId: string }

/** Enumerate legal intents for this NPC right now (for constrained LLM choice). */
export function listLegalActions(
  game: WerewolfSnapshot,
  selfId: ClientId,
): LegalAction[] {
  if (!game.playerIds.includes(selfId)) return []

  if (game.phase === 'claiming') {
    if (game.cards.some((c) => c.claimBy === selfId)) return []
    return game.cards
      .filter((c) => !c.claimBy)
      .map((c) => ({ type: 'werewolf.claim' as const, cardId: c.id }))
  }

  if (game.phase === 'day') {
    const voteTargets: LegalAction[] = game.playerIds
      .filter((id) => id !== selfId)
      .map((targetId) => ({ type: 'werewolf.vote' as const, targetId }))
    // Already voted: may switch target or clear the vote before day ends.
    if (game.votes[selfId]) {
      return [...voteTargets, { type: 'werewolf.undoVote' }]
    }
    return voteTargets
  }

  if (game.phase === 'reveal') {
    if (
      game.revealStage === 'hunter' &&
      game.killedIds.includes(selfId) &&
      game.roles[selfId] === 'hunter' &&
      !game.hunterKillId
    ) {
      return game.playerIds
        .filter((id) => id !== selfId)
        .map((targetId) => ({ type: 'werewolf.hunterKill' as const, targetId }))
    }
    return []
  }

  if (game.phase !== 'night') return []
  if (!isNightActor(game, selfId)) return []
  if (game.nightActions.acknowledged.includes(selfId)) return []

  const step = game.nightStep
  if (step === 'intro' || step === 'outro') return []

  const others = game.playerIds.filter((id) => id !== selfId)
  const simultaneous = step === 'simultaneous' || game.simultaneousNight
  const dealt = game.dealtRoles[selfId]

  const actWerewolves =
    (simultaneous && dealt === 'werewolf') || step === 'werewolves'
  const actSeer = (simultaneous && dealt === 'seer') || step === 'seer'
  const actRobber = (simultaneous && dealt === 'robber') || step === 'robber'
  const actTm =
    (simultaneous && dealt === 'troublemaker') || step === 'troublemaker'
  const actDrunk = (simultaneous && dealt === 'drunk') || step === 'drunk'

  if (actWerewolves) {
    const wolves = actorsForStep(game, 'werewolves')
    if (wolves.length === 1 && !game.nightActions.werewolfPeek) {
      return [0, 1, 2].map((centerIndex) => ({
        type: 'werewolf.werewolfPeek' as const,
        centerIndex,
      }))
    }
    return simultaneous ? [] : [{ type: 'werewolf.ack' }]
  }

  if (actSeer) {
    if (!game.nightActions.seer) {
      const playerActs = others.map((targetId) => ({
        type: 'werewolf.seerPlayer' as const,
        targetId,
      }))
      const centerActs: LegalAction[] = []
      for (let a = 0; a < 3; a++) {
        for (let b = a + 1; b < 3; b++) {
          centerActs.push({ type: 'werewolf.seerCenter', a, b })
        }
      }
      return [...playerActs, ...centerActs]
    }
    return simultaneous ? [] : [{ type: 'werewolf.ack' }]
  }

  if (actRobber) {
    if (!game.nightActions.robber) {
      return others.map((targetId) => ({
        type: 'werewolf.robber' as const,
        targetId,
      }))
    }
    return simultaneous ? [] : [{ type: 'werewolf.ack' }]
  }

  if (actTm) {
    if (!game.nightActions.troublemaker) {
      const out: LegalAction[] = []
      for (let i = 0; i < others.length; i++) {
        for (let j = i + 1; j < others.length; j++) {
          out.push({
            type: 'werewolf.troublemaker',
            a: others[i]!,
            b: others[j]!,
          })
        }
      }
      return out
    }
    return simultaneous ? [] : [{ type: 'werewolf.ack' }]
  }

  if (actDrunk) {
    if (!game.nightActions.drunk) {
      return [0, 1, 2].map((centerIndex) => ({
        type: 'werewolf.drunk' as const,
        centerIndex,
      }))
    }
    return simultaneous ? [] : [{ type: 'werewolf.ack' }]
  }

  return simultaneous ? [] : [{ type: 'werewolf.ack' }]
}
