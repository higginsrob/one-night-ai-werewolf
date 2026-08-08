import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { reactionsFor } from '../scene/playerOverlay'
import type { ClientIntent } from '../net/protocol'
import type { PlayerPublic, ReactionEvent } from '../session/types'
import { ROLE_CARD_FACE_URL, ROLE_TOKEN_URL } from './onwArt'
import { narrationForHumanNight, narrationForStep, roleName } from './roles'
import { teamColorsForRole } from './roleCardTextures'
import {
  actorsForStep,
  isNightActor,
  myClaimedRole,
  myDealtRole,
  playerHasNightPhase,
  playerNeedsNightIntent,
  playersWithDealtRole,
} from './werewolfLogic'
import {
  currentPlaybackBeat,
  dawnPlaybackBeats,
  effectivePlaybackBeatMs,
  playbackFinished,
  revealPlaybackBeats,
} from './nightPlayback'
import {
  presentRolesInHand,
  unlockHostNarrator,
  useHostNarrator,
} from './useHostNarrator'
import {
  NO_VOTE_TARGET,
  type WerewolfRole,
  type WerewolfSnapshot,
} from './werewolfTypes'
import { WerewolfVoteCastCard, WerewolfVoteOverlay } from './WerewolfVoteOverlay'
import {
  setPendingVoteTargetId,
  subscribePendingVoteTarget,
} from './werewolfVoteUi'
import { useNarrowViewport } from '../ui/useNarrowViewport'
import {
  getLocalCardSelectable,
  getLocalCardTokens,
  getLocalTokensInteractive,
  requestLocalCardSelect,
  requestLocalTokenClick,
  subscribeLocalCardSelectable,
  subscribeLocalCardTokens,
  subscribeLocalTokensInteractive,
  type LocalCardTokenUi,
} from './werewolfLocalCardUi'

type OnIntent = (intent: ClientIntent) => void

type Props = {
  game: WerewolfSnapshot
  players: PlayerPublic[]
  localClientId: string | null
  interactive: boolean
  isHost: boolean
  onIntent: OnIntent
  onRematch?: () => void
  /** Host: download day-phase AI feedback log (JSON). */
  onDownloadDayLog?: () => void
  /** Host: leave the game and return everyone to the lobby. */
  onAbortGame?: () => void
  reactions?: ReactionEvent[]
}

function nameOf(
  game: WerewolfSnapshot,
  players: PlayerPublic[],
  id: string,
): string {
  return (
    players.find((p) => p.id === id)?.name ??
    game.playerNames[id] ??
    'Player'
  )
}

/** Official card face for eyes-closed claim / hold-to-peek. */
function ClaimCardArt({
  role,
  label,
}: {
  role: WerewolfRole
  label?: string
}) {
  return (
    <figure className="werewolf-claim-card">
      {label ? <figcaption>{label}</figcaption> : null}
      <img
        src={ROLE_CARD_FACE_URL[role]}
        alt={roleName(role)}
        draggable={false}
      />
    </figure>
  )
}

function LocalCardTokenChip({
  token,
  interactive,
}: {
  token: LocalCardTokenUi
  interactive: boolean
}) {
  const colors = teamColorsForRole(token.role)
  const canTap = interactive && !token.locked
  return (
    <button
      type="button"
      className={[
        'werewolf-local-token',
        token.selected ? 'selected' : '',
        token.locked ? 'locked' : '',
        canTap ? 'interactive' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={
        {
          '--token-accent': colors.accent,
          '--token-bg': colors.bg,
        } as CSSProperties
      }
      aria-label={`${roleName(token.role)} token${token.locked ? ' (locked)' : ''}`}
      disabled={!canTap}
      onClick={(e) => {
        e.stopPropagation()
        if (!canTap) return
        requestLocalTokenClick(token.id)
      }}
    >
      <img
        src={ROLE_TOKEN_URL[token.role]}
        alt=""
        draggable={false}
      />
    </button>
  )
}

function formatCountdown(msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, '0')}`
}

function NightPrivatePanel({
  game,
  players,
  localClientId,
  nightSecondsLeft,
}: {
  game: WerewolfSnapshot
  players: PlayerPublic[]
  localClientId: string
  nightSecondsLeft: number | null
}) {
  const dealt = game.dealtRoles[localClientId]
  const step =
    game.nightStep === 'simultaneous' && dealt
      ? dealt === 'werewolf'
        ? 'werewolves'
        : dealt === 'minion'
          ? 'minion'
          : dealt === 'mason'
            ? 'masons'
            : dealt === 'seer'
              ? 'seer'
              : dealt === 'robber'
                ? 'robber'
                : dealt === 'troublemaker'
                  ? 'troublemaker'
                  : dealt === 'drunk'
                    ? 'drunk'
                    : dealt === 'insomniac'
                      ? 'insomniac'
                      : game.nightStep
      : game.nightStep
  const ack = game.nightActions.acknowledged.includes(localClientId)
  const isActor =
    game.nightStep === 'simultaneous'
      ? isNightActor(game, localClientId)
      : actorsForStep(game, game.nightStep).includes(localClientId)

  const actTimer =
    nightSecondsLeft != null ? (
      <div
        className={`werewolf-night-timer${nightSecondsLeft <= 3 ? ' urgent' : ''}`}
        aria-live="polite"
      >
        {nightSecondsLeft}
      </div>
    ) : game.nightStep !== 'intro' &&
      game.nightStep !== 'outro' &&
      game.nightStep !== 'simultaneous' ? (
      <p className="game-play-body werewolf-waiting-narrator">Listening…</p>
    ) : null

  // Dealt card shows in the bottom-right player dock while eyes are closed.
  const shell = (body: ReactNode) => (
    <div className="werewolf-action">
      <div className="werewolf-action-copy">
        {actTimer}
        {body}
      </div>
    </div>
  )

  if (game.nightStep === 'intro' || game.nightStep === 'outro') {
    // Narrator-driven — overlay covers the screen; no action panel.
    return null
  }

  if (!dealt || !isActor) return null

  // After a pick in simultaneous night, wait for others / resolve.
  if (
    game.nightStep === 'simultaneous' &&
    !playerNeedsNightIntent(game, localClientId) &&
    (dealt === 'seer' ||
      dealt === 'robber' ||
      dealt === 'troublemaker' ||
      dealt === 'drunk' ||
      (dealt === 'werewolf' && game.nightActions.werewolfPeek?.playerId === localClientId))
  ) {
    // Fall through to role-specific "done" UI below (peek result / stole / swapped).
  }

  // Drunk auto-acks after swapping; otherwise the countdown ends the turn.
  if (ack && game.nightStep !== 'simultaneous') {
    return shell(<p className="game-play-body">Go back to sleep…</p>)
  }

  if (step === 'werewolves') {
    const others = playersWithDealtRole(game, 'werewolf').filter(
      (id) => id !== localClientId,
    )
    const alone = others.length === 0
    const peek = game.nightActions.werewolfPeek
    return shell(
      <>
        <p className="game-play-body">
          {alone
            ? 'Alone — tap a center card.'
            : `Pack: ${others.map((id) => nameOf(game, players, id)).join(', ')}`}
        </p>
        {peek?.playerId === localClientId && (
          <p className="game-play-body">
            Center {peek.centerIndex + 1}: <strong>{roleName(peek.role)}</strong>
          </p>
        )}
      </>,
    )
  }

  if (step === 'minion') {
    const wolves = playersWithDealtRole(game, 'werewolf')
    return shell(
      <p className="game-play-body">
        {wolves.length === 0
          ? 'No werewolves among the players.'
          : `Wolves: ${wolves.map((id) => nameOf(game, players, id)).join(', ')}`}
      </p>,
    )
  }

  if (step === 'masons') {
    const others = playersWithDealtRole(game, 'mason').filter(
      (id) => id !== localClientId,
    )
    return shell(
      <p className="game-play-body">
        {others.length === 0
          ? 'No other Mason at the table (may be center).'
          : 'Your fellow Mason is marked.'}
      </p>,
    )
  }

  if (step === 'seer') {
    const view = game.nightActions.seer
    if (view?.playerId === localClientId) {
      return shell(
        <p className="game-play-body">
          {view.view.kind === 'player' ? (
            <>
              {nameOf(game, players, view.view.targetId)}:{' '}
              <strong>{roleName(view.view.role)}</strong>
            </>
          ) : (
            <>
              Center {view.view.indexes[0]! + 1}:{' '}
              <strong>{roleName(view.view.roles[0]!)}</strong>
              {' · '}
              Center {view.view.indexes[1]! + 1}:{' '}
              <strong>{roleName(view.view.roles[1]!)}</strong>
            </>
          )}
        </p>,
      )
    }
    return shell(
      <p className="game-play-body">Tap a player, or two center cards.</p>,
    )
  }

  if (step === 'robber') {
    const robbed = game.nightActions.robber
    if (robbed?.playerId === localClientId) {
      return shell(
        <p className="game-play-body">
          Stole {nameOf(game, players, robbed.targetId)} — you are the{' '}
          <strong>{roleName(robbed.stolenRole)}</strong>.
        </p>,
      )
    }
    return shell(
      <p className="game-play-body">Tap a player to steal.</p>,
    )
  }

  if (step === 'troublemaker') {
    const tm = game.nightActions.troublemaker
    if (tm?.playerId === localClientId) {
      return shell(
        <p className="game-play-body">
          Swapped {nameOf(game, players, tm.a)} ↔{' '}
          {nameOf(game, players, tm.b)}.
        </p>,
      )
    }
    return shell(
      <p className="game-play-body">
        Tap two other players' cards to swap them (or drag one onto another).
      </p>,
    )
  }

  if (step === 'drunk') {
    if (game.nightActions.drunk?.playerId === localClientId) {
      return shell(
        <p className="game-play-body">
          {game.nightStep === 'simultaneous'
            ? 'Swap locked in — waiting for night to resolve…'
            : 'Go back to sleep…'}
        </p>,
      )
    }
    return shell(
      <p className="game-play-body">Tap a center card to swap blindly.</p>,
    )
  }

  if (step === 'insomniac') {
    const current = game.roles[localClientId]!
    return shell(
      <p className="game-play-body">
        Your card is now the <strong>{roleName(current)}</strong>
        {current === dealt ? ' (unchanged).' : '.'}
      </p>,
    )
  }

  return null
}

export function WerewolfHud({
  game,
  players,
  localClientId,
  interactive,
  isHost,
  onIntent,
  onRematch,
  onDownloadDayLog,
  onAbortGame,
  reactions = [],
}: Props) {
  useHostNarrator(game, isHost, onIntent, localClientId)
  const narrow = useNarrowViewport()

  const myRole = myDealtRole(game, localClientId)
  const myClaim = myClaimedRole(game, localClientId)
  const claimedCount = game.cards.filter((c) => c.claimBy).length
  const votedCount = Object.keys(game.votes).length
  const myVote = localClientId ? game.votes[localClientId] : undefined

  const [pendingVoteTargetId, setPendingVoteLocal] = useState<string | null>(
    null,
  )
  const [localCardSelectable, setLocalCardSelectableState] = useState(
    () => getLocalCardSelectable(),
  )
  const [localCardTokens, setLocalCardTokensState] = useState(
    () => getLocalCardTokens(),
  )
  const [localTokensInteractive, setLocalTokensInteractiveState] = useState(
    () => getLocalTokensInteractive(),
  )
  useEffect(() => subscribePendingVoteTarget(setPendingVoteLocal), [])
  useEffect(() => subscribeLocalCardSelectable(setLocalCardSelectableState), [])
  useEffect(() => subscribeLocalCardTokens(setLocalCardTokensState), [])
  useEffect(
    () => subscribeLocalTokensInteractive(setLocalTokensInteractiveState),
    [],
  )
  useEffect(() => {
    if (game.phase !== 'day') setPendingVoteTargetId(null)
  }, [game.phase])

  const playersById = useMemo(() => {
    const m = new Map(players.map((p) => [p.id, p]))
    return m
  }, [players])

  const voteTargetId =
    game.phase === 'day'
      ? (pendingVoteTargetId ?? myVote ?? null)
      : null
  const isNoVote = voteTargetId === NO_VOTE_TARGET
  // No-vote confirm/cast shows your own card; otherwise the voted player.
  const voteDisplayId = isNoVote
    ? localClientId
    : voteTargetId
  const voteTargetPlayer = voteDisplayId
    ? playersById.get(voteDisplayId) ?? {
        id: voteDisplayId,
        name: game.playerNames[voteDisplayId] ?? 'Player',
        color: '#7a8494',
        connected: true,
        cameraOn: false,
        peerId: '',
        deviceId: '',
        photoDataUrl: null,
        emoticonPhotos: {},
        mediaFilter: 'none',
        joinedAt: 0,
      }
    : null
  const voteReactions = voteDisplayId
    ? reactionsFor(reactions, voteDisplayId)
    : []

  const nightLine =
    game.phase === 'night'
      ? game.nightStep === 'simultaneous'
        ? narrationForHumanNight(
            localClientId ? game.dealtRoles[localClientId] : undefined,
            presentRolesInHand(game),
            { dayDurationMs: game.dayDurationMs },
          )
        : narrationForStep(game.nightStep, presentRolesInHand(game), {
            dayDurationMs: game.dayDurationMs,
          })
      : null
  const nightScript =
    nightLine &&
    (game.nightStepEndsAt != null && nightLine.closeSpeak
      ? nightLine.closeSpeak
      : nightLine.wakeSpeak)

  // Spectators and roles with no night wake (villager / hunter / tanner) skip
  // the eyes-closed night overlay — they wait on the open table for day.
  const seatedLocal =
    localClientId != null && game.playerIds.includes(localClientId)
  const localHasNightPhase =
    seatedLocal && playerHasNightPhase(game, localClientId!)
  const eyesClosed =
    game.phase === 'night' &&
    localHasNightPhase &&
    (game.nightPaused || !isNightActor(game, localClientId!))

  // Brief reminder of the claimed card while "Everyone, close your eyes" plays.
  const introClaimRole =
    game.phase === 'night' && game.nightStep === 'intro'
      ? myClaim ?? myRole
      : null
  const [showIntroClaimCard, setShowIntroClaimCard] = useState(false)
  useEffect(() => {
    if (!introClaimRole) {
      setShowIntroClaimCard(false)
      return
    }
    setShowIntroClaimCard(true)
    const t = window.setTimeout(() => setShowIntroClaimCard(false), 5_000)
    return () => window.clearTimeout(t)
  }, [introClaimRole, game.phase, game.nightStep])

  // Hold-to-peek starting card while night is paused (dark screen).
  const pausedSelectedRole = game.nightPaused ? (myClaim ?? myRole) : null
  const [revealPausedCard, setRevealPausedCard] = useState(false)
  useEffect(() => {
    if (!game.nightPaused) setRevealPausedCard(false)
  }, [game.nightPaused])

  const needsHunter =
    game.phase === 'reveal' &&
    game.revealStage === 'hunter' &&
    localClientId != null &&
    game.killedIds.includes(localClientId) &&
    game.roles[localClientId] === 'hunter' &&
    !game.hunterKillId &&
    !game.winners

  const [now, setNow] = useState(() => Date.now())
  const dayTimeoutSent = useRef(false)
  const dawnDoneSent = useRef(false)
  const playbackDoneSent = useRef(false)

  const dawnBeats = useMemo(
    () => (game.phase === 'dawn' ? dawnPlaybackBeats(game) : []),
    [game],
  )
  const revealBeats = useMemo(
    () =>
      game.phase === 'reveal' && game.revealStage === 'nightPlayback'
        ? revealPlaybackBeats(game)
        : [],
    [game],
  )
  const playbackBeats =
    game.phase === 'dawn'
      ? dawnBeats
      : game.phase === 'reveal' && game.revealStage === 'nightPlayback'
        ? revealBeats
        : []
  const playbackBeatMs = effectivePlaybackBeatMs(game)
  const speechDrivenPlayback =
    (game.phase === 'dawn' && game.godMode) ||
    (game.phase === 'reveal' &&
      game.revealStage === 'nightPlayback' &&
      game.playbackBeatIndex != null)
  const playbackBeat =
    playbackBeats.length > 0
      ? currentPlaybackBeat(
          playbackBeats,
          game.playbackStartedAt,
          now,
          playbackBeatMs,
          speechDrivenPlayback ? game.playbackBeatIndex : null,
        )
      : null

  const needsClock =
    (game.phase === 'day' && game.dayEndsAt != null) ||
    (game.phase === 'night' && game.nightStepEndsAt != null) ||
    (game.phase === 'dawn' && !game.godMode)

  // Sync before paint when a deadline appears — a stale `now` from the wake
  // wait used to flash a high number (e.g. 13) before jumping to the act length.
  useLayoutEffect(() => {
    if (!needsClock) return
    setNow(Date.now())
  }, [needsClock, game.phase, game.dayEndsAt, game.nightStepEndsAt])

  useEffect(() => {
    if (!needsClock) return
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [needsClock, game.phase, game.dayEndsAt, game.nightStepEndsAt])

  useEffect(() => {
    if (game.phase !== 'day') {
      dayTimeoutSent.current = false
    }
  }, [game.phase])

  useEffect(() => {
    if (game.phase !== 'dawn') dawnDoneSent.current = false
    if (!(game.phase === 'reveal' && game.revealStage === 'nightPlayback')) {
      playbackDoneSent.current = false
    }
  }, [game.phase, game.revealStage])

  useEffect(() => {
    if (!isHost || game.phase !== 'day' || game.dayEndsAt == null) return
    if (now < game.dayEndsAt) return
    if (dayTimeoutSent.current) return
    dayTimeoutSent.current = true
    onIntent({ type: 'werewolf.dayTimeout' })
  }, [isHost, game.phase, game.dayEndsAt, now, onIntent])

  useEffect(() => {
    if (!isHost || game.phase !== 'dawn') return
    // God-mode dawn is speech-driven via werewolf.playbackNext.
    if (game.godMode) return
    if (!playbackFinished(dawnBeats, game.playbackStartedAt, now, playbackBeatMs))
      return
    if (dawnDoneSent.current) return
    dawnDoneSent.current = true
    onIntent({ type: 'werewolf.dawnDone' })
  }, [
    isHost,
    game.phase,
    game.godMode,
    game.playbackStartedAt,
    playbackBeatMs,
    dawnBeats,
    now,
    onIntent,
  ])

  useEffect(() => {
    if (
      !isHost ||
      game.phase !== 'reveal' ||
      game.revealStage !== 'nightPlayback'
    ) {
      return
    }
    // Speech-driven post-vote recap advances via werewolf.playbackNext.
    if (game.playbackBeatIndex != null) return
    if (
      !playbackFinished(
        revealBeats,
        game.playbackStartedAt,
        now,
        playbackBeatMs,
      )
    ) {
      return
    }
    if (playbackDoneSent.current) return
    playbackDoneSent.current = true
    onIntent({ type: 'werewolf.playbackDone' })
  }, [
    isHost,
    game.phase,
    game.revealStage,
    game.playbackStartedAt,
    game.playbackBeatIndex,
    playbackBeatMs,
    revealBeats,
    now,
    onIntent,
  ])

  // Safety: if wake narration never starts the act timer (TTS stuck), begin it
  // after a generous wait so the host can still finish speaking.
  useEffect(() => {
    if (!isHost || game.phase !== 'night' || game.nightPaused) return
    if (game.nightStep === 'intro' || game.nightStep === 'outro') return
    if (game.nightStepEndsAt != null) return
    const skipsNight =
      localClientId == null ||
      !game.playerIds.includes(localClientId) ||
      !playerHasNightPhase(game, localClientId)
    const t = window.setTimeout(
      () => {
        onIntent({
          type: 'werewolf.startNightAct',
          ...(skipsNight ? { actMs: 3_500 } : {}),
        })
      },
      skipsNight ? 1_000 : 20_000,
    )
    return () => window.clearTimeout(t)
  }, [
    isHost,
    game.phase,
    game.nightStep,
    game.nightStepEndsAt,
    game.nightPaused,
    game.nightResumeAt,
    game.playerIds,
    localClientId,
    onIntent,
  ])

  const dayMsLeft =
    game.phase === 'day' && game.dayEndsAt != null
      ? game.dayEndsAt - now
      : null

  const nightMsLeft =
    game.phase === 'night' && game.nightStepEndsAt != null
      ? game.nightStepEndsAt - now
      : null

  const nightSecondsLeft =
    nightMsLeft != null ? Math.max(0, Math.ceil(nightMsLeft / 1000)) : null

  const localPlayer =
    localClientId != null && game.playerIds.includes(localClientId)
      ? playersById.get(localClientId) ?? {
          id: localClientId,
          name: game.playerNames[localClientId] ?? 'You',
          color: '#c9a227',
          connected: true,
          cameraOn: false,
          peerId: '',
          deviceId: '',
          photoDataUrl: null,
          emoticonPhotos: {},
          mediaFilter: 'none' as const,
          joinedAt: 0,
        }
      : null
  let localVoteFooter: string | null = null
  if (localClientId && game.phase === 'reveal') {
    const voteTarget = game.votes[localClientId]
    if (!voteTarget) localVoteFooter = "Didn't vote"
    else if (voteTarget === NO_VOTE_TARGET) localVoteFooter = 'No vote'
    else localVoteFooter = `→ ${game.playerNames[voteTarget] ?? 'Player'}`
  } else if (localClientId && game.phase === 'day') {
    const voteTarget = game.votes[localClientId]
    if (voteTarget === NO_VOTE_TARGET) localVoteFooter = 'No vote'
    else if (voteTarget)
      localVoteFooter = `→ ${game.playerNames[voteTarget] ?? 'Player'}`
  }
  const localVotesAgainst =
    localClientId &&
    (game.phase === 'day' || game.phase === 'reveal')
      ? Object.values(game.votes).filter(
          (t) => t === localClientId,
        ).length
      : 0
  const showNightDealtCard =
    !eyesClosed &&
    game.phase === 'night' &&
    game.nightStep === 'simultaneous' &&
    Boolean(myRole) &&
    localClientId != null &&
    isNightActor(game, localClientId)
  const localCardSelected =
    pendingVoteTargetId === NO_VOTE_TARGET ||
    (pendingVoteTargetId == null && myVote === NO_VOTE_TARGET)

  const showVoteCast =
    !eyesClosed &&
    !pendingVoteTargetId &&
    Boolean(myVote) &&
    Boolean(voteTargetPlayer)

  const hudRoot =
    typeof document !== 'undefined'
      ? document.querySelector('.scene-stage > .hud')
      : null

  const eyesClosedPortal =
    eyesClosed && typeof document !== 'undefined'
      ? createPortal(
          <div className="werewolf-eyes-closed" aria-live="polite">
            {game.nightPaused ? (
              <>
                <p>Paused</p>
                <span>Night is paused. Wait for the host to resume.</span>
                {pausedSelectedRole && (
                  <>
                    <button
                      type="button"
                      className="btn tiny werewolf-eyes-closed-reveal"
                      onPointerDown={(e) => {
                        e.preventDefault()
                        e.currentTarget.setPointerCapture(e.pointerId)
                        setRevealPausedCard(true)
                      }}
                      onPointerUp={() => setRevealPausedCard(false)}
                      onPointerCancel={() => setRevealPausedCard(false)}
                      onLostPointerCapture={() => setRevealPausedCard(false)}
                      onContextMenu={(e) => e.preventDefault()}
                    >
                      Show my selected card
                    </button>
                    {revealPausedCard && (
                      <div className="werewolf-eyes-closed-claim werewolf-eyes-closed-claim-held">
                        <ClaimCardArt
                          role={pausedSelectedRole}
                          label="Your card"
                        />
                      </div>
                    )}
                  </>
                )}
              </>
            ) : game.nightStep === 'outro' ? (
              <>
                <p>Dawn</p>
                <span>Listen for the narrator — then open your eyes.</span>
              </>
            ) : game.nightStep === 'simultaneous' ? (
              <>
                <p>Night</p>
                <span>Waiting for night actions…</span>
                {myRole && (
                  <div className="werewolf-eyes-closed-claim werewolf-eyes-closed-claim-held">
                    <ClaimCardArt role={myRole} label="Your card" />
                  </div>
                )}
              </>
            ) : game.nightStep === 'intro' ? (
              <>
                <p>Eyes closed</p>
                <span>
                  {showIntroClaimCard && introClaimRole
                    ? 'Remember your card, then close your eyes.'
                    : 'Listen for the narrator. Keep your device dark.'}
                </span>
                {showIntroClaimCard && introClaimRole && (
                  <div className="werewolf-eyes-closed-claim">
                    <ClaimCardArt role={introClaimRole} label="Your card" />
                  </div>
                )}
              </>
            ) : (
              <>
                <p>Eyes closed</p>
                <span>Keep your device dark until you are called.</span>
              </>
            )}
            {!game.nightPaused && nightSecondsLeft != null && (
              <div className="werewolf-night-timer" aria-hidden>
                {nightSecondsLeft}
              </div>
            )}
            {isHost && (
              <div className="werewolf-eyes-closed-host-actions">
                {game.nightStep !== 'intro' &&
                  game.nightStep !== 'outro' &&
                  game.nightStep !== 'simultaneous' && (
                  <button
                    type="button"
                    className="btn tiny werewolf-eyes-closed-pause"
                    onClick={() => {
                      unlockHostNarrator()
                      onIntent({ type: 'werewolf.skipNightStep' })
                    }}
                  >
                    Skip role
                  </button>
                )}
                {game.nightStep === 'simultaneous' && (
                  <button
                    type="button"
                    className="btn tiny werewolf-eyes-closed-pause"
                    onClick={() => {
                      onIntent({ type: 'werewolf.skipNightStep' })
                    }}
                  >
                    Resolve night
                  </button>
                )}
                <button
                  type="button"
                  className="btn tiny werewolf-eyes-closed-pause"
                  onClick={() => {
                    unlockHostNarrator()
                    onIntent({
                      type: game.nightPaused
                        ? 'werewolf.resumeNight'
                        : 'werewolf.pauseNight',
                    })
                  }}
                >
                  {game.nightPaused ? 'Resume night' : 'Pause night'}
                </button>
                {onAbortGame && (
                  <button
                    type="button"
                    className="btn tiny danger werewolf-eyes-closed-pause"
                    onClick={onAbortGame}
                  >
                    Abort game
                  </button>
                )}
              </div>
            )}
          </div>,
          document.body,
        )
      : null

  return (
    <>
      {eyesClosedPortal}

      {!eyesClosed &&
        localPlayer &&
        hudRoot &&
        createPortal(
          <div className="game-play-overlay-right">
            <div className="werewolf-local-card-dock">
              {showVoteCast && voteTargetPlayer && (
                <WerewolfVoteCastCard
                  noVote={myVote === NO_VOTE_TARGET}
                  player={voteTargetPlayer}
                  reactions={voteReactions}
                  onUndo={() => onIntent({ type: 'werewolf.undoVote' })}
                />
              )}
              {!eyesClosed &&
                game.phase === 'claiming' &&
                myClaim && (
                  <div className="werewolf-night-dealt-card">
                    <ClaimCardArt role={myClaim} label="Your card" />
                  </div>
                )}
              {showNightDealtCard && myRole && (
                <div className="werewolf-night-dealt-card">
                  <ClaimCardArt role={myRole} label="Your card" />
                </div>
              )}
              <div className="werewolf-local-card-with-tokens">
                {localCardTokens.length > 0 && (
                  <div
                    className="werewolf-local-tokens"
                    aria-label="Your role tokens"
                  >
                    {localCardTokens.map((t) => (
                      <LocalCardTokenChip
                        key={t.id}
                        token={t}
                        interactive={localTokensInteractive}
                      />
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  className={[
                    'werewolf-local-card-identity',
                    localCardSelectable ? 'selectable' : '',
                    localCardSelected ? 'selected' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  disabled={!localCardSelectable}
                  aria-label={
                    localCardSelectable
                      ? 'Cast no vote'
                      : localPlayer.name || 'You'
                  }
                  onClick={(e) => {
                    e.stopPropagation()
                    if (!localCardSelectable) return
                    requestLocalCardSelect()
                  }}
                >
                  {localVotesAgainst > 0 ? (
                    <span
                      className="werewolf-local-card-votes-against"
                      aria-label={`${localVotesAgainst} vote${localVotesAgainst === 1 ? '' : 's'} against you`}
                    >
                      {'✕'.repeat(localVotesAgainst)}
                    </span>
                  ) : null}
                  {localVoteFooter ? (
                    <span className="werewolf-local-card-footer">
                      {localVoteFooter}
                    </span>
                  ) : null}
                  <span className="werewolf-local-card-name">
                    {localPlayer.name || 'You'}
                  </span>
                </button>
              </div>
            </div>
          </div>,
          hudRoot,
        )}

      {pendingVoteTargetId && voteTargetPlayer && (
        <WerewolfVoteOverlay
          noVote={isNoVote}
          player={voteTargetPlayer}
          reactions={voteReactions}
          onCancel={() => setPendingVoteTargetId(null)}
          onConfirm={() => {
            if (!pendingVoteTargetId) return
            onIntent({
              type: 'werewolf.vote',
              targetId: pendingVoteTargetId,
            })
            setPendingVoteTargetId(null)
          }}
        />
      )}

      {!eyesClosed && game.phase === 'claiming' && (
        <p className="game-play-body">
          {myClaim
            ? `Claimed · waiting ${claimedCount}/${game.playerIds.length}`
            : `Tap a free card · ${claimedCount}/${game.playerIds.length}`}
        </p>
      )}

      {(isHost || onRematch || onAbortGame) &&
        (game.phase === 'night' ||
          game.phase === 'dawn' ||
          (game.phase === 'reveal' &&
            (game.revealStage === 'nightPlayback' ||
              game.revealStage === 'result'))) && (
        <div className="werewolf-tts-row">
          {game.phase === 'reveal' && game.revealStage === 'result' && (
            <div className="btn-row">
              {isHost && (
                <>
                  <button
                    type="button"
                    className="btn tiny"
                    onClick={() =>
                      onIntent({ type: 'werewolf.replayPlayback' })
                    }
                  >
                    Replay
                  </button>
                </>
              )}
              {onDownloadDayLog && (
                <button
                  type="button"
                  className="btn tiny"
                  onClick={onDownloadDayLog}
                >
                  Download log
                </button>
              )}
              {onRematch && (
                <button
                  type="button"
                  className="btn tiny primary"
                  onClick={onRematch}
                >
                  Rematch
                </button>
              )}
              {onAbortGame && (
                <button
                  type="button"
                  className="btn tiny"
                  onClick={onAbortGame}
                >
                  End game
                </button>
              )}
            </div>
          )}
          {isHost && game.phase === 'dawn' && (
            <button
              type="button"
              className="btn tiny"
              onClick={() => {
                dawnDoneSent.current = true
                onIntent({ type: 'werewolf.dawnDone' })
              }}
            >
              {game.godMode ? 'Skip night replay' : 'Skip dawn'}
            </button>
          )}
          {isHost &&
            game.phase === 'reveal' &&
            game.revealStage === 'nightPlayback' && (
              <button
                type="button"
                className="btn tiny"
                onClick={() => {
                  playbackDoneSent.current = true
                  onIntent({ type: 'werewolf.playbackDone' })
                }}
              >
                Skip replay
              </button>
            )}
          {isHost && game.phase === 'night' && (
            <div className="btn-row">
              {game.nightStep === 'simultaneous' ? (
                <button
                  type="button"
                  className="btn tiny"
                  onClick={() => {
                    onIntent({ type: 'werewolf.skipNightStep' })
                  }}
                >
                  Resolve night
                </button>
              ) : (
                game.nightStep !== 'intro' &&
                game.nightStep !== 'outro' && (
                  <button
                    type="button"
                    className="btn tiny"
                    onClick={() => {
                      unlockHostNarrator()
                      onIntent({ type: 'werewolf.skipNightStep' })
                    }}
                  >
                    Skip role
                  </button>
                )
              )}
              {localHasNightPhase && (
                <button
                  type="button"
                  className="btn tiny"
                  onClick={() => {
                    unlockHostNarrator()
                    onIntent({
                      type: game.nightPaused
                        ? 'werewolf.resumeNight'
                        : 'werewolf.pauseNight',
                    })
                  }}
                >
                  {game.nightPaused ? 'Resume night' : 'Pause night'}
                </button>
              )}
              {onAbortGame && (
                <button
                  type="button"
                  className="btn tiny danger"
                  onClick={onAbortGame}
                >
                  Abort game
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {isHost && game.phase === 'night' && !game.godMode && nightScript && (
        <p className="game-play-body werewolf-narrator-script" aria-live="polite">
          {game.nightPaused ? 'Night paused.' : nightScript}
        </p>
      )}

      {!eyesClosed &&
        game.phase === 'night' &&
        !game.nightPaused &&
        localClientId &&
        interactive && (
          <NightPrivatePanel
            game={game}
            players={players}
            localClientId={localClientId}
            nightSecondsLeft={nightSecondsLeft}
          />
        )}

      {!eyesClosed && game.phase === 'dawn' && (
        <p className="game-play-body" aria-live="polite">
          {playbackBeat?.beat.label ?? 'Night falls…'}
        </p>
      )}

      {!eyesClosed && game.phase === 'day' && (
        <>
          {!narrow && !game.godMode && (
            <>
              <p className="game-play-body">
                {myVote
                  ? `Votes in · ${votedCount}/${game.playerIds.length}`
                  : `Discuss, then tap who to kill (or yourself for no vote) · ${votedCount}/${game.playerIds.length}`}
              </p>
              <p className="game-play-body werewolf-token-hint">
                Tap a token, then a player (or card) to mark your guess.
              </p>
            </>
          )}
          {dayMsLeft != null && (
            <div
              className={`werewolf-day-timer${dayMsLeft < 30_000 ? ' urgent' : ''}${game.godMode ? ' watch' : ''}`}
            >
              {formatCountdown(dayMsLeft)}
            </div>
          )}
        </>
      )}

      {game.phase === 'reveal' && game.revealStage === 'nightPlayback' && (
        <p className="game-play-body" aria-live="polite">
          {playbackBeat?.beat.label ?? 'What happened in the night…'}
        </p>
      )}

      {game.phase === 'reveal' &&
        game.revealStage !== 'nightPlayback' && (
        <>
          {game.winMessage && (
            <p className="game-play-body">{game.winMessage}</p>
          )}
          {needsHunter && (
            <p className="game-play-body">Hunter — tap who to take.</p>
          )}
        </>
      )}
    </>
  )
}
