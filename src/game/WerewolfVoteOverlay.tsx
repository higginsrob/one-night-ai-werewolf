import { createPortal } from 'react-dom'
import type { PlayerPublic, ReactionEvent } from '../session/types'
import { HtmlPlayerCard } from '../ui/PlayerCardCarousel'

type ConfirmProps = {
  /** Abstain instead of voting for a player. */
  noVote?: boolean
  player: PlayerPublic
  reactions?: ReactionEvent[]
  onConfirm: () => void
  onCancel: () => void
  /** Portal target — defaults to document.body (fullscreen over the app). */
  portalRoot?: Element | null
}

/** Compact “vote cast” chip for the canvas bottom-right dock. */
export function WerewolfVoteCastCard({
  noVote = false,
  player,
  reactions = [],
  onUndo,
}: {
  noVote?: boolean
  player: PlayerPublic
  reactions?: ReactionEvent[]
  onUndo: () => void
}) {
  return (
    <div className="werewolf-vote-cast-dock" aria-live="polite">
      <p className="werewolf-vote-cast-note">
        {noVote ? 'No vote' : 'Vote cast'}
      </p>
      <div className="werewolf-vote-cast-dock-card">
        <HtmlPlayerCard
          player={player}
          label={noVote ? 'No vote' : 'Your vote'}
          reactions={reactions}
        />
      </div>
      <button
        type="button"
        className="btn tiny werewolf-vote-undo"
        onClick={onUndo}
      >
        Undo
      </button>
    </div>
  )
}

/**
 * Day-phase vote confirm dialog (fullscreen modal; closes back to prior view).
 * Cast UI lives in {@link WerewolfVoteCastCard} beside the local player card.
 */
export function WerewolfVoteOverlay({
  noVote = false,
  player,
  reactions,
  onConfirm,
  onCancel,
  portalRoot,
}: ConfirmProps) {
  if (typeof document === 'undefined') return null

  const root = portalRoot ?? document.body
  return createPortal(
    <div
      className="werewolf-vote-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="werewolf-vote-title"
    >
      <div className="werewolf-vote-panel">
        <h2 id="werewolf-vote-title" className="werewolf-vote-title">
          {noVote ? 'Cast a no vote?' : `Vote for ${player.name}?`}
        </h2>
        <p className="hint werewolf-vote-lead">
          {noVote
            ? 'Confirm to vote for no one.'
            : 'Confirm to cast your vote for this player.'}
        </p>
        <div className="werewolf-vote-card-wrap">
          <HtmlPlayerCard
            player={player}
            reactions={reactions}
            label={noVote ? 'No vote' : undefined}
          />
        </div>
        <div className="btn-row werewolf-vote-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={onConfirm}>
            {noVote ? 'Confirm no vote' : 'Confirm vote'}
          </button>
        </div>
      </div>
    </div>,
    root,
  )
}
