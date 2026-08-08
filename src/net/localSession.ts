import { useCallback, useEffect, useRef, useState } from 'react'
import { cancelHostNarration } from '../game/useHostNarrator'
import {
  createInitialSnapshot,
  reduceIntent,
} from '../session/sessionStore'
import { nextColor } from '../session/colorPalette'
import type { ClientId } from '../session/types'
import { getOrCreateDeviceId } from './deviceId'
import { loadLocalProfile } from './localProfile'
import type { ClientIntent, SessionSnapshot } from './protocol'
import { normalizeSceneVisuals } from '../scene/sceneVisuals'

function randomSessionSeed(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export type LocalSessionApi = {
  role: 'host'
  status: 'connected'
  clientId: ClientId
  error: string | null
  snapshot: SessionSnapshot
  /** Latest snapshot (sync after intents) — prefer over closed-over `snapshot`. */
  getSnapshot: () => SessionSnapshot
  sendIntent: (intent: ClientIntent) => void
  /** Apply an intent as another client (NPC auto-play). */
  injectIntent: (from: ClientId, intent: ClientIntent) => void
  setCardPhoto: (photoDataUrl: string | null) => void
}

function uidClient(): ClientId {
  return `c_${Math.random().toString(36).slice(2, 10)}`
}

function buildInitialSnapshot(): {
  snapshot: SessionSnapshot
  clientId: ClientId
} {
  const profile = loadLocalProfile()
  const clientId = uidClient()
  const deviceId = getOrCreateDeviceId()
  const peerId = `local_${deviceId.slice(0, 12)}`
  const name = profile.name.trim().slice(0, 40) || 'Player'
  const snapshot = createInitialSnapshot({
    sessionSeed: randomSessionSeed(),
    hostGeneration: 0,
    hostPeerId: peerId,
    roomCode: 'LOCAL',
    host: {
      id: clientId,
      name,
      peerId,
      color: nextColor(new Set()),
      deviceId,
      photoDataUrl: profile.photoDataUrl,
      emoticonPhotos: {},
      mediaFilter: 'none',
    },
  })
  return {
    clientId,
    snapshot: {
      ...snapshot,
      sceneVisuals: normalizeSceneVisuals(snapshot.sceneVisuals),
    },
  }
}

export function useLocalSession(): LocalSessionApi {
  const boot = useRef(buildInitialSnapshot()).current
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(boot.snapshot)
  const [error] = useState<string | null>(null)

  const clientId = boot.clientId
  const snapshotRef = useRef(snapshot)
  const clientIdRef = useRef(clientId)

  snapshotRef.current = snapshot
  clientIdRef.current = clientId

  const pushSnapshot = useCallback((next: SessionSnapshot) => {
    const normalized: SessionSnapshot = {
      ...next,
      variantId: next.variantId ?? null,
      werewolfDeck: next.werewolfDeck ?? null,
      anyoneCanGameAdmin: Boolean(next.anyoneCanGameAdmin),
      sceneVisuals: normalizeSceneVisuals(next.sceneVisuals),
      chatLines: Array.isArray(next.chatLines) ? next.chatLines : [],
      chatLocked: Boolean(next.chatLocked),
      chatRespondingId:
        typeof next.chatRespondingId === 'string' ? next.chatRespondingId : null,
      watchMode: Boolean(next.watchMode),
    }
    snapshotRef.current = normalized
    setSnapshot(normalized)
  }, [])

  const applyIntent = useCallback(
    (from: ClientId, intent: ClientIntent) => {
      const cur = snapshotRef.current
      const next = reduceIntent(cur, from, intent)
      pushSnapshot(next)
    },
    [pushSnapshot],
  )

  const sendIntent = useCallback(
    (intent: ClientIntent) => {
      applyIntent(clientIdRef.current, intent)
    },
    [applyIntent],
  )

  const injectIntent = useCallback(
    (from: ClientId, intent: ClientIntent) => {
      applyIntent(from, intent)
    },
    [applyIntent],
  )

  const setCardPhoto = useCallback(
    (photoDataUrl: string | null) => {
      const next =
        typeof photoDataUrl === 'string' && photoDataUrl.trim()
          ? photoDataUrl
          : null
      sendIntent({ type: 'profile.setPhoto', photoDataUrl: next })
    },
    [sendIntent],
  )

  useEffect(() => {
    return () => {
      cancelHostNarration()
    }
  }, [])

  return {
    role: 'host',
    status: 'connected',
    clientId,
    error,
    snapshot,
    getSnapshot: () => snapshotRef.current,
    sendIntent,
    injectIntent,
    setCardPhoto,
  }
}
