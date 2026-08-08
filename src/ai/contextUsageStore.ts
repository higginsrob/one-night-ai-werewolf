export type ContextUsageSnapshot = {
  /** Prompt / input tokens filling the window for the last work-model call. */
  used: number
  /** Effective context window (num_ctx or provider model limit). */
  limit: number
  modelId: string
  configId: string
  /** True when `used` is a char/4 estimate rather than API usage. */
  estimated: boolean
  at: number
}

let snapshot: ContextUsageSnapshot | null = null
const listeners = new Set<() => void>()

export function getContextUsage(): ContextUsageSnapshot | null {
  return snapshot
}

export function setContextUsage(
  next: Omit<ContextUsageSnapshot, 'at'> & { at?: number },
): void {
  snapshot = {
    used: Math.max(0, Math.floor(next.used)),
    limit: Math.max(1, Math.floor(next.limit)),
    modelId: next.modelId,
    configId: next.configId,
    estimated: Boolean(next.estimated),
    at: next.at ?? Date.now(),
  }
  for (const fn of listeners) fn()
}

/** Update limit (and optionally clear used) when the active work model changes. */
export function setContextLimitOnly(args: {
  limit: number
  modelId: string
  configId: string
}): void {
  if (
    snapshot &&
    snapshot.configId === args.configId &&
    snapshot.modelId === args.modelId
  ) {
    snapshot = {
      ...snapshot,
      limit: Math.max(1, Math.floor(args.limit)),
    }
  } else {
    snapshot = {
      used: 0,
      limit: Math.max(1, Math.floor(args.limit)),
      modelId: args.modelId,
      configId: args.configId,
      estimated: false,
      at: Date.now(),
    }
  }
  for (const fn of listeners) fn()
}

export function clearContextUsage(): void {
  snapshot = null
  for (const fn of listeners) fn()
}

export function subscribeContextUsage(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
