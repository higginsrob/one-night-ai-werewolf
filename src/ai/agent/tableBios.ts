import { aiProfileById, aiTableName } from '../aiPlayers'
import {
  humanTableName,
  loadLocalProfile,
} from '../../net/localProfile'
import type { PlayerPublic } from '../../session/types'

const GUARDRAIL =
  'Table players (other seats — social flavor only; do not adopt their voice; only match YOUR persona):'

function formatBioLine(parts: {
  name: string
  nickname?: string
  title?: string
  persona?: string
  kind: 'human' | 'ai'
}): string {
  const nick = parts.nickname?.trim()
  const namePart =
    nick && nick.toLowerCase() !== parts.name.toLowerCase()
      ? `${parts.name} (goes by ${nick})`
      : parts.name
  const bits = [`${namePart} [${parts.kind}]`]
  const title = parts.title?.trim()
  if (title) bits.push(`Title: ${title}`)
  const persona = parts.persona?.trim()
  if (persona) bits.push(`Persona: ${persona}`)
  return `- ${bits.join(' · ')}`
}

/**
 * Bios for every other connected seat so AIs can address table vibe.
 * Acting seat is excluded (their own persona is elsewhere in the prompt).
 */
export function formatTablePlayerBios(
  players: PlayerPublic[],
  selfId: string,
): string {
  const others = players.filter((p) => p.connected && p.id !== selfId)
  if (!others.length) {
    return `${GUARDRAIL}\n(none)`
  }

  const humanProfile = loadLocalProfile()
  const lines: string[] = []

  for (const p of others) {
    if (p.isNpc && p.aiProfileId) {
      const profile = aiProfileById(p.aiProfileId)
      if (profile) {
        lines.push(
          formatBioLine({
            name: aiTableName(profile),
            nickname: profile.nickname,
            title: profile.title,
            persona: profile.persona,
            kind: 'ai',
          }),
        )
        continue
      }
    }
    if (!p.isNpc) {
      const name =
        humanTableName(humanProfile).trim() || p.name.trim() || 'Player'
      lines.push(
        formatBioLine({
          name,
          nickname: humanProfile.nickname,
          title: humanProfile.title,
          persona: humanProfile.persona,
          kind: 'human',
        }),
      )
      continue
    }
    lines.push(formatBioLine({ name: p.name || 'Player', kind: 'ai' }))
  }

  return [GUARDRAIL, ...lines].join('\n')
}
