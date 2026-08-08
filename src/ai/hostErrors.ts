import { clearInferenceBlock } from './inferenceHealth'

export type HostErrorKind = 'ai' | 'tts'

export type HostError = {
  message: string
  kind: HostErrorKind
}

type Listener = (error: HostError | null) => void

let lastError: HostError | null = null
const listeners = new Set<Listener>()

function publish(error: HostError): void {
  if (
    lastError &&
    lastError.message === error.message &&
    lastError.kind === error.kind
  ) {
    return
  }
  lastError = error
  for (const l of listeners) l(error)
}

export function publishAiHostError(message: string): void {
  publish({ message, kind: 'ai' })
}

export function publishTtsHostError(message: string): void {
  publish({ message, kind: 'tts' })
}

export function clearAiHostError(): void {
  lastError = null
  clearInferenceBlock()
  for (const l of listeners) l(null)
}

export function getAiHostError(): HostError | null {
  return lastError
}

export function subscribeAiHostError(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
