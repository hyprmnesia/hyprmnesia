import { Box, Text } from 'ink'
import type { CaptureEvent } from '../core/events'

type LogColor = 'cyan' | 'gray' | 'green' | 'magenta' | 'red' | 'yellow'

export interface DescribedLogEvent {
  level: string
  color: LogColor
  message: string
}

function hhmmss(at: number): string {
  return new Date(at).toTimeString().slice(0, 8)
}

function oneLine(text: string, max = 120): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= max) return cleaned
  return `${cleaned.slice(0, max - 3)}...`
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KB`
}

export function describeLogEvent(e: CaptureEvent): DescribedLogEvent | undefined {
  switch (e.type) {
    case 'started':
      return { level: 'INFO', color: 'cyan', message: `${e.source} started` }
    case 'stopped':
      return { level: 'INFO', color: 'gray', message: `${e.source} stopped` }
    case 'chunk': {
      const context = e.window ? ` (${e.window.app})` : ''
      return { level: 'OK', color: 'green', message: `${e.source} chunk ${kb(e.bytes)}${context}` }
    }
    case 'transcription_status': {
      const color: LogColor =
        e.status === 'error'
          ? 'red'
          : e.status === 'ready'
            ? 'green'
            : e.status === 'downloading'
              ? 'yellow'
              : 'gray'
      const level = e.status === 'error' ? 'ERROR' : e.status === 'ready' ? 'OK' : 'ASR'
      return { level, color, message: `${e.engine}: ${e.message ?? e.status}` }
    }
    case 'transcription_segment':
      return {
        level: 'LIVE',
        color: 'cyan',
        message: `${e.source} transcript ${e.transcribe_ms}ms: ${oneLine(e.text, 90)}`,
      }
    case 'transcribed':
      return {
        level: 'LIVE',
        color: 'cyan',
        message: `${e.source} final ${e.transcribe_ms}ms: ${oneLine(e.text, 90)}`,
      }
    case 'window_changed':
      return {
        level: 'FOCUS',
        color: 'magenta',
        message: `${e.window.app}: ${oneLine(e.window.title, 90)}`,
      }
    case 'error':
      return { level: 'ERROR', color: 'red', message: `${e.source}: ${e.message}` }
    case 'log': {
      const level = e.level.toUpperCase()
      const color: LogColor = e.level === 'error' ? 'red' : e.level === 'warn' ? 'yellow' : 'gray'
      return { level, color, message: e.message }
    }
    default:
      return undefined
  }
}

export function LogPanel({ events }: { events: CaptureEvent[] }) {
  const lines = events
    .map((event) => ({ event, described: describeLogEvent(event) }))
    .filter((entry): entry is { event: CaptureEvent; described: DescribedLogEvent } =>
      Boolean(entry.described),
    )

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} marginTop={1}>
      <Text bold color="blue">
        Logs
      </Text>
      <Text dimColor>l close r refresh q quit</Text>
      <Box flexDirection="column" marginTop={1}>
        {lines.length === 0 && <Text dimColor>(waiting for daemon logs)</Text>}
        {lines.map(({ event, described }, index) => (
          <Text key={`${event.at}-${event.type}-${index}`}>
            <Text dimColor>{hhmmss(event.at)} </Text>
            <Text color={described.color} bold>
              {described.level.padEnd(5)}
            </Text>
            <Text> {oneLine(described.message)}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  )
}
