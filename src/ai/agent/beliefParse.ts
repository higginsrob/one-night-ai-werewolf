/** Parse beliefUpdates from messy local-model JSON. */

export type BeliefUpdate = { aboutName: string; notes: string }

/**
 * Accepts canonical `{aboutName, notes}` and Gemma-style
 * `{aboutRob: "…"}` / `{aboutClaire: "…", notes: "…"}`.
 */
export function parseBeliefUpdates(
  value: unknown,
  playerNames: string[] = [],
): BeliefUpdate[] {
  if (!Array.isArray(value)) return []
  const out: BeliefUpdate[] = []

  for (const u of value) {
    if (!u || typeof u !== 'object' || Array.isArray(u)) continue
    const row = u as Record<string, unknown>

    if (typeof row.aboutName === 'string' && typeof row.notes === 'string') {
      const aboutName = row.aboutName.trim().slice(0, 32)
      const notes = scrubDayBeliefNotes(row.notes.trim().slice(0, 200))
      if (aboutName && notes) out.push({ aboutName, notes })
      if (out.length >= 4) break
      continue
    }

    for (const [key, raw] of Object.entries(row)) {
      const m = key.match(/^about[_]?(.+)$/i)
      if (!m?.[1]) continue
      const guessed = m[1].replace(/[_-]+/g, ' ').trim()
      const aboutName =
        resolveName(guessed, playerNames) ??
        (guessed.length ? guessed.slice(0, 32) : null)
      if (!aboutName) continue
      const notesRaw =
        typeof raw === 'string' && raw.trim()
          ? raw.trim().slice(0, 200)
          : typeof row.notes === 'string' && row.notes.trim()
            ? row.notes.trim().slice(0, 200)
            : null
      if (!notesRaw) continue
      const notes = scrubDayBeliefNotes(notesRaw)
      if (!notes) continue
      out.push({ aboutName, notes })
      break
    }
    if (out.length >= 4) break
  }

  return out
}

/**
 * Day-phase beliefs must not invent a future night ("peek him tonight").
 * Returns empty string when the note is only temporal night fluff.
 */
export function scrubDayBeliefNotes(notes: string): string {
  let out = notes
    .replace(
      /\b(?:I\s+)?(?:should|will|gonna|going\s+to)\s+(?:look\s+at|peek(?:\s+at)?|check)\s+\w+\s+tonight\b[^.!?]*[.!?]?/gi,
      ' ',
    )
    .replace(/\b(?:peek|look\s+at|check)\s+(?:him|her|them|\w+)\s+tonight\b/gi, ' ')
    .replace(/\btonight\b/gi, 'this day')
    .replace(/\s+/g, ' ')
    .trim()
  // Drop notes that are only the scrubbed remnant of a night plan.
  if (
    !out ||
    /^(?:as\s+seer,?\s*)?(?:I\s+should\s+)?(?:verify|check).{0,40}$/i.test(out)
  ) {
    return ''
  }
  return out.slice(0, 200)
}

/** True when notes claim someone has no claim yet. */
export function notesClaimNoClaimYet(notes: string): boolean {
  return /\bno\s+(?:clear\s+)?claim\s+yet\b|\bhas(?:n't| not)\s+claimed\b|\bstill\s+no\s+claim\b|\bremains?\s+neutral\b.*\bno\s+claim\b|\bno\s+clear\s+claim\b/i.test(
    notes,
  )
}

/**
 * Drop belief updates that say "no claim yet" when the claim ledger already
 * has a claim for that player.
 */
export function filterStaleNoClaimBeliefs(
  updates: BeliefUpdate[],
  claimedNames: Set<string>,
): BeliefUpdate[] {
  if (claimedNames.size === 0) return updates
  return updates.filter((u) => {
    if (!notesClaimNoClaimYet(u.notes)) return true
    const hit = [...claimedNames].some(
      (n) => n.toLowerCase() === u.aboutName.toLowerCase(),
    )
    return !hit
  })
}

/**
 * Strip "no claim yet" lines from multi-line stored notes when that player
 * already has a claim on the ledger.
 */
export function scrubStaleNoClaimLines(
  notes: string,
  playerHasClaim: boolean,
): string {
  if (!playerHasClaim || !notes.trim()) return notes
  return notes
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !notesClaimNoClaimYet(line))
    .join('\n')
}

function resolveName(guessed: string, playerNames: string[]): string | null {
  const needle = guessed.toLowerCase()
  if (!needle) return null
  const exact = playerNames.find((n) => n.toLowerCase() === needle)
  if (exact) return exact
  const partial = playerNames.find(
    (n) =>
      n.toLowerCase().startsWith(needle) ||
      needle.startsWith(n.toLowerCase()) ||
      n.toLowerCase().includes(needle),
  )
  return partial ?? null
}

/** Pull beliefUpdates array out of a model JSON blob. */
export function parseBeliefUpdatesFromText(
  text: string,
  playerNames: string[] = [],
): BeliefUpdate[] {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return []
  try {
    const obj = JSON.parse(match[0]) as { beliefUpdates?: unknown }
    return parseBeliefUpdates(obj.beliefUpdates, playerNames)
  } catch {
    return []
  }
}
