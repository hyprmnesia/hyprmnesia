import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { EventBus } from '../core/events'

export interface SckBusOptions {
  sampleRate: number
  channelCount: number
  frameIntervalMs: number
  imageFormat: 'png' | 'jpg'
  jpegQuality?: number
  width?: number
  height?: number
  captureAudio: boolean
  captureVideo: boolean
}

interface SckAudioEvent {
  at: number
  sampleRate: number
  channels: number
  pcm: Buffer
}

export interface SckFrameEvent {
  at: number
  width: number
  height: number
  format: 'png' | 'jpeg'
  mime: string
  image: Buffer
}

type SckAudioHandler = (event: SckAudioEvent) => void
type SckFrameHandler = (event: SckFrameEvent) => void

export interface SckBus {
  start(): Promise<void>
  stop(): Promise<void>
  onAudio(handler: SckAudioHandler): () => void
  onFrame(handler: SckFrameHandler): () => void
}

type WorkerMessage =
  | { type: 'ready'; engine?: string }
  | { type: 'started'; at: number; sample_rate?: number; frame_interval_ms?: number }
  | { type: 'stopped'; at: number }
  | { type: 'audio'; at: number; sample_rate: number; channels: number; pcm_b64: string }
  | {
      type: 'frame'
      at: number
      width: number
      height: number
      format: 'png' | 'jpeg'
      mime: string
      image_b64: string
    }
  | { type: 'error'; at: number; message: string }
  | { type: 'log'; at: number; level: 'info' | 'warn' | 'error'; message: string }

function binaryName(): string {
  return 'hpm-sck'
}

function findBinary(): string | undefined {
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

export function createSckBus(opts: SckBusOptions, events: EventBus): SckBus {
  let proc: ChildProcessWithoutNullStreams | undefined
  let stdoutBuffer = ''
  let startPromise: Promise<void> | undefined
  let stopPromise: Promise<void> | undefined
  let resolvedStarted: (() => void) | undefined
  let rejectedStarted: ((err: Error) => void) | undefined
  const audioHandlers = new Set<SckAudioHandler>()
  const frameHandlers = new Set<SckFrameHandler>()

  function emitLog(level: 'info' | 'warn' | 'error', message: string, extra?: unknown) {
    events.publish({ type: 'log', at: Date.now(), level, message, extra })
  }

  function publishError(message: string) {
    events.publish({ type: 'error', source: 'screen', at: Date.now(), message: `sck: ${message}` })
  }

  function send(value: Record<string, unknown>) {
    if (!proc) return
    proc.stdin.write(`${JSON.stringify(value)}\n`)
  }

  function handleLine(line: string) {
    if (!line.trim()) return
    let msg: WorkerMessage
    try {
      msg = JSON.parse(line) as WorkerMessage
    } catch {
      emitLog('warn', `invalid hpm-sck JSON: ${line.slice(0, 200)}`)
      return
    }
    switch (msg.type) {
      case 'ready':
        send({
          type: 'start',
          capture_audio: opts.captureAudio,
          capture_video: opts.captureVideo,
          sample_rate: opts.sampleRate,
          channel_count: opts.channelCount,
          frame_interval_ms: opts.frameIntervalMs,
          width: opts.width,
          height: opts.height,
          image_format: opts.imageFormat === 'jpg' ? 'jpeg' : 'png',
          jpeg_quality: opts.jpegQuality,
        })
        return
      case 'started':
        resolvedStarted?.()
        resolvedStarted = undefined
        rejectedStarted = undefined
        return
      case 'stopped':
        return
      case 'audio':
        for (const h of audioHandlers) {
          h({
            at: msg.at,
            sampleRate: msg.sample_rate,
            channels: msg.channels,
            pcm: Buffer.from(msg.pcm_b64, 'base64'),
          })
        }
        return
      case 'frame':
        for (const h of frameHandlers) {
          h({
            at: msg.at,
            width: msg.width,
            height: msg.height,
            format: msg.format,
            mime: msg.mime,
            image: Buffer.from(msg.image_b64, 'base64'),
          })
        }
        return
      case 'error': {
        const err = new Error(msg.message)
        rejectedStarted?.(err)
        rejectedStarted = undefined
        resolvedStarted = undefined
        publishError(msg.message)
        return
      }
      case 'log':
        emitLog(msg.level, `hpm-sck: ${msg.message}`)
        return
    }
  }

  function handleStdout(text: string) {
    stdoutBuffer += text
    const lines = stdoutBuffer.split('\n')
    stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) handleLine(line)
  }

  async function start(): Promise<void> {
    if (startPromise) return startPromise
    const binary = findBinary()
    if (!binary) {
      throw new Error(
        'hpm-sck binary not found; run `bun run build` or `cargo build --release --workspace`',
      )
    }
    startPromise = new Promise<void>((resolve, reject) => {
      resolvedStarted = resolve
      rejectedStarted = reject
      const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      proc = child
      child.stdout.on('data', (chunk: Buffer) => handleStdout(chunk.toString('utf8')))
      child.stderr.on('data', (chunk: Buffer) => {
        const message = chunk.toString('utf8').trim()
        if (message) emitLog('warn', `hpm-sck stderr: ${message}`)
      })
      child.on('error', (err) => {
        rejectedStarted?.(err instanceof Error ? err : new Error(String(err)))
        rejectedStarted = undefined
        resolvedStarted = undefined
        publishError(`spawn error: ${String(err)}`)
      })
      child.on('close', (code) => {
        proc = undefined
        const err = new Error(`hpm-sck exited ${code}`)
        rejectedStarted?.(err)
        rejectedStarted = undefined
        resolvedStarted = undefined
        startPromise = undefined
        if (code !== 0 && code !== null) publishError(`exited ${code}`)
      })
    })
    return startPromise
  }

  async function stop(): Promise<void> {
    if (stopPromise) return stopPromise
    const child = proc
    if (!child) return
    stopPromise = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 5_000)
      child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
      } catch {
        // process already gone
      }
    })
    return stopPromise
  }

  function onAudio(handler: SckAudioHandler): () => void {
    audioHandlers.add(handler)
    return () => {
      audioHandlers.delete(handler)
    }
  }

  function onFrame(handler: SckFrameHandler): () => void {
    frameHandlers.add(handler)
    return () => {
      frameHandlers.delete(handler)
    }
  }

  return { start, stop, onAudio, onFrame }
}
