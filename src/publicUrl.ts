/**
 * Resolve a file under `public/` with Vite's `base` (e.g. `/one-night-ai-werewolf/`
 * on GitHub Pages). Absolute `/…` paths ignore base and 404 on project sites.
 */
export function publicAsset(path: string): string {
  const base = import.meta.env.BASE_URL
  const rel = path.replace(/^\/+/, '')
  return `${base}${rel}`
}

/** Strip Vite base so `/npc/…` checks work on project and user sites. */
export function stripPublicBase(url: string): string {
  const trimmed = url.trim()
  const base = import.meta.env.BASE_URL
  if (base !== '/' && trimmed.startsWith(base)) {
    return `/${trimmed.slice(base.length)}`
  }
  return trimmed
}

/** Bundled NPC still under public/npc/{id}/*.jpg (any Vite base). */
export function isNpcPortraitPath(url: string): boolean {
  const path = stripPublicBase(url).replace(/^\.\//, '/')
  return path.startsWith('/npc/')
}
