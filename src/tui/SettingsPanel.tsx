import { Box, Text } from 'ink'
import type { Config } from '../config'

type SettingKind = 'bool' | 'enum' | 'number' | 'text'
export type SettingPath = readonly string[]

export interface SettingField {
  label: string
  path: SettingPath
  kind: SettingKind
  hint: string
  choices?: readonly unknown[]
  step?: number
  min?: number
  max?: number
}

export function getSettingValue(config: Config, path: SettingPath): unknown {
  let cur: unknown = config
  for (const part of path) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

export function setSettingValue(config: Config, path: SettingPath, value: unknown): Config {
  const next = structuredClone(config) as Config
  let cur: Record<string, unknown> = next as unknown as Record<string, unknown>
  for (const part of path.slice(0, -1)) {
    if (!cur[part] || typeof cur[part] !== 'object') cur[part] = {}
    cur = cur[part] as Record<string, unknown>
  }
  cur[path[path.length - 1]!] = value
  return next
}

export function settingsFields(config: Config): SettingField[] {
  const ocrEngine = String(getSettingValue(config, ['processing', 'ocr', 'engine']))
  const txEngine = String(getSettingValue(config, ['processing', 'transcription', 'engine']))
  return [
    {
      label: 'Screen capture',
      path: ['capture', 'screen', 'enabled'],
      kind: 'bool',
      hint: 'enable screenshots',
    },
    {
      label: 'Screen interval',
      path: ['capture', 'screen', 'interval_ms'],
      kind: 'number',
      step: 1000,
      min: 500,
      hint: 'milliseconds',
    },
    {
      label: 'Screen monitor',
      path: ['capture', 'screen', 'monitor'],
      kind: 'enum',
      choices: ['primary', 'all'],
      hint: 'monitor selection',
    },
    {
      label: 'Screen format',
      path: ['capture', 'screen', 'format'],
      kind: 'enum',
      choices: ['png', 'jpg'],
      hint: 'image format',
    },
    {
      label: 'Mic capture',
      path: ['capture', 'audio', 'mic', 'enabled'],
      kind: 'bool',
      hint: 'enable microphone',
    },
    {
      label: 'Mic device',
      path: ['capture', 'audio', 'mic', 'device'],
      kind: 'text',
      hint: 'device name or default',
    },
    {
      label: 'Mic chunk',
      path: ['capture', 'audio', 'mic', 'chunk_ms'],
      kind: 'number',
      step: 5000,
      min: 1000,
      hint: 'milliseconds',
    },
    {
      label: 'System audio',
      path: ['capture', 'audio', 'system', 'enabled'],
      kind: 'bool',
      hint: 'enable speaker/system audio',
    },
    {
      label: 'System device',
      path: ['capture', 'audio', 'system', 'device'],
      kind: 'text',
      hint: 'device name or default',
    },
    {
      label: 'System chunk',
      path: ['capture', 'audio', 'system', 'chunk_ms'],
      kind: 'number',
      step: 5000,
      min: 1000,
      hint: 'milliseconds',
    },
    {
      label: 'Sample rate',
      path: ['capture', 'audio', 'sample_rate'],
      kind: 'enum',
      choices: [16000, 24000, 44100, 48000],
      hint: 'Hz',
    },
    {
      label: 'Echo guard',
      path: ['capture', 'audio', 'echo_suppression', 'enabled'],
      kind: 'bool',
      hint: 'suppress speaker bleed in mic transcript',
    },
    {
      label: 'Speaker gate',
      path: ['capture', 'audio', 'echo_suppression', 'system_threshold_db'],
      kind: 'number',
      step: 1,
      min: -90,
      hint: 'mixer dB threshold',
    },
    {
      label: 'Mic margin',
      path: ['capture', 'audio', 'echo_suppression', 'mic_margin_db'],
      kind: 'number',
      step: 1,
      min: 0,
      hint: 'dB mic must beat mixer',
    },
    {
      label: 'Echo hold',
      path: ['capture', 'audio', 'echo_suppression', 'hold_ms'],
      kind: 'number',
      step: 100,
      min: 0,
      hint: 'ms after mixer activity',
    },
    {
      label: 'OCR engine',
      path: ['processing', 'ocr', 'engine'],
      kind: 'enum',
      choices: ['auto', 'native', 'tesseract', 'noop'],
      hint: 'screen text engine',
    },
    {
      label: 'OCR language',
      path: ['processing', 'ocr', 'options', 'lang'],
      kind: 'text',
      hint: ocrEngine === 'tesseract' ? 'tesseract lang, e.g. eng/fra' : 'used by tesseract',
    },
    {
      label: 'Audio engine',
      path: ['processing', 'transcription', 'engine'],
      kind: 'enum',
      choices: ['parakeet', 'noop'],
      hint: 'live ASR engine',
    },
    {
      label: 'Audio model',
      path: ['processing', 'transcription', 'options', 'model'],
      kind: 'enum',
      choices: ['parakeet-tdt-0.6b-v3'],
      hint: txEngine === 'noop' ? 'ignored by noop' : 'Parakeet model',
    },
    {
      label: 'Live ASR',
      path: ['processing', 'transcription', 'options', 'live', 'enabled'],
      kind: 'bool',
      hint: 'stream transcript to TUI',
    },
    {
      label: 'Min speech',
      path: ['processing', 'transcription', 'options', 'live', 'min_segment_ms'],
      kind: 'number',
      step: 250,
      min: 250,
      hint: 'ms before transcribing',
    },
    {
      label: 'Target speech',
      path: ['processing', 'transcription', 'options', 'live', 'target_segment_ms'],
      kind: 'number',
      step: 500,
      min: 1000,
      hint: 'live segment target ms',
    },
    {
      label: 'Max speech',
      path: ['processing', 'transcription', 'options', 'live', 'max_segment_ms'],
      kind: 'number',
      step: 500,
      min: 1500,
      hint: 'hard segment cap ms',
    },
    {
      label: 'Silence cut',
      path: ['processing', 'transcription', 'options', 'live', 'silence_ms'],
      kind: 'number',
      step: 100,
      min: 100,
      hint: 'ms silence closes segment',
    },
    {
      label: 'RMS gate',
      path: ['processing', 'transcription', 'options', 'live', 'rms_gate'],
      kind: 'number',
      step: 0.001,
      min: 0,
      hint: 'pre-VAD silence gate',
    },
    {
      label: 'Storage path',
      path: ['storage', 'path'],
      kind: 'text',
      hint: 'blob/index directory',
    },
    {
      label: 'MCP transport',
      path: ['mcp', 'transport'],
      kind: 'enum',
      choices: ['stdio', 'http'],
      hint: 'server transport',
    },
    {
      label: 'MCP bind',
      path: ['mcp', 'bind'],
      kind: 'text',
      hint: 'HTTP address, local only until auth',
    },
    {
      label: 'MCP port',
      path: ['mcp', 'port'],
      kind: 'number',
      step: 1,
      min: 1,
      max: 65535,
      hint: 'HTTP port',
    },
  ]
}

function displayValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  if (value === undefined || value === null || value === '') return '(empty)'
  return String(value)
}

export function SettingsPanel({
  config,
  selected,
  editingValue,
  message,
}: {
  config: Config
  selected: number
  editingValue?: string
  message?: string
}) {
  const fields = settingsFields(config)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text bold color="yellow">
        Settings
      </Text>
      <Text dimColor>arrows navigate/adjust enter edit/cycle a apply restart c/esc close</Text>
      <Box flexDirection="column" marginTop={1}>
        {fields.map((field, index) => {
          const active = index === selected
          const raw = getSettingValue(config, field.path)
          return (
            <Text key={field.path.join('.')} color={active ? 'yellow' : undefined}>
              {active ? '> ' : '  '}
              <Text bold={active}>{field.label.padEnd(16)}</Text>
              <Text>{displayValue(raw).padEnd(14)}</Text>
              <Text dimColor>{field.hint}</Text>
            </Text>
          )
        })}
      </Box>
      {editingValue !== undefined && (
        <Box marginTop={1}>
          <Text color="cyan">edit: </Text>
          <Text>{editingValue || ' '}</Text>
        </Box>
      )}
      {message && (
        <Box marginTop={1}>
          <Text dimColor>{message}</Text>
        </Box>
      )}
    </Box>
  )
}
