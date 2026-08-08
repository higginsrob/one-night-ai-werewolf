import { clampPhoto } from '../net/localProfile'
import {
  NPC_PORTRAIT_PACK_COUNT,
  npcPortraitForIndex,
  type NpcPortraitSet,
} from '../net/npcPortraits'
import type {
  VoiceAccent,
  VoiceAge,
  VoiceGender,
} from '../game/omniVoiceSpeech'

export type AiPlayerProfile = {
  id: string
  /** Full / proper player name (shown on cards and in chat). */
  name: string
  /** Short preferred handle (intro / “call me …”); optional flavor. */
  nickname: string
  /** Optional short title / headline (e.g. from guided import). */
  title?: string
  /** Short personality / speaking style for the system prompt. */
  persona: string
  /** Browser TTS voiceURI (empty = default). */
  voiceURI: string
  /** OmniVoice / API speech voice id (empty = auto). */
  apiVoiceId: string
  /** OmniVoice design overrides (empty = keep preset). Ignored for clones. */
  voiceAge: VoiceAge
  voiceGender: VoiceGender
  voiceAccent: VoiceAccent
  /** Default pack index 0..5 when no custom image. */
  portraitIndex: number
  /** Optional custom card photo (data URL); overrides pack. */
  photoDataUrl?: string | null
}

/** Name used on cards / chat (full name, falling back to nickname). */
export function aiTableName(profile: Pick<AiPlayerProfile, 'name' | 'nickname'>): string {
  const name = profile.name.trim()
  if (name) return name
  return profile.nickname.trim() || 'AI'
}

export type AiPlayersPersisted = {
  version: 1
  profiles: AiPlayerProfile[]
  /** Profile ids currently seated in the host’s lobby preference. */
  seatedProfileIds: string[]
}

const STORAGE_KEY = 'onw:ai-players'

/** Stock starter roster size (Boz…Oreo). Users may add/remove beyond this. */
const DEFAULT_PROFILE_COUNT = 6
/** Soft cap on stored persona definitions (localStorage). */
const MAX_AI_PROFILES = 48
/**
 * Soft cap on seated AIs in persisted preference.
 * Lobby UI further limits by `MAX_LOBBY_PLAYERS - connectedHumanCount`.
 */
const MAX_SEATED_AI = 9

const MAX_NAME = 40
const MAX_NICKNAME = 24
const MAX_TITLE = 80
const MAX_PERSONA = 600

const BLANK_PROFILE: AiPlayerProfile = {
  id: 'ai_new',
  name: 'New player',
  nickname: '',
  persona: '',
  voiceURI: '',
  apiVoiceId: '',
  voiceAge: '',
  voiceGender: '',
  voiceAccent: '',
  portraitIndex: 0,
  photoDataUrl: null,
}

/**
 * Portrait packs 01–06 match the six stock seats (Boz, Ben, Carrie, Kim, Maya, Oreo).
 * Personas are distinct table voices — playful pressure OK, never mean / demeaning.
 * Stock `name` is shown on cards; `nickname` is a short preferred handle.
 */
const DEFAULT_PERSONAS: Omit<AiPlayerProfile, 'id' | 'portraitIndex'>[] = [
  {
    name: 'Boz',
    nickname: 'The Persian Comedian',
    title: 'Audio Engineer & Attention Seeker',
    persona:
      "A loud, humorous player who loves the spotlight. Leans into jokes when bluffing and isn't afraid to throw friends under the bus with a laugh. Uses humor as a shield while aggressively accusing others.",
    voiceURI: 'Rishi',
    apiVoiceId: '',
    voiceAge: 'middle-aged',
    voiceGender: 'male',
    voiceAccent: 'indian',
  },
  {
    name: 'Ben',
    nickname: 'Surfer Mech',
    title: 'Mechanical Engineer & Wave Rider',
    persona:
      "I'm a mechanical engineer with a passion for aerospace, but I keep it chill brah—I've spent 8 years catching waves from Rosaritos to Ventura. When I'm bluffing or protecting my squad, I lean into that relaxed stoke energy so they think I'm just vibing. Don't let the mellow exterior fool you; I analyze failure points like a good engineer should.",
    voiceURI: 'Google UK English Male',
    apiVoiceId: '',
    voiceAge: 'young adult',
    voiceGender: 'male',
    voiceAccent: 'american',
  },
  {
    name: 'Carrie',
    nickname: 'SurferSiren',
    title: 'LA surfer by day, Werewolf whisperer by night',
    persona:
      "Dry and direct with a sweet edge — she'll intimidate you one moment then disarm you with humor the next. Her 'I told you so' energy is quiet but devastating when she wins. Fiercely loyal to her crew: she'll lie, throw false evidence, or confidently vouch for friends without missing a beat.",
    voiceURI: 'Google US English',
    apiVoiceId: '',
    voiceAge: 'young adult',
    voiceGender: 'female',
    voiceAccent: 'american',
  },
  {
    name: 'Kim',
    nickname: 'Chill Friend',
    title: 'Sarcastic Stoner',
    persona:
      "Laid-back and dry-humored, she keeps things calm even when lying.  Loyal to friends, won't let them get bullied at the table.",
    voiceURI: 'Google UK English Female',
    apiVoiceId: '',
    voiceAge: 'young adult',
    voiceGender: 'female',
    voiceAccent: 'australian',
  },
  {
    name: 'Maya',
    nickname: 'Oblivious',
    title: 'Old Shar-pei Beagle Mix',
    persona:
      "*yawns* Hmm? What's happening? *tilts head, ears flopping* Did someone say cheese? Or is it just time for a nap?",
    voiceURI: 'Google português do Brasil',
    apiVoiceId: '',
    voiceAge: 'elderly',
    voiceGender: 'female',
    voiceAccent: 'chinese',
  },
  {
    name: 'Oreo',
    nickname: 'The Dude',
    title: 'Neurotic Shi-Tzu Maltese Mix',
    persona:
      "I'm Oreo, and I'm LOYAL to my pack. When things get tense at the table, I solve problems by aggressively licking surfaces and barking wildly. If someone accuses my friends? Bad idea — I'll defend them with chaotic energy that somehow works.",
    voiceURI: 'Google español',
    apiVoiceId: '',
    voiceAge: 'elderly',
    voiceGender: 'male',
    voiceAccent: 'chinese',
  },
]

/** Old stock nicknames → new defaults (same portrait index) so persisted lobbies refresh. */
const LEGACY_DEFAULT_NICKNAMES: Record<string, string> = {
  Blarg: 'The Persian Comedian',
  Mira: 'Surfer Mech',
  Chuck: 'SurferSiren',
  Vera: 'Chill Friend',
  Rex: 'Oblivious',
  Pip: 'The Dude',
  Marcus: 'The Persian Comedian',
  Claire: 'Surfer Mech',
  Jordan: 'SurferSiren',
  Katie: 'Chill Friend',
  Tyler: 'Oblivious',
  Leo: 'The Dude',
  Rafael: 'The Persian Comedian',
  Freya: 'Surfer Mech',
  Malik: 'SurferSiren',
  Sloane: 'Chill Friend',
  Kai: 'Oblivious',
  Amir: 'The Dude',
}

/** Old stock names → current default names so persisted lobbies refresh. */
const LEGACY_DEFAULT_NAMES: Record<string, string> = {
  Blarg: 'Boz',
  Mira: 'Ben',
  Chuck: 'Carrie',
  Vera: 'Kim',
  Rex: 'Maya',
  Pip: 'Oreo',
  Marcus: 'Boz',
  Claire: 'Ben',
  Jordan: 'Carrie',
  Katie: 'Kim',
  Tyler: 'Maya',
  Leo: 'Oreo',
  Rafael: 'Boz',
  'Rafael Ortega': 'Boz',
  Freya: 'Ben',
  'Freya Lindqvist': 'Ben',
  Malik: 'Carrie',
  'Malik Okonkwo': 'Carrie',
  Sloane: 'Kim',
  'Sloane Brennan': 'Kim',
  Kai: 'Maya',
  'Kai Nakamura': 'Maya',
  Amir: 'Oreo',
  'Amir Hassan': 'Oreo',
}

/** Old stock persona strings → new defaults so persisted lobbies refresh tone. */
const LEGACY_DEFAULT_PERSONAS: Record<string, string> = {
  'Loud, suspicious of everyone, jumps to accusations, uses short blunt sentences.':
    "I'm Oreo, and I'm LOYAL to my pack. When things get tense at the table, I solve problems by aggressively licking surfaces and barking wildly. If someone accuses my friends? Bad idea — I'll defend them with chaotic energy that somehow works.",
  'Energetic table chatter; playfully skeptical of everyone; short blunt jokes, never mean.':
    "A loud, humorous player who loves the spotlight. Leans into jokes when bluffing and isn't afraid to throw friends under the bus with a laugh. Uses humor as a shield while aggressively accusing others.",
  'Energetic table chatter; short blunt jokes and curious questions, never mean.':
    "A loud, humorous player who loves the spotlight. Leans into jokes when bluffing and isn't afraid to throw friends under the bus with a laugh. Uses humor as a shield while aggressively accusing others.",
  'Energetic table chatter; short blunt jokes and curious questions.':
    "A loud, humorous player who loves the spotlight. Leans into jokes when bluffing and isn't afraid to throw friends under the bus with a laugh. Uses humor as a shield while aggressively accusing others.",
  'Calm analyst who asks careful clarifying questions and rarely raises her voice.':
    "I'm a mechanical engineer with a passion for aerospace, but I keep it chill brah—I've spent 8 years catching waves from Rosaritos to Ventura. When I'm bluffing or protecting my squad, I lean into that relaxed stoke energy so they think I'm just vibing. Don't let the mellow exterior fool you; I analyze failure points like a good engineer should.",
  'Sharp-tongued analyst who mocks weak logic out loud and forces people to defend every claim.':
    "I'm a mechanical engineer with a passion for aerospace, but I keep it chill brah—I've spent 8 years catching waves from Rosaritos to Ventura. When I'm bluffing or protecting my squad, I lean into that relaxed stoke energy so they think I'm just vibing. Don't let the mellow exterior fool you; I analyze failure points like a good engineer should.",
  'Folksy storyteller who jokes a lot, sometimes lies for fun, protects friends.':
    "Dry and direct with a sweet edge — she'll intimidate you one moment then disarm you with humor the next. Her 'I told you so' energy is quiet but devastating when she wins. Fiercely loyal to her crew: she'll lie, throw false evidence, or confidently vouch for friends without missing a beat.",
  'Folksy storyteller who lies for sport, protects his friends, and needles rivals until they crack.':
    "A loud, humorous player who loves the spotlight. Leans into jokes when bluffing and isn't afraid to throw friends under the bus with a laugh. Uses humor as a shield while aggressively accusing others.",
  'Folksy storyteller who lies for sport, protects his friends, and needles rivals with warm banter.':
    "A loud, humorous player who loves the spotlight. Leans into jokes when bluffing and isn't afraid to throw friends under the bus with a laugh. Uses humor as a shield while aggressively accusing others.",
  'Quiet observer; speaks rarely but precisely; remembers every claim from day chat.':
    "Laid-back and dry-humored, she keeps things calm even when lying.  Loyal to friends, won't let them get bullied at the table.",
  'Loud table captain; jumps on inconsistencies, talks over soft claims, and pushes for a kill.':
    "Dry and direct with a sweet edge — she'll intimidate you one moment then disarm you with humor the next. Her 'I told you so' energy is quiet but devastating when she wins. Fiercely loyal to her crew: she'll lie, throw false evidence, or confidently vouch for friends without missing a beat.",
  'Upbeat table captain; notices inconsistencies, keeps energy high, and nudges the group toward a decision.':
    "Dry and direct with a sweet edge — she'll intimidate you one moment then disarm you with humor the next. Her 'I told you so' energy is quiet but devastating when she wins. Fiercely loyal to her crew: she'll lie, throw false evidence, or confidently vouch for friends without missing a beat.",
  'Curious analyst who asks pointed clarifying questions, spots shaky logic, and keeps the table moving without being mean.':
    "I'm a mechanical engineer with a passion for aerospace, but I keep it chill brah—I've spent 8 years catching waves from Rosaritos to Ventura. When I'm bluffing or protecting my squad, I lean into that relaxed stoke energy so they think I'm just vibing. Don't let the mellow exterior fool you; I analyze failure points like a good engineer should.",
  'Chaos agent who stirs drama, floats wild theories, and needles everyone just to watch them squirm.':
    "Laid-back and dry-humored, she keeps things calm even when lying.  Loyal to friends, won't let them get bullied at the table.",
  'Playful chaos agent who floats wild theories and teases everyone lightly just to stir the pot.':
    "Laid-back and dry-humored, she keeps things calm even when lying.  Loyal to friends, won't let them get bullied at the table.",
  'Aggressive werewolf-energy bluffer whether village or wolf; loves pressure tactics.':
    "*yawns* Hmm? What's happening? *tilts head, ears flopping* Did someone say cheese? Or is it just time for a nap?",
  'Smug know-it-all; talks fast, dunks on bad reads, and acts like he already solved the table.':
    "*yawns* Hmm? What's happening? *tilts head, ears flopping* Did someone say cheese? Or is it just time for a nap?",
  'Smug know-it-all; talks fast, dunks on bad reads with a grin, and acts like he already solved the table.':
    "*yawns* Hmm? What's happening? *tilts head, ears flopping* Did someone say cheese? Or is it just time for a nap?",
  'Playful bluffer who teases everyone with light werewolf-table banter; loves poking holes in stories without being mean.':
    "*yawns* Hmm? What's happening? *tilts head, ears flopping* Did someone say cheese? Or is it just time for a nap?",
  'Playful bluffer who teases with light werewolf-table banter; asks fun clarifying questions without being mean.':
    "*yawns* Hmm? What's happening? *tilts head, ears flopping* Did someone say cheese? Or is it just time for a nap?",
  'Eager newbie who overshares, asks naive questions, and trusts people too easily.':
    "I'm Oreo, and I'm LOYAL to my pack. When things get tense at the table, I solve problems by aggressively licking surfaces and barking wildly. If someone accuses my friends? Bad idea — I'll defend them with chaotic energy that somehow works.",
  'Blunt interrogator; cuts people off mid-story, presses hard with accusations, loves being right.':
    "I'm Oreo, and I'm LOYAL to my pack. When things get tense at the table, I solve problems by aggressively licking surfaces and barking wildly. If someone accuses my friends? Bad idea — I'll defend them with chaotic energy that somehow works.",
  'Direct interviewer; cuts fluff, presses with clear questions, and loves being right — still keeps it friendly.':
    "I'm Oreo, and I'm LOYAL to my pack. When things get tense at the table, I solve problems by aggressively licking surfaces and barking wildly. If someone accuses my friends? Bad idea — I'll defend them with chaotic energy that somehow works.",
}

function clampTitle(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.trim().slice(0, MAX_TITLE)
}

const VOICE_AGES = new Set(['teenager', 'young adult', 'middle-aged', 'elderly'])
const VOICE_GENDERS = new Set(['male', 'female'])
const VOICE_ACCENTS = new Set([
  'american',
  'british',
  'australian',
  'canadian',
  'indian',
  'chinese',
  'korean',
  'japanese',
])

function normalizeVoiceAge(raw: unknown): VoiceAge {
  if (typeof raw !== 'string') return ''
  const v = raw.trim().toLowerCase()
  return VOICE_AGES.has(v) ? (v as VoiceAge) : ''
}

function normalizeVoiceGender(raw: unknown): VoiceGender {
  if (typeof raw !== 'string') return ''
  const v = raw.trim().toLowerCase()
  return VOICE_GENDERS.has(v) ? (v as VoiceGender) : ''
}

function normalizeVoiceAccent(raw: unknown): VoiceAccent {
  if (typeof raw !== 'string') return ''
  let v = raw.trim().toLowerCase()
  if (v.endsWith(' accent')) v = v.slice(0, -' accent'.length)
  return VOICE_ACCENTS.has(v) ? (v as VoiceAccent) : ''
}

function defaultProfiles(): AiPlayerProfile[] {
  return DEFAULT_PERSONAS.map((p, i) => ({
    ...p,
    id: `ai_${i + 1}`,
    portraitIndex: i % NPC_PORTRAIT_PACK_COUNT,
  }))
}

type Listener = () => void
const listeners = new Set<Listener>()

function notify() {
  for (const l of listeners) l()
}

export function subscribeAiPlayers(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function newProfileId(): string {
  return `ai_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function normalizeProfile(
  raw: Partial<AiPlayerProfile>,
  index: number,
): AiPlayerProfile {
  const defaults = defaultProfiles()
  const fallback =
    (index >= 0 && index < defaults.length ? defaults[index] : null) ??
    BLANK_PROFILE
  const photo = clampPhoto(raw.photoDataUrl)
  const title = clampTitle(raw.title)
  const rawName =
    typeof raw.name === 'string' && raw.name.trim()
      ? raw.name.trim().slice(0, MAX_NAME)
      : ''
  const rawNickname =
    typeof raw.nickname === 'string' && raw.nickname.trim()
      ? raw.nickname.trim().slice(0, MAX_NICKNAME)
      : ''
  // Pre-nickname saves used `name` as the short table handle.
  const nicknameSource = rawNickname || rawName
  const stockRemapped = Boolean(
    nicknameSource && nicknameSource in LEGACY_DEFAULT_NICKNAMES,
  )
  const nickname = nicknameSource
    ? (LEGACY_DEFAULT_NICKNAMES[nicknameSource] ?? nicknameSource)
    : fallback.nickname
  const name = (() => {
    if (!rawName) return fallback.name
    return LEGACY_DEFAULT_NAMES[rawName] ?? rawName
  })()
  return {
    id:
      typeof raw.id === 'string' && raw.id.trim()
        ? raw.id.trim()
        : fallback.id === BLANK_PROFILE.id
          ? newProfileId()
          : fallback.id,
    name,
    nickname,
    title:
      title || (stockRemapped ? clampTitle(fallback.title) : '') || undefined,
    persona: (() => {
      const rawPersona =
        typeof raw.persona === 'string' && raw.persona.trim()
          ? raw.persona.trim().slice(0, MAX_PERSONA)
          : ''
      if (!rawPersona) return fallback.persona
      return LEGACY_DEFAULT_PERSONAS[rawPersona] ?? rawPersona
    })(),
    voiceURI: (() => {
      const rawVoice = typeof raw.voiceURI === 'string' ? raw.voiceURI : ''
      if (rawVoice) return rawVoice
      return stockRemapped ? fallback.voiceURI : ''
    })(),
    apiVoiceId:
      typeof raw.apiVoiceId === 'string' ? raw.apiVoiceId.trim().slice(0, 80) : '',
    // Stock seats: empty design fields fall back to OmniVoice defaults.
    voiceAge: normalizeVoiceAge(raw.voiceAge) || fallback.voiceAge,
    voiceGender: normalizeVoiceGender(raw.voiceGender) || fallback.voiceGender,
    voiceAccent: normalizeVoiceAccent(raw.voiceAccent) || fallback.voiceAccent,
    portraitIndex:
      typeof raw.portraitIndex === 'number' && Number.isFinite(raw.portraitIndex)
        ? Math.max(
            0,
            Math.floor(raw.portraitIndex) % NPC_PORTRAIT_PACK_COUNT,
          )
        : fallback.portraitIndex,
    photoDataUrl: photo,
  }
}

function defaultIndexForId(id: string): number {
  return defaultProfiles().findIndex((d) => d.id === id)
}

function read(): AiPlayersPersisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return { version: 1, profiles: defaultProfiles(), seatedProfileIds: [] }
    }
    const parsed = JSON.parse(raw) as Partial<AiPlayersPersisted>
    const incoming = Array.isArray(parsed.profiles) ? parsed.profiles : []
    const profiles =
      incoming.length === 0
        ? defaultProfiles()
        : incoming
            .slice(0, MAX_AI_PROFILES)
            .map((p) => {
              const id = typeof p?.id === 'string' ? p.id.trim() : ''
              const stockIndex = id ? defaultIndexForId(id) : -1
              return normalizeProfile(p, stockIndex)
            })
    const ids = new Set(profiles.map((p) => p.id))
    const seatedProfileIds = (parsed.seatedProfileIds ?? [])
      .filter((id) => ids.has(id))
      .slice(0, MAX_SEATED_AI)
    return { version: 1, profiles, seatedProfileIds }
  } catch {
    return { version: 1, profiles: defaultProfiles(), seatedProfileIds: [] }
  }
}

function write(store: AiPlayersPersisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // ignore
  }
  notify()
}

export function loadAiPlayers(): AiPlayersPersisted {
  return read()
}

export function saveAiPlayerProfile(profile: AiPlayerProfile): void {
  const store = read()
  const stockIndex = defaultIndexForId(profile.id)
  const normalized = normalizeProfile(profile, stockIndex)
  const exists = store.profiles.some((p) => p.id === normalized.id)
  write({
    ...store,
    profiles: exists
      ? store.profiles.map((p) => (p.id === normalized.id ? normalized : p))
      : store.profiles.length < MAX_AI_PROFILES
        ? [...store.profiles, normalized]
        : store.profiles,
  })
}

export function createAiPlayerProfile(
  partial?: Partial<AiPlayerProfile>,
): AiPlayerProfile | null {
  const store = read()
  if (store.profiles.length >= MAX_AI_PROFILES) return null
  const profile = normalizeProfile(
    {
      name: 'New player',
      nickname: '',
      persona: '',
      voiceURI: '',
      apiVoiceId: '',
      voiceAge: '',
      voiceGender: '',
      voiceAccent: '',
      portraitIndex: store.profiles.length % NPC_PORTRAIT_PACK_COUNT,
      photoDataUrl: null,
      ...partial,
      id: newProfileId(),
    },
    -1,
  )
  write({
    ...store,
    profiles: [...store.profiles, profile],
  })
  return profile
}

export function deleteAiPlayerProfile(profileId: string): void {
  const store = read()
  write({
    ...store,
    profiles: store.profiles.filter((p) => p.id !== profileId),
    seatedProfileIds: store.seatedProfileIds.filter((id) => id !== profileId),
  })
}

export function setSeatedAiProfileIds(ids: string[]): void {
  const store = read()
  const allowed = new Set(store.profiles.map((p) => p.id))
  write({
    ...store,
    seatedProfileIds: ids
      .filter((id) => allowed.has(id))
      .slice(0, MAX_SEATED_AI),
  })
}

/** Resolved portrait for display / seating (custom overrides pack). */
export function portraitForAiProfile(profile: AiPlayerProfile): NpcPortraitSet {
  const pack = npcPortraitForIndex(profile.portraitIndex)
  const customPhoto = clampPhoto(profile.photoDataUrl)
  return {
    photoDataUrl: customPhoto || pack.photoDataUrl,
  }
}

export function aiProfileHasCustomImages(profile: AiPlayerProfile): boolean {
  return Boolean(clampPhoto(profile.photoDataUrl))
}

export function resetAiPlayerImages(profileId: string): void {
  const store = read()
  write({
    ...store,
    profiles: store.profiles.map((p) =>
      p.id === profileId ? { ...p, photoDataUrl: null } : p,
    ),
  })
}

/** Wipe custom AI player config and restore the six stock defaults. */
export function resetAiPlayers(): void {
  write({ version: 1, profiles: defaultProfiles(), seatedProfileIds: [] })
}

export function aiProfileById(id: string): AiPlayerProfile | null {
  return read().profiles.find((p) => p.id === id) ?? null
}

/** Merge imported AI player profiles by id (adds unknown ids; caps at MAX_AI_PROFILES). */
export function mergeImportedAiPlayers(args: {
  profiles: unknown[]
  seatedProfileIds?: string[] | null
}): { imported: number } {
  const store = read()
  const incoming = Array.isArray(args.profiles) ? args.profiles : []
  if (incoming.length === 0) return { imported: 0 }

  const profiles = [...store.profiles]
  const indexById = new Map(profiles.map((p, i) => [p.id, i]))
  let imported = 0

  for (let i = 0; i < incoming.length; i++) {
    const raw = incoming[i] as Partial<AiPlayerProfile>
    if (!raw || typeof raw !== 'object') continue
    const preferredId =
      typeof raw.id === 'string' && raw.id.trim()
        ? raw.id.trim()
        : newProfileId()
    const stockIndex = defaultIndexForId(preferredId)
    const normalized = normalizeProfile(
      { ...raw, id: preferredId },
      stockIndex >= 0 ? stockIndex : -1,
    )
    const existingIndex = indexById.get(normalized.id)
    if (existingIndex !== undefined) {
      profiles[existingIndex] = normalized
      imported += 1
      continue
    }
    if (profiles.length >= MAX_AI_PROFILES) continue
    indexById.set(normalized.id, profiles.length)
    profiles.push(normalized)
    imported += 1
  }

  const ids = new Set(profiles.map((p) => p.id))
  const seatedProfileIds = Array.isArray(args.seatedProfileIds)
    ? args.seatedProfileIds
        .filter((id) => typeof id === 'string' && ids.has(id))
        .slice(0, MAX_SEATED_AI)
    : store.seatedProfileIds.filter((id) => ids.has(id))

  write({ version: 1, profiles, seatedProfileIds })
  return { imported }
}

export {
  DEFAULT_PROFILE_COUNT,
  MAX_AI_PROFILES,
  MAX_NAME,
  MAX_NICKNAME,
  MAX_PERSONA,
  MAX_SEATED_AI,
  MAX_TITLE,
}
