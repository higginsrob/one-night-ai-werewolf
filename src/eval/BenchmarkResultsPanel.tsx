import { useEffect, useMemo, useState } from 'react'
import { loadAiStore } from '../ai/aiStore'
import type { ClientIntent, SessionSnapshot } from '../net/protocol'
import type { ClientId } from '../session/types'
import { clearAllBenchmarkLogs } from './benchmarkApi'
import {
  BenchmarkLiveWatch,
  BenchmarkNarratorHost,
} from './BenchmarkLiveWatch'
import type { DayPhaseLogV4 } from './exportBenchmarkLog'
import {
  EvalBarChart,
  EvalRadar,
  STAT_KEYS,
  type ModelAvgRow,
  type StatKey,
} from './EvalCharts'
import {
  getEvalStore,
  isBenchmarkActive,
  subscribeEvalStore,
  type BenchmarkStatus,
} from './evalStore'
import type { PlayerScoreBundle, ScoreDimensions } from './scoreTypes'
import { EMPTY_SCORES } from './scoreTypes'

type StatMode = 'all' | StatKey

function activeStats(mode: StatMode): StatKey[] {
  return mode === 'all' ? [...STAT_KEYS] : [mode]
}

function bundleDims(b: PlayerScoreBundle): ScoreDimensions {
  if (b.llm) {
    return {
      rulesAccuracy:
        b.heuristic.rulesAccuracy * 0.6 + b.llm.rulesAccuracy * 0.4,
      creativity: b.llm.creativity,
      deception: b.heuristic.deception * 0.4 + b.llm.deception * 0.6,
      interviewing:
        b.heuristic.interviewing * 0.4 + b.llm.interviewing * 0.6,
      persuasion: b.llm.persuasion,
    }
  }
  return { ...b.heuristic }
}

function meanDims(bundles: PlayerScoreBundle[]): ScoreDimensions {
  if (bundles.length === 0) return { ...EMPTY_SCORES }
  const acc = { ...EMPTY_SCORES }
  const keys = Object.keys(acc) as Array<keyof ScoreDimensions>
  for (const b of bundles) {
    const src = bundleDims(b)
    for (const k of keys) acc[k] += src[k]
  }
  for (const k of keys) acc[k] = acc[k] / bundles.length
  return acc
}

function reduceNums(values: number[], mode: StatKey): number {
  if (values.length === 0) return 0
  if (mode === 'min') return Math.min(...values)
  if (mode === 'max') return Math.max(...values)
  return values.reduce((s, v) => s + v, 0) / values.length
}

function reduceDims(
  rows: ScoreDimensions[],
  mode: StatKey,
): ScoreDimensions {
  const keys = Object.keys(EMPTY_SCORES) as Array<keyof ScoreDimensions>
  const out = { ...EMPTY_SCORES }
  for (const k of keys) {
    out[k] = reduceNums(
      rows.map((r) => r[k]),
      mode,
    )
  }
  return out
}

/** Actual model id used by the worker config (not the config label). */
export function logModelId(log: DayPhaseLogV4): string {
  const fromHarness = log.harness?.workModel?.modelId?.trim()
  if (fromHarness) return fromHarness
  const cfg = loadAiStore().modelConfigs.find(
    (c) => c.id === log.benchmark.workerConfigId,
  )
  if (cfg?.modelId?.trim()) return cfg.modelId.trim()
  return log.benchmark.workerLabel || 'unknown'
}

function runKey(log: DayPhaseLogV4): string {
  return `${log.benchmark.groupId}:${log.benchmark.runIndex}:${log.exportedAt}`
}

function runOptionLabel(log: DayPhaseLogV4): string {
  const when = log.exportedAt
    ? new Date(log.exportedAt).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—'
  return `#${log.benchmark.runIndex} · ${log.outcome.winners} · ${when}`
}

type RunPoint = {
  overall: number
  dims: ScoreDimensions
  villageWin: boolean
}

function runPoint(log: DayPhaseLogV4): RunPoint {
  const scores = log.benchmark.scores ?? []
  const dims = meanDims(scores)
  const overall =
    scores.length === 0
      ? 0
      : scores.reduce((s, b) => s + b.overall, 0) / scores.length
  const villageWin =
    log.outcome.winners === 'village' ||
    log.outcome.winners === 'village_and_tanner'
  return { overall, dims, villageWin }
}

function chartRowsFor(logs: DayPhaseLogV4[]): ModelAvgRow[] {
  const byModel = new Map<string, DayPhaseLogV4[]>()
  for (const l of logs) {
    const key = logModelId(l)
    const arr = byModel.get(key) ?? []
    arr.push(l)
    byModel.set(key, arr)
  }
  return [...byModel.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([model, runs]) => {
      const points = runs.map(runPoint)
      const overalls = points.map((p) => p.overall)
      const dimRows = points.map((p) => p.dims)
      const villageWins = points.filter((p) => p.villageWin).length
      const byStat = Object.fromEntries(
        STAT_KEYS.map((mode) => [
          mode,
          {
            overall: reduceNums(overalls, mode),
            dims: reduceDims(dimRows, mode),
          },
        ]),
      ) as ModelAvgRow['byStat']
      return {
        model,
        runs: runs.length,
        byStat,
        winRate: runs.length ? villageWins / runs.length : 0,
      }
    })
}

type Props = {
  logs: DayPhaseLogV4[]
  loading?: boolean
  error?: string | null
  onRefresh?: () => void
  snapshot: SessionSnapshot
  localClientId: ClientId
  sendIntent: (intent: ClientIntent) => void
}

export function BenchmarkResultsPanel({
  logs,
  loading,
  error,
  onRefresh,
  snapshot,
  localClientId,
  sendIntent,
}: Props) {
  const [statMode, setStatMode] = useState<StatMode>('all')
  const [modelFilter, setModelFilter] = useState<string>('all')
  const [runFilter, setRunFilter] = useState<string>('all')
  const [status, setStatus] = useState<BenchmarkStatus>(
    () => getEvalStore().status,
  )
  const [clearing, setClearing] = useState(false)
  const [clearError, setClearError] = useState<string | null>(null)

  useEffect(() => {
    return subscribeEvalStore(() => setStatus(getEvalStore().status))
  }, [])

  const modelIds = useMemo(() => {
    const set = new Set(logs.map(logModelId))
    return [...set].sort()
  }, [logs])

  const runsForModel = useMemo(() => {
    if (modelFilter === 'all') return []
    return logs
      .filter((l) => logModelId(l) === modelFilter)
      .slice()
      .reverse()
  }, [logs, modelFilter])

  // Reset run filter when model changes or the selected run disappears.
  useEffect(() => {
    if (modelFilter === 'all') {
      setRunFilter('all')
      return
    }
    if (
      runFilter !== 'all' &&
      !runsForModel.some((l) => runKey(l) === runFilter)
    ) {
      setRunFilter('all')
    }
  }, [modelFilter, runFilter, runsForModel])

  const filteredLogs = useMemo(() => {
    let next = logs
    if (modelFilter !== 'all') {
      next = next.filter((l) => logModelId(l) === modelFilter)
    }
    if (runFilter !== 'all') {
      next = next.filter((l) => runKey(l) === runFilter)
    }
    return next
  }, [logs, modelFilter, runFilter])

  const chartRows = useMemo(() => chartRowsFor(filteredLogs), [filteredLogs])
  const chartStats = activeStats(statMode)

  const suiteActive = isBenchmarkActive()
  const liveWatch =
    suiteActive &&
    (status.phase === 'runningGame' ||
      status.phase === 'awaitingBanter' ||
      status.phase === 'prepareModel' ||
      status.phase === 'probe' ||
      snapshot.phase === 'playing')

  const needHiddenNarrator =
    suiteActive &&
    snapshot.phase === 'playing' &&
    Boolean(snapshot.game) &&
    !liveWatch

  const canClear = !suiteActive && !clearing && logs.length > 0

  const onClearAll = async () => {
    if (!canClear) return
    if (
      !window.confirm(
        `Delete all ${logs.length} benchmark log${logs.length === 1 ? '' : 's'} from benchmarks/?`,
      )
    ) {
      return
    }
    setClearing(true)
    setClearError(null)
    try {
      await clearAllBenchmarkLogs()
      setModelFilter('all')
      setRunFilter('all')
      onRefresh?.()
    } catch (err) {
      setClearError(err instanceof Error ? err.message : String(err))
    } finally {
      setClearing(false)
    }
  }

  const statTitle =
    statMode === 'all'
      ? 'min / avg / max'
      : statMode === 'min'
        ? 'min'
        : statMode === 'max'
          ? 'max'
          : 'avg'
  const chartHeading =
    runFilter !== 'all'
      ? `Run scores (${statTitle})`
      : statMode === 'all'
        ? 'Suite min / avg / max'
        : `Suite ${statTitle === 'avg' ? 'averages' : statTitle}`

  return (
    <div className="bench-results">
      {needHiddenNarrator && (
        <BenchmarkNarratorHost
          snapshot={snapshot}
          localClientId={localClientId}
          sendIntent={sendIntent}
        />
      )}

      <div className="bench-results-toolbar">
        <p className="bench-results-meta">
          {loading
            ? 'Loading…'
            : `${logs.length} log${logs.length === 1 ? '' : 's'} in benchmarks/`}
        </p>
        <div className="btn-row">
          {onRefresh && (
            <button type="button" className="btn tiny" onClick={onRefresh}>
              Refresh
            </button>
          )}
          <button
            type="button"
            className="btn tiny"
            disabled={!canClear}
            title={
              suiteActive
                ? 'Cancel the suite before clearing'
                : 'Delete all logs in benchmarks/'
            }
            onClick={() => void onClearAll()}
          >
            {clearing ? 'Clearing…' : 'Clear all'}
          </button>
        </div>
      </div>

      {(error || clearError) && (
        <p className="bench-error" role="alert">
          {error || clearError}
        </p>
      )}

      <section className="eval-filters">
        <label>
          Stat
          <select
            value={statMode}
            onChange={(e) => setStatMode(e.target.value as StatMode)}
          >
            <option value="all">All</option>
            <option value="min">Min</option>
            <option value="avg">Avg</option>
            <option value="max">Max</option>
          </select>
        </label>
        <label>
          Model
          <select
            value={modelFilter}
            onChange={(e) => {
              setModelFilter(e.target.value)
              setRunFilter('all')
            }}
          >
            <option value="all">All models</option>
            {modelIds.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          Runs
          <select
            value={runFilter}
            disabled={modelFilter === 'all'}
            onChange={(e) => setRunFilter(e.target.value)}
            title={
              modelFilter === 'all'
                ? 'Pick a model to filter runs'
                : undefined
            }
          >
            <option value="all">All runs</option>
            {runsForModel.map((l) => (
              <option key={runKey(l)} value={runKey(l)}>
                {runOptionLabel(l)}
              </option>
            ))}
          </select>
        </label>
      </section>

      {liveWatch && (
        <BenchmarkLiveWatch
          snapshot={snapshot}
          localClientId={localClientId}
          sendIntent={sendIntent}
          statusMessage={status.message}
          workerLabel={status.currentWorkerLabel}
        />
      )}

      {logs.length === 0 && !liveWatch ? (
        <p className="hint">
          No logs yet — configure a suite on the right and run benchmarks.
        </p>
      ) : null}

      {chartRows.length > 0 && (
        <section className="eval-suite-charts">
          <h2>{chartHeading}</h2>
          <div className="eval-charts-row">
            <EvalBarChart
              rows={chartRows}
              metric="overall"
              stats={chartStats}
              title={`Overall by model (${statTitle})`}
            />
            <EvalBarChart
              rows={chartRows}
              metric="rulesAccuracy"
              stats={chartStats}
              title={`Rules accuracy (${statTitle})`}
            />
            <EvalBarChart
              rows={chartRows}
              metric="creativity"
              stats={chartStats}
              title={`Creativity (${statTitle})`}
            />
            <EvalBarChart
              rows={chartRows}
              metric="deception"
              stats={chartStats}
              title={`Deception (${statTitle})`}
            />
            <EvalBarChart
              rows={chartRows}
              metric="interviewing"
              stats={chartStats}
              title={`Interviewing (${statTitle})`}
            />
            <EvalBarChart
              rows={chartRows}
              metric="persuasion"
              stats={chartStats}
              title={`Persuasion (${statTitle})`}
            />
          </div>
          <div className="eval-win-rates">
            {chartRows.map((a) => (
              <span key={a.model}>
                {a.model}: {(a.winRate * 100).toFixed(0)}% village wins ·{' '}
                {a.runs} run{a.runs === 1 ? '' : 's'}
              </span>
            ))}
          </div>
          {chartRows.map((row) => (
            <EvalRadar
              key={row.model}
              byStat={{
                min: row.byStat.min.dims,
                avg: row.byStat.avg.dims,
                max: row.byStat.max.dims,
              }}
              stats={chartStats}
              title={`Radar — ${row.model} (${statTitle})`}
            />
          ))}
        </section>
      )}
    </div>
  )
}
