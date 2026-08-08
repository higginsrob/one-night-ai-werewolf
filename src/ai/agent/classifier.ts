import { myDealtRole } from '../../game/werewolfLogic'
import type { WerewolfRole, WerewolfSnapshot } from '../../game/werewolfTypes'
import type { SessionSnapshot } from '../../net/protocol'
import type { ChatLine, ClientId, PlayerPublic } from '../../session/types'
import { loadAiStore } from '../aiStore'
import { chatWithConfig } from '../client'
import { aiJobQueue } from '../queue'

/** Dealt roles that usually owe the table a claim / night story. */
const INFO_ROLES = new Set<WerewolfRole>([
  'seer',
  'robber',
  'troublemaker',
  'mason',
  'werewolf',
  'minion',
  'drunk',
  'insomniac',
])

const INFO_ROLE_PRIORITY: WerewolfRole[] = [
  'troublemaker',
  'robber',
  'seer',
  'insomniac',
  'mason',
  'drunk',
  'werewolf',
  'minion',
]

function isTinyOpener(transcript: string): boolean {
  const t = transcript.trim().toLowerCase()
  if (!t) return true
  if (t.length <= 12) return true
  return /^(why\s+)?hello[.!?]?\s*$|^hi[.!?]?\s*$|^hey[.!?]?\s*$|^hello\??\s*$|^\?\s*$|^good\s*(morning|evening|night)[.!]?\s*$/.test(
    t,
  )
}

function isNonTrivialDayLine(transcript: string): boolean {
  const t = transcript.trim()
  if (!t) return false
  if (isTinyOpener(t)) return false
  return t.length >= 8
}

function agentHasSpoken(
  chatLines: ChatLine[],
  npcId: ClientId,
): boolean {
  return chatLines.some((l) => l.fromId === npcId && l.via === 'agent')
}

function silentInfoRoleNpcs(args: {
  npcs: PlayerPublic[]
  game: WerewolfSnapshot | null | undefined
  chatLines: ChatLine[]
}): PlayerPublic[] {
  const { npcs, game, chatLines } = args
  if (!game) return []
  const scored: Array<{ p: PlayerPublic; pri: number }> = []
  for (const p of npcs) {
    if (agentHasSpoken(chatLines, p.id)) continue
    const dealt = myDealtRole(game, p.id)
    if (!dealt || !INFO_ROLES.has(dealt)) continue
    const pri = INFO_ROLE_PRIORITY.indexOf(dealt)
    scored.push({ p, pri: pri >= 0 ? pri : 99 })
  }
  scored.sort((a, b) => a.pri - b.pri)
  return scored.map((s) => s.p)
}

/**
 * Cap greeting pile-ons and force silent info-role NPCs to claim.
 * Call after classifyResponders (or name-mention routing).
 */
export function enforceSpeakBudget(args: {
  snapshot: SessionSnapshot
  transcript: string
  responders: ClientId[]
}): ClientId[] {
  const { snapshot, transcript, responders } = args
  const npcs = snapshot.players.filter(
    (p) => p.connected && p.isNpc && p.aiProfileId,
  )
  if (npcs.length === 0) return []

  const chatLines = snapshot.chatLines ?? []
  const game = snapshot.game
  const mentioned = npcs.filter((p) =>
    transcript.toLowerCase().includes(p.name.toLowerCase()),
  )
  // Require prior table talk so a brand-new lobby greeting does not force a
  // claim dump. Day/reveal always count as started — starting a game clears
  // chat, so without this the first day lines often get zero responders.
  const humanLines = chatLines.filter((l) => l.via === 'stt').length
  const tableTalkLines = chatLines.filter(
    (l) => l.via === 'stt' || l.via === 'agent' || l.via === 'system',
  ).length
  const inDay = game?.phase === 'day'
  const inReveal = game?.phase === 'reveal'
  const dayStarted =
    inDay || inReveal || humanLines >= 2 || tableTalkLines >= 3
  // Aftergame: no need to force silent info-role claim dumps.
  const silentInfo = inReveal
    ? []
    : silentInfoRoleNpcs({ npcs, game, chatLines })

  let picked = [...responders].filter((id) => npcs.some((p) => p.id === id))

  // Name mentions always win; still allow appending a silent info seat later.
  if (mentioned.length === 0 && isTinyOpener(transcript) && picked.length > 1) {
    picked = picked.slice(0, 1)
  }

  if (
    dayStarted &&
    silentInfo.length > 0 &&
    !picked.some((id) => silentInfo.some((p) => p.id === id))
  ) {
    const force = silentInfo[0]!
    if (!picked.includes(force.id)) picked.push(force.id)
  }

  if (
    picked.length === 0 &&
    (inDay ||
      inReveal ||
      !game ||
      isNonTrivialDayLine(transcript))
  ) {
    // Day discussion (and lobby) should almost never go unanswered — starting
    // the round wipes chat, so short openers still need a voice.
    const fallback = silentInfo[0] ?? npcs[0]
    if (fallback) picked = [fallback.id]
  }

  // Cap unnamed turns at 2 unless we forced a silent info claim onto a greeting.
  if (mentioned.length === 0 && picked.length > 2) {
    const forced = silentInfo.find((p) => picked.includes(p.id))
    picked = picked.slice(0, 2)
    if (forced && !picked.includes(forced.id)) {
      picked = [...picked.slice(0, 1), forced.id]
    }
  }

  return picked
}

/**
 * Pick 0–6 AI NPC ids (ordered) who should respond to a human utterance.
 * Biases toward names mentioned in the transcript.
 */
export async function classifyResponders(args: {
  snapshot: SessionSnapshot
  transcript: string
  /** Seat that spoke — keeps routing clear when multiple humans are present. */
  humanFromId?: ClientId | null
}): Promise<ClientId[]> {
  const { snapshot, transcript, humanFromId = null } = args
  const npcs = snapshot.players.filter(
    (p) => p.connected && p.isNpc && p.aiProfileId,
  )
  if (npcs.length === 0) return []

  const mentioned = npcs.filter((p) =>
    transcript.toLowerCase().includes(p.name.toLowerCase()),
  )
  if (mentioned.length > 0) {
    return enforceSpeakBudget({
      snapshot,
      transcript,
      responders: mentioned.map((p) => p.id),
    })
  }

  const store = loadAiStore()
  const configId =
    store.activeClassifierConfigId ?? store.activeWorkConfigId
  const config = store.modelConfigs.find((c) => c.id === configId)
  const provider = config
    ? store.providers.find((p) => p.id === config.providerId)
    : null
  if (!config || !provider || !config.modelId.trim()) {
    return enforceSpeakBudget({
      snapshot,
      transcript,
      responders: npcs.slice(0, 1).map((p) => p.id),
    })
  }

  const roster = npcs
    .map((p, i) => `${i}: ${p.name} (${p.id})`)
    .join('\n')
  const speaker =
    (humanFromId
      ? snapshot.players.find((p) => p.id === humanFromId)
      : null) ?? null
  const speakerLabel = speaker?.name ?? 'a human'

  const system = `You route table talk in One Night AI Werewolf to AI players.
Return JSON only: {"indexes":[<0-based indexes of who should reply, ordered>]}.
Use [] if nobody should speak. Prefer 0–2 responders unless several are addressed.
If the speaker named an AI and asked them something, that AI must be first (usually alone).
If the latest line is a cast vote ("I vote for…"), prefer the named target when they are an AI, otherwise 1–2 other AI players to react briefly.
Keep tone routing friendly — do not pile on tiny greetings.`

  const user = `AI players:\n${roster}\n\n${speakerLabel} said:\n"${transcript.trim()}"`

  try {
    const result = await aiJobQueue.enqueue(() =>
      chatWithConfig(
        provider,
        config,
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        { jsonObject: true },
      ),
    )
    const match = result.text.match(/\{[\s\S]*\}/)
    if (!match) {
      return enforceSpeakBudget({
        snapshot,
        transcript,
        responders: npcs.slice(0, 1).map((p) => p.id),
      })
    }
    const parsed = JSON.parse(match[0]) as { indexes?: number[] }
    const indexes = Array.isArray(parsed.indexes) ? parsed.indexes : []
    const picked: ClientId[] = []
    for (const i of indexes) {
      if (typeof i !== 'number' || i < 0 || i >= npcs.length) continue
      const id = npcs[i]!.id
      if (!picked.includes(id)) picked.push(id)
      if (picked.length >= 8) break
    }
    return enforceSpeakBudget({ snapshot, transcript, responders: picked })
  } catch {
    return enforceSpeakBudget({
      snapshot,
      transcript,
      responders: npcs.slice(0, 1).map((p) => p.id),
    })
  }
}
