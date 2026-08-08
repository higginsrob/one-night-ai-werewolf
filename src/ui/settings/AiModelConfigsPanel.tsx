import { useEffect, useRef, useState } from 'react'
import {
  addBlankModelConfig,
  removeModelConfig,
  setActiveClassifierConfigId,
  setActiveGuideConfigId,
  setActiveTtsConfigId,
  setActiveWorkConfigId,
  upsertModelConfig,
} from '../../ai/aiStore'
import { listModelsForProvider } from '../../ai/client'
import { switchForeverOllamaModel } from '../../ai/warmModels'
import {
  MAX_NUM_CTX,
  MAX_SGL_MIN_P,
  MAX_SGL_REPETITION_PENALTY,
  MAX_SGL_TOP_K,
  MAX_TOP_K,
  MAX_TOP_P,
  MIN_NUM_CTX,
  MIN_SGL_MIN_P,
  MIN_SGL_REPETITION_PENALTY,
  MIN_SGL_TOP_K,
  MIN_TOP_K,
  MIN_TOP_P,
  OLLAMA_KEEPALIVE_OPTIONS,
  isSpeechCapableTransport,
  type AiModelConfig,
  type AiProvider,
  type OllamaKeepAlive,
} from '../../ai/types'
import { useAiStore } from '../../ai/useAiStore'

function isOllamaProvider(transport: string | undefined): boolean {
  return transport === 'ollama'
}

function isSglangProvider(transport: string | undefined): boolean {
  return transport === 'sglang'
}

function isOmniVoiceProvider(transport: string | undefined): boolean {
  return transport === 'omnivoice'
}

function formatCtx(n: number): string {
  if (n >= 1024) return `${Math.round(n / 1024)}k`
  return String(n)
}

export function AiModelConfigsPanel() {
  const store = useAiStore()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [warmStatus, setWarmStatus] = useState<string | null>(null)
  const warmGenRef = useRef(0)

  const selected =
    store.modelConfigs.find((c) => c.id === selectedId) ??
    store.modelConfigs[0] ??
    null
  const provider = selected
    ? store.providers.find((p) => p.id === selected.providerId)
    : null
  const ollama = isOllamaProvider(provider?.transport)
  const sglang = isSglangProvider(provider?.transport)
  const omnivoice = isOmniVoiceProvider(provider?.transport)
  const speechCapable = isSpeechCapableTransport(provider?.transport)
  const modelOptions =
    selected?.modelId && !models.includes(selected.modelId)
      ? [selected.modelId, ...models]
      : models

  useEffect(() => {
    if (!provider) {
      setModels([])
      setListLoading(false)
      return
    }
    let cancelled = false
    setListError(null)
    setListLoading(true)
    void listModelsForProvider(provider)
      .then((ids) => {
        if (!cancelled) setModels(ids)
      })
      .catch((err) => {
        if (!cancelled) {
          setModels([])
          setListError(err instanceof Error ? err.message : 'Could not list models')
        }
      })
      .finally(() => {
        if (!cancelled) setListLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [provider])

  const runForeverSwitch = (
    next: AiModelConfig,
    nextProvider: AiProvider,
    opts?: {
      prevModelId?: string | null
      prevProvider?: AiProvider | null
      exceptConfigId?: string | null
    },
  ) => {
    const gen = ++warmGenRef.current
    void switchForeverOllamaModel({
      provider: nextProvider,
      next,
      prevModelId: opts?.prevModelId,
      prevProvider: opts?.prevProvider,
      exceptConfigId: opts?.exceptConfigId,
      onStatus: (msg) => {
        if (gen === warmGenRef.current) setWarmStatus(msg)
      },
    }).catch((err) => {
      if (gen === warmGenRef.current) {
        setWarmStatus(
          err instanceof Error ? err.message : 'Could not switch Ollama model',
        )
      }
    })
  }

  const save = (next: AiModelConfig) => {
    const prevConfig =
      store.modelConfigs.find((c) => c.id === next.id) ?? selected
    const prevProvider = prevConfig
      ? store.providers.find((p) => p.id === prevConfig.providerId)
      : null
    const prevWasForeverOllama =
      Boolean(prevProvider && isOllamaProvider(prevProvider.transport)) &&
      prevConfig?.keepAlive === '-1'
    const prevModelId = prevConfig?.modelId.trim() ?? ''
    const nextModelId = next.modelId.trim()
    const modelChanged = prevModelId !== nextModelId

    upsertModelConfig(next)

    if (!provider || !isOllamaProvider(provider.transport)) {
      return
    }

    const shouldWarm = next.keepAlive === '-1' && Boolean(nextModelId)
    const shouldUnloadPrev =
      prevWasForeverOllama && Boolean(prevModelId) && modelChanged

    if (!shouldWarm && !shouldUnloadPrev) {
      return
    }

    runForeverSwitch(next, provider, {
      prevModelId: shouldUnloadPrev ? prevModelId : null,
      prevProvider: shouldUnloadPrev ? prevProvider : null,
      exceptConfigId: next.id,
    })
  }

  const activateRole = (
    role: 'work' | 'classifier',
    config: AiModelConfig,
  ) => {
    const prevId =
      role === 'work'
        ? store.activeWorkConfigId
        : store.activeClassifierConfigId
    const prevConfig = prevId
      ? store.modelConfigs.find((c) => c.id === prevId)
      : null
    const prevProvider = prevConfig
      ? store.providers.find((p) => p.id === prevConfig.providerId)
      : null
    const nextProvider = store.providers.find((p) => p.id === config.providerId)

    if (role === 'work') setActiveWorkConfigId(config.id)
    else setActiveClassifierConfigId(config.id)

    if (!nextProvider) return

    const prevWasForeverOllama =
      Boolean(prevProvider && isOllamaProvider(prevProvider.transport)) &&
      prevConfig?.keepAlive === '-1'
    const nextIsForeverOllama =
      isOllamaProvider(nextProvider.transport) && config.keepAlive === '-1'

    if (!prevWasForeverOllama && !nextIsForeverOllama) return
    if (prevConfig?.id === config.id) return

    runForeverSwitch(config, nextProvider, {
      prevModelId: prevWasForeverOllama ? prevConfig?.modelId : null,
      prevProvider: prevWasForeverOllama ? prevProvider : null,
    })
  }

  if (store.providers.length === 0) {
    return (
      <div className="settings-panel-body">
        <p className="hint">Add an AI provider first, then create model configs.</p>
        <p className="hint">
          Bulk import/export lives under Settings → Load/Save/Reset.
        </p>
      </div>
    )
  }

  return (
    <div className="settings-panel-body">
      <p className="hint">
        One <strong>work</strong> config runs agents; one <strong>classifier</strong>{' '}
        config routes who should reply. Prefer a small/fast model for the
        classifier. Speech providers (OmniVoice / OpenAI speech) can be marked
        for <strong>TTS</strong>. On local Ollama, avoid two large models both
        set to keep-alive forever with high num_ctx — that often crashes CUDA.
        Ollama configs expose top_p / top_k. SGLang configs expose top_k / min_p /
        repetition penalty and thinking. JSON-object mode is available on the
        active classifier config only. Bulk import/export lives under Settings →
        Load/Save/Reset.
      </p>

      <div className="btn-row" style={{ flexWrap: 'wrap' }}>
        {store.providers.map((p) => (
          <button
            key={p.id}
            type="button"
            className="btn tiny"
            onClick={() => {
              const cfg = addBlankModelConfig(p.id)
              setSelectedId(cfg.id)
            }}
          >
            + Config ({p.label})
          </button>
        ))}
      </div>

      <div className="ai-split">
        <div className="ai-list">
          {store.modelConfigs.map((c) => {
            const prov = store.providers.find((p) => p.id === c.providerId)
            const badges: string[] = []
            if (store.activeWorkConfigId === c.id) badges.push('chat')
            if (store.activeClassifierConfigId === c.id) badges.push('classifier')
            if (store.activeGuideConfigId === c.id) badges.push('guide')
            if (store.activeTtsConfigId === c.id) badges.push('tts')
            return (
              <button
                key={c.id}
                type="button"
                className={`ai-list-item${selected?.id === c.id ? ' active' : ''}`}
                onClick={() => {
                  setSelectedId(c.id)
                  setWarmStatus(null)
                }}
              >
                <strong>{c.label}</strong>
                <span className="hint">
                  {prov?.label ?? '?'} · {c.modelId || 'no model'}
                  {badges.length ? ` · ${badges.join(', ')}` : ''}
                </span>
              </button>
            )
          })}
        </div>

        {selected && (
          <div className="ai-detail">
            <label className="field">
              <span>Label</span>
              <input
                value={selected.label}
                onChange={(e) =>
                  upsertModelConfig({ ...selected, label: e.target.value })
                }
              />
            </label>
            <label className="field">
              <span>Provider</span>
              <select
                value={selected.providerId}
                onChange={(e) =>
                  save({
                    ...selected,
                    providerId: e.target.value,
                    modelId: '',
                  })
                }
              >
                {store.providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Model id</span>
              <select
                value={selected.modelId}
                onChange={(e) =>
                  save({ ...selected, modelId: e.target.value })
                }
                disabled={
                  !selected.modelId &&
                  (listLoading || modelOptions.length === 0)
                }
              >
                <option value="">
                  {listLoading
                    ? 'Loading models…'
                    : listError
                      ? 'Could not list models'
                      : modelOptions.length === 0
                        ? 'No models found'
                        : 'Select a model…'}
                </option>
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            {listError && <p className="hint">{listError}</p>}
            {omnivoice && (
              <p className="hint">
                OmniVoice is speech-only. Use this config for TTS (Settings →
                TTS or “Use for TTS” below). Chat roles ignore it.
              </p>
            )}
            {!omnivoice && (
              <>
                <label className="field">
                  <span>Temperature ({selected.temperature.toFixed(2)})</span>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.05}
                    value={selected.temperature}
                    onChange={(e) =>
                      upsertModelConfig({
                        ...selected,
                        temperature: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>Max tokens</span>
                  <input
                    type="number"
                    min={16}
                    max={8192}
                    value={selected.maxTokens}
                    onChange={(e) =>
                      upsertModelConfig({
                        ...selected,
                        maxTokens: Number(e.target.value) || 1024,
                      })
                    }
                  />
                </label>
              </>
            )}
            {ollama && (
              <>
                <label className="field">
                  <span>
                    Context window (num_ctx): {formatCtx(selected.numCtx)}
                  </span>
                  <input
                    type="range"
                    min={MIN_NUM_CTX}
                    max={Math.min(MAX_NUM_CTX, 65536)}
                    step={512}
                    value={selected.numCtx}
                    onChange={(e) =>
                      upsertModelConfig({
                        ...selected,
                        numCtx: Number(e.target.value),
                      })
                    }
                    onPointerUp={() => {
                      if (selected.keepAlive === '-1' && selected.modelId) {
                        save(selected)
                      }
                    }}
                  />
                </label>
                <label className="field">
                  <span>Top-p ({selected.topP.toFixed(2)})</span>
                  <input
                    type="range"
                    min={MIN_TOP_P}
                    max={MAX_TOP_P}
                    step={0.05}
                    value={selected.topP}
                    onChange={(e) =>
                      upsertModelConfig({
                        ...selected,
                        topP: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>
                    Top-k ({selected.topK === 0 ? 'off' : selected.topK})
                  </span>
                  <input
                    type="range"
                    min={MIN_TOP_K}
                    max={MAX_TOP_K}
                    step={1}
                    value={selected.topK}
                    onChange={(e) =>
                      upsertModelConfig({
                        ...selected,
                        topK: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>Keep alive</span>
                  <select
                    value={selected.keepAlive}
                    onChange={(e) => {
                      const keepAlive = e.target.value as OllamaKeepAlive
                      save({ ...selected, keepAlive })
                    }}
                  >
                    {OLLAMA_KEEPALIVE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="hint">
                  Forever keeps the model loaded in Ollama and warms it when
                  this config is saved and on page load. Changing the model
                  unloads the previous forever model first.
                </p>
                {warmStatus && <p className="hint">{warmStatus}</p>}
              </>
            )}
            {sglang && (
              <>
                <label className="field">
                  <span>
                    Top-k ({selected.sglTopK === -1 ? 'off' : selected.sglTopK})
                  </span>
                  <input
                    type="range"
                    min={MIN_SGL_TOP_K}
                    max={MAX_SGL_TOP_K}
                    step={1}
                    value={selected.sglTopK}
                    onChange={(e) =>
                      upsertModelConfig({
                        ...selected,
                        sglTopK: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>Min-p ({selected.sglMinP.toFixed(2)})</span>
                  <input
                    type="range"
                    min={MIN_SGL_MIN_P}
                    max={MAX_SGL_MIN_P}
                    step={0.01}
                    value={selected.sglMinP}
                    onChange={(e) =>
                      upsertModelConfig({
                        ...selected,
                        sglMinP: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>
                    Repetition penalty (
                    {selected.sglRepetitionPenalty.toFixed(2)})
                  </span>
                  <input
                    type="range"
                    min={MIN_SGL_REPETITION_PENALTY}
                    max={MAX_SGL_REPETITION_PENALTY}
                    step={0.05}
                    value={selected.sglRepetitionPenalty}
                    onChange={(e) =>
                      upsertModelConfig({
                        ...selected,
                        sglRepetitionPenalty: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label className="menu-check">
                  <input
                    type="checkbox"
                    checked={selected.sglEnableThinking}
                    onChange={(e) =>
                      upsertModelConfig({
                        ...selected,
                        sglEnableThinking: e.target.checked,
                      })
                    }
                  />
                  Enable thinking (chat_template_kwargs)
                </label>
                {store.activeClassifierConfigId === selected.id && (
                  <label className="menu-check">
                    <input
                      type="checkbox"
                      checked={selected.sglJsonObject}
                      onChange={(e) =>
                        upsertModelConfig({
                          ...selected,
                          sglJsonObject: e.target.checked,
                        })
                      }
                    />
                    JSON object response (classifier only)
                  </label>
                )}
                <p className="hint">
                  Thinking off is recommended for short day-chat lines. JSON
                  object mode appears when this config is the active classifier
                  and only applies to classifier routing calls.
                </p>
              </>
            )}

            <div className="btn-row">
              {!omnivoice && (
                <>
                  <button
                    type="button"
                    className={`btn${store.activeWorkConfigId === selected.id ? ' primary' : ''}`}
                    onClick={() => activateRole('work', selected)}
                  >
                    Use for chat
                  </button>
                  <button
                    type="button"
                    className={`btn${store.activeClassifierConfigId === selected.id ? ' primary' : ''}`}
                    onClick={() => activateRole('classifier', selected)}
                  >
                    Use as classifier
                  </button>
                  <button
                    type="button"
                    className={`btn${store.activeGuideConfigId === selected.id ? ' primary' : ''}`}
                    onClick={() => setActiveGuideConfigId(selected.id)}
                  >
                    Use as guide agent
                  </button>
                </>
              )}
              {speechCapable && (
                <button
                  type="button"
                  className={`btn${store.activeTtsConfigId === selected.id ? ' primary' : ''}`}
                  onClick={() => setActiveTtsConfigId(selected.id)}
                >
                  Use for TTS
                </button>
              )}
              <button
                type="button"
                className="btn danger"
                onClick={() => {
                  removeModelConfig(selected.id)
                  setSelectedId(null)
                }}
              >
                Delete
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
