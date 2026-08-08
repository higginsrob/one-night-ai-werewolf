import { useEffect, useMemo, useState } from 'react'
import { roleName, validateWerewolfDeck } from '../../game/roles'
import {
  loadWerewolfSettings,
  normalizeWerewolfSettings,
  saveWerewolfSettings,
  type WerewolfHostSettings,
  MAX_DAY_DURATION_SEC,
  MIN_DAY_DURATION_SEC,
} from '../../game/werewolfSettings'
import {
  setNarratorVoiceURI,
  unlockHostNarrator,
} from '../../game/useHostNarrator'
import { unlockAmbientNight } from '../../game/ambientNight'
import { isTtsEnabled } from '../../game/tts'
import type { WerewolfRole } from '../../game/werewolfTypes'
import type { SessionSnapshot } from '../../net/protocol'
import {
  DAY_HDRI_OPTIONS,
  NIGHT_HDRI_OPTIONS,
  normalizeSceneVisuals,
  type DayHdriId,
  type NightHdriId,
  type SceneVisuals,
} from '../../scene/sceneVisuals'

export type SkyPreviewPhase = 'night' | 'day'

type Props = {
  snapshot: SessionSnapshot
  inLobby: boolean
  connectedCount: number
  /** Cast chosen on the lobby table (read-only here). */
  deck: WerewolfRole[]
  onSetSceneVisuals: (visuals: Partial<SceneVisuals>) => void
  onStopGame: () => void
  onRematch: () => void
  onPreviewSky: (phase: SkyPreviewPhase) => void
  onStartGame: (result: {
    settings: WerewolfHostSettings
    deck: WerewolfRole[]
  }) => void
  /** Spectate an all-AI table (needs ≥3 seated AIs). */
  onWatchGame?: () => void
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const r = sec % 60
  return r === 0 ? `${m}m` : `${m}m ${r}s`
}

export function GameSettingsPanel({
  snapshot,
  inLobby,
  connectedCount,
  deck,
  onSetSceneVisuals,
  onStopGame,
  onRematch,
  onPreviewSky,
  onStartGame,
  onWatchGame,
}: Props) {
  const connectedPlayers = snapshot.players.filter((p) => p.connected)
  const sceneVisuals = normalizeSceneVisuals(snapshot.sceneVisuals)

  const [settings, setSettings] = useState<WerewolfHostSettings>(() =>
    loadWerewolfSettings(),
  )

  useEffect(() => {
    setSettings(loadWerewolfSettings())
  }, [connectedCount])

  const valid = validateWerewolfDeck(deck, connectedCount)
  const canStart = inLobby && valid
  const connectedAiCount = connectedPlayers.filter((p) => p.isNpc).length
  /** Watch game: ≥3 seated AIs; you spectate from the gallery. */
  const canWatch = inLobby && connectedAiCount >= 3 && Boolean(onWatchGame)

  const castSummary = useMemo(() => {
    const counts = new Map<WerewolfRole, number>()
    for (const r of deck) counts.set(r, (counts.get(r) ?? 0) + 1)
    return [...counts.entries()].map(([role, n]) =>
      n > 1 ? `${roleName(role)} ×${n}` : roleName(role),
    )
  }, [deck])

  const patchSettings = (partial: Partial<WerewolfHostSettings>) => {
    const next = normalizeWerewolfSettings({ ...settings, ...partial })
    setSettings(next)
    saveWerewolfSettings(next)
  }

  const persist = () => {
    const next = normalizeWerewolfSettings(settings)
    saveWerewolfSettings(next)
    setNarratorVoiceURI(next.voiceURI)
    return next
  }

  const onStartClick = () => {
    if (!canStart) return
    const next = persist()
    // Speak in this same click so night TTS stays allowed after claiming.
    if (isTtsEnabled()) {
      unlockHostNarrator({
        speak:
          'Welcome to One Night Ultimate Werewolf, claim your card to begin.',
      })
    }
    unlockAmbientNight()
    onStartGame({ settings: next, deck })
  }

  const onWatchClick = () => {
    if (!canWatch || !onWatchGame) return
    persist()
    onWatchGame()
  }

  return (
    <div className="settings-panel-body game-settings-panel">
      <div className="game-settings-scroll">
      <section className="werewolf-settings-section werewolf-settings-cast">
        <div className="werewolf-settings-row-label">
          <h3>Cast</h3>
          {!valid && (
            <p className="werewolf-deck-warn">
              Need {Math.max(3, connectedCount) + 3} cards · ≥3 players
            </p>
          )}
        </div>
        <ul className="werewolf-deck-summary">
          {castSummary.length === 0 ? (
            <li className="muted">None selected on table</li>
          ) : (
            castSummary.map((line) => <li key={line}>{line}</li>)
          )}
        </ul>
      </section>

      <section className="werewolf-settings-section">
        <h3>Watch game</h3>
        <p className="hint">
          Seat at least 3 AI players to spectate an all-AI table. Cards stay
          face-down while players pick, seat, and resolve night. At dawn the
          narrator says “Everyone, close your eyes,” then cards flip to
          night-start roles (locked tokens mark those deals) and you hear the
          narrated action replay before day discussion.
        </p>
      </section>

      <section className="werewolf-settings-section">
        <h3>Voice</h3>
        <p className="hint">
          Narrator and speech engine settings live under Settings → TTS.
        </p>
      </section>

      <section className="werewolf-settings-section">
        <h3>Audio</h3>
        <label className="menu-check">
          <input
            type="checkbox"
            checked={settings.environmentSoundsEnabled}
            onChange={(e) =>
              patchSettings({ environmentSoundsEnabled: e.target.checked })
            }
          />
          Environment sounds
        </label>
        <p className="hint">
          Quiet crickets and the occasional owl in the lobby and during night.
        </p>
      </section>

      <section className="werewolf-settings-section werewolf-settings-timers">
        <label className="werewolf-settings-timer">
          <span>
            Day <strong>{formatDuration(settings.dayDurationSec)}</strong>
          </span>
          <input
            type="range"
            min={MIN_DAY_DURATION_SEC}
            max={MAX_DAY_DURATION_SEC}
            step={30}
            value={settings.dayDurationSec}
            onChange={(e) =>
              patchSettings({ dayDurationSec: Number(e.target.value) })
            }
          />
        </label>
      </section>

      <section className="werewolf-settings-section">
        <h3>Scene</h3>
        <div className="scene-visual-row">
          <label className="menu-check">
            <input
              type="checkbox"
              checked={sceneVisuals.backgroundBlur}
              onChange={(e) =>
                onSetSceneVisuals({ backgroundBlur: e.target.checked })
              }
            />
            <span>Background blur</span>
          </label>
          <strong>
            {Math.round(sceneVisuals.backgroundBlurAmount * 100)}%
          </strong>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(sceneVisuals.backgroundBlurAmount * 100)}
            aria-label="Background blur amount"
            disabled={!sceneVisuals.backgroundBlur}
            onChange={(e) =>
              onSetSceneVisuals({
                backgroundBlurAmount: Number(e.target.value) / 100,
              })
            }
          />
        </div>
        <label className="field">
          <span>Night sky</span>
          <div className="ai-voice-row">
            <select
              value={sceneVisuals.nightHdri}
              aria-label="Night sky"
              onChange={(e) =>
                onSetSceneVisuals({
                  nightHdri: e.target.value as NightHdriId,
                })
              }
            >
              {NIGHT_HDRI_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn tiny primary"
              onClick={() => onPreviewSky('night')}
            >
              Test
            </button>
          </div>
        </label>
        <label className="field">
          <span>Day sky</span>
          <div className="ai-voice-row">
            <select
              value={sceneVisuals.dayHdri}
              aria-label="Day sky"
              onChange={(e) =>
                onSetSceneVisuals({
                  dayHdri: e.target.value as DayHdriId,
                })
              }
            >
              {DAY_HDRI_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn tiny primary"
              onClick={() => onPreviewSky('day')}
            >
              Test
            </button>
          </div>
        </label>
      </section>
      </div>

      <div className="game-settings-footer">
        {snapshot.phase === 'playing' && (
          <div className="btn-row">
            <button type="button" className="btn" onClick={onRematch}>
              Rematch
            </button>
            <button type="button" className="btn" onClick={onStopGame}>
              Stop game
            </button>
          </div>
        )}

        <div className="btn-row werewolf-settings-actions">
          <button
            type="button"
            className="btn primary"
            disabled={!canStart}
            onClick={onStartClick}
          >
            Start Game
          </button>
          {canWatch && (
            <button
              type="button"
              className="btn"
              onClick={onWatchClick}
              title="Spectate an all-AI table"
            >
              Watch Game
            </button>
          )}
        </div>
        {canWatch ? (
          <p className="hint">
            Start Game seats you at the table. Watch Game lets you spectate the
            AIs with full table vision and a narrated night-action replay.
          </p>
        ) : (
          !inLobby && (
            <p className="hint">Start Game is available in the lobby.</p>
          )
        )}
      </div>
    </div>
  )
}
