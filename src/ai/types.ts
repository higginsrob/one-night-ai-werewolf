export type AiTransport =
  | 'ollama'
  | 'openai'
  | 'anthropic'
  | 'google-genai'
  | 'groq'
  | 'openai-compatible'
  /** Local SGLang OpenAI-compatible server (/v1/chat/completions + extras). */
  | 'sglang'
  /** Local OmniVoice FastAPI (/v1/audio/speech + design presets). */
  | 'omnivoice'

export type AiProvider = {
  id: string
  label: string
  transport: AiTransport
  /** Base URL override; empty → transport default. */
  baseUrl: string
  /** True when this transport needs an API key (not persisted). */
  requiresApiKey: boolean
}

/** Transports that expose OpenAI-compatible /v1/audio/speech. */
export const SPEECH_CAPABLE_TRANSPORTS: readonly AiTransport[] = [
  'omnivoice',
  'openai',
  'openai-compatible',
] as const

export function isSpeechCapableTransport(
  transport: AiTransport | undefined,
): boolean {
  return Boolean(transport && SPEECH_CAPABLE_TRANSPORTS.includes(transport))
}

export type AiModelConfigRole = 'work' | 'classifier' | 'none'

/** Ollama keep_alive: forever (-1), unload (0), or duration string. */
export type OllamaKeepAlive = '-1' | '0' | '5m' | '30m' | '1h' | '2h'

export type AiModelConfig = {
  id: string
  label: string
  providerId: string
  modelId: string
  temperature: number
  maxTokens: number
  /** Always false — chain-of-thought is disabled for game chat. */
  thinking: boolean
  /** Ollama context window (num_ctx). Ignored for other transports. */
  numCtx: number
  /**
   * Ollama keep_alive. Default `-1` (forever) — warms the model on load.
   * Ignored for non-Ollama transports.
   */
  keepAlive: OllamaKeepAlive
  /**
   * Ollama `top_p` nucleus sampling (0–1). Default `0.9`.
   * Ignored for non-Ollama transports.
   */
  topP: number
  /**
   * Ollama `top_k` sampling. `0` = disabled. Default `40`.
   * Ignored for non-Ollama transports.
   */
  topK: number
  /**
   * SGLang `top_k` sampling. `-1` = server default / disabled.
   * Ignored for non-SGLang transports.
   */
  sglTopK: number
  /**
   * SGLang `min_p` sampling. `0` = off.
   * Ignored for non-SGLang transports.
   */
  sglMinP: number
  /**
   * SGLang `repetition_penalty`. `1` = off.
   * Ignored for non-SGLang transports.
   */
  sglRepetitionPenalty: number
  /**
   * SGLang `chat_template_kwargs.enable_thinking`.
   * Default false — game chat should not burn max tokens on CoT.
   * Ignored for non-SGLang transports.
   */
  sglEnableThinking: boolean
  /**
   * When true, classifier calls send `response_format: { type: "json_object" }`.
   * Ignored for chat / guide / streaming. Non-SGLang transports ignore it.
   */
  sglJsonObject: boolean
}

export const OLLAMA_KEEPALIVE_OPTIONS: {
  value: OllamaKeepAlive
  label: string
}[] = [
  { value: '-1', label: 'Forever (default)' },
  { value: '5m', label: '5 minutes' },
  { value: '30m', label: '30 minutes' },
  { value: '1h', label: '1 hour' },
  { value: '2h', label: '2 hours' },
  { value: '0', label: 'Unload when idle' },
]

/** Safer default for local GPUs; raise in settings if VRAM allows. */
export const DEFAULT_NUM_CTX = 4096
/** Stock Chat model config (Ollama) context window. */
export const DEFAULT_CHAT_NUM_CTX = 8192
/** Stock Classifier model config (Ollama) context window. */
export const DEFAULT_CLASSIFIER_NUM_CTX = 2048
export const MIN_NUM_CTX = 512
export const MAX_NUM_CTX = 131072

/** Ollama sampling defaults (match Ollama protocol defaults). */
export const DEFAULT_TOP_P = 0.9
export const DEFAULT_TOP_K = 40
export const MIN_TOP_P = 0
export const MAX_TOP_P = 1
export const MIN_TOP_K = 0
export const MAX_TOP_K = 100

/** SGLang sampling defaults (match server protocol defaults). */
export const DEFAULT_SGL_TOP_K = -1
export const DEFAULT_SGL_MIN_P = 0
export const DEFAULT_SGL_REPETITION_PENALTY = 1
export const MIN_SGL_TOP_K = -1
export const MAX_SGL_TOP_K = 100
export const MIN_SGL_MIN_P = 0
export const MAX_SGL_MIN_P = 1
export const MIN_SGL_REPETITION_PENALTY = 0.1
export const MAX_SGL_REPETITION_PENALTY = 2

/** Default fields for Ollama-specific sampling knobs. */
export function defaultOllamaSamplingFields(): Pick<
  AiModelConfig,
  'topP' | 'topK'
> {
  return {
    topP: DEFAULT_TOP_P,
    topK: DEFAULT_TOP_K,
  }
}

/** Default fields for SGLang-specific model config knobs. */
export function defaultSglangModelFields(): Pick<
  AiModelConfig,
  | 'sglTopK'
  | 'sglMinP'
  | 'sglRepetitionPenalty'
  | 'sglEnableThinking'
  | 'sglJsonObject'
> {
  return {
    sglTopK: DEFAULT_SGL_TOP_K,
    sglMinP: DEFAULT_SGL_MIN_P,
    sglRepetitionPenalty: DEFAULT_SGL_REPETITION_PENALTY,
    sglEnableThinking: false,
    sglJsonObject: false,
  }
}

/** Stable ids for the stock AI stack (defaults + reset). */
export const DEFAULT_OLLAMA_PROVIDER_ID = 'prov_ollama'
export const DEFAULT_OMNIVOICE_PROVIDER_ID = 'prov_omnivoice'
export const DEFAULT_CHAT_CONFIG_ID = 'cfg_chat'
export const DEFAULT_CLASSIFIER_CONFIG_ID = 'cfg_classifier'
export const DEFAULT_VOICE_CONFIG_ID = 'cfg_voice'

export type AiStorePersisted = {
  version: 1
  providers: AiProvider[]
  modelConfigs: AiModelConfig[]
  activeWorkConfigId: string | null
  activeClassifierConfigId: string | null
  /** Model used for AI player guided import interviews. */
  activeGuideConfigId: string | null
  /** Model config used for API TTS (/v1/audio/speech). */
  activeTtsConfigId: string | null
}

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type TokenUsage = {
  promptTokens: number
  completionTokens?: number
  totalTokens?: number
}

export type ChatCompletionRequest = {
  model: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  /** When false/undefined, disable or minimize thinking. */
  thinking?: boolean
}

export type ChatCompletionResult = {
  text: string
  raw?: unknown
  usage?: TokenUsage
}
