import { defaultBaseUrl } from './defaults'
import { getProviderApiKey } from './keyStore'
import type { AiModelConfig, AiProvider, AiTransport } from './types'

/** Rough token estimate when the provider doesn't return usage. */
export function estimateTokens(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return Math.max(1, Math.ceil(trimmed.length / 4))
}

export function estimateMessagesTokens(
  messages: { content: string }[],
): number {
  let n = 0
  for (const m of messages) n += estimateTokens(m.content) + 4
  return n
}

type CacheEntry = { limit: number; at: number }

const CACHE_TTL_MS = 30 * 60 * 1000
const limitCache = new Map<string, CacheEntry>()
/** providerId → modelId → context_window from last /models fetch */
const providerModelWindows = new Map<string, Map<string, number>>()

function cacheKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`
}

function resolveBaseUrl(provider: AiProvider): string {
  let trimmed = provider.baseUrl.trim().replace(/\/+$/, '')
  if (!trimmed) {
    trimmed = defaultBaseUrl(provider.transport).replace(/\/+$/, '')
  }
  if (provider.transport === 'anthropic') {
    trimmed = trimmed.replace(/\/v1$/i, '')
  }
  return trimmed
}

/**
 * Best-effort known context windows when the API doesn't expose one.
 * Keys are lowercase substrings matched against model id (longest wins).
 */
const KNOWN_CONTEXT_WINDOWS: { match: string; limit: number }[] = [
  { match: 'gpt-4.1', limit: 1_047_576 },
  { match: 'gpt-4o-mini', limit: 128_000 },
  { match: 'gpt-4o', limit: 128_000 },
  { match: 'gpt-4-turbo', limit: 128_000 },
  { match: 'gpt-4', limit: 8192 },
  { match: 'gpt-3.5', limit: 16_385 },
  { match: 'o1-mini', limit: 128_000 },
  { match: 'o1-pro', limit: 200_000 },
  { match: 'o1', limit: 200_000 },
  { match: 'o3-mini', limit: 200_000 },
  { match: 'o3', limit: 200_000 },
  { match: 'o4-mini', limit: 200_000 },
  { match: 'chatgpt-4o', limit: 128_000 },
  { match: 'claude-opus-4', limit: 200_000 },
  { match: 'claude-sonnet-4', limit: 200_000 },
  { match: 'claude-haiku-4', limit: 200_000 },
  { match: 'claude-3-7', limit: 200_000 },
  { match: 'claude-3-5', limit: 200_000 },
  { match: 'claude-3-opus', limit: 200_000 },
  { match: 'claude-3-sonnet', limit: 200_000 },
  { match: 'claude-3-haiku', limit: 200_000 },
  { match: 'gemini-2.5', limit: 1_048_576 },
  { match: 'gemini-2.0', limit: 1_048_576 },
  { match: 'gemini-1.5-pro', limit: 2_000_000 },
  { match: 'gemini-1.5-flash', limit: 1_000_000 },
  { match: 'gemini-pro', limit: 32_768 },
  { match: 'llama-3.1-8b', limit: 131_072 },
  { match: 'llama-3.3-70b', limit: 131_072 },
  { match: 'llama-3.1-70b', limit: 131_072 },
  { match: 'llama-3.1-405b', limit: 131_072 },
  { match: 'llama3-70b', limit: 8192 },
  { match: 'llama3-8b', limit: 8192 },
  { match: 'gpt-oss-120b', limit: 131_072 },
  { match: 'gpt-oss-20b', limit: 131_072 },
  { match: 'qwen3', limit: 131_072 },
  { match: 'qwen2.5', limit: 131_072 },
  { match: 'mixtral-8x7b', limit: 32_768 },
  { match: 'gemma2-9b', limit: 8192 },
  { match: 'deepseek-r1', limit: 131_072 },
]

function knownContextWindow(modelId: string): number | null {
  const m = modelId.toLowerCase()
  let best: { match: string; limit: number } | null = null
  for (const row of KNOWN_CONTEXT_WINDOWS) {
    if (!m.includes(row.match)) continue
    if (!best || row.match.length > best.match.length) best = row
  }
  return best?.limit ?? null
}

function readNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      return Math.floor(v)
    }
  }
  return null
}

function ingestOpenaiCompatModels(
  providerId: string,
  data: {
    data?: {
      id?: string
      context_window?: number
      context_length?: number
      max_model_len?: number
      max_tokens?: number
    }[]
  },
): void {
  const map = new Map<string, number>()
  for (const m of data.data ?? []) {
    const id = m.id?.trim()
    if (!id) continue
    const limit = readNumber(
      m.context_window,
      m.context_length,
      m.max_model_len,
      // Some gateways put context in max_tokens on the model object.
      m.max_tokens && m.max_tokens >= 2048 ? m.max_tokens : null,
    )
    if (limit) map.set(id, limit)
  }
  if (map.size > 0) providerModelWindows.set(providerId, map)
}

async function fetchOpenaiCompatWindows(
  provider: AiProvider,
): Promise<Map<string, number>> {
  const cached = providerModelWindows.get(provider.id)
  if (cached && cached.size > 0) return cached

  const base = resolveBaseUrl(provider)
  const key = provider.requiresApiKey ? getProviderApiKey(provider.id) : null
  const headers: Record<string, string> = {}
  if (key) headers.Authorization = `Bearer ${key}`
  const res = await fetch(`${base}/models`, { headers })
  if (!res.ok) return cached ?? new Map()
  const data = (await res.json()) as Parameters<typeof ingestOpenaiCompatModels>[1]
  ingestOpenaiCompatModels(provider.id, data)
  return providerModelWindows.get(provider.id) ?? new Map()
}

async function fetchGoogleWindow(
  provider: AiProvider,
  modelId: string,
): Promise<number | null> {
  const base = resolveBaseUrl(provider)
  const key = getProviderApiKey(provider.id)
  if (!key) return null
  const id = modelId.replace(/^models\//, '')
  const res = await fetch(
    `${base}/models/${encodeURIComponent(id)}?key=${encodeURIComponent(key)}`,
  )
  if (!res.ok) return null
  const data = (await res.json()) as {
    inputTokenLimit?: number
    input_token_limit?: number
  }
  return readNumber(data.inputTokenLimit, data.input_token_limit)
}

async function fetchAnthropicWindow(
  provider: AiProvider,
  modelId: string,
): Promise<number | null> {
  const base = resolveBaseUrl(provider)
  const key = getProviderApiKey(provider.id)
  if (!key) return null
  try {
    const res = await fetch(`${base}/v1/models/${encodeURIComponent(modelId)}`, {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      max_input_tokens?: number
      context_window?: number
      context_length?: number
    }
    return readNumber(
      data.max_input_tokens,
      data.context_window,
      data.context_length,
    )
  } catch {
    return null
  }
}

/**
 * Effective context window for a model config.
 * Ollama uses the configured num_ctx; cloud transports query /models when possible.
 */
export async function resolveContextLimit(
  provider: AiProvider,
  config: AiModelConfig,
): Promise<number> {
  const modelId = config.modelId.trim()
  if (!modelId) return config.numCtx

  if (provider.transport === 'ollama') {
    return Math.max(512, config.numCtx)
  }

  const key = cacheKey(provider.id, modelId)
  const hit = limitCache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.limit

  let limit: number | null = null

  try {
    if (
      provider.transport === 'groq' ||
      provider.transport === 'openai' ||
      provider.transport === 'openai-compatible' ||
      provider.transport === 'sglang'
    ) {
      const map = await fetchOpenaiCompatWindows(provider)
      limit = map.get(modelId) ?? null
      // Some ids differ by org prefix (openai/gpt-oss-20b vs gpt-oss-20b).
      if (limit == null) {
        const short = modelId.includes('/')
          ? modelId.slice(modelId.lastIndexOf('/') + 1)
          : modelId
        for (const [id, n] of map) {
          if (id === short || id.endsWith(`/${short}`) || id.endsWith(modelId)) {
            limit = n
            break
          }
        }
      }
    } else if (provider.transport === 'google-genai') {
      limit = await fetchGoogleWindow(provider, modelId)
    } else if (provider.transport === 'anthropic') {
      limit = await fetchAnthropicWindow(provider, modelId)
    }
  } catch {
    // fall through to known table
  }

  if (limit == null) limit = knownContextWindow(modelId)
  // Last resort — treat like a modest chat window.
  if (limit == null) limit = 8192

  limitCache.set(key, { limit, at: Date.now() })
  return limit
}

/** Drop cached windows (e.g. after provider/model edits). */
export function clearContextLimitCache(
  providerId?: string,
  modelId?: string,
): void {
  if (!providerId) {
    limitCache.clear()
    providerModelWindows.clear()
    return
  }
  if (modelId) {
    limitCache.delete(cacheKey(providerId, modelId))
    providerModelWindows.get(providerId)?.delete(modelId)
    return
  }
  for (const k of [...limitCache.keys()]) {
    if (k.startsWith(`${providerId}::`)) limitCache.delete(k)
  }
  providerModelWindows.delete(providerId)
}

export function formatTokenCount(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

export function contextUsageRatio(used: number, limit: number): number {
  if (limit <= 0) return 0
  return Math.min(1, Math.max(0, used / limit))
}

export function transportsWithRemoteContextMeta(): AiTransport[] {
  return [
    'groq',
    'openai',
    'openai-compatible',
    'sglang',
    'google-genai',
    'anthropic',
  ]
}
