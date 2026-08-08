import { chatWithConfig } from '../ai/client'
import { loadAiStore } from '../ai/aiStore'
import { ROLE_RULES_REFERENCE } from '../ai/agent/teamStrategy'
import type { DayPhaseLog } from '../ai/agent/exportDayLog'
import type { DayPhaseLogV4 } from './exportBenchmarkLog'
import {
  blendOverall,
  clampScore,
  EMPTY_SCORES,
  type PlayerScoreBundle,
  type ScoreDimensions,
} from './scoreTypes'

type ScorableDayLog = DayPhaseLog | DayPhaseLogV4

function parseScoresJson(text: string): ScoreDimensions | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    const num = (k: string) =>
      clampScore(typeof raw[k] === 'number' ? (raw[k] as number) : Number(raw[k]))
    return {
      rulesAccuracy: num('rulesAccuracy'),
      creativity: num('creativity'),
      deception: num('deception'),
      interviewing: num('interviewing'),
      persuasion: num('persuasion'),
    }
  } catch {
    return null
  }
}

/**
 * LLM-as-judge using the active classifier (or work fallback).
 * One call per player; soft-fails to null llm scores.
 */
export async function scoreWithLlmJudge(
  log: ScorableDayLog,
  heuristicBundles: PlayerScoreBundle[],
  opts?: { onStatus?: (msg: string) => void },
): Promise<PlayerScoreBundle[]> {
  const store = loadAiStore()
  const configId =
    store.activeClassifierConfigId ?? store.activeWorkConfigId
  const config = configId
    ? store.modelConfigs.find((c) => c.id === configId)
    : null
  const provider = config
    ? store.providers.find((p) => p.id === config.providerId)
    : null

  if (!config || !provider) {
    opts?.onStatus?.('No classifier/work model for LLM judge — heuristics only')
    return heuristicBundles
  }

  const out: PlayerScoreBundle[] = []
  for (const bundle of heuristicBundles) {
    const player = log.table.players.find((p) => p.id === bundle.playerId)
    const chat = log.dayChat
      .filter((l) => l.fromId === bundle.playerId)
      .map((l) => l.text)
      .join('\n')
    const agent = log.agents.find((a) => a.id === bundle.playerId)

    opts?.onStatus?.(
      `LLM judge: ${bundle.playerName} (${config.label || config.modelId})…`,
    )

    const prompt = [
      'You are scoring one AI player in One Night Ultimate Werewolf.',
      'Official role/rules reference:',
      ROLE_RULES_REFERENCE.slice(0, 3500),
      '',
      `Player: ${bundle.playerName}`,
      `Dealt role: ${player?.dealtRole ?? '?'}`,
      `Final role: ${player?.finalRole ?? '?'}`,
      `Vote target: ${player?.voteTargetName ?? '?'}`,
      `Outcome: ${log.outcome.winners} — ${log.outcome.winMessage ?? ''}`,
      `Private plan claim: ${agent?.lastPlan?.claim ?? '(none)'}`,
      `Goal: ${agent?.lastPlan?.goal ?? '(none)'}`,
      '',
      'Their day chat lines:',
      chat || '(silent)',
      '',
      'Score 0-10 for each dimension. Return ONLY JSON:',
      '{"rulesAccuracy":n,"creativity":n,"deception":n,"interviewing":n,"persuasion":n}',
      'rulesAccuracy = correct understanding of ONUW rules and honest use of info roles.',
      'creativity = interesting lines / novel angles (not just templates).',
      'deception = skill at lying/cover stories when on wolf/minion/tanner; villagers score mid unless they bluff usefully.',
      'interviewing = asking useful questions and pressing claims.',
      'persuasion = ability to sway the table / influence votes.',
    ].join('\n')

    let llm: ScoreDimensions | null = null
    try {
      const result = await chatWithConfig(provider, config, [
        { role: 'user', content: prompt },
      ])
      llm = parseScoresJson(result.text)
      if (!llm) {
        llm = { ...EMPTY_SCORES }
      }
    } catch {
      llm = null
    }

    out.push({
      ...bundle,
      llm,
      overall: blendOverall(bundle.heuristic, llm),
    })
  }
  return out
}
