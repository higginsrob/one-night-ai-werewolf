import { downloadBlob } from '../net/photoIo'
import {
  loadLocalProfile,
  parseImportedLocalProfile,
  resetLocalProfile,
  saveLocalProfile,
  type LocalPlayerProfile,
} from '../net/localProfile'
import {
  loadAiPlayers,
  mergeImportedAiPlayers,
  resetAiPlayers,
  type AiPlayerProfile,
} from './aiPlayers'
import {
  loadAiStore,
  mergeImportedModelConfigs,
  mergeImportedProviders,
  resetAiStore,
} from './aiStore'
import type { AiModelConfig, AiProvider } from './types'
import { setBrowserTtsVoiceURI } from '../game/browserTts'
import { loadTtsStore, patchTtsStore, resetTtsStore } from '../game/ttsStore'
import type { TtsStorePersisted } from '../game/ttsTypes'
import {
  loadWerewolfSettings,
  normalizeWerewolfSettings,
  resetWerewolfSettings,
  saveWerewolfSettings,
  type WerewolfHostSettings,
} from '../game/werewolfSettings'

const PROVIDERS_KIND = 'onw-ai-providers' as const
const MODEL_CONFIGS_KIND = 'onw-ai-model-configs' as const
const AI_STACK_KIND = 'onw-ai-providers-and-models' as const
const PLAYERS_KIND = 'onw-ai-players' as const
const PROFILE_KIND = 'onw-user-profile' as const
const TTS_KIND = 'onw-tts-settings' as const
const ALL_KIND = 'onw-settings-bundle' as const
const EXPORT_VERSION = 1 as const

type AiStackExport = {
  kind: typeof AI_STACK_KIND
  version: typeof EXPORT_VERSION
  providers: AiProvider[]
  modelConfigs: AiModelConfig[]
  activeWorkConfigId: string | null
  activeClassifierConfigId: string | null
  activeGuideConfigId: string | null
  activeTtsConfigId: string | null
}

type PlayersExport = {
  kind: typeof PLAYERS_KIND
  version: typeof EXPORT_VERSION
  profiles: AiPlayerProfile[]
  seatedProfileIds: string[]
}

type ProfileExport = {
  kind: typeof PROFILE_KIND
  version: typeof EXPORT_VERSION
  profile: LocalPlayerProfile
}

type TtsExport = {
  kind: typeof TTS_KIND
  version: typeof EXPORT_VERSION
  tts: TtsStorePersisted
  /** Browser narrator voice (from werewolf settings). */
  voiceURI: string | null
  browserTtsEnabled: boolean
}

type AllExport = {
  kind: typeof ALL_KIND
  version: typeof EXPORT_VERSION
  ai: Omit<AiStackExport, 'kind' | 'version'>
  players: Omit<PlayersExport, 'kind' | 'version'>
  /** Optional for older bundles that predate the user profile section. */
  profile?: LocalPlayerProfile
  tts: Omit<TtsExport, 'kind' | 'version'>
  game: WerewolfHostSettings
}

export type ImportSummary = {
  providers?: number
  modelConfigs?: number
  modelConfigsSkipped?: number
  players?: number
  profile?: boolean
  tts?: boolean
  game?: boolean
}

function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  })
  downloadBlob(blob, filename)
}

async function readJsonFile(file: File): Promise<unknown> {
  const text = await file.text()
  return JSON.parse(text) as unknown
}

function providersForExport(providers: AiProvider[]): AiProvider[] {
  return providers.map((p) => ({
    id: p.id,
    label: p.label,
    transport: p.transport,
    baseUrl: p.baseUrl,
    requiresApiKey: p.requiresApiKey,
  }))
}

function buildAiStackPayload(): Omit<AiStackExport, 'kind' | 'version'> {
  const store = loadAiStore()
  return {
    providers: providersForExport(store.providers),
    modelConfigs: store.modelConfigs,
    activeWorkConfigId: store.activeWorkConfigId,
    activeClassifierConfigId: store.activeClassifierConfigId,
    activeGuideConfigId: store.activeGuideConfigId,
    activeTtsConfigId: store.activeTtsConfigId,
  }
}

function buildPlayersPayload(): Omit<PlayersExport, 'kind' | 'version'> {
  const store = loadAiPlayers()
  return {
    profiles: store.profiles,
    seatedProfileIds: store.seatedProfileIds,
  }
}

function buildProfilePayload(): LocalPlayerProfile {
  return loadLocalProfile()
}

function buildTtsPayload(): Omit<TtsExport, 'kind' | 'version'> {
  const werewolf = loadWerewolfSettings()
  return {
    tts: loadTtsStore(),
    voiceURI: werewolf.voiceURI,
    browserTtsEnabled: werewolf.browserTtsEnabled,
  }
}

function applyTtsPayload(payload: {
  tts?: unknown
  voiceURI?: unknown
  browserTtsEnabled?: unknown
}): void {
  if (payload.tts && typeof payload.tts === 'object') {
    const raw = payload.tts as Partial<TtsStorePersisted>
    const patch: Partial<TtsStorePersisted> = {}
    if (typeof raw.ttsEnabled === 'boolean') patch.ttsEnabled = raw.ttsEnabled
    if (raw.engine === 'browser' || raw.engine === 'api') patch.engine = raw.engine
    if (
      typeof raw.narratorApiVoiceId === 'string' ||
      raw.narratorApiVoiceId === null
    ) {
      patch.narratorApiVoiceId = raw.narratorApiVoiceId
    }
    if (typeof raw.narratorVoiceAge === 'string') {
      patch.narratorVoiceAge = raw.narratorVoiceAge
    }
    if (typeof raw.narratorVoiceGender === 'string') {
      patch.narratorVoiceGender = raw.narratorVoiceGender
    }
    if (typeof raw.narratorVoiceAccent === 'string') {
      patch.narratorVoiceAccent = raw.narratorVoiceAccent
    }
    if (typeof raw.apiMaxSentencesPerChunk === 'number') {
      patch.apiMaxSentencesPerChunk = raw.apiMaxSentencesPerChunk
    }
    if (Object.keys(patch).length > 0) patchTtsStore(patch)
  }
  const current = loadWerewolfSettings()
  const next = normalizeWerewolfSettings({
    ...current,
    voiceURI:
      typeof payload.voiceURI === 'string' || payload.voiceURI === null
        ? (payload.voiceURI as string | null)
        : current.voiceURI,
    browserTtsEnabled:
      typeof payload.browserTtsEnabled === 'boolean'
        ? payload.browserTtsEnabled
        : current.browserTtsEnabled,
  })
  saveWerewolfSettings(next)
  setBrowserTtsVoiceURI(next.voiceURI)
}

function applyAiStackPayload(payload: {
  providers?: unknown
  modelConfigs?: unknown
  activeWorkConfigId?: string | null
  activeClassifierConfigId?: string | null
  activeGuideConfigId?: string | null
  activeTtsConfigId?: string | null
}): {
  providers: number
  modelConfigs: number
  modelConfigsSkipped: number
} {
  let providers = 0
  let modelConfigs = 0
  let modelConfigsSkipped = 0
  if (Array.isArray(payload.providers) && payload.providers.length > 0) {
    providers = mergeImportedProviders(payload.providers).imported
  }
  if (Array.isArray(payload.modelConfigs) && payload.modelConfigs.length > 0) {
    const result = mergeImportedModelConfigs({
      modelConfigs: payload.modelConfigs,
      activeWorkConfigId: payload.activeWorkConfigId ?? null,
      activeClassifierConfigId: payload.activeClassifierConfigId ?? null,
      activeGuideConfigId: payload.activeGuideConfigId ?? null,
      activeTtsConfigId: payload.activeTtsConfigId ?? null,
    })
    modelConfigs = result.imported
    modelConfigsSkipped = result.skipped
  }
  return { providers, modelConfigs, modelConfigsSkipped }
}

function applyPlayersPayload(payload: {
  profiles?: unknown
  seatedProfileIds?: string[] | null
}): number {
  if (!Array.isArray(payload.profiles)) return 0
  return mergeImportedAiPlayers({
    profiles: payload.profiles,
    seatedProfileIds: payload.seatedProfileIds ?? null,
  }).imported
}

function applyProfilePayload(raw: unknown): LocalPlayerProfile {
  const profile = parseImportedLocalProfile(raw)
  saveLocalProfile(profile)
  return loadLocalProfile()
}

/** Export AI providers + model configs (and active role assignments) together. */
export function exportAiStack(): void {
  const payload: AiStackExport = {
    kind: AI_STACK_KIND,
    version: EXPORT_VERSION,
    ...buildAiStackPayload(),
  }
  downloadJson(payload, 'onw-ai-providers-and-models.json')
}

/** Import providers + model configs; also accepts legacy separate export files. */
export async function importAiStackFromFile(file: File): Promise<ImportSummary> {
  const parsed = await readJsonFile(file)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid AI configuration file.')
  }
  const obj = parsed as {
    kind?: string
    version?: number
    providers?: unknown
    modelConfigs?: unknown
    activeWorkConfigId?: string | null
    activeClassifierConfigId?: string | null
    activeGuideConfigId?: string | null
    activeTtsConfigId?: string | null
    ai?: {
      providers?: unknown
      modelConfigs?: unknown
      activeWorkConfigId?: string | null
      activeClassifierConfigId?: string | null
      activeGuideConfigId?: string | null
      activeTtsConfigId?: string | null
    }
  }

  if (obj.version !== EXPORT_VERSION) {
    throw new Error('Unsupported AI configuration export version.')
  }

  if (obj.kind === ALL_KIND && obj.ai) {
    const result = applyAiStackPayload(obj.ai)
    if (result.providers === 0 && result.modelConfigs === 0) {
      throw new Error('No AI providers or model configs found in file.')
    }
    return {
      providers: result.providers,
      modelConfigs: result.modelConfigs,
      modelConfigsSkipped: result.modelConfigsSkipped,
    }
  }

  if (
    obj.kind === AI_STACK_KIND ||
    obj.kind === PROVIDERS_KIND ||
    obj.kind === MODEL_CONFIGS_KIND
  ) {
    const result = applyAiStackPayload(obj)
    if (result.providers === 0 && result.modelConfigs === 0) {
      throw new Error(
        result.modelConfigsSkipped > 0
          ? 'No configs imported — add matching AI providers first.'
          : 'No AI providers or model configs found in file.',
      )
    }
    return {
      providers: result.providers,
      modelConfigs: result.modelConfigs,
      modelConfigsSkipped: result.modelConfigsSkipped,
    }
  }

  throw new Error(
    'Not an AI configuration export (expected onw-ai-providers-and-models).',
  )
}

/** Export all AI player profiles and seating preference. */
export function exportAiPlayers(): void {
  const payload: PlayersExport = {
    kind: PLAYERS_KIND,
    version: EXPORT_VERSION,
    ...buildPlayersPayload(),
  }
  downloadJson(payload, 'onw-ai-players.json')
}

/** Import AI players from JSON; merges by id (adds new profiles when needed). */
export async function importAiPlayersFromFile(file: File): Promise<{
  imported: number
}> {
  const parsed = await readJsonFile(file)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid AI players file.')
  }
  const obj = parsed as {
    kind?: string
    version?: number
    profiles?: AiPlayerProfile[]
    seatedProfileIds?: string[]
    players?: Omit<PlayersExport, 'kind' | 'version'>
  }

  if (obj.kind === ALL_KIND && obj.players) {
    const imported = applyPlayersPayload(obj.players)
    if (imported === 0) {
      throw new Error('No valid AI player profiles found in file.')
    }
    return { imported }
  }

  if (obj.kind !== PLAYERS_KIND || obj.version !== EXPORT_VERSION) {
    throw new Error('Not an AI players export (expected onw-ai-players).')
  }
  if (!Array.isArray(obj.profiles)) {
    throw new Error('AI players export is missing a profiles list.')
  }
  const imported = applyPlayersPayload(obj)
  if (imported === 0) {
    throw new Error('No valid AI player profiles found in file.')
  }
  return { imported }
}

/** Export the human user profile (name, nickname, title, persona, photo). */
export function exportUserProfile(): void {
  const payload: ProfileExport = {
    kind: PROFILE_KIND,
    version: EXPORT_VERSION,
    profile: buildProfilePayload(),
  }
  downloadJson(payload, 'onw-user-profile.json')
}

/** Import the human user profile from JSON (replaces the current profile). */
export async function importUserProfileFromFile(
  file: File,
): Promise<ImportSummary> {
  const parsed = await readJsonFile(file)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid user profile file.')
  }
  const obj = parsed as {
    kind?: string
    version?: number
    profile?: unknown
  }

  if (obj.kind === ALL_KIND && obj.profile) {
    applyProfilePayload(obj.profile)
    return { profile: true }
  }

  if (obj.kind !== PROFILE_KIND || obj.version !== EXPORT_VERSION) {
    throw new Error('Not a user profile export (expected onw-user-profile).')
  }
  if (!obj.profile || typeof obj.profile !== 'object') {
    throw new Error('User profile export is missing profile data.')
  }
  applyProfilePayload(obj.profile)
  return { profile: true }
}

/** Clear the human user profile to empty defaults. */
export function resetUserProfileSettings(): LocalPlayerProfile {
  return resetLocalProfile()
}

/** Export TTS store + browser narrator voice settings. */
export function exportTtsSettings(): void {
  const payload: TtsExport = {
    kind: TTS_KIND,
    version: EXPORT_VERSION,
    ...buildTtsPayload(),
  }
  downloadJson(payload, 'onw-tts-settings.json')
}

/** Import TTS settings (and optional browser voice fields). */
export async function importTtsSettingsFromFile(
  file: File,
): Promise<ImportSummary> {
  const parsed = await readJsonFile(file)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid TTS settings file.')
  }
  const obj = parsed as {
    kind?: string
    version?: number
    tts?: Omit<TtsExport, 'kind' | 'version'>
    voiceURI?: string | null
    browserTtsEnabled?: boolean
  }

  if (obj.kind === ALL_KIND && obj.tts) {
    applyTtsPayload(obj.tts)
    return { tts: true }
  }

  if (obj.kind !== TTS_KIND || obj.version !== EXPORT_VERSION) {
    throw new Error('Not a TTS settings export (expected onw-tts-settings).')
  }
  if (!obj.tts || typeof obj.tts !== 'object') {
    throw new Error('TTS export is missing settings.')
  }
  applyTtsPayload(obj)
  return { tts: true }
}

/** Export everything: AI stack, players, user profile, TTS, and game (timer) settings. */
export function exportAllSettings(): void {
  const payload: AllExport = {
    kind: ALL_KIND,
    version: EXPORT_VERSION,
    ai: buildAiStackPayload(),
    players: buildPlayersPayload(),
    profile: buildProfilePayload(),
    tts: buildTtsPayload(),
    game: loadWerewolfSettings(),
  }
  downloadJson(payload, 'onw-settings-bundle.json')
}

/** Import a full settings bundle (or a known partial export kind). */
export async function importAllSettingsFromFile(
  file: File,
): Promise<ImportSummary> {
  const parsed = await readJsonFile(file)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid settings file.')
  }
  const obj = parsed as {
    kind?: string
    version?: number
    ai?: Parameters<typeof applyAiStackPayload>[0]
    players?: Parameters<typeof applyPlayersPayload>[0]
    profile?: unknown
    tts?: Parameters<typeof applyTtsPayload>[0]
    game?: unknown
  }

  if (obj.version !== EXPORT_VERSION) {
    throw new Error('Unsupported settings export version.')
  }

  // Allow dropping a partial export onto "All".
  if (obj.kind === AI_STACK_KIND || obj.kind === PROVIDERS_KIND || obj.kind === MODEL_CONFIGS_KIND) {
    return importAiStackFromFile(file)
  }
  if (obj.kind === PLAYERS_KIND) {
    const { imported } = await importAiPlayersFromFile(file)
    return { players: imported }
  }
  if (obj.kind === PROFILE_KIND) {
    return importUserProfileFromFile(file)
  }
  if (obj.kind === TTS_KIND) {
    return importTtsSettingsFromFile(file)
  }

  if (obj.kind !== ALL_KIND) {
    throw new Error('Not a settings bundle (expected onw-settings-bundle).')
  }

  const summary: ImportSummary = {}
  if (obj.ai) {
    const ai = applyAiStackPayload(obj.ai)
    summary.providers = ai.providers
    summary.modelConfigs = ai.modelConfigs
    summary.modelConfigsSkipped = ai.modelConfigsSkipped
  }
  if (obj.players) {
    summary.players = applyPlayersPayload(obj.players)
  }
  if (obj.profile) {
    applyProfilePayload(obj.profile)
    summary.profile = true
  }
  if (obj.tts) {
    applyTtsPayload(obj.tts)
    summary.tts = true
  }
  if (obj.game && typeof obj.game === 'object') {
    const next = normalizeWerewolfSettings(
      obj.game as Partial<WerewolfHostSettings>,
    )
    saveWerewolfSettings(next)
    setBrowserTtsVoiceURI(next.voiceURI)
    summary.game = true
  }

  if (
    !summary.providers &&
    !summary.modelConfigs &&
    !summary.players &&
    !summary.profile &&
    !summary.tts &&
    !summary.game
  ) {
    throw new Error('Settings bundle had nothing to import.')
  }
  return summary
}

/** Restore stock Ollama + OmniVoice providers and Chat / Classifier / Voice configs. */
export function resetAiStackSettings(): void {
  resetAiStore()
}

/** Restore the six stock AI player defaults and clear seating. */
export function resetAiPlayersSettings(): void {
  resetAiPlayers()
}

/** Restore TTS store + browser narrator voice fields. */
export function resetTtsSettingsToDefaults(): void {
  resetTtsStore()
  const werewolf = loadWerewolfSettings()
  saveWerewolfSettings({
    ...werewolf,
    voiceURI: null,
    browserTtsEnabled: true,
  })
  setBrowserTtsVoiceURI(null)
}

/** Reset AI stack, players, user profile, TTS, and game settings to built-in defaults. */
export function resetAllSettingsToDefaults(): void {
  resetAiStackSettings()
  resetAiPlayersSettings()
  resetUserProfileSettings()
  resetTtsStore()
  resetWerewolfSettings()
  setBrowserTtsVoiceURI(null)
}
