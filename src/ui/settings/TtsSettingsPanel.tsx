import { useEffect, useMemo, useState } from 'react'
import { setActiveTtsConfigId } from '../../ai/aiStore'
import { isSpeechCapableTransport } from '../../ai/types'
import { useAiStore } from '../../ai/useAiStore'
import {
  isNetworkVoice,
  listUsableBrowserTtsVoices,
  resetBrowserTts,
  seedDefaultNarratorVoiceIfNeeded,
  setBrowserTtsVoiceURI,
} from '../../game/browserTts'
import { speakTts, stopTts } from '../../game/tts'
import {
  listApiVoiceCatalog,
  testTtsConnection,
} from '../../game/ttsApiClient'
import {
  VOICE_ACCENT_OPTIONS,
  VOICE_AGE_OPTIONS,
  VOICE_GENDER_OPTIONS,
  type VoiceAccent,
  type VoiceAge,
  type VoiceGender,
} from '../../game/omniVoiceSpeech'
import { isOmniVoiceEndpoint, patchTtsStore } from '../../game/ttsStore'
import type { ApiVoiceCatalog, TtsEngine } from '../../game/ttsTypes'
import { useTtsStore } from '../../game/useTtsStore'
import {
  setNarratorVoiceURI,
  useSpeechVoices,
} from '../../game/useHostNarrator'
import {
  loadWerewolfSettings,
  saveWerewolfSettings,
  TTS_TEST_LINE,
  type WerewolfHostSettings,
} from '../../game/werewolfSettings'

export function TtsSettingsPanel() {
  const store = useTtsStore()
  const aiStore = useAiStore()
  const voices = useSpeechVoices()
  const englishVoices = useMemo(
    () => listUsableBrowserTtsVoices(voices),
    [voices],
  )

  const speechConfigs = useMemo(() => {
    return aiStore.modelConfigs.filter((c) => {
      const prov = aiStore.providers.find((p) => p.id === c.providerId)
      return isSpeechCapableTransport(prov?.transport)
    })
  }, [aiStore.modelConfigs, aiStore.providers])

  const [werewolf, setWerewolf] = useState<WerewolfHostSettings>(() =>
    loadWerewolfSettings(),
  )
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)
  const [connStatus, setConnStatus] = useState<string | null>(null)
  const [voiceCatalog, setVoiceCatalog] = useState<ApiVoiceCatalog>({
    presets: [],
  })
  const [apiVoicesError, setApiVoicesError] = useState<string | null>(null)

  useEffect(() => {
    setWerewolf(loadWerewolfSettings())
    if (typeof window !== 'undefined') void window.speechSynthesis?.getVoices()
  }, [])

  useEffect(() => {
    if (voices.length === 0) return
    const next = seedDefaultNarratorVoiceIfNeeded(voices)
    setWerewolf(next)
    if (next.voiceURI) {
      setNarratorVoiceURI(next.voiceURI)
      setBrowserTtsVoiceURI(next.voiceURI)
    }
  }, [voices])

  useEffect(() => {
    if (store.engine !== 'api') return
    let cancelled = false
    void listApiVoiceCatalog()
      .then((catalog) => {
        if (!cancelled) {
          setVoiceCatalog(catalog)
          setApiVoicesError(null)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setVoiceCatalog({ presets: [] })
          setApiVoicesError(e instanceof Error ? e.message : String(e))
        }
      })
    return () => {
      cancelled = true
    }
  }, [store.engine, aiStore.activeTtsConfigId, aiStore.providers, aiStore.modelConfigs])

  const syncEnabled = (enabled: boolean) => {
    patchTtsStore({ ttsEnabled: enabled })
    const next = { ...loadWerewolfSettings(), browserTtsEnabled: enabled }
    saveWerewolfSettings(next)
    setWerewolf(next)
  }

  const setEngine = (engine: TtsEngine) => {
    patchTtsStore({ engine })
    setTestError(null)
  }

  const patchWerewolf = (partial: Partial<WerewolfHostSettings>) => {
    const next = { ...loadWerewolfSettings(), ...partial }
    saveWerewolfSettings(next)
    setWerewolf(next)
    if ('voiceURI' in partial) {
      setNarratorVoiceURI(next.voiceURI)
      setBrowserTtsVoiceURI(next.voiceURI)
    }
  }

  const onTest = () => {
    setTestError(null)
    setTesting(true)
    speakTts(TTS_TEST_LINE, {
      browserVoiceURI: werewolf.voiceURI,
      apiVoiceId: store.narratorApiVoiceId,
      speechPhase: 'narrator',
      voiceDesign: {
        voiceAge: store.narratorVoiceAge as VoiceAge,
        voiceGender: store.narratorVoiceGender as VoiceGender,
        voiceAccent: store.narratorVoiceAccent as VoiceAccent,
      },
      onEnd: () => setTesting(false),
      onError: (err) => {
        if (err !== 'canceled') setTestError(err)
        setTesting(false)
      },
    })
  }

  const onAbortTest = () => {
    stopTts()
    setTesting(false)
  }

  const onTestConnection = async () => {
    setConnStatus('Testing…')
    const result = await testTtsConnection()
    setConnStatus(result.ok ? result.detail : `Failed: ${result.detail}`)
  }

  const activeSpeechConfig =
    speechConfigs.find((c) => c.id === aiStore.activeTtsConfigId) ?? null

  return (
    <div className="settings-panel-body">
      <section className="werewolf-settings-section">
        <h3>Speech</h3>
        <label className="menu-check werewolf-settings-tts-enabled">
          <input
            type="checkbox"
            checked={store.ttsEnabled}
            onChange={(e) => syncEnabled(e.target.checked)}
          />
          <span>Enable TTS</span>
        </label>
        <label className="field">
          <span>Engine</span>
          <select
            value={store.engine}
            disabled={!store.ttsEnabled}
            onChange={(e) => setEngine(e.target.value as TtsEngine)}
          >
            <option value="browser">Browser</option>
            <option value="api">API</option>
          </select>
        </label>
      </section>

      {store.engine === 'browser' && (
        <section className="werewolf-settings-section">
          <h3>Narrator (browser)</h3>
          <div className="werewolf-settings-voice-row">
            <select
              value={werewolf.voiceURI ?? ''}
              aria-label="Narrator voice"
              disabled={!store.ttsEnabled}
              onChange={(e) => {
                patchWerewolf({
                  voiceURI: e.target.value ? e.target.value : null,
                })
                setTestError(null)
              }}
            >
              <option value="">Auto</option>
              {englishVoices.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name}
                  {isNetworkVoice(v) ? ' · network' : ''}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn primary tiny"
              disabled={!store.ttsEnabled || testing}
              onClick={testing ? onAbortTest : onTest}
            >
              {testing ? 'Abort' : 'Test'}
            </button>
            {testError && (
              <button
                type="button"
                className="btn tiny"
                onClick={() => {
                  resetBrowserTts()
                  setTestError(null)
                }}
              >
                Reset
              </button>
            )}
          </div>
          {testError && (
            <p className="werewolf-deck-warn" role="alert">
              {testError}
            </p>
          )}
        </section>
      )}

      {store.engine === 'api' && (
        <>
          <section className="werewolf-settings-section">
            <h3>API model</h3>
            <p className="hint">
              Add an <strong>OmniVoice</strong> or OpenAI-compatible speech
              provider under AI providers, create a model config, then select it
              here.
            </p>
            {speechConfigs.length === 0 ? (
              <p className="hint">
                No speech-capable model configs yet. Add OmniVoice (or
                OpenAI / OpenAI-compatible) in AI providers, then a model config.
              </p>
            ) : (
              <label className="field">
                <span>Active TTS config</span>
                <select
                  value={aiStore.activeTtsConfigId ?? ''}
                  disabled={!store.ttsEnabled}
                  onChange={(e) =>
                    setActiveTtsConfigId(e.target.value || null)
                  }
                >
                  <option value="">Select…</option>
                  {speechConfigs.map((c) => {
                    const prov = aiStore.providers.find(
                      (p) => p.id === c.providerId,
                    )
                    return (
                      <option key={c.id} value={c.id}>
                        {c.label}
                        {prov ? ` · ${prov.label}` : ''}
                        {c.modelId ? ` · ${c.modelId}` : ''}
                      </option>
                    )
                  })}
                </select>
              </label>
            )}
            {activeSpeechConfig && (
              <div className="btn-row" style={{ marginTop: '0.5rem' }}>
                <button
                  type="button"
                  className="btn tiny"
                  disabled={!store.ttsEnabled}
                  onClick={() => void onTestConnection()}
                >
                  Test connection
                </button>
              </div>
            )}
            {connStatus && <p className="hint">{connStatus}</p>}
          </section>

          <section className="werewolf-settings-section">
            <h3>Chunking</h3>
            <label className="field">
              <span>Sentences per request</span>
              <select
                value={String(store.apiMaxSentencesPerChunk)}
                disabled={!store.ttsEnabled}
                onChange={(e) =>
                  patchTtsStore({
                    apiMaxSentencesPerChunk: Number(e.target.value),
                  })
                }
              >
                <option value="1">1 (default · least crackle)</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4">4</option>
                <option value="0">Entire reply (often crackles)</option>
              </select>
            </label>
            <p className="hint">
              OmniVoice voice-design can crackle on long requests. Keep chunks
              short; later sentences reuse the first clip as a voice lock so
              timbre stays steadier across the reply.
            </p>
          </section>

          <section className="werewolf-settings-section">
            <h3>Narrator (API)</h3>
            <div className="werewolf-settings-voice-row">
              <select
                value={store.narratorApiVoiceId ?? ''}
                disabled={!store.ttsEnabled || !aiStore.activeTtsConfigId}
                aria-label="Narrator API voice"
                onChange={(e) =>
                  patchTtsStore({
                    narratorApiVoiceId: e.target.value
                      ? e.target.value
                      : null,
                  })
                }
              >
                <option value="">Auto</option>
                {voiceCatalog.presets.length > 0 && (
                  <optgroup label="OmniVoice design">
                    {voiceCatalog.presets.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              <button
                type="button"
                className="btn primary tiny"
                disabled={
                  !store.ttsEnabled || !aiStore.activeTtsConfigId || testing
                }
                onClick={testing ? onAbortTest : onTest}
              >
                {testing ? 'Abort' : 'Test'}
              </button>
            </div>
            {isOmniVoiceEndpoint() && (
                <div className="field" style={{ marginTop: '0.5rem' }}>
                  <span>OmniVoice design (optional)</span>
                  <p className="hint">
                    Age, gender, and accent apply to built-in design voices and
                    Auto.
                  </p>
                  <label className="field">
                    <span>Age</span>
                    <select
                      value={store.narratorVoiceAge || ''}
                      aria-label="Narrator voice age"
                      disabled={!store.ttsEnabled || !aiStore.activeTtsConfigId}
                      onChange={(e) =>
                        patchTtsStore({
                          narratorVoiceAge: e.target.value as VoiceAge,
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
                      value={store.narratorVoiceGender || ''}
                      aria-label="Narrator voice gender"
                      disabled={!store.ttsEnabled || !aiStore.activeTtsConfigId}
                      onChange={(e) =>
                        patchTtsStore({
                          narratorVoiceGender: e.target.value as VoiceGender,
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
                      value={store.narratorVoiceAccent || ''}
                      aria-label="Narrator voice accent"
                      disabled={!store.ttsEnabled || !aiStore.activeTtsConfigId}
                      onChange={(e) =>
                        patchTtsStore({
                          narratorVoiceAccent: e.target.value as VoiceAccent,
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
            {apiVoicesError && (
              <p className="hint">Voices: {apiVoicesError}</p>
            )}
            {testError && (
              <p className="werewolf-deck-warn" role="alert">
                {testError}
              </p>
            )}
          </section>
        </>
      )}
    </div>
  )
}
