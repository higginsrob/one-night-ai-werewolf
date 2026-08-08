import { useCallback, useEffect } from 'react'
import { warmForeverOllamaModels } from '../ai/warmModels'
import { aiPlayersIntentPayload } from '../ai/aiPlayersIntent'
import type { AiPlayerProfile } from '../ai/aiPlayers'
import { setNarratorVoiceURI } from '../game/useHostNarrator'
import { poolIndicesForRoles } from '../game/roles'
import type { WerewolfRole } from '../game/werewolfTypes'
import { useLocalSession } from '../net/localSession'
import { useDayChatDriver } from '../net/useDayChatDriver'
import { useNpcDriver } from '../net/useNpcDriver'
import { BenchmarkSite } from './BenchmarkSite'
import type { BenchmarkRunConfig } from './BenchmarkRunForm'
import { resetEvalSuite } from './evalStore'
import { useBenchmarkRunner } from './useBenchmarkRunner'

/**
 * Slim host for `/benchmark.html`: local session + AI drivers + benchmark UI.
 * No lobby 3D / settings chrome.
 */
export default function BenchmarkApp() {
  const room = useLocalSession()

  const { startBenchmark, cancelBenchmark } = useBenchmarkRunner(
    {
      getSnapshot: room.getSnapshot,
      sendIntent: room.sendIntent,
    },
    room.snapshot,
  )

  useNpcDriver({
    enabled: true,
    snapshot: room.snapshot,
    injectIntent: room.injectIntent,
  })
  useDayChatDriver({
    enabled: true,
    snapshot: room.snapshot,
    injectIntent: room.injectIntent,
  })

  useEffect(() => {
    warmForeverOllamaModels()
  }, [])

  const onApplyCast = useCallback(
    (profiles: AiPlayerProfile[], deck: WerewolfRole[]) => {
      if (room.getSnapshot().phase === 'playing') {
        room.sendIntent({ type: 'host.lobby' })
      }
      room.sendIntent({
        type: 'host.setAiPlayers',
        players: aiPlayersIntentPayload(profiles),
      })
      room.sendIntent({
        type: 'host.setWerewolfDeck',
        poolIndices: poolIndicesForRoles(deck),
      })
    },
    [room],
  )

  const onStart = useCallback(
    (config: BenchmarkRunConfig) => {
      setNarratorVoiceURI(config.settings.voiceURI)
      // Let setAiPlayers / deck intents settle before the suite starts games.
      window.setTimeout(() => startBenchmark(config), 50)
    },
    [startBenchmark],
  )

  const onCancel = useCallback(() => {
    cancelBenchmark()
    resetEvalSuite()
  }, [cancelBenchmark])

  return (
    <BenchmarkSite
      onStart={onStart}
      onCancel={onCancel}
      onApplyCast={onApplyCast}
      snapshot={room.snapshot}
      localClientId={room.clientId}
      sendIntent={room.sendIntent}
    />
  )
}
