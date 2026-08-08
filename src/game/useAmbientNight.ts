import { useEffect, useState } from 'react'
import { setAmbientNightActive } from './ambientNight'
import {
  loadWerewolfSettings,
  subscribeWerewolfSettings,
} from './werewolfSettings'
import type { SessionSnapshot } from '../net/protocol'

/** Quiet cricket bed (+ rare owl) while in the lobby or live night phase. */
export function useAmbientNight(snapshot: SessionSnapshot): void {
  const [envEnabled, setEnvEnabled] = useState(
    () => loadWerewolfSettings().environmentSoundsEnabled,
  )

  useEffect(() => {
    return subscribeWerewolfSettings(() => {
      setEnvEnabled(loadWerewolfSettings().environmentSoundsEnabled)
    })
  }, [])

  const inLobby = snapshot.phase === 'lobby'
  const inNight = snapshot.game?.phase === 'night'
  const active = envEnabled && (inLobby || Boolean(inNight))

  useEffect(() => {
    setAmbientNightActive(active)
  }, [active])

  useEffect(() => {
    return () => {
      setAmbientNightActive(false)
    }
  }, [])
}
