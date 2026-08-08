/**
 * Spectator claim truthfulness: score spoken role / night-action claims
 * against dealt roles and recorded nightActions (Watch mode only).
 */
import type { SpokenNightStory } from '../ai/agent/claimLedger'
import type { ClientId } from '../session/types'
import { roleName } from './roles'
import type { WerewolfNightActions, WerewolfSnapshot } from './werewolfTypes'

function avgPercent(parts: number[]): number {
  if (parts.length === 0) return 0
  return Math.round(parts.reduce((a, b) => a + b, 0) / parts.length)
}

function roleLabelsMatch(claimed: string, actual: string): boolean {
  return claimed.trim().toLowerCase() === actual.trim().toLowerCase()
}

/** Score a first-person role claim vs dealt (night-start) role. */
export function scoreRoleClaimTruthfulness(
  claimedRoleLabel: string,
  speakerId: ClientId,
  game: Pick<WerewolfSnapshot, 'dealtRoles'>,
): number | null {
  const dealt = game.dealtRoles[speakerId]
  if (!dealt) return null
  return roleLabelsMatch(claimedRoleLabel, roleName(dealt)) ? 100 : 0
}

/** Score a spoken night-action claim vs recorded nightActions. */
export function scoreNightStoryTruthfulness(
  story: SpokenNightStory,
  nightActions: WerewolfNightActions,
): number {
  if (story.kind === 'seer-player') {
    const seer = nightActions.seer
    if (!seer || seer.playerId !== story.speakerId || seer.view.kind !== 'player') {
      return 0
    }
    const targetOk = seer.view.targetId === story.targetId ? 100 : 0
    const roleOk = roleLabelsMatch(story.role, roleName(seer.view.role)) ? 100 : 0
    return avgPercent([targetOk, roleOk])
  }

  if (story.kind === 'seer-center') {
    const seer = nightActions.seer
    if (!seer || seer.playerId !== story.speakerId || seer.view.kind !== 'center') {
      return 0
    }
    // Vague "peeked center" without naming roles — partial credit only.
    if (story.roles.length === 0) return 50
    const actual = new Set(
      seer.view.roles.map((r) => roleName(r).toLowerCase()),
    )
    const hits = story.roles.filter((r) => actual.has(r.toLowerCase())).length
    if (hits >= 2) return 100
    if (hits === 1) return 70
    return 20
  }

  if (story.kind === 'robber') {
    const rob = nightActions.robber
    if (!rob || rob.playerId !== story.speakerId) return 0
    const parts: number[] = [rob.targetId === story.targetId ? 100 : 0]
    if (story.stolenRole) {
      parts.push(
        roleLabelsMatch(story.stolenRole, roleName(rob.stolenRole)) ? 100 : 0,
      )
    }
    return avgPercent(parts)
  }

  // troublemaker — unordered pair
  const tm = nightActions.troublemaker
  if (!tm || tm.playerId !== story.speakerId) return 0
  const truth = new Set([tm.a, tm.b])
  let hits = 0
  if (truth.has(story.aId)) hits += 1
  if (truth.has(story.bId)) hits += 1
  if (hits === 2) return 100
  if (hits === 1) return 50
  return 0
}

/** CSS class for tinting a truthfulness verdict. */
export function truthfulnessScoreClass(score: number): string {
  return score >= 100 ? 'truth-high' : 'truth-low'
}

/** Spectator label: fully correct → truthful; anything else → misleading. */
export function truthfulnessLabel(score: number): 'truthful' | 'misleading' {
  return score >= 100 ? 'truthful' : 'misleading'
}
