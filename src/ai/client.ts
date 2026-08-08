import { loadAiStore } from './aiStore'
import {
  estimateMessagesTokens,
  resolveContextLimit,
} from './contextWindow'
import { setContextUsage } from './contextUsageStore'
import { defaultBaseUrl, rewriteLocalServiceBaseUrl } from './defaults'
import { isGpuCrashMessage } from './inferenceHealth'
import { getProviderApiKey } from './keyStore'
import type {
  AiModelConfig,
  AiProvider,
  AiStorePersisted,
  ChatCompletionRequest,
  ChatCompletionResult,
  TokenUsage,
} from './types'

function resolveBaseUrl(provider: AiProvider): string {
  let trimmed = rewriteLocalServiceBaseUrl(
    provider.baseUrl.trim() || defaultBaseUrl(provider.transport),
  ).replace(/\/+$/, '')
  if (!trimmed) {
    trimmed = defaultBaseUrl(provider.transport).replace(/\/+$/, '')
  }
  // Users often paste https://api.anthropic.com/v1; chat/list paths already include /v1.
  if (provider.transport === 'anthropic') {
    trimmed = trimmed.replace(/\/v1$/i, '')
  }
  return trimmed
}

function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  }
}

function requireKey(provider: AiProvider): string {
  if (!provider.requiresApiKey) return ''
  const key = getProviderApiKey(provider.id)
  if (!key) {
    throw new Error(`API key required for ${provider.label}`)
  }
  return key
}

async function readError(res: Response): Promise<string> {
  try {
    const text = await res.text()
    const trimmed = text.trim()
    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed) as {
          error?: string | { message?: string }
        }
        if (typeof obj.error === 'string' && obj.error.trim()) {
          return obj.error.trim().slice(0, 400)
        }
        if (
          obj.error &&
          typeof obj.error === 'object' &&
          typeof obj.error.message === 'string' &&
          obj.error.message.trim()
        ) {
          return obj.error.message.trim().slice(0, 400)
        }
      } catch {
        // fall through
      }
    }
    return trimmed.slice(0, 240) || res.statusText
  } catch {
    return res.statusText || `HTTP ${res.status}`
  }
}

type StreamDeltaFn = (accumulated: string) => void

type SseChatStreamResult = {
  text: string
  reasoning: string
  sawToolCalls: boolean
  usage?: TokenUsage
}

function parseOpenaiStyleUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
  const prompt = u.prompt_tokens ?? u.promptTokens
  if (typeof prompt !== 'number' || !Number.isFinite(prompt) || prompt < 0) {
    return undefined
  }
  const completion = u.completion_tokens ?? u.completionTokens
  const total = u.total_tokens ?? u.totalTokens
  return {
    promptTokens: Math.floor(prompt),
    ...(typeof completion === 'number' && Number.isFinite(completion)
      ? { completionTokens: Math.floor(completion) }
      : {}),
    ...(typeof total === 'number' && Number.isFinite(total)
      ? { totalTokens: Math.floor(total) }
      : {}),
  }
}

function parseOllamaUsage(raw: {
  prompt_eval_count?: number
  eval_count?: number
}): TokenUsage | undefined {
  const prompt = raw.prompt_eval_count
  if (typeof prompt !== 'number' || !Number.isFinite(prompt) || prompt < 0) {
    return undefined
  }
  const completion = raw.eval_count
  return {
    promptTokens: Math.floor(prompt),
    ...(typeof completion === 'number' && Number.isFinite(completion)
      ? {
          completionTokens: Math.floor(completion),
          totalTokens: Math.floor(prompt + completion),
        }
      : {}),
  }
}

async function reportWorkContextUsage(
  provider: AiProvider,
  config: AiModelConfig,
  messages: ChatCompletionRequest['messages'],
  usage: TokenUsage | undefined,
): Promise<void> {
  const store = loadAiStore()
  if (store.activeWorkConfigId !== config.id) return
  try {
    const limit = await resolveContextLimit(provider, config)
    const estimated = !usage
    const used = usage?.promptTokens ?? estimateMessagesTokens(messages)
    setContextUsage({
      used,
      limit,
      modelId: config.modelId.trim(),
      configId: config.id,
      estimated,
    })
  } catch {
    // UI indicator is best-effort
  }
}

async function readSseChatStream(
  res: Response,
  onDelta: StreamDeltaFn,
): Promise<SseChatStreamResult> {
  if (!res.body) throw new Error('Empty stream body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let reasoning = ''
  let sawToolCalls = false
  let usage: TokenUsage | undefined
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const rawLine of parts) {
      const line = rawLine.trim()
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const json = JSON.parse(payload) as {
          choices?: {
            delta?: {
              content?: unknown
              reasoning?: string
              reasoning_content?: string
              tool_calls?: unknown[]
            }
          }[]
          usage?: unknown
        }
        const chunkUsage = parseOpenaiStyleUsage(json.usage)
        if (chunkUsage) usage = chunkUsage
        const delta = json.choices?.[0]?.delta
        const reasonChunk =
          (typeof delta?.reasoning === 'string' && delta.reasoning) ||
          (typeof delta?.reasoning_content === 'string' &&
            delta.reasoning_content) ||
          ''
        if (reasonChunk) reasoning += reasonChunk
        if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
          sawToolCalls = true
        }
        const chunk = coerceMessageContent(delta?.content)
        if (chunk) {
          text += chunk
          onDelta(text)
        }
      } catch {
        // ignore malformed SSE chunks
      }
    }
  }
  return { text, reasoning, sawToolCalls, usage }
}

/** o-series / some gpt-5 variants only allow default temperature. */
function openaiOmitsCustomTemperature(model: string): boolean {
  const m = model.toLowerCase()
  return (
    m.startsWith('o1') ||
    m.startsWith('o3') ||
    m.startsWith('o4') ||
    m.startsWith('gpt-5') ||
    m.includes('o1-') ||
    m.includes('o3-') ||
    m.includes('o4-')
  )
}

type OpenaiCompatOptions = {
  /** When true, use OpenAI's newer token/temperature rules. */
  openaiNative?: boolean
  /** Groq prefers max_completion_tokens; also applies model-specific think-off knobs. */
  groq?: boolean
  /** SGLang local — thinking via chat_template_kwargs; sampling extras. */
  sglang?: boolean
}

/** Coerce OpenAI-style message content (string | parts[]) to plain text. */
function coerceMessageContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && 'text' in part) {
        const text = (part as { text?: unknown }).text
        return typeof text === 'string' ? text : ''
      }
      return ''
    })
    .join('')
}

/** Strip Groq/Qwen raw `<think>…</think>` blocks; keep the visible answer. */
function stripThinkTags(text: string): string {
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  if (stripped) return stripped
  // Unclosed think block with trailing answer (rare).
  const unclosed = text.match(/<\/think>\s*([\s\S]+)/i)
  return unclosed?.[1]?.trim() || ''
}

function emptyResponseError(opts: {
  reasoning?: string | null
  toolCalls?: boolean
}): Error {
  if (opts.toolCalls) {
    return new Error(
      'Empty model response (tool call only — pick a chat model, not Compound)',
    )
  }
  if (opts.reasoning?.trim()) {
    return new Error(
      'Empty model response (reasoning only — raise max tokens or pick a non-reasoning model)',
    )
  }
  return new Error('Empty model response')
}

function isGptOssModel(model: string): boolean {
  return model.toLowerCase().includes('gpt-oss')
}

/** Qwen 3.x can fully disable thinking via reasoning_effort=none. */
function isQwen3Model(model: string): boolean {
  return /qwen[\s/_.-]*3/i.test(model)
}

/**
 * Turn thinking/reasoning off (or minimize it) so short game lines don't
 * burn the whole max_tokens budget and return content: "".
 *
 * - Groq Qwen3: reasoning_effort none (true off)
 * - Groq GPT-OSS: always-on — hide + low effort only
 * - SGLang: chat_template_kwargs.enable_thinking false
 * - openai-compatible (Ollama /v1, etc.): reasoning_effort none
 *   (native Ollama uses think:false; /v1 ignores think and auto-enables
 *   thinking unless reasoning_effort is set)
 */
function reasoningOffExtras(
  model: string,
  opts?: OpenaiCompatOptions,
): Record<string, unknown> {
  if (opts?.openaiNative) return {}

  if (opts?.sglang) {
    return {
      chat_template_kwargs: { enable_thinking: false },
    }
  }

  const m = model.toLowerCase()
  if (opts?.groq) {
    if (isQwen3Model(m)) {
      return { reasoning_effort: 'none' }
    }
    if (isGptOssModel(m)) {
      return { include_reasoning: false, reasoning_effort: 'low' }
    }
    if (/minimax|deepseek-r1|deepseek-reasoner|qwq/.test(m)) {
      return { reasoning_format: 'hidden' }
    }
    return {}
  }

  // openai-compatible: disable think when the endpoint supports it (Ollama /v1).
  return { reasoning_effort: 'none' }
}

function thinkingEnabled(req: ChatCompletionRequest): boolean {
  return req.thinking === true
}

/** Prefer visible content; some endpoints dump the whole reply into reasoning. */
function resolveAssistantText(
  content: unknown,
  reasoning?: string | null,
): string {
  const raw = coerceMessageContent(content)
  const fromContent = stripThinkTags(raw) || raw.trim()
  if (fromContent) return fromContent
  const r = reasoning?.trim()
  if (!r) return ''
  const fromReasoning = stripThinkTags(r) || r
  // Promote short wrong-field replies only — not a long CoT dump.
  if (fromReasoning.length > 400) return ''
  return fromReasoning
}

function openaiCompatBody(
  req: ChatCompletionRequest,
  extras?: Record<string, unknown>,
  opts?: OpenaiCompatOptions,
): Record<string, unknown> {
  // GPT-OSS still spends tokens on hidden CoT — give the answer room.
  let max = req.maxTokens ?? 1024
  if (opts?.groq && isGptOssModel(req.model) && max < 2048) {
    max = 2048
  }
  const thinkOff = thinkingEnabled(req)
    ? opts?.sglang
      ? { chat_template_kwargs: { enable_thinking: true } }
      : {}
    : reasoningOffExtras(req.model, opts)
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    ...thinkOff,
    ...extras,
  }
  // Official OpenAI API: newer models reject max_tokens; older ones accept
  // max_completion_tokens as well. Groq's docs use max_completion_tokens too.
  if (opts?.openaiNative || opts?.groq) {
    body.max_completion_tokens = max
  } else {
    body.max_tokens = max
  }
  const temperature = req.temperature ?? 0.7
  if (!(opts?.openaiNative && openaiOmitsCustomTemperature(req.model))) {
    body.temperature = temperature
  }
  return body
}

function reasoningEffortRejected(err: string): boolean {
  return /reasoning_effort|include_reasoning|reasoning_format|chat_template_kwargs|stream_options|unknown.?param|unsupported|unrecognized|invalid.*(think|reason|stream)/i.test(
    err,
  )
}

async function postOpenaiCompatChat(
  baseUrl: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

/** Drop think-off / stream_options knobs and retry once if the server rejects them. */
async function openaiCompatFetch(
  baseUrl: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<Response> {
  let res = await postOpenaiCompatChat(baseUrl, headers, body)
  if (res.ok) return res
  const err = await readError(res)
  const hadExtras =
    'reasoning_effort' in body ||
    'include_reasoning' in body ||
    'reasoning_format' in body ||
    'chat_template_kwargs' in body ||
    'stream_options' in body
  if (!hadExtras || !reasoningEffortRejected(err)) {
    throw new Error(err)
  }
  const retry = { ...body }
  if (/stream_options/i.test(err)) {
    delete retry.stream_options
  } else {
    delete retry.reasoning_effort
    delete retry.include_reasoning
    delete retry.reasoning_format
    delete retry.chat_template_kwargs
    delete retry.stream_options
  }
  res = await postOpenaiCompatChat(baseUrl, headers, retry)
  if (!res.ok) throw new Error(await readError(res))
  return res
}

/** OpenAI-compatible chat + models (OpenAI, Groq, Ollama OpenAI API, compatible). */
async function openaiCompatChat(
  baseUrl: string,
  apiKey: string | null,
  req: ChatCompletionRequest,
  extras?: Record<string, unknown>,
  opts?: OpenaiCompatOptions,
): Promise<ChatCompletionResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const res = await openaiCompatFetch(
    baseUrl,
    headers,
    openaiCompatBody(req, extras, opts),
  )
  const data = (await res.json()) as {
    choices?: {
      message?: {
        content?: unknown
        reasoning?: string
        reasoning_content?: string
        tool_calls?: unknown[]
      }
    }[]
    usage?: unknown
  }
  const message = data.choices?.[0]?.message
  const reasoning = message?.reasoning ?? message?.reasoning_content ?? null
  const text = resolveAssistantText(message?.content, reasoning)
  if (!text) {
    throw emptyResponseError({
      reasoning,
      toolCalls: Array.isArray(message?.tool_calls) && message.tool_calls.length > 0,
    })
  }
  return { text, raw: data, usage: parseOpenaiStyleUsage(data.usage) }
}

async function openaiCompatChatStream(
  baseUrl: string,
  apiKey: string | null,
  req: ChatCompletionRequest,
  onDelta: StreamDeltaFn,
  extras?: Record<string, unknown>,
  opts?: OpenaiCompatOptions,
): Promise<ChatCompletionResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const res = await openaiCompatFetch(baseUrl, headers, {
    ...openaiCompatBody(req, extras, opts),
    stream: true,
    // Final SSE chunk includes usage (OpenAI / Groq / many compat gateways).
    stream_options: { include_usage: true },
  })
  const streamed = await readSseChatStream(res, onDelta)
  const text = resolveAssistantText(streamed.text, streamed.reasoning)
  if (!text) {
    throw emptyResponseError({
      reasoning: streamed.reasoning || null,
      toolCalls: streamed.sawToolCalls,
    })
  }
  if (text !== streamed.text.trim()) onDelta(text)
  return { text, usage: streamed.usage }
}

async function openaiCompatListModels(
  baseUrl: string,
  apiKey: string | null,
): Promise<string[]> {
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const res = await fetch(`${baseUrl}/models`, { headers })
  if (!res.ok) throw new Error(await readError(res))
  const data = (await res.json()) as { data?: { id?: string }[] }
  return (data.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => Boolean(id))
    .sort()
}

async function ollamaNativeList(baseUrl: string): Promise<string[]> {
  const res = await fetch(`${baseUrl}/api/tags`)
  if (!res.ok) throw new Error(await readError(res))
  const data = (await res.json()) as { models?: { name?: string }[] }
  return (data.models ?? [])
    .map((m) => m.name)
    .filter((id): id is string => Boolean(id))
    .sort()
}

type OllamaChatExtras = {
  numCtx?: number
  keepAlive?: string | number
  topP?: number
  topK?: number
}

function ollamaChatOptions(extras?: OllamaChatExtras, req?: {
  temperature?: number
  maxTokens?: number
}): Record<string, number> {
  return {
    temperature: req?.temperature ?? 0.7,
    num_predict: req?.maxTokens ?? 1024,
    ...(extras?.numCtx != null ? { num_ctx: extras.numCtx } : {}),
    ...(extras?.topP != null ? { top_p: extras.topP } : {}),
    ...(extras?.topK != null ? { top_k: extras.topK } : {}),
  }
}

/** Build SGLang OpenAI-compat body extras from a model config. */
function sglangRequestExtras(
  config: AiModelConfig,
  opts?: { jsonObject?: boolean },
): Record<string, unknown> {
  const extras: Record<string, unknown> = {}
  if (config.sglTopK !== -1) extras.top_k = config.sglTopK
  if (config.sglMinP > 0) extras.min_p = config.sglMinP
  if (config.sglRepetitionPenalty !== 1) {
    extras.repetition_penalty = config.sglRepetitionPenalty
  }
  // JSON mode is classifier-only — never attach it for chat/stream/guide.
  if (opts?.jsonObject && config.sglJsonObject) {
    extras.response_format = { type: 'json_object' }
  }
  return extras
}

function ollamaKeepAliveValue(
  keepAlive: string | number | undefined,
): string | number | undefined {
  if (keepAlive === undefined || keepAlive === '') return undefined
  if (keepAlive === '-1' || keepAlive === -1) return -1
  if (keepAlive === '0' || keepAlive === 0) return 0
  return keepAlive
}

async function ollamaNativeChat(
  baseUrl: string,
  apiKey: string | null,
  req: ChatCompletionRequest,
  extras?: OllamaChatExtras,
): Promise<ChatCompletionResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const keepAlive = ollamaKeepAliveValue(extras?.keepAlive)
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: req.model,
      stream: false,
      // Thinking models otherwise spend num_predict on reasoning and return "".
      think: thinkingEnabled(req),
      ...(keepAlive !== undefined ? { keep_alive: keepAlive } : {}),
      options: ollamaChatOptions(extras, req),
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    }),
  })
  if (!res.ok) throw new Error(await readError(res))
  const data = (await res.json()) as {
    message?: { content?: string; thinking?: string }
    error?: string
    prompt_eval_count?: number
    eval_count?: number
  }
  if (data.error) throw new Error(data.error)
  const text = data.message?.content?.trim() ?? ''
  if (!text) {
    const thinking = data.message?.thinking?.trim()
    throw new Error(
      thinking
        ? 'Empty model response (thinking only — use a chat model or update Ollama)'
        : 'Empty model response (is this an embedding model?)',
    )
  }
  return { text, raw: data, usage: parseOllamaUsage(data) }
}

async function ollamaNativeChatStream(
  baseUrl: string,
  apiKey: string | null,
  req: ChatCompletionRequest,
  onDelta: StreamDeltaFn,
  extras?: OllamaChatExtras,
): Promise<ChatCompletionResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const keepAlive = ollamaKeepAliveValue(extras?.keepAlive)
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: req.model,
      stream: true,
      think: thinkingEnabled(req),
      ...(keepAlive !== undefined ? { keep_alive: keepAlive } : {}),
      options: ollamaChatOptions(extras, req),
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    }),
  })
  if (!res.ok) throw new Error(await readError(res))
  if (!res.body) throw new Error('Empty stream body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let usage: TokenUsage | undefined
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const rawLine of parts) {
      const line = rawLine.trim()
      if (!line) continue
      let json: {
        message?: { content?: string }
        error?: string
        done?: boolean
        prompt_eval_count?: number
        eval_count?: number
      }
      try {
        json = JSON.parse(line) as typeof json
      } catch {
        continue
      }
      if (json.error) throw new Error(json.error)
      const delta = json.message?.content
      if (typeof delta === 'string' && delta) {
        text += delta
        onDelta(text)
      }
      if (json.done) {
        const chunkUsage = parseOllamaUsage(json)
        if (chunkUsage) usage = chunkUsage
      }
    }
  }
  const trimmed = text.trim()
  if (!trimmed) throw new Error('Empty model response')
  return { text: trimmed, usage }
}

function ollamaAuthHeaders(provider: AiProvider): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (provider.requiresApiKey) {
    const key = getProviderApiKey(provider.id)
    if (key) headers.Authorization = `Bearer ${key}`
  }
  return headers
}

/** Load an Ollama model into memory with the given keep_alive (e.g. forever). */
export async function warmOllamaModel(
  provider: AiProvider,
  config: AiModelConfig,
): Promise<void> {
  if (provider.transport !== 'ollama') {
    return
  }
  const model = config.modelId.trim()
  if (!model) return

  const base = resolveBaseUrl(provider)
  const headers = ollamaAuthHeaders(provider)
  if (provider.requiresApiKey && !headers.Authorization) {
    requireKey(provider)
  }

  const keepAlive = ollamaKeepAliveValue(config.keepAlive) ?? -1
  // /api/generate with empty prompt loads weights without a full chat turn.
  const res = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      prompt: '',
      stream: false,
      keep_alive: keepAlive,
      options: { num_ctx: config.numCtx },
    }),
  })
  if (!res.ok) throw new Error(await readError(res))
}

/** Best-effort unload of one model from an Ollama provider (keep_alive: 0). */
export async function unloadOllamaModel(
  provider: AiProvider,
  modelId: string,
): Promise<void> {
  if (provider.transport !== 'ollama') return
  const model = modelId.trim()
  if (!model) return

  const base = resolveBaseUrl(provider)
  const headers = ollamaAuthHeaders(provider)
  try {
    await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        prompt: '',
        stream: false,
        keep_alive: 0,
      }),
    })
  } catch {
    // ignore wedged runner
  }
}

/** Best-effort unload of models currently resident on Ollama providers. */
export async function unloadOllamaModelsForStore(
  store: AiStorePersisted,
): Promise<void> {
  const seen = new Set<string>()
  for (const provider of store.providers) {
    if (provider.transport !== 'ollama') {
      continue
    }
    const base = resolveBaseUrl(provider)
    if (seen.has(base)) continue
    seen.add(base)

    const headers = ollamaAuthHeaders(provider)

    let names: string[] = []
    try {
      const res = await fetch(`${base}/api/ps`, { headers })
      if (res.ok) {
        const data = (await res.json()) as { models?: { name?: string }[] }
        names = (data.models ?? [])
          .map((m) => m.name)
          .filter((n): n is string => Boolean(n))
      }
    } catch {
      // fall through — still try configured model ids
    }
    if (names.length === 0) {
      names = store.modelConfigs
        .filter((c) => c.providerId === provider.id && c.modelId.trim())
        .map((c) => c.modelId.trim())
    }

    for (const model of [...new Set(names)]) {
      await unloadOllamaModel(provider, model)
    }
  }
}

async function anthropicChat(
  baseUrl: string,
  apiKey: string,
  req: ChatCompletionRequest,
): Promise<ChatCompletionResult> {
  const system = req.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const messages = req.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }))

  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: anthropicHeaders(apiKey),
    body: JSON.stringify({
      model: req.model,
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0.7,
      system: system || undefined,
      messages,
    }),
  })
  if (!res.ok) throw new Error(await readError(res))
  const data = (await res.json()) as {
    content?: { type?: string; text?: string }[]
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  const text =
    data.content
      ?.filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
      .trim() ?? ''
  if (!text) throw new Error('Empty model response')
  const prompt = data.usage?.input_tokens
  const usage: TokenUsage | undefined =
    typeof prompt === 'number' && Number.isFinite(prompt)
      ? {
          promptTokens: Math.floor(prompt),
          ...(typeof data.usage?.output_tokens === 'number'
            ? {
                completionTokens: Math.floor(data.usage.output_tokens),
                totalTokens: Math.floor(
                  prompt + (data.usage.output_tokens ?? 0),
                ),
              }
            : {}),
        }
      : undefined
  return { text, raw: data, usage }
}

/** Prefer Anthropic's public /v1/models; fall back to known chat aliases. */
async function anthropicListModels(
  baseUrl: string,
  apiKey: string,
): Promise<string[]> {
  const fallback = [
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-haiku-4-5-20251001',
    'claude-3-5-haiku-latest',
    'claude-3-5-sonnet-latest',
  ]
  try {
    const res = await fetch(`${baseUrl}/v1/models?limit=100`, {
      headers: anthropicHeaders(apiKey),
    })
    if (!res.ok) return fallback
    const data = (await res.json()) as { data?: { id?: string }[] }
    const ids = (data.data ?? [])
      .map((m) => m.id?.trim())
      .filter((id): id is string => Boolean(id))
    return ids.length > 0 ? ids.sort() : fallback
  } catch {
    return fallback
  }
}

async function googleChat(
  baseUrl: string,
  apiKey: string,
  req: ChatCompletionRequest,
): Promise<ChatCompletionResult> {
  const system = req.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const contents = req.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }))

  const url = `${baseUrl}/models/${encodeURIComponent(req.model)}:generateContent?key=${encodeURIComponent(apiKey)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: system
        ? { parts: [{ text: system }] }
        : undefined,
      contents,
      generationConfig: {
        temperature: req.temperature ?? 0.7,
        maxOutputTokens: req.maxTokens ?? 1024,
      },
    }),
  })
  if (!res.ok) throw new Error(await readError(res))
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[]
    usageMetadata?: {
      promptTokenCount?: number
      candidatesTokenCount?: number
      totalTokenCount?: number
    }
  }
  const text =
    data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? '')
      .join('')
      .trim() ?? ''
  if (!text) throw new Error('Empty model response')
  const prompt = data.usageMetadata?.promptTokenCount
  const usage: TokenUsage | undefined =
    typeof prompt === 'number' && Number.isFinite(prompt)
      ? {
          promptTokens: Math.floor(prompt),
          ...(typeof data.usageMetadata?.candidatesTokenCount === 'number'
            ? {
                completionTokens: Math.floor(
                  data.usageMetadata.candidatesTokenCount,
                ),
              }
            : {}),
          ...(typeof data.usageMetadata?.totalTokenCount === 'number'
            ? { totalTokens: Math.floor(data.usageMetadata.totalTokenCount) }
            : {}),
        }
      : undefined
  return { text, raw: data, usage }
}

async function googleListModels(
  baseUrl: string,
  apiKey: string,
): Promise<string[]> {
  const res = await fetch(
    `${baseUrl}/models?key=${encodeURIComponent(apiKey)}`,
  )
  if (!res.ok) throw new Error(await readError(res))
  const data = (await res.json()) as { models?: { name?: string }[] }
  return (data.models ?? [])
    .map((m) => (m.name ?? '').replace(/^models\//, ''))
    .filter(Boolean)
    .sort()
}

export async function listModelsForProvider(
  provider: AiProvider,
): Promise<string[]> {
  const base = resolveBaseUrl(provider)
  const key = provider.requiresApiKey ? requireKey(provider) : null

  switch (provider.transport) {
    case 'ollama':
      return ollamaNativeList(base)
    case 'openai':
    case 'groq':
    case 'openai-compatible':
    case 'sglang':
      return openaiCompatListModels(base, key)
    case 'omnivoice': {
      try {
        const ids = await openaiCompatListModels(base, key)
        if (ids.length > 0) return ids
      } catch {
        // fall through to default speech model id
      }
      return ['omnivoice']
    }
    case 'anthropic':
      return anthropicListModels(base, key!)
    case 'google-genai':
      return googleListModels(base, key!)
    default:
      return []
  }
}

export async function chatWithProvider(
  provider: AiProvider,
  req: ChatCompletionRequest,
  extras?: OllamaChatExtras | Record<string, unknown>,
): Promise<ChatCompletionResult> {
  const base = resolveBaseUrl(provider)
  const key = provider.requiresApiKey ? requireKey(provider) : null

  switch (provider.transport) {
    case 'ollama':
      return ollamaNativeChat(base, key, req, extras as OllamaChatExtras | undefined)
    case 'openai':
      return openaiCompatChat(base, key, req, undefined, { openaiNative: true })
    case 'groq':
      return openaiCompatChat(base, key, req, undefined, { groq: true })
    case 'openai-compatible':
      return openaiCompatChat(base, key, req)
    case 'sglang':
      return openaiCompatChat(
        base,
        key,
        req,
        extras as Record<string, unknown> | undefined,
        { sglang: true },
      )
    case 'omnivoice':
      throw new Error(
        'OmniVoice is a speech provider — use it for TTS, not chat.',
      )
    case 'anthropic':
      return anthropicChat(base, key!, req)
    case 'google-genai':
      return googleChat(base, key!, req)
    default:
      throw new Error('Unknown transport')
  }
}

export async function chatWithConfig(
  provider: AiProvider,
  config: AiModelConfig,
  messages: ChatCompletionRequest['messages'],
  opts?: { jsonObject?: boolean },
): Promise<ChatCompletionResult> {
  if (!config.modelId.trim()) throw new Error('Model id is empty')
  const isOllama = provider.transport === 'ollama'
  const isSglang = provider.transport === 'sglang'
  const req: ChatCompletionRequest = {
    model: config.modelId,
    messages,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    thinking: isSglang ? config.sglEnableThinking : false,
  }
  if (isSglang) {
    return chatWithProvider(
      provider,
      req,
      sglangRequestExtras(config, { jsonObject: opts?.jsonObject === true }),
    )
  }
  if (!isOllama) return chatWithProvider(provider, req)

  try {
    return await chatWithProvider(provider, req, {
      numCtx: config.numCtx,
      keepAlive: config.keepAlive,
      topP: config.topP,
      topK: config.topK,
    })
  } catch (err) {
    // One softer retry — large num_ctx KV caches are a common CUDA OOM trigger.
    const halved = Math.max(512, Math.floor(config.numCtx / 2))
    if (
      !isGpuCrashMessage(err instanceof Error ? err.message : String(err)) ||
      halved >= config.numCtx
    ) {
      throw err
    }
    return chatWithProvider(provider, req, {
      numCtx: halved,
      keepAlive: config.keepAlive,
      topP: config.topP,
      topK: config.topK,
    })
  }
}

async function streamChatWithProvider(
  provider: AiProvider,
  req: ChatCompletionRequest,
  onDelta: StreamDeltaFn,
  extras?: OllamaChatExtras | Record<string, unknown>,
): Promise<ChatCompletionResult> {
  const base = resolveBaseUrl(provider)
  const key = provider.requiresApiKey ? requireKey(provider) : null

  switch (provider.transport) {
    case 'ollama':
      return ollamaNativeChatStream(
        base,
        key,
        req,
        onDelta,
        extras as OllamaChatExtras | undefined,
      )
    case 'openai':
      return openaiCompatChatStream(base, key, req, onDelta, undefined, {
        openaiNative: true,
      })
    case 'groq':
      return openaiCompatChatStream(base, key, req, onDelta, undefined, {
        groq: true,
      })
    case 'openai-compatible':
      return openaiCompatChatStream(base, key, req, onDelta)
    case 'sglang':
      return openaiCompatChatStream(
        base,
        key,
        req,
        onDelta,
        extras as Record<string, unknown> | undefined,
        { sglang: true },
      )
    case 'omnivoice':
      throw new Error(
        'OmniVoice is a speech provider — use it for TTS, not chat.',
      )
    case 'anthropic':
    case 'google-genai': {
      // No browser stream path yet — deliver the full reply as one delta.
      const result = await chatWithProvider(provider, req, extras)
      onDelta(result.text)
      return result
    }
    default:
      throw new Error('Unknown transport')
  }
}

/** Stream a chat completion; `onDelta` receives accumulated text so far. */
export async function streamChatWithConfig(
  provider: AiProvider,
  config: AiModelConfig,
  messages: ChatCompletionRequest['messages'],
  onDelta: StreamDeltaFn,
): Promise<ChatCompletionResult> {
  if (!config.modelId.trim()) throw new Error('Model id is empty')
  const isOllama = provider.transport === 'ollama'
  const isSglang = provider.transport === 'sglang'
  const req: ChatCompletionRequest = {
    model: config.modelId,
    messages,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    thinking: isSglang ? config.sglEnableThinking : false,
  }

  const run = async (): Promise<ChatCompletionResult> => {
    if (isSglang) {
      return streamChatWithProvider(
        provider,
        req,
        onDelta,
        sglangRequestExtras(config),
      )
    }
    if (!isOllama) return streamChatWithProvider(provider, req, onDelta)
    try {
      return await streamChatWithProvider(provider, req, onDelta, {
        numCtx: config.numCtx,
        keepAlive: config.keepAlive,
        topP: config.topP,
        topK: config.topK,
      })
    } catch (err) {
      const halved = Math.max(512, Math.floor(config.numCtx / 2))
      if (
        !isGpuCrashMessage(err instanceof Error ? err.message : String(err)) ||
        halved >= config.numCtx
      ) {
        throw err
      }
      return streamChatWithProvider(provider, req, onDelta, {
        numCtx: halved,
        keepAlive: config.keepAlive,
        topP: config.topP,
        topK: config.topK,
      })
    }
  }

  const result = await run()
  void reportWorkContextUsage(provider, config, messages, result.usage)
  return result
}

/** Reachability check via model list only — does not load or run a model. */
export async function testProviderConnection(
  provider: AiProvider,
): Promise<string> {
  if (provider.transport === 'omnivoice') {
    const base = resolveBaseUrl(provider)
    const root = base.replace(/\/v1$/i, '') || base
    const key = provider.requiresApiKey ? requireKey(provider) : null
    const headers: Record<string, string> = {}
    if (key) headers.Authorization = `Bearer ${key}`
    const res = await fetch(`${root}/health`, { headers })
    if (!res.ok) {
      throw new Error(`OmniVoice health failed: HTTP ${res.status}`)
    }
    const data = (await res.json()) as {
      device?: string
      modelLoaded?: boolean
      modelId?: string
    }
    return `Connected — OmniVoice · device=${data.device ?? '?'} · loaded=${String(data.modelLoaded)} · model=${data.modelId ?? '?'}`
  }
  const models = await listModelsForProvider(provider)
  if (models.length === 0) {
    return 'Connected (no models listed)'
  }
  const preview = models.slice(0, 3).join(', ')
  const more = models.length > 3 ? ` (+${models.length - 3} more)` : ''
  return `Connected — ${models.length} model${models.length === 1 ? '' : 's'}: ${preview}${more}`
}
