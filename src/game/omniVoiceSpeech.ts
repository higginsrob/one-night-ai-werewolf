/**
 * OmniVoice-only speech enrichment: phase speed, strip non-verbal tags,
 * CMU role pronunciations, and design-voice instruct merging.
 */

export type SpeechPhase = 'lobby' | 'day' | 'result' | 'narrator'

export type VoiceAge =
  | ''
  | 'teenager'
  | 'young adult'
  | 'middle-aged'
  | 'elderly'

export type VoiceGender = '' | 'male' | 'female'

export type VoiceAccent =
  | ''
  | 'american'
  | 'british'
  | 'australian'
  | 'canadian'
  | 'indian'
  | 'chinese'
  | 'korean'
  | 'japanese'

export type VoiceDesignOverrides = {
  voiceAge?: VoiceAge
  voiceGender?: VoiceGender
  voiceAccent?: VoiceAccent
}

/** Official OmniVoice non-verbal tags — stripped from spoken text. */
export const OMNIVOICE_TAGS = [
  '[laughter]',
  '[sigh]',
  '[confirmation-en]',
  '[question-en]',
  '[question-ah]',
  '[question-oh]',
  '[question-ei]',
  '[question-yi]',
  '[surprise-ah]',
  '[surprise-oh]',
  '[surprise-wa]',
  '[surprise-yo]',
  '[dissatisfaction-hnn]',
] as const

export type OmniVoiceTag = (typeof OMNIVOICE_TAGS)[number]

const TAG_SET = new Set<string>(OMNIVOICE_TAGS)

/** Match any known tag, including accidental spacing variants. */
const TAG_RE = new RegExp(
  OMNIVOICE_TAGS.map((t) => t.replace(/[[\]]/g, '\\$&')).join('|'),
  'gi',
)

const PHASE_SPEED: Record<SpeechPhase, number> = {
  lobby: 1.08,
  day: 1.0,
  result: 1.05,
  narrator: 0.95,
}

/** Whole-word → CMU phoneme overrides for ONUW names that TTS often mangles. */
const PRONUNCIATIONS: { re: RegExp; replacement: string }[] = [
  {
    re: /\bTroublemaker\b/gi,
    replacement: '[T R AH1 B AH0 L M EY2 K ER0]',
  },
  {
    re: /\bInsomniac\b/gi,
    replacement: '[IH0 N S AA1 M N IY0 AE2 K]',
  },
  {
    re: /\bDoppelganger\b|\bDoppelgänger\b/gi,
    replacement: '[D AA1 P AH0 L G AE2 NG ER0]',
  },
  {
    re: /\bMinion\b/gi,
    replacement: '[M IH1 N Y AH0 N]',
  },
  {
    re: /\bTanner\b/gi,
    replacement: '[T AE1 N ER0]',
  },
  {
    re: /\bSeer\b/gi,
    replacement: '[S IY1 ER0]',
  },
]

const AGE_VALUES = new Set([
  'child',
  'teenager',
  'young adult',
  'middle-aged',
  'elderly',
])
const GENDER_VALUES = new Set(['male', 'female'])
const PITCH_VALUES = new Set([
  'very low pitch',
  'low pitch',
  'moderate pitch',
  'high pitch',
  'very high pitch',
])
const ACCENT_VALUES = new Set([
  'american accent',
  'british accent',
  'australian accent',
  'canadian accent',
  'indian accent',
  'chinese accent',
  'korean accent',
  'japanese accent',
  'portuguese accent',
  'russian accent',
])

export function speedForPhase(phase: SpeechPhase): number {
  return PHASE_SPEED[phase]
}

export function isOmniVoiceTag(token: string): token is OmniVoiceTag {
  return TAG_SET.has(token)
}

/** Normalize accent UI value to full OmniVoice attribute ("american" → "american accent"). */
export function accentToInstructPart(accent: VoiceAccent): string {
  if (!accent) return ''
  return accent.endsWith(' accent') ? accent : `${accent} accent`
}

type InstructParts = {
  gender?: string
  age?: string
  pitch?: string
  accent?: string
  style?: string
  other: string[]
}

function classifyToken(raw: string): keyof Omit<InstructParts, 'other'> | 'other' {
  const t = raw.trim().toLowerCase()
  if (!t) return 'other'
  if (GENDER_VALUES.has(t)) return 'gender'
  if (AGE_VALUES.has(t)) return 'age'
  if (PITCH_VALUES.has(t)) return 'pitch'
  if (ACCENT_VALUES.has(t)) return 'accent'
  if (t === 'whisper') return 'style'
  return 'other'
}

function parseInstruct(instruct: string): InstructParts {
  const parts: InstructParts = { other: [] }
  for (const raw of instruct.split(',')) {
    const t = raw.trim()
    if (!t) continue
    const kind = classifyToken(t)
    if (kind === 'other') parts.other.push(t)
    else parts[kind] = t.toLowerCase()
  }
  return parts
}

function formatInstruct(parts: InstructParts): string {
  const ordered: string[] = []
  if (parts.gender) ordered.push(parts.gender)
  if (parts.age) ordered.push(parts.age)
  if (parts.pitch) ordered.push(parts.pitch)
  if (parts.style) ordered.push(parts.style)
  if (parts.accent) ordered.push(parts.accent)
  ordered.push(...parts.other)
  return ordered.join(', ')
}

/**
 * Merge profile voice-design overrides onto a design-preset instruct string.
 * Empty override fields leave the preset category unchanged.
 */
export function mergeVoiceInstruct(
  presetInstruct: string | null | undefined,
  overrides: VoiceDesignOverrides,
): string | null {
  const base = (presetInstruct ?? '').trim()
  const parts = parseInstruct(base)

  const age = (overrides.voiceAge ?? '').trim()
  const gender = (overrides.voiceGender ?? '').trim()
  const accentRaw = (overrides.voiceAccent ?? '').trim() as VoiceAccent

  let changed = false
  if (age && AGE_VALUES.has(age)) {
    parts.age = age
    changed = true
  }
  if (gender && GENDER_VALUES.has(gender)) {
    parts.gender = gender
    changed = true
  }
  if (accentRaw) {
    const accent = accentToInstructPart(accentRaw).toLowerCase()
    if (ACCENT_VALUES.has(accent)) {
      parts.accent = accent
      changed = true
    }
  }

  if (!changed && !base) return null
  if (!changed) return base || null
  const merged = formatInstruct(parts)
  return merged || null
}

/** True when any profile override is set (caller may still skip for clones). */
export function hasVoiceDesignOverrides(o: VoiceDesignOverrides): boolean {
  return Boolean(
    (o.voiceAge && o.voiceAge.trim()) ||
      (o.voiceGender && o.voiceGender.trim()) ||
      (o.voiceAccent && o.voiceAccent.trim()),
  )
}

export function applyPronunciations(text: string): string {
  let out = text
  for (const { re, replacement } of PRONUNCIATIONS) {
    out = out.replace(re, replacement)
  }
  return out
}

/** Remove OmniVoice non-verbal tags so lines do not start with chuckles/hums. */
export function stripNonVerbalTags(text: string): string {
  return text
    .replace(TAG_RE, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export function prepareOmniVoiceSpeech(
  text: string,
  phase: SpeechPhase,
): { text: string; speed: number } {
  const cleaned = stripNonVerbalTags(text)
  const withPron = applyPronunciations(cleaned)
  return { text: withPron, speed: speedForPhase(phase) }
}

/** Map session snapshot phase → speech phase for AI lines. */
export function speechPhaseFromSession(args: {
  phase: string
  gamePhase?: string | null
}): SpeechPhase {
  if (args.phase === 'lobby') return 'lobby'
  if (args.gamePhase === 'reveal' || args.gamePhase === 'ended') return 'result'
  return 'day'
}

export const VOICE_AGE_OPTIONS: { value: VoiceAge; label: string }[] = [
  { value: '', label: 'Preset default' },
  { value: 'teenager', label: 'Teenager' },
  { value: 'young adult', label: 'Young adult' },
  { value: 'middle-aged', label: 'Middle-aged' },
  { value: 'elderly', label: 'Elderly' },
]

export const VOICE_GENDER_OPTIONS: { value: VoiceGender; label: string }[] = [
  { value: '', label: 'Preset default' },
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
]

export const VOICE_ACCENT_OPTIONS: { value: VoiceAccent; label: string }[] = [
  { value: '', label: 'Preset default' },
  { value: 'american', label: 'American' },
  { value: 'british', label: 'British' },
  { value: 'australian', label: 'Australian' },
  { value: 'canadian', label: 'Canadian' },
  { value: 'indian', label: 'Indian' },
  { value: 'chinese', label: 'Chinese' },
  { value: 'korean', label: 'Korean' },
  { value: 'japanese', label: 'Japanese' },
]
