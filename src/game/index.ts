import type { GamePlugin } from '../engine/types'
import werewolfConfig from './config.json'
import { WerewolfGame } from './WerewolfGame'
import { isWerewolfRole } from './roles'
import {
  acknowledgeNight,
  advanceNight,
  castVote,
  claimCard,
  undoVote,
  createWerewolfState,
  dawnDone,
  dayTimeout,
  drunkSwap,
  extendNightActWindow,
  hunterKill,
  narratorAdvance,
  nightTimeout,
  pauseNight,
  playbackDone,
  playbackNext,
  replayNightPlayback,
  resumeNight,
  robberSwap,
  seerLookCenter,
  seerLookPlayer,
  setWerewolfTimers,
  skipNightStep,
  startNightAct,
  troublemakerSwap,
  werewolfPeekCenter,
} from './werewolfLogic'
import type { WerewolfRole, WerewolfSnapshot } from './werewolfTypes'

export const werewolfGame: GamePlugin<WerewolfSnapshot> = {
  id: 'werewolf',
  meta: {
    title: 'One Night AI Werewolf',
    description:
      'Claim a card, eyes-closed night on each device, then a timed daytime vote.',
  },
  maxPlayers: 10,
  seatMode: 'party',
  defaultControls: 'orbit',
  config: {
    controls: werewolfConfig.controls as 'orbit',
    maxPlayers: werewolfConfig.maxPlayers,
    table: {
      target: werewolfConfig.table.target as [number, number, number],
      camera: werewolfConfig.table.camera as [number, number, number],
    },
    elements: werewolfConfig.elements,
  },
  Scene: WerewolfGame,
  createInitialState: (_seats, opts) => {
    const ids = opts?.playerIds ?? []
    const roleDeck = (opts?.roleDeck ?? []).filter(
      isWerewolfRole,
    ) as WerewolfRole[]
    const playerNames = opts?.playerNames ?? {}
    const nightActMs =
      typeof opts?.nightActMs === 'number' ? opts.nightActMs : undefined
    const dayDurationMs =
      typeof opts?.dayDurationMs === 'number' ? opts.dayDurationMs : undefined
    const simultaneousNight = Boolean(opts?.simultaneousNight)
    const godMode = Boolean(opts?.godMode)
    const layoutSeed =
      typeof opts?.layoutSeed === 'number' ? opts.layoutSeed : undefined
    const cards = Array.isArray(opts?.cards)
      ? opts.cards
          .filter(
            (c): c is { id: string; role: WerewolfRole } =>
              Boolean(c) &&
              typeof c.id === 'string' &&
              isWerewolfRole(c.role),
          )
          .map((c) => ({ id: c.id, role: c.role }))
      : undefined
    const timing = {
      nightActMs,
      dayDurationMs,
      simultaneousNight,
      godMode,
      layoutSeed,
      cards,
    }
    if (ids.length < 3) {
      const padded = [
        ...ids,
        ...Array.from({ length: 3 - ids.length }, (_, i) => `placeholder_${i}`),
      ]
      return createWerewolfState(padded, {
        roleDeck,
        playerNames,
        ...timing,
      })
    }
    return createWerewolfState(ids, { roleDeck, playerNames, ...timing })
  },
  reduce: (state, intent, ctx) => {
    const current = state as WerewolfSnapshot
    switch (intent.type) {
      case 'werewolf.claim': {
        const cardId = typeof intent.cardId === 'string' ? intent.cardId : ''
        return claimCard(current, ctx.from, cardId)
      }
      case 'werewolf.advanceNight':
        return advanceNight(current, ctx.from)
      case 'werewolf.ack':
        return acknowledgeNight(current, ctx.from)
      case 'werewolf.werewolfPeek': {
        const centerIndex =
          typeof intent.centerIndex === 'number' ? intent.centerIndex : -1
        return werewolfPeekCenter(current, ctx.from, centerIndex)
      }
      case 'werewolf.seerPlayer': {
        const targetId =
          typeof intent.targetId === 'string' ? intent.targetId : ''
        return seerLookPlayer(current, ctx.from, targetId)
      }
      case 'werewolf.seerCenter': {
        const a = typeof intent.a === 'number' ? intent.a : -1
        const b = typeof intent.b === 'number' ? intent.b : -1
        return seerLookCenter(current, ctx.from, a, b)
      }
      case 'werewolf.robber': {
        const targetId =
          typeof intent.targetId === 'string' ? intent.targetId : ''
        return robberSwap(current, ctx.from, targetId)
      }
      case 'werewolf.troublemaker': {
        const a = typeof intent.a === 'string' ? intent.a : ''
        const b = typeof intent.b === 'string' ? intent.b : ''
        return troublemakerSwap(current, ctx.from, a, b)
      }
      case 'werewolf.drunk': {
        const centerIndex =
          typeof intent.centerIndex === 'number' ? intent.centerIndex : -1
        return drunkSwap(current, ctx.from, centerIndex)
      }
      case 'werewolf.vote': {
        const targetId =
          typeof intent.targetId === 'string' ? intent.targetId : ''
        return castVote(current, ctx.from, targetId)
      }
      case 'werewolf.undoVote':
        return undoVote(current, ctx.from)
      case 'werewolf.dayTimeout':
        return dayTimeout(current)
      case 'werewolf.startNightAct': {
        const actMs =
          typeof intent.actMs === 'number' ? intent.actMs : undefined
        return startNightAct(current, actMs)
      }
      case 'werewolf.extendNightAct': {
        const extraMs =
          typeof intent.extraMs === 'number' ? intent.extraMs : 40_000
        return extendNightActWindow(current, extraMs)
      }
      case 'werewolf.nightTimeout':
        return nightTimeout(current)
      case 'werewolf.skipNightStep':
        return skipNightStep(current)
      case 'werewolf.narratorAdvance':
        return narratorAdvance(current)
      case 'werewolf.dawnDone':
        return dawnDone(current)
      case 'werewolf.playbackNext':
        return playbackNext(current)
      case 'werewolf.playbackDone':
        return playbackDone(current)
      case 'werewolf.replayPlayback':
        return replayNightPlayback(current)
      case 'werewolf.pauseNight':
        return pauseNight(current)
      case 'werewolf.resumeNight':
        return resumeNight(current)
      case 'werewolf.setTimers': {
        const nightActMs =
          typeof intent.nightActMs === 'number' ? intent.nightActMs : current.nightActMs
        const dayDurationMs =
          typeof intent.dayDurationMs === 'number'
            ? intent.dayDurationMs
            : current.dayDurationMs
        return setWerewolfTimers(current, nightActMs, dayDurationMs)
      }
      case 'werewolf.hunterKill': {
        const targetId =
          typeof intent.targetId === 'string' ? intent.targetId : ''
        return hunterKill(current, ctx.from, targetId)
      }
      default:
        return current
    }
  },
}

export type { WerewolfSnapshot } from './werewolfTypes'
