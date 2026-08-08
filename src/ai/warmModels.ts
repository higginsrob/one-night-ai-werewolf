import { loadAiStore } from './aiStore'
import { unloadOllamaModel, warmOllamaModel } from './client'
import type { AiModelConfig, AiProvider, AiStorePersisted } from './types'

function isOllama(provider: AiProvider): boolean {
  return provider.transport === 'ollama'
}

function foreverOllamaModelIdsNeeded(
  store: AiStorePersisted,
  exceptConfigId?: string | null,
): Set<string> {
  const needed = new Set<string>()
  const roleIds = [
    store.activeWorkConfigId,
    store.activeClassifierConfigId,
  ]
  for (const id of roleIds) {
    if (!id || id === exceptConfigId) continue
    const config = store.modelConfigs.find((c) => c.id === id)
    if (!config || config.keepAlive !== '-1') continue
    const model = config.modelId.trim()
    if (!model) continue
    const provider = store.providers.find((p) => p.id === config.providerId)
    if (!provider || !isOllama(provider)) continue
    needed.add(model)
  }
  return needed
}

/**
 * Warm forever-keepalive Ollama models.
 * Only preload the work model when a distinct classifier is also forever —
 * pinning two large weights at boot is a common CUDA OOM cause.
 */
export async function warmForeverOllamaModels(): Promise<void> {
  const store = loadAiStore()
  const work = store.activeWorkConfigId
    ? store.modelConfigs.find((c) => c.id === store.activeWorkConfigId)
    : null
  const classifier = store.activeClassifierConfigId
    ? store.modelConfigs.find((c) => c.id === store.activeClassifierConfigId)
    : null

  let toWarm: AiModelConfig | null = null
  if (work?.keepAlive === '-1' && work.modelId.trim()) {
    toWarm = work
  } else if (classifier?.keepAlive === '-1' && classifier.modelId.trim()) {
    toWarm = classifier
  }

  if (!toWarm) return
  const provider = store.providers.find((p) => p.id === toWarm!.providerId)
  if (!provider || !isOllama(provider)) return

  try {
    await warmOllamaModel(provider, toWarm)
  } catch {
    // Best-effort on page load — Ollama may be offline.
  }
}

/**
 * When an Ollama forever-keepalive model changes (edit or chat/classifier
 * role switch), unload the previous model before warming the next so it does
 * not stay resident forever.
 */
export async function switchForeverOllamaModel(args: {
  provider: AiProvider
  next: AiModelConfig
  /** Model id that was previously kept alive (same config or prior active role). */
  prevModelId?: string | null
  /** Provider that held prevModelId when it differs from `provider`. */
  prevProvider?: AiProvider | null
  /** Config id to ignore when checking whether prev is still needed by chat/classifier. */
  exceptConfigId?: string | null
  onStatus?: (msg: string) => void
}): Promise<void> {
  const {
    provider,
    next,
    prevModelId,
    prevProvider,
    exceptConfigId,
    onStatus,
  } = args
  if (!isOllama(provider) && !(prevProvider && isOllama(prevProvider))) {
    return
  }

  const prev = prevModelId?.trim() ?? ''
  const nextId = next.modelId.trim()
  const unloadProvider =
    prevProvider && isOllama(prevProvider) ? prevProvider : provider

  if (prev && prev !== nextId && isOllama(unloadProvider)) {
    const store = loadAiStore()
    const stillNeeded = foreverOllamaModelIdsNeeded(
      store,
      exceptConfigId ?? next.id,
    )
    if (!stillNeeded.has(prev)) {
      onStatus?.(`Unloading ${prev} from Ollama…`)
      await unloadOllamaModel(unloadProvider, prev)
    }
  }

  if (!isOllama(provider) || next.keepAlive !== '-1' || !nextId) {
    return
  }

  onStatus?.('Loading model into Ollama (keepalive forever)…')
  await warmOllamaModel(provider, next)
  onStatus?.('Model loaded with keepalive forever')
}
