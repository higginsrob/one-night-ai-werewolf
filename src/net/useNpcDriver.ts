import { useEffect, useRef, useState } from 'react'
import { aiProfileById } from '../ai/aiPlayers'
import { decideNpcIntent } from '../ai/agent/decideIntent'
import { publishAiHostError } from '../ai/hostErrors'
import {
  inferenceBlockedReason,
  noteInferenceFailure,
} from '../ai/inferenceHealth'
import { checkAiReadiness } from '../ai/readiness'
import { getEvalForcedIntent, isBenchmarkActive } from '../eval/evalStore'
import { playerNeedsNightIntent } from '../game/werewolfLogic'
import type { ClientId } from '../session/types'
import {
  AI_DAY_VOTE_WINDOW_MS,
  aiDayVoteWindowOpen,
  dayMsRemaining,
  pickNextNpcAction,
  scriptedWerewolfIntent,
} from './npcAutoPlay'
import type { ClientIntent, SessionSnapshot } from './protocol'

type Args = {
  enabled: boolean
  snapshot: SessionSnapshot | null
  injectIntent: (from: ClientId, intent: ClientIntent) => void
}

const CLAIMING_GATE_MS = 1_000
/** Only bump when the act window is about to expire (not on every short setting). */
const NIGHT_EXTEND_IF_REMAINING_MS = 2_500
/** Min gap between an AI's day vote cast and a reconsider pass. */
const AI_VOTE_RECONSIDER_MS = 14_000
/** Stop changing votes this close to day end (timeout fills any gaps). */
const AI_VOTE_LOCK_MS = 8_000

function shortClaimDelayMs(): number {
  return 80 + Math.floor(Math.random() * 120)
}

function delayMs(
  phase: string | undefined,
  opts?: { rushVotes?: boolean; rushNight?: boolean },
): number {
  // Face-down claiming uses a shared gate + shortClaimDelayMs — see driver.
  if (phase === 'claiming') return shortClaimDelayMs()
  // Night AI picks and post-window day votes must beat the wall clock.
  if (opts?.rushNight || opts?.rushVotes) {
    return 80 + Math.floor(Math.random() * 120)
  }
  return 600 + Math.floor(Math.random() * 600)
}

function msUntilAiVoteWindow(
  game: NonNullable<SessionSnapshot['game']>,
  opts?: { watchMode?: boolean },
): number | null {
  if (game.phase !== 'day' || game.dayEndsAt == null) return null
  const windowMs = opts?.watchMode
    ? Math.max(
        AI_DAY_VOTE_WINDOW_MS,
        Math.floor((game.dayDurationMs || AI_DAY_VOTE_WINDOW_MS * 2) / 2),
      )
    : AI_DAY_VOTE_WINDOW_MS
  const openAt = game.dayEndsAt - windowMs
  return Math.max(0, openAt - Date.now())
}

/**
 * Host-only: drive AI / scripted NPC intents.
 * When AI is ready, uses the work model; on failure falls back to scripted.
 * Frozen when AI seats exist but API keys / config are missing.
 */
export function useNpcDriver({
  enabled,
  snapshot,
  injectIntent,
}: Args): void {
  const injectRef = useRef(injectIntent)
  injectRef.current = injectIntent
  /** Latest snapshot — async night/day work must not close over a stale render. */
  const snapRef = useRef(snapshot)
  snapRef.current = snapshot
  const timerRef = useRef<number | null>(null)
  const genRef = useRef(0)
  const busyRef = useRef(false)
  /** Wall-clock when the current claiming phase began (shared AI claim gate). */
  const claimingStartedAtRef = useRef<number | null>(null)
  /** Last time each NPC cast/changed/cleared a day vote (reconsider pacing). */
  const lastDayVoteAtRef = useRef<Map<ClientId, number>>(new Map())
  /** Bumped to re-enter the effect for day-vote reconsider wakes. */
  const [voteWake, setVoteWake] = useState(0)

  useEffect(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }

    if (!enabled || !snapshot || snapshot.phase !== 'playing') {
      claimingStartedAtRef.current = null
      if (snapshot?.game?.phase !== 'day') {
        lastDayVoteAtRef.current.clear()
      }
      return
    }

    const npcs = snapshot.players.filter((p) => p.connected && p.isNpc)
    if (npcs.length === 0) return

    const hasAiProfiles = npcs.some((p) => p.aiProfileId)
    const readiness = checkAiReadiness()

    if (hasAiProfiles && !readiness.ready) {
      publishAiHostError(
        readiness.reason ?? 'AI players frozen — configure providers',
      )
      return
    }

    if (busyRef.current) return

    const gen = ++genRef.current
    const gamePhase = snapshot.game?.phase
    if (gamePhase === 'claiming') {
      if (claimingStartedAtRef.current == null) {
        claimingStartedAtRef.current = Date.now()
      }
    } else {
      claimingStartedAtRef.current = null
    }
    if (gamePhase !== 'day') {
      lastDayVoteAtRef.current.clear()
    }

    const allowDayVote =
      !snapshot.game ||
      snapshot.game.phase !== 'day' ||
      aiDayVoteWindowOpen(snapshot.game, Date.now(), {
        watchMode: Boolean(snapshot.watchMode),
      })

    const rushNight = gamePhase === 'night'
    const rushVotes = gamePhase === 'day' && allowDayVote

    const waitMs =
      gamePhase === 'claiming' && claimingStartedAtRef.current != null
        ? (() => {
            const remaining = Math.max(
              0,
              CLAIMING_GATE_MS - (Date.now() - claimingStartedAtRef.current!),
            )
            return remaining > 0 ? remaining : shortClaimDelayMs()
          })()
        : gamePhase === 'day' && snapshot.game && !allowDayVote
          ? (() => {
              const until = msUntilAiVoteWindow(snapshot.game, {
                watchMode: Boolean(snapshot.watchMode),
              })
              // Wake when the final-minute window opens (plus a little jitter).
              return Math.max(
                250,
                (until ?? 1_000) + Math.floor(Math.random() * 400),
              )
            })()
          : delayMs(gamePhase, { rushNight, rushVotes })

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      if (gen !== genRef.current) return

      const run = async () => {
        busyRef.current = true
        let injected = false
        // Prefer live snapshot so mid-flight HMR / phase changes don't use a
        // closed-over render that no longer matches the session.
        const live = snapRef.current
        if (!live || live.phase !== 'playing') {
          busyRef.current = false
          return
        }
        const liveNpcs = live.players.filter((p) => p.connected && p.isNpc)
        try {
          if (!hasAiProfiles || !readiness.ready) {
            const action = pickNextNpcAction(live)
            if (action) {
              injectRef.current(action.npcId, action.intent)
              injected = true
            }
            return
          }

          const game = live.game
          if (!game || live.gameId !== 'werewolf') return

          // Opening card pick is face-down random — never queue a work-model job.
          // Eval benchmark may force a fixed claim map / seeded pick.
          if (game.phase === 'claiming') {
            if (isBenchmarkActive()) {
              for (const npc of liveNpcs) {
                const forced = getEvalForcedIntent(game, npc.id)
                if (forced) {
                  injectRef.current(npc.id, forced)
                  injected = true
                  return
                }
              }
            }
            const action = pickNextNpcAction(live)
            if (action) {
              injectRef.current(action.npcId, action.intent)
              injected = true
            }
            return
          }

          // Eval: force night intents (seeded first run or replay).
          if (game.phase === 'night' && isBenchmarkActive()) {
            const npcsNight = [...liveNpcs].sort((a, b) => {
              const aNight = playerNeedsNightIntent(game, a.id) ? 0 : 1
              const bNight = playerNeedsNightIntent(game, b.id) ? 0 : 1
              return aNight - bNight
            })
            for (const npc of npcsNight) {
              const forced = getEvalForcedIntent(game, npc.id)
              if (forced) {
                injectRef.current(npc.id, forced)
                injected = true
                return
              }
            }
          }

          const blocked = inferenceBlockedReason()
          if (blocked) {
            publishAiHostError(blocked)
            const action = pickNextNpcAction(live)
            if (action) {
              injectRef.current(action.npcId, action.intent)
              injected = true
            }
            return
          }

          const dayLeft = dayMsRemaining(game)
          const voteWindow = aiDayVoteWindowOpen(game, Date.now(), {
            watchMode: Boolean(live.watchMode),
          })
          const canReconsider =
            voteWindow && dayLeft != null && dayLeft > AI_VOTE_LOCK_MS

          // Prefer night actors / unvoted seats so timers don't force defaults first.
          const candidates = [...liveNpcs].sort((a, b) => {
            const aNight = playerNeedsNightIntent(game, a.id) ? 0 : 1
            const bNight = playerNeedsNightIntent(game, b.id) ? 0 : 1
            if (aNight !== bNight) return aNight - bNight
            const aVote =
              game.phase === 'day' && !game.votes[a.id] ? 0 : 1
            const bVote =
              game.phase === 'day' && !game.votes[b.id] ? 0 : 1
            if (aVote !== bVote) return aVote - bVote
            return Math.random() - 0.5
          })

          for (const npc of candidates) {
            if (gen !== genRef.current) return
            const profile = npc.aiProfileId
              ? aiProfileById(npc.aiProfileId)
              : null
            if (!profile) {
              const intent = scriptedWerewolfIntent(game, npc.id, {
                allowDayVote: voteWindow,
              })
              if (intent) {
                injectRef.current(npc.id, intent)
                injected = true
                if (intent.type === 'werewolf.vote') {
                  lastDayVoteAtRef.current.set(npc.id, Date.now())
                }
                return
              }
              continue
            }

            // Day votes only in the final minute; reconsider until near timeout.
            if (game.phase === 'day') {
              if (!voteWindow) continue
              const hasVote = Boolean(game.votes[npc.id])
              if (hasVote) {
                if (!canReconsider) continue
                const lastAt = lastDayVoteAtRef.current.get(npc.id) ?? 0
                if (Date.now() - lastAt < AI_VOTE_RECONSIDER_MS) continue
              }
            }

            try {
              // Give slow local models one more act window before nightTimeout
              // forces a default pick — sized to the host night setting.
              // Skip in watch mode / short rush windows (human already left night).
              const latest = snapRef.current ?? live
              if (
                game.phase === 'night' &&
                !latest.watchMode &&
                !game.nightActGraceUsed &&
                playerNeedsNightIntent(game, npc.id) &&
                game.nightStepEndsAt != null
              ) {
                const remaining = game.nightStepEndsAt - Date.now()
                if (remaining < NIGHT_EXTEND_IF_REMAINING_MS) {
                  injectRef.current(npc.id, {
                    type: 'werewolf.extendNightAct',
                    extraMs: game.nightActMs,
                  })
                }
              }

              const intent = await decideNpcIntent({
                snapshot: snapRef.current ?? live,
                npcId: npc.id,
                profile,
              })
              if (intent) {
                injectRef.current(npc.id, intent)
                injected = true
                if (
                  intent.type === 'werewolf.vote' ||
                  intent.type === 'werewolf.undoVote'
                ) {
                  lastDayVoteAtRef.current.set(npc.id, Date.now())
                }
                return
              }
              // null on day with an existing vote = keep current; pace reconsider.
              if (game.phase === 'day' && game.votes[npc.id]) {
                lastDayVoteAtRef.current.set(npc.id, Date.now())
              }
            } catch (err) {
              publishAiHostError(noteInferenceFailure(err))
              const intent = scriptedWerewolfIntent(game, npc.id, {
                allowDayVote: voteWindow,
              })
              if (intent) {
                injectRef.current(npc.id, intent)
                injected = true
                if (intent.type === 'werewolf.vote') {
                  lastDayVoteAtRef.current.set(npc.id, Date.now())
                }
                return
              }
            }
          }
        } finally {
          busyRef.current = false
          // No snapshot change when AIs keep their votes — schedule a reconsider wake.
          const after = snapRef.current ?? live
          if (
            !injected &&
            gen === genRef.current &&
            after.game?.phase === 'day' &&
            aiDayVoteWindowOpen(after.game, Date.now(), {
              watchMode: Boolean(after.watchMode),
            })
          ) {
            const left = dayMsRemaining(after.game)
            if (left != null && left > AI_VOTE_LOCK_MS) {
              let soonest = AI_VOTE_RECONSIDER_MS
              for (const npc of liveNpcs) {
                if (!after.game.votes[npc.id]) {
                  soonest = 400
                  break
                }
                const lastAt = lastDayVoteAtRef.current.get(npc.id) ?? 0
                const due = AI_VOTE_RECONSIDER_MS - (Date.now() - lastAt)
                if (due < soonest) soonest = Math.max(400, due)
              }
              window.setTimeout(() => {
                if (gen !== genRef.current) return
                setVoteWake((n) => n + 1)
              }, soonest)
            }
          }
        }
      }

      void run()
    }, waitMs)

    return () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [enabled, snapshot, voteWake])
}
