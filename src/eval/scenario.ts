import { shuffleInPlace } from '../game/roles'
import type {
  TableCard,
  WerewolfNightActions,
  WerewolfRole,
  WerewolfSnapshot,
} from '../game/werewolfTypes'
import type { ClientIntent } from '../net/protocol'
import type { ClientId } from '../session/types'
import { hashStringToSeed, mulberry32 } from './seededRng'

export type BenchmarkCard = {
  id: string
  role: WerewolfRole
}

/** Night intent replayed for a seat (claim/night only — not day votes). */
export type BenchmarkNightIntent = {
  npcId: ClientId
  intent: ClientIntent
}

export type BenchmarkScenario = {
  id: string
  /** Stable digest for log grouping. */
  digest: string
  layoutSeed: number
  roleDeck: WerewolfRole[]
  /** Ordered AI profile ids seated for the suite (watch mode). */
  aiProfileIds: string[]
  /** Face-down deal order (claimBy always null in storage). */
  cards: BenchmarkCard[]
  /**
   * playerId → cardId. Empty until first run finishes claiming;
   * subsequent runs force these claims.
   */
  claimMap: Record<string, string>
  /**
   * Ordered night acts captured after first night.
   * Empty on first run (seeded scripted play); replayed later.
   */
  nightIntents: BenchmarkNightIntent[]
  /** True once claim + night have been captured from run 0. */
  frozen: boolean
}

export function newScenarioId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `g_${stamp}_${Math.random().toString(36).slice(2, 7)}`
}

export function buildCardsFromSeed(
  roleDeck: WerewolfRole[],
  layoutSeed: number,
): BenchmarkCard[] {
  const rand = mulberry32(layoutSeed)
  const shuffled = shuffleInPlace([...roleDeck], rand)
  return shuffled.map((role, i) => ({
    id: `card_${i}_${role}`,
    role,
  }))
}

export function createBenchmarkScenario(args: {
  roleDeck: WerewolfRole[]
  aiProfileIds: string[]
  layoutSeed?: number
}): BenchmarkScenario {
  const id = newScenarioId()
  const layoutSeed =
    args.layoutSeed ??
    hashStringToSeed(`${id}:${args.aiProfileIds.join(',')}:${args.roleDeck.join(',')}`)
  const cards = buildCardsFromSeed(args.roleDeck, layoutSeed)
  const digest = hashStringToSeed(
    `${layoutSeed}|${cards.map((c) => c.id).join(',')}|${args.aiProfileIds.join(',')}`,
  ).toString(16)
  return {
    id,
    digest,
    layoutSeed,
    roleDeck: [...args.roleDeck],
    aiProfileIds: [...args.aiProfileIds],
    cards,
    claimMap: {},
    nightIntents: [],
    frozen: false,
  }
}

export function cardsToTableCards(cards: BenchmarkCard[]): TableCard[] {
  return cards.map((c) => ({ id: c.id, role: c.role, claimBy: null }))
}

export function captureClaimMap(game: WerewolfSnapshot): Record<string, string> {
  const map: Record<string, string> = {}
  for (const card of game.cards) {
    if (card.claimBy) map[card.claimBy] = card.id
  }
  return map
}

/** Rebuild night intents from recorded nightActions (for replay on later runs). */
export function nightIntentsFromActions(
  game: WerewolfSnapshot,
): BenchmarkNightIntent[] {
  const na = game.nightActions
  const out: BenchmarkNightIntent[] = []

  if (na.werewolfPeek) {
    out.push({
      npcId: na.werewolfPeek.playerId,
      intent: {
        type: 'werewolf.werewolfPeek',
        centerIndex: na.werewolfPeek.centerIndex,
      },
    })
  }
  if (na.seer) {
    const view = na.seer.view
    if (view.kind === 'player') {
      out.push({
        npcId: na.seer.playerId,
        intent: { type: 'werewolf.seerPlayer', targetId: view.targetId },
      })
    } else {
      out.push({
        npcId: na.seer.playerId,
        intent: {
          type: 'werewolf.seerCenter',
          a: view.indexes[0],
          b: view.indexes[1],
        },
      })
    }
  }
  if (na.robber) {
    out.push({
      npcId: na.robber.playerId,
      intent: { type: 'werewolf.robber', targetId: na.robber.targetId },
    })
  }
  if (na.troublemaker) {
    out.push({
      npcId: na.troublemaker.playerId,
      intent: {
        type: 'werewolf.troublemaker',
        a: na.troublemaker.a,
        b: na.troublemaker.b,
      },
    })
  }
  if (na.drunk) {
    out.push({
      npcId: na.drunk.playerId,
      intent: {
        type: 'werewolf.drunk',
        centerIndex: na.drunk.centerIndex,
      },
    })
  }

  // Acks for anyone who acknowledged (intro/role/outro) — only emit role-step
  // acks for seats that did not already act above.
  const acted = new Set(out.map((x) => x.npcId))
  for (const id of na.acknowledged) {
    if (acted.has(id)) continue
    out.push({ npcId: id, intent: { type: 'werewolf.ack' } })
  }

  return out
}

export function freezeScenarioFromGame(
  scenario: BenchmarkScenario,
  game: WerewolfSnapshot,
): BenchmarkScenario {
  return {
    ...scenario,
    claimMap: captureClaimMap(game),
    nightIntents: nightIntentsFromActions(game),
    frozen: true,
  }
}

function pickSeeded<T>(items: T[], rand: () => number): T | null {
  if (items.length === 0) return null
  return items[Math.floor(rand() * items.length)]!
}

/**
 * Scripted claim/night using the scenario seed (first run), or forced replay
 * (subsequent runs). Returns null for day/reveal (LLM handles those).
 */
export function evalForcedIntent(args: {
  scenario: BenchmarkScenario | null
  game: WerewolfSnapshot
  npcId: ClientId
  /** Per-suite RNG; mutated across calls on first run. */
  rand: (() => number) | null
}): ClientIntent | null {
  const { scenario, game, npcId, rand } = args
  if (!scenario) return null

  if (game.phase === 'claiming') {
    if (scenario.frozen && scenario.claimMap[npcId]) {
      const cardId = scenario.claimMap[npcId]!
      if (game.cards.some((c) => c.claimBy === npcId)) return null
      const card = game.cards.find((c) => c.id === cardId && !c.claimBy)
      return card ? { type: 'werewolf.claim', cardId: card.id } : null
    }
    // First run: seeded random open card.
    if (game.cards.some((c) => c.claimBy === npcId)) return null
    const open = game.cards.filter((c) => !c.claimBy)
    const r = rand ?? Math.random
    const card = pickSeeded(open, r)
    return card ? { type: 'werewolf.claim', cardId: card.id } : null
  }

  if (game.phase === 'night') {
    if (scenario.frozen && scenario.nightIntents.length > 0) {
      return nextReplayNightIntent(scenario, game, npcId)
    }
    // First run: seeded scripted night (mirrors npcAutoPlay logic).
    return seededNightIntent(game, npcId, rand ?? Math.random)
  }

  return null
}

function nextReplayNightIntent(
  scenario: BenchmarkScenario,
  game: WerewolfSnapshot,
  npcId: ClientId,
): ClientIntent | null {
  const na = game.nightActions
  for (const step of scenario.nightIntents) {
    if (step.npcId !== npcId) continue
    const intent = step.intent
    if (intent.type === 'werewolf.werewolfPeek' && !na.werewolfPeek) {
      return intent
    }
    if (
      (intent.type === 'werewolf.seerPlayer' ||
        intent.type === 'werewolf.seerCenter') &&
      !na.seer
    ) {
      return intent
    }
    if (intent.type === 'werewolf.robber' && !na.robber) return intent
    if (intent.type === 'werewolf.troublemaker' && !na.troublemaker) {
      return intent
    }
    if (intent.type === 'werewolf.drunk' && !na.drunk) return intent
    if (
      intent.type === 'werewolf.ack' &&
      !na.acknowledged.includes(npcId)
    ) {
      // Only ack when this seat no longer needs a pick.
      if (seatStillNeedsNightPick(game, npcId)) continue
      return intent
    }
  }
  // Fallback ack when replay list is exhausted for this seat.
  if (!na.acknowledged.includes(npcId) && !seatStillNeedsNightPick(game, npcId)) {
    return { type: 'werewolf.ack' }
  }
  return null
}

function seatStillNeedsNightPick(
  game: WerewolfSnapshot,
  npcId: ClientId,
): boolean {
  const role = game.dealtRoles[npcId]
  const na = game.nightActions
  if (role === 'werewolf') {
    const wolves = game.playerIds.filter((id) => game.dealtRoles[id] === 'werewolf')
    return wolves.length === 1 && !na.werewolfPeek
  }
  if (role === 'seer') return !na.seer
  if (role === 'robber') return !na.robber
  if (role === 'troublemaker') return !na.troublemaker
  if (role === 'drunk') return !na.drunk
  return false
}

function seededNightIntent(
  state: WerewolfSnapshot,
  npcId: ClientId,
  rand: () => number,
): ClientIntent | null {
  if (!state.playerIds.includes(npcId)) return null
  if (state.nightActions.acknowledged.includes(npcId)) return null
  const role = state.dealtRoles[npcId]
  const simultaneous =
    state.nightStep === 'simultaneous' || state.simultaneousNight
  const step = state.nightStep
  if (step === 'intro' || step === 'outro') return null

  const actWerewolves = simultaneous || step === 'werewolves'
  const actSeer = simultaneous || step === 'seer'
  const actRobber = simultaneous || step === 'robber'
  const actTm = simultaneous || step === 'troublemaker'
  const actDrunk = simultaneous || step === 'drunk'

  if (actWerewolves && role === 'werewolf') {
    const wolves = state.playerIds.filter(
      (id) => state.dealtRoles[id] === 'werewolf',
    )
    if (wolves.length === 1 && !state.nightActions.werewolfPeek) {
      return {
        type: 'werewolf.werewolfPeek',
        centerIndex: Math.floor(rand() * 3),
      }
    }
    return simultaneous ? null : { type: 'werewolf.ack' }
  }

  if (actSeer && role === 'seer') {
    if (!state.nightActions.seer) {
      if (rand() < 0.5) {
        const targets = state.playerIds.filter((id) => id !== npcId)
        const targetId = pickSeeded(targets, rand)
        if (targetId) return { type: 'werewolf.seerPlayer', targetId }
      }
      const a = Math.floor(rand() * 3)
      let b = Math.floor(rand() * 3)
      if (b === a) b = (a + 1) % 3
      return { type: 'werewolf.seerCenter', a, b }
    }
    return simultaneous ? null : { type: 'werewolf.ack' }
  }

  if (actRobber && role === 'robber') {
    if (!state.nightActions.robber) {
      const targets = state.playerIds.filter((id) => id !== npcId)
      const targetId = pickSeeded(targets, rand)
      return targetId ? { type: 'werewolf.robber', targetId } : null
    }
    return simultaneous ? null : { type: 'werewolf.ack' }
  }

  if (actTm && role === 'troublemaker') {
    if (!state.nightActions.troublemaker) {
      const others = state.playerIds.filter((id) => id !== npcId)
      const a = pickSeeded(others, rand)
      const b = pickSeeded(
        others.filter((id) => id !== a),
        rand,
      )
      if (!a || !b) return null
      return { type: 'werewolf.troublemaker', a, b }
    }
    return simultaneous ? null : { type: 'werewolf.ack' }
  }

  if (actDrunk && role === 'drunk') {
    if (!state.nightActions.drunk) {
      return {
        type: 'werewolf.drunk',
        centerIndex: Math.floor(rand() * 3),
      }
    }
    return simultaneous ? null : { type: 'werewolf.ack' }
  }

  return simultaneous ? null : { type: 'werewolf.ack' }
}

export type { WerewolfNightActions }
