import { useEffect, useMemo, useRef } from 'react'
import { RoleIcon } from '../game/RoleIcon'
import {
  ROLE_INFO,
  ROLE_POOL,
  poolCount,
  recommendedDeck,
  roleName,
  validateWerewolfDeck,
} from '../game/roles'
import type { WerewolfRole } from '../game/werewolfTypes'

/** Unique roles in pool order for the picker. */
const UNIQUE_ROLES: WerewolfRole[] = [
  'werewolf',
  'minion',
  'seer',
  'robber',
  'troublemaker',
  'villager',
  'insomniac',
  'mason',
  'drunk',
  'hunter',
  'tanner',
]

type Props = {
  connectedCount: number
  deck: WerewolfRole[]
  isHost: boolean
  onChange: (roles: WerewolfRole[]) => void
}

function countIn(deck: WerewolfRole[], role: WerewolfRole): number {
  return deck.filter((r) => r === role).length
}

export function WerewolfDeckBuilder({
  connectedCount,
  deck,
  isHost,
  onChange,
}: Props) {
  const need = Math.max(3, connectedCount) + 3
  const valid = validateWerewolfDeck(deck, connectedCount)

  const summary = useMemo(() => {
    const counts = new Map<WerewolfRole, number>()
    for (const r of deck) counts.set(r, (counts.get(r) ?? 0) + 1)
    return [...counts.entries()].map(([role, n]) =>
      n > 1 ? `${roleName(role)} ×${n}` : roleName(role),
    )
  }, [deck])

  // Seed recommended when empty, or when player count changes.
  const seededFor = useRef<number | null>(null)
  useEffect(() => {
    if (!isHost || connectedCount < 3) return
    const needCards = connectedCount + 3
    const countChanged = seededFor.current !== connectedCount
    if (deck.length === 0 || (countChanged && deck.length !== needCards)) {
      seededFor.current = connectedCount
      onChange(recommendedDeck(connectedCount))
    } else if (deck.length === needCards) {
      seededFor.current = connectedCount
    }
  }, [connectedCount, deck.length, isHost, onChange])

  const add = (role: WerewolfRole) => {
    if (!isHost) return
    if (countIn(deck, role) >= poolCount(role)) return
    if (deck.length >= need) return
    onChange([...deck, role])
  }

  const remove = (role: WerewolfRole) => {
    if (!isHost) return
    const idx = deck.lastIndexOf(role)
    if (idx < 0) return
    onChange(deck.filter((_, i) => i !== idx))
  }

  return (
    <div className="werewolf-deck-builder">
      <div className="werewolf-deck-header">
        <p className="hint">
          Role cards in play ({deck.length}/{need} — players + 3 center)
        </p>
        {isHost && connectedCount >= 3 && (
          <button
            type="button"
            className="btn tiny"
            onClick={() => onChange(recommendedDeck(connectedCount))}
          >
            Recommended
          </button>
        )}
      </div>

      <ul className="werewolf-deck-summary">
        {summary.length === 0 ? (
          <li className="muted">No cards selected yet.</li>
        ) : (
          summary.map((line) => <li key={line}>{line}</li>)
        )}
      </ul>

      {isHost ? (
        <div className="werewolf-deck-pool">
          {UNIQUE_ROLES.map((role) => {
            const used = countIn(deck, role)
            const max = poolCount(role)
            const info = ROLE_INFO[role]
            return (
              <div
                key={role}
                className="werewolf-deck-role"
                data-team={info.team}
              >
                <div className="werewolf-deck-role-meta">
                  <div className="werewolf-deck-role-title">
                    <RoleIcon role={role} size={22} title={info.name} />
                    <strong>{info.name}</strong>
                  </div>
                  <span>
                    {used}/{max}
                  </span>
                </div>
                <div className="werewolf-deck-role-actions">
                  <button
                    type="button"
                    className="btn tiny"
                    disabled={used <= 0}
                    onClick={() => remove(role)}
                    aria-label={`Remove ${info.name}`}
                  >
                    −
                  </button>
                  <button
                    type="button"
                    className="btn tiny"
                    disabled={used >= max || deck.length >= need}
                    onClick={() => add(role)}
                    aria-label={`Add ${info.name}`}
                  >
                    +
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="hint">Host is choosing which roles are in the game.</p>
      )}

      {!valid && connectedCount >= 3 && (
        <p className="werewolf-deck-warn">
          Need exactly {need} cards before starting ({ROLE_POOL.length} max in
          the base set).
        </p>
      )}
      {connectedCount < 3 && (
        <p className="werewolf-deck-warn">Need at least 3 players to deal.</p>
      )}
    </div>
  )
}
