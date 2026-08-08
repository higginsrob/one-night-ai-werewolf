import { useEffect } from 'react'

/**
 * Keep the screen awake while `enabled` (Screen Wake Lock API).
 * No-ops when unsupported; re-acquires after the tab becomes visible again.
 */
export function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    if (typeof navigator === 'undefined' || !navigator.wakeLock?.request) return

    let lock: WakeLockSentinel | null = null
    let cancelled = false

    const acquire = async () => {
      if (cancelled || document.visibilityState !== 'visible') return
      try {
        lock = await navigator.wakeLock.request('screen')
        lock.addEventListener('release', () => {
          lock = null
        })
      } catch {
        // Permission denied, battery saver, or transient failure — ignore.
      }
    }

    void acquire()

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      void lock?.release()
      lock = null
    }
  }, [enabled])
}
