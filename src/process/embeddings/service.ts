// Daemon-side embedding RPC. Wraps the EmbeddingEngine owned by the
// orchestrator and exposes a Unix-socket / Windows-named-pipe server so the
// MCP query encoder can reuse the warm worker instead of spawning a duplicate
// hpm-embed.
//
// Auth model: the IPC is reachable only by the daemon's own OS user. POSIX
// uses a Unix domain socket created with mode 0600 inside ~/.hyprmnesia/
// (which is itself 0700); Windows named pipes default to a current-user-only
// ACL. This is the same trust boundary the MCP auth token (src/mcp/auth.ts)
// already assumes for its on-disk verifier, so a separate token handshake
// would not raise the bar. Network exposure is not supported.

import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { randomUUIDv7 } from 'bun'
import type { EventBus } from '../../core/events'
import type { EmbeddingEngine } from '../types'
import {
  clearEmbedEndpoint,
  defaultEmbedSocketPath,
  type EmbedEndpoint,
  writeEmbedEndpoint,
} from './endpoint'

export const EMBED_PROTOCOL = 'embed/1'

const REQUEST_TIMEOUT_MS = 30_000

type ClientRequest =
  | { id?: string; method: 'embed_query'; params?: { text?: string } }
  | { id?: string; method: 'status' }
  | { id?: string; method: string; params?: unknown }

type ServerHello = {
  type: 'hello'
  protocol: string
  engine: string
  dim: number
}

type ServerResponse =
  | { id: string; result: { vector: number[] } }
  | { id: string; result: { engine: string; dim: number; protocol: string } }
  | { id: string; error: { message: string } }

export interface EmbeddingService {
  start(): Promise<void>
  stop(): Promise<void>
  endpoint(): EmbedEndpoint | undefined
}

export interface EmbeddingServiceOptions {
  socketPath?: string
  endpointPath?: string
  // Hook for tests to observe handled requests without touching globals.
  onRequest?: (method: string) => void
}

function emitLog(
  events: EventBus | undefined,
  level: 'info' | 'warn' | 'error',
  message: string,
): void {
  events?.publish({ type: 'log', at: Date.now(), level, message })
}

export function createEmbeddingService(
  engine: EmbeddingEngine,
  events?: EventBus,
  opts: EmbeddingServiceOptions = {},
): EmbeddingService {
  const socketPath = opts.socketPath ?? defaultEmbedSocketPath()
  const endpointPath = opts.endpointPath
  let server: Server | undefined
  let current: EmbedEndpoint | undefined
  let sockets = new Set<Socket>()

  async function start(): Promise<void> {
    if (server) return
    if (engine.dim <= 0) {
      // The embedding engine is the noop variant; nothing to share.
      return
    }
    await prepareSocketPath(socketPath)
    server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      handleConnection(socket, engine, opts)
    })
    server.on('error', (err) => {
      emitLog(events, 'warn', `embed service error: ${err instanceof Error ? err.message : err}`)
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server?.off('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        server?.off('error', onError)
        resolve()
      }
      server?.once('error', onError)
      server?.once('listening', onListening)
      server?.listen(socketPath)
    })
    if (process.platform !== 'win32') {
      try {
        chmodSync(socketPath, 0o600)
      } catch {}
    }
    current = {
      socket: socketPath,
      pid: process.pid,
      engine: engine.name,
      dim: engine.dim,
      protocol: EMBED_PROTOCOL,
      started_at: Date.now(),
    }
    writeEmbedEndpoint(current, endpointPath)
    emitLog(events, 'info', `embed service ready on ${socketPath} (${engine.name})`)
  }

  async function stop(): Promise<void> {
    const active = server
    server = undefined
    current = undefined
    if (active) {
      for (const socket of sockets) socket.destroy()
      sockets = new Set()
      await new Promise<void>((resolve) => {
        active.close(() => resolve())
      })
    }
    clearEmbedEndpoint(endpointPath)
    if (process.platform !== 'win32') {
      try {
        if (existsSync(socketPath)) unlinkSync(socketPath)
      } catch {}
    }
  }

  return { start, stop, endpoint: () => current }
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  if (process.platform === 'win32') return
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 })
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath)
  } catch {}
}

function handleConnection(
  socket: Socket,
  engine: EmbeddingEngine,
  opts: EmbeddingServiceOptions,
): void {
  socket.setEncoding('utf8')
  let buffer = ''
  const hello: ServerHello = {
    type: 'hello',
    protocol: EMBED_PROTOCOL,
    engine: engine.name,
    dim: engine.dim,
  }
  socket.write(`${JSON.stringify(hello)}\n`)

  const send = (response: ServerResponse) => {
    if (!socket.writable) return
    socket.write(`${JSON.stringify(response)}\n`)
  }

  socket.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      void handleLine(trimmed, engine, send, opts)
    }
  })
  socket.on('error', () => {
    socket.destroy()
  })
  socket.on('close', () => {
    socket.removeAllListeners()
  })
}

async function handleLine(
  line: string,
  engine: EmbeddingEngine,
  send: (response: ServerResponse) => void,
  opts: EmbeddingServiceOptions,
): Promise<void> {
  let request: ClientRequest
  try {
    request = JSON.parse(line) as ClientRequest
  } catch {
    send({ id: 'parse-error', error: { message: 'invalid JSON' } })
    return
  }
  const id = typeof request.id === 'string' ? request.id : randomUUIDv7()
  opts.onRequest?.(request.method)

  if (request.method === 'status') {
    send({
      id,
      result: { engine: engine.name, dim: engine.dim, protocol: EMBED_PROTOCOL },
    })
    return
  }
  if (request.method === 'embed_query') {
    const params = (request as { params?: { text?: string } }).params ?? {}
    const text = typeof params.text === 'string' ? params.text : undefined
    if (!text || text.length === 0) {
      send({ id, error: { message: 'embed_query requires non-empty text' } })
      return
    }
    try {
      const results = await withTimeout(
        engine.embed([{ id, kind: 'query', text }]),
        REQUEST_TIMEOUT_MS,
      )
      const result = results.find((r) => r.id === id) ?? results[0]
      if (!result) {
        send({ id, error: { message: 'engine returned no embedding' } })
        return
      }
      send({ id, result: { vector: Array.from(result.vector) } })
    } catch (err) {
      send({ id, error: { message: err instanceof Error ? err.message : String(err) } })
    }
    return
  }
  send({ id, error: { message: `unknown method: ${request.method}` } })
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`embed timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}
