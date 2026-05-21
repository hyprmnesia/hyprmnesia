import { Box, Text } from 'ink'

export interface TranscriptLine {
  at: number
  id: string
  text: string
  engine: string
}

export type AudioTranscriptState = Record<'mic' | 'system', TranscriptLine[]>

function hhmmss(at: number): string {
  return new Date(at).toTimeString().slice(0, 8)
}

function oneLine(text: string, max = 110): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= max) return cleaned
  return `${cleaned.slice(0, max - 3)}...`
}

function SourceTranscript({
  label,
  color,
  lines,
}: {
  label: string
  color: 'cyan' | 'magenta'
  lines: TranscriptLine[]
}) {
  const latest = lines[lines.length - 1]
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={color} bold>
          {label}
        </Text>
        {latest && (
          <>
            <Text dimColor> {hhmmss(latest.at)} </Text>
            <Text dimColor>{latest.engine}</Text>
          </>
        )}
      </Text>
      {latest ? (
        <Text>{oneLine(latest.text)}</Text>
      ) : (
        <Text dimColor>(waiting for transcription)</Text>
      )}
    </Box>
  )
}

export function LiveTranscript({ transcripts }: { transcripts: AudioTranscriptState }) {
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text bold>Live transcript</Text>
      <SourceTranscript label="Mic" color="cyan" lines={transcripts.mic} />
      <SourceTranscript label="Mixer" color="magenta" lines={transcripts.system} />
    </Box>
  )
}
