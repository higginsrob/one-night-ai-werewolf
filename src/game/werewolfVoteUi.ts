/** Bridge pending day-vote picks from the R3F scene to the DOM HUD. */

type Listener = (targetId: string | null) => void

let pendingVoteTargetId: string | null = null
const listeners = new Set<Listener>()

export function getPendingVoteTargetId(): string | null {
  return pendingVoteTargetId
}

export function setPendingVoteTargetId(targetId: string | null): void {
  if (pendingVoteTargetId === targetId) return
  pendingVoteTargetId = targetId
  for (const fn of listeners) fn(pendingVoteTargetId)
}

export function subscribePendingVoteTarget(fn: Listener): () => void {
  listeners.add(fn)
  fn(pendingVoteTargetId)
  return () => {
    listeners.delete(fn)
  }
}
