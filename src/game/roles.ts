import type { NightStep, WerewolfRole } from './werewolfTypes'
import { DEFAULT_DAY_DURATION_SEC } from './werewolfSettings'

export type RoleInfo = {
  id: WerewolfRole
  name: string
  team: 'village' | 'werewolf' | 'neutral'
  blurb: string
}

export const ROLE_INFO: Record<WerewolfRole, RoleInfo> = {
  werewolf: {
    id: 'werewolf',
    name: 'Werewolf',
    team: 'werewolf',
    blurb: 'At night, find the other werewolves. Survive the day vote.',
  },
  minion: {
    id: 'minion',
    name: 'Minion',
    team: 'werewolf',
    blurb: 'You see the werewolves. You win if a werewolf survives — even if you die.',
  },
  seer: {
    id: 'seer',
    name: 'Seer',
    team: 'village',
    blurb: 'Look at one player’s card, or two cards in the center.',
  },
  robber: {
    id: 'robber',
    name: 'Robber',
    team: 'village',
    blurb: 'Swap your card with another player’s, then look at your new card.',
  },
  troublemaker: {
    id: 'troublemaker',
    name: 'Troublemaker',
    team: 'village',
    blurb: 'Swap two other players’ cards. Do not look at them.',
  },
  villager: {
    id: 'villager',
    name: 'Villager',
    team: 'village',
    blurb: 'No night action. Find the werewolves.',
  },
  insomniac: {
    id: 'insomniac',
    name: 'Insomniac',
    team: 'village',
    blurb: 'At the end of the night, look at your own card.',
  },
  mason: {
    id: 'mason',
    name: 'Mason',
    team: 'village',
    blurb: 'Wake with the other Mason. You are both on the village team.',
  },
  drunk: {
    id: 'drunk',
    name: 'Drunk',
    team: 'village',
    blurb: 'Swap your card with a center card. Do not look at your new card.',
  },
  hunter: {
    id: 'hunter',
    name: 'Hunter',
    team: 'village',
    blurb: 'If you die, you choose someone to die with you.',
  },
  tanner: {
    id: 'tanner',
    name: 'Tanner',
    team: 'neutral',
    blurb:
      'You win if you die. If a werewolf also dies, village wins too; if not, werewolves do not win.',
  },
}

/** Night wake order (skip steps whose roles are not in the dealt set). */
export const NIGHT_ORDER: NightStep[] = [
  'intro',
  'werewolves',
  'minion',
  'masons',
  'seer',
  'robber',
  'troublemaker',
  'drunk',
  'insomniac',
  'outro',
]

/** True once `target` has begun (or the night is over). */
export function nightStepReached(
  phase: string,
  currentStep: NightStep | null | undefined,
  target: NightStep,
): boolean {
  if (
    phase === 'dawn' ||
    phase === 'day' ||
    phase === 'reveal' ||
    phase === 'ended'
  ) {
    return true
  }
  if (phase !== 'night' || !currentStep) return false
  // Simultaneous night: every role is "awake" together for private info UI.
  if (currentStep === 'simultaneous') return true
  return NIGHT_ORDER.indexOf(currentStep) >= NIGHT_ORDER.indexOf(target)
}

export function roleName(role: WerewolfRole): string {
  return ROLE_INFO[role].name
}

/** Map a dealt role to its narrator night step (null = no wake). */
export function nightStepForDealtRole(role: WerewolfRole): NightStep | null {
  switch (role) {
    case 'werewolf':
      return 'werewolves'
    case 'minion':
      return 'minion'
    case 'mason':
      return 'masons'
    case 'seer':
      return 'seer'
    case 'robber':
      return 'robber'
    case 'troublemaker':
      return 'troublemaker'
    case 'drunk':
      return 'drunk'
    case 'insomniac':
      return 'insomniac'
    default:
      return null
  }
}

/** One entry per role type for lobby / settings pickers. */
export const UNIQUE_ROLES: WerewolfRole[] = [
  'werewolf',
  'minion',
  'seer',
  'robber',
  'troublemaker',
  'villager',
  'insomniac',
  'mason',
  'drunk',
  'hunter',
  'tanner',
]

/** Physical base-game card pool (multiples match the box). */
export const ROLE_POOL: WerewolfRole[] = [
  'werewolf',
  'werewolf',
  'minion',
  'seer',
  'robber',
  'villager',
  'villager',
  'villager',
  'troublemaker',
  'insomniac',
  'mason',
  'mason',
  'drunk',
  'hunter',
  'tanner',
]

const ALL_ROLES = new Set<string>(Object.keys(ROLE_INFO))

export function isWerewolfRole(value: unknown): value is WerewolfRole {
  return typeof value === 'string' && ALL_ROLES.has(value)
}

/** How many copies of a role exist in the physical pool. */
export function poolCount(role: WerewolfRole): number {
  return ROLE_POOL.filter((r) => r === role).length
}

/** True if value is a unique index into ROLE_POOL. */
export function isPoolIndex(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < ROLE_POOL.length
  )
}

/** Map role multiset → physical pool slot indices (first available copies). */
export function poolIndicesForRoles(roles: WerewolfRole[]): number[] {
  const used = new Map<WerewolfRole, number>()
  const indices: number[] = []
  for (const role of roles) {
    const copy = used.get(role) ?? 0
    used.set(role, copy + 1)
    let seen = 0
    for (let i = 0; i < ROLE_POOL.length; i++) {
      if (ROLE_POOL[i] !== role) continue
      if (seen === copy) {
        indices.push(i)
        break
      }
      seen++
    }
  }
  return indices.sort((a, b) => a - b)
}

/** Resolve selected pool slots to the role list used when dealing. */
export function rolesFromPoolIndices(indices: number[]): WerewolfRole[] {
  const unique = [...new Set(indices.filter(isPoolIndex))].sort((a, b) => a - b)
  return unique.map((i) => ROLE_POOL[i]!)
}

/** Validate a host-selected role list (players + 3 cards). */
export function validateWerewolfDeck(
  roles: unknown,
  playerCount: number,
): roles is WerewolfRole[] {
  if (!Array.isArray(roles)) return false
  if (playerCount < 3 || playerCount > 10) return false
  if (roles.length !== playerCount + 3) return false
  if (roles.length < 6 || roles.length > 13) return false
  const used = new Map<WerewolfRole, number>()
  for (const r of roles) {
    if (!isWerewolfRole(r)) return false
    used.set(r, (used.get(r) ?? 0) + 1)
  }
  for (const [role, n] of used) {
    if (n > poolCount(role)) return false
  }
  return true
}

/**
 * Validate lobby deck as unique ROLE_POOL indices (players + 3 cards).
 * Incomplete selections are allowed while building — use this only for start-ready.
 */
export function validateWerewolfPoolDeck(
  indices: unknown,
  playerCount: number,
): indices is number[] {
  if (!Array.isArray(indices)) return false
  if (playerCount < 3 || playerCount > 10) return false
  if (indices.length !== playerCount + 3) return false
  if (indices.length < 6 || indices.length > ROLE_POOL.length) return false
  const seen = new Set<number>()
  for (const i of indices) {
    if (!isPoolIndex(i) || seen.has(i)) return false
    seen.add(i)
  }
  return true
}

/** Lobby incomplete-deck check: unique pool indices, 0…pool size. */
export function isValidLobbyPoolDeck(indices: unknown): indices is number[] {
  if (!Array.isArray(indices) || indices.length > ROLE_POOL.length) return false
  const seen = new Set<number>()
  for (const i of indices) {
    if (!isPoolIndex(i) || seen.has(i)) return false
    seen.add(i)
  }
  return true
}

const LOBBY_DECK_STORAGE_KEY = 'onw:lobby-deck'

/** Persist lobby card selections across page refresh. */
export function loadLobbyDeck(): number[] | null {
  try {
    const raw = localStorage.getItem(LOBBY_DECK_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!isValidLobbyPoolDeck(parsed)) return null
    return [...parsed].sort((a, b) => a - b)
  } catch {
    return null
  }
}

export function saveLobbyDeck(poolIndices: number[]): void {
  if (!isValidLobbyPoolDeck(poolIndices)) return
  try {
    localStorage.setItem(
      LOBBY_DECK_STORAGE_KEY,
      JSON.stringify([...poolIndices].sort((a, b) => a - b)),
    )
  } catch {
    // Quota / private mode — ignore
  }
}

/** Recommended n+3 card deck for One Night AI Werewolf. */
export function buildRoleDeck(playerCount: number): WerewolfRole[] {
  const need = playerCount + 3
  if (need < 6) {
    throw new Error('One Night AI Werewolf needs at least 3 players')
  }

  const deck: WerewolfRole[] = [
    'werewolf',
    'werewolf',
    'seer',
    'robber',
    'troublemaker',
  ]

  const extras: WerewolfRole[] = [
    'villager',
    'insomniac',
    'minion',
    'mason',
    'mason',
    'drunk',
    'hunter',
    'tanner',
    'villager',
    'villager',
  ]

  for (const role of extras) {
    if (deck.length >= need) break
    deck.push(role)
  }
  while (deck.length < need) deck.push('villager')

  return deck.slice(0, need)
}

/** Alias used by the lobby “Recommended” button (role multiset). */
export const recommendedDeck = buildRoleDeck

/** Recommended n+3 selection as physical pool slot indices. */
export function recommendedPoolDeck(playerCount: number): number[] {
  return poolIndicesForRoles(buildRoleDeck(playerCount))
}

export function deckReady(
  deck: number[] | null | undefined,
  connectedCount: number,
): boolean {
  return Boolean(deck && validateWerewolfPoolDeck(deck, connectedCount))
}

export function shuffleInPlace<T>(arr: T[], rand = Math.random): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
  return arr
}

export type NarrationLine = {
  /** Spoken when the step begins (wake / intro / dawn). */
  wakeSpeak: string
  /** Spoken after the act window; null for intro/outro. */
  closeSpeak: string | null
  /** Short on-screen label. */
  title: string
  body: string
}

const MINUTE_WORDS: Record<number, string> = {
  1: 'one',
  2: 'two',
  3: 'three',
  4: 'four',
  5: 'five',
  6: 'six',
  7: 'seven',
  8: 'eight',
  9: 'nine',
  10: 'ten',
  11: 'eleven',
  12: 'twelve',
  13: 'thirteen',
  14: 'fourteen',
  15: 'fifteen',
}

/** Human-friendly day length for TTS / HUD (from settings ms). */
export function formatDayDurationSpeak(dayDurationMs: number): string {
  const sec = Math.max(60, Math.round(dayDurationMs / 1000))
  if (sec % 60 === 0) {
    const m = sec / 60
    const word = MINUTE_WORDS[m] ?? String(m)
    return m === 1 ? 'one minute' : `${word} minutes`
  }
  if (sec < 60) return `${sec} seconds`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  const minWord = MINUTE_WORDS[m] ?? String(m)
  const minPart = m === 1 ? 'one minute' : `${minWord} minutes`
  return `${minPart} and ${s} seconds`
}

/**
 * Announcer lines for the current night step.
 * `present` = roles in this round’s hand (role deck). Absent roles are
 * normally skipped before this is called; keep short fallbacks anyway.
 */
export function narrationForStep(
  step: NightStep,
  present: Set<WerewolfRole>,
  opts?: { dayDurationMs?: number },
): NarrationLine {
  switch (step) {
    case 'intro':
      return {
        title: 'Night falls',
        body: 'Everyone, close your eyes.',
        wakeSpeak: 'Everyone, close your eyes.',
        closeSpeak: null,
      }
    case 'werewolves':
      return {
        title: 'Werewolves',
        body: 'Werewolves wake up and look for other werewolves.',
        wakeSpeak: present.has('werewolf')
          ? 'Werewolves, wake up and look for other werewolves. If you are the only werewolf, you may look at one card in the center.'
          : 'Werewolves, wake up.',
        closeSpeak: 'Werewolves, close your eyes.',
      }
    case 'minion':
      return {
        title: 'Minion',
        body: 'Minion wakes and sees the werewolves.',
        wakeSpeak: present.has('minion')
          ? 'Minion, wake up. Werewolves, stick out your thumb so the Minion can see who you are.'
          : 'Minion, wake up.',
        closeSpeak: present.has('minion')
          ? 'Minion, close your eyes. Werewolves, put your thumbs down.'
          : 'Minion, close your eyes.',
      }
    case 'masons':
      return {
        title: 'Masons',
        body: 'Masons wake and look for each other.',
        wakeSpeak: present.has('mason')
          ? 'Masons, wake up and look for the other Mason.'
          : 'Masons, wake up.',
        closeSpeak: 'Masons, close your eyes.',
      }
    case 'seer':
      return {
        title: 'Seer',
        body: 'Seer may look at one player card, or two center cards.',
        wakeSpeak: present.has('seer')
          ? 'Seer, wake up. You may look at another player’s card, or two of the center cards.'
          : 'Seer, wake up.',
        closeSpeak: 'Seer, close your eyes.',
      }
    case 'robber':
      return {
        title: 'Robber',
        body: 'Robber may exchange with another player and view the new card.',
        wakeSpeak: present.has('robber')
          ? 'Robber, wake up. You may exchange your card with another player’s card, and then view your new card.'
          : 'Robber, wake up.',
        closeSpeak: 'Robber, close your eyes.',
      }
    case 'troublemaker':
      return {
        title: 'Troublemaker',
        body: 'Troublemaker may exchange two other players’ cards.',
        wakeSpeak: present.has('troublemaker')
          ? 'Troublemaker, wake up. You may exchange cards between two other players.'
          : 'Troublemaker, wake up.',
        closeSpeak: 'Troublemaker, close your eyes.',
      }
    case 'drunk':
      return {
        title: 'Drunk',
        body: 'Drunk exchanges with a center card without looking.',
        wakeSpeak: present.has('drunk')
          ? 'Drunk, wake up. Exchange your card with a card from the center. Do not look at your new card.'
          : 'Drunk, wake up.',
        closeSpeak: 'Drunk, close your eyes.',
      }
    case 'insomniac':
      return {
        title: 'Insomniac',
        body: 'Insomniac looks at their card — it may have changed.',
        wakeSpeak: present.has('insomniac')
          ? 'Insomniac, wake up. Look at your card. It may have changed.'
          : 'Insomniac, wake up.',
        closeSpeak: 'Insomniac, close your eyes.',
      }
    case 'outro': {
      const dayLen = formatDayDurationSpeak(
        opts?.dayDurationMs ?? DEFAULT_DAY_DURATION_SEC * 1000,
      )
      return {
        title: 'Dawn',
        body: `Everyone wakes. ${dayLen[0]!.toUpperCase()}${dayLen.slice(1)} to discuss and vote.`,
        wakeSpeak: `Everyone, wake up. You have ${dayLen} to find the werewolves.`,
        closeSpeak: null,
      }
    }
    case 'simultaneous':
      return {
        title: 'Night',
        body: 'Everyone with a night action acts now.',
        wakeSpeak: 'Night actions — make your choice.',
        closeSpeak: null,
      }
  }
}

/**
 * Single-player simultaneous window: announce the local human's role only.
 * Villager / no-action roles get empty wakeSpeak (stay dimmed).
 */
export function narrationForHumanNight(
  humanRole: WerewolfRole | null | undefined,
  present: Set<WerewolfRole>,
  opts?: { dayDurationMs?: number },
): NarrationLine {
  const step = humanRole ? nightStepForDealtRole(humanRole) : null
  if (!step) {
    return {
      title: 'Night',
      body: 'Waiting for night actions…',
      wakeSpeak: '',
      closeSpeak: null,
    }
  }
  return narrationForStep(step, present, opts)
}
