/**
 * Official One Night Ultimate Werewolf artwork (optimized under src/assets/onw).
 */
import type { WerewolfRole } from './werewolfTypes'

import cardBackUrl from '../assets/onw/cards/back.jpg'
import werewolfCardUrl from '../assets/onw/cards/werewolf.jpg'
import minionCardUrl from '../assets/onw/cards/minion.jpg'
import seerCardUrl from '../assets/onw/cards/seer.jpg'
import robberCardUrl from '../assets/onw/cards/robber.jpg'
import troublemakerCardUrl from '../assets/onw/cards/troublemaker.jpg'
import villagerCardUrl from '../assets/onw/cards/villager.jpg'
import insomniacCardUrl from '../assets/onw/cards/insomniac.jpg'
import masonCardUrl from '../assets/onw/cards/mason.jpg'
import drunkCardUrl from '../assets/onw/cards/drunk.jpg'
import hunterCardUrl from '../assets/onw/cards/hunter.jpg'
import tannerCardUrl from '../assets/onw/cards/tanner.jpg'

import werewolfTokenUrl from '../assets/onw/tokens/werewolf.jpg'
import minionTokenUrl from '../assets/onw/tokens/minion.jpg'
import seerTokenUrl from '../assets/onw/tokens/seer.jpg'
import robberTokenUrl from '../assets/onw/tokens/robber.jpg'
import troublemakerTokenUrl from '../assets/onw/tokens/troublemaker.jpg'
import villagerTokenUrl from '../assets/onw/tokens/villager.jpg'
import insomniacTokenUrl from '../assets/onw/tokens/insomniac.jpg'
import masonTokenUrl from '../assets/onw/tokens/mason.jpg'
import drunkTokenUrl from '../assets/onw/tokens/drunk.jpg'
import hunterTokenUrl from '../assets/onw/tokens/hunter.jpg'
import tannerTokenUrl from '../assets/onw/tokens/tanner.jpg'

import docGettingStartedUrl from '../assets/onw/docs/getting-started.jpg'
import docRulesUrl from '../assets/onw/docs/rules.jpg'
import docRolesUrl from '../assets/onw/docs/roles.jpg'

export const ROLE_CARD_FACE_URL: Record<WerewolfRole, string> = {
  werewolf: werewolfCardUrl,
  minion: minionCardUrl,
  seer: seerCardUrl,
  robber: robberCardUrl,
  troublemaker: troublemakerCardUrl,
  villager: villagerCardUrl,
  insomniac: insomniacCardUrl,
  mason: masonCardUrl,
  drunk: drunkCardUrl,
  hunter: hunterCardUrl,
  tanner: tannerCardUrl,
}

export const ROLE_TOKEN_URL: Record<WerewolfRole, string> = {
  werewolf: werewolfTokenUrl,
  minion: minionTokenUrl,
  seer: seerTokenUrl,
  robber: robberTokenUrl,
  troublemaker: troublemakerTokenUrl,
  villager: villagerTokenUrl,
  insomniac: insomniacTokenUrl,
  mason: masonTokenUrl,
  drunk: drunkTokenUrl,
  hunter: hunterTokenUrl,
  tanner: tannerTokenUrl,
}

export const CARD_BACK_URL = cardBackUrl

export type LobbyDocId = 'getting-started' | 'rules' | 'roles'

export const DOC_ART: Record<
  LobbyDocId,
  { url: string; aspect: number; title: string }
> = {
  'getting-started': {
    url: docGettingStartedUrl,
    // 1546×2047
    aspect: 1546 / 2047,
    title: 'Getting Started',
  },
  rules: {
    url: docRulesUrl,
    // 2047×1357
    aspect: 2047 / 1357,
    title: 'Rules',
  },
  roles: {
    url: docRolesUrl,
    // 2048×896
    aspect: 2048 / 896,
    title: 'Roles',
  },
}
