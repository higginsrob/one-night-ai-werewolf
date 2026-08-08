import type { ScoreDimensions } from './scoreTypes'

const DIMS: Array<keyof ScoreDimensions> = [
  'rulesAccuracy',
  'creativity',
  'deception',
  'interviewing',
  'persuasion',
]

const DIM_LABEL: Record<keyof ScoreDimensions, string> = {
  rulesAccuracy: 'Rules',
  creativity: 'Creativity',
  deception: 'Deception',
  interviewing: 'Interview',
  persuasion: 'Persuasion',
}

export type StatKey = 'min' | 'avg' | 'max'

export const STAT_KEYS: StatKey[] = ['min', 'avg', 'max']

export const STAT_LABEL: Record<StatKey, string> = {
  min: 'Min',
  avg: 'Avg',
  max: 'Max',
}

export type ModelStatValues = {
  overall: number
  dims: ScoreDimensions
}

export type ModelAvgRow = {
  model: string
  runs: number
  winRate: number
  byStat: Record<StatKey, ModelStatValues>
}

type BarChartProps = {
  rows: ModelAvgRow[]
  metric: 'overall' | keyof ScoreDimensions
  title: string
  /** Which stats to draw; all three → one partitioned bar (min|avg|max). */
  stats?: StatKey[]
}

function metricValue(
  values: ModelStatValues,
  metric: 'overall' | keyof ScoreDimensions,
): number {
  return metric === 'overall' ? values.overall : values.dims[metric]
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(10, n))
}

function scoreToWidth(n: number, barMax: number): number {
  return (clampScore(n) / 10) * barMax
}

/** One bar: 0→min, min→avg, avg→max segments; label is avg. */
function PartitionedBar({
  min,
  avg,
  max,
  y,
  barH,
  labelW,
  barMax,
}: {
  min: number
  avg: number
  max: number
  y: number
  barH: number
  labelW: number
  barMax: number
}) {
  // Ensure non-decreasing partitions even with float noise / single-run ties.
  const vMin = clampScore(min)
  const vAvg = Math.max(vMin, clampScore(avg))
  const vMax = Math.max(vAvg, clampScore(max))
  const wMin = scoreToWidth(vMin, barMax)
  const wAvg = scoreToWidth(vAvg, barMax)
  const wMax = scoreToWidth(vMax, barMax)
  const segments: Array<{
    x: number
    w: number
    cls: string
    roundLeft: boolean
    roundRight: boolean
  }> = []
  if (wMin > 0) {
    segments.push({
      x: labelW,
      w: wMin,
      cls: 'stat-min',
      roundLeft: true,
      roundRight: wAvg <= wMin && wMax <= wMin,
    })
  }
  if (wAvg > wMin) {
    segments.push({
      x: labelW + wMin,
      w: wAvg - wMin,
      cls: 'stat-avg',
      roundLeft: wMin <= 0,
      roundRight: wMax <= wAvg,
    })
  }
  if (wMax > wAvg) {
    segments.push({
      x: labelW + wAvg,
      w: wMax - wAvg,
      cls: 'stat-max',
      roundLeft: wAvg <= 0,
      roundRight: true,
    })
  }
  return (
    <g>
      <rect
        x={labelW}
        y={y}
        width={barMax}
        height={barH}
        rx={3}
        className="eval-chart-track"
      />
      {segments.map((seg) =>
        seg.roundLeft && seg.roundRight ? (
          <rect
            key={seg.cls}
            x={seg.x}
            y={y}
            width={seg.w}
            height={barH}
            rx={3}
            className={`eval-chart-bar ${seg.cls}`}
          />
        ) : (
          <path
            key={seg.cls}
            d={roundedBarPath(seg.x, y, seg.w, barH, seg.roundLeft, seg.roundRight, 3)}
            className={`eval-chart-bar ${seg.cls}`}
          />
        ),
      )}
      <text
        x={labelW + barMax + 8}
        y={y + 14}
        className="eval-chart-value"
      >
        {avg.toFixed(1)}
      </text>
    </g>
  )
}

function roundedBarPath(
  x: number,
  y: number,
  w: number,
  h: number,
  roundLeft: boolean,
  roundRight: boolean,
  r: number,
): string {
  const rr = Math.min(r, w / 2, h / 2)
  const rl = roundLeft ? rr : 0
  const rrgt = roundRight ? rr : 0
  // Clockwise from top-left.
  return [
    `M ${x + rl} ${y}`,
    `H ${x + w - rrgt}`,
    rrgt > 0 ? `A ${rrgt} ${rrgt} 0 0 1 ${x + w} ${y + rrgt}` : `H ${x + w}`,
    `V ${y + h - rrgt}`,
    rrgt > 0
      ? `A ${rrgt} ${rrgt} 0 0 1 ${x + w - rrgt} ${y + h}`
      : `V ${y + h}`,
    `H ${x + rl}`,
    rl > 0 ? `A ${rl} ${rl} 0 0 1 ${x} ${y + h - rl}` : `H ${x}`,
    `V ${y + rl}`,
    rl > 0 ? `A ${rl} ${rl} 0 0 1 ${x + rl} ${y}` : `V ${y}`,
    'Z',
  ].join(' ')
}

export function EvalBarChart({
  rows,
  metric,
  title,
  stats = ['avg'],
}: BarChartProps) {
  const active = stats.length > 0 ? stats : (['avg'] as StatKey[])
  const partitioned =
    active.includes('min') &&
    active.includes('avg') &&
    active.includes('max')
  const rowH = 36
  const barH = 20
  const width = 480
  const height = Math.max(120, 28 + rows.length * rowH + (partitioned ? 24 : 12))
  const barMax = 240
  const labelW = 180

  return (
    <div className="eval-chart">
      <h4>{title}</h4>
      {partitioned && (
        <div className="eval-chart-legend" aria-hidden>
          {STAT_KEYS.map((s) => (
            <span key={s} className={`eval-chart-legend-item stat-${s}`}>
              {STAT_LABEL[s]}
            </span>
          ))}
        </div>
      )}
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img">
        {rows.map((row, i) => {
          const y = 28 + i * rowH
          const label =
            row.model.length > 28 ? `${row.model.slice(0, 26)}…` : row.model
          return (
            <g key={row.model}>
              <title>
                {partitioned
                  ? `${row.model} — min ${metricValue(row.byStat.min, metric).toFixed(1)}, avg ${metricValue(row.byStat.avg, metric).toFixed(1)}, max ${metricValue(row.byStat.max, metric).toFixed(1)}`
                  : row.model}
              </title>
              <text x={0} y={y + 14} className="eval-chart-label">
                {label}
              </text>
              {partitioned ? (
                <PartitionedBar
                  min={metricValue(row.byStat.min, metric)}
                  avg={metricValue(row.byStat.avg, metric)}
                  max={metricValue(row.byStat.max, metric)}
                  y={y}
                  barH={barH}
                  labelW={labelW}
                  barMax={barMax}
                />
              ) : (
                <SingleStatBar
                  value={metricValue(row.byStat[active[0] ?? 'avg'], metric)}
                  stat={active[0] ?? 'avg'}
                  y={y}
                  barH={barH}
                  labelW={labelW}
                  barMax={barMax}
                />
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function SingleStatBar({
  value,
  stat,
  y,
  barH,
  labelW,
  barMax,
}: {
  value: number
  stat: StatKey
  y: number
  barH: number
  labelW: number
  barMax: number
}) {
  const w = scoreToWidth(value, barMax)
  return (
    <g>
      <rect
        x={labelW}
        y={y}
        width={barMax}
        height={barH}
        rx={3}
        className="eval-chart-track"
      />
      <rect
        x={labelW}
        y={y}
        width={w}
        height={barH}
        rx={3}
        className={`eval-chart-bar stat-${stat}`}
      />
      <text x={labelW + barMax + 8} y={y + 14} className="eval-chart-value">
        {value.toFixed(1)}
      </text>
    </g>
  )
}

type RadarProps = {
  /** Single-stat polygon (legacy). Ignored when `byStat` is set. */
  dims?: ScoreDimensions
  byStat?: Partial<Record<StatKey, ScoreDimensions>>
  stats?: StatKey[]
  title: string
}

function radarPoints(dims: ScoreDimensions, cx: number, cy: number, r: number) {
  return DIMS.map((d, i) => {
    const angle = -Math.PI / 2 + (i / DIMS.length) * Math.PI * 2
    const v = Math.max(0, Math.min(10, dims[d])) / 10
    return {
      x: cx + Math.cos(angle) * r * v,
      y: cy + Math.sin(angle) * r * v,
      lx: cx + Math.cos(angle) * (r + 18),
      ly: cy + Math.sin(angle) * (r + 18),
      label: DIM_LABEL[d],
    }
  })
}

export function EvalRadar({ dims, byStat, stats = ['avg'], title }: RadarProps) {
  const cx = 110
  const cy = 110
  const r = 80
  const active = stats.length > 0 ? stats : (['avg'] as StatKey[])
  const series: Array<{ key: StatKey; dims: ScoreDimensions }> = []
  if (byStat) {
    for (const s of active) {
      const d = byStat[s]
      if (d) series.push({ key: s, dims: d })
    }
  } else if (dims) {
    series.push({ key: active[0] ?? 'avg', dims })
  }
  const multi = series.length > 1
  const labelPts = radarPoints(
    series[0]?.dims ?? {
      rulesAccuracy: 0,
      creativity: 0,
      deception: 0,
      interviewing: 0,
      persuasion: 0,
    },
    cx,
    cy,
    r,
  )
  const ring = DIMS.map((_, i) => {
    const angle = -Math.PI / 2 + (i / DIMS.length) * Math.PI * 2
    return `${cx + Math.cos(angle) * r},${cy + Math.sin(angle) * r}`
  }).join(' ')

  return (
    <div className="eval-chart">
      <h4>{title}</h4>
      {multi && (
        <div className="eval-chart-legend" aria-hidden>
          {series.map((s) => (
            <span key={s.key} className={`eval-chart-legend-item stat-${s.key}`}>
              {STAT_LABEL[s.key]}
            </span>
          ))}
        </div>
      )}
      <svg viewBox="0 0 220 220" width="220" height="220" role="img">
        <polygon points={ring} className="eval-radar-ring" />
        {series.map((s) => {
          const pts = radarPoints(s.dims, cx, cy, r)
          const poly = pts.map((p) => `${p.x},${p.y}`).join(' ')
          return (
            <polygon
              key={s.key}
              points={poly}
              className={`eval-radar-fill stat-${s.key}`}
            />
          )
        })}
        {labelPts.map((p) => (
          <text
            key={p.label}
            x={p.lx}
            y={p.ly}
            textAnchor="middle"
            className="eval-chart-label"
          >
            {p.label}
          </text>
        ))}
      </svg>
    </div>
  )
}

export { DIMS, DIM_LABEL }
