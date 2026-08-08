import { loadAiStore } from './aiStore'

/** Cooldown after a local GPU/runner crash so we stop hammering a dead CUDA context. */
const GPU_COOLDOWN_MS = 90_000

let blockedUntil = 0
let blockReason: string | null = null
let unloadInFlight = false

function unwrapProviderMessage(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return raw
  try {
    const obj = JSON.parse(trimmed) as { error?: unknown }
    if (typeof obj.error === 'string' && obj.error.trim()) {
      return obj.error.trim()
    }
  } catch {
    // not JSON
  }
  const nested = trimmed.match(/\{[\s\S]*"error"\s*:\s*"((?:\\.|[^"\\])*)"/)
  if (nested?.[1]) {
    return nested[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
  }
  return trimmed
}

/** True when the provider/runner looks GPU-dead (not ordinary parse/HTTP noise). */
export function isGpuCrashMessage(message: string): boolean {
  return /CUDA|illegal memory access|GGML_ASSERT|out of memory|insufficient memory|runner process has terminated|error loading model|unable to allocate/i.test(
    message,
  )
}

export function isGpuCrashError(err: unknown): boolean {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : String(err)
  return isGpuCrashMessage(unwrapProviderMessage(raw)) || isGpuCrashMessage(raw)
}

/** Turn provider/HTTP blobs into a short host-facing string. */
export function formatInferenceError(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'AI agent failed'
  const unwrapped = unwrapProviderMessage(raw)
  if (isGpuCrashMessage(unwrapped)) {
    return (
      'Local model GPU crashed (CUDA). Restart Ollama, then try a smaller model ' +
      'or lower context (num_ctx). Using scripted table talk / intents until then.'
    )
  }
  // Programming errors (often Vite HMR mid-flight) — keep toast short, stack in console.
  if (err instanceof ReferenceError || err instanceof TypeError) {
    console.error('[ai-host]', err)
  }
  // Keep toast readable — strip multi-line noise.
  return unwrapped.replace(/\s+/g, ' ').slice(0, 220)
}

function requestUnloadAfterCrash(): void {
  if (unloadInFlight) return
  unloadInFlight = true
  // Dynamic import avoids a client ↔ inferenceHealth cycle at module init.
  void import('./client')
    .then((m) => m.unloadOllamaModelsForStore(loadAiStore()))
    .catch(() => {
      // Best-effort — Ollama may already be wedged.
    })
    .finally(() => {
      unloadInFlight = false
    })
}

export function noteInferenceFailure(err: unknown): string {
  const message = formatInferenceError(err)
  if (isGpuCrashError(err)) {
    blockedUntil = Date.now() + GPU_COOLDOWN_MS
    blockReason = message
    requestUnloadAfterCrash()
  }
  return message
}

/** Non-null while we should skip LLM calls after a GPU crash. */
export function inferenceBlockedReason(): string | null {
  if (Date.now() >= blockedUntil) {
    blockedUntil = 0
    blockReason = null
    return null
  }
  return blockReason
}

export function clearInferenceBlock(): void {
  blockedUntil = 0
  blockReason = null
}
