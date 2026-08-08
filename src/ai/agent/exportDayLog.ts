import { roleName } from '../../game/roles'
import {
  NO_VOTE_TARGET,
  type WerewolfSnapshot,
} from '../../game/werewolfTypes'
import type { SessionSnapshot } from '../../net/protocol'
import type { ClientId } from '../../session/types'
import { aiProfileById } from '../aiPlayers'
import { loadAiStore } from '../aiStore'
import type { AiTransport, OllamaKeepAlive } from '../types'
import { buildGlobalPublicClaimBoard, formatClaimLedger, formatSpokenNightStories } from './claimLedger'
import { DAY_RULES, LOBBY_RULES, ROLE_RULES_REFERENCE, SAFETY_GUARDRAILS } from './teamStrategy'
import { gameKeyOf } from './gameKey'
import { listAgentMemoriesForGame } from './memory'
import { buildPrivateObservation } from './privateView'

/** Provider + model config snapshot for reproducing AI behavior (no API keys). */
export type DayPhaseModelRef = {
  configId: string | null
  configLabel: string | null
  modelId: string | null
  settings: {
    temperature: number
    maxTokens: number
    thinking: boolean
    numCtx: number
    keepAlive: OllamaKeepAlive
    topP: number
    topK: number
    sglTopK: number
    sglMinP: number
    sglRepetitionPenalty: number
    sglEnableThinking: boolean
    sglJsonObject: boolean
  } | null
  provider: {
    id: string
    label: string
    transport: AiTransport
    baseUrl: string
    requiresApiKey: boolean
  } | null
  /** True when classifier fell back to the active work config. */
  usedWorkFallback?: boolean
}

export type DayPhaseLog = {
  version: 3
  kind: 'onw-day-phase-log'
  purpose: string
  exportedAt: string
  roomCode: string
  gameKey: string
  harness: {
    dayRules: string
    lobbyRules: string
    roleRules: string
    safetyGuardrails: string
    workModel: DayPhaseModelRef
    classifierModel: DayPhaseModelRef
  }
  outcome: {
    winners: WerewolfSnapshot['winners']
    winMessage: string | null
    timeoutVillageWin: boolean
    killedIds: string[]
    killedNames: string[]
    hunterKillId: string | null
    hunterKillName: string | null
    votes: Array<{
      voterId: string
      voterName: string
      targetId: string
      targetName: string
    }>
  }
  table: {
    players: Array<{
      id: string
      name: string
      isNpc: boolean
      aiProfileId: string | null
      persona: string | null
      dealtRole: string | null
      finalRole: string | null
      voteTargetId: string | null
      voteTargetName: string | null
    }>
    dealtCenter: string[]
    finalCenter: string[]
    nightActions: WerewolfSnapshot['nightActions']
  }
  claimLedger: string
  spokenNightStories: string
  /** Unified public board injected into agent prompts (claims may be lies). */
  publicClaimBoard: string
  dayChat: Array<{
    at: string
    fromId: string
    name: string
    via: 'stt' | 'agent' | 'system' | 'narrator'
    text: string
  }>
  agents: Array<{
    id: string
    name: string
    aiProfileId: string | null
    persona: string | null
    dealtRole: string | null
    finalRole: string | null
    /** Frozen at first day reply when available. */
    privateObservationAtDay: string | null
    /** Rebuilt at export time (may be reveal/ended). */
    privateObservationAtExport: string
    lastPlan: {
      claim: string | null
      suspects: string[]
      goal: string
      answerDirectly: boolean
      beliefUpdates: Array<{ aboutName: string; notes: string }>
    } | null
    knowledge: Array<{
      aboutId: string
      aboutName: string
      notes: string
      updatedAt: string
    }>
    modelChat: Array<{ role: string; content: string }>
    replyTraces: Array<{
      at: string
      mode: 'day' | 'lobby' | 'result'
      humanTranscript: string
      humanFromId: string | null
      humanName: string | null
      responders: string[]
      plan: {
        claim: string | null
        suspects: string[]
        goal: string
        answerDirectly: boolean
      } | null
      planRaw: string | null
      planModelId: string | null
      rawSpeak: string
      cleanedText: string
      retried: boolean
      workModelId: string | null
      latencyMs: number
      privateObservation: string | null
    }>
  }>
}

function nameOf(snapshot: SessionSnapshot, id: string): string {
  if (id === NO_VOTE_TARGET) return 'No vote'
  const game = snapshot.game
  return (
    snapshot.players.find((p) => p.id === id)?.name ??
    game?.playerNames[id] ??
    id
  )
}

function modelRef(
  configId: string | null | undefined,
  opts?: { usedWorkFallback?: boolean },
): DayPhaseModelRef {
  const store = loadAiStore()
  const id = configId ?? null
  const config = id ? store.modelConfigs.find((c) => c.id === id) : null
  const provider = config
    ? (store.providers.find((p) => p.id === config.providerId) ?? null)
    : null
  return {
    configId: id,
    configLabel: config?.label ?? null,
    modelId: config?.modelId ?? null,
    settings: config
      ? {
          temperature: config.temperature,
          maxTokens: config.maxTokens,
          thinking: config.thinking,
          numCtx: config.numCtx,
          keepAlive: config.keepAlive,
          topP: config.topP,
          topK: config.topK,
          sglTopK: config.sglTopK,
          sglMinP: config.sglMinP,
          sglRepetitionPenalty: config.sglRepetitionPenalty,
          sglEnableThinking: config.sglEnableThinking,
          sglJsonObject: config.sglJsonObject,
        }
      : null,
    provider: provider
      ? {
          id: provider.id,
          label: provider.label,
          transport: provider.transport,
          baseUrl: provider.baseUrl,
          requiresApiKey: provider.requiresApiKey,
        }
      : null,
    ...(opts?.usedWorkFallback ? { usedWorkFallback: true } : {}),
  }
}

/** Build a host-side feedback log for tuning day-phase AI. */
export function buildDayPhaseLog(snapshot: SessionSnapshot): DayPhaseLog {
  const game = snapshot.game
  if (!game || snapshot.gameId !== 'werewolf') {
    throw new Error('No werewolf game to export')
  }

  const gKey = gameKeyOf(snapshot)
  const store = loadAiStore()
  const memories = listAgentMemoriesForGame(gKey)
  const memoryById = new Map(memories.map((m) => [m.agentId, m.memory]))

  const players = game.playerIds.map((id) => {
    const p = snapshot.players.find((x) => x.id === id)
    const profile = p?.aiProfileId ? aiProfileById(p.aiProfileId) : null
    const voteTargetId = game.votes[id] ?? null
    return {
      id,
      name: nameOf(snapshot, id),
      isNpc: Boolean(p?.isNpc),
      aiProfileId: p?.aiProfileId ?? null,
      persona: profile?.persona ?? null,
      dealtRole: game.dealtRoles[id] ? roleName(game.dealtRoles[id]!) : null,
      finalRole: game.roles[id] ? roleName(game.roles[id]!) : null,
      voteTargetId,
      voteTargetName: voteTargetId ? nameOf(snapshot, voteTargetId) : null,
    }
  })

  const tablePlayers = snapshot.players.filter((p) =>
    game.playerIds.includes(p.id),
  )
  // Public board for export (spoken claims only; no private plans / dealt cards).
  const publicBoard = buildGlobalPublicClaimBoard({
    players: tablePlayers,
    chatLines: snapshot.chatLines ?? [],
  })
  const ledger = publicBoard.entries
  const nightStories = publicBoard.stories

  const npcIds = new Set<ClientId>([
    ...players.filter((p) => p.isNpc).map((p) => p.id as ClientId),
    ...memories.map((m) => m.agentId),
  ])

  const agents = [...npcIds].map((id) => {
    const p = players.find((x) => x.id === id)
    const profile = p?.aiProfileId ? aiProfileById(p.aiProfileId) : null
    const mem = memoryById.get(id)
    const knowledge = Object.entries(mem?.knowledge ?? {}).map(
      ([aboutId, b]) => ({
        aboutId,
        aboutName: nameOf(snapshot, aboutId),
        notes: b.notes,
        updatedAt: new Date(b.updatedAt).toISOString(),
      }),
    )
    return {
      id,
      name: p?.name ?? nameOf(snapshot, id),
      aiProfileId: p?.aiProfileId ?? null,
      persona: profile?.persona ?? null,
      dealtRole: p?.dealtRole ?? null,
      finalRole: p?.finalRole ?? null,
      privateObservationAtDay: mem?.dayObservation ?? null,
      privateObservationAtExport: buildPrivateObservation(
        game,
        snapshot.players,
        id,
      ),
      lastPlan: mem?.lastPlan
        ? {
            claim: mem.lastPlan.claim,
            suspects: mem.lastPlan.suspects,
            goal: mem.lastPlan.goal,
            answerDirectly: mem.lastPlan.answerDirectly,
            beliefUpdates: mem.lastPlan.beliefUpdates,
          }
        : null,
      knowledge,
      modelChat: (mem?.chat ?? []).map((m) => ({
        role: m.role,
        content: m.content,
      })),
      replyTraces: (mem?.traces ?? []).map((t) => ({
        at: new Date(t.at).toISOString(),
        mode: t.mode,
        humanTranscript: t.humanTranscript,
        humanFromId: t.humanFromId ?? null,
        humanName: t.humanName ?? null,
        responders: t.responders,
        plan: t.plan
          ? {
              claim: t.plan.claim,
              suspects: t.plan.suspects,
              goal: t.plan.goal,
              answerDirectly: t.plan.answerDirectly,
            }
          : null,
        planRaw: t.planRaw,
        planModelId: t.planModelId,
        rawSpeak: t.rawSpeak,
        cleanedText: t.cleanedText,
        retried: t.retried,
        workModelId: t.workModelId,
        latencyMs: t.latencyMs,
        privateObservation: t.privateObservation,
      })),
    }
  })

  const classifierConfigured = Boolean(store.activeClassifierConfigId)
  const classifierConfigId =
    store.activeClassifierConfigId ?? store.activeWorkConfigId

  return {
    version: 3,
    kind: 'onw-day-phase-log',
    purpose:
      'Feedback dump for improving One Night AI Werewolf day-phase AI agents: table talk, private info, beliefs, model chat, plans, reply traces, provider/model settings, and game outcome.',
    exportedAt: new Date().toISOString(),
    roomCode: snapshot.roomCode,
    gameKey: gKey,
    harness: {
      dayRules: DAY_RULES,
      lobbyRules: LOBBY_RULES,
      roleRules: ROLE_RULES_REFERENCE,
      safetyGuardrails: SAFETY_GUARDRAILS,
      workModel: modelRef(store.activeWorkConfigId),
      classifierModel: modelRef(classifierConfigId, {
        usedWorkFallback: !classifierConfigured && Boolean(classifierConfigId),
      }),
    },
    outcome: {
      winners: game.winners,
      winMessage: game.winMessage,
      timeoutVillageWin: game.timeoutVillageWin,
      killedIds: [...game.killedIds],
      killedNames: game.killedIds.map((id) => nameOf(snapshot, id)),
      hunterKillId: game.hunterKillId,
      hunterKillName: game.hunterKillId
        ? nameOf(snapshot, game.hunterKillId)
        : null,
      votes: Object.entries(game.votes).map(([voterId, targetId]) => ({
        voterId,
        voterName: nameOf(snapshot, voterId),
        targetId,
        targetName: nameOf(snapshot, targetId),
      })),
    },
    table: {
      players,
      dealtCenter: game.dealtCenter.map(roleName),
      finalCenter: game.center.map(roleName),
      nightActions: game.nightActions,
    },
    claimLedger: formatClaimLedger(ledger),
    spokenNightStories: formatSpokenNightStories(nightStories),
    publicClaimBoard: publicBoard.text,
    dayChat: (snapshot.chatLines ?? []).map((l) => ({
      at: new Date(l.at).toISOString(),
      fromId: l.fromId,
      name: l.name,
      via: l.via,
      text: l.text,
      ...(typeof l.dayMsLeft === 'number' ? { dayMsLeft: l.dayMsLeft } : {}),
    })),
    agents,
  }
}

export function downloadDayPhaseLog(snapshot: SessionSnapshot): void {
  const log = buildDayPhaseLog(snapshot)
  const stamp = log.exportedAt.replace(/[:.]/g, '-').slice(0, 19)
  const filename = `onw-day-log-${log.roomCode || 'room'}-${stamp}.json`
  const blob = new Blob([`${JSON.stringify(log, null, 2)}\n`], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
