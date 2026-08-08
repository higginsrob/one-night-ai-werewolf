import {
  buildRoleDeck,
  NIGHT_ORDER,
  ROLE_INFO,
  roleName,
  shuffleInPlace,
} from './roles'
import {
  dawnPlaybackBeats,
  GOD_NIGHT_PLAYBACK_BEAT_MS,
  revealPlaybackBeats,
} from './nightPlayback'
import {
  DEFAULT_DAY_DURATION_SEC,
  DEFAULT_NIGHT_ACT_SEC,
} from './werewolfSettings'
import {
  NO_VOTE_TARGET,
  type NightStep,
  type TableCard,
  type WerewolfNightActions,
  type WerewolfRole,
  type WerewolfSnapshot,
} from './werewolfTypes'

export const DAY_DURATION_MS = DEFAULT_DAY_DURATION_SEC * 1000
/** Time each night role gets to act after the wake-up line. */
export const NIGHT_ACT_MS = DEFAULT_NIGHT_ACT_SEC * 1000

function emptyActions(): WerewolfNightActions {
  return { acknowledged: [] }
}

function dealtRoleSet(state: WerewolfSnapshot): Set<WerewolfRole> {
  return new Set([
    ...Object.values(state.dealtRoles),
    ...state.dealtCenter,
  ])
}

/** Roles that wake / act on a given night step (by dealt role). */
export function actorsForStep(
  state: WerewolfSnapshot,
  step: NightStep,
): string[] {
  const want: WerewolfRole | null =
    step === 'werewolves'
      ? 'werewolf'
      : step === 'minion'
        ? 'minion'
        : step === 'masons'
          ? 'mason'
          : step === 'seer'
            ? 'seer'
            : step === 'robber'
              ? 'robber'
              : step === 'troublemaker'
                ? 'troublemaker'
                : step === 'drunk'
                  ? 'drunk'
                  : step === 'insomniac'
                    ? 'insomniac'
                    : null
  if (!want) return []
  return state.playerIds.filter((id) => state.dealtRoles[id] === want)
}

function stepNeedsActors(step: NightStep): boolean {
  return step !== 'intro' && step !== 'outro' && step !== 'simultaneous'
}

function stepIsPresent(state: WerewolfSnapshot, step: NightStep): boolean {
  if (step === 'intro' || step === 'outro' || step === 'simultaneous') return true
  const present = dealtRoleSet(state)
  switch (step) {
    case 'werewolves':
      return present.has('werewolf')
    case 'minion':
      return present.has('minion')
    case 'masons':
      return present.has('mason')
    case 'seer':
      return present.has('seer')
    case 'robber':
      return present.has('robber')
    case 'troublemaker':
      return present.has('troublemaker')
    case 'drunk':
      return present.has('drunk')
    case 'insomniac':
      return present.has('insomniac')
  }
}

function nextStepAfter(
  state: WerewolfSnapshot,
  from: NightStep,
): NightStep | 'day' {
  const idx = NIGHT_ORDER.indexOf(from)
  for (let i = idx + 1; i < NIGHT_ORDER.length; i++) {
    const step = NIGHT_ORDER[i]!
    if (stepIsPresent(state, step)) return step
  }
  return 'day'
}

function withStep(state: WerewolfSnapshot, step: NightStep): WerewolfSnapshot {
  // Always settle on present roles — even when the card is only in the center —
  // so the narrator can wake them, run the act timer, then put them to sleep.
  return {
    ...state,
    nightStep: step,
    nightActions: {
      ...state.nightActions,
      acknowledged: [],
    },
    nightStepEndsAt: null,
    nightActGraceUsed: false,
  }
}

function enterDay(state: WerewolfSnapshot): WerewolfSnapshot {
  return {
    ...state,
    phase: 'day',
    dayEndsAt: Date.now() + (state.dayDurationMs || DAY_DURATION_MS),
    nightStepEndsAt: null,
    nightPaused: false,
    nightPauseRemainingMs: null,
    playbackStartedAt: null,
    playbackBeatMs: null,
    playbackBeatIndex: null,
    revealStage: null,
    votes: {},
    // Keep night action memory (robber steal, etc.) for private day role stack.
    nightActions: {
      ...state.nightActions,
      acknowledged: [],
    },
  }
}

/**
 * God-mode watch: after night outro, animate every night action in order
 * before day discussion (reuses the dawn playback schedule).
 */
function enterGodNightPlayback(state: WerewolfSnapshot): WerewolfSnapshot {
  return {
    ...state,
    phase: 'dawn',
    dayEndsAt: null,
    nightStepEndsAt: null,
    nightPaused: false,
    nightPauseRemainingMs: null,
    playbackStartedAt: Date.now(),
    playbackBeatMs: GOD_NIGHT_PLAYBACK_BEAT_MS,
    playbackBeatIndex: 0,
    revealStage: null,
    votes: {},
    nightActions: {
      ...state.nightActions,
      acknowledged: [],
    },
  }
}

/** Host/client: short dawn recap finished — start day timer. */
export function dawnDone(state: WerewolfSnapshot): WerewolfSnapshot {
  if (state.phase !== 'dawn') return state
  return enterDay(state)
}

/**
 * Host: advance one speech-driven playback beat (god-mode dawn or post-vote
 * night recap) after announce TTS or silent action hold.
 */
export function playbackNext(state: WerewolfSnapshot): WerewolfSnapshot {
  if (state.playbackBeatIndex == null) return state

  if (state.phase === 'dawn' && state.godMode) {
    const beats = dawnPlaybackBeats(state)
    const next = state.playbackBeatIndex + 1
    if (next >= beats.length) return enterDay(state)
    return {
      ...state,
      playbackBeatIndex: next,
      playbackStartedAt: Date.now(),
    }
  }

  if (state.phase === 'reveal' && state.revealStage === 'nightPlayback') {
    const beats = revealPlaybackBeats(state)
    const next = state.playbackBeatIndex + 1
    if (next >= beats.length) return playbackDone(state)
    return {
      ...state,
      playbackBeatIndex: next,
      playbackStartedAt: Date.now(),
    }
  }

  return state
}

function beginRevealPlayback(
  state: WerewolfSnapshot,
  killedIds: string[],
): WerewolfSnapshot {
  let next: WerewolfSnapshot = {
    ...state,
    phase: 'reveal',
    revealStage: 'nightPlayback',
    playbackStartedAt: Date.now(),
    playbackBeatMs: GOD_NIGHT_PLAYBACK_BEAT_MS,
    playbackBeatIndex: 0,
    killedIds,
    hunterKillId: null,
    winners: null,
    winMessage: null,
    dayEndsAt: null,
    timeoutVillageWin: false,
  }
  // When Hunter won't delay the outcome, resolve winners now so cards + aftergame
  // talk can start with the night replay instead of waiting for the result stage.
  const hunters = killedIds.filter((id) => state.roles[id] === 'hunter')
  if (hunters.length === 0) {
    next = applyRevealOutcome(next, killedIds, null)
  }
  return next
}

/**
 * Host: re-run the public night playback from the result screen.
 * Keeps winners / kills.
 */
export function replayNightPlayback(state: WerewolfSnapshot): WerewolfSnapshot {
  if (state.phase !== 'reveal' || state.revealStage !== 'result') {
    return state
  }
  if (state.winners == null) return state
  return {
    ...state,
    revealStage: 'nightPlayback',
    playbackStartedAt: Date.now(),
    playbackBeatMs: GOD_NIGHT_PLAYBACK_BEAT_MS,
    playbackBeatIndex: 0,
  }
}

/**
 * Host/client: full night replay finished — hunter pick or winners.
 */
export function playbackDone(state: WerewolfSnapshot): WerewolfSnapshot {
  if (state.phase !== 'reveal' || state.revealStage !== 'nightPlayback') {
    return state
  }

  // Voluntary re-watch — round already resolved; return to the result screen.
  if (state.winners != null) {
    return {
      ...state,
      revealStage: 'result',
      playbackStartedAt: null,
      playbackBeatMs: null,
    playbackBeatIndex: null,
    }
  }

  const hunters = state.killedIds.filter((id) => state.roles[id] === 'hunter')
  if (hunters.length > 0) {
    return {
      ...state,
      revealStage: 'hunter',
      playbackStartedAt: null,
      playbackBeatMs: null,
    playbackBeatIndex: null,
      winners: null,
      winMessage:
        hunters.length === 1
          ? 'The Hunter died — they choose one player to take with them.'
          : 'A Hunter died — they choose one player to take with them.',
    }
  }

  return finishReveal(state, state.killedIds, null)
}

export type CreateWerewolfOpts = {
  roleDeck?: WerewolfRole[] | null
  playerNames?: Record<string, string>
  nightActMs?: number
  dayDurationMs?: number
  simultaneousNight?: boolean
  /** Watch-game: play night-action recap before day (always on in watch mode). */
  godMode?: boolean
  /** Eval/benchmark: freeze layout scatter seed. */
  layoutSeed?: number
  /** Eval/benchmark: pre-shuffled face-down cards (claimBy ignored / cleared). */
  cards?: Array<{ id: string; role: WerewolfRole }>
}

function clampTimerMs(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function createWerewolfState(
  playerIds: string[],
  opts?: CreateWerewolfOpts,
): WerewolfSnapshot {
  const unique = [...new Set(playerIds)]
  if (unique.length < 3) {
    throw new Error('One Night AI Werewolf needs at least 3 players')
  }

  const composed =
    opts?.roleDeck && opts.roleDeck.length === unique.length + 3
      ? [...opts.roleDeck]
      : buildRoleDeck(unique.length)
  const roleDeck = [...composed]
  const playerNames: Record<string, string> = {}
  for (let i = 0; i < unique.length; i++) {
    const id = unique[i]!
    playerNames[id] = opts?.playerNames?.[id] ?? `Player ${i + 1}`
  }

  const cards: TableCard[] =
    opts?.cards && opts.cards.length === unique.length + 3
      ? opts.cards.map((c) => ({
          id: c.id,
          role: c.role,
          claimBy: null,
        }))
      : shuffleInPlace([...composed]).map((role, i) => ({
          id: `card_${i}_${role}`,
          role,
          claimBy: null,
        }))

  const layoutSeed =
    typeof opts?.layoutSeed === 'number' && opts.layoutSeed > 0
      ? opts.layoutSeed >>> 0
      : (Date.now() ^ (unique.length * 2654435761) ^ cards.length) >>> 0

  const nightActMs = clampTimerMs(
    opts?.nightActMs,
    NIGHT_ACT_MS,
    5_000,
    60_000,
  )
  const dayDurationMs = clampTimerMs(
    opts?.dayDurationMs,
    DAY_DURATION_MS,
    60_000,
    15 * 60_000,
  )

  return {
    gameId: 'werewolf',
    phase: 'claiming',
    playerIds: unique,
    playerNames,
    roleDeck,
    cards,
    layoutSeed: layoutSeed || 1,
    roles: {},
    dealtRoles: {},
    center: [],
    dealtCenter: [],
    nightStep: 'intro',
    nightActions: emptyActions(),
    simultaneousNight: Boolean(opts?.simultaneousNight),
    godMode: Boolean(opts?.godMode),
    nightStepEndsAt: null,
    nightActGraceUsed: false,
    nightPaused: false,
    nightPauseRemainingMs: null,
    nightResumeAt: 0,
    nightActMs,
    dayEndsAt: null,
    dayDurationMs,
    votes: {},
    killedIds: [],
    hunterKillId: null,
    revealStage: null,
    playbackStartedAt: null,
    playbackBeatMs: null,
    playbackBeatIndex: null,
    timeoutVillageWin: false,
    winners: null,
    winMessage: null,
  }
}

function finishClaiming(state: WerewolfSnapshot): WerewolfSnapshot {
  const roles: Record<string, WerewolfRole> = {}
  const claimedIds = new Set<string>()
  for (const card of state.cards) {
    if (!card.claimBy) continue
    roles[card.claimBy] = card.role
    claimedIds.add(card.claimBy)
  }
  if (claimedIds.size !== state.playerIds.length) return state

  const unclaimed = state.cards.filter((c) => !c.claimBy).map((c) => c.role)
  if (unclaimed.length !== 3) return state

  // Always narrator intro first; simultaneousNight collects AI+human intents
  // in one shared window after intro advances.
  return {
    ...state,
    phase: 'night',
    roles: { ...roles },
    dealtRoles: { ...roles },
    center: [...unclaimed],
    dealtCenter: [...unclaimed],
    nightStep: 'intro',
    nightActions: emptyActions(),
    nightStepEndsAt: null,
    nightActGraceUsed: false,
    nightPaused: false,
    nightPauseRemainingMs: null,
    nightResumeAt: 0,
    dayEndsAt: null,
    revealStage: null,
    playbackStartedAt: null,
    playbackBeatMs: null,
    playbackBeatIndex: null,
    timeoutVillageWin: false,
  }
}

/** Host: freeze night act timer and narration. */
export function pauseNight(state: WerewolfSnapshot): WerewolfSnapshot {
  if (state.phase !== 'night' || state.nightPaused) return state
  const remaining =
    state.nightStepEndsAt != null
      ? Math.max(0, state.nightStepEndsAt - Date.now())
      : null
  return {
    ...state,
    nightPaused: true,
    nightPauseRemainingMs: remaining,
    nightStepEndsAt: null,
  }
}

/** Host: unfreeze night; restore act window or re-trigger wake narration. */
export function resumeNight(state: WerewolfSnapshot): WerewolfSnapshot {
  if (state.phase !== 'night' || !state.nightPaused) return state
  const remaining = state.nightPauseRemainingMs
  return {
    ...state,
    nightPaused: false,
    nightPauseRemainingMs: null,
    nightStepEndsAt: remaining != null ? Date.now() + remaining : null,
    nightResumeAt: Date.now(),
  }
}

export function claimCard(
  state: WerewolfSnapshot,
  fromId: string,
  cardId: string,
): WerewolfSnapshot {
  if (state.phase !== 'claiming') return state
  if (!state.playerIds.includes(fromId)) return state
  if (state.cards.some((c) => c.claimBy === fromId)) return state

  const target = state.cards.find((c) => c.id === cardId)
  if (!target || target.claimBy) return state

  const cards = state.cards.map((c) =>
    c.id === cardId ? { ...c, claimBy: fromId } : c,
  )

  return finishClaiming({ ...state, cards })
}

function ackPlayer(
  state: WerewolfSnapshot,
  playerId: string,
): WerewolfSnapshot {
  if (state.nightActions.acknowledged.includes(playerId)) return state
  return {
    ...state,
    nightActions: {
      ...state.nightActions,
      acknowledged: [...state.nightActions.acknowledged, playerId],
    },
  }
}

/**
 * Role steps: optional ack (e.g. drunk after swap); the host timer advances night.
 * Intro/outro are advanced by the host narrator (no player buttons).
 */
export function acknowledgeNight(
  state: WerewolfSnapshot,
  fromId: string,
): WerewolfSnapshot {
  if (state.phase !== 'night') return state
  if (!state.playerIds.includes(fromId)) return state
  const step = state.nightStep

  // Intro/outro no longer wait on player acks.
  if (step === 'intro' || step === 'outro') return state

  const actors = actorsForStep(state, step)
  if (!actors.includes(fromId)) return state

  if (step === 'seer' && !state.nightActions.seer) return state
  if (step === 'robber' && !state.nightActions.robber) return state
  if (step === 'troublemaker' && !state.nightActions.troublemaker) return state
  if (step === 'drunk' && !state.nightActions.drunk) return state

  return ackPlayer(state, fromId)
}

/**
 * Host narrator finished the intro or outro line — advance the night sequence.
 */
export function narratorAdvance(state: WerewolfSnapshot): WerewolfSnapshot {
  if (state.phase !== 'night' || state.nightPaused) return state
  if (state.nightStep === 'intro') {
    if (state.simultaneousNight) {
      if (!nightHasWakePresence(state)) return withStep(state, 'outro')
      return withStep(state, 'simultaneous')
    }
    const after = nextStepAfter(state, 'intro')
    if (after === 'day') return withStep(state, 'outro')
    return withStep(state, after)
  }
  if (state.nightStep === 'outro') {
    // Ensure Troublemaker/Seer/etc. always have recorded night knowledge first.
    const filled = ensureAllMissingNightActions(state)
    // God-mode watch: show night actions before day; otherwise keep them secret
    // until the post-vote reveal playback.
    if (filled.godMode) return enterGodNightPlayback(filled)
    return enterDay(filled)
  }
  return state
}

/** True when any seated player has a night-waking / night-acting role. */
function nightHasWakePresence(state: WerewolfSnapshot): boolean {
  return state.playerIds.some((id) => {
    const dealt = state.dealtRoles[id]
    return (
      dealt === 'werewolf' ||
      dealt === 'minion' ||
      dealt === 'mason' ||
      dealt === 'seer' ||
      dealt === 'robber' ||
      dealt === 'troublemaker' ||
      dealt === 'drunk' ||
      dealt === 'insomniac'
    )
  })
}

/**
 * Host: begin the act window after the wake-up narration finishes.
 * Optional `actMs` shortens the window (spectator / no-wake rush).
 */
export function startNightAct(
  state: WerewolfSnapshot,
  actMs?: number,
): WerewolfSnapshot {
  if (state.phase !== 'night' || state.nightPaused) return state
  const canStart =
    state.nightStep === 'simultaneous' || stepNeedsActors(state.nightStep)
  if (!canStart) return state
  if (state.nightStepEndsAt != null) return state
  // Nothing left to collect — expire immediately so narrator → day can run.
  if (
    state.nightStep === 'simultaneous' &&
    simultaneousNightReady(state)
  ) {
    return {
      ...state,
      nightStepEndsAt: Date.now(),
      nightActGraceUsed: true,
    }
  }
  const configured = state.nightActMs || NIGHT_ACT_MS
  const ms =
    typeof actMs === 'number' && Number.isFinite(actMs)
      ? Math.max(500, Math.min(actMs, configured))
      : configured
  // Short rush windows skip grace so spectators aren't stuck for 2× nightActMs.
  const rushed = typeof actMs === 'number' && actMs < configured
  return {
    ...state,
    nightStepEndsAt: Date.now() + ms,
    nightActGraceUsed: rushed,
  }
}

/**
 * Host/NPC: push the current night act deadline out so slow AI picks can land
 * before a deterministic timeout fallback overwrites them.
 * Cap to one configured act window so the UI timer stays near nightActMs.
 */
export function extendNightActWindow(
  state: WerewolfSnapshot,
  extraMs?: number,
): WerewolfSnapshot {
  if (state.phase !== 'night' || state.nightPaused) return state
  if (state.nightStepEndsAt == null) return state
  const actMs = state.nightActMs || NIGHT_ACT_MS
  const bump = Math.max(
    1_000,
    Math.min(extraMs ?? actMs, actMs),
  )
  const base = Math.max(state.nightStepEndsAt, Date.now())
  return {
    ...state,
    nightStepEndsAt: Math.min(base + bump, Date.now() + actMs * 2),
  }
}

/** Host: update pacing timers for upcoming night/day windows. */
export function setWerewolfTimers(
  state: WerewolfSnapshot,
  nightActMs: number,
  dayDurationMs: number,
): WerewolfSnapshot {
  const nextNight = clampTimerMs(nightActMs, state.nightActMs || NIGHT_ACT_MS, 5_000, 60_000)
  const nextDay = clampTimerMs(
    dayDurationMs,
    state.dayDurationMs || DAY_DURATION_MS,
    60_000,
    15 * 60_000,
  )
  return {
    ...state,
    nightActMs: nextNight,
    dayDurationMs: nextDay,
  }
}

function currentNightStepNeedsAction(state: WerewolfSnapshot): boolean {
  if (state.nightStep === 'simultaneous') {
    return state.playerIds.some((id) => playerNeedsNightIntent(state, id))
  }
  if (!stepNeedsActors(state.nightStep)) return false
  return actorsForStep(state, state.nightStep).some((id) =>
    playerNeedsNightIntent(state, id),
  )
}

/**
 * Host: act window expired — complete any missing required night action, then
 * move to the next present night step (after the close-eyes line on the host).
 *
 * Slow AI night picks can lose the race with the act timer; without this,
 * Seer/Robber/etc. wake with empty private info and invent peeks by day.
 * First expiry with a still-missing pick gets one grace extension.
 */
export function nightTimeout(state: WerewolfSnapshot): WerewolfSnapshot {
  if (state.phase !== 'night' || state.nightPaused) return state
  if (state.nightStep === 'simultaneous') {
    if (state.nightStepEndsAt == null) return state
    if (Date.now() + 500 < state.nightStepEndsAt) return state
    if (!state.nightActGraceUsed && currentNightStepNeedsAction(state)) {
      // One extra act window matching the host setting (not a fixed 35s floor).
      const graceMs = state.nightActMs || NIGHT_ACT_MS
      return {
        ...state,
        nightActGraceUsed: true,
        nightStepEndsAt: Date.now() + graceMs,
      }
    }
    return resolveSimultaneousNight(state)
  }
  if (!stepNeedsActors(state.nightStep)) return state
  if (state.nightStepEndsAt == null) return state
  if (Date.now() + 500 < state.nightStepEndsAt) return state

  if (!state.nightActGraceUsed && currentNightStepNeedsAction(state)) {
    const graceMs = state.nightActMs || NIGHT_ACT_MS
    return {
      ...state,
      nightActGraceUsed: true,
      nightStepEndsAt: Date.now() + graceMs,
    }
  }

  const withAction = forcePendingNightActions(state)
  const next = nextStepAfter(withAction, withAction.nightStep)
  if (next === 'day') {
    // Belt-and-suspenders: backfill any earlier skipped role actions before dawn.
    return withStep(ensureAllMissingNightActions(withAction), 'outro')
  }
  return withStep(withAction, next)
}

/**
 * Apply a deterministic night action for `step` even if the game has already
 * moved past that wake (used when Skip advanced without recording, or as a
 * dawn safety net). Does not change nightStep.
 */
export function forceNightActionsForStep(
  state: WerewolfSnapshot,
  step: NightStep,
): WerewolfSnapshot {
  if (state.phase !== 'night') return state
  const actors = actorsForStep(state, step)
  if (actors.length === 0) return state

  if (step === 'werewolves') {
    if (actors.length === 1 && !state.nightActions.werewolfPeek) {
      return recordWerewolfPeek(state, actors[0]!, 0)
    }
    return state
  }

  if (step === 'seer' && !state.nightActions.seer) {
    const seerId = actors[0]!
    const others = state.playerIds.filter((id) => id !== seerId)
    if (others.length > 0) {
      return recordSeerPlayer(state, seerId, others[0]!)
    }
    return recordSeerCenter(state, seerId, 0, 1)
  }

  if (step === 'robber' && !state.nightActions.robber) {
    const robberId = actors[0]!
    const others = state.playerIds.filter((id) => id !== robberId)
    if (others.length === 0) return state
    return recordRobberSwap(state, robberId, others[0]!)
  }

  if (step === 'troublemaker' && !state.nightActions.troublemaker) {
    const tmId = actors[0]!
    const others = state.playerIds.filter((id) => id !== tmId)
    if (others.length < 2) return state
    return recordTroublemakerSwap(state, tmId, others[0]!, others[1]!)
  }

  if (step === 'drunk' && !state.nightActions.drunk) {
    return recordDrunkSwap(state, actors[0]!, 0)
  }

  return state
}

/**
 * If the current night step still lacks its recorded action, apply a
 * deterministic fallback so private day info is never empty after a timeout.
 */
export function forcePendingNightActions(
  state: WerewolfSnapshot,
): WerewolfSnapshot {
  return forceNightActionsForStep(state, state.nightStep)
}

/**
 * Backfill every dealt night role that never recorded an action. Safe to call
 * before outro/day so Troublemaker/Seer/etc. always have private day knowledge.
 */
export function ensureAllMissingNightActions(
  state: WerewolfSnapshot,
): WerewolfSnapshot {
  if (state.phase !== 'night') return state
  let next = state
  for (const step of NIGHT_ORDER) {
    if (!stepNeedsActors(step)) continue
    if (!stepIsPresent(next, step)) continue
    next = forceNightActionsForStep(next, step)
  }
  return next
}

/** Host: skip the current role's night step (wake / act / close). */
export function skipNightStep(state: WerewolfSnapshot): WerewolfSnapshot {
  if (state.phase !== 'night') return state
  if (state.nightStep === 'simultaneous') {
    return resolveSimultaneousNight(state)
  }
  if (!stepNeedsActors(state.nightStep)) return state

  // Skip used to advance with empty nightActions — AI Troublemakers then had
  // "no swap recorded" and could not name who they switched when asked.
  const withAction = forcePendingNightActions(state)
  const next = nextStepAfter(withAction, withAction.nightStep)
  const advanced =
    next === 'day'
      ? withStep(ensureAllMissingNightActions(withAction), 'outro')
      : withStep(withAction, next)
  return {
    ...advanced,
    nightPaused: false,
    nightPauseRemainingMs: null,
    // Force host narrator to re-key and speak the next wake line.
    nightResumeAt: Date.now(),
  }
}

/** @deprecated Prefer acknowledgeNight for intro/outro; kept for older clients. */
export function advanceNight(
  state: WerewolfSnapshot,
  fromId: string,
): WerewolfSnapshot {
  return acknowledgeNight(state, fromId)
}

/** Dealt roles that wake or act during night (vs villager / hunter / tanner). */
export function playerHasNightPhase(
  state: WerewolfSnapshot,
  playerId: string,
): boolean {
  const dealt = state.dealtRoles[playerId]
  return (
    dealt === 'werewolf' ||
    dealt === 'minion' ||
    dealt === 'mason' ||
    dealt === 'seer' ||
    dealt === 'robber' ||
    dealt === 'troublemaker' ||
    dealt === 'drunk' ||
    dealt === 'insomniac'
  )
}

export function isNightActor(
  state: WerewolfSnapshot,
  playerId: string,
): boolean {
  if (state.phase !== 'night') return false
  if (state.simultaneousNight && state.nightStep === 'simultaneous') {
    const dealt = state.dealtRoles[playerId]
    // Keep action + info roles eyes-open for the shared window (incl. after pick).
    return (
      dealt === 'werewolf' ||
      dealt === 'minion' ||
      dealt === 'mason' ||
      dealt === 'seer' ||
      dealt === 'robber' ||
      dealt === 'troublemaker' ||
      dealt === 'drunk'
    )
  }
  const step = state.nightStep
  // Intro/outro are narrator-driven; night-phase roles stay eyes-closed / listening.
  if (step === 'intro' || step === 'outro') return false
  return actorsForStep(state, step).includes(playerId)
}

type NightActOpts = {
  /** Allow recording after the wake step advanced (Skip / dawn backfill). */
  ignoreStep?: boolean
}

/** True while simultaneous night is collecting intents (board swaps deferred). */
function deferBoardMutations(state: WerewolfSnapshot): boolean {
  return state.simultaneousNight && state.nightStep === 'simultaneous'
}

function nightStepAllows(
  state: WerewolfSnapshot,
  step: NightStep,
  opts?: NightActOpts,
): boolean {
  if (opts?.ignoreStep) return true
  if (deferBoardMutations(state)) return true
  return state.nightStep === step
}

/** Lone WW peek / seer / robber / TM / drunk still need a submitted intent. */
export function playerNeedsNightIntent(
  state: WerewolfSnapshot,
  playerId: string,
): boolean {
  if (state.phase !== 'night') return false
  if (!state.playerIds.includes(playerId)) return false
  const dealt = state.dealtRoles[playerId]
  if (!dealt) return false

  if (dealt === 'werewolf') {
    const wolves = actorsForStep(state, 'werewolves')
    return wolves.length === 1 && wolves[0] === playerId && !state.nightActions.werewolfPeek
  }
  if (dealt === 'seer') return !state.nightActions.seer
  if (dealt === 'robber') return !state.nightActions.robber
  if (dealt === 'troublemaker') return !state.nightActions.troublemaker
  if (dealt === 'drunk') return !state.nightActions.drunk
  return false
}

/** Every required simultaneous-night intent has been recorded. */
export function simultaneousNightReady(state: WerewolfSnapshot): boolean {
  if (!state.simultaneousNight || state.nightStep !== 'simultaneous') return false
  return state.playerIds.every((id) => !playerNeedsNightIntent(state, id))
}

/**
 * Apply deferred robber → troublemaker → drunk swaps onto the live board.
 * Peeks were already snapshotted against the pre-swap board during collect.
 */
function applyDeferredSwaps(state: WerewolfSnapshot): WerewolfSnapshot {
  let next = state
  const robber = next.nightActions.robber
  if (robber) {
    const fromId = robber.playerId
    const targetId = robber.targetId
    const stolenRole = next.roles[targetId]!
    const mine = next.roles[fromId]!
    next = {
      ...next,
      roles: {
        ...next.roles,
        [fromId]: stolenRole,
        [targetId]: mine,
      },
      nightActions: {
        ...next.nightActions,
        robber: { ...robber, stolenRole },
      },
    }
  }

  const tm = next.nightActions.troublemaker
  if (tm) {
    const roleA = next.roles[tm.a]!
    const roleB = next.roles[tm.b]!
    next = {
      ...next,
      roles: {
        ...next.roles,
        [tm.a]: roleB,
        [tm.b]: roleA,
      },
    }
  }

  const drunk = next.nightActions.drunk
  if (drunk) {
    const fromId = drunk.playerId
    const idx = drunk.centerIndex
    const mine = next.roles[fromId]!
    const mid = next.center[idx]!
    const center = [...next.center]
    center[idx] = mine
    next = {
      ...next,
      roles: { ...next.roles, [fromId]: mid },
      center,
    }
  }

  return next
}

/**
 * Force missing intents, apply deferred swaps in night order, then outro
 * (narrator dawn line) before day.
 */
export function resolveSimultaneousNight(
  state: WerewolfSnapshot,
): WerewolfSnapshot {
  if (state.phase !== 'night') return state
  if (!state.simultaneousNight || state.nightStep !== 'simultaneous') {
    return state
  }
  const filled = ensureAllMissingNightActions(state)
  const applied = applyDeferredSwaps(filled)
  return withStep(applied, 'outro')
}

function maybeResolveSimultaneous(
  state: WerewolfSnapshot,
  opts?: NightActOpts,
): WerewolfSnapshot {
  // Force/backfill paths must not recurse into resolve mid-fill.
  if (opts?.ignoreStep) return state
  if (!simultaneousNightReady(state)) return state
  // Act window not started yet (still on wake TTS) — wait for startNightAct.
  if (state.nightStepEndsAt == null) return state
  // Collapse the deadline so close TTS → nightTimeout → outro can run.
  if (Date.now() >= state.nightStepEndsAt) return state
  return {
    ...state,
    nightStepEndsAt: Date.now(),
  }
}

export function werewolfPeekCenter(
  state: WerewolfSnapshot,
  fromId: string,
  centerIndex: number,
  opts?: NightActOpts,
): WerewolfSnapshot {
  if (state.phase !== 'night') return state
  if (!nightStepAllows(state, 'werewolves', opts)) return state
  if (state.dealtRoles[fromId] !== 'werewolf') return state
  const wolves = actorsForStep(state, 'werewolves')
  if (wolves.length !== 1) return state
  if (centerIndex < 0 || centerIndex > 2) return state
  if (state.nightActions.werewolfPeek) return state

  return maybeResolveSimultaneous({
    ...state,
    nightActions: {
      ...state.nightActions,
      werewolfPeek: {
        playerId: fromId,
        centerIndex,
        role: state.center[centerIndex]!,
      },
    },
  }, opts)
}

function recordWerewolfPeek(
  state: WerewolfSnapshot,
  fromId: string,
  centerIndex: number,
): WerewolfSnapshot {
  return werewolfPeekCenter(state, fromId, centerIndex, { ignoreStep: true })
}

export function seerLookPlayer(
  state: WerewolfSnapshot,
  fromId: string,
  targetId: string,
  opts?: NightActOpts,
): WerewolfSnapshot {
  if (state.phase !== 'night') return state
  if (!nightStepAllows(state, 'seer', opts)) return state
  if (state.dealtRoles[fromId] !== 'seer') return state
  if (state.nightActions.seer) return state
  if (fromId === targetId || !state.playerIds.includes(targetId)) return state

  return maybeResolveSimultaneous({
    ...state,
    nightActions: {
      ...state.nightActions,
      seer: {
        playerId: fromId,
        view: {
          kind: 'player',
          targetId,
          role: state.roles[targetId]!,
        },
      },
    },
  }, opts)
}

function recordSeerPlayer(
  state: WerewolfSnapshot,
  fromId: string,
  targetId: string,
): WerewolfSnapshot {
  return seerLookPlayer(state, fromId, targetId, { ignoreStep: true })
}

export function seerLookCenter(
  state: WerewolfSnapshot,
  fromId: string,
  a: number,
  b: number,
  opts?: NightActOpts,
): WerewolfSnapshot {
  if (state.phase !== 'night') return state
  if (!nightStepAllows(state, 'seer', opts)) return state
  if (state.dealtRoles[fromId] !== 'seer') return state
  if (state.nightActions.seer) return state
  if (a === b || a < 0 || a > 2 || b < 0 || b > 2) return state

  return maybeResolveSimultaneous({
    ...state,
    nightActions: {
      ...state.nightActions,
      seer: {
        playerId: fromId,
        view: {
          kind: 'center',
          indexes: [a, b],
          roles: [state.center[a]!, state.center[b]!],
        },
      },
    },
  }, opts)
}

function recordSeerCenter(
  state: WerewolfSnapshot,
  fromId: string,
  a: number,
  b: number,
): WerewolfSnapshot {
  return seerLookCenter(state, fromId, a, b, { ignoreStep: true })
}

export function robberSwap(
  state: WerewolfSnapshot,
  fromId: string,
  targetId: string,
  opts?: NightActOpts,
): WerewolfSnapshot {
  if (state.phase !== 'night') return state
  if (!nightStepAllows(state, 'robber', opts)) return state
  if (state.dealtRoles[fromId] !== 'robber') return state
  if (state.nightActions.robber) return state
  if (fromId === targetId || !state.playerIds.includes(targetId)) return state

  const mine = state.roles[fromId]!
  const theirs = state.roles[targetId]!
  const defer = deferBoardMutations(state)
  const roles = defer
    ? state.roles
    : { ...state.roles, [fromId]: theirs, [targetId]: mine }

  return maybeResolveSimultaneous({
    ...state,
    roles,
    nightActions: {
      ...state.nightActions,
      robber: { playerId: fromId, targetId, stolenRole: theirs },
    },
  }, opts)
}

function recordRobberSwap(
  state: WerewolfSnapshot,
  fromId: string,
  targetId: string,
): WerewolfSnapshot {
  return robberSwap(state, fromId, targetId, { ignoreStep: true })
}

export function troublemakerSwap(
  state: WerewolfSnapshot,
  fromId: string,
  a: string,
  b: string,
  opts?: NightActOpts,
): WerewolfSnapshot {
  if (state.phase !== 'night') return state
  if (!nightStepAllows(state, 'troublemaker', opts)) return state
  if (state.dealtRoles[fromId] !== 'troublemaker') return state
  if (state.nightActions.troublemaker) return state
  if (a === b || a === fromId || b === fromId) return state
  if (!state.playerIds.includes(a) || !state.playerIds.includes(b)) return state

  const defer = deferBoardMutations(state)
  const roles = defer
    ? state.roles
    : {
        ...state.roles,
        [a]: state.roles[b]!,
        [b]: state.roles[a]!,
      }

  // Stay on the step (like robber) so the actor sees the swap FX until the timer.
  return maybeResolveSimultaneous({
    ...state,
    roles,
    nightActions: {
      ...state.nightActions,
      troublemaker: { playerId: fromId, a, b },
    },
  }, opts)
}

function recordTroublemakerSwap(
  state: WerewolfSnapshot,
  fromId: string,
  a: string,
  b: string,
): WerewolfSnapshot {
  return troublemakerSwap(state, fromId, a, b, { ignoreStep: true })
}

export function drunkSwap(
  state: WerewolfSnapshot,
  fromId: string,
  centerIndex: number,
  opts?: NightActOpts,
): WerewolfSnapshot {
  if (state.phase !== 'night') return state
  if (!nightStepAllows(state, 'drunk', opts)) return state
  if (state.dealtRoles[fromId] !== 'drunk') return state
  if (state.nightActions.drunk) return state
  if (centerIndex < 0 || centerIndex > 2) return state

  const mine = state.roles[fromId]!
  const mid = state.center[centerIndex]!
  const defer = deferBoardMutations(state)
  const roles = defer ? state.roles : { ...state.roles, [fromId]: mid }
  const center = defer
    ? state.center
    : (() => {
        const next = [...state.center]
        next[centerIndex] = mine
        return next
      })()

  return maybeResolveSimultaneous({
    ...state,
    roles,
    center,
    nightActions: {
      ...state.nightActions,
      drunk: { playerId: fromId, centerIndex },
      acknowledged: state.nightActions.acknowledged.includes(fromId)
        ? state.nightActions.acknowledged
        : [...state.nightActions.acknowledged, fromId],
    },
  }, opts)
}

function recordDrunkSwap(
  state: WerewolfSnapshot,
  fromId: string,
  centerIndex: number,
): WerewolfSnapshot {
  return drunkSwap(state, fromId, centerIndex, { ignoreStep: true })
}

export function castVote(
  state: WerewolfSnapshot,
  fromId: string,
  targetId: string,
): WerewolfSnapshot {
  if (state.phase !== 'day') return state
  if (!state.playerIds.includes(fromId)) return state
  const isNoVote = targetId === NO_VOTE_TARGET
  // Official: each player points to another player — no self-votes.
  // House option: tap yourself to cast a no-vote (abstain).
  if (
    !isNoVote &&
    (fromId === targetId || !state.playerIds.includes(targetId))
  ) {
    return state
  }

  const votes = { ...state.votes, [fromId]: targetId }
  const next = { ...state, votes }

  if (state.playerIds.every((id) => votes[id])) {
    // Keep votes editable until the day clock is nearly out so players (and
    // AIs) can still switch or undo before dayTimeout resolves the table.
    const msLeft =
      state.dayEndsAt != null ? Math.max(0, state.dayEndsAt - Date.now()) : 0
    if (msLeft > 2_000) return next
    return resolveVotes(next)
  }
  return next
}

/** Clear a player's day vote while discussion time remains. */
export function undoVote(
  state: WerewolfSnapshot,
  fromId: string,
): WerewolfSnapshot {
  if (state.phase !== 'day') return state
  if (!state.playerIds.includes(fromId)) return state
  if (!(fromId in state.votes)) return state

  const votes = { ...state.votes }
  delete votes[fromId]
  return { ...state, votes }
}

function tallyVotes(votes: Record<string, string>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const target of Object.values(votes)) {
    if (target === NO_VOTE_TARGET) continue
    counts.set(target, (counts.get(target) ?? 0) + 1)
  }
  return counts
}

/**
 * Official: highest vote total dies; all tied for most die.
 * If no one has more than one vote, nobody dies.
 */
export function pickKilledIds(votes: Record<string, string>): string[] {
  const counts = tallyVotes(votes)
  let best = 0
  const leaders: string[] = []
  for (const [id, n] of counts) {
    if (n > best) {
      best = n
      leaders.length = 0
      leaders.push(id)
    } else if (n === best) {
      leaders.push(id)
    }
  }
  if (best <= 1) return []
  return leaders
}

/** Players who received the highest vote total (any positive count), for narration. */
function mostVotedPlayerIds(votes: Record<string, string>): string[] {
  const counts = tallyVotes(votes)
  let best = 0
  const leaders: string[] = []
  for (const [id, n] of counts) {
    if (n > best) {
      best = n
      leaders.length = 0
      leaders.push(id)
    } else if (n === best) {
      leaders.push(id)
    }
  }
  if (best <= 0) return []
  return leaders
}

function joinNames(names: string[]): string {
  if (names.length === 0) return 'Someone'
  if (names.length === 1) return names[0]!
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}

/** Spoken clause naming who led the vote tally (empty when nobody was voted for). */
function mostVotesSpeakClause(state: WerewolfSnapshot): string {
  const leaders = mostVotedPlayerIds(state.votes)
  if (leaders.length === 0) return ''
  const names = joinNames(leaders.map((id) => playerLabel(state, id)))
  if (leaders.length === 1) {
    return `${names} received the most votes. `
  }
  return `${names} tied for the most votes. `
}

export function resolveVotes(state: WerewolfSnapshot): WerewolfSnapshot {
  const killedIds = pickKilledIds(state.votes)
  return beginRevealPlayback(state, killedIds)
}

/**
 * Day timer expired. If votes already produce a kill, resolve;
 * otherwise nobody dies and official win conditions apply
 * (werewolves win if a werewolf is among players; village if all wolves are in center).
 */
export function dayTimeout(state: WerewolfSnapshot): WerewolfSnapshot {
  if (state.phase !== 'day') return state
  if (state.winners) return state
  if (state.dayEndsAt != null && Date.now() + 500 < state.dayEndsAt) {
    return state
  }

  const killedIds = pickKilledIds(state.votes)
  if (killedIds.length > 0) {
    return resolveVotes(state)
  }

  return beginRevealPlayback(state, [])
}

export function hunterKill(
  state: WerewolfSnapshot,
  fromId: string,
  targetId: string,
): WerewolfSnapshot {
  if (state.phase !== 'reveal') return state
  if (state.revealStage !== 'hunter') return state
  if (!state.killedIds.includes(fromId)) return state
  if (state.roles[fromId] !== 'hunter') return state
  if (state.hunterKillId) return state
  if (!state.playerIds.includes(targetId) || targetId === fromId) return state
  if (state.winners) return state

  return finishReveal(state, state.killedIds, targetId)
}

/** Set winners / win message without changing reveal stage (used mid-playback). */
function applyRevealOutcome(
  state: WerewolfSnapshot,
  killedIds: string[],
  hunterKillId: string | null,
): WerewolfSnapshot {
  const dead = new Set<string>(killedIds)
  if (hunterKillId) dead.add(hunterKillId)

  const werewolfAmongPlayers = state.playerIds.some(
    (id) => state.roles[id] === 'werewolf',
  )
  const tannerDead = [...dead].some((id) => state.roles[id] === 'tanner')
  const werewolfDead = [...dead].some((id) => state.roles[id] === 'werewolf')
  const votesClause = mostVotesSpeakClause(state)

  let winners: WerewolfSnapshot['winners'] = null
  let winMessage = 'Nobody dies. '

  if (dead.size === 0) {
    winMessage =
      Object.keys(state.votes).length === 0
        ? 'Nobody was killed. '
        : 'No one received enough votes to die. '
    // Official: if nobody dies and a werewolf is among players → werewolves.
    // If all WW are in center → village.
    if (!werewolfAmongPlayers) {
      winners = 'village'
      winMessage += 'No werewolves among the players. Village wins!'
    } else {
      winners = 'werewolves'
      winMessage += 'A werewolf still lives. Werewolves win!'
    }
  } else if (tannerDead && werewolfDead) {
    // Official: Tanner dies with a werewolf → Tanner and village both win.
    winners = 'village_and_tanner'
    const tid = [...dead].find((id) => state.roles[id] === 'tanner')!
    winMessage = `${playerLabel(state, tid)} the Tanner dies, and a werewolf dies too. Tanner and village both win!`
  } else if (tannerDead) {
    winners = 'tanner'
    const tid = [...dead].find((id) => state.roles[id] === 'tanner')!
    winMessage = `${playerLabel(state, tid)} the Tanner dies and wins! Werewolves do not win.`
  } else if (werewolfDead) {
    winners = 'village'
    winMessage = 'A werewolf was eliminated. Village team wins!'
  } else {
    winners = 'werewolves'
    winMessage = 'No werewolf died. Werewolves (and Minion) win!'
  }

  if (votesClause) {
    winMessage = `${votesClause}${winMessage}`
  }

  return {
    ...state,
    timeoutVillageWin: false,
    killedIds,
    hunterKillId,
    winners,
    winMessage,
    dayEndsAt: null,
  }
}

function finishReveal(
  state: WerewolfSnapshot,
  killedIds: string[],
  hunterKillId: string | null,
): WerewolfSnapshot {
  return {
    ...applyRevealOutcome(state, killedIds, hunterKillId),
    phase: 'reveal',
    revealStage: 'result',
    playbackStartedAt: null,
    playbackBeatMs: null,
    playbackBeatIndex: null,
  }
}

function playerLabel(state: WerewolfSnapshot, id: string): string {
  return state.playerNames[id] ?? 'Someone'
}

/**
 * Whether this player won after the reveal resolves.
 * Null while the round is still in progress (or hunter pick pending).
 */
export function playerWon(
  state: WerewolfSnapshot,
  playerId: string,
): boolean | null {
  if (state.phase !== 'reveal' || !state.winners) return null
  if (!state.playerIds.includes(playerId)) return null
  const role = state.roles[playerId]
  if (!role) return null

  const dead =
    state.killedIds.includes(playerId) || state.hunterKillId === playerId

  switch (state.winners) {
    case 'village':
      return ROLE_INFO[role].team === 'village'
    case 'werewolves':
      return role === 'werewolf' || role === 'minion'
    case 'tanner':
      return role === 'tanner' && dead
    case 'village_and_tanner':
      if (role === 'tanner' && dead) return true
      return ROLE_INFO[role].team === 'village'
    default:
      return null
  }
}

export function roleLabel(role: WerewolfRole): string {
  return roleName(role)
}

export function playersWithDealtRole(
  state: WerewolfSnapshot,
  role: WerewolfRole,
): string[] {
  return state.playerIds.filter((id) => state.dealtRoles[id] === role)
}

export function myDealtRole(
  state: WerewolfSnapshot,
  clientId: string | null,
): WerewolfRole | null {
  if (!clientId) return null
  return state.dealtRoles[clientId] ?? null
}

export function myClaimedRole(
  state: WerewolfSnapshot,
  clientId: string | null,
): WerewolfRole | null {
  if (!clientId) return null
  if (state.dealtRoles[clientId]) return state.dealtRoles[clientId]!
  const card = state.cards.find((c) => c.claimBy === clientId)
  return card?.role ?? null
}

export function myCurrentRole(
  state: WerewolfSnapshot,
  clientId: string | null,
): WerewolfRole | null {
  if (!clientId) return null
  return state.roles[clientId] ?? null
}

/** Private “now” role the player is allowed to remember (Robber / Insomniac). */
export function myKnownNowRole(
  state: WerewolfSnapshot,
  clientId: string | null,
): WerewolfRole | null {
  if (!clientId) return null
  const dealt = state.dealtRoles[clientId]
  if (!dealt) return null

  if (dealt === 'robber') {
    const robbed = state.nightActions.robber
    if (robbed?.playerId === clientId) return robbed.stolenRole
    return null
  }

  if (dealt === 'insomniac') {
    // After their wake (acked or past that step / day), they may remember current.
    if (
      state.phase === 'dawn' ||
      state.phase === 'day' ||
      state.phase === 'reveal'
    ) {
      return state.roles[clientId] ?? null
    }
    if (state.phase === 'night') {
      const order = NIGHT_ORDER.indexOf(state.nightStep)
      const insomniaIdx = NIGHT_ORDER.indexOf('insomniac')
      if (order > insomniaIdx) return state.roles[clientId] ?? null
      if (
        state.nightStep === 'insomniac' &&
        state.nightActions.acknowledged.includes(clientId)
      ) {
        return state.roles[clientId] ?? null
      }
      if (state.nightStep === 'insomniac') {
        // Show while checking during their turn.
        return state.roles[clientId] ?? null
      }
    }
  }

  return null
}
