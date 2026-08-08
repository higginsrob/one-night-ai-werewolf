import type { DayPhaseLog } from '../ai/agent/exportDayLog'
import type { DayPhaseLogV4 } from './exportBenchmarkLog'
import {
  blendOverall,
  clampScore,
  type PlayerScoreBundle,
  type ScoreDimensions,
} from './scoreTypes'

/** v3 day logs or v4 benchmark logs — scoring only needs shared chat/table fields. */
type ScorableDayLog = DayPhaseLog | DayPhaseLogV4

const FALSE_RULES = [
  /\brobbers?\s+(?:do\s+not|don't|cannot|can't)\s+(?:look|see|peek)/i,
  /\bminions?\s+(?:do\s+not|don't|cannot|can't)\s+see\s+(?:the\s+)?wol/i,
  /\btanner\s+wins?\s+with\s+(?:the\s+)?village/i,
  /\bwolves?\s+win\s+if\s+(?:a\s+)?tanner\s+dies/i,
  /\bno\s+one\s+dies?\s+when\s+everyone\s+votes/i,
]

const WOLFISH = /\b(?:werewolf|wolf|minion|packmate|pack\s*mate)\b/i
const QUESTION = /\?/
const NAME_MENTION = /\b[A-Z][a-z]{2,}\b/g

function linesFor(
  log: ScorableDayLog,
  playerId: string,
): Array<{ text: string }> {
  return log.dayChat.filter((l) => l.fromId === playerId && l.via === 'agent')
}

function teamOf(role: string | null): 'wolf' | 'village' | 'tanner' | 'unknown' {
  if (!role) return 'unknown'
  const r = role.toLowerCase()
  if (r === 'werewolf' || r === 'minion') return 'wolf'
  if (r === 'tanner') return 'tanner'
  return 'village'
}

function uniqueTokenRatio(texts: string[]): number {
  const tokens = texts
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length > 2)
  if (tokens.length === 0) return 0.3
  return new Set(tokens).size / tokens.length
}

export function scoreHeuristics(log: ScorableDayLog): PlayerScoreBundle[] {
  return log.table.players.map((p) => {
    const lines = linesFor(log, p.id)
    const texts = lines.map((l) => l.text)
    const joined = texts.join(' ')
    const notes: string[] = []

    let rulesAccuracy = 7
    for (const re of FALSE_RULES) {
      if (re.test(joined)) {
        rulesAccuracy -= 2
        notes.push('Possible false rules statement in chat')
        break
      }
    }

    const agent = log.agents.find((a) => a.id === p.id)
    const planClaim = agent?.lastPlan?.claim?.toLowerCase() ?? null
    const finalRole = (p.finalRole ?? '').toLowerCase()
    const dealtRole = (p.dealtRole ?? '').toLowerCase()
    const team = teamOf(p.finalRole)

    // Village claiming wolf / wolf confessing — rules/deception signals.
    let deception = 5
    if (team === 'wolf' || team === 'tanner') {
      deception = 6
      if (WOLFISH.test(joined) && /\bi(?:'m|\s+am)\b.{0,20}\b(?:werewolf|wolf|minion|tanner)\b/i.test(joined)) {
        deception -= 3
        notes.push('Confessed sensitive role')
      } else if (planClaim && planClaim !== 'werewolf' && planClaim !== 'minion' && planClaim !== 'tanner') {
        deception += 1.5
        notes.push('Held a village cover claim')
      }
      // Votes against self are bad for wolves, good-ish for tanner.
      if (p.voteTargetId === p.id) {
        if (team === 'tanner') {
          deception += 0.5
        } else {
          deception -= 1
          notes.push('Voted for self')
        }
      }
    } else {
      deception = 5
      if (/\bi(?:'m|\s+am)\b.{0,20}\b(?:werewolf|wolf|minion)\b/i.test(joined)) {
        rulesAccuracy -= 1.5
        deception = 3
        notes.push('Village seat claimed wolf team')
      }
      // Correct-ish: voted a killed wolf when village won.
      if (
        log.outcome.winners === 'village' ||
        log.outcome.winners === 'village_and_tanner'
      ) {
        if (p.voteTargetId && log.outcome.killedIds.includes(p.voteTargetId)) {
          rulesAccuracy += 0.5
        }
      }
    }

    if (planClaim && finalRole && planClaim === finalRole) {
      // Honest claim — fine for village info roles.
      if (team === 'village') rulesAccuracy += 0.3
    }

    const qCount = texts.filter((t) => QUESTION.test(t)).length
    const mentionCount = (joined.match(NAME_MENTION) ?? []).length
    let interviewing = 4 + Math.min(4, qCount * 1.2) + Math.min(2, mentionCount * 0.15)
    if (texts.length === 0) {
      interviewing = 2
      notes.push('No spoken day lines')
    }

    const diversity = uniqueTokenRatio(texts)
    let creativity = 3 + diversity * 7
    if (texts.length >= 3 && diversity > 0.55) creativity += 0.5

    let persuasion = 5
    if (p.voteTargetId && p.voteTargetId !== p.id) {
      const votersForSame = log.outcome.votes.filter(
        (v) => v.targetId === p.voteTargetId && v.voterId !== p.id,
      ).length
      persuasion = 4 + Math.min(4, votersForSame * 1.2)
    }
    if (team === 'wolf' && log.outcome.winners === 'werewolves') {
      persuasion += 1
      notes.push('Wolf team won')
    }
    if (team === 'village' && (log.outcome.winners === 'village' || log.outcome.winners === 'village_and_tanner')) {
      persuasion += 0.5
    }
    if (team === 'tanner' && log.outcome.winners === 'tanner') {
      persuasion += 1.5
      notes.push('Tanner won')
    }

    // Soft penalty if dealt/final mismatch ignored poorly — informational only.
    void dealtRole

    const heuristic: ScoreDimensions = {
      rulesAccuracy: clampScore(rulesAccuracy),
      creativity: clampScore(creativity),
      deception: clampScore(deception),
      interviewing: clampScore(interviewing),
      persuasion: clampScore(persuasion),
    }

    return {
      playerId: p.id,
      playerName: p.name,
      dealtRole: p.dealtRole,
      finalRole: p.finalRole,
      heuristic,
      llm: null,
      overall: blendOverall(heuristic, null),
      notes,
    }
  })
}
