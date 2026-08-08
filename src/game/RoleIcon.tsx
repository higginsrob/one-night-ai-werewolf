import { ROLE_ICONS } from './roleIcons'
import type { WerewolfRole } from './werewolfTypes'

type Props = {
  role: WerewolfRole
  /** CSS pixel size (width = height). Default 28. */
  size?: number
  className?: string
  title?: string
}

/**
 * Inline SVG role symbol. Color via CSS `color` / `currentColor`.
 */
export function RoleIcon({
  role,
  size = 28,
  className,
  title,
}: Props) {
  const icon = ROLE_ICONS[role]
  if (!icon) return null

  return (
    <svg
      className={className ?? 'werewolf-role-icon'}
      width={size}
      height={size}
      viewBox={icon.viewBox}
      role="img"
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {icon.paths.map((d, i) => (
        <path key={i} d={d} fill="currentColor" fillRule="evenodd" />
      ))}
    </svg>
  )
}
