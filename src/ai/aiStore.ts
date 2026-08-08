import {
  buildDefaultAiStore,
  makeDefaultProvider,
  newId,
  rewriteLocalServiceBaseUrl,
  transportRequiresApiKey,
} from './defaults'
import { clearAllProviderApiKeys } from './keyStore'
import type {
  AiModelConfig,
  AiProvider,
  AiStorePersisted,
  AiTransport,
  OllamaKeepAlive,
} from './types'
import {
  DEFAULT_NUM_CTX,
  DEFAULT_SGL_MIN_P,
  DEFAULT_SGL_REPETITION_PENALTY,
  DEFAULT_SGL_TOP_K,
  DEFAULT_TOP_K,
  DEFAULT_TOP_P,
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
  defaultOllamaSamplingFields,
  defaultSglangModelFields,
} from './types'

const STORAGE_KEY = 'onw:ai-store'
const LISTENERS_KEY = '__onwAiStoreListeners__'
const STORE_EVENT = 'onw:ai-store'

const KNOWN_TRANSPORTS: readonly AiTransport[] = [
  'ollama',
  'openai',
  'anthropic',
  'google-genai',
  'groq',
  'openai-compatible',
  'sglang',
  'omnivoice',
]

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

export function subscribeAiStore(listener: Listener): () => void {
  const listeners = getListeners()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Same-tab bridge so UI refreshes even if HMR split the listener set. */
export function subscribeAiStoreEvents(listener: Listener): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(STORE_EVENT, listener)
  return () => window.removeEventListener(STORE_EVENT, listener)
}

function normalizeProvider(raw: Partial<AiProvider>): AiProvider | null {
  if (!raw || typeof raw.id !== 'string' || !raw.id) return null
  const transport = raw.transport as AiTransport
  if (!KNOWN_TRANSPORTS.includes(transport)) {
    return null
  }
  const rawBase = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : ''
  const baseUrl = rewriteLocalServiceBaseUrl(rawBase)
  return {
    id: raw.id,
    label:
      typeof raw.label === 'string' && raw.label.trim()
        ? raw.label.trim().slice(0, 48)
        : transport,
    transport,
    baseUrl,
    requiresApiKey: transportRequiresApiKey(transport),
  }
}

const KEEP_ALIVES = new Set<OllamaKeepAlive>([
  '-1',
  '0',
  '5m',
  '30m',
  '1h',
  '2h',
])

function normalizeKeepAlive(raw: unknown): OllamaKeepAlive {
  if (typeof raw === 'string' && KEEP_ALIVES.has(raw as OllamaKeepAlive)) {
    return raw as OllamaKeepAlive
  }
  return '-1'
}

function clampNumber(
  raw: unknown,
  min: number,
  max: number,
  fallback: number,
  integer = false,
): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  const n = integer ? Math.floor(raw) : raw
  return Math.max(min, Math.min(max, n))
}

function normalizeConfig(raw: Partial<AiModelConfig>): AiModelConfig | null {
  if (!raw || typeof raw.id !== 'string' || !raw.id) return null
  if (typeof raw.providerId !== 'string' || !raw.providerId) return null
  const temperature =
    typeof raw.temperature === 'number' && Number.isFinite(raw.temperature)
      ? Math.max(0, Math.min(2, raw.temperature))
      : 0.7
  const maxTokens =
    typeof raw.maxTokens === 'number' && Number.isFinite(raw.maxTokens)
      ? Math.max(16, Math.min(8192, Math.floor(raw.maxTokens)))
      : 1024
  const numCtx =
    typeof raw.numCtx === 'number' && Number.isFinite(raw.numCtx)
      ? Math.max(MIN_NUM_CTX, Math.min(MAX_NUM_CTX, Math.floor(raw.numCtx)))
      : DEFAULT_NUM_CTX
  return {
    id: raw.id,
    label:
      typeof raw.label === 'string' && raw.label.trim()
        ? raw.label.trim().slice(0, 48)
        : 'Model',
    providerId: raw.providerId,
    modelId:
      typeof raw.modelId === 'string' ? raw.modelId.trim().slice(0, 128) : '',
    temperature,
    maxTokens,
    thinking: false,
    numCtx,
    keepAlive: normalizeKeepAlive(raw.keepAlive),
    topP: clampNumber(raw.topP, MIN_TOP_P, MAX_TOP_P, DEFAULT_TOP_P),
    topK: clampNumber(raw.topK, MIN_TOP_K, MAX_TOP_K, DEFAULT_TOP_K, true),
    sglTopK: clampNumber(
      raw.sglTopK,
      MIN_SGL_TOP_K,
      MAX_SGL_TOP_K,
      DEFAULT_SGL_TOP_K,
      true,
    ),
    sglMinP: clampNumber(
      raw.sglMinP,
      MIN_SGL_MIN_P,
      MAX_SGL_MIN_P,
      DEFAULT_SGL_MIN_P,
    ),
    sglRepetitionPenalty: clampNumber(
      raw.sglRepetitionPenalty,
      MIN_SGL_REPETITION_PENALTY,
      MAX_SGL_REPETITION_PENALTY,
      DEFAULT_SGL_REPETITION_PENALTY,
    ),
    sglEnableThinking: raw.sglEnableThinking === true,
    sglJsonObject: raw.sglJsonObject === true,
  }
}

function writeStoreQuiet(store: AiStorePersisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // ignore quota
  }
}

function readStore(): AiStorePersisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      // First visit only — seed so Settings has a usable stock stack.
      const seeded = buildDefaultAiStore()
      writeStoreQuiet(seeded)
      return seeded
    }
    const parsed = JSON.parse(raw) as Partial<AiStorePersisted>
    if (parsed.version !== 1) {
      // Unknown schema: use defaults in memory, but do not clobber disk
      // (a locked-up tab / bad migration must not wipe the user's config).
      return buildDefaultAiStore()
    }
    const providers = (parsed.providers ?? [])
      .map((p) => normalizeProvider(p))
      .filter(Boolean) as AiProvider[]
    const modelConfigs = (parsed.modelConfigs ?? [])
      .map((c) => normalizeConfig(c))
      .filter(Boolean) as AiModelConfig[]
    // Empty / wiped store → restore stock Chat, Classifier, Voice stack.
    if (providers.length === 0 && modelConfigs.length === 0) {
      const seeded = buildDefaultAiStore()
      writeStoreQuiet(seeded)
      return seeded
    }
    const providerIds = new Set(providers.map((p) => p.id))
    const configs = modelConfigs.filter((c) => providerIds.has(c.providerId))
    const configIds = new Set(configs.map((c) => c.id))
    const store: AiStorePersisted = {
      version: 1,
      providers,
      modelConfigs: configs,
      activeWorkConfigId:
        parsed.activeWorkConfigId && configIds.has(parsed.activeWorkConfigId)
          ? parsed.activeWorkConfigId
          : null,
      activeClassifierConfigId:
        parsed.activeClassifierConfigId &&
        configIds.has(parsed.activeClassifierConfigId)
          ? parsed.activeClassifierConfigId
          : null,
      activeGuideConfigId:
        parsed.activeGuideConfigId && configIds.has(parsed.activeGuideConfigId)
          ? parsed.activeGuideConfigId
          : null,
      activeTtsConfigId:
        parsed.activeTtsConfigId && configIds.has(parsed.activeTtsConfigId)
          ? parsed.activeTtsConfigId
          : null,
    }
    // Expand leftover /ollama|/omnivoice paths from older builds.
    const rawProviders = parsed.providers ?? []
    const rewritten = providers.some((p, i) => {
      const before =
        rawProviders[i] && typeof rawProviders[i] === 'object'
          ? String((rawProviders[i] as AiProvider).baseUrl ?? '')
          : ''
      return before !== p.baseUrl
    })
    if (rewritten) {
      writeStoreQuiet(store)
    }
    return store
  } catch {
    // Parse/normalize blew up — keep whatever is on disk; don't overwrite it
    // with a fresh seed (that made lockup → new-tab look like a full wipe).
    return buildDefaultAiStore()
  }
}

function writeStore(store: AiStorePersisted): void {
  writeStoreQuiet(store)
  notify()
}

export function loadAiStore(): AiStorePersisted {
  return readStore()
}

export function saveAiStore(store: AiStorePersisted): void {
  writeStore(store)
}

/** Restore stock Ollama + OmniVoice providers and Chat / Classifier / Voice configs. */
export function resetAiStore(): void {
  clearAllProviderApiKeys()
  writeStore(buildDefaultAiStore())
}

export function upsertProvider(provider: AiProvider): void {
  const store = readStore()
  const idx = store.providers.findIndex((p) => p.id === provider.id)
  const next = {
    ...provider,
    baseUrl: rewriteLocalServiceBaseUrl(provider.baseUrl),
    requiresApiKey: transportRequiresApiKey(provider.transport),
  }
  const providers =
    idx >= 0
      ? store.providers.map((p, i) => (i === idx ? next : p))
      : [...store.providers, next]
  writeStore({ ...store, providers })
}

export function removeProvider(providerId: string): void {
  const store = readStore()
  const providers = store.providers.filter((p) => p.id !== providerId)
  const modelConfigs = store.modelConfigs.filter(
    (c) => c.providerId !== providerId,
  )
  const configIds = new Set(modelConfigs.map((c) => c.id))
  writeStore({
    ...store,
    providers,
    modelConfigs,
    activeWorkConfigId:
      store.activeWorkConfigId && configIds.has(store.activeWorkConfigId)
        ? store.activeWorkConfigId
        : null,
    activeClassifierConfigId:
      store.activeClassifierConfigId &&
      configIds.has(store.activeClassifierConfigId)
        ? store.activeClassifierConfigId
        : null,
    activeGuideConfigId:
      store.activeGuideConfigId && configIds.has(store.activeGuideConfigId)
        ? store.activeGuideConfigId
        : null,
    activeTtsConfigId:
      store.activeTtsConfigId && configIds.has(store.activeTtsConfigId)
        ? store.activeTtsConfigId
        : null,
  })
}

export function upsertModelConfig(config: AiModelConfig): void {
  const store = readStore()
  const idx = store.modelConfigs.findIndex((c) => c.id === config.id)
  const modelConfigs =
    idx >= 0
      ? store.modelConfigs.map((c, i) => (i === idx ? config : c))
      : [...store.modelConfigs, config]
  writeStore({ ...store, modelConfigs })
}

export function removeModelConfig(configId: string): void {
  const store = readStore()
  writeStore({
    ...store,
    modelConfigs: store.modelConfigs.filter((c) => c.id !== configId),
    activeWorkConfigId:
      store.activeWorkConfigId === configId ? null : store.activeWorkConfigId,
    activeClassifierConfigId:
      store.activeClassifierConfigId === configId
        ? null
        : store.activeClassifierConfigId,
    activeGuideConfigId:
      store.activeGuideConfigId === configId ? null : store.activeGuideConfigId,
    activeTtsConfigId:
      store.activeTtsConfigId === configId ? null : store.activeTtsConfigId,
  })
}

export function setActiveWorkConfigId(id: string | null): void {
  const store = readStore()
  writeStore({ ...store, activeWorkConfigId: id })
}

export function setActiveClassifierConfigId(id: string | null): void {
  const store = readStore()
  writeStore({ ...store, activeClassifierConfigId: id })
}

export function setActiveGuideConfigId(id: string | null): void {
  const store = readStore()
  writeStore({ ...store, activeGuideConfigId: id })
}

export function setActiveTtsConfigId(id: string | null): void {
  const store = readStore()
  writeStore({ ...store, activeTtsConfigId: id })
}

export function addProviderOfType(transport: AiTransport): AiProvider {
  const provider = makeDefaultProvider(transport)
  upsertProvider(provider)
  return provider
}

export function addBlankModelConfig(providerId: string): AiModelConfig {
  const store = readStore()
  const provider = store.providers.find((p) => p.id === providerId)
  const isOmni = provider?.transport === 'omnivoice'
  const config: AiModelConfig = {
    id: newId('cfg'),
    label: isOmni ? 'OmniVoice' : 'New model',
    providerId,
    modelId: isOmni ? 'omnivoice' : '',
    temperature: 0.7,
    maxTokens: 1024,
    thinking: false,
    numCtx: DEFAULT_NUM_CTX,
    keepAlive: '-1',
    ...defaultOllamaSamplingFields(),
    ...defaultSglangModelFields(),
  }
  upsertModelConfig(config)
  return config
}

/** Merge imported providers by id (API keys are never included). */
export function mergeImportedProviders(raw: unknown[]): {
  imported: number
} {
  const incoming = (Array.isArray(raw) ? raw : [])
    .map((p) => normalizeProvider(p as Partial<AiProvider>))
    .filter(Boolean) as AiProvider[]
  if (incoming.length === 0) return { imported: 0 }

  const store = readStore()
  const byId = new Map(store.providers.map((p) => [p.id, p]))
  for (const p of incoming) byId.set(p.id, p)
  const providers = Array.from(byId.values())
  const providerIds = new Set(providers.map((p) => p.id))
  const modelConfigs = store.modelConfigs.filter((c) =>
    providerIds.has(c.providerId),
  )
  const configIds = new Set(modelConfigs.map((c) => c.id))
  writeStore({
    ...store,
    providers,
    modelConfigs,
    activeWorkConfigId:
      store.activeWorkConfigId && configIds.has(store.activeWorkConfigId)
        ? store.activeWorkConfigId
        : null,
    activeClassifierConfigId:
      store.activeClassifierConfigId &&
      configIds.has(store.activeClassifierConfigId)
        ? store.activeClassifierConfigId
        : null,
    activeGuideConfigId:
      store.activeGuideConfigId && configIds.has(store.activeGuideConfigId)
        ? store.activeGuideConfigId
        : null,
    activeTtsConfigId:
      store.activeTtsConfigId && configIds.has(store.activeTtsConfigId)
        ? store.activeTtsConfigId
        : null,
  })
  return { imported: incoming.length }
}

/** Merge imported model configs by id; skips configs whose provider is missing. */
export function mergeImportedModelConfigs(args: {
  modelConfigs: unknown[]
  activeWorkConfigId?: string | null
  activeClassifierConfigId?: string | null
  activeGuideConfigId?: string | null
  activeTtsConfigId?: string | null
}): { imported: number; skipped: number } {
  const store = readStore()
  const providerIds = new Set(store.providers.map((p) => p.id))
  const normalized = (Array.isArray(args.modelConfigs) ? args.modelConfigs : [])
    .map((c) => normalizeConfig(c as Partial<AiModelConfig>))
    .filter(Boolean) as AiModelConfig[]
  const accepted = normalized.filter((c) => providerIds.has(c.providerId))
  const skipped = normalized.length - accepted.length
  if (accepted.length === 0) return { imported: 0, skipped }

  const byId = new Map(store.modelConfigs.map((c) => [c.id, c]))
  for (const c of accepted) byId.set(c.id, c)
  const modelConfigs = Array.from(byId.values())
  const configIds = new Set(modelConfigs.map((c) => c.id))

  const pickActive = (id: string | null | undefined, fallback: string | null) => {
    if (id && configIds.has(id)) return id
    if (fallback && configIds.has(fallback)) return fallback
    return null
  }

  writeStore({
    ...store,
    modelConfigs,
    activeWorkConfigId: pickActive(
      args.activeWorkConfigId,
      store.activeWorkConfigId,
    ),
    activeClassifierConfigId: pickActive(
      args.activeClassifierConfigId,
      store.activeClassifierConfigId,
    ),
    activeGuideConfigId: pickActive(
      args.activeGuideConfigId,
      store.activeGuideConfigId,
    ),
    activeTtsConfigId: pickActive(
      args.activeTtsConfigId,
      store.activeTtsConfigId,
    ),
  })
  return { imported: accepted.length, skipped }
}

/**
 * One-shot merge used when migrating legacy TTS-store providers/configs
 * into the shared AI store (preserves ids so keys/settings keep working).
 */
export function mergeMigratedTtsProvidersAndConfigs(args: {
  providers: AiProvider[]
  modelConfigs: AiModelConfig[]
  activeTtsConfigId: string | null
}): void {
  if (args.providers.length === 0 && args.modelConfigs.length === 0) return
  const store = readStore()
  const byProv = new Map(store.providers.map((p) => [p.id, p]))
  for (const p of args.providers) {
    if (!byProv.has(p.id)) {
      byProv.set(p.id, {
        ...p,
        requiresApiKey: transportRequiresApiKey(p.transport),
      })
    }
  }
  const providers = Array.from(byProv.values())
  const providerIds = new Set(providers.map((p) => p.id))

  const byCfg = new Map(store.modelConfigs.map((c) => [c.id, c]))
  for (const c of args.modelConfigs) {
    if (!providerIds.has(c.providerId)) continue
    if (!byCfg.has(c.id)) byCfg.set(c.id, c)
  }
  const modelConfigs = Array.from(byCfg.values())
  const configIds = new Set(modelConfigs.map((c) => c.id))

  writeStore({
    ...store,
    providers,
    modelConfigs,
    activeWorkConfigId:
      store.activeWorkConfigId && configIds.has(store.activeWorkConfigId)
        ? store.activeWorkConfigId
        : null,
    activeClassifierConfigId:
      store.activeClassifierConfigId &&
      configIds.has(store.activeClassifierConfigId)
        ? store.activeClassifierConfigId
        : null,
    activeGuideConfigId:
      store.activeGuideConfigId && configIds.has(store.activeGuideConfigId)
        ? store.activeGuideConfigId
        : null,
    activeTtsConfigId:
      (args.activeTtsConfigId && configIds.has(args.activeTtsConfigId)
        ? args.activeTtsConfigId
        : null) ??
      (store.activeTtsConfigId && configIds.has(store.activeTtsConfigId)
        ? store.activeTtsConfigId
        : null),
  })
}
