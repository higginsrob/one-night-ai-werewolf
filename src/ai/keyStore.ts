/** In-memory API keys — never written to localStorage / disk. */
const keys = new Map<string, string>()

export function setProviderApiKey(providerId: string, key: string): void {
  const trimmed = key.trim()
  if (!trimmed) keys.delete(providerId)
  else keys.set(providerId, trimmed)
}

export function getProviderApiKey(providerId: string): string | null {
  return keys.get(providerId) ?? null
}

export function clearProviderApiKey(providerId: string): void {
  keys.delete(providerId)
}

export function clearAllProviderApiKeys(): void {
  keys.clear()
}

export function hasProviderApiKey(providerId: string): boolean {
  return Boolean(keys.get(providerId)?.trim())
}
