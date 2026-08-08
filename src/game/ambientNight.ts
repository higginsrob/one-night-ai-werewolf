/**
 * Quiet outdoor night ambience (crickets + rare owl) for lobby / night phase.
 * Procedural Web Audio — no asset files. Starts after a user gesture unlocks audio.
 */

const CRICKET_GAIN = 0.05
const OWL_GAIN = 0.07
const FADE_SEC = 1.8
/** Long loop so sparse chirp clusters can sit in stretches of silence. */
const LOOP_SEC = 28
/** Owl hoot delay range while ambience is active. */
const OWL_MIN_MS = 28_000
const OWL_MAX_MS = 95_000

let ctx: AudioContext | null = null
let master: GainNode | null = null
let cricketGain: GainNode | null = null
let loopSource: AudioBufferSourceNode | null = null
let cricketBuffer: AudioBuffer | null = null
let owlTimer: ReturnType<typeof setTimeout> | null = null
let wanted = false
let unlocked = false
let building: Promise<AudioBuffer> | null = null
let gestureBound = false

function AudioCtx(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext ||
    null
  )
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

/** Soft band-limited chirp pulse into a stereo buffer. */
function paintChirp(
  L: Float32Array,
  R: Float32Array,
  sampleRate: number,
  startSample: number,
  freq: number,
  pan: number,
  pulseCount: number,
  gain: number,
): void {
  const pulseLen = Math.floor(sampleRate * rand(0.018, 0.032))
  const gap = Math.floor(sampleRate * rand(0.028, 0.048))
  const left = Math.cos((pan + 1) * 0.25 * Math.PI)
  const right = Math.sin((pan + 1) * 0.25 * Math.PI)
  let t0 = startSample
  for (let p = 0; p < pulseCount; p++) {
    // Soften later pulses slightly so a chirp isn't flat in level.
    const pulseGain = gain * rand(0.75, 1.05) * (1 - p * 0.06)
    for (let i = 0; i < pulseLen; i++) {
      const idx = t0 + i
      if (idx < 0 || idx >= L.length) continue
      const env = Math.sin((Math.PI * i) / pulseLen)
      // Narrow tone + a whisper of noise so chirps don't sound like pure beeps.
      const tone = Math.sin((2 * Math.PI * freq * i) / sampleRate)
      const noise = Math.random() * 2 - 1
      const sample = (tone * 0.82 + noise * 0.18) * env * env * pulseGain
      L[idx] += sample * left
      R[idx] += sample * right
    }
    t0 += pulseLen + gap
  }
}

/** Biased toward quieter chirps; occasional nearer/louder ones. */
function cricketChirpGain(): number {
  const u = Math.random()
  if (u < 0.45) return rand(0.18, 0.4)
  if (u < 0.8) return rand(0.4, 0.72)
  return rand(0.72, 1)
}

function buildCricketBuffer(audioCtx: BaseAudioContext): AudioBuffer {
  const sampleRate = audioCtx.sampleRate
  const length = Math.floor(sampleRate * LOOP_SEC)
  const buffer = audioCtx.createBuffer(2, length, sampleRate)
  const L = buffer.getChannelData(0)
  const R = buffer.getChannelData(1)

  // Sparse clusters: a short burst of chirps, then a few seconds of quiet.
  const voices = [
    { freq: 4200, pan: -0.7, pulses: 3 },
    { freq: 4900, pan: 0.55, pulses: 2 },
    { freq: 5400, pan: -0.25, pulses: 3 },
    { freq: 3950, pan: 0.8, pulses: 2 },
  ]

  let t = rand(1.5, 4)
  while (t < LOOP_SEC - 1.5) {
    const clusterLen = rand(0.9, 2.2)
    const clusterEnd = Math.min(LOOP_SEC - 0.4, t + clusterLen)
    // Whole clusters sit nearer or farther.
    const clusterGain = rand(0.55, 1.05)
    let ct = t
    while (ct < clusterEnd) {
      const v = voices[Math.floor(Math.random() * voices.length)]!
      paintChirp(
        L,
        R,
        sampleRate,
        Math.floor(ct * sampleRate),
        v.freq * rand(0.96, 1.04),
        v.pan + rand(-0.12, 0.12),
        v.pulses,
        cricketChirpGain() * clusterGain,
      )
      ct += rand(0.28, 0.55)
    }
    // Silence between clusters.
    t = clusterEnd + rand(2.8, 6.5)
  }

  for (let i = 0; i < length; i++) {
    L[i] = Math.tanh(L[i] * 0.6)
    R[i] = Math.tanh(R[i] * 0.6)
  }

  // Crossfade loop edges so the seam is inaudible.
  const fade = Math.floor(sampleRate * 0.5)
  for (let i = 0; i < fade; i++) {
    const a = i / fade
    const b = 1 - a
    const li = L[i]
    const ri = R[i]
    const lj = L[length - fade + i]
    const rj = R[length - fade + i]
    L[i] = li * a + lj * b
    R[i] = ri * a + rj * b
    L[length - fade + i] = lj * a + li * b
    R[length - fade + i] = rj * a + ri * b
  }

  return buffer
}

async function ensureBuffer(audioCtx: AudioContext): Promise<AudioBuffer> {
  if (cricketBuffer) return cricketBuffer
  if (!building) {
    building = Promise.resolve().then(() => {
      cricketBuffer = buildCricketBuffer(audioCtx)
      return cricketBuffer
    })
  }
  return building
}

function clearOwlTimer(): void {
  if (owlTimer != null) {
    clearTimeout(owlTimer)
    owlTimer = null
  }
}

function scheduleOwl(): void {
  clearOwlTimer()
  if (!wanted || !ctx || !master) return
  owlTimer = setTimeout(() => {
    owlTimer = null
    if (!wanted || !ctx || !master) return
    playOwlHoot(ctx, master)
    scheduleOwl()
  }, rand(OWL_MIN_MS, OWL_MAX_MS))
}

function playOwlHoot(audioCtx: AudioContext, dest: AudioNode): void {
  const now = audioCtx.currentTime
  const pan = rand(-0.75, 0.75)
  const panner = audioCtx.createStereoPanner()
  panner.pan.value = pan
  const gain = audioCtx.createGain()
  gain.gain.value = 0
  // Two soft "whoos" — classic distant barn-owl cadence.
  const notes: { f0: number; f1: number; at: number; dur: number }[] = [
    { f0: 420, f1: 310, at: 0, dur: 0.55 },
    { f0: 390, f1: 280, at: 0.7, dur: 0.65 },
  ]
  gain.connect(panner)
  panner.connect(dest)

  for (const n of notes) {
    const osc = audioCtx.createOscillator()
    osc.type = 'sine'
    const start = now + n.at
    osc.frequency.setValueAtTime(n.f0, start)
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(80, n.f1),
      start + n.dur,
    )
    // Gentle vibrato
    const lfo = audioCtx.createOscillator()
    lfo.frequency.value = 4.2
    const lfoGain = audioCtx.createGain()
    lfoGain.gain.value = 6
    lfo.connect(lfoGain)
    lfoGain.connect(osc.frequency)
    osc.connect(gain)
    osc.start(start)
    osc.stop(start + n.dur + 0.05)
    lfo.start(start)
    lfo.stop(start + n.dur + 0.05)
  }

  gain.gain.setValueAtTime(0, now)
  gain.gain.linearRampToValueAtTime(OWL_GAIN, now + 0.08)
  gain.gain.setValueAtTime(OWL_GAIN * 0.85, now + 0.55)
  gain.gain.linearRampToValueAtTime(OWL_GAIN, now + 0.72)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.55)

  window.setTimeout(() => {
    try {
      gain.disconnect()
      panner.disconnect()
    } catch {
      /* already gone */
    }
  }, 1800)
}

async function startLoop(): Promise<void> {
  if (!ctx || !master || !wanted) return
  const buf = await ensureBuffer(ctx)
  if (!ctx || !master || !wanted) return

  stopLoopNodes()

  cricketGain = ctx.createGain()
  cricketGain.gain.value = CRICKET_GAIN
  cricketGain.connect(master)

  loopSource = ctx.createBufferSource()
  loopSource.buffer = buf
  loopSource.loop = true
  loopSource.connect(cricketGain)
  loopSource.start()

  // First owl after a short settle, then regular sparse schedule.
  clearOwlTimer()
  owlTimer = setTimeout(() => {
    owlTimer = null
    if (!wanted || !ctx || !master) return
    playOwlHoot(ctx, master)
    scheduleOwl()
  }, rand(12_000, 28_000))
}

function stopLoopNodes(): void {
  clearOwlTimer()
  if (loopSource) {
    try {
      loopSource.stop()
    } catch {
      /* already stopped */
    }
    try {
      loopSource.disconnect()
    } catch {
      /* ignore */
    }
    loopSource = null
  }
  if (cricketGain) {
    try {
      cricketGain.disconnect()
    } catch {
      /* ignore */
    }
    cricketGain = null
  }
}

function fadeMaster(to: number, then?: () => void): void {
  if (!ctx || !master) {
    then?.()
    return
  }
  const g = master.gain
  const now = ctx.currentTime
  g.cancelScheduledValues(now)
  g.setValueAtTime(Math.max(0.0001, g.value), now)
  if (to <= 0) {
    g.exponentialRampToValueAtTime(0.0001, now + FADE_SEC)
    window.setTimeout(() => {
      if (master) master.gain.value = 0
      then?.()
    }, FADE_SEC * 1000 + 30)
  } else {
    g.exponentialRampToValueAtTime(to, now + FADE_SEC)
  }
}

async function ensureContext(): Promise<AudioContext | null> {
  const Ctor = AudioCtx()
  if (!Ctor) return null
  if (!ctx) {
    ctx = new Ctor()
    master = ctx.createGain()
    master.gain.value = 0
    master.connect(ctx.destination)
  }
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume()
    } catch {
      return null
    }
  }
  return ctx
}

async function applyWanted(): Promise<void> {
  if (!wanted) {
    fadeMaster(0, () => stopLoopNodes())
    return
  }
  if (!unlocked) return
  const audioCtx = await ensureContext()
  if (!audioCtx || !wanted) return
  if (!loopSource) {
    await startLoop()
  }
  fadeMaster(1)
}

function onGesture(): void {
  if (unlocked) return
  unlocked = true
  unbindGestureUnlock()
  void (async () => {
    await ensureContext()
    await applyWanted()
  })()
}

const gestureOpts: AddEventListenerOptions = { capture: true }
let gestureHandler: (() => void) | null = null

function unbindGestureUnlock(): void {
  if (!gestureHandler || typeof window === 'undefined') return
  window.removeEventListener('pointerdown', gestureHandler, gestureOpts)
  window.removeEventListener('keydown', gestureHandler, gestureOpts)
  window.removeEventListener('touchstart', gestureHandler, gestureOpts)
  gestureHandler = null
  gestureBound = false
}

function bindGestureUnlock(): void {
  if (gestureBound || unlocked || typeof window === 'undefined') return
  gestureBound = true
  gestureHandler = () => onGesture()
  window.addEventListener('pointerdown', gestureHandler, gestureOpts)
  window.addEventListener('keydown', gestureHandler, gestureOpts)
  window.addEventListener('touchstart', gestureHandler, gestureOpts)
}

/**
 * Turn outdoor night ambience on/off. Safe to call often (phase changes).
 * Audio begins after the first user gesture unlocks the AudioContext.
 */
export function setAmbientNightActive(active: boolean): void {
  if (wanted === active) {
    if (active) bindGestureUnlock()
    return
  }
  wanted = active
  if (active) {
    bindGestureUnlock()
    // If already unlocked (e.g. TTS click), start immediately.
    void applyWanted()
  } else {
    void applyWanted()
  }
}

/** Call from an existing click path (Start / Speak / Settings) to unlock early. */
export function unlockAmbientNight(): void {
  onGesture()
}

export function isAmbientNightWanted(): boolean {
  return wanted
}
