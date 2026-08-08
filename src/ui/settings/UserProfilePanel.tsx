import { useRef, useState } from 'react'
import {
  MAX_NAME,
  MAX_NICKNAME,
  MAX_PERSONA,
  MAX_TITLE,
} from '../../ai/aiPlayers'
import { useAiStore } from '../../ai/useAiStore'
import {
  fileToCardPhoto,
  humanTableName,
  loadLocalProfile,
  saveLocalProfile,
  type LocalPlayerProfile,
} from '../../net/localProfile'
import { exportPhotoAsJpeg } from '../../net/photoIo'

export type UserProfileSyncPatch = {
  name?: string
  photoDataUrl?: string | null
}

type Props = {
  onSyncProfile: (patch: UserProfileSyncPatch) => void
  /** Open AI Interview (guided persona flow) for the human profile. */
  onAiInterview?: () => void
}

export function UserProfilePanel({ onSyncProfile, onAiInterview }: Props) {
  const [profile, setProfile] = useState<LocalPlayerProfile>(() =>
    loadLocalProfile(),
  )
  const [ioError, setIoError] = useState<string | null>(null)
  const [ioStatus, setIoStatus] = useState<string | null>(null)
  const imagePickRef = useRef<HTMLInputElement | null>(null)
  const imageImportRef = useRef<HTMLInputElement | null>(null)
  const aiStore = useAiStore()
  const canInterview =
    Boolean(onAiInterview) && aiStore.modelConfigs.length > 0

  const persist = (next: LocalPlayerProfile) => {
    saveLocalProfile(next)
    const fresh = loadLocalProfile()
    setProfile(fresh)
    onSyncProfile({
      name: humanTableName(fresh),
      photoDataUrl: fresh.photoDataUrl,
    })
  }

  const update = (patch: Partial<LocalPlayerProfile>) => {
    setIoError(null)
    persist({ ...profile, ...patch })
  }

  const onPickImage = async (file: File | undefined) => {
    if (!file) return
    setIoError(null)
    const dataUrl = await fileToCardPhoto(file)
    if (!dataUrl) {
      setIoError('Could not process image — try another JPEG/PNG.')
      return
    }
    update({ photoDataUrl: dataUrl })
    setIoStatus('Updated profile image')
  }

  const onClearImage = () => {
    setIoError(null)
    update({ photoDataUrl: null })
    setIoStatus('Cleared profile image')
  }

  const onExportImage = async () => {
    if (!profile.photoDataUrl) return
    setIoError(null)
    try {
      await exportPhotoAsJpeg(profile.photoDataUrl, humanTableName(profile))
    } catch {
      setIoError('Could not export image.')
    }
  }

  return (
    <div className="settings-panel-body">
      <h3>Your profile</h3>
      <p className="hint">
        Name and photo show on your card. Nickname, title, and persona are shared
        with AI players so table talk can address you more naturally.
      </p>

      <div className="ai-detail">
        <div className="ai-player-photo-row">
          <div
            className="ai-image-slots"
            role="group"
            aria-label="Your profile image"
          >
            <div className="ai-image-slot">
              <div className="ai-image-slot-preview-wrap">
                {profile.photoDataUrl && (
                  <img
                    src={profile.photoDataUrl}
                    alt=""
                    className="ai-player-photo-preview"
                  />
                )}
              </div>
              <span className="ai-image-slot-label">Profile</span>
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
                  disabled={!profile.photoDataUrl}
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
              disabled={!profile.photoDataUrl}
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
            {onAiInterview && (
              <button
                type="button"
                className="btn tiny primary"
                disabled={!canInterview}
                title={
                  canInterview
                    ? undefined
                    : 'Add an AI model config first (Settings → AI model configs)'
                }
                onClick={onAiInterview}
              >
                AI Interview
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
              void onPickImage(file)
            }}
          />
        </div>
        <p className="hint">
          Images are resized to fit the card. Clear removes your custom photo.
        </p>

        <label className="field">
          <span>Name</span>
          <input
            value={profile.name}
            maxLength={MAX_NAME}
            placeholder="Your name"
            onChange={(e) => update({ name: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Nickname</span>
          <input
            value={profile.nickname}
            maxLength={MAX_NICKNAME}
            placeholder="Table handle"
            onChange={(e) => update({ nickname: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Title</span>
          <input
            value={profile.title}
            maxLength={MAX_TITLE}
            placeholder="Optional headline"
            onChange={(e) => update({ title: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Persona</span>
          <textarea
            rows={5}
            value={profile.persona}
            maxLength={MAX_PERSONA}
            placeholder="How you play and talk at the table"
            onChange={(e) => update({ persona: e.target.value })}
          />
        </label>
      </div>

      {ioError && <p className="hint">{ioError}</p>}
      {ioStatus && <p className="hint">{ioStatus}</p>}
    </div>
  )
}
