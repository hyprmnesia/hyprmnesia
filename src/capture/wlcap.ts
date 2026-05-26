import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { EventBus } from '../core/events'
import { defaultWaylandTokenPath } from '../util/paths'
import type { SckFrameEvent } from './sck'

export interface WlcapBusOptions {
  frameIntervalMs: number
  imageFormat: 'png' | 'jpg'
  jpegQuality?: number
}

type WlcapFrameHandler = (event: SckFrameEvent) => void

export interface WlcapBus {
  start(): Promise<void>
  stop(): Promise<void>
  onFrame(handler: WlcapFrameHandler): () => void
}

type WorkerMessage =
  | { type: 'ready'; engine?: string }
  | { type: 'started'; at: number; frame_interval_ms?: number; restore_token?: string | null }
  | { type: 'stopped'; at: number }
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

function findBinary(): string | undefined {
  const name = 'hpm-wlcap'
  const candidates = [
    join(dirname(process.execPath), 'native', name),
    join(dirname(process.execPath), name),
    join(process.cwd(), 'dist', 'native', name),
    join(process.cwd(), 'dist', name),
    join(process.cwd(), 'target', 'release', name),
  ]
  return candidates.find((p) => existsSync(p))
}

function readRestoreToken(): string | undefined {
  const path = defaultWaylandTokenPath()
  if (!existsSync(path)) return undefined
  try {
    const token = readFileSync(path, 'utf8').trim()
    return token === '' ? undefined : token
  } catch {
    return undefined
  }
}

function writeRestoreToken(token: string): void {
  const path = defaultWaylandTokenPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, token)
  } catch {
    // best-effort; a missing token just means re-prompting next session
  }
}

export function createWlcapBus(opts: WlcapBusOptions, events: EventBus): WlcapBus {
  let proc: ChildProcessWithoutNullStreams | undefined
  let stdoutBuffer = ''
  let startPromise: Promise<void> | undefined
  let stopPromise: Promise<void> | undefined
  let resolvedStarted: (() => void) | undefined
  let rejectedStarted: ((err: Error) => void) | undefined
  const frameHandlers = new Set<WlcapFrameHandler>()

  function emitLog(level: 'info' | 'warn' | 'error', message: string) {
    events.publish({ type: 'log', at: Date.now(), level, message })
  }

  function publishError(message: string) {
    events.publish({
      type: 'error',
      source: 'screen',
      at: Date.now(),
      message: `wlcap: ${message}`,
    })
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
      emitLog('warn', `invalid hpm-wlcap JSON: ${line.slice(0, 200)}`)
      return
    }
    switch (msg.type) {
      case 'ready':
        send({
          type: 'start',
          frame_interval_ms: opts.frameIntervalMs,
          image_format: opts.imageFormat === 'jpg' ? 'jpeg' : 'png',
          jpeg_quality: opts.jpegQuality,
          restore_token: readRestoreToken(),
        })
        return
      case 'started':
        if (msg.restore_token) writeRestoreToken(msg.restore_token)
        resolvedStarted?.()
        resolvedStarted = undefined
        rejectedStarted = undefined
        return
      case 'stopped':
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
        emitLog(msg.level, `hpm-wlcap: ${msg.message}`)
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
        'hpm-wlcap binary not found; run `bun run build` or `cargo build --release --workspace`',
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
        if (message) emitLog('warn', `hpm-wlcap stderr: ${message}`)
      })
      child.on('error', (err) => {
        rejectedStarted?.(err instanceof Error ? err : new Error(String(err)))
        rejectedStarted = undefined
        resolvedStarted = undefined
        publishError(`spawn error: ${String(err)}`)
      })
      child.on('close', (code) => {
        proc = undefined
        const err = new Error(`hpm-wlcap exited ${code}`)
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

  function onFrame(handler: WlcapFrameHandler): () => void {
    frameHandlers.add(handler)
    return () => {
      frameHandlers.delete(handler)
    }
  }

  return { start, stop, onFrame }
}
