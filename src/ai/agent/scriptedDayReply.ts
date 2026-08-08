import { roleName } from '../../game/roles'
import { playerWon } from '../../game/werewolfLogic'
import type { SessionSnapshot } from '../../net/protocol'
import type { ClientId } from '../../session/types'
import { aiTableName, type AiPlayerProfile } from '../aiPlayers'
import { getAgentMemory } from './memory'
import { gameKeyOf } from './gameKey'
import { isNearDuplicate } from './spokenText'

/** Cheap aftergame banter when the LLM / GPU is unavailable. */
export function scriptedEndReply(args: {
  snapshot: SessionSnapshot
  npcId: ClientId
  profile: AiPlayerProfile
  humanTranscript?: string
  avoidTexts?: string[]
}): string {
  const { snapshot, npcId, profile, avoidTexts = [] } = args
  const game = snapshot.game
  const won = game ? playerWon(game, npcId) : null
  const role = game?.roles[npcId]
  const roleLabel = role ? roleName(role) : null
  const winMsg = game?.winMessage?.trim()
  const playful =
    /loud|blunt|playful|teas|banter|energetic|joke/i.test(profile.persona)
  const calm = /calm|analyst|quiet|careful/i.test(profile.persona)
  const candidates: string[] = []

  if (won === true) {
    candidates.push(
      playful
        ? `I'll take that win${roleLabel ? ` as ${roleLabel}` : ''}. What a ride.`
        : `We'll take it.${roleLabel ? ` I ended as ${roleLabel}.` : ''} Solid round.`,
      winMsg
        ? calm
          ? `${winMsg} Glad that landed our way.`
          : `Yep — ${winMsg}`
        : `Victory feels good. Rematch?`,
    )
  } else if (won === false) {
    candidates.push(
      playful
        ? `Oof. Respect to the winners${roleLabel ? ` — I was ${roleLabel}` : ''}. Rematch?`
        : `Tough loss.${roleLabel ? ` I was ${roleLabel}.` : ''} Rematch whenever.`,
      calm
        ? `Fair result. I want another look at that night.`
        : `We got cooked. Let's run it back.`,
    )
  } else {
    candidates.push(
      playful
        ? `Alright, cards up — let's see who was lying.`
        : `Reveal time. Curious how night actually played out.`,
    )
  }

  candidates.push(
    `Fun round. ${args.humanTranscript?.trim() ? 'What stood out to you?' : 'Who surprised you most?'}`,
  )

  for (const line of candidates) {
    if (avoidTexts.some((a) => isNearDuplicate(line, a))) continue
    return line
  }
  return won
    ? `Nice win. I'm ${aiTableName(profile)}.`
    : `I'm ${aiTableName(profile)}. Rematch?`
}

/** Cheap table talk when the LLM / GPU is unavailable. */
export function scriptedDayReply(args: {
  snapshot: SessionSnapshot
  npcId: ClientId
  profile: AiPlayerProfile
  humanTranscript: string
  humanFromId?: ClientId | null
  avoidTexts?: string[]
}): string {
  if (args.snapshot.game?.phase === 'reveal') {
    return scriptedEndReply(args)
  }
  if (args.snapshot.phase === 'lobby') {
    return scriptedLobbyReply(args)
  }
  const {
    snapshot,
    npcId,
    profile,
    humanTranscript,
    humanFromId = null,
    avoidTexts = [],
  } = args
  const seated = new Set(
    snapshot.game?.playerIds ??
      snapshot.players.filter((p) => p.connected).map((p) => p.id),
  )
  const others = snapshot.players
    .filter((p) => p.id !== npcId && seated.has(p.id))
    .map((p) => p.name)
  const human =
    (humanFromId
      ? snapshot.players.find((p) => p.id === humanFromId)?.name
      : null) ??
    snapshot.players.find((p) => !p.isNpc)?.name ??
    others[0] ??
    'friend'
  const target =
    others.find((n) =>
      humanTranscript.toLowerCase().includes(n.toLowerCase()),
    ) ?? others.find((n) => n !== human) ?? others[0] ?? 'someone'
  const claim =
    getAgentMemory(gameKeyOf(snapshot), npcId).lastPlan?.claim ?? 'Villager'
  const t = humanTranscript.toLowerCase()
  const playful =
    /loud|blunt|playful|teas|banter|energetic|joke/i.test(profile.persona)
  const calm = /calm|analyst|quiet|careful/i.test(profile.persona)

  const candidates: string[] = []

  if (/\bi\s+vote\s+for\b|\bi(?:'m| am)\s+casting\s+a\s+no\s+vote\b/i.test(t)) {
    const me = aiTableName(profile).toLowerCase()
    const nick = profile.nickname.trim().toLowerCase()
    const votedSelf =
      t.includes(me) || (Boolean(nick) && t.includes(nick))
    candidates.push(
      votedSelf
        ? playful
          ? `${human}, bold pick. Make your case before everyone piles on.`
          : `${human}, noted. Why me over ${target}?`
        : playful
          ? `${human} locking in ${target}? Interesting. I'm not sold yet.`
          : `Vote on ${target} from ${human}. Anyone else leaning that way?`,
    )
  }

  if (/\bwho is everyone\b|\bwho'?s here\b|\bintroduc/i.test(t)) {
    candidates.push(
      playful
        ? `I'm ${aiTableName(profile)}. Let's hear claims — starting with you, ${human}?`
        : `I'm ${aiTableName(profile)}. Let's hear everyone's claims before we jump.`,
    )
  }

  if (
    /\bwhat (were|are) you\b|\bwhat you were\b|\bwhat you are\b|\byour role\b|\bwhat'?s your role\b|\bwho (were|are) you\b|\bsaid what you were\b|\btell me what you\b/i.test(
      t,
    ) ||
    (t.includes(aiTableName(profile).toLowerCase()) &&
      /\bwhat\b|\bsay\b|\bclaim\b|\brole\b|\byou were\b/i.test(t)) ||
    (Boolean(profile.nickname.trim()) &&
      t.includes(profile.nickname.trim().toLowerCase()) &&
      /\bwhat\b|\bsay\b|\bclaim\b|\brole\b|\byou were\b/i.test(t))
  ) {
    candidates.push(
      calm
        ? `${human}, I'd claim ${claim}. What makes you ask?`
        : `I'd say ${claim}. ${target}, what about you?`,
    )
  }

  if (/\bi(?:'m| am) (?:a |the )?(villager|werewolf|seer|robber)/i.test(t)) {
    candidates.push(
      playful
        ? `Cute claim, ${human}. ${target}, want to jump in?`
        : `Noted, ${human}. ${target}, can you walk us through your night?`,
    )
  }

  if (/\b(wolf|werewolf|sus|suspicious|liar|lying)\b/i.test(t)) {
    candidates.push(
      playful
        ? `${target}'s story has a few holes — let's poke it gently.`
        : `If we're naming names, I want a clearer read on ${target}.`,
    )
  }

  if (t.length <= 2 || t === '?' || t === 'hello?' || t === 'hello') {
    candidates.push(
      calm
        ? `Still here, ${human}. What do you want to know?`
        : `Hey ${human} — who's got a claim for us?`,
    )
  }

  candidates.push(
    playful
      ? `${human}, you're dancing a little. ${target}, anything fun to add?`
      : `${human}, I'm listening. ${target}, anything to add before we vote?`,
    `I'm on ${claim}. ${target}, help me trust you here.`,
  )

  for (const line of candidates) {
    if (avoidTexts.some((a) => isNearDuplicate(line, a))) continue
    return line
  }
  return `I'm ${aiTableName(profile)}. ${claim} claim — your move, ${human}.`
}

/** Cheap lobby warm-up banter when the LLM / GPU is unavailable. */
function scriptedLobbyReply(args: {
  snapshot: SessionSnapshot
  npcId: ClientId
  profile: AiPlayerProfile
  humanTranscript: string
  humanFromId?: ClientId | null
  avoidTexts?: string[]
}): string {
  const {
    snapshot,
    npcId,
    profile,
    humanTranscript,
    humanFromId = null,
    avoidTexts = [],
  } = args
  const otherAis = snapshot.players.filter(
    (p) => p.id !== npcId && p.connected && p.isNpc,
  )
  const otherAiNames = otherAis.map((p) => p.name)
  const others = snapshot.players
    .filter((p) => p.id !== npcId && p.connected)
    .map((p) => p.name)
  const recent = (snapshot.chatLines ?? []).filter((l) => l.fromId !== npcId)
  const last = recent[recent.length - 1]
  const chatEmpty = !(snapshot.chatLines ?? []).some((l) => l.text.trim())
  const metaSpeak =
    /you were asked to speak|speak up in lobby|empty lobby|based on recent/i.test(
      humanTranscript,
    )
  const focusText = metaSpeak && last ? last.text : humanTranscript
  const focusName =
    metaSpeak && last
      ? last.name
      : (humanFromId
          ? snapshot.players.find((p) => p.id === humanFromId)?.name
          : null) ??
        otherAiNames[0] ??
        others[0] ??
        'friend'
  const human = focusName
  const target =
    otherAiNames.find((n) =>
      focusText.toLowerCase().includes(n.toLowerCase()),
    ) ??
    otherAiNames.find((n) => n !== human) ??
    otherAiNames[0] ??
    others.find((n) => n !== human) ??
    others[0] ??
    'someone'
  const t = focusText.toLowerCase()
  const playful =
    /loud|blunt|playful|teas|banter|energetic|joke|humor|spotlight|roast/i.test(
      profile.persona,
    )
  const calm = /calm|analyst|quiet|careful|chill|laid-back|dry/i.test(
    profile.persona,
  )

  const candidates: string[] = []

  if (metaSpeak && chatEmpty) {
    candidates.push(
      playful
        ? `Alright — One Night Ultimate Werewolf, cards soon. ${target}, you already look like trouble.`
        : `Welcome in — One Night Ultimate Werewolf warm-up. ${target}, you ready to scheme already?`,
      calm
        ? `Lobby's open for One Night Ultimate Werewolf. ${target}, don't act innocent yet.`
        : `Gather up — One Night Ultimate Werewolf night is coming. ${target}, wipe that grin off.`,
    )
  }

  if (metaSpeak && last) {
    const lastIsAi = otherAis.some((p) => p.id === last.fromId)
    const clapTarget =
      lastIsAi && last.name !== aiTableName(profile)
        ? last.name
        : target
    candidates.push(
      playful
        ? `${clapTarget}, I'm picking that up — and ${target === clapTarget ? 'the whole table' : target} looks a little too amused.`
        : `${clapTarget}, fair point. ${target === clapTarget ? 'Anyone else' : target}, you jumping in on that?`,
      calm
        ? `Following ${clapTarget}'s thread — ${target}, what's your take?`
        : `${clapTarget} said it. ${target}, don't pretend you weren't already plotting a reply.`,
    )
  }

  if (/\brules?\b|\bseer\b|\brobber\b|\btroublemaker\b|\bminion\b/i.test(t)) {
    candidates.push(
      playful
        ? `Rules, sure — but first, ${target}, why do you look like you're already scheming?`
        : `Happy to do a quick rules check. ${target}, you good on night order?`,
    )
  }

  if (/\bready\b|\bstart\b|\blet'?s (go|play|start)\b|\bdeal\b/i.test(t)) {
    candidates.push(
      playful
        ? `Deal time soon. ${target}, wipe that sneaky grin off before night starts.`
        : `I'm ready. ${target}, you feeling lucky or cursed?`,
    )
  }

  if (
    /\bscheme|plot|innocent|trust me|sneaky|guilty|poker|energy|roast|joke/i.test(
      t,
    )
  ) {
    candidates.push(
      playful
        ? `${human}, bold. ${target}, defend yourself — or confess the bit.`
        : `${human} called it. ${target}, you going to own that or clap back?`,
    )
  }

  if (t.length <= 2 || /\bhello\b|\bhey\b|\bhi\b|\bwhat'?s up\b/i.test(t)) {
    candidates.push(
      calm
        ? `Hey table. ${target} already has that fake-innocent look going.`
        : `Hey! ${target}, don't act innocent — we remember how sneaky you get.`,
    )
  }

  candidates.push(
    playful
      ? `${target}, that "trust me" energy is already ridiculous — own it.`
      : `${target}'s overselling the chill act. Anyone else seeing this?`,
    calm
      ? `Warm-up: ${target} always thinks they're unreadable. Prove me wrong tonight.`
      : `${target}, you've got that scheming lobby energy already.`,
  )

  for (const line of candidates) {
    if (avoidTexts.some((a) => isNearDuplicate(line, a))) continue
    return line
  }
  return `One Night Ultimate Werewolf warm-up — ${target}, you're looking too innocent already.`
}
