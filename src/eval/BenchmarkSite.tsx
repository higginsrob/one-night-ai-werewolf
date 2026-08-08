import { useCallback, useEffect, useState } from 'react'
import { APP_NAME } from '../config'
import type { AiPlayerProfile } from '../ai/aiPlayers'
import type { WerewolfRole } from '../game/werewolfTypes'
import type { ClientIntent, SessionSnapshot } from '../net/protocol'
import type { ClientId } from '../session/types'
import { loadAllBenchmarkLogs } from './benchmarkApi'
import { BenchmarkResultsPanel } from './BenchmarkResultsPanel'
import {
  BenchmarkRunForm,
  type BenchmarkRunConfig,
} from './BenchmarkRunForm'
import type { DayPhaseLogV4 } from './exportBenchmarkLog'
import {
  getEvalStore,
  isBenchmarkActive,
  subscribeEvalStore,
  type BenchmarkStatus,
} from './evalStore'

type Props = {
  onStart: (config: BenchmarkRunConfig) => void
  onCancel: () => void
  onApplyCast: (profiles: AiPlayerProfile[], deck: WerewolfRole[]) => void
  snapshot: SessionSnapshot
  localClientId: ClientId
  sendIntent: (intent: ClientIntent) => void
}

export function BenchmarkSite({
  onStart,
  onCancel,
  onApplyCast,
  snapshot,
  localClientId,
  sendIntent,
}: Props) {
  const [logs, setLogs] = useState<DayPhaseLogV4[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [status, setStatus] = useState<BenchmarkStatus>(
    () => getEvalStore().status,
  )

  const refreshLogs = useCallback(async () => {
    try {
      setLoadError(null)
      const next = await loadAllBenchmarkLogs()
      setLogs(next)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshLogs()
  }, [refreshLogs])

  useEffect(() => {
    return subscribeEvalStore(() => {
      setStatus(getEvalStore().status)
      const completed = getEvalStore().completedLogs.length
      if (completed > 0 || getEvalStore().status.phase === 'done') {
        void refreshLogs()
      }
    })
  }, [refreshLogs])

  // Light poll while a suite is running so the results panel stays current.
  useEffect(() => {
    if (!isBenchmarkActive()) return
    const id = window.setInterval(() => {
      void refreshLogs()
    }, 4000)
    return () => window.clearInterval(id)
  }, [status.phase, refreshLogs])

  const running = isBenchmarkActive()

  return (
    <div className="benchmark-site">
      <header className="benchmark-site-header">
        <div>
          <p className="benchmark-eyebrow">{APP_NAME}</p>
          <h1>Benchmark</h1>
          <p className="muted">
            Local-only model evaluation. Results accumulate in{' '}
            <code>benchmarks/</code>.
          </p>
        </div>
        <a className="btn" href="/">
          Back to game
        </a>
      </header>

      {running && (
        <div className="benchmark-run-banner" role="status">
          <div>
            <strong>
              {status.totalRuns > 0
                ? `Model ${Math.min(status.runIndex + 1, status.totalRuns)} / ${status.totalRuns}`
                : 'Running'}
              {status.currentWorkerLabel
                ? ` — ${status.currentWorkerLabel}`
                : ''}
            </strong>
            <p>{status.message}</p>
            {status.error && (
              <p className="bench-error" role="alert">
                {status.error}
              </p>
            )}
          </div>
          <button type="button" className="btn danger" onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}

      {(status.phase === 'error' || status.phase === 'cancelled') &&
        !running && (
          <div className="benchmark-run-banner warn" role="status">
            <div>
              <strong>
                {status.phase === 'error' ? 'Suite failed' : 'Suite cancelled'}
              </strong>
              <p>{status.message}</p>
              {status.error && (
                <p className="bench-error" role="alert">
                  {status.error}
                </p>
              )}
            </div>
            <button type="button" className="btn" onClick={onCancel}>
              Dismiss
            </button>
          </div>
        )}

      <div className="benchmark-site-grid">
        <main className="benchmark-site-main">
          <BenchmarkResultsPanel
            logs={logs}
            loading={loading}
            error={loadError}
            onRefresh={() => void refreshLogs()}
            snapshot={snapshot}
            localClientId={localClientId}
            sendIntent={sendIntent}
          />
        </main>
        <aside className="benchmark-site-aside">
          <BenchmarkRunForm
            onStart={onStart}
            onCancel={onCancel}
            onApplyCast={onApplyCast}
          />
        </aside>
      </div>
    </div>
  )
}
