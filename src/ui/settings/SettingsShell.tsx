import { useEffect, useState } from 'react'
import type { AiPlayerProfile } from '../../ai/aiPlayers'
import { checkAiLobbySetup } from '../../ai/readiness'
import { useAiStore } from '../../ai/useAiStore'
import { rolesFromPoolIndices } from '../../game/roles'
import type { WerewolfHostSettings } from '../../game/werewolfSettings'
import type { WerewolfRole } from '../../game/werewolfTypes'
import type { SessionSnapshot } from '../../net/protocol'
import {
  humanTableName,
  type LocalPlayerProfile,
} from '../../net/localProfile'
import {
  resetSceneBackdrop,
  setSceneBackdrop,
} from '../../scene/sceneBackdrop'
import type { SceneVisuals } from '../../scene/sceneVisuals'
import { AiModelConfigsPanel } from './AiModelConfigsPanel'
import { AiPlayersPanel } from './AiPlayersPanel'
import { AiProvidersPanel } from './AiProvidersPanel'
import { GuidedAiPlayerImportModal } from './GuidedAiPlayerImportModal'
import {
  GameSettingsPanel,
  type SkyPreviewPhase,
} from './GameSettingsPanel'
import { LoadSavePanel } from './LoadSavePanel'
import { TtsSettingsPanel } from './TtsSettingsPanel'
import {
  UserProfilePanel,
  type UserProfileSyncPatch,
} from './UserProfilePanel'
import { loadAiPlayers } from '../../ai/aiPlayers'

export type SettingsSection =
  | 'you'
  | 'aiProviders'
  | 'aiModels'
  | 'aiPlayers'
  | 'tts'
  | 'loadSave'
  | 'game'

type GuidedTarget =
  | { kind: 'ai'; profileId: string }
  | { kind: 'human' }

type Props = {
  open: boolean
  onClose: () => void
  section: SettingsSection
  onSectionChange: (section: SettingsSection) => void
  snapshot: SessionSnapshot
  inLobby: boolean
  onSetSceneVisuals: (visuals: Partial<SceneVisuals>) => void
  onStopGame: () => void
  onRematch: () => void
  onSyncProfile: (patch: UserProfileSyncPatch) => void
  onSetAiPlayers?: (profiles: AiPlayerProfile[]) => void
  onStartGame?: (result: {
    settings: WerewolfHostSettings
    deck: WerewolfRole[]
  }) => void
  onWatchGame?: () => void
}

const NAV: {
  id: SettingsSection
  label: string
}[] = [
  { id: 'you', label: 'You' },
  { id: 'aiProviders', label: 'AI providers' },
  { id: 'aiModels', label: 'AI model configs' },
  { id: 'aiPlayers', label: 'AI players' },
  { id: 'tts', label: 'TTS' },
  { id: 'loadSave', label: 'Load/Save/Reset' },
  { id: 'game', label: 'Game' },
]

const DAY_PREVIEW = { intensity: 0.42, blurriness: 0.14 } as const

export function SettingsShell({
  open,
  onClose,
  section,
  onSectionChange,
  snapshot,
  inLobby,
  onSetSceneVisuals,
  onStopGame,
  onRematch,
  onSyncProfile,
  onSetAiPlayers,
  onStartGame,
  onWatchGame,
}: Props) {
  const aiStore = useAiStore()
  const lobbySetup = checkAiLobbySetup(aiStore)
  const hasProviders = lobbySetup.hasProviders
  const hasActiveModelConfig = lobbySetup.hasChatMode && lobbySetup.hasClassifierMode
  const [skyPreview, setSkyPreview] = useState<SkyPreviewPhase | null>(null)
  const [guidedTarget, setGuidedTarget] = useState<GuidedTarget | null>(null)
  const [youPanelKey, setYouPanelKey] = useState(0)

  useEffect(() => {
    if (!open) setSkyPreview(null)
  }, [open])

  useEffect(() => {
    if (!open) setGuidedTarget(null)
  }, [open])

  useEffect(() => {
    if (!skyPreview) return
    if (skyPreview === 'day') {
      setSceneBackdrop({
        variant: 'dusk',
        intensity: DAY_PREVIEW.intensity,
        blurriness: DAY_PREVIEW.blurriness,
      })
    } else {
      setSceneBackdrop({
        variant: 'night',
        intensity: null,
        blurriness: null,
      })
    }
    return () => {
      resetSceneBackdrop()
    }
  }, [skyPreview])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (guidedTarget) return
      if (skyPreview) {
        setSkyPreview(null)
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, skyPreview, guidedTarget])

  useEffect(() => {
    if (section === 'aiModels' && !hasProviders) {
      onSectionChange('aiProviders')
      return
    }
    if (section === 'aiPlayers' && !hasActiveModelConfig) {
      onSectionChange(hasProviders ? 'aiModels' : 'aiProviders')
    }
  }, [
    section,
    onSectionChange,
    hasProviders,
    hasActiveModelConfig,
  ])

  if (!open) return null

  const navDisabledReason = (id: SettingsSection): string | null => {
    if (id === 'aiModels' && !hasProviders) {
      return 'Add an AI provider first'
    }
    if (id === 'aiPlayers' && !hasActiveModelConfig) {
      return 'Set chat and classifier model configs first'
    }
    return null
  }

  const leaveGuidedConfirm = () => {
    if (!guidedTarget) return true
    return window.confirm(
      guidedTarget.kind === 'human'
        ? 'Are you sure you want to leave AI Interview?'
        : 'Are you sure you want to leave guided import?',
    )
  }

  if (skyPreview) {
    return (
      <div className="sky-preview-bar" role="status">
        <span>
          Previewing {skyPreview === 'day' ? 'day' : 'night'} sky — look around
        </span>
        <button
          type="button"
          className="btn primary tiny"
          onClick={() => setSkyPreview(null)}
        >
          Done
        </button>
      </div>
    )
  }

  return (
    <div className="settings-shell-overlay" role="dialog" aria-modal="true">
      <div className="settings-shell">
        <aside className="settings-nav">
          <div className="settings-nav-header">
            <strong>Settings</strong>
            <button
              type="button"
              className="btn tiny"
              onClick={() => {
                if (guidedTarget) {
                  if (!leaveGuidedConfirm()) return
                  setGuidedTarget(null)
                  return
                }
                onClose()
              }}
            >
              Close
            </button>
          </div>
          <nav className="settings-nav-list">
            {NAV.map((item) => {
              const disabledReason = navDisabledReason(item.id)
              const disabled = Boolean(disabledReason)
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`settings-nav-item${section === item.id ? ' active' : ''}${disabled ? ' is-disabled' : ''}`}
                  disabled={disabled}
                  title={disabledReason ?? undefined}
                  aria-disabled={disabled}
                  onClick={() => {
                    if (disabled) return
                    onSectionChange(item.id)
                  }}
                >
                  {item.label}
                </button>
              )
            })}
          </nav>
        </aside>
        <div className="settings-content">
          <h2 className="settings-content-title">
            {NAV.find((n) => n.id === section)?.label ?? 'Settings'}
          </h2>
          {section === 'you' && (
            <UserProfilePanel
              key={youPanelKey}
              onSyncProfile={onSyncProfile}
              onAiInterview={() => setGuidedTarget({ kind: 'human' })}
            />
          )}
          {section === 'aiProviders' && <AiProvidersPanel />}
          {section === 'aiModels' && <AiModelConfigsPanel />}
          {section === 'aiPlayers' && (
            <AiPlayersPanel
              inLobby={inLobby}
              connectedHumanCount={
                snapshot.players.filter((p) => p.connected && !p.isNpc).length
              }
              onSeatChange={(profiles) => onSetAiPlayers?.(profiles)}
              onGuidedImport={(profileId) =>
                setGuidedTarget({ kind: 'ai', profileId })
              }
            />
          )}
          {section === 'tts' && <TtsSettingsPanel />}
          {section === 'loadSave' && (
            <LoadSavePanel
              onAiPlayersImported={(profiles) => onSetAiPlayers?.(profiles)}
              onProfileImported={(profile) => {
                onSyncProfile({
                  name: humanTableName(profile),
                  photoDataUrl: profile.photoDataUrl,
                })
                setYouPanelKey((k) => k + 1)
              }}
            />
          )}
          {section === 'game' && onStartGame && (
            <GameSettingsPanel
              snapshot={snapshot}
              inLobby={inLobby}
              connectedCount={snapshot.players.filter((p) => p.connected).length}
              deck={rolesFromPoolIndices(snapshot.werewolfDeck ?? [])}
              onSetSceneVisuals={onSetSceneVisuals}
              onStopGame={onStopGame}
              onRematch={onRematch}
              onPreviewSky={setSkyPreview}
              onStartGame={onStartGame}
              onWatchGame={onWatchGame}
            />
          )}
        </div>
      </div>
      {guidedTarget?.kind === 'ai' &&
        (() => {
          const profile = loadAiPlayers().profiles.find(
            (p) => p.id === guidedTarget.profileId,
          )
          if (!profile) return null
          return (
            <GuidedAiPlayerImportModal
              target="ai"
              profile={profile}
              onClose={() => setGuidedTarget(null)}
              onApplied={() => {
                const next = loadAiPlayers()
                onSetAiPlayers?.(
                  next.profiles.filter((p) =>
                    next.seatedProfileIds.includes(p.id),
                  ),
                )
              }}
            />
          )
        })()}
      {guidedTarget?.kind === 'human' && (
        <GuidedAiPlayerImportModal
          target="human"
          onClose={() => setGuidedTarget(null)}
          onApplied={(profile: LocalPlayerProfile) => {
            onSyncProfile({
              name: humanTableName(profile),
              photoDataUrl: profile.photoDataUrl,
            })
            setYouPanelKey((k) => k + 1)
          }}
        />
      )}
    </div>
  )
}
