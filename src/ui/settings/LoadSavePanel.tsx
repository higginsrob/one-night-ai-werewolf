import { useRef, useState } from 'react'
import {
  exportAiPlayers,
  exportAiStack,
  exportAllSettings,
  exportTtsSettings,
  exportUserProfile,
  importAiPlayersFromFile,
  importAiStackFromFile,
  importAllSettingsFromFile,
  importTtsSettingsFromFile,
  importUserProfileFromFile,
  resetAiPlayersSettings,
  resetAiStackSettings,
  resetAllSettingsToDefaults,
  resetTtsSettingsToDefaults,
  resetUserProfileSettings,
  type ImportSummary,
} from '../../ai/aiConfigIo'
import { loadAiPlayers } from '../../ai/aiPlayers'
import type { AiPlayerProfile } from '../../ai/aiPlayers'
import {
  loadLocalProfile,
  type LocalPlayerProfile,
} from '../../net/localProfile'

type Scope = 'all' | 'ai' | 'players' | 'profile' | 'tts'

type Props = {
  /** Sync seated AI players into the live lobby after an import. */
  onAiPlayersImported?: (seated: AiPlayerProfile[]) => void
  /** Sync human name/photo into the live lobby after profile import/reset. */
  onProfileImported?: (profile: LocalPlayerProfile) => void
}

function formatSummary(summary: ImportSummary): string {
  const parts: string[] = []
  if (summary.providers) parts.push(`${summary.providers} provider(s)`)
  if (summary.modelConfigs) {
    const skipped =
      summary.modelConfigsSkipped && summary.modelConfigsSkipped > 0
        ? ` (${summary.modelConfigsSkipped} skipped — missing provider)`
        : ''
    parts.push(`${summary.modelConfigs} model config(s)${skipped}`)
  } else if (summary.modelConfigsSkipped && summary.modelConfigsSkipped > 0) {
    parts.push(
      `${summary.modelConfigsSkipped} model config(s) skipped — missing provider`,
    )
  }
  if (summary.players) parts.push(`${summary.players} AI player(s)`)
  if (summary.profile) parts.push('your profile')
  if (summary.tts) parts.push('TTS settings')
  if (summary.game) parts.push('game settings')
  if (parts.length === 0) return 'Imported settings'
  return `Imported ${parts.join(', ')}`
}

const ROWS: {
  id: Scope
  title: string
  blurb: string
  fileHint: string
  resetConfirm: string
}[] = [
  {
    id: 'all',
    title: 'All',
    blurb:
      'Everything below, plus game settings (timers, browser narrator voice). API keys are never included in exports.',
    fileHint: 'onw-settings-bundle.json',
    resetConfirm:
      'Reset all settings to defaults? This restores stock AI providers (Ollama + OmniVoice), Chat / Classifier / Voice model configs, AI players, your profile, TTS, and game settings. API keys in memory are cleared.',
  },
  {
    id: 'ai',
    title: 'AI providers + model configs',
    blurb:
      'Providers and model configs together (model configs need their providers). Active chat / classifier / guide / TTS model assignments included. API keys are never included in exports.',
    fileHint: 'onw-ai-providers-and-models.json',
    resetConfirm:
      'Reset AI providers and model configs to defaults (Ollama + OmniVoice; Chat 8k / Classifier 2k / Voice)? This also clears API keys held in memory.',
  },
  {
    id: 'players',
    title: 'AI players',
    blurb: 'Personas, photos, voices, and seating preferences.',
    fileHint: 'onw-ai-players.json',
    resetConfirm:
      'Reset AI players to the six stock defaults and clear seating?',
  },
  {
    id: 'profile',
    title: 'Profile',
    blurb: 'Your name, nickname, title, persona, and profile photo.',
    fileHint: 'onw-user-profile.json',
    resetConfirm:
      'Reset your profile? This clears name, nickname, title, persona, and photo.',
  },
  {
    id: 'tts',
    title: 'TTS settings',
    blurb:
      'Engine, enable flag, narrator API voice, OmniVoice design overrides, and browser narrator voice.',
    fileHint: 'onw-tts-settings.json',
    resetConfirm: 'Reset TTS settings and browser narrator voice to defaults?',
  },
]

export function LoadSavePanel({
  onAiPlayersImported,
  onProfileImported,
}: Props) {
  const importRefs = useRef<Partial<Record<Scope, HTMLInputElement | null>>>({})
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Scope | null>(null)

  const syncSeatedPlayers = () => {
    const next = loadAiPlayers()
    onAiPlayersImported?.(
      next.profiles.filter((p) => next.seatedProfileIds.includes(p.id)),
    )
  }

  const syncProfile = (profile = loadLocalProfile()) => {
    onProfileImported?.(profile)
  }

  const onExport = (scope: Scope) => {
    setError(null)
    try {
      if (scope === 'all') exportAllSettings()
      else if (scope === 'ai') exportAiStack()
      else if (scope === 'players') exportAiPlayers()
      else if (scope === 'profile') exportUserProfile()
      else exportTtsSettings()
      const label = ROWS.find((r) => r.id === scope)?.title ?? scope
      setStatus(`Exported ${label}`)
    } catch {
      setError('Could not export settings.')
    }
  }

  const onImport = async (scope: Scope, file: File | undefined) => {
    if (!file) return
    setError(null)
    setBusy(scope)
    try {
      let summary: ImportSummary
      if (scope === 'all') {
        summary = await importAllSettingsFromFile(file)
      } else if (scope === 'ai') {
        summary = await importAiStackFromFile(file)
      } else if (scope === 'players') {
        const { imported } = await importAiPlayersFromFile(file)
        summary = { players: imported }
      } else if (scope === 'profile') {
        summary = await importUserProfileFromFile(file)
      } else {
        summary = await importTtsSettingsFromFile(file)
      }
      if (summary.players || scope === 'all' || scope === 'players') {
        syncSeatedPlayers()
      }
      if (summary.profile || scope === 'all' || scope === 'profile') {
        syncProfile()
      }
      setStatus(formatSummary(summary))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not import settings.')
    } finally {
      setBusy(null)
    }
  }

  const onReset = (scope: Scope) => {
    const row = ROWS.find((r) => r.id === scope)
    if (!row) return
    if (!window.confirm(row.resetConfirm)) return
    setError(null)
    try {
      if (scope === 'all') resetAllSettingsToDefaults()
      else if (scope === 'ai') resetAiStackSettings()
      else if (scope === 'players') resetAiPlayersSettings()
      else if (scope === 'profile') resetUserProfileSettings()
      else resetTtsSettingsToDefaults()
      if (scope === 'all' || scope === 'players') {
        syncSeatedPlayers()
      }
      if (scope === 'all' || scope === 'profile') {
        syncProfile()
      }
      setStatus(`Reset ${row.title} to defaults`)
    } catch {
      setError('Could not reset settings.')
    }
  }

  return (
    <div className="settings-panel-body load-save-panel">
      <p className="hint">
        Import, export, or reset configuration. Use <strong>All</strong> to move
        a full setup between browsers; use the other rows for partial backups.
        API keys stay in this tab’s memory and are never written to files.
      </p>

      <div className="load-save-rows">
        {ROWS.map((row) => (
          <section key={row.id} className="load-save-row">
            <div className="load-save-row-copy">
              <h3>{row.title}</h3>
              <p className="hint">{row.blurb}</p>
              <p className="hint">
                File: <code>{row.fileHint}</code>
              </p>
            </div>
            <div className="btn-row load-save-row-actions">
              <button
                type="button"
                className="btn tiny"
                disabled={busy !== null}
                onClick={() => onExport(row.id)}
              >
                Export
              </button>
              <button
                type="button"
                className="btn tiny"
                disabled={busy !== null}
                onClick={() => importRefs.current[row.id]?.click()}
              >
                {busy === row.id ? 'Importing…' : 'Import'}
              </button>
              <button
                type="button"
                className="btn tiny danger"
                disabled={busy !== null}
                onClick={() => onReset(row.id)}
              >
                Reset
              </button>
              <input
                ref={(el) => {
                  importRefs.current[row.id] = el
                }}
                type="file"
                accept=".json,application/json"
                className="visually-hidden"
                tabIndex={-1}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  void onImport(row.id, file)
                }}
              />
            </div>
          </section>
        ))}
      </div>

      {error && <p className="hint load-save-error">{error}</p>}
      {status && <p className="hint">{status}</p>}
    </div>
  )
}
