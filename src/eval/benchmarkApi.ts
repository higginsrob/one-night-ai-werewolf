/** Load / save helpers for local DEV benchmark logs under ./benchmarks/. */

import type { DayPhaseLogV4 } from './exportBenchmarkLog'

export function isBenchLog(raw: unknown): raw is DayPhaseLogV4 {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>
  return (
    (o.kind === 'onw-day-phase-log' || o.version === 4 || o.version === 3) &&
    Array.isArray(o.dayChat) &&
    typeof o.table === 'object'
  )
}

export function asV4(log: DayPhaseLogV4): DayPhaseLogV4 {
  if (log.version === 4 && log.benchmark && log.replay) return log
  return {
    ...log,
    version: 4,
    benchmark: log.benchmark ?? {
      groupId: 'offline',
      runIndex: 0,
      workerConfigId: log.harness?.workModel?.configId ?? 'unknown',
      workerLabel:
        log.harness?.workModel?.configLabel ??
        log.harness?.workModel?.modelId ??
        'unknown',
      classifierConfigId: log.harness?.classifierModel?.configId ?? null,
      scenarioId: 'offline',
      scenarioDigest: 'offline',
    },
    replay: log.replay ?? {
      layoutSeed: 1,
      playerIds: log.table.players.map((p) => p.id),
      playerNames: Object.fromEntries(
        log.table.players.map((p) => [p.id, p.name]),
      ),
      roleDeck: [],
      cards: [],
      dealtRoles: Object.fromEntries(
        log.table.players.map((p) => [p.id, p.dealtRole ?? '']),
      ),
      roles: Object.fromEntries(
        log.table.players.map((p) => [p.id, p.finalRole ?? '']),
      ),
      dealtCenter: log.table.dealtCenter,
      center: log.table.finalCenter,
      nightActions: log.table.nightActions,
      votes: Object.fromEntries(
        log.table.players
          .filter((p) => p.voteTargetId)
          .map((p) => [p.id, p.voteTargetId!]),
      ),
      killedIds: log.outcome.killedIds,
      hunterKillId: log.outcome.hunterKillId,
      winners: log.outcome.winners,
      winMessage: log.outcome.winMessage,
      simultaneousNight: true,
    },
  }
}

export async function fetchBenchmarkFileList(): Promise<string[]> {
  const res = await fetch('/__onw/benchmarks', { cache: 'no-store' })
  if (!res.ok) throw new Error(`List failed: ${res.statusText}`)
  const data = (await res.json()) as { files?: unknown }
  if (!Array.isArray(data.files)) return []
  return data.files.filter(
    (f): f is string => typeof f === 'string' && f.endsWith('.json'),
  )
}

export async function fetchBenchmarkLog(
  filename: string,
): Promise<DayPhaseLogV4 | null> {
  const res = await fetch(
    `/__onw/benchmarks/${encodeURIComponent(filename)}`,
    { cache: 'no-store' },
  )
  if (!res.ok) return null
  const parsed = (await res.json()) as unknown
  if (!isBenchLog(parsed)) return null
  return asV4(parsed)
}

export async function loadAllBenchmarkLogs(): Promise<DayPhaseLogV4[]> {
  const files = await fetchBenchmarkFileList()
  const logs: DayPhaseLogV4[] = []
  for (const file of files) {
    const log = await fetchBenchmarkLog(file)
    if (log) logs.push(log)
  }
  return logs
}

/** Delete every `onw-bench-*.json` under ./benchmarks/ (DEV API). */
export async function clearAllBenchmarkLogs(): Promise<number> {
  const res = await fetch('/__onw/benchmarks', {
    method: 'DELETE',
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Clear failed: ${res.statusText}`)
  const data = (await res.json()) as { deleted?: unknown }
  return typeof data.deleted === 'number' ? data.deleted : 0
}
