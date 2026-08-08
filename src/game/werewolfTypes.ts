export type WerewolfRole =
  | 'werewolf'
  | 'minion'
  | 'seer'
  | 'robber'
  | 'troublemaker'
  | 'villager'
  | 'insomniac'
  | 'mason'
  | 'drunk'
  | 'hunter'
  | 'tanner'

/** Sentinel vote target: player chose not to vote for anyone. */
export const NO_VOTE_TARGET = '__no_vote__'

export type WerewolfPhase =
  | 'claiming'
  | 'night'
  | 'dawn'
  | 'day'
  | 'reveal'

/** Sub-stages while `phase === 'reveal'`. */
export type RevealStage = 'nightPlayback' | 'hunter' | 'result'

/** Ordered night narration / action steps. */
export type NightStep =
  | 'intro'
  | 'werewolves'
  | 'minion'
  | 'masons'
  | 'seer'
  | 'robber'
  | 'troublemaker'
  | 'drunk'
  | 'insomniac'
  | 'outro'
  /** Narrator-off: everyone who needs a pick acts in one shared window. */
  | 'simultaneous'

export type SeerView =
  | { kind: 'player'; targetId: string; role: WerewolfRole }
  | { kind: 'center'; indexes: [number, number]; roles: [WerewolfRole, WerewolfRole] }

export type WerewolfNightActions = {
  /** Players who finished intro / role / outro ack. */
  acknowledged: string[]
  /** Lone werewolf who peeked a center card. */
  werewolfPeek?: { playerId: string; centerIndex: number; role: WerewolfRole }
  seer?: { playerId: string; view: SeerView }
  robber?: { playerId: string; targetId: string; stolenRole: WerewolfRole }
  troublemaker?: { playerId: string; a: string; b: string }
  drunk?: { playerId: string; centerIndex: number }
}

/** Face-down role card on the table during claim (and retained for reference). */
export type TableCard = {
  id: string
  role: WerewolfRole
  claimBy: string | null
}

export type WerewolfSnapshot = {
  gameId: 'werewolf'
  phase: WerewolfPhase
  /** Stable order of players dealt into this round. */
  playerIds: string[]
  /** Display names frozen at deal time (scene has no live roster). */
  playerNames: Record<string, string>
  /** Composed role set for this round (before shuffle order). */
  roleDeck: WerewolfRole[]
  /** Shuffled table cards; claimBy set during claiming. */
  cards: TableCard[]
  /** Seed for deterministic claim-phase scatter layout. */
  layoutSeed: number
  /** Roles as currently held (after night swaps). Empty during claiming. */
  roles: Record<string, WerewolfRole>
  /** Roles claimed at the start of night (before swaps). */
  dealtRoles: Record<string, WerewolfRole>
  /** Three middle cards (mutable during night). Empty during claiming. */
  center: WerewolfRole[]
  dealtCenter: WerewolfRole[]
  nightStep: NightStep
  nightActions: WerewolfNightActions
  /**
   * When true, night collects intents in one shared window after intro
   * (single-player: human wake + silent AI acts), then swaps apply in order.
   */
  simultaneousNight: boolean
  /**
   * Watch-game spectator omniscience: after night resolves, play a public
   * action recap (dawn) before day discussion. Always true in watch mode.
   */
  godMode: boolean
  /**
   * Wall-clock ms when the current role’s act window ends.
   * Null while the narrator is still waking that role (or on intro/outro).
   */
  nightStepEndsAt: number | null
  /**
   * After the act window expires once with a missing AI/human pick, we grant
   * one grace extension before forcing a deterministic fallback.
   */
  nightActGraceUsed: boolean
  /** Host paused night (timer + narration frozen). */
  nightPaused: boolean
  /** Remaining act-window ms captured when night was paused (null if mid-wake). */
  nightPauseRemainingMs: number | null
  /** Bumped on resume so the host narrator can re-speak a cut wake line. */
  nightResumeAt: number
  /** Act window length after each wake line (ms). */
  nightActMs: number
  /** Wall-clock ms when day discussion/voting ends (null outside day). */
  dayEndsAt: number | null
  /** Day discussion/voting length (ms). */
  dayDurationMs: number
  /**
   * voterId → targetId.
   * Target may be {@link NO_VOTE_TARGET} when the voter abstains.
   */
  votes: Record<string, string>
  /** Players eliminated by the vote (ties kill all tied for most). */
  killedIds: string[]
  /** Hunter may kill a second player when they die. */
  hunterKillId: string | null
  /** Reveal sub-stage (null outside reveal). */
  revealStage: RevealStage | null
  /**
   * Wall-clock ms when dawn or nightPlayback sequence started.
   * Clients derive the current beat from this + beat duration.
   * For god-mode dawn, also bumped when `playbackBeatIndex` advances.
   */
  playbackStartedAt: number | null
  /**
   * Per-beat duration for the active dawn / nightPlayback sequence.
   * Null outside playback.
   */
  playbackBeatMs: number | null
  /**
   * Host-advanced beat index for speech-synced playback (god-mode dawn and
   * post-vote night recap). Null when using wall-clock dawn only.
   */
  playbackBeatIndex: number | null
  /**
   * Legacy flag: previously forced a house-rule village win on day timeout.
   * Kept on the snapshot for wire/export compat; always false — official
   * no-kill win conditions apply instead.
   */
  timeoutVillageWin: boolean
  /** village_and_tanner: Tanner dies with a werewolf — both teams win. */
  winners: 'village' | 'werewolves' | 'tanner' | 'village_and_tanner' | null
  winMessage: string | null
}
