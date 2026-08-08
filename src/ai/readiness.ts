import { loadAiStore } from './aiStore'
import type { AiStorePersisted } from './types'
import { hasProviderApiKey } from './keyStore'

export type AiReadiness = {
  ready: boolean
  reason: string | null
}

export type AiLobbySetup = {
  /** Providers present and chat + classifier modes each have a model id. */
  ready: boolean
  hasProviders: boolean
  hasChatMode: boolean
  hasClassifierMode: boolean
}

function configHasModel(
  store: AiStorePersisted,
  configId: string | null,
): boolean {
  if (!configId) return false
  const config = store.modelConfigs.find((c) => c.id === configId)
  return Boolean(config?.modelId.trim())
}

/**
 * Structural lobby setup: providers plus assigned chat and classifier modes
 * with a model picked. Used for the day-chat "Setup required" banner.
 */
export function checkAiLobbySetup(
  store: AiStorePersisted = loadAiStore(),
): AiLobbySetup {
  const hasProviders = store.providers.length > 0
  const hasChatMode = configHasModel(store, store.activeWorkConfigId)
  const hasClassifierMode = configHasModel(
    store,
    store.activeClassifierConfigId,
  )
  return {
    ready: hasProviders && hasChatMode && hasClassifierMode,
    hasProviders,
    hasChatMode,
    hasClassifierMode,
  }
}

/** True when chat and classifier configs can run without missing keys. */
export function checkAiReadiness(): AiReadiness {
  const store = loadAiStore()
  if (store.providers.length === 0) {
    return { ready: false, reason: 'No AI providers configured' }
  }
  if (!store.activeWorkConfigId) {
    return { ready: false, reason: 'No active chat model config' }
  }
  const work = store.modelConfigs.find((c) => c.id === store.activeWorkConfigId)
  if (!work) return { ready: false, reason: 'Chat model config missing' }
  if (!work.modelId.trim()) {
    return { ready: false, reason: 'Chat model id is empty' }
  }
  const workProv = store.providers.find((p) => p.id === work.providerId)
  if (!workProv) return { ready: false, reason: 'Chat provider missing' }
  if (workProv.requiresApiKey && !hasProviderApiKey(workProv.id)) {
    return {
      ready: false,
      reason: `Enter API key for ${workProv.label} to unlock AI players`,
    }
  }

  if (!store.activeClassifierConfigId) {
    return { ready: false, reason: 'No active classifier model config' }
  }
  const clf = store.modelConfigs.find(
    (c) => c.id === store.activeClassifierConfigId,
  )
  if (!clf) return { ready: false, reason: 'Classifier model config missing' }
  if (!clf.modelId.trim()) {
    return { ready: false, reason: 'Classifier model id is empty' }
  }
  const clfProv = store.providers.find((p) => p.id === clf.providerId)
  if (!clfProv) return { ready: false, reason: 'Classifier provider missing' }
  if (clfProv.requiresApiKey && !hasProviderApiKey(clfProv.id)) {
    return {
      ready: false,
      reason: `Enter API key for ${clfProv.label} (classifier)`,
    }
  }

  return { ready: true, reason: null }
}
