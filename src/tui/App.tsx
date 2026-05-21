import { spawnSync } from 'node:child_process'
import { Box, Text, useApp, useInput } from 'ink'
import { useEffect, useMemo, useState } from 'react'
import { type Config, ensureDefaultConfig, loadConfigForEditing, saveConfig } from '../config'
import type { CaptureEvent, Source } from '../core/events'
import type { Orchestrator, OrchestratorStatus } from '../core/orchestrator'
import { selfCliArgs } from '../util/selfCli'
import { EventList } from './EventList'
import { Footer } from './Footer'
import { type AudioTranscriptState, LiveTranscript, type TranscriptLine } from './LiveTranscript'
import { LogPanel } from './LogPanel'
import {
  getSettingValue,
  type SettingField,
  SettingsPanel,
  setSettingValue,
  settingsFields,
} from './SettingsPanel'
import { StatusPanel } from './StatusPanel'

const MAX_EVENTS = 10
const MAX_LOG_EVENTS = 80
const MAX_LEVELS = 64
const MAX_TRANSCRIPT_LINES = 4
const FLOOR_DB = -60

const VISIBLE: ReadonlySet<CaptureEvent['type']> = new Set([
  'chunk',
  'transcribed',
  'transcription_status',
  'transcription_segment',
  'window_changed',
  'error',
  'started',
  'stopped',
  'log',
])

function pushBounded(arr: number[], v: number, max: number): number[] {
  const next = [...arr, v]
  return next.length > max ? next.slice(next.length - max) : next
}

function pushTranscript(
  state: AudioTranscriptState,
  source: 'mic' | 'system',
  line: TranscriptLine,
): AudioTranscriptState {
  const next = [...state[source], line]
  return {
    ...state,
    [source]:
      next.length > MAX_TRANSCRIPT_LINES ? next.slice(next.length - MAX_TRANSCRIPT_LINES) : next,
  }
}

function isAudioTranscriptSource(source: Source): source is 'mic' | 'system' {
  return source === 'mic' || source === 'system'
}

function restartDaemon(): boolean {
  spawnSync(process.execPath, selfCliArgs('stop'), { stdio: 'ignore', windowsHide: true })
  const started = spawnSync(process.execPath, selfCliArgs('_daemon'), {
    stdio: 'ignore',
    windowsHide: true,
  })
  return started.status === 0
}

function coerceEditedValue(field: SettingField, value: string): unknown {
  if (field.kind === 'number') {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return undefined
    const min = field.min ?? Number.NEGATIVE_INFINITY
    const max = field.max ?? Number.POSITIVE_INFINITY
    return Math.min(max, Math.max(min, parsed))
  }
  return value
}

function nextFieldValue(field: SettingField, current: unknown, direction = 1): unknown {
  if (field.kind === 'bool') return !current
  if (field.kind === 'number') {
    const base = typeof current === 'number' ? current : Number(current) || 0
    const min = field.min ?? Number.NEGATIVE_INFINITY
    const max = field.max ?? Number.POSITIVE_INFINITY
    return Math.min(max, Math.max(min, base + (field.step ?? 1) * direction))
  }
  if (field.kind === 'enum' && field.choices?.length) {
    const index = Math.max(
      0,
      field.choices.findIndex((choice) => choice === current),
    )
    return field.choices[(index + direction + field.choices.length) % field.choices.length]
  }
  return current
}

export function App({ orch }: { orch: Orchestrator }) {
  const { exit } = useApp()
  const [status, setStatus] = useState<OrchestratorStatus>(() => orch.status())
  const [events, setEvents] = useState<CaptureEvent[]>([])
  const [logEvents, setLogEvents] = useState<CaptureEvent[]>([])
  const [micLevels, setMicLevels] = useState<number[]>([])
  const [systemLevels, setSystemLevels] = useState<number[]>([])
  const [transcripts, setTranscripts] = useState<AudioTranscriptState>({ mic: [], system: [] })
  const [, tick] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [settingsIndex, setSettingsIndex] = useState(0)
  const [settings, setSettings] = useState<Config>(() => loadConfigForEditing())
  const [editingValue, setEditingValue] = useState<string | undefined>()
  const [settingsMessage, setSettingsMessage] = useState(() => `config: ${ensureDefaultConfig()}`)
  const [stopping, setStopping] = useState(false)

  useEffect(() => {
    return orch.events.subscribe((e) => {
      if (e.type === 'audio_level') {
        const setter =
          e.source === 'mic' ? setMicLevels : e.source === 'system' ? setSystemLevels : null
        if (!setter) return
        const v = Number.isFinite(e.rms_db) ? e.rms_db : FLOOR_DB
        setter((arr) => pushBounded(arr, v, MAX_LEVELS))
        return
      }
      const nextStatus = orch.status()
      setStatus(nextStatus)
      if (stopping && !nextStatus.running) setStopping(false)
      const transcribedText =
        e.type === 'transcribed' && typeof e.text === 'string' ? e.text.trim() : ''
      if (e.type === 'transcribed' && isAudioTranscriptSource(e.source) && transcribedText) {
        const source = e.source
        setTranscripts((prev) =>
          pushTranscript(prev, source, {
            at: e.at,
            id: e.id,
            text: transcribedText,
            engine: e.engine,
          }),
        )
      }
      if (VISIBLE.has(e.type)) {
        setLogEvents((prev) => {
          const next = [...prev, e]
          return next.length > MAX_LOG_EVENTS ? next.slice(next.length - MAX_LOG_EVENTS) : next
        })
        setEvents((prev) => {
          const next = [...prev, e]
          return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next
        })
      }
    })
  }, [orch])

  useEffect(() => {
    const id = setInterval(() => tick((t) => t + 1), 1000)
    const statusId = setInterval(() => {
      const nextStatus = orch.status()
      setStatus(nextStatus)
      if (stopping && !nextStatus.running) setStopping(false)
    }, 1000)
    return () => {
      clearInterval(id)
      clearInterval(statusId)
    }
  }, [orch])

  const actions = useMemo(() => {
    return {
      toggleStartStop: () => {
        if (stopping) return
        if (orch.isRunning()) {
          setStopping(true)
          const stopEvent: CaptureEvent = {
            type: 'log',
            at: Date.now(),
            level: 'info',
            message: 'stopping daemon; finalizing queued transcriptions',
          }
          setLogEvents((prev) => {
            const next = [...prev, stopEvent]
            return next.length > MAX_LOG_EVENTS ? next.slice(next.length - MAX_LOG_EVENTS) : next
          })
          setEvents((prev) => {
            const next: CaptureEvent[] = [...prev, stopEvent]
            return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next
          })
          orch.stop().catch(() => setStopping(false))
        } else {
          orch.start().catch(() => {})
        }
        setTimeout(() => setStatus(orch.status()), 250)
      },
      refresh: () => {
        setStatus(orch.status())
      },
      reloadSettings: () => {
        setSettings(loadConfigForEditing())
        setSettingsMessage(`reloaded ${ensureDefaultConfig()}`)
      },
      applySettings: () => {
        const ok = restartDaemon()
        setStatus(orch.status())
        setSettingsMessage(
          ok ? 'daemon restarted with saved settings' : 'daemon restart failed; check logs',
        )
      },
      exit: () => {
        orch.dispose?.()
        exit()
      },
    }
  }, [orch, exit, stopping])

  useInput((input, key) => {
    if (settingsOpen) {
      const fields = settingsFields(settings)
      const field = fields[settingsIndex]
      if (!field) return

      if (key.ctrl && input === 'c') {
        actions.exit()
        return
      }

      const saveNext = (next: Config, message = 'saved config.yaml; restart daemon to apply') => {
        setSettings(next)
        saveConfig(next)
        setSettingsMessage(message)
      }

      if (editingValue !== undefined) {
        if (key.return) {
          const nextValue = coerceEditedValue(field, editingValue)
          if (nextValue !== undefined) saveNext(setSettingValue(settings, field.path, nextValue))
          setEditingValue(undefined)
        } else if (key.escape) {
          setEditingValue(undefined)
        } else if (key.backspace || key.delete) {
          setEditingValue((value) => value?.slice(0, -1) ?? '')
        } else if (key.ctrl && input === 'u') {
          setEditingValue('')
        } else if (input && !key.ctrl && !key.meta) {
          setEditingValue((value) => `${value ?? ''}${input}`)
        }
        return
      }

      if (input === 'e') {
        actions.exit()
      } else if (key.escape || input === 'c') {
        setSettingsOpen(false)
      } else if (input === 'l') {
        setSettingsOpen(false)
        setLogsOpen(true)
      } else if (key.upArrow) {
        setSettingsIndex((i) => Math.max(0, i - 1))
      } else if (key.downArrow) {
        setSettingsIndex((i) => Math.min(fields.length - 1, i + 1))
      } else if (key.leftArrow || key.rightArrow) {
        const current = getSettingValue(settings, field.path)
        const direction = key.leftArrow ? -1 : 1
        const nextValue = nextFieldValue(field, current, direction)
        saveNext(setSettingValue(settings, field.path, nextValue))
      } else if (key.return || input === ' ') {
        const current = getSettingValue(settings, field.path)
        if (field.kind === 'text' || field.kind === 'number') setEditingValue(String(current ?? ''))
        else saveNext(setSettingValue(settings, field.path, nextFieldValue(field, current, 1)))
      } else if (input === 'a') {
        actions.applySettings()
      } else if (input === 'r') {
        actions.reloadSettings()
      }
      return
    }

    if (input === 'e' || (key.ctrl && input === 'c')) {
      actions.exit()
    } else if (input === 'x') {
      actions.toggleStartStop()
    } else if (input === 'r') {
      actions.refresh()
    } else if (input === 'l') {
      setLogsOpen((open) => !open)
      setSettingsOpen(false)
    } else if (input === 'c') {
      setSettings(loadConfigForEditing())
      setSettingsOpen(true)
      setLogsOpen(false)
    }
  })

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">
          hyprmnesia
        </Text>
      </Box>
      <StatusPanel
        status={status}
        micLevels={micLevels}
        systemLevels={systemLevels}
        stopping={stopping}
      />
      {settingsOpen ? (
        <SettingsPanel
          config={settings}
          selected={settingsIndex}
          editingValue={editingValue}
          message={settingsMessage}
        />
      ) : logsOpen ? (
        <LogPanel events={logEvents} />
      ) : (
        <>
          <LiveTranscript transcripts={transcripts} />
          <EventList events={events} />
        </>
      )}
      <Footer
        running={status.running}
        settingsOpen={settingsOpen}
        logsOpen={logsOpen}
        stopping={stopping}
      />
    </Box>
  )
}
