import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUIDv7 } from 'bun'
import type { AudioSource, EventBus } from '../../core/events'
import type {
  PcmAudioFrame,
  TranscriptionCallbacks,
  TranscriptionEngine,
  TranscriptionSegment,
  TranscriptionStatus,
} from '../types'

export interface ParakeetOptions {
  model?: string
  live?: {
    enabled?: boolean
    min_segment_ms?: number
    target_segment_ms?: number
    max_segment_ms?: number
    silence_ms?: number
    rms_gate?: number
  }
}

const DEFAULT_PARAKEET_MODEL = 'parakeet-tdt-0.6b-v3'
const PARAKEET_MODELS = new Set([DEFAULT_PARAKEET_MODEL])

export function normalizeParakeetModel(model: unknown): string {
  return typeof model === 'string' && PARAKEET_MODELS.has(model) ? model : DEFAULT_PARAKEET_MODEL
}

type WorkerMessage =
  | { type: 'ready'; engine: string; model?: string }
  | { type: 'status'; status: TranscriptionStatus['status']; engine?: string; message?: string }
  | {
      type: 'segment_final'
      source: AudioSource
      chunk_id: string
      start_at: number
      end_at: number
      text: string
      engine: string
      transcribe_ms: number
    }
  | { type: 'flushed'; id?: string | null }
  | { type: 'error'; source?: AudioSource; chunk_id?: string; engine?: string; message: string }

function binaryName(): string {
  return process.platform === 'win32' ? 'hpm-asr.exe' : 'hpm-asr'
}

function findNativeAsrBinary(): string | undefined {
  const name = binaryName()
  const candidates = [
    join(dirname(process.execPath), 'native', name),
    join(dirname(process.execPath), name),
    join(process.cwd(), 'dist', 'native', name),
    join(process.cwd(), 'dist', name),
    join(process.cwd(), 'target', 'release', name),
  ]
  return candidates.find((p) => existsSync(p))
}

function emitLog(
  events: EventBus | undefined,
  level: 'info' | 'warn' | 'error',
  message: string,
  extra?: unknown,
) {
  events?.publish({ type: 'log', at: Date.now(), level, message, extra })
}

export class ParakeetTranscription implements TranscriptionEngine {
  readonly name: string
  private binary?: string
  private proc?: ChildProcessWithoutNullStreams
  private callbacks?: TranscriptionCallbacks
  private stdoutBuffer = ''
  private readyCache?: boolean
  private sawStoppedStatus = false
  private flushes = new Map<
    string,
    { resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()

  constructor(
    private opts: ParakeetOptions = {},
    private events?: EventBus,
  ) {
    this.opts.model = normalizeParakeetModel(opts.model)
    const model = this.opts.model
    this.name = `parakeet:${model}`
  }

  async ready(): Promise<boolean> {
    if (this.readyCache !== undefined) return this.readyCache
    this.binary = findNativeAsrBinary()
    this.readyCache = Boolean(this.binary)
    if (!this.readyCache) {
      emitLog(
        this.events,
        'error',
        'hpm-asr binary not found; run `bun run build` or `cargo build --release --workspace`',
      )
    }
    return this.readyCache
  }

  async start(callbacks: TranscriptionCallbacks): Promise<void> {
    this.callbacks = callbacks
    if (this.proc) return
    const ok = await this.ready()
    if (!ok || !this.binary) throw new Error('hpm-asr binary not located')

    callbacks.onStatus({
      status: 'starting',
      engine: this.name,
      message: 'starting Parakeet worker',
    })
    this.sawStoppedStatus = false
    const proc = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.proc = proc

    proc.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk.toString('utf8')))
    proc.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim()
      if (message) emitLog(this.events, 'warn', `hpm-asr stderr: ${message}`)
    })
    proc.on('error', (err) => {
      callbacks.onStatus({ status: 'error', engine: this.name, message: String(err) })
      this.rejectFlushes(err instanceof Error ? err : new Error(String(err)))
    })
    proc.on('close', (code) => {
      this.proc = undefined
      if (!this.sawStoppedStatus) {
        callbacks.onStatus({
          status: 'stopped',
          engine: this.name,
          message: `hpm-asr exited ${code}`,
        })
      }
      this.rejectFlushes(new Error(`hpm-asr exited ${code}`))
    })

    this.send({
      type: 'init',
      model: this.opts.model,
      sample_rate: 16000,
      min_segment_ms: this.opts.live?.min_segment_ms,
      target_segment_ms: this.opts.live?.target_segment_ms,
      max_segment_ms: this.opts.live?.max_segment_ms,
      silence_ms: this.opts.live?.silence_ms,
      rms_gate: this.opts.live?.rms_gate,
    })
  }

  submitPcm(frame: PcmAudioFrame): void {
    if (!this.proc || this.opts.live?.enabled === false) return
    this.send({
      type: 'audio',
      source: frame.source,
      chunk_id: frame.chunkId,
      at: Math.round(frame.at),
      sample_rate: frame.sampleRate,
      pcm_b64: frame.pcm.toString('base64'),
    })
  }

  async flush(source?: AudioSource): Promise<void> {
    if (!this.proc) return
    const id = randomUUIDv7()
    this.send({ type: 'flush', id, source })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.flushes.delete(id)
        reject(new Error(`hpm-asr flush timed out (${source ?? 'all'})`))
      }, 120_000)
      this.flushes.set(id, { resolve, reject, timer })
    })
  }

  async stop(): Promise<void> {
    const proc = this.proc
    if (!proc) return
    this.send({ type: 'shutdown' })
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill()
        resolve()
      }, 10_000)
      proc.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private handleStdout(text: string): void {
    this.stdoutBuffer += text
    const lines = this.stdoutBuffer.split('\n')
    this.stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let msg: WorkerMessage
      try {
        msg = JSON.parse(line) as WorkerMessage
      } catch {
        emitLog(this.events, 'warn', `invalid hpm-asr JSON: ${line.slice(0, 200)}`)
        continue
      }
      this.handleMessage(msg)
    }
  }

  private handleMessage(msg: WorkerMessage): void {
    if (!this.callbacks) return
    if (msg.type === 'ready') {
      this.callbacks.onStatus({ status: 'ready', engine: msg.engine, message: 'Parakeet ready' })
    } else if (msg.type === 'status') {
      if (msg.status === 'stopped') this.sawStoppedStatus = true
      this.callbacks.onStatus({
        status: msg.status,
        engine: msg.engine ?? this.name,
        message: msg.message,
      })
    } else if (msg.type === 'segment_final') {
      const text = msg.text.trim()
      if (!text) return
      const segment: TranscriptionSegment = {
        source: msg.source,
        chunkId: msg.chunk_id,
        startAt: msg.start_at,
        endAt: msg.end_at,
        text,
        engine: msg.engine,
        transcribeMs: msg.transcribe_ms,
      }
      this.callbacks.onSegment(segment)
    } else if (msg.type === 'flushed') {
      if (msg.id) this.resolveFlush(msg.id)
    } else if (msg.type === 'error') {
      const message = msg.message || 'hpm-asr error'
      this.callbacks.onStatus({ status: 'error', engine: msg.engine ?? this.name, message })
      emitLog(this.events, 'error', message, msg)
    }
  }

  private send(value: Record<string, unknown>): void {
    this.proc?.stdin.write(`${JSON.stringify(value)}\n`)
  }

  private resolveFlush(id: string): void {
    const pending = this.flushes.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.flushes.delete(id)
    pending.resolve()
  }

  private rejectFlushes(err: Error): void {
    for (const [id, pending] of this.flushes) {
      clearTimeout(pending.timer)
      pending.reject(err)
      this.flushes.delete(id)
    }
  }
}
