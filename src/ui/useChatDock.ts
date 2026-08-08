import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'

const WIDTH_KEY = 'onw.chatDock.width'

export const CHAT_DOCK_DEFAULT_WIDTH = 340
/** Preferred minimum; may shrink further on tight viewports. */
export const CHAT_DOCK_MIN_WIDTH = 260
/** Absolute floor so compose UI still fits. */
export const CHAT_DOCK_HARD_MIN_WIDTH = 220
/** Keep at least this much scene width when the dock is open. */
export const CHAT_DOCK_MIN_SCENE = 220
export const CHAT_DOCK_MAX_WIDTH = 560

function readWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY))
    if (Number.isFinite(n) && n >= CHAT_DOCK_HARD_MIN_WIDTH) {
      return clampChatDockWidth(Math.round(n))
    }
  } catch {
    // ignore
  }
  return clampChatDockWidth(CHAT_DOCK_DEFAULT_WIDTH)
}

export function clampChatDockWidth(width: number, viewportWidth = window.innerWidth): number {
  const max = Math.min(
    CHAT_DOCK_MAX_WIDTH,
    Math.max(CHAT_DOCK_HARD_MIN_WIDTH, viewportWidth - CHAT_DOCK_MIN_SCENE),
  )
  const min = Math.min(CHAT_DOCK_MIN_WIDTH, max)
  return Math.round(Math.min(max, Math.max(min, width)))
}

/** Persisted width state for the always-visible right-side chat dock. */
export function useChatDock() {
  const [width, setWidthState] = useState(readWidth)

  const setWidth = useCallback((next: number | ((prev: number) => number)) => {
    setWidthState((prev) => {
      const raw = typeof next === 'function' ? next(prev) : next
      return clampChatDockWidth(raw)
    })
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(width))
    } catch {
      // ignore
    }
  }, [width])

  useEffect(() => {
    const onResize = () => {
      setWidthState((prev) => clampChatDockWidth(prev))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const beginResize = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = width
      const target = e.currentTarget as HTMLElement
      target.setPointerCapture(e.pointerId)

      const onMove = (ev: PointerEvent) => {
        // Dragging the left edge: move left → wider dock.
        setWidth(startWidth + (startX - ev.clientX))
      }
      const onUp = (ev: PointerEvent) => {
        target.releasePointerCapture(ev.pointerId)
        target.removeEventListener('pointermove', onMove)
        target.removeEventListener('pointerup', onUp)
        target.removeEventListener('pointercancel', onUp)
      }
      target.addEventListener('pointermove', onMove)
      target.addEventListener('pointerup', onUp)
      target.addEventListener('pointercancel', onUp)
    },
    [setWidth, width],
  )

  return { width, setWidth, beginResize }
}
