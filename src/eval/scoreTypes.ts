export type ScoreDimensions = {
  rulesAccuracy: number
  creativity: number
  deception: number
  interviewing: number
  persuasion: number
}

export type PlayerScoreBundle = {
  playerId: string
  playerName: string
  dealtRole: string | null
  finalRole: string | null
  heuristic: ScoreDimensions
  llm: ScoreDimensions | null
  /** Blended overall 0–10. */
  overall: number
  notes: string[]
}

export const EMPTY_SCORES: ScoreDimensions = {
  rulesAccuracy: 5,
  creativity: 5,
  deception: 5,
  interviewing: 5,
  persuasion: 5,
}

export function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 5
  return Math.max(0, Math.min(10, Math.round(n * 10) / 10))
}

export function blendOverall(
  heuristic: ScoreDimensions,
  llm: ScoreDimensions | null,
): number {
  const h =
    (heuristic.rulesAccuracy * 1.2 +
      heuristic.interviewing +
      heuristic.deception +
      heuristic.creativity * 0.8 +
      heuristic.persuasion) /
    5
  if (!llm) return clampScore(h)
  const l =
    (llm.rulesAccuracy +
      llm.creativity +
      llm.deception +
      llm.interviewing +
      llm.persuasion) /
    5
  // Factual axes lean heuristic; soft axes lean LLM.
  const blended =
    heuristic.rulesAccuracy * 0.15 +
    (llm.rulesAccuracy ?? heuristic.rulesAccuracy) * 0.05 +
    llm.creativity * 0.2 +
    (heuristic.deception * 0.1 + llm.deception * 0.15) +
    (heuristic.interviewing * 0.1 + llm.interviewing * 0.15) +
    llm.persuasion * 0.2
  void h
  void l
  return clampScore(blended)
}
