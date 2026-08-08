import type { WerewolfSnapshot } from '../game/werewolfTypes'
import type { DayPhaseLog } from '../ai/agent/exportDayLog'
import { buildDayPhaseLog } from '../ai/agent/exportDayLog'
import type { SessionSnapshot } from '../net/protocol'
import type { BenchmarkScenario } from './scenario'
import type { PlayerScoreBundle } from './scoreTypes'

export type BenchmarkReplayPayload = {
  layoutSeed: number
  playerIds: string[]
  playerNames: Record<string, string>
  roleDeck: string[]
  cards: Array<{ id: string; role: string; claimBy: string | null }>
  dealtRoles: Record<string, string>
  roles: Record<string, string>
  dealtCenter: string[]
  center: string[]
  nightActions: WerewolfSnapshot['nightActions']
  votes: Record<string, string>
  killedIds: string[]
  hunterKillId: string | null
  winners: WerewolfSnapshot['winners']
  winMessage: string | null
  simultaneousNight: boolean
}

export type BenchmarkLogMeta = {
  groupId: string
  runIndex: number
  workerConfigId: string
  workerLabel: string
  classifierConfigId: string | null
  scenarioId: string
  scenarioDigest: string
}

export type DayPhaseLogV4 = Omit<DayPhaseLog, 'version'> & {
  version: 4
  benchmark: BenchmarkLogMeta & {
    scores?: PlayerScoreBundle[]
  }
  replay: BenchmarkReplayPayload
}

export function buildReplayPayload(
  snapshot: SessionSnapshot,
): BenchmarkReplayPayload {
  const game = snapshot.game
  if (!game) throw new Error('No game for replay payload')
  return {
    layoutSeed: game.layoutSeed,
    playerIds: [...game.playerIds],
    playerNames: { ...game.playerNames },
    roleDeck: [...game.roleDeck],
    cards: game.cards.map((c) => ({
      id: c.id,
      role: c.role,
      claimBy: c.claimBy,
    })),
    dealtRoles: { ...game.dealtRoles },
    roles: { ...game.roles },
    dealtCenter: [...game.dealtCenter],
    center: [...game.center],
    nightActions: game.nightActions,
    votes: { ...game.votes },
    killedIds: [...game.killedIds],
    hunterKillId: game.hunterKillId,
    winners: game.winners,
    winMessage: game.winMessage,
    simultaneousNight: game.simultaneousNight,
  }
}

export function buildBenchmarkDayLog(args: {
  snapshot: SessionSnapshot
  meta: BenchmarkLogMeta
  scores?: PlayerScoreBundle[]
}): DayPhaseLogV4 {
  const base = buildDayPhaseLog(args.snapshot)
  return {
    ...base,
    version: 4,
    benchmark: {
      ...args.meta,
      ...(args.scores ? { scores: args.scores } : {}),
    },
    replay: buildReplayPayload(args.snapshot),
  }
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'model'
}

export function benchmarkLogFilename(meta: BenchmarkLogMeta): string {
  return `onw-bench-${meta.groupId}-${slug(meta.workerLabel)}-${String(meta.runIndex).padStart(2, '0')}.json`
}

/** Write a benchmark log into the local `benchmarks/` folder via the Vite DEV API. */
export async function saveBenchmarkLog(
  log: DayPhaseLogV4,
): Promise<{ method: 'api'; filename: string }> {
  const filename = benchmarkLogFilename(log.benchmark)
  if (!import.meta.env.DEV) {
    throw new Error('Benchmark saves are only available on the Vite dev server')
  }
  const res = await fetch('/__onw/benchmarks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, body: log }),
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const err = (await res.json()) as { error?: string }
      if (err.error) detail = err.error
    } catch {
      // ignore
    }
    throw new Error(`Failed to save ${filename}: ${detail}`)
  }
  return { method: 'api', filename }
}

export function scenarioMeta(
  scenario: BenchmarkScenario,
  args: {
    groupId: string
    runIndex: number
    workerConfigId: string
    workerLabel: string
    classifierConfigId: string | null
  },
): BenchmarkLogMeta {
  return {
    groupId: args.groupId,
    runIndex: args.runIndex,
    workerConfigId: args.workerConfigId,
    workerLabel: args.workerLabel,
    classifierConfigId: args.classifierConfigId,
    scenarioId: scenario.id,
    scenarioDigest: scenario.digest,
  }
}
