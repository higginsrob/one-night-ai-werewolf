import { useCallback, useEffect, useRef } from 'react'
import { aiProfileById, type AiPlayerProfile } from '../ai/aiPlayers'
import {
  MAX_AGENT_CHAT_STREAK,
  MAX_WATCH_AGENT_CHAT_STREAK,
  pickInterviewFollowUp,
} from '../ai/agent/addressing'
import {
  classifyResponders,
  enforceSpeakBudget,
} from '../ai/agent/classifier'
import {
  generateDayReply,
  generateEndReply,
  generateLobbyReply,
} from '../ai/agent/dayReply'
import {
  scriptedDayReply,
  scriptedEndReply,
} from '../ai/agent/scriptedDayReply'
import { publishAiHostError } from '../ai/hostErrors'
import {
  inferenceBlockedReason,
  noteInferenceFailure,
} from '../ai/inferenceHealth'
import { checkAiReadiness } from '../ai/readiness'
import { speakTts, stopTts } from '../game/tts'
import { isBrowserTtsSpeaking } from '../game/browserTts'
import {
  speechPhaseFromSession,
  type VoiceDesignOverrides,
} from '../game/omniVoiceSpeech'
import { gameKeyOf } from '../ai/agent/gameKey'
import { EVAL_BANTER_DONE_EVENT, isEvalMode } from '../eval/evalMode'
import { sessionChatLive, sessionNpcSpeakLive } from '../session/chatLive'
import { currentHostId } from '../session/sessionStore'
import type { ClientId } from '../session/types'
import {
  losingPlayerIdsFromGame,
  winningPlayerIdsFromGame,
} from '../scene/winningSeat'
import type { ClientIntent, SessionSnapshot } from './protocol'

type Args = {
  enabled: boolean
  snapshot: SessionSnapshot | null
  injectIntent: (from: ClientId, intent: ClientIntent) => void
}

const MAX_QUEUE = 8

type PendingHumanLine = {
  id: string
  fromId: ClientId
  text: string
  /** Table event (vote) rather than spoken STT. */
  via?: 'stt' | 'system'
}

function newChatLineId(): string {
  return `chat_${Math.random().toString(36).slice(2, 10)}`
}

function pickConnectedAi(
  snap: SessionSnapshot,
  candidateIds: ClientId[],
): ClientId | null {
  const pool = candidateIds.filter((id) => {
    const p = snap.players.find((x) => x.id === id)
    return Boolean(p?.connected && p.isNpc && p.aiProfileId)
  })
  if (pool.length === 0) return null
  return pool[Math.floor(Math.random() * pool.length)] ?? null
}

/** One AI winner + one AI loser when possible (ordered: winner, then loser). */
function pickResultBanterSpeakers(snap: SessionSnapshot): ClientId[] {
  const game = snap.game
  if (!game?.winners) return []
  const winners = winningPlayerIdsFromGame(snap.gameId, game)
  const losers = losingPlayerIdsFromGame(snap.gameId, game)
  const winnerAi = pickConnectedAi(snap, winners)
  const loserAi = pickConnectedAi(
    snap,
    losers.filter((id) => id !== winnerAi),
  )
  const out: ClientId[] = []
  if (winnerAi) out.push(winnerAi)
  if (loserAi) out.push(loserAi)
  return out
}

type StreamResult = {
  lineId: string
  reply: string
  /** Ensure final text is published (idempotent; no-op if already finalized). */
  commit: () => void
  /** Drop the thinking shell / bubble if still present. */
  discard: () => void
}

/**
 * Generate an AI reply with a thinking shell (name + throbber) while the request
 * runs. Token partials are not shown — the bubble jumps to the final cleaned
 * text when the request completes (avoids stream→cleanup flash).
 */
function streamAgentReply(args: {
  npcId: ClientId
  inject: (from: ClientId, intent: ClientIntent) => void
  generate: (
    onPartial: (accumulated: string) => void,
  ) => Promise<string>
}): Promise<StreamResult> {
  const lineId = newChatLineId()
  let opened = false
  let latest = ''
  let finalReply = ''
  let discarded = false
  let finalized = false

  const patch = (text: string, streaming: boolean) => {
    args.inject(args.npcId, {
      type: 'chat.patch',
      id: lineId,
      text,
      streaming,
    })
  }

  const open = (text: string, streaming: boolean) => {
    if (opened || discarded) return
    opened = true
    args.inject(args.npcId, {
      type: 'chat.append',
      fromId: args.npcId,
      text,
      via: 'agent',
      id: lineId,
      streaming,
    })
  }

  const finalize = (text: string) => {
    if (discarded || finalized) return
    const cleaned = text.trim()
    if (!cleaned) return
    finalized = true
    if (!opened) {
      open(cleaned, false)
      return
    }
    patch(cleaned, false)
  }

  const commit = () => {
    finalize(finalReply || latest)
  }

  const discard = () => {
    if (discarded) return
    discarded = true
    if (opened) {
      args.inject(args.npcId, { type: 'chat.remove', id: lineId })
    }
  }

  // Thinking shell immediately — no token streaming into the bubble.
  open('', true)

  return args
    .generate((accumulated) => {
      latest = accumulated
    })
    .then((reply) => {
      finalReply = reply
      if (reply) finalize(reply)
      return { lineId, reply, commit, discard }
    })
    .catch((err) => {
      const error = err instanceof Error ? err : new Error(String(err))
      ;(error as Error & { lineId?: string }).lineId = lineId
      ;(error as Error & { discard?: () => void }).discard = discard
      throw error
    })
}

export type DayChatDriverApi = {
  /** Stop AI player TTS, drop queued turns, and release the chat floor. */
  stopPlayerTts: () => void
  /** Cancel in-flight player TTS without dropping the chat turn queue. */
  silencePlayerTts: () => void
  /**
   * Host-only: prompt one seated AI to contribute a line from chat history
   * (question or statement), without waiting for a human utterance.
   */
  promptNpcSpeak: (npcId: ClientId) => void
}

/**
 * Host-only: watch shared chat for new human lines, classify responders,
 * generate ordered AI replies, broadcast chat, and speak via Web Speech.
 * Holds the human chat floor until each turn chain (all responders + TTS) finishes.
 * Prefetches agent replies ahead of the current TTS utterance (2 ahead in
 * watch/spectator mode, 1 ahead otherwise) so speech stays continuous.
 * While a request runs, a thinking shell (name + throbber) is shown; the final
 * cleaned text replaces it when the request completes (no token streaming).
 * Agents may interview other agents by name; follow-ups are capped so at most
 * {@link MAX_AGENT_CHAT_STREAK} AI replies land before a human must speak again.
 */
export function useDayChatDriver({
  enabled,
  snapshot,
  injectIntent,
}: Args): DayChatDriverApi {
  const snapRef = useRef(snapshot)
  snapRef.current = snapshot
  const queueRef = useRef<PendingHumanLine[]>([])
  const pumpingRef = useRef(false)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const injectRef = useRef(injectIntent)
  injectRef.current = injectIntent
  /** Skip remaining TTS / responders for the in-flight turn. */
  const abortSpeechRef = useRef(false)
  /**
   * Set by silencePlayerTts so the in-flight speak await can treat cancel as
   * intentional (advance to next seat) vs unexpected mid-utterance interrupt.
   */
  const silenceIntentRef = useRef(false)
  /**
   * Bumped when queued/in-flight day work is invalidated (Esc, leave day,
   * result banter). In-flight chains capture the value at start and exit when
   * it changes — even if a later turn clears abortSpeechRef.
   */
  const workGenRef = useRef(0)
  /** Lines already queued or answered — seeded when the driver enables. */
  const seenIdsRef = useRef<Set<string>>(new Set())
  const seededRef = useRef(false)
  /** Game keys that already got automatic winner/loser aftergame lines. */
  const celebratedGamesRef = useRef<Set<string>>(new Set())
  const celebratingRef = useRef(false)
  /** Last seen werewolf phase — used to abort day turns when the round ends. */
  const prevGamePhaseRef = useRef<string | null>(null)
  /** Last AI who volunteered in watch-mode day (rotate speakers). */
  const lastWatchSpeakerRef = useRef<ClientId | null>(null)

  const setTurn = useCallback(
    (locked: boolean, respondingId: ClientId | null = null) => {
      const snap = snapRef.current
      const hostId = snap ? currentHostId(snap) : null
      if (!hostId) return
      injectRef.current(hostId, {
        type: 'chat.setTurn',
        locked,
        respondingId: locked ? respondingId : null,
      })
    },
    [],
  )

  const publishAgentLine = useCallback(
    (npcId: ClientId, text: string, lineId?: string) => {
      if (lineId) {
        injectRef.current(npcId, {
          type: 'chat.patch',
          id: lineId,
          text,
          streaming: false,
        })
        return
      }
      injectRef.current(npcId, {
        type: 'chat.append',
        fromId: npcId,
        text,
        via: 'agent',
      })
    },
    [],
  )

  /** Drop queued human turns, stop TTS, and signal in-flight chains to exit. */
  const invalidateQueuedTurns = useCallback(() => {
    workGenRef.current += 1
    abortSpeechRef.current = true
    silenceIntentRef.current = false
    queueRef.current = []
    stopTts()
  }, [])

  const stopPlayerTts = useCallback(() => {
    invalidateQueuedTurns()
    celebratingRef.current = false
    // Release the pump latch immediately — in-flight LLM may still finish, but
    // workGen makes its finally a no-op so Speak / lobby turns are not blocked.
    pumpingRef.current = false
    // Unlock immediately so humans can talk while any in-flight LLM call finishes.
    if (snapRef.current?.chatLocked) {
      setTurn(false)
    }
  }, [invalidateQueuedTurns, setTurn])

  /** Cut current/scheduled TTS only — in-flight reply chain continues to the next seat. */
  const silencePlayerTts = useCallback(() => {
    silenceIntentRef.current = true
    stopTts()
  }, [])

  const speakNpcChain = useCallback(
    async (args: {
      snap: SessionSnapshot
      responders: ClientId[]
      humanTranscript: string
      humanFromId: ClientId | null
      useScripted: boolean
      proactive?: boolean
      /** workGen at chain start — mismatch means this turn was invalidated. */
      workGen: number
    }) => {
      const {
        snap,
        responders,
        humanTranscript,
        humanFromId,
        useScripted,
        proactive = false,
        workGen,
      } = args
      const inLobby = snap.phase === 'lobby'
      const inReveal =
        snap.phase === 'playing' && snap.game?.phase === 'reveal'
      /** Day chains must stop as soon as the round leaves day (reveal/vote/etc.). */
      const dayChain = !inLobby && !inReveal
      /** Interview follow-ups during day/lobby — not aftergame banter. */
      const allowInterviewFollowUps = !inReveal
      const saidThisTurn: string[] = []
      const spokenIds: ClientId[] = []
      const speakBudget = snap.watchMode
        ? MAX_WATCH_AGENT_CHAT_STREAK
        : MAX_AGENT_CHAT_STREAK
      const queue: ClientId[] = responders
        .filter((id, i, arr) => arr.indexOf(id) === i)
        .slice(0, speakBudget)

      type PreparedUtterance = {
        npcId: ClientId
        profile: AiPlayerProfile
        reply: string
        lineId?: string
        commit: () => void
        discard: () => void
      }

      const dropUnspokenLine = (prepared: PreparedUtterance) => {
        prepared.discard()
      }

      const chainStale = () => {
        if (!enabledRef.current || abortSpeechRef.current) return true
        if (workGenRef.current !== workGen) return true
        const live = snapRef.current
        if (!live) return true
        // Day chains must stop for night, end-scene, and End game → lobby
        // (lobby clears `game`, so a null phase must count as stale).
        if (dayChain) {
          return live.phase !== 'playing' || live.game?.phase !== 'day'
        }
        if (inReveal) {
          return (
            live.phase !== 'playing' ||
            live.game?.phase !== 'reveal' ||
            live.game.revealStage !== 'result'
          )
        }
        if (inLobby) {
          return live.phase !== 'lobby'
        }
        return false
      }

      /** Latest line this seat is answering (human kickoff, then prior AI). */
      let lineTranscript = humanTranscript
      let lineFromId = humanFromId

      /**
       * Prefetch depth ahead of the utterance currently playing.
       * Watch/spectator streaks are longer — keep 2 replies warm so TTS gaps stay short.
       */
      const prefetchAhead = snap.watchMode ? 2 : 1
      /** Prepared seats waiting to speak (not including the one currently playing). */
      const readyQueue: PreparedUtterance[] = []
      /** Generation epoch — bumped when interview follow-ups invalidate prefetched seats. */
      let prefetchEpoch = 0
      let prefetchPump: Promise<void> | null = null

      const takeNextSpeaker = (): ClientId | null => {
        // spokenIds + readyQueue are already committed seats for this turn.
        if (spokenIds.length + readyQueue.length >= speakBudget) return null
        while (queue.length > 0) {
          const npcId = queue.shift()!
          const npc = snap.players.find((p) => p.id === npcId)
          if (npc?.connected && npc.isNpc && npc.aiProfileId) return npcId
        }
        return null
      }

      const prepareNpcReply = async (
        npcId: ClientId,
      ): Promise<PreparedUtterance | null> => {
        const npc = snap.players.find((p) => p.id === npcId)
        const profile = npc?.aiProfileId
          ? aiProfileById(npc.aiProfileId)
          : null
        if (!npc || !profile) return null
        if (chainStale()) return null

        setTurn(true, npcId)

        const live = snapRef.current ?? snap
        let reply = ''
        let lineId: string | undefined
        let commit = () => {}
        let discard = () => {}
        const chainResponders = [
          ...spokenIds,
          npcId,
          ...queue.filter((id) => id !== npcId),
        ]

        const stillBlocked = Boolean(inferenceBlockedReason())
        if (useScripted || stillBlocked) {
          if (chainStale()) return null
          reply = inReveal
            ? scriptedEndReply({
                snapshot: live,
                npcId,
                profile,
                humanTranscript: lineTranscript,
                avoidTexts: saidThisTurn,
              })
            : scriptedDayReply({
                snapshot: live,
                npcId,
                profile,
                humanTranscript: lineTranscript,
                humanFromId: lineFromId,
                avoidTexts: saidThisTurn,
              })
          if (chainStale()) return null
          if (reply) {
            let committed = false
            commit = () => {
              if (committed) return
              committed = true
              publishAgentLine(npcId, reply)
            }
            discard = () => {
              committed = true
            }
          }
        } else {
          try {
            const streamed = await streamAgentReply({
              npcId,
              inject: injectRef.current,
              generate: (onPartial) => {
                if (inLobby) {
                  return generateLobbyReply({
                    snapshot: live,
                    npcId,
                    profile,
                    humanTranscript: lineTranscript,
                    humanFromId: lineFromId,
                    responders: chainResponders,
                    avoidTexts: saidThisTurn,
                    onPartial,
                    proactive,
                  })
                }
                if (inReveal) {
                  return generateEndReply({
                    snapshot: live,
                    npcId,
                    profile,
                    humanTranscript: lineTranscript,
                    humanFromId: lineFromId,
                    responders: chainResponders,
                    avoidTexts: saidThisTurn,
                    onPartial,
                    proactive,
                  })
                }
                return generateDayReply({
                  snapshot: live,
                  npcId,
                  profile,
                  humanTranscript: lineTranscript,
                  humanFromId: lineFromId,
                  responders: chainResponders,
                  avoidTexts: saidThisTurn,
                  onPartial,
                  proactive,
                })
              },
            })
            lineId = streamed.lineId
            reply = streamed.reply
            commit = streamed.commit
            discard = streamed.discard
          } catch (err) {
            lineId = (err as { lineId?: string }).lineId
            const errDiscard = (err as { discard?: () => void }).discard
            if (errDiscard) discard = errDiscard
            else if (lineId) {
              discard = () => {
                injectRef.current(npcId, { type: 'chat.remove', id: lineId! })
              }
            }
            publishAiHostError(noteInferenceFailure(err))
            reply = ''
          }

          if (chainStale()) {
            discard()
            return null
          }

          if (!reply) {
            reply = inReveal
              ? scriptedEndReply({
                  snapshot: live,
                  npcId,
                  profile,
                  humanTranscript: lineTranscript,
                  avoidTexts: saidThisTurn,
                })
              : scriptedDayReply({
                  snapshot: live,
                  npcId,
                  profile,
                  humanTranscript: lineTranscript,
                  humanFromId: lineFromId,
                  avoidTexts: saidThisTurn,
                })
            if (chainStale()) {
              discard()
              return null
            }
            if (reply) {
              // Fill the thinking shell with scripted fallback (no stream flash).
              const scripted = reply
              publishAgentLine(npcId, scripted, lineId)
              let dropped = false
              commit = () => {}
              discard = () => {
                if (dropped || !lineId) return
                dropped = true
                injectRef.current(npcId, { type: 'chat.remove', id: lineId })
              }
            } else {
              discard()
              return null
            }
          }
        }

        if (!reply || chainStale()) {
          if (chainStale()) discard()
          return null
        }
        return { npcId, profile, reply, lineId, commit, discard }
      }

      /**
       * Fill `readyQueue` up to `prefetchAhead` seats. Serial via aiJobQueue;
       * runs in the background while TTS plays so the next 1–2 replies stay warm.
       *
       * Always start the pump on a microtask (`Promise.resolve().then`) so an
       * empty queue never completes the async work during `ensurePrefetch()`
       * itself. A sync exit used to leave a resolved Promise stuck in
       * `prefetchPump`, and `awaitPrefetch` would spin forever (tab freeze)
       * — especially when the speak chain ended and looked for a next seat.
       */
      const ensurePrefetch = () => {
        if (prefetchPump) return
        const pump = Promise.resolve().then(async () => {
          while (!chainStale()) {
            if (readyQueue.length >= prefetchAhead) break
            if (spokenIds.length + readyQueue.length >= speakBudget) break
            const epoch = prefetchEpoch
            const nextId = takeNextSpeaker()
            if (!nextId) break
            const prepared = await prepareNpcReply(nextId)
            if (epoch !== prefetchEpoch) {
              if (prepared) dropUnspokenLine(prepared)
              continue
            }
            if (prepared) readyQueue.push(prepared)
          }
        })
        prefetchPump = pump
        void pump.finally(() => {
          if (prefetchPump === pump) prefetchPump = null
        })
      }

      const awaitPrefetch = async (): Promise<PreparedUtterance | null> => {
        while (!chainStale()) {
          if (readyQueue.length > 0) {
            const next = readyQueue.shift()!
            ensurePrefetch()
            return next
          }
          ensurePrefetch()
          const pending = prefetchPump
          if (!pending) return null
          try {
            await pending
          } catch {
            // Prepare failures are handled per-seat; keep draining the queue.
          }
          // Pump finished. Either we have a ready utterance (loop) or nothing
          // left — do not re-kick here. A sync empty kick + fall-through without
          // await used to busy-spin the main thread when the chain completed.
          if (readyQueue.length === 0) return null
        }
        return null
      }

      const discardReadyQueue = () => {
        for (const u of readyQueue) dropUnspokenLine(u)
        readyQueue.length = 0
      }

      const discardPrefetch = async () => {
        prefetchEpoch += 1
        discardReadyQueue()
        const pending = prefetchPump
        if (!pending) return
        try {
          await pending
        } catch {
          // ignore
        }
        discardReadyQueue()
      }

      try {
        let current = await awaitPrefetch()

        while (current) {
          if (chainStale()) {
            dropUnspokenLine(current)
            break
          }

          saidThisTurn.push(current.reply)
          spokenIds.push(current.npcId)

          if (
            allowInterviewFollowUps &&
            spokenIds.length < speakBudget
          ) {
            const followUp = pickInterviewFollowUp({
              reply: current.reply,
              snapshot: snapRef.current ?? snap,
              speakerId: current.npcId,
              // Only skip self — a prior speaker may be asked a follow-up question.
              excludeIds: [current.npcId],
            })
            if (followUp) {
              // Interview takes over the rest of this turn (still capped by speakBudget).
              // Drop seats prepared against the old responder order.
              prefetchEpoch += 1
              discardReadyQueue()
              queue.length = 0
              queue.push(followUp)
              lineTranscript = current.reply
              lineFromId = current.npcId
            }
          }

          // Keep up to prefetchAhead LLM replies warm while this seat speaks.
          ensurePrefetch()

          const speaking = current
          const voiceDesign: VoiceDesignOverrides = {
            voiceAge: speaking.profile.voiceAge,
            voiceGender: speaking.profile.voiceGender,
            voiceAccent: speaking.profile.voiceAccent,
          }
          const speechPhase = speechPhaseFromSession({
            phase: snap.phase,
            gamePhase: snap.game?.phase ?? null,
          })
          setTurn(true, speaking.npcId)
          // Ensure final text is published before TTS (usually already finalized).
          speaking.commit()

          silenceIntentRef.current = false
          let unexpectedCancel = false
          await new Promise<void>((resolve) => {
            let settled = false
            const done = () => {
              if (settled) return
              settled = true
              resolve()
            }
            speakTts(speaking.reply, {
              browserVoiceURI: speaking.profile.voiceURI || null,
              apiVoiceId: speaking.profile.apiVoiceId || null,
              speakerId: speaking.npcId,
              speechPhase,
              voiceDesign,
              onStart: () => {
                ensurePrefetch()
              },
              onEnd: () => {
                silenceIntentRef.current = false
                done()
              },
              onError: () => {
                const intentionalSilence = silenceIntentRef.current
                const intentionalAbort =
                  abortSpeechRef.current ||
                  workGenRef.current !== workGen
                silenceIntentRef.current = false
                if (intentionalSilence || intentionalAbort) {
                  done()
                  return
                }
                // Spurious interrupt/cancel — end this wait but do not advance
                // the speak chain to the next seat (avoids cutting into a steal).
                unexpectedCancel = true
                done()
              },
            })
          })

          if (chainStale() || unexpectedCancel) {
            if (unexpectedCancel && !chainStale()) {
              await discardPrefetch()
            }
            break
          }
          current = await awaitPrefetch()
        }
      } finally {
        await discardPrefetch()
      }
    },
    [publishAgentLine, setTurn],
  )

  const processOne = useCallback(
    async (pending: PendingHumanLine) => {
      const snap = snapRef.current
      if (!enabledRef.current || !snap) return

      const chatOk = sessionChatLive({
        phase: snap.phase,
        gamePhase: snap.game?.phase,
      })
      if (!chatOk) return

      // Don't resume day turns after the round has moved on.
      // Aftergame only after the end-scene recap reaches the result stage.
      if (
        snap.phase === 'playing' &&
        snap.game?.phase !== 'day' &&
        !(
          snap.game?.phase === 'reveal' &&
          snap.game.revealStage === 'result' &&
          Boolean(snap.game.winners)
        )
      ) {
        return
      }

      const readiness = checkAiReadiness()
      if (!readiness.ready) {
        publishAiHostError(readiness.reason ?? 'AI not ready')
        return
      }

      const workGen = workGenRef.current
      abortSpeechRef.current = false

      const trimmed = pending.text
      const blocked = inferenceBlockedReason()
      const useScripted = Boolean(blocked)
      if (blocked) publishAiHostError(blocked)

      // Floor is already locked by human append; announce thinking until a speaker starts.
      setTurn(true, null)

      let responders: ClientId[]
      if (useScripted) {
        // Name-mention routing without classifier LLM.
        const npcs = snap.players.filter(
          (p) =>
            p.connected &&
            p.isNpc &&
            p.aiProfileId &&
            p.id !== pending.fromId,
        )
        const mentioned = npcs.filter((p) =>
          trimmed.toLowerCase().includes(p.name.toLowerCase()),
        )
        responders = enforceSpeakBudget({
          snapshot: snap,
          transcript: trimmed,
          responders:
            mentioned.length > 0
              ? mentioned.map((p) => p.id)
              : npcs.slice(0, 1).map((p) => p.id),
        })
      } else {
        try {
          responders = await classifyResponders({
            snapshot: snap,
            transcript: trimmed,
            humanFromId: pending.fromId,
          })
        } catch (err) {
          publishAiHostError(noteInferenceFailure(err))
          const npcs = snap.players.filter(
            (p) =>
              p.connected &&
              p.isNpc &&
              p.aiProfileId &&
              p.id !== pending.fromId,
          )
          const mentioned = npcs.filter((p) =>
            trimmed.toLowerCase().includes(p.name.toLowerCase()),
          )
          responders = enforceSpeakBudget({
            snapshot: snap,
            transcript: trimmed,
            responders:
              mentioned.length > 0
                ? mentioned.map((p) => p.id)
                : npcs.slice(0, 1).map((p) => p.id),
          })
        }
      }
      // Never have the casting seat reply to its own vote announcement.
      responders = responders.filter((id) => id !== pending.fromId)

      if (
        !enabledRef.current ||
        abortSpeechRef.current ||
        workGenRef.current !== workGen
      ) {
        return
      }

      await speakNpcChain({
        snap,
        responders,
        humanTranscript: trimmed,
        humanFromId: pending.fromId,
        useScripted,
        workGen,
      })
    },
    [setTurn, speakNpcChain],
  )

  const runResultBanter = useCallback(
    async (snap: SessionSnapshot, gameKey: string) => {
      if (celebratingRef.current) return
      if (celebratedGamesRef.current.has(gameKey)) return
      const speakers = pickResultBanterSpeakers(snap)
      if (speakers.length === 0) {
        celebratedGamesRef.current.add(gameKey)
        abortSpeechRef.current = false
        if (isEvalMode()) {
          window.dispatchEvent(
            new CustomEvent(EVAL_BANTER_DONE_EVENT, {
              detail: { gameKey },
            }),
          )
        }
        return
      }

      const readiness = checkAiReadiness()
      if (!readiness.ready) {
        // Retry next snapshot tick once AI is ready.
        return
      }

      celebratedGamesRef.current.add(gameKey)
      celebratingRef.current = true
      const workGen = workGenRef.current
      abortSpeechRef.current = false

      const blocked = inferenceBlockedReason()
      if (blocked) publishAiHostError(blocked)

      setTurn(true, null)
      try {
        await speakNpcChain({
          snap,
          responders: speakers,
          humanTranscript:
            snap.game?.winMessage?.trim() ||
            'The round just ended — react to the result.',
          humanFromId: null,
          useScripted: Boolean(blocked),
          proactive: true,
          workGen,
        })
      } catch (err) {
        publishAiHostError(noteInferenceFailure(err))
      } finally {
        if (isEvalMode()) {
          window.dispatchEvent(
            new CustomEvent(EVAL_BANTER_DONE_EVENT, {
              detail: { gameKey },
            }),
          )
        }
        // Stale after End game / Esc — do not clear a newer turn's latches.
        if (workGenRef.current !== workGen) return
        celebratingRef.current = false
        if (enabledRef.current && queueRef.current.length === 0) {
          setTurn(false)
        } else if (queueRef.current.length > 0) {
          void pumpRef.current?.()
        }
      }
    },
    [setTurn, speakNpcChain],
  )

  const pumpRef = useRef<(() => Promise<void>) | null>(null)

  const pump = useCallback(async () => {
    if (pumpingRef.current || celebratingRef.current) return
    pumpingRef.current = true
    const workGen = workGenRef.current
    try {
      while (queueRef.current.length > 0) {
        if (workGenRef.current !== workGen) break
        if (celebratingRef.current) break
        // A prior Esc / phase abort must not permanently kill the pump —
        // each new human line is a fresh turn.
        abortSpeechRef.current = false
        const next = queueRef.current.shift()
        if (!next) break
        try {
          await processOne(next)
        } catch (err) {
          publishAiHostError(noteInferenceFailure(err))
        }
      }
    } finally {
      if (workGenRef.current !== workGen) return
      pumpingRef.current = false
      if (
        queueRef.current.length > 0 &&
        !celebratingRef.current &&
        !abortSpeechRef.current
      ) {
        void pump()
      } else if (enabledRef.current && !celebratingRef.current) {
        // Release the floor only when every queued turn has finished.
        setTurn(false)
        // Human chat may have delayed the aftergame reactions — try now.
        const live = snapRef.current
        if (
          live?.phase === 'playing' &&
          live.game?.phase === 'reveal' &&
          live.game.revealStage === 'result' &&
          live.game.winners
        ) {
          const key = gameKeyOf(live)
          if (!celebratedGamesRef.current.has(key)) {
            void runResultBanter(live, key)
          }
        }
      }
    }
  }, [processOne, setTurn, runResultBanter])

  pumpRef.current = pump

  useEffect(() => {
    if (!enabled) {
      seededRef.current = false
      seenIdsRef.current = new Set()
      queueRef.current = []
      pumpingRef.current = false
      celebratingRef.current = false
      prevGamePhaseRef.current = null
      if (snapRef.current?.chatLocked) {
        setTurn(false)
      }
      return
    }
    const lines = snapshot?.chatLines ?? []
    if (!seededRef.current) {
      seenIdsRef.current = new Set(lines.map((l) => l.id))
      seededRef.current = true
      prevGamePhaseRef.current =
        snapshot?.phase === 'playing' ? (snapshot.game?.phase ?? null) : null
      // If we came online onto an already-locked floor (e.g. human line landed
      // in the same tick), enqueue the latest human line so the pump can reply
      // and release the lock — don't treat it as already answered.
      if (snapshot?.chatLocked) {
        const latestTrigger = [...lines]
          .reverse()
          .find((line) => {
            if (line.via === 'agent' || line.via === 'narrator') return false
            const text = line.text.trim()
            if (!text) return false
            if (line.via === 'system') return true
            const speaker = snapshot.players.find((p) => p.id === line.fromId)
            return Boolean(speaker && !speaker.isNpc)
          })
        if (latestTrigger) {
          seenIdsRef.current.delete(latestTrigger.id)
          queueRef.current.push({
            id: latestTrigger.id,
            fromId: latestTrigger.fromId,
            text: latestTrigger.text.trim(),
            via: latestTrigger.via === 'system' ? 'system' : 'stt',
          })
          void pump()
        } else {
          setTurn(false)
        }
      }
      return
    }

    const chatOk = sessionChatLive({
      phase: snapshot?.phase ?? 'lobby',
      gamePhase: snapshot?.game?.phase,
    })
    if (!chatOk || !snapshot) return

    let enqueued = false
    for (const line of lines) {
      if (seenIdsRef.current.has(line.id)) continue
      if (line.via === 'agent' || line.via === 'narrator') {
        seenIdsRef.current.add(line.id)
        continue
      }
      const text = line.text.trim()
      if (!text) {
        seenIdsRef.current.add(line.id)
        continue
      }

      const isSystemEvent = line.via === 'system'
      if (!isSystemEvent) {
        const speaker = snapshot.players.find((p) => p.id === line.fromId)
        if (!speaker || speaker.isNpc) {
          seenIdsRef.current.add(line.id)
          continue
        }
      } else if (
        // Vote announcements only draw replies while discussion is live.
        snapshot.phase !== 'playing' ||
        snapshot.game?.phase !== 'day'
      ) {
        seenIdsRef.current.add(line.id)
        continue
      }

      // Hold human lines through the end-scene night recap (and hunter pick)
      // until the result stage — then aftergame replies can start.
      if (
        !isSystemEvent &&
        snapshot.phase === 'playing' &&
        snapshot.game?.phase === 'reveal' &&
        snapshot.game.revealStage !== 'result'
      ) {
        continue
      }
      seenIdsRef.current.add(line.id)
      queueRef.current.push({
        id: line.id,
        fromId: line.fromId,
        text,
        via: isSystemEvent ? 'system' : 'stt',
      })
      enqueued = true
    }

    if (queueRef.current.length > MAX_QUEUE) {
      queueRef.current.splice(0, queueRef.current.length - MAX_QUEUE)
    }

    if (enqueued) void pump()
  }, [enabled, snapshot, pump, setTurn])

  // Leaving day: abort in-flight / queued day replies immediately.
  // Entering day / new round: clear leftover abort + aftergame latches so
  // watch-mode volunteers (and Speak) are not blocked by a hung prior turn.
  // End game → lobby: same latch cleanup.
  const prevSessionPhaseRef = useRef<string | null>(null)
  useEffect(() => {
    if (!enabled || !snapshot) {
      prevGamePhaseRef.current = null
      prevSessionPhaseRef.current = null
      return
    }
    const sessionPhase = snapshot.phase
    const prevSession = prevSessionPhaseRef.current
    prevSessionPhaseRef.current = sessionPhase

    const gamePhase =
      snapshot.phase === 'playing' ? (snapshot.game?.phase ?? null) : null
    const prev = prevGamePhaseRef.current
    prevGamePhaseRef.current = gamePhase

    const clearChatLatches = (opts?: { unlock?: boolean }) => {
      celebratingRef.current = false
      pumpingRef.current = false
      abortSpeechRef.current = false
      lastWatchSpeakerRef.current = null
      if (opts?.unlock && snapshot.chatLocked) setTurn(false)
    }

    // Rematch / new deal: drop aftergame banter latches that outlive the old
    // round (celebratingRef is not in React deps, so watch day would stay mute).
    // Do not stopTts here — that would cut the welcome narrator armed on click.
    if (prev !== 'claiming' && gamePhase === 'claiming') {
      workGenRef.current += 1
      queueRef.current = []
      clearChatLatches({ unlock: true })
      return
    }

    if (prev !== 'day' && gamePhase === 'day') {
      // Dawn → day: never carry aftergame / Esc latches into discussion.
      workGenRef.current += 1
      clearChatLatches()
      return
    }

    // Includes lobby (`gamePhase === null`) — previously only non-null phases
    // aborted, so End game mid-day left pumpingRef stuck and Speak was a no-op.
    if (prev === 'day' && gamePhase !== 'day') {
      invalidateQueuedTurns()
      clearChatLatches({ unlock: true })
    }

    if (prevSession === 'playing' && sessionPhase === 'lobby') {
      invalidateQueuedTurns()
      clearChatLatches({ unlock: true })
    }
  }, [enabled, snapshot, invalidateQueuedTurns, setTurn])

  // After the end-scene night recap reaches the result screen: celebrate.
  useEffect(() => {
    if (!enabled || !snapshot) return
    if (snapshot.phase !== 'playing' || snapshot.game?.phase !== 'reveal') return
    if (snapshot.game.revealStage !== 'result') return
    if (!snapshot.game.winners) return
    if (celebratingRef.current) return

    const key = gameKeyOf(snapshot)
    if (celebratedGamesRef.current.has(key)) return

    let cancelled = false
    const start = async () => {
      // Let any leftover day pump drain, then wait for narrator win TTS to finish
      // so AI banter does not cut off the end-scene announcement.
      for (let i = 0; i < 120 && pumpingRef.current; i++) {
        await new Promise((r) => setTimeout(r, 16))
        if (cancelled) return
      }
      for (let i = 0; i < 600 && isBrowserTtsSpeaking(); i++) {
        await new Promise((r) => setTimeout(r, 100))
        if (cancelled) return
      }
      if (cancelled || !enabledRef.current) return
      const live = snapRef.current
      if (
        !live ||
        live.phase !== 'playing' ||
        live.game?.phase !== 'reveal' ||
        live.game.revealStage !== 'result' ||
        !live.game.winners
      ) {
        return
      }
      if (celebratedGamesRef.current.has(key) || celebratingRef.current) return
      void runResultBanter(live, key)
    }
    void start()
    return () => {
      cancelled = true
    }
  }, [enabled, snapshot, runResultBanter])

  const promptNpcSpeak = useCallback(
    (npcId: ClientId) => {
      if (!enabledRef.current) return
      const snap = snapRef.current
      if (!snap) return

      const chatOk = sessionNpcSpeakLive({
        phase: snap.phase,
        gamePhase: snap.game?.phase,
        revealStage: snap.game?.revealStage,
        hasWinners: Boolean(snap.game?.winners),
      })
      if (!chatOk) return

      const npc = snap.players.find((p) => p.id === npcId)
      if (!npc?.connected || !npc.isNpc || !npc.aiProfileId) return

      // Don't interrupt an in-flight turn or result celebration.
      if (
        snap.chatLocked ||
        pumpingRef.current ||
        celebratingRef.current ||
        queueRef.current.length > 0
      ) {
        return
      }

      const readiness = checkAiReadiness()
      if (!readiness.ready) {
        publishAiHostError(readiness.reason ?? 'AI not ready')
        return
      }

      const workGen = workGenRef.current
      abortSpeechRef.current = false
      const blocked = inferenceBlockedReason()
      if (blocked) publishAiHostError(blocked)

      const chatEmpty = !(snap.chatLines ?? []).some((l) => l.text.trim())
      const prompt =
        snap.phase === 'lobby'
          ? chatEmpty
            ? 'You were asked to speak up in an empty lobby. Introduce One Night Ultimate Werewolf briefly and kick off lobby banter with another AI by name. Do not mention empty history or starting fresh; do not ask the human to speak.'
            : 'You were asked to speak up in lobby chat. Read recent table chat first — react to the latest lines, preferably addressing another AI (continue the joke, clap back, or answer). No role/card talk; do not comment on anyone being quiet; do not ask the human to speak up.'
          : snap.game?.phase === 'reveal'
            ? 'You were asked to speak up after the round. Based on the result and recent chat, contribute a short reaction, question, or statement to the group.'
            : snap.watchMode
              ? 'Watch-mode day: keep the conversation going. Probe, interview someone by name, accuse or misdirect for your team, pitch a vote read, or land a short joke — then keep pressure on the table.'
              : 'You were asked to speak up at the table. Based on recent chat history, decide on a short question or statement that moves the discussion forward.'

      pumpingRef.current = true
      setTurn(true, null)
      void (async () => {
        try {
          await speakNpcChain({
            snap,
            responders: [npcId],
            humanTranscript: prompt,
            humanFromId: null,
            useScripted: Boolean(blocked),
            proactive: true,
            workGen,
          })
        } catch (err) {
          publishAiHostError(noteInferenceFailure(err))
        } finally {
          if (workGenRef.current !== workGen) return
          pumpingRef.current = false
          if (enabledRef.current && queueRef.current.length === 0) {
            setTurn(false)
          } else if (queueRef.current.length > 0) {
            void pumpRef.current?.()
          }
        }
      })()
    },
    [setTurn, speakNpcChain],
  )

  // Watch mode: keep day chat moving without waiting for a human utterance.
  // Busy latches (pumping / celebrating) are refs — retry when they clear
  // instead of waiting for a snapshot dep that may never change.
  useEffect(() => {
    if (!enabled || !snapshot?.watchMode) return
    if (snapshot.phase !== 'playing' || snapshot.game?.phase !== 'day') return
    if (snapshot.chatLocked) return

    let cancelled = false
    let timer: number | null = null
    let readinessWarned = false

    const schedule = (ms: number) => {
      if (cancelled) return
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(tick, ms)
    }

    const tick = () => {
      timer = null
      if (cancelled) return
      const live = snapRef.current
      if (!live?.watchMode) return
      if (live.phase !== 'playing' || live.game?.phase !== 'day') return
      if (live.chatLocked) return
      if (
        pumpingRef.current ||
        celebratingRef.current ||
        queueRef.current.length > 0
      ) {
        schedule(750)
        return
      }

      const readiness = checkAiReadiness()
      if (!readiness.ready) {
        if (!readinessWarned) {
          readinessWarned = true
          publishAiHostError(readiness.reason ?? 'AI not ready')
        }
        schedule(2_000)
        return
      }
      readinessWarned = false

      const seated = new Set(live.game.playerIds)
      const pool = live.players.filter(
        (p) =>
          p.connected &&
          p.isNpc &&
          p.aiProfileId &&
          seated.has(p.id),
      )
      if (pool.length === 0) return

      // Prefer seats that have spoken least so silent players get nudged.
      const speakCount = new Map<string, number>()
      for (const p of pool) speakCount.set(p.id, 0)
      for (const line of live.chatLines ?? []) {
        if (!speakCount.has(line.fromId)) continue
        // Skip pure vote lines so a mute seat that only voted still counts as quiet.
        if (/^\s*i\s+vote\s+for\b/i.test(line.text)) continue
        speakCount.set(line.fromId, (speakCount.get(line.fromId) ?? 0) + 1)
      }

      const last = lastWatchSpeakerRef.current
      const ordered = [...pool].sort((a, b) => {
        const ca = speakCount.get(a.id) ?? 0
        const cb = speakCount.get(b.id) ?? 0
        if (ca !== cb) return ca - cb
        if (a.id === last) return 1
        if (b.id === last) return -1
        return Math.random() - 0.5
      })
      const pick = ordered[0]
      if (!pick) return
      lastWatchSpeakerRef.current = pick.id
      promptNpcSpeak(pick.id)
    }

    schedule(1_200 + Math.floor(Math.random() * 1_800))
    return () => {
      cancelled = true
      if (timer != null) window.clearTimeout(timer)
    }
  }, [
    enabled,
    snapshot?.watchMode,
    snapshot?.phase,
    snapshot?.game?.phase,
    snapshot?.chatLocked,
    snapshot?.chatRespondingId,
    snapshot?.chatLines?.length,
    promptNpcSpeak,
  ])

  return { stopPlayerTts, silencePlayerTts, promptNpcSpeak }
}
