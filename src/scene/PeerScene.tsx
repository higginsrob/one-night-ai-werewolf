import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { PerformanceMonitor } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'
import { SceneControls } from '../engine/controls'
import { werewolfGame } from '../game'
import type { ClientIntent, SessionSnapshot } from '../net/protocol'
import { currentHostId } from '../session/sessionStore'
import type { ClientId, PlayerPublic } from '../session/types'
import { GallerySeats } from './GallerySeats'
import { LobbyTable } from './LobbyTable'
import { isCoarseMobile } from './deviceProfile'
import { DistantVillage } from './DistantVillage'
import { MoonGround } from './MoonGround'
import { NightBackdrop } from './NightBackdrop'
import { AutoCameraController } from './AutoCameraController'
import { OrbitFocusController } from './OrbitFocusController'
import { clearOrbitFocus } from './playerCardFocus'
import { RoundTable } from './RoundTable'
import { SceneReadySignal } from './SceneReadySignal'
import {
  normalizeSceneVisuals,
} from './sceneVisuals'
import {
  losingPlayerIdsFromGame,
  winningPlayerIdsFromGame,
} from './winningSeat'

/** Floor when FPS dips — never go soft enough that card art turns to mush. */
const DPR_MIN = isCoarseMobile ? 1.25 : 0.85
/**
 * Cap below full 3× Retina to save fill-rate, but keep phones at 2× so cards
 * stay sharp next to the HTML HUD.
 */
const DPR_MAX = 2

function dprFromFactor(factor: number): number {
  const deviceMax =
    typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const max = Math.min(DPR_MAX, deviceMax)
  const min = Math.min(DPR_MIN, max)
  return Math.round((min + (max - min) * factor) * 10) / 10
}

type Props = {
  snapshot: SessionSnapshot | null
  localClientId: string | null
  isHost: boolean
  selectedModeId: string | null
  onSelectMode: (id: string) => void
  onDismissDoc?: () => void
  /** World-space reading target for MapControls while a lobby doc is open. */
  onReadingTarget?: (target: [number, number, number] | null) => void
  onReady?: () => void
  onGameIntent: (intent: ClientIntent) => void
  seatingEnabled?: boolean
  onTogglePlayerSeat?: (clientId: ClientId) => void
  orbitEnabled?: boolean
  /** When false, player billboards are omitted (e.g. mobile HTML carousel). */
  showSceneCards?: boolean
  lobbyDeck?: number[]
  canEditLobbyDeck?: boolean
  onToggleLobbyRole?: (poolIndex: number) => void
  lobbyDeckNeed?: number
  /** Set while a lobby document is lifted — enables MapControls on this point. */
  readingTarget?: [number, number, number] | null
}

const LOBBY_CAMERA: [number, number, number] = [0, 4.2, 6.4]
const LOBBY_TARGET: [number, number, number] = [0, 1.2, 0]
const EMPTY_VOTES: Record<string, string> = {}
const PLAY_CAMERA =
  (werewolfGame.config.table?.camera as [number, number, number] | undefined) ??
  LOBBY_CAMERA
const PLAY_TARGET =
  (werewolfGame.config.table?.target as [number, number, number] | undefined) ??
  LOBBY_TARGET

function SceneBody({
  snapshot,
  localClientId,
  isHost,
  selectedModeId,
  onSelectMode,
  onDismissDoc,
  onReadingTarget,
  onReady,
  onGameIntent,
  seatingEnabled = false,
  onTogglePlayerSeat,
  orbitEnabled = true,
  showSceneCards = true,
  lobbyDeck = [],
  canEditLobbyDeck = false,
  onToggleLobbyRole,
  lobbyDeckNeed = 6,
  readingTarget = null,
}: Props) {
  const playersById = useMemo(() => {
    const m = new Map<string, PlayerPublic>()
    for (const p of snapshot?.players ?? []) m.set(p.id, p)
    return m
  }, [snapshot?.players])

  const inLobby = !snapshot || snapshot.phase === 'lobby'
  const controls = 'orbit'
  const target = inLobby ? LOBBY_TARGET : PLAY_TARGET
  const watchMode = Boolean(snapshot?.watchMode)
  const autoCamera =
    watchMode &&
    snapshot?.phase === 'playing' &&
    Boolean(snapshot.game) &&
    !readingTarget
  const conversationPan = Boolean(
    autoCamera && snapshot?.game?.phase === 'day',
  )
  const claimProgress = useMemo(() => {
    const game = snapshot?.game
    if (!game) return 1
    if (game.phase !== 'claiming') return 1
    const n = game.playerIds.length
    if (n <= 0) return 1
    let claimed = 0
    for (const id of game.playerIds) {
      if (game.cards.some((c) => c.claimBy === id)) claimed += 1
    }
    return claimed / n
  }, [snapshot?.game])

  const dayVotes = snapshot?.game?.votes ?? EMPTY_VOTES

  useEffect(() => {
    clearOrbitFocus()
  }, [inLobby])

  useEffect(() => {
    if (autoCamera) clearOrbitFocus()
  }, [autoCamera])

  const localConnected = Boolean(
    localClientId &&
      snapshot?.players.some((p) => p.id === localClientId && p.connected),
  )
  const interactive = localConnected
  const hostId = snapshot ? currentHostId(snapshot) : null
  const inNightReplay =
    snapshot?.phase === 'playing' &&
    snapshot.game?.phase === 'reveal' &&
    snapshot.game.revealStage === 'nightPlayback'
  const winningPlayerIds =
    snapshot?.phase === 'playing' && !inNightReplay
      ? winningPlayerIdsFromGame(snapshot.gameId, snapshot.game)
      : []
  const losingPlayerIds =
    snapshot?.phase === 'playing' && !inNightReplay
      ? losingPlayerIdsFromGame(snapshot.gameId, snapshot.game)
      : []

  // Werewolf seats its own PlayerCards beside role cards — exclude those from gallery.
  const werewolfSeatedIds =
    snapshot?.phase === 'playing' && snapshot.game
      ? new Set(snapshot.game.playerIds)
      : null

  const galleryIds =
    snapshot?.phase === 'playing'
      ? snapshot.players
          .filter((p) => p.connected)
          .map((p) => p.id)
          .filter((id) => !werewolfSeatedIds?.has(id))
          // Spectators do not get a 3D card for themselves.
          .filter((id) => id !== localClientId)
      : []

  const visuals = normalizeSceneVisuals(snapshot?.sceneVisuals)

  return (
    <>
      <NightBackdrop visuals={visuals} />
      <MoonGround />
      <DistantVillage />
      <SceneReadySignal onReady={onReady ?? (() => {})} />
      <ambientLight intensity={0.08} />
      <SceneControls
        kind={controls}
        enabled={orbitEnabled}
        readingTarget={readingTarget}
        target={target}
        {...(autoCamera
          ? {
              // Front-of-table arc only — matches auto-camera (no back-side orbit).
              minAzimuthAngle: -Math.PI * 0.42,
              maxAzimuthAngle: Math.PI * 0.42,
              maxDistance: 22,
              minPolarAngle: 0.08,
              maxPolarAngle: Math.PI / 2.05,
            }
          : {})}
      />
      {autoCamera ? (
        <AutoCameraController
          enabled={orbitEnabled}
          conversationPan={conversationPan}
          gamePhase={snapshot?.game?.phase ?? null}
          claimProgress={claimProgress}
          votes={dayVotes}
        />
      ) : (
        !readingTarget && (
          <OrbitFocusController tableTarget={target} enabled={orbitEnabled} />
        )
      )}

      {!snapshot && <RoundTable />}

      {snapshot?.phase === 'lobby' && (
        <LobbyTable
          snapshot={snapshot}
          playersById={playersById}
          localClientId={localClientId}
          selectedModeId={selectedModeId}
          onSelectMode={onSelectMode}
          onDismissDoc={onDismissDoc}
          onReadingTarget={onReadingTarget}
          deck={lobbyDeck}
          canEditDeck={canEditLobbyDeck}
          onToggleRole={onToggleLobbyRole ?? (() => {})}
          deckNeed={lobbyDeckNeed}
          seatingEnabled={seatingEnabled}
          onTogglePlayerSeat={onTogglePlayerSeat}
          showSceneCards={showSceneCards}
        />
      )}

      {snapshot?.phase === 'playing' && snapshot.game && (
        <>
          <werewolfGame.Scene
            state={snapshot.game}
            seats={snapshot.seats}
            localClientId={localClientId}
            isHost={isHost}
            players={snapshot.players}
            reactions={snapshot.reactions}
            interactive={interactive}
            onIntent={onGameIntent}
          />
          {showSceneCards && (
            <GallerySeats
              spectators={galleryIds}
              playersById={playersById}
              localClientId={localClientId}
              hostId={hostId}
              reactions={snapshot.reactions}
              layout="behind"
              indexOffset={0}
              layoutTotal={galleryIds.length}
              winningPlayerIds={winningPlayerIds}
              losingPlayerIds={losingPlayerIds}
              label={false}
            />
          )}
        </>
      )}
    </>
  )
}

export function PeerScene({
  onDismissDoc: onDismissDocProp,
  onReadingTarget: onReadingTargetProp,
  ...props
}: Props) {
  const inLobby =
    !props.snapshot || props.snapshot.phase === 'lobby'
  const cam = inLobby ? LOBBY_CAMERA : PLAY_CAMERA
  const [dpr, setDpr] = useState(() => dprFromFactor(1))
  const [readingTarget, setReadingTarget] = useState<
    [number, number, number] | null
  >(null)

  const onReadingTarget = useCallback(
    (target: [number, number, number] | null) => {
      setReadingTarget(target)
      onReadingTargetProp?.(target)
    },
    [onReadingTargetProp],
  )

  const onDismissDoc = useCallback(() => {
    setReadingTarget(null)
    onDismissDocProp?.()
  }, [onDismissDocProp])

  return (
    <Canvas
      className="peer-canvas"
      // "percentage" → PCFShadowMap; boolean true still selects deprecated PCFSoftShadowMap.
      shadows={!isCoarseMobile ? 'percentage' : false}
      dpr={dpr}
      camera={{ position: cam, fov: 42, near: 0.1, far: 200 }}
      gl={{
        antialias: !isCoarseMobile,
        powerPreference: isCoarseMobile ? 'default' : 'high-performance',
      }}
      onPointerMissed={() => {
        clearOrbitFocus()
        onDismissDoc()
      }}
    >
      <PerformanceMonitor
        // Start at full quality; only drop DPR if FPS actually struggles.
        factor={1}
        step={0.1}
        flipflops={isCoarseMobile ? 12 : 8}
        onChange={({ factor }) => setDpr(dprFromFactor(factor))}
        onFallback={() => setDpr(dprFromFactor(0))}
      />
      <Suspense fallback={null}>
        <SceneBody
          {...props}
          readingTarget={readingTarget}
          onReadingTarget={onReadingTarget}
          onDismissDoc={onDismissDoc}
        />
      </Suspense>
    </Canvas>
  )
}
