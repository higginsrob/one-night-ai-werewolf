import { chatWithConfig } from '../client'
import { loadAiStore } from '../aiStore'
import { formatInferenceError } from '../inferenceHealth'
import {
  MAX_NAME,
  MAX_NICKNAME,
  MAX_PERSONA,
  MAX_TITLE,
} from '../aiPlayers'
import type { ChatMessage } from '../types'

export type PersonaGuideDraft = {
  name: string
  nickname: string
  title: string
  persona: string
}

export type PersonaGuideTurn =
  | { kind: 'question'; text: string }
  | { kind: 'ready'; draft: PersonaGuideDraft }

const SYSTEM_PROMPT = `You help configure an AI opponent for One Night Ultimate Werewolf.
Your job is to interview the host and produce a short table persona.

Flow:
1. First message from the host will usually be a pasted profile / bio dump (or they may say they have none). Acknowledge it briefly, then ask follow-up questions about how this person should play at a social-deduction table: tone, humor, bluntness, how they bluff, how they protect friends, quirks.
2. Ask ONE focused question per reply until you have enough.
3. When ready, reply with ONLY a JSON object (no markdown fences):
{"ready":true,"name":"...","nickname":"...","title":"...","persona":"..."}

Rules for the final JSON:
- name: proper player name shown on the card (first + last when known), max ${MAX_NAME} characters. Prefer a real-looking full name from the bio — not a cute handle.
- nickname: short preferred handle others may call them by, max ${MAX_NICKNAME} characters. Usually a first name; never invent a silly gamertag unless the host asked for one. Cards and chat show \`name\`, not nickname.
- title: optional short headline (job/role vibe), max ${MAX_TITLE} characters; use "" if unknown.
- persona: 1–3 sentences of speaking style for the system prompt, max ${MAX_PERSONA} characters. Playful table pressure is OK; never mean, demeaning, prejudiced, or hostile.
- Do not invent real-world private facts beyond what the host shared.
- Before ready, never output the ready JSON — only ask a question in plain text.`

function extractJsonObject(text: string): unknown | null {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      // fall through
    }
  }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown
    } catch {
      return null
    }
  }
  return null
}

function parseReadyPayload(raw: unknown): PersonaGuideDraft | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (obj.ready !== true) return null
  const name = typeof obj.name === 'string' ? obj.name.trim().slice(0, MAX_NAME) : ''
  const nickname =
    typeof obj.nickname === 'string'
      ? obj.nickname.trim().slice(0, MAX_NICKNAME)
      : ''
  const title =
    typeof obj.title === 'string' ? obj.title.trim().slice(0, MAX_TITLE) : ''
  const persona =
    typeof obj.persona === 'string'
      ? obj.persona.trim().slice(0, MAX_PERSONA)
      : ''
  // Older guides may only emit name (short handle) — treat it as nickname too.
  const resolvedNickname = nickname || name
  const resolvedName = name || nickname
  if (!resolvedName || !resolvedNickname || !persona) return null
  return {
    name: resolvedName.slice(0, MAX_NAME),
    nickname: resolvedNickname.slice(0, MAX_NICKNAME),
    title,
    persona,
  }
}

export function personaGuideSystemMessage(): ChatMessage {
  return { role: 'system', content: SYSTEM_PROMPT }
}

/** Opening instruction so the first user turn is the profile dump. */
export function personaGuideKickoffUserMessage(
  target: 'ai' | 'human' = 'ai',
): ChatMessage {
  return {
    role: 'user',
    content:
      target === 'human'
        ? 'Start the AI interview for my human table profile. Ask me to paste a profile / bio text dump about myself (or say I have none).'
        : 'Start the guided import. Ask me to paste a profile / bio text dump for this AI player (or say I have none).',
  }
}

export async function runPersonaGuideTurn(
  history: ChatMessage[],
): Promise<PersonaGuideTurn> {
  const store = loadAiStore()
  const configId = store.activeGuideConfigId
  if (!configId) {
    throw new Error('Pick a guide agent model config first.')
  }
  const config = store.modelConfigs.find((c) => c.id === configId)
  if (!config) throw new Error('Guide agent model config is missing.')
  const provider = store.providers.find((p) => p.id === config.providerId)
  if (!provider) throw new Error('Guide agent provider is missing.')

  try {
    const result = await chatWithConfig(provider, config, [
      personaGuideSystemMessage(),
      ...history,
    ])
    const parsed = parseReadyPayload(extractJsonObject(result.text))
    if (parsed) return { kind: 'ready', draft: parsed }
    const text = result.text.trim()
    if (!text) throw new Error('Guide agent returned an empty reply.')
    return { kind: 'question', text }
  } catch (err) {
    throw new Error(formatInferenceError(err))
  }
}
