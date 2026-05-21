import { Box, Text } from 'ink'

export function Footer({
  running,
  settingsOpen,
  logsOpen,
  stopping,
}: {
  running: boolean
  settingsOpen: boolean
  logsOpen: boolean
  stopping: boolean
}) {
  return (
    <Box marginTop={1} paddingX={1}>
      <Text>
        <Text color="cyan">[x]</Text>
        <Text dimColor>{stopping ? ' stopping  ' : running ? ' stop  ' : ' start  '}</Text>
        <Text color="cyan">[r]</Text>
        <Text dimColor> refresh </Text>
        <Text color="cyan">[c]</Text>
        <Text dimColor>{settingsOpen ? ' close settings  ' : ' settings  '}</Text>
        <Text color="cyan">[l]</Text>
        <Text dimColor>{logsOpen ? ' close logs  ' : ' logs  '}</Text>
        <Text color="cyan">[q]</Text>
        <Text dimColor> quit</Text>
      </Text>
    </Box>
  )
}
