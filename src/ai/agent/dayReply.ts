import type { SessionSnapshot } from '../../net/protocol'
import type { ClientId } from '../../session/types'
import { isOmniVoiceEndpoint } from '../../game/ttsStore'
import { aiTableName, type AiPlayerProfile } from '../aiPlayers'
import { loadAiStore } from '../aiStore'
import { chatWithConfig } from '../client'
import { aiJobQueue } from '../queue'
import type { AiModelConfig, AiProvider, ChatMessage } from '../types'
import {
  buildGlobalPublicClaimBoard,
  extractClaimFromText,
  formatTablePressure,
  formatRoleDeckHand,
  boardHasSpokenSwapStory,
  rolesInPlayLabels,
  spokenClaimsAccountForVillageSeats,
  spokenRobberStoryTargeting,
  lockedSpokenClaimForPlayer,
  overclaimedRoles,
  isInfoClaimRole,
  namesWithCompleteNightStory,
  incompleteNightStories,
  type SpokenNightStory,
} from './claimLedger'
import { formatDayPlan, planDayReply, type DayPlan } from './dayPlan'
import {
  formatDayClockNote,
  formatRecentChatForAgent,
} from './chatTime'
import { gameKeyOf } from './gameKey'
import { formatTablePlayerBios } from './tableBios'
import {
  assumesUnrecordedNightSwap,
  claimsTroublemakerDoesNotKnowTargets,
  claimsUnownedFirstPersonTroublemakerSwap,
  humanAskedSwapTargets,
  deniesConsistentRobberTargetStory,
  inventsFalseMinionRules,
  inventsFalseRobberRules,
  inventsFabricatedNightCardStory,
  inventsSeerPeekContradiction,
  inventsUnrecordedTroublemakerSwap,
  knownWolfAllyNames,
  offersConflictingSecondRoleClaim,
  replyAccusesWolfAlly,
  replyConfessesOwnTanner,
  replyConfessesOwnWerewolf,
  replyIsBareVoteCast,
  replyIsHostile,
  replyIsPrejudiced,
  replyOffersOffTopicAdvice,
  replyOwnsTroublemakerSwap,
  replyThreatensRealHarm,
  replyViolatesVillageTeam,
  robberInventedExtraPeek,
  rolesNotInPlay,
  seatHasRecordedNightSwap,
  seatHasSeerPeekToChallengeWith,
  spokenReasksClaimedRole,
  spokenReasksCompleteNightStory,
  stripOutOfDeckRoles,
  thanksNonSeatedPlayer,
  troublemakerMisattributesOwnSwap,
  villageMustNotInventNightCardStory,
  winTeamFromPrivate,
} from './guardrails'
import {
  appendAgentChat,
  appendReplyTrace,
  ensureDayObservation,
  formatKnowledgeBase,
  getAgentMemory,
  pruneStaleNoClaimNotes,
  resolvePlayerIdByName,
  setLastPlan,
  updateBelief,
} from './memory'
import { ROLE_INFO, roleName } from '../../game/roles'
import { myDealtRole, playerWon } from '../../game/werewolfLogic'
import {
  buildHardFacts,
  buildPrivateObservation,
  robberNightResult,
  seerNightPeek,
  troublemakerSwapPair,
} from './privateView'
import {
  addressesSelfByName,
  capSentences,
  confessesRobWhileClaimingSeer,
  extractSpokenReply,
  isNearDuplicate,
  normalizeSpoken,
  splitSentences,
  stripSelfSpeakerLabel,
  stripStageAndThoughts,
} from './spokenText'
import {
  DAY_RULES,
  LOBBY_RULES,
  RESULT_RULES,
  WATCH_DAY_RULES,
  teamStrategyForSeat,
} from './teamStrategy'

export {
  DAY_RULES,
  LOBBY_RULES,
  RESULT_RULES,
  ROLE_RULES_REFERENCE,
  SAFETY_GUARDRAILS,
  WATCH_DAY_RULES,
} from './teamStrategy'
export { extractSpokenReply } from './spokenText'

function formatPublicResultSummary(
  game: NonNullable<SessionSnapshot['game']>,
  players: SessionSnapshot['players'],
  npcId: ClientId,
): string {
  const nameOf = (id: string) =>
    players.find((p) => p.id === id)?.name ?? game.playerNames[id] ?? 'Someone'
  const rolesLine = game.playerIds
    .map((id) => {
      const role = game.roles[id]
      const label = role ? roleName(role) : '?'
      const team = role ? ROLE_INFO[role].team : '?'
      return `${nameOf(id)}: ${label} (${team})`
    })
    .join('; ')
  const dead = [
    ...game.killedIds,
    ...(game.hunterKillId ? [game.hunterKillId] : []),
  ]
  const deadLine =
    dead.length === 0
      ? 'Nobody died.'
      : `Dead: ${dead.map(nameOf).join(', ')}.`
  const won = playerWon(game, npcId)
  const myRole = game.roles[npcId]
  const myBit = myRole
    ? `You were ${roleName(myRole)} (${ROLE_INFO[myRole].team}).`
    : ''
  const outcomeBit =
    won == null
      ? 'Outcome not finalized yet (reveal / night replay in progress).'
      : won
        ? 'You WON this round.'
        : 'You LOST this round.'
  const winMsg = game.winMessage?.trim() || '(no win message yet)'
  return [
    `Public result: ${winMsg}`,
    deadLine,
    `Final roles: ${rolesLine}`,
    myBit,
    outcomeBit,
  ]
    .filter(Boolean)
    .join('\n')
}

function lastAssistantTexts(
  gameKey: string,
  npcId: ClientId,
  limit = 4,
): string[] {
  const chat = getAgentMemory(gameKey, npcId).chat
  const out: string[] = []
  for (let i = chat.length - 1; i >= 0 && out.length < limit; i--) {
    const m = chat[i]
    if (m?.role === 'assistant' && m.content.trim()) out.push(m.content.trim())
  }
  return out
}

function recentTableAgentLines(
  snapshot: SessionSnapshot,
  npcId: ClientId,
): string[] {
  // Long lookback so verbatim parroting of earlier table lines still gets caught.
  return (snapshot.chatLines ?? [])
    .filter((l) => l.via === 'agent' && l.fromId !== npcId)
    .slice(-24)
    .map((l) => l.text)
}

function echoesForbidden(
  text: string,
  forbidden: string[],
): string | null {
  for (const f of forbidden) {
    if (f.trim() && isNearDuplicate(text, f)) return f
  }
  return null
}

/** Drop sentences that parrot recent table lines; keep any fresh remainder. */
function stripEchoedSentences(
  text: string,
  forbidden: string[],
): string | null {
  const parts = splitSentences(text)
  if (parts.length <= 1) return null
  const kept = parts.filter(
    (s) => !forbidden.some((f) => f.trim() && isNearDuplicate(s, f)),
  )
  if (kept.length === 0 || kept.length === parts.length) return null
  return capSentences(kept.join(' '), 3)
}

/**
 * Deterministic spoken stub when the model reply fails guardrails.
 * Avoids looping on "who still needs a night story?" (Villagers don't).
 */
function buildGuardrailFallback(args: {
  reason: string
  claim: string | null | undefined
  suspects: string[]
  playful: boolean
  incomplete: SpokenNightStory[]
  surplus: Array<{ role: string; names: string[] }>
  avoid: string[]
}): string {
  const claim = args.claim?.trim() || null
  const claimBit = claim ? ` I'm the ${claim}.` : ''
  const claimLead = claim ? `I'm the ${claim}. ` : ''
  const suspect = args.suspects.find((n) => n.trim())?.trim() ?? null
  const incomplete = args.incomplete[0]
  const surplus = args.surplus[0]

  const candidates: string[] = []
  if (incomplete) {
    if (incomplete.kind === 'seer-center') {
      candidates.push(
        `${claimLead}${incomplete.speakerName}, which center roles did you see?`.trim(),
      )
    } else if (incomplete.kind === 'robber') {
      candidates.push(
        `${claimLead}${incomplete.speakerName}, what role did you steal?`.trim(),
      )
    }
  }
  if (surplus) {
    const who = surplus.names.slice(0, 2).join(' and ')
    candidates.push(
      `${claimLead}Deck only has room for one ${surplus.role} — ${who}, whose claim holds?`.trim(),
    )
  }
  if (suspect) {
    candidates.push(
      args.playful
        ? `Alright ${suspect}, walk me through your read — I'm not buying silence.${claimBit}`.trim()
        : `${claimLead}${suspect}, how does your claim sit with the board?`.trim(),
    )
  }
  candidates.push(
    args.playful
      ? `Fair — keep the claims honest.${claimBit}`.trim()
      : `${claimLead}Let's do role accounting on what's already on the board.`.trim(),
  )
  candidates.push(
    args.playful
      ? `Okay — who's next with a shaky claim?${claimBit}`.trim()
      : `${claimLead}Who still has no role claim on the board?`.trim(),
  )

  if (args.reason.startsWith('reask-claim:')) {
    const who = args.reason.slice('reask-claim:'.length)
    candidates.unshift(
      claim
        ? `${who}'s claim is already on the board — I'm the ${claim}. Let's press role counts instead.`
        : `${who}'s claim is already on the board. Let's press role counts instead.`,
    )
  } else if (args.reason.startsWith('reask-night:')) {
    const who = args.reason.slice('reask-night:'.length)
    candidates.unshift(
      claim
        ? `${who} already gave their night story — I'm the ${claim}. Let's do role accounting.`
        : `${who} already gave their night story. Let's do role accounting.`,
    )
  } else if (args.reason === 'dual-claim') {
    candidates.unshift(
      claim ? `I woke as ${claim}.` : `Let's stick to one claim each.`,
    )
  }

  for (const c of candidates) {
    if (!c.trim()) continue
    if (args.avoid.some((a) => a.trim() && isNearDuplicate(c, a))) continue
    return c
  }
  return claim ? `I'm the ${claim}.` : `Let's keep checking claims.`
}

function applyBeliefUpdates(
  gameKey: string,
  npcId: ClientId,
  players: SessionSnapshot['players'],
  updates: Array<{ aboutName: string; notes: string }>,
): void {
  for (const u of updates) {
    const aboutId = resolvePlayerIdByName(players, u.aboutName)
    if (!aboutId || aboutId === npcId) continue
    updateBelief(gameKey, npcId, aboutId, u.notes)
  }
}

function humanAskedForRole(transcript: string, selfName: string): boolean {
  const t = transcript.toLowerCase()
  if (
    /\bwhat (were|are) you\b|\bwhat you were\b|\bwhat you are\b|\byour role\b|\bwhat'?s your role\b|\bwho (were|are) you\b|\bwhat do you claim\b|\bsaid what you were\b|\btell me what you\b|\bwhat were you before\b/i.test(
      t,
    )
  ) {
    return true
  }
  return (
    t.includes(selfName.toLowerCase()) &&
    /\bwhat\b|\bsay\b|\bclaim\b|\brole\b|\bwere you\b|\byou were\b/i.test(t)
  )
}

function replyStatesClaim(text: string, claim: string): boolean {
  const nText = normalizeSpoken(text)
  const nClaim = normalizeSpoken(claim)
  if (!nClaim) return true
  if (nText.includes(nClaim)) return true
  // "villager" vs "I'm a villager"
  const bare = nClaim.replace(/^the /, '')
  return bare.length >= 4 && nText.includes(bare)
}

function hasClaimedAtTable(
  snapshot: SessionSnapshot,
  npcId: ClientId,
  claim: string,
): boolean {
  return (snapshot.chatLines ?? []).some(
    (l) => l.fromId === npcId && replyStatesClaim(l.text, claim),
  )
}

function spokenClaimForSelfIsSeer(
  snapshot: SessionSnapshot,
  npcId: ClientId,
): boolean {
  return hasClaimedAtTable(snapshot, npcId, 'Seer')
}

function enforceClaimInReply(
  text: string,
  plan: DayPlan | null,
  profile: AiPlayerProfile,
  humanTranscript: string,
  snapshot: SessionSnapshot,
  npcId: ClientId,
): string {
  const claim = plan?.claim?.trim()
  if (!claim) return text
  const existingClaim = extractClaimFromText(text)
  if (existingClaim) return text
  const hasNightVerb =
    /\bi\s+(?:saw|peeked|checked|looked\s+at|robbed|stole|swapped\s+with|switched)\b/i.test(
      text,
    )
  // Sharing a Seer peek without naming Seer still needs the Seer claim spliced in.
  // Other night verbs already state a role story — don't chop in a contradictory cover.
  if (hasNightVerb && claim.toLowerCase() !== 'seer') return text
  const need =
    humanAskedForRole(humanTranscript, aiTableName(profile)) ||
    (Boolean(profile.nickname.trim()) &&
      humanAskedForRole(humanTranscript, profile.nickname.trim())) ||
    !hasClaimedAtTable(snapshot, npcId, claim) ||
    (claim.toLowerCase() === 'seer' && hasNightVerb)
  if (!need || replyStatesClaim(text, claim)) return text
  // Prefer first-person "I'm the X" — avoid "I'd claim" stacking with another role.
  const addon = `I'm the ${claim}.`
  // Reserve a sentence slot so capSentences cannot drop the claim.
  const head = capSentences(text, 2)
  return capSentences(`${head} ${addon}`.trim(), 3)
}

/** When claiming Seer, force naming the private peek at least once. */
function enforceSeerPeekInReply(
  text: string,
  peek:
    | { kind: 'player'; targetName: string; roleLabel: string }
    | { kind: 'center'; label: string }
    | null,
  opts?: { claim?: string | null; forceShare?: boolean },
): string {
  if (!peek) return text
  const claimingSeer =
    (opts?.claim ?? '').toLowerCase() === 'seer' ||
    /\bi(?:'m| am)\s+(?:the\s+)?seer\b/i.test(text)
  if (!claimingSeer && !opts?.forceShare) return text
  if (peek.kind === 'player') {
    const n = normalizeSpoken(text)
    const hasTarget = n.includes(normalizeSpoken(peek.targetName))
    const hasRole = n.includes(normalizeSpoken(peek.roleLabel))
    if (hasTarget && hasRole) return text
    if (
      hasTarget &&
      /\b(?:saw|peeked|looked\s+at|checked)\b/i.test(text) &&
      hasRole
    ) {
      return text
    }
    const addon = `I peeked ${peek.targetName} as ${peek.roleLabel}.`
    return capSentences(`${capSentences(text, 2)} ${addon}`.trim(), 3)
  }
  if (/\bcenter\b/i.test(text) && /\b(?:saw|peeked|looked)\b/i.test(text)) {
    return text
  }
  const addon = `I peeked ${peek.label}.`
  return capSentences(`${capSentences(text, 2)} ${addon}`.trim(), 3)
}

function salvageSpokenFromRaw(raw: string): string {
  const light = capSentences(stripStageAndThoughts(raw), 3).slice(0, 400)
  if (light.trim()) return light
  // Last resort: drop only obvious stage wrappers, keep the rest.
  return capSentences(
    raw
      .replace(/^\*+[^*]+\*+\s*/g, '')
      .replace(/\([^)]{0,80}\)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    3,
  ).slice(0, 400)
}

function replySharesSeerPeek(
  text: string,
  peek:
    | { kind: 'player'; targetName: string; roleLabel: string }
    | { kind: 'center'; label: string },
): boolean {
  const n = normalizeSpoken(text)
  if (peek.kind === 'player') {
    return (
      n.includes(normalizeSpoken(peek.targetName)) &&
      n.includes(normalizeSpoken(peek.roleLabel)) &&
      /\b(?:saw|peeked|looked\s+at|checked)\b/i.test(text)
    )
  }
  return /\bcenter\b/i.test(text) && /\b(?:saw|peeked|looked)\b/i.test(text)
}

function replySharesRobberStory(
  text: string,
  rob: { targetName: string; stolenLabel: string },
): boolean {
  const n = normalizeSpoken(text)
  const hasTarget = n.includes(normalizeSpoken(rob.targetName))
  if (!hasTarget) return false
  const hasStolen = n.includes(normalizeSpoken(rob.stolenLabel))
  const ownsRob =
    /\bi\s+(?:robbed|stole(?:\s+from)?|swapped\s+with|took|grabbed)\b/i.test(
      text,
    ) ||
    /\bi\s+(?:grabbed|got)\s+(?:a\s+|the\s+)?[a-z]+\s+from\b/i.test(text) ||
    (hasStolen &&
      /\bi\s+(?:ended\s+up\s+as|became|got|grabbed)\b/i.test(text))
  if (!ownsRob) return false
  // Stolen role is preferred but not required if they clearly named the rob target.
  return hasStolen || /\b(?:became|got|stole|took|grabbed|ended\s+up)\b/i.test(text)
}

/** When claiming Robber, force naming rob target + stolen role at least once. */
function enforceRobberNightStoryInReply(
  text: string,
  rob: { targetName: string; stolenLabel: string } | null,
  opts?: { claim?: string | null; forceShare?: boolean },
): string {
  if (!rob) return text
  const claimingRobber =
    (opts?.claim ?? '').toLowerCase() === 'robber' ||
    /\bi(?:'m| am)\s+(?:the\s+)?robber\b/i.test(text)
  if (!claimingRobber && !opts?.forceShare) return text
  if (replySharesRobberStory(text, rob)) return text
  const addon = `I robbed ${rob.targetName} and became ${rob.stolenLabel}.`
  return capSentences(`${capSentences(text, 2)} ${addon}`.trim(), 3)
}

/** When asked who you swapped, or when claiming Troublemaker, force the two private-info names. */
function enforceTroublemakerSwapAnswer(
  text: string,
  humanTranscript: string,
  aName: string,
  bName: string,
  opts?: {
    claim?: string | null
    forceShare?: boolean
    otherPlayerNames?: string[]
  },
): string {
  const asked = humanAskedSwapTargets(humanTranscript)
  const claimingTm =
    (opts?.claim ?? '').toLowerCase() === 'troublemaker' ||
    /\bi(?:'m| am)\s+(?:the\s+)?troublemaker\b/i.test(text) ||
    /\bi(?:'d| would)\s+claim\s+troublemaker\b/i.test(text)
  if (!asked && !claimingTm && !opts?.forceShare) return text
  const others = opts?.otherPlayerNames ?? []
  // Wrong pair / "you swapped" — replace with a clean first-person story.
  if (troublemakerMisattributesOwnSwap(text, aName, bName, others)) {
    const claimBit =
      claimingTm || (opts?.claim ?? '').toLowerCase() === 'troublemaker'
        ? `I'm the Troublemaker. `
        : ''
    return `${claimBit}I swapped ${aName} and ${bName} — I didn't see the roles.`.trim()
  }
  if (replyOwnsTroublemakerSwap(text, aName, bName)) return text
  const addon = `I swapped ${aName} and ${bName} — I didn't see the roles.`
  return capSentences(`${capSentences(text, 2)} ${addon}`.trim(), 3)
}

/** Drop "I'll play X" / extra "I'd claim Y" when a different role is already stated. */
function scrubConflictingSecondClaim(
  text: string,
  planClaim: string | null | undefined,
  rolesInPlay: string[],
): string {
  if (!offersConflictingSecondRoleClaim(text, rolesInPlay)) return text
  const claim = planClaim?.trim()
  // Prefer keeping the planned/first claim; drop "I'll play …" / trailing "I'd claim …".
  let out = text
    .replace(
      /\s*,?\s*(?:but\s+)?(?:sure\s+thing[—\-–,]?\s*)?i(?:'ll| will)\s+play\s+(?:as\s+)?(?:a\s+|the\s+)?[a-z]+(?:\s+if\b[^.!?]*)?[.!?]?/gi,
      ' ',
    )
    .replace(
      /\s*i(?:'d| would)\s+claim\s+[a-z]+\.?/gi,
      (m) => {
        if (
          claim &&
          new RegExp(`claim\\s+${escapeRegExpClaim(claim)}`, 'i').test(m)
        ) {
          return m
        }
        return ' '
      },
    )
    .replace(/\s+/g, ' ')
    .trim()
  if (claim && !replyStatesClaim(out, claim) && replyStatesClaim(text, claim)) {
    // Scrub may have wiped the claim — restore a single clean one.
    out = capSentences(`${out} I'm the ${claim}.`.trim(), 3)
  }
  if (offersConflictingSecondRoleClaim(out, rolesInPlay) && claim) {
    return `I woke as ${claim}.`
  }
  return out
}

function escapeRegExpClaim(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function speakOnce(args: {
  provider: AiProvider
  config: AiModelConfig
  system: string
  history: ChatMessage[]
  user: string
}): Promise<string> {
  const result = await aiJobQueue.enqueue(() =>
    chatWithConfig(args.provider, args.config, [
      { role: 'system', content: args.system },
      ...args.history,
      { role: 'user', content: args.user },
    ]),
  )
  return result.text
}

function resolveHumanSpeaker(
  snapshot: SessionSnapshot,
  humanFromId?: ClientId | null,
): { id: ClientId; name: string } | null {
  if (humanFromId) {
    const p = snapshot.players.find((x) => x.id === humanFromId)
    if (p) return { id: p.id, name: p.name }
  }
  // Legacy fallback — only safe when a single human is seated.
  const humans = snapshot.players.filter((p) => !p.isNpc)
  if (humans.length === 1) {
    const only = humans[0]!
    return { id: only.id, name: only.name }
  }
  return null
}

async function generateReply(args: {
  snapshot: SessionSnapshot
  npcId: ClientId
  profile: AiPlayerProfile
  humanTranscript: string
  /** Who spoke the human line — required with 2+ humans so beliefs/prompts stay attributed. */
  humanFromId?: ClientId | null
  mode: 'day' | 'lobby' | 'result'
  responders?: ClientId[]
  /** Lines already spoken this turn by other NPCs (anti-echo). */
  avoidTexts?: string[]
  /** Accumulated reply callback once the full cleaned text is ready (not token streaming). */
  onPartial?: (accumulated: string) => void
  /** Proactive aftergame line (no human utterance). */
  proactive?: boolean
}): Promise<string> {
  const {
    snapshot,
    npcId,
    profile,
    humanTranscript,
    humanFromId = null,
    mode,
    responders = [npcId],
    avoidTexts = [],
    onPartial,
    proactive = false,
  } = args
  const store = loadAiStore()
  const config = store.modelConfigs.find((c) => c.id === store.activeWorkConfigId)
  const provider = config
    ? store.providers.find((p) => p.id === config.providerId)
    : null
  if (!config || !provider) throw new Error('Work model not configured')

  const gKey = gameKeyOf(snapshot)
  const mem = getAgentMemory(gKey, npcId)
  const started = Date.now()
  const speaker = proactive ? null : resolveHumanSpeaker(snapshot, humanFromId)
  const speakerName = speaker?.name ?? 'a human'
  const recentChat = formatRecentChatForAgent(snapshot.chatLines ?? [], 12)
  const roster = snapshot.players
    .filter((p) => p.connected)
    .map((p) => p.name)
    .join(', ')

  let planRaw: string | null = null
  let planModelId: string | null = null
  let privateObservation: string | null = null
  let plan: DayPlan | null = mem.lastPlan

  const forbidden = [
    ...avoidTexts,
    ...recentTableAgentLines(snapshot, npcId),
    ...lastAssistantTexts(gKey, npcId, 4),
  ]

  const rules =
    mode === 'lobby'
      ? LOBBY_RULES
      : mode === 'result'
        ? RESULT_RULES
        : snapshot.watchMode
          ? `${DAY_RULES}\n\n${WATCH_DAY_RULES}`
          : DAY_RULES
  const systemParts = [
    `You are ${aiTableName(profile)}${
      profile.nickname.trim() &&
      profile.nickname.trim().toLowerCase() !== aiTableName(profile).toLowerCase()
        ? ` (goes by ${profile.nickname.trim()})`
        : ''
    }.`,
    `PERSONA (match this voice closely): ${profile.persona}`,
    formatTablePlayerBios(snapshot.players, npcId),
    rules,
  ]

  let dayGame: NonNullable<SessionSnapshot['game']> | null = null
  let dayWinTeam: ReturnType<typeof winTeamFromPrivate> = 'unknown'
  let dayClaimedNames = new Set<string>()
  let dayNightStoryNames = new Set<string>()
  let dayBoardHasSwap = false
  let dayWolfAllyNames: string[] = []
  let dayRobTargetStory: ReturnType<typeof spokenRobberStoryTargeting> = null
  let dayIncompleteStories: SpokenNightStory[] = []
  let daySurplus: Array<{ role: string; names: string[] }> = []

  if (mode === 'day') {
    const game = snapshot.game
    if (!game) throw new Error('No game')
    dayGame = game
    dayWinTeam = winTeamFromPrivate(game, npcId)
    dayWolfAllyNames = knownWolfAllyNames(game, npcId)
    privateObservation = buildPrivateObservation(game, snapshot.players, npcId)
    ensureDayObservation(gKey, npcId, privateObservation)
    const tablePlayers = snapshot.players.filter((p) =>
      game.playerIds.includes(p.id),
    )
    const publicBoard = buildGlobalPublicClaimBoard({
      players: tablePlayers,
      chatLines: snapshot.chatLines ?? [],
    })
    dayClaimedNames = new Set(
      publicBoard.entries.filter((e) => e.claim).map((e) => e.playerName),
    )
    dayNightStoryNames = namesWithCompleteNightStory(publicBoard.stories)
    dayBoardHasSwap = boardHasSpokenSwapStory(publicBoard.stories)
    dayRobTargetStory = spokenRobberStoryTargeting(publicBoard.stories, npcId)
    dayIncompleteStories = incompleteNightStories(publicBoard.stories)
    daySurplus = overclaimedRoles(game, publicBoard.entries).map((s) => ({
      role: s.role,
      names: s.names,
    }))
    pruneStaleNoClaimNotes(gKey, npcId, snapshot.players, dayClaimedNames)
    const inPlay = rolesInPlayLabels(game)
    const notInPlay = rolesNotInPlay(game)

    const planned = await planDayReply({
      snapshot,
      npcId,
      profile,
      humanTranscript,
      humanFromId: speaker?.id ?? null,
      gameKey: gKey,
      proactive,
    })
    plan = planned.plan
    setLastPlan(gKey, npcId, planned.plan)
    applyBeliefUpdates(gKey, npcId, snapshot.players, planned.plan.beliefUpdates)
    planRaw = planned.raw
    planModelId = planned.modelId

    const hardFacts = buildHardFacts(game, snapshot.players, npcId)
    const tmPair = troublemakerSwapPair(game, snapshot.players, npcId)
    const clockNote = formatDayClockNote(game)
    systemParts.push(
      'Private info:',
      privateObservation,
      'Team strategy:',
      teamStrategyForSeat(game, npcId),
      `Cards in this hand (public, with counts): ${formatRoleDeckHand(game)}`,
      `Roles you may claim (unique labels): ${inPlay.join(', ')}`,
    )
    if (hardFacts.length) {
      systemParts.push('Hard facts (do not contradict):', hardFacts.join('\n'))
    }
    if (notInPlay.length) {
      systemParts.push(
        `Roles NOT in play (do not invent): ${notInPlay.join(', ')}`,
      )
    }
    systemParts.push(
      publicBoard.text,
      'Table pressure:',
      formatTablePressure(snapshot.chatLines ?? [], tablePlayers),
    )
    if (
      dayWinTeam === 'village' &&
      spokenClaimsAccountForVillageSeats(game, publicBoard.entries)
    ) {
      systemParts.push(
        'Role accounting tip: spoken claims currently account for the player seats with village roles and you have no solid private wolf — prefer pitching a no-kill / 1-each vote spread (both wolves may be in the center).',
      )
    }
    if (dayRobTargetStory) {
      const stole = dayRobTargetStory.stolenRole
        ? ` and became ${dayRobTargetStory.stolenRole}`
        : ''
      systemParts.push(
        `${dayRobTargetStory.speakerName} claims they robbed YOU${stole}. That is compatible with your night info — you would not feel or know a rob. Do NOT argue "no swap felt" / "my card stayed" as proof they are lying.`,
      )
    }
    const surplus = overclaimedRoles(game, publicBoard.entries)
    if (dayWinTeam === 'village' && surplus.length > 0) {
      const top = surplus[0]!
      const who = top.names.slice(0, 3).join(', ')
      systemParts.push(
        `Deck-count conflict: ${top.deck}× ${top.role} in hand but ${top.claimed} claims (${who}). Calmly press the surplus — do not hostile pile-on.`,
      )
    }
    const incomplete = incompleteNightStories(publicBoard.stories)
    if (dayWinTeam === 'village' && incomplete.length > 0) {
      const bits = incomplete.map((s) => {
        if (s.kind === 'seer-center') {
          return `${s.speakerName}'s Seer center peek (roles unnamed)`
        }
        if (s.kind === 'robber') {
          return `${s.speakerName}'s Robber story (stolen role unnamed)`
        }
        return `${s.speakerName}'s night story`
      })
      systemParts.push(
        `Incomplete night stories on the board — ask for the missing detail: ${bits.join('; ')}.`,
      )
    }
    if (!dayBoardHasSwap && !seatHasRecordedNightSwap(game, npcId)) {
      systemParts.push(
        'No first-person Robber/Troublemaker swap is on the claim board (and you did not swap) — do not ask about "after the swap" or whether cards moved.',
      )
    }
    if (clockNote) systemParts.push(clockNote)
    systemParts.push(
      'Your private plan for this line (follow it; do not read it aloud):',
      formatDayPlan(planned.plan, speaker?.name),
    )
    if (planned.plan.claim) {
      systemParts.push(
        `If asked your role — or you have not claimed yet — state your claim as ${planned.plan.claim} in your spoken reply.`,
      )
    }
    systemParts.push(
      snapshot.watchMode
        ? proactive
          ? 'Spoken tone (watch mode): volunteer the next beat — interview by name, probe a gap, accuse or misdirect for your team, pitch a vote read, or land a short joke. Keep the table moving.'
          : 'Spoken tone (watch mode): answer the latest line first, then advance — counter, recruit, accuse, bluff, or joke. Prefer naming someone with a follow-up question.'
        : proactive
          ? 'Spoken tone: you are volunteering a line to the table — pick a useful question or statement from recent chat and private info. Hold private suspects internally. Soft doubt only for real claim conflicts or solid private night info — one light poke max.'
          : 'Spoken tone: answer the latest line first. Hold private suspects internally. Do not accuse someone of being a werewolf (or "acting sus") just because they corrected a fact, mentioned time, greeted, or asked a question. Soft doubt only for real claim conflicts or solid private night info — one light poke max. If the private goal sounds accusatory but their line was ordinary table talk, follow the cooperative answer instead of the suspicion.',
      'You may ask another player a short question by name (human or AI) when interviewing — that invites them to answer next.',
    )
    if (tmPair && humanAskedSwapTargets(humanTranscript)) {
      systemParts.push(
        `They asked who you swapped. Answer with both names: ${tmPair.aName} and ${tmPair.bName}. Do not say you don't know who.`,
      )
    } else if (tmPair && planned.plan.claim?.toLowerCase() === 'troublemaker') {
      systemParts.push(
        `You are claiming Troublemaker — open with YOUR first-person night story: "I swapped ${tmPair.aName} and ${tmPair.bName}." Never accuse another player of doing your swap, and never invent different targets.`,
      )
    } else if (tmPair && myDealtRole(game, npcId) === 'troublemaker') {
      const tmShared = (snapshot.chatLines ?? []).some(
        (l) =>
          l.fromId === npcId &&
          replyOwnsTroublemakerSwap(l.text, tmPair.aName, tmPair.bName),
      )
      if (!tmShared) {
        systemParts.push(
          `You are the Troublemaker — volunteer now: "I swapped ${tmPair.aName} and ${tmPair.bName}." Do not attribute that swap to anyone else.`,
        )
      }
    }
    const seerPeek = seerNightPeek(game, snapshot.players, npcId)
    if (seerPeek && planned.plan.claim?.toLowerCase() === 'seer') {
      const alreadyShared = (snapshot.chatLines ?? []).some(
        (l) => l.fromId === npcId && replySharesSeerPeek(l.text, seerPeek),
      )
      if (!alreadyShared) {
        systemParts.push(
          seerPeek.kind === 'player'
            ? `You are claiming Seer — name your peek in this reply: you saw ${seerPeek.targetName} as ${seerPeek.roleLabel}.`
            : `You are claiming Seer — name your center peek in this reply: ${seerPeek.label}.`,
        )
      }
    }
    const robResult = robberNightResult(game, snapshot.players, npcId)
    if (robResult) {
      const robShared = (snapshot.chatLines ?? []).some((l) =>
        l.fromId === npcId && replySharesRobberStory(l.text, robResult),
      )
      if (
        !robShared &&
        ((planned.plan.claim ?? '').toLowerCase() === 'robber' ||
          myDealtRole(game, npcId) === 'robber')
      ) {
        systemParts.push(
          `You are claiming Robber — name your night story in this reply: you robbed ${robResult.targetName} and became ${robResult.stolenLabel}.`,
        )
      } else {
        systemParts.push(
          `Robber night ceiling: you may say you robbed ${robResult.targetName} and became ${robResult.stolenLabel}. Do NOT invent a further peek, "card looked funny," or Seer-style look at anyone.`,
        )
      }
    }
  } else if (mode === 'result') {
    const game = snapshot.game
    if (!game) throw new Error('No game')
    dayGame = game
    const seatedNames = snapshot.players
      .filter((p) => p.connected)
      .map((p) => p.name)
    systemParts.push(
      'Public outcome (truth — you may speak freely about it):',
      formatPublicResultSummary(game, snapshot.players, npcId),
      'Players at the table:',
      roster || '(just you)',
      seatedNames.length
        ? `Only thank / address these seated names (plus Narrator if needed): ${seatedNames.join(', ')}. Never invent a host, spectator, or "Rob" / judge who is not listed.`
        : 'Never invent a host or spectator who is not seated.',
    )
    if (snapshot.watchMode) {
      systemParts.push(
        'This was watch / AI-only — there was no human player at the table. Do not thank or address a human host.',
      )
    }
  } else {
    const otherAis = snapshot.players
      .filter((p) => p.connected && p.isNpc && p.id !== npcId)
      .map((p) => p.name)
    const humans = snapshot.players
      .filter((p) => p.connected && !p.isNpc)
      .map((p) => p.name)
    const chatEmpty = !(snapshot.chatLines ?? []).some((l) => l.text.trim())
    systemParts.push(
      'Players at the table:',
      roster || '(just you)',
      otherAis.length
        ? `Other AI players (prefer addressing these by name): ${otherAis.join(', ')}`
        : 'Other AI players: (none seated)',
    )
    if (humans.length) {
      systemParts.push(
        `Human player(s) — do not ask them to speak up: ${humans.join(', ')}`,
      )
    }
    systemParts.push(
      proactive
        ? chatEmpty
          ? 'Spoken tone (lobby, empty chat): introduce One Night Ultimate Werewolf briefly and kick off lobby banter — greet, hype the round, poke another AI by name. Never mention empty history / starting fresh. Never ask the human to speak.'
          : 'Spoken tone (lobby): first react to recent table chat (continue a thread, clap back, or answer), preferring another AI by name. Then add friendly banter if it fits. Never say someone is quiet; never ask the human to speak up. No role/card talk.'
        : 'Spoken tone (lobby): answer the latest line first, then keep banter going with another AI if it fits — not roles/cards, never the "you\'re quiet" bit, never ask the human to speak up. Rules answers stay brief when asked.',
    )
  }

  systemParts.push(
    'Your notes:',
    formatKnowledgeBase(mem, snapshot.players, dayClaimedNames),
    'Recent table chat (bracketed timers are wall-clock day time left when each line was said):',
    recentChat || '(none)',
    'Do NOT copy or paraphrase another player\'s latest lines.',
    `Do NOT address yourself (${aiTableName(profile)}) by name, ask yourself questions, or narrate about yourself in third person (e.g. "${aiTableName(profile)}'s the one…" / "why ${aiTableName(profile)} might be safe") — speak in first person.`,
    'When claiming a role, stick to ONE claim — never also say you will "play" or "claim" a second different role in the same reply.',
    proactive
      ? mode === 'lobby'
        ? recentChat
          ? 'This is a Speak turn — ground your line in Recent table chat above. Prefer addressing another AI. Do not ask the human to speak up.'
          : 'This is a Speak turn with empty chat — open the lobby: introduce the game briefly and kick off banter with another AI. Do not mention empty history or ask the human to speak.'
        : 'This is your own reaction — speak to the table, not as a reply to a specific person.'
      : `Attribute claims and questions only to the player who said them. The latest line is from ${speakerName} — not from any other player.`,
    'Human speech may be imperfect STT — respond to intent, never mock wording quirks.',
    `Stay in persona: ${profile.persona}`,
    'Reply in character as spoken dialogue only — no JSON, no quotes wrapping the whole reply, no stage directions, no thoughts.',
    ...(isOmniVoiceEndpoint()
      ? [
          'Do not write stage directions, bracket tags like [laughter], emotion markup, or leading chuckles/hums — speak plain dialogue only.',
        ]
      : []),
  )

  const system = systemParts.join('\n\n')
  const looksLikeVote =
    /\bi\s+vote\s+for\b|\bi(?:'m| am)\s+casting\s+a\s+no\s+vote\b/i.test(
      humanTranscript,
    )
  const user = proactive
    ? mode === 'result'
      ? `${humanTranscript.trim() || 'The round just ended — react briefly.'}\nSpeak as ${aiTableName(profile)} with 1–3 short spoken sentences. Sound like your persona.`
      : mode === 'lobby'
        ? recentChat
          ? `${humanTranscript.trim() || 'Speak up in lobby chat.'}\nAs ${aiTableName(profile)}, contribute 1–3 short spoken sentences grounded in the recent table chat — react to the latest lines first, preferably addressing another AI. No role/card talk; do not mention anyone being quiet; do not ask the human to speak. Sound like your persona.`
          : `${humanTranscript.trim() || 'Speak up in lobby chat.'}\nAs ${aiTableName(profile)}, the lobby chat is empty — introduce One Night Ultimate Werewolf briefly and kick off banter with another AI by name (1–3 short spoken sentences). Do not mention empty history or starting fresh; do not ask the human to speak. Sound like your persona.`
        : `${humanTranscript.trim() || 'Speak up at the table based on recent chat.'}\nAs ${aiTableName(profile)}, contribute 1–3 short spoken sentences — a question or statement to the group grounded in the recent table chat. Sound like your persona.`
    : looksLikeVote
      ? `${speakerName} just cast a vote: "${humanTranscript.trim()}"\nReact to this vote as ${aiTableName(profile)} with 1–3 short spoken sentences (agree, push back, or note the tally pressure). Do NOT reply with only "I vote for X" — argue the read without parroting the cast-vote line. Sound like your persona.`
      : mode === 'lobby'
        ? `${speakerName} said: "${humanTranscript.trim()}"\nRespond as ${aiTableName(profile)} with 1–3 short spoken sentences that address this line — prefer looping in another AI over asking the human to speak. No role claims, no "you're quiet" jokes. Sound like your persona.`
        : `${speakerName} said: "${humanTranscript.trim()}"\nRespond as ${aiTableName(profile)} with 1–3 short spoken sentences that address this new line from ${speakerName}. Sound like your persona.`
  // Keep short history so the model is less likely to parrot its last turn.
  const history = mem.chat.slice(-4)

  let rawSpeak = await speakOnce({
    provider,
    config,
    system,
    history,
    user,
  })
  let text = extractSpokenReply(rawSpeak)
  if (text) {
    text = stripSelfSpeakerLabel(text, aiTableName(profile))
    if (profile.nickname.trim()) {
      text = stripSelfSpeakerLabel(text, profile.nickname.trim())
    }
  }
  if (!text && rawSpeak.trim()) {
    text = salvageSpokenFromRaw(rawSpeak)
    if (text) {
      text = stripSelfSpeakerLabel(text, aiTableName(profile))
    }
  }
  let retried = false
  const firstPassText = text

  const claimIsSeer =
    (plan?.claim ?? '').toLowerCase() === 'seer' ||
    spokenClaimForSelfIsSeer(snapshot, npcId)
  const dealtRobber =
    mode === 'day' && dayGame
      ? myDealtRole(dayGame, npcId) === 'robber'
      : false
  const tmPair =
    mode === 'day' && dayGame
      ? troublemakerSwapPair(dayGame, snapshot.players, npcId)
      : null
  const seerPeek =
    mode === 'day' && dayGame
      ? seerNightPeek(dayGame, snapshot.players, npcId)
      : null
  const robResult =
    mode === 'day' && dayGame
      ? robberNightResult(dayGame, snapshot.players, npcId)
      : null
  const dealtTroublemaker =
    mode === 'day' && dayGame
      ? myDealtRole(dayGame, npcId) === 'troublemaker'
      : false
  const lockedClaim =
    mode === 'day' && dayGame
      ? lockedSpokenClaimForPlayer(
          snapshot.chatLines ?? [],
          npcId,
          snapshot.players.filter((p) => dayGame!.playerIds.includes(p.id)),
        )
      : null

  const needsRetry = (candidate: string): string | null => {
    const echo = echoesForbidden(candidate, forbidden)
    if (echo) return `echo:${echo.slice(0, 160)}`
    if (
      addressesSelfByName(candidate, aiTableName(profile)) ||
      (Boolean(profile.nickname.trim()) &&
        addressesSelfByName(candidate, profile.nickname.trim()))
    ) {
      return 'self-address'
    }
    if (replyIsHostile(candidate)) return 'hostile'
    if (replyIsPrejudiced(candidate)) return 'prejudiced'
    if (replyThreatensRealHarm(candidate)) return 'real-harm'
    if (replyOffersOffTopicAdvice(candidate)) return 'off-topic'
    if (mode === 'result') {
      const seated = snapshot.players
        .filter((p) => p.connected)
        .map((p) => p.name)
      const phantom = thanksNonSeatedPlayer(candidate, seated)
      if (phantom) return `phantom-thanks:${phantom}`
      return null
    }
    // Day-only secrecy / claim guardrails — aftergame may admit the truth.
    if (mode !== 'day') return null
    if (dayWinTeam === 'village' && replyViolatesVillageTeam(candidate)) {
      return 'village-team'
    }
    if (
      dayWinTeam === 'werewolf' &&
      replyConfessesOwnWerewolf(candidate)
    ) {
      return 'werewolf-team'
    }
    const allyHit =
      dayWinTeam === 'werewolf'
        ? replyAccusesWolfAlly(candidate, dayWolfAllyNames)
        : null
    if (allyHit) return `wolf-ally:${allyHit}`
    if (dayWinTeam === 'neutral' && replyConfessesOwnTanner(candidate)) {
      return 'tanner-team'
    }
    if (
      dealtRobber &&
      claimIsSeer &&
      confessesRobWhileClaimingSeer(candidate)
    ) {
      return 'robber-seer'
    }
    if (dealtRobber && robberInventedExtraPeek(candidate, robResult)) {
      return 'robber-extra-peek'
    }
    if (
      dealtTroublemaker &&
      tmPair &&
      claimsTroublemakerDoesNotKnowTargets(candidate)
    ) {
      return 'tm-knows-targets'
    }
    if (
      dealtTroublemaker &&
      tmPair &&
      troublemakerMisattributesOwnSwap(
        candidate,
        tmPair.aName,
        tmPair.bName,
        (dayGame?.playerIds ?? [])
          .filter((id) => id !== npcId)
          .map((id) => dayGame!.playerNames[id] ?? id)
          .filter(
            (n) =>
              n.toLowerCase() !== tmPair.aName.toLowerCase() &&
              n.toLowerCase() !== tmPair.bName.toLowerCase(),
          ),
      )
    ) {
      return 'tm-wrong-swap'
    }
    if (
      dealtTroublemaker &&
      !tmPair &&
      inventsUnrecordedTroublemakerSwap(candidate)
    ) {
      return 'tm-no-swap'
    }
    // Seer/Robber/etc. must not steal the Troublemaker first-person swap story.
    if (
      !(dealtTroublemaker && tmPair) &&
      claimsUnownedFirstPersonTroublemakerSwap(candidate)
    ) {
      return 'unowned-tm-swap'
    }
    if (replyIsBareVoteCast(candidate)) {
      return 'bare-vote'
    }
    if (
      dayGame &&
      offersConflictingSecondRoleClaim(candidate, rolesInPlayLabels(dayGame))
    ) {
      return 'dual-claim'
    }
    // Locked info claim: do not flip to a different deck role mid-day.
    if (lockedClaim && isInfoClaimRole(lockedClaim)) {
      const spoken = extractClaimFromText(candidate)
      if (
        spoken &&
        spoken.toLowerCase() !== lockedClaim.toLowerCase() &&
        // Soft "even if I'm the Villager" hedges still flip the ledger — block them.
        replyStatesClaim(candidate, spoken)
      ) {
        return 'claim-flip'
      }
    }
    if (
      dayGame &&
      villageMustNotInventNightCardStory(dayGame, npcId) &&
      inventsFabricatedNightCardStory(candidate)
    ) {
      return 'no-night-invent'
    }
    if (
      dayGame &&
      assumesUnrecordedNightSwap(candidate) &&
      !seatHasRecordedNightSwap(dayGame, npcId) &&
      !dayBoardHasSwap
    ) {
      return 'assume-swap'
    }
    if (
      dayGame &&
      !seatHasSeerPeekToChallengeWith(dayGame, npcId) &&
      inventsSeerPeekContradiction(candidate)
    ) {
      return 'seer-contradict'
    }
    const reaskWho = spokenReasksClaimedRole(
      candidate,
      new Set(
        [...dayClaimedNames].filter(
          (n) =>
            n.toLowerCase() !== aiTableName(profile).toLowerCase() &&
            (!profile.nickname.trim() ||
              n.toLowerCase() !== profile.nickname.trim().toLowerCase()),
        ),
      ),
    )
    if (reaskWho) return `reask-claim:${reaskWho}`
    const reaskStoryWho = spokenReasksCompleteNightStory(
      candidate,
      new Set(
        [...dayNightStoryNames].filter(
          (n) =>
            n.toLowerCase() !== aiTableName(profile).toLowerCase() &&
            (!profile.nickname.trim() ||
              n.toLowerCase() !== profile.nickname.trim().toLowerCase()),
        ),
      ),
    )
    if (reaskStoryWho) return `reask-night:${reaskStoryWho}`
    if (inventsFalseMinionRules(candidate)) {
      return 'false-minion-rules'
    }
    if (inventsFalseRobberRules(candidate)) {
      return 'false-robber-rules'
    }
    if (
      dayRobTargetStory &&
      deniesConsistentRobberTargetStory(candidate)
    ) {
      return 'robber-target-epistemology'
    }
    return null
  }

  const retryReason = text ? needsRetry(text) : null
  if (text && retryReason) {
    retried = true
    // Keep the first-pass bubble visible while retrying — clearing it made
    // good lines vanish, then get replaced by a generic stub on retry failure.
    let hint: string
    if (retryReason.startsWith('echo:')) {
      hint = `Do NOT repeat or closely paraphrase this table line: "${retryReason.slice(5)}". Give a fresh reply in your own persona voice.`
    } else if (retryReason === 'village-team') {
      hint =
        'You are village-aligned. Do NOT claim to be a werewolf/minion or talk about packmates. Stay consistent with your plan claim and private info.'
    } else if (retryReason === 'werewolf-team') {
      hint =
        'You are on the werewolf team. Do NOT confess wolf/minion or say you woke up holding the wolf card. Stick to your planned village cover claim and lie about night results.'
    } else if (retryReason.startsWith('wolf-ally:')) {
      const ally = retryReason.slice('wolf-ally:'.length)
      hint = `Do NOT accuse, vote, or call ${ally} a wolf/minion — they are your known wolf ally. Protect them and steer heat onto another seat.`
    } else if (retryReason === 'tanner-team') {
      hint =
        'You are the Tanner. Do NOT say you are Tanner, that you win if you die, or ask people to kill you. Stick to your village cover claim and lie a little clumsily so you look suspicious enough to draw votes.'
    } else if (retryReason === 'robber-seer') {
      hint =
        'You are claiming Seer. Do NOT say you took/robbed/stole their card. Either stick to Seer without confessing the rob, or clearly own Robber if you reveal the swap.'
    } else if (retryReason === 'robber-extra-peek' && robResult) {
      hint = `Your only night result is: you robbed ${robResult.targetName} and became ${robResult.stolenLabel}. Do NOT invent peeks, "card looked funny," or Seer-style looks. Say the rob + stolen role clearly.`
    } else if (retryReason === 'tm-knows-targets' && tmPair) {
      hint = `You DO know who you swapped: ${tmPair.aName} and ${tmPair.bName}. Name them. Never say you don't know which players.`
    } else if (retryReason === 'tm-wrong-swap' && tmPair) {
      hint = `YOU are the Troublemaker — say "I swapped ${tmPair.aName} and ${tmPair.bName}." Do NOT accuse anyone else of your swap, and do NOT invent different swap targets.`
    } else if (retryReason === 'tm-no-swap') {
      hint =
        'No Troublemaker swap is recorded for you. Do NOT claim you swapped anyone. Claim Troublemaker only if you must, without inventing targets.'
    } else if (retryReason === 'unowned-tm-swap') {
      hint =
        'Do NOT say "I swapped A and B" — that is only the Troublemaker\'s night story. Stick to YOUR claim and private night info (Seer = peek only; Robber = rob + stolen role). Cite another player\'s swap only if they already said it first-person on the claim board.'
    } else if (retryReason === 'bare-vote') {
      hint =
        'Do NOT cast votes in dialogue with "I vote for X" — the game posts cast votes separately. Argue who should die and why (e.g. "I\'m on Ben — Boz moved the wolf card").'
    } else if (retryReason.startsWith('phantom-thanks:')) {
      const who = retryReason.slice('phantom-thanks:'.length)
      hint = `Do NOT thank or give props to "${who}" — they were not at this table. Only address seated players listed in your prompt (or the Narrator).`
    } else if (retryReason === 'dual-claim') {
      hint = plan?.claim
        ? `State exactly one role claim: ${plan.claim}. Do NOT also say you'll "play" or "claim" a second different role in the same reply.`
        : 'State exactly one role claim. Do not offer to play a second different role in the same reply.'
    } else if (retryReason === 'claim-flip' && lockedClaim) {
      hint = `You already claimed ${lockedClaim} at the table — keep that claim. Do NOT flip to Villager or another cover.`
    } else if (retryReason === 'no-night-invent') {
      hint =
        'Your private night info has no peek or swap you performed. Do NOT invent that you peeked, robbed, swapped, or picked up a role card. If you are Insomniac whose card changed, only say you checked your own card. Stick to your claim and ask others what they woke as.'
    } else if (retryReason === 'assume-swap') {
      hint =
        'No Troublemaker/Robber swap is in your private info or on the claim board. Do NOT ask about "after the swap" or whether a card got swapped — treat seats as unmoved until a first-person swap story appears.'
    } else if (retryReason === 'seer-contradict') {
      hint =
        'You have no Seer peek of your own. Do NOT say their Seer claim/peek "doesn\'t line up with what I saw." Clear matching peeks or interview someone else — never invent a contradiction.'
    } else if (retryReason.startsWith('reask-claim:')) {
      const who = retryReason.slice('reask-claim:'.length)
      hint = `${who} already has a role claim on the PUBLIC CLAIM BOARD — do NOT ask what they woke as / what role they are. Acknowledge the board and move on (role accounting, another seat, or a vote pitch).`
    } else if (retryReason.startsWith('reask-night:')) {
      const who = retryReason.slice('reask-night:'.length)
      hint = `${who} already gave a complete night story on the board — do NOT re-ask what the stolen card looked like / demand another peek. Acknowledge it and move on (role accounting, incomplete Seer peeks, or a vote pitch).`
    } else if (retryReason === 'false-minion-rules') {
      hint =
        'Minion DOES see who the werewolves are at night (wolves stick out a thumb). Do NOT say Minions cannot peek/see wolves. Challenge the player\'s consistency or motives instead of inventing false rules.'
    } else if (retryReason === 'false-robber-rules') {
      hint =
        'Robber DOES look at the stolen card after swapping — becoming Seer/Mason/etc. is NORMAL. Do NOT say Robbers cannot peek or that "Seer from Robber" is impossible. Challenge target/timing/conflicts instead.'
    } else if (retryReason === 'robber-target-epistemology') {
      const who = dayRobTargetStory?.speakerName ?? 'they'
      hint = `${who} claims they robbed YOU — you would NOT feel that swap. Do NOT say "no swap felt" / "my card stayed" as proof they are lying. Treat their Robber story as compatible with your night info and do role accounting instead.`
    } else if (retryReason === 'hostile') {
      hint =
        'Keep it friendly. No insults, demeaning lines, or "you idiots / pathetic / shut up." Light teasing is fine — rewrite without hostility.'
    } else if (retryReason === 'prejudiced') {
      hint =
        'Never be prejudiced or bigoted toward any race, ethnicity, religion, gender, orientation, disability, or minority. Rewrite without stereotypes or slurs — stick to the Werewolf game.'
    } else if (retryReason === 'real-harm') {
      hint =
        'Never threaten or encourage real-world harm. In-game vote/eliminate talk is fine; rewrite any real-life harm.'
    } else if (retryReason === 'off-topic') {
      hint =
        'Stay on One Night Ultimate Werewolf and this table only. Do not give coding, legal, medical, or other real-world advice — redirect to the game.'
    } else {
      hint = `Do NOT address yourself as "${aiTableName(profile)}", grill yourself, or narrate about yourself in third person. Speak to the table / ${speakerName}.`
    }
    rawSpeak = await speakOnce({
      provider,
      config,
      system,
      history,
      user: `${user}\n\nIMPORTANT: ${hint}`,
    })
    text = extractSpokenReply(rawSpeak)
    if (text) {
      text = stripSelfSpeakerLabel(text, aiTableName(profile))
      if (profile.nickname.trim()) {
        text = stripSelfSpeakerLabel(text, profile.nickname.trim())
      }
    }
    if (!text && rawSpeak.trim()) {
      text = salvageSpokenFromRaw(rawSpeak)
      if (text) {
        text = stripSelfSpeakerLabel(text, aiTableName(profile))
      }
    }
    // Prefer a salvageable first pass over an empty/broken retry.
    if (!text && firstPassText) {
      text = firstPassText
    }
  }

  if (text && mode === 'day') {
    text = enforceClaimInReply(
      text,
      plan,
      profile,
      humanTranscript,
      snapshot,
      npcId,
    )
  }

  /** Night-story line we forced into speech — must survive final needsRetry. */
  let forcedNightStory: string | null = null

  if (text && tmPair && mode === 'day') {
    const before = text
    const tmSharedAtTable = (snapshot.chatLines ?? []).some(
      (l) =>
        l.fromId === npcId &&
        replyOwnsTroublemakerSwap(l.text, tmPair.aName, tmPair.bName),
    )
    const otherNames = (dayGame?.playerIds ?? [])
      .filter((id) => id !== npcId)
      .map((id) => dayGame!.playerNames[id] ?? id)
      .filter(
        (n) =>
          n.toLowerCase() !== tmPair.aName.toLowerCase() &&
          n.toLowerCase() !== tmPair.bName.toLowerCase(),
      )
    text = enforceTroublemakerSwapAnswer(
      text,
      humanTranscript,
      tmPair.aName,
      tmPair.bName,
      {
        claim: plan?.claim,
        forceShare:
          !tmSharedAtTable &&
          ((plan?.claim ?? '').toLowerCase() === 'troublemaker' ||
            dealtTroublemaker),
        otherPlayerNames: otherNames,
      },
    )
    if (text !== before && replyOwnsTroublemakerSwap(text, tmPair.aName, tmPair.bName)) {
      forcedNightStory = `I swapped ${tmPair.aName} and ${tmPair.bName} — I didn't see the roles.`
    }
  }

  if (text && dayGame && mode === 'day') {
    text = scrubConflictingSecondClaim(
      text,
      plan?.claim ?? lockedClaim,
      rolesInPlayLabels(dayGame),
    )
  }

  if (text && robResult && mode === 'day') {
    const before = text
    const robSharedAtTable = (snapshot.chatLines ?? []).some(
      (l) => l.fromId === npcId && replySharesRobberStory(l.text, robResult),
    )
    const forceRobber =
      (plan?.claim ?? '').toLowerCase() === 'robber' ||
      dealtRobber ||
      (lockedClaim ?? '').toLowerCase() === 'robber'
    text = enforceRobberNightStoryInReply(text, robResult, {
      claim: forceRobber ? 'Robber' : plan?.claim,
      forceShare: !robSharedAtTable && forceRobber,
    })
    if (text !== before && replySharesRobberStory(text, robResult)) {
      forcedNightStory = `I robbed ${robResult.targetName} and became ${robResult.stolenLabel}.`
    }
    if (forceRobber && plan) {
      text = enforceClaimInReply(
        text,
        { ...plan, claim: 'Robber' },
        profile,
        humanTranscript,
        snapshot,
        npcId,
      )
    }
  }

  if (text && seerPeek && mode === 'day') {
    const before = text
    const seerSharedAtTable = (snapshot.chatLines ?? []).some(
      (l) => l.fromId === npcId && replySharesSeerPeek(l.text, seerPeek),
    )
    const forceSeer =
      (plan?.claim ?? '').toLowerCase() === 'seer' ||
      myDealtRole(dayGame!, npcId) === 'seer' ||
      (lockedClaim ?? '').toLowerCase() === 'seer'
    text = enforceSeerPeekInReply(text, seerPeek, {
      claim: forceSeer ? 'Seer' : plan?.claim,
      forceShare: !seerSharedAtTable && forceSeer,
    })
    if (text !== before && replySharesSeerPeek(text, seerPeek)) {
      forcedNightStory =
        seerPeek.kind === 'player'
          ? `I peeked ${seerPeek.targetName} as ${seerPeek.roleLabel}.`
          : `I peeked ${seerPeek.label}.`
    }
    // After peek splice, ensure Seer claim is present when this seat is dealt Seer.
    if (forceSeer && plan) {
      text = enforceClaimInReply(
        text,
        { ...plan, claim: 'Seer' },
        profile,
        humanTranscript,
        snapshot,
        npcId,
      )
    }
  }

  if (text && dayGame && mode === 'day') {
    text = stripOutOfDeckRoles(text, rolesNotInPlay(dayGame))
  }

  // Final echo / self-address / team / civility guard after claim splice
  if (text && needsRetry(text)) {
    retried = true
    const finalReason = needsRetry(text)
    const splicedHasForced =
      !!forcedNightStory &&
      ((tmPair &&
        replyOwnsTroublemakerSwap(text, tmPair.aName, tmPair.bName)) ||
        (robResult && replySharesRobberStory(text, robResult)) ||
        (seerPeek && replySharesSeerPeek(text, seerPeek)))
    // Prefer keeping a forced night story over reverting to a bare first pass.
    const cleanFirst =
      !forcedNightStory &&
      firstPassText &&
      !needsRetry(firstPassText)
        ? firstPassText
        : null
    if (cleanFirst) {
      text = cleanFirst
    } else if (forcedNightStory && (finalReason === 'claim-flip' || splicedHasForced)) {
      const claim =
        lockedClaim && isInfoClaimRole(lockedClaim)
          ? lockedClaim
          : plan?.claim
      const claimBit = claim ? `I'm the ${claim}. ` : ''
      text = `${claimBit}${forcedNightStory}`.trim()
    } else if (finalReason === 'claim-flip' && lockedClaim) {
      const story =
        forcedNightStory ??
        (tmPair && dealtTroublemaker
          ? `I swapped ${tmPair.aName} and ${tmPair.bName} — I didn't see the roles.`
          : robResult && dealtRobber
            ? `I robbed ${robResult.targetName} and became ${robResult.stolenLabel}.`
            : seerPeek && myDealtRole(dayGame!, npcId) === 'seer'
              ? seerPeek.kind === 'player'
                ? `I peeked ${seerPeek.targetName} as ${seerPeek.roleLabel}.`
                : `I peeked ${seerPeek.label}.`
              : null)
      text = story
        ? `I'm the ${lockedClaim}. ${story}`
        : `I'm the ${lockedClaim}.`
    } else if (finalReason?.startsWith('wolf-ally:')) {
      const ally = finalReason.slice('wolf-ally:'.length)
      text = `Hold up — ${ally} isn't my read. Who else has a shaky claim we should pressure?`
    } else if (finalReason === 'tm-knows-targets' && tmPair) {
      text = `I swapped ${tmPair.aName} and ${tmPair.bName} — I didn't see the roles.`
    } else if (finalReason === 'tm-wrong-swap' && tmPair) {
      text = `I'm the Troublemaker. I swapped ${tmPair.aName} and ${tmPair.bName} — I didn't see the roles.`
    } else if (finalReason === 'tm-no-swap') {
      text = plan?.claim
        ? `I'm the ${plan.claim}, but I don't have a swap story to share.`
        : `I don't have a swap story to share.`
    } else if (finalReason === 'dual-claim') {
      text = buildGuardrailFallback({
        reason: 'dual-claim',
        claim: lockedClaim ?? plan?.claim,
        suspects: plan?.suspects ?? [],
        playful: /loud|blunt|playful|teas|banter|energetic/i.test(
          profile.persona,
        ),
        incomplete: dayIncompleteStories,
        surplus: daySurplus,
        avoid: forbidden,
      })
    } else if (finalReason === 'robber-extra-peek' && robResult) {
      text = `I robbed ${robResult.targetName} and became ${robResult.stolenLabel}. That's my whole night story.`
    } else if (finalReason === 'false-minion-rules') {
      text = `Fair — Minion does see the wolves at night. Still doesn't prove your story; walk me through the claims.`
    } else if (finalReason === 'false-robber-rules') {
      text = `Robbers do look at the card they steal — becoming Seer that way is normal. Still, that doesn't settle whose story holds — keep the claims coming.`
    } else if (finalReason === 'robber-target-epistemology') {
      const who = dayRobTargetStory?.speakerName ?? 'they'
      text = plan?.claim
        ? `Fair — I wouldn't feel a rob anyway. I'm the ${plan.claim}. ${who}'s Robber story can sit next to that; let's do role accounting.`
        : `Fair — I wouldn't feel a rob anyway. ${who}'s Robber story can sit next to my night info; let's do role accounting.`
    } else if (finalReason === 'assume-swap') {
      // If we already forced a TM/Robber story, keep it rather than denying the swap.
      if (forcedNightStory) {
        const claim = lockedClaim ?? plan?.claim
        text = claim
          ? `I'm the ${claim}. ${forcedNightStory}`
          : forcedNightStory
      } else {
        text = plan?.claim
          ? `I'm not assuming any swap yet — nothing's on the board. I'm the ${plan.claim}.`
          : `I'm not assuming any swap yet — nothing's on the board. Who still needs to claim?`
      }
    } else if (finalReason === 'seer-contradict') {
      text = plan?.claim
        ? `I didn't peek what they peeked — I'm the ${plan.claim}. Let's do role accounting instead of inventing conflicts.`
        : `I didn't peek what they peeked — let's do role accounting instead of inventing conflicts.`
    } else if (
      finalReason?.startsWith('reask-claim:') ||
      finalReason?.startsWith('reask-night:')
    ) {
      text = buildGuardrailFallback({
        reason: finalReason,
        claim: plan?.claim,
        suspects: plan?.suspects ?? [],
        playful: /loud|blunt|playful|teas|banter|energetic/i.test(
          profile.persona,
        ),
        incomplete: dayIncompleteStories,
        surplus: daySurplus,
        avoid: forbidden,
      })
    } else if (
      finalReason === 'hostile' ||
      finalReason === 'prejudiced' ||
      finalReason === 'real-harm' ||
      finalReason === 'off-topic'
    ) {
      text =
        mode === 'lobby'
          ? `Easy — keep it playful. Who's looking too innocent next?`
          : mode === 'result'
            ? `Back to the round — wild game. Rematch?`
            : `Let's stick to this Werewolf round — whose claim are we checking next?`
    } else if (mode === 'result') {
      const won = dayGame ? playerWon(dayGame, npcId) : null
      const playful = /loud|blunt|playful|teas|banter|energetic/i.test(
        profile.persona,
      )
      text = won
        ? playful
          ? `I'll take that win. What a round.`
          : `That one goes our way. Solid game.`
        : playful
          ? `Oof — respect to the winners. Rematch?`
          : `Tough loss. Rematch whenever you're ready.`
    } else if (
      finalReason?.startsWith('echo:') ||
      finalReason === 'self-address'
    ) {
      if (forcedNightStory) {
        const claim = lockedClaim ?? plan?.claim
        text = claim
          ? `I'm the ${claim}. ${forcedNightStory}`
          : forcedNightStory
      } else {
        const stripped = stripEchoedSentences(text, forbidden)
        const salvage = salvageSpokenFromRaw(rawSpeak)
        if (stripped && !needsRetry(stripped)) {
          text = stripped
        } else if (salvage && !needsRetry(salvage)) {
          text = salvage
        } else {
          text = buildGuardrailFallback({
            reason: finalReason,
            claim: plan?.claim,
            suspects: plan?.suspects ?? [],
            playful: /loud|blunt|playful|teas|banter|energetic/i.test(
              profile.persona,
            ),
            incomplete: dayIncompleteStories,
            surplus: daySurplus,
            avoid: forbidden,
          })
        }
      }
    } else if (forcedNightStory) {
      const claim = lockedClaim ?? plan?.claim
      text = claim
        ? `I'm the ${claim}. ${forcedNightStory}`
        : forcedNightStory
    } else {
      text = buildGuardrailFallback({
        reason: finalReason ?? 'other',
        claim: plan?.claim,
        suspects: plan?.suspects ?? [],
        playful: /loud|blunt|playful|teas|banter|energetic/i.test(
          profile.persona,
        ),
        incomplete: dayIncompleteStories,
        surplus: daySurplus,
        avoid: forbidden,
      })
    }
    text = capSentences(text, 3)
    if (dayGame && mode === 'day') {
      text = stripOutOfDeckRoles(text, rolesNotInPlay(dayGame))
    }
  }

  const traceBase = {
    at: Date.now(),
    mode,
    humanTranscript,
    humanFromId: speaker?.id ?? null,
    humanName: speaker?.name ?? null,
    responders,
    planRaw,
    planModelId,
    rawSpeak,
    retried,
    workModelId: config.modelId,
    latencyMs: Date.now() - started,
    privateObservation,
  } as const

  if (!text) {
    appendReplyTrace(gKey, npcId, {
      ...traceBase,
      plan: mem.lastPlan,
      cleanedText: '',
    })
    return ''
  }

  onPartial?.(text)

  appendAgentChat(gKey, npcId, { role: 'user', content: user })
  appendAgentChat(gKey, npcId, { role: 'assistant', content: text })

  if (speaker && mode === 'day') {
    updateBelief(
      gKey,
      npcId,
      speaker.id,
      `Said to me: ${humanTranscript.slice(0, 100)}`,
    )
  }

  appendReplyTrace(gKey, npcId, {
    ...traceBase,
    plan: getAgentMemory(gKey, npcId).lastPlan,
    cleanedText: text,
  })

  return text
}

export async function generateDayReply(args: {
  snapshot: SessionSnapshot
  npcId: ClientId
  profile: AiPlayerProfile
  humanTranscript: string
  humanFromId?: ClientId | null
  responders?: ClientId[]
  avoidTexts?: string[]
  onPartial?: (accumulated: string) => void
  /** Host prompted this seat to volunteer a line (no human utterance). */
  proactive?: boolean
}): Promise<string> {
  return generateReply({ ...args, mode: 'day' })
}

export async function generateLobbyReply(args: {
  snapshot: SessionSnapshot
  npcId: ClientId
  profile: AiPlayerProfile
  humanTranscript: string
  humanFromId?: ClientId | null
  responders?: ClientId[]
  avoidTexts?: string[]
  onPartial?: (accumulated: string) => void
  /** Host prompted this seat to volunteer a line (no human utterance). */
  proactive?: boolean
}): Promise<string> {
  return generateReply({ ...args, mode: 'lobby' })
}

export async function generateEndReply(args: {
  snapshot: SessionSnapshot
  npcId: ClientId
  profile: AiPlayerProfile
  humanTranscript: string
  humanFromId?: ClientId | null
  responders?: ClientId[]
  avoidTexts?: string[]
  onPartial?: (accumulated: string) => void
  /** True for automatic winner/loser reactions (no human line). */
  proactive?: boolean
}): Promise<string> {
  return generateReply({ ...args, mode: 'result' })
}
