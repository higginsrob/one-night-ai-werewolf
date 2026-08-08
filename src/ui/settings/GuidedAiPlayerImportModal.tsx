import { useCallback, useEffect, useRef, useState } from 'react'
import {
  personaGuideKickoffUserMessage,
  runPersonaGuideTurn,
  type PersonaGuideDraft,
} from '../../ai/agent/personaGuide'
import {
  aiTableName,
  portraitForAiProfile,
  saveAiPlayerProfile,
  type AiPlayerProfile,
} from '../../ai/aiPlayers'
import { setActiveGuideConfigId } from '../../ai/aiStore'
import { useAiStore } from '../../ai/useAiStore'
import {
  fileToCardPhoto,
  humanTableName,
  loadLocalProfile,
  saveLocalProfile,
  type LocalPlayerProfile,
} from '../../net/localProfile'
import type { ChatMessage } from '../../ai/types'

type Step = 'setup' | 'interview' | 'review'

type AiProps = {
  target: 'ai'
  profile: AiPlayerProfile
  onClose: () => void
  onApplied: () => void
}

type HumanProps = {
  target: 'human'
  onClose: () => void
  onApplied: (profile: LocalPlayerProfile) => void
}

type Props = AiProps | HumanProps

type ChatBubble = {
  role: 'user' | 'assistant'
  text: string
}

export function GuidedAiPlayerImportModal(props: Props) {
  const { onClose } = props
  const isHuman = props.target === 'human'
  const aiProfile = props.target === 'ai' ? props.profile : null
  const humanInitial = isHuman ? loadLocalProfile() : null

  const store = useAiStore()
  const [step, setStep] = useState<Step>('setup')
  const [guideConfigId, setGuideConfigId] = useState(
    () => store.activeGuideConfigId ?? store.modelConfigs[0]?.id ?? '',
  )
  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(() => {
    if (aiProfile) return portraitForAiProfile(aiProfile).photoDataUrl
    return humanInitial?.photoDataUrl ?? null
  })
  const [customPhoto, setCustomPhoto] = useState(false)
  const [history, setHistory] = useState<ChatMessage[]>([])
  const [bubbles, setBubbles] = useState<ChatBubble[]>([])
  const [draft, setDraft] = useState<PersonaGuideDraft | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const imageRef = useRef<HTMLInputElement | null>(null)
  const chatEndRef = useRef<HTMLDivElement | null>(null)

  const subjectLabel = aiProfile
    ? aiTableName(aiProfile)
    : humanTableName(humanInitial ?? loadLocalProfile())

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [bubbles, busy])

  const requestClose = useCallback(() => {
    if (
      !window.confirm(
        isHuman
          ? 'Are you sure you want to leave AI Interview?'
          : 'Are you sure you want to leave guided import?',
      )
    ) {
      return
    }
    onClose()
  }, [isHuman, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      requestClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [requestClose])

  const onPickPhoto = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    const dataUrl = await fileToCardPhoto(file)
    if (!dataUrl) {
      setError('Could not process image — try another JPEG/PNG.')
      return
    }
    setPhotoDataUrl(dataUrl)
    setCustomPhoto(true)
  }

  const startInterview = async () => {
    if (!guideConfigId) {
      setError('Select a guide agent model config.')
      return
    }
    setError(null)
    setActiveGuideConfigId(guideConfigId)
    setStep('interview')
    setBusy(true)
    setBubbles([])
    setHistory([])
    setDraft(null)
    const kickoff = personaGuideKickoffUserMessage(isHuman ? 'human' : 'ai')
    try {
      const turn = await runPersonaGuideTurn([kickoff])
      setHistory([
        kickoff,
        {
          role: 'assistant',
          content:
            turn.kind === 'question' ? turn.text : JSON.stringify(turn.draft),
        },
      ])
      if (turn.kind === 'ready') {
        setDraft(turn.draft)
        setBubbles([
          { role: 'assistant', text: 'Ready — review the draft below.' },
        ])
        setStep('review')
      } else {
        setBubbles([{ role: 'assistant', text: turn.text }])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Guide agent failed.')
      setStep('setup')
    } finally {
      setBusy(false)
    }
  }

  const sendUserMessage = async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setError(null)
    const userMsg: ChatMessage = { role: 'user', content: text }
    const nextHistory = [...history, userMsg]
    setHistory(nextHistory)
    setBubbles((b) => [...b, { role: 'user', text }])
    setBusy(true)
    try {
      const turn = await runPersonaGuideTurn(nextHistory)
      if (turn.kind === 'ready') {
        setHistory([
          ...nextHistory,
          { role: 'assistant', content: JSON.stringify(turn.draft) },
        ])
        setDraft(turn.draft)
        setBubbles((b) => [
          ...b,
          { role: 'assistant', text: 'Ready — review the draft below.' },
        ])
        setStep('review')
      } else {
        setHistory([
          ...nextHistory,
          { role: 'assistant', content: turn.text },
        ])
        setBubbles((b) => [...b, { role: 'assistant', text: turn.text }])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Guide agent failed.')
    } finally {
      setBusy(false)
    }
  }

  const applyDraft = () => {
    if (!draft) return
    if (
      !window.confirm(
        isHuman
          ? `Apply AI Interview to your profile? This overwrites name, nickname, title, persona, and photo.`
          : `Apply guided import to ${subjectLabel}? This overwrites name, nickname, title, persona, and photo.`,
      )
    ) {
      return
    }
    if (props.target === 'ai') {
      saveAiPlayerProfile({
        ...props.profile,
        name: draft.name,
        nickname: draft.nickname,
        title: draft.title || undefined,
        persona: draft.persona,
        photoDataUrl: customPhoto
          ? photoDataUrl
          : props.profile.photoDataUrl ?? null,
      })
      props.onApplied()
    } else {
      const prev = loadLocalProfile()
      const next: LocalPlayerProfile = {
        name: draft.name,
        nickname: draft.nickname,
        title: draft.title,
        persona: draft.persona,
        photoDataUrl: customPhoto ? photoDataUrl : prev.photoDataUrl,
      }
      saveLocalProfile(next)
      props.onApplied(loadLocalProfile())
    }
    onClose()
  }

  return (
    <div
      className="guided-import-backdrop"
      role="presentation"
      onClick={requestClose}
    >
      <div
        className="guided-import-modal"
        role="dialog"
        aria-modal="true"
        aria-label={isHuman ? 'AI Interview' : 'Guided AI player import'}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="guided-import-header">
          <h3>
            {isHuman
              ? `AI Interview — ${subjectLabel}`
              : `Guided import — ${subjectLabel}`}
          </h3>
          <button type="button" className="btn tiny" onClick={requestClose}>
            Close
          </button>
        </header>

        {step === 'setup' && (
          <div className="guided-import-body">
            <p className="hint">
              {isHuman
                ? 'Pick a guide agent, optionally set a profile photo, then start the interview. The agent will ask for a text dump first, then follow-up questions until it can write your Werewolf table persona.'
                : 'Pick a guide agent, optionally set a profile photo, then start the interview. The agent will ask for a text dump first, then follow-up questions until it can write a Werewolf table persona.'}
            </p>
            <label className="field">
              <span>Guide agent model</span>
              <select
                value={guideConfigId}
                onChange={(e) => setGuideConfigId(e.target.value)}
              >
                {store.modelConfigs.length === 0 && (
                  <option value="">No model configs</option>
                )}
                {store.modelConfigs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label || c.modelId || c.id}
                  </option>
                ))}
              </select>
            </label>
            <div className="guided-import-photo">
              {photoDataUrl && (
                <img
                  src={photoDataUrl}
                  alt=""
                  className="ai-player-photo-preview"
                />
              )}
              <div className="btn-row">
                <button
                  type="button"
                  className="btn tiny"
                  onClick={() => imageRef.current?.click()}
                >
                  Set profile image
                </button>
                <input
                  ref={imageRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="visually-hidden"
                  tabIndex={-1}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    e.target.value = ''
                    void onPickPhoto(file)
                  }}
                />
              </div>
            </div>
            {error && <p className="error">{error}</p>}
            <div className="btn-row">
              <button
                type="button"
                className="btn primary"
                disabled={!guideConfigId || busy}
                onClick={() => void startInterview()}
              >
                Start interview
              </button>
            </div>
          </div>
        )}

        {(step === 'interview' || step === 'review') && (
          <div className="guided-import-body guided-import-chat">
            <div className="guided-import-transcript" aria-live="polite">
              {bubbles.map((b, i) => (
                <div
                  key={`${b.role}-${i}`}
                  className={`guided-import-bubble ${b.role}`}
                >
                  {b.text}
                </div>
              ))}
              {busy && <p className="hint">Guide agent is thinking…</p>}
              <div ref={chatEndRef} />
            </div>
            {error && <p className="error">{error}</p>}
            {step === 'interview' && (
              <form
                className="guided-import-compose"
                onSubmit={(e) => {
                  e.preventDefault()
                  void sendUserMessage()
                }}
              >
                <textarea
                  rows={3}
                  value={input}
                  disabled={busy}
                  placeholder="Paste a profile dump or answer the question…"
                  onChange={(e) => setInput(e.target.value)}
                />
                <button
                  type="submit"
                  className="btn primary"
                  disabled={busy || !input.trim()}
                >
                  Send
                </button>
              </form>
            )}
            {step === 'review' && draft && (
              <div className="guided-import-review">
                <label className="field">
                  <span>Name</span>
                  <input
                    value={draft.name}
                    maxLength={40}
                    onChange={(e) =>
                      setDraft({ ...draft, name: e.target.value })
                    }
                  />
                </label>
                <label className="field">
                  <span>Nickname</span>
                  <input
                    value={draft.nickname}
                    maxLength={24}
                    onChange={(e) =>
                      setDraft({ ...draft, nickname: e.target.value })
                    }
                  />
                </label>
                <label className="field">
                  <span>Title</span>
                  <input
                    value={draft.title}
                    maxLength={80}
                    onChange={(e) =>
                      setDraft({ ...draft, title: e.target.value })
                    }
                  />
                </label>
                <label className="field">
                  <span>Persona</span>
                  <textarea
                    rows={5}
                    value={draft.persona}
                    onChange={(e) =>
                      setDraft({ ...draft, persona: e.target.value })
                    }
                  />
                </label>
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setStep('interview')
                      setDraft(null)
                    }}
                  >
                    Keep interviewing
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    onClick={applyDraft}
                  >
                    {isHuman ? 'Apply to your profile' : 'Apply to AI player'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
