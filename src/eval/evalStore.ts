import type { SessionSnapshot } from '../net/protocol'
import type { ClientIntent } from '../net/protocol'
import type { ClientId } from '../session/types'
import { mulberry32 } from './seededRng'
import {
  evalForcedIntent,
  freezeScenarioFromGame,
  type BenchmarkScenario,
} from './scenario'

export type BenchmarkPhase =
  | 'idle'
  | 'prepareModel'
  | 'probe'
  | 'runningGame'
  | 'awaitingBanter'
  | 'exportLog'
  | 'scoring'
  | 'done'
  | 'error'
  | 'cancelled'

export type BenchmarkStatus = {
  phase: BenchmarkPhase
  groupId: string | null
  workerConfigIds: string[]
  runIndex: number
  totalRuns: number
  currentWorkerId: string | null
  currentWorkerLabel: string | null
  message: string
  error: string | null
  /** Optional status hint (e.g. save path). */
  folderHint: string | null
}

export type EvalStoreState = {
  status: BenchmarkStatus
  scenario: BenchmarkScenario | null
  /** Seeded RNG for first-run claim/night; null after freeze. */
  runRand: (() => number) | null
  completedLogs: unknown[]
  /** Legacy flag; benchmark site reads logs from disk instead. */
  showResults: boolean
}

const LISTENERS_KEY = '__onwEvalListeners__'

type Listener = () => void

function getListeners(): Set<Listener> {
  const g = globalThis as typeof globalThis & {
    [LISTENERS_KEY]?: Set<Listener>
  }
  if (!g[LISTENERS_KEY]) g[LISTENERS_KEY] = new Set()
  return g[LISTENERS_KEY]
}

function notify() {
  for (const l of getListeners()) l()
}

const idleStatus = (): BenchmarkStatus => ({
  phase: 'idle',
  groupId: null,
  workerConfigIds: [],
  runIndex: 0,
  totalRuns: 0,
  currentWorkerId: null,
  currentWorkerLabel: null,
  message: '',
  error: null,
  folderHint: null,
})

let state: EvalStoreState = {
  status: idleStatus(),
  scenario: null,
  runRand: null,
  completedLogs: [],
  showResults: false,
}

export function subscribeEvalStore(listener: Listener): () => void {
  const listeners = getListeners()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getEvalStore(): EvalStoreState {
  return state
}

export function isBenchmarkActive(): boolean {
  const p = state.status.phase
  return (
    p !== 'idle' &&
    p !== 'done' &&
    p !== 'error' &&
    p !== 'cancelled'
  )
}

export function setEvalStatus(partial: Partial<BenchmarkStatus>): void {
  state = {
    ...state,
    status: { ...state.status, ...partial },
  }
  notify()
}

export function setEvalScenario(scenario: BenchmarkScenario | null): void {
  state = {
    ...state,
    scenario,
    runRand: scenario
      ? mulberry32(scenario.layoutSeed ^ 0x9e3779b9)
      : null,
  }
  notify()
}

export function captureEvalScenarioFromSnapshot(snapshot: SessionSnapshot): void {
  const game = snapshot.game
  if (!game || !state.scenario || state.scenario.frozen) return
  if (game.phase !== 'day' && game.phase !== 'reveal') return
  const next = freezeScenarioFromGame(state.scenario, game)
  state = {
    ...state,
    scenario: next,
    runRand: null,
  }
  notify()
}

export function resetEvalSuite(): void {
  state = {
    status: idleStatus(),
    scenario: null,
    runRand: null,
    completedLogs: [],
    showResults: false,
  }
  notify()
}

export function beginEvalSuite(args: {
  groupId: string
  workerConfigIds: string[]
  scenario: BenchmarkScenario
}): void {
  state = {
    status: {
      phase: 'prepareModel',
      groupId: args.groupId,
      workerConfigIds: args.workerConfigIds,
      runIndex: 0,
      totalRuns: args.workerConfigIds.length,
      currentWorkerId: args.workerConfigIds[0] ?? null,
      currentWorkerLabel: null,
      message: 'Starting benchmark…',
      error: null,
      folderHint: 'Writing logs to benchmarks/',
    },
    scenario: args.scenario,
    runRand: mulberry32(args.scenario.layoutSeed ^ 0x9e3779b9),
    completedLogs: [],
    showResults: false,
  }
  notify()
}

export function pushCompletedLog(log: unknown): void {
  state = {
    ...state,
    completedLogs: [...state.completedLogs, log],
  }
  notify()
}

export function openEvalResults(): void {
  state = { ...state, showResults: true }
  notify()
}

export function closeEvalResults(): void {
  state = { ...state, showResults: false }
  notify()
}

export function setShowResultsFromOffline(logs: unknown[]): void {
  state = {
    ...state,
    completedLogs: logs,
    showResults: true,
    status: {
      ...idleStatus(),
      phase: 'done',
      message: 'Loaded offline logs',
    },
  }
  notify()
}

/** Claim/night forced intent while a suite is running. */
export function getEvalForcedIntent(
  game: NonNullable<SessionSnapshot['game']>,
  npcId: ClientId,
): ClientIntent | null {
  if (!isBenchmarkActive()) return null
  return evalForcedIntent({
    scenario: state.scenario,
    game,
    npcId,
    rand: state.runRand,
  })
}
