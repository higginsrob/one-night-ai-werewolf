import { useCallback, useEffect, useRef } from 'react'
import { loadAiStore, setActiveWorkConfigId } from '../ai/aiStore'
import { clearAgentMemoriesForGame } from '../ai/agent/memory'
import { gameKeyOf } from '../ai/agent/gameKey'
import {
  dayDurationMsFromSettings,
  nightActMsFromSettings,
  type WerewolfHostSettings,
} from '../game/werewolfSettings'
import type { WerewolfRole } from '../game/werewolfTypes'
import type { ClientIntent, SessionSnapshot } from '../net/protocol'
import { EVAL_BANTER_DONE_EVENT } from './evalMode'
import {
  beginEvalSuite,
  captureEvalScenarioFromSnapshot,
  getEvalStore,
  isBenchmarkActive,
  pushCompletedLog,
  resetEvalSuite,
  setEvalStatus,
  setEvalScenario,
} from './evalStore'
import {
  buildBenchmarkDayLog,
  saveBenchmarkLog,
  scenarioMeta,
} from './exportBenchmarkLog'
import { prepareWorkModelSwitch } from './ollamaLifecycle'
import { createBenchmarkScenario } from './scenario'
import { scoreHeuristics } from './scoreHeuristics'
import { scoreWithLlmJudge } from './scoreLlmJudge'

type RoomApi = {
  /** Always read latest — do not close over a React render snapshot. */
  getSnapshot: () => SessionSnapshot
  sendIntent: (intent: ClientIntent) => void
}

type StartArgs = {
  workerConfigIds: string[]
  settings: WerewolfHostSettings
  deck: WerewolfRole[]
  aiProfileIds: string[]
}

/**
 * Orchestrates sequential watch-mode benchmark runs.
 * Mount only when eval mode is active.
 */
export function useBenchmarkRunner(
  room: RoomApi,
  snapshot: SessionSnapshot,
): {
  startBenchmark: (args: StartArgs) => void
  cancelBenchmark: () => void
} {
  const cancelledRef = useRef(false)
  const waitingBanterRef = useRef<{
    resolve: () => void
    gameKey: string
  } | null>(null)
  const prevPhaseRef = useRef<string | null>(null)
  const suiteRef = useRef<{
    workerConfigIds: string[]
    settings: WerewolfHostSettings
    deck: WerewolfRole[]
  } | null>(null)

  // Capture claim/night after first night→day.
  useEffect(() => {
    if (!isBenchmarkActive()) return
    const game = snapshot.game
    const phase = game?.phase ?? null

    if (
      prevPhaseRef.current === 'night' &&
      (phase === 'day' || phase === 'dawn')
    ) {
      captureEvalScenarioFromSnapshot(snapshot)
    }
    if (
      phase === 'reveal' &&
      game?.winners &&
      getEvalStore().scenario &&
      !getEvalStore().scenario?.frozen
    ) {
      captureEvalScenarioFromSnapshot(snapshot)
    }
    prevPhaseRef.current = phase
  }, [snapshot])

  useEffect(() => {
    const onBanter = (ev: Event) => {
      const detail = (ev as CustomEvent<{ gameKey?: string }>).detail
      const waiter = waitingBanterRef.current
      if (!waiter) return
      if (detail?.gameKey && detail.gameKey !== waiter.gameKey) return
      waitingBanterRef.current = null
      waiter.resolve()
    }
    window.addEventListener(EVAL_BANTER_DONE_EVENT, onBanter)
    return () => window.removeEventListener(EVAL_BANTER_DONE_EVENT, onBanter)
  }, [])

  const waitForBanter = useCallback((gameKey: string, timeoutMs = 180_000) => {
    return new Promise<void>((resolve) => {
      waitingBanterRef.current = { resolve, gameKey }
      window.setTimeout(() => {
        if (waitingBanterRef.current?.gameKey === gameKey) {
          waitingBanterRef.current = null
          resolve()
        }
      }, timeoutMs)
    })
  }, [])

  const cancelBenchmark = useCallback(() => {
    cancelledRef.current = true
    waitingBanterRef.current?.resolve()
    waitingBanterRef.current = null
    setEvalStatus({
      phase: 'cancelled',
      message: 'Benchmark cancelled',
    })
    room.sendIntent({ type: 'host.lobby' })
  }, [room])

  const runSuite = useCallback(
    async (args: StartArgs) => {
      cancelledRef.current = false
      const store0 = loadAiStore()
      const groupId = `g${Date.now().toString(36)}`
      const scenario = createBenchmarkScenario({
        roleDeck: args.deck,
        aiProfileIds: args.aiProfileIds,
      })
      beginEvalSuite({
        groupId,
        workerConfigIds: args.workerConfigIds,
        scenario,
      })
      // Seed labels so the Runs list can show pending rows immediately.
      {
        const firstId = args.workerConfigIds[0]
        const first = firstId
          ? store0.modelConfigs.find((c) => c.id === firstId)
          : null
        if (first) {
          setEvalStatus({
            currentWorkerId: first.id,
            currentWorkerLabel: first.label || first.modelId,
          })
        }
      }
      suiteRef.current = {
        workerConfigIds: args.workerConfigIds,
        settings: args.settings,
        deck: args.deck,
      }

      let prevConfigId = store0.activeWorkConfigId

      for (let i = 0; i < args.workerConfigIds.length; i++) {
        if (cancelledRef.current) break
        const workerId = args.workerConfigIds[i]!
        const store = loadAiStore()
        const config = store.modelConfigs.find((c) => c.id === workerId)
        if (!config) {
          setEvalStatus({
            phase: 'error',
            error: `Missing model config ${workerId}`,
            message: 'Benchmark failed',
          })
          return
        }
        const provider = store.providers.find((p) => p.id === config.providerId)
        if (!provider) {
          setEvalStatus({
            phase: 'error',
            error: `Missing provider for ${config.label}`,
            message: 'Benchmark failed',
          })
          return
        }

        const prevConfig = prevConfigId
          ? store.modelConfigs.find((c) => c.id === prevConfigId) ?? null
          : null

        setEvalStatus({
          phase: 'prepareModel',
          runIndex: i,
          currentWorkerId: workerId,
          currentWorkerLabel: config.label || config.modelId,
          message: `Preparing ${config.label || config.modelId}…`,
          error: null,
        })

        try {
          await prepareWorkModelSwitch({
            prevConfig,
            nextConfig: config,
            nextProvider: provider,
            onStatus: (msg) => setEvalStatus({ message: msg }),
          })
        } catch (err) {
          setEvalStatus({
            phase: 'error',
            error: err instanceof Error ? err.message : String(err),
            message: 'Model prepare failed',
          })
          return
        }

        if (cancelledRef.current) break

        setActiveWorkConfigId(workerId)
        prevConfigId = workerId

        setEvalStatus({
          phase: 'probe',
          message: `${config.label || config.modelId} ready — starting watch game`,
        })

        // Return to lobby between runs so start is clean.
        if (room.getSnapshot().phase === 'playing') {
          room.sendIntent({ type: 'host.lobby' })
          await new Promise((r) => setTimeout(r, 400))
        }

        const liveScenario = getEvalStore().scenario
        if (!liveScenario) {
          setEvalStatus({
            phase: 'error',
            error: 'Scenario missing',
            message: 'Benchmark failed',
          })
          return
        }

        setEvalStatus({
          phase: 'runningGame',
          message: `Running watch game (${i + 1}/${args.workerConfigIds.length})…`,
        })

        room.sendIntent({
          type: 'host.start',
          roleDeck: liveScenario.roleDeck,
          nightActMs: nightActMsFromSettings(args.settings),
          dayDurationMs: dayDurationMsFromSettings(args.settings),
          simultaneousNight: true,
          watchMode: true,
          evalDeal: {
            layoutSeed: liveScenario.layoutSeed,
            cards: liveScenario.cards,
          },
        })

        // Wait a tick for gameKey, clear prior memories for this key.
        await new Promise((r) => setTimeout(r, 200))
        const snapAfterStart = room.getSnapshot()
        if (snapAfterStart.game) {
          try {
            clearAgentMemoriesForGame(gameKeyOf(snapAfterStart))
          } catch {
            // ignore
          }
        }

        setEvalStatus({
          phase: 'awaitingBanter',
          message: `Playing with ${config.label || config.modelId} — waiting for outcome…`,
        })

        // Wait until reveal + winners, then banter-done (or timeout).
        const gameKey = await waitUntilReveal(room, () => cancelledRef.current)
        if (cancelledRef.current || !gameKey) break

        captureEvalScenarioFromSnapshot(room.getSnapshot())
        await waitForBanter(gameKey)

        if (cancelledRef.current) break

        setEvalStatus({
          phase: 'exportLog',
          message: 'Building day log…',
        })

        const finalSnap = room.getSnapshot()
        if (!finalSnap.game?.winners) {
          setEvalStatus({
            phase: 'error',
            error: 'Game ended without winners',
            message: 'Benchmark failed',
          })
          return
        }

        const classifierId =
          loadAiStore().activeClassifierConfigId ??
          loadAiStore().activeWorkConfigId

        let log = buildBenchmarkDayLog({
          snapshot: finalSnap,
          meta: scenarioMeta(getEvalStore().scenario!, {
            groupId,
            runIndex: i,
            workerConfigId: workerId,
            workerLabel: config.label || config.modelId,
            classifierConfigId: classifierId,
          }),
        })

        setEvalStatus({
          phase: 'scoring',
          message: 'Scoring chat log…',
        })

        try {
          const heuristic = scoreHeuristics(log)
          const scored = await scoreWithLlmJudge(log, heuristic, {
            onStatus: (msg) => setEvalStatus({ message: msg }),
          })
          log = {
            ...log,
            benchmark: { ...log.benchmark, scores: scored },
          }
        } catch (err) {
          setEvalStatus({
            message: `Scoring issue: ${err instanceof Error ? err.message : String(err)} — saving without LLM scores`,
          })
        }

        setEvalStatus({
          phase: 'exportLog',
          message: `Saving log for ${config.label || config.modelId}…`,
          folderHint: null,
        })

        try {
          const saved = await saveBenchmarkLog(log)
          pushCompletedLog(log)
          setEvalStatus({
            message: `Wrote benchmarks/${saved.filename}`,
          })
        } catch (err) {
          setEvalStatus({
            phase: 'error',
            error: err instanceof Error ? err.message : String(err),
            message: 'Failed to save benchmark log',
          })
          return
        }

        // Brief pause so TTS/UI settle before next model.
        room.sendIntent({ type: 'host.lobby' })
        await new Promise((r) => setTimeout(r, 800))
      }

      if (cancelledRef.current) {
        setEvalStatus({ phase: 'cancelled', message: 'Benchmark cancelled' })
        return
      }

      setEvalStatus({
        phase: 'done',
        message: 'Benchmark complete',
      })
    },
    [room, waitForBanter],
  )

  const startBenchmark = useCallback(
    (args: StartArgs) => {
      if (isBenchmarkActive()) return
      void runSuite(args)
    },
    [runSuite],
  )

  // Expose reset when leaving results if needed
  useEffect(() => {
    return () => {
      // keep store across unmount during HMR
    }
  }, [])

  return { startBenchmark, cancelBenchmark }
}

async function waitUntilReveal(
  room: RoomApi,
  isCancelled: () => boolean,
): Promise<string | null> {
  const start = Date.now()
  const timeoutMs = 45 * 60_000
  while (Date.now() - start < timeoutMs) {
    if (isCancelled()) return null
    const snap = room.getSnapshot()
    if (
      snap.phase === 'playing' &&
      snap.game?.phase === 'reveal' &&
      snap.game.winners
    ) {
      return gameKeyOf(snap)
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  return null
}

export { resetEvalSuite, setEvalScenario }
