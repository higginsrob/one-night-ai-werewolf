import { ROLE_INFO } from './roles'
import type { WerewolfRole } from './werewolfTypes'

export type TokenTarget =
  | { kind: 'tray' }
  | { kind: 'player'; playerId: string }
  | { kind: 'center'; index: number }

export type CharacterToken = {
  id: string
  role: WerewolfRole
  /** Index among tokens of the same role in the deck (0-based). */
  copy: number
}

export type TokenPlacement = {
  target: TokenTarget
  /** Knowledge markers from peeks cannot be moved. */
  locked: boolean
}

export function buildTokenInventory(roleDeck: WerewolfRole[]): CharacterToken[] {
  const counts = new Map<WerewolfRole, number>()
  return roleDeck.map((role) => {
    const copy = counts.get(role) ?? 0
    counts.set(role, copy + 1)
    return { id: `${role}-${copy}`, role, copy }
  })
}

const SHORT_LABELS: Partial<Record<WerewolfRole, string>> = {
  werewolf: 'Wolf',
  troublemaker: 'TM',
  villager: 'Vill',
  insomniac: 'Inso',
  hunter: 'Hunt',
  minion: 'Min',
  mason: 'Masn',
  robber: 'Rob',
  drunk: 'Drnk',
  tanner: 'Tan',
  seer: 'Seer',
}

export function shortRoleLabel(role: WerewolfRole): string {
  return SHORT_LABELS[role] ?? ROLE_INFO[role].name.slice(0, 4)
}

export function emptyPlacements(
  tokens: CharacterToken[],
): Record<string, TokenPlacement> {
  const out: Record<string, TokenPlacement> = {}
  for (const t of tokens) {
    out[t.id] = { target: { kind: 'tray' }, locked: false }
  }
  return out
}

export function targetsEqual(a: TokenTarget, b: TokenTarget): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'tray') return true
  if (a.kind === 'center' && b.kind === 'center') return a.index === b.index
  if (a.kind === 'player' && b.kind === 'player') {
    return a.playerId === b.playerId
  }
  return false
}

/** Unlocked token of `role` — tray first, then any unlocked placement. */
export function findPlaceableTokenForRole(
  tokens: CharacterToken[],
  placements: Record<string, TokenPlacement>,
  role: WerewolfRole,
): string | null {
  let elsewhere: string | null = null
  for (const t of tokens) {
    if (t.role !== role) continue
    const p = placements[t.id]
    if (!p || p.locked) continue
    if (p.target.kind === 'tray') return t.id
    elsewhere ??= t.id
  }
  return elsewhere
}

export function hasLockedRoleOnTarget(
  tokens: CharacterToken[],
  placements: Record<string, TokenPlacement>,
  role: WerewolfRole,
  target: TokenTarget,
): boolean {
  return tokens.some((t) => {
    if (t.role !== role) return false
    const p = placements[t.id]
    return Boolean(p?.locked && targetsEqual(p.target, target))
  })
}

export function placeTokenOn(
  placements: Record<string, TokenPlacement>,
  tokenId: string,
  target: TokenTarget,
  locked: boolean,
): Record<string, TokenPlacement> {
  const cur = placements[tokenId]
  if (!cur) return placements
  if (cur.locked) return placements
  return {
    ...placements,
    [tokenId]: { target, locked },
  }
}

/** Lock a role marker onto a target (private knowledge). No-op if already locked there. */
export function lockRoleOnTarget(
  tokens: CharacterToken[],
  placements: Record<string, TokenPlacement>,
  role: WerewolfRole,
  target: TokenTarget,
): Record<string, TokenPlacement> {
  if (hasLockedRoleOnTarget(tokens, placements, role, target)) {
    return placements
  }
  // Prefer upgrading an unlocked token already on this target.
  const onTarget = tokens.find((t) => {
    if (t.role !== role) return false
    const p = placements[t.id]
    return Boolean(p && !p.locked && targetsEqual(p.target, target))
  })
  if (onTarget) {
    return {
      ...placements,
      [onTarget.id]: { target, locked: true },
    }
  }
  const id = findPlaceableTokenForRole(tokens, placements, role)
  if (!id) return placements
  return placeTokenOn(placements, id, target, true)
}
