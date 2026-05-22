import { Box, Text, useApp, useInput } from 'ink'
import { useEffect, useMemo, useRef, useState } from 'react'
import { type Config, ensureDefaultConfig, loadConfigForEditing } from '../config'
import type { CaptureEvent, Source } from '../core/events'
import type { Orchestrator, OrchestratorStatus } from '../core/orchestrator'
import { selfCliArgs } from '../util/selfCli'
import { EventList } from './EventList'
import { Footer } from './Footer'
import { type AudioTranscriptState, LiveTranscript, type TranscriptLine } from './LiveTranscript'
import { LogPanel } from './LogPanel'
import { SettingsPanel } from './SettingsPanel'
import { StatusPanel } from './StatusPanel'
import { handleSettingsKey } from './settingsInput'

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

function pushBounded<T>(arr: readonly T[], v: T, max: number): T[] {
  const next = [...arr, v]
  return next.length > max ? next.slice(next.length - max) : next
}

function pushTranscript(
  state: AudioTranscriptState,
  source: 'mic' | 'system',
  line: TranscriptLine,
): AudioTranscriptState {
  return { ...state, [source]: pushBounded(state[source], line, MAX_TRANSCRIPT_LINES) }
}

function isAudioTranscriptSource(source: Source): source is 'mic' | 'system' {
  return source === 'mic' || source === 'system'
}

async function awaitChild(args: string[]): Promise<number> {
  const proc = Bun.spawn([process.execPath, ...args], { stdout: 'ignore', stderr: 'ignore' })
  return await proc.exited
}

async function restartDaemon(): Promise<boolean> {
  await awaitChild(selfCliArgs('stop'))
  const code = await awaitChild(selfCliArgs('_daemon'))
  return code === 0
}

export function App({ orch }: { orch: Orchestrator }) {
  const { exit } = useApp()
  const [status, setStatus] = useState<OrchestratorStatus>(() => orch.status())
  const [logEvents, setLogEvents] = useState<CaptureEvent[]>([])
  const [micLevels, setMicLevels] = useState<number[]>([])
  const [systemLevels, setSystemLevels] = useState<number[]>([])
  const [transcripts, setTranscripts] = useState<AudioTranscriptState>({ mic: [], system: [] })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [settingsIndex, setSettingsIndex] = useState(0)
  const [settings, setSettings] = useState<Config>(() => loadConfigForEditing())
  const [editingValue, setEditingValue] = useState<string | undefined>()
  const [settingsMessage, setSettingsMessage] = useState(() => `config: ${ensureDefaultConfig()}`)
  const [stopping, setStopping] = useState(false)
  const stoppingRef = useRef(stopping)
  stoppingRef.current = stopping

  const events = useMemo(() => logEvents.slice(-MAX_EVENTS), [logEvents])

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
      if (stoppingRef.current && !nextStatus.running) setStopping(false)
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
        setLogEvents((prev) => pushBounded(prev, e, MAX_LOG_EVENTS))
      }
    })
  }, [orch])

  useEffect(() => {
    const id = setInterval(() => {
      const nextStatus = orch.status()
      setStatus(nextStatus)
      if (stoppingRef.current && !nextStatus.running) setStopping(false)
    }, 1000)
    return () => clearInterval(id)
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
          setLogEvents((prev) => pushBounded(prev, stopEvent, MAX_LOG_EVENTS))
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
      applySettings: async () => {
        setSettingsMessage('restarting daemon…')
        const ok = await restartDaemon()
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
      handleSettingsKey(input, key, {
        config: settings,
        selected: settingsIndex,
        setSelected: setSettingsIndex,
        setConfig: setSettings,
        setMessage: setSettingsMessage,
        editingValue,
        setEditingValue,
        onApply: () => {
          void actions.applySettings()
        },
        onReload: actions.reloadSettings,
        onClose: () => setSettingsOpen(false),
        onOpenLogs: () => {
          setSettingsOpen(false)
          setLogsOpen(true)
        },
        onExit: actions.exit,
      })
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
