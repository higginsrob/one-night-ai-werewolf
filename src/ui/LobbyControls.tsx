import type { SessionSnapshot } from '../net/protocol'

type Props = {
  snapshot: SessionSnapshot
  onOpenSettings: () => void
}

export function LobbyControls({ snapshot, onOpenSettings }: Props) {
  const connectedCount = snapshot.players.filter((p) => p.connected).length

  return (
    <div className="lobby-menu">
      <button
        type="button"
        className="hamburger-btn"
        aria-label="Open settings"
        onClick={onOpenSettings}
      >
        <span className="hamburger-box" aria-hidden>
          <span className="hamburger-line" />
          <span className="hamburger-line" />
          <span className="hamburger-line" />
        </span>
        {connectedCount > 0 && (
          <span className="hamburger-badge">{connectedCount}</span>
        )}
      </button>
    </div>
  )
}
