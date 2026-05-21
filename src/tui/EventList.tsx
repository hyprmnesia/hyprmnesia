import { Box, Text } from 'ink'
import type { CaptureEvent } from '../core/events'
import { describeLogEvent } from './LogPanel'

function hhmmss(at: number): string {
  return new Date(at).toTimeString().slice(0, 8)
}

export function EventList({ events }: { events: CaptureEvent[] }) {
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text bold>Recent events</Text>
      {events.length === 0 && <Text dimColor>(none yet)</Text>}
      {events.map((e, i) => {
        const d = describeLogEvent(e)
        if (!d) return null
        return (
          <Box key={i}>
            <Text dimColor>{hhmmss(e.at)} </Text>
            <Text color={d.color} bold>
              {d.level.padEnd(5)}
            </Text>
            <Text> {d.message.slice(0, 90)}</Text>
          </Box>
        )
      })}
    </Box>
  )
}
