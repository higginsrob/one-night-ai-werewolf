import type { SessionSnapshot } from '../../net/protocol'
import type { ClientId } from '../../session/types'
import { aiTableName, type AiPlayerProfile } from '../aiPlayers'
import { loadAiStore } from '../aiStore'
import { chatWithConfig } from '../client'
import { aiJobQueue } from '../queue'
import {
  buildGlobalPublicClaimBoard,
  formatTablePressure,
  boardHasSpokenSwapStory,
  namesWithCompleteNightStory,
  normalizePlanClaim,
  formatRoleDeckHand,
  rolesInPlayLabels,
  lockedSpokenClaimForPlayer,
  spokenClaimForPlayer,
  spokenClaimsAccountForVillageSeats,
  spokenRobberStoryTargeting,
  overclaimedRoles,
  isInfoClaimRole,
  type SpokenNightStory,
  incompleteNightStories,
} from './claimLedger'
import {
  formatDayClockNote,
  formatRecentChatForAgent,
  dayMsLeftNow,
} from './chatTime'
import {
  filterStaleNoClaimBeliefs,
  parseBeliefUpdates,
} from './beliefParse'
import {
  preferredTannerCoverClaim,
  preferredWerewolfCoverClaim,
  seerPeekedWolfNames,
  knownWolfAllyNames,
  stripOutOfDeckRoles,
  winTeamFromPrivate,
  rolesNotInPlay,
  inventsFabricatedNightCardStory,
  inventsSeerPeekContradiction,
  assumesUnrecordedNightSwap,
  claimsUnownedFirstPersonTroublemakerSwap,
  seatHasRecordedNightSwap,
  seatHasSeerPeekToChallengeWith,
  villageMustNotInventNightCardStory,
  inventsFalseRobberRules,
  deniesConsistentRobberTargetStory,
  robberInventedExtraPeek,
  type WinTeam,
} from './guardrails'
import { formatKnowledgeBase, getAgentMemory } from './memory'
import {
  buildPrivateObservation,
  robberNightResult,
  seerNightPeek,
} from './privateView'
import { roleName } from '../../game/roles'
import { SAFETY_GUARDRAILS, teamStrategyForSeat } from './teamStrategy'
import { formatTablePlayerBios } from './tableBios'
import { myDealtRole, playersWithDealtRole } from '../../game/werewolfLogic'
import type { WerewolfRole, WerewolfSnapshot } from '../../game/werewolfTypes'
import type { ChatLine } from '../../session/types'

/** Info / dangerous claims a no-peek Villager should not open with. */
const VILLAGER_AVOID_CLAIMS = new Set([
  'Seer',
  'Robber',
  'Troublemaker',
  'Insomniac',
  'Drunk',
  'Mason',
  'Werewolf',
  'Minion',
])

const VILLAGE_FORBIDDEN_CLAIMS = new Set(['Werewolf', 'Minion'])
const TANNER_FORBIDDEN_CLAIMS = new Set(['Tanner'])

/** Village info roles should default-claim their dealt role, not blank Villager. */
const VILLAGE_INFO_DEALT = new Set<WerewolfRole>([
  'seer',
  'robber',
  'troublemaker',
  'insomniac',
  'drunk',
  'mason',
  'hunter',
])

export type DayPlan = {
  claim: string | null
  suspects: string[]
  goal: string
  answerDirectly: boolean
  beliefUpdates: Array<{ aboutName: string; notes: string }>
}

export function emptyDayPlan(): DayPlan {
  return {
    claim: null,
    suspects: [],
    goal: 'Listen and stay consistent',
    answerDirectly: true,
    beliefUpdates: [],
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseDayPlan(text: string, playerNames: string[] = []): DayPlan {
  const fallback = emptyDayPlan()
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return fallback
  try {
    const obj = JSON.parse(match[0]) as {
      claim?: unknown
      suspects?: unknown
      goal?: unknown
      answerDirectly?: unknown
      beliefUpdates?: unknown
    }
    const claim =
      typeof obj.claim === 'string' && obj.claim.trim()
        ? obj.claim.trim().slice(0, 40)
        : null
    const suspects = Array.isArray(obj.suspects)
      ? obj.suspects
          .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          .map((s) => s.trim().slice(0, 32))
          .slice(0, 4)
      : []
    const goal =
      typeof obj.goal === 'string' && obj.goal.trim()
        ? obj.goal.trim().slice(0, 200)
        : fallback.goal
    const answerDirectly =
      typeof obj.answerDirectly === 'boolean' ? obj.answerDirectly : true
    const beliefUpdates = parseBeliefUpdates(obj.beliefUpdates, playerNames)
    return { claim, suspects, goal, answerDirectly, beliefUpdates }
  } catch {
    return fallback
  }
}

/** True when classifier output contains usable day-plan JSON (not prose / stage directions). */
export function dayPlanRawLooksValid(raw: string): boolean {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return false
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false
    // Require at least claim or goal key so dialogue blobs don't pass.
    if (!('claim' in obj) && !('goal' in obj)) return false
    // Reject when "claim" is a whole sentence / spoken line.
    if (typeof obj.claim === 'string') {
      const c = obj.claim.trim()
      if (c.length > 40 || /[.!?]/.test(c) || /\b(?:i|you|we)\s+/i.test(c)) {
        return false
      }
    }
    // Reject stage-direction / dialogue-shaped goals that ate the whole blob.
    if (typeof obj.goal === 'string') {
      const g = obj.goal.trim()
      if (
        /^\(/.test(g) ||
        /^["']/.test(g) ||
        /\byou\s+(?:lean|smile|pause|begin)\b/i.test(g)
      ) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

export function formatDayPlan(plan: DayPlan, speakerName?: string): string {
  const who = speakerName?.trim() || 'the human'
  return [
    `Public claim to stick to: ${plan.claim ?? '(undecided)'}`,
    `Private suspects (for voting/notes — do NOT accuse them aloud unless this goal needs one light poke): ${plan.suspects.length ? plan.suspects.join(', ') : '(none)'}`,
    `Goal this line: ${plan.goal}`,
    speakerName?.trim()
      ? `Answer ${who} directly: ${plan.answerDirectly ? 'yes' : 'no — deflect/redirect'}`
      : `Volunteer line (no one to answer): ${plan.answerDirectly ? 'still framed as a reply — prefer a fresh question/statement' : 'yes — open contribution'}`,
  ].join('\n')
}

/** Private plan step (classifier model preferred). Never spoken aloud. */
export async function planDayReply(args: {
  snapshot: SessionSnapshot
  npcId: ClientId
  profile: AiPlayerProfile
  humanTranscript: string
  humanFromId?: ClientId | null
  gameKey: string
  /** Host prompted this seat to volunteer — plan a contribution, not a reply. */
  proactive?: boolean
}): Promise<{ plan: DayPlan; raw: string; modelId: string | null }> {
  const {
    snapshot,
    npcId,
    profile,
    humanTranscript,
    humanFromId = null,
    gameKey,
    proactive = false,
  } = args
  const game = snapshot.game
  if (!game) {
    return { plan: emptyDayPlan(), raw: '', modelId: null }
  }

  const store = loadAiStore()
  const configId =
    store.activeClassifierConfigId ?? store.activeWorkConfigId
  const config = store.modelConfigs.find((c) => c.id === configId)
  const provider = config
    ? store.providers.find((p) => p.id === config.providerId)
    : null
  if (!config || !provider) {
    return { plan: emptyDayPlan(), raw: '', modelId: null }
  }

  const mem = getAgentMemory(gameKey, npcId)
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

  const speaker =
    !proactive && humanFromId
      ? snapshot.players.find((p) => p.id === humanFromId) ?? null
      : null
  const speakerName = speaker?.name ?? 'a human'

  const inPlay = rolesInPlayLabels(game)
  const notInPlay = rolesNotInPlay(game)
  const priorClaim = lockedSpokenClaimForPlayer(
    snapshot.chatLines ?? [],
    npcId,
    tablePlayers,
  )
  const wolfNames = seerPeekedWolfNames(game, npcId)
  const nightStoryNames = namesWithCompleteNightStory(publicBoard.stories)
  const clockNote = formatDayClockNote(game)
  const recentChat = formatRecentChatForAgent(snapshot.chatLines ?? [], 12)
  const system = [
    `You are planning privately for ${aiTableName(profile)} in One Night Ultimate Werewolf.` +
      (profile.nickname.trim() &&
      profile.nickname.trim().toLowerCase() !== aiTableName(profile).toLowerCase()
        ? ` Goes by ${profile.nickname.trim()}.`
        : ''),
    profile.title?.trim()
      ? `Persona: ${profile.persona} · Title: ${profile.title.trim()}`
      : `Persona: ${profile.persona}`,
    formatTablePlayerBios(snapshot.players, npcId),
    SAFETY_GUARDRAILS,
    'Return JSON only (not spoken dialogue). No stage directions, no markdown fences, no prose before or after the JSON object:',
    '{"claim":"<role name from claimable roles, or null>","suspects":["Name"],"goal":"<what this reply should accomplish>","answerDirectly":true,"beliefUpdates":[{"aboutName":"Name","notes":"short"}]}',
    'claim MUST be exactly one role name from the claimable roles list (or null). Never put a sentence/goal in claim.',
    'goal MUST be a short planning instruction (under 160 chars), not spoken dialogue or stage directions.',
    'beliefUpdates MUST use keys aboutName and notes (not aboutRob). Use exact player names.',
    'beliefUpdates are for DAY talk — never plan to peek/look at someone "tonight" (night is over).',
    'Public claim board = what was SAID (may be lies). If it shows a claim or night story, do not write "no claim yet" and do not re-ask that role/story. A named peek ("I saw X as Y") or named center roles is complete — never demand "more detail" / "what did the stolen card look like." Vague "I peeked center" without roles is incomplete — ask which cards.',
    'Night stories on the board are first-person only. Do not treat "X says Y swapped A and B" as Y\'s night story unless Y themselves said they swapped.',
    'Do not plan goals that assume a night swap ("after the swap", "was the card swapped") unless YOUR private info records a swap you did OR a first-person Robber/Troublemaker swap is already on the claim board.',
    'Weigh board entries against private night info and deck counts — never treat public claims as ground truth.',
    'If a Seer peeks YOU as the role you were dealt, that is CONFIRMATION of the Seer — clear them from suspects; pressure conflicting claimants instead.',
    'Mason / no-peek seats: never plan that a Seer peek "doesn\'t line up with what I saw" — you did not see their peek. Clear matching peeks; interview elsewhere.',
    'Dealt Mason + Robber→Mason is NORMAL — do not plan goals that treat "three Masons" as automatic overclaim. Count role claims (Robber + Masons), not "became Mason" as an extra Mason claim.',
    proactive
      ? 'No one just spoke to you — you are volunteering the next table line. Set answerDirectly false. Goal should be a short question or statement that advances discussion from recent chat.'
      : `The latest spoken line is from ${speakerName} only. Do not attribute that line (or its claim) to any other player.`,
    'Rules: protect your team; werewolves / Minion / Robber-who-became-wolf must NEVER list known wolves in suspects, accuse them, or plan to vote them — pick other seats; werewolves / Robber-who-became-wolf must NEVER set claim to Werewolf or Minion — pick a village cover (Robber, Villager, etc.) and lie about night results; Tanner must NEVER set claim to Tanner — pick a village cover and plan slightly clumsy deceit to draw votes; Troublemaker should claim Troublemaker and plan to say "I swapped A and B" (never accuse someone else of your swap); stay consistent with prior spoken village claims; beliefUpdates are about OTHER players; do not invent night peeks/swaps/"picked up a card" stories that are not in your private info.',
    'Spoken claim hygiene: plan exactly ONE role claim — never a goal that also offers to "play" a second different role.',
    'If private info says Night info: none (or no peek/swap recorded), your goal must NOT invent peeks, swaps, or stolen roles — claim without a night story and interview others.',
    'If someone\'s spoken claim matches your private night info, that is CONFIRMATION — clear them from suspects and note they are consistent. Never call a matching peek+claim a "contradiction."',
    'Insomniac (unchanged card) / Villager / Hunter often have no extra night story beyond their role — do not demand peeks they cannot have.',
    'Never set a goal like "clarify who still needs a night story" when the only seats without stories claimed Villager/Hunter — those claims are complete without a night action. Prefer role-count conflicts, incomplete Seer/Robber/TM stories, or a named interview of an unclaimed seat.',
    'Robber looking at the stolen card (and becoming Seer/Mason/etc.) is NORMAL — never mark that as impossible, illegal, or a wolf tell in suspects/beliefUpdates/goal.',
    'A Robber who names rob target + stolen role has a complete night story — do not demand a Seer-style peek of the target\'s face or ask what the stolen card "looked like."',
    'If a first-person Robber story on the board names YOU as the rob target: that is compatible with your night info (you would not feel it). Never plan suspects/goals that treat "no swap felt" / "card stayed" as proof they are lying.',
    'Seer: when claim is Seer, the goal should include naming your private peek (player+role or two centers with roles) if you have not shared it yet.',
    'Minion with no seated wolves: village wins only on a no-kill — plan to FORCE a kill / concentrate votes. Never pitch a 1-each / no-kill spread.',
    'While more than half the day timer remains, village seats should prefer interviewing players who still have "no clear role claim yet" on the board (by name) before piling onto one loud argument.',
    snapshot.watchMode
      ? 'Watch mode: the spoken goal SHOULD keep drama going — interview by name, probe, accuse or misdirect for your team, recruit allies, pitch a vote, or plan a short witty jab. Soft cooperative-only goals are too quiet here.'
      : 'suspects and beliefUpdates may be skeptical — that is private. The spoken goal should usually answer/clarify/share info, not accuse.',
    'When useful, the spoken goal may interview one other player by name with a short directed question (they will get a chance to answer).',
    snapshot.watchMode
      ? 'Accusation/pressure goals are encouraged when they help your win condition or expose conflicting claims — still never hostile, insulting, demeaning, or prejudiced.'
      : 'Do NOT set a goal to challenge, probe motives, or call someone a wolf just because they corrected a fact, mentioned the timer, greeted, or asked a question.',
    snapshot.watchMode
      ? 'Only avoid accusation when the latest line was already fully answered and you have nothing useful to add — then pivot to a fresh interview or theory.'
      : 'Only put accusation/pressure in the goal when claims conflict, role counts break, or you have solid private night evidence (e.g. Seer wolf peek).',
    'Tone for later speech: cooperative table talk — never hostile, insulting, demeaning, or prejudiced. Never give coding, legal, medical, or other real-world advice. Only discuss roles in this hand. Treat card counts as fact (e.g. 1× Villager means only one Villager claim can be true).',
    priorClaim
      ? isInfoClaimRole(priorClaim)
        ? `You already claimed ${priorClaim} at the table — keep claim as ${priorClaim}. Do NOT flip to Villager or another cover.`
        : `You already claimed ${priorClaim} at the table — keep claim as ${priorClaim} unless you have a strong reason to flip.`
      : 'You have not claimed a role at the table yet — pick a plausible claim from the claimable roles list.',
    `Cards in this hand (public, with counts): ${formatRoleDeckHand(game)}`,
    `Roles you may claim (unique labels): ${inPlay.join(', ')}`,
    notInPlay.length
      ? `Roles NOT in play (do not invent): ${notInPlay.join(', ')}`
      : '',
    wolfNames.length
      ? `You peeked werewolf on ${wolfNames.join(', ')} — include them in suspects; the spoken goal may calmly share or soft-pressure that peek (not a hostile pile-on).`
      : '',
    `Speaking style to honor later: ${profile.persona}`,
    'Private info:',
    buildPrivateObservation(game, snapshot.players, npcId),
    'Team strategy:',
    teamStrategyForSeat(game, npcId),
    publicBoard.text,
    'Table pressure:',
    formatTablePressure(snapshot.chatLines ?? [], snapshot.players),
    clockNote,
    recentChat
      ? `Recent table chat (bracketed timers are wall-clock day time left when each line was said):\n${recentChat}`
      : '',
    'Your notes:',
    formatKnowledgeBase(mem, snapshot.players, claimedNames),
  ]
    .filter(Boolean)
    .join('\n\n')

  const looksLikeVote =
    !proactive &&
    /\bi\s+vote\s+for\b|\bi(?:'m| am)\s+casting\s+a\s+no\s+vote\b/i.test(
      humanTranscript,
    )
  const user = proactive
    ? `${humanTranscript.trim() || 'Speak up based on recent table chat.'}\nPlan ${aiTableName(profile)}'s next spoken contribution (question or statement) to the group.`
    : looksLikeVote
      ? `${speakerName} just cast a vote: "${humanTranscript.trim()}"\nPlan ${aiTableName(profile)}'s spoken reaction to this vote.`
      : `${speakerName} just said: "${humanTranscript.trim()}"\nPlan ${aiTableName(profile)}'s next spoken reply to ${speakerName}.`

  const playerNames = snapshot.players.map((p) => p.name)
  const harden = (raw: string) =>
    hardenDayPlan(parseDayPlan(raw, playerNames), {
      rolesInPlay: inPlay,
      priorSpokenClaim: priorClaim,
      dealt,
      winTeam: winTeamFromPrivate(game, npcId),
      seerWolfNames: wolfNames,
      game,
      players: snapshot.players,
      chatLines: snapshot.chatLines ?? [],
      npcId,
      claimedNames,
      nightStories: publicBoard.stories,
      nightStoryNames,
    })

  const jsonOnlyRetry =
    'Return ONLY one JSON object matching the schema. No dialogue, no stage directions, no markdown fences, no prose before or after the JSON. Example: {"claim":"Mason","suspects":[],"goal":"Ask Carrie which center roles she saw","answerDirectly":true,"beliefUpdates":[]}'

  try {
    const result = await aiJobQueue.enqueue(() =>
      chatWithConfig(provider, config, [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ]),
    )
    let raw = result.text
    let classifierOk = dayPlanRawLooksValid(raw)
    if (!classifierOk) {
      try {
        const retry = await aiJobQueue.enqueue(() =>
          chatWithConfig(provider, config, [
            { role: 'system', content: system },
            { role: 'user', content: user },
            { role: 'assistant', content: raw.slice(0, 1200) },
            { role: 'user', content: jsonOnlyRetry },
          ]),
        )
        if (dayPlanRawLooksValid(retry.text)) {
          raw = retry.text
          classifierOk = true
        } else {
          // Classifier returned prose twice — deterministic harden on empty plan.
          raw = ''
          classifierOk = false
        }
      } catch {
        raw = dayPlanRawLooksValid(raw) ? raw : ''
        classifierOk = Boolean(raw)
      }
    }
    return {
      plan: harden(raw),
      // Keep invalid prose out of export traces when we fell back.
      raw: classifierOk ? raw : '',
      modelId: config.modelId,
    }
  } catch {
    // Planner failure must not block spoken day replies.
    return { plan: harden(''), raw: '', modelId: config.modelId }
  }
}

export type HardenDayPlanOpts = {
  rolesInPlay: string[]
  priorSpokenClaim: string | null
  dealt?: WerewolfRole | null
  winTeam?: WinTeam
  seerWolfNames?: string[]
  game?: WerewolfSnapshot | null
  players?: SessionSnapshot['players']
  chatLines?: SessionSnapshot['chatLines']
  npcId?: ClientId | null
  claimedNames?: Set<string>
  nightStories?: SpokenNightStory[]
  nightStoryNames?: Set<string>
}

/** True when a goal re-asks someone for a role/night story they already gave. */
export function goalReasksKnownInfo(
  goal: string,
  claimedNames: Set<string>,
  nightStoryNames: Set<string>,
): string | null {
  // Complete night story → never re-interview that peek / demand more detail.
  for (const name of nightStoryNames) {
    const named = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(goal)
    const aboutPeek =
      /\b(?:seer\s+peek|(?:his|her|their|the|your)\s+peek|peek)\b/i.test(goal)
    const wantsDetail =
      /\b(?:ask|clarif\w*|detail|more\s+info|what\s+made|walk\s+(?:me|us)\s+through|explain|premature|stolen\s+card|looked\s+like|actual\s+role|role\s+you\s+grabbed)\b/i.test(
        goal,
      )
    if ((named || aboutPeek) && wantsDetail) return name
  }

  // Role already claimed → don't ask "what were you / what did you wake as".
  for (const name of claimedNames) {
    if (
      new RegExp(
        `\\b(?:ask|what|interview)\\b.{0,40}\\b${escapeRegExp(name)}\\b.{0,50}\\b(?:wake|woke|role|were\\s+you|are\\s+you|end\\s+up)|\\b${escapeRegExp(name)}\\b.{0,30}\\bwhat\\s+(?:did|were|are|do)\\s+you\\b|\\b${escapeRegExp(name)}\\b.{0,40}\\b(?:no\\s+role\\s+claim|still\\s+have\\s+no)\\b`,
        'i',
      ).test(goal)
    ) {
      return name
    }
  }
  return null
}

/** Names whose spoken claims match this seat's private night facts. */
export function namesClearedByPrivateInfo(
  game: WerewolfSnapshot,
  npcId: ClientId,
  chatLines: ChatLine[],
  nightStories: SpokenNightStory[] = [],
): string[] {
  const cleared: string[] = []
  const nameOf = (id: string) => game.playerNames[id] ?? id
  const dealt = myDealtRole(game, npcId)
  const dealtLabel = dealt ? roleName(dealt) : null

  if (dealt === 'robber') {
    const rob = game.nightActions.robber
    if (rob?.playerId === npcId) {
      const stolen = roleName(rob.stolenRole)
      const spoken = spokenClaimForPlayer(chatLines, rob.targetId)
      if (spoken && spoken.toLowerCase() === stolen.toLowerCase()) {
        cleared.push(nameOf(rob.targetId))
      }
    }
  }

  if (dealt === 'seer') {
    const seer = game.nightActions.seer
    if (seer?.playerId === npcId && seer.view.kind === 'player') {
      const peeked = seer.view.role
      if (peeked !== 'werewolf') {
        const spoken = spokenClaimForPlayer(chatLines, seer.view.targetId)
        const peekedLabel = roleName(peeked)
        if (spoken && spoken.toLowerCase() === peekedLabel.toLowerCase()) {
          cleared.push(nameOf(seer.view.targetId))
        }
        // Peeked Robber who now claims Seer (after a rob) is often consistent.
        if (peeked === 'robber' && spoken?.toLowerCase() === 'seer') {
          cleared.push(nameOf(seer.view.targetId))
        }
      }
    }
  }

  // Reverse: someone peeks YOU as your dealt role → clear them (confirming Seer).
  if (dealtLabel) {
    for (const story of nightStories) {
      if (story.kind !== 'seer-player') continue
      if (story.targetId !== npcId) continue
      const peekRole = story.role.toLowerCase()
      const matchesDealt = peekRole === dealtLabel.toLowerCase()
      const matchesRobberAsRobber =
        dealt === 'robber' && peekRole === 'robber'
      if (!matchesDealt && !matchesRobberAsRobber) continue
      cleared.push(story.speakerName)
    }
  }

  // Robber story naming YOU and stealing your dealt role is compatible —
  // robbed seats do not feel the swap (e.g. Mason + "I robbed you → Mason").
  if (dealtLabel) {
    for (const story of nightStories) {
      if (story.kind !== 'robber') continue
      if (story.targetId !== npcId) continue
      if (
        story.stolenRole &&
        story.stolenRole.toLowerCase() === dealtLabel.toLowerCase()
      ) {
        cleared.push(story.speakerName)
      }
    }
  }

  // Mason: Robber story naming your mason partner and becoming Mason is compatible.
  if (dealt === 'mason') {
    const fellows = playersWithDealtRole(game, 'mason').filter((id) => id !== npcId)
    for (const story of nightStories) {
      if (story.kind !== 'robber') continue
      if (!fellows.includes(story.targetId)) continue
      if (story.stolenRole?.toLowerCase() === 'mason') {
        cleared.push(story.speakerName)
      }
    }
  }

  return [...new Set(cleared)]
}

/** Clamp claim to a real deck role; prefer an already-spoken table claim. */
export function hardenDayPlan(
  plan: DayPlan,
  rolesInPlayOrOpts: string[] | HardenDayPlanOpts,
  priorSpokenClaimArg?: string | null,
  dealtArg: WerewolfRole | null = null,
): DayPlan {
  const opts: HardenDayPlanOpts = Array.isArray(rolesInPlayOrOpts)
    ? {
        rolesInPlay: rolesInPlayOrOpts,
        priorSpokenClaim: priorSpokenClaimArg ?? null,
        dealt: dealtArg,
      }
    : rolesInPlayOrOpts

  const {
    rolesInPlay,
    priorSpokenClaim,
    dealt = null,
    winTeam = 'unknown',
    seerWolfNames = [],
    game = null,
    players = [],
    chatLines = [],
    npcId = null,
    claimedNames = new Set<string>(),
    nightStories = [],
    nightStoryNames = new Set<string>(),
  } = opts

  let claim = normalizePlanClaim(plan.claim, rolesInPlay)
  if (priorSpokenClaim) {
    const prior = normalizePlanClaim(priorSpokenClaim, rolesInPlay)
    // Locked info claims (Seer/TM/Robber/…) and any prior stick for the rest of day.
    if (prior) claim = prior
  } else if (dealt === 'villager') {
    // No-peek villagers inventing Seer/TM/Robber stories collapses table logic.
    if (!claim || VILLAGER_AVOID_CLAIMS.has(claim)) {
      claim = rolesInPlay.includes('Villager')
        ? 'Villager'
        : (normalizePlanClaim(roleName(dealt), rolesInPlay) ?? claim)
    }
  }

  // Village-aligned seats must not silently plan-claim Werewolf/Minion.
  if (
    winTeam === 'village' &&
    claim &&
    VILLAGE_FORBIDDEN_CLAIMS.has(claim) &&
    !priorSpokenClaim
  ) {
    claim = rolesInPlay.includes('Villager')
      ? 'Villager'
      : dealt
        ? (normalizePlanClaim(roleName(dealt), rolesInPlay) ?? null)
        : null
  }

  // Werewolf-team seats must not plan-claim Werewolf/Minion (suicide claim).
  // Even if they already blurted it once, steer future plans back to a cover.
  if (winTeam === 'werewolf') {
    const priorNorm = priorSpokenClaim
      ? normalizePlanClaim(priorSpokenClaim, rolesInPlay)
      : null
    const priorIsWolf =
      !!priorNorm && VILLAGE_FORBIDDEN_CLAIMS.has(priorNorm)
    if (!claim || VILLAGE_FORBIDDEN_CLAIMS.has(claim) || priorIsWolf) {
      const cover = preferredWerewolfCoverClaim(dealt, rolesInPlay)
      if (cover) claim = cover
    }
  }

  // Tanner must not plan-claim Tanner (too direct). Cover + clumsy deceit instead.
  if (winTeam === 'neutral') {
    const priorNorm = priorSpokenClaim
      ? normalizePlanClaim(priorSpokenClaim, rolesInPlay)
      : null
    const priorIsTanner =
      !!priorNorm && TANNER_FORBIDDEN_CLAIMS.has(priorNorm)
    if (!claim || TANNER_FORBIDDEN_CLAIMS.has(claim) || priorIsTanner) {
      const cover = preferredTannerCoverClaim(rolesInPlay)
      if (cover) claim = cover
    }
  }

  // Village info seats (esp. Troublemaker): prefer honest dealt claim over soft Villager.
  // Seer with a recorded peek: force Seer unless they already soft-claimed another cover
  // without sharing the peek yet.
  if (
    !priorSpokenClaim &&
    winTeam === 'village' &&
    (dealt === 'troublemaker' || dealt === 'insomniac')
  ) {
    const dealtLabel = roleName(dealt)
    if (
      dealtLabel &&
      rolesInPlay.includes(dealtLabel) &&
      (!claim || claim === 'Villager')
    ) {
      claim = dealtLabel
    }
  }

  if (
    winTeam === 'village' &&
    dealt === 'seer' &&
    rolesInPlay.includes('Seer') &&
    game &&
    npcId &&
    seerNightPeek(game, players, npcId)
  ) {
    const priorNorm = priorSpokenClaim
      ? normalizePlanClaim(priorSpokenClaim, rolesInPlay)
      : null
    const sharedPeek = chatLines.some((l) => {
      if (l.fromId !== npcId) return false
      const peek = seerNightPeek(game, players, npcId)
      if (!peek) return false
      if (peek.kind === 'player') {
        return (
          l.text.toLowerCase().includes(peek.targetName.toLowerCase()) &&
          l.text.toLowerCase().includes(peek.roleLabel.toLowerCase()) &&
          /\b(?:saw|peeked|looked|checked)\b/i.test(l.text)
        )
      }
      return /\bcenter\b/i.test(l.text) && /\b(?:saw|peeked|looked)\b/i.test(l.text)
    })
    // Sharing (or about to share) a Seer peek: never let claim drift to Robber/etc.
    if (sharedPeek || !priorNorm || priorNorm === 'Seer') {
      claim = 'Seer'
    }
  }

  if (!claim) {
    // Village info seats: prefer honest dealt-role claim over blank Villager cover.
    // (Werewolf/Tanner covers are handled above; null there falls through.)
    const dealtLabel = dealt ? roleName(dealt) : null
    if (
      winTeam === 'village' &&
      dealt &&
      VILLAGE_INFO_DEALT.has(dealt) &&
      dealtLabel &&
      rolesInPlay.includes(dealtLabel)
    ) {
      claim = dealtLabel
    } else if (rolesInPlay.includes('Villager')) {
      claim = 'Villager'
    }
  }

  let suspects = [...plan.suspects]
  let goal = plan.goal
  let beliefUpdates = filterStaleNoClaimBeliefs(
    plan.beliefUpdates,
    claimedNames,
  )

  // Werewolf team: never list known packmates / Minion-seen wolves as suspects.
  if (winTeam === 'werewolf' && game && npcId) {
    const allyNames = knownWolfAllyNames(game, npcId)
    if (allyNames.length > 0) {
      suspects = suspects.filter(
        (s) => !allyNames.some((a) => a.toLowerCase() === s.toLowerCase()),
      )
      const allyInGoal = allyNames.some((name) =>
        new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(goal),
      )
      if (
        allyInGoal &&
        /\b(?:vote|kill|eliminate|accus|suspect|pressure|wolf|werewolf|minion|challenge|target)\b/i.test(
          goal,
        )
      ) {
        const others = [...claimedNames].filter(
          (n) =>
            !allyNames.some((a) => a.toLowerCase() === n.toLowerCase()) &&
            n.toLowerCase() !==
              (game.playerNames[npcId] ?? '').toLowerCase(),
        )
        const decoy = others[0] ?? 'a quiet villager'
        goal =
          `Protect ${allyNames.join(' and ')} — do not accuse or vote them. Misdirect heat onto ${decoy} or another shaky village claim.`.slice(
            0,
            200,
          )
      }
      for (const name of allyNames) {
        const existing = beliefUpdates.find(
          (b) => b.aboutName.toLowerCase() === name.toLowerCase(),
        )
        const protectNote = 'Known wolf ally — protect; never accuse or vote.'
        if (existing) {
          if (
            /\b(?:suspect|wolf|werewolf|accus|liar|bluff|hiding|vote)\b/i.test(
              existing.notes,
            )
          ) {
            existing.notes = protectNote
          }
        } else {
          beliefUpdates = [
            ...beliefUpdates,
            { aboutName: name, notes: protectNote },
          ].slice(0, 4)
        }
      }
    }
  }

  // Troublemaker: volunteer swap names until spoken at the table.
  if (dealt === 'troublemaker' && game && npcId) {
    const tm = game.nightActions.troublemaker
    if (tm?.playerId === npcId) {
      const aName = game.playerNames[tm.a] ?? tm.a
      const bName = game.playerNames[tm.b] ?? tm.b
      const shared = chatLines.some((l) => {
        if (l.fromId !== npcId) return false
        const n = l.text.toLowerCase()
        return (
          n.includes(aName.toLowerCase()) &&
          n.includes(bName.toLowerCase()) &&
          /\bi\s+(?:swapped|switched|shuffled)\b/i.test(l.text)
        )
      })
      // Scrub goals that accuse someone else of the TM's own swap.
      if (
        /\byou\s+(?:swapped|switched)\b/i.test(goal) ||
        (/\b(?:swapped|switched)\b/i.test(goal) &&
          !/\bi\s+(?:swapped|switched|shuffled)\b/i.test(goal) &&
          !/\bclaim\s+troublemaker\b/i.test(goal))
      ) {
        goal =
          `Claim Troublemaker and say you swapped ${aName} and ${bName} (roles unknown). Interview someone else if needed.`.slice(
            0,
            200,
          )
      }
      if (!shared) {
        const namesInGoal =
          new RegExp(`\\b${escapeRegExp(aName)}\\b`, 'i').test(goal) &&
          new RegExp(`\\b${escapeRegExp(bName)}\\b`, 'i').test(goal)
        if (
          !namesInGoal ||
          !/\bi\s+(?:swapped|switched)|(?:swap|switch|troublemaker)\b/i.test(
            goal,
          )
        ) {
          goal =
            `Claim Troublemaker and name that you swapped ${aName} and ${bName} (roles unknown). ${goal}`.slice(
              0,
              200,
            )
        }
      }
    }
  }

  // Werewolf team: scrub goals that explicitly plan a wolf confession.
  if (
    winTeam === 'werewolf' &&
    /\b(?:establish|volunteer|admit|confess|claim(?:ing)?)\b.{0,40}\b(?:werewolf|wolf|minion)\b|\bwerewolf\s+claim\b/i.test(
      goal,
    )
  ) {
    goal =
      'Stick to a village cover claim; do not confess wolf. Probe others and stay consistent.'.slice(
        0,
        200,
      )
  }

  // Tanner: scrub goals that plan an outright Tanner confession / "please kill me".
  if (
    winTeam === 'neutral' &&
    /\b(?:establish|volunteer|admit|confess|claim(?:ing)?)\b.{0,40}\btanner\b|\btanner\s+claim\b|\bwin\s+if\s+i\s+die\b|\bask(?:ing)?\s+(?:them|people|the\s+table)\s+to\s+(?:vote|kill)\s+me\b/i.test(
      goal,
    )
  ) {
    goal =
      'Claim a village cover; lie a little clumsily to draw suspicion and votes — do not name Tanner.'.slice(
        0,
        200,
      )
  }

  // Block goals that re-ask a role/peek already on the ledger.
  const reaskWho = goalReasksKnownInfo(goal, claimedNames, nightStoryNames)
  if (reaskWho) {
    const others = [...claimedNames].filter(
      (n) => n.toLowerCase() !== reaskWho.toLowerCase(),
    )
    const conflictHint =
      others.length > 0
        ? `Pressure conflicting claims (e.g. vs ${others[0]}) using role counts.`
        : 'Move on — interview someone else or do role accounting.'
    goal =
      `${reaskWho} already gave a clear role/night story — do not re-ask. ${conflictHint}`.slice(
        0,
        200,
      )
  }

  // Clear players whose claims match private night facts.
  if (game && npcId) {
    const cleared = namesClearedByPrivateInfo(
      game,
      npcId,
      chatLines,
      nightStories,
    )
    if (cleared.length > 0) {
      suspects = suspects.filter(
        (s) => !cleared.some((c) => c.toLowerCase() === s.toLowerCase()),
      )
      const clearedHitGoal = cleared.some((name) =>
        new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(goal),
      )
      if (
        clearedHitGoal &&
        /\b(?:contradict|hiding|dodg|evasive|liar|pressure|suspect|challenge|accus)/i.test(
          goal,
        )
      ) {
        const who = cleared.join(' and ')
        goal =
          `Confirm ${who} ${cleared.length === 1 ? 'matches' : 'match'} your private night info, then ask someone else a useful role question.`.slice(
            0,
            200,
          )
      }
      for (const name of cleared) {
        const existing = beliefUpdates.find(
          (b) => b.aboutName.toLowerCase() === name.toLowerCase(),
        )
        if (existing) {
          if (
            /\b(?:contradict|hiding|dodg|evasive|liar|suspect|bluff)/i.test(
              existing.notes,
            )
          ) {
            existing.notes =
              'Claim matches my private night info — cleared for now.'
          }
        } else {
          beliefUpdates = [
            ...beliefUpdates,
            {
              aboutName: name,
              notes: 'Claim matches my private night info — cleared for now.',
            },
          ].slice(0, 4)
        }
      }
    }
  }

  // Force Seer wolf peeks into suspects / goal bias.
  if (seerWolfNames.length > 0) {
    for (const name of seerWolfNames) {
      if (!suspects.some((s) => s.toLowerCase() === name.toLowerCase())) {
        suspects = [name, ...suspects].slice(0, 4)
      }
    }
    const sharedPeek =
      npcId &&
      chatLines.some(
        (l) =>
          l.fromId === npcId &&
          seerWolfNames.some((n) =>
            l.text.toLowerCase().includes(n.toLowerCase()),
          ) &&
          /\b(werewolf|wolf|seer|saw|peek)/i.test(l.text),
      )
    if (!sharedPeek) {
      const target = seerWolfNames[0]!
      if (!/challenge|accuse|pressure|reveal|peek|wolf|share/i.test(goal)) {
        goal = `Calmly share or soft-pressure ${target} using your Seer wolf peek; do not protect them. ${goal}`.slice(
          0,
          200,
        )
      }
    }
  } else if (game && npcId && myDealtRole(game, npcId) === 'seer') {
    // Village / center peeks: bias the goal to name the peek when claiming Seer.
    const peek = seerNightPeek(game, players, npcId)
    const claimingSeer = (claim ?? '').toLowerCase() === 'seer'
    if (peek && claimingSeer) {
      const shared =
        peek.kind === 'player'
          ? chatLines.some(
              (l) =>
                l.fromId === npcId &&
                l.text.toLowerCase().includes(peek.targetName.toLowerCase()) &&
                l.text.toLowerCase().includes(peek.roleLabel.toLowerCase()) &&
                /\b(?:saw|peeked|looked|checked)\b/i.test(l.text),
            )
          : chatLines.some(
              (l) =>
                l.fromId === npcId &&
                /\bcenter\b/i.test(l.text) &&
                /\b(?:saw|peeked|looked)\b/i.test(l.text),
            )
      if (!shared) {
        goal =
          peek.kind === 'player'
            ? `Name your Seer peek: ${peek.targetName} was ${peek.roleLabel}. ${goal}`.slice(
                0,
                200,
              )
            : `Name your Seer center peek: ${peek.label}. ${goal}`.slice(0, 200)
      }
    }
  }

  // Scrub goals / beliefs that invent false Robber rules or treat Robber→Seer as impossible.
  if (inventsFalseRobberRules(goal)) {
    goal =
      'Robber becoming the stolen role (e.g. Seer) is normal — do not call it impossible. Interview conflicting claims instead.'.slice(
        0,
        200,
      )
  }
  beliefUpdates = beliefUpdates.map((b) =>
    inventsFalseRobberRules(b.notes)
      ? {
          ...b,
          notes:
            'Robber→stolen role is normal ONUW — re-evaluate without calling that impossible.',
        }
      : b,
  )

  // Scrub false "I didn't feel a rob ⇒ their Robber story is a lie" epistemology.
  if (game && npcId) {
    const robAtMe = spokenRobberStoryTargeting(nightStories, npcId)
    if (robAtMe) {
      if (deniesConsistentRobberTargetStory(goal)) {
        goal =
          `${robAtMe.speakerName}'s Robber story naming you is compatible with your night info (you would not feel a rob) — do role accounting, do not dismiss them for "no swap felt".`.slice(
            0,
            200,
          )
      }
      // Drop them from suspects if the only heat was this false contradiction.
      suspects = suspects.filter(
        (s) => s.toLowerCase() !== robAtMe.speakerName.toLowerCase(),
      )
      beliefUpdates = beliefUpdates.map((b) =>
        b.aboutName.toLowerCase() === robAtMe.speakerName.toLowerCase() &&
        deniesConsistentRobberTargetStory(b.notes)
          ? {
              ...b,
              notes:
                'Robber claim naming me is compatible with my night info — not disproved by "no swap felt."',
            }
          : b,
      )
    } else if (deniesConsistentRobberTargetStory(goal)) {
      goal =
        'Robbed seats do not feel the swap — do not treat "no swap felt" as proof against a Robber story. Do role accounting instead.'.slice(
          0,
          200,
        )
    }
  }
  beliefUpdates = beliefUpdates.map((b) =>
    deniesConsistentRobberTargetStory(b.notes)
      ? {
          ...b,
          notes:
            'Robbed seats do not feel the swap — Robber story can be compatible with their night info.',
        }
      : b,
  )

  // Scrub Robber goals that invent peeks beyond the steal.
  if (game && npcId && myDealtRole(game, npcId) === 'robber') {
    const rob = robberNightResult(game, players, npcId)
    if (rob && robberInventedExtraPeek(goal, rob)) {
      goal =
        `Stick to robbed ${rob.targetName} → became ${rob.stolenLabel}; no invented peeks. Confirm matching claims, then interview someone else.`.slice(
          0,
          200,
        )
    }
    // Force naming the rob story when claiming Robber and it isn't on the board yet.
    if (rob && (claim ?? '').toLowerCase() === 'robber') {
      const shared = chatLines.some(
        (l) =>
          l.fromId === npcId &&
          new RegExp(
            `\\bi\\s+(?:robbed|stole(?:\\s+from)?|swapped\\s+with)\\b[^.!?]{0,40}\\b${rob.targetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
            'i',
          ).test(l.text),
      )
      if (!shared && !/\brobbed\b/i.test(goal)) {
        goal =
          `Name rob: robbed ${rob.targetName} → became ${rob.stolenLabel}. ${goal}`.slice(
            0,
            200,
          )
      }
    }
  }

  // Scrub goals that invent peeks/swaps when this village seat has none.
  if (
    game &&
    npcId &&
    villageMustNotInventNightCardStory(game, npcId) &&
    inventsFabricatedNightCardStory(goal)
  ) {
    const selfName = (game.playerNames[npcId] ?? '').toLowerCase()
    const silentSeat = Object.values(game.playerNames ?? {}).find(
      (n) =>
        n.toLowerCase() !== selfName &&
        ![...claimedNames].some((c) => c.toLowerCase() === n.toLowerCase()),
    )
    goal = silentSeat
      ? `Stick to your claim with no invented peek/swap. Interview ${silentSeat} by name — ask what they woke as.`.slice(
          0,
          200,
        )
      : 'Stick to your claim with no invented peek/swap — you have no night card action. Ask someone else what they woke as.'.slice(
          0,
          200,
        )
  }

  // Seer/Robber/etc. must not plan to own a Troublemaker first-person swap.
  if (
    game &&
    npcId &&
    !(
      myDealtRole(game, npcId) === 'troublemaker' &&
      game.nightActions.troublemaker?.playerId === npcId
    ) &&
    claimsUnownedFirstPersonTroublemakerSwap(goal)
  ) {
    goal =
      'Do not say "I swapped A and B" — that is only Troublemaker. Stick to your claim and private night info; cite another seat\'s first-person swap only if it is on the board.'.slice(
        0,
        200,
      )
  }

  // Scrub goals that treat a night swap as fact when none is recorded / spoken.
  if (game && npcId && assumesUnrecordedNightSwap(goal)) {
    const ownSwap = seatHasRecordedNightSwap(game, npcId)
    const boardSwap = boardHasSpokenSwapStory(nightStories)
    if (!ownSwap && !boardSwap) {
      goal =
        'No swap is on the claim board or in your private info — do not assume cards moved. Stick to known claims and interview gaps.'.slice(
          0,
          200,
        )
    }
  }

  // Scrub invented Seer contradictions when this seat has no Seer peek.
  if (
    game &&
    npcId &&
    !seatHasSeerPeekToChallengeWith(game, npcId) &&
    inventsSeerPeekContradiction(goal)
  ) {
    goal =
      'You have no Seer peek of your own — do not invent that their peek conflicts with what you saw. Clear matching peeks; interview someone else or do role accounting.'.slice(
        0,
        200,
      )
  }
  if (game && npcId && !seatHasSeerPeekToChallengeWith(game, npcId)) {
    beliefUpdates = beliefUpdates.map((b) =>
      inventsSeerPeekContradiction(b.notes)
        ? {
            ...b,
            notes:
              'No private peek to contradict their Seer story — re-evaluate without inventing "what I saw."',
          }
        : b,
    )
  }

  // Before mid-day: village should open seats that still have no role claim
  // (avoid tunnel vision on one loud argument while wolves stay silent).
  if (game && npcId && winTeam === 'village') {
    const msLeft = dayMsLeftNow(game)
    const total = game.dayDurationMs || 0
    const beforeMidDay =
      msLeft == null || total <= 0 ? true : msLeft > total * 0.5
    if (beforeMidDay) {
      const selfName = (game.playerNames[npcId] ?? '').toLowerCase()
      const unclaimed = Object.values(game.playerNames ?? {}).filter(
        (n) =>
          n.toLowerCase() !== selfName &&
          ![...claimedNames].some((c) => c.toLowerCase() === n.toLowerCase()),
      )
      if (unclaimed.length > 0) {
        const mentionsSilent = unclaimed.some((name) =>
          new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(goal),
        )
        const mentionsClaimed = [...claimedNames].some((name) =>
          new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(goal),
        )
        const alreadyAsks =
          /\b(?:interview|ask)\b/i.test(goal) &&
          (mentionsSilent ||
            /\b(?:no\s+role\s+claim|what\s+they\s+woke|what\s+did\s+you\s+wake)\b/i.test(
              goal,
            ))
        if (!alreadyAsks && (mentionsClaimed || unclaimed.length >= 2)) {
          const target = unclaimed[0]!
          goal =
            `Interview ${target} by name — they still have no role claim on the board. Ask what they woke as. ${goal}`.slice(
              0,
              200,
            )
        }
      }
    }
  }

  // When spoken claims cleanly fill player seats with village roles and this
  // seat has no private wolf, pitch an explicit no-kill / 1-each spread.
  if (
    game &&
    players.length > 0 &&
    winTeam === 'village' &&
    seerWolfNames.length === 0
  ) {
    const tablePlayers = players.filter((p) => game.playerIds.includes(p.id))
    const board = buildGlobalPublicClaimBoard({
      players: tablePlayers,
      chatLines,
    })
    if (spokenClaimsAccountForVillageSeats(game, board.entries)) {
      if (
        !/\b(?:no[\s-]?kill|1[\s-]?each|one[\s-]?each|vote\s+spread|nobody\s+dies|center[\s-]?wolf)\b/i.test(
          goal,
        )
      ) {
        goal =
          `Pitch a no-kill / 1-each vote spread — spoken claims account for player seats; both wolves may be in the center. ${goal}`.slice(
            0,
            200,
          )
      }
    }
  }

  // Minion, no seated wolves: force a kill (village wins only on no-kill).
  if (
    game &&
    npcId &&
    winTeam === 'werewolf' &&
    dealt === 'minion' &&
    knownWolfAllyNames(game, npcId).length === 0
  ) {
    if (
      !/\b(?:force\s+a\s+kill|concentrate|pile\s+on|someone\s+must\s+die)\b/i.test(
        goal,
      )
    ) {
      goal =
        `No seated wolves — FORCE a kill (concentrate votes on one village seat). Do NOT pitch a no-kill / 1-each spread. ${goal}`.slice(
          0,
          200,
        )
    }
  }

  // Incomplete night stories (vague Seer center / Robber without stolen role).
  if (game && players.length > 0 && winTeam === 'village') {
    const incomplete = incompleteNightStories(nightStories)
    if (incomplete.length > 0) {
      const top = incomplete[0]!
      const already =
        /\b(?:roles?\s+unnamed|incomplete|which\s+(?:two|center)|what\s+roles?\s+(?:did|were)|name\s+(?:the\s+)?center)\b/i.test(
          goal,
        )
      if (!already) {
        if (top.kind === 'seer-center') {
          goal =
            `Ask ${top.speakerName} which center roles they saw — "peeked center" without roles is incomplete. ${goal}`.slice(
              0,
              200,
            )
        } else if (top.kind === 'robber' && !top.stolenRole) {
          goal =
            `Ask ${top.speakerName} what role they stole from ${top.targetName}. ${goal}`.slice(
              0,
              200,
            )
        }
      }
    }
  }

  // Classifier fell back to empty goal — seed a deterministic village advance.
  if (
    /^listen and stay consistent$/i.test(goal.trim()) &&
    winTeam === 'village' &&
    game &&
    players.length > 0
  ) {
    const tablePlayers = players.filter((p) => game.playerIds.includes(p.id))
    const board = buildGlobalPublicClaimBoard({
      players: tablePlayers,
      chatLines,
    })
    const unclaimed = board.entries
      .filter((e) => !e.claim)
      .map((e) => e.playerName)
    const incomplete = incompleteNightStories(board.stories)
    if (incomplete[0]?.kind === 'seer-center') {
      goal = `Ask ${incomplete[0].speakerName} which center roles they saw.`
    } else if (unclaimed[0]) {
      goal = `Interview ${unclaimed[0]} by name — they still have no role claim on the board.`
    } else if (spokenClaimsAccountForVillageSeats(game, board.entries)) {
      goal =
        'Pitch a no-kill / 1-each vote spread — spoken claims account for player seats; both wolves may be in the center.'
    } else {
      goal = 'Do role accounting from the claim board and press the weakest story.'
    }
  }

  // Deck-count surplus: calmly press overclaimed roles (e.g. 3× Villager vs 1×).
  if (game && players.length > 0 && winTeam === 'village') {
    const tablePlayers = players.filter((p) => game.playerIds.includes(p.id))
    const board = buildGlobalPublicClaimBoard({
      players: tablePlayers,
      chatLines,
    })
    const surplus = overclaimedRoles(game, board.entries)
    if (surplus.length > 0) {
      const top = surplus[0]!
      const already =
        /\b(?:overclaim|surplus|duplicate|deck\s+has|only\s+\d+|1×|1x)\b/i.test(
          goal,
        ) ||
        new RegExp(
          `\\b${top.claimed}\\s*(?:×|x)?\\s*${top.role}\\b`,
          'i',
        ).test(goal)
      if (!already) {
        const who = top.names.slice(0, 3).join(', ')
        goal =
          `Deck has ${top.deck}× ${top.role} but ${top.claimed} claims (${who}) — calmly press the surplus. ${goal}`.slice(
            0,
            200,
          )
      }
    }
  }

  // Scrub out-of-deck roles from goal text.
  if (game) {
    const notIn = rolesNotInPlay(game)
    goal = stripOutOfDeckRoles(goal, notIn)
  }

  return { ...plan, claim, suspects, goal, beliefUpdates }
}
