/** DEV-only benchmark / eval surfaces (`/benchmark.html`, `?eval=true`). */

export function isBenchmarkPage(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const path = window.location.pathname
    return path.endsWith('/benchmark.html') || path.endsWith('/benchmark')
  } catch {
    return false
  }
}

export function isEvalMode(): boolean {
  if (!import.meta.env.DEV) return false
  if (typeof window === 'undefined') return false
  if (isBenchmarkPage()) return true
  try {
    return new URLSearchParams(window.location.search).get('eval') === 'true'
  } catch {
    return false
  }
}

/** Redirect `/?eval=true` → `/benchmark.html` (DEV). Returns true if redirected. */
export function redirectEvalQueryToBenchmarkPage(): boolean {
  if (!import.meta.env.DEV) return false
  if (typeof window === 'undefined') return false
  if (isBenchmarkPage()) return false
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.get('eval') !== 'true') return false
    params.delete('eval')
    params.delete('results')
    const qs = params.toString()
    window.location.replace(`/benchmark.html${qs ? `?${qs}` : ''}`)
    return true
  } catch {
    return false
  }
}

export const EVAL_WORKER_IDS_KEY = 'onw:eval-worker-ids'
export const EVAL_BANTER_DONE_EVENT = 'onw:eval-banter-done'
export const EVAL_NIGHT_CAPTURE_EVENT = 'onw:eval-night-capture'

export function loadEvalWorkerIds(): string[] {
  try {
    const raw = sessionStorage.getItem(EVAL_WORKER_IDS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
  } catch {
    return []
  }
}

export function saveEvalWorkerIds(ids: string[]): void {
  try {
    sessionStorage.setItem(EVAL_WORKER_IDS_KEY, JSON.stringify(ids))
  } catch {
    // ignore
  }
}
