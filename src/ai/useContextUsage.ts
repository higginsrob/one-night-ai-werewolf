import { useEffect, useState } from 'react'
import {
  getContextUsage,
  subscribeContextUsage,
  type ContextUsageSnapshot,
} from './contextUsageStore'

export function useContextUsage(): ContextUsageSnapshot | null {
  const [usage, setUsage] = useState(() => getContextUsage())
  useEffect(() => subscribeContextUsage(() => setUsage(getContextUsage())), [])
  return usage
}
