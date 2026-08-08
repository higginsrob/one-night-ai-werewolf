import type { WerewolfSnapshot } from '../../game/werewolfTypes'
import type { ChatLine } from '../../session/types'

/** Milliseconds of day discussion remaining right now, or null if not in day. */
export function dayMsLeftNow(
  game: WerewolfSnapshot | null | undefined,
): number | null {
  if (!game || game.phase !== 'day' || game.dayEndsAt == null) return null
  return Math.max(0, game.dayEndsAt - Date.now())
}

/** Match HUD-style countdown: `m:ss`. */
export function formatDayCountdown(msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, '0')}`
}

/** One-line clock note for day prompts (empty when not day). */
export function formatDayClockNote(
  game: WerewolfSnapshot | null | undefined,
): string {
  const ms = dayMsLeftNow(game)
  if (ms == null) return ''
  return `Day discussion time remaining: ${formatDayCountdown(ms)} (wall clock — use for pacing, do not speak the timer unless natural).`
}

/** Format a table chat line for agent context, with optional day clock stamp. */
export function formatChatLineForAgent(line: ChatLine): string {
  const clock =
    typeof line.dayMsLeft === 'number'
      ? ` [${formatDayCountdown(line.dayMsLeft)} left]`
      : ''
  return `${line.name}${clock}: ${line.text}`
}

export function formatRecentChatForAgent(
  chatLines: ChatLine[],
  limit = 12,
): string {
  return chatLines
    .filter((line) => line.via !== 'narrator')
    .slice(-limit)
    .map(formatChatLineForAgent)
    .join('\n')
}
