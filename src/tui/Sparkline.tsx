import { Text } from 'ink'

const BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

const FLOOR_DB = -60
const CEIL_DB = 0

function pickBlock(v: number): string {
  if (!Number.isFinite(v)) return BLOCKS[0]!
  const clamped = Math.max(FLOOR_DB, Math.min(CEIL_DB, v))
  const norm = (clamped - FLOOR_DB) / (CEIL_DB - FLOOR_DB)
  const idx = Math.min(BLOCKS.length - 1, Math.max(0, Math.round(norm * (BLOCKS.length - 1))))
  return BLOCKS[idx]!
}

export function Sparkline({
  values,
  width,
  color,
}: {
  values: number[]
  width: number
  color?: string
}) {
  const slot = values.slice(-width)
  const blocks = slot.map(pickBlock).join('')
  const padded = ' '.repeat(Math.max(0, width - slot.length)) + blocks
  return <Text color={color}>{padded}</Text>
}
