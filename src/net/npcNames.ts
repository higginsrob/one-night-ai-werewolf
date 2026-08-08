const TITLES = [
  'Captain',
  'Baron',
  'Duke',
  'Sir',
  'Lady',
  'Mayor',
  'Chef',
  'Doctor',
  'Agent',
  'Professor',
  'Admiral',
  'Count',
  'Princess',
  'Sheriff',
  'Coach',
] as const

const NOUNS = [
  'Pickles',
  'Biscuit',
  'Waffles',
  'Noodles',
  'Pretzel',
  'Meatball',
  'Sprout',
  'Crumbs',
  'Goober',
  'Nugget',
  'Beans',
  'Muffin',
  'Tater',
  'Scone',
  'Dumpling',
  'Bagel',
  'Chimichanga',
  'Pancake',
  'Meatloaf',
  'Squash',
  'Turnip',
  'Gherkin',
  'Quiche',
  'Fudge',
] as const

function shuffle<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/** Unique funny display names, each at most 24 characters. */
export function funnyNpcNames(count: number): string[] {
  const n = Math.max(0, Math.floor(count))
  if (n === 0) return []

  const combos: string[] = []
  for (const title of TITLES) {
    for (const noun of NOUNS) {
      const name = `${title} ${noun}`
      if (name.length <= 24) combos.push(name)
    }
  }

  const shuffled = shuffle(combos)
  const names: string[] = []
  for (let i = 0; i < n; i++) {
    if (i < shuffled.length) {
      names.push(shuffled[i]!)
    } else {
      names.push(`NPC ${i + 1}`)
    }
  }
  return names
}
