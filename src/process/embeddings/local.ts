import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { EventBus } from '../../core/events'
import type {
  EmbeddingCallbacks,
  EmbeddingEngine,
  EmbeddingRequest,
  EmbeddingResult,
  EmbeddingStatus,
} from '../types'

export interface LocalEmbeddingOptions {
  model?: string
  dim?: number
}

const DEFAULT_MODEL = 'multilingual-e5-small'
const DEFAULT_DIM = 384
const EMBED_TIMEOUT_MS = 60_000

type WorkerMessage =
  | { type: 'ready'; engine: string; model?: string; dim?: number }
  | { type: 'status'; status: EmbeddingStatus['status']; engine?: string; message?: string }
  | { type: 'embedding'; id: string; kind?: string; vector: number[] }
  | { type: 'error'; id?: string; engine?: string; message: string }

function binaryName(): string {
  return process.platform === 'win32' ? 'hpm-embed.exe' : 'hpm-embed'
}

// Same resolution order as findNativeAsrBinary in transcription/parakeet.ts.
function findNativeEmbedBinary(): string | undefined {
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

interface Pending {
  resolve: (result: EmbeddingResult) => void
  reject: (err: Error) => void
  kind: EmbeddingRequest['kind']
  timer: ReturnType<typeof setTimeout>
}

export class LocalEmbedding implements EmbeddingEngine {
  readonly name: string
  readonly dim: number
  private binary?: string
  private proc?: ChildProcessWithoutNullStreams
  private callbacks?: EmbeddingCallbacks
  private stdoutBuffer = ''
  private readyCache?: boolean
  private model: string
  private pending = new Map<string, Pending>()

  constructor(
    opts: LocalEmbeddingOptions = {},
    private events?: EventBus,
  ) {
    this.model = typeof opts.model === 'string' && opts.model ? opts.model : DEFAULT_MODEL
    this.dim = typeof opts.dim === 'number' && opts.dim > 0 ? Math.trunc(opts.dim) : DEFAULT_DIM
    this.name = `local:${this.model}`
  }

  async ready(): Promise<boolean> {
    if (this.readyCache !== undefined) return this.readyCache
    this.binary = findNativeEmbedBinary()
    this.readyCache = Boolean(this.binary)
    if (!this.readyCache) {
      emitLog(
        this.events,
        'warn',
        'hpm-embed binary not found; semantic search disabled. Run `bun run build` or `cargo build --release --workspace`',
      )
    }
    return this.readyCache
  }

  async start(callbacks: EmbeddingCallbacks): Promise<void> {
    this.callbacks = callbacks
    if (this.proc) return
    const ok = await this.ready()
    if (!ok || !this.binary) throw new Error('hpm-embed binary not located')

    callbacks.onStatus({ status: 'starting', engine: this.name, message: 'starting embed worker' })
    const proc = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.proc = proc

    proc.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk.toString('utf8')))
    proc.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim()
      if (message) emitLog(this.events, 'warn', `hpm-embed stderr: ${message}`)
    })
    proc.on('error', (err) => {
      callbacks.onStatus({ status: 'error', engine: this.name, message: String(err) })
      this.rejectAll(err instanceof Error ? err : new Error(String(err)))
    })
    proc.on('close', (code) => {
      this.proc = undefined
      callbacks.onStatus({
        status: 'stopped',
        engine: this.name,
        message: `hpm-embed exited ${code}`,
      })
      this.rejectAll(new Error(`hpm-embed exited ${code}`))
    })

    this.send({ type: 'init', model: this.model, dim: this.dim })
  }

  async embed(requests: EmbeddingRequest[]): Promise<EmbeddingResult[]> {
    if (requests.length === 0) return []
    if (!this.proc) throw new Error('hpm-embed worker not started')
    const promises = requests.map(
      (req) =>
        new Promise<EmbeddingResult>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(req.id)
            reject(new Error(`hpm-embed timed out for ${req.id}`))
          }, EMBED_TIMEOUT_MS)
          this.pending.set(req.id, { resolve, reject, kind: req.kind, timer })
          this.send({ type: 'embed', id: req.id, kind: req.kind, text: req.text })
        }),
    )
    return Promise.all(promises)
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
        emitLog(this.events, 'warn', `invalid hpm-embed JSON: ${line.slice(0, 200)}`)
        continue
      }
      this.handleMessage(msg)
    }
  }

  private handleMessage(msg: WorkerMessage): void {
    if (msg.type === 'ready') {
      this.callbacks?.onStatus({ status: 'ready', engine: msg.engine, message: 'embed ready' })
    } else if (msg.type === 'status') {
      this.callbacks?.onStatus({
        status: msg.status,
        engine: msg.engine ?? this.name,
        message: msg.message,
      })
    } else if (msg.type === 'embedding') {
      const pending = this.pending.get(msg.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(msg.id)
      pending.resolve({ id: msg.id, kind: pending.kind, vector: Float32Array.from(msg.vector) })
    } else if (msg.type === 'error') {
      const message = msg.message || 'hpm-embed error'
      emitLog(this.events, 'error', message, msg)
      if (msg.id) {
        const pending = this.pending.get(msg.id)
        if (pending) {
          clearTimeout(pending.timer)
          this.pending.delete(msg.id)
          pending.reject(new Error(message))
        }
      } else {
        this.callbacks?.onStatus({ status: 'error', engine: msg.engine ?? this.name, message })
      }
    }
  }

  private send(value: Record<string, unknown>): void {
    this.proc?.stdin.write(`${JSON.stringify(value)}\n`)
  }

  private rejectAll(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(err)
      this.pending.delete(id)
    }
  }
}
