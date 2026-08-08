import * as THREE from 'three'

/** Live world-space centers of 3D player cards (OrbitFocusController). */
const byId = new Map<string, THREE.Vector3>()

/** Click-selected player card to frame; null = table center. */
let focusPlayerId: string | null = null
const focusListeners = new Set<(id: string | null) => void>()

export function publishPlayerCardFocus(
  id: string,
  x: number,
  y: number,
  z: number,
): void {
  let v = byId.get(id)
  if (!v) {
    v = new THREE.Vector3()
    byId.set(id, v)
  }
  v.set(x, y, z)
}

export function clearPlayerCardFocus(id: string): void {
  byId.delete(id)
  if (focusPlayerId === id) setOrbitFocusPlayerId(null)
}

export function readPlayerCardFocus(id: string, out: THREE.Vector3): boolean {
  const v = byId.get(id)
  if (!v) return false
  out.copy(v)
  return true
}

/** Iterate live published player-card world centers (auto-camera framing). */
export function forEachPlayerCardFocus(
  fn: (id: string, center: THREE.Vector3) => void,
): void {
  for (const [id, v] of byId) fn(id, v)
}

export function getOrbitFocusPlayerId(): string | null {
  return focusPlayerId
}

export function setOrbitFocusPlayerId(id: string | null): void {
  const next = typeof id === 'string' && id.trim() ? id.trim() : null
  if (focusPlayerId === next) return
  focusPlayerId = next
  for (const fn of focusListeners) fn(focusPlayerId)
}

export function clearOrbitFocus(): void {
  setOrbitFocusPlayerId(null)
}

export function subscribeOrbitFocusPlayerId(
  fn: (id: string | null) => void,
): () => void {
  focusListeners.add(fn)
  fn(focusPlayerId)
  return () => {
    focusListeners.delete(fn)
  }
}
