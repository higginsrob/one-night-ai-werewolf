import { NIGHT_ORDER, roleName } from './roles'
import { setSceneBackdrop } from '../scene/sceneBackdrop'
import type {
  NightStep,
  WerewolfRole,
  WerewolfSnapshot,
} from './werewolfTypes'

export const PLAYBACK_BEAT_MS = 1600
/** Hold after each silent action beat once the narrator has spoken. */
export const GOD_NIGHT_PLAYBACK_BEAT_MS = 1200
/** Extra pad after the last beat before advancing phase (wall-clock mode). */
export const PLAYBACK_TAIL_MS = 600

export function effectivePlaybackBeatMs(
  game: Pick<WerewolfSnapshot, 'playbackBeatMs'>,
): number {
  return game.playbackBeatMs ?? PLAYBACK_BEAT_MS
}

export type PlaybackBeat =
  | { kind: 'atmosphere'; label: string; speak?: string }
  | {
      kind: 'announce'
      nightStep: NightStep
      label: string
      speak: string
    }
  | {
      kind: 'glow'
      /**
       * Cards seen / revealed this beat (yellow target ring).
       * Ally peeks (wolves, masons) and Minion→werewolves land here.
       */
      playerIds: string[]
      /** Waking role(s) when distinct from targets (teal actor ring). */
      actorIds?: string[]
      label: string
      speak?: string
    }
  | {
      kind: 'peekCenter'
      index: number
      role: WerewolfRole
      /** Waking player(s) for this night step. */
      actorIds: string[]
      label: string
      speak?: string
    }
  | {
      kind: 'peekPlayer'
      playerId: string
      role: WerewolfRole
      actorIds: string[]
      label: string
      speak?: string
    }
  | {
      kind: 'swap'
      a: string
      b: string
      mode: 'players' | 'selfCenter'
      faceRole?: WerewolfRole
      actorIds: string[]
      label: string
      speak?: string
    }
  | {
      kind: 'flip'
      playerId: string
      role: WerewolfRole
      label: string
      speak?: string
    }

function dealtRoleSet(state: WerewolfSnapshot): Set<WerewolfRole> {
  return new Set([
    ...Object.values(state.dealtRoles),
    ...state.dealtCenter,
  ])
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

function nameOf(game: WerewolfSnapshot, id: string): string {
  return game.playerNames[id] ?? 'Someone'
}

function presentRoleSteps(game: WerewolfSnapshot): NightStep[] {
  return NIGHT_ORDER.filter(
    (step) =>
      step !== 'intro' &&
      step !== 'outro' &&
      step !== 'simultaneous' &&
      stepIsPresent(game, step),
  )
}

/** Action FX for one night role step (no announce). */
export function actionBeatsForNightStep(
  game: WerewolfSnapshot,
  step: NightStep,
): PlaybackBeat[] {
  const beats: PlaybackBeat[] = []
  switch (step) {
    case 'werewolves': {
      const wolves = game.playerIds.filter(
        (id) => game.dealtRoles[id] === 'werewolf',
      )
      if (wolves.length > 1) {
        const names = wolves.map((id) => nameOf(game, id)).join(' and ')
        const speak = `Werewolves ${names} woke up and found each other.`
        beats.push({
          kind: 'glow',
          playerIds: wolves,
          label: speak,
          speak,
        })
      }
      const peek = game.nightActions.werewolfPeek
      if (peek) {
        const speak = `Werewolf ${nameOf(game, peek.playerId)} woke up and peeked at a center card: ${roleName(peek.role)}.`
        beats.push({
          kind: 'peekCenter',
          index: peek.centerIndex,
          role: peek.role,
          actorIds: [peek.playerId],
          label: speak,
          speak,
        })
      }
      break
    }
    case 'minion': {
      const minions = game.playerIds.filter(
        (id) => game.dealtRoles[id] === 'minion',
      )
      const wolves = game.playerIds.filter(
        (id) => game.dealtRoles[id] === 'werewolf',
      )
      if (minions.length > 0) {
        const minionNames = minions.map((id) => nameOf(game, id)).join(' and ')
        const wolfPart =
          wolves.length === 0
            ? 'saw no werewolves'
            : wolves.length === 1
              ? `saw ${nameOf(game, wolves[0]!)} as a werewolf`
              : `saw the werewolves: ${wolves.map((id) => nameOf(game, id)).join(' and ')}`
        const speak = `Minion ${minionNames} woke up and ${wolfPart}.`
        beats.push({
          kind: 'glow',
          // Yellow-ring the werewolves the Minion sees; teal-ring the Minion.
          playerIds: wolves,
          actorIds: minions,
          label: speak,
          speak,
        })
      }
      break
    }
    case 'masons': {
      const masons = game.playerIds.filter(
        (id) => game.dealtRoles[id] === 'mason',
      )
      if (masons.length > 0) {
        const names = masons.map((id) => nameOf(game, id)).join(' and ')
        const speak =
          masons.length === 1
            ? `Mason ${names} woke up and found no other Mason.`
            : `Masons ${names} woke up and saw each other.`
        beats.push({
          kind: 'glow',
          playerIds: masons,
          label: speak,
          speak,
        })
      }
      break
    }
    case 'seer': {
      const seer = game.nightActions.seer
      if (!seer) break
      const seerName = nameOf(game, seer.playerId)
      if (seer.view.kind === 'player') {
        const speak = `Seer ${seerName} woke up and saw ${nameOf(game, seer.view.targetId)} as a ${roleName(seer.view.role)}.`
        beats.push({
          kind: 'peekPlayer',
          playerId: seer.view.targetId,
          role: seer.view.role,
          actorIds: [seer.playerId],
          label: speak,
          speak,
        })
      } else {
        const r0 = roleName(seer.view.roles[0]!)
        const r1 = roleName(seer.view.roles[1]!)
        const speak = `Seer ${seerName} woke up and peeked at two center cards: ${r0} and ${r1}.`
        beats.push({
          kind: 'peekCenter',
          index: seer.view.indexes[0]!,
          role: seer.view.roles[0]!,
          actorIds: [seer.playerId],
          label: speak,
          speak,
        })
        beats.push({
          kind: 'peekCenter',
          index: seer.view.indexes[1]!,
          role: seer.view.roles[1]!,
          actorIds: [seer.playerId],
          label: `Center ${seer.view.indexes[1]! + 1}: ${r1}.`,
        })
      }
      break
    }
    case 'robber': {
      const robbed = game.nightActions.robber
      if (!robbed) break
      const speak = `Robber ${nameOf(game, robbed.playerId)} woke up and robbed ${nameOf(game, robbed.targetId)}, becoming a ${roleName(robbed.stolenRole)}.`
      beats.push({
        kind: 'swap',
        a: robbed.playerId,
        b: robbed.targetId,
        mode: 'players',
        faceRole: robbed.stolenRole,
        actorIds: [robbed.playerId],
        label: speak,
        speak,
      })
      break
    }
    case 'troublemaker': {
      const tm = game.nightActions.troublemaker
      if (!tm) break
      const speak = `Troublemaker ${nameOf(game, tm.playerId)} woke up and switched ${nameOf(game, tm.a)} and ${nameOf(game, tm.b)}.`
      beats.push({
        kind: 'swap',
        a: tm.a,
        b: tm.b,
        mode: 'players',
        actorIds: [tm.playerId],
        label: speak,
        speak,
      })
      break
    }
    case 'drunk': {
      const drunk = game.nightActions.drunk
      if (!drunk) break
      const speak = `Drunk ${nameOf(game, drunk.playerId)} woke up and swapped with center card ${drunk.centerIndex + 1}.`
      beats.push({
        kind: 'swap',
        a: drunk.playerId,
        b: `center:${drunk.centerIndex}`,
        mode: 'selfCenter',
        actorIds: [drunk.playerId],
        label: speak,
        speak,
      })
      break
    }
    case 'insomniac': {
      const actors = game.playerIds.filter(
        (id) => game.dealtRoles[id] === 'insomniac',
      )
      for (const id of actors) {
        const role = game.roles[id]
        if (!role) continue
        const speak = `Insomniac ${nameOf(game, id)} woke up and checked their card: ${roleName(role)}.`
        beats.push({
          kind: 'flip',
          playerId: id,
          role,
          label: speak,
          speak,
        })
      }
      break
    }
    default:
      break
  }
  return beats
}

/**
 * Ordered night-action beats (werewolves → … → insomniac). Shared by
 * post-vote reveal and god-mode pre-day dawn recap.
 */
export function nightActionPlaybackBeats(
  game: WerewolfSnapshot,
): PlaybackBeat[] {
  const beats: PlaybackBeat[] = []
  for (const step of presentRoleSteps(game)) {
    beats.push(...actionBeatsForNightStep(game, step))
  }
  return beats
}

/**
 * Dawn beats: god-mode watch narrates each night outcome with its animation;
 * otherwise a short non-spoiler wake-up (legacy / non-god clients).
 */
export function dawnPlaybackBeats(game: WerewolfSnapshot): PlaybackBeat[] {
  if (game.godMode) {
    const beats: PlaybackBeat[] = [
      {
        kind: 'announce',
        nightStep: 'intro',
        label: 'Night falls…',
        speak: 'Everyone, close your eyes.',
      },
    ]
    for (const step of presentRoleSteps(game)) {
      const actions = actionBeatsForNightStep(game, step)
      if (actions.length === 0) continue
      beats.push(...actions)
    }
    beats.push({
      kind: 'announce',
      nightStep: 'outro',
      label: 'Everyone wakes. Discuss.',
      speak: 'Everyone, wake up.',
    })
    return beats
  }
  return [
    { kind: 'atmosphere', label: 'Everyone wakes.' },
    { kind: 'atmosphere', label: 'Discuss and vote.' },
  ]
}

/**
 * True when robber / troublemaker / drunk moved cards overnight.
 * Peeks and ally glows do not count — nothing to animate in the post-vote replay.
 */
export function nightCardsChanged(game: WerewolfSnapshot): boolean {
  const a = game.nightActions
  return Boolean(a.robber || a.troublemaker || a.drunk)
}

function revealClosingSpeak(game: WerewolfSnapshot): {
  label: string
  speak: string
} {
  const win = game.winMessage?.trim()
  if (win) {
    return { label: win, speak: win }
  }
  const hunters = game.killedIds.filter((id) => game.roles[id] === 'hunter')
  if (hunters.length > 0) {
    const speak =
      hunters.length === 1
        ? 'The Hunter died — they choose one player to take with them.'
        : 'A Hunter died — they choose one player to take with them.'
    return { label: speak, speak }
  }
  return { label: 'The votes are in.', speak: 'The votes are in.' }
}

/**
 * Full public post-vote replay — same night-action narration as god-mode dawn,
 * but opens with a recap line and closes on the winning team (no wake-up).
 */
export function revealPlaybackBeats(game: WerewolfSnapshot): PlaybackBeat[] {
  const beats: PlaybackBeat[] = [
    {
      kind: 'announce',
      nightStep: 'intro',
      label: 'What happened in the night…',
      speak: "Times up!  lets see what happened during the night",
    },
  ]
  for (const step of presentRoleSteps(game)) {
    const actions = actionBeatsForNightStep(game, step)
    if (actions.length === 0) continue
    beats.push(...actions)
  }
  const closing = revealClosingSpeak(game)
  beats.push({
    kind: 'announce',
    nightStep: 'outro',
    label: closing.label,
    speak: closing.speak,
  })
  return beats
}

export function playbackDurationMs(
  beats: PlaybackBeat[],
  beatMs: number = PLAYBACK_BEAT_MS,
): number {
  return beats.length * beatMs + PLAYBACK_TAIL_MS
}

export function currentPlaybackBeat(
  beats: PlaybackBeat[],
  startedAt: number | null,
  nowMs: number = Date.now(),
  beatMs: number = PLAYBACK_BEAT_MS,
  /** When set, host-driven index (god-mode speech sync) instead of wall-clock. */
  beatIndex: number | null = null,
): { beat: PlaybackBeat; index: number } | null {
  if (beats.length === 0) return null
  if (typeof beatIndex === 'number') {
    if (beatIndex < 0 || beatIndex >= beats.length) return null
    return { beat: beats[beatIndex]!, index: beatIndex }
  }
  if (startedAt == null) return null
  const elapsed = nowMs - startedAt
  if (elapsed < 0) return { beat: beats[0]!, index: 0 }
  const index = Math.floor(elapsed / beatMs)
  if (index >= beats.length) return null
  return { beat: beats[index]!, index }
}

export function playbackFinished(
  beats: PlaybackBeat[],
  startedAt: number | null,
  nowMs: number = Date.now(),
  beatMs: number = PLAYBACK_BEAT_MS,
  beatIndex: number | null = null,
): boolean {
  if (typeof beatIndex === 'number') {
    return beatIndex >= beats.length
  }
  if (startedAt == null) return false
  return nowMs >= startedAt + playbackDurationMs(beats, beatMs)
}

/** Table roles during night playback — dealt start, then swaps as their beats play. */
export type PlaybackBoard = {
  roles: Record<string, WerewolfRole>
  center: WerewolfRole[]
}

function cloneDealtBoard(game: WerewolfSnapshot): PlaybackBoard {
  return {
    roles: { ...game.dealtRoles },
    center: [...game.dealtCenter],
  }
}

function applySwapBeat(board: PlaybackBoard, beat: Extract<PlaybackBeat, { kind: 'swap' }>): PlaybackBoard {
  if (beat.mode === 'players') {
    const roleA = board.roles[beat.a]
    const roleB = board.roles[beat.b]
    if (!roleA || !roleB) return board
    return {
      ...board,
      roles: {
        ...board.roles,
        [beat.a]: roleB,
        [beat.b]: roleA,
      },
    }
  }
  const cIdx = Number(beat.b.split(':')[1] ?? -1)
  const mine = board.roles[beat.a]
  const mid = board.center[cIdx]
  if (!mine || mid == null || cIdx < 0) return board
  const center = [...board.center]
  center[cIdx] = mine
  return {
    roles: { ...board.roles, [beat.a]: mid },
    center,
  }
}

/**
 * Reconstruct seat/center roles for a playback beat index.
 * Starts from night-deal cards; each `swap` beat through `beatIndex` is applied
 * so the arrive-home animation matches post-swap faces.
 */
export function playbackBoardAtBeat(
  game: WerewolfSnapshot,
  beats: PlaybackBeat[],
  beatIndex: number | null,
): PlaybackBoard {
  let board = cloneDealtBoard(game)
  if (beatIndex == null || beatIndex < 0) return board
  const through = Math.min(beatIndex, beats.length - 1)
  for (let i = 0; i <= through; i++) {
    const beat = beats[i]
    if (beat?.kind === 'swap') board = applySwapBeat(board, beat)
  }
  return board
}

/**
 * Live table faces for dawn / reveal nightPlayback.
 * Returns null outside those phases (caller uses `game.roles` / `game.center`).
 */
export function playbackDisplayBoard(
  game: WerewolfSnapshot,
  nowMs: number = Date.now(),
): PlaybackBoard | null {
  const isDawn = game.phase === 'dawn'
  const isRevealPlay =
    game.phase === 'reveal' && game.revealStage === 'nightPlayback'
  if (!isDawn && !isRevealPlay) return null

  const beats = isDawn ? dawnPlaybackBeats(game) : revealPlaybackBeats(game)
  const beatMs = effectivePlaybackBeatMs(game)
  const beatIndex =
    (isDawn && game.godMode) || isRevealPlay ? game.playbackBeatIndex : null
  const cur = currentPlaybackBeat(
    beats,
    game.playbackStartedAt,
    nowMs,
    beatMs,
    beatIndex,
  )
  if (cur) return playbackBoardAtBeat(game, beats, cur.index)
  if (
    playbackFinished(
      beats,
      game.playbackStartedAt,
      nowMs,
      beatMs,
      beatIndex,
    )
  ) {
    return { roles: { ...game.roles }, center: [...game.center] }
  }
  // Not started yet — original deals.
  return cloneDealtBoard(game)
}

/** Drive night↔dusk sky from werewolf phase / playback progress. */
export function syncWerewolfBackdrop(
  game: WerewolfSnapshot,
  nowMs: number = Date.now(),
): void {
  const nightIntensity = 0.06
  const duskIntensity = 0.42

  if (game.phase === 'claiming' || game.phase === 'night') {
    setSceneBackdrop({
      variant: 'night',
      intensity: game.phase === 'night' ? 0.045 : nightIntensity,
      blurriness: 0.18,
    })
    return
  }

  if (game.phase === 'dawn') {
    const beats = dawnPlaybackBeats(game)
    const beatMs = effectivePlaybackBeatMs(game)
    let t: number
    if (game.godMode && typeof game.playbackBeatIndex === 'number') {
      t =
        beats.length <= 1
          ? 1
          : Math.min(1, Math.max(0, game.playbackBeatIndex / (beats.length - 1)))
    } else {
      const started = game.playbackStartedAt ?? nowMs
      const total = Math.max(1, playbackDurationMs(beats, beatMs))
      t = Math.min(1, Math.max(0, (nowMs - started) / total))
    }
    // Dark → light on night sky, then hand off to dusk near the end.
    const intensity = 0.02 + (nightIntensity * 1.4 - 0.02) * t
    setSceneBackdrop({
      variant: t > 0.82 ? 'dusk' : 'night',
      intensity: t > 0.82 ? duskIntensity * (0.5 + 0.5 * ((t - 0.82) / 0.18)) : intensity,
      blurriness: 0.18 - 0.04 * t,
    })
    return
  }

  if (game.phase === 'day') {
    setSceneBackdrop({
      variant: 'dusk',
      intensity: duskIntensity,
      blurriness: 0.14,
    })
    return
  }

  if (game.phase === 'reveal') {
    if (game.revealStage === 'nightPlayback') {
      const beats = revealPlaybackBeats(game)
      const beatMs = effectivePlaybackBeatMs(game)
      let t: number
      if (typeof game.playbackBeatIndex === 'number') {
        t =
          beats.length <= 1
            ? 1
            : Math.min(
                1,
                Math.max(0, game.playbackBeatIndex / (beats.length - 1)),
              )
      } else {
        const started = game.playbackStartedAt ?? nowMs
        const total = Math.max(1, playbackDurationMs(beats, beatMs))
        t = Math.min(1, Math.max(0, (nowMs - started) / total))
      }
      const intensity = 0.025 + (0.12 - 0.025) * t
      setSceneBackdrop({
        variant: t > 0.88 ? 'dusk' : 'night',
        intensity:
          t > 0.88
            ? duskIntensity * ((t - 0.88) / 0.12)
            : intensity,
        blurriness: 0.18 - 0.04 * t,
      })
      return
    }
    setSceneBackdrop({
      variant: 'dusk',
      intensity: duskIntensity,
      blurriness: 0.14,
    })
    return
  }

  setSceneBackdrop({
    variant: 'night',
    intensity: null,
    blurriness: null,
  })
}
