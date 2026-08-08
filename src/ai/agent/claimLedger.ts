import { ROLE_INFO, roleName } from '../../game/roles'
import type { WerewolfRole, WerewolfSnapshot } from '../../game/werewolfTypes'
import type { ChatLine, ClientId, PlayerPublic } from '../../session/types'
import type { AgentGameMemory } from './memory'

const ROLE_BY_TOKEN = new Map<string, string>()
for (const role of Object.keys(ROLE_INFO) as WerewolfRole[]) {
  const label = ROLE_INFO[role].name
  ROLE_BY_TOKEN.set(role.toLowerCase(), label)
  ROLE_BY_TOKEN.set(label.toLowerCase(), label)
}
ROLE_BY_TOKEN.set('wolf', 'Werewolf')
ROLE_BY_TOKEN.set('ww', 'Werewolf')

function matchRoleLabel(fragment: string): string | null {
  const key = fragment.trim().toLowerCase().replace(/[^a-z]/g, '')
  if (!key) return null
  return ROLE_BY_TOKEN.get(key) ?? null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * First-person self-claims only. Skips third-person "X claimed Werewolf".
 * Also catches casual / STT openers: "insomniac here", "my role was Seer".
 */
const CLAIM_PATTERNS: RegExp[] = [
  // Prefer night-role statements over soft "I'd claim X" cover appendages.
  // First-person only — "you/he woke up as Robber" must NOT become a self-claim.
  /\bi\s+woke(?:\s+up)?\s+(?:as\s+)?(?:a\s+|the\s+)?([a-z]+)\b/i,
  /\bi(?:'m| am| was)\s+(?:just\s+|really\s+|actually\s+|honestly\s+)?(?:a\s+|the\s+)?(?:humble\s+|simple\s+|plain\s+)?([a-z]+)\b/i,
  /\bi(?:'m| am)\s+claiming\s+(?:to be\s+)?(?:a\s+|the\s+)?([a-z]+)\b/i,
  // "my role is/was Seer" / "my card was Villager"
  /\bmy\s+(?:role|card)\s+(?:is|was|as)\s+(?:a\s+|the\s+)?([a-z]+)\b/i,
  // "I played Seer" / "I started as Robber"
  /\bi\s+(?:played|started)\s+(?:as\s+)?(?:a\s+|the\s+)?([a-z]+)\b/i,
  // "as the Seer, I …" / "as Seer I looked…" — require first-person follow-through
  // so "I saw Boz as a Villager," is NOT a self-claim.
  /\bas\s+(?:a\s+|the\s+)?([a-z]+)\s*[,:]\s*i\b/i,
  /\bas\s+(?:a\s+|the\s+)?([a-z]+)\s+i\b/i,
  // Soft cover last — do not override "I woke as Seer" with "I'd claim Villager".
  /\bi(?:'d| would)\s+claim\s+(?:to be\s+)?(?:a\s+|the\s+)?([a-z]+)\b/i,
  // "hi everyone, insomniac here" / "Seer here"
  /\b([a-z]+)\s+here\b/i,
]

/** True when "as Role" is a peek result ("saw Boz as Villager"), not a self-claim. */
function matchIsPeekAsRole(text: string, matchIndex: number): boolean {
  const before = text.slice(Math.max(0, matchIndex - 100), matchIndex)
  return /\b(?:saw|peeked(?:\s+at)?|looked\s+at|checked)\b[\s\S]{0,80}$/i.test(
    before,
  )
}

/** Normalize curly apostrophes so "I'm the Villager" matches claim patterns. */
function normalizeClaimText(text: string): string {
  return text.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
}

/** Pull a public role claim from spoken/table text, or null. */
export function extractClaimFromText(text: string): string | null {
  const normalized = normalizeClaimText(text)
  for (const re of CLAIM_PATTERNS) {
    const m = normalized.match(re)
    if (!m?.[1] || m.index == null) continue
    if (matchIsPeekAsRole(normalized, m.index)) continue
    const role = matchRoleLabel(m[1])
    if (role) return role
  }
  return null
}

export type ClaimLedgerEntry = {
  playerId: ClientId
  playerName: string
  claim: string | null
  source: 'chat' | 'plan' | 'none'
  evidence: string | null
}

export type SpokenNightStory =
  | {
      kind: 'seer-player'
      speakerId: ClientId
      speakerName: string
      targetId: ClientId
      targetName: string
      role: string
      evidence: string
    }
  | {
      kind: 'seer-center'
      speakerId: ClientId
      speakerName: string
      /** Named center roles if spoken (e.g. Seer + Werewolf). Empty = vague/incomplete. */
      roles: string[]
      evidence: string
    }
  | {
      kind: 'robber'
      speakerId: ClientId
      speakerName: string
      targetId: ClientId
      targetName: string
      stolenRole: string | null
      evidence: string
    }
  | {
      kind: 'troublemaker'
      speakerId: ClientId
      speakerName: string
      aId: ClientId
      aName: string
      bId: ClientId
      bName: string
      evidence: string
    }

/** True when this story already answers "what did you see / do at night?" */
export function nightStoryIsComplete(story: SpokenNightStory): boolean {
  if (story.kind === 'seer-player') return true
  // Vague "I peeked center" without naming roles is incomplete — demand the cards.
  if (story.kind === 'seer-center') return story.roles.length >= 1
  // Robber needs target + stolen role; target-only is incomplete.
  if (story.kind === 'robber') return Boolean(story.stolenRole)
  if (story.kind === 'troublemaker') return true
  return false
}

/** First-person Robber/Troublemaker swap already spoken on the claim board. */
export function boardHasSpokenSwapStory(
  stories: SpokenNightStory[],
): boolean {
  return stories.some(
    (s) => s.kind === 'robber' || s.kind === 'troublemaker',
  )
}

/**
 * Extract a Seer-style player peek from first-person table talk, e.g.
 * "I saw Ben as the Villager" / "I peeked Kim as Werewolf".
 * Third-person ("you peeked Ben…") must NOT become the speaker's night story.
 */
export function extractSeerPlayerPeekFromText(
  text: string,
  players: PlayerPublic[],
  speakerId: ClientId,
): { targetId: ClientId; targetName: string; role: string } | null {
  // Require first-person ownership of the peek verb.
  if (
    !/\bi\b[^.!?]{0,100}\b(?:saw|peeked(?:\s+at)?|looked\s+at|checked)\b/i.test(
      text,
    )
  ) {
    return null
  }
  for (const p of players) {
    if (p.id === speakerId) continue
    const name = escapeRegExp(p.name)
    const patterns = [
      new RegExp(
        `\\b(?:saw|peeked(?:\\s+at)?|looked\\s+at|checked)\\b[^.!?]{0,40}\\b${name}\\b[^.!?]{0,40}\\b(?:as\\s+)?(?:a\\s+|the\\s+)?([a-z]+)\\b`,
        'i',
      ),
      new RegExp(
        `\\b${name}\\b\\s+(?:as|was)\\s+(?:a\\s+|the\\s+)?([a-z]+)\\b`,
        'i',
      ),
      // "saw Ben as the villager, NOT Kim" — role may follow "as"
      new RegExp(
        `\\b(?:saw|peeked(?:\\s+at)?|looked\\s+at)\\s+${name}\\s+as\\s+(?:a\\s+|the\\s+)?([a-z]+)\\b`,
        'i',
      ),
    ]
    for (const re of patterns) {
      const m = text.match(re)
      if (!m?.[1]) continue
      const role = matchRoleLabel(m[1])
      if (!role) continue
      // Avoid matching "saw Ben as the" with filler words.
      if (/^(as|the|a|an|not|and|or)$/i.test(m[1])) continue
      return { targetId: p.id, targetName: p.name, role }
    }
  }
  return null
}

/** First-person center peek only — "you peeked the center" is not the speaker's story. */
function extractSeerCenterPeek(text: string): boolean {
  return /\bi\b[^.!?]{0,100}\b(?:saw|peeked(?:\s+at)?|looked\s+at|checked)\b[^.!?]{0,50}\b(?:two\s+)?(?:center|middle)\b/i.test(
    text,
  )
}

/** Role labels named as the result of a first-person center peek (may be empty). */
function extractSeerCenterRoles(text: string): string[] {
  const roles: string[] = []
  const seen = new Set<string>()
  // Only scan the peek-result window — not "I'm the Seer and peeked center…".
  const windows = [
    text.match(
      /\b(?:center|middle)\b[^.!?]{0,20}\b(?:was|were|are|as|showed|had|contained)\b[^.!?]{0,100}/i,
    )?.[0],
    text.match(
      /\b(?:saw|peeked(?:\s+at)?|looked\s+at|checked)\b[^.!?]{0,40}\b(?:two\s+)?(?:center|middle)\b[^.!?]{0,100}/i,
    )?.[0],
    text.match(/\b(?:center|middle)\s+cards?\s*[:\-–]\s*[^.!?]{0,100}/i)?.[0],
  ].filter((w): w is string => Boolean(w))
  if (windows.length === 0) return []
  const window = windows[0]!
  for (const m of window.matchAll(/\b([A-Za-z][a-z]+)\b/g)) {
    const label = matchRoleLabel(m[1]!)
    if (!label) continue
    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    roles.push(label)
  }
  return roles.slice(0, 3)
}

/** First-person rob / steal / grab verbs (shared with reply recognition). */
const ROBBER_OWN_VERB =
  String.raw`robbed|stole(?:\s+from)?|swapped\s+with|took|grabbed`

function extractRobberStory(
  text: string,
  players: PlayerPublic[],
  speakerId: ClientId,
): { targetId: ClientId; targetName: string; stolenRole: string | null } | null {
  // Troublemaker "swapped A and B" is not a Robber story.
  if (/\b(?:swapped|switched)\s+\w+\s+and\b/i.test(text)) return null
  // First-person only — "Rob said he robbed Kai" must not become Ben's night story.
  const ownsRob =
    new RegExp(
      String.raw`\bi\s+(?:was\s+the\s+robber\s+and\s+(?:i\s+)?)?(?:${ROBBER_OWN_VERB})\b`,
      'i',
    ).test(text) ||
    /\bi(?:'m|\s+am)\s+(?:the\s+)?robber\b/i.test(text) ||
    // "I grabbed Mason from Ben" / "I ended up as Mason after robbing Ben"
    /\bi\s+(?:grabbed|got)\s+(?:a\s+|the\s+)?[a-z]+\s+from\b/i.test(text) ||
    /\bi\s+(?:ended\s+up\s+as|became)\s+(?:a\s+|the\s+)?[a-z]+/i.test(text)
  if (!ownsRob) return null
  // Bare "I'm the Robber" without a named target is a role claim, not a night story.
  for (const p of players) {
    if (p.id === speakerId) continue
    const name = escapeRegExp(p.name)
    const hit =
      new RegExp(
        String.raw`\bi\s+(?:was\s+the\s+robber\s+and\s+(?:i\s+)?)?(?:${ROBBER_OWN_VERB})\b[^.!?]{0,40}\b${name}\b`,
        'i',
      ).test(text) ||
      new RegExp(
        String.raw`\bi\s+(?:grabbed|got)\s+(?:a\s+|the\s+)?[a-z]+\s+from\s+${name}\b`,
        'i',
      ).test(text) ||
      new RegExp(
        String.raw`\b(?:robbed|stole(?:\s+from)?|swapped\s+with|took|grabbed)\b[^.!?]{0,40}\b${name}\b`,
        'i',
      ).test(text) ||
      (/\bi\s+(?:ended\s+up\s+as|became)\b/i.test(text) &&
        new RegExp(
          String.raw`\b(?:from|robbing|robbed)\s+${name}\b`,
          'i',
        ).test(text))
    if (!hit) continue
    let stolenRole: string | null = null
    const roleMatch = text.match(
      /\b(?:got|stole|took|grabbed|became|ended\s+up\s+as|saw\s+(?:him|her|them)\s+as)\s+(?:a\s+|the\s+)?([a-z]+)\b/i,
    )
    if (roleMatch?.[1]) {
      stolenRole = matchRoleLabel(roleMatch[1])
    }
    return { targetId: p.id, targetName: p.name, stolenRole }
  }
  return null
}

/**
 * First-person Troublemaker swap only.
 * "Kim / Boz … he swapped" or "if Carrie swapped A and B" must NOT become
 * the speaker's night story — that false attribution poisons the claim board.
 */
function extractTroublemakerSwap(
  text: string,
  players: PlayerPublic[],
  speakerId: ClientId,
): { aId: ClientId; aName: string; bId: ClientId; bName: string } | null {
  // Require the speaker to own the swap verb (same bar as Seer/Robber extractors).
  const ownsSwap =
    /\bi\s+(?:swapped|switched|shuffled)\b/i.test(text) ||
    /\bi(?:'m|\s+am)\s+(?:the\s+)?troublemaker\b[^.!?]{0,100}\b(?:who\s+)?(?:swapped|switched|shuffled)\b/i.test(
      text,
    ) ||
    /\bas\s+(?:the\s+)?troublemaker\b[^.!?]{0,80}\bi\s+(?:swapped|switched|shuffled)\b/i.test(
      text,
    )
  if (!ownsSwap) return null

  // Reject third-person framing even when "I" appears elsewhere
  // ("I think Carrie swapped Boz and Kim").
  if (
    /\b(?:he|she|they|you)\s+(?:swapped|switched|shuffled)\b/i.test(text) &&
    !/\bi\s+(?:swapped|switched|shuffled)\b/i.test(text)
  ) {
    return null
  }
  for (const p of players) {
    if (p.id === speakerId) continue
    const name = escapeRegExp(p.name)
    if (
      new RegExp(
        `\\b${name}\\s+(?:swapped|switched|shuffled)\\b`,
        'i',
      ).test(text) &&
      !/\bi\s+(?:swapped|switched|shuffled)\b/i.test(text)
    ) {
      return null
    }
  }

  const hit: PlayerPublic[] = []
  for (const p of players) {
    if (p.id === speakerId) continue
    if (new RegExp(`\\b${escapeRegExp(p.name)}\\b`, 'i').test(text)) {
      hit.push(p)
    }
  }
  if (hit.length < 2) return null
  return {
    aId: hit[0]!.id,
    aName: hit[0]!.name,
    bId: hit[1]!.id,
    bName: hit[1]!.name,
  }
}

/**
 * First-person night story from a single utterance (Seer / TM / Robber).
 * Same priority as the table claim board: player peek → center → TM → Robber.
 */
export function extractSpokenNightStoryFromText(
  text: string,
  players: PlayerPublic[],
  speakerId: ClientId,
  speakerName: string,
): SpokenNightStory | null {
  const evidence = text.slice(0, 160)

  const peek = extractSeerPlayerPeekFromText(text, players, speakerId)
  if (peek) {
    return {
      kind: 'seer-player',
      speakerId,
      speakerName,
      targetId: peek.targetId,
      targetName: peek.targetName,
      role: peek.role,
      evidence,
    }
  }

  if (extractSeerCenterPeek(text)) {
    return {
      kind: 'seer-center',
      speakerId,
      speakerName,
      roles: extractSeerCenterRoles(text),
      evidence,
    }
  }

  const tm = extractTroublemakerSwap(text, players, speakerId)
  if (tm) {
    return {
      kind: 'troublemaker',
      speakerId,
      speakerName,
      ...tm,
      evidence,
    }
  }

  const rob = extractRobberStory(text, players, speakerId)
  if (rob) {
    return {
      kind: 'robber',
      speakerId,
      speakerName,
      targetId: rob.targetId,
      targetName: rob.targetName,
      stolenRole: rob.stolenRole,
      evidence,
    }
  }

  return null
}

/** Short spectator/UI label for a spoken night action claim (no speaker name). */
export function formatSpokenNightStoryClaim(story: SpokenNightStory): string {
  if (story.kind === 'seer-player') {
    return `saw ${story.targetName} as ${story.role}`
  }
  if (story.kind === 'seer-center') {
    return story.roles.length > 0
      ? `peeked center (${story.roles.join(' + ')})`
      : 'peeked the center (roles unnamed)'
  }
  if (story.kind === 'robber') {
    return story.stolenRole
      ? `robbed ${story.targetName} (${story.stolenRole})`
      : `robbed ${story.targetName}`
  }
  return `swapped ${story.aName} and ${story.bName}`
}

/**
 * Host-built night stories spoken at the table (latest complete story per seat).
 */
export function buildSpokenNightStories(
  chatLines: ChatLine[],
  players: PlayerPublic[],
): SpokenNightStory[] {
  const bySpeaker = new Map<ClientId, SpokenNightStory>()

  for (const line of chatLines) {
    const speaker = players.find((p) => p.id === line.fromId)
    if (!speaker) continue
    const story = extractSpokenNightStoryFromText(
      line.text,
      players,
      line.fromId,
      speaker.name,
    )
    if (story) bySpeaker.set(line.fromId, story)
  }

  return [...bySpeaker.values()]
}

export function formatSpokenNightStories(stories: SpokenNightStory[]): string {
  if (stories.length === 0) {
    return '(no clear night stories spoken yet)'
  }
  const lines = stories.map((s) => {
    if (s.kind === 'seer-player') {
      return `- ${s.speakerName}: Seer peek — ${s.targetName} as ${s.role}`
    }
    if (s.kind === 'seer-center') {
      if (s.roles.length > 0) {
        return `- ${s.speakerName}: Seer peek — center ${s.roles.join(' + ')}`
      }
      return `- ${s.speakerName}: Seer peek — center cards (roles not named — incomplete)`
    }
    if (s.kind === 'robber') {
      const stole = s.stolenRole ? ` (got ${s.stolenRole})` : ''
      return `- ${s.speakerName}: Robber — swapped with ${s.targetName}${stole}`
    }
    return `- ${s.speakerName}: Troublemaker — swapped ${s.aName} and ${s.bName}`
  })
  lines.push(
    'Note: a named peek ("I saw X as Y") or named center roles is a complete night story — do not demand more detail on how they know. Vague "I peeked center" without roles is incomplete — ask which cards.',
    'Note: dealt Mason + Robber→Mason is normal — count role claims, not "became Mason" as an extra Mason claim.',
  )
  return lines.join('\n')
}

/** Player names who already gave a complete spoken night story. */
export function namesWithCompleteNightStory(
  stories: SpokenNightStory[],
): Set<string> {
  const out = new Set<string>()
  for (const s of stories) {
    if (nightStoryIsComplete(s)) out.add(s.speakerName)
  }
  return out
}

/** Incomplete night stories still on the board (vague Seer center, Robber without stolen role). */
export function incompleteNightStories(
  stories: SpokenNightStory[],
): SpokenNightStory[] {
  return stories.filter((s) => !nightStoryIsComplete(s))
}

/** Physical cards in this round's hand (players + center), preserving duplicates. */
export function roleDeckRoles(game: WerewolfSnapshot): WerewolfRole[] {
  if (game.roleDeck?.length > 0) return [...game.roleDeck]
  return [
    ...Object.values(game.dealtRoles),
    ...(game.dealtCenter ?? []),
  ] as WerewolfRole[]
}

/** Unique role labels present in this round's deck (players + center). */
export function rolesInPlayLabels(game: WerewolfSnapshot): string[] {
  const labels: string[] = []
  const seen = new Set<string>()
  for (const role of roleDeckRoles(game)) {
    const label = roleName(role)
    if (seen.has(label)) continue
    seen.add(label)
    labels.push(label)
  }
  return labels
}

/**
 * Public hand composition with multiplicity, e.g.
 * "2× Werewolf, 1× Seer, 1× Robber, 1× Villager, 1× Troublemaker, 1× Minion (7 cards)".
 */
export function formatRoleDeckHand(game: WerewolfSnapshot): string {
  const roles = roleDeckRoles(game)
  if (roles.length === 0) return '(unknown)'
  const counts = new Map<string, number>()
  const order: string[] = []
  for (const role of roles) {
    const label = roleName(role)
    if (!counts.has(label)) order.push(label)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const parts = order.map((label) => `${counts.get(label)}× ${label}`)
  return `${parts.join(', ')} (${roles.length} cards)`
}

/** Normalize a free-form plan claim to a deck role label, or null. */
export function normalizePlanClaim(
  claim: string | null | undefined,
  allowedLabels: string[],
): string | null {
  if (!claim?.trim()) return null
  const matched = matchRoleLabel(claim)
  if (!matched) return null
  if (allowedLabels.length === 0) return matched
  const ok = allowedLabels.some(
    (l) => l.toLowerCase() === matched.toLowerCase(),
  )
  return ok ? matched : null
}

/** Info roles that should stick once spoken — do not flip to Villager mid-day. */
export const INFO_CLAIM_ROLES = new Set([
  'Seer',
  'Troublemaker',
  'Robber',
  'Mason',
  'Insomniac',
])

/** Claims that normally have no night action / no night story to share. */
export const NO_NIGHT_STORY_CLAIMS = new Set([
  'Villager',
  'Hunter',
  'Tanner',
])

export function isInfoClaimRole(claim: string | null | undefined): boolean {
  if (!claim?.trim()) return false
  return INFO_CLAIM_ROLES.has(claim.trim())
}

/** True when this claimed role usually owes a first-person night story. */
export function claimExpectsNightStory(
  claim: string | null | undefined,
): boolean {
  if (!claim?.trim()) return false
  return !NO_NIGHT_STORY_CLAIMS.has(claim.trim())
}

/** Latest role this seat already said at the table. */
export function spokenClaimForPlayer(
  chatLines: ChatLine[],
  playerId: ClientId,
  players: PlayerPublic[] = [],
): string | null {
  let found: string | null = null
  let sharedSeerPeek = false
  for (const line of chatLines) {
    if (line.fromId !== playerId) continue
    const claim = extractClaimFromText(line.text)
    if (claim) found = claim
    if (
      players.length > 0 &&
      extractSeerPlayerPeekFromText(line.text, players, playerId)
    ) {
      sharedSeerPeek = true
    } else if (extractSeerCenterPeek(line.text)) {
      sharedSeerPeek = true
    }
  }
  // A named Seer peek without an explicit role claim still counts as claiming Seer.
  if (!found && sharedSeerPeek) return 'Seer'
  // Complete first-person rob story without "I'm the Robber" still counts as Robber.
  if (!found && players.length > 0) {
    for (const line of chatLines) {
      if (line.fromId !== playerId) continue
      if (extractRobberStory(line.text, players, playerId)) return 'Robber'
    }
  }
  return found
}

/**
 * First firm info claim for this seat (Seer/TM/Robber/Mason/Insomniac).
 * Once spoken, that claim locks for the rest of day — later "I'm Villager"
 * lines must not overwrite it for planning or speech guards.
 * Falls back to latest claim when no info lock exists.
 */
export function lockedSpokenClaimForPlayer(
  chatLines: ChatLine[],
  playerId: ClientId,
  players: PlayerPublic[] = [],
): string | null {
  let firstInfo: string | null = null
  let latest: string | null = null
  let sharedSeerPeek = false
  for (const line of chatLines) {
    if (line.fromId !== playerId) continue
    const claim = extractClaimFromText(line.text)
    if (claim) {
      latest = claim
      if (!firstInfo && isInfoClaimRole(claim)) firstInfo = claim
    }
    if (
      players.length > 0 &&
      extractSeerPlayerPeekFromText(line.text, players, playerId)
    ) {
      sharedSeerPeek = true
    } else if (extractSeerCenterPeek(line.text)) {
      sharedSeerPeek = true
    }
  }
  if (firstInfo) return firstInfo
  if (latest) return latest
  if (sharedSeerPeek) return 'Seer'
  // Complete first-person rob story without "I'm the Robber" still locks Robber.
  if (players.length > 0) {
    for (const line of chatLines) {
      if (line.fromId !== playerId) continue
      if (extractRobberStory(line.text, players, playerId)) return 'Robber'
    }
  }
  return null
}

export type OverclaimedRole = {
  role: string
  claimed: number
  deck: number
  names: string[]
}

/**
 * Roles whose spoken claim count exceeds the deck count for this hand.
 * Used to pressure surplus Villager/etc. claimants.
 */
export function overclaimedRoles(
  game: WerewolfSnapshot,
  entries: ClaimLedgerEntry[],
): OverclaimedRole[] {
  const seatedIds = new Set(game.playerIds)
  const seated = entries.filter((e) => seatedIds.has(e.playerId) && e.claim)
  if (seated.length === 0) return []

  const deckCounts = new Map<string, number>()
  for (const role of roleDeckRoles(game)) {
    const label = roleName(role)
    deckCounts.set(label, (deckCounts.get(label) ?? 0) + 1)
  }

  const byRole = new Map<string, string[]>()
  for (const e of seated) {
    const c = e.claim!
    const list = byRole.get(c) ?? []
    list.push(e.playerName)
    byRole.set(c, list)
  }

  const out: OverclaimedRole[] = []
  for (const [role, names] of byRole) {
    const deck = deckCounts.get(role) ?? 0
    if (names.length > deck) {
      out.push({ role, claimed: names.length, deck, names })
    }
  }
  return out
}

/**
 * True when every seated player has a spoken non-wolf claim and those claims
 * fit the deck counts — both wolves look center-only from public speech.
 */
export function spokenClaimsAccountForVillageSeats(
  game: WerewolfSnapshot,
  entries: ClaimLedgerEntry[],
): boolean {
  const seatedIds = new Set(game.playerIds)
  const seated = entries.filter((e) => seatedIds.has(e.playerId))
  if (seated.length === 0 || seated.length !== game.playerIds.length) {
    return false
  }
  if (seated.some((e) => !e.claim)) return false

  const wolfLabels = new Set(['Werewolf', 'Minion'])
  if (seated.some((e) => e.claim && wolfLabels.has(e.claim))) return false

  const deckCounts = new Map<string, number>()
  for (const role of roleDeckRoles(game)) {
    const label = roleName(role)
    if (wolfLabels.has(label)) continue
    deckCounts.set(label, (deckCounts.get(label) ?? 0) + 1)
  }
  const villageInDeck = [...deckCounts.values()].reduce((a, b) => a + b, 0)
  if (villageInDeck < game.playerIds.length) return false

  const claimCounts = new Map<string, number>()
  for (const e of seated) {
    const c = e.claim!
    claimCounts.set(c, (claimCounts.get(c) ?? 0) + 1)
  }
  for (const [role, n] of claimCounts) {
    if ((deckCounts.get(role) ?? 0) < n) return false
  }
  return true
}

/**
 * Host-built summary of who claimed what — so models need not reconstruct
 * claims from raw chat alone.
 *
 * Priority: chat > (self) plan.
 * Deal-phase card picks are private dealt roles, not public claims.
 * Plan claims only fill the viewing agent's own seat (never other players).
 */
export function buildClaimLedger(args: {
  players: PlayerPublic[]
  chatLines: ChatLine[]
  /** Optional per-agent memories (self plan claims only). */
  memoriesByAgentId?: Map<ClientId, AgentGameMemory>
  /** When set, plan fallback applies only to this seat. */
  selfId?: ClientId | null
}): ClaimLedgerEntry[] {
  const { players, chatLines, memoriesByAgentId, selfId = null } = args
  const byId = new Map<ClientId, ClaimLedgerEntry>()

  for (const p of players) {
    byId.set(p.id, {
      playerId: p.id,
      playerName: p.name,
      claim: null,
      source: 'none',
      evidence: null,
    })
  }

  for (const line of chatLines) {
    const claim = extractClaimFromText(line.text)
    if (!claim) continue
    const entry = byId.get(line.fromId)
    if (!entry) continue
    entry.claim = claim
    entry.source = 'chat'
    entry.evidence = line.text.slice(0, 160)
  }

  if (memoriesByAgentId && selfId) {
    const mem = memoriesByAgentId.get(selfId)
    const planned = mem?.lastPlan?.claim?.trim()
    if (planned) {
      const entry = byId.get(selfId)
      if (entry && entry.source !== 'chat') {
        const role = matchRoleLabel(planned) ?? planned
        entry.claim = role
        entry.source = 'plan'
        entry.evidence = `Planned claim: ${role}`
      }
    }
  }

  return [...byId.values()]
}

export function formatClaimLedger(entries: ClaimLedgerEntry[]): string {
  if (entries.length === 0) return '(no players)'
  const lines = entries.map((e) => {
    if (!e.claim) return `- ${e.playerName}: (no clear claim yet)`
    const via = e.source === 'plan' ? 'planned' : 'said'
    return `- ${e.playerName}: claimed ${e.claim} (${via})`
  })
  lines.push(
    'Note: dealt Seer + Robber who became Seer can both talk as "Seer" — that is normal, not automatically a wolf pair.',
    'Note: dealt Mason + Robber who became Mason is normal — count ROLE CLAIMS (Robber + Masons), not "became Mason" as a third Mason claim.',
  )
  return lines.join('\n')
}

function nightStorySummary(story: SpokenNightStory): string {
  if (story.kind === 'seer-player') {
    return `Seer peek — ${story.targetName} as ${story.role}`
  }
  if (story.kind === 'seer-center') {
    if (story.roles.length > 0) {
      return `Seer peek — center ${story.roles.join(' + ')}`
    }
    return 'Seer peek — center cards (roles not named — incomplete)'
  }
  if (story.kind === 'robber') {
    const stole = story.stolenRole ? ` (got ${story.stolenRole})` : ''
    const incomplete = story.stolenRole ? '' : ' — incomplete (stolen role unnamed)'
    return `Robber — swapped with ${story.targetName}${stole}${incomplete}`
  }
  return `Troublemaker — swapped ${story.aName} and ${story.bName}`
}

/**
 * Shared global board of public table speech: role claims + night stories.
 * Identical for every agent when built from chat only (no plan fallback).
 * Entries are what was SAID — may be lies; never treat as ground truth.
 */
export function formatPublicClaimBoard(
  entries: ClaimLedgerEntry[],
  stories: SpokenNightStory[],
): string {
  const storyById = new Map(stories.map((s) => [s.speakerId, s]))
  const header = [
    'PUBLIC CLAIM BOARD (shared table speech — identical for every player)',
    'These are public claims only: what people said they were / did at night.',
    'Treat every entry as SUSPECT, not truth — players lie. Weigh against your private night info and role counts.',
    'Do use the board as the record of what was already said: do not re-ask a role or night story listed here.',
  ]

  if (entries.length === 0) {
    return [...header, '(no players)'].join('\n')
  }

  const lines = entries.map((e) => {
    const story = storyById.get(e.playerId)
    const claimBit = e.claim
      ? e.source === 'plan'
        ? `claimed ${e.claim} (planned, not yet spoken)`
        : `claimed ${e.claim}`
      : 'no clear role claim yet'
    const storyBit = story
      ? `night story: ${nightStorySummary(story)}`
      : e.claim && !claimExpectsNightStory(e.claim)
        ? `night story: (none expected — ${e.claim} has no night action)`
        : 'night story: (none spoken)'
    return `- ${e.playerName}: ${claimBit}; ${storyBit}`
  })

  lines.push(
    'Notes: duplicate Seer talk can be dealt Seer + Robber-who-became-Seer (normal). Dealt Mason + Robber→Mason is normal — count role claims, not "became Mason" as an extra Mason claim.',
    'Villager / Hunter claims need NO night story — do not ask them what they peeked, robbed, or swapped. Press role-count conflicts or incomplete Seer/Robber/Troublemaker stories instead.',
    'A named peek ("I saw X as Y") or named center roles counts as a complete night story. Vague "I peeked center" without roles is incomplete — ask which cards / what roles.',
    'A Robber who named target + stolen role has a complete night story — do not re-ask what the stolen card "looked like."',
    'Night stories are first-person only (I swapped / I peeked / I robbed). Accusations that someone else swapped or peeked are NOT that player\'s night story — do not treat them as board facts.',
  )
  return [...header, ...lines].join('\n')
}

/**
 * Global public board from table chat only — no per-agent planned claims.
 * Pass this (same inputs) to every agent so the board stays identical.
 */
export function buildGlobalPublicClaimBoard(args: {
  players: PlayerPublic[]
  chatLines: ChatLine[]
}): { entries: ClaimLedgerEntry[]; stories: SpokenNightStory[]; text: string } {
  const entries = buildClaimLedger({
    players: args.players,
    chatLines: args.chatLines,
  })
  const stories = buildSpokenNightStories(args.chatLines, args.players)
  // Night stories without an explicit role claim still count on the board.
  for (const story of stories) {
    const entry = entries.find((e) => e.playerId === story.speakerId)
    if (!entry || entry.claim) continue
    if (story.kind === 'seer-player' || story.kind === 'seer-center') {
      entry.claim = 'Seer'
      entry.source = 'chat'
      entry.evidence = story.evidence
    } else if (story.kind === 'robber') {
      entry.claim = 'Robber'
      entry.source = 'chat'
      entry.evidence = story.evidence
    } else if (story.kind === 'troublemaker') {
      entry.claim = 'Troublemaker'
      entry.source = 'chat'
      entry.evidence = story.evidence
    }
  }
  return {
    entries,
    stories,
    text: formatPublicClaimBoard(entries, stories),
  }
}

/** First-person Robber night story that names this seat as the rob target. */
export function spokenRobberStoryTargeting(
  stories: SpokenNightStory[],
  targetId: ClientId,
): Extract<SpokenNightStory, { kind: 'robber' }> | null {
  for (const story of stories) {
    if (story.kind === 'robber' && story.targetId === targetId) return story
  }
  return null
}

/** One-line pressure summary from recent chat. */
export function formatTablePressure(
  chatLines: ChatLine[],
  players: PlayerPublic[],
): string {
  const recent = chatLines.slice(-8)
  if (recent.length === 0) return '(no table talk yet)'
  const accused = new Map<string, number>()
  for (const line of recent) {
    const lower = line.text.toLowerCase()
    for (const p of players) {
      if (p.id === line.fromId) continue
      if (!lower.includes(p.name.toLowerCase())) continue
      if (
        /\b(wolf|werewolf|sus|suspicious|lie|lying|vote|kill)\b/i.test(lower)
      ) {
        accused.set(p.name, (accused.get(p.name) ?? 0) + 1)
      }
    }
  }
  const heat = [...accused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([n, c]) => `${n}×${c}`)
  const last = recent[recent.length - 1]
  const lastBit = last
    ? `Latest: ${last.name}: "${last.text.slice(0, 120)}"`
    : ''
  const heatBit = heat.length ? `Heat: ${heat.join(', ')}.` : 'No clear heat.'
  return `${heatBit} ${lastBit}`.trim()
}
