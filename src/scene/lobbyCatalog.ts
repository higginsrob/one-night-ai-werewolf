import type { LobbyDocId } from '../game/onwArt'

export type LobbyVisual = 'document'

export type LobbyCatalogEntry = {
  id: LobbyDocId
  title: string
  description: string
  visual: LobbyVisual
  /** World position on the lobby table. */
  position: [number, number, number]
  /** Yaw rotation in radians. */
  rotationY?: number
  playable: boolean
}

/** Props on the lobby table — rule documents (characters live as RoleCard meshes). */
const CATALOG: LobbyCatalogEntry[] = [
  {
    id: 'getting-started',
    title: 'Getting Started',
    description: 'Quick overview of how to play.',
    visual: 'document',
    position: [-0.42, 0.7, 1.42],
    rotationY: -0.12,
    playable: false,
  },
  {
    id: 'rules',
    title: 'Rules',
    description: 'Setup, night, day, and winning.',
    visual: 'document',
    position: [0.08, 0.7, 1.5],
    rotationY: 0.04,
    playable: false,
  },
  {
    id: 'roles',
    title: 'Roles',
    description: 'Every character ability and night script.',
    visual: 'document',
    position: [0.58, 0.7, 1.4],
    rotationY: 0.18,
    playable: false,
  },
]

export function listLobbyCatalog(): LobbyCatalogEntry[] {
  return CATALOG
}

export function getLobbyCatalogEntry(
  id: string | null | undefined,
): LobbyCatalogEntry | null {
  if (!id) return null
  return listLobbyCatalog().find((e) => e.id === id) ?? null
}

export function isLobbyDocId(id: string): id is LobbyDocId {
  return id === 'getting-started' || id === 'rules' || id === 'roles'
}
