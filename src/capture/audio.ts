import { randomUUIDv7 } from 'bun'
import type { AudioCaptureConfig, AudioStreamConfig } from '../config'
import type { AudioSource, EventBus, WindowContext } from '../core/events'
import type { TranscriptionQueue } from '../process/transcription_queue'
import type { BlobStore } from '../store/blobs'
import type { ChunkStore } from '../store/db'
import {
  buildMicInputArgs,
  buildSystemAudioInputArgs,
  getFfmpegPath,
  listAvfoundationAudioDevices,
  listDshowAudioDevices,
  SYSTEM_AUDIO_DSHOW_DEVICE,
} from './ffmpeg'
import type { SckBus } from './sck'
import { encodePcm16Wav, pcm16Levels } from './wav'

export interface AudioCaptureDeps {
  cfg: AudioCaptureConfig
  blobs: BlobStore
  store: ChunkStore
  transcription: TranscriptionQueue
  events: EventBus
  sck?: SckBus
  getWindow?: () => WindowContext | undefined
}

export interface CaptureRunner {
  stop: () => void
  done: Promise<void>
}

interface AudioStreamDeps {
  blobs: BlobStore
  store: ChunkStore
  transcription: TranscriptionQueue
  events: EventBus
  echo: EchoSuppressionRuntime
  getWindow?: () => WindowContext | undefined
}

const SCR_INSTALL_URL =
  'https://github.com/rdp/screen-capture-recorder-to-video-windows-free/releases'
const LEVEL_THROTTLE_MS = 100
const ASR_FRAME_MS = 30
const BYTES_PER_SAMPLE = 2

const NOOP_RUNNER: CaptureRunner = { stop: () => {}, done: Promise.resolve() }

interface AudioChunkState {
  id: string
  kind: 'audio_mic' | 'audio_system'
  startAt: number
  blobPath: string
  window?: WindowContext
  parts: Buffer[]
  samples: number
  inserted: boolean
}

interface EchoSuppressionRuntime {
  enabled: boolean
  systemThresholdDb: number
  micMarginDb: number
  holdMs: number
  activeUntil: number
  lastSystemPeakDb: number
}

const DARWIN_VIRTUAL_MIC_PATTERNS = [/blackhole/i, /aggregate/i, /soundflower/i, /loopback/i]

async function resolveDevice(source: AudioSource, configured: string): Promise<string> {
  if (process.platform === 'darwin') {
    if (source !== 'mic' || configured !== 'default') return configured
    // avfoundation `:0` indexes audio devices in registration order; if a
    // virtual loopback device (BlackHole / Aggregate / etc.) is installed it
    // can occupy index 0 and silently feed us silence. Pick the first
    // real-looking input device instead.
    const devices = await listAvfoundationAudioDevices()
    if (devices.length === 0) return '0'
    const real = devices.find((d) => !DARWIN_VIRTUAL_MIC_PATTERNS.some((re) => re.test(d.name)))
    const chosen = real ?? devices[0]
    return String(chosen?.index ?? 0)
  }
  if (process.platform !== 'win32') return configured
  const devices = await listDshowAudioDevices()
  if (source === 'mic') {
    if (configured !== 'default') return configured
    const first = devices.find((d) => !d.toLowerCase().includes(SYSTEM_AUDIO_DSHOW_DEVICE))
    if (!first) throw new Error('no mic device found via dshow')
    return first
  }
  const target = configured === 'default' ? SYSTEM_AUDIO_DSHOW_DEVICE : configured
  const present = devices.some((d) => d.toLowerCase() === target.toLowerCase())
  if (!present) {
    throw new Error(
      `system audio device '${target}' not found via dshow - ` +
        `install Screen Capturer Recorder (free, open source) from ${SCR_INSTALL_URL} ` +
        `or pass --no-system-audio to disable. ` +
        `available dshow audio devices: ${JSON.stringify(devices)}`,
    )
  }
  return target
}

function inputArgsFor(source: AudioSource, device: string): string[] {
  return source === 'mic' ? buildMicInputArgs(device) : buildSystemAudioInputArgs(device)
}

function finiteLevel(value: number): number | undefined {
  return Number.isFinite(value) ? value : undefined
}

function peakOrFloor(value: number): number {
  return Number.isFinite(value) ? value : -Infinity
}

function makeEchoSuppression(cfg: AudioCaptureConfig): EchoSuppressionRuntime {
  return {
    enabled: cfg.echo_suppression?.enabled ?? true,
    systemThresholdDb: cfg.echo_suppression?.system_threshold_db ?? -45,
    micMarginDb: cfg.echo_suppression?.mic_margin_db ?? 6,
    holdMs: cfg.echo_suppression?.hold_ms ?? 500,
    activeUntil: 0,
    lastSystemPeakDb: -Infinity,
  }
}

function shouldSubmitAsrFrame(
  source: AudioSource,
  at: number,
  frame: Buffer,
  echo: EchoSuppressionRuntime,
): boolean {
  if (!echo.enabled) return true
  const levels = pcm16Levels(frame)
  const peak = Number.isFinite(levels.peak_db) ? levels.peak_db : -Infinity

  if (source === 'system') {
    if (peak >= echo.systemThresholdDb) {
      echo.activeUntil = Math.max(echo.activeUntil, at + echo.holdMs)
      echo.lastSystemPeakDb = peak
    }
    return true
  }

  if (at > echo.activeUntil) return true
  return peak >= echo.lastSystemPeakDb + echo.micMarginDb
}

function chunkKind(source: AudioSource): 'audio_mic' | 'audio_system' {
  return source === 'mic' ? 'audio_mic' : 'audio_system'
}

interface AudioConsumer {
  appendPcm: (pcm: Buffer) => Promise<void>
  finalize: () => Promise<void>
}

function makeAudioConsumer(
  args: {
    source: AudioSource
    device: string
    sampleRate: number
    chunkMs: number
  } & AudioStreamDeps,
): AudioConsumer {
  const {
    source,
    device,
    sampleRate,
    chunkMs,
    blobs,
    store,
    transcription,
    events,
    echo,
    getWindow,
  } = args
  const chunkSamples = Math.max(1, Math.floor((chunkMs / 1000) * sampleRate))
  const asrFrameBytes = Math.max(
    BYTES_PER_SAMPLE,
    Math.floor((ASR_FRAME_MS / 1000) * sampleRate) * BYTES_PER_SAMPLE,
  )
  const streamStartAt = Date.now()
  let samplesSeen = 0
  let current: AudioChunkState | undefined
  let asrPending = Buffer.alloc(0)
  let asrPendingAt: number | undefined
  let lastLevelAt = 0

  const ensureChunk = (at: number): AudioChunkState => {
    if (current) return current
    const id = randomUUIDv7()
    const kind = chunkKind(source)
    const blobPath = blobs.path(kind, id, 'wav', at)
    const window = getWindow?.()
    current = { id, kind, startAt: at, blobPath, window, parts: [], samples: 0, inserted: false }
    return current
  }

  // Defer the DB row until the chunk actually has audio. Avoids orphan rows
  // when a stream stops between ensureChunk and the first sample arriving.
  const insertChunkRow = (chunk: AudioChunkState) => {
    if (chunk.inserted) return
    chunk.inserted = true
    store.insert({
      id: chunk.id,
      kind: chunk.kind,
      at: chunk.startAt,
      start_at: chunk.startAt,
      end_at: chunk.startAt,
      blob: chunk.blobPath,
      bytes: 0,
      text: '',
      capture_ms: 0,
      window: chunk.window,
      audio: {
        engine: 'pending',
        device,
        sample_rate: sampleRate,
        chunk_ms: chunkMs,
      },
    })
  }

  const flushAsrBoundary = () => {
    asrPending = Buffer.alloc(0)
    asrPendingAt = undefined
    transcription.flush(source).catch((err) => {
      events.publish({ type: 'error', source, at: Date.now(), message: `ASR flush failed: ${err}` })
    })
  }

  const finalizeChunk = async () => {
    if (!current || !current.inserted) {
      current = undefined
      return
    }
    const chunk = current
    current = undefined
    const pcm = Buffer.concat(chunk.parts)
    const wav = encodePcm16Wav(pcm, sampleRate)
    await blobs.write(chunk.kind, chunk.id, 'wav', wav, chunk.startAt)
    const endAt = chunk.startAt + Math.round((chunk.samples / sampleRate) * 1000)
    const levels = pcm16Levels(pcm)
    const rms_db = finiteLevel(levels.rms_db)
    const peak_db = finiteLevel(levels.peak_db)
    store.finalizeAudioChunk(chunk.id, {
      bytes: wav.length,
      capture_ms: Date.now() - chunk.startAt,
      end_at: endAt,
      rms_db,
      peak_db,
    })
    events.publish({
      type: 'chunk',
      source,
      at: endAt,
      id: chunk.id,
      path: chunk.blobPath,
      bytes: wav.length,
      text_len: 0,
      capture_ms: Date.now() - chunk.startAt,
      window: chunk.window,
      rms_db,
      peak_db,
    })
  }

  const feedAsr = (chunkId: string, pcm: Buffer, at: number) => {
    if (asrPending.length === 0) asrPendingAt = at
    asrPending = Buffer.concat([asrPending, pcm])
    while (asrPending.length >= asrFrameBytes && asrPendingAt !== undefined) {
      const frame = asrPending.subarray(0, asrFrameBytes)
      if (shouldSubmitAsrFrame(source, asrPendingAt, frame, echo)) {
        transcription.submitPcm({
          source,
          chunkId,
          at: asrPendingAt,
          sampleRate,
          pcm: frame,
        })
      }
      asrPending = asrPending.subarray(asrFrameBytes)
      asrPendingAt += ASR_FRAME_MS
    }
  }

  const appendPcm = async (pcm: Buffer) => {
    let offset = 0
    while (offset < pcm.length) {
      const sampleAt = streamStartAt + Math.round((samplesSeen / sampleRate) * 1000)
      const chunk = ensureChunk(sampleAt)
      const remainingSamples = chunkSamples - chunk.samples
      const remainingBytes = remainingSamples * BYTES_PER_SAMPLE
      const takeBytes = Math.min(remainingBytes, pcm.length - offset)
      const part = pcm.subarray(offset, offset + takeBytes)
      const partAt = chunk.startAt + Math.round((chunk.samples / sampleRate) * 1000)
      const newSamples = Math.floor(part.length / BYTES_PER_SAMPLE)

      chunk.parts.push(part)
      chunk.samples += newSamples
      samplesSeen += newSamples
      if (newSamples > 0) insertChunkRow(chunk)
      feedAsr(chunk.id, part, partAt)

      const now = Date.now()
      if (now - lastLevelAt >= LEVEL_THROTTLE_MS) {
        lastLevelAt = now
        const levels = pcm16Levels(part)
        events.publish({
          type: 'audio_level',
          source,
          at: now,
          rms_db: peakOrFloor(levels.peak_db),
        })
      }

      offset += takeBytes
      if (chunk.samples >= chunkSamples) {
        flushAsrBoundary()
        await finalizeChunk()
      }
    }
  }

  const finalize = async () => {
    flushAsrBoundary()
    await finalizeChunk()
    await transcription.flush(source).catch((err) => {
      events.publish({
        type: 'error',
        source,
        at: Date.now(),
        message: `ASR final flush failed: ${err}`,
      })
    })
  }

  return { appendPcm, finalize }
}

function publishDisabled(events: EventBus, source: AudioSource): CaptureRunner {
  events.publish({
    type: 'log',
    at: Date.now(),
    level: 'info',
    message: `${source} capture disabled`,
  })
  return NOOP_RUNNER
}

function startSckSystemStream(
  stream: AudioStreamConfig,
  sampleRate: number,
  sck: SckBus,
  deps: AudioStreamDeps,
): CaptureRunner {
  const source: AudioSource = 'system'
  if (!stream.enabled) return publishDisabled(deps.events, source)

  let running = true
  let unsubscribe: (() => void) | undefined
  let resolveStopped!: () => void
  const stoppedSignal = new Promise<void>((resolve) => {
    resolveStopped = resolve
  })

  const done = (async () => {
    const consumer = makeAudioConsumer({
      source,
      device: 'sck',
      sampleRate,
      chunkMs: stream.chunk_ms,
      ...deps,
    })

    try {
      await sck.start()
    } catch (err) {
      deps.events.publish({
        type: 'error',
        source,
        at: Date.now(),
        message: `sck start failed: ${String(err)}`,
      })
      return
    }

    if (!running) return

    deps.events.publish({
      type: 'started',
      source,
      at: Date.now(),
      meta: { mode: 'pcm', chunk_ms: stream.chunk_ms, device: 'sck', sample_rate: sampleRate },
    })

    let appending: Promise<void> = Promise.resolve()
    unsubscribe = sck.onAudio((event) => {
      appending = appending
        .then(() => consumer.appendPcm(event.pcm))
        .catch((err) => {
          deps.events.publish({
            type: 'error',
            source,
            at: Date.now(),
            message: `sck appendPcm: ${String(err)}`,
          })
        })
    })

    await stoppedSignal

    unsubscribe?.()
    unsubscribe = undefined
    await appending.catch(() => {})
    await consumer.finalize()
    deps.events.publish({ type: 'stopped', source, at: Date.now() })
  })()

  return {
    done,
    stop: () => {
      if (!running) return
      running = false
      resolveStopped()
    },
  }
}

function startStream(
  source: AudioSource,
  stream: AudioStreamConfig,
  sampleRate: number,
  deps: AudioStreamDeps,
): CaptureRunner {
  if (!stream.enabled) return publishDisabled(deps.events, source)

  let running = true
  let currentProc: { kill: () => void } | null = null

  const done = (async () => {
    let device: string
    try {
      device = await resolveDevice(source, stream.device)
    } catch (err) {
      deps.events.publish({ type: 'error', source, at: Date.now(), message: String(err) })
      return
    }

    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      ...inputArgsFor(source, device),
      '-vn',
      '-f',
      's16le',
      '-acodec',
      'pcm_s16le',
      '-ar',
      String(sampleRate),
      '-ac',
      '1',
      'pipe:1',
    ]
    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn([getFfmpegPath(), ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
      })
    } catch (err) {
      deps.events.publish({
        type: 'error',
        source,
        at: Date.now(),
        message: `failed to spawn ffmpeg (${source}): ${String(err)}`,
      })
      return
    }
    currentProc = proc
    const stderrText =
      proc.stderr instanceof ReadableStream ? new Response(proc.stderr).text() : Promise.resolve('')
    if (!(proc.stdout instanceof ReadableStream)) {
      proc.kill()
      deps.events.publish({
        type: 'error',
        source,
        at: Date.now(),
        message: `ffmpeg (${source}) did not expose a readable PCM stdout stream`,
      })
      return
    }

    deps.events.publish({
      type: 'started',
      source,
      at: Date.now(),
      meta: { mode: 'pcm', chunk_ms: stream.chunk_ms, device, sample_rate: sampleRate },
    })

    const consumer = makeAudioConsumer({
      source,
      device,
      sampleRate,
      chunkMs: stream.chunk_ms,
      ...deps,
    })

    const reader = proc.stdout.getReader()
    try {
      while (running) {
        const { done: readerDone, value } = await reader.read()
        if (readerDone) break
        if (value?.length) await consumer.appendPcm(Buffer.from(value))
      }
    } catch (err) {
      if (running) {
        deps.events.publish({ type: 'error', source, at: Date.now(), message: String(err) })
      }
    } finally {
      running = false
      currentProc = null
      await consumer.finalize()

      const exit = await proc.exited.catch(() => undefined)
      const stderr = await stderrText.catch(() => '')
      if (exit !== 0 && stderr.trim()) {
        deps.events.publish({
          type: 'error',
          source,
          at: Date.now(),
          message: `ffmpeg (${source}) exited ${exit}: ${stderr.trim()}`,
        })
      }
      deps.events.publish({ type: 'stopped', source, at: Date.now() })
    }
  })()

  return {
    done,
    stop: () => {
      running = false
      currentProc?.kill()
    },
  }
}

export function startAudioCapture({
  cfg,
  blobs,
  store,
  transcription,
  events,
  sck,
  getWindow,
}: AudioCaptureDeps): CaptureRunner {
  const echo = makeEchoSuppression(cfg)
  const streamDeps: AudioStreamDeps = { blobs, store, transcription, events, echo, getWindow }
  const mic = startStream('mic', cfg.mic, cfg.sample_rate, streamDeps)
  const system =
    process.platform === 'darwin' && cfg.system.enabled && sck
      ? startSckSystemStream(cfg.system, cfg.sample_rate, sck, streamDeps)
      : startStream('system', cfg.system, cfg.sample_rate, streamDeps)
  return {
    done: Promise.allSettled([mic.done, system.done]).then(() => {}),
    stop: () => {
      mic.stop()
      system.stop()
    },
  }
}
