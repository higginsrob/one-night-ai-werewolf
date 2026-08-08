/** Pull spoken dialogue out of model JSON / fenced blobs / stage directions. */

const SPOKEN_KEYS = [
  'reply',
  'text',
  'message',
  'dialogue',
  'response',
  'speech',
  'say',
  'content',
  'utterance',
] as const

function fromObject(value: unknown): string | null {
  if (typeof value === 'string') {
    const s = value.trim()
    return s || null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  for (const key of SPOKEN_KEYS) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

/** Drop italic/thought blocks, stage directions, and trailing meta commentary. */
export function stripStageAndThoughts(text: string): string {
  let out = text
  // Unwrap **bold** / __bold__ to plain text first — otherwise the single-*
  // thought strip turns "**Kim**" into "* *" and destroys player names.
  out = out.replace(/\*\*([^*\n]{1,280})\*\*/g, '$1')
  out = out.replace(/__([^_\n]{1,280})__/g, '$1')
  // *thinking* or _thinking_
  out = out.replace(/(\*|_)[^*\n_]{1,280}\1/g, ' ')
  // (stage directions)
  out = out.replace(/\([^)]{1,200}\)/g, ' ')
  // [stage directions]
  out = out.replace(/\[[^\]]{1,200}\]/g, ' ')
  // Lines that look like internal monologue
  out = out
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      if (!t) return false
      if (/^(wait|hmm|note|thought|internal|aside)\b/i.test(t)) return false
      if (/^(OOC|meta|system)\b/i.test(t)) return false
      return true
    })
    .join(' ')
  return out.replace(/\s+/g, ' ').trim()
}

/** Prefer the first quoted spoken line when the model wraps dialogue in quotes. */
export function unwrapQuotedDialogue(text: string): string {
  const trimmed = text.trim()
  const m = trimmed.match(/^[«"“]([\s\S]+?)[»"”](?:\s|$)/)
  if (m?.[1]?.trim()) return m[1].trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('“') && trimmed.endsWith('”'))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  // Dialogue quote then leftover junk on later lines/sentences
  const firstQuote = trimmed.match(/^[«"“]([\s\S]+?)[»"”]/)
  if (firstQuote?.[1] && trimmed.length > firstQuote[0].length + 8) {
    return firstQuote[1].trim()
  }
  return trimmed
}

/** Split into spoken sentences (terminal punctuation or trailing remnant). */
export function splitSentences(text: string): string[] {
  return splitSentencesWithOffsets(text).map((s) => s.text)
}

/** Same-length stand-in so "A.I." periods are not sentence boundaries. */
const INITIALISM_DOT = '\uE000'

/**
 * Mask initialisms like "A.I." / "U.S.A." so their periods are not treated as
 * sentence boundaries (browser TTS otherwise cuts after "Welcome to One Night A.").
 */
function maskInitialisms(source: string): string {
  return source.replace(/\b(?:[A-Z]\.){2,}/g, (m) =>
    m.replace(/\./g, INITIALISM_DOT),
  )
}

function restoreInitialisms(s: string): string {
  return s.replaceAll(INITIALISM_DOT, '.')
}

/** Sentence spans with offsets into the original (trimmed) string. */
export function splitSentencesWithOffsets(
  text: string,
): { text: string; start: number; end: number }[] {
  const source = text.trim()
  if (!source) return []
  const masked = maskInitialisms(source)
  const parts = masked.match(/[^.!?]+[.!?]+|[^.!?]+$/g)
  if (!parts) return [{ text: source, start: 0, end: source.length }]
  const out: { text: string; start: number; end: number }[] = []
  let cursor = 0
  for (const raw of parts) {
    const trimmed = raw.trim()
    if (!trimmed) {
      cursor += raw.length
      continue
    }
    const local = raw.indexOf(trimmed)
    const start = cursor + (local >= 0 ? local : 0)
    const end = start + trimmed.length
    out.push({ text: restoreInitialisms(trimmed), start, end })
    cursor += raw.length
  }
  return out
}

/** Keep at most `max` spoken sentences. */
export function capSentences(text: string, max = 3): string {
  const parts = splitSentences(text)
  if (parts.length <= max) return text.trim()
  return parts.slice(0, max).join(' ').trim()
}

/** True when dialogue oddly addresses the speaker by their own name. */
export function addressesSelfByName(text: string, selfName: string): boolean {
  const name = selfName.trim()
  if (!name || name.length < 2) return false
  const n = escapeRegExp(name)
  const re = new RegExp(
    [
      // Vocative / ask-self: "Kim," / "hey Kim" / "Kim, did…"
      `(?:^|[.!?\\s])${n}\\s*,`,
      `\\b(?:hey|hi|ok|okay|so|well)\\s+${n}\\b`,
      `\\b${n}\\s*,\\s*(?:did|do|what|who|are|were|can|could|would|will)\\b`,
      // Interview / grill self: "let's grill Kim" / "ask Kim about"
      `\\b(?:grill|interview|ask|pressure|nail|blame|accuse|probe)\\s+${n}\\b`,
      `\\blet['’]?s\\s+(?:grill|interview|ask|pressure|nail|blame|accuse)\\s+${n}\\b`,
      // Third-person self narration: "Kim's now on the hit list" / "Carrie's the one who…"
      `\\b${n}['’]s\\s+(?:now\\s+)?(?:on\\s+the\\s+hit|flipping|claiming|voting|still|the\\s+one|trying|looking|acting)\\b`,
      `\\b${n}\\s+is\\s+(?:now\\s+)?(?:on\\s+the\\s+hit|flipping|claiming|the\\s+one|trying|looking|acting)\\b`,
      // "why Ben might be safe" / "see why Carrie is…" (speaker talking about self)
      `\\b(?:why|whether|if)\\s+${n}\\b.{0,30}\\b(?:might\\s+be|is|could\\s+be|looks?)\\b`,
      `\\b(?:vote|votes?|heat|pressure|target)\\s+(?:on\\s+)?${n}\\b`,
      // "Looks like she's trying" after naming self earlier is caught above;
      // bare "keep eyes on her" when self is female is too ambiguous — skip.
    ].join('|'),
    'i',
  )
  return re.test(text)
}

/**
 * Drop a leading "Name: …" / `Name: "…"` self-label the model sometimes wraps
 * around dialogue (e.g. `Carrie: "Boz, what…"`).
 */
export function stripSelfSpeakerLabel(text: string, selfName: string): string {
  const name = selfName.trim()
  if (!name || name.length < 2) return text
  const re = new RegExp(
    `^${escapeRegExp(name)}\\s*:\\s*`,
    'i',
  )
  let out = text.replace(re, '').trim()
  // Unwrap a single surrounding quote pair left after stripping the label.
  if (
    (out.startsWith('"') && out.endsWith('"')) ||
    (out.startsWith('“') && out.endsWith('”')) ||
    (out.startsWith("'") && out.endsWith("'"))
  ) {
    out = out.slice(1, -1).trim()
  }
  return out
}

/** Robber claiming Seer must not confess the rob mid-sentence. */
export function confessesRobWhileClaimingSeer(text: string): boolean {
  return (
    /\b(?:i\s+)?(?:took|robbed|stole)\s+(?:your|his|her|their)\s+card\b/i.test(
      text,
    ) ||
    /\bbefore\s+i\s+took\s+your\s+card\b/i.test(text) ||
    /\bi\s+(?:robbed|stole\s+from)\s+you\b/i.test(text)
  )
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function normalizeSpoken(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Token Jaccard similarity in [0, 1]. */
export function spokenSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeSpoken(a).split(' ').filter(Boolean))
  const tb = new Set(normalizeSpoken(b).split(' ').filter(Boolean))
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  const union = ta.size + tb.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * True when `a` and `b` share a contiguous run of `minWords`+ tokens
 * (catches verbatim parroting even when Jaccard is diluted by extra words).
 */
export function sharesLongPhrase(
  a: string,
  b: string,
  minWords = 10,
): boolean {
  const ta = normalizeSpoken(a).split(' ').filter(Boolean)
  const tb = normalizeSpoken(b).split(' ').filter(Boolean)
  if (ta.length < minWords || tb.length < minWords) return false
  const shorter = ta.length <= tb.length ? ta : tb
  const longer = ta.length <= tb.length ? tb : ta
  const longerJoined = ` ${longer.join(' ')} `
  for (let i = 0; i <= shorter.length - minWords; i++) {
    const phrase = shorter.slice(i, i + minWords).join(' ')
    if (longerJoined.includes(` ${phrase} `)) return true
  }
  return false
}

export function isNearDuplicate(
  a: string,
  b: string,
  threshold = 0.82,
): boolean {
  if (!a.trim() || !b.trim()) return false
  if (normalizeSpoken(a) === normalizeSpoken(b)) return true
  if (spokenSimilarity(a, b) >= threshold) return true
  // Long shared phrase = parrot even if the rest of the reply differs.
  return sharesLongPhrase(a, b, 10)
}

export function extractSpokenReply(raw: string): string {
  let text = raw.trim()
  if (!text) return ''

  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)```$/i)
  if (fenced?.[1]) text = fenced[1].trim()

  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const spoken = fromObject(JSON.parse(text) as unknown)
      if (spoken) text = spoken
    } catch {
      // fall through
    }
  }

  const embedded = text.match(/\{[\s\S]*\}/)
  if (embedded && (text.includes('"reply"') || text.includes('"text"'))) {
    try {
      const spoken = fromObject(JSON.parse(embedded[0]!) as unknown)
      if (spoken) text = spoken
    } catch {
      // fall through
    }
  }

  text = unwrapQuotedDialogue(text)
  text = stripStageAndThoughts(text)
  text = capSentences(text, 3)
  return text.slice(0, 400)
}
