import { useEffect, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import {
  getBrowserTtsSpeakerId,
  subscribeBrowserTtsSpeaker,
} from '../game/browserTts'
import { NO_VOTE_TARGET } from '../game/werewolfTypes'
import {
  clearOrbitFocus,
  readPlayerCardFocus,
} from './playerCardFocus'
import {
  boxCenter,
  buildTableCardsBox3,
  fitDistanceForBox,
  getTablePadBounds,
} from './sceneBounds'

/** Soft follow toward desired pose (lower = slower). */
const LERP = 0.38
const USER_PAUSE_MS = 5_000
/**
 * Stay on the front (+Z) side of the table — never orbit around the back.
 * Matches the playable OrbitControls front arc, slightly tighter.
 */
const FRONT_AZIMUTH_MAX = Math.PI * 0.28
/** Idle day sway within the front arc (radians). */
const FRONT_SWAY_AMP = Math.PI * 0.12
/** Idle sway angular frequency (rad/s of the sine phase). */
const FRONT_SWAY_SPEED = 0.12
/**
 * Default overview: near straight top-down from the front.
 * OrbitControls polar is angle from +Y; ~0 is bird's-eye.
 */
const OVERVIEW_POLAR = 0.18
/** Mild speaker approach — slight tilt in from overview. */
const SPEAKER_POLAR = 0.48
const SPEAKER_LOOK_BIAS = 0.4
/** Zoom closer on the speaking player (fraction of overview distance). */
const SPEAKER_DIST_SCALE = 0.68
/** How fast framing params ease between table ↔ player (1/s). */
const FRAMING_LERP = 0.45
/** Speaker → speaker look/azimuth ease (slightly snappier than table returns). */
const SPEAKER_TO_SPEAKER_LERP = 0.55
/** Speaker / idle azimuth ease rate (1/s). */
const SPEAKER_AZIMUTH_LERP = 0.28
const IDLE_AZIMUTH_LERP = 0.22
/**
 * Fit zoom so seat cards sit near the frame edges with a small grass margin.
 */
const OVERVIEW_ZOOM = 0.92
const OVERVIEW_FIT_PADDING = 1.06
/** Establishing shot → overview while AIs claim cards (modest pull-back). */
const INTRO_DIST_SCALE = 1.22
const INTRO_POLAR = 0.36
/** How fast introT eases toward claim-driven target (1/s). */
const INTRO_PROGRESS_LERP = 2.4
/** After all claims, finish any remaining zoom this quickly. */
const INTRO_FINISH_SEC = 0.7
/** Opening push-in before the first claim (wide → overview). */
const INTRO_PRECLAIM_CRAWL_SEC = 2.8
const INTRO_PRECLAIM_MAX = 0.72
/** Camera follow during intro — snappy enough to keep up with the zoom. */
const INTRO_LERP = 0.52
/** Keep framing the voted-against player while the voter (or gap) settles. */
const VOTE_FOCUS_HOLD_MS = 5_500

type Props = {
  enabled?: boolean
  /** When true, idle between speakers gently sways left/right at the front. */
  conversationPan?: boolean
  /** Live werewolf phase — `claiming` triggers the opening zoom-in. */
  gamePhase?: string | null
  /**
   * 0–1 fraction of seated players who have claimed a card.
   * Drives the intro zoom; animation completes when this reaches 1.
   */
  claimProgress?: number
  /** Day votes: voterId → targetId (may be NO_VOTE_TARGET). */
  votes?: Record<string, string>
}

type OrbitLike = {
  target: THREE.Vector3
  update: () => void
  addEventListener?: (type: string, fn: () => void) => void
  removeEventListener?: (type: string, fn: () => void) => void
}

function sphericalOffset(
  out: THREE.Vector3,
  azimuth: number,
  polar: number,
  radius: number,
): THREE.Vector3 {
  const sp = Math.sin(polar)
  return out.set(
    sp * Math.sin(azimuth) * radius,
    Math.cos(polar) * radius,
    sp * Math.cos(azimuth) * radius,
  )
}

function clampFrontAzimuth(az: number): number {
  return THREE.MathUtils.clamp(az, -FRONT_AZIMUTH_MAX, FRONT_AZIMUTH_MAX)
}

/** Map a seat position to a small front-arc azimuth (never behind the table). */
function frontAzimuthForSeat(
  seat: THREE.Vector3,
  tableCenter: THREE.Vector3,
  tableRadius: number,
): number {
  const dx = seat.x - tableCenter.x
  const span = Math.max(0.6, tableRadius)
  return clampFrontAzimuth((dx / span) * FRONT_AZIMUTH_MAX)
}

/**
 * Watch-mode cinematic camera: front-of-table overview, look + zoom on
 * speakers, gentle left/right sway before the first speaker — no full-table
 * orbits. Stays on speakers between lines; returns to table only after a
 * user camera reset (or during the claiming intro).
 */
export function AutoCameraController({
  enabled = true,
  conversationPan = false,
  gamePhase = null,
  claimProgress = 1,
  votes = {},
}: Props) {
  const { camera, controls, size } = useThree()
  const [speakerId, setSpeakerId] = useState(() => getBrowserTtsSpeakerId())

  const pausedUntil = useRef(0)
  const wasPaused = useRef(false)
  const azimuth = useRef(0)
  const swayPhase = useRef(0)
  const introT = useRef(1)
  const introArmed = useRef(false)
  const introElapsed = useRef(0)
  /** Stay on speakers between lines; only clear on intro / user-resume reset. */
  const speakerMode = useRef(false)
  const prevVotes = useRef<Record<string, string>>({})
  const voteFocusId = useRef<string | null>(null)
  const voteFocusUntil = useRef(0)
  const voteCasterId = useRef<string | null>(null)
  const votesSeeded = useRef(false)
  /** Smoothed framing — eases between table overview and speaker close-up. */
  const polarSm = useRef(OVERVIEW_POLAR)
  const distSm = useRef(8)
  const lookBiasSm = useRef(0)
  const lookPointSm = useRef(new THREE.Vector3(0, 1.2, 0))
  const lastSpeakerPos = useRef(new THREE.Vector3())
  const framingReady = useRef(false)
  const box = useRef(new THREE.Box3())
  const lookDesired = useRef(new THREE.Vector3())
  const posDesired = useRef(new THREE.Vector3())
  const scratch = useRef(new THREE.Vector3())
  const scratchSpeaker = useRef(new THREE.Vector3())
  const offset = useRef(new THREE.Vector3())
  const center = useRef(new THREE.Vector3())
  const initialized = useRef(false)

  useEffect(() => subscribeBrowserTtsSpeaker(setSpeakerId), [])

  useEffect(() => {
    if (!enabled) return
    clearOrbitFocus()
    initialized.current = false
    framingReady.current = false
    wasPaused.current = false
    azimuth.current = 0
    swayPhase.current = 0
    lookBiasSm.current = 0
    introElapsed.current = 0
    speakerMode.current = false
    prevVotes.current = {}
    voteFocusId.current = null
    voteFocusUntil.current = 0
    voteCasterId.current = null
    votesSeeded.current = false
    // Arm intro when a watch game begins in claiming; otherwise skip.
    if (gamePhase === 'claiming') {
      introT.current = 0
      introArmed.current = true
    } else {
      introT.current = 1
      introArmed.current = false
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    if (gamePhase === 'claiming' && !introArmed.current) {
      introT.current = 0
      introElapsed.current = 0
      introArmed.current = true
    }
    if (gamePhase && gamePhase !== 'claiming' && introT.current >= 1) {
      introArmed.current = false
    }
  }, [enabled, gamePhase])

  useEffect(() => {
    if (!enabled) return
    const orbit = controls as OrbitLike | null
    if (!orbit?.addEventListener || !orbit.removeEventListener) return

    const onStart = () => {
      pausedUntil.current = performance.now() + USER_PAUSE_MS
    }
    orbit.addEventListener('start', onStart)
    return () => {
      orbit.removeEventListener?.('start', onStart)
    }
  }, [enabled, controls])

  useFrame((_, dt) => {
    if (!enabled) return
    const orbit = controls as OrbitLike | null
    if (!orbit?.target || typeof orbit.update !== 'function') return

    const now = performance.now()
    if (now < pausedUntil.current) {
      wasPaused.current = true
      return
    }

    if (wasPaused.current || !initialized.current) {
      const off = scratch.current.copy(camera.position).sub(orbit.target)
      if (off.lengthSq() > 1e-6) {
        azimuth.current = clampFrontAzimuth(Math.atan2(off.x, off.z))
      } else {
        azimuth.current = 0
      }
      // User camera control is a scene reset — return to table overview.
      if (wasPaused.current) {
        speakerMode.current = false
        voteFocusId.current = null
        voteCasterId.current = null
      }
      wasPaused.current = false
    }

    // Detect new / changed votes → frame the player voted against.
    if (!votesSeeded.current) {
      prevVotes.current = { ...votes }
      votesSeeded.current = true
    } else {
      const prev = prevVotes.current
      for (const [voterId, targetId] of Object.entries(votes)) {
        if (prev[voterId] === targetId) continue
        if (!targetId || targetId === NO_VOTE_TARGET) continue
        voteFocusId.current = targetId
        voteCasterId.current = voterId
        voteFocusUntil.current = performance.now() + VOTE_FOCUS_HOLD_MS
        speakerMode.current = true
      }
      prevVotes.current = { ...votes }
    }

    const persp = camera as THREE.PerspectiveCamera
    const fov = persp.isPerspectiveCamera ? persp.fov : 42
    const aspect =
      persp.isPerspectiveCamera && persp.aspect > 0
        ? persp.aspect
        : size.width / Math.max(1, size.height)

    buildTableCardsBox3(box.current)
    boxCenter(box.current, center.current)
    const pad = getTablePadBounds()
    const tableRadius = pad?.radius ?? 2.5
    const overviewDist =
      fitDistanceForBox(
        box.current,
        fov,
        aspect,
        OVERVIEW_FIT_PADDING,
        OVERVIEW_POLAR,
      ) * OVERVIEW_ZOOM
    const speakerDist =
      fitDistanceForBox(
        box.current,
        fov,
        aspect,
        OVERVIEW_FIT_PADDING,
        SPEAKER_POLAR,
      ) *
      OVERVIEW_ZOOM *
      SPEAKER_DIST_SCALE

    const frameDt = frameDtSafe(dt)
    const claimsDone = THREE.MathUtils.clamp(claimProgress, 0, 1)
    const stillIntro =
      introArmed.current &&
      (gamePhase === 'claiming' || introT.current < 1 || claimsDone < 1)

    if (stillIntro && introT.current < 1) {
      introElapsed.current += frameDt
      let targetIntro: number
      if (claimsDone >= 1 || (gamePhase && gamePhase !== 'claiming')) {
        // Everyone picked (or phase advanced) — finish the remaining zoom.
        targetIntro = 1
        const finishStep = frameDt / INTRO_FINISH_SEC
        introT.current = Math.min(1, introT.current + finishStep)
        // Also ease toward 1 so we don't undershoot if finish is slow.
        const k = 1 - Math.exp(-INTRO_PROGRESS_LERP * frameDt)
        introT.current += (1 - introT.current) * k
      } else {
        const preclaim = Math.min(
          INTRO_PRECLAIM_MAX,
          introElapsed.current / INTRO_PRECLAIM_CRAWL_SEC,
        )
        // Claims drive the zoom; preclaim crawl only fills the opening beat.
        targetIntro = Math.max(preclaim, claimsDone * 0.92)
        const k = 1 - Math.exp(-INTRO_PROGRESS_LERP * frameDt)
        introT.current += (targetIntro - introT.current) * k
      }
      if (introT.current >= 0.995) {
        introT.current = 1
        introArmed.current = false
      }
    }

    let targetPolar = OVERVIEW_POLAR
    let targetDist = overviewDist
    let targetLookBias = 0
    let targetAz = 0
    const speakerPos = scratchSpeaker.current
    let hasSpeakerPos = false
    let holdingSpeaker = false

    const intro = smoothstep(introT.current)
    if (intro < 1) {
      speakerMode.current = false
      voteFocusId.current = null
      voteCasterId.current = null
      const wideDist = overviewDist * INTRO_DIST_SCALE
      targetDist = THREE.MathUtils.lerp(wideDist, overviewDist, intro)
      targetPolar = THREE.MathUtils.lerp(INTRO_POLAR, OVERVIEW_POLAR, intro)
      targetLookBias = 0
      targetAz = 0
    } else {
      const voteTarget = voteFocusId.current
      const voteActive =
        Boolean(voteTarget) && performance.now() < voteFocusUntil.current
      if (
        voteActive &&
        speakerId &&
        voteCasterId.current &&
        speakerId !== voteCasterId.current
      ) {
        // Someone else started talking — release vote lock to normal speaker follow.
        voteFocusId.current = null
        voteCasterId.current = null
      }

      const focusVote =
        Boolean(voteFocusId.current) &&
        performance.now() < voteFocusUntil.current &&
        readPlayerCardFocus(voteFocusId.current!, speakerPos)

      if (focusVote) {
        speakerMode.current = true
        lastSpeakerPos.current.copy(speakerPos)
        hasSpeakerPos = true
        targetPolar = SPEAKER_POLAR
        targetDist = speakerDist
        targetLookBias = SPEAKER_LOOK_BIAS
        targetAz = frontAzimuthForSeat(speakerPos, center.current, tableRadius)
      } else {
        if (voteFocusId.current && performance.now() >= voteFocusUntil.current) {
          voteFocusId.current = null
          voteCasterId.current = null
        }
        hasSpeakerPos =
          Boolean(speakerId) &&
          readPlayerCardFocus(speakerId!, speakerPos)

        if (hasSpeakerPos) {
          speakerMode.current = true
          lastSpeakerPos.current.copy(speakerPos)
          targetPolar = SPEAKER_POLAR
          targetDist = speakerDist
          targetLookBias = SPEAKER_LOOK_BIAS
          targetAz = frontAzimuthForSeat(
            speakerPos,
            center.current,
            tableRadius,
          )
        } else if (speakerMode.current) {
          // Between speakers: hold the last player frame — do not pull back to table.
          holdingSpeaker = true
          targetPolar = SPEAKER_POLAR
          targetDist = speakerDist
          targetLookBias = SPEAKER_LOOK_BIAS
          targetAz = frontAzimuthForSeat(
            lastSpeakerPos.current,
            center.current,
            tableRadius,
          )
        } else if (conversationPan) {
          swayPhase.current += FRONT_SWAY_SPEED * frameDt
          targetAz = Math.sin(swayPhase.current) * FRONT_SWAY_AMP
        }
      }
    }

    // Smooth framing params so table ↔ player never snaps.
    const framingRate =
      hasSpeakerPos || holdingSpeaker ? SPEAKER_TO_SPEAKER_LERP : FRAMING_LERP
    if (!framingReady.current) {
      polarSm.current = targetPolar
      distSm.current = targetDist
      lookBiasSm.current = targetLookBias
      lookPointSm.current.copy(center.current)
      if (hasSpeakerPos || holdingSpeaker) {
        lookPointSm.current.lerp(
          hasSpeakerPos ? speakerPos : lastSpeakerPos.current,
          targetLookBias,
        )
      }
      framingReady.current = true
    } else {
      const kF = 1 - Math.exp(-framingRate * frameDt)
      polarSm.current += (targetPolar - polarSm.current) * kF
      distSm.current += (targetDist - distSm.current) * kF
      lookBiasSm.current += (targetLookBias - lookBiasSm.current) * kF

      const lookGoal = scratch.current.copy(center.current)
      if (lookBiasSm.current > 0.001 && (hasSpeakerPos || holdingSpeaker)) {
        const focus = hasSpeakerPos ? speakerPos : lastSpeakerPos.current
        lookGoal.lerp(focus, lookBiasSm.current)
      }
      lookPointSm.current.lerp(lookGoal, kF)
    }

    const azLerp =
      intro < 1
        ? 0.6
        : hasSpeakerPos || holdingSpeaker
          ? SPEAKER_AZIMUTH_LERP
          : IDLE_AZIMUTH_LERP
    const kAz = 1 - Math.exp(-azLerp * frameDt)
    azimuth.current = clampFrontAzimuth(
      azimuth.current + (targetAz - azimuth.current) * kAz,
    )

    const look = lookDesired.current.copy(lookPointSm.current)
    sphericalOffset(
      offset.current,
      azimuth.current,
      polarSm.current,
      distSm.current,
    )
    posDesired.current.copy(look).add(offset.current)

    if (!initialized.current) {
      camera.position.copy(posDesired.current)
      orbit.target.copy(look)
      initialized.current = true
    } else {
      const follow = intro < 1 ? INTRO_LERP : LERP
      const k = 1 - Math.exp(-follow * dt)
      camera.position.lerp(posDesired.current, k)
      orbit.target.lerp(look, k)
    }
    orbit.update()
  })

  return null
}

function frameDtSafe(dt: number): number {
  return Math.min(dt, 0.05)
}

function smoothstep(t: number): number {
  const x = THREE.MathUtils.clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
}
