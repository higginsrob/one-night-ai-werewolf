import { getProviderApiKey } from '../ai/keyStore'
import {
  isOmniVoiceEndpoint,
  resolveActiveTtsEndpoint,
  setDesignVoiceInstructMap,
  setTtsApiCapabilities,
} from './ttsStore'
import type { ApiVoice, ApiVoiceCatalog } from './ttsTypes'

function authHeaders(providerId: string, requiresApiKey: boolean): Record<string, string> {
  const headers: Record<string, string> = {}
  if (requiresApiKey) {
    const key = getProviderApiKey(providerId)
    if (key) headers.Authorization = `Bearer ${key}`
  }
  return headers
}

/** Strip trailing /v1 to get service root for /health and /v1/voices. */
export function serviceRootFromBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (trimmed.endsWith('/v1')) return trimmed.slice(0, -3) || trimmed
  return trimmed
}

function markOmniVoice(detected: boolean): void {
  setTtsApiCapabilities({ omnivoice: detected })
}

function looksLikeOmniHealth(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const o = data as Record<string, unknown>
  if (typeof o.modelId === 'string' && /omnivoice/i.test(o.modelId)) return true
  // Our OmniVoice /health shape
  return (
    typeof o.device === 'string' &&
    typeof o.modelLoaded === 'boolean' &&
    typeof o.voiceCount === 'number'
  )
}

function epLooksOmni(
  ep: NonNullable<ReturnType<typeof resolveActiveTtsEndpoint>>,
): boolean {
  return (
    ep.transport === 'omnivoice' ||
    ep.modelId.toLowerCase().includes('omnivoice')
  )
}

export async function testTtsConnection(): Promise<{
  ok: boolean
  detail: string
}> {
  const ep = resolveActiveTtsEndpoint()
  if (!ep) return { ok: false, detail: 'No active TTS model config' }
  const root = serviceRootFromBaseUrl(ep.baseUrl)
  try {
    const healthUrl = `${root}/health`
    const res = await fetch(healthUrl, {
      headers: authHeaders(ep.providerId, ep.requiresApiKey),
    })
    if (res.ok) {
      const data = (await res.json()) as {
        device?: string
        modelLoaded?: boolean
        modelId?: string
      }
      markOmniVoice(
        looksLikeOmniHealth(data) || epLooksOmni(ep),
      )
      return {
        ok: true,
        detail: `OK · device=${data.device ?? '?'} · loaded=${String(data.modelLoaded)}`,
      }
    }
    // Fall back to OpenAI-shaped /v1/models
    const modelsRes = await fetch(`${ep.baseUrl}/models`, {
      headers: authHeaders(ep.providerId, ep.requiresApiKey),
    })
    if (!modelsRes.ok) {
      markOmniVoice(false)
      return {
        ok: false,
        detail: `HTTP ${res.status} (health) / ${modelsRes.status} (models)`,
      }
    }
    const models = (await modelsRes.json()) as {
      data?: { id?: string }[]
    }
    const ids = Array.isArray(models.data)
      ? models.data.map((m) => String(m.id ?? '').toLowerCase())
      : []
    const omni =
      ids.some((id) => id.includes('omnivoice')) || epLooksOmni(ep)
    markOmniVoice(omni)
    return { ok: true, detail: 'OK · /v1/models' }
  } catch (e) {
    return { ok: false, detail: friendlySpeechError(e) }
  }
}

export async function listApiVoices(): Promise<ApiVoice[]> {
  const catalog = await listApiVoiceCatalog()
  return [...catalog.presets]
}

export async function listApiVoiceCatalog(): Promise<ApiVoiceCatalog> {
  const ep = resolveActiveTtsEndpoint()
  if (!ep) return { presets: [] }
  const root = serviceRootFromBaseUrl(ep.baseUrl)
  const res = await fetch(`${root}/v1/voices`, {
    headers: authHeaders(ep.providerId, ep.requiresApiKey),
  })
  if (!res.ok) {
    throw new Error(`List voices failed: HTTP ${res.status}`)
  }
  const data = (await res.json()) as {
    data?: ApiVoice[]
    presets?: ApiVoice[]
  }
  const presets = (Array.isArray(data.presets) ? data.presets : []).map(
    (v) => ({
      ...v,
      kind: 'design' as const,
    }),
  )
  const omniFromPresets =
    presets.length > 0 &&
    presets.some((p) => typeof p.instruct === 'string' && p.instruct.trim())
  markOmniVoice(
    omniFromPresets || epLooksOmni(ep) || isOmniVoiceEndpoint(),
  )
  setDesignVoiceInstructMap(presets)
  return { presets }
}

export class SpeechFetchAborted extends Error {
  constructor(message = 'canceled') {
    super(message)
    this.name = 'SpeechFetchAborted'
  }
}

export function isSpeechFetchAborted(e: unknown): boolean {
  if (e instanceof SpeechFetchAborted) return true
  if (e instanceof DOMException && e.name === 'AbortError') return true
  if (e instanceof Error && e.name === 'AbortError') return true
  return false
}

/** Map raw fetch/network failures to a user-visible TTS message. */
export function friendlySpeechError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (
    e instanceof TypeError ||
    /failed to fetch|networkerror|load failed|network request failed|err_connection/i.test(
      msg,
    )
  ) {
    return 'TTS server unreachable — is OmniVoice running?'
  }
  return msg
}

export async function fetchSpeechAudio(opts: {
  text: string
  voice?: string | null
  speed?: number
  instruct?: string | null
  /** Prior chunk WAV to lock OmniVoice design timbre across chunks. */
  refAudio?: Blob | null
  refText?: string | null
  signal?: AbortSignal
}): Promise<Blob> {
  const ep = resolveActiveTtsEndpoint()
  if (!ep) throw new Error('No active TTS model config')
  if (opts.signal?.aborted) throw new SpeechFetchAborted()
  try {
    const body: Record<string, unknown> = {
      model: ep.modelId,
      input: opts.text,
      voice: opts.voice?.trim() || 'auto',
      response_format: 'wav',
    }
    if (typeof opts.speed === 'number' && Number.isFinite(opts.speed)) {
      body.speed = opts.speed
    }
    if (opts.instruct?.trim()) {
      body.instruct = opts.instruct.trim()
    }
    if (opts.refAudio && opts.refAudio.size > 0) {
      body.ref_audio_b64 = await blobToBase64(opts.refAudio)
      if (opts.refText?.trim()) body.ref_text = opts.refText.trim()
    }
    const res = await fetch(`${ep.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(ep.providerId, ep.requiresApiKey),
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(text || `Speech failed: HTTP ${res.status}`)
    }
    const buf = await res.arrayBuffer()
    return new Blob([buf], { type: 'audio/wav' })
  } catch (e) {
    if (isSpeechFetchAborted(e)) throw new SpeechFetchAborted()
    throw new Error(friendlySpeechError(e))
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const chunk = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
