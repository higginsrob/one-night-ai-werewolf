import type { SessionSnapshot } from '../../net/protocol'
import type { ClientId, PlayerPublic } from '../../session/types'

/** Max consecutive AI chat replies before a human must speak again. */
export const MAX_AGENT_CHAT_STREAK = 3

/** Longer interview chains when humans are only watching. */
export const MAX_WATCH_AGENT_CHAT_STREAK = 6

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * True when `text` directs a question / vocative at `name`
 * (not merely mentioning them in third person).
 */
export function isDirectedAtName(text: string, name: string): boolean {
  const n = name.trim()
  if (!n || n.length < 2) return false
  const reName = escapeRegExp(n)
  // "Alice," / "Alice?"
  const vocative = new RegExp(`(?:^|[.!?\\s])${reName}\\s*[,?]`, 'i')
  // Name appears in a sentence that ends with ?
  const ask = new RegExp(`\\b${reName}\\b[^.!?\\n]*\\?`, 'i')
  // "hey Alice" / "so Alice"
  const hey = new RegExp(
    `\\b(?:hey|hi|ok|okay|so|well)\\s+${reName}\\b`,
    'i',
  )
  // "Alice, did/what/…"
  const askName = new RegExp(
    `\\b${reName}\\s*,\\s*(?:did|do|what|who|are|were|can|could|would|will|how|why|when|where|have|has|is|was)\\b`,
    'i',
  )
  return (
    vocative.test(text) ||
    ask.test(text) ||
    hey.test(text) ||
    askName.test(text)
  )
}

function connectedAiPlayers(snapshot: SessionSnapshot): PlayerPublic[] {
  return snapshot.players.filter(
    (p) => p.connected && p.isNpc && p.aiProfileId,
  )
}

/**
 * AI seats the speaker is interviewing (directed name address).
 * Prefer question/vocative hits over bare third-person mentions.
 */
export function findInterviewTargets(
  text: string,
  snapshot: SessionSnapshot,
  speakerId: ClientId,
): ClientId[] {
  const npcs = connectedAiPlayers(snapshot)
  const out: ClientId[] = []
  // Longer names first so "Ann" does not steal "Anna".
  const ordered = [...npcs].sort((a, b) => b.name.length - a.name.length)
  const claimedSpans: Array<{ start: number; end: number }> = []

  for (const p of ordered) {
    if (p.id === speakerId) continue
    const name = p.name.trim()
    if (name.length < 2) continue
    if (!isDirectedAtName(text, name)) continue

    const lower = text.toLowerCase()
    const needle = name.toLowerCase()
    let from = 0
    let hit = -1
    while ((hit = lower.indexOf(needle, from)) >= 0) {
      const end = hit + needle.length
      const overlaps = claimedSpans.some(
        (s) => hit < s.end && end > s.start,
      )
      if (!overlaps) {
        claimedSpans.push({ start: hit, end })
        if (!out.includes(p.id)) out.push(p.id)
        break
      }
      from = hit + 1
    }
  }
  return out
}

/**
 * Next AI who should answer an interview question from `reply`.
 * Skips seats already queued or who just spoke.
 */
export function pickInterviewFollowUp(args: {
  reply: string
  snapshot: SessionSnapshot
  speakerId: ClientId
  /** Seats already scheduled or who already spoke this chain. */
  excludeIds: Iterable<ClientId>
}): ClientId | null {
  const exclude = new Set(args.excludeIds)
  const targets = findInterviewTargets(
    args.reply,
    args.snapshot,
    args.speakerId,
  )
  for (const id of targets) {
    if (exclude.has(id)) continue
    const p = args.snapshot.players.find((x) => x.id === id)
    if (!p?.connected || !p.isNpc || !p.aiProfileId) continue
    return id
  }
  return null
}
