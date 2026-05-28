import { startAudioCapture } from '../capture/audio'
import { createSckBus, type SckBus } from '../capture/sck'
import { startScreenCapture } from '../capture/screen'
import type { Config } from '../config'
import { EmbeddingQueue } from '../process/embedding_queue'
import { makeEmbedding } from '../process/embeddings'
import { createEmbeddingService, type EmbeddingService } from '../process/embeddings/service'
import { makeOcr } from '../process/ocr'
import { makeTranscription } from '../process/transcription'
import { TranscriptionQueue } from '../process/transcription_queue'
import type { EmbeddingEngine, EmbeddingStatus } from '../process/types'
import { makeBlobStore } from '../store/blobs'
import { openChunkStore } from '../store/db'
import { defaultDbPath } from '../util/paths'
import { EventBus, type Source, type WindowContext } from './events'
import { startWindowTracker, type WindowTracker } from './window-tracker'

export interface SourceStatus {
  enabled: boolean
  running: boolean
  started_at?: number
  last_chunk_at?: number
  last_chunk_bytes?: number
  last_error?: string
}

export interface OrchestratorStatus {
  running: boolean
  sources: Record<Source, SourceStatus>
  focused_window?: WindowContext
}

export interface Orchestrator {
  readonly events: EventBus
  readonly cfg: Config
  start(): Promise<void>
  stop(): Promise<void>
  isRunning(): boolean
  status(): OrchestratorStatus
  dispose?(): void
}

interface Runner {
  stop: () => void
  done: Promise<void>
}

// Boots the embedding engine once for the daemon so the embedding queue and
// the shared embed service can share a single hpm-embed worker. Status events
// are forwarded to the orchestrator event bus.
async function startSharedEmbedding(engine: EmbeddingEngine, events: EventBus): Promise<boolean> {
  if (!(await engine.ready())) return false
  await engine.start({
    onStatus: (status: EmbeddingStatus) => {
      events.publish({
        type: 'embedding_status',
        at: Date.now(),
        status: status.status,
        engine: status.engine,
        message: status.message,
      })
    },
  })
  return true
}

function embeddingQueueOptions(cfg: Config) {
  const opts = cfg.processing.embeddings.options ?? {}
  const rawSources = Array.isArray(opts.sources) ? opts.sources : ['screen', 'mic', 'system']
  const sources = rawSources.filter(
    (s): s is Source => s === 'screen' || s === 'mic' || s === 'system',
  )
  return {
    model: typeof opts.model === 'string' ? opts.model : 'multilingual-e5-small',
    dim: typeof opts.dim === 'number' ? opts.dim : 384,
    batchSize: typeof opts.batch_size === 'number' ? Math.max(1, Math.trunc(opts.batch_size)) : 16,
    sources: sources.length > 0 ? sources : (['screen', 'mic', 'system'] as Source[]),
  }
}

export function makeOrchestrator(cfg: Config): Orchestrator {
  const events = new EventBus()
  const blobs = makeBlobStore(cfg.storage.path)
  const store = openChunkStore(defaultDbPath())
  const ocr = makeOcr(cfg.processing.ocr)
  const transcription = makeTranscription(cfg.processing.transcription, events)
  const embedding = makeEmbedding(cfg.processing.embeddings, events)
  let transcriptionQueue: TranscriptionQueue | undefined
  let embeddingQueue: EmbeddingQueue | undefined
  let embeddingService: EmbeddingService | undefined
  let embeddingStarted = false

  let running = false
  let stopping: Promise<void> | undefined
  let storeClosed = false
  let windowTracker: WindowTracker | undefined
  let sck: SckBus | undefined
  const runners: Runner[] = []
  const sourceStatus: Record<Source, SourceStatus> = {
    screen: { enabled: cfg.capture.screen.enabled, running: false },
    mic: { enabled: cfg.capture.audio.mic.enabled, running: false },
    system: { enabled: cfg.capture.audio.system.enabled, running: false },
  }

  events.subscribe((e) => {
    if (e.type === 'started') {
      sourceStatus[e.source].running = true
      sourceStatus[e.source].started_at = e.at
      sourceStatus[e.source].last_error = undefined
    } else if (e.type === 'stopped') {
      sourceStatus[e.source].running = false
      sourceStatus[e.source].started_at = undefined
    } else if (e.type === 'chunk') {
      sourceStatus[e.source].last_chunk_at = e.at
      sourceStatus[e.source].last_chunk_bytes = e.bytes
      sourceStatus[e.source].last_error = undefined
    } else if (e.type === 'error') {
      sourceStatus[e.source].last_error = e.message
    }
  })

  async function start() {
    if (running) return
    if (!(await ocr.ready())) throw new Error(`ocr engine '${ocr.name}' not ready`)
    if (!(await transcription.ready()))
      throw new Error(`transcription engine '${transcription.name}' not ready`)
    events.publish({
      type: 'log',
      at: Date.now(),
      level: 'info',
      message: 'orchestrator starting',
      extra: { cfg },
    })

    windowTracker = startWindowTracker(events)
    transcriptionQueue = new TranscriptionQueue(transcription, store, events)
    await transcriptionQueue.start()

    if (!store.vecEnabled) {
      events.publish({
        type: 'log',
        at: Date.now(),
        level: 'info',
        message: 'semantic index unavailable (sqlite-vec not loaded); embeddings disabled',
      })
    } else {
      embeddingStarted = await startSharedEmbedding(embedding, events)
      if (embeddingStarted) {
        embeddingQueue = new EmbeddingQueue(embedding, store, events, {
          ...embeddingQueueOptions(cfg),
          manageEngineLifecycle: false,
        })
        await embeddingQueue.start()

        embeddingService = createEmbeddingService(embedding, events)
        try {
          await embeddingService.start()
        } catch (err) {
          events.publish({
            type: 'log',
            at: Date.now(),
            level: 'warn',
            message: `embed service failed to start: ${String(err)}`,
          })
          embeddingService = undefined
        }
      } else {
        events.publish({
          type: 'log',
          at: Date.now(),
          level: 'info',
          message: `embedding engine '${embedding.name}' not ready; indexing & shared embed disabled`,
        })
      }
    }

    const wantSckScreen = process.platform === 'darwin' && cfg.capture.screen.enabled
    const wantSckSystemAudio = process.platform === 'darwin' && cfg.capture.audio.system.enabled
    if (wantSckScreen || wantSckSystemAudio) {
      sck = createSckBus(
        {
          sampleRate: cfg.capture.audio.sample_rate,
          channelCount: 2,
          frameIntervalMs: cfg.capture.screen.interval_ms,
          imageFormat: cfg.capture.screen.format,
          jpegQuality: cfg.capture.screen.quality,
          captureAudio: wantSckSystemAudio,
          captureVideo: wantSckScreen,
        },
        events,
      )
    }

    const screen = startScreenCapture({
      cfg: cfg.capture.screen,
      blobs,
      store,
      ocr,
      events,
      sck,
      getWindow: () => windowTracker?.current(),
    })
    const audio = startAudioCapture({
      cfg: cfg.capture.audio,
      blobs,
      store,
      transcription: transcriptionQueue,
      events,
      sck,
      getWindow: () => windowTracker?.current(),
    })
    runners.push(screen, audio)
    running = true
  }

  function closeStore() {
    if (storeClosed) return
    storeClosed = true
    store.close()
  }

  async function stop() {
    if (stopping) return stopping
    stopping = (async () => {
      if (!running) {
        closeStore()
        return
      }
      running = false
      const activeRunners = runners.splice(0)
      const activeQueue = transcriptionQueue
      transcriptionQueue = undefined
      const activeEmbeddingQueue = embeddingQueue
      embeddingQueue = undefined

      for (const r of activeRunners) r.stop()
      windowTracker?.stop()
      windowTracker = undefined

      await Promise.allSettled(activeRunners.map((r) => r.done))
      if (sck) {
        try {
          await sck.stop()
        } catch (err) {
          events.publish({
            type: 'error',
            source: 'screen',
            at: Date.now(),
            message: `sck stop: ${String(err)}`,
          })
        }
        sck = undefined
      }
      await activeQueue?.stop()
      const activeService = embeddingService
      embeddingService = undefined
      if (activeService) {
        try {
          await activeService.stop()
        } catch {}
      }
      await activeEmbeddingQueue?.stop()
      if (embeddingStarted) {
        embeddingStarted = false
        try {
          await embedding.stop()
        } catch {}
      }
      closeStore()
      events.publish({
        type: 'log',
        at: Date.now(),
        level: 'info',
        message: 'orchestrator stopped',
      })
    })()
    return stopping
  }

  return {
    events,
    cfg,
    start,
    stop,
    isRunning: () => running,
    status: () => ({
      running,
      sources: {
        screen: { ...sourceStatus.screen },
        mic: { ...sourceStatus.mic },
        system: { ...sourceStatus.system },
      },
      focused_window: windowTracker?.current(),
    }),
  }
}
