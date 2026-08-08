import { useCallback, useEffect, useState } from 'react'

export type MobilePaneMode = 'chat' | 'scene'

const STORAGE_KEY = 'onw.mobilePaneMode'
const ORDER: MobilePaneMode[] = ['scene', 'chat']

function readMode(): MobilePaneMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'chat' || v === 'scene') return v
    // Migrate removed "split" preference to fullscreen table.
    if (v === 'split') return 'scene'
  } catch {
    // ignore
  }
  return 'scene'
}

export function useMobilePaneMode() {
  const [mode, setModeState] = useState<MobilePaneMode>(readMode)

  const setMode = useCallback((next: MobilePaneMode) => {
    setModeState(next)
  }, [])

  const cycleMode = useCallback(() => {
    setModeState((prev) => {
      const i = ORDER.indexOf(prev)
      return ORDER[(i + 1) % ORDER.length]!
    })
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      // ignore
    }
  }, [mode])

  return { mode, setMode, cycleMode }
}

export function mobilePaneToggleLabel(mode: MobilePaneMode): string {
  switch (mode) {
    case 'scene':
      return 'Show chat'
    case 'chat':
      return 'Show table'
  }
}

export function mobilePaneToggleTitle(mode: MobilePaneMode): string {
  switch (mode) {
    case 'scene':
      return 'Showing table — tap for chat'
    case 'chat':
      return 'Showing chat — tap for table'
  }
}
