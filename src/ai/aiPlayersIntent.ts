import {
  aiTableName,
  portraitForAiProfile,
  type AiPlayerProfile,
} from './aiPlayers'

/** Build wire payload for host.setAiPlayers from local personas. */
export function aiPlayersIntentPayload(profiles: AiPlayerProfile[]) {
  return profiles.map((p) => {
    const portrait = portraitForAiProfile(p)
    return {
      profileId: p.id,
      name: aiTableName(p),
      photoDataUrl: portrait.photoDataUrl,
    }
  })
}
