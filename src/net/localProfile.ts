import { isNpcPortraitPath } from '../publicUrl'

const LEGACY_MULTI_KEY = 'onw:profiles'
const STORAGE_KEY = 'onw:profile'

/** Max JPEG data-URL length kept in localStorage / snapshots (~180KB). */
export const MAX_PHOTO_CHARS = 180_000

/** Match AI player persona field caps in aiPlayers.ts (avoid circular import). */
const MAX_NAME = 40
const MAX_NICKNAME = 24
const MAX_TITLE = 80
const MAX_PERSONA = 600

export { MAX_NAME, MAX_NICKNAME, MAX_PERSONA, MAX_TITLE }

export type LocalPlayerProfile = {
  name: string
  nickname: string
  title: string
  persona: string
  photoDataUrl: string | null
}

const EMPTY: LocalPlayerProfile = {
  name: '',
  nickname: '',
  title: '',
  persona: '',
  photoDataUrl: null,
}

export function clampPhoto(dataUrl: string | null | undefined): string | null {
  if (!dataUrl) return null
  const trimmed = dataUrl.trim()
  if (trimmed.startsWith('data:image/')) {
    if (trimmed.length > MAX_PHOTO_CHARS) return null
    return trimmed
  }
  if (isNpcPortraitPath(trimmed) && trimmed.length < 256) {
    return trimmed
  }
  return null
}

function normalizeName(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().slice(0, MAX_NAME) : ''
}

function normalizeNickname(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().slice(0, MAX_NICKNAME) : ''
}

function normalizeTitle(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().slice(0, MAX_TITLE) : ''
}

function normalizePersona(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().slice(0, MAX_PERSONA) : ''
}

function normalizeProfile(
  raw: Partial<LocalPlayerProfile> | null | undefined,
): LocalPlayerProfile {
  return {
    name: normalizeName(raw?.name),
    nickname: normalizeNickname(raw?.nickname),
    title: normalizeTitle(raw?.title),
    persona: normalizePersona(raw?.persona),
    photoDataUrl: clampPhoto(raw?.photoDataUrl),
  }
}

/** Name used on cards / chat (full name, falling back to nickname). */
export function humanTableName(
  profile: Pick<LocalPlayerProfile, 'name' | 'nickname'>,
): string {
  const name = profile.name.trim()
  if (name) return name
  return profile.nickname.trim() || 'Player'
}

/** Load the local human profile. */
export function loadLocalProfile(): LocalPlayerProfile {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LocalPlayerProfile>
      return normalizeProfile(parsed)
    }
  } catch {
    // fall through to migrate
  }

  // Migrate from the old multi-profile store (active name only).
  try {
    const multi = localStorage.getItem(LEGACY_MULTI_KEY)
    if (multi) {
      const parsed = JSON.parse(multi) as {
        activeId?: string
        profiles?: Record<string, { name?: string }>
      }
      const active =
        (parsed.activeId && parsed.profiles?.[parsed.activeId]) ||
        Object.values(parsed.profiles ?? {})[0]
      const profile = normalizeProfile({ name: active?.name })
      saveLocalProfile(profile)
      localStorage.removeItem(LEGACY_MULTI_KEY)
      return profile
    }
  } catch {
    // ignore
  }

  return { ...EMPTY }
}

/** Persist the local human profile. */
export function saveLocalProfile(profile: LocalPlayerProfile): void {
  try {
    const next = normalizeProfile(profile)
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        name: next.name,
        nickname: next.nickname,
        title: next.title,
        persona: next.persona,
        photoDataUrl: next.photoDataUrl,
      }),
    )
  } catch {
    // Quota / private mode — ignore
  }
}

/** Clear the local human profile to empty defaults. */
export function resetLocalProfile(): LocalPlayerProfile {
  const empty = { ...EMPTY }
  saveLocalProfile(empty)
  return loadLocalProfile()
}

/** Normalize an unknown import blob into a local profile (throws if unusable). */
export function parseImportedLocalProfile(raw: unknown): LocalPlayerProfile {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid profile data.')
  }
  return normalizeProfile(raw as Partial<LocalPlayerProfile>)
}

/**
 * Portrait still matching the player card (aspect-ratio 2 / 3).
 * Cover-cropped from an image file so the snapshot matches the card face.
 */
const PHOTO_W = 512
const PHOTO_H = 768
const PHOTO_QUALITY = 0.82
const PHOTO_QUALITY_MIN = 0.45

/** Encode a cover-cropped canvas as a JPEG that fits {@link MAX_PHOTO_CHARS}. */
function encodeCoverCanvas(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  mirrorX: boolean,
): string | null {
  if (!srcW || !srcH) return null
  const scale = Math.max(PHOTO_W / srcW, PHOTO_H / srcH)
  const sw = Math.round(srcW * scale)
  const sh = Math.round(srcH * scale)
  const canvas = document.createElement('canvas')
  canvas.width = PHOTO_W
  canvas.height = PHOTO_H
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  if (mirrorX) {
    ctx.translate(PHOTO_W, 0)
    ctx.scale(-1, 1)
  }
  ctx.drawImage(source, (PHOTO_W - sw) / 2, (PHOTO_H - sh) / 2, sw, sh)

  for (let q = PHOTO_QUALITY; q >= PHOTO_QUALITY_MIN - 1e-6; q -= 0.06) {
    const dataUrl = canvas.toDataURL('image/jpeg', q)
    const clamped = clampPhoto(dataUrl)
    if (clamped) return clamped
  }
  return null
}

/**
 * Resize + JPEG-compress a user-picked image so it fits the photo budget
 * (~60KB binary / {@link MAX_PHOTO_CHARS} data-URL chars). Cover-crops to the
 * card portrait aspect.
 */
export async function fileToCardPhoto(file: File): Promise<string | null> {
  if (!file.type.startsWith('image/')) return null

  const objectUrl = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('load failed'))
      el.src = objectUrl
    })
    if (!img.naturalWidth || !img.naturalHeight) return null
    return encodeCoverCanvas(img, img.naturalWidth, img.naturalHeight, false)
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
