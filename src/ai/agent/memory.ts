import type { ClientId, PlayerPublic } from '../../session/types'
import type { ChatMessage } from '../types'
import { scrubStaleNoClaimLines } from './beliefParse'
import type { DayPlan } from './dayPlan'

export type PlayerBelief = {
  notes: string
  updatedAt: number
}

export type ReplyTrace = {
  at: number
  mode: 'day' | 'lobby' | 'result'
  humanTranscript: string
  /** Seat that spoke the human line (required when multiple humans are at the table). */
  humanFromId: ClientId | null
  humanName: string | null
  responders: ClientId[]
  plan: DayPlan | null
  planRaw: string | null
  planModelId: string | null
  rawSpeak: string
  cleanedText: string
  retried: boolean
  workModelId: string | null
  latencyMs: number
  privateObservation: string | null
}

export type AgentGameMemory = {
  gameKey: string
  knowledge: Record<ClientId, PlayerBelief>
  /** Perspective chat history for this agent. */
  chat: ChatMessage[]
  /** Latest private day plan. */
  lastPlan: DayPlan | null
  /** Frozen first day-phase private observation for export. */
  dayObservation: string | null
  traces: ReplyTrace[]
}

const STORAGE_KEY = 'onw:ai-agent-memory'
const memories = new Map<string, AgentGameMemory>()

type PersistedBlob = {
  version: 1
  entries: Record<string, AgentGameMemory>
}

function key(gameKey: string, agentId: ClientId): string {
  return `${gameKey}::${agentId}`
}

function persist(): void {
  try {
    // Drop oldest agent entries if the map grows (keep newest ~20).
    if (memories.size > 20) {
      const keys = [...memories.keys()]
      for (const k of keys.slice(0, memories.size - 20)) memories.delete(k)
    }
    const entries: Record<string, AgentGameMemory> = {}
    for (const [k, mem] of memories) {
      const traces = mem.traces.slice(-24)
      const chat = mem.chat.slice(-40)
      entries[k] = { ...mem, traces, chat }
    }
    const blob: PersistedBlob = { version: 1, entries }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(blob))
  } catch {
    // quota / private mode — keep in-memory only
  }
}

function hydrate(): void {
  if (memories.size > 0) return
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Partial<PersistedBlob>
    if (parsed.version !== 1 || !parsed.entries) return
    for (const [k, mem] of Object.entries(parsed.entries)) {
      if (!mem || typeof mem !== 'object') continue
      const traces = Array.isArray(mem.traces)
        ? mem.traces.map((t) => ({
            ...t,
            humanFromId:
              typeof t?.humanFromId === 'string' ? t.humanFromId : null,
            humanName: typeof t?.humanName === 'string' ? t.humanName : null,
          }))
        : []
      memories.set(k, {
        gameKey: typeof mem.gameKey === 'string' ? mem.gameKey : k,
        knowledge: mem.knowledge ?? {},
        chat: Array.isArray(mem.chat) ? mem.chat : [],
        lastPlan: mem.lastPlan ?? null,
        dayObservation:
          typeof mem.dayObservation === 'string' ? mem.dayObservation : null,
        traces,
      })
    }
  } catch {
    // ignore corrupt storage
  }
}

export function getAgentMemory(
  gameKey: string,
  agentId: ClientId,
): AgentGameMemory {
  hydrate()
  const k = key(gameKey, agentId)
  let mem = memories.get(k)
  if (!mem) {
    mem = {
      gameKey,
      knowledge: {},
      chat: [],
      lastPlan: null,
      dayObservation: null,
      traces: [],
    }
    memories.set(k, mem)
  }
  return mem
}

export function clearAgentMemoriesForGame(gameKey: string): void {
  hydrate()
  for (const k of [...memories.keys()]) {
    if (k.startsWith(`${gameKey}::`)) memories.delete(k)
  }
  persist()
}

/** Host-local memories for every AI seat in a game (for day-log export). */
export function listAgentMemoriesForGame(
  gameKey: string,
): Array<{ agentId: ClientId; memory: AgentGameMemory }> {
  hydrate()
  const prefix = `${gameKey}::`
  const out: Array<{ agentId: ClientId; memory: AgentGameMemory }> = []
  for (const [k, memory] of memories) {
    if (!k.startsWith(prefix)) continue
    out.push({ agentId: k.slice(prefix.length) as ClientId, memory })
  }
  return out
}

export function clearAllAgentMemories(): void {
  memories.clear()
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

export function appendAgentChat(
  gameKey: string,
  agentId: ClientId,
  message: ChatMessage,
): void {
  const mem = getAgentMemory(gameKey, agentId)
  mem.chat.push(message)
  if (mem.chat.length > 40) mem.chat.splice(0, mem.chat.length - 40)
  persist()
}

export function updateBelief(
  gameKey: string,
  agentId: ClientId,
  aboutId: ClientId,
  notes: string,
): void {
  const mem = getAgentMemory(gameKey, agentId)
  const prev = mem.knowledge[aboutId]?.notes ?? ''
  mem.knowledge[aboutId] = {
    notes: prev ? `${prev}\n${notes}` : notes,
    updatedAt: Date.now(),
  }
  persist()
}

export function setLastPlan(
  gameKey: string,
  agentId: ClientId,
  plan: DayPlan,
): void {
  const mem = getAgentMemory(gameKey, agentId)
  mem.lastPlan = plan
  persist()
}

export function ensureDayObservation(
  gameKey: string,
  agentId: ClientId,
  observation: string,
): void {
  const mem = getAgentMemory(gameKey, agentId)
  if (!mem.dayObservation) {
    mem.dayObservation = observation
    persist()
  }
}

export function appendReplyTrace(
  gameKey: string,
  agentId: ClientId,
  trace: ReplyTrace,
): void {
  const mem = getAgentMemory(gameKey, agentId)
  mem.traces.push(trace)
  if (mem.traces.length > 24) mem.traces.splice(0, mem.traces.length - 24)
  persist()
}

export function resolvePlayerIdByName(
  players: PlayerPublic[],
  name: string,
): ClientId | null {
  const needle = name.trim().toLowerCase()
  if (!needle) return null
  const exact = players.find((p) => p.name.toLowerCase() === needle)
  if (exact) return exact.id
  const partial = players.find(
    (p) =>
      p.name.toLowerCase().includes(needle) ||
      needle.includes(p.name.toLowerCase()),
  )
  return partial?.id ?? null
}

export function formatKnowledgeBase(
  mem: AgentGameMemory,
  players?: PlayerPublic[],
  /** Names who already have a claim on the ledger — scrub stale "no claim yet". */
  claimedNames?: Set<string>,
): string {
  const entries = Object.entries(mem.knowledge)
  if (entries.length === 0) return '(no notes yet)'
  return entries
    .map(([id, b]) => {
      const name = players?.find((p) => p.id === id)?.name ?? id
      const hasClaim =
        !!claimedNames &&
        [...claimedNames].some((n) => n.toLowerCase() === name.toLowerCase())
      const notes = scrubStaleNoClaimLines(b.notes, hasClaim)
      if (!notes.trim()) return null
      return `- ${name}: ${notes}`
    })
    .filter(Boolean)
    .join('\n')
}

/** Persistently drop stale "no claim yet" lines for players on the claim ledger. */
export function pruneStaleNoClaimNotes(
  gameKey: string,
  agentId: ClientId,
  players: PlayerPublic[],
  claimedNames: Set<string>,
): void {
  if (claimedNames.size === 0) return
  const mem = getAgentMemory(gameKey, agentId)
  let changed = false
  for (const [id, belief] of Object.entries(mem.knowledge)) {
    const name = players.find((p) => p.id === id)?.name ?? id
    const hasClaim = [...claimedNames].some(
      (n) => n.toLowerCase() === name.toLowerCase(),
    )
    if (!hasClaim) continue
    const scrubbed = scrubStaleNoClaimLines(belief.notes, true)
    if (scrubbed !== belief.notes) {
      if (scrubbed.trim()) {
        mem.knowledge[id] = { ...belief, notes: scrubbed }
      } else {
        delete mem.knowledge[id]
      }
      changed = true
    }
  }
  if (changed) persist()
}
