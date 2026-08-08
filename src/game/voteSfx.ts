/**
 * Short procedural "vote cast" cue — Web Audio, no asset files.
 * Plays after a user gesture has unlocked audio (Start / vote tap / etc.).
 */

let ctx: AudioContext | null = null

function AudioCtx(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext ||
    null
  )
}

async function ensureContext(): Promise<AudioContext | null> {
  const Ctor = AudioCtx()
  if (!Ctor) return null
  if (!ctx) ctx = new Ctor()
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume()
    } catch {
      return null
    }
  }
  return ctx
}

/** Soft stamp + short whoosh when a day vote is cast or changed. */
export function playVoteSfx(): void {
  void (async () => {
    const audioCtx = await ensureContext()
    if (!audioCtx) return
    const now = audioCtx.currentTime
    const master = audioCtx.createGain()
    master.gain.value = 0.22
    master.connect(audioCtx.destination)

    // Percussive body (felt stamp).
    const noiseBuf = audioCtx.createBuffer(
      1,
      Math.floor(audioCtx.sampleRate * 0.08),
      audioCtx.sampleRate,
    )
    const data = noiseBuf.getChannelData(0)
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length)
    }
    const noise = audioCtx.createBufferSource()
    noise.buffer = noiseBuf
    const noiseFilter = audioCtx.createBiquadFilter()
    noiseFilter.type = 'lowpass'
    noiseFilter.frequency.value = 900
    const noiseGain = audioCtx.createGain()
    noiseGain.gain.setValueAtTime(0.0001, now)
    noiseGain.gain.exponentialRampToValueAtTime(0.9, now + 0.008)
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.07)
    noise.connect(noiseFilter)
    noiseFilter.connect(noiseGain)
    noiseGain.connect(master)
    noise.start(now)
    noise.stop(now + 0.09)

    // Soft descending tone (whoosh / point).
    const osc = audioCtx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(420, now)
    osc.frequency.exponentialRampToValueAtTime(180, now + 0.18)
    const oscGain = audioCtx.createGain()
    oscGain.gain.setValueAtTime(0.0001, now)
    oscGain.gain.exponentialRampToValueAtTime(0.55, now + 0.02)
    oscGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2)
    osc.connect(oscGain)
    oscGain.connect(master)
    osc.start(now)
    osc.stop(now + 0.22)
  })()
}
