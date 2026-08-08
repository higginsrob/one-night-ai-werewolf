import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import {
  clearAiHostError,
  getAiHostError,
  subscribeAiHostError,
} from './ai/hostErrors'
import { warmForeverOllamaModels } from './ai/warmModels'
import { APP_NAME } from './config'
import { GameEngine } from './engine/GameEngine'
import {
  cancelHostNarration,
  unlockHostNarrator,
  setNarratorVoiceURI,
  WATCH_GAME_WELCOME,
} from './game/useHostNarrator'
import { NARRATOR_CLIENT_ID } from './session/types'
import { unlockAmbientNight } from './game/ambientNight'
import { useAmbientNight } from './game/useAmbientNight'
import { isTtsEnabled } from './game/tts'
import {
  deckReady,
  loadLobbyDeck,
  poolIndicesForRoles,
  recommendedPoolDeck,
  ROLE_POOL,
  saveLobbyDeck,
} from './game/roles'
import {
  dayDurationMsFromSettings,
  loadWerewolfSettings,
  nightActMsFromSettings,
  type WerewolfHostSettings,
} from './game/werewolfSettings'
import type { WerewolfRole } from './game/werewolfTypes'
import { isBrowserTtsSpeaking } from './game/browserTts'
import { useLocalSession } from './net/localSession'
import type { ClientIntent } from './net/protocol'
import { useDayChatDriver } from './net/useDayChatDriver'
import { useNpcDriver } from './net/useNpcDriver'
import { DayChatPanel } from './ui/DayChatPanel'
import { GamePlayOverlay } from './ui/GamePlayOverlay'
import { LobbyControls } from './ui/LobbyControls'
import { PlayerCardCarousel } from './ui/PlayerCardCarousel'
import { loadAiPlayers } from './ai/aiPlayers'
import { aiPlayersIntentPayload } from './ai/aiPlayersIntent'
import { MAX_LOBBY_PLAYERS } from './session/npcPlayers'
import { sessionNpcSpeakLive } from './session/chatLive'
import {
  SettingsShell,
  type SettingsSection,
} from './ui/settings/SettingsShell'
import { isLobbyDocId } from './scene/lobbyCatalog'
import {
  CHAT_DOCK_HARD_MIN_WIDTH,
  CHAT_DOCK_MAX_WIDTH,
  useChatDock,
} from './ui/useChatDock'
import {
  mobilePaneToggleLabel,
  mobilePaneToggleTitle,
  useMobilePaneMode,
  type MobilePaneMode,
} from './ui/useMobilePaneMode'
import { useNarrowViewport } from './ui/useNarrowViewport'
import { useWakeLock } from './ui/useWakeLock'

export default function App() {
  const room = useLocalSession()
  const narrow = useNarrowViewport()
  const mobilePane = useMobilePaneMode()
  const [sceneReady, setSceneReady] = useState(false)
  /** Lobby document currently lifted toward the camera (local view only). */
  const [focusedDocId, setFocusedDocId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>('game')
  const [aiHostError, setAiHostError] = useState(() => getAiHostError())

  useEffect(() => subscribeAiHostError(setAiHostError), [])

  const inLobby = room.snapshot.phase === 'lobby'
  const playing = room.snapshot.phase === 'playing'

  /** Re-seat persisted AI players once per lobby entry after refresh. */
  const aiSeatsRestoredRef = useRef(false)
  useEffect(() => {
    if (!inLobby) {
      aiSeatsRestoredRef.current = false
      return
    }
    if (aiSeatsRestoredRef.current) return
    const snap = room.snapshot
    aiSeatsRestoredRef.current = true

    const store = loadAiPlayers()
    const humanCount = snap.players.filter(
      (p) => p.connected && !p.isNpc,
    ).length
    const maxAi = Math.max(0, MAX_LOBBY_PLAYERS - humanCount)
    const profiles = store.profiles
      .filter((p) => store.seatedProfileIds.includes(p.id))
      .slice(0, maxAi)

    room.sendIntent({
      type: 'host.setAiPlayers',
      players: aiPlayersIntentPayload(profiles),
    })
  }, [inLobby, room.snapshot, room.sendIntent])
  useWakeLock(playing)
  useAmbientNight(room.snapshot)
  useNpcDriver({
    enabled: true,
    snapshot: room.snapshot,
    injectIntent: room.injectIntent,
  })
  const { stopPlayerTts, silencePlayerTts, promptNpcSpeak } =
    useDayChatDriver({
      enabled: true,
      snapshot: room.snapshot,
      injectIntent: room.injectIntent,
    })

  // Esc aborts the AI reply chain (not night narrator — only while chat floor is locked).
  useEffect(() => {
    if (!room.snapshot.chatLocked) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      stopPlayerTts()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [room.snapshot.chatLocked, stopPlayerTts])

  // Day: → silences the current speaker without aborting the reply chain.
  useEffect(() => {
    if (room.snapshot.game?.phase !== 'day') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowRight') return
      if (!isBrowserTtsSpeaking()) return
      const t = e.target
      if (
        t instanceof HTMLElement &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.isContentEditable)
      ) {
        return
      }
      e.preventDefault()
      silencePlayerTts()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [room.snapshot.game?.phase, silencePlayerTts])
  const showPlayerCarousel = Boolean(room.snapshot)
  /** Chat dock stays up for the whole session; compose is gated to lobby/day/reveal. */
  const chatAvailable = Boolean(room.snapshot)
  const hostCanPromptNpcSpeak = sessionNpcSpeakLive({
    phase: room.snapshot.phase,
    gamePhase: room.snapshot.game?.phase,
    revealStage: room.snapshot.game?.revealStage,
    hasWinners: Boolean(room.snapshot.game?.winners),
  })
  const chatDock = useChatDock()

  // Night actions need the full table on mobile — stash the pane preference and
  // restore it when day (or any non-night phase) begins.
  const nightPaneRestoreRef = useRef<MobilePaneMode | null>(null)
  const nightPaneForcedRef = useRef(false)
  const mobilePaneModeRef = useRef(mobilePane.mode)
  mobilePaneModeRef.current = mobilePane.mode
  useEffect(() => {
    const inNight = room.snapshot.game?.phase === 'night'
    if (inNight) {
      if (nightPaneRestoreRef.current === null) {
        nightPaneRestoreRef.current = mobilePaneModeRef.current
      }
      if (narrow && !nightPaneForcedRef.current) {
        nightPaneForcedRef.current = true
        if (mobilePaneModeRef.current !== 'scene') {
          mobilePane.setMode('scene')
        }
      }
      return
    }
    nightPaneForcedRef.current = false
    if (nightPaneRestoreRef.current === null) return
    const restore = nightPaneRestoreRef.current
    nightPaneRestoreRef.current = null
    if (mobilePaneModeRef.current !== restore) {
      mobilePane.setMode(restore)
    }
  }, [narrow, room.snapshot.game?.phase, mobilePane.setMode])

  // R3F canvas needs a resize pass after collapsing/expanding the scene pane.
  useEffect(() => {
    if (!narrow) return
    const id = window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'))
    })
    return () => window.cancelAnimationFrame(id)
  }, [narrow, mobilePane.mode])

  const onChatTranscript = useCallback(
    (text: string) => {
      const me = room.clientId
      if (room.snapshot.chatLocked) return
      // Watch-game spectators do not join table talk.
      if (room.snapshot.watchMode && room.snapshot.phase === 'playing') return
      room.sendIntent({
        type: 'chat.append',
        fromId: me,
        text,
        via: 'stt',
      })
    },
    [room],
  )

  const playInteractive = room.snapshot.players.some(
    (p) => p.id === room.clientId && p.connected,
  )

  const onGameIntent = useCallback(
    (intent: ClientIntent) => {
      room.sendIntent(intent)
    },
    [room],
  )

  const openSettings = useCallback((section: SettingsSection = 'game') => {
    setSettingsSection(section)
    setSettingsOpen(true)
  }, [])

  const onRematch = useCallback(() => {
    // Drop aftergame banter / hung pumps before arming narrator for the next round.
    stopPlayerTts()
    const settings = loadWerewolfSettings()
    setNarratorVoiceURI(settings.voiceURI)
    if (isTtsEnabled()) {
      unlockHostNarrator({
        speak:
          'Welcome to One Night Ultimate Werewolf, claim your card to begin.',
      })
    }
    unlockAmbientNight()
    room.sendIntent({
      type: 'host.rematch',
      nightActMs: nightActMsFromSettings(settings),
      dayDurationMs: dayDurationMsFromSettings(settings),
      simultaneousNight: true,
      watchMode: Boolean(room.snapshot.watchMode),
    })
  }, [room, stopPlayerTts])

  const onStartWerewolfFromSettings = useCallback(
    (result: { settings: WerewolfHostSettings; deck: WerewolfRole[] }) => {
      const { settings, deck } = result
      setNarratorVoiceURI(settings.voiceURI)
      room.sendIntent({
        type: 'host.setWerewolfDeck',
        poolIndices: poolIndicesForRoles(deck),
      })
      room.sendIntent({
        type: 'host.start',
        roleDeck: deck,
        nightActMs: nightActMsFromSettings(settings),
        dayDurationMs: dayDurationMsFromSettings(settings),
        simultaneousNight: true,
        watchMode: false,
      })
      setSettingsOpen(false)
      setSettingsSection('game')
    },
    [room],
  )

  const onWatchGame = useCallback(() => {
    const aiCount = room.snapshot.players.filter(
      (p) => p.connected && p.isNpc,
    ).length
    if (aiCount < 3) return
    // Clear lobby Speak / prior-round latches before arming narrator audio.
    stopPlayerTts()
    const settings = loadWerewolfSettings()
    setNarratorVoiceURI(settings.voiceURI)
    // Unlock + speak in this click (browser + API/OmniVoice) so the welcome
    // starts immediately and night/dawn audio stays allowed.
    if (isTtsEnabled()) {
      unlockHostNarrator({ speak: WATCH_GAME_WELCOME })
    }
    unlockAmbientNight()
    // Deck is rebuilt for AI-only seat count inside host.start when needed.
    room.sendIntent({
      type: 'host.start',
      nightActMs: nightActMsFromSettings(settings),
      dayDurationMs: dayDurationMsFromSettings(settings),
      simultaneousNight: true,
      watchMode: true,
    })
    // After host.start clears chat — mirror the welcome into the log.
    room.sendIntent({
      type: 'chat.append',
      fromId: NARRATOR_CLIENT_ID,
      text: WATCH_GAME_WELCOME,
      via: 'narrator',
    })
    setSettingsOpen(false)
    setSettingsSection('game')
  }, [room, stopPlayerTts])

  const onStopGame = useCallback(() => {
    cancelHostNarration()
    // Drop in-flight AI table talk so lobby Speak is not blocked by a hung pump.
    stopPlayerTts()
    room.sendIntent({ type: 'host.lobby' })
  }, [room, stopPlayerTts])

  const connectedPlayers = useMemo(
    () => room.snapshot.players.filter((p) => p.connected),
    [room.snapshot.players],
  )

  useEffect(() => {
    document.title = APP_NAME
  }, [])

  useEffect(() => {
    setNarratorVoiceURI(loadWerewolfSettings().voiceURI)
  }, [])

  useEffect(() => {
    void warmForeverOllamaModels()
  }, [])

  const connectedCount = connectedPlayers.length
  const connectedAiCount = connectedPlayers.filter((p) => p.isNpc).length
  const lobbyDeckNeed = Math.max(3, connectedCount) + 3
  const lobbyDeck = room.snapshot.werewolfDeck ?? []
  const canEditLobbyDeck = inLobby
  // Start = deck sized for human + AIs; Watch = deck sized for AIs only.
  const lobbyReadyToStart =
    inLobby && !settingsOpen && deckReady(lobbyDeck, connectedCount)
  const lobbyReadyToWatch =
    inLobby &&
    !settingsOpen &&
    connectedAiCount >= 3 &&
    deckReady(lobbyDeck, connectedAiCount)

  // Restore saved lobby cards, or seed a recommended deck.
  useEffect(() => {
    if (!canEditLobbyDeck) return
    if (room.snapshot.werewolfDeck != null) return
    room.sendIntent({
      type: 'host.setWerewolfDeck',
      poolIndices:
        loadLobbyDeck() ??
        recommendedPoolDeck(Math.max(3, connectedCount)),
    })
  }, [canEditLobbyDeck, connectedCount, room, room.snapshot.werewolfDeck])

  // Keep lobby card selections across refresh.
  useEffect(() => {
    if (!inLobby) return
    const deck = room.snapshot.werewolfDeck
    if (deck == null) return
    saveLobbyDeck(deck)
  }, [inLobby, room.snapshot.werewolfDeck])

  const onToggleLobbyRole = useCallback(
    (poolIndex: number) => {
      if (!canEditLobbyDeck) return
      if (poolIndex < 0 || poolIndex >= ROLE_POOL.length) return
      const selected = new Set(room.snapshot.werewolfDeck ?? [])
      const need = Math.max(3, connectedPlayers.length) + 3
      if (selected.has(poolIndex)) {
        selected.delete(poolIndex)
      } else {
        if (selected.size >= need) return
        selected.add(poolIndex)
      }
      room.sendIntent({
        type: 'host.setWerewolfDeck',
        poolIndices: [...selected].sort((a, b) => a - b),
      })
    },
    [canEditLobbyDeck, connectedPlayers.length, room],
  )

  // Lobby: tap a document sheet to lift it toward the camera; tap again to put it back.
  const onSelectLobbyProp = useCallback(
    (id: string) => {
      if (!inLobby || !isLobbyDocId(id)) return
      setFocusedDocId((prev) => (prev === id ? null : id))
    },
    [inLobby],
  )

  const onDismissDoc = useCallback(() => {
    setFocusedDocId(null)
  }, [])

  useEffect(() => {
    if (!inLobby) setFocusedDocId(null)
  }, [inLobby])

  const playerCarouselEl = showPlayerCarousel ? (
    <PlayerCardCarousel
      snapshot={room.snapshot}
      localClientId={room.clientId}
      seatingEnabled={false}
      onSpeakNpc={
        hostCanPromptNpcSpeak && !room.snapshot.watchMode
          ? promptNpcSpeak
          : undefined
      }
      speakDisabled={Boolean(room.snapshot.chatLocked)}
    />
  ) : null

  const chatDockEl = chatAvailable ? (
    <aside
      className="chat-dock"
      aria-label={
        inLobby
          ? 'Lobby talk'
          : room.snapshot.game?.phase === 'reveal'
            ? 'Aftergame talk'
            : room.snapshot.watchMode
              ? 'Watch mode table talk'
              : 'Table talk'
      }
    >
      {!narrow && (
        <div
          className="chat-dock-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat dock"
          aria-valuenow={chatDock.width}
          aria-valuemin={CHAT_DOCK_HARD_MIN_WIDTH}
          aria-valuemax={CHAT_DOCK_MAX_WIDTH}
          tabIndex={0}
          onPointerDown={chatDock.beginResize}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 40 : 16
            if (e.key === 'ArrowLeft') {
              e.preventDefault()
              chatDock.setWidth((w) => w + step)
            } else if (e.key === 'ArrowRight') {
              e.preventDefault()
              chatDock.setWidth((w) => w - step)
            }
          }}
        />
      )}
      <div className="chat-dock-body">
        {!narrow && playerCarouselEl}
        <DayChatPanel
          snapshot={room.snapshot}
          localClientId={room.clientId}
          onTranscript={onChatTranscript}
          onStopTts={stopPlayerTts}
          onSilenceTts={silencePlayerTts}
          onOpenAiSetup={
            inLobby ? (section) => openSettings(section) : undefined
          }
          onClearChat={
            inLobby
              ? () => room.sendIntent({ type: 'chat.clear' })
              : undefined
          }
        />      </div>
    </aside>
  ) : null

  return (
    <div
      className={`app-shell onw-shell${narrow ? ` narrow pane-${mobilePane.mode}` : ''}`}
    >
      {narrow && (
        <div className="mobile-chrome">
          <button
            type="button"
            className="mobile-pane-toggle"
            aria-label={mobilePaneToggleLabel(mobilePane.mode)}
            title={mobilePaneToggleTitle(mobilePane.mode)}
            onClick={mobilePane.cycleMode}
            data-mode={mobilePane.mode}
          >
            <span className="mobile-pane-toggle-icon" aria-hidden>
              <span className="mobile-pane-toggle-block scene" />
              <span className="mobile-pane-toggle-block chat" />
            </span>
          </button>
          <LobbyControls
            snapshot={room.snapshot}
            onOpenSettings={() => openSettings('game')}
          />
        </div>
      )}
      <div
        className={`app-body${chatAvailable && !narrow ? ' chat-dock-open' : ''}`}
        style={
          chatAvailable && !narrow
            ? ({ '--chat-dock-width': `${chatDock.width}px` } as CSSProperties)
            : undefined
        }
      >
      <div className="scene-stage">
        <GameEngine
          snapshot={room.snapshot}
          localClientId={room.clientId}
          isHost
          selectedModeId={focusedDocId}
          onSelectMode={onSelectLobbyProp}
          onDismissDoc={onDismissDoc}
          onReady={() => setSceneReady(true)}
          onGameIntent={onGameIntent}
          seatingEnabled={false}
          orbitEnabled={sceneReady}
          showSceneCards={!narrow}
          lobbyDeck={lobbyDeck}
          canEditLobbyDeck={canEditLobbyDeck}
          onToggleLobbyRole={onToggleLobbyRole}
          lobbyDeckNeed={lobbyDeckNeed}
        />

        <div className="hud">
          {!narrow && (
            <div className="top-bar">
              <LobbyControls
                snapshot={room.snapshot}
                onOpenSettings={() => openSettings('game')}
              />
            </div>
          )}

          {(lobbyReadyToStart || lobbyReadyToWatch) && (
            <div className="lobby-start-bar">
              {lobbyReadyToStart && (
                <button
                  type="button"
                  className="btn primary lobby-start-btn"
                  onClick={() => openSettings('game')}
                >
                  Start game
                </button>
              )}
              {lobbyReadyToWatch && (
                <button
                  type="button"
                  className="btn lobby-watch-btn"
                  onClick={onWatchGame}
                  title="Spectate an all-AI table"
                >
                  Watch game
                </button>
              )}
            </div>
          )}

          {playing && (
            <GamePlayOverlay
              snapshot={room.snapshot}
              localClientId={room.clientId}
              interactive={playInteractive}
              isHost
              onIntent={onGameIntent}
              onRematch={onRematch}
              onAbortGame={onStopGame}
            />
          )}

          {room.error && (
            <p className="error toast">{room.error}</p>
          )}
          {aiHostError && (
            <div className="error toast ai-toast" role="alert">
              <div className="toast-body">
                <p className="toast-message">{aiHostError.message}</p>
                <button
                  type="button"
                  className="toast-link"
                  onClick={() => {
                    clearAiHostError()
                    openSettings(
                      aiHostError.kind === 'tts' ? 'tts' : 'aiProviders',
                    )
                  }}
                >
                  {aiHostError.kind === 'tts'
                    ? 'Open TTS settings'
                    : 'Open AI providers'}
                </button>
              </div>
              <button
                type="button"
                className="toast-dismiss"
                onClick={clearAiHostError}
                aria-label="Dismiss error"
              >
                ×
              </button>
            </div>
          )}

          {!sceneReady && (
            <div className="scene-loading" role="status" aria-live="polite">
              <div className="scene-loading-inner">
                <span className="scene-spinner" aria-hidden />
                <p>The moon is rising…</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {!narrow && chatDockEl}
      </div>

      {narrow && (showPlayerCarousel || chatAvailable) && (
        <div className="mobile-dock">
          {playerCarouselEl}
          {chatDockEl}
        </div>
      )}

      <SettingsShell
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false)
          setSettingsSection('game')
        }}
        section={settingsSection}
        onSectionChange={setSettingsSection}
        snapshot={room.snapshot}
        inLobby={Boolean(inLobby)}
        onSetSceneVisuals={(visuals) =>
          room.sendIntent({
            type: 'host.setSceneVisuals',
            visuals,
          })
        }
        onStopGame={onStopGame}
        onRematch={onRematch}
        onSyncProfile={(patch) => {
          if (patch.name != null) {
            room.sendIntent({
              type: 'profile.setName',
              name: patch.name,
            })
          }
          if (patch.photoDataUrl !== undefined) {
            room.sendIntent({
              type: 'profile.setPhoto',
              photoDataUrl: patch.photoDataUrl,
            })
          }
        }}
        onSetAiPlayers={(profiles) => {
          if (!inLobby) return
          room.sendIntent({
            type: 'host.setAiPlayers',
            players: aiPlayersIntentPayload(profiles),
          })
        }}
        onStartGame={onStartWerewolfFromSettings}
        onWatchGame={onWatchGame}
      />
    </div>
  )
}
