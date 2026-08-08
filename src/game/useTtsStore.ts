import { useEffect, useState } from 'react'
import {
  loadTtsStore,
  subscribeTtsStore,
  subscribeTtsStoreEvents,
} from './ttsStore'
import type { TtsStorePersisted } from './ttsTypes'

export function useTtsStore(): TtsStorePersisted {
  const [store, setStore] = useState(() => loadTtsStore())
  useEffect(() => {
    const refresh = () => setStore(loadTtsStore())
    const unsub = subscribeTtsStore(refresh)
    const unsubEvents = subscribeTtsStoreEvents(refresh)
    return () => {
      unsub()
      unsubEvents()
    }
  }, [])
  return store
}
