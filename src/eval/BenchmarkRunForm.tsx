import { useEffect, useMemo, useState } from 'react'
import {
  aiTableName,
  loadAiPlayers,
  setSeatedAiProfileIds,
  subscribeAiPlayers,
  type AiPlayerProfile,
} from '../ai/aiPlayers'
import { useAiStore } from '../ai/useAiStore'
import {
  buildRoleDeck,
  validateWerewolfDeck,
} from '../game/roles'
import { stopTts } from '../game/tts'
import { loadTtsStore, patchTtsStore } from '../game/ttsStore'
import {
  loadWerewolfSettings,
  normalizeWerewolfSettings,
  saveWerewolfSettings,
  type WerewolfHostSettings,
  MAX_DAY_DURATION_SEC,
  MAX_NIGHT_ACT_SEC,
  MIN_DAY_DURATION_SEC,
  MIN_NIGHT_ACT_SEC,
} from '../game/werewolfSettings'
import type { WerewolfRole } from '../game/werewolfTypes'
import { MAX_LOBBY_PLAYERS } from '../session/npcPlayers'
import { WerewolfDeckBuilder } from '../ui/WerewolfDeckBuilder'
import {
  loadEvalWorkerIds,
  saveEvalWorkerIds,
} from './evalMode'
import {
  isBenchmarkActive,
  subscribeEvalStore,
} from './evalStore'

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const r = sec % 60
  return r === 0 ? `${m}m` : `${m}m ${r}s`
}

export type BenchmarkRunConfig = {
  workerConfigIds: string[]
  settings: WerewolfHostSettings
  deck: WerewolfRole[]
  aiProfileIds: string[]
}

type Props = {
  onStart: (config: BenchmarkRunConfig) => void
  onCancel: () => void
  /** Apply seated AI profiles to the live session before start. */
  onApplyCast: (profiles: AiPlayerProfile[], deck: WerewolfRole[]) => void
}

export function BenchmarkRunForm({ onStart, onCancel, onApplyCast }: Props) {
  const aiStore = useAiStore()
  const [aiStoreLocal, setAiStoreLocal] = useState(() => loadAiPlayers())
  const [workerIds, setWorkerIds] = useState<string[]>(() => loadEvalWorkerIds())
  const [seatedIds, setSeatedIds] = useState<string[]>(() =>
    loadAiPlayers().seatedProfileIds.slice(0, MAX_LOBBY_PLAYERS),
  )
  const [settings, setSettings] = useState<WerewolfHostSettings>(() => {
    // Master mute is ttsStore.ttsEnabled; keep werewolf.browserTtsEnabled aligned.
    const werewolf = loadWerewolfSettings()
    const ttsEnabled = loadTtsStore().ttsEnabled
    if (werewolf.browserTtsEnabled === ttsEnabled) return werewolf
    const synced = normalizeWerewolfSettings({
      ...werewolf,
      browserTtsEnabled: ttsEnabled,
    })
    saveWerewolfSettings(synced)
    return synced
  })
  const [deck, setDeck] = useState<WerewolfRole[]>(() => {
    const n = Math.max(3, loadAiPlayers().seatedProfileIds.length)
    return buildRoleDeck(n)
  })
  const [running, setRunning] = useState(() => isBenchmarkActive())

  useEffect(() => subscribeAiPlayers(() => setAiStoreLocal(loadAiPlayers())), [])
  useEffect(() => {
    return subscribeEvalStore(() => setRunning(isBenchmarkActive()))
  }, [])

  const seatedCount = seatedIds.length
  const deckValid = validateWerewolfDeck(deck, seatedCount)

  const classifierLabel = useMemo(() => {
    const id =
      aiStore.activeClassifierConfigId ?? aiStore.activeWorkConfigId
    const cfg = id
      ? aiStore.modelConfigs.find((c) => c.id === id)
      : null
    if (!cfg) return 'None configured'
    const via =
      aiStore.activeClassifierConfigId == null ? ' (work fallback)' : ''
    return `${cfg.label || cfg.modelId}${via}`
  }, [aiStore])

  const toggleWorker = (id: string) => {
    setWorkerIds((prev) => {
      const next = prev.includes(id)
        ? prev.filter((x) => x !== id)
        : [...prev, id]
      saveEvalWorkerIds(next)
      return next
    })
  }

  const moveWorker = (id: string, dir: -1 | 1) => {
    setWorkerIds((prev) => {
      const i = prev.indexOf(id)
      if (i < 0) return prev
      const j = i + dir
      if (j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j]!, next[i]!]
      saveEvalWorkerIds(next)
      return next
    })
  }

  const toggleSeat = (id: string) => {
    setSeatedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      if (prev.length >= MAX_LOBBY_PLAYERS) return prev
      return [...prev, id]
    })
  }

  // Keep deck sized to cast when seat count changes.
  useEffect(() => {
    if (seatedCount < 3) return
    const need = seatedCount + 3
    if (deck.length !== need) {
      setDeck(buildRoleDeck(seatedCount))
    }
  }, [seatedCount, deck.length])

  const patchSettings = (partial: Partial<WerewolfHostSettings>) => {
    const next = normalizeWerewolfSettings({ ...settings, ...partial })
    setSettings(next)
    saveWerewolfSettings(next)
  }

  /** Gate all engines (browser + API). Matches Settings → TTS. */
  const setSpeechEnabled = (enabled: boolean) => {
    patchTtsStore({ ttsEnabled: enabled })
    patchSettings({ browserTtsEnabled: enabled })
    if (!enabled) stopTts()
  }

  const canStart =
    !running &&
    workerIds.length >= 1 &&
    seatedCount >= 3 &&
    deckValid

  const onSubmit = () => {
    if (!canStart) return
    setSeatedAiProfileIds(seatedIds)
    const profiles = aiStoreLocal.profiles.filter((p) =>
      seatedIds.includes(p.id),
    )
    const nextSettings = normalizeWerewolfSettings(settings)
    saveWerewolfSettings(nextSettings)
    // Re-assert master mute from the form so a suite never ignores the checkbox.
    patchTtsStore({ ttsEnabled: nextSettings.browserTtsEnabled })
    if (!nextSettings.browserTtsEnabled) stopTts()
    onApplyCast(profiles, deck)
    onStart({
      workerConfigIds: workerIds,
      settings: nextSettings,
      deck,
      aiProfileIds: seatedIds,
    })
  }

  return (
    <form
      className="bench-run-form"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <header className="bench-run-form-header">
        <h2>Run benchmarks</h2>
        <p className="muted">
          Watch-mode AI-only suites. Logs write to <code>benchmarks/</code>.
        </p>
      </header>

      <section className="bench-form-section">
        <h3>Worker models</h3>
        <p className="hint">
          Run order is sequential. Classifier stays fixed:{' '}
          <strong>{classifierLabel}</strong>
        </p>
        <ul className="eval-worker-list">
          {aiStore.modelConfigs.length === 0 ? (
            <li className="muted">
              No model configs — add some under Settings → AI model configs in
              the main app.
            </li>
          ) : (
            aiStore.modelConfigs.map((c) => {
              const checked = workerIds.includes(c.id)
              return (
                <li key={c.id} className="eval-worker-row">
                  <label className="menu-check">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={running}
                      onChange={() => toggleWorker(c.id)}
                    />
                    <span>
                      {c.label || c.modelId}
                      <span className="muted"> · {c.modelId}</span>
                    </span>
                  </label>
                  {checked && (
                    <span className="eval-worker-order btn-row">
                      <button
                        type="button"
                        className="btn tiny"
                        aria-label="Move earlier"
                        disabled={running}
                        onClick={() => moveWorker(c.id, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="btn tiny"
                        aria-label="Move later"
                        disabled={running}
                        onClick={() => moveWorker(c.id, 1)}
                      >
                        ↓
                      </button>
                    </span>
                  )}
                </li>
              )
            })
          )}
        </ul>
        {workerIds.length > 0 && (
          <p className="hint">
            Order:{' '}
            {workerIds
              .map(
                (id) =>
                  aiStore.modelConfigs.find((c) => c.id === id)?.label ?? id,
              )
              .join(' → ')}
          </p>
        )}
      </section>

      <section className="bench-form-section">
        <h3>AI cast</h3>
        <p className="hint">Seat at least 3 AI players (max {MAX_LOBBY_PLAYERS}).</p>
        <ul className="bench-cast-list">
          {aiStoreLocal.profiles.map((p) => {
            const checked = seatedIds.includes(p.id)
            return (
              <li key={p.id}>
                <label className="menu-check">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={
                      running ||
                      (!checked && seatedIds.length >= MAX_LOBBY_PLAYERS)
                    }
                    onChange={() => toggleSeat(p.id)}
                  />
                  <span>
                    {aiTableName(p)}
                    {p.title ? (
                      <span className="muted"> · {p.title}</span>
                    ) : null}
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
        <p className="hint">
          {seatedCount} seated
          {seatedCount < 3 ? ' — need ≥3' : ''}
        </p>
      </section>

      <section className="bench-form-section">
        <h3>Role cards</h3>
        <WerewolfDeckBuilder
          connectedCount={seatedCount}
          deck={deck}
          isHost={!running && seatedCount >= 3}
          onChange={setDeck}
        />
      </section>

      <section className="bench-form-section">
        <h3>Game settings</h3>
        <label className="werewolf-settings-timer">
          <span>
            Day <strong>{formatDuration(settings.dayDurationSec)}</strong>
          </span>
          <input
            type="range"
            min={MIN_DAY_DURATION_SEC}
            max={MAX_DAY_DURATION_SEC}
            step={30}
            disabled={running}
            value={settings.dayDurationSec}
            onChange={(e) =>
              patchSettings({ dayDurationSec: Number(e.target.value) })
            }
          />
        </label>
        <label className="werewolf-settings-timer">
          <span>
            Night act <strong>{formatDuration(settings.nightActSec)}</strong>
          </span>
          <input
            type="range"
            min={MIN_NIGHT_ACT_SEC}
            max={MAX_NIGHT_ACT_SEC}
            step={1}
            disabled={running}
            value={settings.nightActSec}
            onChange={(e) =>
              patchSettings({ nightActSec: Number(e.target.value) })
            }
          />
        </label>
        <label className="menu-check">
          <input
            type="checkbox"
            checked={settings.browserTtsEnabled}
            disabled={running}
            onChange={(e) => setSpeechEnabled(e.target.checked)}
          />
          Speech / TTS
        </label>
        <label className="menu-check">
          <input
            type="checkbox"
            checked={settings.environmentSoundsEnabled}
            disabled={running}
            onChange={(e) =>
              patchSettings({ environmentSoundsEnabled: e.target.checked })
            }
          />
          Environment sounds
        </label>
      </section>

      <div className="bench-run-actions btn-row">
        {running ? (
          <button type="button" className="btn danger" onClick={onCancel}>
            Cancel suite
          </button>
        ) : (
          <button type="submit" className="btn primary" disabled={!canStart}>
            Run benchmarks
          </button>
        )}
      </div>
    </form>
  )
}
