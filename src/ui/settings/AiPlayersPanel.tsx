import { useEffect, useMemo, useRef, useState } from 'react'
import {
  aiProfileHasCustomImages,
  aiTableName,
  createAiPlayerProfile,
  deleteAiPlayerProfile,
  loadAiPlayers,
  MAX_AI_PROFILES,
  portraitForAiProfile,
  resetAiPlayerImages,
  resetAiPlayers,
  saveAiPlayerProfile,
  setSeatedAiProfileIds,
  subscribeAiPlayers,
  type AiPlayerProfile,
} from '../../ai/aiPlayers'
import {
  isNetworkVoice,
  listUsableBrowserTtsVoices,
  pickBrowserTtsVoice,
} from '../../game/browserTts'
import { speakTts, stopTts } from '../../game/tts'
import { listApiVoiceCatalog } from '../../game/ttsApiClient'
import type { ApiVoiceCatalog } from '../../game/ttsTypes'
import {
  VOICE_ACCENT_OPTIONS,
  VOICE_AGE_OPTIONS,
  VOICE_GENDER_OPTIONS,
  type VoiceAccent,
  type VoiceAge,
  type VoiceGender,
} from '../../game/omniVoiceSpeech'
import { isOmniVoiceEndpoint } from '../../game/ttsStore'
import { useTtsStore } from '../../game/useTtsStore'
import { useAiStore } from '../../ai/useAiStore'
import { useSpeechVoices } from '../../game/useHostNarrator'
import { clampPhoto, fileToCardPhoto } from '../../net/localProfile'
import { exportPhotoAsJpeg } from '../../net/photoIo'
import { MAX_LOBBY_PLAYERS } from '../../session/npcPlayers'

function introLineFor(profile: AiPlayerProfile): string {
  const full = profile.name.trim() || 'an AI player'
  const nick = profile.nickname.trim()
  const who =
    nick && nick.toLowerCase() !== full.toLowerCase()
      ? `${full} — call me ${nick}`
      : full
  const title = profile.title?.trim()
  const persona = profile.persona.trim()
  if (title && persona) return `Hi, I'm ${who}, ${title}. ${persona}`
  if (persona) return `Hi, I'm ${who}. ${persona}`
  if (title) return `Hi, I'm ${who}, ${title}.`
  return `Hi, I'm ${who}.`
}

function truncate(text: string, max: number): string {
  const t = text.trim()
  if (t.length <= max) return t
  return `${t.slice(0, max - 1)}…`
}

type Props = {
  /** Lobby-only seating sync to the room. */
  inLobby: boolean
  connectedHumanCount: number
  onSeatChange: (profiles: AiPlayerProfile[]) => void
  /** Open guided import for the selected AI player. */
  onGuidedImport?: (profileId: string) => void
}

export function AiPlayersPanel({
  inLobby,
  connectedHumanCount,
  onSeatChange,
  onGuidedImport,
}: Props) {
  const [store, setStore] = useState(() => loadAiPlayers())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [ioError, setIoError] = useState<string | null>(null)
  const [ioStatus, setIoStatus] = useState<string | null>(null)

  useEffect(() => subscribeAiPlayers(() => setStore(loadAiPlayers())), [])

  const maxAi = Math.max(0, MAX_LOBBY_PLAYERS - connectedHumanCount)
  const editing =
    editingId == null
      ? null
      : (store.profiles.find((p) => p.id === editingId) ?? null)

  const syncSeated = () => {
    const next = loadAiPlayers()
    setStore(next)
    if (!inLobby) return
    onSeatChange(
      next.profiles.filter((p) => next.seatedProfileIds.includes(p.id)),
    )
  }

  const toggleSeat = (id: string) => {
    if (!inLobby) return
    const seated = new Set(store.seatedProfileIds)
    if (seated.has(id)) seated.delete(id)
    else {
      if (seated.size >= maxAi) return
      seated.add(id)
    }
    const ids = store.profiles
      .map((p) => p.id)
      .filter((pid) => seated.has(pid))
    setSeatedAiProfileIds(ids)
    syncSeated()
  }

  const onResetAll = () => {
    if (
      !window.confirm(
        'Reset all AI players to the stock defaults? This clears custom names, nicknames, personas, voices, photos, and seating.',
      )
    ) {
      return
    }
    setIoError(null)
    setEditingId(null)
    resetAiPlayers()
    setStore(loadAiPlayers())
    setIoStatus('Reset AI players to defaults')
    syncSeated()
  }

  const onAddPlayer = () => {
    setIoError(null)
    const created = createAiPlayerProfile()
    if (!created) {
      setIoError(`Roster is full (max ${MAX_AI_PROFILES} AI players).`)
      return
    }
    setStore(loadAiPlayers())
    setEditingId(created.id)
    setIoStatus('Added a new AI player')
  }

  const onDeletePlayer = (profile: AiPlayerProfile) => {
    if (
      !window.confirm(
        `Delete “${aiTableName(profile)}”? This cannot be undone (use Reset to defaults to restore the stock six).`,
      )
    ) {
      return
    }
    setIoError(null)
    if (editingId === profile.id) setEditingId(null)
    deleteAiPlayerProfile(profile.id)
    setIoStatus(`Deleted ${aiTableName(profile)}`)
    syncSeated()
  }

  return (
    <div className="settings-panel-body">
      <h3>AI players</h3>
      <p className="hint">
        Define as many personas as you like; seat up to {maxAi} in the lobby
        (capacity {MAX_LOBBY_PLAYERS}). Checkboxes sync into the live lobby when
        open. Bulk JSON import/export lives under Settings → Load/Save/Reset.
      </p>

      <div className="btn-row" style={{ flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn tiny primary"
          onClick={onAddPlayer}
          disabled={store.profiles.length >= MAX_AI_PROFILES}
        >
          Add player
        </button>
        <button type="button" className="btn tiny danger" onClick={onResetAll}>
          Reset to defaults
        </button>
      </div>
      {ioError && <p className="hint">{ioError}</p>}
      {ioStatus && <p className="hint">{ioStatus}</p>}

      <div className="ai-players-table-wrap">
        <table className="ai-players-table">
          <thead>
            <tr>
              <th scope="col" className="ai-players-col-seat">
                Seat
              </th>
              <th scope="col" className="ai-players-col-photo">
                Photo
              </th>
              <th scope="col">Name</th>
              <th scope="col" className="ai-players-col-hide-sm">
                Nickname
              </th>
              <th scope="col" className="ai-players-col-hide-md">
                Persona
              </th>
              <th scope="col" className="ai-players-col-actions">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {store.profiles.length === 0 ? (
              <tr>
                <td colSpan={6} className="ai-players-empty">
                  No AI players yet. Add one, or reset to the stock defaults.
                </td>
              </tr>
            ) : (
              store.profiles.map((p) => {
                const seated = store.seatedProfileIds.includes(p.id)
                const portrait = portraitForAiProfile(p)
                return (
                  <tr key={p.id} className={seated ? 'seated' : undefined}>
                    <td className="ai-players-col-seat">
                      <input
                        type="checkbox"
                        checked={seated}
                        aria-label={`Seat ${aiTableName(p)}`}
                        disabled={
                          !inLobby ||
                          (!seated && store.seatedProfileIds.length >= maxAi)
                        }
                        onChange={() => toggleSeat(p.id)}
                      />
                    </td>
                    <td className="ai-players-col-photo">
                      <img
                        src={portrait.photoDataUrl}
                        alt=""
                        className="ai-players-table-thumb"
                      />
                    </td>
                    <td>
                      <strong>{aiTableName(p)}</strong>
                      {p.title?.trim() ? (
                        <div className="hint ai-players-table-title">
                          {truncate(p.title, 48)}
                        </div>
                      ) : null}
                    </td>
                    <td className="ai-players-col-hide-sm">
                      {p.nickname.trim() || '—'}
                    </td>
                    <td className="ai-players-col-hide-md">
                      <span className="hint">
                        {truncate(p.persona, 72) || '—'}
                      </span>
                    </td>
                    <td className="ai-players-col-actions">
                      <div className="btn-row ai-players-row-actions">
                        <button
                          type="button"
                          className="btn tiny"
                          onClick={() => {
                            setIoError(null)
                            setIoStatus(null)
                            setEditingId(p.id)
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn tiny danger"
                          onClick={() => onDeletePlayer(p)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="hint">
        {store.seatedProfileIds.length} seated · {store.profiles.length} defined
        {store.profiles.length >= MAX_AI_PROFILES
          ? ` (at max ${MAX_AI_PROFILES})`
          : ''}
      </p>

      {editing && (
        <AiPlayerEditModal
          profile={editing}
          onClose={() => setEditingId(null)}
          onSaved={syncSeated}
          onGuidedImport={
            onGuidedImport
              ? (id) => {
                  setEditingId(null)
                  onGuidedImport(id)
                }
              : undefined
          }
          onError={setIoError}
          onStatus={setIoStatus}
        />
      )}
    </div>
  )
}

type EditModalProps = {
  profile: AiPlayerProfile
  onClose: () => void
  onSaved: () => void
  onGuidedImport?: (profileId: string) => void
  onError: (msg: string | null) => void
  onStatus: (msg: string | null) => void
}

function AiPlayerEditModal({
  profile: profileProp,
  onClose,
  onSaved,
  onGuidedImport,
  onError,
  onStatus,
}: EditModalProps) {
  const [profile, setProfile] = useState(profileProp)
  const [testingVoice, setTestingVoice] = useState(false)
  const voices = useSpeechVoices()
  const usableVoices = useMemo(() => listUsableBrowserTtsVoices(voices), [voices])
  const ttsStore = useTtsStore()
  const aiStore = useAiStore()
  const [apiVoices, setApiVoices] = useState<ApiVoiceCatalog>({
    presets: [],
  })
  const imagePickRef = useRef<HTMLInputElement | null>(null)
  const imageImportRef = useRef<HTMLInputElement | null>(null)
  const voiceTestGen = useRef(0)
  const testingVoiceRef = useRef(false)

  useEffect(() => {
    setProfile(profileProp)
  }, [profileProp])

  const refreshApiVoices = () => {
    if (ttsStore.engine !== 'api') {
      setApiVoices({ presets: [] })
      return
    }
    void listApiVoiceCatalog()
      .then(setApiVoices)
      .catch(() => setApiVoices({ presets: [] }))
  }

  useEffect(() => {
    refreshApiVoices()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh when TTS engine / endpoint changes
  }, [ttsStore.engine, aiStore.activeTtsConfigId])

  useEffect(() => {
    return () => {
      if (!testingVoiceRef.current) return
      voiceTestGen.current += 1
      testingVoiceRef.current = false
      stopTts()
    }
  }, [])

  const previewUrl = portraitForAiProfile(profile).photoDataUrl
  const hasCustomPhoto = aiProfileHasCustomImages(profile)

  const update = (patch: Partial<AiPlayerProfile>) => {
    const next = { ...profile, ...patch }
    saveAiPlayerProfile(next)
    const fresh =
      loadAiPlayers().profiles.find((p) => p.id === next.id) ?? next
    setProfile(fresh)
    onSaved()
  }

  const onPickImage = async (file: File | undefined) => {
    if (!file) return
    onError(null)
    const dataUrl = await fileToCardPhoto(file)
    if (!dataUrl) {
      onError('Could not process image — try another JPEG/PNG.')
      return
    }
    update({ photoDataUrl: dataUrl })
  }

  const onClearImage = () => {
    onError(null)
    update({ photoDataUrl: null })
  }

  const onResetImages = () => {
    onError(null)
    resetAiPlayerImages(profile.id)
    const fresh =
      loadAiPlayers().profiles.find((p) => p.id === profile.id) ?? profile
    setProfile(fresh)
    onSaved()
  }

  const onExportImage = async () => {
    if (!previewUrl) return
    onError(null)
    try {
      await exportPhotoAsJpeg(previewUrl, aiTableName(profile))
    } catch {
      onError('Could not export image.')
    }
  }

  const onImportImage = async (file: File | undefined) => {
    if (!file) return
    onError(null)
    const dataUrl = await fileToCardPhoto(file)
    if (!dataUrl) {
      onError('Could not process image — try another JPEG/PNG.')
      return
    }
    update({ photoDataUrl: dataUrl })
    onStatus('Imported profile image')
  }

  const finishVoiceTest = (gen: number) => {
    if (gen !== voiceTestGen.current) return
    testingVoiceRef.current = false
    setTestingVoice(false)
  }

  const onTestVoice = () => {
    const latest =
      loadAiPlayers().profiles.find((p) => p.id === profile.id) ?? profile
    if (ttsStore.engine === 'browser') {
      if (typeof window === 'undefined' || !window.speechSynthesis) {
        onError('This browser has no text-to-speech support.')
        return
      }
      const requested = latest.voiceURI.trim() || null
      const voice = pickBrowserTtsVoice(requested)
      const voiceURI = voice?.voiceURI ?? null
      if (requested && !voice) {
        onError('That TTS voice is not available in this browser.')
        return
      }
      onError(null)
      const gen = ++voiceTestGen.current
      testingVoiceRef.current = true
      setTestingVoice(true)
      speakTts(introLineFor(latest), {
        browserVoiceURI: voiceURI,
        onEnd: () => finishVoiceTest(gen),
      })
      return
    }
    onError(null)
    const gen = ++voiceTestGen.current
    testingVoiceRef.current = true
    setTestingVoice(true)
    speakTts(introLineFor(latest), {
      apiVoiceId: latest.apiVoiceId || null,
      speechPhase: 'lobby',
      voiceDesign: {
        voiceAge: latest.voiceAge,
        voiceGender: latest.voiceGender,
        voiceAccent: latest.voiceAccent,
      },
      onEnd: () => finishVoiceTest(gen),
      onError: (err) => {
        if (err !== 'canceled') onError(err)
        finishVoiceTest(gen)
      },
    })
  }

  const onAbortVoiceTest = () => {
    voiceTestGen.current += 1
    testingVoiceRef.current = false
    setTestingVoice(false)
    stopTts()
  }

  const closeModal = () => {
    onAbortVoiceTest()
    onClose()
  }

  return (
    <div
      className="ai-player-edit-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeModal()
      }}
    >
      <div
        className="ai-player-edit-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-player-edit-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="ai-player-edit-header">
          <h3 id="ai-player-edit-title">Edit {aiTableName(profile)}</h3>
          <button type="button" className="btn tiny" onClick={closeModal}>
            Close
          </button>
        </header>
        <div className="ai-player-edit-body ai-detail">
          <div className="ai-player-photo-row">
            <div
              className="ai-image-slots"
              role="group"
              aria-label="AI player image"
            >
              <div className="ai-image-slot">
                <div className="ai-image-slot-preview-wrap">
                  {previewUrl && (
                    <img
                      src={previewUrl}
                      alt=""
                      className="ai-player-photo-preview"
                    />
                  )}
                </div>
                <span className="ai-image-slot-label">
                  Profile
                  {hasCustomPhoto ? '' : ' · default'}
                </span>
                <div className="btn-row ai-image-slot-actions">
                  <button
                    type="button"
                    className="btn tiny"
                    onClick={() => imagePickRef.current?.click()}
                  >
                    Set
                  </button>
                  <button
                    type="button"
                    className="btn tiny"
                    disabled={!hasCustomPhoto}
                    onClick={onClearImage}
                  >
                    Clear
                  </button>
                </div>
              </div>
            </div>
            <div className="btn-row" style={{ flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn tiny"
                disabled={!hasCustomPhoto}
                onClick={onResetImages}
              >
                Reset image
              </button>
              <button
                type="button"
                className="btn tiny"
                onClick={() => void onExportImage()}
              >
                Export image
              </button>
              <button
                type="button"
                className="btn tiny"
                onClick={() => imageImportRef.current?.click()}
              >
                Import image
              </button>
              {onGuidedImport && (
                <button
                  type="button"
                  className="btn tiny primary"
                  onClick={() => onGuidedImport(profile.id)}
                >
                  Guided import
                </button>
              )}
            </div>
            <input
              ref={imagePickRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="visually-hidden"
              tabIndex={-1}
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                void onPickImage(file)
              }}
            />
            <input
              ref={imageImportRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="visually-hidden"
              tabIndex={-1}
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                void onImportImage(file)
              }}
            />
          </div>
          <p className="hint">
            Images are resized to fit the card. Clear restores the pack default
            photo for this profile.
          </p>

          <label className="field">
            <span>Name</span>
            <input
              value={profile.name}
              maxLength={40}
              onChange={(e) => update({ name: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Nickname</span>
            <input
              value={profile.nickname}
              maxLength={24}
              placeholder="Table handle"
              onChange={(e) => update({ nickname: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Title</span>
            <input
              value={profile.title ?? ''}
              maxLength={80}
              placeholder="Optional headline"
              onChange={(e) => update({ title: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Persona</span>
            <textarea
              rows={5}
              value={profile.persona}
              onChange={(e) => update({ persona: e.target.value })}
            />
          </label>
          {ttsStore.engine !== 'api' ? (
            <label className="field">
              <span>TTS voice (host)</span>
              <div className="ai-voice-row">
                <select
                  value={
                    profile.voiceURI &&
                    usableVoices.some((v) => v.voiceURI === profile.voiceURI)
                      ? profile.voiceURI
                      : ''
                  }
                  aria-label="TTS voice"
                  onChange={(e) => {
                    onError(null)
                    update({ voiceURI: e.target.value })
                  }}
                >
                  <option value="">Browser default</option>
                  {usableVoices.map((v) => (
                    <option key={v.voiceURI} value={v.voiceURI}>
                      {v.name} ({v.lang})
                      {isNetworkVoice(v) ? ' · network' : ''}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={`btn tiny${testingVoice ? '' : ' primary'}`}
                  onClick={testingVoice ? onAbortVoiceTest : onTestVoice}
                >
                  {testingVoice ? 'Abort' : 'Test'}
                </button>
              </div>
            </label>
          ) : (
            <>
              <label className="field">
                <span>API TTS voice</span>
                <div className="ai-voice-row">
                  <select
                    value={profile.apiVoiceId || ''}
                    aria-label="API TTS voice"
                    onChange={(e) => {
                      onError(null)
                      update({ apiVoiceId: e.target.value })
                    }}
                  >
                    <option value="">Auto</option>
                    {apiVoices.presets.length > 0 && (
                      <optgroup label="OmniVoice design">
                        {apiVoices.presets.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                  <button
                    type="button"
                    className={`btn tiny${testingVoice ? '' : ' primary'}`}
                    onClick={testingVoice ? onAbortVoiceTest : onTestVoice}
                  >
                    {testingVoice ? 'Abort' : 'Test'}
                  </button>
                </div>
              </label>
              {isOmniVoiceEndpoint() && (
                <div className="field">
                  <span>OmniVoice design (optional)</span>
                  <p className="hint">
                    Overrides apply to built-in design voices and Auto.
                  </p>
                  <label className="field">
                    <span>Age</span>
                    <select
                      value={profile.voiceAge || ''}
                      aria-label="Voice age"
                      onChange={(e) =>
                        update({
                          voiceAge: e.target.value as VoiceAge,
                        })
                      }
                    >
                      {VOICE_AGE_OPTIONS.map((o) => (
                        <option key={o.value || 'default'} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Gender</span>
                    <select
                      value={profile.voiceGender || ''}
                      aria-label="Voice gender"
                      onChange={(e) =>
                        update({
                          voiceGender: e.target.value as VoiceGender,
                        })
                      }
                    >
                      {VOICE_GENDER_OPTIONS.map((o) => (
                        <option key={o.value || 'default'} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Accent</span>
                    <select
                      value={profile.voiceAccent || ''}
                      aria-label="Voice accent"
                      onChange={(e) =>
                        update({
                          voiceAccent: e.target.value as VoiceAccent,
                        })
                      }
                    >
                      {VOICE_ACCENT_OPTIONS.map((o) => (
                        <option key={o.value || 'default'} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
            </>
          )}
          {hasCustomPhoto && clampPhoto(profile.photoDataUrl) && (
            <p className="hint">
              Custom image overrides the default until you reset.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
