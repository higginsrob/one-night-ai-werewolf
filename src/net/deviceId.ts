const STORAGE_KEY = 'onw:deviceId'

/** Stable per-browser id so reconnects can resume the same player profile. */
export function getOrCreateDeviceId(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEY)?.trim()
    if (existing) return existing
    const id = `d_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
    localStorage.setItem(STORAGE_KEY, id)
    return id
  } catch {
    return `d_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  }
}
