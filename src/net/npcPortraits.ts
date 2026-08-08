import { publicAsset } from '../publicUrl'

export type NpcPortraitSet = {
  photoDataUrl: string
}

const SET_IDS = ['01', '02', '03', '04', '05', '06'] as const

export const NPC_PORTRAIT_PACK_COUNT = SET_IDS.length

function portraitUrl(setId: string, file: string): string {
  return publicAsset(`npc/${setId}/${file}`)
}

function buildSet(setId: string): NpcPortraitSet {
  return {
    photoDataUrl: portraitUrl(setId, 'card.jpg'),
  }
}

/** Curated selfie cards for AI / NPC portraits. */
export const NPC_PORTRAIT_SETS: NpcPortraitSet[] = SET_IDS.map(buildSet)

/** Cycle through portrait packs when seeding more NPCs than packs. */
export function npcPortraitForIndex(index: number): NpcPortraitSet {
  const i = ((index % NPC_PORTRAIT_SETS.length) + NPC_PORTRAIT_SETS.length) %
    NPC_PORTRAIT_SETS.length
  return NPC_PORTRAIT_SETS[i]!
}
