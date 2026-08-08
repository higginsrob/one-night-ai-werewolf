import { useEffect, useState } from 'react'

/** Matches the existing mobile layout breakpoint in styles.css. */
export const NARROW_VIEWPORT_MQ = '(max-width: 700px)'

/** True when the viewport is phone-sized (max-width 700px). */
export function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined'
      ? window.matchMedia(NARROW_VIEWPORT_MQ).matches
      : false,
  )

  useEffect(() => {
    const mq = window.matchMedia(NARROW_VIEWPORT_MQ)
    const onChange = () => setNarrow(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return narrow
}
