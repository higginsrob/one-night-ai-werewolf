import { Billboard, Text } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GameSceneProps } from '../engine/types'
import { PlayerCard } from '../scene/PlayerCard'
import { reactionsFor } from '../scene/playerOverlay'
import { RoundTable, TABLE_FELT_RADIUS, TABLE_TOP } from '../scene/RoundTable'
import {
  clearTablePadBounds,
  publishTablePadBounds,
} from '../scene/sceneBounds'
import {
  buildTokenInventory,
  emptyPlacements,
  lockRoleOnTarget,
  placeTokenOn,
  targetsEqual,
  type TokenPlacement,
  type TokenTarget,
} from './characterTokens'
import {
  CharacterTokenMesh,
  TOKEN_HEIGHT,
  TOKEN_RADIUS,
} from './CharacterTokenMesh'
import { ROLE_CARD_HEIGHT } from './roleCardTextures'
import { nightStepReached } from './roles'
import { RoleCardMesh } from './RoleCardMesh'
import {
  layoutClaimScatter,
  layoutWerewolfTable,
  localSeatPoseIndex,
  type CardPose,
} from './tableLayout'
import {
  currentPlaybackBeat,
  dawnPlaybackBeats,
  effectivePlaybackBeatMs,
  playbackDisplayBoard,
  revealPlaybackBeats,
  syncWerewolfBackdrop,
  type PlaybackBeat,
} from './nightPlayback'
import { isGodSpectatorVision, spectatorDealFacesRevealed } from './godMode'
import { playerWon } from './werewolfLogic'
import {
  NO_VOTE_TARGET,
  type WerewolfRole,
  type WerewolfSnapshot,
} from './werewolfTypes'
import {
  setPendingVoteTargetId,
  subscribePendingVoteTarget,
} from './werewolfVoteUi'
import {
  setLocalCardSelectHandler,
  setLocalCardSelectable,
  setLocalCardTokens,
  setLocalTokenClickHandler,
  setLocalTokensInteractive,
} from './werewolfLocalCardUi'
import { resetSceneBackdrop } from '../scene/sceneBackdrop'
import {
  VoteArrowFx,
  VOTE_ARROW_HOLD_MS,
  type VoteFlight,
} from './VoteArrowFx'
import { playVoteSfx } from './voteSfx'

/** Matches PlayerCard height; used to park seat cards outside the ring. */
const PLAYER_CARD_H = 1.32
const PLAYER_CARD_W = 0.86
const SEAT_PLAYER_CARD_SCALE = 0.5

/** World position of the seat player card (vote arrow endpoints). */
function seatCharacterPos(pose: CardPose): [number, number, number] {
  const pos = pose.position
  const outward = Math.hypot(pos[0], pos[2]) || 1
  const nx = pos[0] / outward
  const nz = pos[2] / outward
  const seatCardDist =
    ROLE_CARD_HEIGHT * 0.5 +
    PLAYER_CARD_H * SEAT_PLAYER_CARD_SCALE * 0.5 +
    0.14
  return [
    pos[0] + nx * seatCardDist,
    TABLE_TOP + 0.56,
    pos[2] + nz * seatCardDist,
  ]
}

function tokenStackWorldPos(
  base: [number, number, number],
  yaw: number,
  stackIndex: number,
  stackCount: number,
): [number, number, number] {
  const along = (stackIndex - (stackCount - 1) / 2) * (TOKEN_RADIUS * 1.9)
  const dx = Math.cos(yaw) * along
  const dz = Math.sin(yaw) * along
  return [
    base[0] + dx,
    base[1] + TOKEN_HEIGHT * 0.55 + 0.012,
    base[2] + dz,
  ]
}

/** Local offsets for role tokens beside a billboarded seat player card. */
function playerCardTokenLocalPos(
  stackIndex: number,
  stackCount: number,
): [number, number, number] {
  const halfW = (PLAYER_CARD_W * SEAT_PLAYER_CARD_SCALE) / 2
  const x = halfW + TOKEN_RADIUS * 1.15
  const y = (stackIndex - (stackCount - 1) / 2) * (TOKEN_RADIUS * 2.05)
  return [x, y, 0.06]
}

function useAnimNow(active: boolean): number {
  const [now, setNow] = useState(() => performance.now())
  useFrame(() => {
    if (active) setNow(performance.now())
  })
  return now
}

type PickMode =
  | 'none'
  | 'claim'
  | 'werewolfPeek'
  | 'seer'
  | 'robber'
  | 'troublemaker'
  | 'drunk'
  | 'vote'
  | 'hunter'

type LocalFx =
  | { kind: 'idle' }
  | { kind: 'glow'; playerIds: string[]; actorIds?: string[] }
  | {
      kind: 'peekCenter'
      index: number
      role: WerewolfRole
      until: number
      actorIds?: string[]
    }
  | {
      kind: 'peekPlayer'
      playerId: string
      role: WerewolfRole
      until: number
      actorIds?: string[]
    }
  | {
      kind: 'flipSelf'
      playerId: string
      role: WerewolfRole
      until: number
    }
  | {
      kind: 'swap'
      a: string
      b: string
      /** 'player' ids or `center:N` */
      mode: 'players' | 'selfCenter'
      until: number
      faceRole?: WerewolfRole
      actorIds?: string[]
    }

function localFxFromBeat(beat: PlaybackBeat, until: number): LocalFx {
  switch (beat.kind) {
    case 'atmosphere':
    case 'announce':
      return { kind: 'idle' }
    case 'glow':
      return {
        kind: 'glow',
        playerIds: beat.playerIds,
        actorIds: beat.actorIds,
      }
    case 'peekCenter':
      return {
        kind: 'peekCenter',
        index: beat.index,
        role: beat.role,
        until,
        actorIds: beat.actorIds,
      }
    case 'peekPlayer':
      return {
        kind: 'peekPlayer',
        playerId: beat.playerId,
        role: beat.role,
        until,
        actorIds: beat.actorIds,
      }
    case 'swap':
      return {
        kind: 'swap',
        a: beat.a,
        b: beat.b,
        mode: beat.mode,
        until,
        faceRole: beat.faceRole,
        actorIds: beat.actorIds,
      }
    case 'flip':
      return {
        kind: 'flipSelf',
        playerId: beat.playerId,
        role: beat.role,
        until,
      }
  }
}

function parseCenterTargetId(id: string): number | null {
  if (!id.startsWith('center:')) return null
  const n = Number(id.slice('center:'.length))
  return Number.isFinite(n) ? n : null
}

/** Waking role(s) — teal actor ring. */
function nightActorIdsFromFx(fx: LocalFx): Set<string> {
  switch (fx.kind) {
    case 'glow':
      return new Set(fx.actorIds ?? [])
    case 'peekCenter':
    case 'peekPlayer':
    case 'swap':
      return new Set(fx.actorIds ?? [])
    case 'flipSelf':
      return new Set([fx.playerId])
    default:
      return new Set()
  }
}

/**
 * Cards peeked / selected this beat — yellow target ring (player seats).
 * Target wins over actor when the same id appears in both sets.
 */
function nightTargetIdsFromFx(fx: LocalFx): Set<string> {
  switch (fx.kind) {
    case 'glow':
      return new Set(fx.playerIds)
    case 'peekPlayer':
      return new Set([fx.playerId])
    case 'swap': {
      const ids = new Set<string>()
      if (parseCenterTargetId(fx.a) == null) ids.add(fx.a)
      if (parseCenterTargetId(fx.b) == null) ids.add(fx.b)
      return ids
    }
    case 'flipSelf':
      return new Set([fx.playerId])
    default:
      return new Set()
  }
}

/** Center indexes peeked / swapped this beat — yellow target ring. */
function nightTargetCenterIndexesFromFx(fx: LocalFx): Set<number> {
  switch (fx.kind) {
    case 'peekCenter':
      return new Set([fx.index])
    case 'swap': {
      const indexes = new Set<number>()
      const a = parseCenterTargetId(fx.a)
      const b = parseCenterTargetId(fx.b)
      if (a != null) indexes.add(a)
      if (b != null) indexes.add(b)
      return indexes
    }
    default:
      return new Set()
  }
}

function pickModeFor(
  game: WerewolfSnapshot,
  localClientId: string | null,
): PickMode {
  if (!localClientId || !game.playerIds.includes(localClientId)) return 'none'

  if (game.phase === 'claiming') {
    return 'claim'
  }

  const dealt = game.dealtRoles[localClientId]
  const ack = game.nightActions.acknowledged.includes(localClientId)

  if (game.phase === 'day') {
    return game.votes[localClientId] ? 'none' : 'vote'
  }

  if (
    game.phase === 'reveal' &&
    game.revealStage === 'hunter' &&
    game.killedIds.includes(localClientId) &&
    game.roles[localClientId] === 'hunter' &&
    !game.hunterKillId &&
    !game.winners
  ) {
    return 'hunter'
  }

  if (game.phase !== 'night' || ack) return 'none'

  if (game.nightStep === 'simultaneous' || game.simultaneousNight) {
    if (dealt === 'werewolf') {
      const wolves = game.playerIds.filter(
        (id) => game.dealtRoles[id] === 'werewolf',
      )
      if (wolves.length === 1 && !game.nightActions.werewolfPeek) {
        return 'werewolfPeek'
      }
      return 'none'
    }
    if (dealt === 'seer') return game.nightActions.seer ? 'none' : 'seer'
    if (dealt === 'robber') return game.nightActions.robber ? 'none' : 'robber'
    if (dealt === 'troublemaker') {
      return game.nightActions.troublemaker ? 'none' : 'troublemaker'
    }
    if (dealt === 'drunk') return game.nightActions.drunk ? 'none' : 'drunk'
    return 'none'
  }

  switch (game.nightStep) {
    case 'werewolves': {
      if (dealt !== 'werewolf') return 'none'
      const wolves = game.playerIds.filter(
        (id) => game.dealtRoles[id] === 'werewolf',
      )
      if (wolves.length === 1 && !game.nightActions.werewolfPeek) {
        return 'werewolfPeek'
      }
      return 'none'
    }
    case 'seer':
      if (dealt !== 'seer') return 'none'
      return game.nightActions.seer ? 'none' : 'seer'
    case 'robber':
      if (dealt !== 'robber') return 'none'
      return game.nightActions.robber ? 'none' : 'robber'
    case 'troublemaker':
      if (dealt !== 'troublemaker') return 'none'
      return game.nightActions.troublemaker ? 'none' : 'troublemaker'
    case 'drunk':
      if (dealt !== 'drunk') return 'none'
      return game.nightActions.drunk ? 'none' : 'drunk'
    default:
      return 'none'
  }
}

export function WerewolfGame({
  state,
  localClientId,
  players = [],
  reactions = [],
  interactive,
  onIntent,
}: GameSceneProps) {
  const game = state as WerewolfSnapshot | null
  const [seerCenters, setSeerCenters] = useState<number[]>([])
  const [tmPicks, setTmPicks] = useState<string[]>([])
  const [localFx, setLocalFx] = useState<LocalFx>({ kind: 'idle' })
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null)
  const [placements, setPlacements] = useState<Record<string, TokenPlacement>>(
    {},
  )
  const [pendingVoteTargetId, setPendingVoteLocal] = useState<string | null>(
    null,
  )
  const [voteFlights, setVoteFlights] = useState<VoteFlight[]>([])
  const tmDragFrom = useRef<string | null>(null)
  const tmDidDragSwap = useRef(false)
  const playbackBeatKey = useRef<string>('')
  const nightFxKey = useRef<string>('')
  const localCardSelectRef = useRef<(() => void) | null>(null)
  const localTokenClickRef = useRef<((tokenId: string) => void) | null>(null)
  const prevVotesRef = useRef<Record<string, string>>({})
  const votesSeededRef = useRef(false)
  const voteFlightSeq = useRef(0)
  const playersById = useMemo(() => {
    const m = new Map(players.map((p) => [p.id, p]))
    return m
  }, [players])

  const tokens = useMemo(
    () => buildTokenInventory(game?.roleDeck ?? []),
    [game?.roleDeck],
  )

  const godVision = isGodSpectatorVision(game, localClientId)
  const mode = game ? pickModeFor(game, localClientId) : 'none'
  /** Watch: flip after dawn's "Everyone, close your eyes." line. */
  const spectatorDealRevealed = spectatorDealFacesRevealed(game, godVision)

  // Local photo card is a DOM overlay — bridge vote / token taps from the HUD.
  useEffect(() => {
    if (!game || !localClientId || !interactive) {
      setLocalCardSelectable(false)
      setLocalCardSelectHandler(null)
      setLocalTokenClickHandler(null)
      setLocalTokensInteractive(false)
      setLocalCardTokens([])
      return
    }
    const claiming = game.phase === 'claiming'
    const night = game.phase === 'night'
    const playbackActive =
      game.phase === 'dawn' ||
      (game.phase === 'reveal' && game.revealStage === 'nightPlayback')
    const nightBusy = night && mode !== 'none'
    const tokensInteractive =
      !claiming &&
      !nightBusy &&
      !playbackActive &&
      game.playerIds.includes(localClientId)
    const placingToken = tokensInteractive && Boolean(selectedTokenId)
    const localSelectable = mode === 'vote' || placingToken
    setLocalCardSelectable(localSelectable)
    setLocalCardSelectHandler(
      localSelectable
        ? () => {
            localCardSelectRef.current?.()
          }
        : null,
    )
    setLocalTokensInteractive(tokensInteractive)
    setLocalTokenClickHandler(
      tokensInteractive
        ? (tokenId) => {
            localTokenClickRef.current?.(tokenId)
          }
        : null,
    )
    const stacked = tokens.filter((t) => {
      const p = placements[t.id]
      return (
        p?.target.kind === 'player' && p.target.playerId === localClientId
      )
    })
    setLocalCardTokens(
      stacked.map((t) => {
        const p = placements[t.id]!
        return {
          id: t.id,
          role: t.role,
          locked: p.locked,
          selected: selectedTokenId === t.id,
        }
      }),
    )
    return () => {
      setLocalCardSelectable(false)
      setLocalCardSelectHandler(null)
      setLocalTokenClickHandler(null)
      setLocalTokensInteractive(false)
      setLocalCardTokens([])
    }
  }, [
    game,
    localClientId,
    interactive,
    mode,
    selectedTokenId,
    tokens,
    placements,
  ])

  // Reset private token board when the round deck changes.
  useEffect(() => {
    setPlacements(emptyPlacements(tokens))
    setSelectedTokenId(null)
  }, [tokens, game?.layoutSeed])

  useEffect(() => {
    setSeerCenters([])
    setTmPicks([])
    tmDragFrom.current = null
    tmDidDragSwap.current = false
  }, [game?.nightStep, game?.phase, mode])

  useEffect(() => subscribePendingVoteTarget(setPendingVoteLocal), [])

  useEffect(() => {
    if (game?.phase !== 'day') setPendingVoteTargetId(null)
  }, [game?.phase])

  const requestVoteConfirm = useCallback(
    (targetId: string) => {
      if (!localClientId) return
      // Tap yourself (player card or role card) → confirm a no-vote.
      if (targetId === localClientId) {
        setPendingVoteTargetId(NO_VOTE_TARGET)
        return
      }
      setPendingVoteTargetId(targetId)
    },
    [localClientId],
  )

  // Auto-lock private knowledge tokens (local-only; peers never see these).
  useEffect(() => {
    if (!game || !localClientId || tokens.length === 0) return
    if (!game.playerIds.includes(localClientId)) return

    setPlacements((prev) => {
      let next = prev
      const lock = (role: WerewolfRole, target: TokenTarget) => {
        next = lockRoleOnTarget(tokens, next, role, target)
      }

      const dealt = game.dealtRoles[localClientId]
      // Starting claim — always mark on your own card (replaces HUD "Claimed").
      if (dealt) {
        lock(dealt, { kind: 'player', playerId: localClientId })
      }

      // Pack reveal — other werewolves at the table.
      if (
        dealt === 'werewolf' &&
        nightStepReached(game.phase, game.nightStep, 'werewolves')
      ) {
        for (const id of game.playerIds) {
          if (id === localClientId) continue
          if (game.dealtRoles[id] === 'werewolf') {
            lock('werewolf', { kind: 'player', playerId: id })
          }
        }
      }

      // Minion sees the werewolves.
      if (
        dealt === 'minion' &&
        nightStepReached(game.phase, game.nightStep, 'minion')
      ) {
        for (const id of game.playerIds) {
          if (game.dealtRoles[id] === 'werewolf') {
            lock('werewolf', { kind: 'player', playerId: id })
          }
        }
      }

      // Mason pair — fellow mason at the table.
      if (
        dealt === 'mason' &&
        nightStepReached(game.phase, game.nightStep, 'masons')
      ) {
        for (const id of game.playerIds) {
          if (id === localClientId) continue
          if (game.dealtRoles[id] === 'mason') {
            lock('mason', { kind: 'player', playerId: id })
          }
        }
      }

      const peek = game.nightActions.werewolfPeek
      if (peek?.playerId === localClientId) {
        lock(peek.role, { kind: 'center', index: peek.centerIndex })
      }

      const seer = game.nightActions.seer
      if (seer?.playerId === localClientId) {
        if (seer.view.kind === 'player') {
          lock(seer.view.role, {
            kind: 'player',
            playerId: seer.view.targetId,
          })
        } else {
          lock(seer.view.roles[0]!, {
            kind: 'center',
            index: seer.view.indexes[0]!,
          })
          lock(seer.view.roles[1]!, {
            kind: 'center',
            index: seer.view.indexes[1]!,
          })
        }
      }

      const robber = game.nightActions.robber
      if (robber?.playerId === localClientId) {
        lock(robber.stolenRole, {
          kind: 'player',
          playerId: localClientId,
        })
      }

      if (
        dealt === 'insomniac' &&
        nightStepReached(game.phase, game.nightStep, 'insomniac')
      ) {
        const current = game.roles[localClientId]
        if (current) {
          lock(current, { kind: 'player', playerId: localClientId })
        }
      }

      return next
    })
  }, [
    game,
    game?.nightActions,
    game?.nightStep,
    game?.phase,
    game?.roles,
    game?.dealtRoles,
    localClientId,
    tokens,
  ])

  // God vision (watch spectator): after the deal flip, lock dealt roles onto
  // seats so the gallery can compare night-start tokens vs live cards. Skip
  // center — those cards are face-up, so tokens there are redundant.
  useEffect(() => {
    if (!game || !godVision || !spectatorDealRevealed || tokens.length === 0)
      return
    if (Object.keys(game.dealtRoles).length === 0) return

    setPlacements((prev) => {
      let next = prev
      for (const id of game.playerIds) {
        const role = game.dealtRoles[id]
        if (!role) continue
        next = lockRoleOnTarget(tokens, next, role, {
          kind: 'player',
          playerId: id,
        })
      }
      return next
    })
  }, [
    game,
    game?.dealtRoles,
    game?.playerIds,
    godVision,
    spectatorDealRevealed,
    tokens,
  ])

  // Actor-only night FX — peers never see these local state changes.
  // Dawn / reveal nightPlayback use a separate synced schedule below.
  useEffect(() => {
    if (!game || !localClientId) {
      nightFxKey.current = ''
      setLocalFx({ kind: 'idle' })
      return
    }
    if (
      game.phase === 'dawn' ||
      (game.phase === 'reveal' && game.revealStage === 'nightPlayback')
    ) {
      nightFxKey.current = ''
      return
    }
    if (game.phase !== 'night') {
      nightFxKey.current = ''
      setLocalFx({ kind: 'idle' })
      return
    }

    const dealt = game.dealtRoles[localClientId]
    const now = performance.now()
    const hold = 1400
    const startFx = (key: string, fx: LocalFx) => {
      if (nightFxKey.current === key) return
      nightFxKey.current = key
      setLocalFx(fx)
    }

    if (game.nightStep === 'werewolves' && dealt === 'werewolf') {
      const wolves = game.playerIds.filter(
        (id) => game.dealtRoles[id] === 'werewolf',
      )
      const peek = game.nightActions.werewolfPeek
      if (peek?.playerId === localClientId) {
        startFx(`peekCenter:${peek.centerIndex}:${peek.role}`, {
          kind: 'peekCenter',
          index: peek.centerIndex,
          role: peek.role,
          until: now + hold,
        })
        return
      }
      if (wolves.length > 1) {
        const ids = wolves.filter((id) => id !== localClientId)
        startFx(`glow:ww:${ids.join(',')}`, {
          kind: 'glow',
          playerIds: ids,
        })
        return
      }
    }

    if (game.nightStep === 'minion' && dealt === 'minion') {
      const wolves = game.playerIds.filter(
        (id) => game.dealtRoles[id] === 'werewolf',
      )
      startFx(`glow:minion:${wolves.join(',')}`, {
        kind: 'glow',
        playerIds: wolves,
        actorIds: [localClientId],
      })
      return
    }

    if (game.nightStep === 'masons' && dealt === 'mason') {
      const others = game.playerIds.filter(
        (id) => game.dealtRoles[id] === 'mason' && id !== localClientId,
      )
      startFx(`glow:mason:${others.join(',')}`, {
        kind: 'glow',
        playerIds: others,
      })
      return
    }

    if (game.nightStep === 'seer' && dealt === 'seer') {
      const seer = game.nightActions.seer
      if (seer?.playerId === localClientId) {
        if (seer.view.kind === 'player') {
          startFx(`peekPlayer:${seer.view.targetId}`, {
            kind: 'peekPlayer',
            playerId: seer.view.targetId,
            role: seer.view.role,
            until: now + hold,
          })
        } else {
          startFx(`peekCenter:${seer.view.indexes[0]}`, {
            kind: 'peekCenter',
            index: seer.view.indexes[0]!,
            role: seer.view.roles[0]!,
            until: now + hold,
          })
        }
        return
      }
    }

    if (game.nightStep === 'robber' && dealt === 'robber') {
      const robbed = game.nightActions.robber
      if (robbed?.playerId === localClientId) {
        startFx(`swap:robber:${robbed.targetId}`, {
          kind: 'swap',
          a: localClientId,
          b: robbed.targetId,
          mode: 'players',
          until: now + hold,
          faceRole: robbed.stolenRole,
        })
        return
      }
    }

    if (game.nightStep === 'troublemaker' && dealt === 'troublemaker') {
      const tm = game.nightActions.troublemaker
      if (tm?.playerId === localClientId) {
        startFx(`swap:tm:${tm.a}:${tm.b}`, {
          kind: 'swap',
          a: tm.a,
          b: tm.b,
          mode: 'players',
          until: now + hold,
        })
        return
      }
    }

    if (game.nightStep === 'drunk' && dealt === 'drunk') {
      const drunk = game.nightActions.drunk
      if (drunk?.playerId === localClientId) {
        startFx(`swap:drunk:${drunk.centerIndex}`, {
          kind: 'swap',
          a: localClientId,
          b: `center:${drunk.centerIndex}`,
          mode: 'selfCenter',
          until: now + hold,
        })
        return
      }
    }

    if (game.nightStep === 'insomniac' && dealt === 'insomniac') {
      const current = game.roles[localClientId]
      if (current) {
        startFx(`flip:${current}`, {
          kind: 'flipSelf',
          playerId: localClientId,
          role: current,
          until: now + hold,
        })
        return
      }
    }

    nightFxKey.current = ''
    setLocalFx({ kind: 'idle' })
  }, [
    game,
    game?.phase,
    game?.nightStep,
    game?.nightActions,
    game?.roles,
    game?.revealStage,
    localClientId,
  ])

  // Synced dawn / post-vote night playback (everyone sees the same beats).
  useEffect(() => {
    if (!game) return
    const isDawn = game.phase === 'dawn'
    const isRevealPlay =
      game.phase === 'reveal' && game.revealStage === 'nightPlayback'
    if (!isDawn && !isRevealPlay) {
      playbackBeatKey.current = ''
      return
    }

    const beats = isDawn ? dawnPlaybackBeats(game) : revealPlaybackBeats(game)
    const beatMs = effectivePlaybackBeatMs(game)
    const tick = () => {
      const cur = currentPlaybackBeat(
        beats,
        game.playbackStartedAt,
        Date.now(),
        beatMs,
        (isDawn && game.godMode) || isRevealPlay
          ? game.playbackBeatIndex
          : null,
      )
      if (!cur) {
        setLocalFx({ kind: 'idle' })
        return
      }
      const key = `${game.phase}:${game.revealStage}:${game.playbackStartedAt}:${game.playbackBeatIndex}:${cur.index}`
      if (key === playbackBeatKey.current) return
      playbackBeatKey.current = key
      const until = performance.now() + beatMs
      setLocalFx(localFxFromBeat(cur.beat, until))
    }

    tick()
    const id = window.setInterval(tick, 100)
    return () => window.clearInterval(id)
  }, [
    game,
    game?.phase,
    game?.revealStage,
    game?.playbackStartedAt,
    game?.playbackBeatMs,
    game?.playbackBeatIndex,
    game?.godMode,
    game?.nightActions,
  ])

  useFrame(() => {
    if (!game) return
    syncWerewolfBackdrop(game, Date.now())
  })

  useEffect(() => {
    return () => resetSceneBackdrop()
  }, [])

  // Clear timed FX.
  useEffect(() => {
    if (
      localFx.kind !== 'peekCenter' &&
      localFx.kind !== 'peekPlayer' &&
      localFx.kind !== 'flipSelf' &&
      localFx.kind !== 'swap'
    ) {
      return
    }
    const ms = Math.max(0, localFx.until - performance.now())
    const t = window.setTimeout(() => {
      if (
        !game ||
        game.phase === 'dawn' ||
        (game.phase === 'reveal' && game.revealStage === 'nightPlayback')
      ) {
        // Playback schedule owns the next beat.
        return
      }
      // Keep glow for pack/minion while step active; clear peeks/swaps to settled.
      if (game.phase !== 'night') {
        setLocalFx({ kind: 'idle' })
        return
      }
      const dealt = localClientId ? game.dealtRoles[localClientId] : null
      if (game.nightStep === 'werewolves' && dealt === 'werewolf') {
        const wolves = game.playerIds.filter(
          (id) => game.dealtRoles[id] === 'werewolf' && id !== localClientId,
        )
        if (wolves.length > 0) {
          setLocalFx({ kind: 'glow', playerIds: wolves })
          return
        }
      }
      if (game.nightStep === 'minion' && dealt === 'minion') {
        const wolves = game.playerIds.filter(
          (id) => game.dealtRoles[id] === 'werewolf',
        )
        setLocalFx({ kind: 'glow', playerIds: wolves })
        return
      }
      if (game.nightStep === 'masons' && dealt === 'mason') {
        const others = game.playerIds.filter(
          (id) => game.dealtRoles[id] === 'mason' && id !== localClientId,
        )
        setLocalFx({ kind: 'glow', playerIds: others })
        return
      }
      if (localFx.kind === 'swap' && localFx.faceRole && localClientId) {
        setLocalFx({
          kind: 'flipSelf',
          playerId: localClientId,
          role: localFx.faceRole,
          until: performance.now() + 1200,
        })
        return
      }
      setLocalFx({ kind: 'idle' })
    }, ms)
    return () => window.clearTimeout(t)
  }, [localFx, game, localClientId])

  const tableLayout = useMemo(
    () => layoutWerewolfTable(game?.playerIds.length ?? 3),
    [game?.playerIds.length],
  )

  useEffect(() => {
    const tableScale = Math.max(1, tableLayout.padRadius / TABLE_FELT_RADIUS)
    publishTablePadBounds({
      centerX: 0,
      centerY: TABLE_TOP,
      centerZ: 0,
      radius: TABLE_FELT_RADIUS * tableScale,
    })
    return () => clearTablePadBounds()
  }, [tableLayout.padRadius])

  const localSeatIndex = useMemo(() => {
    if (!game || !localClientId) return -1
    return game.playerIds.indexOf(localClientId)
  }, [game, localClientId])

  const poseIndexForPlayer = useCallback(
    (playerIndex: number) =>
      localSeatPoseIndex(
        playerIndex,
        localSeatIndex,
        game?.playerIds.length ?? 0,
      ),
    [game?.playerIds.length, localSeatIndex],
  )

  // Day vote cast / change → SFX + short-lived arrow from voter → target.
  useEffect(() => {
    if (!game || game.phase !== 'day') {
      prevVotesRef.current = {}
      votesSeededRef.current = false
      setVoteFlights([])
      return
    }
    const votes = game.votes
    if (!votesSeededRef.current) {
      prevVotesRef.current = { ...votes }
      votesSeededRef.current = true
      return
    }
    const prev = prevVotesRef.current
    const added: VoteFlight[] = []
    const now = performance.now()
    for (const [voterId, targetId] of Object.entries(votes)) {
      if (prev[voterId] === targetId) continue
      playVoteSfx()
      if (!targetId || targetId === NO_VOTE_TARGET) continue
      const iFrom = game.playerIds.indexOf(voterId)
      const iTo = game.playerIds.indexOf(targetId)
      if (iFrom < 0 || iTo < 0) continue
      const poseFrom = tableLayout.players[poseIndexForPlayer(iFrom)]
      const poseTo = tableLayout.players[poseIndexForPlayer(iTo)]
      if (!poseFrom || !poseTo) continue
      voteFlightSeq.current += 1
      added.push({
        id: `vote-${voteFlightSeq.current}-${voterId}`,
        from: seatCharacterPos(poseFrom),
        to: seatCharacterPos(poseTo),
        createdAt: now,
        until: now + VOTE_ARROW_HOLD_MS,
      })
    }
    prevVotesRef.current = { ...votes }
    if (added.length === 0) return
    setVoteFlights((cur) => [...cur.filter((f) => f.until > now), ...added])
  }, [game, poseIndexForPlayer, tableLayout.players])

  // Drop expired vote arrows.
  useEffect(() => {
    if (voteFlights.length === 0) return
    const nextUntil = Math.min(...voteFlights.map((f) => f.until))
    const ms = Math.max(0, nextUntil - performance.now()) + 30
    const t = window.setTimeout(() => {
      const now = performance.now()
      setVoteFlights((cur) => cur.filter((f) => f.until > now))
    }, ms)
    return () => window.clearTimeout(t)
  }, [voteFlights])

  const claimPoses = useMemo(
    () =>
      game
        ? layoutClaimScatter(game.cards.length, game.layoutSeed)
        : [],
    [game?.cards.length, game?.layoutSeed],
  )

  /** Votes against each player (day + reveal tallies on the table). */
  const votesAgainstById = useMemo(() => {
    const counts = new Map<string, number>()
    if (!game || (game.phase !== 'day' && game.phase !== 'reveal')) {
      return counts
    }
    for (const target of Object.values(game.votes)) {
      if (!target || target === NO_VOTE_TARGET) continue
      counts.set(target, (counts.get(target) ?? 0) + 1)
    }
    return counts
  }, [game])

  const fxTimed =
    localFx.kind === 'swap' ||
    localFx.kind === 'peekCenter' ||
    localFx.kind === 'peekPlayer' ||
    localFx.kind === 'flipSelf' ||
    voteFlights.length > 0
  const now = useAnimNow(fxTimed)

  const assignSelectedToken = useCallback(
    (target: TokenTarget) => {
      if (!selectedTokenId) return false
      const cur = placements[selectedTokenId]
      if (!cur || cur.locked) {
        setSelectedTokenId(null)
        return false
      }
      if (targetsEqual(cur.target, target)) {
        setPlacements((prev) =>
          placeTokenOn(prev, selectedTokenId, { kind: 'tray' }, false),
        )
      } else {
        setPlacements((prev) =>
          placeTokenOn(prev, selectedTokenId, target, false),
        )
      }
      setSelectedTokenId(null)
      return true
    },
    [placements, selectedTokenId],
  )

  if (!game) return null

  const claiming = game.phase === 'claiming'
  // End scene: all cards face-up for the whole reveal (night replay, hunter, result).
  const revealed = game.phase === 'reveal'
  // Hold winner/loser chrome until the narrated night recap finishes.
  const showOutcome =
    revealed && game.revealStage !== 'nightPlayback' && Boolean(game.winners)
  const night = game.phase === 'night'
  const playbackActive =
    game.phase === 'dawn' ||
    (game.phase === 'reveal' && game.revealStage === 'nightPlayback')
  const playbackBeatMs = effectivePlaybackBeatMs(game)
  const canAct = interactive && mode !== 'none'
  const nightBusy = night && mode !== 'none'
  const tokensInteractive =
    interactive &&
    !claiming &&
    !nightBusy &&
    !playbackActive &&
    Boolean(localClientId && game.playerIds.includes(localClientId))
  const swapActive = localFx.kind === 'swap' && now < localFx.until
  const swapHoldMs = playbackActive ? playbackBeatMs : 1400
  const swapProgress = swapActive
    ? 1 - (localFx.until - now) / swapHoldMs
    : 0
  /**
   * Face-up table for post-vote reveal, or watch spectators after the dawn
   * "close your eyes" line. Claiming + live night stay face-down in god vision.
   */
  const cardsFaceUp = revealed || (godVision && spectatorDealRevealed)
  // Dawn / nightPlayback: start on dealt cards, apply swaps as their beats play.
  const playbackBoard = playbackActive ? playbackDisplayBoard(game) : null
  const tableRoles = playbackBoard?.roles ?? game.roles
  const tableCenter = playbackBoard?.center ?? game.center

  const onTokenClick = (tokenId: string) => {
    if (!tokensInteractive) return
    const cur = placements[tokenId]
    if (!cur) return
    if (cur.locked) {
      setSelectedTokenId(null)
      return
    }
    if (selectedTokenId === tokenId) {
      setSelectedTokenId(null)
      return
    }
    setSelectedTokenId(tokenId)
  }

  const onCenter = (index: number) => {
    if (selectedTokenId && tokensInteractive) {
      assignSelectedToken({ kind: 'center', index })
      return
    }
    if (!canAct || !onIntent) return
    if (mode === 'werewolfPeek' || mode === 'drunk') {
      onIntent({
        type: mode === 'drunk' ? 'werewolf.drunk' : 'werewolf.werewolfPeek',
        centerIndex: index,
      })
      return
    }
    if (mode === 'seer') {
      setSeerCenters((prev) => {
        if (prev.includes(index)) return prev.filter((x) => x !== index)
        const next = [...prev, index].slice(-2)
        if (next.length === 2) {
          onIntent({ type: 'werewolf.seerCenter', a: next[0], b: next[1] })
        }
        return next
      })
    }
  }

  const submitTroublemaker = (a: string, b: string) => {
    if (!onIntent || a === b) return
    onIntent({ type: 'werewolf.troublemaker', a, b })
    setTmPicks([a, b])
    tmDragFrom.current = null
  }

  const pickTroublemaker = (playerId: string) => {
    if (!localClientId || playerId === localClientId) return
    if (tmDidDragSwap.current) {
      tmDidDragSwap.current = false
      return
    }
    if (tmPicks.includes(playerId)) {
      setTmPicks((prev) => prev.filter((x) => x !== playerId))
      return
    }
    if (tmPicks.length === 0) {
      setTmPicks([playerId])
      return
    }
    submitTroublemaker(tmPicks[0]!, playerId)
  }

  const onPlayer = (playerId: string) => {
    if (selectedTokenId && tokensInteractive) {
      assignSelectedToken({ kind: 'player', playerId })
      return
    }
    if (!canAct || !onIntent || !localClientId) return
    if (mode === 'seer') {
      if (playerId === localClientId) return
      onIntent({ type: 'werewolf.seerPlayer', targetId: playerId })
      return
    }
    if (mode === 'robber') {
      if (playerId === localClientId) return
      onIntent({ type: 'werewolf.robber', targetId: playerId })
      return
    }
    if (mode === 'troublemaker') {
      pickTroublemaker(playerId)
      return
    }
    if (mode === 'vote') {
      requestVoteConfirm(playerId)
      return
    }
    if (mode === 'hunter') {
      if (playerId === localClientId) return
      onIntent({ type: 'werewolf.hunterKill', targetId: playerId })
    }
  }

  const onTmPointerDown = (playerId: string) => {
    if (!canAct || mode !== 'troublemaker' || playerId === localClientId) return
    tmDragFrom.current = playerId
    tmDidDragSwap.current = false
  }

  const onTmPointerUp = (playerId: string) => {
    if (!canAct || mode !== 'troublemaker' || !onIntent) return
    const from = tmDragFrom.current
    tmDragFrom.current = null
    if (!from || from === playerId || playerId === localClientId) return
    tmDidDragSwap.current = true
    submitTroublemaker(from, playerId)
  }

  const onClaim = (cardId: string) => {
    if (!canAct || !onIntent || mode !== 'claim') return
    onIntent({ type: 'werewolf.claim', cardId })
  }

  const placingToken = tokensInteractive && Boolean(selectedTokenId)
  const centerSelectable =
    placingToken ||
    (canAct &&
      (mode === 'werewolfPeek' || mode === 'seer' || mode === 'drunk'))
  const playerSelectable =
    placingToken ||
    (canAct &&
      (mode === 'seer' ||
        mode === 'robber' ||
        mode === 'troublemaker' ||
        mode === 'vote' ||
        mode === 'hunter'))

  // Keep DOM overlay handlers in sync (refs assigned each render).
  localCardSelectRef.current = localClientId
    ? () => onPlayer(localClientId)
    : null
  localTokenClickRef.current = onTokenClick
  const trayTokens = tokens.filter(
    (t) => (placements[t.id] ?? { target: { kind: 'tray' as const } }).target
      .kind === 'tray',
  )
  // Outside the pad toward the default camera (+Z), so tokens don't sit on a seat.
  const trayZ = tableLayout.padRadius + 0.28
  const trayY = TABLE_TOP + TOKEN_HEIGHT / 2 + 0.028
  const trayCols = Math.min(7, Math.max(1, trayTokens.length))
  const trayRows = Math.max(1, Math.ceil(trayTokens.length / trayCols))
  // Flat outcome banner on the wood strip in front of the token tray (players only).
  const seatedPlaying = Boolean(
    localClientId && game.playerIds.includes(localClientId),
  )
  const localOutcome =
    seatedPlaying && showOutcome ? playerWon(game, localClientId!) : null
  const outcomeLabelZ =
    trayZ + (trayRows - 1) * (TOKEN_RADIUS * 2.15) + 0.58
  const tableScale = Math.max(1, tableLayout.padRadius / TABLE_FELT_RADIUS)

  const nightActorIds = nightActorIdsFromFx(localFx)
  const nightTargetIds = nightTargetIdsFromFx(localFx)
  const nightTargetCenters = nightTargetCenterIndexesFromFx(localFx)

  const nightHighlightForPlayer = (
    id: string,
  ): false | 'actor' | 'target' => {
    if (nightTargetIds.has(id)) return 'target'
    if (nightActorIds.has(id)) return 'actor'
    return false
  }

  const nightHighlightForCenter = (
    index: number,
  ): false | 'actor' | 'target' => {
    if (nightTargetCenters.has(index)) return 'target'
    return false
  }

  const peekCenterIndex =
    localFx.kind === 'peekCenter' && now < localFx.until
      ? localFx.index
      : -1
  const peekCenterRole =
    localFx.kind === 'peekCenter' ? localFx.role : null

  const peekPlayerId =
    localFx.kind === 'peekPlayer' && now < localFx.until
      ? localFx.playerId
      : null
  const peekPlayerRole =
    localFx.kind === 'peekPlayer' ? localFx.role : null

  const flipPlayerId =
    localFx.kind === 'flipSelf' && now < localFx.until
      ? localFx.playerId
      : null
  const flipRole =
    localFx.kind === 'flipSelf' && now < localFx.until
      ? localFx.role
      : null

  // Roles are already swapped in state — animate each card FROM the other
  // seat TO its home so it arrives and stays (no snap-back when FX ends).
  const swapTravel = (tRaw: number) => {
    const t = Math.min(1, Math.max(0, tRaw))
    const travel = Math.min(1, t / 0.65)
    const ease = travel * travel * (3 - 2 * travel)
    const lift = Math.sin(travel * Math.PI) * 0.35
    return { ease, lift }
  }

  const playerCardOffset = (id: string): [number, number, number] | null => {
    if (!swapActive || localFx.kind !== 'swap') return null
    const { ease, lift } = swapTravel(swapProgress)
    if (localFx.mode === 'players') {
      if (id !== localFx.a && id !== localFx.b) return null
      const iA = game.playerIds.indexOf(localFx.a)
      const iB = game.playerIds.indexOf(localFx.b)
      const poseA = tableLayout.players[poseIndexForPlayer(iA)]
      const poseB = tableLayout.players[poseIndexForPlayer(iB)]
      if (!poseA || !poseB) return null
      // Arrive home: start at the other seat, ease to this seat.
      const from = id === localFx.a ? poseB : poseA
      const to = id === localFx.a ? poseA : poseB
      return [
        from.position[0] + (to.position[0] - from.position[0]) * ease,
        from.position[1] + lift,
        from.position[2] + (to.position[2] - from.position[2]) * ease,
      ]
    }
    // Drunk (and playback): move the swapped player's card, not only local.
    if (localFx.mode === 'selfCenter' && id === localFx.a) {
      const i = game.playerIds.indexOf(id)
      const pose = tableLayout.players[poseIndexForPlayer(i)]
      const cIdx = Number(localFx.b.split(':')[1] ?? -1)
      const cPose = tableLayout.center[cIdx]
      if (!pose || !cPose) return null
      // Arrive at the player seat from the center.
      return [
        cPose.position[0] + (pose.position[0] - cPose.position[0]) * ease,
        pose.position[1] + lift,
        cPose.position[2] + (pose.position[2] - cPose.position[2]) * ease,
      ]
    }
    return null
  }

  const centerCardOffset = (index: number): [number, number, number] | null => {
    if (!swapActive || localFx.kind !== 'swap') return null
    if (localFx.mode !== 'selfCenter') return null
    const cIdx = Number(localFx.b.split(':')[1] ?? -1)
    if (index !== cIdx) return null
    const { ease, lift } = swapTravel(swapProgress)
    const i = game.playerIds.indexOf(localFx.a)
    const pose = tableLayout.players[poseIndexForPlayer(i)]
    const cPose = tableLayout.center[index]
    if (!pose || !cPose) return null
    // Arrive at center from the drunk's seat.
    return [
      pose.position[0] + (cPose.position[0] - pose.position[0]) * ease,
      cPose.position[1] + lift,
      pose.position[2] + (cPose.position[2] - pose.position[2]) * ease,
    ]
  }

  return (
    <group>
      <RoundTable scale={tableScale} />

      {claiming &&
        game.cards.map((card, i) => {
          const pose = claimPoses[i]
          if (!pose) return null
          const claimedByOther =
            Boolean(card.claimBy) && card.claimBy !== localClientId
          const claimedByMe = card.claimBy === localClientId
          const alreadyClaimed = game.cards.some(
            (c) => c.claimBy === localClientId,
          )
          const free = !card.claimBy
          return (
            <RoleCardMesh
              key={card.id}
              role={card.role}
              faceDown
              selected={claimedByMe}
              dimmed={claimedByOther || (alreadyClaimed && free)}
              selectable={canAct && free && !alreadyClaimed}
              position={pose.position}
              rotation={pose.rotation}
              onClick={() => onClaim(card.id)}
            />
          )
        })}

      {!claiming &&
        tableLayout.center.map((pose, i) => {
          const cardPos = centerCardOffset(i) ?? pose.position
          const pos = pose.position
          const faceUp =
            cardsFaceUp ||
            (peekCenterIndex === i && Boolean(peekCenterRole))
          const showRole =
            peekCenterIndex === i && peekCenterRole
              ? peekCenterRole
              : tableCenter[i]
          const stacked = tokens.filter((t) => {
            const p = placements[t.id]
            return (
              p?.target.kind === 'center' && p.target.index === i
            )
          })
          return (
            <group key={`c-${i}`}>
              <RoleCardMesh
                role={showRole}
                faceDown={!faceUp}
                selected={seerCenters.includes(i)}
                highlighted={nightHighlightForCenter(i)}
                selectable={centerSelectable}
                position={cardPos}
                rotation={pose.rotation}
                onClick={() => onCenter(i)}
              />
              {stacked.map((t, si) => {
                const p = placements[t.id]!
                return (
                  <CharacterTokenMesh
                    key={t.id}
                    role={t.role}
                    selected={selectedTokenId === t.id}
                    locked={p.locked}
                    position={tokenStackWorldPos(
                      pos,
                      pose.rotation[2],
                      si,
                      stacked.length,
                    )}
                    onClick={
                      tokensInteractive
                        ? () => onTokenClick(t.id)
                        : undefined
                    }
                  />
                )
              })}
            </group>
          )
        })}

      {!claiming &&
        game.playerIds.map((id, i) => {
          const pose = tableLayout.players[poseIndexForPlayer(i)]
          if (!pose) return null
          const name = game.playerNames[id] ?? `Player ${i + 1}`
          const isSelf = id === localClientId
          const selected =
            tmPicks.includes(id) ||
            pendingVoteTargetId === id ||
            (pendingVoteTargetId === NO_VOTE_TARGET && isSelf)
          const votesAgainst = votesAgainstById.get(id) ?? 0
          const canPickPlayer =
            playerSelectable &&
            (placingToken ||
              (!(mode === 'seer' && isSelf) &&
                !(mode === 'robber' && isSelf) &&
                !(mode === 'troublemaker' && isSelf) &&
                !(mode === 'hunter' && isSelf)))
          const playerCardSelectable =
            (canAct && mode === 'vote') ||
            (placingToken && tokensInteractive)

          const pos = pose.position
          const cardPos = playerCardOffset(id) ?? pos
          const faceUp =
            cardsFaceUp ||
            (peekPlayerId === id && Boolean(peekPlayerRole)) ||
            (flipPlayerId === id && Boolean(flipRole))
          const showRole =
            peekPlayerId === id && peekPlayerRole
              ? peekPlayerRole
              : flipPlayerId === id && flipRole
                ? flipRole
                : tableRoles[id]

          const owner = playersById.get(id) ?? {
            id,
            name,
            color: isSelf ? '#c9a227' : '#7a8494',
            connected: true,
            cameraOn: false,
            peerId: '',
            deviceId: '',
            photoDataUrl: null,
            emoticonPhotos: {},
            mediaFilter: 'none',
            joinedAt: 0,
          }
          const outcome = showOutcome ? playerWon(game, id) : null
          const isWinner = outcome === true
          const isLoser = outcome === false
          let voteFooter: string | null = null
          if (revealed) {
            const voteTarget = game.votes[id]
            if (!voteTarget) voteFooter = "Didn't vote"
            else if (voteTarget === NO_VOTE_TARGET) voteFooter = 'No vote'
            else voteFooter = `→ ${game.playerNames[voteTarget] ?? 'Player'}`
          } else if (game.phase === 'day') {
            const voteTarget = game.votes[id]
            if (voteTarget === NO_VOTE_TARGET) voteFooter = 'No vote'
            else if (voteTarget)
              voteFooter = `→ ${game.playerNames[voteTarget] ?? 'Player'}`
          }
          const stacked = tokens.filter((t) => {
            const p = placements[t.id]
            return (
              p?.target.kind === 'player' && p.target.playerId === id
            )
          })

          // Player card toward outside of the circle
          const seatCardPos = seatCharacterPos(pose)
          // Local photo card is a DOM overlay — tokens render beside it in the HUD.

          return (
            <group key={id}>
              <RoleCardMesh
                role={showRole}
                faceDown={!faceUp}
                selected={selected}
                highlighted={nightHighlightForPlayer(id)}
                selectable={canPickPlayer}
                position={cardPos}
                rotation={pose.rotation}
                onClick={() => onPlayer(id)}
                onPointerDown={
                  mode === 'troublemaker' && !placingToken
                    ? () => onTmPointerDown(id)
                    : undefined
                }
                onPointerUp={
                  mode === 'troublemaker' && !placingToken
                    ? () => onTmPointerUp(id)
                    : undefined
                }
              />
              {!isSelf && (
                <group position={seatCardPos} scale={SEAT_PLAYER_CARD_SCALE}>
                  <PlayerCard
                    player={owner}
                    position={[0, 0, 0]}
                    highlight={selected}
                    winner={isWinner}
                    loser={isLoser}
                    footer={voteFooter ?? undefined}
                    votesAgainst={votesAgainst}
                    reactions={reactionsFor(reactions, id)}
                    selectable={playerCardSelectable}
                    onSelect={
                      playerCardSelectable ? () => onPlayer(id) : undefined
                    }
                  />
                </group>
              )}
              {/* Private guess / night-knowledge tokens beside seat player cards.
                  Local-player tokens live in the DOM card dock. */}
              {!isSelf && stacked.length > 0 && (
                <Billboard position={seatCardPos} follow>
                  {stacked.map((t, si) => {
                    const p = placements[t.id]!
                    return (
                      <CharacterTokenMesh
                        key={t.id}
                        role={t.role}
                        facing="camera"
                        selected={selectedTokenId === t.id}
                        locked={p.locked}
                        position={playerCardTokenLocalPos(si, stacked.length)}
                        onClick={
                          tokensInteractive
                            ? () => onTokenClick(t.id)
                            : undefined
                        }
                      />
                    )
                  })}
                </Billboard>
              )}
            </group>
          )
        })}

      {/* Private character-token tray (local only). */}
      {!claiming && tokens.length > 0 && (
        <group>
          {placingToken && (
            <mesh
              position={[0, TABLE_TOP + 0.02, trayZ]}
              rotation={[-Math.PI / 2, 0, 0]}
              onClick={(e) => {
                e.stopPropagation()
                assignSelectedToken({ kind: 'tray' })
              }}
            >
              <planeGeometry
                args={[
                  Math.max(1.2, trayCols * TOKEN_RADIUS * 2.3),
                  0.42,
                ]}
              />
              <meshBasicMaterial transparent opacity={0.001} depthWrite={false} />
            </mesh>
          )}
          {trayTokens.map((t, i) => {
            const row = Math.floor(i / trayCols)
            const col = i % trayCols
            const rowLen = Math.min(trayCols, trayTokens.length - row * trayCols)
            const x =
              (col - (rowLen - 1) / 2) * (TOKEN_RADIUS * 2.15)
            const z = trayZ + row * (TOKEN_RADIUS * 2.15)
            const p = placements[t.id]
            return (
              <CharacterTokenMesh
                key={t.id}
                role={t.role}
                selected={selectedTokenId === t.id}
                locked={Boolean(p?.locked)}
                position={[x, trayY, z]}
                onClick={
                  tokensInteractive ? () => onTokenClick(t.id) : undefined
                }
              />
            )
          })}
        </group>
      )}

      {/* Day vote: arrow from voter character → target (fades after a few seconds). */}
      <VoteArrowFx flights={voteFlights} />

      {/* Local player win/loss — big table label (not shown while spectating). */}
      {localOutcome != null && (
        <Text
          position={[0, TABLE_TOP + 0.025, outcomeLabelZ]}
          rotation={[-Math.PI / 2, 0, 0]}
          fontSize={0.42}
          color={localOutcome ? '#f0c040' : '#c4c8d0'}
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.028}
          outlineColor="#0a120c"
          letterSpacing={0.04}
        >
          {localOutcome ? 'Winner' : 'Loser'}
        </Text>
      )}
    </group>
  )
}
