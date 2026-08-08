/**
 * Place players on an arc across the back half of the scene
 * (camera looks from +Z toward the origin).
 */
export function behindBoardSeatPosition(
  index: number,
  total: number,
): [number, number, number] {
  const n = Math.max(total, 1)
  // Outside the scaled picnic table so cards clear the far bench / end.
  const radius = 3.45
  // Hover just above the scaled tabletop (TABLE_TOP ≈ 1.42).
  const y = 1.95
  // Widen with more players so cards stay readable; stay on the far half.
  const span = Math.min(Math.PI * 0.72, Math.PI * 0.28 + (n - 1) * 0.22)
  const mid = -Math.PI / 2
  const t = n === 1 ? 0.5 : index / (n - 1)
  const angle = mid - span / 2 + t * span
  return [Math.cos(angle) * radius, y, Math.sin(angle) * radius]
}
