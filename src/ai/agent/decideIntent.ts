import { myDealtRole } from '../../game/werewolfLogic'
import type { ClientIntent, SessionSnapshot } from '../../net/protocol'
import type { ClientId } from '../../session/types'
import { aiTableName, type AiPlayerProfile } from '../aiPlayers'
import { loadAiStore } from '../aiStore'
import { chatWithConfig } from '../client'
import { aiJobQueue } from '../queue'
import {
  filterStaleNoClaimBeliefs,
  parseBeliefUpdatesFromText,
} from './beliefParse'
import {
  buildGlobalPublicClaimBoard,
  formatTablePressure,
  rolesInPlayLabels,
  spokenClaimsAccountForVillageSeats,
  spokenRobberStoryTargeting,
} from './claimLedger'
import {
  formatDayClockNote,
  formatRecentChatForAgent,
} from './chatTime'
import {
  deniesConsistentRobberTargetStory,
  filterOutAllyVotes,
  formatVoteTallies,
  inventsFalseRobberRules,
  knownWolfAllyIds,
  notesInventWolfWithoutEvidence,
  notesViolateTeam,
  notesWantVoteSpread,
  preferSeerWolfVote,
  preferVillageSpreadVote,
  preferForceKillVote,
  preferVoteTarget,
  seerPeekedWolfIds,
  seerWolfVoteAfterClaimedSwap,
  troublemakerMovedWolfTarget,
  voteTallies,
  voteWinConditionCheatSheet,
  winTeamFromPrivate,
} from './guardrails'
import { gameKeyOf } from './gameKey'
import {
  appendAgentChat,
  formatKnowledgeBase,
  getAgentMemory,
  resolvePlayerIdByName,
  updateBelief,
} from './memory'
import {
  buildHardFacts,
  buildPrivateObservation,
  listLegalActions,
  type LegalAction,
} from './privateView'
import { DAY_RULES, WATCH_DAY_RULES, teamStrategyForSeat } from './teamStrategy'
import { formatTablePlayerBios } from './tableBios'

/**
 * Coerce a model-provided action index into 0..max-1.
 * Out-of-range values return null (do NOT map max → last option — that turns
 * invented "skip/no-kill" indexes into accidental pile-on votes).
 * Ambiguous 1-based last-option (raw === max) is only accepted when
 * allowOneBasedLast is true.
 */
export function coerceIndex(
  raw: unknown,
  max: number,
  opts?: { allowOneBasedLast?: boolean },
): number | null {
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim()
        ? Number(raw.trim())
        : NaN
  if (!Number.isFinite(n)) return null
  const i = Math.trunc(n)
  if (i >= 0 && i < max) return i
  // Models sometimes answer 1-based (1..max). Accept only when not inventing
  // an extra option beyond the list — gated by allowOneBasedLast for i === max.
  if (i >= 1 && i < max) return i - 1
  if (opts?.allowOneBasedLast && i === max && max >= 1) return max - 1
  return null
}

function parseActionIndex(
  text: string,
  max: number,
  opts?: { allowOneBasedLast?: boolean },
): number | null {
  const cleaned = text
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .trim()
  const coerce = (raw: unknown) => coerceIndex(raw, max, opts)

  // Prefer the first complete JSON object only (models often emit several
  // {"index":…} choices concatenated — never take a later one).
  const firstObj = extractFirstJsonObject(cleaned)
  if (firstObj) {
    try {
      const obj = JSON.parse(firstObj) as {
        index?: unknown
        actionIndex?: unknown
        action_index?: unknown
      }
      for (const key of ['index', 'actionIndex', 'action_index'] as const) {
        const fromObj = coerce(obj[key])
        if (fromObj != null) return fromObj
      }
    } catch {
      // fall through
    }
  }

  // Prefer explicit index fields even when surrounding JSON is messy.
  // Use the FIRST index field only (ignore trailing alternate choices).
  const field =
    cleaned.match(/"?(?:index|actionIndex|action_index)"?\s*:\s*(-?\d+)/i) ??
    cleaned.match(/\b(?:index|action)\s*[:=]\s*(-?\d+)/i)
  if (field) {
    const fromField = coerce(field[1])
    if (fromField != null) return fromField
  }

  // Last integer in range wins (models often narrate, then pick) — but only
  // when there is a single digit candidate path (no multi-index dump).
  const indexFields = [
    ...cleaned.matchAll(/"?(?:index|actionIndex|action_index)"?\s*:\s*(-?\d+)/gi),
  ]
  if (indexFields.length > 1) {
    const fromFirst = coerce(indexFields[0]![1])
    if (fromFirst != null) return fromFirst
  }

  const nums = [...cleaned.matchAll(/\b(\d+)\b/g)].map((m) => Number(m[1]))
  for (let i = nums.length - 1; i >= 0; i--) {
    const idx = coerce(nums[i])
    if (idx != null) return idx
  }
  return null
}

/** Brace-matched first `{…}` in text, or null. */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (escape) {
        escape = false
        continue
      }
      if (ch === '\\') {
        escape = true
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** Prefer ack / claim fallbacks when the model reply is unusable. */
function fallbackActionIndex(legal: LegalAction[]): number {
  const ack = legal.findIndex((a) => a.type === 'werewolf.ack')
  if (ack >= 0) return ack
  const voteIdx = legal
    .map((a, i) => (a.type === 'werewolf.vote' ? i : -1))
    .filter((i) => i >= 0)
  if (voteIdx.length > 0) {
    return voteIdx[Math.floor(Math.random() * voteIdx.length)]!
  }
  return Math.floor(Math.random() * legal.length)
}

function parseNotes(text: string): string | null {
  const firstObj = extractFirstJsonObject(text)
  if (!firstObj) return null
  try {
    const obj = JSON.parse(firstObj) as { notes?: string }
    return typeof obj.notes === 'string' ? obj.notes.slice(0, 400) : null
  } catch {
    return null
  }
}

/** True when freeform notes deny the action the model just indexed. */
export function notesContradictAction(
  notes: string | null | undefined,
  label: string,
): boolean {
  if (!notes?.trim()) return false
  const n = notes.toLowerCase()
  const denies =
    /\b(?:choose|chose|choosing)\s+not\s+to\b|\bi\s+(?:do|did)\s+not\b|\bnot\s+(?:rob|swap|vote|peek|claim|acknowledge)\b|\bkeep(?:ing)?\s+(?:my|current)\b|\bwithout\s+(?:robbing|swapping|voting)\b|\bdecline\b|\bskip(?:ping)?\b/i.test(
      n,
    )
  if (!denies) return false
  // Notes that deny acting while the chosen label is a concrete night/vote act.
  if (
    /\b(?:rob|swap|vote|peek|claim|hunter)/i.test(label) &&
    !/\backnowledge\b/i.test(label)
  ) {
    return true
  }
  return false
}

function actionToIntent(action: LegalAction): ClientIntent {
  return action as ClientIntent
}

function actionLabel(
  action: LegalAction,
  snapshot: SessionSnapshot,
): string {
  const name = (id: string) =>
    snapshot.players.find((p) => p.id === id)?.name ??
    snapshot.game?.playerNames[id] ??
    id
  switch (action.type) {
    case 'werewolf.vote':
      return `Vote for ${name(action.targetId)}`
    case 'werewolf.undoVote':
      return 'Clear my vote (unvote)'
    case 'werewolf.hunterKill':
      return `Hunter-kill ${name(action.targetId)}`
    case 'werewolf.robber':
      return `Rob ${name(action.targetId)}`
    case 'werewolf.seerPlayer':
      return `Seer peek ${name(action.targetId)}`
    case 'werewolf.seerCenter':
      return `Seer peek center ${action.a + 1} & ${action.b + 1}`
    case 'werewolf.troublemaker':
      return `Troublemaker swap ${name(action.a)} ↔ ${name(action.b)}`
    case 'werewolf.werewolfPeek':
      return `Lone wolf peek center ${action.centerIndex + 1}`
    case 'werewolf.drunk':
      return `Drunk swap center ${action.centerIndex + 1}`
    case 'werewolf.claim':
      return `Claim card ${action.cardId}`
    case 'werewolf.ack':
      return 'Acknowledge / done'
    default:
      return JSON.stringify(action)
  }
}

export async function decideNpcIntent(args: {
  snapshot: SessionSnapshot
  npcId: ClientId
  profile: AiPlayerProfile
}): Promise<ClientIntent | null> {
  const { snapshot, npcId, profile } = args
  const game = snapshot.game
  if (!game || snapshot.gameId !== 'werewolf') return null

  let legal = listLegalActions(game, npcId)
  if (legal.length === 0) return null

  // Opening claim is a face-down card pick — no private info yet, no model needed.
  if (game.phase === 'claiming') {
    return actionToIntent(legal[Math.floor(Math.random() * legal.length)]!)
  }

  const winTeam = winTeamFromPrivate(game, npcId)
  const peekedWolves = seerPeekedWolfIds(game, npcId)
  const allies = knownWolfAllyIds(game, npcId)
  const chatLines = snapshot.chatLines ?? []
  const currentVote = game.votes[npcId] ?? null

  // Real Troublemaker: if chat places night-wolf on one swap target, vote the other.
  if (game.phase === 'day') {
    const movedWolf = troublemakerMovedWolfTarget(game, npcId, chatLines)
    const forcedTm = preferVoteTarget(legal, movedWolf)
    if (forcedTm != null) {
      const action = legal[forcedTm]!
      if (
        action.type === 'werewolf.vote' &&
        currentVote === action.targetId
      ) {
        return null
      }
      return actionToIntent(action)
    }
  }

  // Seer vote clamp: vote peeked wolf, unless table talk establishes a TM swap
  // that moved that card — then vote the other swap target (skip clamp if self).
  if (game.phase === 'day' && peekedWolves.length > 0) {
    const afterSwap = seerWolfVoteAfterClaimedSwap(
      game,
      npcId,
      peekedWolves,
      chatLines,
    )
    if (afterSwap && afterSwap !== npcId) {
      const forced = preferVoteTarget(legal, afterSwap)
      if (forced != null) {
        const action = legal[forced]!
        if (
          action.type === 'werewolf.vote' &&
          currentVote === action.targetId
        ) {
          return null
        }
        return actionToIntent(action)
      }
    } else if (!afterSwap) {
      const forced = preferSeerWolfVote(legal, peekedWolves)
      if (forced != null) {
        const action = legal[forced]!
        if (
          action.type === 'werewolf.vote' &&
          currentVote === action.targetId
        ) {
          return null
        }
        return actionToIntent(action)
      }
    }
    // afterSwap === self: wolf card is on us — do not force voting the old peek.
  }

  // Werewolf team: remove known packmates from vote options when alternatives exist.
  if (game.phase === 'day' && winTeam === 'werewolf') {
    legal = filterOutAllyVotes(legal, allies)
  }

  if (legal.length === 1) return actionToIntent(legal[0]!)

  const store = loadAiStore()
  const config = store.modelConfigs.find((c) => c.id === store.activeWorkConfigId)
  const provider = config
    ? store.providers.find((p) => p.id === config.providerId)
    : null
  if (!config || !provider) {
    throw new Error('Work model not configured')
  }

  const gKey = gameKeyOf(snapshot)
  const mem = getAgentMemory(gKey, npcId)
  const observation = buildPrivateObservation(game, snapshot.players, npcId)
  const dealt = myDealtRole(game, npcId)
  const tablePlayers = snapshot.players.filter((p) =>
    game.playerIds.includes(p.id),
  )
  const publicBoard = buildGlobalPublicClaimBoard({
    players: tablePlayers,
    chatLines: snapshot.chatLines ?? [],
  })
  const claimedNames = new Set(
    publicBoard.entries.filter((e) => e.claim).map((e) => e.playerName),
  )
  const inPlay = rolesInPlayLabels(game)
  const namedLegal = legal.map(
    (a, i) => `${i}: ${actionLabel(a, snapshot)}`,
  )
  const hardFacts = buildHardFacts(game, snapshot.players, npcId)
  const tallies =
    game.phase === 'day' ? voteTallies(game, npcId) : new Map<string, number>()
  const clockNote = formatDayClockNote(game)
  const recentChat = formatRecentChatForAgent(snapshot.chatLines ?? [], 12)
  const currentVoteName =
    currentVote == null
      ? null
      : snapshot.players.find((p) => p.id === currentVote)?.name ??
        game.playerNames[currentVote] ??
        currentVote
  const claimsAccountForPrompt =
    game.phase === 'day' &&
    winTeam === 'village' &&
    peekedWolves.length === 0 &&
    spokenClaimsAccountForVillageSeats(game, publicBoard.entries)
  const robTargetStory = spokenRobberStoryTargeting(publicBoard.stories, npcId)

  const system = [
    `You are ${aiTableName(profile)}, an AI player in One Night Ultimate Werewolf.` +
      (profile.nickname.trim() &&
      profile.nickname.trim().toLowerCase() !== aiTableName(profile).toLowerCase()
        ? ` Goes by ${profile.nickname.trim()}.`
        : ''),
    profile.title?.trim()
      ? `Persona: ${profile.persona} · Title: ${profile.title.trim()}`
      : `Persona: ${profile.persona}`,
    formatTablePlayerBios(snapshot.players, npcId),
    snapshot.watchMode ? `${DAY_RULES}\n\n${WATCH_DAY_RULES}` : DAY_RULES,
    voteWinConditionCheatSheet(inPlay, game),
    `Your win team (from private info): ${winTeam}`,
    'Team strategy:',
    teamStrategyForSeat(game, npcId),
    ...(snapshot.watchMode && game.phase === 'day'
      ? [
          'Watch-mode voting: you may cast or revise a bluff vote to misdirect, then change later. Prefer theatrical table politics over staying silent.',
        ]
      : []),
    'Private information (do not claim to know more):',
    observation,
    ...(hardFacts.length
      ? ['Hard facts (do not contradict):', hardFacts.join('\n')]
      : []),
    ...(game.phase === 'day'
      ? [formatVoteTallies(game, npcId)]
      : []),
    publicBoard.text,
    'Table pressure:',
    formatTablePressure(snapshot.chatLines ?? [], tablePlayers),
    ...(clockNote ? [clockNote] : []),
    ...(recentChat
      ? [
          `Recent table chat (bracketed timers are wall-clock day time left when each line was said):\n${recentChat}`,
        ]
      : []),
    'Your notes about other players:',
    formatKnowledgeBase(mem, snapshot.players, claimedNames),
    'Your planned public claim (private intent — not yet on the board unless spoken):',
    mem.lastPlan?.claim ?? '(none)',
    currentVoteName
      ? `You already voted for ${currentVoteName}. Prefer keeping that vote unless new table info clearly warrants switching or clearing. Picking the same target keeps your vote (no change).`
      : '',
    'Choose exactly one legal action by index (0-based, must be in the list). Reply with exactly ONE JSON object — never multiple objects, never an array of choices:',
    '{"index": <number>, "notes": "<optional short reason>", "beliefUpdates":[{"aboutName":"Name","notes":"short"}]}',
    'Notes must match the action you pick (do not say you skipped/declined while selecting an action).',
    'Do NOT list alternate indexes or emit several JSON objects. Pick one index and stop.',
    'Voting tip: werewolf team should not vote fellow werewolves. Village: concentrate on a solid private wolf suspect; if you have no solid wolf after role accounting, pick a player who currently has 0 votes to help a 1-each spread. Prefer a named player vote over clearing your vote.',
    ...(claimsAccountForPrompt
      ? [
          'Role accounting: spoken claims currently fill the player seats with village roles and you have no private wolf — execute a 1-each / no-kill spread (vote someone with 0 votes). Do NOT invent wolf suspects, do NOT pile onto one seat (especially a unique leader), and do NOT clear/unvote — pick a 0-vote target and keep a spread.',
        ]
      : []),
    ...(game.phase === 'day' &&
    winTeam === 'werewolf' &&
    dealt === 'minion' &&
    allies.length === 0
      ? [
          'Minion with no seated wolves: village wins ONLY if nobody dies. FORCE a kill — concentrate votes on one village seat. Do NOT pitch or execute a 1-each / no-kill spread.',
        ]
      : []),
    ...(robTargetStory && winTeam === 'village'
      ? [
          `${robTargetStory.speakerName} claims they robbed YOU${robTargetStory.stolenRole ? ` (became ${robTargetStory.stolenRole})` : ''}. That is compatible with your night info — you would not feel a rob. Do NOT vote them just because you "didn't feel a swap" or think their Robber story "contradicts" your dealt role.`,
        ]
      : []),
  ]
    .filter(Boolean)
    .join('\n\n')

  const user = `Legal actions:\n${namedLegal.join('\n')}\n\nPick the best action for your goals.`

  const result = await aiJobQueue.enqueue(() =>
    chatWithConfig(provider, config, [
      { role: 'system', content: system },
      ...mem.chat.slice(-8),
      { role: 'user', content: user },
    ]),
  )

  appendAgentChat(gKey, npcId, { role: 'user', content: user })
  appendAgentChat(gKey, npcId, { role: 'assistant', content: result.text })

  let notes = parseNotes(result.text)
  const claimsAccount =
    game.phase === 'day' &&
    winTeam === 'village' &&
    peekedWolves.length === 0 &&
    spokenClaimsAccountForVillageSeats(game, publicBoard.entries)
  const minionForceKill =
    game.phase === 'day' &&
    winTeam === 'werewolf' &&
    dealt === 'minion' &&
    allies.length === 0
  const wantSpread =
    game.phase === 'day' &&
    winTeam === 'village' &&
    peekedWolves.length === 0 &&
    (notesWantVoteSpread(notes) ||
      inventsFalseRobberRules(notes ?? '') ||
      deniesConsistentRobberTargetStory(notes ?? '') ||
      claimsAccount)

  // When notes invent a skip/no-kill option, do not accept 1-based last-index remap.
  let idx = parseActionIndex(result.text, legal.length, {
    allowOneBasedLast: !wantSpread && !minionForceKill,
  })

  if (idx == null) {
    const afterSwap =
      peekedWolves.length > 0
        ? seerWolfVoteAfterClaimedSwap(game, npcId, peekedWolves, chatLines)
        : null
    const tmMoved = troublemakerMovedWolfTarget(game, npcId, chatLines)
    idx =
      preferVoteTarget(legal, tmMoved) ??
      (afterSwap && afterSwap !== npcId
        ? preferVoteTarget(legal, afterSwap)
        : null) ??
      (afterSwap === npcId
        ? null
        : preferSeerWolfVote(legal, peekedWolves)) ??
      (minionForceKill
        ? preferForceKillVote(legal, tallies)
        : null) ??
      (wantSpread ||
      (game.phase === 'day' &&
        winTeam === 'village' &&
        peekedWolves.length === 0)
        ? preferVillageSpreadVote(legal, tallies, {
            avoidPileOn: claimsAccount || wantSpread,
          })
        : null) ??
      (currentVote != null
        ? null
        : fallbackActionIndex(legal))
    // Reconsider with no clear signal — keep the current vote.
    if (idx == null && currentVote != null) return null
    if (idx == null) idx = fallbackActionIndex(legal)
  } else if (minionForceKill) {
    const forced = preferForceKillVote(legal, tallies)
    if (forced != null) idx = forced
  } else if (wantSpread) {
    const spread = preferVillageSpreadVote(legal, tallies, {
      avoidPileOn: true,
    })
    if (spread != null) idx = spread
  }

  // Claims account / no private wolf: never clear the vote — keep or move to a spread.
  if (
    claimsAccount &&
    legal[idx]?.type === 'werewolf.undoVote'
  ) {
    const spread = preferVillageSpreadVote(legal, tallies, {
      avoidPileOn: true,
    })
    if (spread != null) {
      idx = spread
    } else if (currentVote != null) {
      return null
    }
  }

  // Village pile-on with no private wolf + false "Robber can't be Seer" /
  // "Robber story contradicts my Mason because I didn't feel it" → spread.
  if (
    game.phase === 'day' &&
    winTeam === 'village' &&
    peekedWolves.length === 0 &&
    (inventsFalseRobberRules(notes ?? '') ||
      deniesConsistentRobberTargetStory(notes ?? '')) &&
    legal[idx]?.type === 'werewolf.vote'
  ) {
    const spread = preferVillageSpreadVote(legal, tallies, {
      avoidPileOn: true,
    })
    if (spread != null) idx = spread
  }

  // Reject invented "eliminate X as wolf" pile-ons when claims already account for seats.
  if (
    claimsAccount &&
    notesInventWolfWithoutEvidence(notes) &&
    legal[idx]?.type === 'werewolf.vote'
  ) {
    const spread = preferVillageSpreadVote(legal, tallies, {
      avoidPileOn: true,
    })
    if (spread != null) idx = spread
  }

  // Claims account: if model still piled onto a unique leader, force a lower seat.
  if (claimsAccount && legal[idx]?.type === 'werewolf.vote') {
    const pickedVote = legal[idx]!
    if (pickedVote.type === 'werewolf.vote') {
      const targetId = pickedVote.targetId
      const myTally = tallies.get(targetId) ?? 0
      const others = [...tallies.entries()].filter(([id]) => id !== targetId)
      const maxOther = others.reduce((m, [, n]) => Math.max(m, n), 0)
      const zeroExists = legal.some(
        (a) =>
          a.type === 'werewolf.vote' && (tallies.get(a.targetId) ?? 0) === 0,
      )
      const wouldLead = myTally + 1 > maxOther
      if (zeroExists || (wouldLead && myTally >= maxOther && maxOther > 0)) {
        const spread = preferVillageSpreadVote(legal, tallies, {
          avoidPileOn: true,
        })
        if (spread != null) idx = spread
      }
    }
  }

  // Reject team-violating vote rationales; fall back to peek / heat / random legal.
  if (
    game.phase === 'day' &&
    legal[idx]?.type === 'werewolf.vote' &&
    notesViolateTeam(notes, winTeam)
  ) {
    const afterSwap =
      peekedWolves.length > 0
        ? seerWolfVoteAfterClaimedSwap(game, npcId, peekedWolves, chatLines)
        : null
    const tmMoved = troublemakerMovedWolfTarget(game, npcId, chatLines)
    idx =
      preferVoteTarget(legal, tmMoved) ??
      (afterSwap && afterSwap !== npcId
        ? preferVoteTarget(legal, afterSwap)
        : null) ??
      (afterSwap === npcId
        ? null
        : preferSeerWolfVote(legal, peekedWolves)) ??
      (minionForceKill
        ? preferForceKillVote(legal, tallies)
        : preferVillageSpreadVote(legal, tallies, {
            avoidPileOn: claimsAccount,
          })) ??
      fallbackActionIndex(legal)
  }

  // Werewolf team: never accept a vote on a known ally even if model picked it.
  const picked = legal[idx]
  if (
    picked?.type === 'werewolf.vote' &&
    allies.includes(picked.targetId) &&
    winTeam === 'werewolf'
  ) {
    const alt = legal.findIndex(
      (a) => a.type === 'werewolf.vote' && !allies.includes(a.targetId),
    )
    if (alt >= 0) idx = alt
  }

  const chosen = legal[idx]!
  // Reconsider: picking the same target (or notes that say keep) means no change.
  if (
    chosen.type === 'werewolf.vote' &&
    currentVote != null &&
    chosen.targetId === currentVote
  ) {
    return null
  }
  const chosenLabel = actionLabel(chosen, snapshot)
  if (notesContradictAction(notes, chosenLabel)) {
    notes = chosenLabel
  }

  if (notes && !notesViolateTeam(notes, winTeam)) {
    // Night picks are intents; do not store speculative peek outcomes as facts.
    // Day speech was inventing "I saw X as werewolf" from "Peek X to check…".
    if (game.phase !== 'night') {
      updateBelief(gKey, npcId, npcId, notes)
    } else {
      updateBelief(gKey, npcId, npcId, `Night action: ${chosenLabel}`)
    }
  } else if (notes && dealt) {
    // Still record sanitized note without the violating rationale.
    updateBelief(gKey, npcId, npcId, `Acted with ${winTeam} team goals: ${chosenLabel}.`)
  }

  // Skip beliefUpdates on night — models often write hoped-for peek results.
  if (game.phase !== 'night') {
    for (const u of filterStaleNoClaimBeliefs(
      parseBeliefUpdatesFromText(
        extractFirstJsonObject(result.text) ?? result.text,
        snapshot.players.map((p) => p.name),
      ),
      claimedNames,
    )) {
      const aboutId = resolvePlayerIdByName(snapshot.players, u.aboutName)
      if (!aboutId || aboutId === npcId) continue
      if (notesViolateTeam(u.notes, winTeam)) continue
      if (deniesConsistentRobberTargetStory(u.notes)) continue
      // When village seats are already accounted for, drop invented wolf-hunt notes.
      if (
        claimsAccount &&
        (notesInventWolfWithoutEvidence(u.notes) ||
          /\b(?:suspect\s+as\s+wolf|werewolf|wolf)\b/i.test(u.notes))
      ) {
        continue
      }
      updateBelief(gKey, npcId, aboutId, u.notes)
    }
  }
  return actionToIntent(chosen)
}
