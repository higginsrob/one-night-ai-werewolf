import { ROLE_INFO, roleName } from '../../game/roles'
import {
  myDealtRole,
  myKnownNowRole,
  playersWithDealtRole,
} from '../../game/werewolfLogic'
import type { WerewolfRole, WerewolfSnapshot } from '../../game/werewolfTypes'
import type { ClientId } from '../../session/types'
import type { LegalAction } from './privateView'
import { formatRoleDeckHand, rolesInPlayLabels } from './claimLedger'

export type WinTeam = 'village' | 'werewolf' | 'neutral' | 'unknown'

/** Win team from private info (dealt + known-now after rob). */
export function winTeamFromPrivate(
  game: WerewolfSnapshot,
  selfId: ClientId,
): WinTeam {
  const known = myKnownNowRole(game, selfId)
  const dealt = myDealtRole(game, selfId)
  const role = known ?? dealt
  if (!role) return 'unknown'
  const team = ROLE_INFO[role].team
  if (team === 'werewolf') return 'werewolf'
  if (team === 'neutral') return 'neutral'
  return 'village'
}

/** Player ids the Seer peeked as werewolf (night player peek only). */
export function seerPeekedWolfIds(
  game: WerewolfSnapshot,
  selfId: ClientId,
): ClientId[] {
  if (myDealtRole(game, selfId) !== 'seer') return []
  const seer = game.nightActions.seer
  if (!seer || seer.playerId !== selfId) return []
  if (seer.view.kind !== 'player') return []
  if (seer.view.role !== 'werewolf') return []
  return [seer.view.targetId]
}

/** Names for seerPeekedWolfIds. */
export function seerPeekedWolfNames(
  game: WerewolfSnapshot,
  selfId: ClientId,
): string[] {
  return seerPeekedWolfIds(game, selfId).map(
    (id) => game.playerNames[id] ?? id,
  )
}

/** Known packmates / wolf allies this werewolf-team seat must not vote. */
export function knownWolfAllyIds(
  game: WerewolfSnapshot,
  selfId: ClientId,
): ClientId[] {
  const team = winTeamFromPrivate(game, selfId)
  if (team !== 'werewolf') return []

  const dealt = myDealtRole(game, selfId)
  const allies = new Set<ClientId>()

  if (dealt === 'werewolf' || dealt === 'minion') {
    for (const id of playersWithDealtRole(game, 'werewolf')) {
      if (id !== selfId) allies.add(id)
    }
  }

  // Robber who became WW: the victim is now village (has robber card) — not an ally.
  // Do not protect the robbed player. Protect other dealt wolves if any.
  if (dealt === 'robber') {
    const known = myKnownNowRole(game, selfId)
    if (known === 'werewolf') {
      // Lone converted wolf — no pack from night vision unless minion knowledge N/A
    }
  }

  return [...allies]
}

/** Display names for knownWolfAllyIds. */
export function knownWolfAllyNames(
  game: WerewolfSnapshot,
  selfId: ClientId,
): string[] {
  return knownWolfAllyIds(game, selfId).map(
    (id) => game.playerNames[id] ?? id,
  )
}

/**
 * Spoken line that pressures a known wolf ally (Minion/WW packmate) —
 * e.g. "vote Sloane", "Sloane is the wolf".
 */
export function replyAccusesWolfAlly(
  text: string,
  allyNames: string[],
): string | null {
  if (!text?.trim() || allyNames.length === 0) return null
  const t = text.replace(/[\u2018\u2019]/g, "'")
  for (const name of allyNames) {
    const n = name.trim()
    if (n.length < 2) continue
    const reName = new RegExp(
      `\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
      'i',
    )
    if (!reName.test(t)) continue
    if (
      /\b(?:vote|kill|eliminate|lynch)\b.{0,40}/i.test(t) ||
      /\b(?:wolf|werewolf|minion|guilty|hiding|threat|sus(?:picious)?)\b/i.test(
        t,
      ) ||
      new RegExp(
        `\\b(?:vote|kill|eliminate)\\s+${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
        'i',
      ).test(t) ||
      new RegExp(
        `\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b.{0,40}\\b(?:wolf|werewolf|minion|guilty|hiding|threat)\\b`,
        'i',
      ).test(t)
    ) {
      return n
    }
  }
  return null
}

const VILLAGE_FORBIDDEN_NOTE =
  /\b(packmate|pack\s*mate|fellow\s+werewolf|fellow\s+wolf|my\s+wolf|our\s+pack|werewolf\s+myself|claimed\s+werewolf\s+myself|as\s+a\s+(?:claimed\s+)?werewolf\s+myself|protect(?:ing)?\s+(?:my\s+)?pack)\b/i

const WEREWOLF_FORBIDDEN_NOTE =
  /\b(hunt\s+werewolves|find\s+the\s+wolf|as\s+village|for\s+the\s+village)\b/i

/** True if vote/action notes contradict the seat's win team. */
export function notesViolateTeam(
  notes: string | null | undefined,
  winTeam: WinTeam,
): boolean {
  if (!notes?.trim()) return false
  if (winTeam === 'village' && VILLAGE_FORBIDDEN_NOTE.test(notes)) return true
  if (winTeam === 'werewolf' && WEREWOLF_FORBIDDEN_NOTE.test(notes)) return true
  return false
}

/** True if spoken reply claims wolf-team identity while village-aligned. */
export function replyViolatesVillageTeam(text: string): boolean {
  return replyConfessesOwnWerewolf(text) || /\bmy\s+packmate\b/i.test(text)
}

/**
 * First-person wolf/minion confession (spoken). Used to block village seats
 * from claiming wolf, and werewolf-team seats from volunteering suicide claims.
 */
export function replyConfessesOwnWerewolf(text: string): boolean {
  if (!text?.trim()) return false
  const t = text.replace(/[\u2018\u2019']/g, "'")
  return (
    // "I'm a werewolf" / "I am the wolf" — not "read Sam as a wolf"
    /\bi(?:'m| am)\s+(?:a\s+|the\s+)?(?:werewolf|wolf|minion)\b/i.test(t) ||
    // Self-ID framing: "As a werewolf, I ..." (require trailing first person)
    /\bas\s+(?:a\s+|the\s+)?(?:werewolf|wolf|minion)\b,?\s+i\b/i.test(t) ||
    // "I'm currently playing as a Werewolf" / "I woke up as the wolf"
    /\bi(?:'m|\s+am)\b.{0,40}\b(?:playing\s+as|became)\b.{0,30}\b(?:a\s+|the\s+)?(?:werewolf|wolf|minion)\b/i.test(
      t,
    ) ||
    /\bi\s+woke\s+(?:up\s+)?as\b.{0,30}\b(?:a\s+|the\s+)?(?:werewolf|wolf|minion)\b/i.test(
      t,
    ) ||
    // "I ... holding the Wolf card" / "I woke up holding the Wolf card"
    /\bi\b.{0,50}\b(?:holding|hold)\s+(?:the\s+)?(?:wolf|werewolf)\s+card\b/i.test(
      t,
    ) ||
    /\bi\s+woke\s+up\s+holding\b.{0,30}\b(?:wolf|werewolf)\b/i.test(t) ||
    // First-person confess/admit only (avoid "he's confessing he's the wolf")
    /\bi\b.{0,20}\b(?:confess(?:ing|ed)?|admitt(?:ing|ed))\b.{0,40}\b(?:(?:i(?:'m|\s+am)|to\s+being|as)\s+)?(?:a\s+|the\s+)?(?:werewolf|wolf|minion)\b/i.test(
      t,
    )
  )
}

/**
 * Preferred public cover claim for werewolf-team seats (never Werewolf/Minion).
 * Robber→WW should usually soft-claim Robber and lie about the stolen role.
 */
export function preferredWerewolfCoverClaim(
  dealt: WerewolfRole | null | undefined,
  rolesInPlay: string[],
): string | null {
  if (dealt === 'robber' && rolesInPlay.includes('Robber')) return 'Robber'
  if (dealt === 'drunk' && rolesInPlay.includes('Drunk')) return 'Drunk'
  if (dealt === 'insomniac' && rolesInPlay.includes('Insomniac')) {
    return 'Insomniac'
  }
  if (rolesInPlay.includes('Villager')) return 'Villager'
  if (rolesInPlay.includes('Hunter')) return 'Hunter'
  if (rolesInPlay.includes('Insomniac')) return 'Insomniac'
  const banned = new Set(['Werewolf', 'Minion', 'Tanner'])
  return rolesInPlay.find((r) => !banned.has(r)) ?? null
}

/**
 * First-person Tanner confession. Tanner wins by dying, but naming Tanner
 * out loud is too on-the-nose — they should bait votes with shaky lies instead.
 */
export function replyConfessesOwnTanner(text: string): boolean {
  if (!text?.trim()) return false
  const t = text.replace(/[\u2018\u2019']/g, "'")
  return (
    // "I'm the Tanner" — not "mark him as a tanner"
    /\bi(?:'m| am)\s+(?:a\s+|the\s+)?tanner\b/i.test(t) ||
    /\bas\s+(?:a\s+|the\s+)?tanner\b,?\s+i\b/i.test(t) ||
    /\bi(?:'m|\s+am)\b.{0,40}\b(?:playing\s+as|became|claiming)\b.{0,30}\b(?:a\s+|the\s+)?tanner\b/i.test(
      t,
    ) ||
    /\bi\s+(?:was|woke\s+(?:up\s+)?as)\b.{0,30}\b(?:a\s+|the\s+)?tanner\b/i.test(
      t,
    ) ||
    /\bi\b.{0,20}\b(?:confess(?:ing|ed)?|admitt(?:ing|ed))\b.{0,40}\b(?:a\s+|the\s+)?tanner\b/i.test(
      t,
    ) ||
    /\bplease\s+(?:vote|kill|eliminate)\s+me\b.{0,40}\btanner\b/i.test(t) ||
    /\bi\s+win\s+if\s+i\s+die\b/i.test(t)
  )
}

/**
 * Cover claim for Tanner: a village-looking role they can botch slightly.
 * Never Tanner itself — that is too direct.
 */
export function preferredTannerCoverClaim(rolesInPlay: string[]): string | null {
  // Prefer bland or mid claims they can tell inconsistently.
  if (rolesInPlay.includes('Villager')) return 'Villager'
  if (rolesInPlay.includes('Hunter')) return 'Hunter'
  if (rolesInPlay.includes('Insomniac')) return 'Insomniac'
  if (rolesInPlay.includes('Drunk')) return 'Drunk'
  const banned = new Set(['Tanner', 'Werewolf', 'Minion'])
  return rolesInPlay.find((r) => !banned.has(r)) ?? null
}

const ROLE_LABELS = (Object.keys(ROLE_INFO) as WerewolfRole[]).map((r) =>
  roleName(r),
)

/** Role labels that exist in ONUW but not this round's deck. */
export function rolesNotInPlay(game: WerewolfSnapshot): string[] {
  const inPlay = new Set(rolesInPlayLabels(game).map((l) => l.toLowerCase()))
  return ROLE_LABELS.filter((l) => !inPlay.has(l.toLowerCase()))
}

/**
 * Soft-scrub invented out-of-deck role names from free text
 * (e.g. Tanner theory when Tanner is not in play).
 */
export function stripOutOfDeckRoles(
  text: string,
  notInPlay: string[],
): string {
  if (!text || notInPlay.length === 0) return text
  let out = text
  for (const role of notInPlay) {
    const re = new RegExp(`\\b${escapeRegExp(role)}\\b`, 'gi')
    out = out.replace(re, 'someone')
  }
  // Clean doubled hedges after replacement
  out = out.replace(/\bsomeone\s+someone\b/gi, 'someone')
  return out
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * If Seer peeked a living WW among legal vote targets, return that action index.
 */
export function preferSeerWolfVote(
  legal: LegalAction[],
  peekedWolfIds: ClientId[],
): number | null {
  if (peekedWolfIds.length === 0) return null
  const want = new Set(peekedWolfIds)
  for (let i = 0; i < legal.length; i++) {
    const a = legal[i]!
    if (a.type === 'werewolf.vote' && want.has(a.targetId)) return i
  }
  return null
}

/** Prefer a specific vote target among legal actions. */
export function preferVoteTarget(
  legal: LegalAction[],
  targetId: ClientId | null | undefined,
): number | null {
  if (!targetId) return null
  for (let i = 0; i < legal.length; i++) {
    const a = legal[i]!
    if (a.type === 'werewolf.vote' && a.targetId === targetId) return i
  }
  return null
}

/**
 * Player ids strongly indicated as night-time werewolves from day chat
 * (Seer peeks naming a wolf, or first-person wolf confessions).
 */
export function nightWolfSuspectIdsFromChat(
  game: WerewolfSnapshot,
  chatLines: Array<{ fromId: ClientId; text: string }>,
): ClientId[] {
  const found = new Set<ClientId>()
  const players = game.playerIds.map((id) => ({
    id,
    name: game.playerNames[id] ?? id,
  }))

  for (const line of chatLines) {
    const text = line.text
    if (!text?.trim()) continue

    // First-person confession from the speaker ("I was the wolf", "I'm a werewolf").
    // Do NOT use bare \bi(?:...)? — that matches the "i" in "if".
    if (
      /\bi(?:'m|\s+am)\b.{0,40}\b(?:a\s+|the\s+)?(?:werewolf|wolf)\b/i.test(
        text,
      ) ||
      /\bi\s+(?:definitely\s+)?was\b.{0,40}\b(?:a\s+|the\s+)?(?:werewolf|wolf)\b/i.test(
        text,
      ) ||
      /\bi\s+woke\s+(?:up\s+)?as\b.{0,40}\b(?:a\s+|the\s+)?(?:werewolf|wolf)\b/i.test(
        text,
      )
    ) {
      if (game.playerIds.includes(line.fromId)) found.add(line.fromId)
    }

    for (const p of players) {
      if (p.id === line.fromId) continue
      const name = escapeRegExp(p.name)
      const others = players
        .filter((o) => o.id !== p.id)
        .map((o) => o.name)

      // Seer-style peek language.
      const peekHit =
        new RegExp(
          `\\b(?:looked\\s+at|peeked(?:\\s+at)?|saw|checked)\\b[^.!?]{0,80}\\b${name}\\b[^.!?]{0,50}\\b(?:werewolf|wolf)\\b`,
          'i',
        ).test(text) ||
        new RegExp(
          `\\b(?:looked\\s+at|peeked(?:\\s+at)?|saw|checked)\\b[^.!?]{0,50}\\b(?:werewolf|wolf)\\b[^.!?]{0,40}\\b${name}\\b`,
          'i',
        ).test(text)

      // "Rob was the wolf" (tight).
      const wasWolf = new RegExp(
        `\\b${name}\\b\\s+was\\s+(?:the\\s+|a\\s+)?(?:werewolf|wolf)\\b`,
        'i',
      ).test(text)

      // "Rob ... admitted ... wolf" — reject if another player name sits between.
      let admittedWolf = false
      const adm = new RegExp(
        `\\b${name}\\b([\\s\\S]{0,50}?)\\b(?:admitted|confessed)\\b[\\s\\S]{0,40}?\\b(?:werewolf|wolf)\\b`,
        'i',
      ).exec(text)
      if (adm) {
        const between = adm[1] ?? ''
        admittedWolf = !others.some((o) =>
          new RegExp(`\\b${escapeRegExp(o)}\\b`, 'i').test(between),
        )
      }

      if (peekHit || wasWolf || admittedWolf) found.add(p.id)
    }
  }

  return [...found]
}

/**
 * Spoken Troublemaker claim that names both swap targets (from any speaker).
 * Returns [a,b] player ids when both names appear with a swap/switch verb.
 */
export function claimedTroublemakerSwapPairFromChat(
  game: WerewolfSnapshot,
  chatLines: Array<{ fromId: ClientId; text: string }>,
): [ClientId, ClientId] | null {
  const players = game.playerIds.map((id) => ({
    id,
    name: game.playerNames[id] ?? id,
  }))

  for (const line of chatLines) {
    if (!/\b(?:swapped|switched|shuffle(?:d)?)\b/i.test(line.text)) continue
    const hit: ClientId[] = []
    for (const p of players) {
      const re = new RegExp(`\\b${escapeRegExp(p.name)}\\b`, 'i')
      if (re.test(line.text)) hit.push(p.id)
    }
    // Prefer two others; TM says "I swapped Rob and Rain" → Rob+Rain.
    const others = [...new Set(hit)].filter((id) => id !== line.fromId)
    if (others.length >= 2) return [others[0]!, others[1]!]
    const uniq = [...new Set(hit)]
    if (uniq.length >= 2) return [uniq[0]!, uniq[1]!]
  }
  return null
}

/**
 * Real Troublemaker: if chat places a night wolf on one swap target, return the
 * other target (where the wolf card should be now).
 */
export function troublemakerMovedWolfTarget(
  game: WerewolfSnapshot,
  selfId: ClientId,
  chatLines: Array<{ fromId: ClientId; text: string }>,
): ClientId | null {
  if (myDealtRole(game, selfId) !== 'troublemaker') return null
  const tm = game.nightActions.troublemaker
  if (!tm || tm.playerId !== selfId) return null

  const nightWolves = new Set(nightWolfSuspectIdsFromChat(game, chatLines))
  const aIs = nightWolves.has(tm.a)
  const bIs = nightWolves.has(tm.b)
  if (aIs && !bIs) return tm.b
  if (bIs && !aIs) return tm.a
  return null
}

/**
 * Seer who peeked a wolf: if table talk establishes a Troublemaker swapped that
 * seat with someone else, return where the wolf card should be now.
 * Returns null when no trusted swap redirect applies (keep voting the peek).
 * Returns selfId when the Seer themselves received the wolf card (cannot self-vote).
 */
export function seerWolfVoteAfterClaimedSwap(
  game: WerewolfSnapshot,
  _selfId: ClientId,
  peekedWolfIds: ClientId[],
  chatLines: Array<{ fromId: ClientId; text: string }>,
): ClientId | null {
  if (peekedWolfIds.length === 0) return null
  const pair = claimedTroublemakerSwapPairFromChat(game, chatLines)
  if (!pair) return null

  const [a, b] = pair
  for (const wolfId of peekedWolfIds) {
    if (wolfId === a) return b
    if (wolfId === b) return a
  }
  return null
}

/** Drop vote targets that are known wolf allies for werewolf-team seats. */
export function filterOutAllyVotes(
  legal: LegalAction[],
  allyIds: ClientId[],
): LegalAction[] {
  if (allyIds.length === 0) return legal
  const ban = new Set(allyIds)
  const filtered = legal.filter(
    (a) => !(a.type === 'werewolf.vote' && ban.has(a.targetId)),
  )
  // Keep non-vote actions; if filtering emptied all votes, fall back to original.
  const hadVote = legal.some((a) => a.type === 'werewolf.vote')
  const stillHasVote = filtered.some((a) => a.type === 'werewolf.vote')
  if (hadVote && !stillHasVote) return legal
  return filtered.length > 0 ? filtered : legal
}

/** Current vote counts (optionally excluding one voter, e.g. self). */
export function voteTallies(
  game: WerewolfSnapshot,
  excludeVoterId?: ClientId | null,
): Map<ClientId, number> {
  const tallies = new Map<ClientId, number>()
  for (const id of game.playerIds) tallies.set(id, 0)
  for (const [voterId, targetId] of Object.entries(game.votes)) {
    if (excludeVoterId && voterId === excludeVoterId) continue
    if (!targetId || !tallies.has(targetId)) continue
    tallies.set(targetId, (tallies.get(targetId) ?? 0) + 1)
  }
  return tallies
}

/** Human-readable vote tallies for the vote prompt. */
export function formatVoteTallies(
  game: WerewolfSnapshot,
  selfId: ClientId,
): string {
  const tallies = voteTallies(game, selfId)
  const myVote = game.votes[selfId]
  const myTarget =
    myVote == null
      ? null
      : game.playerNames[myVote] ?? myVote
  const lines = game.playerIds.map((id) => {
    const name = game.playerNames[id] ?? id
    const n = tallies.get(id) ?? 0
    const you = id === selfId ? ' (you — not a legal target)' : ''
    return `- ${name}: ${n}${you}`
  })
  const header = myTarget
    ? `Current votes so far (your vote for ${myTarget} excluded from tallies):`
    : 'Current votes so far (your vote not cast yet):'
  return [header, ...lines].join('\n')
}

/**
 * Among legal votes, prefer a target with the fewest votes (0 when possible)
 * so village can execute a no-kill spread instead of piling on.
 * When avoidPileOn, never stack onto a unique vote leader if a lower seat exists.
 */
export function preferVillageSpreadVote(
  legal: LegalAction[],
  tallies: Map<ClientId, number>,
  opts?: { avoidPileOn?: boolean },
): number | null {
  const votes = legal
    .map((a, i) => ({ a, i }))
    .filter((x): x is { a: Extract<LegalAction, { type: 'werewolf.vote' }>; i: number } =>
      x.a.type === 'werewolf.vote',
    )
  if (votes.length === 0) return null

  let pool = votes
  if (opts?.avoidPileOn) {
    const zero = pool.filter((x) => (tallies.get(x.a.targetId) ?? 0) === 0)
    if (zero.length > 0) {
      pool = zero
    } else {
      const counts = pool.map((x) => tallies.get(x.a.targetId) ?? 0)
      const max = Math.max(...counts)
      const leaders = pool.filter(
        (x) => (tallies.get(x.a.targetId) ?? 0) === max,
      )
      const nonLeaders = pool.filter(
        (x) => (tallies.get(x.a.targetId) ?? 0) < max,
      )
      // Unique leader already — do not pile on; spread to a lower seat.
      if (leaders.length === 1 && nonLeaders.length > 0) {
        pool = nonLeaders
      }
    }
  }

  let bestIdx: number | null = null
  let bestCount = Number.POSITIVE_INFINITY
  for (const { a, i } of pool) {
    const n = tallies.get(a.targetId) ?? 0
    if (n < bestCount) {
      bestCount = n
      bestIdx = i
    }
  }
  return bestIdx
}

/**
 * Minion with no seated wolves: force a kill — pile onto the current vote leader
 * (or any seated player) so village cannot win on a no-kill.
 */
export function preferForceKillVote(
  legal: LegalAction[],
  tallies: Map<ClientId, number>,
): number | null {
  let bestIdx: number | null = null
  let bestCount = -1
  for (let i = 0; i < legal.length; i++) {
    const a = legal[i]!
    if (a.type !== 'werewolf.vote') continue
    const n = tallies.get(a.targetId) ?? 0
    if (n > bestCount) {
      bestCount = n
      bestIdx = i
    }
  }
  return bestIdx
}

/** Model notes that invent a skip / no-kill / 1-each spread instead of a real vote. */
export function notesWantVoteSpread(notes: string | null | undefined): boolean {
  if (!notes?.trim()) return false
  return /\b(?:1[\s-]?each|one[\s-]?each|spread|no[\s-]?kill|nobody\s+dies|prevent\s+anyone\s+from\s+dying|no\s+one\s+dies|skip(?:ping)?(?:\s+the\s+vote)?|decline\s+to\s+vote|without\s+voting)\b/i.test(
    notes,
  )
}

/** Short cheat sheet always injected at vote time. */
export function voteWinConditionCheatSheet(
  rolesInPlay: string[],
  game?: WerewolfSnapshot | null,
): string {
  const tannerIn = rolesInPlay.some((r) => r.toLowerCase() === 'tanner')
  return [
    'Win-condition cheat sheet:',
    '- Claiming wolf ≠ already won; village must still kill a seated werewolf.',
    '- Village: if you have a solid wolf from YOUR private info, concentrate votes there.',
    '- Village: if a Troublemaker swapped a night-wolf seat, vote the OTHER swap target (the card moved) — do not keep voting the original peeked seat.',
    '- Village: if private info + claims account for the info roles and you have NO solid wolf, prefer a 1-each vote spread so nobody dies (center-wolf no-kill). Nobody dies when no player has more than one vote.',
    '- There is NO skip / no-kill action index — you must pick a listed player. To spread, vote someone who currently has 0 votes (see tallies). Never invent an index outside the list.',
    '- Village: when claims already fill the seats, do NOT invent a wolf suspect to pile onto, and do NOT clear/unvote — keep the 1-each spread. Never stack onto a unique vote leader.',
    '- Village: dealt Mason + Robber→Mason is normal deck math — do not treat it as three Mason claims or a reason to kill.',
    '- Village: a first-person Robber story naming YOU is compatible with your night info (you would not feel a rob). Do not pile onto them for "no swap felt" / "card stayed".',
    '- Village: do not pile onto the loudest bluffer just for aggression.',
    '- Werewolf team: do not vote packmates / known wolves.',
    '- Minion with no seated wolves: village wins only on a no-kill — FORCE a kill (concentrate votes). Do NOT spread 1-each.',
    tannerIn
      ? '- Tanner is in play: they win if they die (village also wins if a WW dies too).'
      : '- Tanner is NOT in this round — do not invent Tanner theories.',
    game
      ? `Cards in this hand (with counts): ${formatRoleDeckHand(game)}`
      : `Roles in play: ${rolesInPlay.join(', ')}`,
  ].join('\n')
}

/**
 * First-person ownership of a Troublemaker swap naming both private targets.
 * Mere mention of both names (e.g. accusing someone else of swapping them) is
 * NOT enough — requires "I swapped/switched …".
 */
export function replyOwnsTroublemakerSwap(
  text: string,
  aName: string,
  bName: string,
): boolean {
  if (!text?.trim()) return false
  const t = text.replace(/[\u2018\u2019']/g, "'")
  const a = aName.trim()
  const b = bName.trim()
  if (a.length < 2 || b.length < 2) return false
  if (
    !new RegExp(`\\b${escapeRegExp(a)}\\b`, 'i').test(t) ||
    !new RegExp(`\\b${escapeRegExp(b)}\\b`, 'i').test(t)
  ) {
    return false
  }
  return (
    /\bi\s+(?:swapped|switched|shuffled)\b/i.test(t) ||
    /\bi(?:'m|\s+am)\s+(?:the\s+)?troublemaker\b.{0,80}\b(?:swapped|switched|shuffled|swapping|switching)\b/i.test(
      t,
    )
  )
}

/**
 * First-person Troublemaker-style swap ("I swapped A and B") when this seat is
 * NOT the Troublemaker with a recorded swap — e.g. Seer parroting the TM story.
 */
export function claimsUnownedFirstPersonTroublemakerSwap(
  text: string,
): boolean {
  if (!text?.trim()) return false
  const t = text.replace(/[\u2018\u2019']/g, "'")
  // "I swapped Kim and Ben" / "Alright, I swapped…"
  if (
    /\bi\s+(?:swapped|switched|shuffled)\s+(?:two|2|[A-Z])/i.test(t) ||
    /\bi\s+(?:swapped|switched|shuffled)\s+[\p{L}'-]+\s+and\b/iu.test(t)
  ) {
    return true
  }
  // Owning "my swap story" without being TM.
  if (/\bmy\s+swap\s+story\b/i.test(t)) {
    return true
  }
  return false
}

/**
 * Spoken reply that is only a cast-vote sentence (system already posts those).
 */
export function replyIsBareVoteCast(text: string): boolean {
  if (!text?.trim()) return false
  const t = text.replace(/[\u2018\u2019']/g, "'").trim()
  // Whole reply is one or more "I vote for X." lines.
  if (
    /^(?:i\s+vote\s+for\s+[\p{L}'-]+[.!?]?\s*)+$/iu.test(t) ||
    /^(?:i(?:'m|\s+am)\s+voting\s+for\s+[\p{L}'-]+[.!?]?\s*)+$/iu.test(t) ||
    /^vote\s+[\p{L}'-]+[.!?]?$/iu.test(t)
  ) {
    return true
  }
  return false
}

/**
 * Aftergame: thanking / giving props to a proper name that is not seated
 * (e.g. "props to Rob" when Rob was never at the table).
 */
export function thanksNonSeatedPlayer(
  text: string,
  seatedNames: string[],
): string | null {
  if (!text?.trim() || seatedNames.length === 0) return null
  const t = text.replace(/[\u2018\u2019']/g, "'")
  const allowed = new Set(
    seatedNames.map((n) => n.trim().toLowerCase()).filter((n) => n.length >= 2),
  )
  // Common phantom hosts from training data / developer names.
  const propsHit =
    /\b(?:props|credit|thanks?|thank\s+you|shout[\s-]?out|appreciate)\b.{0,40}\bto\s+([A-Z][\p{L}'-]+)\b/iu.exec(
      t,
    ) ||
    /\bgive\s+props\s+to\s+([A-Z][\p{L}'-]+)\b/iu.exec(t)
  if (propsHit?.[1]) {
    const who = propsHit[1]
    if (!allowed.has(who.toLowerCase()) && who.toLowerCase() !== 'narrator') {
      return who
    }
  }
  return null
}

/**
 * Real Troublemaker speech that attributes THEIR swap to someone else, or names
 * a wrong swap pair (not the two private-info targets).
 */
export function troublemakerMisattributesOwnSwap(
  text: string,
  aName: string,
  bName: string,
  otherPlayerNames: string[],
): boolean {
  if (!text?.trim()) return false
  const t = text.replace(/[\u2018\u2019']/g, "'")
  const a = aName.trim().toLowerCase()
  const b = bName.trim().toLowerCase()
  const correct = new Set([a, b])
  const swapVerb =
    '(?:swapped|switched|shuffled|swapping|switching|shuffling)'

  // "you swapped X with Y" / "calling you … for swapping me" directed at another seat.
  if (new RegExp(`\\byou\\s+${swapVerb}\\b`, 'i').test(t)) {
    return true
  }
  if (
    new RegExp(
      `\\b(?:calling\\s+you|blame\\s+you|you(?:'re|\\s+are)).{0,50}\\bfor\\s+${swapVerb}\\b`,
      'i',
    ).test(t)
  ) {
    return true
  }

  for (const name of otherPlayerNames) {
    const n = name.trim()
    if (n.length < 2) continue
    const re = escapeRegExp(n)
    // "Boz swapped Ben with Kim" / "Ben … for swapping me" — third-person.
    if (
      new RegExp(`\\b${re}\\b.{0,50}\\b${swapVerb}\\b`, 'i').test(t) &&
      !/\bi\s+(?:swapped|switched|shuffled)\b/i.test(t)
    ) {
      return true
    }
  }

  // Names appearing as swap *objects* near the verb (not vocatives earlier).
  const objectHit = t.match(
    new RegExp(`\\b${swapVerb}\\b(.{0,60})`, 'i'),
  )
  if (objectHit?.[1]) {
    const window = objectHit[1]
    const hits: string[] = []
    for (const name of [aName, bName, ...otherPlayerNames]) {
      const n = name.trim()
      if (n.length < 2) continue
      if (new RegExp(`\\b${escapeRegExp(n)}\\b`, 'i').test(window)) {
        hits.push(n.toLowerCase())
      }
    }
    const uniq = [...new Set(hits)]
    if (uniq.length >= 2) {
      const isCorrect =
        uniq.length === 2 &&
        correct.has(uniq[0]!) &&
        correct.has(uniq[1]!)
      if (!isCorrect) return true
    }
  }

  return false
}

/**
 * Spoken line that claims one role then offers/plays a different second role
 * ("I woke Villager… I'll play Mason" / "I'm Villager… I'd claim Seer").
 */
export function offersConflictingSecondRoleClaim(
  text: string,
  rolesInPlay: string[],
): boolean {
  if (!text?.trim() || rolesInPlay.length === 0) return false
  const t = text.replace(/[\u2018\u2019']/g, "'")
  const found: string[] = []
  for (const role of rolesInPlay) {
    const r = escapeRegExp(role)
    if (
      new RegExp(
        `\\bi(?:'m| am|'d| would)?\\s+(?:claim(?:ing)?\\s+)?(?:a\\s+|the\\s+)?${r}\\b|\\bi\\s+woke\\s+(?:up\\s+)?(?:as\\s+)?(?:a\\s+|the\\s+)?${r}\\b|\\bi(?:'ll| will)\\s+play\\s+(?:as\\s+)?(?:a\\s+|the\\s+)?${r}\\b|\\bi(?:'d| would)\\s+claim\\s+${r}\\b`,
        'i',
      ).test(t)
    ) {
      found.push(role.toLowerCase())
    }
  }
  return new Set(found).size >= 2
}

/** Spoken denial that Troublemaker somehow forgot who they swapped. */
export function claimsTroublemakerDoesNotKnowTargets(text: string): boolean {
  return (
    /\b(?:don'?t|do\s+not|didn'?t|cannot|can'?t|won'?t)\s+(?:know|have|remember|tell|give|share|say).{0,50}(?:who|whom|which).{0,40}(?:swap|switch|shuffl)/i.test(
      text,
    ) ||
    /\b(?:information|name)\s+(?:doesn'?t|does\s+not)\s+exist\b/i.test(text) ||
    /\bi\s+didn'?t\s+look\b.{0,80}\b(?:don'?t|do\s+not|cannot|can'?t)\s+know\s+who\b/i.test(
      text,
    ) ||
    /\byou'?d\s+have\s+to\s+ask\b.{0,40}\bif\s+they\s+got\s+shuffled\b/i.test(
      text,
    )
  )
}

/** Claims a Troublemaker swap when none is recorded in private info. */
export function inventsUnrecordedTroublemakerSwap(text: string): boolean {
  const claimsTmAndSwap =
    /\b(?:i(?:'m|\s+am)\s+(?:the\s+)?troublemaker|playing\s+troublemaker)\b/i.test(
      text,
    ) && /\b(?:swapped|switched|shuffle|swapping|switching)\b/i.test(text)
  return (
    claimsTmAndSwap ||
    /\bi\s+(?:swapped|switched)\s+(?:two|2)\b/i.test(text) ||
    /\bi\s+(?:swapped|switched)\s+[A-Z][\p{L}'-]+/iu.test(text)
  )
}

/**
 * First-person fabricated peeks / swaps / "picked up a card" stories.
 * Used when a village seat has no recorded night card action.
 * Insomniac self-checks ("I checked my card") are allowed.
 */
export function inventsFabricatedNightCardStory(text: string): boolean {
  if (!text?.trim()) return false
  const t = text.replace(/[\u2018\u2019]/g, "'")
  if (
    /\bi\s+(?:robbed|stole(?:\s+from)?|swapped\s+with|switched\s+with)\b/i.test(
      t,
    )
  ) {
    return true
  }
  if (/\bi\s+(?:swapped|switched|shuffled)\s+(?:two|2|[A-Z])/i.test(t)) {
    return true
  }
  // "when I swapped" / "after I swapped" without owning a recorded Robber action
  if (
    /\b(?:when|after|before)\s+i\s+(?:swapped|switched|robbed|stole)\b/i.test(t)
  ) {
    return true
  }
  if (/\bi\s+picked\s+up\s+(?:a\s+|the\s+)?[a-z]+\s+card\b/i.test(t)) {
    return true
  }
  if (
    /\bafter\s+(?:swapping|robbing|stealing)\b/i.test(t) &&
    /\b(?:i(?:'m|\s+am)?|i)\b/i.test(t)
  ) {
    return true
  }
  const selfCardCheck =
    /\b(?:checked|looked\s+at|saw)\b[^.!?]{0,40}\b(?:my|own)\s+card\b/i.test(t)
  if (
    !selfCardCheck &&
    /\bi\b[^.!?]{0,80}\b(?:saw|peeked(?:\s+at)?|looked\s+at|checked)\b[^.!?]{0,60}\b(?:as|was)\s+(?:a\s+|the\s+)?(?:werewolf|villager|seer|robber|mason|insomniac|drunk|troublemaker|minion|hunter|tanner)\b/i.test(
      t,
    )
  ) {
    return true
  }
  if (
    /\bi\s+(?:peeked|looked\s+at|checked)\s+(?:the\s+)?(?:center|middle)\b/i.test(
      t,
    )
  ) {
    return true
  }
  return false
}

/**
 * Village-aligned seats with no recorded night card peek/swap must not invent
 * one at the table (collapses role accounting). Werewolves may still lie.
 */
export function villageMustNotInventNightCardStory(
  game: WerewolfSnapshot,
  selfId: ClientId,
): boolean {
  if (winTeamFromPrivate(game, selfId) !== 'village') return false
  const dealt = myDealtRole(game, selfId)
  if (!dealt) return true
  if (dealt === 'seer' && game.nightActions.seer?.playerId === selfId) {
    return false
  }
  if (dealt === 'robber' && game.nightActions.robber?.playerId === selfId) {
    return false
  }
  if (
    dealt === 'troublemaker' &&
    game.nightActions.troublemaker?.playerId === selfId
  ) {
    return false
  }
  if (dealt === 'drunk' && game.nightActions.drunk?.playerId === selfId) {
    return false
  }
  // Insomniac may discuss their own dawn check, but inventsFabricated still
  // blocks invented peeks/robs/swaps of other players.
  if (dealt === 'insomniac') return true
  // Mason may discuss partner visibility — inventsFabricated still blocks fake peeks/swaps.
  return true
}

/**
 * True when private night actions record a swap this seat performed
 * (Robber / Troublemaker / Drunk).
 */
export function seatHasRecordedNightSwap(
  game: WerewolfSnapshot,
  selfId: ClientId,
): boolean {
  const rob = game.nightActions.robber
  if (rob?.playerId === selfId) return true
  const tm = game.nightActions.troublemaker
  if (tm?.playerId === selfId) return true
  const drunk = game.nightActions.drunk
  if (drunk?.playerId === selfId) return true
  return false
}

/**
 * Speech/goals that treat a night swap as established fact
 * ("after the swap", "was your card swapped", "night swap") without owning
 * a recorded personal swap. Callers should also allow first-person TM/Robber
 * swap stories already on the claim board.
 */
export function assumesUnrecordedNightSwap(text: string): boolean {
  if (!text?.trim()) return false
  const t = text.replace(/[\u2018\u2019]/g, "'")
  // First-person owning a swap is handled by inventsFabricated / TM guards.
  // This catches treating "the swap" as table fact / grilling others about it.
  return (
    /\bafter\s+(?:the\s+)?(?:night\s+)?swap\b/i.test(t) ||
    /\bafter\s+last\s+night(?:'s)?\s+swap\b/i.test(t) ||
    /\b(?:got|get|been|was|were)\s+swapped\b/i.test(t) ||
    /\b(?:card|role)\s+(?:got|get|was|were)\s+(?:swapped|moved|switched)\b/i.test(
      t,
    ) ||
    /\bany\s+chance\s+(?:that\s+)?(?:card|role).{0,40}\bswapp/i.test(t) ||
    /\b(?:did|was)\s+(?:any|a)\s+card\s+get\s+swapp/i.test(t) ||
    /\bwho\s+holds\s+the\s+\w+\s+role\b.{0,40}\bswapp/i.test(t) ||
    /\bswapp(?:ed|ing)\s+(?:the\s+)?(?:villager|seer|mason|insomniac)\s+(?:card|seat|role)\b/i.test(
      t,
    ) ||
    /\bwhat\s+(?:role|card)\s+(?:did\s+you\s+end\s+up\s+with|do\s+you\s+have\s+now)\b.{0,40}\bswapp/i.test(
      t,
    ) ||
    /\bwhat\s+(?:role|card).{0,30}\bafter\s+(?:the\s+)?(?:night\s+)?swapp/i.test(
      t,
    )
  )
}

/**
 * Invented first-person contradiction of someone else's Seer peek
 * ("doesn't line up with what I saw") when this seat has no Seer peek of its own.
 */
export function inventsSeerPeekContradiction(text: string): boolean {
  if (!text?.trim()) return false
  const t = text.replace(/[\u2018\u2019]/g, "'")
  return (
    /\b(?:seer(?:'?s)?\s+(?:claim|peek)|peek)\b.{0,60}\b(?:doesn'?t|does\s+not|don'?t|do\s+not|didn'?t|did\s+not)\s+(?:quite\s+)?(?:line\s+up|match|add\s+up|fit|check\s+out)\b/i.test(
      t,
    ) ||
    /\b(?:doesn'?t|does\s+not|don'?t|do\s+not|didn'?t)\s+(?:quite\s+)?(?:line\s+up|match|add\s+up)\b.{0,50}\b(?:what\s+i\s+saw|my\s+(?:peek|night)|seer)\b/i.test(
      t,
    ) ||
    /\b(?:contradict|conflicts?\s+with)\b.{0,40}\b(?:seer|peek|what\s+i\s+saw)\b/i.test(
      t,
    ) ||
    /\b(?:seer|peek)\b.{0,40}\b(?:feel(?:s)?\s+off|suspicious|wrong|fake)\b.{0,40}\b(?:what\s+i\s+saw|i\s+saw)\b/i.test(
      t,
    ) ||
    /\bi\s+saw\b.{0,40}\b(?:seer|peek)\b.{0,30}\b(?:off|wrong|differ)/i.test(t)
  )
}

/**
 * True when this seat has a recorded Seer peek they could use to challenge
 * another night story. Mason / Villager / etc. should not invent "what I saw"
 * contradictions of Seer peeks.
 */
export function seatHasSeerPeekToChallengeWith(
  game: WerewolfSnapshot,
  selfId: ClientId,
): boolean {
  const seer = game.nightActions.seer
  return !!(seer && seer.playerId === selfId)
}

/**
 * Spoken line that re-asks a named player what role they woke as / are,
 * when that name is already on the claim board.
 */
export function spokenReasksClaimedRole(
  text: string,
  claimedNames: Set<string>,
): string | null {
  if (!text?.trim() || claimedNames.size === 0) return null
  const t = text.replace(/[\u2018\u2019']/g, "'")
  for (const name of claimedNames) {
    const n = name.trim()
    if (n.length < 2) continue
    const reName = escapeRegExp(n)
    // "Ben, what did you wake as" / "Ben what role" / "what did you wake as last night? Ben"
    if (
      new RegExp(
        `\\b${reName}\\b[,:]?\\s+(?:what|who'd|who\\s+did).{0,40}\\b(?:wake|woke|role|were\\s+you|are\\s+you|end\\s+up)\\b`,
        'i',
      ).test(t) ||
      new RegExp(
        `\\b(?:ask|what)\\b.{0,30}\\b${reName}\\b.{0,40}\\b(?:wake|woke|role|were\\s+you|are\\s+you)\\b`,
        'i',
      ).test(t) ||
      new RegExp(
        `\\b${reName}\\b.{0,30}\\bwhat\\s+(?:did|were|are|do)\\s+you\\b`,
        'i',
      ).test(t) ||
      new RegExp(
        `\\bwhat\\s+(?:role\\s+)?did\\s+you\\s+wake\\b.{0,60}\\b${reName}\\b`,
        'i',
      ).test(t)
    ) {
      return n
    }
  }
  return null
}

/**
 * Spoken line that re-asks a Robber (or similar) for a stolen-card peek / detail
 * when their complete night story is already on the board.
 */
export function spokenReasksCompleteNightStory(
  text: string,
  nightStoryNames: Set<string>,
): string | null {
  if (!text?.trim() || nightStoryNames.size === 0) return null
  const t = text.replace(/[\u2018\u2019']/g, "'")
  const wantsExtra =
    /\b(?:stolen\s+card|what\s+(?:did|does)\s+(?:that\s+)?(?:stolen\s+)?card\s+look|looked\s+like|actual\s+role\s+you\s+grabbed|what\s+was\s+the\s+actual\s+role|more\s+detail|walk\s+(?:me|us)\s+through|what\s+made\s+you|how\s+do\s+you\s+know)\b/i.test(
      t,
    ) ||
    /\bwhat\s+(?:did|exactly)\s+you\s+(?:see|grab|steal|rob|get)\b/i.test(t)
  if (!wantsExtra) return null
  for (const name of nightStoryNames) {
    const n = name.trim()
    if (n.length < 2) continue
    if (new RegExp(`\\b${escapeRegExp(n)}\\b`, 'i').test(t)) return n
  }
  // Unnamed but clearly grilling the robber story already on the board.
  if (
    /\b(?:stolen\s+card|role\s+you\s+grabbed|what\s+you\s+stole)\b/i.test(t)
  ) {
    return [...nightStoryNames][0] ?? null
  }
  return null
}

/** Belief/vote notes inventing wolf suspicion with no private wolf evidence. */
export function notesInventWolfWithoutEvidence(
  notes: string | null | undefined,
): boolean {
  if (!notes?.trim()) return false
  return /\b(?:suspect\s+as\s+wolf|aim\s+to\s+eliminate|push(?:ing)?\s+to\s+(?:get|eliminate)|misdirecting\s+while\s+protecting)\b/i.test(
    notes,
  )
}

/**
 * False ONUW rule: "Minions don't see / peek at werewolves."
 * Minion wakes and learns which players are werewolves.
 */
export function inventsFalseMinionRules(text: string): boolean {
  // Normalize curly apostrophes from model / STT output.
  const t = text.replace(/[\u2018\u2019]/g, "'")
  return (
    /\bminions?\b.{0,80}\b(?:don'?t|do\s+not|doesn'?t|does\s+not|can'?t|cannot|never)\b.{0,60}\b(?:peek|see|know|look|learn|get).{0,40}\b(?:wol(?:f|ves)|werewol(?:f|ves)|roles?|cards?)\b/i.test(
      t,
    ) ||
    /\bminions?\b.{0,40}\b(?:don'?t|do\s+not|doesn'?t|does\s+not)\s+peek\b/i.test(
      t,
    ) ||
    /\b(?:don'?t|do\s+not|doesn'?t|does\s+not|can'?t|cannot|never)\b.{0,40}\b(?:peek|see|know)\b.{0,40}\bminions?\b/i.test(
      t,
    ) ||
    /\bminions?\s+(?:have\s+)?no\s+(?:night\s+)?(?:info|power|peek|vision)\b/i.test(
      t,
    )
  )
}

/**
 * False ONUW rule: "Robbers don't peek / don't look at the stolen card."
 * Also false: "Robber becoming Seer / getting Seer powers is impossible."
 * Robber swaps then looks at the stolen card — becoming that role is normal.
 */
export function inventsFalseRobberRules(text: string): boolean {
  const t = text.replace(/[\u2018\u2019]/g, "'")
  return (
    /\brobbers?\b.{0,80}\b(?:don'?t|do\s+not|doesn'?t|does\s+not|can'?t|cannot|never)\b.{0,50}\b(?:get\s+to\s+)?(?:peek|see|look|know|learn|check)\b/i.test(
      t,
    ) ||
    /\brobbers?\b.{0,40}\b(?:don'?t|do\s+not|doesn'?t|does\s+not)\s+(?:get\s+to\s+)?peek\b/i.test(
      t,
    ) ||
    /\b(?:don'?t|do\s+not|doesn'?t|does\s+not|can'?t|cannot|never)\b.{0,40}\b(?:peek|see|look)\b.{0,40}\brobbers?\b/i.test(
      t,
    ) ||
    /\brobbers?\s+(?:have\s+)?no\s+(?:night\s+)?(?:peek|look|vision)\b/i.test(t) ||
    /\b(?:impossible|illegal|can'?t\s+be|cannot\s+be)\b.{0,40}(?:seer[\s-]?from[\s-]?robber|robber[\s-]?seer|seer\s+powers?\s+from\s+robb)/i.test(
      t,
    ) ||
    /\brobbers?\b.{0,60}\b(?:don'?t|doesn'?t|do\s+not|does\s+not|can'?t|cannot|never|doesn'?t\s+normally)\b.{0,40}(?:become|get|gain|grant|give)\b.{0,30}(?:seer|powers?)\b/i.test(
      t,
    ) ||
    /\bseer\s+powers?\s+from\s+robb(?:er|ing)\b.{0,80}(?:superpower|impossible|fake|lie|can'?t|cannot|doesn'?t|breathing)\b/i.test(
      t,
    ) ||
    /\b(?:only\s+)?minions?\b.{0,40}\b(?:get|have|do)\b.{0,20}peeks?\b.{0,40}\brobbers?\b/i.test(
      t,
    ) ||
    /\brobbers?\b.{0,40}\bonly\s+minions?\b/i.test(t)
  )
}

/**
 * False epistemology: treating "I didn't feel a swap / my card stayed X" as
 * proof that a Robber story naming you (or anyone) is a lie. Robbed seats do
 * not learn they were robbed — Mason/Villager night info stays compatible.
 */
export function deniesConsistentRobberTargetStory(text: string): boolean {
  const t = text.replace(/[\u2018\u2019']/g, "'")
  if (!t.trim()) return false
  const feltAsProof =
    /\b(?:no\s+swap\s+felt|didn'?t\s+(?:feel|notice)\s+(?:a\s+|any\s+)?(?:swap|rob|change)|never\s+felt\s+(?:a\s+)?(?:swap|rob)|(?:my\s+)?card\s+(?:never|didn'?t|did\s+not)\s+move(?:d)?|(?:my\s+)?card\s+(?:just\s+)?stayed|stayed\s+\w+\s+all\s+night|fixed\s+(?:mason|role))\b/i.test(
      t,
    )
  const dismissesRob =
    /\b(?:robber(?:y)?|rob(?:bed|bing)|fabrication|dodgy|bluff(?:ing)?|lying|busted|fake|holes|contradict(?:s|ed|ing)?)\b/i.test(
      t,
    )
  if (feltAsProof && dismissesRob) return true
  // Vote-note style: "Robber story contradicts my fixed Mason role"
  if (
    /\b(?:robber(?:y)?(?:\s+story)?|robbed)\b.{0,80}\bcontradict/i.test(t) ||
    /\bcontradict(?:s|ed|ing)?\b.{0,60}\b(?:robber(?:y)?|fixed\s+(?:mason|role)|mason\s+role)\b/i.test(
      t,
    )
  ) {
    return true
  }
  return false
}

/**
 * Dealt Robber with a recorded rob: allowed to name the steal + stolen role.
 * Not allowed to invent Seer-style peeks, vague "card looked funny," or
 * looking at someone beyond stating who they robbed / what they became.
 */
export function robberInventedExtraPeek(
  text: string,
  rob: { targetName: string; stolenLabel: string } | null,
): boolean {
  if (!text?.trim() || !rob) return false
  const t = text.replace(/[\u2018\u2019]/g, "'")
  if (
    /\bcard\s+(?:looked|felt|seemed)\s+(?:funny|weird|odd|strange|off)\b/i.test(
      t,
    )
  ) {
    return true
  }
  if (/\bgot\s+lucky\s+with\s+(?:this\s+)?peek\b/i.test(t)) return true
  if (
    /\bi\s+saw\s+something\s+(?:different|weird|funny|odd)\b/i.test(t) ||
    /\bwhen\s+i\s+looked\s+at\b/i.test(t)
  ) {
    return true
  }
  // Seer-style "I peeked X as ROLE" / "I saw X as ROLE" for a role they didn't steal.
  const rolePeek = t.match(
    /\bi\b[^.!?]{0,60}\b(?:saw|peeked(?:\s+at)?|looked\s+at)\b[^.!?]{0,40}\b(?:as|was)\s+(?:a\s+|the\s+)?([a-z]+)\b/i,
  )
  if (rolePeek?.[1]) {
    const claimed = rolePeek[1].toLowerCase()
    const stolen = rob.stolenLabel.toLowerCase()
    if (claimed !== stolen && claimed !== 'robber') {
      return true
    }
  }
  // "I peeked X" without also owning the rob/became in the same breath.
  const peekedSomeone =
    /\bi\s+(?:peeked|looked\s+at)\s+[A-Z][\p{L}'-]+/iu.test(t) ||
    /\bi\s+peeked\b/i.test(t)
  if (peekedSomeone) {
    const ownsRob =
      /\b(?:robbed|stole|stolen|became|got)\b/i.test(t) &&
      new RegExp(escapeRegExp(rob.targetName), 'i').test(t)
    if (!ownsRob) return true
  }
  return false
}

/**
 * Hostile / demeaning table talk — retry. Light teasing is OK; insults are not.
 */
export function replyIsHostile(text: string): boolean {
  if (!text?.trim()) return false
  const t = text.replace(/[\u2018\u2019]/g, "'")
  return (
    /\b(?:you\s+idiots?|you\s+morons?|you\s+losers?|shut\s+up|pathetic|stupid|dumbass|asshole|piece\s+of\s+shit)\b/i.test(
      t,
    ) ||
    /\b(?:stop\s+whining|don'?t\s+whine|whine\s+about)\b/i.test(t) ||
    /\b(?:you(?:'re| are)\s+just\s+(?:being\s+)?(?:pathetic|stupid|garbage))\b/i.test(
      t,
    )
  )
}

/**
 * Prejudice / bigotry in spoken replies — retry.
 * Keeps detection coarse so in-game werewolf "kill/vote" talk is not flagged.
 */
export function replyIsPrejudiced(text: string): boolean {
  if (!text?.trim()) return false
  const t = text.replace(/[\u2018\u2019]/g, "'")
  return (
    /\b(?:racist|sexist|homophobic|transphobic|antisemitic|islamophobic)\b/i.test(
      t,
    ) ||
    /\b(?:all\s+(?:black|white|asian|mexican|jewish|muslim|gay|trans)\s+people\s+are)\b/i.test(
      t,
    ) ||
    /\b(?:go\s+back\s+to\s+your\s+country|hate\s+(?:immigrants|minorities))\b/i.test(
      t,
    )
  )
}

/**
 * Real-world harm outside board-game vote fiction — retry.
 */
export function replyThreatensRealHarm(text: string): boolean {
  if (!text?.trim()) return false
  const t = text.replace(/[\u2018\u2019]/g, "'")
  return (
    /\b(?:kill\s+yourself|kys|self[\s-]?harm|commit\s+suicide)\b/i.test(t) ||
    /\b(?:i(?:'ll| will)\s+(?:hurt|harm|attack|murder|stab|shoot)\s+you)\b/i.test(
      t,
    ) ||
    /\b(?:hurt|harm|attack|murder)\s+(?:you|someone)\s+(?:in\s+real\s+life|irl|outside\s+the\s+game)\b/i.test(
      t,
    )
  )
}

/**
 * Off-topic real-world expertise (coding / law / medical / finance) — retry.
 */
export function replyOffersOffTopicAdvice(text: string): boolean {
  if (!text?.trim()) return false
  const t = text.replace(/[\u2018\u2019]/g, "'")
  return (
    /\b(?:here(?:'s| is)\s+(?:some\s+)?(?:code|a\s+function|a\s+script)|```|npm\s+install|def\s+\w+\(|function\s+\w+\s*\()\b/i.test(
      t,
    ) ||
    /\b(?:as\s+your\s+lawyer|legal\s+advice|consult\s+an?\s+attorney|sue\s+them|file\s+a\s+lawsuit)\b/i.test(
      t,
    ) ||
    /\b(?:medical\s+advice|see\s+a\s+doctor|take\s+(?:this\s+)?(?:medication|antibiotics|ibuprofen)|diagnos(?:e|is))\b/i.test(
      t,
    ) ||
    /\b(?:invest\s+in|stock\s+tip|financial\s+advice|crypto\s+advice)\b/i.test(t)
  )
}

/** Human is asking which players the Troublemaker swapped. */
export function humanAskedSwapTargets(transcript: string): boolean {
  return (
    /\b(?:who|which)\b.{0,40}\b(?:switch|swapped|swap|shuffl)/i.test(
      transcript,
    ) ||
    /\b(?:switched|swapped|swap)\s+me\s+with\b/i.test(transcript) ||
    /\bwho\s+you\s+(?:switched|swapped)\b/i.test(transcript) ||
    /\bwhich\s+player\s+you\s+(?:switched|swapped)\b/i.test(transcript) ||
    /\bdid\s+you\s+(?:switch|swap|shuffl)\b/i.test(transcript) ||
    /\b(?:switch|swapped|swap)\s+anyone\b/i.test(transcript) ||
    /\bwho\s+(?:did\s+you|were\s+you)\s+(?:switch|swap)/i.test(transcript)
  )
}
