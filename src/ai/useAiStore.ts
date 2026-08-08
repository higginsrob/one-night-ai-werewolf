import { useEffect, useState } from 'react'
import { loadTtsStore } from '../game/ttsStore'
import {
  loadAiStore,
  subscribeAiStore,
  subscribeAiStoreEvents,
} from './aiStore'
import type { AiStorePersisted } from './types'

export function useAiStore(): AiStorePersisted {
  // Side effect: migrate legacy TTS providers into the AI store on first paint.
  const [store, setStore] = useState(() => {
    loadTtsStore()
    return loadAiStore()
  })
  useEffect(() => {
    const refresh = () => setStore(loadAiStore())
    const unsub = subscribeAiStore(refresh)
    const unsubEvents = subscribeAiStoreEvents(refresh)
    return () => {
      unsub()
      unsubEvents()
    }
  }, [])
  return store
}
