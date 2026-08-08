import {
  chatWithConfig,
  unloadOllamaModelsForStore,
  warmOllamaModel,
} from '../ai/client'
import { loadAiStore } from '../ai/aiStore'
import {
  defaultOllamaBaseUrl,
  rewriteLocalServiceBaseUrl,
} from '../ai/defaults'
import type { AiModelConfig, AiProvider } from '../ai/types'
import { getProviderApiKey } from '../ai/keyStore'

function resolveBaseUrl(provider: AiProvider): string {
  const raw = provider.baseUrl.trim() || defaultOllamaBaseUrl()
  return rewriteLocalServiceBaseUrl(raw).replace(/\/$/, '')
}

async function listResidentOllamaModels(provider: AiProvider): Promise<string[]> {
  const base = resolveBaseUrl(provider)
  const key = provider.requiresApiKey ? getProviderApiKey(provider.id) : null
  const headers: Record<string, string> = {}
  if (key) headers.Authorization = `Bearer ${key}`
  try {
    const res = await fetch(`${base}/api/ps`, { headers })
    if (!res.ok) return []
    const data = (await res.json()) as { models?: { name?: string }[] }
    return (data.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => Boolean(n))
  } catch {
    return []
  }
}

export function configIsOllama(
  config: AiModelConfig | null | undefined,
  providers: AiProvider[],
): boolean {
  if (!config) return false
  const p = providers.find((x) => x.id === config.providerId)
  return p?.transport === 'ollama'
}

/** Unload all resident Ollama models and wait until /api/ps is empty. */
export async function unloadAndWaitOllama(opts?: {
  timeoutMs?: number
  onStatus?: (msg: string) => void
}): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 90_000
  const store = loadAiStore()
  opts?.onStatus?.('Unloading Ollama models…')
  await unloadOllamaModelsForStore(store)

  const ollamaProviders = store.providers.filter((p) => p.transport === 'ollama')
  if (ollamaProviders.length === 0) return

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    let any = false
    for (const p of ollamaProviders) {
      const names = await listResidentOllamaModels(p)
      if (names.length > 0) {
        any = true
        opts?.onStatus?.(
          `Waiting for Ollama unload (${names.join(', ')})…`,
        )
        break
      }
    }
    if (!any) {
      opts?.onStatus?.('Ollama models unloaded')
      return
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
  throw new Error('Timed out waiting for Ollama models to unload')
}

export async function warmAndProbeWorkModel(args: {
  config: AiModelConfig
  provider: AiProvider
  onStatus?: (msg: string) => void
}): Promise<void> {
  const { config, provider, onStatus } = args
  if (provider.transport === 'ollama') {
    onStatus?.(`Warming ${config.label || config.modelId}…`)
    await warmOllamaModel(provider, config)
  }
  onStatus?.(`Probing ${config.label || config.modelId}…`)
  const result = await chatWithConfig(provider, config, [
    {
      role: 'user',
      content: 'Reply with exactly the word OK and nothing else.',
    },
  ])
  const text = result.text.trim().toUpperCase()
  if (!text.includes('OK')) {
    throw new Error(
      `Liveness probe failed for ${config.label || config.modelId}: got "${result.text.slice(0, 80)}"`,
    )
  }
  onStatus?.(`${config.label || config.modelId} is live`)
}

/**
 * Switch work models with Ollama unload/warm when either side is Ollama
 * (or model ids differ on the same Ollama host).
 */
export async function prepareWorkModelSwitch(args: {
  prevConfig: AiModelConfig | null
  nextConfig: AiModelConfig
  nextProvider: AiProvider
  onStatus?: (msg: string) => void
}): Promise<void> {
  const store = loadAiStore()
  const prevIsOllama = configIsOllama(args.prevConfig, store.providers)
  const nextIsOllama = args.nextProvider.transport === 'ollama'
  const sameModel =
    args.prevConfig?.modelId === args.nextConfig.modelId &&
    args.prevConfig?.providerId === args.nextConfig.providerId

  if ((prevIsOllama || nextIsOllama) && !sameModel) {
    await unloadAndWaitOllama({ onStatus: args.onStatus })
  }

  await warmAndProbeWorkModel({
    config: args.nextConfig,
    provider: args.nextProvider,
    onStatus: args.onStatus,
  })
}
