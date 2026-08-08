/** Auto-assigned session colors (phone-readable on dark night scene). */
export const PLAYER_COLORS = [
  '#E85D4C',
  '#4C9BE8',
  '#3ECF8E',
  '#F0C040',
  '#C77DFF',
  '#FF8C42',
  '#5EEAD4',
  '#F472B6',
  '#A3E635',
  '#60A5FA',
  '#FB7185',
  '#FBBF24',
] as const

export type PlayerColor = (typeof PLAYER_COLORS)[number]

export function nextColor(used: ReadonlySet<string>): PlayerColor {
  for (const c of PLAYER_COLORS) {
    if (!used.has(c)) return c
  }
  // Wrap with slight variation index
  const idx = used.size % PLAYER_COLORS.length
  return PLAYER_COLORS[idx]!
}
