import { useRef, useState } from 'react'
import {
  addProviderOfType,
  removeProvider,
  upsertProvider,
} from '../../ai/aiStore'
import { testProviderConnection } from '../../ai/client'
import { defaultBaseUrl, TRANSPORT_META } from '../../ai/defaults'
import {
  clearProviderApiKey,
  getProviderApiKey,
  hasProviderApiKey,
  setProviderApiKey,
} from '../../ai/keyStore'
import type { AiProvider, AiTransport } from '../../ai/types'
import { useAiStore } from '../../ai/useAiStore'

const TRANSPORTS = Object.keys(TRANSPORT_META) as AiTransport[]

export function AiProvidersPanel() {
  const store = useAiStore()
  const keyImportRef = useRef<HTMLInputElement | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const selected =
    store.providers.find((p) => p.id === selectedId) ?? store.providers[0] ?? null

  const select = (p: AiProvider) => {
    setSelectedId(p.id)
    setKeyDraft(getProviderApiKey(p.id) ?? '')
    setStatus(null)
  }

  const update = (patch: Partial<AiProvider>) => {
    if (!selected) return
    const next = { ...selected, ...patch }
    upsertProvider(next)
    setSelectedId(next.id)
  }

  const onImportKey = async (file: File | undefined) => {
    if (!file || !selected) return
    try {
      const text = (await file.text()).trim()
      if (!text) {
        setStatus('Key file was empty')
        return
      }
      setKeyDraft(text)
      setProviderApiKey(selected.id, text)
      setStatus('Key imported from file')
    } catch {
      setStatus('Could not read key file')
    }
  }

  return (
    <div className="settings-panel-body">
      <p className="hint">
        API keys stay in this tab’s memory only — refresh clears them. Ollama,
        SGLang, and OmniVoice local need no key — set a full base URL (e.g.
        http://127.0.0.1:11434 or http://127.0.0.1:30000/v1). Use OmniVoice (or
        OpenAI-compatible) for speech APIs, then pick the TTS model config under
        Settings → TTS. Bulk import/export lives under Settings →
        Load/Save/Reset.
      </p>

      <div className="btn-row" style={{ flexWrap: 'wrap' }}>
        {TRANSPORTS.map((t) => (
          <button
            key={t}
            type="button"
            className="btn tiny"
            onClick={() => {
              const p = addProviderOfType(t)
              select(p)
            }}
          >
            + {TRANSPORT_META[t].label}
          </button>
        ))}
      </div>

      {store.providers.length === 0 && (
        <p className="hint">No providers yet — add one above.</p>
      )}

      <div className="ai-split">
        <div className="ai-list">
          {store.providers.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`ai-list-item${selected?.id === p.id ? ' active' : ''}`}
              onClick={() => select(p)}
            >
              <strong>{p.label}</strong>
              <span className="hint">
                {TRANSPORT_META[p.transport].label}
                {p.requiresApiKey
                  ? hasProviderApiKey(p.id)
                    ? ' · key set'
                    : ' · key missing'
                  : ' · no key'}
              </span>
            </button>
          ))}
        </div>

        {selected && (
          <div className="ai-detail">
            <label className="field">
              <span>Label</span>
              <input
                value={selected.label}
                onChange={(e) => update({ label: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Base URL</span>
              <input
                value={selected.baseUrl}
                placeholder={defaultBaseUrl(selected.transport)}
                onChange={(e) => update({ baseUrl: e.target.value })}
              />
            </label>
            {selected.requiresApiKey && (
              <label className="field">
                <span>API key (memory only)</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={keyDraft}
                  placeholder="Paste key to unlock"
                  onChange={(e) => setKeyDraft(e.target.value)}
                  onBlur={() => {
                    setProviderApiKey(selected.id, keyDraft)
                    setStatus(
                      keyDraft.trim() ? 'Key stored in memory' : 'Key cleared',
                    )
                  }}
                />
              </label>
            )}
            <div className="btn-row">
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  setStatus(null)
                  setProviderApiKey(selected.id, keyDraft)
                  void testProviderConnection(selected)
                    .then((msg) => setStatus(msg))
                    .catch((err) =>
                      setStatus(
                        err instanceof Error ? err.message : 'Test failed',
                      ),
                    )
                    .finally(() => setBusy(false))
                }}
              >
                {busy ? 'Testing…' : 'Test connection'}
              </button>
              {selected.requiresApiKey && (
                <>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => keyImportRef.current?.click()}
                  >
                    Import key
                  </button>
                  <input
                    ref={keyImportRef}
                    type="file"
                    accept=".txt,text/plain"
                    className="visually-hidden"
                    tabIndex={-1}
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      e.target.value = ''
                      void onImportKey(file)
                    }}
                  />
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      clearProviderApiKey(selected.id)
                      setKeyDraft('')
                      setStatus('Key cleared')
                    }}
                  >
                    Clear key
                  </button>
                </>
              )}
              <button
                type="button"
                className="btn danger"
                onClick={() => {
                  clearProviderApiKey(selected.id)
                  removeProvider(selected.id)
                  setSelectedId(null)
                  setStatus(null)
                }}
              >
                Delete
              </button>
            </div>
            {status && <p className="hint">{status}</p>}
          </div>
        )}
      </div>
    </div>
  )
}
