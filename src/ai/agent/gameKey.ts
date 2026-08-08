import type { SessionSnapshot } from '../../net/protocol'

export function gameKeyOf(snapshot: SessionSnapshot): string {
  if (snapshot.phase === 'lobby' || !snapshot.game) {
    return `${snapshot.sessionSeed}:lobby`
  }
  const g = snapshot.game
  return `${snapshot.sessionSeed}:${g.layoutSeed}:${g.playerIds.join(',')}`
}
