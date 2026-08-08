import type {
  AiModelConfig,
  AiProvider,
  AiStorePersisted,
  AiTransport,
} from './types'
import {
  DEFAULT_CHAT_CONFIG_ID,
  DEFAULT_CHAT_NUM_CTX,
  DEFAULT_CLASSIFIER_CONFIG_ID,
  DEFAULT_CLASSIFIER_NUM_CTX,
  DEFAULT_NUM_CTX,
  DEFAULT_OLLAMA_PROVIDER_ID,
  DEFAULT_OMNIVOICE_PROVIDER_ID,
  DEFAULT_VOICE_CONFIG_ID,
  defaultOllamaSamplingFields,
  defaultSglangModelFields,
} from './types'

/** Default Ollama base URL (no proxy — type any reachable host). */
export const DEFAULT_OLLAMA_BASE = 'http://127.0.0.1:11434'
export const OLLAMA_DIRECT_BASE = DEFAULT_OLLAMA_BASE

/** Default SGLang OpenAI-compatible base (…/v1). */
export const DEFAULT_SGLANG_BASE = 'http://127.0.0.1:30000/v1'
export const SGLANG_DIRECT_BASE = DEFAULT_SGLANG_BASE

/** Default OmniVoice OpenAI-compatible base (…/v1). */
export const DEFAULT_OMNIVOICE_BASE = 'http://127.0.0.1:8880/v1'
export const OMNIVOICE_DIRECT_BASE = DEFAULT_OMNIVOICE_BASE

export function defaultOllamaBaseUrl(): string {
  return DEFAULT_OLLAMA_BASE
}

export function defaultSglangBaseUrl(): string {
  return DEFAULT_SGLANG_BASE
}

export function defaultOmniVoiceBaseUrl(): string {
  return DEFAULT_OMNIVOICE_BASE
}

/** Trim; also expand leftover Vite proxy paths from older builds. */
export function rewriteLocalServiceBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (trimmed === '/ollama' || trimmed.startsWith('/ollama/')) {
    const path = trimmed === '/ollama' ? '' : trimmed.slice('/ollama'.length)
    return `${DEFAULT_OLLAMA_BASE}${path}`
  }
  if (trimmed === '/sglang' || trimmed.startsWith('/sglang/')) {
    const path =
      trimmed === '/sglang' || trimmed === '/sglang/'
        ? '/v1'
        : trimmed.slice('/sglang'.length)
    return `http://127.0.0.1:30000${path === '' ? '/v1' : path}`
  }
  if (trimmed === '/omnivoice' || trimmed.startsWith('/omnivoice/')) {
    const path =
      trimmed === '/omnivoice' || trimmed === '/omnivoice/'
        ? '/v1'
        : trimmed.slice('/omnivoice'.length)
    return `http://127.0.0.1:8880${path === '' ? '/v1' : path}`
  }
  return baseUrl.trim()
}

export const TRANSPORT_META: Record<
  AiTransport,
  { label: string; defaultBaseUrl: string; requiresApiKey: boolean }
> = {
  ollama: {
    label: 'Ollama (local)',
    defaultBaseUrl: DEFAULT_OLLAMA_BASE,
    requiresApiKey: false,
  },
  openai: {
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
  },
  anthropic: {
    label: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    requiresApiKey: true,
  },
  'google-genai': {
    label: 'Google GenAI',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    requiresApiKey: true,
  },
  groq: {
    label: 'Groq',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    requiresApiKey: true,
  },
  'openai-compatible': {
    label: 'OpenAI-compatible',
    defaultBaseUrl: '',
    requiresApiKey: true,
  },
  sglang: {
    label: 'SGLang (local)',
    defaultBaseUrl: DEFAULT_SGLANG_BASE,
    requiresApiKey: false,
  },
  omnivoice: {
    label: 'OmniVoice (local)',
    defaultBaseUrl: DEFAULT_OMNIVOICE_BASE,
    requiresApiKey: false,
  },
}

export function defaultBaseUrl(transport: AiTransport): string {
  return TRANSPORT_META[transport].defaultBaseUrl
}

export function transportRequiresApiKey(transport: AiTransport): boolean {
  return TRANSPORT_META[transport].requiresApiKey
}

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

export function makeDefaultProvider(transport: AiTransport): AiProvider {
  const meta = TRANSPORT_META[transport]
  return {
    id: newId('prov'),
    label: meta.label,
    transport,
    baseUrl: meta.defaultBaseUrl,
    requiresApiKey: meta.requiresApiKey,
  }
}

/**
 * Stock AI stack: Ollama + OmniVoice providers, and Chat / Classifier / Voice
 * model configs. Chat uses 8k num_ctx; classifier uses 2k. Model ids are left
 * empty for Ollama so the user picks from the local list.
 */
export function buildDefaultAiStore(): AiStorePersisted {
  const ollama: AiProvider = {
    id: DEFAULT_OLLAMA_PROVIDER_ID,
    label: TRANSPORT_META.ollama.label,
    transport: 'ollama',
    baseUrl: DEFAULT_OLLAMA_BASE,
    requiresApiKey: false,
  }
  const omnivoice: AiProvider = {
    id: DEFAULT_OMNIVOICE_PROVIDER_ID,
    label: TRANSPORT_META.omnivoice.label,
    transport: 'omnivoice',
    baseUrl: DEFAULT_OMNIVOICE_BASE,
    requiresApiKey: false,
  }

  const sgl = defaultSglangModelFields()
  const ollamaSampling = defaultOllamaSamplingFields()
  const chat: AiModelConfig = {
    id: DEFAULT_CHAT_CONFIG_ID,
    label: 'Chat',
    providerId: ollama.id,
    modelId: '',
    temperature: 0.7,
    maxTokens: 1024,
    thinking: false,
    numCtx: DEFAULT_CHAT_NUM_CTX,
    keepAlive: '-1',
    ...ollamaSampling,
    ...sgl,
  }
  const classifier: AiModelConfig = {
    id: DEFAULT_CLASSIFIER_CONFIG_ID,
    label: 'Classifier',
    providerId: ollama.id,
    modelId: '',
    temperature: 0.2,
    maxTokens: 512,
    thinking: false,
    numCtx: DEFAULT_CLASSIFIER_NUM_CTX,
    keepAlive: '-1',
    ...ollamaSampling,
    ...sgl,
  }
  const voice: AiModelConfig = {
    id: DEFAULT_VOICE_CONFIG_ID,
    label: 'Voice',
    providerId: omnivoice.id,
    modelId: 'omnivoice',
    temperature: 0.7,
    maxTokens: 1024,
    thinking: false,
    numCtx: DEFAULT_NUM_CTX,
    keepAlive: '-1',
    ...ollamaSampling,
    ...sgl,
  }

  return {
    version: 1,
    providers: [ollama, omnivoice],
    modelConfigs: [chat, classifier, voice],
    activeWorkConfigId: chat.id,
    activeClassifierConfigId: classifier.id,
    activeGuideConfigId: chat.id,
    activeTtsConfigId: voice.id,
  }
}
