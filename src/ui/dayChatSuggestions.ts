import { ROLE_INFO, roleName } from '../game/roles'
import type { WerewolfRole } from '../game/werewolfTypes'

/**
 * Pregenerated table-talk lines for the day chat Suggest control.
 *
 * Tuned for this app's AI day agents (see DAY_RULES / scriptedDayReply):
 * - Opening claim rounds and "what were you?" force clear public claims.
 * - Named interviews ("{name}, …") get better directed replies than vague heat.
 * - Night-result questions (peek / rob / swap pair) fill the public claim board.
 * - Soft conflict probes beat hard "you're the wolf" accusations.
 * - Deception stays on village cover claims — never "I'm the werewolf/tanner."
 */

export type SuggestionPhase = 'lobby' | 'day' | 'aftergame'

export type SuggestionGroup =
  | 'interview'
  | 'deception'
  | 'lobby'
  | 'aftergame'
  | WerewolfRole

export type ChatSuggestion = {
  id: string
  /** Short dropdown label. */
  label: string
  /**
   * Inserted into the compose draft.
   * Placeholders: `{name}` / `{name2}` = other seated players (filled on select).
   */
  text: string
  group: SuggestionGroup
  phases: SuggestionPhase[]
}

const DAY: SuggestionPhase[] = ['day']
const LOBBY: SuggestionPhase[] = ['lobby']
const AFTER: SuggestionPhase[] = ['aftergame']
const DAY_AFTER: SuggestionPhase[] = ['day', 'aftergame']

/** Shared interview / structure lines — highest leverage with the AI table. */
const INTERVIEW: ChatSuggestion[] = [
  {
    id: 'int-round',
    label: 'Open claim round',
    text: "Let's hear claims — what did everyone wake as?",
    group: 'interview',
    phases: DAY,
  },
  {
    id: 'int-you',
    label: 'Ask {name} their role',
    text: '{name}, what were you?',
    group: 'interview',
    phases: DAY,
  },
  {
    id: 'int-night',
    label: 'Ask {name} night story',
    text: '{name}, walk us through your night.',
    group: 'interview',
    phases: DAY,
  },
  {
    id: 'int-seer',
    label: 'Ask Seer peek',
    text: 'Anyone claiming Seer — who or what did you look at?',
    group: 'interview',
    phases: DAY,
  },
  {
    id: 'int-robber',
    label: 'Ask Robber result',
    text: 'If you robbed someone, who did you take and what did you become?',
    group: 'interview',
    phases: DAY,
  },
  {
    id: 'int-tm',
    label: 'Ask Troublemaker swaps',
    text: 'Troublemaker — name the two people you swapped.',
    group: 'interview',
    phases: DAY,
  },
  {
    id: 'int-mason',
    label: 'Ask Mason partner',
    text: 'Masons, did you find each other?',
    group: 'interview',
    phases: DAY,
  },
  {
    id: 'int-insomniac',
    label: 'Ask Insomniac check',
    text: 'Insomniac, was your card still Insomniac at dawn?',
    group: 'interview',
    phases: DAY,
  },
  {
    id: 'int-drunk',
    label: 'Ask Drunk',
    text: 'Drunk, which center card did you take — and you still have no idea what you are, right?',
    group: 'interview',
    phases: DAY,
  },
  {
    id: 'int-conflict-seer',
    label: 'Probe double Seer',
    text: 'Two Seer claims — both of you, say exactly what you saw so we can compare.',
    group: 'interview',
    phases: DAY,
  },
  {
    id: 'int-conflict-tm',
    label: 'Probe Troublemaker story',
    text: '{name}, if you were Troublemaker, who are the two people you swapped?',
    group: 'interview',
    phases: DAY,
  },
  {
    id: 'int-deck',
    label: 'Deck accounting',
    text: "Let's check the deck counts — whose claims can't both be true?",
    group: 'interview',
    phases: DAY,
  },
  {
    id: 'int-soft',
    label: 'Soft doubt {name}',
    text: "{name}, I'm not accusing yet — can you tighten up that night story?",
    group: 'interview',
    phases: DAY,
  },
  {
    id: 'int-clear',
    label: 'Clear a matching claim',
    text: "That matches what I heard — I'm inclined to clear {name} and look elsewhere.",
    group: 'interview',
    phases: DAY,
  },
  {
    id: 'int-vote',
    label: 'Lean vote {name}',
    text: "I'm leaning toward voting {name} unless someone has a cleaner story.",
    group: 'interview',
    phases: DAY,
  },
  {
    id: 'int-novote',
    label: 'Argue no-kill',
    text: 'If both wolves are in the center, we should no-kill. Does anyone have proof a wolf is still seated?',
    group: 'interview',
    phases: DAY,
  },
]

/** Truthful / soft-claim intros per role (player fills night details as needed). */
const BY_ROLE: Record<WerewolfRole, ChatSuggestion[]> = {
  villager: [
    {
      id: 'vil-claim',
      label: 'Claim Villager',
      text: "I'm a Villager — no night action. Let's hear the info roles.",
      group: 'villager',
      phases: DAY,
    },
    {
      id: 'vil-ask',
      label: 'Villager pushes claims',
      text: "I'm Villager. {name}, start us off — what did you wake as?",
      group: 'villager',
      phases: DAY,
    },
  ],
  hunter: [
    {
      id: 'hun-claim',
      label: 'Claim Hunter',
      text: "I'm the Hunter. No night info — but if I die, I take someone with me.",
      group: 'hunter',
      phases: DAY,
    },
    {
      id: 'hun-ask',
      label: 'Hunter asks night',
      text: "Hunter here. {name}, what's your night story?",
      group: 'hunter',
      phases: DAY,
    },
  ],
  seer: [
    {
      id: 'seer-claim',
      label: 'Claim Seer',
      text: "I'm the Seer.",
      group: 'seer',
      phases: DAY,
    },
    {
      id: 'seer-player',
      label: 'Seer peeked a player',
      text: "I'm the Seer. I looked at {name}'s card.",
      group: 'seer',
      phases: DAY,
    },
    {
      id: 'seer-center',
      label: 'Seer peeked center',
      text: "I'm the Seer. I looked at two center cards.",
      group: 'seer',
      phases: DAY,
    },
    {
      id: 'seer-wolf',
      label: 'Seer soft-presses wolf peek',
      text: "I'm the Seer, and I saw a werewolf on {name}. Talk me out of voting them.",
      group: 'seer',
      phases: DAY,
    },
    {
      id: 'seer-confirm',
      label: 'Seer confirms a claim',
      text: "I'm the Seer — I peeked {name} and it matches their claim. I'm clearing them.",
      group: 'seer',
      phases: DAY,
    },
  ],
  robber: [
    {
      id: 'rob-claim',
      label: 'Claim Robber',
      text: "I'm the Robber.",
      group: 'robber',
      phases: DAY,
    },
    {
      id: 'rob-took',
      label: 'Robber names steal',
      text: "I'm the Robber. I swapped with {name} and looked at my new card.",
      group: 'robber',
      phases: DAY,
    },
    {
      id: 'rob-became',
      label: 'Robber shares new role',
      text: "I'm the Robber. I took {name}'s card and became a village role.",
      group: 'robber',
      phases: DAY,
    },
    {
      id: 'rob-noswap',
      label: 'Robber stayed put',
      text: "I'm the Robber, and I didn't swap with anyone.",
      group: 'robber',
      phases: DAY,
    },
  ],
  troublemaker: [
    {
      id: 'tm-claim',
      label: 'Claim Troublemaker',
      text: "I'm the Troublemaker.",
      group: 'troublemaker',
      phases: DAY,
    },
    {
      id: 'tm-swap',
      label: 'TM names both swaps',
      text: "I'm the Troublemaker. I swapped {name} and {name2}.",
      group: 'troublemaker',
      phases: DAY,
    },
    {
      id: 'tm-noswap',
      label: 'TM did not swap',
      text: "I'm the Troublemaker, and I didn't swap anyone.",
      group: 'troublemaker',
      phases: DAY,
    },
    {
      id: 'tm-wolf-moved',
      label: 'TM redirects wolf vote',
      text: "I'm Troublemaker — I swapped {name} and {name2}. If a wolf was on one of them at night, vote the other.",
      group: 'troublemaker',
      phases: DAY,
    },
  ],
  mason: [
    {
      id: 'mas-claim',
      label: 'Claim Mason',
      text: "I'm a Mason.",
      group: 'mason',
      phases: DAY,
    },
    {
      id: 'mas-partner',
      label: 'Mason names partner',
      text: "I'm a Mason — I woke with {name}. They're village.",
      group: 'mason',
      phases: DAY,
    },
    {
      id: 'mas-lone',
      label: 'Lone Mason',
      text: "I'm a Mason, and I didn't see another Mason. The other may be in the center.",
      group: 'mason',
      phases: DAY,
    },
  ],
  insomniac: [
    {
      id: 'ins-claim',
      label: 'Claim Insomniac',
      text: "I'm the Insomniac.",
      group: 'insomniac',
      phases: DAY,
    },
    {
      id: 'ins-same',
      label: 'Still Insomniac',
      text: "I'm the Insomniac — I checked at dawn and I'm still Insomniac.",
      group: 'insomniac',
      phases: DAY,
    },
    {
      id: 'ins-changed',
      label: 'Card changed',
      text: "I'm the Insomniac — my card changed overnight. I am not Insomniac anymore.",
      group: 'insomniac',
      phases: DAY,
    },
  ],
  drunk: [
    {
      id: 'dru-claim',
      label: 'Claim Drunk',
      text: "I'm the Drunk. I swapped with a center card and I have no idea what I am now.",
      group: 'drunk',
      phases: DAY,
    },
    {
      id: 'dru-ask',
      label: 'Drunk asks for help',
      text: "Drunk here — unknown role. {name}, give us a real night result so we can find a wolf.",
      group: 'drunk',
      phases: DAY,
    },
  ],
  werewolf: [
    {
      id: 'ww-pack',
      label: 'WW asks open claims',
      text: "Let's not rush. Everyone claim — {name}, what did you wake as?",
      group: 'werewolf',
      phases: DAY,
    },
    {
      id: 'ww-deflect',
      label: 'WW soft redirect',
      text: "{name}'s story is the one I want to hear again before we lock a vote.",
      group: 'werewolf',
      phases: DAY,
    },
  ],
  minion: [
    {
      id: 'min-steer',
      label: 'Minion steers talk',
      text: "I'm listening. {name}, claim cleanly — role and night result.",
      group: 'minion',
      phases: DAY,
    },
    {
      id: 'min-heat',
      label: 'Minion moves heat',
      text: "I'm not sold on {name} yet. Can someone else share a night peek or swap?",
      group: 'minion',
      phases: DAY,
    },
  ],
  tanner: [
    {
      id: 'tan-nervous',
      label: 'Tanner clumsy Villager',
      text: "I'm… a Villager. Yeah. No night stuff. Why is everyone looking at me?",
      group: 'tanner',
      phases: DAY,
    },
    {
      id: 'tan-hedge',
      label: 'Tanner hedges',
      text: "Villager, I think? Wait — do Villagers wake up? Anyway, {name} seems off to me.",
      group: 'tanner',
      phases: DAY,
    },
  ],
}

/**
 * Cover claims and misleading night stories.
 * Aligns with app coaching: wolves/tanner never confess; fake info roles are fair game.
 */
const DECEPTION: ChatSuggestion[] = [
  {
    id: 'dec-vil',
    label: 'Cover as Villager',
    text: "I'm a Villager — nothing happened for me at night.",
    group: 'deception',
    phases: DAY,
  },
  {
    id: 'dec-hunter',
    label: 'Cover as Hunter',
    text: "I'm the Hunter. No peek, but don't vote me unless you're ready for my revenge pick.",
    group: 'deception',
    phases: DAY,
  },
  {
    id: 'dec-seer-center',
    label: 'Fake Seer (center)',
    text: "I'm the Seer. I checked two center cards — no werewolf there.",
    group: 'deception',
    phases: DAY,
  },
  {
    id: 'dec-seer-player',
    label: 'Fake Seer (player)',
    text: "I'm the Seer. I looked at {name} and saw a village role.",
    group: 'deception',
    phases: DAY,
  },
  {
    id: 'dec-robber',
    label: 'Fake Robber steal',
    text: "I'm the Robber. I took {name}'s card and got a Villager.",
    group: 'deception',
    phases: DAY,
  },
  {
    id: 'dec-tm',
    label: 'Fake Troublemaker swap',
    text: "I'm the Troublemaker. I swapped {name} and {name2}.",
    group: 'deception',
    phases: DAY,
  },
  {
    id: 'dec-mason',
    label: 'Fake Mason pair',
    text: "I'm a Mason — woke with {name}.",
    group: 'deception',
    phases: DAY,
  },
  {
    id: 'dec-insomniac',
    label: 'Fake Insomniac same',
    text: "I'm the Insomniac. Checked at dawn — still Insomniac.",
    group: 'deception',
    phases: DAY,
  },
  {
    id: 'dec-drunk',
    label: 'Fake Drunk',
    text: "I'm the Drunk. Swapped with the center — I genuinely don't know what I am.",
    group: 'deception',
    phases: DAY,
  },
  {
    id: 'dec-minion-as-seer',
    label: 'Minion-style fake info',
    text: "I know who the wolves are… wait, I mean — I'm Seer, and I saw something useful on {name}.",
    group: 'deception',
    phases: DAY,
  },
  {
    id: 'dec-protect',
    label: 'Protect ally softly',
    text: "{name} has been consistent so far. I'd rather pressure someone with a thinner story.",
    group: 'deception',
    phases: DAY,
  },
  {
    id: 'dec-frame',
    label: 'Frame with soft heat',
    text: "{name}, that claim doesn't line up with the deck for me. Can you explain it again?",
    group: 'deception',
    phases: DAY,
  },
]

const LOBBY_LINES: ChatSuggestion[] = [
  {
    id: 'lob-hi',
    label: 'Greet the table',
    text: 'Hey everyone — someone already looks too innocent and we have not even dealt.',
    group: 'lobby',
    phases: LOBBY,
  },
  {
    id: 'lob-rules',
    label: 'Ask a rules check',
    text: 'Quick rules check — Seer goes before Robber and Troublemaker, right?',
    group: 'lobby',
    phases: LOBBY,
  },
  {
    id: 'lob-hype',
    label: 'Hype the game',
    text: "Alright, who brought the fake 'trust me' energy tonight?",
    group: 'lobby',
    phases: LOBBY,
  },
  {
    id: 'lob-name',
    label: 'Banter with {name}',
    text: "{name}, you look like you're already plotting. Spill — what's the scheme?",
    group: 'lobby',
    phases: LOBBY,
  },
]

const AFTERGAME: ChatSuggestion[] = [
  {
    id: 'ag-truth',
    label: 'Admit your role',
    text: 'Alright, cards up — I was honestly…',
    group: 'aftergame',
    phases: AFTER,
  },
  {
    id: 'ag-ask',
    label: 'Ask who lied',
    text: '{name}, when did you decide to lie?',
    group: 'aftergame',
    phases: DAY_AFTER,
  },
  {
    id: 'ag-rematch',
    label: 'Call rematch',
    text: 'Fun round. Rematch?',
    group: 'aftergame',
    phases: AFTER,
  },
  {
    id: 'ag-surprise',
    label: 'Who surprised you',
    text: 'Who surprised you most that round?',
    group: 'aftergame',
    phases: AFTER,
  },
]

const ROLE_ORDER: WerewolfRole[] = [
  'villager',
  'seer',
  'robber',
  'troublemaker',
  'mason',
  'insomniac',
  'drunk',
  'hunter',
  'werewolf',
  'minion',
  'tanner',
]

export const ALL_CHAT_SUGGESTIONS: ChatSuggestion[] = [
  ...INTERVIEW,
  ...ROLE_ORDER.flatMap((r) => BY_ROLE[r]),
  ...DECEPTION,
  ...LOBBY_LINES,
  ...AFTERGAME,
]

export function suggestionGroupLabel(group: SuggestionGroup): string {
  if (group === 'interview') return 'Interview'
  if (group === 'deception') return 'Deception'
  if (group === 'lobby') return 'Lobby'
  if (group === 'aftergame') return 'Aftergame'
  return roleName(group)
}

export function suggestionsForPhase(
  phase: SuggestionPhase,
  rolesInDeck?: Iterable<WerewolfRole> | null,
): ChatSuggestion[] {
  const deck = rolesInDeck ? new Set(rolesInDeck) : null
  return ALL_CHAT_SUGGESTIONS.filter((s) => {
    if (!s.phases.includes(phase)) return false
    if (!deck) return true
    if (s.group === 'interview' || s.group === 'deception') return true
    if (s.group === 'lobby' || s.group === 'aftergame') return true
    // Hide role claim groups not in this round's hand (werewolf/minion/tanner still useful for deception via Deception group).
    if (s.group in ROLE_INFO) {
      const role = s.group as WerewolfRole
      if (role === 'werewolf' || role === 'minion' || role === 'tanner') {
        return deck.has(role)
      }
      return deck.has(role)
    }
    return true
  })
}

/** Group suggestions for <optgroup> rendering, preserving catalog order. */
export function groupSuggestions(
  list: ChatSuggestion[],
): Array<{ group: SuggestionGroup; label: string; items: ChatSuggestion[] }> {
  const order: SuggestionGroup[] = [
    'interview',
    ...ROLE_ORDER,
    'deception',
    'lobby',
    'aftergame',
  ]
  const byGroup = new Map<SuggestionGroup, ChatSuggestion[]>()
  for (const s of list) {
    const arr = byGroup.get(s.group) ?? []
    arr.push(s)
    byGroup.set(s.group, arr)
  }
  return order
    .filter((g) => (byGroup.get(g)?.length ?? 0) > 0)
    .map((group) => ({
      group,
      label: suggestionGroupLabel(group),
      items: byGroup.get(group)!,
    }))
}

/** Fill {name}/{name2} from other seated players (prefer NPCs first). */
export function fillSuggestionPlaceholders(
  text: string,
  otherNames: string[],
): string {
  const names = otherNames.map((n) => n.trim()).filter(Boolean)
  const a = names[0] ?? 'someone'
  const b = names.find((n) => n !== a) ?? names[1] ?? 'someone else'
  return text.replaceAll('{name2}', b).replaceAll('{name}', a)
}
