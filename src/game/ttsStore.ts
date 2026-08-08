import {
  defaultOmniVoiceBaseUrl,
  defaultBaseUrl,
  rewriteLocalServiceBaseUrl,
} from '../ai/defaults'
import {
  loadAiStore,
  mergeMigratedTtsProvidersAndConfigs,
} from '../ai/aiStore'
import type { AiModelConfig, AiProvider } from '../ai/types'
import { defaultOllamaSamplingFields, defaultSglangModelFields } from '../ai/types'
import { isSpeechCapableTransport } from '../ai/types'
import type { VoiceAccent, VoiceAge, VoiceGender } from './omniVoiceSpeech'
import {
  type TtsApiCapabilities,
  type TtsEngine,
  type TtsStorePersisted,
  clampApiMaxSentencesPerChunk,
  DEFAULT_MAX_SENTENCES_PER_CHUNK,
} from './ttsTypes'

const STORAGE_KEY = 'onw:tts-store'
const LISTENERS_KEY = '__onwTtsStoreListeners__'
const STORE_EVENT = 'onw:tts-store'

const NARRATOR_VOICE_AGES = new Set([
  'teenager',
  'young adult',
  'middle-aged',
  'elderly',
])
const NARRATOR_VOICE_GENDERS = new Set(['male', 'female'])
const NARRATOR_VOICE_ACCENTS = new Set([
  'american',
  'british',
  'australian',
  'canadian',
  'indian',
  'chinese',
  'korean',
  'japanese',
])

function normalizeNarratorVoiceAge(raw: unknown): VoiceAge {
  if (typeof raw !== 'string') return ''
  const v = raw.trim().toLowerCase()
  return NARRATOR_VOICE_AGES.has(v) ? (v as VoiceAge) : ''
}

function normalizeNarratorVoiceGender(raw: unknown): VoiceGender {
  if (typeof raw !== 'string') return ''
  const v = raw.trim().toLowerCase()
  return NARRATOR_VOICE_GENDERS.has(v) ? (v as VoiceGender) : ''
}

function normalizeNarratorVoiceAccent(raw: unknown): VoiceAccent {
  if (typeof raw !== 'string') return ''
  let v = raw.trim().toLowerCase()
  if (v.endsWith(' accent')) v = v.slice(0, -' accent'.length)
  return NARRATOR_VOICE_ACCENTS.has(v) ? (v as VoiceAccent) : ''
}

/** Default OmniVoice design for the narrator. */
const DEFAULT_NARRATOR_VOICE_AGE: VoiceAge = 'elderly'
const DEFAULT_NARRATOR_VOICE_GENDER: VoiceGender = 'male'
const DEFAULT_NARRATOR_VOICE_ACCENT: VoiceAccent = 'indian'

function defaultStore(): TtsStorePersisted {
  return {
    version: 3,
    ttsEnabled: true,
    engine: 'browser',
    narratorApiVoiceId: null,
    narratorVoiceAge: DEFAULT_NARRATOR_VOICE_AGE,
    narratorVoiceGender: DEFAULT_NARRATOR_VOICE_GENDER,
    narratorVoiceAccent: DEFAULT_NARRATOR_VOICE_ACCENT,
    apiMaxSentencesPerChunk: DEFAULT_MAX_SENTENCES_PER_CHUNK,
  }
}

type Listener = () => void

function getListeners(): Set<Listener> {
  const g = globalThis as typeof globalThis & {
    [LISTENERS_KEY]?: Set<Listener>
  }
  if (!g[LISTENERS_KEY]) g[LISTENERS_KEY] = new Set()
  return g[LISTENERS_KEY]
}

function notify() {
  for (const l of getListeners()) l()
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(STORE_EVENT))
  }
}

export function subscribeTtsStore(listener: Listener): () => void {
  const listeners = getListeners()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function subscribeTtsStoreEvents(listener: Listener): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(STORE_EVENT, listener)
  return () => window.removeEventListener(STORE_EVENT, listener)
}

function looksLikeOmniVoice(baseUrl: string, modelId: string): boolean {
  const url = baseUrl.toLowerCase()
  const model = modelId.toLowerCase()
  return (
    model.includes('omnivoice') ||
    url.includes('8880') ||
    url.includes('/omnivoice') ||
    url.includes('omnivoice')
  )
}

/** Migrate legacy v1 TTS providers/configs into the shared AI store once. */
function migrateLegacyV1(parsed: {
  providers?: unknown[]
  modelConfigs?: unknown[]
  activeConfigId?: string | null
  ttsEnabled?: boolean
  engine?: string
  narratorApiVoiceId?: string | null
}): TtsStorePersisted {
  const legacyProviders = Array.isArray(parsed.providers) ? parsed.providers : []
  const legacyConfigs = Array.isArray(parsed.modelConfigs)
    ? parsed.modelConfigs
    : []

  const providers: AiProvider[] = []
  for (const raw of legacyProviders) {
    if (!raw || typeof raw !== 'object') continue
    const p = raw as {
      id?: string
      label?: string
      baseUrl?: string
      requiresApiKey?: boolean
    }
    if (typeof p.id !== 'string' || !p.id) continue
    const baseUrl = rewriteLocalServiceBaseUrl(
      typeof p.baseUrl === 'string' && p.baseUrl.trim()
        ? p.baseUrl.trim()
        : defaultOmniVoiceBaseUrl(),
    )
    const omni = looksLikeOmniVoice(baseUrl, '')
    providers.push({
      id: p.id,
      label:
        typeof p.label === 'string' && p.label.trim()
          ? p.label.trim().slice(0, 48)
          : omni
            ? 'OmniVoice (local)'
            : 'Speech API',
      transport: omni ? 'omnivoice' : 'openai-compatible',
      baseUrl,
      requiresApiKey: omni ? false : Boolean(p.requiresApiKey),
    })
  }

  const modelConfigs: AiModelConfig[] = []
  for (const raw of legacyConfigs) {
    if (!raw || typeof raw !== 'object') continue
    const c = raw as {
      id?: string
      label?: string
      providerId?: string
      modelId?: string
    }
    if (typeof c.id !== 'string' || !c.id) continue
    if (typeof c.providerId !== 'string' || !c.providerId) continue
    const modelId =
      typeof c.modelId === 'string' ? c.modelId.trim().slice(0, 128) : 'omnivoice'
    const provider = providers.find((p) => p.id === c.providerId)
    if (
      provider &&
      looksLikeOmniVoice(provider.baseUrl, modelId) &&
      provider.transport !== 'omnivoice'
    ) {
      provider.transport = 'omnivoice'
      provider.requiresApiKey = false
      if (!provider.baseUrl) provider.baseUrl = defaultOmniVoiceBaseUrl()
    }
    modelConfigs.push({
      id: c.id,
      label:
        typeof c.label === 'string' && c.label.trim()
          ? c.label.trim().slice(0, 48)
          : 'Speech model',
      providerId: c.providerId,
      modelId: modelId || 'omnivoice',
      temperature: 0.7,
      maxTokens: 1024,
      thinking: false,
      numCtx: 4096,
      keepAlive: '-1',
      ...defaultOllamaSamplingFields(),
      ...defaultSglangModelFields(),
    })
  }

  mergeMigratedTtsProvidersAndConfigs({
    providers,
    modelConfigs,
    activeTtsConfigId:
      typeof parsed.activeConfigId === 'string' ? parsed.activeConfigId : null,
  })

  let engine: TtsEngine = 'browser'
  if (parsed.engine === 'api' || parsed.engine === 'browser') {
    engine = parsed.engine
  }

  return {
    version: 3,
    ttsEnabled:
      typeof parsed.ttsEnabled === 'boolean' ? parsed.ttsEnabled : true,
    engine,
    narratorApiVoiceId:
      typeof parsed.narratorApiVoiceId === 'string' &&
      parsed.narratorApiVoiceId.trim()
        ? parsed.narratorApiVoiceId.trim().slice(0, 80)
        : null,
    narratorVoiceAge: DEFAULT_NARRATOR_VOICE_AGE,
    narratorVoiceGender: DEFAULT_NARRATOR_VOICE_GENDER,
    narratorVoiceAccent: DEFAULT_NARRATOR_VOICE_ACCENT,
    apiMaxSentencesPerChunk: DEFAULT_MAX_SENTENCES_PER_CHUNK,
  }
}

function normalizeV3Fields(parsed: {
  version?: number
  ttsEnabled?: boolean
  engine?: string
  narratorApiVoiceId?: string | null
  narratorVoiceAge?: string
  narratorVoiceGender?: string
  narratorVoiceAccent?: string
  apiMaxSentencesPerChunk?: number
}): TtsStorePersisted {
  let engine: TtsEngine = 'browser'
  if (parsed.engine === 'api' || parsed.engine === 'browser') {
    engine = parsed.engine
  }
  let sentences = clampApiMaxSentencesPerChunk(parsed.apiMaxSentencesPerChunk)
  // v2 briefly defaulted to 4 sentences, which crackles on OmniVoice design.
  if (parsed.version === 2 && parsed.apiMaxSentencesPerChunk === 4) {
    sentences = DEFAULT_MAX_SENTENCES_PER_CHUNK
  }
  return {
    version: 3,
    ttsEnabled:
      typeof parsed.ttsEnabled === 'boolean' ? parsed.ttsEnabled : true,
    engine,
    narratorApiVoiceId:
      typeof parsed.narratorApiVoiceId === 'string' &&
      parsed.narratorApiVoiceId.trim()
        ? parsed.narratorApiVoiceId.trim().slice(0, 80)
        : null,
    // Empty design fields → stock OmniVoice narrator defaults.
    narratorVoiceAge:
      normalizeNarratorVoiceAge(parsed.narratorVoiceAge) ||
      DEFAULT_NARRATOR_VOICE_AGE,
    narratorVoiceGender:
      normalizeNarratorVoiceGender(parsed.narratorVoiceGender) ||
      DEFAULT_NARRATOR_VOICE_GENDER,
    narratorVoiceAccent:
      normalizeNarratorVoiceAccent(parsed.narratorVoiceAccent) ||
      DEFAULT_NARRATOR_VOICE_ACCENT,
    apiMaxSentencesPerChunk: sentences,
  }
}

function readStore(): TtsStorePersisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      const seeded = defaultStore()
      writeStoreQuiet(seeded)
      return seeded
    }
    const parsed = JSON.parse(raw) as {
      version?: number
      providers?: unknown[]
      modelConfigs?: unknown[]
      activeConfigId?: string | null
      ttsEnabled?: boolean
      engine?: string
      narratorApiVoiceId?: string | null
      narratorVoiceAge?: string
      narratorVoiceGender?: string
      narratorVoiceAccent?: string
      apiMaxSentencesPerChunk?: number
    }
    const version = parsed.version

    if (version === 1) {
      const migrated = migrateLegacyV1(parsed)
      writeStoreQuiet(migrated)
      return migrated
    }

    if (version === 2 || version === 3) {
      const normalized = normalizeV3Fields(parsed)
      const narratorWasEmpty =
        !normalizeNarratorVoiceAge(parsed.narratorVoiceAge) &&
        !normalizeNarratorVoiceGender(parsed.narratorVoiceGender) &&
        !normalizeNarratorVoiceAccent(parsed.narratorVoiceAccent)
      if (version !== 3 || narratorWasEmpty) {
        writeStoreQuiet(normalized)
      }
      return normalized
    }

    // Unknown schema: in-memory defaults only — do not clobber disk.
    return defaultStore()
  } catch {
    // Keep whatever is on disk; do not overwrite with a seed.
    return defaultStore()
  }
}

function writeStoreQuiet(store: TtsStorePersisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // ignore
  }
}

function writeStore(store: TtsStorePersisted): void {
  writeStoreQuiet(store)
  notify()
}

export function loadTtsStore(): TtsStorePersisted {
  return readStore()
}

export function saveTtsStore(store: TtsStorePersisted): void {
  writeStore(store)
}

export function patchTtsStore(patch: Partial<TtsStorePersisted>): void {
  const next = { ...readStore(), ...patch, version: 3 as const }
  if ('apiMaxSentencesPerChunk' in patch) {
    next.apiMaxSentencesPerChunk = clampApiMaxSentencesPerChunk(
      next.apiMaxSentencesPerChunk,
    )
  }
  writeStore(next)
}

/** Restore TTS preferences to built-in defaults. */
export function resetTtsStore(): void {
  writeStore(defaultStore())
}

export function resolveActiveTtsEndpoint(): {
  baseUrl: string
  modelId: string
  providerId: string
  requiresApiKey: boolean
  transport: AiProvider['transport']
} | null {
  // Ensure any legacy onw:tts-store v1 providers were merged into the AI store.
  readStore()
  const ai = loadAiStore()
  if (!ai.activeTtsConfigId) return null
  const config = ai.modelConfigs.find((c) => c.id === ai.activeTtsConfigId)
  if (!config) return null
  const provider = ai.providers.find((p) => p.id === config.providerId)
  if (!provider || !isSpeechCapableTransport(provider.transport)) return null
  let baseUrl = rewriteLocalServiceBaseUrl(
    provider.baseUrl.trim() || defaultBaseUrl(provider.transport),
  ).replace(/\/+$/, '')
  if (!baseUrl) {
    baseUrl = defaultBaseUrl(provider.transport).replace(/\/+$/, '')
  }
  if (!baseUrl) return null
  return {
    baseUrl,
    modelId: config.modelId || 'omnivoice',
    providerId: provider.id,
    requiresApiKey: provider.requiresApiKey,
    transport: provider.transport,
  }
}

/** In-memory only — refreshed by connection / voice catalog probes. */
let apiCapabilities: TtsApiCapabilities | null = null

/** Design preset id → instruct (from last voice catalog fetch). */
let designInstructById = new Map<string, string>()

export function getTtsApiCapabilities(): TtsApiCapabilities | null {
  return apiCapabilities
}

export function setTtsApiCapabilities(
  caps: Omit<TtsApiCapabilities, 'checkedAt'> & { checkedAt?: number },
): void {
  apiCapabilities = {
    omnivoice: Boolean(caps.omnivoice),
    checkedAt: caps.checkedAt ?? Date.now(),
  }
  notify()
}

export function setDesignVoiceInstructMap(
  entries: { id: string; instruct?: string }[],
): void {
  const next = new Map<string, string>()
  for (const e of entries) {
    if (e.id && e.instruct?.trim()) next.set(e.id, e.instruct.trim())
  }
  designInstructById = next
}

export function getDesignVoiceInstruct(
  voiceId: string | null | undefined,
): string | null {
  if (!voiceId?.trim()) return null
  return designInstructById.get(voiceId.trim()) ?? null
}

export function isDesignVoiceId(voiceId: string | null | undefined): boolean {
  if (!voiceId?.trim() || voiceId === 'auto') return true
  return designInstructById.has(voiceId.trim())
}

/** True when the active speech API looks like OmniVoice. */
export function isOmniVoiceEndpoint(): boolean {
  if (apiCapabilities?.omnivoice) return true
  const ep = resolveActiveTtsEndpoint()
  if (!ep) return false
  if (ep.transport === 'omnivoice') return true
  return ep.modelId.toLowerCase().includes('omnivoice')
}
