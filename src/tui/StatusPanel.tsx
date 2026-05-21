import { Box, Text } from 'ink'
import type { Source } from '../core/events'
import type { OrchestratorStatus, SourceStatus } from '../core/orchestrator'
import { Sparkline } from './Sparkline'

const HISTOGRAM_WIDTH = 32
const INFO_WIDTH = 22

function ago(ms?: number): string {
  if (!ms) return 'never'
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

function since(ms?: number): string {
  if (!ms) return '0s'
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

function fmtBytes(b?: number): string {
  if (!b) return ''
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

function padRight(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n)
  return s + ' '.repeat(n - s.length)
}

function SourceLine({ name, s, levels }: { name: Source; s: SourceStatus; levels?: number[] }) {
  let dot = '○'
  let color: 'gray' | 'green' | 'yellow' | 'red' = 'gray'
  let info = 'disabled'
  if (s.enabled) {
    if (s.last_error) {
      dot = '●'
      color = 'red'
      info = s.last_error.slice(0, INFO_WIDTH)
    } else if (s.running) {
      dot = '●'
      color = 'green'
      info = s.last_chunk_at
        ? `${ago(s.last_chunk_at)}  ${fmtBytes(s.last_chunk_bytes)}`
        : `${since(s.started_at)} recording`
    } else {
      color = 'yellow'
      info = 'stopped'
    }
  }
  return (
    <Box>
      <Text color={color}>{dot}</Text>
      <Text> {padRight(name, 7)} </Text>
      <Text dimColor>{padRight(info, INFO_WIDTH)}</Text>
      {levels !== undefined && (
        <>
          <Text> </Text>
          <Sparkline
            values={levels}
            width={HISTOGRAM_WIDTH}
            color={color === 'red' ? 'red' : 'cyan'}
          />
        </>
      )}
    </Box>
  )
}

export function StatusPanel({
  status,
  micLevels,
  systemLevels,
  stopping,
}: {
  status: OrchestratorStatus
  micLevels: number[]
  systemLevels: number[]
  stopping: boolean
}) {
  const w = status.focused_window
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text bold>Captures</Text>
      <SourceLine name="screen" s={status.sources.screen} />
      <SourceLine name="mic" s={status.sources.mic} levels={micLevels} />
      <SourceLine name="system" s={status.sources.system} levels={systemLevels} />
      {stopping && (
        <Box marginTop={1}>
          <Text color="yellow">
            Stopping: captures are stopped, finalizing queued transcriptions...
          </Text>
        </Box>
      )}
      {w && (
        <Box marginTop={1}>
          <Text dimColor>Focused: </Text>
          <Text>{w.app}</Text>
          <Text dimColor> — </Text>
          <Text>{w.title}</Text>
        </Box>
      )}
    </Box>
  )
}
